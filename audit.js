// Setu — audit trail
//
// Pure logic. No HTTP, no MCP, no Express — same shape as catalog.js,
// mandate.js and payments.js, so the MCP `get_audit_log` tool and the Express
// `/payment/verify` route append to and read from one ledger instead of each
// keeping their own.
//
// This is the "explainable" half of the track's bar. mandate.js decides; this
// records what was decided, on what basis, and what happened next. A gate with
// no record of its verdicts is unreviewable.
//
// APPEND-ONLY, IN SQLITE. Two properties this file is built around:
//
//   1. Entries are never mutated. A purchase that is approved and then captured
//      produces TWO entries, not one row edited twice. An audit log you can
//      rewrite is not an audit log, and the pending->settled transition is
//      exactly the history worth keeping.
//
//   2. The ledger lives in SQLite (WAL mode), and reads are indexed queries
//      instead of full-file scans. The MCP server (server.js) and the HTTP
//      server (server-http.js) are SEPARATE Node processes that can read and
//      write concurrently without blocking each other.
//
// MIGRATION: existing audit-log.jsonl data can be imported with migrate-jsonl.js.
//
// MONEY: integer paise throughout, matching catalog.js and mandate.js.

import { z } from "zod";
import { formatPaise } from "./mandate.js";
import { getDb } from "./db.js";

/**
 * How long an approved-but-unpaid order holds its amount against the mandate.
 *
 * Spend is only counted at capture, so without a hold every order awaiting
 * payment reserves nothing — and an agent could open ten ₹449 orders against a
 * ₹2,000 budget, each one approved because nothing had been captured yet. The
 * hold closes that gap; the expiry keeps an abandoned checkout from burning
 * budget forever. A payment made after its hold lapsed is refunded rather than
 * counted (see /payment/verify), because by then the budget may have been
 * promised to another order.
 */
export const HOLD_TTL_MS = 15 * 60 * 1000;

/**
 * The lifecycle of one money decision. Statuses are the vocabulary the whole
 * project speaks — the MCP tools, the HTTP route and the dashboard
 * all branch on these strings, so they are defined once, here.
 */
export const STATUS = Object.freeze({
  // A dry-run `check_mandate`. No order, no money — but a recorded decision,
  // because "the agent asked whether it could" is part of the story.
  MANDATE_CHECKED: "mandate_checked",
  // `initiate_purchase` was refused by the mandate. No Razorpay order exists.
  PURCHASE_BLOCKED: "purchase_blocked",
  // Mandate approved, Razorpay order created, waiting on a human to pay.
  // Explicitly NOT a success — no spend is counted against the budget yet.
  ORDER_CREATED: "order_created",
  // Signature verified AND Razorpay confirms status "captured". Money moved.
  PAYMENT_CAPTURED: "payment_captured",
  // Verification or capture failed. The order stands; the money did not move.
  PAYMENT_FAILED: "payment_failed",
});

export const auditEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  status: z.enum(Object.values(STATUS)),
  // The agent's stated reason, in its own words ("buy a phone case under ₹500").
  // The single most valuable field for a human reviewing the trail: it is the
  // only one that records what the agent thought it was doing.
  intent: z.string().nullable(),
  amount: z.int().positive().nullable(),
  product_id: z.string().nullable(),
  // The verdict from mandate.check(), flattened. Kept verbatim rather than
  // recomputed on read, so the trail shows the rules AS THEY APPLIED AT THE
  // TIME — re-running today's rules over yesterday's decisions would launder
  // exactly the discrepancy an audit exists to surface.
  mandate: z
    .object({
      mandate_id: z.string().nullable(),
      approved: z.boolean(),
      code: z.string(),
      reason: z.string(),
    })
    .nullable(),
  order_id: z.string().nullable(),
  payment_id: z.string().nullable(),
  // Why this entry says what it says, when the mandate verdict doesn't cover it.
  // A PAYMENT_FAILED entry carries the approval that was granted earlier, so
  // without this there would be nothing recording what went wrong afterwards —
  // "signature_mismatch" and "not_captured" are very different failures and the
  // trail has to be able to tell them apart.
  detail: z.string().nullable(),
});

let counter = 0;

// Both servers append to this ledger, and each starts its own counter at zero.
// A per-process suffix keeps two entries written in the same millisecond from
// colliding on an id — duplicate ids in an audit log undermine the one thing
// the file is for.
const PROCESS_TAG = Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Prepared statements — created lazily on first use
// ---------------------------------------------------------------------------
let _stmts = null;

function stmts() {
  if (_stmts !== null) return _stmts;

  const db = getDb();

  _stmts = {
    insert: db.prepare(`
      INSERT INTO audit_entries
        (id, timestamp, status, intent, amount, product_id,
         mandate_id, mandate_approved, mandate_code, mandate_reason,
         order_id, payment_id, detail)
      VALUES
        (@id, @timestamp, @status, @intent, @amount, @product_id,
         @mandate_id, @mandate_approved, @mandate_code, @mandate_reason,
         @order_id, @payment_id, @detail)
    `),

    listAll: db.prepare(`
      SELECT * FROM audit_entries ORDER BY rowid ASC
    `),

    listLimit: db.prepare(`
      SELECT * FROM audit_entries ORDER BY rowid DESC LIMIT @limit
    `),

    findByOrderId: db.prepare(`
      SELECT * FROM audit_entries
      WHERE order_id = @order_id
      ORDER BY rowid ASC
    `),

    totalCaptured: db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM audit_entries
      WHERE status = 'payment_captured'
    `),

    spentUnder: db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM audit_entries
      WHERE status = 'payment_captured' AND mandate_id = @mandate_id
    `),

    // For heldUnder: find ORDER_CREATED entries that haven't been captured
    // and whose hold hasn't expired. We compute the hold expiry in JS
    // (timestamp + HOLD_TTL_MS) because date arithmetic in SQLite is awkward
    // with ISO 8601 + millisecond offsets, and correctness matters more than
    // the minor perf gain of doing it in SQL.
    orderCreatedUnder: db.prepare(`
      SELECT * FROM audit_entries
      WHERE status = 'order_created' AND mandate_id = @mandate_id
      ORDER BY rowid ASC
    `),

    capturedOrderIds: db.prepare(`
      SELECT DISTINCT order_id FROM audit_entries
      WHERE status = 'payment_captured' AND order_id IS NOT NULL
    `),
  };

  return _stmts;
}

// ---------------------------------------------------------------------------
// Row <-> entry conversion
// ---------------------------------------------------------------------------
//
// The audit_entries table flattens the nested `mandate` object into four
// columns. These helpers convert between the flat row and the nested shape
// that every caller (MCP tools, HTTP routes, dashboard) expects.

function rowToEntry(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    status: row.status,
    intent: row.intent,
    amount: row.amount,
    product_id: row.product_id,
    mandate:
      row.mandate_code !== null
        ? {
            mandate_id: row.mandate_id,
            approved: row.mandate_approved === 1,
            code: row.mandate_code,
            reason: row.mandate_reason,
          }
        : null,
    order_id: row.order_id,
    payment_id: row.payment_id,
    detail: row.detail,
  };
}

function entryToRow(entry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    status: entry.status,
    intent: entry.intent,
    amount: entry.amount,
    product_id: entry.product_id,
    mandate_id: entry.mandate?.mandate_id ?? null,
    mandate_approved: entry.mandate ? (entry.mandate.approved ? 1 : 0) : null,
    mandate_code: entry.mandate?.code ?? null,
    mandate_reason: entry.mandate?.reason ?? null,
    order_id: entry.order_id,
    payment_id: entry.payment_id,
    detail: entry.detail,
  };
}

// ---------------------------------------------------------------------------
// Public API — same exports as the old JSONL-backed audit.js
// ---------------------------------------------------------------------------

/**
 * Append one entry to the ledger. Returns the stored entry, including the
 * `id` and `timestamp` assigned here — a caller cannot backdate an entry.
 *
 * Every field is optional at the call site and defaults to null: a blocked
 * purchase has no order_id, a dry-run check has no payment_id. Recording null
 * is deliberate — it says "this stage was never reached", which is different
 * from the field being absent.
 */
export function record({
  status,
  intent = null,
  amount = null,
  product_id = null,
  mandate = null,
  order_id = null,
  payment_id = null,
  detail = null,
}) {
  const entry = auditEntrySchema.parse({
    id: `aud_${++counter}_${Date.now()}_${PROCESS_TAG}`,
    timestamp: new Date().toISOString(),
    status,
    intent,
    amount,
    product_id,
    mandate,
    order_id,
    payment_id,
    detail,
  });

  stmts().insert.run(entryToRow(entry));
  return entry;
}

/**
 * Every entry, oldest first — the order things happened, which is the order a
 * reviewer wants to read.
 *
 * A limit takes the most RECENT n, then restores chronological order — same
 * semantics as the old JSONL implementation.
 */
export function list({ limit = null } = {}) {
  if (limit !== null) {
    // Query gets the N most recent (DESC), then we reverse to chronological
    return stmts().listLimit.all({ limit }).reverse().map(rowToEntry);
  }
  return stmts().listAll.all().map(rowToEntry);
}

/** Every entry for one Razorpay order, oldest first. The history of one purchase. */
export function findByOrderId(orderId) {
  return stmts().findByOrderId.all({ order_id: orderId }).map(rowToEntry);
}

/**
 * Total captured spend, in paise — the sum of every PAYMENT_CAPTURED entry.
 *
 * The ledger, not a counter, is the source of truth for how much has been
 * spent. Two reasons this matters more than it looks:
 *
 *   - The capture happens in the HTTP process; the mandate lives in the MCP
 *     process. A `spent` field incremented in one is invisible to the other.
 *     Deriving it from the shared ledger means both agree by construction.
 *   - A budget figure that can drift from the record of what was actually
 *     bought is the exact thing an auditor would go looking for.
 *
 * ORDER_CREATED entries are deliberately NOT counted: an order awaiting payment
 * has not spent anything, and a checkout the human abandons must not
 * permanently burn budget.
 */
export function totalCaptured() {
  return stmts().totalCaptured.get().total;
}

/**
 * Captured spend under ONE mandate, in paise. This, not totalCaptured(), is
 * what a mandate's budget is measured against: every captured payment carries
 * the mandate that approved it, and a new mandate must not inherit spend that
 * an earlier one authorised.
 */
export function spentUnder(mandateId) {
  return stmts().spentUnder.get({ mandate_id: mandateId }).total;
}

/** When the hold placed by an ORDER_CREATED entry lapses. */
export function holdExpiresAt(orderEntry) {
  return new Date(Date.parse(orderEntry.timestamp) + HOLD_TTL_MS);
}

/**
 * Paise held by approved orders under one mandate that are neither captured
 * nor past their hold expiry. A PAYMENT_FAILED entry does NOT release a hold:
 * the Razorpay order is still payable, and the human may retry it.
 */
export function heldUnder(mandateId, now = new Date()) {
  const s = stmts();
  const capturedSet = new Set(
    s.capturedOrderIds.all().map((r) => r.order_id),
  );
  const orders = s.orderCreatedUnder.all({ mandate_id: mandateId }).map(rowToEntry);

  return orders
    .filter(
      (e) =>
        !capturedSet.has(e.order_id) &&
        holdExpiresAt(e) > now,
    )
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

/** One entry as a single human-readable line, for logs and the demo narration. */
export function formatEntry(entry) {
  const parts = [entry.timestamp, entry.status.toUpperCase()];
  if (entry.amount !== null) parts.push(formatPaise(entry.amount));
  if (entry.product_id !== null) parts.push(entry.product_id);
  if (entry.mandate !== null) parts.push(entry.mandate.code);
  if (entry.order_id !== null) parts.push(entry.order_id);
  if (entry.detail !== null) parts.push(`(${entry.detail})`);
  return parts.join("  ");
}
