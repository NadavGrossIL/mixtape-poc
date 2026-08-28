---
paths:
  - "evals/**"
---

# evals/

- **Never invent a threshold.** `thresholds.json` was set on 2026-08-18 from
  a measured baseline (run `2026-08-18T07-45-44-348Z`: 11 cards, 88 notes,
  75 checkable; invented 0.240, verified-true 0.733, generic 0.045,
  resolution 1.000). The gates sit ~2 sd loose of those numbers so a bad
  draw can't fail a build; tightening them is Nadav's product call, not the
  harness's. `reliability` thresholds stay `{}`: no valid baseline exists.
- A metric with an empty denominator is "no data — skipped", never a
  breach; a run that measured *nothing* fails unconditionally in
  `aggregate.ts` (`8e0a94a`). Validity is not a threshold.
- `runs/` and `baseline-logs/` are evidence. Read them; never edit them.
- Evals cost money and never gate CI; `selftest.ts` is free and does.
  Anything with one right answer is a unit test, not an eval —
  `docs/decisions/0003-tests-vs-evals-split.md`.
- Cases are `prompts.json` entries `{id, category, prompt}` —
  `docs/playbooks/add-an-eval-case.md`. Pilot with `--only <id>` before a
  full run; a full run is the day's Spotify quota.
