# Build Challenges & Technical Obstacles

A running log kept during the build, written as things happened rather than
reconstructed afterwards. Newest entries at the bottom.

---

## 1. Proving `.gitignore` actually caught `.env` — before trusting it with a live key

**Day 1, 2026-09-01**

### The situation

Setu talks to Razorpay's Orders API, so it needs real test-mode credentials
(`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) in a local `.env`. The repo is public
by submission day. That combination is the one mistake in this build that cannot
be walked back.

### Why this is not a "just add it to .gitignore" problem

A committed secret is not undone by deleting the file. The value stays in the
commit history, reachable by hash, and it stays there through every clone and
fork already taken. Making a repo private afterwards does not retract copies.
The only genuine remedies are both worse than prevention:

1. **Rotate the key at Razorpay** — the leaked value must be assumed burned,
   whatever the history says.
2. **Rewrite history** (`git filter-repo` / BFG, then a force push) — which
   invalidates every existing clone and, mid-hackathon, risks the repo itself.

So the guard had to be verified *before* the first real value went into the file,
not after.

### The subtlety that made verification non-trivial

`git status` reporting a clean tree is **not** proof that ignoring works. A file
is absent from `git status` for two very different reasons — because it is
correctly ignored, or because it does not exist at all. A verification that
cannot tell those apart proves nothing. It also cannot distinguish an exact-match
rule from an incidental one: `.env` might be swept up by some broad wildcard that
stops matching the moment the file is renamed.

### What was actually checked

Six checks, none of which read the file's contents:

| Check | Result |
|---|---|
| `git status` (full, unfiltered) | `nothing to commit, working tree clean` |
| File exists on disk? | yes, 86 bytes — so "clean" isn't a false pass |
| `git ls-files --error-unmatch .env` | not tracked |
| Staged file list | not staged |
| `git check-ignore -v .env` | `.gitignore:2:.env` |
| `git status --porcelain --ignored` | `!! .env` |

The decisive one is `git check-ignore -v`, which names the exact rule doing the
work: line 2 of `.gitignore`, a literal `.env` pattern — not a wildcard that
could quietly stop applying later.

### Related finding

While auditing `.gitignore`, the existing `*.local` rule turned out **not** to
cover `.claude/settings.local.json` — that filename ends in `.json`, so the
wildcard never matched it. An explicit rule was added. A reminder that a
plausible-looking ignore pattern is not evidence of an ignored file.

### How this shaped the code

With the guard verified, credentials are loaded through Node's built-in
`--env-file` flag rather than a `dotenv` dependency:

```
node --env-file=.env server.js
```

No secret is ever hardcoded, printed, or logged. `server.js` checks only for the
*presence* of the two variables at startup and warns to stderr if they are
missing — never their values. The MCP registration carries the same flag, so the
server started by Claude Code loads credentials the same way.

One sharp edge found while testing this: `--env-file` **hard-crashes** if the
file is absent (`node.exe: .env: not found`), which would break anyone cloning
the repo without a `.env`. `--env-file-if-exists` is the forgiving variant if
that becomes a problem for reproducing the demo.

---

## 2. Signature verification proves authenticity, not capture

**Day 1, 2026-09-01**

Recomputing the HMAC on a checkout callback proves the message genuinely came
from Razorpay and was not altered in transit. It proves nothing about whether
the payment actually succeeded: a correctly signed callback for a pending,
failed, or authorised-but-uncaptured payment verifies exactly as cleanly as one
for a captured payment. Authenticity and outcome are separate questions, and
only the first is answered by the signature.

Closed on Day 2 inside `initiate_purchase`, which fetches the payment with
`razorpay.payments.fetch(paymentId)` and treats the purchase as real only when
`status === "captured"`.

---

## 3. A test suite that assumed a clean slate, and would have gone red on camera

**Day 2, 2026-09-02**

### The situation

Day 2 morning made the audit ledger file-backed — `audit-log.jsonl`, append-only,
written by both the MCP server and the HTTP server. That was necessary: an order
is created in one process and captured in the other, so an in-memory array would
have left each blind to the other.

`test-mcp.js` was written the same morning, against a ledger that happened to be
empty, and quietly encoded that accident as an assumption in two places:

```js
const orderEntry = log.entries.find((e) => e.status === "order_created");
expect("an unpaid order has spent nothing", afterOrder.mandate.spent, 0);
expect("full budget still available", afterOrder.mandate.remaining, 200000);
```

Both passed. They kept passing for a day.

### How it surfaced

Two manual purchases in the afternoon, made to populate the audit dashboard, and
`find` started returning the *first* `order_created` entry in the whole ledger —
a previous run's order — instead of the one the test had just created. Loud,
immediate, and harmless.

### Why the other one mattered much more

The hardcoded `spent: 0` / `remaining: 200000` failed differently: **it couldn't
fail yet.**

`spent` is derived from `PAYMENT_CAPTURED` entries, and nothing had ever been
captured — capture needs a human completing Razorpay's hosted checkout. So those
two assertions were guaranteed green on every run right up until the first real
payment settled. The first real payment is the demo.

That is the shape worth naming: an assertion that encodes today's state as a
literal is a delayed failure, and the fuse burns until the system finally does
the thing it was built to do. This one was set to go off mid-recording, on the
one run where the money path was working, with the least time available to
diagnose it — and it would have looked like the capture logic was broken rather
than the test.

The trade is also worth naming. The file-backed ledger bought cross-process
visibility and paid for it in test isolation. Shared durable state between
processes is exactly what made `get_audit_log` truthful about payments settled
elsewhere, and exactly what stopped every test run from starting from zero.

### How it was fixed

The budget assertions were never really about ₹0 — they were about *an unpaid
order changing nothing*. So they now read the ledger's state at the start of the
run and assert against that:

```js
const baseline = parse(await call("get_audit_log", { limit: 1 })).mandate;
...
expect("creating an order spent nothing new", afterOrder.mandate.spent, baseline.spent);
expect("budget is unchanged by an unpaid order", afterOrder.mandate.remaining, baseline.remaining);
```

The literal `0` was a fact about the environment; `baseline.spent` is the
property actually being tested, and it holds whether the ledger is empty or
carries a dozen settled payments.

Alongside it: `find` became `findLast`, since this run's entries are the ones
appended last, and the "nothing captured yet" check was scoped to this run's
order id rather than asking whether the entire ledger contains a capture.

### Proving the fix could still fail

Per the repo's testing discipline, a rewritten assertion is only worth having if
it can still go red. `totalCaptured()` was deliberately broken to count
`ORDER_CREATED` alongside `PAYMENT_CAPTURED` — i.e. to charge the budget at
intent instead of at capture, the exact rule these assertions guard. Both went
red, the suite exited non-zero, and the change was reverted and re-verified
green.

---

## 4. Two bugs a green test suite could not see

**Day 2, 2026-09-02**

### The situation

The evening's job was the graded failure scenario: a purchase the mandate
refuses, handled gracefully enough that the agent recovers. It shipped with
`test-recovery.js`, which drives the real MCP server over a real stdio
transport and runs the whole sequence — blocked attempt, suggestions offered,
substitute bought, both halves on the record — five times to a pass.

It went 5 of 5, zero failures. The suite was also proved capable of failing:
stubbing `suggestAlternatives()` to return `[]` turned all five runs red.

Then the same scenario was put in front of real Claude Code sessions. The first
one surfaced a defect inside a single run — enough to abandon that batch, fix
it, and start over; the completed batch of five surfaced a second, plus a
design complaint the agent volunteered on its own.

None of the three is a logic error. None was reachable by the harness.

### Discovery 1 — the agent asked a different question than the test did

The spec was to put substitutes on `initiate_purchase`'s refusal, and that is
what was built and tested. The harness called `initiate_purchase`, got a
refusal naming two permitted products, bought one, passed.

The first live agent never called `initiate_purchase` on the blocked product at
all. It called `check_mandate` first — the preview tool, which answers "would
this be allowed?" without buying — got back a bare `per_txn_cap_exceeded` with
no alternatives, and went off calling `search_catalog` three times trying to
find a substitute by hand. In that run it never completed a purchase.

The behaviour is correct on the agent's part, and obvious in hindsight: a
careful agent checks before it commits. The refusal it actually receives comes
from the preview, so the preview is where a refusal has to be useful. Testing
`initiate_purchase` exhaustively proved the feature worked on the path the spec
described and said nothing about the path agents take.

Fixed by giving `check_mandate`'s refusal the same substitutes from the same
helper, and by adding a step to the harness that asserts the preview refuses
*and* names the identical set the committing call names — so the two can never
drift into telling an agent two different stories. That first live batch was
killed rather than spending five runs measuring a build already known to be
incomplete.

### Discovery 2 — a correct answer that could not be delivered

`get_audit_log` with no arguments returned the whole ledger, pretty-printed.
Correct, complete, and by that point in the day about a hundred entries. Every
live agent that called it got this instead:

```
Error: result (79,426 characters across 1,894 lines) exceeds maximum allowed
tokens. Output has been saved to ...
```

The client rejected the response before the model ever saw it. Four of the four
runs that reached that call hit it, every time.

**Why the harness could not catch this is the whole point.** `test-recovery.js`
makes the identical call, `get_audit_log({})`, against the identical ledger —
and passes. The MCP protocol imposes no size limit and the SDK client has no
context window, so the harness receives all 79,426 characters and parses them
happily. The limit is enforced by the agent's client, not by the server, the
protocol, or the test. A response can be valid on the wire, correct in content,
and still be undeliverable to the only consumer that matters.

That failure mode is invisible to any test whose client is a program. It is
also the worst one to find late: "read the audit trail" is the first thing
anyone asks this server to do, and a trail nobody can open explains nothing —
which is precisely the bar the project is graded against.

Fixed by returning the 25 most recent entries by default and reporting
`total_entries` / `showing` / `omitted`, so the window is stated rather than
silently applied. 79,426 characters became 20,166. An explicit `limit` or
`order_id` still reaches the rest, and a single order's history is never
truncated. `GET /audit` was deliberately left uncapped — no such limit applies
to HTTP, and the dashboard wants the whole trail.

### A third one, smaller: the agent as design critic

Unprompted, at the end of a run that completed successfully, one agent wrote:

> You asked for a mouse and the fallback bought stationery. That's what your
> instruction specified, and I followed it, but the two alternatives the mandate
> offered were a notebook and a pen pack — neither substitutes for a mouse on a
> desk setup. If the intent was "get me a working mouse," the real fix is
> raising the per-transaction cap above ₹749, not this order.

Nothing was broken. Every test passed, and the suggestions were exactly what the
rule specified: cheapest-first among permitted products. But the two cheapest
permitted products in this catalog are stationery, so *every* refusal suggested
the same two things no matter what was asked for, and the gate read as though it
had not understood the request. That prompted the ordering change to
same-category-first, cheapest within it. An assertion can check that a rule was
implemented; it cannot notice that the rule reads badly to the person on the
other end.

### What it cost, and why it was worth it

Five live sessions took a minute to a minute and a half each and about $4 in
total, against a deterministic suite that runs for free. The right split is not
one or the other:

- The **harness** owns everything about correctness that must hold on every run
  and be provable on demand: the gate refusing before Razorpay is contacted,
  suggestions that the same `check()` would approve, spend counted only at
  capture, both refusal paths agreeing. It is fast, free, and it can be broken
  on purpose to prove it still bites.
- The **live agent** owns everything about the interface being *usable*: which
  tool a real client reaches for first, whether the answer fits through the
  pipe, whether a technically correct response reads as sensible.

Worth stating plainly, because it is the honest version: **the harness found
none of the evening's three defects.** All three came from live sessions, and
one of them came from the agent simply saying so out loud. That is not an
argument against the harness — it is what the harness is for that it stayed
green, since every one of those fixes had to land without breaking the gate, and
the suite is what made that provable rather than hoped-for. It is an argument
that a green suite is evidence about the server, not evidence about the
experience of using it.

Both bugs above lived in the gap between "the server is correct" and "an agent
can use it." That gap has two sides, and only one of them can be tested by a
program.

### Smaller confirmations from the same runs

Two things went wrong in live runs and were supposed to:

- An agent called `initiate_purchase` with `product_id` but no `intent`. The
  schema rejected it (`expected string, received undefined at intent`) and the
  agent retried with one. A purchase that records no reason is refused — which
  is the audit trail's whole premise, holding under a real caller.
- Another sent `productId` instead of `product_id` and corrected itself the same
  way.

---

## Scope decisions (deliberate omissions, not oversights)

- **Stock is seeded but never decremented on purchase.** Inventory management is
  orthogonal to the trust primitive this project is demonstrating, so `stock` is
  presented to the agent as catalog metadata only. A purchase does not mutate it.
