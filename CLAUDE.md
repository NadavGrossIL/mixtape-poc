# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mixtape: prompt → Claude-curated 8-track card → real Spotify playlist. This
file is a map. The reasoning lives next to the code as comments; read those.

## Where things live

- `server/` — Express on 8888, plain `.ts` run by Node 24 (no build step).
  `index.ts` all routes + gate/identity/caps wiring · `curator.ts` the
  Claude agent, prompts and tool schemas · `spotify.ts` OAuth, search cache,
  quota breaker, playlist writes · `caps.ts` `session.ts` `usage.ts`
  `logbook.ts` pure helpers · `test/` unit tests (`node:test`).
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
  `list-tokens.ts`, `deploy-wizard.sh`. `hermes/` — a client of the public
  API, touches nothing in the app.

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
  `evals/baseline-logs/**`, `.github/**`, `CLAUDE.md`, `.claude/**`,
  `server/.env*`. Edited by a human, outside the agent. Deny rules; they
  also catch `cat`/`sed`/`>`/`>>` in Bash (verified 2026-08-28).
- **ask** — `server/session.ts`, `server/caps.ts`, `server/env.ts`,
  `server/spotify.ts` (identity, caps, tokens). Ask rules stop the Edit
  tool only — a Bash redirect walks past them — so `npm run gate` step 0
  fails when any of them differs from `origin/main`; a human passes it
  with `FACTORY_ASK_OK=1`. Factory runs: `--permission-mode acceptEdits`
  plus the enumerated Bash allowlist in `.claude/settings.json`.
- **free** — everything else.

## Read before touching

- Any route → `docs/playbooks/add-a-server-route.md`
- `evals/prompts.json` → `docs/playbooks/add-an-eval-case.md`
- `server/curator.ts` → `docs/playbooks/change-the-curator-prompt.md`
- Why it is shaped this way → `docs/decisions/` (three ADRs), `README.md`
- Path-scoped gotchas load on their own from `.claude/rules/`
  (`curator.md`, `spotify.md`, `evals.md`).
