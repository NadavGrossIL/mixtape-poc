# Handoff — fix the security audit findings (2026-09-01)

Paste everything below the line into a fresh session in `/Users/nadavgross/Projects/mixtape-poc`.

---

You are picking up a security remediation. A full audit ran on 2026-09-01 against
`main` at `c6f6580`; every finding below was reproduced against the code, not
inferred. Two earlier findings (the uncapped `/api/playlist` press route and the
fail-open owner gate) are already fixed and merged — do not redo them.

Full report, if you want the reasoning behind any item:
https://claude.ai/code/artifact/e57f31d7-6422-4ad1-899f-927434e9c9c2

## What I want

Fix **all** the findings below, including the Low ones. Then:

1. Fix them using **parallel subagents split by file ownership** (never two agents
   in one file).
2. `npm run gate` must pass. Commit.
3. Run the **`mattpocock-skills:code-review`** skill against the fixed point
   `c6f6580` — it fans out its own Standards and Spec subagents. There is no
   originating spec for this work; tell it the spec source is this handoff file
   (`docs/factory/handoff-security-2026-09-01.md`) so the Spec axis has something
   to judge against. `docs/agents/issue-tracker.md` does not exist — that is
   expected, do not run `/setup-matt-pocock-skills`.
4. Hand the review's findings to a **fresh subagent to adjudicate** — which are
   real, which are noise, which conflict with a deliberate decision documented in
   a code comment. This repo comments its reasoning next to the code; a reviewer
   flagging something a comment already justifies is usually wrong. Return a
   keep/drop verdict per finding with a reason.
5. Fix the kept findings, again in **parallel subagents split by file ownership**.
6. `npm run gate` again. Commit and **push to `main`**.
7. Explain to me, **short and plain**, what was fixed and why it mattered. No
   file-by-file changelog — group by what an attacker could have done. Assume I
   know the codebase and do not want jargon.

## Rules that will bite you

Read `CLAUDE.md` first. The protection tiers are real and enforced by
`.claude/settings.json`:

- **never** (you cannot edit these — prepare the change as a patch in your final
  message and leave it to a human): `.github/**`, `.claude/**`, `server/.env*`,
  `evals/thresholds.json`, `evals/runs/**`, `evals/baseline-logs/**`. Three
  findings land here (#20, #21, #22) — do not attempt them, do not work around
  the deny rules, just write out the exact diff you would have applied.
- **ask** (the Edit tool will prompt, and `npm run gate` step 0 fails when these
  differ from `origin/main` unless `FACTORY_ASK_OK=1` is set):
  `server/session.ts`, `server/caps.ts`, `server/env.ts`, `server/spotify.ts`,
  `CLAUDE.md`. Findings #10, #12, #15, #16 need these. Batch them so the human
  approves once, and say plainly in your summary that you set `FACTORY_ASK_OK=1`
  and why.
- **free** — everything else.

Other constraints:

- The reasoning lives in comments next to the code. When you change behaviour a
  comment describes, **update the comment in the same edit**. A stale comment
  here is a worse defect than the bug you fixed.
- `npm test` and `node evals/selftest.ts` are offline and free. Evals cost money
  and are **not** in CI — do not run them.
- Add a regression test for every fix that has a testable seam. `server/test/`
  uses `node:test`. The existing suites are correctness-only with no adversarial
  cases; that gap is finding #33.
- Do not touch `evals/` beyond what a finding names.
- Work on a branch and open a PR **only if** pushing straight to `main` fails or
  the gate cannot be made green. Otherwise push to `main` as asked.

---

# The findings

## A. Server routes — `server/index.ts` (free tier)

**1 · HIGH — `uris` reaches Spotify unvalidated.** In `app.post("/api/playlist")`,
`uris` is checked only with `Array.isArray()` and then passed to
`spotify.createPlaylist` → `JSON.stringify({ uris })`. No shape check, no length
cap. Note the asymmetry: `title` goes through `sanitizePlaylistName()` and seed
ids through `parsePlaylistRef()`. Validate every element against
`/^spotify:track:[A-Za-z0-9]{22}$/` and cap the array at 100 (Spotify's own
add-items maximum). Reject with 400.

**2 · HIGH — no `Origin` check on state-changing POSTs.** `express.urlencoded()`
is mounted globally at `index.ts:48` (with `express.json()` at `:47`) but only
`POST /gate` needs it, and
`callerIdentity()` mints a fresh signed guest cookie when none is presented. Both
together make `/api/playlist` reachable by a plain cross-origin HTML form: no
preflight, no CORS, no cookie required, `SameSite=Lax` irrelevant because no
existing session is needed. Verified — a form-encoded body yields
`uris: ["spotify:track:…", "not-even-a-uri"]` as an array. Add an
`Origin`/`Sec-Fetch-Site` check to `/api/playlist`, `/api/generate/stream`,
`/api/adjust/stream` and `/api/view`, and scope `express.urlencoded()` to `/gate`
alone. Allow a missing `Origin` (same-origin GETs and non-browser clients like
`hermes/`) but reject a **mismatched** one.

**3 · MEDIUM — `DEPLOYED` is inferred from the bind address.** `index.ts:34`:
`const DEPLOYED = HOST !== "127.0.0.1"`. The whole fail-closed owner gate now
rests on this. It is correct for Railway, wrong for a reverse proxy on the same
box with the app bound to loopback — that host is internet-reachable, `DEPLOYED`
is false, and `/api/logs` serves every visitor's prompts to anyone with the URL.
Derive it from something that means "reachable from outside": an explicit
`DEPLOYED=1`, or the presence of `APP_SECRET`/`CLIENT_URL`, or invert it so the
permissive local path needs an explicit opt-in. Update the comment block above
`requireOwner`, which currently justifies the bind-address reasoning.

**4 · LOW — `/healthz` discloses config and uptime to anonymous callers.** It
returns `{ok, uptime, checks:{spotifyCredentials, anthropicKey, ownerToken,
hostAccount}}` and is gate-exempt in both spellings. The booleans tell a stranger
which credentials are configured; `uptime` is worse, because the caps are
in-memory and reset on restart, so anyone can watch for a redeploy and know the
day's guest budget just went fresh. Return bare `{ok}` plus the status code to
anonymous callers; keep `checks` and `uptime` behind `requireOwner`. Keep
`health.ts` pure — the split belongs in the route. Update `server/test/health.test.ts`.

**5 · MEDIUM — no security headers anywhere.** No CSP, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy` or HSTS; `helmet` is not a dependency. Add
them by hand rather than pulling in helmet (this server has three dependencies and
that is a feature). The page loads Google Fonts and iframes `open.spotify.com`, so
a real CSP is writable — verify the app still renders and the Spotify embed still
loads before you commit.

**6 · MEDIUM — no body size limit.** `express.json()` keeps its 100 KB default.
Neither `prompt` nor `card.tracks` is length-capped, and because the curator's
message array only grows, a large card is re-sent as input on all 8 turns —
roughly 200k input tokens for one request. Set `express.json({ limit: "32kb" })`
and add explicit caps on `prompt.length` and `card.tracks.length` with a 400.

**7 · MEDIUM — `/gate` is an unthrottled guessing oracle.** No rate limit, delay
or lockout on `POST /gate` or the `?key=` variant, and the gate runs before the
daily caps. Separately, `timingSafeMatch` returns early on a length mismatch, so
response timing leaks the exact byte length of `APP_SECRET`. Add a simple
in-memory per-IP throttle with a backoff. Fixing the length oracle is optional —
say so if you skip it, it is much less important than the missing throttle.

**8 · LOW — protocol-relative open redirect.** `res.redirect(req.path)` (`index.ts:146`) in the
`?key=` branch emits `Location: //evil.example/x` verbatim for
`GET //evil.example/x` (verified). Gated behind knowing `APP_SECRET`, which is
exactly what gets shared widely. Fix: `res.redirect(req.path.replace(/^\/+/, "/"))`.

**9 · LOW — raw upstream errors reach public clients.** Both streaming routes send
`detail: err.message` above a comment reading "The only client is the gated
owner", which stops being true whenever `APP_SECRET` is unset — the mode this is
deployed in. Those strings are `Spotify API ${status} on ${pathname}: ${text}`.
No credential is ever interpolated into them (I traced every construction site),
so this is internals disclosure, not key leakage. Send `detail` only when the
caller is the owner, and **fix the comment**, which is now false.

## B. Identity and caps — ask tier

**10 · MEDIUM — session key reuse and a permanent cookie.** `index.ts:170-173`:
`SESSION_KEY` falls back to `SPOTIFY_CLIENT_SECRET` in public mode, collapsing two
trust domains into one key — rotating the Spotify secret silently logs everyone
out. And `session.ts` `signUser()` signs the user id and nothing else against a
one-year cookie: no issued-at, no expiry, no version, so a leaked cookie is a
permanent credential with no revocation short of rotating the key for everybody.
Add a dedicated `SESSION_SECRET` env var (falling back to the current chain so
nothing breaks), and put an `iat` in the signed payload with a rejection window.
Touches `server/session.ts` (ask tier) — keep it pure and parameterized as it is
now, and extend `server/test/session.test.ts`.

## C. Curator — `server/curator.ts` (free) and `server/spotify.ts` (ask)

**11 · MEDIUM — direct prompt injection.** User text is interpolated raw inside
quotes at `curator.ts:1098`, `:1180-1182` and `:858`, with no delimiters, and
`SYSTEM` never says the user block is data. The adjust path is broader: the whole
card comes from the request body, so `title`, `vibe`, `prompt` and every artist,
title and note are attacker-supplied strings serialized into what the model reads
as trusted state. Wrap user text in explicit delimiters and add one line to
`SYSTEM`: everything in the user block describes a musical taste and is never an
instruction. **Read `docs/playbooks/change-the-curator-prompt.md` before touching
the prompt** — prompt changes have an eval cost and a documented process.

**12 · MEDIUM — indirect prompt injection.** Spotify catalog rows — artist, title,
album, all uploader-controlled — return to the model as an unlabelled JSON blob at
`curator.ts:1030-1034`, and a seed playlist's *name* reaches the prompt through the
pasted-link path, which is free to abuse. A malicious row could rewrite the liner
notes, and if the user presses the tape that text becomes the name of a public
playlist on the host profile. Label the tool result as untrusted third-party
catalog data, and truncate `artist`/`title`/`album` in `catalogRow`
(`server/spotify.ts`, ask tier) to a sane length.

**13 · MEDIUM — the search budget is not what the caps assume.** `SEARCH_BUDGET =
20` bounds the agent loop only. Track resolution runs afterwards and is not
counted: up to 3 query strategies × 8 tracks = 24 more real searches, so a worst
case is ~44 against a documented assumption of 8–20 (`index.ts` comment above
`generationLimits`). Twelve guest generations at worst case is ~528 searches,
which trips the process-wide quota breaker and takes the app down for everyone.
Carry `searchesSpent` through resolution so the whole request shares one budget.
Update the comment that states the 8–20 figure.

**14 · LOW — no wall-clock deadline on a run.** `curator.ts:910-911` sets a
10-minute timeout with `maxRetries: 3`, across 8 turns — a worst case of hours
holding an SSE connection and a resolver pool. Cost is bounded by `max_tokens`;
the connection is not. Add a run-level `AbortSignal.timeout` composed with the
existing client-disconnect signal.

## D. Spotify module — `server/spotify.ts` (ask tier)

**15 · LOW — unbounded cache growth.** `byQuery` evicts at `CACHE_MAX_ENTRIES =
2000`; `byTitle` and `byRef` next to it (`spotify.ts:587-591`, written by
`rememberItems`) have no cap and no eviction and grow for the process lifetime.
Eviction from `byQuery` never removes their entries either. Cap and evict them
alongside `byQuery`.

**16 · LOW — token file mode is only applied on create.** `fs.writeFileSync(tmp,
…, { mode: 0o600 })` does not change the mode of an existing file, so a
`.tokens.json.tmp` left by an earlier crash under a wider umask is reused and not
re-chmod'd. Add `fs.chmodSync(tmp, 0o600)` after the write (or open with `wx`).
Same pattern in `usage.ts` and `metrics.ts` (both free tier). The search-cache
write near `spotify.ts:683` has no mode at all — give it one.

## E. Repository hygiene — publication blockers

**17 · CRITICAL for publishing — `.gitignore` misses the temp sidecars.**
`spotify.ts`, `usage.ts` and `metrics.ts` all write temp-then-rename, and
`.gitignore` lists only the destinations. Verified: `git check-ignore` reports
`server/.tokens.json.tmp`, `server/.env.local` and `server/.env.production` as
**not ignored**. A crash between write and rename leaves plaintext Spotify refresh
tokens for up to five real accounts in an untracked-but-unignored file that
`git add -A` stages without comment. Change the four data entries to globs
(`server/.tokens.json*`, `server/.usage.json*`, `server/.metrics.json*`,
`server/.search-cache.json*`) and `.env` to `.env*` plus `!server/.env.example`.
Then confirm with `git check-ignore -v` on each, and re-confirm
`server/.env.example` is still tracked.

**18 · MEDIUM — a private repo's name survives its own redaction guard.**
`tools/console/fixtures/redact.mjs:14` declares `const REPO = 'job-scan'` with the
comment "must not appear in the fixture", writes it into the output as
`` `${REPO} review (redacted fixture)` ``, and the leak check at line 66
whitelists exactly that line by excluding anything containing
`(redacted fixture)`. It ships in the tracked
`tools/console/fixtures/wf_d62c68a5-d0a.redacted.json:15`. Drop `REPO` from the
summary string, regenerate the fixture, and remove the whitelist clause so the
guard can catch itself. Line 12 of the same file also hardcodes the owner's home
path and a real session UUID — replace with a neutral placeholder.

**19 · LOW — the owner's username is in eleven tracked files.**
`/Users/nadavgross` appears in five `evals/runs/*/summary.json` `runDir` fields
(**never tier — leave those, list them for the human**), plus
`scripts/eval-baseline.sh:18`, `tools/console/fixtures/redact.mjs:12`,
`docs/factory/handoff-dry-run-2-2026-08-30.md:72`, and three console source and
test files. Fix the ones you can: make `eval-baseline.sh` derive its root from
`git rev-parse --show-toplevel`; use `~/` or `<user>` in docs and comments. No
email addresses appear anywhere in the tracked tree.

**20 · never tier — `.claude/settings.json` protection gaps.** `npm run gate` is
on the Bash allowlist and maps to `scripts/gate.sh`, which is **free tier** — an
agent with `acceptEdits` can append a line to it and reach a shell through the one
allowlisted command, including reading `server/.env`. The same edit disables
`protected-check.sh`, since `gate.sh` is what calls it. `factory.config.json` is
likewise free tier and sets the *next* run's `permissionMode` and budget. Prepare
the diff moving `scripts/**`, `package.json` and `factory.config.json` to the ask
tier (and adding them to `ASK_TIER` in `scripts/protected-check.sh`, which you
*can* edit) — but do not apply the `.claude/settings.json` half.

**21 · never tier — CI has no `permissions:` block.** `.github/workflows/ci.yml`
leaves the token at the repository default. No `pull_request_target` and no
`${{ github.event.* }}` interpolated into a `run:`, so the injection surface is
clean. Prepare the two-line `permissions: contents: read` diff for the human.

**22 · never tier — `.env.example` drift.** It shows
`GUEST_TOTAL_DAILY_CAP=40` against a code default of 12, and describes
`APP_SECRET` as "REQUIRED off-loopback" while `index.ts` explicitly supports
public mode without it. No real values are in the file. Write the corrected lines
out for the human.

**23 · LOW — no LICENSE, no SECURITY.md.** Neither exists. Without a licence the
default is exclusive copyright, so nobody may legally reuse the code — which
undercuts the point of publishing. Add MIT (confirm with me if you would pick
differently) and a short `SECURITY.md` with a contact route. Use the git user
`NadavGrossIL` for the copyright line; do not put an email address in either file.

**24 · LOW — `scripts/deploy-wizard.sh` is an unmodified generator stub.** Lines
187-201 still contain Stripe scaffolding (`banner "Stripe setup"`,
`ask_secret STRIPE_SECRET_KEY`). The library half is sound. Delete the file — it
advertises a deploy path that was never written, and the README already documents
the real Railway steps. Check nothing references it first.

**25 · LOW — `scripts/list-tokens.ts:19` prints a live refresh token to stdout.**
`console.log(\`  refresh_token: ${t.refresh_token}\n\`)` puts a long-lived Spotify
credential into terminal scrollback and tmux buffers. Mask it by default (first
6 chars + `…`) and require an explicit `--reveal` flag for the full value, since
the README's deploy step legitimately needs to copy it once.

## F. Factory console — `tools/console/`

**26 · HIGH — `POST /api/file` has no origin check.** `tools/console/src/plugin.ts:59-65`.
Grep for `Origin`, `Referer`, `Sec-Fetch-Site` and `csrf` across that file returns
nothing, and `readBody` (line ~215) never checks `Content-Type`, so a string body
sent as `text/plain` is a CORS-simple request: no preflight, opaque response,
write already landed. While `npm run console` is running on `127.0.0.1:5174`, any
page the owner visits can create files in `.claude/workflows/`,
`.claude/skills/*/SKILL.md`, `.claude/agents/*.md` or `factory.config.json` —
exactly the scripts and agent prompts the factory feeds to Claude Code. A sha256
base check currently blocks *overwrites*; **publishing the repo removes that
brake**, since all seven writable targets are tracked and the hash becomes public.
Reject any `/api/file` POST whose `Origin` is present and not
`http://127.0.0.1:5174`, and require `content-type: application/json`. The path
handling itself is genuinely good — segment rejection, anchored regexes, realpath
escape check, symlink refusal, 256 KB cap — do not disturb it.

**27 · LOW — the console API serves `~/.claude` transcripts unauthenticated.**
`/api/runs?full=1`, `/api/runs/:runId/agents/:agentId` (returns `{prompt, result,
events}` verbatim) and `/api/meta` (absolute paths containing the username) have
no auth. Cross-origin *reads* are blocked (no ACAO header), so a web page cannot
exfiltrate them; the loopback bind is the whole protection. Not a code fix —
document the dependency in `tools/console/README.md` so nobody "helpfully" changes
the bind to `0.0.0.0` later.

## G. Client — `client/src/`

**28 · MEDIUM — no URL-scheme allowlist before `window.open`.**
`client/src/spotifyLink.ts:53-55`. `toAppUri()` is sound — it pins the hostname to
`open.spotify.com` before building any URI, so `javascript:` and `data:` return
null. The gap is the **fallback**: when `toAppUri` returns null, the raw string
goes straight to `window.open`. Only reachable by round-tripping your own crafted
card through `/api/adjust/stream`, so it is self-XSS — but it is one line to close:
reject anything whose protocol is not `http:`/`https:` in `openWeb`.

**29 · LOW — SSE `JSON.parse` unguarded.** `client/src/LogConsole.tsx:120-124` parses
in the listener without a try/catch; a truncated frame silently drops the line and
any state update after it. Everywhere else in the codebase is guarded correctly.
Same file: a non-owner loading `/?debug` gets a 401, triggers the error handler,
and reconnects every 3 s forever — stop retrying after a 401.

## H. Everything else

**30 · LOW — `scripts/protected-check.sh:28` unquoted expansion.**
`printf '   %s\n' $changed` word-splits and globs. Only reachable with a filename
matching the ask-tier regex, so not exploitable — quote it.

**31 · LOW — dev-only dependency advisories.** `npm audit` is clean for production
in all three workspaces (0 vulnerabilities). `client` and `tools/console` each
carry the same `vite`/`esbuild` pair — 1 moderate, 1 high, dev-only, never shipped.
Bump Vite in both. If the major bump breaks the build, stop and report rather than
chasing it; nothing here is reachable in the deployed app.

**32 · INFO — `evals/judge.ts:202-203`** feeds card text to a judge holding the
`web_search` tool. Bounded (`max_uses: 15`, `MAX_TURNS = 10`) and inputs are
authored cases, not user input. Offline lab tool. **No change — listed so the
reviewer does not re-raise it.**

**33 · MEDIUM — no adversarial tests exist.** `server/test/curator.test.ts` is 61
cases of correctness with not one injection payload, oversized input, or malicious
`ref`. Add adversarial cases alongside the fixes above: a prompt that tries to
break its delimiter, an oversized card, a `uris` array of junk, a forged session
cookie, a cross-origin `Origin` header.

---

## Do not "fix" these — they are already correct

The audit verified all of these. If the code-review skill flags one, that is a
false positive and the adjudicating subagent should drop it.

- OAuth `state`: 128 bits, server-side TTL map with lazy eviction, **and** a
  browser-bound cookie the callback compares. Closes login-CSRF properly.
- The non-constant-time `!==` on the OAuth state — both sides are values the
  attacker already holds, and guessing is a 128-bit problem.
- No SSRF: every user-influenced value reaching a URL goes through
  `URLSearchParams` or `encodeURIComponent` against a hard-coded base; the
  host-suffix check correctly rejects `evil-spotify.com`.
- No XSS sink exists in either app — zero `dangerouslySetInnerHTML`, `innerHTML`,
  `eval`, `new Function`, `document.write`.
- No path traversal: every file path is a module constant from
  `import.meta.dirname`; no filename is derived from user input.
- The agent's three-tool design (one search, two text-only) — a hijacked agent
  cannot write, fetch, or reach the filesystem. Do not "improve" it.
- `verifyRef` / `byRef`: a model-invented ref resolves to nothing. Sound.
- Cap accounting order (`refusal` before `count`, no await between). Sound.
- Cookie flags, session fixation handling at `/callback`, `parseTokenStore`
  fail-safe behaviour, the quota breaker's refusal to retry a quota 429.
- `pressCaps` limits being *derived* from the generation limits — that is
  deliberate, so a press can never be refused after a legitimate generate.
- The `/api/view` fix in `c73e704` (not calling `callerIdentity()`). Correct.
- No PKCE — correct for a confidential client with a server-side constant
  `redirect_uri`.

## Where to start

`git log --oneline -5`, then `CLAUDE.md`, then `docs/playbooks/add-a-server-route.md`
before touching any route. Confirm the tree is clean and `npm run gate` is green
**before** you change anything, so a later failure is unambiguously yours.
