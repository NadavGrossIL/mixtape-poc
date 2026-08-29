# Playbook — run the factory on a spec

One spec with `status: ready` goes to a reviewed branch with no human in
between, and leaves a row in `docs/factory/RUNS.md`. The driver is
`scripts/factory-run.sh`; the line it runs is
`.claude/workflows/implement-from-spec.js` (Implement → Gate → Review,
`docs/factory/plan.md` M4a). Everything happens in a dedicated worktree,
`../mixtape-poc.wt`, cut fresh from `origin/main` for every run — dry run 1
showed why: uncommitted work in the tree reaches the reviewer's `git diff`
and fails the review for nothing, and a run launched from the main checkout
edits `main`.

1. **Preflight.** The spec has `status: ready` in its frontmatter (a human
   flips it, `specs/_template.md`), and the main checkout is clean —
   `git status --porcelain` empty. The script refuses otherwise (exit 2)
   and lists what to stash or commit. `origin` is fetched.
2. **Worktree.** `../mixtape-poc.wt` on branch `factory/NNNN-slug` from
   `origin/main`; a previous worktree at that path is removed first, a
   stale local branch of that name is deleted. `npm ci` runs in `server/`
   and `client/` — the gate needs both, and a real install (a second or two
   from the npm cache) keeps anything the implementer installs out of the
   main checkout.
3. **Trust, once.** Claude Code trusts workspaces per directory and ignores
   the repo's `permissions.allow` until the workspace has been trusted, which
   would park a headless run on the `Workflow(...)` approval card. The driver
   looks in `~/.claude.json` for the worktree's own `hasTrustDialogAccepted`
   first, then the repo's (the main checkout's entry): on 2.1.251 a worktree
   of a trusted repo shows no dialog and gets no entry of its own (measured
   2026-08-29 — the headless probe ran an allowlisted `git status` with no
   denial). Only when neither is trusted does the script stop (exit 3) and
   print the one-time fix: `cd <repo> && claude`, accept the dialog, quit,
   re-run.
4. **The command.** Composed from `factory.config.json`:

   ```sh
   claude -p '/implement-from-spec {"spec":"specs/NNNN-slug.md","config":{…}}' \
     --permission-mode acceptEdits --max-turns 60 --max-budget-usd 5 --output-format json
   ```

   `maxTurns`, `maxBudgetUsd`, `permissionMode` are the hard stop;
   `maxGateRounds`, `base`, `reviewer`, `implementModel` reach the script as
   `args.config`. `implementModel` sets the model of the implementer and its
   fix rounds only — the reviewer keeps the model in
   `.claude/agents/reviewer.md`. Stdout goes to
   `docs/factory/runs/<date>-NNNN.json` (small; not `evals/runs/`).
5. **The row.** After exit the script reads `total_cost_usd`, `num_turns`,
   `subtype` from that JSON and the run manifest from
   `~/.claude/projects/-Users-…-mixtape-poc.wt/<session>/workflows/wf_*.json`
   (the newest one started after launch), then appends one row: date · spec ·
   engine · attempts (implement / gate / review) · gate · review · outcome ·
   cost · run · notes. Outcome is `autonomous (ready-for-pr)` or
   `autonomous (ready-for-eval)` — the latter when the spec has
   `touches_prompt: true`, meaning the PR is owed one eval run read by a
   human against `evals/thresholds.json` — else `escalated: <reason>`, and
   the script exits 5 so a timer can notice.
6. **Then, by hand.** The script never commits, pushes or opens a PR; it
   prints the commands: commit in the worktree, `git push -u origin
   factory/NNNN-slug`, `gh pr create --draft --body-file
   docs/factory/runs/<date>-NNNN.pr.md` (a body the script generates from
   the row — the run table, a pre-merge checklist, PR #1's shape; a run
   that ended without a manifest falls back to the spec as body), and
   commit the ledger (`docs/factory/RUNS.md`, `docs/factory/runs/*`) on
   `main`.

   Two checks stand between that draft PR and the merge, and the script
   prints both: `/code-review factory/NNNN-slug since main` — the
   two-axis review, Standards against the repo's documented conventions
   plus a smell baseline, Spec against the originating spec — because the
   factory's reviewer judges the contract only and is told not to grade
   style, so this is the second opinion at the gate; and the spec's
   hand-checked bullets (its `### 3.` under `## Acceptance checks`), which
   are the spec's own browser checks and nobody has clicked them yet. The
   generated PR body carries both as `- [ ]` items.

## Before status: ready — /review-spec

The step before step 1. A spec is a draft until a human flips it, and the
hand-run panel of 2026-08-29 showed why the flip needs a check first: on a
carefully drafted spec it found 3 wrong claims and 16 must-adds
(`docs/reviews/0002-spec-panel-2026-08-29.md`). `/review-spec` is that
panel as a saved workflow, `.claude/workflows/review-spec.js` (Check →
Clarity → Craft → Apply, `docs/factory/plan.md` M3): the `spec-checker`
agent (`.claude/agents/spec-checker.md`, read-only, Sonnet) replays every
factual claim against the code and data; a clarity pass finds every place two
engineers would build different things and holds the acceptance checks
against the implementer's allowlist and the reviewer's rubric; a craft
pass judges structure, durability of snapshot-dependent claims, demo-able
metrics against `evals/thresholds.json` and scope for one run. Then an
Apply agent **edits the spec in place**: every wrong claim corrected, every
must-add inserted as written, `status:` left exactly as it was, and a
`## Panel review` section appended with the open decisions (recommendation
in brackets) and one line per fragile claim. The human resolves those
decisions when flipping to `status: ready`; the section stays in the spec
as the record. Result: `reviewed`, or `needs-human` when an agent returns
nothing or a wrong claim was left in the spec.

```sh
/review-spec specs/NNNN-slug.md                                  # in a session
claude -p '/review-spec specs/NNNN-slug.md' --max-turns 40 --max-budget-usd 3 --output-format json
claude -p '/review-spec {"spec":"specs/NNNN-slug.md","config":{"apply":false}}' …   # findings only, spec untouched
```

A saved workflow registers at session start: a session opened before the
script existed does not have `/review-spec` — start a new one. `config.apply:
false` returns the findings without editing; `config.checker` swaps the
fact-checker's agent type (default `spec-checker`).

The three files the workflow is made of are never-tier, so a human applies
them from the patched copy an agent prepares outside the repo:
`.claude/workflows/review-spec.js`, `.claude/agents/spec-checker.md`, and
`.claude/settings.json` (one more `permissions.allow` line,
`"Workflow(review-spec)"`). Then `node scripts/workflow-selftest.mjs` — it
carries the review-spec cases and runs them once the script is in place.

## Testing the driver without spending

```sh
scripts/factory-run.sh specs/NNNN-slug.md --dry-run
```

Runs steps 1–4 and prints the composed command and args; it creates the
worktree (remove it with `git worktree remove --force ../mixtape-poc.wt &&
git worktree prune`) but never launches `claude` and does not need trust.
`FACTORY_SKIP_PREFLIGHT=1` skips the status and clean-tree checks — for a
human testing the script against a toy spec from a dirty tree, never for a
run whose row is meant to say "autonomous".

## The never-tier rule

`.claude/workflows/implement-from-spec.js`, like everything under
`.claude/`, is never-tier: an agent cannot edit it, in any mode. A change to
the line — the JSON `args` form, the `implementModel` knob, the
`ready-for-eval` status — is prepared as a patched copy outside the repo and
applied by a human, then the stub simulation is rerun before the next run.
Before editing the script, and again after: `node scripts/workflow-selftest.mjs`
(also `npm run selftest:workflows`, and a step of `npm run gate`) drives the
line against stub agents — every status, retry and label the driver and the
console rely on, offline and free. `WORKFLOWS_DIR=<dir>` points it at a
patched copy outside the repo, test-only.
The driver itself, `scripts/factory-run.sh`, is free tier.
