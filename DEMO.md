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
| **Substitute** | `acc-mouse-wired` | ₹449.00 | accessories | approved |

The mouse is the right thing to be refused: its category **is** on the
allowlist, so the refusal can only be about the ₹500 cap. A charger would also
be refused, but on category, which invites the objection "you just picked a
product the list forbids." This one isolates the cap as the binding rule.

`acc-mouse-wired` is not chosen by hand — it is the first entry in the
`alternatives` the refusal itself returns. Suggestions are ordered **closest
match first**: most tags shared with the refused product, then its category,
then cheapest. The wired mouse shares three tags with the wireless one (`mouse`,
`laptop`, `usb`); the phone case shares none.

**The ordering is the thing to point at on camera.** The list is deliberately
NOT in price order — ₹449.00 is offered *ahead of* the ₹399.00 phone case. That
inversion is visible proof the gate ranked by relevance rather than by price. A
refusal that answers "you can't have a mouse" with "have a notebook" is the gate
changing the subject; one that answers with a cheaper mouse is a recovered sale.

Two earlier orderings both failed here, and the failure is worth a sentence out
loud. Cheapest-first answered the mouse with a ₹120 notebook. Category-first was
still too coarse — "accessories" holds mice, cases, sleeves and stands — so it
answered with the cheapest accessory, a phone case. Only shared tags encode
"same kind of thing".

Say this out loud rather than let a judge catch it: **Setu is not a
recommendation engine.** It does not interpret shopping intent, and it is not
trying to. Ranking substitutes by relevance is a courtesy the refusal can afford
because every candidate has already been through the same `check()` that just
refused — the ranking decides only the *order* of an already-authorized list, never
what is permitted. The mandate's job is to bound spending; if the customer
genuinely needs the ₹749 mouse, the real fix is a higher cap, not a cleverer
suggestion. When the refusal is about the *category* instead — try
`chg-usbc-65w` — few candidates share tags, none share the category, both keys
flatten, and the list correctly falls back to cheapest overall.

## The sequence

Ask the agent, in a Claude Code session with the `setu` MCP server registered —
in natural language, without naming a product id. The agent is meant to find
the product itself via `search_catalog`; handing it the id would make this a
demo of the agent clicking a button, not of it acting on a request:

> I want to buy a wireless mouse for my desk setup. Check what my spending
> mandate allows first. If this one doesn't fit the limit, don't just give up —
> buy whatever it suggests as the closest match instead. Then show me the full
> audit trail of what you did.

A plain `search_catalog` query for "wireless mouse" returns exactly one
product — the wired mouse's tags say `wired`, not `wireless` — so this is as
deterministic in practice as naming the id outright (verified directly against
`searchCatalog()`).

Say "whatever it suggests as the closest match", not "the cheapest". Verified
live: asking for the cheapest makes the agent re-rank the suggestions itself
and buy the ₹120.00 notebook over the ₹449.00 wired mouse — correct obedience
to the instruction, but it throws away the closest-match ordering the server
just did and makes the demo contradict this document. It also throws away the
sale the merchant would otherwise have kept.

**This is a scripted demonstration of the mandate/audit mechanism, not a claim
that auto-substituting is correct behavior.** The instruction above tells the
agent to complete the substitute purchase on its own so the demo runs as one
continuous, unattended sequence — that is a demo simplification. In production,
when the exact requested item can't be authorized, the right move is to surface
the block — and any permitted alternatives — to the customer and let them
decide, not for the agent to silently complete a different purchase.

What happens, in order:

1. **`check_mandate` / `initiate_purchase` on `acc-mouse-wireless` → REFUSED.**
   `per_txn_cap_exceeded`. No Razorpay order is created — the gate runs before
   the payment rails are touched, so there is nothing to cancel.
2. **The refusal names substitutes.** Both the preview and the committing call
   return the same two, in the same order: `acc-mouse-wired` (₹449.00, a real
   like-for-like) and `acc-case-clear` (₹399.00). Note the list is not in price
   order — that is the relevance ranking showing. Every candidate
   has been put through the same `check()` that just refused, so a suggestion
   cannot itself be refused on the next call.
3. **Recovery is an ordinary second call.** `initiate_purchase` with
   `acc-mouse-wired`. There is no retry tool — a tool that re-attempts a
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
- **The detail line reads `suggested_alternatives: acc-mouse-wired,
  acc-case-clear`** — the recovery is on the record, so the next row is not an
  unexplained purchase of something the user never asked for.
- **The tile reading "₹749.00 blocked by the mandate"** — spend that never
  reached Razorpay, summed from these same rows.

Then the row below it: ORDER CREATED, ₹449.00, `acc-mouse-wired`, with a real
order id. The customer asked for a mouse and got a mouse.

## Before recording

```
rm audit-log.jsonl                     # start from a clean trail
node --env-file=.env server-http.js    # dashboard + payment rails on :3000
```

The MCP server is launched by Claude Code itself, and its tool definitions are
snapshotted at session start — a session left open since before the last
`server.js` edit will keep serving the old tool logic even though the server on
disk is current. So: confirm `setu` is registered (`claude mcp list` should
report `Connected`), then **start a fresh Claude Code session immediately
before recording**. Registering mid-session does not substitute for this — a
server registered mid-session is invisible to that session; it only takes
effect in the next one.
