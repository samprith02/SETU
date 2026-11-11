// Setu — mandate engine
//
// Pure logic. No HTTP, no MCP, no Razorpay — same shape as catalog.js and
// payments.js, so the `check_mandate` and `initiate_purchase` tools
// import these functions directly instead of reimplementing the rules.
//
// This is the "bounded and gated" half of the track's bar. Every money action
// passes through check() BEFORE any Razorpay order is created, so a blocked
// purchase never reaches the payment rails at all.
//
// MONEY: integer paise throughout, matching catalog.js. Comparing budgets in
// floating-point rupees can flip a verdict at the boundary.
//
// PERSISTENCE: mandates are stored in SQLite so they survive process restarts.
// The old in-memory-only store meant a server restart created a new mandate
// with a new id, and any spend under the old mandate was orphaned.

import { z } from "zod";
import { getDb } from "./db.js";

export const mandateSchema = z.object({
  id: z.string().min(1),
  // Total budget for the mandate's whole life. Stateful — meaningless without
  // `spent`. Bounds how much can go wrong in aggregate.
  max_amount: z.int().positive(),
  // Ceiling on any single purchase. Stateless. Bounds the blast radius of one
  // bad decision.
  per_txn_cap: z.int().positive(),
  // An agent may only buy within these catalog categories.
  category_allowlist: z.array(z.string()).min(1),
  // ISO 8601. Delegated authority that never lapses isn't delegated, it's given
  // away.
  expiry: z.string().datetime(),
  // Running total of approved+recorded spend, in paise.
  spent: z.int().nonnegative(),
  // Paise reserved by approved orders that have not been paid yet. Counted
  // against what remains so that unpaid orders cannot jointly overrun the
  // budget; released when the order is captured or its hold expires.
  held: z.int().nonnegative(),
  created_at: z.string().datetime(),
});

// Indian digit grouping (1,00,000 rather than 100,000). These strings land in
// the audit trail and get read aloud on camera, so they should look like money.
const RUPEE_FORMAT = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Paise -> a display string. Formatting happens here; maths never does. */
export function formatPaise(paise) {
  return "₹" + RUPEE_FORMAT.format(paise / 100);
}

// ---------------------------------------------------------------------------
// Persistent mandate storage
// ---------------------------------------------------------------------------
//
// Mandates are stored in SQLite. `spent` and `held` are NOT stored — they are
// derived from the audit ledger (see server.js's currentMandate()), which is
// the only source of truth for how much has been spent. Storing them here
// would create two sources of truth that could drift.

let _stmts = null;

function stmts() {
  if (_stmts !== null) return _stmts;

  const db = getDb();
  _stmts = {
    upsert: db.prepare(`
      INSERT OR REPLACE INTO mandates
        (id, max_amount, per_txn_cap, category_allowlist, expiry, created_at)
      VALUES
        (@id, @max_amount, @per_txn_cap, @category_allowlist, @expiry, @created_at)
    `),
    findById: db.prepare(`
      SELECT * FROM mandates WHERE id = @id
    `),
    findLatest: db.prepare(`
      SELECT * FROM mandates ORDER BY rowid DESC LIMIT 1
    `),
    listAll: db.prepare(`
      SELECT * FROM mandates ORDER BY rowid ASC
    `),
  };
  return _stmts;
}

function mandateRowToObj(row) {
  if (!row) return null;
  return {
    id: row.id,
    max_amount: row.max_amount,
    per_txn_cap: row.per_txn_cap,
    category_allowlist: JSON.parse(row.category_allowlist),
    expiry: row.expiry,
    created_at: row.created_at,
    // spent and held are NOT from the database — they must be supplied by the
    // caller from the audit ledger. Default to 0 here; server.js overrides.
    spent: 0,
    held: 0,
  };
}

// In-memory reference to the active mandate. Kept in sync with the database.
let activeMandate = null;
let counter = 0;

/**
 * Create a mandate, persist it, and make it the active one.
 * Amounts are integer paise. `expiry` is an ISO 8601 timestamp.
 */
export function createMandate({
  max_amount,
  per_txn_cap,
  category_allowlist,
  expiry,
}) {
  const mandate = mandateSchema.parse({
    id: `mdt_${++counter}_${Date.now()}`,
    max_amount,
    per_txn_cap,
    category_allowlist,
    expiry,
    spent: 0,
    held: 0,
    created_at: new Date().toISOString(),
  });

  // A per-transaction cap above the total budget is almost certainly a mistake
  // — it can never be the binding constraint. Better to reject it than to ship
  // a mandate with a rule that does nothing.
  if (mandate.per_txn_cap > mandate.max_amount) {
    throw new Error(
      `per_txn_cap (${formatPaise(mandate.per_txn_cap)}) cannot exceed ` +
        `max_amount (${formatPaise(mandate.max_amount)})`,
    );
  }

  // Persist to SQLite
  stmts().upsert.run({
    id: mandate.id,
    max_amount: mandate.max_amount,
    per_txn_cap: mandate.per_txn_cap,
    category_allowlist: JSON.stringify(mandate.category_allowlist),
    expiry: mandate.expiry,
    created_at: mandate.created_at,
  });

  activeMandate = mandate;
  return mandate;
}

/**
 * Load a mandate from the database by id. Returns the mandate object (without
 * spent/held — those must be derived from the audit ledger by the caller) or
 * null if not found.
 */
export function loadMandate(id) {
  const row = stmts().findById.get({ id });
  return mandateRowToObj(row);
}

/**
 * Load the most recently created mandate from the database. Used at startup
 * to resume the previous mandate instead of creating a new one every restart.
 */
export function loadLatestMandate() {
  const row = stmts().findLatest.get();
  const mandate = mandateRowToObj(row);
  if (mandate) activeMandate = mandate;
  return mandate;
}

/** The current mandate, or null if none has been created. */
export function getActiveMandate() {
  return activeMandate;
}

/** Amount still available under the total budget, in paise: neither spent nor held. */
export function remainingBudget(mandate) {
  return Math.max(0, mandate.max_amount - mandate.spent - (mandate.held ?? 0));
}

/**
 * Decide whether a purchase is permitted. Called BEFORE any Razorpay order is
 * created — a blocked purchase must never touch the payment rails.
 *
 * Returns the FIRST failing rule rather than every failure, so the audit trail
 * records one unambiguous reason. Rule order is deliberate and is the order a
 * person would reason in:
 *   1. expiry   — a lapsed mandate authorises nothing, so nothing else matters
 *   2. category — what may be bought, before how much
 *   3. per_txn_cap  — is this single purchase too large
 *   4. max_amount   — does it fit in what's left of the budget
 *
 * `remaining` is always included so a blocked agent can pick a cheaper
 * substitute without having to guess.
 */
export function check(mandate, purchaseAmount, category, now = new Date()) {
  if (mandate === null || mandate === undefined) {
    return {
      approved: false,
      code: "no_mandate",
      reason: "No active mandate. An agent cannot spend without one.",
    };
  }
  if (!Number.isInteger(purchaseAmount) || purchaseAmount <= 0) {
    return {
      approved: false,
      code: "invalid_amount",
      reason: `Purchase amount must be a positive integer in paise, got: ${purchaseAmount}`,
    };
  }

  const remaining = remainingBudget(mandate);
  const context = {
    mandate_id: mandate.id,
    amount: purchaseAmount,
    category,
    remaining,
  };

  // 1. Expiry
  if (new Date(mandate.expiry) <= now) {
    return {
      ...context,
      approved: false,
      code: "mandate_expired",
      reason:
        `Mandate expired at ${mandate.expiry} (now ${now.toISOString()}). ` +
        `Expired mandates authorise nothing.`,
    };
  }

  // 2. Category allowlist
  if (!mandate.category_allowlist.includes(category)) {
    return {
      ...context,
      approved: false,
      code: "category_not_allowed",
      reason:
        `Category "${category}" is not in this mandate's allowlist ` +
        `(${mandate.category_allowlist.join(", ")}).`,
    };
  }

  // 3. Per-transaction cap — bounds one bad decision
  if (purchaseAmount > mandate.per_txn_cap) {
    return {
      ...context,
      approved: false,
      code: "per_txn_cap_exceeded",
      reason:
        `Purchase of ${formatPaise(purchaseAmount)} exceeds the per-transaction ` +
        `cap of ${formatPaise(mandate.per_txn_cap)}.`,
    };
  }

  // 4. Total budget — bounds aggregate exposure, including unpaid orders
  if (purchaseAmount > remaining) {
    const held = mandate.held ?? 0;
    return {
      ...context,
      approved: false,
      code: "max_amount_exceeded",
      reason:
        `Purchase of ${formatPaise(purchaseAmount)} exceeds the ` +
        `${formatPaise(remaining)} remaining of a ${formatPaise(mandate.max_amount)} ` +
        `budget (${formatPaise(mandate.spent)} already spent` +
        (held > 0 ? `, ${formatPaise(held)} held by orders awaiting payment` : "") +
        `).`,
    };
  }

  return {
    ...context,
    approved: true,
    code: "approved",
    reason:
      `Approved: ${formatPaise(purchaseAmount)} in "${category}" is within the ` +
      `${formatPaise(mandate.per_txn_cap)} per-transaction cap and the ` +
      `${formatPaise(remaining)} remaining budget.`,
  };
}

/**
 * Record spend against the mandate after a purchase actually completes.
 * Without this `max_amount` can never bind — a budget that is never decremented
 * is decoration. Call only after a payment is confirmed, never on intent.
 */
export function recordSpend(mandate, purchaseAmount) {
  if (!Number.isInteger(purchaseAmount) || purchaseAmount <= 0) {
    throw new Error(`recordSpend needs a positive integer paise amount, got: ${purchaseAmount}`);
  }
  mandate.spent += purchaseAmount;
  return mandate;
}
