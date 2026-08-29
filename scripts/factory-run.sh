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
# (-Users-…-mixtape-poc.wt) starts with the repo's; the console globs on
# that prefix. Claude Code trusts workspaces per directory and ignores the
# repo's `permissions.allow` until the worktree has been trusted once, which
# would put the Workflow(...) approval card in front of a headless run — so
# step 3 checks ~/.claude.json and stops, rather than guessing.
#
# The script never commits, pushes or opens a PR: a run ends with the
# branch in the worktree and the commands a human runs next. Exit codes:
# 2 preflight, 3 not trusted, 4 claude produced no JSON, 5 the run escalated
# (the row says why), 0 autonomous.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WT="$(dirname "$ROOT")/$(basename "$ROOT").wt"
CONFIG="$ROOT/factory.config.json"
RUNS_MD="$ROOT/docs/factory/RUNS.md"
RUNS_DIR="$ROOT/docs/factory/runs"
CLAUDE_JSON="${HOME}/.claude.json"
PROJECTS_DIR="${HOME}/.claude/projects"

for tool in git node npm jq; do
  command -v "$tool" >/dev/null || { echo "factory-run: $tool not found" >&2; exit 2; }
done

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

say() { printf '\n== %s\n' "$*"; }

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
TRUSTED=$(node -e '
  const fs = require("fs"); const [file, dir] = process.argv.slice(1)
  let ok = false
  try { const p = JSON.parse(fs.readFileSync(file, "utf8")).projects || {}; ok = p[dir] && p[dir].hasTrustDialogAccepted === true } catch {}
  console.log(ok ? "yes" : "no")
' "$CLAUDE_JSON" "$WT")
if [ "$TRUSTED" = "yes" ]; then
  echo "   trusted (hasTrustDialogAccepted in ~/.claude.json)"
else
  echo "   NOT trusted: the worktree's permissions.allow is ignored, so a headless run would stop at the Workflow(...) approval card."
  echo "   Once, by hand:  cd $WT && claude   — accept the trust dialog, quit, then re-run this script."
  if [ "$DRY_RUN" = "1" ]; then
    echo "   (dry run: continuing; a real run would stop here with exit 3)"
  else
    exit 3
  fi
fi

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
LAUNCH_MS=$(node -e 'console.log(Date.now())')
say "run: $(date '+%H:%M:%S') — max $MAX_TURNS turns, \$$MAX_BUDGET"
RC=0
(cd "$WT" && "${CMD[@]}" > "$OUT") || RC=$?
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
# slug (cwd with / → -). Newest one that started after we launched.
WT_SLUG=$(printf '%s' "$WT" | tr '/' '-')
MANIFEST=$(node -e '
  const fs = require("fs"), path = require("path")
  const [dir, since] = process.argv.slice(1)
  let best = null
  for (const session of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    const wdir = path.join(dir, session, "workflows")
    if (!fs.existsSync(wdir)) continue
    for (const f of fs.readdirSync(wdir)) {
      if (!/^wf_.*\.json$/.test(f)) continue
      try {
        const m = JSON.parse(fs.readFileSync(path.join(wdir, f), "utf8"))
        if (Number(m.startTime) >= Number(since) && (!best || m.startTime > best.startTime)) best = { ...m, file: path.join(wdir, f) }
      } catch {}
    }
  }
  if (!best) { process.stdout.write("{}"); process.exit(0) }
  const r = best.result || {}
  const model = (label) => ((best.workflowProgress || []).find((p) => p.label && p.label.startsWith(label)) || {}).model || ""
  process.stdout.write(JSON.stringify({
    file: best.file, runId: best.runId || "", status: r.status || best.status || "",
    reason: r.reason || "", attempts: r.attempts || {}, gateOk: r.gate ? r.gate.ok : null, gateStep: r.gate ? r.gate.step : "",
    verdict: r.review ? r.review.verdict : "", findings: r.review && r.review.findings ? r.review.findings.length : null,
    agentCount: best.agentCount || 0, totalTokens: best.totalTokens || 0, durationMs: best.durationMs || 0,
    implementModel: model("implement"), reviewModel: model("review:"),
  }))
' "$PROJECTS_DIR/$WT_SLUG" "$LAUNCH_MS")

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
  echo "   manifest: none found under $PROJECTS_DIR/$WT_SLUG since launch (a budget/turn stop can end before the script returns)"
  R_STATUS=""; R_REASON="claude result subtype $SUBTYPE, no workflow manifest"
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
say "next, by a human:"
echo "   git -C $WT add -A && git -C $WT commit -m 'Spec $NNNN: $SLUG (factory)'"
echo "   git -C $WT push -u origin $BRANCH"
echo "   gh pr create --draft --head $BRANCH --title 'Spec $NNNN: $SLUG' --body-file $SPEC"
echo "   git add docs/factory/RUNS.md $OUT   # the ledger, committed on main"
exit $EXIT
