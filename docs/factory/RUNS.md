# Factory runs

One row per run of the line (docs/factory/plan.md, M5). Cost is
`total_cost_usd` from `claude -p --output-format json`; attempts are
`implement / gate / review` as the workflow counted them. "autonomous" means
no human between `status: ready` and the review verdict; "escalated" means
the run returned `needs-human` and the reason column says why.

How a row gets here: `scripts/factory-run.sh specs/NNNN-slug.md` cuts a
clean worktree at `../mixtape-poc.wt` (branch `factory/NNNN-slug` from
`origin/main`), runs `claude -p "/implement-from-spec {spec, config}"` in
it with the hard-stop flags from `factory.config.json`, saves the JSON
result to `docs/factory/runs/<date>-NNNN.json`, reads the run manifest the
engine wrote, and appends the row below. Nothing is committed or pushed by
the script — the human commits in the worktree and opens the draft PR
(`docs/playbooks/run-the-factory.md`). The first row predates the driver
and was written by hand.

| date | spec | engine | attempts (impl/gate/review) | gate | review | outcome | cost (USD) | run | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-29 | 0001 share-pressed-card | native `/implement-from-spec` | 1 / 1 / 1 | passed (first run) | pass, 0 findings (sonnet) | autonomous → PR #1 (draft) | 3.92 | `wf_9fda3778-dbf` · 4 agents · 106k tok · 4.4 min | first dry run; manifest written only at run end, journal is the live signal; a $0.68 load probe the same morning is not in this row |
| 2026-08-29 | 0002 album-position-gate-blind-spots | native `/implement-from-spec` | 1 / 1 / 1 (review cut) | passed (first run) | — (reviewer cut at 2m14s, no verdict) | escalated: headless bg-task ceiling (600 s) ended the session in Review | 3.26 | `wf_0684802b-74d` · 4 agents · 208k tok · 10.1 min · no manifest (journal only) | attempt 1 · implementModel: sonnet · driver: scripts/factory-run.sh, worktree factory/0002-album-position-gate-blind-spots · implement 6m49s on sonnet vs 2m31s on fable in row 1 (8 slices vs 1 button) · branch validated by hand: gate + 125 tests pass; diff kept as docs/factory/runs/2026-08-29-0002-attempt1.diff, result as …-attempt1.json · spec was reviewed first by /review-spec `wf_48b9d383-e37` (65 claims, 0 wrong, 15 must-adds — 12 of the hand panel's 16 must-adds overlapped, 5 folded in by hand) · a $0.26 headless trust probe the same afternoon is not in this row |

Rules that feed this table (plan §M5): a bug fix ships with a test or eval
case; friend feedback becomes a `/spec`; a `touches_prompt: true` spec gets
one eval run, read by a human against `evals/thresholds.json`.
