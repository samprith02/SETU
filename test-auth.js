// Setu — authentication, agent identity & rate-limit tests
//
// Run with:  node test-auth.js
// Tests merchant API key auth, strict fail-closed mode, per-agent MCP tokens,
// session isolation across agents, agent_id recording in the audit ledger,
// and rate limiting — against a throwaway SQLite DB.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DB_PATH = path.join(os.tmpdir(), `setu-test-auth-${process.pid}.db`);
process.env.SETU_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

const origEnv = {
  SETU_API_KEY: process.env.SETU_API_KEY,
  SETU_AGENT_KEYS: process.env.SETU_AGENT_KEYS,
  SETU_REQUIRE_AUTH: process.env.SETU_REQUIRE_AUTH,
};

const { createApp } = await import("./server-http.js");
const { ensureDemoMandate, resetCachedMandate } = await import("./mcp.js");
const audit = await import("./audit.js");
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

ensureDemoMandate();
const app = createApp();
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

// Separate app instance with a tight rate limit to test 429 cleanly.
const rlApp = createApp({ rateLimit: { windowMs: 10_000, max: 3 } });
const rlServer = http.createServer(rlApp);
await new Promise((resolve) => rlServer.listen(0, "127.0.0.1", resolve));
const rlBaseUrl = `http://127.0.0.1:${rlServer.address().port}`;

try {
  // -------------------------------------------------------------------------
  heading("1. Dev mode (no keys configured)");
  // -------------------------------------------------------------------------
  delete process.env.SETU_API_KEY;
  delete process.env.SETU_AGENT_KEYS;
  delete process.env.SETU_REQUIRE_AUTH;

  const devAudit = await fetch(`${baseUrl}/audit`);
  expect("GET /audit succeeds in dev mode", devAudit.status, 200);

  // -------------------------------------------------------------------------
  heading("2. Strict fail-closed mode when SETU_REQUIRE_AUTH=1");
  // -------------------------------------------------------------------------
  process.env.SETU_REQUIRE_AUTH = "1";
  const failClosed = await fetch(`${baseUrl}/audit`);
  expect("GET /audit returns 503 when strict auth lacks key", failClosed.status, 503);

  // -------------------------------------------------------------------------
  heading("3. Merchant API key enforcement");
  // -------------------------------------------------------------------------
  process.env.SETU_API_KEY = "merchant_secret_xyz";
  process.env.SETU_AGENT_KEYS = "claude:agent_claude_1,cursor:agent_cursor_2";

  const publicCat = await fetch(`${baseUrl}/catalog`);
  expect("GET /catalog stays public", publicCat.status, 200);

  const noAuthAudit = await fetch(`${baseUrl}/audit`);
  expect("GET /audit without key returns 401", noAuthAudit.status, 401);

  const badAuthAudit = await fetch(`${baseUrl}/audit`, {
    headers: { Authorization: "Bearer wrong_key" },
  });
  expect("GET /audit with wrong Bearer returns 401", badAuthAudit.status, 401);

  const bearerAudit = await fetch(`${baseUrl}/audit`, {
    headers: { Authorization: "Bearer merchant_secret_xyz" },
  });
  expect("GET /audit with Bearer key returns 200", bearerAudit.status, 200);

  const headerAudit = await fetch(`${baseUrl}/audit`, {
    headers: { "X-Api-Key": "merchant_secret_xyz" },
  });
  expect("GET /audit with X-Api-Key returns 200", headerAudit.status, 200);

  const noAuthCheckout = await fetch(`${baseUrl}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "cbl-usbc-1m" }),
  });
  expect("POST /checkout without key returns 401", noAuthCheckout.status, 401);

  // -------------------------------------------------------------------------
  heading("4. Per-agent MCP auth, audit attribution & session isolation");
  // -------------------------------------------------------------------------
  const unauthMcp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  expect("POST /mcp without token returns 401", unauthMcp.status, 401);

  const client = new Client({ name: "claude-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: "Bearer agent_claude_1" },
    },
  });
  await client.connect(transport);

  await client.callTool({
    name: "check_mandate",
    arguments: { product_id: "cbl-usbc-1m", intent: "auth attribution test" },
  });

  const entries = audit.list();
  const lastEntry = entries[entries.length - 1];
  expect("audit entry records authenticated agent_id", lastEntry.agent_id, "claude");

  // Another authenticated agent must not be able to hijack claude's session
  const hijack = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer agent_cursor_2",
      "mcp-session-id": transport.sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect("cross-agent session reuse returns 403", hijack.status, 403);

  await transport.terminateSession();
  await client.close();

  // -------------------------------------------------------------------------
  heading("5. Rate limiting on purchase / MCP endpoints");
  // -------------------------------------------------------------------------
  // Send 4 requests with bad body on /payment/verify (hits limiter before 400 validation)
  const statuses = [];
  let retryAfter = null;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${rlBaseUrl}/payment/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    statuses.push(r.status);
    if (r.status === 429) retryAfter = r.headers.get("retry-after");
  }
  expect("first 3 pass limiter (400 validation), 4th hits 429", statuses, [400, 400, 400, 429]);
  expect("429 includes Retry-After header", Number(retryAfter) >= 1, true);
} finally {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await app.locals.closeMcpSessions?.();
  await rlApp.locals.closeMcpSessions?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => rlServer.close(resolve));
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
console.log("  Auth, agent attribution, and rate limiting behaved as specified.\n");

