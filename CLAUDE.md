# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mixtape: prompt → Claude-curated 8-track card → real Spotify playlist. This
file is a map. The reasoning lives next to the code as comments; read those.

## Where things live

- `server/` — Express on 8888, plain `.ts` run by Node 24 (no build step).
  `index.ts` all routes + gate/identity/caps wiring · `curator.ts` the
  curator's rules: prompt, the two tool schemas, the card check (no model
  call in it) · `lc/curator-lc.ts` the LangChain/LangGraph agent that runs
  them — the only curator since 2026-11-21; its small decisions are pure
  files beside it (`cardStream.ts` `cardDiff.ts` `searchStep.ts`
  `modelCall.ts` `threads.ts` `runLog.ts`), and `lc/first-agent.ts`
  `card-agent.ts` `press-agent.ts` are lesson files, never wired in ·
  `curatorLoader.ts` loads the agent behind the LangSmith tracing guard
  (tracing is forced off on a deployed host unless
  `LANGSMITH_TRACE_VISITORS=1`) · `spotify.ts` OAuth, search cache,
  quota breaker, playlist writes · `caps.ts` `pressCaps.ts` `session.ts`
  `usage.ts` `metrics.ts` `health.ts` `logbook.ts` `searchBudget.ts`
  `httpOrigin.ts` `trackUris.ts` `gateThrottle.ts` `drain.ts` `outage.ts`
  `errors.ts` pure helpers (`errors.ts` reads `status` / `message` /
  `quotaExceeded` off a caught value, so no route needs `catch (err: any)`) ·
  `wire.ts` the zod schema of the card on the wire and the one accent list;
  `/api/adjust/stream` parses the card it is sent with it · `test/`
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
  rate-limits `/gate` guessing. `drain.ts` (2026-09-02) is the bounded wait
  the SIGTERM handler in `index.ts` uses so a Railway redeploy lets in-flight
  SSE runs finish instead of cutting them; inert until
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` ≥ 30 on the service. `outage.ts` (2026-09-02) classifies an Anthropic
  auth/billing failure so `/healthz` goes 503 for it and the visitor is told
  "our side, not yours" — every generation had been failing on an empty
  credit balance while `/healthz` stayed green, because it only checked that
  the key was present. Session cookies now carry a signed issued-at
  and expire (`SESSION_MAX_AGE_MS` in `session.ts`), so the `Set-Cookie`
  `Max-Age` in `index.ts` is derived from it rather than picked separately,
  and `SESSION_SECRET` is the signing key; unset, it still falls back to
  `APP_SECRET` then `SPOTIFY_CLIENT_SECRET` (one credential doing two jobs),
  which a deployed host now warns about at boot.
- `client/` — Vite + React 18, one screen. `src/App.tsx` is the composition
  root: the prompt, the card, the hint and the live region, one hook per
  concern, and the screen's layout · `src/hooks/` one hook per concern
  (session, shelf, recent, page view, seed picker, generation,
  refine, save, unsaved-card guard) · `src/components/` one component per
  surface, the log console included · pure modules flat in `src/`,
  unit-tested from `server/test/` (so no `react`, no DOM, `.ts` on internal
  imports): `card.ts` `seed.ts` `runFailure.ts` `failures.ts` `recent.ts`
  `latest.ts` `share.ts` and the run reducers `generationRun.ts`
  `refineRun.ts` `saveRun.ts` · `debug.ts` is the `?debug` switch for the
  log console. `src/types.ts` declares the card on its own instead of
  importing `server/wire.ts`: the production build compiles the client
  before `server/node_modules` exists, so even a type-only import of a file
  that imports zod fails the deploy; `server/test/wire.test.ts` fails the
  typecheck if the two ever differ. Tokens in `src/styles/tokens.css` (all
  CSS under `src/styles/`, one file per surface, layered via `index.css`).
  Dev proxy in `vite.config.ts`; served from Express when built.
- `evals/` — truthfulness (`generate` → `judge` → `aggregate`, plus
  `grounding`) grades the liner notes, `reliability` (pass^k), year fit
  (`fit.ts` over `fit-prompts.json`, 2026-11-22: is each track from the era
  the listener asked for — the one eval that grades the playlist; code
  passes a track when Spotify and MusicBrainz agree, the rest need a web
  check), `selftest` (offline), `prompts.json` (the truthfulness cases),
  `thresholds.json` (the gates), `runs/` (evidence).
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
  Both layers — the `scripts/protected-check.sh` gate check and the matching
  `Edit(...)` rules in `.claude/settings.json` — are in place since
  2026-09-01 (`d768ccf`); the only thing still owed from that pass is the
  eval run (`docs/factory/security-never-tier-patches-2026-09-01.md`).
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
- `server/curator.ts`, `server/lc/curator-lc.ts`, `server/lc/cardDiff.ts`
  (anything the model is sent) → `docs/playbooks/change-the-curator-prompt.md`
- Why it is shaped this way → `docs/decisions/` (three ADRs), `README.md`
- Path-scoped gotchas load on their own from `.claude/rules/`
  (`curator.md`, `spotify.md`, `evals.md`).
