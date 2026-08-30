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
| 2026-08-29 | 0002 album-position-gate-blind-spots | native `/implement-from-spec` | 2 / 1 / 1 | passed (first run) | — (reviewer errored at 116 s: account session limit) | escalated: account session limit hit in Review ("You've hit your session limit · resets 4:40pm"); the reviewer and the fix round returned nothing | 2.74 | `wf_66ec6c31-e3f` · 5 agents · 180k tok · 9.4 min | attempt 3 · implementModel: sonnet · driver: scripts/factory-run.sh, worktree factory/0002-album-position-gate-blind-spots · implement 6m36s on sonnet, gate passed first run, contract extracted, then the window closed · branch validated by hand (gate + tests); diff kept as docs/factory/runs/2026-08-29-0002-attempt3.diff, result and PR body as …-attempt3.json / .pr.md · attempt 2 (14:21, `wf_b0d5ee18-0a6`, $0.35) is not a row: swept at once by CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0, result kept as …-attempt2.json · the 600 s ceiling and the dashed project slug were fixed in the driver between attempts 1 and 3 |
| 2026-08-30 | 0002 album-position-gate-blind-spots | native `/implement-from-spec` | 1 / 1 / 1 | passed (first run) | pass, 0 findings (claude-sonnet-5) | autonomous (ready-for-eval) | 2.93 | `wf_2d570cca-1ac` · 4 agents · 197k tok · 11.2 min | attempt 4, the autonomous one · implementModel: sonnet · driver: scripts/factory-run.sh, worktree factory/0002-album-position-gate-blind-spots · implement 1 / gate 1 / review 1, every phase first-try; the reviewer returned `{verdict: pass, findings: []}` — the first real verdict on this spec, attempts 1 and 3 never got one · validated by hand before the PR: `npm run gate` passed in 3 s, 125/125 tests, +8 tests in `server/test/curator.test.ts` (61 → 69) matching the spec's eight slices with its exact fixture table and both must-stay-green guards (`pylon`, `disquedor`), no package.json, no ask-tier or never-tier path · cost split $1.91 sonnet (implement, gate, contract, reviewer) + $1.02 **opus-5[1m]** at the top level: `claude -p` inherits the CLI's default model, which a `/model` in an interactive session had changed that morning — attempts 1–3 orchestrated on fable-5. So $2.93 vs dry run 1's $3.92 is not a clean Sonnet-vs-Fable read; the like-for-like row (plan §6 item 3) is still owed · 1 permission denial, harmless and the allowlist working as designed: an agent tried a compound `git status && echo … && node -e …` line, which the exact-string allowlist refuses, and it recovered |

Rules that feed this table (plan §M5): a bug fix ships with a test or eval
case; friend feedback becomes a `/spec`; a `touches_prompt: true` spec gets
one eval run, read by a human against `evals/thresholds.json`.
