#!/usr/bin/env bash
# The gate: every free check this repo has, cheapest first, stop at the
# first failure. `npm run gate` locally and the only job in ci.yml both run
# this, so the two can't drift (docs/factory/plan.md, M2). Evals are NOT
# here — they cost money and Spotify quota; selftest is the free part.
#
# Each step is the exact command CLAUDE.md documents, run from the same
# directory: ask-tier check → server typecheck → client typecheck → unit
# tests → evals selftest → workflow selftest (the never-tier factory line
# against stub agents, scripts/workflow-selftest.mjs) → client build. The
# build step is `vite build` alone because `tsc -b` already ran as the
# client typecheck. Step 0 is the ask tier (scripts/protected-check.sh):
# free, deterministic, and the one check permission rules can't do.
set -euo pipefail
cd "$(dirname "$0")/.."

GATE_START=$SECONDS
step() {
  local name=$1 dir=$2 cmd=$3
  local t0=$SECONDS
  printf '\n== gate: %s\n   (cd %s && %s)\n' "$name" "$dir" "$cmd"
  if ! (cd "$dir" && eval "$cmd"); then
    printf '\n== gate FAILED at "%s" after %ds (total %ds)\n' "$name" $((SECONDS - t0)) $((SECONDS - GATE_START))
    exit 1
  fi
  printf '== ok: %s (%ds)\n' "$name" $((SECONDS - t0))
}

step "ask-tier check"   .      "bash scripts/protected-check.sh"
step "server typecheck" server "npm run typecheck"
step "client typecheck" client "npm run typecheck"
step "unit tests"       server "node --test"
step "evals selftest"   .      "node evals/selftest.ts"
step "workflow selftest" .     "node scripts/workflow-selftest.mjs"
step "client build"     client "npx vite build"

printf '\n== gate passed in %ds\n' $((SECONDS - GATE_START))
