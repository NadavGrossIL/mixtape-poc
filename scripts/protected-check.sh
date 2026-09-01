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

# What is in the tier, and why:
#
#   server/{session,caps,env,spotify}.ts — identity, caps, tokens. A wrong
#     line here spends money or leaks a credential.
#   scripts/**  — `npm run gate` is the ONE command the factory's Bash
#     allowlist admits, and it runs scripts/gate.sh, which is otherwise free
#     tier. An agent with acceptEdits could append a line to gate.sh and get
#     an arbitrary shell out of the one allowed command — including `cat
#     server/.env`. The same edit disables this check, since gate.sh is what
#     calls it. So the whole directory is ask tier: it is the escape hatch.
#   package.json (any of them) — the same hole one level up. gate.sh runs
#     `npm run typecheck` in server/ and client/, and `npm run gate` itself
#     is a root script; whoever writes an npm script the gate invokes writes
#     a shell command the allowlist then runs. Dependency bumps trip this
#     too. That is the price of closing the escape.
#   factory.config.json — sets the NEXT run's permissionMode and budget. An
#     agent that can edit it can widen its own permissions for the run after
#     this one, which no in-run check would ever see.
#
# This is only half the fix: the permission rules in .claude/settings.json
# (never tier, human-edited) still list the narrow set. This check is the
# deterministic half, and it is the half that actually catches a Bash
# redirect.
ASK_TIER='^(server/(session|caps|env|spotify)\.ts|scripts/.*|factory\.config\.json|([^/]+/)*package\.json)$'

if [ "${FACTORY_ASK_OK:-}" = "1" ]; then
  echo "== ask-tier check skipped by a human (FACTORY_ASK_OK=1)"
  exit 0
fi

base=$(git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | sort -u | grep -E "$ASK_TIER" || true)

if [ -n "$changed" ]; then
  printf '== ask-tier files changed since %s — a human must approve:\n' "$(git rev-parse --short "$base")"
  # One line per file, but quoted: bare $changed word-splits and globs, so a
  # filename with a space or a `*` in it would print wrong (or expand against
  # the working tree). The loop keeps the per-line output the split gave us.
  printf '%s\n' "$changed" | while IFS= read -r f; do printf '   %s\n' "$f"; done
  printf '   (FACTORY_ASK_OK=1 npm run gate, once you have read the diff)\n'
  exit 1
fi
echo "== ok: no ask-tier files changed since $(git rev-parse --short "$base")"
