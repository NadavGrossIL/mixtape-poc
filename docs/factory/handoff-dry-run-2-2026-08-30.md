# Handoff — finish dry run 2 (spec 0002), 2026-08-30

Paste the block below as the first message of a new session, started in this
repo on `main` (at `ea7688d` or later, the RUNS.md row for attempt 3).

---

Continue the Mixtape feature factory from where the 2026-08-29/30 session
stopped. Read first, in this order: the memory file mixtape-feature-factory.md
(recalled automatically), docs/factory/plan.md sections 4, M3–M5, 6 and 11
(every "Verified" block is measured fact — respect it),
docs/playbooks/run-the-factory.md, docs/factory/RUNS.md (three rows),
CLAUDE.md, .claude/settings.json, .claude/workflows/*.js, .claude/agents/*.md,
scripts/factory-run.sh, docs/factory/runs/2026-08-29-0002-attempt3.diff.

State on main: M1–M5 done · console C1–C4 + UX pass 1 (PR #2, merged 20:39Z,
`48a0af4`; console only) · `specs/0002-album-position-gate-blind-spots.md` is
`status: ready` — reviewed by `/review-spec` (`wf_48b9d383-e37`, its first
real run) and by the hand panel, all seven decisions resolved and written in
(`41d5884`, `d1b15f3`) · dry run 2 has run three times without an autonomous
row (RUNS.md rows 2–3): attempt 1 cut by `claude -p`'s 600 s background
ceiling in Review, attempt 2 swept at once by that ceiling set to 0, attempt 3
(`wf_66ec6c31-e3f`, $2.74) reached Review and the account session limit
ended it ("You've hit your session limit · resets 4:40pm"). All three driver
defects are fixed on main (`f4a39e1`, `084e1a0`, `e0a0d42`): trust falls back
to the repo's entry, a one-hour ceiling, the dashed project slug, a journal
line when a run ends without a manifest. Attempt 3's implementation sits
uncommitted in the worktree `../mixtape-poc.wt` (branch
`factory/0002-album-position-gate-blind-spots` at `e0a0d42`): gate passes,
125/125 tests, faithful to the spec on a read of the whole diff — the next
driver run WIPES that worktree; the diff is saved as
`docs/factory/runs/2026-08-29-0002-attempt3.diff`. A second worktree,
`../mixtape-poc.main`, was the previous session's main-branch desk while the
main checkout sat on `console/ux-pass-1`; it is disposable.

Measured facts the next run depends on (details in the plan's M5 block):
- A full line run on Sonnet takes ~10 min wall clock and ~180k subagent
  tokens; the account's 5-hour window can end it mid-Review. Check the
  window before launching (a fresh window, or well after the last reset).
- The auto-mode classifier blocks the agent from committing
  `scripts/factory-run.sh` and from launching it. The human runs both, as
  `!` lines: `! git commit -qam '…' && git push -q` and
  `! scripts/factory-run.sh specs/0002-album-position-gate-blind-spots.md`.
  The `!` line moves to the background after 120 s and the agent is
  notified with the full output when it ends.
- The driver needs a clean main checkout (untracked files count) and
  writes `docs/factory/RUNS.md` + `docs/factory/runs/<date>-0002.{json,pr.md}`
  into that checkout at the end; the agent moves them into a commit on main.
- Sonnet implements this spec in ~6.7 min / ≈$2.5; it writes all eight tests
  and the code together ("green on the first run"), not red-then-green per
  slice as the spec asks — a point for the pre-merge `/code-review`.

Do, in order, committing and pushing to main after each verified stage:
1. Housekeeping: `git checkout main` in the main checkout if it is still on
   `console/ux-pass-1` (merged), `git worktree remove ../mixtape-poc.main`
   (commit anything left there first), `git worktree prune`. Leave
   `../mixtape-poc.wt` alone until step 2 decides.
2. Finish dry run 2 — Nadav picks A or B when asked:
   A. **Re-run the line** (recommended when the session window allows):
      confirm the tree is clean and the window is fresh, then hand Nadav the
      `!` driver line. Expected end state: `ready-for-eval`, implementer on
      Sonnet. Validate the branch yourself (read the diff, run `npm run gate`
      in the worktree, count the tests) before the PR; the driver prints the
      PR command and the two pre-merge checks. Record the cost delta vs dry
      run 1 ($3.92, Fable) in the row's notes.
   B. **Salvage attempt 3** (~$0.5): keep the worktree as it is, run only
      the reviewer headless in it —
      `cd ../mixtape-poc.wt && claude -p '/review specs/0002-album-position-gate-blind-spots.md' --max-turns 20 --max-budget-usd 1 --output-format json`
      — and write the row by hand as "escalated at Review (session limit);
      reviewed by hand, verdict …". Not an autonomous row.
3. If the run escalates again, stop and report the reason with the manifest
   (`~/.claude/projects/-Users-nadavgross-Projects-mixtape-poc-wt/<session>/workflows/wf_*.json`)
   and journal evidence (`…/subagents/workflows/wf_*/journal.jsonl` and the
   `agent-*.jsonl` next to it — `workflowProgress[].error` names a session
   limit when that is the cause).
4. Do NOT merge, do NOT run the eval leg — both are Nadav's; the PR body the
   driver writes carries the `/code-review … since main` line and the spec's
   hand checks (none for this spec).
5. Update the memory file and the plan's Verified blocks (M5 row count and
   the eval-case half of its done-when, §6 dry run 2 result and the
   like-for-like Sonnet vs Fable row) when done.

Rules, unchanged: subagents implement, you orchestrate and validate every
stage yourself before committing; sequential agents, no parallel fan-outs
(read-only review panels excepted); never run paid evals; never edit
never-tier files — stage them at the repo root and give a short `! mv` or
`! cp -R` line; never add a broad Bash(*) allow; report failures as failures.
Costs: headless spend on 2026-08-29 was $6.61 (probe $0.26 + attempts $3.26,
$0.35, $2.74); tell Nadav the session total at the end. Stop for Nadav only
at: the A/B choice, the `!` lines he must run, an escalation, and the PR.
