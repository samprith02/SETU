// Setu — MCP tool surface factory
//
// Shared by both transports:
//   - server.js       (stdio transport — `claude mcp add --transport stdio`)
//   - server-http.js  (Streamable HTTP at /mcp + optional --stdio in one process)
//
// Every tool here is a thin wrapper over catalog.js, mandate.js, payments.js,
// audit.js, upsell.js and merchant2.js. No business logic lives in this file.
//
// stdout is reserved for JSON-RPC when stdio transport is active, so every log
// in this module goes to console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getProduct, searchCatalog, CURRENCY, UNIT } from "./catalog.js";
import { createMandate, loadLatestMandate, check, formatPaise, remainingBudget } from "./mandate.js";
import { createOrder } from "./payments.js";
import * as audit from "./audit.js";
import { getUpsell } from "./upsell.js";
import { getStudyProduct, searchStudyCatalog } from "./merchant2.js";

const DEFAULT_AUDIT_LIMIT = 25;

// ---------------------------------------------------------------------------
// Shared demo mandate & serialization queue (process-wide across sessions)
// ---------------------------------------------------------------------------

let demoMandate = null;

/**
 * Resume the persisted demo mandate if one exists and has not expired;
 * otherwise seed a fresh one. Cached per-process so every MCP session and
 * HTTP route shares the exact same mandate id.
 */
export function ensureDemoMandate() {
  if (demoMandate && new Date(demoMandate.expiry) > new Date()) {
    return demoMandate;
  }
  const existing = loadLatestMandate();
  if (existing && new Date(existing.expiry) > new Date()) {
    demoMandate = existing;
    return demoMandate;
  }
  demoMandate = createMandate({
    max_amount: 200000, // ₹2,000.00 total, for the mandate's whole life
    per_txn_cap: 50000, // ₹500.00 ceiling on any single purchase
    category_allowlist: ["cables", "stationery", "accessories"],
    expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  });
  return demoMandate;
}

/** Reset cached mandate reference (useful for tests switching DB paths). */
export function resetCachedMandate() {
  demoMandate = null;
}

/**
 * The active mandate enriched with live `spent` and `held` derived from the
 * audit ledger so budget state never drifts from recorded reality.
 */
export function currentMandate() {
  const m = ensureDemoMandate();
  return {
    ...m,
    spent: audit.spentUnder(m.id),
    held: audit.heldUnder(m.id),
  };
}

/**
 * Run purchase attempts one at a time across ALL MCP sessions in this process.
 *
 * initiate_purchase reads the budget, awaits Razorpay, then records the order
 * that places the hold. Two calls interleaved across that await would both read
 * the budget before either hold existed, and both be approved.
 */
let purchaseQueue = Promise.resolve();
function oneAtATime(fn) {
  const run = purchaseQueue.then(fn, fn);
  purchaseQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Substitute helpers
// ---------------------------------------------------------------------------

function suggestAlternatives(mandate, blockedProduct, limit = 2) {
  const wantedTags = new Set(blockedProduct.tags);
  const sharedTags = (product) => product.tags.filter((tag) => wantedTags.has(tag)).length;
  const sameCategory = (product) => (product.category === blockedProduct.category ? 0 : 1);

  return mandate.category_allowlist
    .flatMap((category) => searchCatalog({ category, maxPrice: mandate.per_txn_cap }).products)
    .filter(
      (candidate) =>
        candidate.id !== blockedProduct.id &&
        check(mandate, candidate.price, candidate.category).approved,
    )
    .sort(
      (a, b) =>
        sharedTags(b) - sharedTags(a) ||
        sameCategory(a) - sameCategory(b) ||
        a.price - b.price,
    )
    .slice(0, limit);
}

const alternativesDetail = (alternatives) =>
  alternatives.length > 0
    ? `suggested_alternatives: ${alternatives.map((a) => a.id).join(", ")}`
    : "suggested_alternatives: none — no catalog product satisfies this mandate";

const alternativesAdvice = (alternatives) =>
  alternatives.length > 0
    ? " Permitted alternatives, closest match first: " +
      alternatives.map((a) => `${a.name} (${formatPaise(a.price)}, id ${a.id})`).join("; ") +
      "."
    : " No product in this catalog is permitted under the current mandate, so there is no substitute.";

const alternativesPayload = (alternatives) =>
  alternatives.map((a) => ({
    id: a.id,
    name: a.name,
    category: a.category,
    price: a.price,
    price_display: formatPaise(a.price),
  }));

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

const ok = (summary, data) => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

const fail = (summary, data) => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure a Setu McpServer instance with all 8 tools.
 * Each Streamable HTTP session gets its own McpServer instance connected to
 * its transport, while sharing the process-wide mandate, ledger, and queue.
 */
export function createSetuMcpServer({ baseUrl, defaultAgentId = null } = {}) {
  const resolveBaseUrl = () =>
    baseUrl || process.env.SETU_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  const resolveAgentId = (extra) =>
    extra?.authInfo?.clientId ?? defaultAgentId ?? process.env.SETU_AGENT_ID ?? null;

  const server = new McpServer({ name: "setu", version: "0.3.0" });

  // 1. search_catalog
  server.registerTool(
    "search_catalog",
    {
      title: "Search catalog",
      description:
        "Search the merchant's product catalog. " +
        "All filters are optional and combine with AND; " +
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

  // 2. get_product
  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description:
        "Fetch one product by its exact catalog id. " +
        "Price is an integer count of PAISE. " +
        "Use this to confirm the price and category before calling check_mandate or initiate_purchase.",
      inputSchema: {
        product_id: z
          .string()
          .min(1)
          .describe('Exact catalog id, e.g. "acc-case-clear".'),
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

  // 3. check_mandate
  server.registerTool(
    "check_mandate",
    {
      title: "Check mandate",
      description:
        "Ask whether buying a product would be permitted under the active spend mandate, WITHOUT " +
        "buying it. Returns the verdict and, when refused, the specific rule that refused it, how " +
        "much budget remains, and up to two `alternatives` — real catalog products the mandate WOULD " +
        "approve, closest match first (same category as the product you asked about where one " +
        "qualifies, then cheapest). Buy one of those ids instead of searching the catalog yourself. " +
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
    async ({ product_id, intent }, extra) => {
      const product = getProduct(product_id);
      if (product === null) {
        return fail(`No product with id "${product_id}".`, {
          error: "product_not_found",
          id: product_id,
        });
      }

      const mandate = currentMandate();
      const verdict = check(mandate, product.price, product.category);
      const alternatives = verdict.approved ? [] : suggestAlternatives(mandate, product);
      const agentId = resolveAgentId(extra);

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
        agent_id: agentId,
        detail: verdict.approved ? null : alternativesDetail(alternatives),
      });

      return ok(
        verdict.approved
          ? "PERMITTED (not yet purchased)"
          : `REFUSED — ${verdict.reason}${alternativesAdvice(alternatives)}`,
        {
          ...verdict,
          product: { id: product.id, name: product.name, category: product.category },
          unit: UNIT,
          remaining_display: formatPaise(remainingBudget(mandate)),
          alternatives: alternativesPayload(alternatives),
          note: "This was a check only. No order was created and no money moved.",
        },
      );
    },
  );

  // 4. initiate_purchase
  server.registerTool(
    "initiate_purchase",
    {
      title: "Initiate purchase",
      description:
        "Attempt to buy a product. The purchase is checked against the active spend mandate FIRST — " +
        "if the mandate refuses, no payment order is created and nothing is charged, and the refusal " +
        "names up to two `alternatives` the mandate WOULD approve, closest match first (same category " +
        "as the product you asked for where one qualifies, then cheapest). To recover from a refusal, " +
        "call this tool again with one of those ids — there is no separate retry tool. " +
        "If the mandate approves, a Razorpay order is created and a checkout URL is returned. " +
        "This does NOT complete the payment: a human must open that URL and pay. The tool returns " +
        "status 'awaiting_payment', never 'paid'. Call get_audit_log afterwards to see whether the " +
        "payment was captured. " +
        "The price is taken from the catalog and can never be supplied by you.",
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
    async ({ product_id, intent }, extra) => oneAtATime(async () => {
      const product = getProduct(product_id);
      if (product === null) {
        return fail(`No product with id "${product_id}".`, {
          error: "product_not_found",
          id: product_id,
          hint: "Call search_catalog to list valid ids.",
        });
      }

      const mandate = currentMandate();
      const agentId = resolveAgentId(extra);

      // THE GATE. Before any checkout, always.
      const verdict = check(mandate, product.price, product.category);
      const mandateRecord = {
        mandate_id: mandate.id,
        approved: verdict.approved,
        code: verdict.code,
        reason: verdict.reason,
      };

      if (!verdict.approved) {
        const alternatives = suggestAlternatives(mandate, product);

        const entry = audit.record({
          status: audit.STATUS.PURCHASE_BLOCKED,
          intent,
          amount: product.price,
          product_id: product.id,
          mandate: mandateRecord,
          agent_id: agentId,
          detail: alternativesDetail(alternatives),
        });
        console.error(
          `[setu] BLOCKED ${product.id} — ${verdict.code}; ` +
            `${alternatives.length} alternative(s) offered`,
        );

        return fail(`REFUSED — ${verdict.reason}${alternativesAdvice(alternatives)}`, {
          purchased: false,
          blocked_by: verdict.code,
          reason: verdict.reason,
          product: { id: product.id, name: product.name, category: product.category },
          amount: product.price,
          unit: UNIT,
          remaining: verdict.remaining,
          remaining_display: formatPaise(verdict.remaining ?? 0),
          alternatives: alternativesPayload(alternatives),
          audit_entry_id: entry.id,
          note: "No order was created. Nothing was charged.",
          next_step:
            alternatives.length > 0
              ? "To recover, call initiate_purchase again with one of the alternative ids above."
              : "Nothing in the catalog satisfies this mandate. Report that to the user rather than retrying — a different product will be refused too.",
        });
      }

      // Approved: create the Razorpay order
      let order;
      try {
        order = await createOrder({
          amountPaise: product.price,
          receipt: `setu_${Date.now()}`,
          notes: {
            product_id: product.id,
            product_name: product.name,
            mandate_id: mandate.id,
            intent: intent.slice(0, 256),
            source: "mcp:initiate_purchase",
            ...(agentId ? { agent_id: agentId } : {}),
          },
        });
      } catch (error) {
        audit.record({
          status: audit.STATUS.PAYMENT_FAILED,
          intent,
          amount: product.price,
          product_id: product.id,
          mandate: mandateRecord,
          agent_id: agentId,
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
        agent_id: agentId,
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
        checkout_url: `${resolveBaseUrl()}/checkout.html?orderId=${order.id}`,
        audit_entry_id: entry.id,
        hold_expires_at: audit.holdExpiresAt(entry).toISOString(),
        next_step:
          "A human must open checkout_url and complete payment before hold_expires_at. Payment " +
          "capture is verified server-side; call get_audit_log to see the outcome. Until then the " +
          "amount is held against the budget, and counted as spent only once captured.",
      });
    }),
  );

  // 5. get_audit_log
  server.registerTool(
    "get_audit_log",
    {
      title: "Get audit log",
      description:
        "Read the audit trail: every mandate check, every blocked purchase, every order created and " +
        "every payment captured or failed, oldest first. This is the record of what was decided and " +
        "why. Use it to confirm whether a purchase you initiated was actually paid for — " +
        "initiate_purchase only ever reports that an order was created. " +
        `Returns the ${DEFAULT_AUDIT_LIMIT} most recent entries by default; the response states how ` +
        "many exist in total, and `limit` or `order_id` reach the rest.",
      inputSchema: {
        limit: z
          .int()
          .positive()
          .optional()
          .describe(
            `Return only the most recent N entries. Defaults to ${DEFAULT_AUDIT_LIMIT}. ` +
              "Pass a larger number for more of the trail.",
          ),
        order_id: z
          .string()
          .optional()
          .describe("Return only entries for this Razorpay order — the history of one purchase."),
      },
    },
    async ({ limit, order_id }) => {
      const all = order_id ? audit.findByOrderId(order_id) : audit.list();
      const window = limit ?? (order_id ? all.length : DEFAULT_AUDIT_LIMIT);
      const entries = all.slice(-window);
      const omitted = all.length - entries.length;

      const mandate = currentMandate();
      return ok(
        `${entries.length} of ${all.length} audit entr(ies)` +
          (omitted > 0 ? ` (${omitted} older not shown — pass a larger limit)` : "") +
          `. Spent ${formatPaise(mandate.spent)} of ${formatPaise(mandate.max_amount)}` +
          (mandate.held > 0 ? `, ${formatPaise(mandate.held)} held by unpaid orders` : "") +
          `; ${formatPaise(remainingBudget(mandate))} remaining.`,
        {
          total_entries: all.length,
          showing: entries.length,
          omitted,
          mandate: {
            id: mandate.id,
            max_amount: mandate.max_amount,
            per_txn_cap: mandate.per_txn_cap,
            category_allowlist: mandate.category_allowlist,
            expiry: mandate.expiry,
            spent: mandate.spent,
            held: mandate.held,
            remaining: remainingBudget(mandate),
            unit: UNIT,
          },
          entries,
          timeline: entries.map(audit.formatEntry),
        },
      );
    },
  );

  // 6. get_upsell
  server.registerTool(
    "get_upsell",
    {
      title: "Get upsell suggestions",
      description:
        "After a purchase completes, returns up to 3 complementary product suggestions " +
        "for the given product id. Suggestions are based on complementarity rules " +
        "(e.g. a mouse → stand, cable) and sorted cheapest first. " +
        "These are SUGGESTIONS, not approved purchases — the agent should surface them " +
        "to the human; any actual purchase still requires a separate initiate_purchase call " +
        "that goes through the full mandate gate. " +
        "Use the product_id from the PAYMENT_CAPTURED audit entry.",
      inputSchema: {
        product_id: z
          .string()
          .min(1)
          .describe("The id of the product that was just purchased."),
      },
    },
    async ({ product_id }) => {
      const result = getUpsell(product_id);
      if (result.purchased === null) {
        return fail(`Product "${product_id}" not found in catalog.`, { product_id });
      }
      if (result.suggestions.length === 0) {
        return ok(
          `No complementary suggestions for "${result.purchased.name}" — ` +
            `no pairing rules match this product type.`,
          { product_id, purchased: result.purchased, suggestions: [] },
        );
      }
      const names = result.suggestions
        .map((p) => `${p.name} (${formatPaise(p.price)}, id ${p.id})`)
        .join("; ");
      return ok(
        `Bought: ${result.purchased.name}. ` +
          `You might also consider: ${names}. ` +
          `To purchase any of these, call initiate_purchase — the mandate gate applies as normal.`,
        {
          product_id,
          purchased: { id: result.purchased.id, name: result.purchased.name, price: result.purchased.price },
          suggestions: result.suggestions.map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            price: p.price,
            price_display: formatPaise(p.price),
          })),
          currency: result.currency,
          unit: result.unit,
          note: "Suggestions are not mandated purchases. Call initiate_purchase to act on any of these.",
        },
      );
    },
  );

  // 7. search_study_catalog
  server.registerTool(
    "search_study_catalog",
    {
      title: "Search study store catalog",
      description:
        "Search the second merchant's catalog: Campus Study & Office Essentials. " +
        "Same mandate and audit contract as the tech store — different products. " +
        "This demonstrates Setu is a portable trust primitive, not a one-merchant integration. " +
        "Prices are integer PAISE. Categories: stationery, desk, tech.",
      inputSchema: {
        query: z.string().optional().describe('Free text, e.g. "notebook" or "mechanical keyboard".'),
        category: z.string().optional().describe("stationery, desk, or tech."),
        max_price: z.int().positive().optional().describe("Upper price bound in paise."),
      },
    },
    async ({ query, category, max_price }) => {
      const result = searchStudyCatalog({
        query: query ?? null,
        category: category ?? null,
        maxPrice: max_price ?? null,
      });
      return ok(
        `Study store: ${result.count} product(s) match. ` +
          (result.count === 0 ? "Try broader search terms." : "Prices in paise; use initiate_purchase to buy."),
        result,
      );
    },
  );

  // 8. get_study_product
  server.registerTool(
    "get_study_product",
    {
      title: "Get study store product",
      description:
        "Retrieve one product from the study store by id. " +
        "Use search_study_catalog to find ids first.",
      inputSchema: {
        product_id: z.string().min(1).describe("Exact product id from the study store catalog."),
      },
    },
    async ({ product_id }) => {
      const product = getStudyProduct(product_id);
      if (product === null) {
        return fail(`Study store product "${product_id}" not found.`, { product_id });
      }
      return ok(
        `${product.name} — ${formatPaise(product.price)} (${product.stock} in stock).`,
        { currency: "INR", unit: "paise", merchant: "study", product },
      );
    },
  );

  return server;
}
