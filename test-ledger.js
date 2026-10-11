// Setu — ledger accounting tests
//
// Run with:  node test-ledger.js
// Exits non-zero on any failure, same contract as test-mandate.js.
//
// What a mandate's budget is measured against is derived from the ledger, so
// these test the derivation directly: spend is scoped to the mandate that
// authorised it, and unpaid orders hold budget until they are captured or
// their hold expires. Runs against a throwaway ledger, never the demo's.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEDGER = path.join(os.tmpdir(), `setu-test-ledger-${process.pid}.jsonl`);
process.env.SETU_AUDIT_LOG = LEDGER;
fs.rmSync(LEDGER, { force: true });

// Imported after the env var is set: audit.js resolves its path at load.
const audit = await import("./audit.js");

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

const verdict = (mandateId) => ({
  mandate_id: mandateId,
  approved: true,
  code: "approved",
  reason: "test approval",
});

/** Write an entry with a chosen timestamp — record() always stamps "now". */
function appendAt(timestamp, fields) {
  const entry = audit.auditEntrySchema.parse({
    id: `aud_test_${Math.random().toString(36).slice(2)}`,
    timestamp: timestamp.toISOString(),
    intent: null,
    amount: null,
    product_id: null,
    mandate: null,
    order_id: null,
    payment_id: null,
    detail: null,
    ...fields,
  });
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n", "utf8");
}

const order = (mandateId, orderId, amount, at = new Date()) =>
  appendAt(at, {
    status: audit.STATUS.ORDER_CREATED,
    amount,
    product_id: "cbl-usbc-1m",
    mandate: verdict(mandateId),
    order_id: orderId,
  });

const capture = (mandateId, orderId, amount) =>
  appendAt(new Date(), {
    status: audit.STATUS.PAYMENT_CAPTURED,
    amount,
    product_id: "cbl-usbc-1m",
    mandate: verdict(mandateId),
    order_id: orderId,
    payment_id: `pay_${orderId}`,
  });

try {
  // -------------------------------------------------------------------------
  heading("1. spentUnder — a new mandate does not inherit an old one's spend");
  // -------------------------------------------------------------------------
  order("mdt_A", "order_a1", 44900);
  capture("mdt_A", "order_a1", 44900);
  order("mdt_A", "order_a2", 29900);
  capture("mdt_A", "order_a2", 29900);

  expect("mandate A has spent both captures", audit.spentUnder("mdt_A"), 44900 + 29900);
  expect("mandate B, minted later, has spent nothing", audit.spentUnder("mdt_B"), 0);
  expect("the ledger-wide total still sees everything", audit.totalCaptured(), 44900 + 29900);

  order("mdt_B", "order_b1", 39900);
  capture("mdt_B", "order_b1", 39900);
  expect("B counts only its own capture", audit.spentUnder("mdt_B"), 39900);
  expect("A is unchanged by B's capture", audit.spentUnder("mdt_A"), 44900 + 29900);

  // -------------------------------------------------------------------------
  heading("2. heldUnder — unpaid orders hold budget until paid or expired");
  // -------------------------------------------------------------------------
  const now = new Date();
  order("mdt_C", "order_c1", 44900, now);
  order("mdt_C", "order_c2", 44900, now);
  expect("two unpaid orders hold their sum", audit.heldUnder("mdt_C", now), 2 * 44900);
  expect("holds are scoped to their mandate", audit.heldUnder("mdt_A", now), 0);

  capture("mdt_C", "order_c1", 44900);
  expect("a captured order stops holding (it is spent instead)", audit.heldUnder("mdt_C", now), 44900);
  expect("and is counted as spent", audit.spentUnder("mdt_C"), 44900);

  appendAt(new Date(), {
    status: audit.STATUS.PAYMENT_FAILED,
    amount: 44900,
    mandate: verdict("mdt_C"),
    order_id: "order_c2",
    detail: "not_captured: test",
  });
  expect("a failed payment keeps holding — the order can still be paid", audit.heldUnder("mdt_C", now), 44900);

  const stale = new Date(now.getTime() - audit.HOLD_TTL_MS - 1000);
  order("mdt_D", "order_d1", 44900, stale);
  order("mdt_D", "order_d2", 29900, now);
  expect("an order past its hold expiry holds nothing", audit.heldUnder("mdt_D", now), 29900);
  expect(
    "holdExpiresAt is creation time plus the TTL",
    audit.holdExpiresAt({ timestamp: now.toISOString() }).getTime(),
    now.getTime() + audit.HOLD_TTL_MS,
  );
  const later = new Date(now.getTime() + audit.HOLD_TTL_MS + 1);
  expect("every hold lapses once its TTL passes", audit.heldUnder("mdt_D", later), 0);
} finally {
  fs.rmSync(LEDGER, { force: true });
}

// ---------------------------------------------------------------------------
heading("SUMMARY");
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n  LEDGER ACCOUNTING IS BROKEN — see failures above.");
  process.exit(1);
}
console.log("\n  Spend is scoped to its mandate, and holds behave as specified.");
