## Git rules
Never add a "Co-Authored-By: Claude" line, a "🤖 Generated with Claude Code" line, 
or any Claude/Anthropic attribution to commit messages or PR descriptions. Commits 
should look like they came from me alone.

## What this is
Setu — an agent commerce gateway for Razorpay AI Buildathon 2026, Track 01
(AI Growth & Agentic Commerce). Solo 3-day build, submission due 2026-09-05.
An AI agent (Claude Code itself, over MCP) reads a merchant catalog, gets a spend
**mandate** checked, and completes a real purchase on Razorpay test-mode rails,
with every decision landing in an audit trail.

The track's bar, which every design decision serves: *every money action
explainable, bounded and gated; show the audit trail and one failure handled
gracefully.*

## Run
```
node --env-file=.env server.js        # MCP server (stdio) — registered as `setu`
node --env-file=.env server-http.js   # HTTP API on :3000
npm test                              # mandate engine assertions
```
Razorpay test-mode keys live in `.env` (gitignored, never commit, never log the
values). Node's built-in `--env-file` does the loading — no `dotenv`. It
hard-crashes if `.env` is missing; `--env-file-if-exists` is the forgiving variant.

## Architecture invariants — do not break these
- **Money is always an integer count of paise.** Never decimal rupees. Float error
  can flip a mandate cap comparison, which is the one decision this project is
  graded on. Format to rupees only for display (`formatPaise`).
- **`catalog.js`, `payments.js`, `mandate.js` are pure logic** — no HTTP, no MCP,
  no Express imports. Both the HTTP layer and the MCP tool layer import the same
  functions so they cannot drift. Keep new business logic in this shape.
- **`server.js` stdout is the JSON-RPC channel.** Any non-protocol write corrupts
  the stream. All logging in the MCP server goes to `console.error`.
- **Response envelopes are built in `catalog.js`, not in routes.** `getCatalog()`
  owns `{currency, unit, products}`; routes pass it through.
- **Prices never come from a request body.** `/checkout` looks the amount up from
  the catalog by `productId`.
- Seed data is validated by zod at import time, so a bad price fails at startup
  rather than mid-demo.

## Deferred by design (not oversights)
- **`/checkout` is deliberately ungated** — no mandate check, no audit entry. It
  exists to prove the payment rails work in a browser. The mandate gate belongs in
  the Day 2 `initiate_purchase` MCP tool. Do not wire `check()` into `/checkout`.
- **`stock` is seeded but never decremented.** Inventory is orthogonal to the trust
  primitive being demonstrated.
- Signature verification proves authenticity, not capture status. Day 2's
  `initiate_purchase` closes this by requiring `status === "captured"` from
  `razorpay.payments.fetch()`.
- `package.json` `main: index.js` points at a nonexistent file — cosmetic, Day 3.

## Testing
`test-mandate.js` asserts (`node:assert/strict`) and exits non-zero on failure —
it does not merely print. When changing mandate rules, prove the test can still
fail: break the rule deliberately, confirm a non-zero exit, then restore.

## Windows / Git Bash gotchas hit in this repo
- `/tmp/foo.json` written by curl does **not** resolve for Node. Use the session
  scratchpad with an explicit `C:/Users/...` path.
- `pkill` does not exist. Stop the HTTP server with
  `netstat -ano | grep :3000 | grep LISTENING` then `taskkill //F //PID <pid>`.
- Backticks inside `node -e "..."` get evaluated by bash and silently mangle code.
  Use the Write/Edit tools for file content, not shell heredocs or `-e` strings.
- An MCP server registered mid-session is invisible to that session — servers load
  at session start. Register before recording the demo.
