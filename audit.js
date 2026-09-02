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
// APPEND-ONLY, ON DISK. Two properties this file is built around:
//
//   1. Entries are never mutated. A purchase that is approved and then captured
//      produces TWO entries, not one row edited twice. An audit log you can
//      rewrite is not an audit log, and the pending->settled transition is
//      exactly the history worth keeping.
//
//   2. The ledger lives in a file, and every read re-reads it. The MCP server
//      (server.js) and the HTTP server (server-http.js) are SEPARATE Node
//      processes: an order is created in the first and confirmed in the second.
//      An in-memory array would leave each blind to the other, and
//      `get_audit_log` would report "awaiting payment" forever for a purchase
//      that had already settled.
//
// MONEY: integer paise throughout, matching catalog.js and mandate.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { formatPaise } from "./mandate.js";

// Resolved against this file, not the working directory, so both servers write
// to the same ledger no matter where they were started from.
const LOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-log.jsonl");

/**
 * The lifecycle of one money decision. Statuses are the vocabulary the whole
 * project speaks — the MCP tools, the HTTP route and (Afternoon) the dashboard
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

  // One JSON object per line. A single sub-4KB appendFileSync is atomic enough
  // that the two servers can write concurrently without interleaving a line,
  // and a line-oriented file stays readable with `tail -f` during the demo.
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Every entry, oldest first — the order things happened, which is the order a
 * reviewer wants to read. Re-reads the file on every call so an entry written
 * by the other process is visible immediately.
 *
 * A malformed line throws rather than being skipped. Nothing but `record()`
 * ever writes here, so a bad line means real corruption, and an audit log that
 * quietly drops entries is worse than one that refuses to load.
 */
export function list({ limit = null } = {}) {
  if (!fs.existsSync(LOG_PATH)) return [];

  const entries = fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      try {
        return auditEntrySchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `audit-log.jsonl line ${number} is corrupt and cannot be parsed: ${error.message}`,
        );
      }
    });

  // Limit takes the most RECENT n, then restores chronological order.
  return limit === null ? entries : entries.slice(-limit);
}

/** Every entry for one Razorpay order, oldest first. The history of one purchase. */
export function findByOrderId(orderId) {
  return list().filter((entry) => entry.order_id === orderId);
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
  return list()
    .filter((entry) => entry.status === STATUS.PAYMENT_CAPTURED)
    .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
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
