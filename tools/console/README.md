# Mixtape factory console

A local page that draws the feature factory's workflows as a graph, replays
their runs, and edits the files the line is made of. It reads two things:

- workflow definitions in this repo — `.claude/workflows/*.js`,
  `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.archon/workflows/*.yaml`
- run records Claude Code writes under `~/.claude/projects/<repo-slug>/`
  (`<session>/workflows/wf_*.json` manifests and the agent transcripts next to them),
  and under every sibling dir named `<repo-slug>.x` or `<repo-slug>-x` — the driver
  (`scripts/factory-run.sh`) runs in a worktree at `../mixtape-poc.wt`, whose slug is
  the repo's plus `.wt`. Each run says which (`projectSlug`); the page tags a
  worktree run `wt`.
- the ledger, `docs/factory/RUNS.md` (cost per run — the manifest never has it)

When neither exists yet, it shows the fixtures in `fixtures/` (flagged "fixture").

```sh
cd tools/console
npm install
npm run dev        # http://127.0.0.1:5174
npm run build      # typecheck (tsc --noEmit) + vite build, nothing is deployed
npm run fixtures   # regenerate the redacted fixture from the real run on this machine
```

Endpoints (served by the Vite dev-server plugin in `src/plugin.ts`; everything is
GET except the one POST below):

- `/api/workflows` — `[{ name, engine, kind, path, source, sha, meta }]` (`sha` = sha256 of `source`;
  `kind` is `script | skill | agent | yaml`, an `agent` being `.claude/agents/<name>.md`). `meta` is
  what the file says about itself: a script's `export const meta` — `description`, `whenToUse`,
  `phases: [{ title, detail }]` — plus `outcomes`, the `|`-separated words after the description's
  last `→` (else every `status: '…'` a `return {` can produce, `needs-human` last); a skill's or
  agent's frontmatter — `description`, `argumentHint`, `model`, `tools`, `disableModelInvocation` —
  read as `key: value` lines, no YAML library. A file without a header gets `{}`.
- `/api/file?path=…` — `{ path, content, sha }` for one allowlisted file (404 when it does not exist yet)
- `/api/config` — the parsed `factory.config.json`, or `{}` when there is none
- `POST /api/file` — the only write, see "Tweak" below
- `/api/runs` — manifests newest first, without `script`/`args` (`?full=1` includes them);
  each carries `projectSlug`, the projects dir it was read from
- `/api/runs/:runId/agents/:agentId` — `{ prompt, result, events }` from the transcript (404 for fixtures)
- `/api/ledger` — `{ [runId]: { cost, date, spec, outcome, notes } }` from the RUNS.md table
  (columns found by header name; the `run` cell names the id in backticks; a row without one
  is skipped, a missing file is `{}`). `docs/factory/runs/<date>-NNNN.json` (the raw `claude -p`
  results, no run id) fill a missing `cost` when a row matches on date + spec number.
- `/api/meta` — `{ slug, projectsBase, projectDirs, exists }`: the projects dirs being read
  (`CONSOLE_PROJECTS_DIR` overrides `~/.claude/projects`; `exists` is the repo's own dir)
- `/api/events` — Server-Sent Events; `data:` lines are `{ kind: 'runs' }` (a manifest or
  copied script changed, or a new project dir appeared), `{ kind: 'journal', runId }` (a
  journal or agent transcript grew), `{ kind: 'workflows' }` (a definition file changed),
  `{ kind: 'ledger' }` (RUNS.md or `docs/factory/runs/` changed). `fs.watch` recursive on
  each project dir, the three definition dirs and `docs/factory`, polling every 2 s where
  watch is unavailable; the projects base is re-scanned every 5 s for a new matching dir
  (a worktree's appears with its first run). Batched into 300 ms windows, `: ping` every
  15 s. Watchers start with the first subscriber and stop with the last.

Live runs. The manifest is written only when the run ends (measured 2026-08-29 on
`wf_9fda3778-dbf`: journal at 09:43:38, manifest at 09:48:00, nothing in between; a
`--max-budget-usd` stop writes one with `status: killed`), so `/api/runs` also reads
`<session>/subagents/workflows/wf_*/journal.jsonl` (`started` / `result` per agent, no
timestamps or labels) and the `agent-*.jsonl` transcripts next to it (timestamps, model,
usage, tool calls, the prompt). The derived record has `status: 'running'` (`'stale'` once
nothing moved for 15 min), agents in state `running` / `done` / `error`, and the workflow
name from the copied `workflows/scripts/<name>-<runId>.js` when the journal has none.
That copy also names the agents: each transcript's prompt is matched against the script's
prompt literals (the text before the first `${`, compared verbatim, longest match wins), so a
journal-only run reads `implement`, `gate:1`, `contract:1`, `review:1` with the node's phase,
templates numbered in start order (`gate:after-review-fix` draws as `gate:2`); without the copy,
or when nothing matches, the label is the prompt's first line. Merge rule per runId: a manifest
with a terminal status (`completed` / `failed` / `error` / `cancelled`) is final; otherwise
the journal is overlaid — the journal wins for an agent's `state` and `lastProgressAt`, the
manifest wins for everything else it knows, totals are recomputed. Every record says where
it came from (`source: 'manifest' | 'journal' | 'merged'`) and whether it is `live`.

Layout: `src/graph/` turns a script or YAML into nodes and edges (`parseScript` also
reads the script's `meta` — description, whenToUse, phase details, the outcomes it can
return), overlays a run's `workflowProgress` by label, and lays phases out as swimlanes
with dagre; `layout.ts` also routes every edge (orthogonal step edges; the `fix:*` loops
run under the fix shelf on their own y with the `≤n` bound as a pill) and places the
OUTCOME column. `purpose.ts` gives each node its one-line purpose (a table per label
pattern, else the skill's or agent's description, else the prompt's first sentence).
`src/ui/` is the Workflows screen (a card per workflow: description, last run in one
line, phase strip, run-it block; a skills-and-agents table), the Canvas (lanes with
subtitles, nodes with a purpose line, the outcome column, a legend), the run rail
(grouped by workflow, filterable), the replay bar (phase ticks, one bar per agent) and
the node panel, which sits beside the canvas — the rail collapses to a strip of dots —
and is drag-resizable. The panel's width is the only browser-side state (`localStorage`
`console.panelWidth`, a per-viewer convenience); runs and definitions are never stored
there. `ui/format.ts` holds the shared readings of a run: `outcomeOf`
(`result.status` in the workflow's words, else the engine status), `specOf` (args →
result → ledger → prompt), `usdOf` ("no cost yet" while live, "not in RUNS.md" after),
`stoppedAt`, `stopReason`, `nowAt`, `toneOf`, `elapsedOf`. A stale run's unfinished
agents are drawn `stalled`. The page keeps
one `EventSource` open and refetches on each event; a live run follows "now" and the
scrubber is offered once it finishes. Esc closes the panel; Enter opens a focused node.
All CSS lives in `src/styles.css`.

Tweak (C4). The node panel has three editable tabs — *Prompt* (the `SKILL.md` of the
skill a node invokes, or `.claude/agents/<agentType>.md` for a named subagent such as
the reviewer; a literal prompt is read-only), *Knobs* (`factory.config.json`) and
*Script* (the workflow file, edited as code: the graph is drawn from that text). All
three are CodeMirror 6 (`src/ui/CodeEditor.tsx`): highlighting by extension, search on
⌘F, ⌘S for Save…, one theme built from the CSS tokens so dark and light both work.
Save shows the file side by side with what it would become — `@codemirror/merge`'s
merge view, both sides read-only, unchanged stretches collapsed — then writes through

- `POST /api/file` with `{ path, content, base }` (JSON, ≤ 256 kB). `path` is
  repo-relative and must match one of `.claude/workflows/*.js`,
  `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.archon/workflows/*.yaml|yml`,
  `factory.config.json` after normalisation — no `..`, no absolute paths, no
  symlinks, and the parent's real path must stay inside the repo. Anything else is
  `403 { error: 'path not allowlisted' }`.
- `base` is the sha256 of the content the client last read (from `/api/workflows`
  or `/api/file`; `""` for a file that does not exist yet). If the file on disk no
  longer hashes to it the reply is `409 { error: 'file changed on disk', current }`
  and the page offers Reload — optimistic concurrency, no lock file.
- Success writes atomically (temp file + rename) and returns `{ ok, path, sha }`; the
  page then refetches `/api/workflows` so the graph re-parses the new script text.
  The gate runs `scripts/workflow-selftest.mjs` against the script, so a panel
  edit that breaks the flow (a renamed status, a lost retry) fails `npm run gate`.

`factory.config.json` (repo root, free tier) holds the knobs a driver reads:
`maxGateRounds`, `base`, `reviewer`, `implementModel` go to the script as
`args.config`; `maxTurns`, `maxBudgetUsd`, `permissionMode` are the `claude -p`
hard-stop flags a driver composes. The driver is `scripts/factory-run.sh`: it
passes `{ spec, config }` to the script as one JSON string
(`/implement-from-spec {"spec":"specs/…","config":{…}}`), because the slash form
always hands the script a plain string as `args`; the script parses a string that
starts with `{`. The bare form `/implement-from-spec specs/…` in a session still
works and uses the script's defaults — `config` reaches it only through the driver.

The static graph reads `agent(prompt, { label, phase, agentType })` calls anywhere in
the script — single, double or backtick quotes; a `${expr}` in a label becomes `*`
(`gate:*`), and a run's `gate:1` lights that node. `agentType` draws an `@reviewer` chip.
A `fix:<checker>` label is a loop, not a step: the chain is `implement → gate:* →
contract:* → review:*`, and `fix:gate-*` / `fix:review` get a dashed edge back from the
gate / review node (drawn as a U underneath, labelled with the enclosing `for` bound —
`≤2` from `round <= MAX_GATE_ROUNDS`, `≤1` outside a loop) and a dashed edge into the
gate again. Dagre ranks only the chain; the fix nodes form a row under `implement`.

Rules: local only. It reads `~/.claude`, so it is never deployed and is not part of
the product build. It never starts a run — starting is `claude -p` with the hard-stop
flags, or Archon; this page watches and edits, and the write endpoint executes nothing.
Every manifest field is optional and shows "—" when missing.
