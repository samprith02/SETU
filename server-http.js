// Setu — HTTP API
//
// Deliberately thin: routing, validation and status codes only. Product data
// lives in catalog.js and Razorpay logic in payments.js, so the MCP tool
// surface built on Day 2 imports the same functions and cannot drift from
// what these routes do.

import express from "express";
import { getCatalog, getProduct, CURRENCY, UNIT } from "./catalog.js";
import { createOrder, verifyPaymentSignature, getKeyId } from "./payments.js";

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

// Confirm a checkout callback actually came from Razorpay before believing it.
app.post("/payment/verify", (req, res) => {
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

  const valid = verifyPaymentSignature({ orderId, paymentId, signature });
  if (!valid) {
    console.error(`[setu] SIGNATURE MISMATCH for order ${orderId} — rejected`);
    return res.status(400).json({ verified: false, error: "signature_mismatch" });
  }

  console.log(`[setu] payment verified: ${paymentId} for order ${orderId}`);
  res.json({ verified: true, order_id: orderId, payment_id: paymentId });
});

app.listen(PORT, () => {
  console.log(`[setu] catalog API listening on http://localhost:${PORT}`);
});
