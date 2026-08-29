# Mixtape factory console

A local page that draws the feature factory's workflows as a graph and replays
their runs. It reads two things and writes nothing:

- workflow definitions in this repo — `.claude/workflows/*.js`,
  `.claude/skills/*/SKILL.md`, `.archon/workflows/*.yaml`
- run records Claude Code writes under `~/.claude/projects/<repo-slug>/`
  (`<session>/workflows/wf_*.json` manifests and the agent transcripts next to them)

When neither exists yet, it shows the fixtures in `fixtures/` (flagged "fixture").

```sh
cd tools/console
npm install
npm run dev        # http://127.0.0.1:5174
npm run build      # typecheck (tsc --noEmit) + vite build, nothing is deployed
npm run fixtures   # regenerate the redacted fixture from the real run on this machine
```

Endpoints (served by the Vite dev-server plugin in `src/plugin.ts`, GET only):

- `/api/workflows` — `[{ name, engine, kind, path, source }]`
- `/api/runs` — manifests newest first, without `script`/`args` (`?full=1` includes them)
- `/api/runs/:runId/agents/:agentId` — `{ prompt, result, events }` from the transcript (404 for fixtures)
- `/api/meta` — which projects directory is being read (`CONSOLE_PROJECTS_DIR` overrides `~/.claude/projects`)
- `/api/events` — Server-Sent Events; `data:` lines are `{ kind: 'runs' }` (a manifest or
  copied script changed), `{ kind: 'journal', runId }` (a journal or agent transcript grew),
  `{ kind: 'workflows' }` (a definition file changed). `fs.watch` recursive on the projects
  dir and the three definition dirs, polling every 2 s where watch is unavailable, batched
  into 300 ms windows, `: ping` every 15 s. Watchers start with the first subscriber and
  stop with the last.

Live runs. The manifest is written only when the run ends (measured 2026-08-29 on
`wf_9fda3778-dbf`: journal at 09:43:38, manifest at 09:48:00, nothing in between; a
`--max-budget-usd` stop writes one with `status: killed`), so `/api/runs` also reads
`<session>/subagents/workflows/wf_*/journal.jsonl` (`started` / `result` per agent, no
timestamps or labels) and the `agent-*.jsonl` transcripts next to it (timestamps, model,
usage, tool calls, the prompt). The derived record has `status: 'running'` (`'stale'` once
nothing moved for 15 min), agents in state `running` / `done` / `error`, and the workflow
name from the copied `workflows/scripts/<name>-<runId>.js` when the journal has none;
without that, labels fall back to the prompt's first line. Merge rule per runId: a manifest
with a terminal status (`completed` / `failed` / `error` / `cancelled`) is final; otherwise
the journal is overlaid — the journal wins for an agent's `state` and `lastProgressAt`, the
manifest wins for everything else it knows, totals are recomputed. Every record says where
it came from (`source: 'manifest' | 'journal' | 'merged'`) and whether it is `live`.

Layout: `src/graph/` turns a script or YAML into nodes and edges, overlays a run's
`workflowProgress` by label, and lays phases out as swimlanes with dagre; `src/ui/`
is the Workflows screen, the Canvas, the run rail, the replay scrubber and a
read-only node panel. The page keeps one `EventSource` open and refetches on each
event; a live run follows "now" and the scrubber is offered once it finishes.
All CSS lives in `src/styles.css`.

Rules: local only. It reads `~/.claude`, so it is never deployed and is not part of
the product build. It never starts a run — starting is `claude -p` or Archon; this
page only watches. Every manifest field is optional and shows "—" when missing.
