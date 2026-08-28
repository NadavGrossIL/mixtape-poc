#!/usr/bin/env bash
# Gate step 0 — the ask tier, deterministically.
#
# Permission ask rules stop the Edit tool only. A Bash redirect such as
# `printf '\n' >> server/caps.ts` walked straight past them in auto and
# acceptEdits mode, and a `Bash(*caps.ts*)` rule never matched (measured
# 2026-08-28, docs/factory/plan.md M2). So the gate reads the diff itself:
# if any ask-tier file differs from origin/main, or is changed in the
# working tree, the gate fails and a human decides. A human passes it with
# FACTORY_ASK_OK=1. The factory agent cannot: its Bash allowlist admits
# `npm run gate` verbatim and nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."

ASK_TIER='^server/(session|caps|env|spotify)\.ts$'

if [ "${FACTORY_ASK_OK:-}" = "1" ]; then
  echo "== ask-tier check skipped by a human (FACTORY_ASK_OK=1)"
  exit 0
fi

base=$(git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | sort -u | grep -E "$ASK_TIER" || true)

if [ -n "$changed" ]; then
  printf '== ask-tier files changed since %s — a human must approve:\n' "$(git rev-parse --short "$base")"
  printf '   %s\n' $changed
  printf '   (FACTORY_ASK_OK=1 npm run gate, once you have read the diff)\n'
  exit 1
fi
echo "== ok: no ask-tier files changed since $(git rev-parse --short "$base")"
