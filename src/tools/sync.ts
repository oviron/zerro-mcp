import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../server";
import { toolText, withErrors } from "./result";

export function registerSyncTool(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "sync_data",
    {
      title: "Sync Zerro Data",
      description: `Pull the latest changes from ZenMoney now. Other tools already sync when data is older than ${Math.round(ctx.config.syncTtlMs / 1000)}s.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withErrors(async () => {
      await ctx.replica.exclusive(() => ctx.replica.pull());
      const snap = ctx.replica.snapshot();
      return toolText(`Synced at ${new Date(snap.syncedAt).toISOString()}.`);
    }),
  );
}
