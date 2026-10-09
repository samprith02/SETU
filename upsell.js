// Setu — upsell engine
//
// Pure logic. No HTTP, no MCP — same shape as catalog.js, mandate.js and
// audit.js so both the Express route and the MCP tool import the same
// function and cannot drift.
//
// What this is NOT: a recommendation engine. Upsell suggestions are computed
// AFTER a purchase completes; they are a courtesy shown to the human (not acted
// on by the agent silently). The agent's authority covers only what the mandate
// allows; the suggestions here are unordered, unscored hints — the human or the
// agent calling `get_upsell` explicitly decides whether to act on them.
//
// Rule design:
//   - Complementarity is encoded as directed pairs: productA → [candidateTags].
//     A product whose tags overlap with any candidate set in the map is
//     suggested. One level of indirection means the rule is about the
//     RELATIONSHIP ("a charger pairs with cables") not a hardcoded id list
//     that breaks whenever the catalog is seeded differently.
//   - Maximum 3 suggestions per call, cheapest first so a suggestion within
//     the mandate's remaining budget appears before one that isn't.
//   - The calling tool/route handles the "in-mandate" filter if it wants one;
//     this module is agnostic to the mandate.

import { getProduct, getCatalog } from "./catalog.js";

// Directed complementarity rules.
// Keys are tags of the PURCHASED product; values are arrays of tags that
// make a SUGGESTED product complementary to it.
//
// Rationale for each pair:
//   mouse      → [mousepad, cable] — a mouse needs a surface and often a hub
//   laptop     → [stand, sleeve, cable, hub] — desk-setup accessories
//   charger    → [cable] — a charger is only useful with the right cable
//   cable      → [charger, adapter] — a cable pairs with a power source or adapter
//   earphones  → [cable] — replacement / extension cable
//   storage    → [cable] — a pen drive benefits from a USB-C adapter
//   notebook   → [pen] — stationery pairs naturally
//   pen        → [notebook] — stationery pairs naturally
//   stand      → [cable, mouse] — a laptop on a stand needs peripherals
const COMPLEMENT_RULES = [
  { purchaseTags: ["mouse"],      suggestTags: ["stand", "cable", "sleeve"] },
  { purchaseTags: ["stand"],      suggestTags: ["mouse", "cable", "adapter"] },
  { purchaseTags: ["laptop"],     suggestTags: ["stand", "sleeve", "cable", "adapter"] },
  { purchaseTags: ["charger"],    suggestTags: ["cable"] },
  { purchaseTags: ["cable"],      suggestTags: ["charger", "adapter"] },
  { purchaseTags: ["usb-c"],      suggestTags: ["cable", "adapter", "charger"] },
  { purchaseTags: ["earphones"],  suggestTags: ["cable"] },
  { purchaseTags: ["storage"],    suggestTags: ["cable", "adapter"] },
  { purchaseTags: ["pendrive"],   suggestTags: ["cable", "adapter"] },
  { purchaseTags: ["notebook"],   suggestTags: ["pen", "gel"] },
  { purchaseTags: ["pen"],        suggestTags: ["notebook", "ruled"] },
  { purchaseTags: ["case"],       suggestTags: ["cable", "charger"] },
  { purchaseTags: ["sleeve"],     suggestTags: ["stand", "cable", "mouse"] },
  { purchaseTags: ["power-bank"], suggestTags: ["cable"] },
];

const MAX_SUGGESTIONS = 3;

/**
 * Return up to MAX_SUGGESTIONS catalog products that complement the given
 * purchased product. The purchased product itself is excluded. Results are
 * sorted cheapest-first so the most budget-friendly option appears first.
 *
 * Returns { purchased, suggestions, currency, unit } where:
 *   purchased   — the product that was just bought (or null if id not found)
 *   suggestions — array of complementary products, cheapest first
 *   currency / unit — same self-describing envelope as the rest of the catalog
 */
export function getUpsell(productId) {
  const purchased = getProduct(productId);
  if (purchased === null) {
    return { purchased: null, suggestions: [], currency: "INR", unit: "paise" };
  }

  const purchasedTagSet = new Set(purchased.tags.map((t) => t.toLowerCase()));

  // Collect the suggest-tag sets for every rule that matches the purchased product.
  const wantedTags = new Set();
  for (const rule of COMPLEMENT_RULES) {
    if (rule.purchaseTags.some((t) => purchasedTagSet.has(t.toLowerCase()))) {
      for (const t of rule.suggestTags) wantedTags.add(t.toLowerCase());
    }
  }

  if (wantedTags.size === 0) {
    return { purchased, suggestions: [], currency: "INR", unit: "paise" };
  }

  const { products } = getCatalog();

  const candidates = products
    .filter((p) => {
      if (p.id === purchased.id) return false; // exclude the purchased item itself
      const tagSet = new Set(p.tags.map((t) => t.toLowerCase()));
      return [...wantedTags].some((t) => tagSet.has(t));
    })
    .sort((a, b) => a.price - b.price) // cheapest first
    .slice(0, MAX_SUGGESTIONS);

  return { purchased, suggestions: candidates, currency: "INR", unit: "paise" };
}
