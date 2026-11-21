---
paths:
  - "server/curator.ts"
  - "server/lc/**"
  - "server/curatorLoader.ts"
---

# The curator: server/curator.ts (rules) + server/lc/ (the agent)

- Since 2026-11-21 the only curator is the LangChain/LangGraph agent in
  `server/lc/curator-lc.ts`. `server/curator.ts` no longer calls a model: it
  holds the rules the agent runs — `SYSTEM`, the two tool definitions
  (`SEARCH_TOOL`, `CURATOR_TOOL`), the fences, the card check, the limits. The
  hand-written Anthropic SDK loop, `adjust_mixtape` and `ADJUST_SYSTEM` are
  gone (git history, before PR #24).
- What the model reads about its tools is defined ONCE, in `curator.ts`. The
  LangChain tools pass those definitions through untouched
  (`extras.providerToolDefinition`), so `strict` and `eager_input_streaming`
  ride along. The zod schemas in `curator-lc.ts` are only LangChain's argument
  check — editing a description there changes nothing the model sees.
  `test/lcCurator.test.ts` pins the wire format.
- Cross-read prompt against schema: a schema can forbid what the prompt
  demands (`d69f4bb`). An adjust uses the same `SYSTEM`; its extra rules are in
  the message built by `adjustMessage` in `server/lc/cardDiff.ts`.
- `tracks` is an object with eight required keys, not an array — see
  `docs/decisions/0001-keyed-object-over-array-in-tool-schema.md`. Strict
  tool use silently drops `minItems`; `required` is compiled. Don't revert.
- Delivery stays a non-forced tool. Measured: `responseFormat:
  providerStrategy(...)` delivered 3 of 6, twice; `toolStrategy` forces tool
  choice every round, which newer Claude models reject with a 400.
- Anything the model is sent — `SYSTEM`, a tool definition, `adjustMessage`,
  the last-round note, `MODEL` — is a prompt change: **one** eval run,
  human-read, never a loop: `docs/playbooks/change-the-curator-prompt.md`.
  Measured cost of that run: judge ≈ $1.18/card, $12.95 for 11 cards,
  ~3 min/card wall clock, and ~90 live Spotify searches — the day's whole
  quota. A change to the agent's plumbing (loop, streaming, memory, limits)
  instead needs `node evals/reliability.ts --trials 2` (6 live runs, about 50
  cents): one passing run proves nothing.
- Free checks first: `cd server && node --test test/curator.test.ts
  test/lc*.test.ts` (the streaming brace matcher, and the agent end to end
  with a fake model) and `npm run typecheck`.
- `index.ts` must load the agent through `curatorLoader.ts`, never import it
  directly: the LangSmith tracing guard has to run before any LangChain module
  loads. On a deployed host tracing is forced off unless
  `LANGSMITH_TRACE_VISITORS=1`.
- `SEARCH_BUDGET` (20) and `SEARCH_CONCURRENCY` (2) exist because of the
  Spotify quota, not taste — `.claude/rules/spotify.md`. Since 2026-09-01 the
  20 is only the agent's SHARE of a request-scoped allowance of 30
  (`REQUEST_SEARCH_BUDGET` in `index.ts`, built by `server/searchBudget.ts`)
  that the agent and track resolution spend from together
  (`server/lc/searchStep.ts`). Resolution used to be uncounted, which is how a
  worst-case run reached ~44 searches against a documented 8-20 and could trip
  the quota breaker for everyone. Cache hits are still free to both.
- `server/lc/first-agent.ts`, `card-agent.ts`, `press-agent.ts` are lesson
  files. Leave them; never wire them into the app.
