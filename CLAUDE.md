# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mixtape: prompt → Claude-curated 8-track card → real Spotify playlist. This
file is a map. The reasoning lives next to the code as comments; read those.

## Where things live

- `server/` — Express on 8888, plain `.ts` run by Node 24 (no build step).
  `index.ts` all routes + gate/identity/caps wiring · `curator.ts` the
  Claude agent, prompts and tool schemas · `spotify.ts` OAuth, search cache,
  quota breaker, playlist writes · `caps.ts` `pressCaps.ts` `session.ts`
  `usage.ts` `metrics.ts` `health.ts` `logbook.ts` `searchBudget.ts`
  `httpOrigin.ts` `trackUris.ts` `gateThrottle.ts` pure helpers · `test/`
  unit tests (`node:test`). `pressCaps.ts` caps `/api/playlist`, the one paid
  route reachable without the curator; `metrics.ts` is the per-day funnel
  (`makeMetrics({ dir, today })`, `DATA_DIR` or beside the code — an
  ephemeral disk resets it); `health.ts` decides what `/healthz` fails on
  and what a stranger is allowed to see of it. The four modules the
  2026-09-01 security pass added: `searchBudget.ts` is the ONE per-request
  Spotify allowance the curator loop and track resolution now both spend
  from (resolution used to be uncounted, so a run could cost ~44 searches
  against a documented 8-20 and trip the quota breaker for everyone);
  `httpOrigin.ts` is the cross-site rule for the state-changing POSTs;
  `trackUris.ts` validates `uris` before Spotify sees them; `gateThrottle.ts`
  rate-limits `/gate` guessing. Session cookies now carry a signed issued-at
  and expire (`SESSION_MAX_AGE_MS` in `session.ts`), so the `Set-Cookie`
  `Max-Age` in `index.ts` is derived from it rather than picked separately,
  and `SESSION_SECRET` is the signing key — the old fallback to
  `SPOTIFY_CLIENT_SECRET` made one credential do two jobs.
- `client/` — Vite + React 18, one screen: `src/App.tsx`, tokens in
  `src/styles.css`. Dev proxy in `vite.config.ts`; served from Express when built.
- `evals/` — truthfulness (`generate` → `judge` → `aggregate`, plus
  `grounding`), `reliability` (pass^k), `selftest` (offline), `prompts.json`
  (the cases), `thresholds.json` (the gates), `runs/` (evidence).
- `docs/` — `reviews/` (2026-08-14 audit) · `research/` · `decisions/`
  (ADRs) · `playbooks/` (how we do X) · `factory/plan.md` (this workflow).
- `specs/` — feature tickets, from `specs/_template.md`.
- `.claude/skills/` — `/spec`, `/implement`, `/review` (the factory line, M3);
  `.claude/agents/reviewer.md` is the read-only reviewer `/review` calls.
- `scripts/` — `eval-baseline.sh` (one-shot, quota-preflighted),
  `list-tokens.ts` (masks the refresh token; `--reveal` prints it in full,
  which the README's deploy step needs once). `hermes/` — a client of the
  public API, touches nothing in the app.

## Run and verify

```sh
cd server && npm run dev             # http://127.0.0.1:8888
cd client && npm run dev             # open on 127.0.0.1, never localhost
cd server && npm test                # unit tests + evals selftest, offline
cd server && node --test test/caps.test.ts   # one test file
npm run typecheck                    # server; client: cd client && npm run typecheck
node evals/selftest.ts               # harness logic, no keys, no cost
cd client && npm run build           # tsc -b && vite build
npm run gate                         # all of the above, cheapest first, stops at first failure
```

CI (`.github/workflows/ci.yml`) runs `npm run gate` and nothing else. Evals
are not in CI — they cost money (`docs/playbooks/change-the-curator-prompt.md`).

## Protection tiers (enforced by `.claude/settings.json` permission rules)

- **never** — `evals/thresholds.json`, `evals/runs/**`,
  `evals/baseline-logs/**`, `.github/**`, `.claude/**`,
  `server/.env*`. Edited by a human, outside the agent. Deny rules; they
  also catch `cat`/`sed`/`>`/`>>` in Bash (verified 2026-08-28).
- **ask** — `server/session.ts`, `server/caps.ts`, `server/env.ts`,
  `server/spotify.ts` (identity, caps, tokens), `scripts/**`, every
  `package.json`, `factory.config.json`, and `CLAUDE.md` — this
  file, which every session reads first, so a wrong line here misleads
  every session after it; an agent proposes the edit and a human approves
  it in the moment (moved off **never** 2026-09-01, so a capability that
  ships also lands in the map above instead of waiting to be noticed).
  `scripts/**`, `package.json` and `factory.config.json` joined the tier on
  2026-09-01: `npm run gate` is the one command the factory's Bash allowlist
  admits and it runs `scripts/gate.sh`, so a free-tier `gate.sh` (or an npm
  script it invokes) is an arbitrary shell out of the one allowed command —
  including `cat server/.env` — and the same edit disables step 0, since
  `gate.sh` is what calls it. `factory.config.json` sets the *next* run's
  `permissionMode` and budget, which no in-run check would ever see.
  **Those three are enforced by `scripts/protected-check.sh` only** — the
  matching `Edit(...)` rules in `.claude/settings.json` are not there yet
  (never tier; the diff is in the 2026-09-01 security handoff, for a human).
  So the gate catches them, but the Edit tool will not prompt on them.
  Ask rules stop the Edit
  tool only — a Bash redirect walks past them — so `npm run gate` step 0
  fails when any of them differs from `origin/main`; a human passes it
  with `FACTORY_ASK_OK=1`. It runs in CI too, but only because
  `.github/workflows/ci.yml` sets `fetch-depth: 0` — the default shallow
  checkout has no `origin/main` to diff against and the check silently
  passes whatever the PR touches (it did, until #11). Factory runs: `--permission-mode acceptEdits`
  plus the enumerated Bash allowlist in `.claude/settings.json`.
- **free** — everything else.

## Read before touching

- Any route → `docs/playbooks/add-a-server-route.md`
- `evals/prompts.json` → `docs/playbooks/add-an-eval-case.md`
- `server/curator.ts` → `docs/playbooks/change-the-curator-prompt.md`
- Why it is shaped this way → `docs/decisions/` (three ADRs), `README.md`
- Path-scoped gotchas load on their own from `.claude/rules/`
  (`curator.md`, `spotify.md`, `evals.md`).
