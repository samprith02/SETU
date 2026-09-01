// Setu — MCP server
// Spike: proves the stdio registration path works end to end before any real
// commerce logic exists. Grows into the real tool surface (search_catalog,
// get_product, check_mandate, initiate_purchase, get_audit_log).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Razorpay credentials come from .env via Node's built-in loader — no dotenv:
//   node --env-file=.env server.js
// The flag does the loading; this only verifies it worked, so a forgotten flag
// fails here loudly instead of surfacing as a baffling auth error mid-demo.
// Never log the values themselves — presence only.
const REQUIRED_ENV = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

const server = new McpServer({
  name: "setu",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    title: "Ping",
    description:
      "Health check for the Setu MCP server. Takes no arguments and returns a fixed string. Use to confirm the server is reachable.",
  },
  async () => ({
    content: [{ type: "text", text: "pong from Setu MCP server" }],
  }),
);

// stdout is the JSON-RPC channel — anything written there that isn't a protocol
// message corrupts the stream. All logging goes to stderr.
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[setu] MCP server ready on stdio");
if (missingEnv.length > 0) {
  console.error(
    `[setu] WARNING: ${missingEnv.join(", ")} not set — start with ` +
      `\`node --env-file=.env server.js\`. Razorpay calls will fail until this is fixed.`,
  );
} else {
  console.error("[setu] Razorpay credentials loaded from environment");
}
