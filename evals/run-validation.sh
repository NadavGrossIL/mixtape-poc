#!/bin/bash
# One-shot validation run for the grounded-notes fix (layers 1+2, 928af80).
# Cache was wiped beforehand so every search row carries the new fields —
# this run spends ~90 live Spotify searches; do not run anything else against
# the quota today. Log goes to the gitignored baseline-logs dir.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=evals/baseline-logs/validation-2026-08-23.log
{
  echo "=== validation run $(date -u +%FT%TZ) on $(git rev-parse --short HEAD) ==="
  node evals/generate.ts || { echo "GENERATE FAILED rc=$?"; exit 1; }
  node evals/judge.ts    || { echo "JUDGE FAILED rc=$?"; exit 1; }
  node evals/aggregate.ts; echo "aggregate rc=$?"
  node evals/grounding.ts; echo "grounding rc=$?"
  echo "=== done $(date -u +%FT%TZ) ==="
} >> "$LOG" 2>&1
