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
   the repo's `permissions.allow` until the worktree has been trusted, which
   would park a headless run on the `Workflow(...)` approval card. If
   `~/.claude.json` has no `hasTrustDialogAccepted` for the worktree path
   the script stops (exit 3) and prints the one-time fix:
   `cd ../mixtape-poc.wt && claude`, accept the dialog, quit, re-run. The
   trust entry survives the worktree being removed and recreated at the
   same path.
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
   factory/NNNN-slug`, `gh pr create --draft`, and commit the ledger
   (`docs/factory/RUNS.md`, `docs/factory/runs/*.json`) on `main`.

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
