// Setu — Razorpay payments
//
// Pure logic. Knows nothing about HTTP or MCP, same as catalog.js, so the
// Express routes and the Day 2 `initiate_purchase` MCP tool share one
// implementation instead of each rolling their own.
//
// Test mode only. Credentials come from the environment via Node's built-in
// loader (`node --env-file=.env ...`) and are never logged.

import crypto from "node:crypto";
import Razorpay from "razorpay";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Start the process with \`node --env-file=.env ...\`.`,
    );
  }
  return value;
}

// Built on first use, not at import time — so a missing .env fails on the first
// payment call with a clear message, instead of making this module unimportable
// and taking unrelated tools (like the MCP ping) down with it.
let client = null;
function getClient() {
  if (client === null) {
    client = new Razorpay({
      key_id: requireEnv("RAZORPAY_KEY_ID"),
      key_secret: requireEnv("RAZORPAY_KEY_SECRET"),
    });
  }
  return client;
}

/**
 * The publishable key id. Safe to send to a browser — it identifies the
 * merchant account but authorises nothing on its own. The *secret* never
 * leaves this process.
 */
export function getKeyId() {
  return requireEnv("RAZORPAY_KEY_ID");
}

/** Create a Razorpay order. `amountPaise` must be an integer count of paise. */
export async function createOrder({ amountPaise, receipt, notes = {} }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error(`amountPaise must be a positive integer, got: ${amountPaise}`);
  }
  return getClient().orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
    notes,
  });
}

/** Fetch an existing order by id — used to re-open checkout for an order an agent created. */
export async function fetchOrder(orderId) {
  return getClient().orders.fetch(orderId);
}

/**
 * Fetch a payment from Razorpay, by id.
 *
 * This is what closes the gap left by signature verification alone. A valid
 * signature proves the callback is authentic — that Razorpay really sent it and
 * nobody altered it in flight. It says nothing about whether the money moved:
 * an authorised-but-uncaptured payment, or one later failed, carries a
 * perfectly valid signature too.
 *
 * Only Razorpay's own record of `status === "captured"` establishes that, and
 * only this call reaches it. The returned `amount` is likewise authoritative —
 * preferred over anything the browser reports, since the browser is exactly the
 * party that would benefit from lying about it.
 */
export async function fetchPayment(paymentId) {
  return getClient().payments.fetch(paymentId);
}

/**
 * Verify that a checkout callback genuinely came from Razorpay.
 *
 * Razorpay signs `order_id|payment_id` with HMAC-SHA256 keyed by the account's
 * secret. Only Razorpay and this server know that secret, so a matching digest
 * is proof the message is authentic and unaltered. Recomputing it here is the
 * only thing standing between "the browser told us the payment succeeded" and
 * actually knowing that it did.
 *
 * Compared in constant time: a plain `===` leaks, through how long the
 * comparison takes, how many leading characters a guess got right, which is
 * enough to reconstruct a valid signature one character at a time.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac("sha256", requireEnv("RAZORPAY_KEY_SECRET"))
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(String(signature ?? ""), "utf8");

  // timingSafeEqual throws on length mismatch, so check length first — this
  // leaks only the length, which is fixed and public for a SHA-256 hex digest.
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
