#!/usr/bin/env bash
# The factory driver: one spec, one headless run, one row in RUNS.md
# (docs/factory/plan.md, M4a + M5; docs/playbooks/run-the-factory.md).
#
#   scripts/factory-run.sh specs/NNNN-slug.md [--dry-run]
#
# The run happens in a dedicated worktree, ../mixtape-poc.wt, cut fresh from
# origin/main every time. Two lessons from dry run 1 (2026-08-29) made that
# non-negotiable: uncommitted work in the tree reached the reviewer's
# `git diff` and produced a spurious fail, and a probe launched from the
# main checkout re-ran the spec on `main`. A worktree that starts clean has
# neither problem, and the main checkout is never the thing being edited.
#
# The worktree sits next to the repo so its Claude project slug
# (-Users-…-mixtape-poc-wt: every non-alphanumeric character of the cwd
# becomes `-`, the dot included — measured on dry run 2, 2026-08-29, 2.1.251)
# starts with the repo's; the console globs on that prefix and reads both
# the dashed and the dotted form. Claude Code trusts workspaces per
# directory and ignores the
# repo's `permissions.allow` until the workspace has been trusted once, which
# would put the Workflow(...) approval card in front of a headless run — so
# step 3 checks ~/.claude.json: the worktree's own entry first, then the
# repo's, because a worktree of a trusted repo inherits the trust (measured
# 2026-08-29 on 2.1.251: no dialog is shown, no entry is written for the
# worktree path, and a headless `claude -p` in it ran an allowlisted
# `git status` with no denial). It stops only when neither is trusted.
#
# The script never commits, pushes or opens a PR: a run ends with the
# branch in the worktree, a generated PR body in docs/factory/runs/, and the
# commands a human runs next — including the two pre-merge checks the line
# does not do (a /code-review for style and spec fit; the spec's hand-checked
# bullets, which nobody has clicked). Exit codes:
# 2 preflight, 3 not trusted, 4 claude produced no JSON, 5 the run escalated
# (the row says why), 0 autonomous.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WT="$(dirname "$ROOT")/$(basename "$ROOT").wt"
CONFIG="$ROOT/factory.config.json"
RUNS_MD="$ROOT/docs/factory/RUNS.md"
RUNS_DIR="$ROOT/docs/factory/runs"
CLAUDE_JSON="${HOME}/.claude.json"
PROJECTS_DIR="${HOME}/.claude/projects"

for tool in git node npm jq; do
  command -v "$tool" >/dev/null || { echo "factory-run: $tool not found" >&2; exit 2; }
done

say() { printf '\n== %s\n' "$*"; }

# --- helpers (sourceable: `source scripts/factory-run.sh` defines these and
# --- returns, so they can be exercised without a run) ------------------------

# The spec's hand checks, one per line: the `- ` bullets under the `### `
# heading of `## Acceptance checks` whose title says "Hand-checked" or
# "Post-review", else under its `### 3.` heading (the template's slot for
# what the gate cannot run). Wrapped bullet lines are joined. Nested bullets
# fold into their parent. No output = the spec has none.
hand_checks() {
  awk '
    /^## /  { acc = ($0 ~ /^## Acceptance checks/); key = ""; open = 0; next }
    acc && /^### / {
      key = ($0 ~ /Hand-checked|Post-review/) ? "named" : ($0 ~ /^### 3\./) ? "third" : ""
      open = 0; next
    }
    acc && key != "" {
      if ($0 ~ /^- /)                    { n[key]++; b[key, n[key]] = substr($0, 3); open = 1 }
      else if (open && $0 ~ /^ +[^ ]/)   { line = $0; sub(/^ +/, "", line); b[key, n[key]] = b[key, n[key]] " " line }
      else                               { open = 0 }
    }
    END {
      k = ("named" in n) ? "named" : "third"
      for (i = 1; i <= n[k]; i++) print b[k, i]
    }
  ' "$1"
}

# The PR body, to stdout. Reads the row's variables (NNNN SLUG SPEC BRANCH
# DATE PERMISSION_MODE MAX_TURNS MAX_BUDGET ATTEMPTS GATE REVIEW COST RUN
# IMPLEMENT_MODEL) and the spec's hand checks; the shape is PR #1's, so the
# next factory PR reads like the first. The two footer lines are PR #1's,
# verbatim.
pr_body() {
  local check
  cat <<EOF
Spec $NNNN: $SLUG — \`$SPEC\` through \`scripts/factory-run.sh\` on \`$BRANCH\`, no human between approval and review (row of $DATE in \`docs/factory/RUNS.md\`).

## Factory run

| | |
| --- | --- |
| workflow | \`/implement-from-spec\`, headless \`claude -p --permission-mode $PERMISSION_MODE --max-turns $MAX_TURNS --max-budget-usd $MAX_BUDGET\` |
| run | $RUN |
| attempts | implement / gate / review: $ATTEMPTS |
| gate | \`npm run gate\` $GATE |
| review | \`reviewer\`: $REVIEW |
| cost | \$$(printf '%.2f' "$COST") (\`total_cost_usd\`) |
EOF
  [ -n "$IMPLEMENT_MODEL" ] && echo "| implementModel | \`$IMPLEMENT_MODEL\` |"
  cat <<EOF

## Pre-merge, by a human

- [ ] \`/code-review $BRANCH since main\` — Standards (the repo's documented conventions plus the smell baseline) and Spec (against \`$SPEC\`); the factory reviewer judged the contract only and was told not to grade style
EOF
  local any=0
  while IFS= read -r check; do
    any=1; echo "- [ ] $check"
  done < <(hand_checks "$ROOT/$SPEC")
  [ "$any" = "1" ] || echo "- hand checks: (none in the spec)"
  cat <<'EOF'

Do not merge from the agent side — the merge is the human gate.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013gws7xggrmqNrtGmAJgxgV
EOF
}

# Sourced, not run: the helpers are defined, nothing else happens.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

# --- args --------------------------------------------------------------------

SPEC=""
DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '2,6p' "$0"; exit 0 ;;
    -*) echo "factory-run: unknown flag $a" >&2; exit 2 ;;
    *) SPEC=$a ;;
  esac
done
[ -n "$SPEC" ] || { echo "usage: scripts/factory-run.sh specs/NNNN-slug.md [--dry-run]" >&2; exit 2; }

# --- 1. preflight ------------------------------------------------------------

say "preflight: $SPEC"
if [[ ! "$SPEC" =~ ^specs/([0-9]{4})-([A-Za-z0-9_-]+)\.md$ ]]; then
  echo "   expected a path like specs/0001-slug.md" >&2; exit 2
fi
NNNN=${BASH_REMATCH[1]}
SLUG=${BASH_REMATCH[2]}
[ -f "$ROOT/$SPEC" ] || { echo "   $SPEC does not exist" >&2; exit 2; }

# The frontmatter is the block between the first two `---` lines; a trailing
# `# comment` on the status line is allowed by the template.
STATUS=$(sed -n '2,/^---$/p' "$ROOT/$SPEC" | grep -E '^status:' | head -1 | awk '{print $2}' || true)
echo "   status: ${STATUS:-<none>}"

# FACTORY_SKIP_PREFLIGHT=1 is for a human testing the driver (a --dry-run
# against a toy spec, a dirty tree while editing this script). Never set it
# for a real run: the status and clean-tree checks are what the row's
# "autonomous" claim rests on.
if [ "${FACTORY_SKIP_PREFLIGHT:-}" = "1" ]; then
  echo "   !! FACTORY_SKIP_PREFLIGHT=1 — status and clean-tree checks skipped by a human"
else
  if [ "$STATUS" != "ready" ]; then
    echo "   $SPEC has status: ${STATUS:-<none>}; the factory only runs a spec with status: ready" >&2
    exit 2
  fi
  DIRTY=$(git -C "$ROOT" status --porcelain)
  if [ -n "$DIRTY" ]; then
    echo "   the main checkout is not clean — stash or commit first; the reviewer diffs the working tree:" >&2
    printf '   %s\n' "$DIRTY" >&2
    exit 2
  fi
fi
git -C "$ROOT" fetch -q origin
echo "   origin/main: $(git -C "$ROOT" rev-parse --short origin/main)"

# --- 2. worktree -------------------------------------------------------------

BRANCH="factory/${NNNN}-${SLUG}"
say "worktree: $WT on $BRANCH (from origin/main)"
if git -C "$ROOT" worktree list --porcelain | grep -qx "worktree $WT"; then
  echo "   removing the previous worktree"
  git -C "$ROOT" worktree remove --force "$WT"
fi
git -C "$ROOT" worktree prune
if [ -e "$WT" ]; then
  # A directory git does not know about: it is not ours to delete.
  echo "   $WT exists but is not a registered worktree — remove it yourself, then re-run" >&2
  exit 2
fi
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "   deleting the stale local branch $BRANCH"
  git -C "$ROOT" branch -D "$BRANCH" >/dev/null
fi
git -C "$ROOT" worktree add -B "$BRANCH" "$WT" origin/main
echo "   $(git -C "$WT" log --oneline -1)"

# The gate (scripts/gate.sh) needs server/ and client/ node_modules: tsc,
# node --test, evals/selftest.ts (node built-ins only) and vite build. A real
# `npm ci` per worktree rather than a symlink to the main checkout: it is a
# second or two from the npm cache, and anything the implementer installs
# stays in the worktree instead of leaking into the main tree.
for dir in server client; do
  echo "   npm ci in $dir/"
  npm ci --prefix "$WT/$dir" --no-audit --no-fund --prefer-offline --loglevel=error
done

# --- 3. trust ----------------------------------------------------------------

say "trust: $WT"
# The worktree's own entry wins when it exists; otherwise the repo's entry
# counts, because a worktree of a trusted repo is trusted without a dialog
# or an entry of its own (2.1.251, measured 2026-08-29). Prints wt|root|no.
TRUSTED=$(node -e '
  const fs = require("fs"); const [file, wt, root] = process.argv.slice(1)
  let p = {}
  try { p = JSON.parse(fs.readFileSync(file, "utf8")).projects || {} } catch {}
  const ok = (dir) => !!p[dir] && p[dir].hasTrustDialogAccepted === true
  console.log(ok(wt) ? "wt" : ok(root) ? "root" : "no")
' "$CLAUDE_JSON" "$WT" "$ROOT")
case "$TRUSTED" in
  wt)   echo "   trusted (hasTrustDialogAccepted for the worktree in ~/.claude.json)" ;;
  root) echo "   trusted (inherited from $ROOT — a worktree of a trusted repo; measured 2026-08-29 on 2.1.251, no dialog is shown and no entry is written for the worktree path)" ;;
  *)
    echo "   NOT trusted: neither $WT nor $ROOT has hasTrustDialogAccepted in ~/.claude.json, so the repo's"
    echo "   permissions.allow is ignored and a headless run would stop at the Workflow(...) approval card."
    echo "   Once, by hand:  cd $ROOT && claude   — accept the trust dialog for the repo itself, quit, then re-run this script."
    echo "   If the run still stops on the Workflow(...) approval card after that, report it — that is the thing to fix."
    if [ "$DRY_RUN" = "1" ]; then
      echo "   (dry run: continuing; a real run would stop here with exit 3)"
    else
      exit 3
    fi
    ;;
esac

# --- 4. compose --------------------------------------------------------------

say "compose: from factory.config.json"
[ -f "$CONFIG" ] || { echo "   $CONFIG missing" >&2; exit 2; }
PERMISSION_MODE=$(jq -r '.permissionMode // "acceptEdits"' "$CONFIG")
MAX_TURNS=$(jq -r '.maxTurns // 60' "$CONFIG")
MAX_BUDGET=$(jq -r '.maxBudgetUsd // 5' "$CONFIG")
IMPLEMENT_MODEL=$(jq -r '.implementModel // empty' "$CONFIG")
# The whole config rides along as args.config; the script reads the keys it
# knows (maxGateRounds, base, reviewer, implementModel) and ignores the rest.
ARG=$(jq -c --arg spec "$SPEC" '{spec: $spec, config: .}' "$CONFIG")
CMD=(claude -p "/implement-from-spec $ARG" --permission-mode "$PERMISSION_MODE" --max-turns "$MAX_TURNS" --max-budget-usd "$MAX_BUDGET" --output-format json)
DATE=$(date +%F)
OUT="$RUNS_DIR/$DATE-$NNNN.json"
echo "   args: $ARG"
printf "   command (cwd %s):\n   claude -p '/implement-from-spec %s' --permission-mode %s --max-turns %s --max-budget-usd %s --output-format json\n" "$WT" "$ARG" "$PERMISSION_MODE" "$MAX_TURNS" "$MAX_BUDGET"
echo "   stdout → $OUT"

if [ "$DRY_RUN" = "1" ]; then
  say "dry run: stopping before launch. The worktree is in place; remove it with:"
  echo "   git worktree remove --force $WT && git worktree prune"
  exit 0
fi

# --- 5. run ------------------------------------------------------------------

command -v claude >/dev/null || { echo "factory-run: claude not found" >&2; exit 2; }
mkdir -p "$RUNS_DIR"
# `claude -p` waits at most 600 s for background tasks, and a Workflow runs
# as one. Dry run 2 (2026-08-29, 2.1.251, wf_0684802b-74d) hit it: implement
# on Sonnet took 6m49s, the line was killed in its Review phase ("Background
# tasks still running after 600s; terminating"), and claude still exited 0
# with subtype success, 2 turns and no manifest (dry run 1's 4.4 min never
# got near it). The message says "Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
# to wait indefinitely"; on 2.1.251 it does not — the binary computes
# `ceiling = env ?? 600000` and treats 0 as already exceeded, so it swept
# the workflow at once (attempt 2, wf_b0d5ee18-0a6: back in 15 s, subtype
# success, $0.35, the implement agent orphaned). The driver therefore passes
# a one-hour ceiling, comfortably above any line run; --max-turns and
# --max-budget-usd stay the hard stop. FACTORY_BG_WAIT_MS overrides it.
BG_WAIT_MS="${FACTORY_BG_WAIT_MS:-3600000}"
LAUNCH_MS=$(node -e 'console.log(Date.now())')
say "run: $(date '+%H:%M:%S') — max $MAX_TURNS turns, \$$MAX_BUDGET, bg-task ceiling $(( BG_WAIT_MS / 1000 ))s (FACTORY_BG_WAIT_MS)"
RC=0
(cd "$WT" && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="$BG_WAIT_MS" "${CMD[@]}" > "$OUT") || RC=$?
echo "   claude exited $RC after $(( ($(node -e 'console.log(Date.now())') - LAUNCH_MS) / 1000 ))s"

if ! jq -e 'type == "object"' "$OUT" >/dev/null 2>&1; then
  echo "   no JSON result in $OUT — nothing to record" >&2
  exit 4
fi
COST=$(jq -r '.total_cost_usd // 0' "$OUT")
TURNS=$(jq -r '.num_turns // 0' "$OUT")
SUBTYPE=$(jq -r '.subtype // "?"' "$OUT")
echo "   subtype: $SUBTYPE · turns: $TURNS · cost: \$$COST"

# The manifest is written at the end of the run under the worktree's project
# slug: the cwd with every non-alphanumeric character turned into `-`, the
# dot included (-Users-…-mixtape-poc-wt; dry run 2 wrote its journal there
# while the driver looked in …-mixtape-poc.wt). Both forms are searched, for
# safety. Newest manifest that started after we launched; when there is
# none but a journal (subagents/workflows/wf_*/journal.jsonl) is newer than
# the launch, the run was cut before the manifest and the journal is the
# evidence — its path rides along as `journal`.
WT_SLUG=$(printf '%s' "$WT" | tr -c 'A-Za-z0-9' '-')
WT_SLUG_DOTTED=$(printf '%s' "$WT" | tr '/' '-')
MANIFEST=$(node -e '
  const fs = require("fs"), path = require("path")
  const [since, ...dirs] = process.argv.slice(1)
  let best = null, journal = null
  for (const dir of dirs) {
    for (const session of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
      const wdir = path.join(dir, session, "workflows")
      for (const f of (fs.existsSync(wdir) ? fs.readdirSync(wdir) : [])) {
        if (!/^wf_.*\.json$/.test(f)) continue
        try {
          const m = JSON.parse(fs.readFileSync(path.join(wdir, f), "utf8"))
          if (Number(m.startTime) >= Number(since) && (!best || m.startTime > best.startTime)) best = { ...m, file: path.join(wdir, f) }
        } catch {}
      }
      const jdir = path.join(dir, session, "subagents", "workflows")
      for (const run of (fs.existsSync(jdir) ? fs.readdirSync(jdir) : [])) {
        const j = path.join(jdir, run, "journal.jsonl")
        if (!/^wf_/.test(run) || !fs.existsSync(j)) continue
        const mtime = fs.statSync(j).mtimeMs
        if (mtime < Number(since) || (journal && mtime <= journal.mtime)) continue
        const results = fs.readFileSync(j, "utf8").split("\n").filter((l) => /"type":"result"/.test(l)).length
        journal = { file: j, mtime, results }
      }
    }
  }
  if (!best) { process.stdout.write(JSON.stringify(journal ? { journal: journal.file, journalResults: journal.results } : {})); process.exit(0) }
  const r = best.result || {}
  const model = (label) => ((best.workflowProgress || []).find((p) => p.label && p.label.startsWith(label)) || {}).model || ""
  process.stdout.write(JSON.stringify({
    file: best.file, runId: best.runId || "", status: r.status || best.status || "",
    reason: r.reason || "", attempts: r.attempts || {}, gateOk: r.gate ? r.gate.ok : null, gateStep: r.gate ? r.gate.step : "",
    verdict: r.review ? r.review.verdict : "", findings: r.review && r.review.findings ? r.review.findings.length : null,
    agentCount: best.agentCount || 0, totalTokens: best.totalTokens || 0, durationMs: best.durationMs || 0,
    implementModel: model("implement"), reviewModel: model("review:"),
  }))
' "$LAUNCH_MS" "$PROJECTS_DIR/$WT_SLUG" "$PROJECTS_DIR/$WT_SLUG_DOTTED")

# --- the row -----------------------------------------------------------------

mf() { printf '%s' "$MANIFEST" | jq -r "$1"; }
if [ "$(mf 'has("runId")')" = "true" ]; then
  echo "   manifest: $(mf .file)"
  R_STATUS=$(mf .status); R_REASON=$(mf .reason)
  ATTEMPTS="$(mf '.attempts.implement // 0') / $(mf '.attempts.gate // 0') / $(mf '.attempts.review // 0')"
  case "$(mf .gateOk)" in
    true)  GATE="passed"; [ "$(mf '.attempts.gate // 0')" = "1" ] && GATE="passed (first run)" || GATE="passed (round $(mf .attempts.gate))" ;;
    false) GATE="failed at \"$(mf .gateStep)\"" ;;
    *)     GATE="—" ;;
  esac
  if [ -n "$(mf .verdict)" ]; then
    REVIEW="$(mf .verdict), $(mf .findings) findings"
    [ -n "$(mf .reviewModel)" ] && REVIEW="$REVIEW ($(mf .reviewModel))"
  else
    REVIEW="—"
  fi
  RUN="\`$(mf .runId)\` · $(mf .agentCount) agents · $(mf '.totalTokens / 1000 | round')k tok · $(mf '.durationMs / 6000 | round / 10') min"
else
  echo "   manifest: none found under $PROJECTS_DIR/$WT_SLUG (or $WT_SLUG_DOTTED) since launch (a budget/turn stop can end before the script returns)"
  [ -n "$(mf '.journal // empty')" ] && echo "   journal: $(mf .journal) ($(mf .journalResults) result lines — the run was cut before the manifest)"
  R_STATUS=""; R_REASON="claude result subtype $SUBTYPE, no workflow manifest"
  # The 600 s ceiling leaves no trace in $OUT but the result text: claude's
  # last turn says the workflow is "running in the background", then the
  # terminate message goes to stderr. That text plus no manifest is the signal.
  if jq -r '.result // ""' "$OUT" | grep -q 'running in the background'; then
    R_REASON="headless bg-task ceiling hit before the run ended (no manifest); see the journal"
  fi
  ATTEMPTS="— / — / —"; GATE="—"; REVIEW="—"; RUN="no manifest · $TURNS turns"
fi
case "$R_STATUS" in
  ready-for-pr|ready-for-eval) OUTCOME="autonomous ($R_STATUS)"; EXIT=0 ;;
  *) OUTCOME="escalated: ${R_REASON:-$R_STATUS}"; EXIT=5 ;;
esac
NOTES="driver: scripts/factory-run.sh, worktree $BRANCH"
[ -n "$IMPLEMENT_MODEL" ] && NOTES="implementModel: $IMPLEMENT_MODEL · $NOTES"
[ "$SUBTYPE" != "success" ] && NOTES="$NOTES · claude subtype $SUBTYPE"
ROW="| $DATE | $NNNN $SLUG | native \`/implement-from-spec\` | $ATTEMPTS | $GATE | $REVIEW | $OUTCOME | $(printf '%.2f' "$COST") | $RUN | $NOTES |"

# Insert after the last table row: the file has prose after the table.
node -e '
  const fs = require("fs"); const [file, row] = process.argv.slice(1)
  const lines = fs.readFileSync(file, "utf8").split("\n")
  let last = -1
  lines.forEach((l, i) => { if (/^\| \d{4}-\d{2}-\d{2} \|/.test(l)) last = i })
  if (last < 0) { lines.forEach((l, i) => { if (/^\| --- \|/.test(l)) last = i }) }
  if (last < 0) throw new Error("no table in " + file)
  lines.splice(last + 1, 0, row)
  fs.writeFileSync(file, lines.join("\n"))
' "$RUNS_MD" "$ROW"

say "row appended to docs/factory/RUNS.md"
echo "$ROW"
say "worktree: $WT"
echo "   $(git -C "$WT" log --oneline -1)"
git -C "$WT" status --short | sed 's/^/   /'
# The PR body: generated when the run got as far as a manifest (the table
# has something to say); a run that stopped earlier keeps the spec as body.
BODY=$SPEC
LEDGER="docs/factory/RUNS.md $OUT"
if [ "$(mf 'has("runId")')" = "true" ]; then
  PR_MD="$RUNS_DIR/$DATE-$NNNN.pr.md"
  pr_body > "$PR_MD"
  BODY=$PR_MD; LEDGER="$LEDGER $PR_MD"
  say "PR body written to $PR_MD"
fi

say "next, by a human:"
echo "   git -C $WT add -A && git -C $WT commit -m 'Spec $NNNN: $SLUG (factory)'"
echo "   git -C $WT push -u origin $BRANCH"
echo "   gh pr create --draft --head $BRANCH --title 'Spec $NNNN: $SLUG' --body-file $BODY"
echo "   git add $LEDGER   # the ledger, committed on main"
say "pre-merge, by a human — the factory reviewer judged the contract, not style, and nobody has clicked the browser checks:"
echo "   1. /code-review $BRANCH since main"
echo "      Standards (the repo's documented conventions + smell baseline) and Spec (against $SPEC)"
echo "   2. the spec's hand checks:"
if [ -n "$(hand_checks "$ROOT/$SPEC")" ]; then
  hand_checks "$ROOT/$SPEC" | sed 's/^/      - /'
else
  echo "      (none in the spec)"
fi
exit $EXIT
