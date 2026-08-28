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

Layout: `src/graph/` turns a script or YAML into nodes and edges, overlays a run's
`workflowProgress` by label, and lays phases out as swimlanes with dagre; `src/ui/`
is the Workflows screen, the Canvas, the run rail, the replay scrubber and a
read-only node panel. All CSS lives in `src/styles.css`.

Rules: local only. It reads `~/.claude`, so it is never deployed and is not part of
the product build. It never starts a run — starting is `claude -p` or Archon; this
page only watches. Every manifest field is optional and shows "—" when missing.
