// Setu — mandate engine tests
//
// Run with:  node test-mandate.js
// Exits non-zero if any rule misbehaves, so a broken mandate engine fails
// loudly instead of quietly printing plausible-looking output.
//
// Doubles as documentation: the printed narrative is the same walkthrough used
// to explain why both spend limits exist.

import assert from "node:assert/strict";
import {
  createMandate,
  getActiveMandate,
  check,
  recordSpend,
  remainingBudget,
  formatPaise,
} from "./mandate.js";
import { getProduct } from "./catalog.js";

let passed = 0;
let failed = 0;

const heading = (t) =>
  console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  PASS  ${label}`);
    passed++;
  } catch {
    console.log(`  FAIL  ${label}`);
    console.log(`          expected: ${expected}`);
    console.log(`          actual:   ${actual}`);
    failed++;
  }
}

const showVerdict = (v) => {
  console.log(`  approved : ${v.approved}`);
  console.log(`  code     : ${v.code}`);
  console.log(`  reason   : ${v.reason}`);
  if (v.remaining !== undefined) console.log(`  remaining: ${formatPaise(v.remaining)}`);
};

// A mandate an agent might realistically be handed: Rs 2,000 total budget,
// Rs 500 ceiling on any one purchase, three allowed categories, expiring in an
// hour.
const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const mandate = createMandate({
  max_amount: 200000,
  per_txn_cap: 50000,
  category_allowlist: ["cables", "stationery", "accessories"],
  expiry: inOneHour,
});

heading("THE MANDATE");
console.log(`  id                : ${mandate.id}`);
console.log(`  max_amount        : ${formatPaise(mandate.max_amount)}  (total budget)`);
console.log(`  per_txn_cap       : ${formatPaise(mandate.per_txn_cap)}  (any one purchase)`);
console.log(`  category_allowlist: ${mandate.category_allowlist.join(", ")}`);
console.log(`  expiry            : ${mandate.expiry}`);
console.log(`  spent             : ${formatPaise(mandate.spent)}`);
console.log();
expect("getActiveMandate() returns the mandate just created", getActiveMandate().id, mandate.id);
expect("a new mandate starts with zero spent", mandate.spent, 0);
expect("remainingBudget equals max_amount initially", remainingBudget(mandate), 200000);

// ---------------------------------------------------------------------------
// 1. APPROVED — inside both money limits, in an allowed category
// ---------------------------------------------------------------------------
const cable = getProduct("cbl-usbc-1m"); // Rs 299, cables
heading(`1. APPROVED — ${cable.name}, ${formatPaise(cable.price)}, "${cable.category}"`);
const v1 = check(mandate, cable.price, cable.category);
showVerdict(v1);
console.log();
expect("approved", v1.approved, true);
expect("code is approved", v1.code, "approved");
expect("checking does not spend budget", mandate.spent, 0);

// ---------------------------------------------------------------------------
// 2. BLOCKED by per_txn_cap
// Chosen so no other rule can fire: the category IS allowed and the amount
// DOES fit the total budget, so only the per-transaction cap can block it.
// ---------------------------------------------------------------------------
const stand = getProduct("acc-laptop-stand"); // Rs 1,099, accessories
heading(`2. BLOCKED (per_txn_cap) — ${stand.name}, ${formatPaise(stand.price)}, "${stand.category}"`);
console.log(`  isolating the rule: category "${stand.category}" is allowed, and`);
console.log(`  ${formatPaise(stand.price)} fits inside the ${formatPaise(mandate.max_amount)} budget —`);
console.log(`  so the per-transaction cap is the only rule that can block this.`);
console.log();
expect("category is in the allowlist", mandate.category_allowlist.includes(stand.category), true);
expect("amount fits the total budget", stand.price <= remainingBudget(mandate), true);
const v2 = check(mandate, stand.price, stand.category);
showVerdict(v2);
console.log();
expect("blocked", v2.approved, false);
expect("code is per_txn_cap_exceeded", v2.code, "per_txn_cap_exceeded");

// ---------------------------------------------------------------------------
// 3. BLOCKED by category allowlist
// Rules are evaluated category-before-amount, so this reports the category even
// though the price would also breach the cap.
// ---------------------------------------------------------------------------
const earphones = getProduct("aud-earphones-wired"); // Rs 599, audio
heading(`3. BLOCKED (category) — ${earphones.name}, ${formatPaise(earphones.price)}, "${earphones.category}"`);
console.log(`  ${formatPaise(earphones.price)} would ALSO breach the ${formatPaise(mandate.per_txn_cap)} cap,`);
console.log(`  but category is checked first, so that is the reason recorded.`);
console.log();
const v3 = check(mandate, earphones.price, earphones.category);
showVerdict(v3);
console.log();
expect("blocked", v3.approved, false);
expect("code is category_not_allowed", v3.code, "category_not_allowed");
expect("category reported ahead of the cap breach", v3.code === "per_txn_cap_exceeded", false);

// ---------------------------------------------------------------------------
// 4. BLOCKED by expiry
// Checked at a fixed future instant rather than by waiting, so the test is
// deterministic and instant.
// ---------------------------------------------------------------------------
const shortLived = createMandate({
  max_amount: 200000,
  per_txn_cap: 50000,
  category_allowlist: ["cables", "stationery", "accessories"],
  expiry: new Date(Date.now() + 1000).toISOString(),
});
const anHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
heading("4. BLOCKED (expired) — the same cheap cable, checked after expiry");
console.log(`  mandate expiry: ${shortLived.expiry}`);
console.log(`  checked at    : ${anHourFromNow.toISOString()}`);
console.log();
const v4 = check(shortLived, cable.price, cable.category, anHourFromNow);
showVerdict(v4);
console.log();
expect("blocked", v4.approved, false);
expect("code is mandate_expired", v4.code, "mandate_expired");
expect(
  "the same purchase is approved before expiry",
  check(shortLived, cable.price, cable.category).approved,
  true,
);

// ---------------------------------------------------------------------------
// 5. Why per_txn_cap alone is not enough
// Every purchase below obeys the per-transaction cap. Only the total budget
// stops the run.
// ---------------------------------------------------------------------------
heading("5. max_amount — the limit a per-transaction cap cannot enforce");
const budget = createMandate({
  max_amount: 100000, // Rs 1,000 total
  per_txn_cap: 50000, // Rs 500 each
  category_allowlist: ["cables"],
  expiry: inOneHour,
});
console.log(`  budget ${formatPaise(budget.max_amount)}, cap ${formatPaise(budget.per_txn_cap)} —`);
console.log(`  buying the ${formatPaise(cable.price)} cable repeatedly:`);
console.log();

const outcomes = [];
for (let i = 1; i <= 4; i++) {
  const v = check(budget, cable.price, "cables");
  outcomes.push(v.code);
  console.log(
    `   purchase ${i}: ${v.approved ? "APPROVED" : "BLOCKED "} | ` +
      `spent ${formatPaise(budget.spent).padStart(10)} | ` +
      `remaining ${formatPaise(v.remaining).padStart(10)} | ${v.code}`,
  );
  if (v.approved) recordSpend(budget, cable.price);
}
console.log();
console.log(`  Every purchase above was under the ${formatPaise(budget.per_txn_cap)} per-transaction cap.`);
console.log(`  Only max_amount stopped the fourth.`);
console.log();
expect("first three approved", outcomes.slice(0, 3).join(","), "approved,approved,approved");
expect("fourth blocked by the budget", outcomes[3], "max_amount_exceeded");
expect("spent is the sum of the three approved purchases", budget.spent, 3 * cable.price);
expect("each purchase was under the per-transaction cap", cable.price <= budget.per_txn_cap, true);

// ---------------------------------------------------------------------------
heading("SUMMARY");
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log();
  console.log("  MANDATE ENGINE IS BROKEN — see failures above.");
  process.exit(1);
}
console.log();
console.log("  All mandate rules behaved as specified.");
