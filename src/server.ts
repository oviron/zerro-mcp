import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config";
import type { Replica } from "./replica";
import { registerReadTools } from "./tools/read";
import { registerSyncTool } from "./tools/sync";
import { registerWriteTools } from "./tools/write";

declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ === "string" ? __VERSION__ : (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export type Ctx = { config: Config; replica: Replica };

export function createServer(ctx: Ctx) {
  const server = new McpServer({ name: "zerro-mcp", version });
  registerSyncTool(server, ctx);
  registerReadTools(server, ctx);
  // Writes exist only where ZERRO_MCP_WRITE is set: one writer per account.
  if (ctx.config.write) registerWriteTools(server, ctx);
  return server;
}
