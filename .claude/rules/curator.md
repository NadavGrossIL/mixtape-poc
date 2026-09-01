---
paths:
  - "server/curator.ts"
---

# server/curator.ts

- `SYSTEM` (line ~345) is the curator prompt; `ADJUST_SYSTEM` extends it.
  The tool schemas (`create_mixtape`, `adjust_mixtape`) are in this file too.
  Cross-read prompt against schema: a schema can forbid what the prompt
  demands (`d69f4bb` — adjust replacements could not carry a `ref`).
- `tracks` is an object with eight required keys, not an array — see
  `docs/decisions/0001-keyed-object-over-array-in-tool-schema.md`. Strict
  tool use silently drops `minItems`; `required` is compiled. Don't revert.
- A prompt or `MODEL` change means **one** eval run, human-read, never a
  loop: `docs/playbooks/change-the-curator-prompt.md`. Measured cost of that
  run: judge ≈ $1.18/card, $12.95 for 11 cards, ~3 min/card wall clock, and
  ~90 live Spotify searches — the day's whole quota.
- Free checks first: `cd server && node --test test/curator.test.ts` (the
  streaming brace matcher, 83 cases) and `npm run typecheck`.
- `SEARCH_BUDGET` (20) and `SEARCH_CONCURRENCY` (2) exist because of the
  Spotify quota, not taste — `.claude/rules/spotify.md`. Since 2026-09-01 the
  20 is only the agent loop's SHARE of a request-scoped allowance of 30
  (`REQUEST_SEARCH_BUDGET` in `index.ts`, built by `server/searchBudget.ts`)
  that the loop and track resolution spend from together. Resolution used to
  be uncounted, which is how a worst-case run reached ~44 searches against a
  documented 8-20 and could trip the quota breaker for everyone. Cache hits
  are still free to both.
