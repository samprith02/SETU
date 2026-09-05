# Setu — 5-minute submission video

Everything below is verified against the running system. Nothing here is a
claim the code doesn't back.

**Total: 5:00.** Narration is ~620 words, which is a calm ~135 wpm with room for
the pauses where you stop talking and let the screen do the work. Do not rush
the two silences marked **[BEAT]** — they are where a judge actually reads the
screen.

---

## Before you hit record

Run these in order. All four, every time.

```bash
rm audit-log.jsonl                      # a clean trail; the video shows it filling up
node --env-file=.env server-http.js     # dashboard + payment rails on :3000
npm test                                # confirm green before you trust the demo
claude mcp list                         # must say: setu — Connected
```

Then **quit Claude Code and start a fresh session.** MCP tool definitions are
snapshotted at session start, so a session older than your last `server.js` edit
serves stale tool logic. This has bitten this repo before.

Open `http://localhost:3000/audit.html` and confirm it reads **"No entries yet."**
That empty state is your opening shot.

**Have ready to paste** (Razorpay test card):
`4111 1111 1111 1111`, any future expiry, any CVV.

### Screen layout — do this, it matters more than anything else here

**One window, split 50/50: Claude Code terminal on the LEFT, browser on
`audit.html` on the RIGHT.** Do not tab between them.

The dashboard auto-refreshes every 3 seconds. With a split screen, every row
appears on the right *at the moment* the agent acts on the left — the audit
trail writes itself on camera. Tab-switching throws that away and turns your
strongest visual into a static screenshot.

Terminal font at 16pt+. Browser zoom ~110%. Record at 1080p.

---

## [0:00 – 0:35] Cold open — the problem

**On screen:** Browser only, full screen, `audit.html` with the empty ledger.

**Do:** Nothing. Just talk over the empty dashboard.

> "This is a merchant's storefront. Every purchase you're about to see is made
> by an AI agent — not a person clicking *buy*, an agent, spending someone
> else's money.
>
> That's what Razorpay's Track 01 is pointed at. Agents are about to become
> buyers. But a merchant accepting one can't answer the only question that
> matters: *is this agent actually allowed to spend this?*
>
> So merchants get two bad options. Block AI buyers, and lose the channel. Or
> accept them blind, and eat whatever goes wrong.
>
> Setu is the third option."

---

## [0:35 – 1:05] What it is

**On screen:** Switch to the split layout now. Left: terminal showing
`claude mcp list` with **setu — Connected**.

**Do:** Let `claude mcp list` output sit on screen while you talk.

> "Setu is a gateway that runs at the merchant's end, between an AI buyer and
> Razorpay. It's an MCP server — so the agent, which here is Claude Code
> itself, talks to the shop through five tools.
>
> It can search the catalog. Check whether a purchase is allowed. Buy. And read
> the audit log.
>
> What it *cannot* do is create its own spending authority. There is no
> `create_mandate` tool. An agent that can mint its own limit doesn't have one."

---

## [1:05 – 1:30] The mandate

**On screen:** Left pane. Show the mandate terms — easiest is the DEMO.md table,
or scroll the `server-http.js` startup log.

> "The authority comes from the customer, and it's called a mandate. This one:
> five hundred rupees per transaction, two thousand total, three allowed
> categories, expires in twenty-four hours.
>
> Every one of those is checked *before* Razorpay is ever contacted. Watch."

---

## [1:30 – 2:00] The ask, and the refusal

**Do:** Paste this into Claude Code and hit enter:

> Buy me a wireless mouse for the campus desk setup (product id
> `acc-mouse-wireless`). If the mandate blocks it, buy the first alternative it
> suggests instead, then show me the audit trail.

⚠️ Say **"the first alternative"**, never "the cheapest" — verified live, asking
for the cheapest makes the agent re-rank the list itself and buy a ₹120 notebook,
which throws away the ordering the server just did.

**Say while it runs:**

> "I'm asking for a wireless mouse. Seven hundred forty-nine rupees — over the
> five-hundred cap."

**[BEAT]** — when `REFUSED` appears, **stop talking for two seconds.** Let them read it.

> "Refused. And look at what the refusal actually says.
>
> The rule that fired, by name — `per_txn_cap_exceeded`. The amount, the cap, in
> plain English. And over on the right, in the audit trail: **no order**.
> Razorpay was never contacted. There's nothing to refund and nothing to cancel,
> because the payment rails were never touched.
>
> That's *bounded and gated*."

**Point at:** the `no order` cell in the right pane. This is the single most
important cell in the video.

---

## [2:00 – 2:35] The part that makes it Track 01

**On screen:** Left pane, the alternatives list in the refusal.

> "But here's the part I care about most. The refusal doesn't just say no — it
> names what the mandate *would* allow. And the first suggestion is a four
> hundred forty-nine rupee wired mouse.
>
> Notice the order. Four-forty-nine is listed *above* three-ninety-nine. That
> list is not sorted by price — it's sorted by how close each substitute is to
> what was actually asked for, by shared tags with the refused product.
>
> An earlier version ranked by price, and it answered *'you can't have a mouse'*
> with *'have a notebook.'* That isn't a gate helping. That's a gate changing
> the subject."

**Point at:** the ₹449 line sitting above the ₹399 line. The price inversion is
visible proof of relevance ranking — it is the most persuasive two seconds you have.

---

## [2:35 – 3:05] Recovery — the revenue beat

**On screen:** Left pane as the agent makes its second call; ORDER CREATED
appears on the right.

> "So the agent buys the mouse it *can* buy. Same tool, second call — there is
> deliberately no retry tool, because a tool that re-attempts a purchase the
> gate already refused is a tool for arguing with the gate.
>
> And this is why it's Track 01 and not just a safety feature. A naive gate
> loses that sale. This one keeps it. The customer asked for a mouse and got a
> mouse — and the merchant kept the revenue.
>
> Bounded spending and merchant revenue aren't a trade-off here. They're the
> same feature."

---

## [3:05 – 3:45] Real money on real rails

**Do:** In the right pane, click **`pay this order →`** on the ORDER CREATED row.
Pay with the test card. Return to the dashboard.

> "The agent created a real Razorpay order — but notice it never claimed the
> purchase completed. A human still has to pay. I'll do that now, on Razorpay
> test-mode rails."

**[BEAT]** — pay in silence. Let the Razorpay checkout be on screen. It's proof.

> "And Setu doesn't take the callback's word for it. It recomputes the HMAC
> signature — and then asks Razorpay directly whether the payment status is
> *captured*, because an authorized-but-uncaptured payment carries a perfectly
> valid signature. Only a captured payment counts against the budget."

---

## [3:45 – 4:30] The audit trail

**On screen:** Browser full screen on `audit.html`. Scroll slowly, top to bottom.

> "And here's the whole story, in the order it happened. The check. The block.
> The order. The capture.
>
> Seven hundred forty-nine rupees blocked — spend that never reached Razorpay.
> Every rule that fired, and how many times.
>
> Every row carries the verdict *as it applied at the time* — not recomputed on
> read. Re-running today's rules over yesterday's decisions would launder
> exactly the discrepancy an audit exists to catch.
>
> And the money on this page is summed from this ledger, not from a counter
> kept somewhere else. The record and the balance can't drift apart."

**Point at, in order:** the ₹749 blocked tile → the `rules fired` chips → the red
left rail on the blocked row → the green rail on the captured row.

---

## [4:30 – 5:00] Close

**On screen:** Stay on the audit trail.

> "Every money action explainable, bounded, and gated. The audit trail — and a
> failure handled gracefully, recovered into a completed sale.
>
> *Setu* means bridge. That's the whole idea: what makes a merchant safely
> transactable by an AI buyer isn't a smarter agent. It's a gate the merchant
> controls, and a record they can show afterwards.
>
> Thanks for watching."

---

## If you have 10 seconds spare, add this

Slot it right after the recovery beat at 3:05. It buys real credibility with
technical judges, and it's already the repo's own stated position:

> "To be straight with you — in production you'd surface the block to the
> customer and let *them* choose the substitute. The agent completing it
> unattended is a demo simplification, so this runs as one continuous sequence."

---

## If something breaks on camera

| What happens | What to do |
| --- | --- |
| Checkout link 404s / won't connect | `server-http.js` isn't running. It's a separate process from the MCP server and does not start itself. Check `netstat -ano \| grep :3000 \| grep LISTENING`. |
| Agent buys the ₹120 notebook | You said "cheapest" instead of "the first alternative". Re-record the prompt. |
| Agent invents its own reasoning instead of calling tools | Stale session — MCP tools were snapshotted before your last edit. Restart Claude Code. |
| Dashboard shows old rows | You forgot `rm audit-log.jsonl`. Delete and re-run. |

**Safest recovery of all:** `npm run test:recovery` runs this exact sequence five
times in a row, unattended, and prints each step. If the live agent misbehaves
twice, record that instead and narrate over it — same story, zero improvisation.

---

## What each section is scoring against

| Track 01 requirement | Where the video earns it |
| --- | --- |
| "Makes a merchant transactable by an AI buyer **end to end**" | 1:30 → 3:45, ask through captured payment |
| "**Agent-readable catalog**" (named example direction) | 0:35, the five MCP tools |
| "**Grow the merchant's revenue**" (the track headline) | 2:35, refusal recovered into a completed sale |
| "Every money action **explainable**" | 1:30, the named rule and plain-English reason |
| "**Bounded and gated**" | 1:30, `no order` — the gate runs before the rails |
| "**Show the audit trail**" | 3:45 |
| "**One failure handled gracefully**" | 2:00 → 3:05, refused then recovered |
