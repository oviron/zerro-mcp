import { createHash } from "node:crypto";
import {
  buildOutboxTransport,
  compileApplyBudgetPreset,
  compileCoverOverspending,
  compileMoveBudgetFunds,
  compileSetTotalAssigned,
  createProjectionGraph,
  stageCompiledCommand,
  type TCompiled,
  type TDataStore,
  type TEnvelopeId,
  type TNormalizedPatch,
} from "../core";
import type { Snapshot } from "../replica";
import { fmt, ToolInputError, View, type Month } from "../view";

export type Action =
  | { kind: "set"; month: Month; envelope: TEnvelopeId; amount: number }
  | { kind: "move"; month: Month; from: TEnvelopeId | "toBeAssigned"; to: TEnvelopeId | "toBeAssigned"; amount: number; currency: string }
  | { kind: "cover"; month: Month; envelope?: TEnvelopeId };

/** One own-assignment that the action changes, in the envelope currency. */
export type BudgetChange = { month: Month; id: TEnvelopeId; name: string; currency: string; from: number; to: number };

export type EnvelopeEffect = {
  id: TEnvelopeId;
  name: string;
  currency: string;
  assigned: [number, number];
  available: [number, number];
};

export type Plan = {
  action: Action;
  token: string;
  changes: BudgetChange[];
  effects: EnvelopeEffect[];
  toBeAssigned: { month: Month; currency: string; before: number; after: number }[];
  transport: TNormalizedPatch;
  /** Server rows the transport replaces, as they are now: the rollback copy. */
  original: Record<string, unknown[]>;
  /** Expected own-assignments for every month after the write. */
  expectedBudgets: Record<string, Record<string, number>>;
  /** Envelopes and months whose figures the preview shows. */
  watched: { envelopes: TEnvelopeId[]; months: Month[] };
};

export class NothingToChange extends Error {}

function compile(view: View, action: Action): TCompiled {
  const { data, graph, ctx } = view.snap;
  switch (action.kind) {
    case "set":
      return compileSetTotalAssigned(data, { month: action.month, id: action.envelope, amount: action.amount }, ctx, graph);
    case "move":
      return compileMoveBudgetFunds(
        data,
        { month: action.month, from: action.from, to: action.to, money: { amount: action.amount, currency: action.currency } },
        ctx,
        graph,
      );
    case "cover":
      return action.envelope
        ? compileApplyBudgetPreset(data, { month: action.month, id: action.envelope, kind: "coverOverspending" }, ctx, graph)
        : compileCoverOverspending(data, action.month, ctx, graph);
  }
}

const budgetsOf = (view: View) => view.graph.budgets(view.data) as Record<string, Record<string, number>>;

/**
 * Compiles the action with Zerro's own compiler and runs it in memory:
 * what changes, what it leads to, and the exact rows to send. The token is
 * a fingerprint of all of that plus the versions of the rows it replaces,
 * so any change on the server in between gives a different token.
 */
export function planAction(snap: Snapshot, action: Action, displayCurrency?: string): Plan {
  const before = new View(snap, displayCurrency);
  const compiled = compile(before, action);
  if (!compiled.operations.length) throw new NothingToChange("Nothing to change: the budget already looks like that.");
  const issuedAt = snap.ctx.now();
  let current: TDataStore;
  let transport: TNormalizedPatch | undefined;
  try {
    const staged = stageCompiledCommand(snap.data, [], compiled, issuedAt);
    current = staged.current;
    transport = buildOutboxTransport(snap.data, staged.outbox, issuedAt);
  } catch (error) {
    if ((error as Error).message.includes("did not change")) throw new NothingToChange("Nothing to change: the budget already looks like that.");
    throw error;
  }
  if (!transport) throw new NothingToChange("Nothing to change: the budget already looks like that.");

  const after = new View({ ...snap, data: current, graph: createProjectionGraph(snap.ctx) }, displayCurrency);
  const envs = before.envelopes();
  const b0 = budgetsOf(before);
  const b1 = budgetsOf(after);

  const changes: BudgetChange[] = [];
  for (const month of new Set([...Object.keys(b0), ...Object.keys(b1)])) {
    for (const id of new Set([...Object.keys(b0[month] ?? {}), ...Object.keys(b1[month] ?? {})])) {
      const from = b0[month]?.[id] ?? 0;
      const to = b1[month]?.[id] ?? 0;
      if (from !== to) {
        const env = envs[id as TEnvelopeId];
        changes.push({ month: month as Month, id: id as TEnvelopeId, name: env?.name ?? id, currency: env?.currency ?? "", from, to });
      }
    }
  }
  changes.sort((a, b) => (a.month + a.id).localeCompare(b.month + b.id));

  const affected = new Set<TEnvelopeId>();
  for (const c of changes) {
    if (c.month !== action.month) continue;
    affected.add(c.id);
    const parent = envs[c.id]?.parent;
    if (parent) affected.add(parent);
  }
  const watched = {
    envelopes: [...affected],
    months: [...new Set([action.month, before.currentMonth])].filter(m => before.months.includes(m)),
  };
  const was = measure(before, action.month, watched);
  const will = measure(after, action.month, watched);
  const effects: EnvelopeEffect[] = will.envelopes.map((e, i) => ({
    ...e,
    assigned: [was.envelopes[i].assigned, e.assigned],
    available: [was.envelopes[i].available, e.available],
  }));
  const toBeAssigned = will.toBeAssigned.map((t, i) => ({ ...t, before: was.toBeAssigned[i].value, after: t.value })).map(
    ({ value: _v, ...t }) => t,
  );

  const original: Record<string, unknown[]> = {};
  const versions: Record<string, unknown> = {};
  const t = transport as Record<string, unknown>;
  for (const [key, rows] of Object.entries(t)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as { id?: string | number; object?: string }[]) {
      const table = key === "deletion" ? (row.object as string) : key;
      const id = row.id as string | number;
      const existing = (snap.data as unknown as Record<string, Record<string | number, { changed?: number }>>)[table]?.[id];
      if (existing) {
        versions[`${table}:${id}`] = existing.changed ?? null;
        (original[table] ??= []).push(existing);
      } else {
        // New rows get fresh random ids on every compile: count them, not name them.
        versions[`${table}:new`] = ((versions[`${table}:new`] as number) ?? 0) + 1;
      }
    }
  }

  // Everything the write depends on and produces, minus send times and the
  // random ids of rows it creates: equal state gives an equal token.
  const rates = {
    month: before.graph.fxRatesGetter(before.data)(action.month).rates,
    current: before.graph.currentFxRates(before.data).rates,
  };
  const token = createHash("sha256")
    .update(
      stableJson({ action, changes, effects, toBeAssigned, versions, rates, expected: b1, sent: canonicalTransport(transport, snap.data), transactions: transactionsDigest(snap.data) }),
    )
    .digest("hex")
    .slice(0, 16);

  return { action, token, changes, effects, toBeAssigned, transport, original, expectedBudgets: b1, watched };
}

export function describePlan(plan: Plan): string {
  const lines = ["Budget changes (own assignment per envelope):"];
  for (const c of plan.changes) lines.push(`- ${c.month} ${c.name} [${c.id}]: ${fmt(c.from, c.currency)} → ${fmt(c.to, c.currency)}`);
  if (plan.effects.length) {
    lines.push(`Envelopes in ${plan.action.month} (with children):`);
    for (const e of plan.effects)
      lines.push(
        `- ${e.name}: assigned ${fmt(e.assigned[0], e.currency)} → ${fmt(e.assigned[1], e.currency)}, available ${fmt(e.available[0], e.currency)} → ${fmt(e.available[1], e.currency)}`,
      );
  }
  for (const t of plan.toBeAssigned)
    lines.push(`To be assigned in ${t.month}: ${fmt(t.before, t.currency)} → ${fmt(t.after, t.currency)}`);
  const stores = Object.keys(plan.transport).filter(k => k !== "serverTimestamp");
  lines.push(`Rows to send: ${stores.map(k => `${(plan.transport as Record<string, unknown[]>)[k].length} ${k}`).join(", ")}.`);
  return lines.join("\n");
}

export function requireEnvelopeOrTba(view: View, query: string): TEnvelopeId | "toBeAssigned" {
  const q = query.trim().toLowerCase();
  if (["tobeassigned", "to be assigned", "не распределено"].includes(q)) return "toBeAssigned";
  return view.resolveEnvelope(query).id;
}

export function requireAmount(amount: number, positive: boolean) {
  if (!Number.isFinite(amount)) throw new ToolInputError("Amount must be a finite number");
  if (positive && amount <= 0) throw new ToolInputError("Amount must be positive");
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) throw new ToolInputError("Amount has more than 2 decimal places");
}

export type Measured = {
  envelopes: { id: TEnvelopeId; name: string; currency: string; assigned: number; available: number }[];
  toBeAssigned: { month: Month; currency: string; value: number }[];
};

/** The figures a preview shows, measured on any snapshot. */
export function measure(view: View, month: Month, watched: Plan["watched"]): Measured {
  const envs = view.envelopes();
  const metrics = view.graph.envMetrics(view.data)[month];
  const totals = view.graph.monthTotals(view.data);
  const cur = view.displayCurrency;
  return {
    // An envelope can disappear between preview and verification (its category deleted).
    envelopes: watched.envelopes.filter(id => envs[id] && metrics?.[id]).map(id => {
      const c = envs[id].currency;
      return {
        id,
        name: envs[id].name,
        currency: c,
        assigned: view.convert(metrics[id].totalAssigned, c, month),
        available: view.convert(metrics[id].totalAvailable, c, month),
      };
    }),
    toBeAssigned: watched.months.filter(m => totals[m]).map(m => ({ month: m, currency: cur, value: view.convert(totals[m].toBeAssigned, cur, m) })),
  };
}

const VOLATILE = new Set(["changed", "created", "stamp", "serverTimestamp"]);

/** The transport without send times, with created rows' random ids replaced by stable names. */
export function canonicalTransport(transport: TNormalizedPatch, base: TDataStore): unknown {
  const fresh: string[] = [];
  const b = base as unknown as Record<string, Record<string, unknown>>;
  for (const [key, rows] of Object.entries(transport as Record<string, unknown>)) {
    if (!Array.isArray(rows) || key === "deletion") continue;
    for (const row of rows as { id: string | number }[]) if (b[key]?.[row.id] === undefined) fresh.push(String(row.id));
  }
  let json = JSON.stringify(transport);
  fresh.forEach((id, i) => (json = json.split(id).join(`new#${i}`)));
  return strip(JSON.parse(json));
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)]));
  return v;
}

/** JSON with sorted keys, so equal content always hashes equally. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** Any added, changed or deleted transaction changes this, and with it the token. */
function transactionsDigest(data: TDataStore): string {
  const h = createHash("sha256");
  for (const t of Object.values(data.transaction).sort((a, b) => (a.id < b.id ? -1 : 1))) h.update(`${t.id}:${t.changed};`);
  return h.digest("hex");
}
