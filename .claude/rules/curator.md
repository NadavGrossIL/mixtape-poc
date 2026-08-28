---
paths:
  - "server/curator.ts"
---

# server/curator.ts

- `SYSTEM` (line ~289) is the curator prompt; `ADJUST_SYSTEM` extends it.
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
  streaming brace matcher, 61 cases) and `npm run typecheck`.
- `SEARCH_BUDGET` (20/run, cache hits free) and `SEARCH_CONCURRENCY` (2) exist
  because of the Spotify quota, not taste — `.claude/rules/spotify.md`.
