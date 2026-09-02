// Setu — MCP tool surface tests
//
// Run with:  node --env-file=.env test-mcp.js
// Exits non-zero if any tool misbehaves, same contract as test-mandate.js.
//
// This drives the REAL server over a real stdio transport — the server is
// spawned as a subprocess and spoken to in JSON-RPC, exactly as Claude Code
// does. Importing the modules directly would test the logic but not the wiring,
// and the wiring is what breaks.
//
// `initiate_purchase` creates genuine Razorpay TEST-MODE orders. No money moves
// — capture requires a human completing hosted Checkout, which is the whole
// point of the split this file verifies.

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatPaise } from "./mandate.js";

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

// Every tool returns a one-line summary followed by a JSON body. Tests read the
// JSON; the summary is what a human sees in the transcript.
function parse(result) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf("\n{")));
}
const summaryOf = (result) => result.content[0].text.split("\n")[0];

const client = new Client({ name: "setu-test", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file=.env", "server.js"],
  // Inherit stderr so the server's startup banner is visible in test output.
  stderr: "inherit",
});
await client.connect(transport);

const call = (name, args) => client.callTool({ name, arguments: args });

// ---------------------------------------------------------------------------
heading("1. TOOL SURFACE");
// ---------------------------------------------------------------------------
const { tools } = await client.listTools();
const toolNames = tools.map((t) => t.name).sort();
console.log(`  registered: ${toolNames.join(", ")}`);

expect("five tools registered", toolNames, [
  "check_mandate",
  "get_audit_log",
  "get_product",
  "initiate_purchase",
  "search_catalog",
]);

// The absence is the design. An agent that can mint its own mandate has no
// spending limit, only a formality it can rewrite.
expect("no create_mandate tool is exposed", toolNames.includes("create_mandate"), false);

// ---------------------------------------------------------------------------
heading("2. search_catalog — the agent's view of the shop");
// ---------------------------------------------------------------------------
const search = parse(await call("search_catalog", { query: "phone case", max_price: 50000 }));
console.log(`  query "phone case", max_price 50000 paise (${formatPaise(50000)})`);
for (const p of search.products) {
  console.log(`    ${p.id}  ${p.name}  ${formatPaise(p.price)}  [${p.category}]`);
}

expect("finds the clear phone case", search.products[0].id, "acc-case-clear");
expect("declares its unit", search.unit, "paise");
expect("respects max_price", search.products.every((p) => p.price <= 50000), true);

const overPriced = parse(await call("search_catalog", { category: "chargers", max_price: 50000 }));
expect("no charger is under ₹500", overPriced.count, 0);

// ---------------------------------------------------------------------------
heading("3. check_mandate — a preview that spends nothing");
// ---------------------------------------------------------------------------
const okCheck = parse(await call("check_mandate", { product_id: "acc-case-clear" }));
console.log(`  acc-case-clear (${formatPaise(39900)}, accessories)`);
console.log(`    approved: ${okCheck.approved}  code: ${okCheck.code}`);

expect("phone case is permitted", okCheck.approved, true);
expect("code is approved", okCheck.code, "approved");

const capCheck = parse(await call("check_mandate", { product_id: "chg-usbc-65w" }));
console.log(`  chg-usbc-65w (${formatPaise(149900)}, chargers)`);
console.log(`    approved: ${capCheck.approved}  code: ${capCheck.code}`);
console.log(`    reason:   ${capCheck.reason}`);

// Category is checked before price, so a charger fails on the allowlist first —
// the mandate refuses on the earliest rule that applies, not the most dramatic.
expect("65W charger is refused", capCheck.approved, false);
expect("refused on category, the first failing rule", capCheck.code, "category_not_allowed");

const audioCheck = parse(await call("check_mandate", { product_id: "aud-earphones-wired" }));
expect("audio is outside the allowlist", audioCheck.code, "category_not_allowed");

// An allowed category that is simply too expensive fails on the cap instead.
const sleeveCheck = parse(await call("check_mandate", { product_id: "acc-sleeve-14" }));
console.log(`  acc-sleeve-14 (${formatPaise(89900)}, accessories — allowed category)`);
console.log(`    code: ${sleeveCheck.code}`);
expect("₹899 sleeve exceeds the ₹500 per-transaction cap", sleeveCheck.code, "per_txn_cap_exceeded");

// ---------------------------------------------------------------------------
heading("4. initiate_purchase — BLOCKED never reaches the payment rails");
// ---------------------------------------------------------------------------

// The ledger is append-only and survives between runs, so this run does not
// start from zero spend. Budget assertions below are made RELATIVE to what the
// ledger already held — hard-coding ₹0 spent would pass only until the first
// real captured payment, which is exactly when the suite most needs to work.
const baseline = parse(await call("get_audit_log", { limit: 1 })).mandate;
console.log(`  ledger baseline: spent ${formatPaise(baseline.spent)}, ` +
  `${formatPaise(baseline.remaining)} remaining`);

const blocked = await call("initiate_purchase", {
  product_id: "chg-usbc-65w",
  intent: "test: buy the 65W charger, which the mandate should refuse",
});
const blockedBody = parse(blocked);
console.log(`  summary: ${summaryOf(blocked)}`);
console.log(`    purchased:  ${blockedBody.purchased}`);
console.log(`    blocked_by: ${blockedBody.blocked_by}`);
console.log(`    note:       ${blockedBody.note}`);

expect("reported as an error to the agent", blocked.isError, true);
expect("purchased is false", blockedBody.purchased, false);
expect("no order id was issued", "order_id" in blockedBody, false);
expect("the refusing rule is named", blockedBody.blocked_by, "category_not_allowed");
expect("remaining budget is offered for a substitute", blockedBody.remaining, baseline.remaining);

// ---------------------------------------------------------------------------
heading("5. initiate_purchase — APPROVED stops at 'awaiting payment'");
// ---------------------------------------------------------------------------
const approved = await call("initiate_purchase", {
  product_id: "acc-case-clear",
  intent: "test: buy me a phone case under ₹500",
});
const approvedBody = parse(approved);
console.log(`  summary: ${summaryOf(approved)}`);
console.log(`    order_id:     ${approvedBody.order_id}`);
console.log(`    status:       ${approvedBody.status}`);
console.log(`    amount:       ${approvedBody.amount_display}`);
console.log(`    checkout_url: ${approvedBody.checkout_url}`);

expect("not reported as an error", approved.isError, undefined);
expect("a real Razorpay order exists", approvedBody.order_id.startsWith("order_"), true);
expect("amount came from the catalog, not the caller", approvedBody.amount, 39900);

// The heart of the design: a synchronous tool call cannot observe a human
// completing hosted Checkout, so it must not claim the purchase succeeded.
expect("does NOT claim the purchase completed", approvedBody.purchased, false);
expect("status is awaiting_payment, never paid", approvedBody.status, "awaiting_payment");

// ---------------------------------------------------------------------------
heading("6. Budget is counted at capture, not at intent");
// ---------------------------------------------------------------------------
const afterOrder = parse(await call("get_audit_log", {}));
console.log(`  spent after creating an order: ${formatPaise(afterOrder.mandate.spent)}`);
console.log(`  remaining:                     ${formatPaise(afterOrder.mandate.remaining)}`);

// An abandoned checkout must not permanently burn budget the user never spent.
expect("creating an order spent nothing new", afterOrder.mandate.spent, baseline.spent);
expect("budget is unchanged by an unpaid order", afterOrder.mandate.remaining, baseline.remaining);

// ---------------------------------------------------------------------------
heading("7. get_audit_log — the trail of what was decided and why");
// ---------------------------------------------------------------------------
const log = parse(await call("get_audit_log", {}));
for (const line of log.timeline) console.log(`    ${line}`);

const statuses = log.entries.map((e) => e.status);
expect("blocked purchase is recorded", statuses.includes("purchase_blocked"), true);
expect("created order is recorded", statuses.includes("order_created"), true);
// Scoped to THIS run's order: an earlier demo may legitimately have captured a
// payment, and the claim being tested is that the order just created was not.
expect(
  "this run's order is not recorded as captured",
  log.entries.some(
    (e) => e.order_id === approvedBody.order_id && e.status === "payment_captured",
  ),
  false,
);

// findLast, not find: the ledger persists across runs, so the FIRST entry of a
// given status belongs to some earlier run. This run's entries are the last ones.
const blockedEntry = log.entries.findLast((e) => e.status === "purchase_blocked");
expect("the blocked entry has no order id", blockedEntry.order_id, null);
expect("the blocked entry records the refusing rule", blockedEntry.mandate.code, "category_not_allowed");
expect(
  "the blocked entry records the agent's stated intent",
  blockedEntry.intent,
  "test: buy the 65W charger, which the mandate should refuse",
);

const orderEntry = log.entries.findLast((e) => e.status === "order_created");
expect("the order entry carries the order id", orderEntry.order_id, approvedBody.order_id);

const byOrder = parse(await call("get_audit_log", { order_id: approvedBody.order_id }));
expect("one purchase's history is retrievable", byOrder.entries.length, 1);

// ---------------------------------------------------------------------------
heading("8. Bad input is refused, not guessed at");
// ---------------------------------------------------------------------------
const missing = await call("get_product", { product_id: "does-not-exist" });
expect("unknown product id is an error", missing.isError, true);
expect("and names the failure", parse(missing).error, "product_not_found");

await client.close();

// ---------------------------------------------------------------------------
heading("SUMMARY");
// ---------------------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("  MCP tool surface did NOT behave as specified.\n");
  process.exit(1);
}
console.log("  All five tools behaved as specified.\n");
