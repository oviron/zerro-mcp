import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZERRO_DATA_ACCOUNT_NAME } from "../../vendor/zerro-core/constants";
import type { TDataStore } from "../core";
import { ToolInputError } from "../view";

/**
 * Refuses to write over Zerro's hidden documents when they are not what
 * Zerro itself would write: duplicated (type, month) documents or payloads
 * of the wrong shape. Zerro reads the last duplicate and silently drops the
 * rest, so a write on top would bury the conflict.
 */
export function checkHiddenDocuments(data: TDataStore): void {
  const accounts = Object.values(data.account).filter(a => a.title === ZERRO_DATA_ACCOUNT_NAME);
  if (accounts.length > 1) throw new ToolInputError(`Refusing to write: ZenMoney has ${accounts.length} "${ZERRO_DATA_ACCOUNT_NAME}" accounts.`);
  const accountId = accounts[0]?.id;
  if (!accountId) return;
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const r of Object.values(data.reminder)) {
    if (r.incomeAccount !== accountId && r.outcomeAccount !== accountId) continue;
    if (!r.comment) continue;
    let doc: { type?: unknown; month?: unknown; payload?: unknown };
    try {
      doc = JSON.parse(r.comment);
    } catch {
      problems.push(`reminder ${r.id}: comment is not JSON`);
      continue;
    }
    if (typeof doc?.type !== "string" || !("payload" in doc)) {
      problems.push(`reminder ${r.id}: not a Zerro document`);
      continue;
    }
    const key = `${doc.type}${typeof doc.month === "string" ? `:${doc.month}` : ""}`;
    const dup = seen.get(key);
    if (dup) problems.push(`document ${key} is stored twice (reminders ${dup} and ${r.id})`);
    seen.set(key, r.id);
    const shapeError = checkPayload(doc.type, doc.payload);
    if (shapeError) problems.push(`document ${key}: ${shapeError}`);
  }
  if (problems.length)
    throw new ToolInputError(`Refusing to write: Zerro's stored data looks damaged. Fix it in Zerro first.\n- ${problems.join("\n- ")}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function checkPayload(type: string, payload: unknown): string | null {
  switch (type) {
    case "budgets":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, v] of Object.entries(payload)) if (typeof v !== "number" || !Number.isFinite(v)) return `amount for ${id} is not a number`;
      return null;
    case "goals":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, g] of Object.entries(payload)) {
        if (g === null) continue;
        if (!isObject(g) || typeof g.type !== "string" || typeof g.amount !== "number") return `goal for ${id} is malformed`;
      }
      return null;
    case "EnvelopeMeta":
      if (!isObject(payload)) return "payload is not an object";
      for (const [id, m] of Object.entries(payload)) if (!isObject(m)) return `meta for ${id} is not an object`;
      return null;
    case "UserSettings":
      return isObject(payload) ? null : "payload is not an object";
    default:
      return null;
  }
}

/** One writer across processes on this machine. */
export class WriteLock {
  private path: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "write.lock");
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number(readFileSync(this.path, "utf8"));
        if (pid && pid !== process.pid && alive(pid))
          throw new ToolInputError(`Another zerro-mcp process (pid ${pid}) is writing. Try again in a moment.`);
        rmSync(this.path, { force: true });
      }
    }
    throw new ToolInputError("Could not take the write lock.");
  }

  release(): void {
    rmSync(this.path, { force: true });
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
 * An open journal is a write whose outcome is not yet confirmed; a closed one
 * stays as the backup to roll back from.
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
    writeFileSync(this.file, JSON.stringify(this.entry, null, 2), { mode: 0o600 });
  }
}
