# Playbook — add an eval case

A case is one entry in `evals/prompts.json`: `{ "id", "category", "prompt" }`.
`id` is `<category-prefix>-<slug>` (`niche-city-pop`, `statbait-highest-bpm`);
categories in use: `app-example`, `mainstream-safe`, `deep-niche`,
`non-english`, `decade-specific`, `mood-only`, `stat-claim-bait`,
`recent-music`, `artist-specific`. Add to an existing category unless the
case is a new *kind* of lie to catch — that is what categories split rates by.

Deterministic checks are not eval cases: a fixture + assert in
`evals/selftest.ts` / `evals/test-fixtures/` (ADR 0003).

1. Append the entry. Check it parses:
   `node -e 'JSON.parse(require("fs").readFileSync("evals/prompts.json","utf8"))'`
2. Pilot just that case, in order — each step reads the latest run dir:
   ```sh
   node evals/generate.ts --only <id>   # real curator + Spotify resolution
   node evals/judge.ts                  # Opus + web search, one call per card
   node evals/aggregate.ts              # rates + threshold gate → summary.json
   ```
3. Read `evals/runs/<ts>/verdicts.json` for the card by hand. The judge is
   non-deterministic; one card proves the prompt *works*, not a rate.

## The other case file: `evals/fit-prompts.json`

A separate set (2026-11-22) for a different question: did every track obey
the year or era the listener asked for. Each case carries its answer key,
`era: { from, to }` — the inclusive range of ORIGINAL release years, `null`
for an open side — and `trap`: `null`, or one line on why Spotify's date is
expected to mislead there. It is kept out of `prompts.json` on purpose, so
the truthfulness rates and their cost do not move.

- Only asks with one right answer per track belong: a year, a decade, a
  range. "Fastest", "longest", "biggest" and "one-hit wonder" were tried in
  the 2026-11-22 pilot and two blind checkers could not agree on them.
- `node evals/generate.ts --prompts fit-prompts.json` generates its cards
  (about 10 cents a card, no judge); `node evals/fit.ts` scores them. Code
  passes a track when Spotify and MusicBrainz both date it inside the range;
  the rest need a web check, read back with `--checks <file>`. The header of
  `evals/fit.ts` has the first result and the fix that was tried and dropped.
- `selftest.ts` checks the file's shape; a backwards or missing era fails CI.

## What it costs

- Judge ≈ **$1.18/card** (max $1.66), ~2.9 min wall clock, ~10 web searches
  (`docs/research/eval-findings-audit-2026-08-18.md`).
- Curator: up to `SEARCH_BUDGET` = 20 live Spotify searches from a shared
  daily quota of a few hundred (`.claude/rules/spotify.md`).

## Don't

- Don't touch `thresholds.json` because the new case moved a rate. The
  gates were calibrated on 75 checkable notes and sit ~2 sd loose; a new
  baseline run is the only way to re-set them, and that is Nadav's call.
- Don't put the case in `scripts/eval-baseline.sh`'s `--limit 6` slice
  expecting it to run there; the full 18-prompt run is `run-validation.sh`'s
  shape.
