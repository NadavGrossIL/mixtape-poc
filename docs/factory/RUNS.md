# Factory runs

One row per run of the line (docs/factory/plan.md, M5). Cost is
`total_cost_usd` from `claude -p --output-format json`; attempts are
`implement / gate / review` as the workflow counted them. "autonomous" means
no human between `status: ready` and the review verdict; "escalated" means
the run returned `needs-human` and the reason column says why.

| date | spec | engine | attempts (impl/gate/review) | gate | review | outcome | cost (USD) | run | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-29 | 0001 share-pressed-card | native `/implement-from-spec` | 1 / 1 / 1 | passed (first run) | pass, 0 findings (sonnet) | autonomous → PR #1 (draft) | 3.92 | `wf_9fda3778-dbf` · 4 agents · 106k tok · 4.4 min | first dry run; manifest written only at run end, journal is the live signal; a $0.68 load probe the same morning is not in this row |

Rules that feed this table (plan §M5): a bug fix ships with a test or eval
case; friend feedback becomes a `/spec`; a `touches_prompt: true` spec gets
one eval run, read by a human against `evals/thresholds.json`.
