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

## Scope decisions (deliberate omissions, not oversights)

- **Stock is seeded but never decremented on purchase.** Inventory management is
  orthogonal to the trust primitive this project is demonstrating, so `stock` is
  presented to the agent as catalog metadata only. A purchase does not mutate it.
