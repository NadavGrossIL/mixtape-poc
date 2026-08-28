# Playbook — change the curator prompt

The prompt is `SYSTEM` in `server/curator.ts` (~line 289); `ADJUST_SYSTEM`
extends it for the refine flow. The tool schemas sit in the same file — read
the schema next to any rule you add, because a strict schema can forbid
what the prompt demands (`d69f4bb`), and it silently drops constraints it
can't compile (ADR 0001). Changing `MODEL` counts as a prompt change.

Mark the spec `touches_prompt: true`. Evals run **once** after review and a
human reads the result. Nothing loops on it.

## Afterwards, cheapest first

1. Free, offline: `cd server && npm test` and `npm run typecheck`. The
   brace matcher and completeness gates don't care about wording, so a
   failure here is a schema or code slip, not the prompt.
2. Preflight the quota with one search (the probe in
   `scripts/eval-baseline.sh`). No quota → nothing else is worth paying for.
3. The one eval run — the shape `evals/run-validation.sh` used on
   2026-08-23 (copy it with a new log name; it hardcodes that date):
   ```sh
   node evals/generate.ts     # all 18 prompts through the real curator
   node evals/judge.ts        # Opus + web search
   node evals/aggregate.ts    # exit 1 = a threshold breached
   node evals/grounding.ts    # were invented years copied from Spotify rows?
   ```
4. Contract check, k=3 on the cheap eval (plan §9):
   `node evals/reliability.ts --only app-fastest-rap --trials 3`
5. Read `evals/runs/<ts>/summary.json` against `evals/thresholds.json`
   **and** a sample of `verdicts.json` by hand. A breach means the change
   regressed truthfulness — fix the prompt, not the threshold.

## What it costs (measured)

- Judge ≈ $1.18/card, **$12.95 for an 11-card run**, ~2.9 min/card
  (`docs/research/eval-findings-audit-2026-08-18.md`).
- **~90 live Spotify searches** — the day's whole quota; run nothing else
  against it that day (`evals/run-validation.sh`). Cache hits are free, so
  re-running the same prompts is cheaper than the first pass.
- Wall clock in the logs: 32 min (2026-08-23, judge resumed later after API
  credits ran out at 7/18) to ~5 h (2026-08-24, plus a 2 h judge retry).

## The record

The validated example: `928af80` prompt rewrite → `b7c09eb` invented notes
24.0% → 10.1%. Baseline numbers: `.claude/rules/evals.md`.
