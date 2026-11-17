import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { Replica } from "../src/replica";
import { createServer } from "../src/server";
import { UnknownOutcomeError, type DiffClient, type DiffRequest } from "../src/zenmoney/client";
import type { WireDiff } from "../src/zenmoney/wire";

type Row = Record<string, unknown> & { changed?: number };
const KEYS = ["instrument", "country", "company", "user", "merchant", "account", "tag", "budget", "reminder", "reminderMarker", "transaction"];
const rowId = (key: string, row: Row) => (key === "budget" ? `${row.date}#${row.tag}` : String(row.id));

export const NOW = Date.parse("2026-11-17T12:00:00Z");
const T = Math.round(Date.parse("2026-10-01T00:00:00Z") / 1000);
export const ZERRO_ACCOUNT = "zerro-acc";
export const BUDGET_DOC = "doc-budgets-2026-11";

export function fixture(): WireDiff {
  const tag = (id: string, title: string, parent: string | null = null) => ({
    id, changed: T, user: 1, title, parent, icon: null, staticId: null, picture: null, color: null,
    showIncome: false, showOutcome: true, budgetIncome: false, budgetOutcome: true, required: false, archive: false,
  });
  const account = (id: string, title: string, inBalance: boolean, balance: number, instrument = 2) => ({
    id, changed: T, user: 1, instrument, title, role: null, company: null, type: "checking", syncID: null,
    balance, startBalance: 0, creditLimit: 0, inBalance, savings: false, enableCorrection: false,
    balanceCorrectionType: null, enableSMS: false, archive: false, private: false, capitalization: null,
    percent: null, startDate: null, endDateOffset: null, endDateOffsetInterval: null, payoffStep: null, payoffInterval: null,
  });
  const tr = (id: string, date: string, p: Partial<Row>) => ({
    id, changed: T, created: T, user: 1, deleted: false, hold: null, viewed: true, source: null, qrCode: null,
    incomeBankID: null, income: 0, incomeInstrument: 2, incomeAccount: "card", outcomeBankID: null, outcome: 0,
    outcomeInstrument: 2, outcomeAccount: "card", tag: null, merchant: null, payee: null, originalPayee: null,
    comment: null, date, mcc: null, reminderMarker: null, opIncome: 0, opIncomeInstrument: null, opOutcome: 0,
    opOutcomeInstrument: null, latitude: null, longitude: null, ...p,
  });
  const doc = (id: string, comment: unknown) => ({
    id, changed: T, user: 1, incomeInstrument: 2, incomeAccount: ZERRO_ACCOUNT, income: 1, outcomeInstrument: 2,
    outcomeAccount: ZERRO_ACCOUNT, outcome: 0, tag: null, merchant: null, payee: null, comment: JSON.stringify(comment),
    interval: null, step: 0, points: [0], startDate: "2020-01-01", endDate: "2020-01-01", notify: false,
  });
  return {
    serverTimestamp: T,
    instrument: [
      { id: 1, changed: T, title: "US Dollar", shortTitle: "USD", symbol: "$", rate: 90 },
      { id: 2, changed: T, title: "Russian Ruble", shortTitle: "RUB", symbol: "₽", rate: 1 },
    ],
    user: [{
      id: 1, changed: T, currency: 2, parent: null, country: 1, countryCode: "RU", email: null, login: null,
      monthStartDay: 1, isForecastEnabled: false, planBalanceMode: "balance", planSettings: "", paidTill: 0,
      subscription: "", subscriptionRenewalDate: null,
    }],
    account: [account("card", "Card", true, 48800), { ...account(ZERRO_ACCOUNT, "🤖 [Zerro Data]", false, 0), archive: true }],
    tag: [tag("food", "Food"), tag("home", "Home"), tag("cafe", "Cafe", "food")],
    transaction: [
      tr("salary", "2026-10-05", { income: 50000, outcomeAccount: "card" }),
      tr("groceries", "2026-11-05", { outcome: 1200, incomeAccount: "card", tag: ["food"] }),
    ],
    reminder: [doc(BUDGET_DOC, { type: "budgets", month: "2026-11", payload: { "tag#food": 1000, "tag#home": 500 } })],
  } as WireDiff;
}

/**
 * A ZenMoney stand-in with its rules: a row replaces the stored one only
 * when its `changed` is not older; answers carry every row changed after
 * the request's cursor.
 */
export class FakeZenMoney implements DiffClient {
  rows = new Map<string, Map<string, { row: Row; stamp: number }>>();
  deletions: { row: Row; stamp: number }[] = [];
  clock: number;
  requests: DiffRequest[] = [];
  /** Next push: "lost" applies it and loses the answer, "dropped" never applies it. */
  fault?: "lost" | "dropped";

  constructor(initial: WireDiff = fixture()) {
    this.clock = (initial.serverTimestamp as number) + 100;
    for (const key of KEYS) this.rows.set(key, new Map());
    this.apply(initial, true);
  }

  async diff(request: DiffRequest): Promise<WireDiff> {
    this.requests.push(request);
    this.clock += 10;
    const isPush = KEYS.some(k => Array.isArray(request[k])) || Array.isArray(request.deletion);
    if (isPush && this.fault === "dropped") {
      this.fault = undefined;
      throw new UnknownOutcomeError("ZenMoney API request failed: no answer within 60s");
    }
    if (isPush) this.apply(request, false);
    if (isPush && this.fault === "lost") {
      this.fault = undefined;
      throw new UnknownOutcomeError("ZenMoney API request failed: no answer within 60s");
    }
    const since = request.serverTimestamp;
    const out: WireDiff = { serverTimestamp: this.clock };
    for (const [key, map] of this.rows) {
      const rows = [...map.values()].filter(r => r.stamp > since).map(r => r.row);
      if (rows.length) out[key] = rows;
    }
    const dels = this.deletions.filter(d => d.stamp > since).map(d => d.row);
    if (dels.length) out.deletion = dels;
    return out;
  }

  /** Another client writing straight to ZenMoney. */
  write(diff: WireDiff) {
    this.clock += 10;
    this.apply(diff, false);
  }

  get(key: string, id: string): Row | undefined {
    return this.rows.get(key)?.get(id)?.row;
  }

  pushes(): DiffRequest[] {
    return this.requests.filter(r => KEYS.some(k => Array.isArray(r[k])) || Array.isArray(r.deletion));
  }

  private apply(diff: WireDiff, initial: boolean) {
    const stamp = initial ? 1 : this.clock;
    for (const key of KEYS) {
      const rows = diff[key];
      if (!Array.isArray(rows)) continue;
      const map = this.rows.get(key)!;
      for (const row of rows as Row[]) {
        const id = rowId(key, row);
        const stored = map.get(id);
        if (stored && (stored.row.changed ?? 0) > (row.changed ?? 0)) continue;
        map.set(id, { row: { ...row }, stamp });
      }
    }
    for (const d of (diff.deletion as Row[] | undefined) ?? []) {
      this.rows.get(d.object as string)?.delete(String(d.id));
      this.deletions.push({ row: d, stamp });
    }
  }
}

export async function connect(options: { write?: boolean; server?: FakeZenMoney; now?: () => number } = {}) {
  const fake = options.server ?? new FakeZenMoney();
  const stateDir = mkdtempSync(join(tmpdir(), "zerro-mcp-test-"));
  const config: Config = {
    token: "test",
    apiBase: "https://api.zenmoney.ru",
    timeoutMs: 1000,
    syncTtlMs: 0,
    write: options.write ?? false,
    stateDir,
  };
  const replica = new Replica(fake, 0, options.now ?? (() => NOW));
  const server = createServer({ config, replica });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      structuredContent?: Record<string, any>;
      isError?: boolean;
    };
    return { text: r.content.map(c => c.text).join("\n"), data: r.structuredContent, isError: !!r.isError };
  };
  return { fake, client, call, stateDir };
}
