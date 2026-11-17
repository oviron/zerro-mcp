import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchToWire, wireToPatch } from "../src/zenmoney/wire";
import { BUDGET_DOC, connect, fixture, FakeZenMoney, NOW, ZERRO_ACCOUNT } from "./fake";

const budgetsDoc = (fake: FakeZenMoney) => JSON.parse(fake.get("reminder", BUDGET_DOC)!.comment as string);

describe("wire", () => {
  it("converts seconds to ms and back, with synthetic budget ids", () => {
    const wire = { serverTimestamp: 100, budget: [{ date: "2026-11-01", tag: "food", changed: 5 }], deletion: [{ id: "x", object: "tag", stamp: 7, user: 1 }] };
    const patch = wireToPatch(wire) as any;
    expect(patch.serverTimestamp).toBe(100_000);
    expect(patch.budget[0]).toMatchObject({ id: "2026-11-01#food", changed: 5000 });
    expect(patch.deletion[0].stamp).toBe(7000);
    expect(patchToWire(patch)).toEqual(wire);
  });
});

describe("read tools", () => {
  it("lists envelopes with Zerro's figures", async () => {
    const { call } = await connect();
    const r = await call("get_envelopes", { month: "2026-11" });
    expect(r.isError).toBe(false);
    const food = r.data!.envelopes.find((e: any) => e.id === "tag#food");
    expect(food.total).toEqual({ leftover: 0, assigned: 1000, activity: -1200, available: -200 });
    expect(food.group).toBe("Categories");
  });

  it("summarises the month", async () => {
    const { call } = await connect();
    const r = await call("get_month_summary", { month: "2026-11" });
    expect(r.data).toMatchObject({ assigned: 1500, overspend: -200, // Free money is what the budget holds minus what envelopes keep: 48 800 − (−200 + 500).
    toBeAssigned: 48500 });
  });

  it("routes envelope activity", async () => {
    const { call } = await connect();
    const r = await call("get_envelope_activity", { envelope: "Food", month: "2026-11" });
    expect(r.data!.transactions.map((t: any) => t.id)).toEqual(["groceries"]);
  });

  it("reports where an inherited goal was set and shows percent goals as percent", async () => {
    const server = new FakeZenMoney();
    const doc = server.get("reminder", BUDGET_DOC)!;
    server.write({ reminder: [{ ...doc, id: "goals-10", comment: JSON.stringify({ type: "goals", month: "2026-10", payload: { "tag#home": { type: "incomePercent", amount: 0.25 } } }) }] } as any);
    const { call } = await connect({ server });
    const r = await call("get_goals", { month: "2026-11" });
    expect(r.data!.goals[0]).toMatchObject({ envelope: "tag#home", setIn: "2026-10", amount: 0.25 });
    expect(r.text).toMatch(/25% of income/);
  });

  it("rejects months outside Zerro's range", async () => {
    const { call } = await connect();
    const r = await call("get_envelopes", { month: "2031-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Available months/);
  });

  it("asks for an id when a name is ambiguous", async () => {
    const server = new FakeZenMoney();
    server.write({ tag: [{ ...(server.get("tag", "home") as object), id: "home2", changed: 2_000_000_000 }] } as any);
    const { call } = await connect({ server });
    const r = await call("get_envelopes", { envelope: "Home" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/tag#home2/);
  });
});

describe("write tools", () => {
  it("are absent unless writes are enabled", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).not.toContain("set_envelope_budget");
  });

  it("preview changes nothing; confirm writes, keeps other keys and closes the journal", async () => {
    const { call, fake, stateDir } = await connect({ write: true });
    const preview = await call("set_envelope_budget", { envelope: "Food", amount: 1200, month: "2026-11" });
    expect(preview.data).toMatchObject({ status: "preview" });
    expect(fake.pushes()).toHaveLength(0);
    const token = preview.data!.token;

    const done = await call("set_envelope_budget", { envelope: "Food", amount: 1200, month: "2026-11", confirm: token });
    expect(done.isError).toBe(false);
    expect(done.data).toMatchObject({ status: "confirmed" });
    expect(budgetsDoc(fake).payload).toEqual({ "tag#food": 1200, "tag#home": 500 });
    expect(fake.get("reminder", BUDGET_DOC)!.changed).toBe(NOW / 1000);

    const files = readdirSync(join(stateDir, "journal"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/\.open\./);
    const journal = JSON.parse(readFileSync(join(stateDir, "journal", files[0]), "utf8"));
    expect(journal.status).toBe("confirmed");
    expect(JSON.parse(journal.original.reminder[0].comment).payload["tag#food"]).toBe(1000);
  });

  it("gives the same token for the same state and refuses a stale one", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1200, month: "2026-11" };
    const a = await call("set_envelope_budget", args);
    const b = await call("set_envelope_budget", args);
    expect(a.data!.token).toBe(b.data!.token);

    // Someone edits the same month in Zerro after the preview.
    const doc = fake.get("reminder", BUDGET_DOC)!;
    fake.write({ reminder: [{ ...doc, changed: (doc.changed as number) + 5, comment: JSON.stringify({ type: "budgets", month: "2026-11", payload: { "tag#food": 1000, "tag#home": 700 } }) }] } as any);
    const r = await call("set_envelope_budget", { ...args, confirm: a.data!.token });
    expect(r.data).toMatchObject({ status: "preview" });
    expect(r.text).toMatch(/changed since that preview/);
    expect(fake.pushes()).toHaveLength(0);
  });

  it("moves funds between envelopes and from To be assigned", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { from: "toBeAssigned", to: "Home", amount: 1, currency: "USD", month: "2026-11" };
    const p = await call("move_envelope_funds", args);
    expect(p.data!.changes).toEqual([expect.objectContaining({ id: "tag#home", from: 500, to: 590 })]);
    await call("move_envelope_funds", { ...args, confirm: p.data!.token });
    expect(budgetsDoc(fake).payload["tag#home"]).toBe(590);
  });

  it("covers overspend", async () => {
    const { call, fake } = await connect({ write: true });
    const p = await call("cover_overspend", { month: "2026-11" });
    expect(p.data!.toBeAssigned[0]).toMatchObject({ before: 48500, after: 48300 });
    await call("cover_overspend", { month: "2026-11", confirm: p.data!.token });
    expect(budgetsDoc(fake).payload["tag#food"]).toBe(1200);
  });

  it("says when there is nothing to change", async () => {
    const { call } = await connect({ write: true });
    const r = await call("set_envelope_budget", { envelope: "Food", amount: 1000, month: "2026-11" });
    expect(r.text).toMatch(/Nothing to change/);
  });

  it("recovers a lost answer by pulling, without retrying", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.fault = "lost";
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.data).toMatchObject({ status: "confirmed" });
    expect(r.text).toMatch(/answer was lost/);
    expect(fake.pushes()).toHaveLength(1);
  });

  it("reports a dropped write as unconfirmed and leaves the journal open", async () => {
    const { call, fake, stateDir } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.fault = "dropped";
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: "unconfirmed" });
    expect(fake.pushes()).toHaveLength(1);
    expect(budgetsDoc(fake).payload["tag#food"]).toBe(1000);
    expect(readdirSync(join(stateDir, "journal"))[0]).toMatch(/\.open\.json$/);
  });

  it("refuses to write over duplicated Zerro documents", async () => {
    const server = new FakeZenMoney();
    const doc = server.get("reminder", BUDGET_DOC)!;
    server.write({ reminder: [{ ...doc, id: "dup" }] } as any);
    const { call } = await connect({ write: true, server });
    const r = await call("set_envelope_budget", { envelope: "Home", amount: 600, month: "2026-11" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/stored twice/);
    expect(server.pushes()).toHaveLength(0);
  });

  it("finds duplicates on any account, as the core does, and ignores plain comments", async () => {
    const server = new FakeZenMoney();
    const doc = server.get("reminder", BUDGET_DOC)!;
    server.write({ reminder: [
      { ...doc, id: "note", comment: "just a note" },
      { ...doc, id: "elsewhere", incomeAccount: "card", outcomeAccount: "card" },
    ] } as any);
    const { call } = await connect({ write: true, server });
    const r = await call("set_envelope_budget", { envelope: "Home", amount: 600, month: "2026-11" });
    expect(r.text).toMatch(/stored twice \(reminders doc-budgets-2026-11 and elsewhere\)/);
    expect(r.text).not.toMatch(/note/);
  });

  it("refuses payloads Zerro would misread", async () => {
    const server = new FakeZenMoney();
    const doc = server.get("reminder", BUDGET_DOC)!;
    server.write({ reminder: [{ ...doc, id: "settings", comment: JSON.stringify({ type: "UserSettings", payload: { preferZmBudgets: "false" } }) }] } as any);
    const { call } = await connect({ write: true, server });
    const r = await call("set_envelope_budget", { envelope: "Home", amount: 600, month: "2026-11" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/preferZmBudgets is not a boolean/);
  });

  it("changes the token when other budgets move, even if totals stay", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Cafe", amount: 100, month: "2026-11" };
    const a = await call("set_envelope_budget", args);
    const doc = fake.get("reminder", BUDGET_DOC)!;
    // Food and Home swap 100 between them in another client: same sum, different budgets.
    fake.write({ reminder: [{ ...doc, changed: (doc.changed as number) + 5, comment: JSON.stringify({ type: "budgets", month: "2026-11", payload: { "tag#food": 900, "tag#home": 600 } }) }] } as any);
    const b = await call("set_envelope_budget", args);
    expect(b.data!.token).not.toBe(a.data!.token);
  });

  it("changes the token when rates change", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { from: "toBeAssigned", to: "Home", amount: 1, currency: "USD", month: "2026-11" };
    const a = await call("move_envelope_funds", args);
    const usd = fake.get("instrument", "1")!;
    fake.write({ instrument: [{ ...usd, rate: 91, changed: (usd.changed as number) + 5 }] } as any);
    const r = await call("move_envelope_funds", { ...args, confirm: a.data!.token });
    expect(r.data).toMatchObject({ status: "preview" });
    expect(fake.pushes()).toHaveLength(0);
  });

  it("treats a 503 after the write as an unknown outcome and recovers by pulling", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.fault = "error503";
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.data).toMatchObject({ status: "confirmed" });
    expect(fake.pushes()).toHaveLength(1);
  });

  it("closes the journal as refused on a 4xx", async () => {
    const { call, fake, stateDir } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.fault = "refused";
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.isError).toBe(true);
    const [file] = readdirSync(join(stateDir, "journal"));
    expect(JSON.parse(readFileSync(join(stateDir, "journal", file), "utf8")).status).toBe("refused");
  });

  it("re-measures figures after the write when other data moved them", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.afterPush = () =>
      fake.write({ transaction: [{ ...fake.get("transaction", "groceries")!, id: "more", outcome: 300, changed: 2_000_000_000 }] } as any);
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.data).toMatchObject({ status: "confirmed" });
    expect(r.data!.now.envelopes[0]).toMatchObject({ id: "tag#food", available: -200 });
    expect(r.text).toMatch(/preview said 100 RUB/);
  });

  it("flags a write that someone overwrote right after it", async () => {
    const { call, fake } = await connect({ write: true });
    const args = { envelope: "Food", amount: 1300, month: "2026-11" };
    const p = await call("set_envelope_budget", args);
    fake.afterPush = () => {
      const doc = fake.get("reminder", BUDGET_DOC)!;
      fake.write({ reminder: [{ ...doc, changed: (doc.changed as number) + 5, comment: JSON.stringify({ type: "budgets", month: "2026-11", payload: { "tag#food": 1000, "tag#home": 500 } }) }] } as any);
    };
    const r = await call("set_envelope_budget", { ...args, confirm: p.data!.token });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: "unconfirmed" });
    expect(r.text).toMatch(/still 1,000 RUB, expected 1,300 RUB/);
  });

  it("lets only one process hold the write lock", async () => {
    const { WriteLock } = await import("../src/write/guard");
    const dir = mkdtempSync(join(tmpdir(), "zerro-lock-"));
    const a = new WriteLock(dir);
    const b = new WriteLock(dir);
    a.acquire();
    // Same pid counts as alive, so the second holder is refused rather than stealing.
    writeFileSync(join(dir, "write.lock"), `${process.ppid}:other`);
    expect(() => b.acquire()).toThrow(/is writing/);
    a.release();
    expect(readFileSync(join(dir, "write.lock"), "utf8")).toBe(`${process.ppid}:other`);
    writeFileSync(join(dir, "write.lock"), "999999:dead");
    b.acquire();
    b.release();
  });

  it("creates the Zerro document when a month has none", async () => {
    const wire = fixture();
    delete (wire as any).reminder;
    (wire as any).account = (wire as any).account.filter((a: any) => a.id !== ZERRO_ACCOUNT);
    const server = new FakeZenMoney(wire);
    const { call } = await connect({ write: true, server });
    const p = await call("set_envelope_budget", { envelope: "Food", amount: 900, month: "2026-11" });
    const r = await call("set_envelope_budget", { envelope: "Food", amount: 900, month: "2026-11", confirm: p.data!.token });
    expect(r.data).toMatchObject({ status: "confirmed" });
    const accounts = [...server.rows.get("account")!.values()].map(r => r.row.title);
    expect(accounts).toContain("🤖 [Zerro Data]");
  });

  it("writes category budgets to native ZenMoney budgets when Zerro is set to", async () => {
    const server = new FakeZenMoney();
    const doc = server.get("reminder", BUDGET_DOC)!;
    server.write({
      reminder: [{ ...doc, id: "settings", comment: JSON.stringify({ type: "UserSettings", payload: { preferZmBudgets: true } }) }],
    } as any);
    const { call } = await connect({ write: true, server });
    const p = await call("set_envelope_budget", { envelope: "Home", amount: 650, month: "2026-11" });
    const r = await call("set_envelope_budget", { envelope: "Home", amount: 650, month: "2026-11", confirm: p.data!.token });
    expect(r.data).toMatchObject({ status: "confirmed" });
    expect(server.get("budget", "2026-11-01#home")).toMatchObject({ outcome: 650 });
  });
});
