# Mixtape factory console

A local page that draws the feature factory's workflows as a graph, shows how
their runs went, and edits the files the line is made of. It reads two things:

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
npm test           # node --test on src/**/*.test.ts (Node ≥ 22.18 strips the types;
                   # test/register-ts.mjs resolves the app's extensionless imports)
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
- `/api/file?path=…` — `{ path, content, sha }` for one allowlisted file (404 when it does not exist yet).
  Two allowlists, in `src/allow.ts` (pure, unit-tested in `src/allow.test.ts`): GET reads the
  five writable definition files **plus**, read-only, `specs/**/*.md` (a spec may sit in a
  subdirectory; every segment is the same tight character class, so a `..` never gets that
  far), `docs/factory/RUNS.md` and `docs/factory/runs/*.{json,diff,md}` — the context of a
  run. POST only ever asks for the writable list, so the read-only additions are 403 on a write.
- `/api/config` — the parsed `factory.config.json`, or `{}` when there is none
- `POST /api/file` — the only write, see "Tweak" below
- `/api/runs` — manifests newest first, without `script`/`args` (`?full=1` includes them);
  each carries `projectSlug`, the projects dir it was read from, plus
  `paths: { manifest?, journal?, scriptCopy?, sessionDir?, agents: { [agentId]: { transcript, meta? } } }`
  — absolute paths to everything the run left on disk, the dirs the loader walked anyway —
  and `git: { branch?, cwd? }`, read from the FIRST line of one agent transcript (`cwd` and
  `gitBranch` are on every line; cached by that file's size+mtime, one line per run).
  `scriptCopy` is the script the engine **froze** for this run (`manifest.scriptPath`, else the
  copy in `workflows/scripts/`), which is not necessarily today's repo file.
- `/api/runs/:runId/agents/:agentId` — `{ prompt, result, events }` from the transcript (404 for fixtures)
- `/api/ledger` — `{ [runId]: { cost, date, spec, outcome, notes, line, driverFiles, driverExtracts } }` from the RUNS.md
  table (columns found by header name; the `run` cell names the id in backticks; a row without one
  is skipped, a missing file is `{}`). `line` is the row's 1-based line in RUNS.md, so the page can
  open the file at it. `driverFiles: { json?, diff?, pr? }` are the driver's saved results under
  `docs/factory/runs/`, absolute, oldest attempt first: `<date>-NNNN[-attemptN].{json,diff,pr.md}`
  matched to a row by date + spec number and, when the row's notes name an attempt ("attempt 3 · …"),
  by that attempt — several rows can share a date and a spec, and the attempt-suffixed names used to
  match nothing at all. A row with no `cost` cell takes it from the last matched JSON's `total_cost_usd`.
  `driverExtracts` is a parsed reading of each of those JSONs, keyed by path (`src/driverExtract.ts`,
  pure and unit-tested): cost, turns, the stop reason (`terminal_reason` over the raw `stop_reason`),
  whether it errored, and the session-limit text when `result` carries one — the few fields a reader
  actually asks the raw envelope for.
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
`src/ui/` is three levels: the Workflows screen, the workflow's definition view, and the
run view. The Workflows screen is a card per **workflow, not per run**, read top to
bottom as name → what it is for → how it flows → where it can end → the way in: the
plain-words `whenToUse`, then the phases as a chain in the canvas lanes' own uppercase
(`IMPLEMENT → GATE → REVIEW`, the raw arrow chain in its tooltip), then `ends in
ready-for-pr · ready-for-eval · needs-human` — toned words rather than the canvas's
chips, because three pills do not fit a 360 px card and a chip there means the outcome a
run *reached*, not the ones it could. The foot is the same status dot the Runs tab draws, how the last
run ended (the click that opens that exact run), the run count and `Open →`. The
spec, the clock, the cost, the cause tag, the phase strip and the command that runs it
again all moved a level down to the workflow's own screen: this screen answers which
workflows exist and what they do. Under the cards, the skills and agents — in **two
groups, because they are two kinds of thing**: a skill is a procedure invoked by name, an
agent is a subagent a step spawns with its own model and tools, and the heading says which,
so no badge repeats it on every row. (Mixed in one grid they were told apart only by that
badge, and five of them wrapped 4 + 1 with a hole in the row; split 3 + 2, each group fills
its own.) A skill's row is named the way it is run — `/implement` — with its argument beside
it; an agent's carries its model and the frontmatter's `tools` list, which is how a
"read-only reviewer" is checked rather than believed and had never been on screen. Both end
in who calls it, `used by implement-from-spec ▸ review:*`, deduped per workflow, or the
human who runs it. Each row is a button that opens the file itself (SKILL.md or the agent's
`.md`) in the same panel the canvas uses, editable through the same allowlist, beside the
screen (the screen scrolls in its own column so the panel stays put). Opening a workflow (card
name, "Open →") lands on the **definition view**: the static graph with nothing
overlaid, and in the header's place `ui/WorkflowDef.tsx`, which wears **the same three rows
a run wears** so moving between the two views does not move the furniture — the sentence
(`Use when: …`, keeping its label because `whenToUse` is a condition whose subject is the
spec), the Run command row with the driver warnings, and a line of context headed
`Definition`: the workflow file with an **Open** that edits the very text the graph is
drawn from, the run count, and the newest run as one clause — dot, outcome, when, how
long, cost, `View →`. What that header deliberately does *not* carry is the flow. The
canvas under it already draws the phases as lanes with their subtitles, the nodes with
their purposes and the outcome column with every word the workflow can return; a numbered
list of the same things in the header was the page twice, stacked, and it pushed the graph
— the reason to be on this screen — 120 px down. Selecting a run — that
line, a row in the Runs tab, a card's last-run clause — is what turns the run view on: overlay, run
sentence, why-stopped block, context row, timeline, the node panel's "This run" tab
(which the definition view's panel does not offer — with no run selected there is
nothing for it to be about). `‹ workflow` in the header walks back; Esc closes the
panel first, then walks run → definition, and stops there. A `runId` that no longer
matches after a refetch degrades to the definition view rather than jumping to the
newest run. Under the header the stage has **two tabs, `Flow` and `Runs <n>`**, which are the
two things a workflow screen is for. *Flow* is the Canvas — lanes with subtitles, nodes with
a purpose line, the outcome column, a legend behind the `?` in the zoom cluster, and the
timeline strip under it (phase ticks, one bar per agent) once a run is selected. *Runs* is
**this workflow's runs and only those** — the same set the tab's own `<n>` counts, newest
first, filterable, under one group head, open. (The screen is scoped to one workflow and
you change workflows from the home screen; `RunList` still groups, so a caller that hands
it more than one gets headed groups with the named one first.) The list
used to be a 280 px rail beside the canvas: it cost the graph a third of its width and gave
each run four wrapped lines, so a row now reads left to right across the screen — dot,
outcome, spec, badges, then when / how long / what it cost, right-aligned — and the graph
fits the full width. Picking a run returns to *Flow* with that run overlaid. (The rail's
folded strip-of-dots went with the rail; nothing folds any more.) The node panel opens
beside either tab and is drag-resizable; its title row and the two tabs stay stuck to the
top of its scroll. Because the stage is the whole width now, the canvas fit is allowed
above 100 % (`FIT.maxZoom` 1.75, padding .06) — held at 1 it sat small in the middle of a
wide screen with the space around it.
Browser-side state is three per-viewer conveniences, never runs or
definitions: the panel's width (`console.panelWidth`), the legend
(`console.legend`) and the context line's `more` (`console.context`) — all through
`ui/remember.ts`, which swallows a blocked `localStorage` and keeps the default. `ui/format.ts` holds the shared readings of a run: `outcomeOf`
(`result.status` in the workflow's words, else the engine status), `specOf` (args →
result → ledger → prompt), `specPath` (that reading as a path a driver takes, the
ledger's `0002 album-…` cell rebuilt), `usdOf` ("no cost yet" while live; after, `NO_ROW`
— one wording worn three ways, the definition view's `no RUNS.md row`, the Runs tab's `no row` and the
header's `—`, all with the same title, "open the run to add one"), `whereOfGit` (`branch …
· worktree …`, the `notes` cell of the RUNS.md row `rowValuesOf` prefills),
`dotOf` (the status dot the Runs tab and the home card both draw, so the two cannot disagree
about one run), `outcomeTone` (a status word with no run behind it, keeping `toneOf`'s
verdict on the same word so `needs-human` is not amber in the list of what a workflow can
return and red on the run that returned it),
`stoppedAt`, `stopReason`, `nowAt`, `toneOf`, `elapsedOf`. The two
signals the classifier needs are a layer below, in `src/graph/signals.ts` (`graph/`
imports nothing from `ui/`): `isLive` and `sessionLimit` — the failing agent's `You've
hit your session limit · resets 4:40pm (Asia/Jerusalem)`, or the script's own
`[review:1] failed: …` log line when the agents carry no error, matched by
`SESSION_LIMIT_RE` and split into the reset time; `ui/format.ts` re-exports both.
`ui/Cause.tsx` owns the `CAUSE_TAG` copy and the `<CauseTag>` the canvas block renders —
its one caller, now that the home card carries no tag — plus `<Findings>`, the reviewer's
findings as the canvas block and the node panel both list them. A stale run's
unfinished agents are drawn `stalled`. The page keeps
one `EventSource` open and refetches on each event, so a live run's nodes and timeline
bars follow it as it goes. The timeline is static — no play, no speed, no scrubber:
every node shows the manifest's last word for it, and the strip is one bar per agent
from its start to its end (a live one runs to *now*), coloured by how it settled.
Hovering a bar names the agent, its clock and its tokens; clicking one opens that
node's panel. Esc closes the panel; Enter opens a focused node. Inside a CodeMirror
editor the first Esc belongs to the editor — it closes the search panel, or leaves the
editor (Tab indents, so Esc is the way out; Esc-then-Tab moves focus on too) — and only
a second Esc, pressed with focus outside it, closes the panel. The editor bar says so.
All CSS lives in `src/styles.css`.

Running it again. The two lower levels carry one command, bound to the run in front of
you — the definition view's row (`Re-run`, or `Run` when the workflow has none yet) and a
compact row under the canvas header's run sentence. The home card does not: a command
built from the last run's spec is a fact about that run, and the card is about the
workflow. It is the driver with that run's
own spec — `scripts/factory-run.sh specs/0002-album-position-gate-blind-spots.md` —
except where a workflow has no driver (`review-spec`, whose line is the in-session
`/review-spec <spec>`); `specs/NNNN-slug.md` appears only when there is no run to read
a spec from. No `--max-turns` / `--max-budget-usd` on screen: the driver reads them
from `factory.config.json`, which the canvas header's **Settings** button opens.
Copy copies exactly the line; where it goes and what happens then ("paste in a terminal
— the driver writes the RUNS.md row") is the button's tooltip, since the screen title
already says the console never starts a run.
Beside it on the canvas, when they apply: the driver wipes `../mixtape-poc.wt`
(it cuts the worktree again from `origin/main`, so uncommitted work there goes) and it
costs about ten minutes of the five-hour account window; the account window itself — an
agent whose `error` says "You've hit your session limit" — puts its reset time in the
block above. The card's last-run clause is itself a button: it
opens that run on the canvas, while the card's name and "Open →" open the
workflow's definition view — the run overlay waits to be asked for.

Why it stopped. A run that ended badly is classified once, in `src/graph/cause.ts`
(`classify(run)` — pure, one manifest in, one verdict out, tested against the real
runs on disk), into the only distinction that changes what the reader does next:
**infra**, which a human handles and which says nothing about the spec, or **spec**,
where the diff and the ticket disagree. The rules, in order, first match wins:
an agent error or a `logs[]` line saying "You've hit your session limit" → *infra ·
account window* (with the reset time); `status: killed` or an `Error: Workflow
aborted` → *infra · budget/turn stop*; stale with no terminal manifest → *infra ·
swept or session ended*; `result.gate.step` `ask-tier check` → *infra · dirty
ask-tier file*; a `reason` of "no result" over an agent that wrote an error →
*infra · the step died*; `result.review.verdict: 'fail'` with findings that are
about the diff → *spec · the reviewer failed it*; "implementer escalated" → *spec*;
the gate still failing → *spec/code*; anything else → *unknown · open the
transcript*. The order is what makes it honest: `wf_66ec6c31-e3f` has a failed
review verdict **and** a session limit, and it is infra — the reviewer's finding is
its own "reviewer returned nothing" placeholder, which `findingsOf` drops. The
canvas shows it **in the order a reader acts in**: the tag and the headline, the one
action, the reviewer's real findings when there are any, then the Re-run command that
performs the action — and only then the proof, on one quiet last line, the raw string
that fired the rule beside the script's `logs[]` behind a disclosure (160 px, scrolling,
the firing line lit). The command used to sit under the evidence, two blocks below the
sentence telling you to press it. When the block renders, the run sentence above it
drops its `— <reason>` fragment: the block says it better and the two side by side read
as a contradiction ("no result" against "account session limit"). The sentence ends
instead in `result.attempts`, when the script returned them — `attempts implement ×2 ·
gate ×1 · review ×1`. The sentence never carries the outcome **word**: the pill in the
row above it does, and with a block below it that word was on screen three times. What
is left is provenance — which run, on what, when — set 12 px and muted so the pill and
the block read first; the `reason`, the one thing in it the pill does not know, keeps
the text colour and the weight.
A run that ended well has no block, and
its Re-run row stands on its own under the sentence. The home card carries no tag at all
any more — why a run stopped is a fact about that run, and it is a click away on the
canvas; a Runs row says the headline on hover. `result.cause`, if a script ever
returns one, wins over the table's class. Next to the outcome pill, `engine:
<status>` appears only when the engine's own word is neither `completed` nor
what the pill already says.

Where the context lives. Under the canvas header, a **Context** *line* names the three
artefacts a manager reaches for — no clicking a node first: the spec (Open, read-only in the
panel), the branch (Copy) and the RUNS.md row at its line number (Open) — and ends in
`more ▾`. Opening it unfolds the rest in a box of its own — 180 px, scrolling inside, so
unfolding it never takes the canvas off the screen, in two clusters. **artefacts** is what the run
produced, labelled by what it answers: the frozen script (Diff against the live file), the
**driver result** — whose value is not a path but the extract's own words, `$2.93 · 5 turns ·
stopped: completed` (or the session-limit line when that is how it ended), the path in the
tooltip, the raw JSON behind Open — the **diff it produced** and the **PR body**. **paths**
is where its files live, copy-only: the worktree it ran in (from `git`, which is `cwd` /
`gitBranch` off the first transcript line), the run id, the manifest, the journal, the
spec's path. Under both, the ledger row in its own words — two lines, the whole note in
the tooltip and one **Open** away in RUNS.md itself, because in full it ran four lines of
prose that the 180 px box cut mid-word anyway. Each unfolded line is a label, the value in monospace
(a long path is truncated from the *left* — the tail identifies the file — with the whole thing
in the tooltip), then Copy and, where the page can serve the file, Open. Paths under `~/.claude`
are copy-only: they are outside the repo and `/api/file` will not serve them, which is fine —
a terminal is where they are going. The frozen script's **Diff** puts the copy the engine ran
beside the live repo file (the Definition tab's Script editor edits the live one), and says so
when they are identical; the same comparison sits folded under that editor.
When there is no row, the header's USD cell is `—` ("no row in docs/factory/RUNS.md")
and the Context line's RUNS.md slot carries the one action — **add row** — which opens
RUNS.md at its last row and copies a row for this run, built from the table's own header
(`prefillRow`) — date, spec, engine, attempts, gate, review, outcome, run and notes filled from
the manifest, cost left empty because only the driver's JSON knows it. The page never writes
RUNS.md. On the definition view's last-run line the same absence is the line's last cell,
`no RUNS.md row`, which reads as a link and is opened by the click that line already
performs — the canvas, where **add row** lives. The home card says nothing about cost at
all: it is a fact about a run. The node panel's *This run* tab carries the transcript's
absolute path with a Copy and
loads it when you open the tab (it was four clicks: run, node, tab, button). The home card's
last-run clause carries the spec and the absolute time in its tooltip and leaves every
other artefact to the canvas.

Where the eye lands (§5). The run is the focal point and the reference material is folded:
the canvas header is ~140 px for a clean run and ~225 px for one that stopped (measured at
1552 px wide), the definition view's header is three rows of the same shape, the legend hides behind `?`, the `native` chip is gone from both screens (it is a
constant; the value is in the workflow name's tooltip), and the footer is one `LIVE` dot
whose tooltip carries the dirs it reads. What is *not* folded any more is the skills and
agents: they are what the line is made of, and a reader looking for "what do I have" was
opening a disclosure to find out. They are two labelled groups of rows on the home screen
now, each row opening its file, and each group headed by one line saying what that kind of
thing *is* — the question "which skills and agents do I have" is answered without a click. On a card, what the workflow is *for* is the largest text after its name: the
run block that used to own that size is one muted clause in the foot, and a card that
was ~360 px is ~190 px, so the whole grid is scannable without scrolling. The paragraph
that used to sit under each card's command ("The console never starts a run — paste this
in a terminal…") is gone with the command itself: the screen's subtitle already says it.

Tweak (C4). The node panel has two tabs. *Definition* is what the step is made of, and it
is the editable one: **Prompt** (the `SKILL.md` of the skill a node invokes, or
`.claude/agents/<agentType>.md` for a named subagent such as the reviewer; a literal prompt
from the script is read-only, and a journal-only node shows one prompt — the transcript's
full text once it loads, the manifest's preview until then, cut off at twelve lines with
`show all` under it — no scroll box of its own, so the wheel scrolls the panel)
and **Script** (the workflow file, edited as code: the graph is drawn from that text), with
the run's frozen copy of that script folded underneath. *This run* is what the run knows
about the step: its facts, its error, its attempts, the reviewer's findings where they belong
to it (`ui/Cause.tsx`'s `<Findings>`, the same list the canvas header's block renders), its
result and its transcript. The prompt is not repeated here — it is rendered once, in
Definition ▸ Prompt, and *This run* carries one line back to it. A node that never ran in this run opens on Definition
and says "Did not run in this run." in one line, instead of a grid of dashes. The knobs are
not a tab: `factory.config.json` is the same file on every node, so it is one **Settings**
button in the canvas header, opening in the panel's slot, editable through the same
`POST /api/file` allowlist (which did not grow). Every editor is CodeMirror 6
(`src/ui/CodeEditor.tsx`): highlighting by extension, search on
⌘F, ⌘S for Save…, one theme built from the CSS tokens so dark and light both work.
Save shows the file side by side with what it would become — `@codemirror/merge`'s
merge view, both sides read-only, unchanged stretches collapsed — then writes through

- `POST /api/file` with `{ path, content, base }` (JSON, ≤ 256 kB). `path` is
  repo-relative and must match one of `.claude/workflows/*.js`,
  `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.archon/workflows/*.yaml|yml`,
  `factory.config.json` after normalisation — no `..`, no absolute paths, no
  symlinks, and the parent's real path must stay inside the repo. Anything else is
  `403 { error: 'path not allowlisted' }`, including everything GET may read read-only
  (`specs/`, RUNS.md, `docs/factory/runs/`): the write list is a separate array in
  `src/allow.ts`, and `src/allow.test.ts` asserts it did not grow.
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
