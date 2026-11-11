// Setu — MCP server (stdio entrypoint)
//
// Thin stdio wrapper around mcp.js so MCP clients that launch a local command
// (`claude mcp add --transport stdio setu -- node --env-file=.env server.js`)
// work identically to the unified HTTP+MCP server in server-http.js.
//
// stdout is the JSON-RPC channel. Anything written there that isn't a protocol
// message corrupts the stream, so every log below goes to console.error.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSetuMcpServer, ensureDemoMandate } from "./mcp.js";
import { formatPaise } from "./mandate.js";
import * as audit from "./audit.js";
import { getDbPath } from "./db.js";

const REQUIRED_ENV = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

const demoMandate = ensureDemoMandate();
const server = createSetuMcpServer({
  defaultAgentId: process.env.SETU_AGENT_ID || "stdio-agent",
});
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[setu] MCP server ready on stdio — 8 tools registered (tech store + study store + upsell)");
console.error(`[setu] database: ${getDbPath()}`);
console.error(
  `[setu] demo mandate ${demoMandate.id}: ` +
    `${formatPaise(demoMandate.max_amount)} budget, ` +
    `${formatPaise(demoMandate.per_txn_cap)} per-transaction cap, ` +
    `categories [${demoMandate.category_allowlist.join(", ")}], ` +
    `expires ${demoMandate.expiry}`,
);
console.error(`[setu] spent under this mandate: ${formatPaise(audit.spentUnder(demoMandate.id))}`);
if (missingEnv.length > 0) {
  console.error(
    `[setu] WARNING: ${missingEnv.join(", ")} not set — start with ` +
      `\`node --env-file=.env server.js\`. Razorpay calls will fail until this is fixed.`,
  );
} else {
  console.error("[setu] Razorpay credentials loaded from environment");
}
