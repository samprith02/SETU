// Setu — unified HTTP + Streamable HTTP MCP integration tests
//
// Run with:  node --env-file=.env test-http-mcp.js
// Verifies Phase 1.2 (merged process): HTTP API + dashboard and MCP over
// Streamable HTTP (/mcp) share one process, one mandate, one purchase queue,
// and one SQLite ledger.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DB_PATH = path.join(os.tmpdir(), `setu-test-http-mcp-${process.pid}.db`);
process.env.SETU_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

const { createApp } = await import("./server-http.js");
const { ensureDemoMandate, resetCachedMandate } = await import("./mcp.js");
const { closeDb } = await import("./db.js");

let passed = 0;
let failed = 0;

const heading = (t) =>
  console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  PASS  ${label}`);
    passed++;
  } catch {
    console.log(`  FAIL  ${label}`);
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function parse(result) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf("\n{")));
}

const demoMandate = ensureDemoMandate();
const app = createApp();
const httpServer = http.createServer(app);

await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const { port } = httpServer.address();
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = new URL(`${baseUrl}/mcp`);

let client;
let transport;

try {
  // -------------------------------------------------------------------------
  heading("1. Streamable HTTP MCP transport connects to /mcp");
  // -------------------------------------------------------------------------
  client = new Client({ name: "setu-http-test", version: "0.1.0" });
  transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);

  expect("transport assigned a session id", typeof transport.sessionId, "string");

  const { tools } = await client.listTools();
  expect("all 8 MCP tools exposed over HTTP", tools.map((t) => t.name).sort(), [
    "check_mandate",
    "get_audit_log",
    "get_product",
    "get_study_product",
    "get_upsell",
    "initiate_purchase",
    "search_catalog",
    "search_study_catalog",
  ]);

  // -------------------------------------------------------------------------
  heading("2. Tool call over /mcp -> immediate visibility in GET /audit");
  // -------------------------------------------------------------------------
  const blocked = await client.callTool({
    name: "initiate_purchase",
    arguments: {
      product_id: "acc-mouse-wireless",
      intent: "http-mcp test: blocked wireless mouse",
    },
  });
  const blockedBody = parse(blocked);
  expect("blocked purchase returns isError true", blocked.isError, true);
  expect("blocked by per_txn_cap_exceeded", blockedBody.blocked_by, "per_txn_cap_exceeded");

  const approved = await client.callTool({
    name: "initiate_purchase",
    arguments: {
      product_id: "acc-mouse-wired",
      intent: "http-mcp test: buy wired substitute",
    },
  });
  const approvedBody = parse(approved);
  expect("approved order starts with order_", approvedBody.order_id.startsWith("order_"), true);
  expect(
    "checkout_url targets the running server origin",
    approvedBody.checkout_url,
    `${baseUrl}/checkout.html?orderId=${approvedBody.order_id}`,
  );

  const auditRes = await fetch(`${baseUrl}/audit`);
  const auditJson = await auditRes.json();
  expect("GET /audit returns 200", auditRes.status, 200);
  expect("GET /audit sees the active mandate id", auditJson.mandate?.id, demoMandate.id);
  expect("GET /audit sees held budget from the MCP order", auditJson.mandate?.held, 44900);
  expect("GET /audit has both MCP entries", auditJson.entries.length, 2);
  expect(
    "GET /audit includes the order created via /mcp",
    auditJson.entries[1].order_id,
    approvedBody.order_id,
  );

  // Also verify GET /order/:id on the same server works for the MCP-created order
  const orderRes = await fetch(`${baseUrl}/order/${approvedBody.order_id}`);
  const orderJson = await orderRes.json();
  expect("GET /order/:id returns 200 for MCP order", orderRes.status, 200);
  expect("GET /order/:id reports product id", orderJson.product?.id, "acc-mouse-wired");

  // -------------------------------------------------------------------------
  heading("3. Session validation & cleanup");
  // -------------------------------------------------------------------------
  const badInit = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect("non-initialize POST without session id returns 400", badInit.status, 400);

  const unknownSid = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "nonexistent-session",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect("POST with unknown session id returns 404", unknownSid.status, 404);

  await transport.terminateSession();
  await client.close();

  const afterDelete = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": transport.sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect("terminated session returns 404", afterDelete.status, 404);
} finally {
  await app.locals.closeMcpSessions?.();
  await new Promise((resolve) => httpServer.close(resolve));
  resetCachedMandate();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}

heading("SUMMARY");
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
console.log("  Unified HTTP + Streamable HTTP MCP server behaved as specified.\n");

