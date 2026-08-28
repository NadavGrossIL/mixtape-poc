# ADR 0003 — Tests and evals answer different questions; neither replaces the other

**Status:** accepted · **Date:** 2026-08-16 (`99d0ff0`), CI shape from `de18ff5`

## Context

The question was whether the unit tests should become evals. All server
tests and the eval selftest are deterministic; grading a brace-matcher with
a model is slower, costlier and less reliable than an assert. The real gaps
were the opposite: `evals/runs/` had never existed and `aggregate.ts`
printed rates that could not fail anything.

## Decision

- **Test** (offline, in CI, every push): anything with one right answer —
  the streaming brace matcher, the completeness gates, track matching, cap
  arithmetic, cookie signing, the pass@k/pass^k estimators, the threshold
  checker. `cd server && npm test` runs `node --test` **and**
  `node evals/selftest.ts`.
- **Eval** (costs money, needs keys, never gates a PR): anything graded on
  model output — note truthfulness (Opus judge + web search) and first-try
  contract reliability (pass^k). Thresholds are set only from a measured
  baseline (`evals/thresholds.json`, 2026-08-18).
- CI holds no secrets on purpose, so evals cannot run there.

## Consequences

- A bug fix ships with a test if deterministic, an eval case if not.
- Deterministic harness logic gets its own tests (`selftest.ts`) so the
  paid runs are never the first place a harness bug shows.
- `server/curator.ts` exposes `onCommit` so the eval measures the
  production path rather than a copy that drifts.

Sources: README "Tests"; commit `99d0ff0`; `.github/workflows/ci.yml`;
`docs/reviews/2026-08-14-architecture-review.md` §6 ("testing-pyramid").
