import { envelopeVisibility, type TEnvelope, type TEnvelopeId, type TFxAmount, type TISOMonth } from "./core";
import type { Snapshot } from "./replica";

export type Month = TISOMonth;

export class ToolInputError extends Error {}

const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const fmt = (amount: number, currency: string) => `${nf.format(amount)} ${currency}`;

/** "5,000 USD + 1,200 RUB"; empty amount is "0". */
export function fmtFx(amount: TFxAmount): string {
  const parts = Object.entries(amount).filter(([, v]) => v).map(([c, v]) => fmt(v as number, c));
  return parts.length ? parts.join(" + ") : "0";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Read helpers over one snapshot: month range, currency conversion as Zerro
 * does it (month rates), envelope lookup and the UI's visibility rule.
 */
export class View {
  readonly displayCurrency: string;
  readonly months: Month[];
  readonly currentMonth: Month;
  private convertFx;

  constructor(readonly snap: Snapshot, displayCurrency?: string) {
    const { graph, data } = snap;
    this.months = graph.monthList(data) as Month[];
    this.currentMonth = graph.currentMonth() as Month;
    this.convertFx = graph.convertFx(data);
    this.displayCurrency = displayCurrency ?? graph.userCurrency(data);
    if (!(this.displayCurrency in graph.currentFxRates(data).rates))
      throw new ToolInputError(`Display currency ${this.displayCurrency} is not a ZenMoney instrument`);
  }

  get graph() {
    return this.snap.graph;
  }
  get data() {
    return this.snap.data;
  }

  month(wanted?: string): Month {
    const month = (wanted ?? this.currentMonth) as Month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ToolInputError(`Month must be YYYY-MM, got "${month}"`);
    if (!this.months.includes(month))
      throw new ToolInputError(
        `Zerro has no budget for ${month}. Available months: ${this.months[0]} to ${this.months.at(-1)}.`,
      );
    return month;
  }

  /** Converts at the month's rates, as Zerro's budget screen does. */
  convert(amount: TFxAmount | undefined, currency: string, month: Month): number {
    if (!amount) return 0;
    return round2(this.convertFx(amount, currency, month));
  }

  ratesSource(month: Month): string {
    const rates = this.graph.fxRatesGetter(this.data)(month);
    return `${rates.type} rates for ${rates.date}`;
  }

  syncedAt(): string {
    return new Date(this.snap.syncedAt).toISOString();
  }

  envelopes(): Record<TEnvelopeId, TEnvelope> {
    return this.graph.envelopes(this.data) as Record<TEnvelopeId, TEnvelope>;
  }

  /** Exact id (tag#…, account#…, merchant#…, payee#…) or an unambiguous name. */
  resolveEnvelope(query: string): TEnvelope {
    const all = this.envelopes();
    const q = query.trim();
    if (all[q as TEnvelopeId]) return all[q as TEnvelopeId];
    const norm = (s: string) => s.trim().toLowerCase();
    const exact = Object.values(all).filter(e => norm(e.name) === norm(q));
    if (exact.length === 1) return exact[0];
    const candidates = exact.length ? exact : Object.values(all).filter(e => norm(e.name).includes(norm(q)));
    if (candidates.length === 1 && !exact.length)
      throw new ToolInputError(`No envelope named "${q}". Did you mean "${candidates[0].name}" (${candidates[0].id})?`);
    if (!candidates.length) throw new ToolInputError(`No envelope matches "${q}".`);
    const list = candidates.slice(0, 15).map(e => `- ${e.name} (${e.id}${e.parent ? `, in ${all[e.parent]?.name}` : ""})`);
    throw new ToolInputError(`"${q}" matches several envelopes; pass the id:\n${list.join("\n")}`);
  }

  /** Zerro's default visibility for the month (EnvelopeTable/envRenderInfo). */
  visibleIds(month: Month): Set<TEnvelopeId> {
    const envs = this.envelopes();
    const metrics = this.graph.envMetrics(this.data)[month];
    const goals = this.graph.goals(this.data)[month] ?? {};
    const visible = new Set<TEnvelopeId>();
    const nonZero = (a: TFxAmount) => Object.values(a).some(v => v);
    const check = (e: TEnvelope) => {
      if (e.visibility === envelopeVisibility.hidden) return;
      const m = metrics[e.id];
      if (
        e.visibility === envelopeVisibility.visible ||
        goals[e.id]?.goal ||
        nonZero(m.selfAssigned) ||
        nonZero(m.selfActivity) ||
        nonZero(m.selfAvailable) ||
        e.children.some(id => visible.has(id))
      )
        visible.add(e.id);
    };
    Object.values(envs).filter(e => e.parent).forEach(check);
    Object.values(envs).filter(e => !e.parent).forEach(check);
    return visible;
  }
}

export function header(view: View, month?: Month): string {
  const parts = [`Synced ${view.syncedAt()}`];
  if (month) parts.push(view.ratesSource(month));
  return `(${parts.join("; ")}. Confirmed ZenMoney state; unsent edits in an open Zerro tab are not visible here.)`;
}
