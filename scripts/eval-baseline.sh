#!/bin/bash
# One-shot eval baseline: the first real numbers this harness has ever produced.
#
# Ordered by what matters most, because the Spotify daily quota is the binding
# constraint — roughly 10-30 curator runs per day across ALL clients (local dev,
# Railway, and evals share one per-developer-account bucket). Truthfulness runs
# first because it is the POC's kill-condition question; reliability runs on
# whatever quota is left. A stage that dies does NOT stop the ones after it,
# so a quota death late in the run still leaves the earlier results on disk.
#
# Deliberately NOT run under `set -e`: every stage's exit code is captured and
# reported instead, since a failed stage here is data (usually "quota gone"),
# not a reason to lose the stages that already succeeded.
#
# Scheduled by ~/Library/LaunchAgents/com.nadav.mixtape-eval-baseline.plist.
# Run it by hand any time: bash scripts/eval-baseline.sh

REPO="/Users/nadavgross/Projects/mixtape-poc"
NODE="/opt/homebrew/bin/node"
LOG_DIR="$REPO/evals/baseline-logs"
STAMP="$(date +%Y-%m-%d_%H%M)"
LOG="$LOG_DIR/baseline-$STAMP.log"

mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1

exec >> "$LOG" 2>&1

say() { echo "[$(date '+%H:%M:%S')] $*"; }

say "=== eval baseline start ==="
say "node $($NODE -v), repo $REPO"

# --- Preflight -------------------------------------------------------------
# One cheap Spotify call decides whether ANY of this is worth paying for. Every
# curator run needs the search tool, and a quota error aborts the whole run
# (curator.ts: `if (err.quotaExceeded) throw err`) — so without quota, every
# stage below would burn Anthropic tokens to produce nothing.
say "preflight: probing Spotify quota..."
$NODE --input-type=module -e "
import('./evals/util.ts').then(async (u) => {
  u.loadServerEnv();
  const s = await import('./server/spotify.ts');
  if (!s.credentialsConfigured() || !s.isLoggedIn()) { console.log('PREFLIGHT: not logged in'); process.exit(2); }
  try { await s.searchCatalog('Adele Hello'); console.log('PREFLIGHT: quota OK'); process.exit(0); }
  catch (e) { console.log('PREFLIGHT: ' + e.message); process.exit(3); }
});"
PRE=$?
if [ $PRE -ne 0 ]; then
  say "preflight FAILED (exit $PRE) — spending nothing. Re-run by hand once quota clears:"
  say "  bash scripts/eval-baseline.sh"
  say "=== eval baseline aborted ==="
  exit $PRE
fi

# --- 1. Truthfulness: do the liner notes tell the truth? -------------------
say "stage 1/4: generate (6 prompts, real curator + Spotify resolution)"
$NODE evals/generate.ts --limit 6
G=$?; say "stage 1 exit=$G"

say "stage 2/4: judge (Opus + web search fact-check)"
$NODE evals/judge.ts
J=$?; say "stage 2 exit=$J"

say "stage 3/4: aggregate (rates + threshold gate)"
$NODE evals/aggregate.ts
A=$?; say "stage 3 exit=$A  (exit 1 here means a THRESHOLD BREACH, not a crash)"

# --- 2. Reliability: does the agent obey its own output contract? ----------
# Whatever quota survived stage 1. One prompt x 5 trials keeps this inside the
# budget; widen with --trials/--limit by hand on a fresh quota day.
say "stage 4/4: reliability (1 prompt x 5 trials, pass^k)"
$NODE evals/reliability.ts --only app-fastest-rap --trials 5
R=$?; say "stage 4 exit=$R"

say "=== eval baseline done: generate=$G judge=$J aggregate=$A reliability=$R ==="
say "results: $REPO/evals/runs/  |  this log: $LOG"
say "next: put the measured numbers into evals/thresholds.json so they become gates"

# --- Self-disable ----------------------------------------------------------
# This is a ONE-SHOT baseline, but it is scheduled daily so that a Mac asleep
# at 10:30 (or a quota that has not cleared yet) simply retries tomorrow. Once
# the stages have actually run, the schedule must go — an eval suite that
# quietly re-bills every morning is a bug, not a feature. Preflight failures
# exit long before this line, so they keep their retry.
PLIST="$HOME/Library/LaunchAgents/com.nadav.mixtape-eval-baseline.plist"
if [ -f "$PLIST" ]; then
  # Order matters, and it bit us on the first run: `launchctl bootout` of the
  # job you are RUNNING INSIDE kills your own process group, so anything after
  # it never happens. On 2026-08-17 that left the plist on disk with the job
  # unloaded — invisible until the next login, when launchd would reload it and
  # silently re-bill a 3.5h eval. So remove the file and log FIRST; bootout is
  # last precisely because it does not return.
  rm -f "$PLIST"
  say "schedule removed — this was a one-shot. Re-run by hand: bash scripts/eval-baseline.sh"
  launchctl bootout "gui/$(id -u)/com.nadav.mixtape-eval-baseline" 2>/dev/null
fi
