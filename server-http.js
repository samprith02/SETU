// Setu — HTTP API
//
// Deliberately thin: routing, validation and status codes only. Product data
// lives in catalog.js and Razorpay logic in payments.js, so the MCP tool
// surface built on Day 2 imports the same functions and cannot drift from
// what these routes do.

import express from "express";
import { getCatalog, getProduct, CURRENCY, UNIT } from "./catalog.js";
import {
  createOrder,
  fetchOrder,
  fetchPayment,
  verifyPaymentSignature,
  getKeyId,
} from "./payments.js";
import { formatPaise } from "./mandate.js";
import * as audit from "./audit.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/catalog", (req, res) => {
  res.json(getCatalog());
});

app.get("/product/:id", (req, res) => {
  const product = getProduct(req.params.id);
  if (product === null) {
    return res.status(404).json({ error: "product_not_found", id: req.params.id });
  }
  // Same self-describing envelope as /catalog, from the same constants — an
  // agent reading `price: 29900` on either route learns the unit the same way.
  res.json({ currency: CURRENCY, unit: UNIT, product });
});

// Create a Razorpay order for one product. Price comes from the catalog, never
// from the request body — a client that could name its own amount could buy a
// laptop stand for one paisa.
app.post("/checkout", async (req, res) => {
  const { productId } = req.body ?? {};
  if (typeof productId !== "string" || productId.length === 0) {
    return res.status(400).json({ error: "productId_required" });
  }

  const product = getProduct(productId);
  if (product === null) {
    return res.status(404).json({ error: "product_not_found", id: productId });
  }

  try {
    const order = await createOrder({
      amountPaise: product.price,
      receipt: `setu_${productId}_${Date.now()}`,
      notes: { product_id: product.id, product_name: product.name },
    });

    res.json({
      key_id: getKeyId(), // publishable — safe in a browser, not the secret
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      unit: UNIT,
      product: { id: product.id, name: product.name },
    });
  } catch (error) {
    console.error("[setu] order creation failed:", error.message);
    res.status(502).json({ error: "order_creation_failed", detail: error.message });
  }
});

// Re-open the checkout page for an order that already exists. The MCP
// `initiate_purchase` tool creates the order in a different process and hands
// the human a URL; this is what that URL needs to render a Pay button without
// creating a second order. Read-only, and returns only what the browser needs.
app.get("/order/:id", async (req, res) => {
  try {
    const order = await fetchOrder(req.params.id);
    // If Setu's mandate gate created this order, the ledger knows what it was
    // for. A plain /checkout order has no entry, and that is fine.
    const origin = audit.findByOrderId(order.id).find((e) => e.product_id !== null);
    res.json({
      key_id: getKeyId(), // publishable — safe in a browser, not the secret
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      unit: UNIT,
      product: origin
        ? { id: origin.product_id, name: getProduct(origin.product_id)?.name ?? origin.product_id }
        : null,
      intent: origin?.intent ?? null,
    });
  } catch (error) {
    console.error(`[setu] order lookup failed for ${req.params.id}: ${error.message}`);
    res.status(404).json({ error: "order_not_found", id: req.params.id });
  }
});

// Settle a payment.
//
// This route is the second half of a purchase that began in the MCP server.
// `initiate_purchase` could only get as far as "order created" — capture
// happens after a human completes Razorpay's hosted Checkout, which is minutes
// and one process away. This is the side that actually learns the outcome, so
// this is where the outcome gets confirmed and recorded.
//
// Two independent checks, and BOTH must pass:
//
//   1. Signature — proves the callback is authentic: Razorpay sent it and
//      nobody altered it. Says nothing about whether money moved.
//   2. Capture status, fetched from Razorpay directly — proves it did. An
//      authorised-but-uncaptured payment carries a perfectly valid signature.
//
// Only after both does spend get counted, and it gets counted by writing a
// PAYMENT_CAPTURED entry to the ledger — the mandate's `spent` is derived from
// those entries, so the ledger and the budget cannot disagree.
app.post("/payment/verify", async (req, res) => {
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body ?? {};

  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({
      error: "missing_fields",
      required: ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature"],
    });
  }

  // Was this order created through the mandate gate? If not, it came from the
  // deliberately ungated /checkout page, which exists only to prove the payment
  // rails work in a browser. Those purchases are verified exactly as before but
  // written to no ledger and counted against no budget — mixing them in would
  // make the audit trail claim authority it never granted.
  const priorEntries = audit.findByOrderId(orderId);
  const origin = priorEntries.find((entry) => entry.status === audit.STATUS.ORDER_CREATED);
  const mandated = origin !== undefined;

  const recordFailure = (detail) => {
    if (!mandated) return null;
    return audit.record({
      status: audit.STATUS.PAYMENT_FAILED,
      intent: origin.intent,
      amount: origin.amount,
      product_id: origin.product_id,
      mandate: origin.mandate,
      order_id: orderId,
      payment_id: paymentId,
      detail,
    });
  };

  // 1. Authenticity.
  if (!verifyPaymentSignature({ orderId, paymentId, signature })) {
    console.error(`[setu] SIGNATURE MISMATCH for order ${orderId} — rejected`);
    recordFailure("signature_mismatch: recomputed HMAC did not match the callback signature");
    return res.status(400).json({ verified: false, error: "signature_mismatch" });
  }

  // 2. Did the money actually move? Ask Razorpay, not the browser.
  let payment;
  try {
    payment = await fetchPayment(paymentId);
  } catch (error) {
    console.error(`[setu] payment fetch failed for ${paymentId}: ${error.message}`);
    recordFailure(`payment_fetch_failed: could not reach Razorpay to confirm capture — ${error.message}`);
    return res.status(502).json({
      verified: true,
      captured: false,
      error: "payment_fetch_failed",
      detail: error.message,
    });
  }

  if (payment.status !== "captured") {
    console.error(
      `[setu] payment ${paymentId} is "${payment.status}", not "captured" — not counted`,
    );
    recordFailure(`not_captured: Razorpay reports payment status "${payment.status}", so no money moved`);
    return res.status(402).json({
      verified: true,
      captured: false,
      error: "payment_not_captured",
      payment_status: payment.status,
      detail:
        "The signature is genuine but Razorpay has not captured this payment, " +
        "so no money has moved. Nothing was counted against the mandate.",
    });
  }

  // Razorpay's own figure is authoritative — the browser is exactly the party
  // that would benefit from misreporting it. If it disagrees with what the
  // mandate approved, that is the discrepancy an audit trail exists to catch,
  // so it is recorded as a failure rather than quietly accepted.
  if (mandated && payment.amount !== origin.amount) {
    console.error(
      `[setu] AMOUNT MISMATCH on ${orderId}: approved ${origin.amount}, captured ${payment.amount}`,
    );
    recordFailure(`amount_mismatch: mandate approved ${origin.amount} paise but ${payment.amount} paise was captured`);
    return res.status(409).json({
      verified: true,
      captured: true,
      counted: false,
      error: "amount_mismatch",
      approved_amount: origin.amount,
      captured_amount: payment.amount,
      unit: UNIT,
    });
  }

  if (!mandated) {
    console.log(`[setu] payment captured: ${paymentId} (ungated /checkout — not audited)`);
    return res.json({
      verified: true,
      captured: true,
      counted: false,
      order_id: orderId,
      payment_id: paymentId,
      note: "Ungated browser checkout. Not recorded against any mandate.",
    });
  }

  const entry = audit.record({
    status: audit.STATUS.PAYMENT_CAPTURED,
    intent: origin.intent,
    amount: payment.amount,
    product_id: origin.product_id,
    mandate: origin.mandate,
    order_id: orderId,
    payment_id: paymentId,
  });

  console.log(
    `[setu] CAPTURED ${formatPaise(payment.amount)} — ${paymentId} for order ${orderId} ` +
      `(${origin.product_id}); counted against mandate ${origin.mandate?.mandate_id}`,
  );

  res.json({
    verified: true,
    captured: true,
    counted: true,
    order_id: orderId,
    payment_id: paymentId,
    amount: payment.amount,
    unit: UNIT,
    amount_display: formatPaise(payment.amount),
    product_id: origin.product_id,
    audit_entry_id: entry.id,
    total_spent: audit.totalCaptured(),
  });
});

app.listen(PORT, () => {
  console.log(`[setu] catalog API listening on http://localhost:${PORT}`);
});
