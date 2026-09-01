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
