import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  token: string;
  apiBase: string;
  timeoutMs: number;
  syncTtlMs: number;
  displayCurrency?: string;
  write: boolean;
  stateDir: string;
};

const API_BASES = ["https://api.zenmoney.ru", "https://api.zenmoney.app"];
const truthy = (v: string | undefined) => ["1", "true", "yes"].includes(v?.trim().toLowerCase() ?? "");

function seconds(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of seconds`);
  return n * 1000;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ZENMONEY_TOKEN?.trim();
  if (!token) throw new Error("ZENMONEY_TOKEN is required. Get it at https://zerro.app/token");
  const apiBase = (env.ZENMONEY_API_URL?.trim() || API_BASES[0]).replace(/\/+$/, "");
  if (!API_BASES.includes(apiBase)) throw new Error(`ZENMONEY_API_URL must be one of: ${API_BASES.join(", ")}`);
  const displayCurrency = env.ZERRO_DISPLAY_CURRENCY?.trim().toUpperCase() || undefined;
  return {
    token,
    apiBase,
    timeoutMs: seconds("ZENMONEY_TIMEOUT", 60, env),
    syncTtlMs: seconds("ZERRO_SYNC_TTL", 30, env),
    displayCurrency,
    write: truthy(env.ZERRO_MCP_WRITE),
    stateDir: env.ZERRO_MCP_STATE_DIR?.trim() || join(homedir(), ".local", "state", "zerro-mcp"),
  };
}
