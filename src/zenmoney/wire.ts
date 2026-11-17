import type { TNormalizedPatch } from "../core";

/**
 * ZenMoney's /v8/diff/ speaks seconds; Zerro's core speaks milliseconds and
 * gives budgets a synthetic id. These two functions are the whole boundary,
 * mirroring Zerro's own adapter (src/6-shared/api/zm-adapter/converters.ts).
 */
type Row = Record<string, unknown>;
export type WireDiff = Record<string, unknown> & { serverTimestamp?: number };

const ms = (s: unknown) => (typeof s === "number" ? s * 1000 : s);
const sec = (m: unknown) => (typeof m === "number" ? Math.round(m / 1000) : m);

const withTimes = (row: Row, conv: (v: unknown) => unknown, fields: string[]): Row => {
  const out: Row = { ...row };
  for (const f of fields) if (f in out) out[f] = conv(out[f]);
  return out;
};

const TIME_FIELDS: Record<string, string[]> = {
  instrument: ["changed"],
  country: [],
  company: ["changed"],
  user: ["changed", "paidTill"],
  merchant: ["changed"],
  account: ["changed"],
  tag: ["changed"],
  budget: ["changed"],
  reminder: ["changed"],
  reminderMarker: ["changed"],
  transaction: ["changed", "created"],
  deletion: ["stamp"],
};

export const budgetId = (date: string, tag: string | null) => `${date}#${tag}`;

export function wireToPatch(diff: WireDiff): TNormalizedPatch {
  const out: Record<string, unknown> = { serverTimestamp: 0 };
  if (diff.serverTimestamp) out.serverTimestamp = diff.serverTimestamp * 1000;
  for (const [key, fields] of Object.entries(TIME_FIELDS)) {
    const rows = diff[key];
    if (!Array.isArray(rows)) continue;
    out[key] = rows.map((r: Row) => {
      const row = withTimes(r, ms, fields);
      if (key === "budget") row.id = budgetId(row.date as string, row.tag as string | null);
      return row;
    });
  }
  return out as TNormalizedPatch;
}

export function patchToWire(patch: TNormalizedPatch): WireDiff {
  const out: WireDiff = {};
  const p = patch as Record<string, unknown>;
  if (p.serverTimestamp) out.serverTimestamp = sec(p.serverTimestamp) as number;
  for (const [key, fields] of Object.entries(TIME_FIELDS)) {
    const rows = p[key];
    if (!Array.isArray(rows)) continue;
    out[key] = rows.map((r: Row) => {
      const row = withTimes(r, sec, fields);
      if (key === "budget") delete row.id;
      return row;
    });
  }
  return out;
}
