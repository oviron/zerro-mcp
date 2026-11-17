import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, type Config } from "./config";
import { Replica } from "./replica";
import { createServer } from "./server";
import { ZenMoneyClient } from "./zenmoney/client";

let config: Config;
try {
  config = configFromEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const client = new ZenMoneyClient(config.token, config.apiBase, config.timeoutMs);
const replica = new Replica(client, config.syncTtlMs);
const server = createServer({ config, replica });

server
  .connect(new StdioServerTransport())
  .then(() => console.error(`zerro-mcp running on stdio${config.write ? " (writes enabled)" : ""}`))
  .catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
