# Setu — the scripted demo

The graded bar for Track 01 is *"every money action explainable, bounded and
gated; show the audit trail and one failure handled gracefully."* This is the
exact sequence that shows it. Nothing here is improvised — the product ids,
the refusing rule and the substitutes are all fixed by the seeded mandate and
the catalog, and `npm run test:recovery` runs this same sequence five times.

## The seeded mandate

Seeded in `server.js` at startup, deliberately not creatable by the agent:

| Term | Value |
| --- | --- |
| Per-transaction cap | ₹500.00 |
| Total budget | ₹2,000.00 |
| Allowed categories | cables, stationery, accessories |
| Expiry | 24h from server start |

## The two product ids

| Role | Product id | Price | Category | Outcome |
| --- | --- | --- | --- | --- |
| **Blocked** | `acc-mouse-wireless` | ₹749.00 | accessories | `per_txn_cap_exceeded` |
| **Substitute** | `acc-case-clear` | ₹399.00 | accessories | approved |

The mouse is the right thing to be refused: its category **is** on the
allowlist, so the refusal can only be about the ₹500 cap. A charger would also
be refused, but on category, which invites the objection "you just picked a
product the list forbids." This one isolates the cap as the binding rule.

`acc-case-clear` is not chosen by hand — it is the first entry in the
`alternatives` the refusal itself returns. Suggestions are ordered **closest
match first**: the refused product's own category ahead of everything else,
cheapest within each group. So a refused ₹749 accessory is answered with the
cheapest permitted accessory, not with the cheapest thing in the shop. The
second suggestion is `stn-notebook-a5` (₹120.00), the cheapest permitted
product overall.

That ordering matters on camera. Under pure cheapest-first the refusal answered
"you can't have a mouse" with "have a notebook", which reads as the gate not
understanding the request. When the refusal is about the *category* instead —
try `chg-usbc-65w` — nothing shares that category, and the list correctly falls
back to cheapest overall.

One thing to say out loud rather than let a judge catch: a phone case is not a
mouse. `acc-mouse-wireless` is the only mouse in the catalog, so no permitted
substitute is a true like-for-like. The mandate's job is to bound spending, not
to shop; the honest framing is "here is what your authority actually permits",
and raising the per-transaction cap is the real fix if the user genuinely needs
that mouse.

## The sequence

Ask the agent, in a Claude Code session with the `setu` MCP server registered:

> Buy me a wireless mouse for the campus desk setup (product id
> `acc-mouse-wireless`). If the mandate blocks it, buy the first alternative it
> suggests instead, then show me the audit trail.

Say "the first alternative", not "the cheapest". Verified live: asking for the
cheapest makes the agent re-rank the suggestions itself and buy the ₹120.00
notebook over the ₹399.00 phone case — correct obedience to the instruction,
but it throws away the closest-match ordering the server just did and makes the
demo contradict this document.

What happens, in order:

1. **`check_mandate` / `initiate_purchase` on `acc-mouse-wireless` → REFUSED.**
   `per_txn_cap_exceeded`. No Razorpay order is created — the gate runs before
   the payment rails are touched, so there is nothing to cancel.
2. **The refusal names substitutes.** Both the preview and the committing call
   return the same two, in the same order: `acc-case-clear` (₹399.00, the same
   category that was refused) and `stn-notebook-a5` (₹120.00). Every candidate
   has been put through the same `check()` that just refused, so a suggestion
   cannot itself be refused on the next call.
3. **Recovery is an ordinary second call.** `initiate_purchase` with
   `acc-case-clear`. There is no retry tool — a tool that re-attempts a
   purchase the gate refused is a tool for arguing with the gate.
4. **A real Razorpay test-mode order is created**, status `awaiting_payment`.
   The tool never claims the purchase completed; a human still has to pay.
5. **`get_audit_log` shows both halves**, and so does
   `http://localhost:3000/audit.html`.

## What to point at on screen

On the dashboard, the blocked row is the one that matters:

- **Amount ₹749.00**, **rule `per_txn_cap_exceeded`**, and the reason in plain
  words.
- **Order column reads "no order"** — Razorpay was never contacted.
- **The detail line reads `suggested_alternatives: acc-case-clear,
  stn-notebook-a5`** — the recovery is on the record, so the next row is not an
  unexplained purchase of something the user never asked for.

Then the row below it: ORDER CREATED, ₹399.00, `acc-case-clear`, with a real
order id.

## Before recording

```
rm audit-log.jsonl                     # start from a clean trail
node --env-file=.env server-http.js    # dashboard + payment rails on :3000
```

The MCP server is launched by Claude Code itself. Register it **before**
starting the session — a server registered mid-session is invisible to it.
