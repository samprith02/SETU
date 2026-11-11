// Setu — payment settlement & webhook reconciliation
//
// Pure logic. No HTTP, no Express, no MCP. Both `/payment/verify` (browser
// callback) and `/webhooks/razorpay` (server-to-server webhook) call these
// functions so idempotency, amount verification, hold expiry refunds, and
// audit recording behave identically regardless of which side learns the
// outcome first.

import * as audit from "./audit.js";
import { UNIT } from "./catalog.js";
import { formatPaise } from "./mandate.js";
import { refundPayment } from "./payments.js";

/**
 * Record a payment failure against a mandated order. No-op for ungated
 * `/checkout` orders (they carry no mandate and no audit trail).
 */
export function recordOrderFailure(orderId, paymentId, detail) {
  const prior = audit.findByOrderId(orderId);
  const origin = prior.find((entry) => entry.status === audit.STATUS.ORDER_CREATED);
  if (!origin) return null;

  return audit.record({
    status: audit.STATUS.PAYMENT_FAILED,
    intent: origin.intent,
    amount: origin.amount,
    product_id: origin.product_id,
    mandate: origin.mandate,
    order_id: orderId,
    payment_id: paymentId ?? null,
    agent_id: origin.agent_id ?? null,
    detail,
  });
}

/**
 * Settle a payment after Razorpay authenticity has already been proven (either
 * by callback HMAC + `fetchPayment`, or by webhook `X-Razorpay-Signature`).
 *
 * Returns `{ statusCode, body }` matching `/payment/verify`'s response schema.
 */
export async function settlePayment({
  orderId,
  payment,
  source = "verify",
  refundFn = refundPayment,
}) {
  const paymentId = payment.id;
  const priorEntries = audit.findByOrderId(orderId);
  const origin = priorEntries.find((entry) => entry.status === audit.STATUS.ORDER_CREATED);
  const mandated = origin !== undefined;
  const mandateId = origin?.mandate?.mandate_id ?? null;

  const fail = (detail) => {
    if (!mandated) return null;
    return audit.record({
      status: audit.STATUS.PAYMENT_FAILED,
      intent: origin.intent,
      amount: origin.amount,
      product_id: origin.product_id,
      mandate: origin.mandate,
      order_id: orderId,
      payment_id: paymentId,
      agent_id: origin.agent_id ?? null,
      detail,
    });
  };

  // A callback or webhook can be delivered more than once. A payment already
  // settled must never be counted against the budget a second time.
  const settled = priorEntries.find(
    (entry) => entry.status === audit.STATUS.PAYMENT_CAPTURED && entry.payment_id === paymentId,
  );
  if (settled) {
    return {
      statusCode: 200,
      body: {
        verified: true,
        captured: true,
        counted: true,
        duplicate: true,
        order_id: orderId,
        payment_id: paymentId,
        amount: settled.amount,
        unit: UNIT,
        audit_entry_id: settled.id,
        total_spent: audit.spentUnder(mandateId),
        note: "Already settled. This callback was not counted a second time.",
      },
    };
  }

  if (payment.status !== "captured") {
    console.error(
      `[setu] payment ${paymentId} is "${payment.status}", not "captured" — not counted`,
    );
    fail(`not_captured: Razorpay reports payment status "${payment.status}", so no money moved`);
    return {
      statusCode: 402,
      body: {
        verified: true,
        captured: false,
        error: "payment_not_captured",
        payment_status: payment.status,
        detail:
          "The signature is genuine but Razorpay has not captured this payment, " +
          "so no money has moved. Nothing was counted against the mandate.",
      },
    };
  }

  // Razorpay's own figure is authoritative — if it disagrees with what the
  // mandate approved, record the discrepancy as a failure rather than counting it.
  if (mandated && payment.amount !== origin.amount) {
    console.error(
      `[setu] AMOUNT MISMATCH on ${orderId}: approved ${origin.amount}, captured ${payment.amount}`,
    );
    fail(`amount_mismatch: mandate approved ${origin.amount} paise but ${payment.amount} paise was captured`);
    return {
      statusCode: 409,
      body: {
        verified: true,
        captured: true,
        counted: false,
        error: "amount_mismatch",
        approved_amount: origin.amount,
        captured_amount: payment.amount,
        unit: UNIT,
      },
    };
  }

  if (!mandated) {
    console.log(`[setu] payment captured: ${paymentId} (ungated /checkout — not audited)`);
    return {
      statusCode: 200,
      body: {
        verified: true,
        captured: true,
        counted: false,
        order_id: orderId,
        payment_id: paymentId,
        note: "Ungated browser checkout. Not recorded against any mandate.",
      },
    };
  }

  // Check whether the approval's budget hold had already lapsed when paid.
  const paidAt =
    typeof payment.created_at === "number" ? new Date(payment.created_at * 1000) : new Date();
  const holdExpiry = audit.holdExpiresAt(origin);
  if (paidAt > holdExpiry) {
    const late =
      `hold_expired: paid at ${paidAt.toISOString()}, but the approval only held ` +
      `budget until ${holdExpiry.toISOString()}`;
    let refund;
    try {
      refund = await refundFn(paymentId, { reason: "setu_hold_expired", order_id: orderId });
    } catch (error) {
      console.error(`[setu] REFUND FAILED for late payment ${paymentId}: ${error.message}`);
      fail(`${late}; refund_failed — ${error.message}. Refund manually.`);
      return {
        statusCode: 502,
        body: {
          verified: true,
          captured: true,
          counted: false,
          refunded: false,
          error: "hold_expired_refund_failed",
          detail: error.message,
        },
      };
    }
    console.error(`[setu] late payment ${paymentId} on ${orderId} refunded (${refund.id})`);
    fail(`${late}; refunded in full (${refund.id})`);
    return {
      statusCode: 409,
      body: {
        verified: true,
        captured: true,
        counted: false,
        refunded: true,
        refund_id: refund.id,
        error: "approval_expired",
        detail: "Paid after the approval expired, so the payment was refunded. Nothing was counted.",
      },
    };
  }

  const entry = audit.record({
    status: audit.STATUS.PAYMENT_CAPTURED,
    intent: origin.intent,
    amount: payment.amount,
    product_id: origin.product_id,
    mandate: origin.mandate,
    order_id: orderId,
    payment_id: paymentId,
    agent_id: origin.agent_id ?? null,
    detail: source === "webhook" ? "settled via razorpay webhook" : null,
  });

  console.log(
    `[setu] CAPTURED ${formatPaise(payment.amount)} — ${paymentId} for order ${orderId} ` +
      `(${origin.product_id}, via ${source}); counted against mandate ${mandateId}`,
  );

  return {
    statusCode: 200,
    body: {
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
      total_spent: audit.spentUnder(mandateId),
    },
  };
}

/**
 * Handle a `payment.failed` webhook event idempotently.
 */
export function handlePaymentFailedWebhook(payment) {
  const orderId = payment?.order_id;
  const paymentId = payment?.id ?? null;
  if (!orderId) return { recorded: false, reason: "missing_order_id" };

  const prior = audit.findByOrderId(orderId);
  const origin = prior.find((e) => e.status === audit.STATUS.ORDER_CREATED);
  if (!origin) return { recorded: false, reason: "ungated_order" };

  if (prior.some((e) => e.status === audit.STATUS.PAYMENT_CAPTURED && e.payment_id === paymentId)) {
    return { recorded: false, reason: "already_captured" };
  }
  if (
    paymentId &&
    prior.some((e) => e.status === audit.STATUS.PAYMENT_FAILED && e.payment_id === paymentId)
  ) {
    return { recorded: false, reason: "duplicate_failure" };
  }

  const reason = [payment.error_code, payment.error_description].filter(Boolean).join(": ");
  const entry = audit.record({
    status: audit.STATUS.PAYMENT_FAILED,
    intent: origin.intent,
    amount: origin.amount,
    product_id: origin.product_id,
    mandate: origin.mandate,
    order_id: orderId,
    payment_id: paymentId,
    agent_id: origin.agent_id ?? null,
    detail: reason ? `webhook payment.failed: ${reason}` : "webhook payment.failed",
  });
  return { recorded: true, entry };
}

/**
 * Handle a `refund.created` / `refund.processed` webhook event idempotently.
 * Only credits back spend if a PAYMENT_CAPTURED entry exists for this payment
 * (late hold-expired refunds were never counted as spent in the first place).
 */
export function handleRefundWebhook(refund) {
  const paymentId = refund?.payment_id;
  const refundId = refund?.id;
  if (!paymentId || !refundId) return { recorded: false, reason: "missing_refund_ids" };

  const prior = audit.findByPaymentId(paymentId);
  const captured = prior.find((e) => e.status === audit.STATUS.PAYMENT_CAPTURED);
  if (!captured) {
    return { recorded: false, reason: "payment_not_counted" };
  }

  const alreadyRefunded = prior.some(
    (e) =>
      e.status === audit.STATUS.PAYMENT_REFUNDED &&
      (e.detail ?? "").includes(refundId),
  );
  if (alreadyRefunded) {
    return { recorded: false, reason: "duplicate_refund" };
  }

  const amount =
    Number.isInteger(refund.amount) && refund.amount > 0 ? refund.amount : captured.amount;

  const entry = audit.record({
    status: audit.STATUS.PAYMENT_REFUNDED,
    intent: captured.intent,
    amount,
    product_id: captured.product_id,
    mandate: captured.mandate,
    order_id: captured.order_id,
    payment_id: paymentId,
    agent_id: captured.agent_id ?? null,
    detail: `refund:${refundId}`,
  });
  return { recorded: true, entry };
}
