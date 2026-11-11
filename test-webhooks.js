// Setu — Razorpay webhook & settlement tests
//
// Run with:  node test-webhooks.js
// Tests HMAC raw-body verification, payment.captured settlement, idempotent
// replay protection, amount mismatch rejection, payment.failed, refund.created,
// and hold-expired auto-refunds against a throwaway SQLite DB.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `setu-test-webhooks-${process.pid}.db`);
process.env.SETU_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

const TEST_SECRET = "whsec_setu_test_secret_12345";
const origSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

const { createApp } = await import("./server-http.js");
const { ensureDemoMandate, resetCachedMandate } = await import("./mcp.js");
const audit = await import("./audit.js");
const { settlePayment } = await import("./settlement.js");
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

function sign(rawBody, secret = TEST_SECRET) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

const demoMandate = ensureDemoMandate();
const app = createApp();
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const webhookUrl = `http://127.0.0.1:${port}/webhooks/razorpay`;

async function postWebhook(rawBody, signature) {
  const headers = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-razorpay-signature"] = signature;
  const res = await fetch(webhookUrl, { method: "POST", headers, body: rawBody });
  return { status: res.status, json: await res.json() };
}

try {
  // -------------------------------------------------------------------------
  heading("1. Webhook secret configuration & signature validation");
  // -------------------------------------------------------------------------
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const unconfigured = await postWebhook("{}", "abc");
  expect("503 when RAZORPAY_WEBHOOK_SECRET is unset", unconfigured.status, 503);

  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

  const missingSig = await postWebhook(JSON.stringify({ event: "payment.captured" }));
  expect("400 when X-Razorpay-Signature is missing", missingSig.status, 400);

  const badSig = await postWebhook(JSON.stringify({ event: "payment.captured" }), "deadbeef");
  expect("400 on invalid signature", badSig.status, 400);

  const originalBody = JSON.stringify({ event: "ping", data: { n: 1 } });
  const tamperedBody = JSON.stringify({ event: "ping", data: { n: 2 } });
  const tampered = await postWebhook(tamperedBody, sign(originalBody));
  expect("400 when signed raw body is tampered", tampered.status, 400);

  // -------------------------------------------------------------------------
  heading("2. payment.captured settles mandated order & is idempotent");
  // -------------------------------------------------------------------------
  const orderId = "order_wh_1001";
  const paymentId = "pay_wh_1001";
  const mandateRecord = {
    mandate_id: demoMandate.id,
    approved: true,
    code: "approved",
    reason: "test approval",
  };
  audit.record({
    status: audit.STATUS.ORDER_CREATED,
    intent: "webhook test mouse",
    amount: 44900,
    product_id: "acc-mouse-wired",
    mandate: mandateRecord,
    order_id: orderId,
  });
  expect("order initially holds 44900", audit.heldUnder(demoMandate.id), 44900);

  const capturePayload = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 44900,
          status: "captured",
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  });

  const cap1 = await postWebhook(capturePayload, sign(capturePayload));
  expect("payment.captured returns 200", cap1.status, 200);
  expect("settlement counted the payment", cap1.json.settlement.counted, true);
  expect("spentUnder updated to 44900", audit.spentUnder(demoMandate.id), 44900);
  expect("hold released after capture", audit.heldUnder(demoMandate.id), 0);

  const cap2 = await postWebhook(capturePayload, sign(capturePayload));
  expect("replay returns 200", cap2.status, 200);
  expect("replay marked duplicate", cap2.json.settlement.duplicate, true);
  expect("spentUnder not double-counted", audit.spentUnder(demoMandate.id), 44900);

  // -------------------------------------------------------------------------
  heading("3. Amount mismatch & ungated orders");
  // -------------------------------------------------------------------------
  const mismatchOrder = "order_wh_mismatch";
  audit.record({
    status: audit.STATUS.ORDER_CREATED,
    intent: "mismatch test",
    amount: 29900,
    product_id: "cbl-usbc-1m",
    mandate: mandateRecord,
    order_id: mismatchOrder,
  });
  const mismatchBody = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_wh_mismatch",
          order_id: mismatchOrder,
          amount: 99900,
          status: "captured",
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  });
  const mm = await postWebhook(mismatchBody, sign(mismatchBody));
  expect("amount mismatch acks webhook with 200", mm.status, 200);
  expect("amount mismatch not counted", mm.json.settlement.counted, false);
  expect("amount mismatch reports error", mm.json.settlement.error, "amount_mismatch");
  expect("spentUnder unchanged after mismatch", audit.spentUnder(demoMandate.id), 44900);

  const ungatedBody = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_wh_ungated",
          order_id: "order_ungated_browser",
          amount: 29900,
          status: "captured",
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  });
  const ug = await postWebhook(ungatedBody, sign(ungatedBody));
  expect("ungated payment acks 200", ug.status, 200);
  expect("ungated payment not counted", ug.json.settlement.counted, false);

  // -------------------------------------------------------------------------
  heading("4. payment.failed & refund.created webhooks");
  // -------------------------------------------------------------------------
  const failOrder = "order_wh_fail";
  audit.record({
    status: audit.STATUS.ORDER_CREATED,
    intent: "failed payment test",
    amount: 39900,
    product_id: "acc-case-clear",
    mandate: mandateRecord,
    order_id: failOrder,
  });
  const failBody = JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_wh_fail_1",
          order_id: failOrder,
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Card declined",
        },
      },
    },
  });
  const pf1 = await postWebhook(failBody, sign(failBody));
  expect("payment.failed recorded", pf1.json.recorded, true);
  const pf2 = await postWebhook(failBody, sign(failBody));
  expect("duplicate payment.failed ignored", pf2.json.recorded, false);

  // Refund of the captured payment reduces spentUnder
  const refundBody = JSON.stringify({
    event: "refund.created",
    payload: {
      refund: {
        entity: {
          id: "rfnd_wh_1",
          payment_id: paymentId,
          amount: 44900,
        },
      },
    },
  });
  const rf1 = await postWebhook(refundBody, sign(refundBody));
  expect("refund.created recorded for captured payment", rf1.json.recorded, true);
  expect("spentUnder reduced after refund", audit.spentUnder(demoMandate.id), 0);

  const rf2 = await postWebhook(refundBody, sign(refundBody));
  expect("duplicate refund.created ignored", rf2.json.recorded, false);

  const uncountedRefund = JSON.stringify({
    event: "refund.created",
    payload: {
      refund: {
        entity: { id: "rfnd_uncounted", payment_id: "pay_never_captured", amount: 10000 },
      },
    },
  });
  const rf3 = await postWebhook(uncountedRefund, sign(uncountedRefund));
  expect("refund for uncounted payment is not recorded", rf3.json.recorded, false);

  // -------------------------------------------------------------------------
  heading("5. Hold-expired payment triggers refund");
  // -------------------------------------------------------------------------
  const lateOrder = "order_wh_late";
  audit.record({
    status: audit.STATUS.ORDER_CREATED,
    intent: "late payment test",
    amount: 29900,
    product_id: "cbl-usbc-1m",
    mandate: mandateRecord,
    order_id: lateOrder,
  });
  let refundCalledWith = null;
  const lateResult = await settlePayment({
    orderId: lateOrder,
    source: "webhook",
    payment: {
      id: "pay_wh_late",
      order_id: lateOrder,
      amount: 29900,
      status: "captured",
      created_at: Math.floor((Date.now() + audit.HOLD_TTL_MS + 60_000) / 1000),
    },
    refundFn: async (pid, notes) => {
      refundCalledWith = { pid, notes };
      return { id: "rfnd_mock_late" };
    },
  });
  expect("late payment returns 409", lateResult.statusCode, 409);
  expect("late payment triggers refundFn", refundCalledWith?.pid, "pay_wh_late");
  expect("late payment error is approval_expired", lateResult.body.error, "approval_expired");
  expect("late payment not counted in spentUnder", audit.spentUnder(demoMandate.id), 0);
} finally {
  if (origSecret === undefined) {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  } else {
    process.env.RAZORPAY_WEBHOOK_SECRET = origSecret;
  }
  await new Promise((resolve) => server.close(resolve));
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
console.log("  Webhooks and shared settlement behaved as specified.\n");

