// Setu — MCP server
//
// The agent-facing surface. Five tools, and every one of them is a thin wrapper:
// catalog.js decides what exists, mandate.js decides what is permitted,
// payments.js talks to Razorpay, audit.js records what happened. No business
// logic lives in this file — it translates between MCP's tool protocol and
// those four modules, exactly as server-http.js does for HTTP, so the two
// surfaces cannot drift apart.
//
// stdout is the JSON-RPC channel. Anything written there that isn't a protocol
// message corrupts the stream, so every log below goes to console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCatalog, getProduct, searchCatalog, CURRENCY, UNIT } from "./catalog.js";
import { createMandate, check, formatPaise, remainingBudget } from "./mandate.js";
import { createOrder } from "./payments.js";
import * as audit from "./audit.js";

// Razorpay credentials come from .env via Node's built-in loader — no dotenv:
//   node --env-file=.env server.js
// The flag does the loading; this only verifies it worked, so a forgotten flag
// fails here loudly instead of surfacing as a baffling auth error mid-demo.
// Never log the values themselves — presence only.
const REQUIRED_ENV = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

// Where the human goes to actually pay. The MCP server never serves this page —
// server-http.js does — so the two must agree on the origin.
const BASE_URL = process.env.SETU_BASE_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// The mandate — seeded here, NOT creatable by the agent
// ---------------------------------------------------------------------------
//
// Note what is missing from the tool list below: there is no `create_mandate`.
// That absence is the whole point. An agent that can mint its own spending
// authority has no spending limit — it has a formality it can rewrite whenever
// the limit becomes inconvenient. Delegated authority only means something if
// it is granted from outside the thing being constrained.
//
// So the mandate is seeded at startup, in the server's own process, before any
// agent connects. This block is a STAND-IN for a real merchant's admin flow —
// in production a human would authorise this in a dashboard, or it would arrive
// signed from the merchant's backend, and it would be scoped to one agent
// session. What matters for the demo is only that the agent cannot reach it.
//
// The numbers are chosen against the campus-store catalog so both outcomes are
// demonstrable without contrived inputs:
//   - ₹500 per-transaction cap: admits the phone case (₹399), the USB-C cable
//     (₹299) and the stationery, blocks the 65W charger (₹1,499) and the power
//     bank (₹1,299).
//   - ₹2,000 total budget: several purchases fit, so budget exhaustion is
//     reachable in a live demo rather than theoretical.
//   - allowlist omits `audio`, `chargers` and `storage`, so a category refusal
//     can be shown independently of a price refusal.
const DEMO_MANDATE = createMandate({
  max_amount: 200000, // ₹2,000.00 total, for the mandate's whole life
  per_txn_cap: 50000, // ₹500.00 ceiling on any single purchase
  category_allowlist: ["cables", "stationery", "accessories"],
  expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
});

/**
 * The mandate as it stands right now.
 *
 * `spent` is DERIVED from the audit ledger rather than read from a counter.
 * The order is created in this process but captured in the HTTP one, so an
 * in-memory `spent` incremented on either side would be invisible to the other
 * and the budget would silently under-count. Deriving it from the shared ledger
 * makes both processes agree by construction, and means the budget can never
 * drift from the record of what was actually bought — which is precisely the
 * discrepancy an audit trail exists to catch.
 */
function currentMandate() {
  return { ...DEMO_MANDATE, spent: audit.totalCaptured() };
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

// Agents read the first line; humans watching the demo read the first line too.
// The JSON below it carries the full detail for anything that needs to branch.
const ok = (summary, data) => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

const fail = (summary, data) => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  isError: true,
});

const server = new McpServer({ name: "setu", version: "0.2.0" });

// ---------------------------------------------------------------------------
// 1. search_catalog
// ---------------------------------------------------------------------------
server.registerTool(
  "search_catalog",
  {
    title: "Search catalog",
    description:
      "Search the merchant's product catalog. All filters are optional and combine with AND; " +
      "with no arguments it returns the whole catalog, cheapest first. " +
      "IMPORTANT: max_price is an integer count of PAISE, not rupees — ₹500 is 50000. " +
      "Every price in the response is paise too; the response states its own currency and unit.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Free text matched across name, description, tags and id, e.g. "phone case".'),
      category: z
        .string()
        .optional()
        .describe("Exact category: chargers, cables, accessories, audio, storage, stationery."),
      max_price: z
        .int()
        .positive()
        .optional()
        .describe("Maximum price in PAISE. ₹500 is 50000."),
    },
  },
  async ({ query, category, max_price }) => {
    const result = searchCatalog({
      query: query ?? null,
      category: category ?? null,
      maxPrice: max_price ?? null,
    });
    return ok(
      `${result.count} product(s) matched. Prices are in ${result.unit}.`,
      result,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. get_product
// ---------------------------------------------------------------------------
server.registerTool(
  "get_product",
  {
    title: "Get product",
    description:
      "Fetch one product by its exact catalog id. Price is an integer count of PAISE. " +
      "Use this to confirm the price and category before calling check_mandate or initiate_purchase.",
    inputSchema: {
      product_id: z.string().min(1).describe('Exact catalog id, e.g. "acc-case-clear".'),
    },
  },
  async ({ product_id }) => {
    const product = getProduct(product_id);
    if (product === null) {
      return fail(`No product with id "${product_id}".`, {
        error: "product_not_found",
        id: product_id,
        hint: "Call search_catalog to list valid ids.",
      });
    }
    return ok(`${product.name} — ${formatPaise(product.price)} (${product.category})`, {
      currency: CURRENCY,
      unit: UNIT,
      product,
    });
  },
);

// ---------------------------------------------------------------------------
// 3. check_mandate
// ---------------------------------------------------------------------------
server.registerTool(
  "check_mandate",
  {
    title: "Check mandate",
    description:
      "Ask whether buying a product would be permitted under the active spend mandate, WITHOUT " +
      "buying it. Returns the verdict and, when refused, the specific rule that refused it and " +
      "how much budget remains — enough to pick a cheaper substitute. " +
      "The amount and category are read from the catalog, never supplied by the caller. " +
      "This is a preview: initiate_purchase re-runs the same check itself, so calling this first " +
      "is optional, but the check is recorded in the audit log either way.",
    inputSchema: {
      product_id: z.string().min(1).describe("Exact catalog id of the product being considered."),
      intent: z
        .string()
        .optional()
        .describe("Why you are considering this purchase, in your own words. Recorded in the audit log."),
    },
  },
  async ({ product_id, intent }) => {
    const product = getProduct(product_id);
    if (product === null) {
      return fail(`No product with id "${product_id}".`, {
        error: "product_not_found",
        id: product_id,
      });
    }

    const mandate = currentMandate();
    const verdict = check(mandate, product.price, product.category);

    audit.record({
      status: audit.STATUS.MANDATE_CHECKED,
      intent: intent ?? null,
      amount: product.price,
      product_id: product.id,
      mandate: {
        mandate_id: mandate.id,
        approved: verdict.approved,
        code: verdict.code,
        reason: verdict.reason,
      },
    });

    return ok(verdict.approved ? "PERMITTED (not yet purchased)" : "REFUSED", {
      ...verdict,
      product: { id: product.id, name: product.name, category: product.category },
      unit: UNIT,
      remaining_display: formatPaise(remainingBudget(mandate)),
      note: "This was a check only. No order was created and no money moved.",
    });
  },
);

// ---------------------------------------------------------------------------
// 4. initiate_purchase
// ---------------------------------------------------------------------------
//
// The gate. Two things happen here and one deliberately does not:
//
//   DOES: the mandate is checked BEFORE Razorpay is contacted. A refused
//         purchase never reaches the payment rails at all — that is the claim
//         the whole project rests on, and it only holds if the check comes
//         first, in this order, in this function.
//   DOES: on approval, a Razorpay order is created and recorded as PENDING.
//   DOES NOT: report success, or count spend against the budget.
//
// Order creation and payment capture are not the same instant. `orders.create`
// returns immediately; capture only happens once a human completes Razorpay's
// hosted Checkout, which may be a minute later or never. A tool call cannot sit
// and wait for that, so the honest return here is "awaiting_payment" plus a URL.
// The captured-status check and the settling audit entry live in the
// /payment/verify route in server-http.js, which is the side that actually
// learns the outcome.
//
// Counting spend here would be worse than merely inaccurate: a checkout the
// human abandons would permanently burn budget the user never spent.
server.registerTool(
  "initiate_purchase",
  {
    title: "Initiate purchase",
    description:
      "Attempt to buy a product. The purchase is checked against the active spend mandate FIRST — " +
      "if the mandate refuses, no payment order is created and nothing is charged. " +
      "If the mandate approves, a Razorpay order is created and a checkout URL is returned. " +
      "This does NOT complete the payment: a human must open that URL and pay. The tool returns " +
      "status 'awaiting_payment', never 'paid'. Call get_audit_log afterwards to see whether the " +
      "payment was captured. The price is taken from the catalog and can never be supplied by you.",
    inputSchema: {
      product_id: z.string().min(1).describe("Exact catalog id of the product to buy."),
      intent: z
        .string()
        .min(1)
        .describe(
          "Why you are making this purchase, in your own words — the user request you are acting on. " +
            "Required: it is the audit trail's record of what you believed you were doing.",
        ),
    },
  },
  async ({ product_id, intent }) => {
    const product = getProduct(product_id);
    if (product === null) {
      return fail(`No product with id "${product_id}".`, {
        error: "product_not_found",
        id: product_id,
        hint: "Call search_catalog to list valid ids.",
      });
    }

    const mandate = currentMandate();

    // ---- THE GATE. Before Razorpay, always. --------------------------------
    const verdict = check(mandate, product.price, product.category);
    const mandateRecord = {
      mandate_id: mandate.id,
      approved: verdict.approved,
      code: verdict.code,
      reason: verdict.reason,
    };

    if (!verdict.approved) {
      const entry = audit.record({
        status: audit.STATUS.PURCHASE_BLOCKED,
        intent,
        amount: product.price,
        product_id: product.id,
        mandate: mandateRecord,
      });
      console.error(`[setu] BLOCKED ${product.id} — ${verdict.code}`);

      return fail(`REFUSED — ${verdict.reason}`, {
        purchased: false,
        blocked_by: verdict.code,
        reason: verdict.reason,
        product: { id: product.id, name: product.name, category: product.category },
        amount: product.price,
        unit: UNIT,
        remaining: verdict.remaining,
        remaining_display: formatPaise(verdict.remaining ?? 0),
        audit_entry_id: entry.id,
        note: "No Razorpay order was created. Nothing was charged.",
      });
    }

    // ---- Approved: create the order ----------------------------------------
    let order;
    try {
      order = await createOrder({
        amountPaise: product.price,
        // Razorpay caps receipt at 40 characters; the provenance lives in notes.
        receipt: `setu_${Date.now()}`,
        notes: {
          product_id: product.id,
          product_name: product.name,
          mandate_id: mandate.id,
          // Notes values are capped at 256 characters by Razorpay.
          intent: intent.slice(0, 256),
          source: "mcp:initiate_purchase",
        },
      });
    } catch (error) {
      audit.record({
        status: audit.STATUS.PAYMENT_FAILED,
        intent,
        amount: product.price,
        product_id: product.id,
        mandate: mandateRecord,
        detail: `order_creation_failed: mandate approved but Razorpay refused the order — ${error.message}`,
      });
      console.error(`[setu] order creation failed for ${product.id}: ${error.message}`);
      return fail("Mandate approved the purchase, but Razorpay order creation failed.", {
        purchased: false,
        error: "order_creation_failed",
        detail: error.message,
        product: { id: product.id, name: product.name },
      });
    }

    const entry = audit.record({
      status: audit.STATUS.ORDER_CREATED,
      intent,
      amount: product.price,
      product_id: product.id,
      mandate: mandateRecord,
      order_id: order.id,
    });
    console.error(`[setu] order ${order.id} created for ${product.id} (${verdict.code})`);

    return ok(`APPROVED — order created, awaiting payment. ${verdict.reason}`, {
      purchased: false,
      status: "awaiting_payment",
      approved_by: verdict.code,
      reason: verdict.reason,
      product: { id: product.id, name: product.name, category: product.category },
      amount: order.amount,
      currency: order.currency,
      unit: UNIT,
      amount_display: formatPaise(order.amount),
      order_id: order.id,
      checkout_url: `${BASE_URL}/checkout.html?orderId=${order.id}`,
      audit_entry_id: entry.id,
      next_step:
        "A human must open checkout_url and complete payment. Payment capture is verified " +
        "server-side; call get_audit_log to see the outcome. Budget is only counted once captured.",
    });
  },
);

// ---------------------------------------------------------------------------
// 5. get_audit_log
// ---------------------------------------------------------------------------
server.registerTool(
  "get_audit_log",
  {
    title: "Get audit log",
    description:
      "Read the audit trail: every mandate check, every blocked purchase, every order created and " +
      "every payment captured or failed, oldest first. This is the record of what was decided and " +
      "why. Use it to confirm whether a purchase you initiated was actually paid for — " +
      "initiate_purchase only ever reports that an order was created.",
    inputSchema: {
      limit: z
        .int()
        .positive()
        .optional()
        .describe("Return only the most recent N entries. Omit for the full trail."),
      order_id: z
        .string()
        .optional()
        .describe("Return only entries for this Razorpay order — the history of one purchase."),
    },
  },
  async ({ limit, order_id }) => {
    const entries = order_id
      ? audit.findByOrderId(order_id)
      : audit.list({ limit: limit ?? null });

    const mandate = currentMandate();
    return ok(
      `${entries.length} audit entr(ies). Spent ${formatPaise(mandate.spent)} of ` +
        `${formatPaise(mandate.max_amount)}; ${formatPaise(remainingBudget(mandate))} remaining.`,
      {
        mandate: {
          id: mandate.id,
          max_amount: mandate.max_amount,
          per_txn_cap: mandate.per_txn_cap,
          category_allowlist: mandate.category_allowlist,
          expiry: mandate.expiry,
          spent: mandate.spent,
          remaining: remainingBudget(mandate),
          unit: UNIT,
        },
        entries,
        timeline: entries.map(audit.formatEntry),
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[setu] MCP server ready on stdio — 5 tools registered");
console.error(
  `[setu] demo mandate ${DEMO_MANDATE.id}: ` +
    `${formatPaise(DEMO_MANDATE.max_amount)} budget, ` +
    `${formatPaise(DEMO_MANDATE.per_txn_cap)} per-transaction cap, ` +
    `categories [${DEMO_MANDATE.category_allowlist.join(", ")}], ` +
    `expires ${DEMO_MANDATE.expiry}`,
);
console.error(`[setu] already spent (from audit ledger): ${formatPaise(audit.totalCaptured())}`);
if (missingEnv.length > 0) {
  console.error(
    `[setu] WARNING: ${missingEnv.join(", ")} not set — start with ` +
      `\`node --env-file=.env server.js\`. Razorpay calls will fail until this is fixed.`,
  );
} else {
  console.error("[setu] Razorpay credentials loaded from environment");
}
