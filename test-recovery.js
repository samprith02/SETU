// Setu — the failure-and-recovery path, run end to end, repeatedly
//
// Run with:  node --env-file=.env test-recovery.js
// Exits non-zero if any run of the sequence fails, same contract as the other
// two suites.
//
// This is the scenario the track grades: "show the audit trail and one failure
// handled gracefully." The failure is a purchase the mandate refuses; the
// graceful handling is that the refusal names permitted substitutes, and the
// agent recovers by simply buying one. There is no retry tool and no new
// server-side recovery logic — recovery is a second ordinary initiate_purchase
// call, which is the point.
//
// One full sequence:
//   1. initiate_purchase(BLOCKED)   -> refused, no Razorpay order, alternatives offered
//   2. initiate_purchase(alt[0])    -> approved, real order created
//   3. get_audit_log                -> both halves of the story are on the record
//
// Run RUNS times in a row, because a recovery path that works once is not a
// recovery path. Creates real Razorpay TEST-MODE orders; no money moves.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatPaise } from "./mandate.js";

const RUNS = 5;

// The scripted scenario, so the demo is not improvised live.
//
// BLOCKED is a wireless mouse: ₹749.00, category "accessories". That category
// IS on the mandate's allowlist, so the refusal can only be about the ₹500.00
// per-transaction cap — it isolates the cap as the binding rule and cannot be
// mistaken for a category quibble.
const BLOCKED_ID = "acc-mouse-wireless";
const BLOCKED_CATEGORY = "accessories";
const BLOCKED_RULE = "per_txn_cap_exceeded";
const REQUEST = "buy me a wireless mouse for the campus desk setup";

let failedRuns = 0;
const problems = [];

const heading = (t) =>
  console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));

function parse(result) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf("\n{")));
}
const summaryOf = (result) => result.content[0].text.split("\n")[0];

const client = new Client({ name: "setu-recovery-test", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file=.env", "server.js"],
  stderr: "inherit",
});
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });

// The mandate's own terms, read from the server rather than assumed, so this
// file does not quietly encode a copy of them that can drift.
const mandate = parse(await call("get_audit_log", { limit: 1 })).mandate;
console.log(
  `mandate ${mandate.id}: ${formatPaise(mandate.per_txn_cap)} per transaction, ` +
    `${formatPaise(mandate.remaining)} of ${formatPaise(mandate.max_amount)} remaining, ` +
    `categories [${mandate.category_allowlist.join(", ")}]`,
);

for (let run = 1; run <= RUNS; run++) {
  heading(`RUN ${run} of ${RUNS}`);
  const failures = [];
  const fail = (msg) => failures.push(msg);

  // --- 0. The preview -------------------------------------------------------
  // A careful agent asks before it commits, so check_mandate's refusal has to
  // carry the substitutes too. Observed live: an agent that previews first and
  // gets a bare "no" goes off searching the catalog by hand, and may never
  // recover at all.
  const preview = await call("check_mandate", { product_id: BLOCKED_ID, intent: REQUEST });
  const previewBody = parse(preview);
  console.log(`  0. PREVIEW  ${summaryOf(preview)}`);

  if (previewBody.approved !== false) fail("preview did not refuse the blocked product");
  if (previewBody.code !== BLOCKED_RULE) {
    fail(`preview refused on "${previewBody.code}", expected "${BLOCKED_RULE}"`);
  }
  if ((previewBody.alternatives ?? []).length === 0) {
    fail("preview refused without naming any alternative");
  }

  // --- 1. The failure -------------------------------------------------------
  const blocked = await call("initiate_purchase", {
    product_id: BLOCKED_ID,
    intent: REQUEST,
  });
  const blockedBody = parse(blocked);
  console.log(`  1. BLOCKED  ${summaryOf(blocked)}`);

  if (blocked.isError !== true) fail("refusal was not reported as an error");
  if (blockedBody.purchased !== false) fail("refusal claimed a purchase happened");
  if (blockedBody.blocked_by !== BLOCKED_RULE) {
    fail(`refused on "${blockedBody.blocked_by}", expected "${BLOCKED_RULE}"`);
  }
  // The gate must stop the purchase BEFORE Razorpay is contacted.
  if ("order_id" in blockedBody) fail("a Razorpay order was created for a blocked purchase");

  const alternatives = blockedBody.alternatives ?? [];
  if (alternatives.length === 0) fail("no alternatives were offered");
  // Both refusal paths must name the same substitutes — an agent that previews
  // and then commits must not be told two different stories.
  const previewIds = (previewBody.alternatives ?? []).map((a) => a.id).join(",");
  if (previewIds !== alternatives.map((a) => a.id).join(",")) {
    fail(`preview suggested [${previewIds}], the refusal suggested a different set`);
  }
  if (alternatives.length > 2) fail(`${alternatives.length} alternatives offered, expected 1-2`);

  // Every suggestion must be one the same gate would actually approve —
  // suggesting something that gets refused on the next call is worse than
  // suggesting nothing.
  for (const alt of alternatives) {
    if (!mandate.category_allowlist.includes(alt.category)) {
      fail(`suggested ${alt.id} in disallowed category "${alt.category}"`);
    }
    if (alt.price > mandate.per_txn_cap) {
      fail(`suggested ${alt.id} at ${formatPaise(alt.price)}, over the per-transaction cap`);
    }
  }
  // Closest match first: the blocked product's own category ahead of everything
  // else, cheapest within each group. Note this is deliberately NOT price order
  // overall — for the mouse, the ₹399 phone case outranks the ₹120 notebook
  // because it is the substitute that answers the question that was asked.
  const rank = (a) => [a.category === BLOCKED_CATEGORY ? 0 : 1, a.price];
  for (let i = 1; i < alternatives.length; i++) {
    const [prevGroup, prevPrice] = rank(alternatives[i - 1]);
    const [group, price] = rank(alternatives[i]);
    if (group < prevGroup || (group === prevGroup && price < prevPrice)) {
      fail(`alternatives are out of order: ${alternatives[i - 1].id} before ${alternatives[i].id}`);
    }
  }
  // The substitute offered first must be in the same category as the refused
  // product whenever the catalog has one the mandate allows.
  if (alternatives.some((a) => a.category === BLOCKED_CATEGORY)) {
    if (alternatives[0].category !== BLOCKED_CATEGORY) {
      fail(`a ${BLOCKED_CATEGORY} substitute exists but ${alternatives[0].id} was offered first`);
    }
  }
  console.log(
    `     offered: ${alternatives.map((a) => `${a.id} (${a.price_display})`).join(", ")}`,
  );

  // --- 2. The recovery ------------------------------------------------------
  // Exactly what the agent does: call initiate_purchase again with a suggested
  // id. No retry tool, no special endpoint.
  const substitute = alternatives[0];
  let recovered = null;
  if (substitute === undefined) {
    fail("cannot attempt recovery — nothing was suggested");
  } else {
    const recovery = await call("initiate_purchase", {
      product_id: substitute.id,
      intent: `${REQUEST} — the mouse was over the mandate's cap, buying the suggested ${substitute.name} instead`,
    });
    recovered = parse(recovery);
    console.log(`  2. RECOVERED  ${summaryOf(recovery)}`);

    if (recovery.isError) fail("the suggested substitute was itself refused");
    if (typeof recovered.order_id !== "string" || !recovered.order_id.startsWith("order_")) {
      fail("recovery did not produce a real Razorpay order");
    }
    if (recovered.amount !== substitute.price) {
      fail(`ordered ${recovered.amount} paise, suggested ${substitute.price}`);
    }
    // A synchronous tool call still cannot observe a human paying.
    if (recovered.purchased !== false) fail("recovery claimed the purchase completed");
    if (recovered.status !== "awaiting_payment") {
      fail(`recovery status was "${recovered.status}", expected "awaiting_payment"`);
    }
  }

  // --- 3. Both halves on the record ----------------------------------------
  const log = parse(await call("get_audit_log", {}));

  const blockedEntry = log.entries.find((e) => e.id === blockedBody.audit_entry_id);
  if (blockedEntry === undefined) {
    fail("the refusal is not in the audit log");
  } else {
    if (blockedEntry.status !== "purchase_blocked") fail("refusal logged with the wrong status");
    if (blockedEntry.order_id !== null) fail("the logged refusal carries an order id");
    if (blockedEntry.intent !== REQUEST) fail("the logged refusal lost the agent's stated intent");
    if (blockedEntry.mandate?.code !== BLOCKED_RULE) fail("the logged refusal lost the refusing rule");
    // The substitutes offered are themselves on the record — otherwise the trail
    // shows a refusal followed by an unexplained purchase of something else.
    for (const alt of alternatives) {
      if (!(blockedEntry.detail ?? "").includes(alt.id)) {
        fail(`the logged refusal does not record that ${alt.id} was suggested`);
      }
    }
  }

  if (recovered?.order_id) {
    const orderEntry = log.entries.find(
      (e) => e.order_id === recovered.order_id && e.status === "order_created",
    );
    if (orderEntry === undefined) {
      fail("the recovery order is not in the audit log");
    } else if (orderEntry.product_id !== substitute.id) {
      fail("the logged recovery names the wrong product");
    }
    // Nothing is captured, so nothing is spent — an order awaiting payment must
    // not burn budget.
    const after = parse(await call("get_audit_log", { limit: 1 })).mandate;
    if (after.spent !== mandate.spent) fail("an unpaid recovery order changed the budget");
  }

  if (blockedEntry) {
    console.log(`  3. ON THE RECORD  ${blockedEntry.detail}`);
  }

  if (failures.length === 0) {
    console.log(`  -> run ${run}: OK`);
  } else {
    failedRuns++;
    console.log(`  -> run ${run}: FAILED`);
    for (const f of failures) {
      console.log(`       - ${f}`);
      problems.push(`run ${run}: ${f}`);
    }
  }
}

await client.close();

heading("SUMMARY");
console.log(`\n  ${RUNS - failedRuns} of ${RUNS} runs completed the full sequence`);
console.log(`  ${failedRuns} of ${RUNS} runs failed\n`);
if (failedRuns > 0) {
  for (const p of problems) console.log(`    ${p}`);
  console.log("\n  The recovery path is NOT reliable.\n");
  process.exit(1);
}
console.log("  Blocked, explained, substituted, recovered — every time.\n");
