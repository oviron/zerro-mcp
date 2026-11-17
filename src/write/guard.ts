import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TDataStore } from "../core";
import { ToolInputError } from "../view";

const KNOWN_TYPES = new Set(["goals", "fxRates", "budgets", "linkedAccounts", "linkedDebtors", "EnvelopeMeta", "UserSettings", "tagOrder"]);
const MONTHLY_TYPES = new Set(["goals", "budgets", "fxRates"]);
const GOAL_TYPES = new Set(["monthly", "monthlySpend", "targetBalance", "incomePercent"]);
const VISIBILITY = new Set(["hidden", "visible", "auto"]);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Refuses to write when Zerro's stored documents are not what Zerro itself
 * would write. The core finds documents in every reminder by their JSON, so
 * this check does too: duplicates of one (type, month) — Zerro silently keeps
 * the last and a write would bury the others — and payloads of the wrong
 * shape, which change the numbers or break the compilers. Plain-text comments
 * are not documents and are skipped.
 */
export function checkHiddenDocuments(data: TDataStore): void {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const r of Object.values(data.reminder)) {
    const doc = parseDocument(r.comment);
    if (!doc) continue;
    const monthly = MONTHLY_TYPES.has(doc.type);
    if (monthly && (typeof doc.month !== "string" || !MONTH.test(doc.month))) {
      problems.push(`reminder ${r.id}: ${doc.type} document without a valid month`);
      continue;
    }
    const key = monthly ? `${doc.type}:${doc.month}` : doc.type;
    const dup = seen.get(key);
    if (dup) problems.push(`document ${key} is stored twice (reminders ${dup} and ${r.id})`);
    seen.set(key, r.id);
    const shapeError = checkPayload(doc.type, doc.payload);
    if (shapeError) problems.push(`document ${key}: ${shapeError}`);
  }
  if (problems.length)
    throw new ToolInputError(`Refusing to write: Zerro's stored data looks damaged. Fix it in Zerro first.\n- ${problems.join("\n- ")}`);
}

/** Same recognition as the core's parseHiddenDataComment, limited to known types. */
function parseDocument(comment: string | null): { type: string; month?: unknown; payload: unknown } | null {
  if (!comment) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment);
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.type !== "string" || !("payload" in parsed)) return null;
  if (!KNOWN_TYPES.has(parsed.type)) return null;
  return parsed as { type: string; month?: unknown; payload: unknown };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

function checkPayload(type: string, payload: unknown): string | null {
  switch (type) {
    case "budgets":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, v] of Object.entries(payload)) if (!isNum(v)) return `amount for ${id} is not a finite number`;
      return null;
    case "goals":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, g] of Object.entries(payload)) {
        if (g === null) continue;
        if (!isObject(g)) return `goal for ${id} is not an object`;
        if (typeof g.type !== "string" || !GOAL_TYPES.has(g.type)) return `goal for ${id} has unknown type ${JSON.stringify(g.type)}`;
        if (!isNum(g.amount)) return `goal for ${id} has no finite amount`;
        if (g.end !== undefined && g.end !== null && (typeof g.end !== "string" || !DATE.test(g.end))) return `goal for ${id} has a bad end date`;
      }
      return null;
    case "EnvelopeMeta":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, m] of Object.entries(payload)) {
        if (!isObject(m)) return `meta for ${id} is not an object`;
        for (const f of ["keepIncome", "carryNegatives"] as const)
          if (m[f] !== undefined && typeof m[f] !== "boolean") return `meta ${f} for ${id} is not a boolean`;
        for (const f of ["group", "comment", "currency", "parent"] as const)
          if (m[f] !== undefined && m[f] !== null && typeof m[f] !== "string") return `meta ${f} for ${id} is not a string`;
        if (m.index !== undefined && m.index !== null && !isNum(m.index)) return `meta index for ${id} is not a number`;
        if (m.visibility !== undefined && m.visibility !== null && !VISIBILITY.has(m.visibility as string))
          return `meta visibility for ${id} is ${JSON.stringify(m.visibility)}`;
      }
      return null;
    case "UserSettings":
      if (!isObject(payload)) return "payload is not an object";
      for (const f of ["preferZmBudgets", "sawMigrationAlert"] as const)
        if (payload[f] !== undefined && typeof payload[f] !== "boolean") return `${f} is not a boolean`;
      return null;
    default:
      return null;
  }
}

/**
 * One writer across processes on this machine. The lock file appears
 * atomically with its owner already inside (written aside, then hard-linked),
 * and only the owner removes it.
 */
export class WriteLock {
  private path: string;
  private owner?: string;

  constructor(private dir: string) {
    this.path = join(dir, "write.lock");
  }

  acquire(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
    const draft = join(this.dir, `write.lock.${owner.replace(":", "-")}`);
    writeFileSync(draft, owner, { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          linkSync(draft, this.path);
          this.owner = owner;
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const holder = this.read();
        const pid = Number(holder?.split(":")[0]);
        if (holder && pid && alive(pid))
          throw new ToolInputError(`Another zerro-mcp process (pid ${pid}) is writing. Try again in a moment.`);
        this.removeStale(holder);
      }
      throw new ToolInputError("Could not take the write lock.");
    } finally {
      rmSync(draft, { force: true });
    }
  }

  release(): void {
    if (this.owner && this.read() === this.owner) rmSync(this.path, { force: true });
    this.owner = undefined;
  }

  private read(): string | undefined {
    try {
      return readFileSync(this.path, "utf8");
    } catch {
      return undefined;
    }
  }

  /** Moves the lock aside and deletes it only if it is still the dead holder's. */
  private removeStale(holder: string | undefined) {
    const aside = join(this.dir, `write.lock.stale-${randomBytes(8).toString("hex")}`);
    try {
      renameSync(this.path, aside);
    } catch {
      return;
    }
    if (readFileSync(aside, "utf8") !== holder) {
      // A live process took the lock in between: put it back unless yet another one did.
      try {
        linkSync(aside, this.path);
      } catch {
        /* someone holds a newer lock; theirs stands */
      }
    }
    rmSync(aside, { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Private record of one write: the rows before, what was sent, how it ended.
 * An open journal is a write whose outcome is not confirmed; a closed one
 * stays as the backup to roll back from. Every save replaces the file
 * atomically, so a crash never leaves it truncated.
 */
export class Journal {
  private file: string;
  private entry: Record<string, unknown>;

  constructor(dir: string, token: string, entry: Record<string, unknown>) {
    const journalDir = join(dir, "journal");
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(journalDir, `${stamp}-${token}.open.json`);
    this.entry = { startedAt: new Date().toISOString(), ...entry };
    this.save();
  }

  update(fields: Record<string, unknown>): void {
    Object.assign(this.entry, fields);
    this.save();
  }

  close(fields: Record<string, unknown>): string {
    this.update({ ...fields, closedAt: new Date().toISOString() });
    const closed = this.file.replace(/\.open\.json$/, ".json");
    renameSync(this.file, closed);
    this.file = closed;
    return closed;
  }

  get path(): string {
    return this.file;
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entry, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
