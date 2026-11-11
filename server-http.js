// Setu — Unified HTTP + MCP server
//
// Deliberately thin: routing, validation and status codes only. Product data
// lives in catalog.js, Razorpay logic in payments.js, mandate rules in
// mandate.js, audit persistence in audit.js, and MCP tool registration in
// mcp.js. Both HTTP routes and MCP tools run in this single process so they
// share one mandate, one purchase queue, and one SQLite connection.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getCatalog, getProduct, CURRENCY, UNIT } from "./catalog.js";
import {
  createOrder,
  fetchOrder,
  fetchPayment,
  verifyPaymentSignature,
  verifyWebhookSignature,
  getKeyId,
} from "./payments.js";
import {
  settlePayment,
  recordOrderFailure,
  handlePaymentFailedWebhook,
  handleRefundWebhook,
} from "./settlement.js";
import { formatPaise, loadLatestMandate } from "./mandate.js";
import * as audit from "./audit.js";
import { getUpsell } from "./upsell.js";
import { getStudyCatalog, getStudyProduct, searchStudyCatalog } from "./merchant2.js";
import { createSetuMcpServer, ensureDemoMandate } from "./mcp.js";
import { getDbPath } from "./db.js";
import { authenticateMerchant, authenticateAgent, createRateLimiter } from "./auth.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

export function createApp({ baseUrl, rateLimit } = {}) {
  const app = express();

  const defaultMax = Number(process.env.SETU_RATE_LIMIT_MAX) || 120;
  const purchaseLimiter = createRateLimiter({
    windowMs: rateLimit?.windowMs ?? 60_000,
    max: rateLimit?.max ?? defaultMax,
  });
  const mcpLimiter = createRateLimiter({
    windowMs: rateLimit?.windowMs ?? 60_000,
    max: rateLimit?.max ?? defaultMax,
    isJsonRpc: true,
  });

  // Razorpay webhooks sign the exact raw UTF-8 payload bytes — register this
  // route with express.raw() BEFORE express.json() parses and discards them.
  app.post(
    "/webhooks/razorpay",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
        return res.status(503).json({ error: "webhook_secret_not_configured" });
      }

      const signature = req.headers["x-razorpay-signature"];
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));

      if (!signature || !verifyWebhookSignature({ rawBody, signature })) {
        console.error("[setu] WEBHOOK SIGNATURE MISMATCH — rejected");
        return res.status(400).json({ error: "invalid_webhook_signature" });
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }

      const eventName = event?.event;
      try {
        if (eventName === "payment.captured") {
          const payment = event.payload?.payment?.entity;
          if (!payment?.id || !payment?.order_id) {
            return res.status(400).json({ error: "missing_payment_entity" });
          }
          const result = await settlePayment({
            orderId: payment.order_id,
            payment,
            source: "webhook",
          });
          // Always ack 200 to Razorpay once processed/recorded so it doesn't
          // keep retrying terminal business rejections (e.g. hold_expired).
          return res.status(200).json({ ok: true, event: eventName, settlement: result.body });
        }

        if (eventName === "payment.failed") {
          const payment = event.payload?.payment?.entity;
          const result = handlePaymentFailedWebhook(payment);
          return res.status(200).json({ ok: true, event: eventName, ...result });
        }

        if (eventName === "refund.created" || eventName === "refund.processed") {
          const refund = event.payload?.refund?.entity;
          const result = handleRefundWebhook(refund);
          return res.status(200).json({ ok: true, event: eventName, ...result });
        }

        return res.status(200).json({ ok: true, ignored: true, event: eventName ?? null });
      } catch (error) {
        console.error(`[setu] webhook handling failed (${eventName}): ${error.message}`);
        return res.status(500).json({ error: "webhook_processing_failed", detail: error.message });
      }
    },
  );

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

// public/ has audit.html and checkout.html but no index.html, so with no
// route here the bare port 404s with Express's own "Cannot GET /" — which
// reads as the server being broken when it's actually just missing a front
// door. The dashboard is the thing anyone hitting this port wants to see.
app.get("/", (req, res) => {
  res.redirect("/audit.html");
});

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
app.post("/checkout", authenticateMerchant, purchaseLimiter, async (req, res) => {
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
    const history = audit.findByOrderId(order.id);
    const origin = history.find((e) => e.product_id !== null);

    // An approval holds budget only for so long. Once the hold has lapsed the
    // budget may already be promised to another order, so the page stops
    // offering to take payment rather than accepting money it would refund.
    const created = history.find((e) => e.status === audit.STATUS.ORDER_CREATED);
    if (created && order.status !== "paid" && audit.holdExpiresAt(created) <= new Date()) {
      return res.status(410).json({
        error: "approval_expired",
        order_id: order.id,
        hold_expired_at: audit.holdExpiresAt(created).toISOString(),
        detail: "This approval has expired. Ask the agent to start the purchase again.",
      });
    }

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
app.post("/payment/verify", purchaseLimiter, async (req, res) => {
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

  // 1. Authenticity.
  if (!verifyPaymentSignature({ orderId, paymentId, signature })) {
    console.error(`[setu] SIGNATURE MISMATCH for order ${orderId} — rejected`);
    recordOrderFailure(
      orderId,
      paymentId,
      "signature_mismatch: recomputed HMAC did not match the callback signature",
    );
    return res.status(400).json({ verified: false, error: "signature_mismatch" });
  }

  // 2. Did the money actually move? Ask Razorpay, not the browser.
  let payment;
  try {
    payment = await fetchPayment(paymentId);
  } catch (error) {
    console.error(`[setu] payment fetch failed for ${paymentId}: ${error.message}`);
    recordOrderFailure(
      orderId,
      paymentId,
      `payment_fetch_failed: could not reach Razorpay to confirm capture — ${error.message}`,
    );
    return res.status(502).json({
      verified: true,
      captured: false,
      error: "payment_fetch_failed",
      detail: error.message,
    });
  }

  const { statusCode, body } = await settlePayment({ orderId, payment, source: "verify" });
  res.status(statusCode).json(body);
});

// Read the audit trail over HTTP.
//
// The same ledger `get_audit_log` serves to the agent, served to a browser.
// Both call audit.list() / audit.findByOrderId() / audit.formatEntry(), so the
// dashboard cannot show one story while the agent reads another. Nothing is
// filtered, formatted or totalled here — this route only picks which of
// audit.js's readers to call and hands back what it returns.
//
// Deliberately NOT included: the mandate's terms (cap, allowlist, budget).
// Those are seeded in the MCP process and this one holds no copy; minting a
// second mandate here would put an id on screen that no entry refers to. Every
// entry already carries the verdict that applied to it at the time, which is
// the version an audit is supposed to show anyway.
// ---------------------------------------------------------------------------
// Upsell layer
// ---------------------------------------------------------------------------
//
// After a purchase is captured the dashboard (and any caller) can fetch
// complementary product suggestions. This is read-only — upsell logic lives
// in upsell.js and has no side effects. The mandate filter is optional:
// pass ?mandateFilter=1 to exclude products the active mandate would block.
// (The mandate lives in the MCP process, so we check only per_txn_cap here
// using the cap read from the entry; the caller's judgment applies otherwise.)
app.get("/upsell/:productId", (req, res) => {
  const result = getUpsell(req.params.productId);
  if (result.purchased === null) {
    return res.status(404).json({
      error: "product_not_found",
      id: req.params.productId,
    });
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// Second merchant — Campus Study & Office Essentials
// ---------------------------------------------------------------------------
//
// Same mandate+audit contract as the tech store; only the catalog differs.
// This demonstrates that Setu is a portable trust primitive, not a
// one-merchant integration.
app.get("/catalog2", (req, res) => {
  res.json(getStudyCatalog());
});

app.get("/catalog2/search", (req, res) => {
  const { q: query, category, max_price } = req.query;
  let maxPrice = null;
  if (max_price !== undefined) {
    maxPrice = Number(max_price);
    if (!Number.isInteger(maxPrice) || maxPrice <= 0) {
      return res.status(400).json({ error: "max_price_must_be_a_positive_integer", max_price });
    }
  }
  try {
    res.json(searchStudyCatalog({ query: query ?? null, category: category ?? null, maxPrice }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/catalog2/product/:id", (req, res) => {
  const product = getStudyProduct(req.params.id);
  if (product === null) {
    return res.status(404).json({ error: "product_not_found", id: req.params.id });
  }
  res.json({ currency: "INR", unit: "paise", merchant: "study", product });
});

// ---------------------------------------------------------------------------
// Audit trail (existing)
// ---------------------------------------------------------------------------

app.get("/audit", authenticateMerchant, (req, res) => {
  const { limit, order_id: orderId } = req.query;

  if (orderId !== undefined && typeof orderId !== "string") {
    return res.status(400).json({ error: "order_id_must_be_a_string" });
  }

  let parsedLimit = null;
  if (limit !== undefined) {
    parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: "limit_must_be_a_positive_integer", limit });
    }
  }

  try {
    const entries = orderId
      ? audit.findByOrderId(orderId)
      : audit.list({ limit: parsedLimit });
    const captured = audit.totalCaptured();
    const activeMandate = loadLatestMandate();
    const mandate = activeMandate
      ? {
          ...activeMandate,
          spent: audit.spentUnder(activeMandate.id),
          held: audit.heldUnder(activeMandate.id),
        }
      : null;

    res.json({
      currency: CURRENCY,
      unit: UNIT,
      count: entries.length,
      total_captured: captured,
      total_captured_display: formatPaise(captured),
      mandate,
      entries,
      timeline: entries.map(audit.formatEntry),
    });
  } catch (error) {
    // audit.list() throws on a corrupt line rather than skipping it. A 500 is
    // the honest answer: a trail that quietly drops entries is worse than one
    // that refuses to load.
    console.error(`[setu] audit read failed: ${error.message}`);
    res.status(500).json({ error: "audit_log_unreadable", detail: error.message });
  }
});

  // -------------------------------------------------------------------------
  // MCP over Streamable HTTP (/mcp)
  // -------------------------------------------------------------------------
  const sessions = new Map();

  const jsonRpcError = (res, status, code, message) => {
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });
  };

  app.use("/mcp", authenticateAgent, mcpLimiter);

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (typeof sessionId === "string" && sessionId.length > 0) {
        const session = sessions.get(sessionId);
        if (!session) {
          return jsonRpcError(res, 404, -32001, "Session not found");
        }
        if (session.agentId !== req.auth?.clientId) {
          return jsonRpcError(res, 403, -32001, "Forbidden: session belongs to a different agent");
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
      }

      const origin = baseUrl || process.env.SETU_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const agentId = req.auth?.clientId ?? null;
      const mcpServer = createSetuMcpServer({ baseUrl: origin, defaultAgentId: agentId });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server: mcpServer, agentId });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`[setu] MCP POST error: ${error.message}`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return jsonRpcError(res, 400, -32000, "Bad Request: Missing mcp-session-id header");
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return jsonRpcError(res, 404, -32001, "Session not found");
    }
    if (session.agentId !== req.auth?.clientId) {
      return jsonRpcError(res, 403, -32001, "Forbidden: session belongs to a different agent");
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[setu] MCP GET error: ${error.message}`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return jsonRpcError(res, 400, -32000, "Bad Request: Missing mcp-session-id header");
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return jsonRpcError(res, 404, -32001, "Session not found");
    }
    if (session.agentId !== req.auth?.clientId) {
      return jsonRpcError(res, 403, -32001, "Forbidden: session belongs to a different agent");
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[setu] MCP DELETE error: ${error.message}`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  app.locals.closeMcpSessions = async () => {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(active.map((s) => s.transport.close()));
  };

  return app;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const PORT = process.env.PORT || 3000;
  const withStdio = process.argv.includes("--stdio");

  if (withStdio) {
    // stdout is reserved for JSON-RPC whenever stdio transport is active.
    console.log = (...args) => console.error(...args);
  }

  const demoMandate = ensureDemoMandate();
  const app = createApp();

  app.listen(PORT, async () => {
    console.error(`[setu] unified server listening on http://localhost:${PORT}`);
    console.error(`[setu] MCP Streamable HTTP endpoint: http://localhost:${PORT}/mcp`);
    console.error(`[setu] database: ${getDbPath()}`);
    console.error(
      `[setu] demo mandate ${demoMandate.id}: ` +
        `${formatPaise(demoMandate.max_amount)} budget, ` +
        `${formatPaise(demoMandate.per_txn_cap)} per-transaction cap`,
    );

    if (withStdio) {
      const stdioServer = createSetuMcpServer({
        baseUrl: process.env.SETU_BASE_URL || `http://localhost:${PORT}`,
      });
      await stdioServer.connect(new StdioServerTransport());
      console.error("[setu] MCP stdio transport also attached in the same process");
    }
  });
}
