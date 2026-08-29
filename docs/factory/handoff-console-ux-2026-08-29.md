# Handoff — factory console UX pass, 2026-08-29

Paste the block below as the first message of a new session, started in this
repo on `main` (at `f4a39e1` or later). It spawns a UI/UX team to fix the
console's monitoring experience and ship the result.

---

You are the orchestrator of a small UI/UX team working on the Mixtape feature
factory's **console** — `tools/console`, the local page that draws the
factory's workflows as a graph, replays their runs and edits the files the
line is made of (`npm run console` → http://127.0.0.1:5174). The console
works, but as a *monitoring* tool it is not good enough yet. Your job: audit
it as a product, fix everything listed below, find more improvements that
have clear value, implement them, verify them in a real browser, commit and
push. Nothing about the factory's engine, driver, skills or workflows changes
in this pass — only what the console shows and how.

## Read first, in this order

`CLAUDE.md` · `tools/console/README.md` (the contract: endpoints, merge
rules, what "local only" means) · `docs/factory/plan.md` §11 (why the
console exists, its principles, C1–C5) · `tools/console/src/` (all of it,
~1 500 lines: `plugin.ts` the Vite dev-server plugin that serves the data,
`graph/` parser + run overlay + dagre layout, `ui/` the screens,
`styles.css` all the CSS, `types.ts` every shape) · `.claude/workflows/*.js`
and `.claude/skills/*/SKILL.md` (the things the console draws — read-only for
you, see Constraints) · `docs/factory/RUNS.md` · `docs/playbooks/run-the-factory.md`.
Memory `mixtape-feature-factory.md` is recalled automatically; its
"engine on-disk facts" are measured — respect them.

## What the user reported (must all be fixed)

**All-workflows screen** (`src/ui/Workflows.tsx`, `.cards` / `.card` in
`styles.css`). Today a card is: name, engine badge, a thumbnail of the graph,
and last-run status/date/duration/tokens/run-count. Missing:

1. *What the workflow does.* Both scripts already declare it —
   `export const meta = { name, description, whenToUse, phases: [{ title, detail }] }`
   in `.claude/workflows/implement-from-spec.js:23` and `review-spec.js:24` —
   but `src/graph/parseScript.ts` `readMetaPhases()` keeps only `name` and the
   phase titles. Carry `description`, `whenToUse` and each phase's `detail`
   through `Graph` / `WorkflowFile` and show them (card, canvas header, lane
   headers). Degrade to "—" when a script has none.
2. *The last run, in one line a human can read* — outcome (the workflow's
   terminal status: `ready-for-pr` / `needs-human` / `reviewed` …, which lives
   in the run's result, not just `completed`), which spec it ran on (the
   arg), when, how long, cost (the ledger already provides USD by run id —
   `/api/ledger`; the card shows tokens but never USD), and where it stopped
   if it failed (the first `error` agent's label). Also a "what happened" for
   a *live* run: which phase/agent is running now.
3. *Skills the workflow calls — what are they.* The screen prints skill names
   as bare chips ("Skills the workflows call: implement review spec"). Each
   `SKILL.md` has frontmatter `name` / `description` / `argument-hint`
   (`/api/workflows` already ships the `source`; parse the frontmatter
   client- or plugin-side). Show the description, and which workflow(s) call
   each skill — the parser already records `node.skill` per node, so this is
   a join, not new data. Same for named subagents (`.claude/agents/*.md`,
   e.g. `@reviewer`).
4. *How to invoke a workflow.* Each script's header comment says it
   (`/implement-from-spec specs/NNNN-slug.md` in a session, or headless via
   `scripts/factory-run.sh <spec>` with the `factory.config.json` knobs).
   Surface a copyable "Run it" line per card — read from `meta`, from a
   `whenToUse`/usage field, or hard-code the two known forms per engine — and
   say clearly that the console itself never starts a run (plan §11 rule).
5. *And more* — see "Find more" below.

**Single-workflow screen** (`src/ui/App.tsx` canvas shell, `Canvas.tsx`,
`AgentNode.tsx`, `graph/layout.ts`, `NodePanel.tsx`, `RunList.tsx`, `Replay.tsx`):

6. *The diagram is not clear.* No visible reading order; a first-time viewer
   cannot tell what each step does and why, nor where the run is going next.
   Give the graph an explicit left-to-right narrative: phase lanes titled with
   the phase `detail`, a one-line purpose under each node label (from the
   prompt's first line, the skill description, or the label's role —
   `gate:*` = "npm run gate", `fix:gate-*` = "fix round after a failed gate",
   `contract:*` = "acceptance checks extracted from the spec"), and the
   terminal outcomes (`ready-for-pr | ready-for-eval | needs-human`) drawn as
   an end node or an outcome strip so the flow has a visible end.
7. *The connecting lines are messy.* The loop-back edges (`LoopEdge` in
   `Canvas.tsx`, `LOOP_DROP`, the bottom `loop` handles) cross the fix-node
   shelf and each other; cross-lane edges are drawn between absolute
   positions with no routing; edge labels (`≤2`) collide. Fix the routing —
   orthogonal/smoothstep paths with distinct handle offsets per edge, loops
   drawn *below* the shelf not through it, labels placed on the horizontal
   segment, a legend for solid vs dashed — and make the running edge
   visibly the one that is active. Check every layout the parser can
   produce: both workflows, the 15-agent fan-out packing case in `layout.ts`,
   the fixture, a live run.
8. *Text cut-offs in the node panel.* Opening a step shows a title like
   "Invoke the project skill `implement` with the S…" — that is the prompt's
   first line used as a label (the journal fallback documented in the
   README) truncated by the plugin (`promptPreview` / label fallback in
   `plugin.ts`) and then again by the 400 px panel. Fix both ends: the panel
   header must wrap or show the full label on hover *and* a step whose label
   is a prompt line should get a real label from the script when the run's
   workflow file is on disk. Also the *Transcript* tab title is clipped: five
   uppercase, letter-spaced tabs (`.tabs` / `.tab`) do not fit the panel
   width. Make the panel resizable or wider by default, let tabs wrap or
   scroll, never clip a tab name. Audit every `nowrap` / `ellipsis` /
   `max-height` in `styles.css` for the same class of bug (node labels at
   216 px, chips, run rail names, `.mono` blocks at 180 px).

## Find more (each must have a stated value; drop what does not)

Candidates the previous session noticed, for the team to verify, rank and
extend — you are expected to add your own from the audit:

- Cost is only on the canvas header; the run rail and cards should show USD
  and, for a run in progress, "no cost yet — written to RUNS.md at the end".
- `state: 'stale'` (nothing moved for 15 min) and `status: killed` (budget
  stop) exist in the data but have no distinct visual or explanation.
- The replay scrubber has no phase markers; you cannot see *when* the gate
  failed. Mark agent start/end ticks on the timeline.
- The run rail lists runs newest first with no grouping by workflow, spec or
  day and no filter; with two workflows and a worktree (`wt` tag) it already
  reads as noise.
- Empty/error states: "No workflows or runs found yet", "Could not reach the
  console plugin", fixture mode — none tell the user what to do next
  (start a run how, check which dir, see `/api/meta`).
- The attempts list in *Last result* is a `<ul>`; retries are the most
  important thing to see in a factory run — a small table with attempt,
  outcome, duration, tokens and the failing gate step would be worth it.
- Keyboard: no way to move between nodes or close the panel with Esc; no
  focus styles; `aria` labels exist on the panel only.
- Dark/light: the page uses `colorMode="system"` for React Flow but check
  every custom colour token in both themes.
- `Thumbnail.tsx` draws 27 lines of SVG — is the thumbnail earning its space,
  or would the description + last-run line be more useful on the card?
  Decide with evidence (screenshots), not taste.

## Team and process

Spawn subagents with the Agent tool; do not run a Workflow for this (the
user did not opt into orchestration cost). Keep the *audit* parallel and the
*implementation* sequential — one working tree, one editor at a time — and
validate before every commit yourself (the user's standing rule). Suggested
team, adjust as needed:

1. **UX auditor** (read-only, uses Chrome via the `claude-in-chrome` tools):
   opens http://127.0.0.1:5174 against the real runs on this machine (the
   dev server must be running — `npm run console` from the repo root, in the
   background), walks both screens and the node panel for every node type,
   screenshots every defect above plus anything new, writes the findings to
   the scratchpad as a ranked list with a one-line *value* per item.
2. **Information architect / copywriter**: decides what each screen must
   answer in the first 5 seconds ("what is this, what happened last, what do
   I do now"), the labels, the one-liners per node kind, the empty states.
   Output: a short spec in the scratchpad the implementers follow.
3. **Graph/diagram specialist**: owns `graph/layout.ts` + `Canvas.tsx` +
   `AgentNode.tsx` edge routing and the loop/legend work (item 7). Must
   test against both scripts, the fixture and the fan-out branch.
4. **Frontend implementer(s)**: everything else in `src/ui` and `plugin.ts`
   (meta/frontmatter parsing, panel, cards, rail, replay). TypeScript strict,
   no new dependencies unless the value is obvious (say why in the commit).
5. **QA / reviewer** (read-only): re-runs the auditor's walk on the finished
   build, confirms every reported item is fixed with an after-screenshot,
   runs `cd tools/console && npm run build` (typecheck + vite build — the
   repo gate does *not* cover the console) and `npm run gate` at the root.

Process: audit → IA spec → implementation in small commits (one concern
each, message says what changed *for the user*) → QA walk → push. Between
steps, you (the orchestrator) read the diff and the screenshots yourself;
subagents' reports are not shown to the user, so relay what matters.

## Constraints (non-negotiable)

- Touch only `tools/console/**` (plus `docs/factory/plan.md` §11 and the
  console README if the contract changes). `.claude/**`, `CLAUDE.md`,
  `evals/**`, `.github/**` are never-tier — you cannot write them and the
  console's `POST /api/file` is for the human at the panel, not for you.
  Reading `.claude/workflows/*.js` and `.claude/skills/*/SKILL.md` through
  the plugin is fine — that is what the console does.
- The console stays local-only, never deployed, never starts a run, keeps
  no database — it reads files the repo and `~/.claude/projects` already
  have (plan §11 rules). Every manifest field is optional; show "—" when
  missing, never crash on a partial journal.
- Do not break the write path (C4): the diff-then-write flow, the sha `base`,
  the 409 conflict — if you restyle the editor, re-test a save on
  `factory.config.json` and revert it.
- Keep the SSE/live behaviour: a live run follows "now"; the scrubber
  appears only after it ends.
- No screenshots or binaries in the repo; keep them in the scratchpad and
  describe before/after in the PR body.
- Do not start a factory run to get data — the real runs already on this
  machine (`wf_9fda3778-dbf`, `wf_48b9d383-e37`, the worktree runs) and the
  fixtures are enough; a run costs ~$4.

## Done when

- Every numbered item 1–8 is fixed and shown fixed by an after-screenshot.
- At least five "find more" items with stated value shipped; the rest listed
  in the PR body as deferred, with the reason.
- `cd tools/console && npm run build` and `npm run gate` pass.
- Work is on branch `console/ux-pass-1`, pushed, with a draft PR whose body
  has: the ranked audit list, what shipped, what was deferred, before/after
  notes per screen. Merge is the user's call — do not merge.
- `tools/console/README.md` and plan.md §11 updated for anything that
  changed in the contract (new `WorkflowFile` fields, new endpoints, the
  panel's new behaviour). One paragraph, in the repo's voice.
- Final message to the user: what shipped, what was deferred and why, the PR
  link, total session cost.
