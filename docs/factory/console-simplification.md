# Console simplification — UX pass 2 (proposal, 2026-08-30)

Source: two read-only audits on 2026-08-30 against the real runs on disk
(`wf_66ec6c31-e3f` needs-human, `wf_2a52cfdf-b8a` killed, `wf_0684802b-74d` stale,
`wf_2d570cca-1ac` live). A UX walk in Chrome (12 screenshots) and a data audit of
`tools/console/src` + the manifests, journals, transcripts, `RUNS.md` and
`docs/factory/runs/`. Nothing here is implemented yet.

The three questions the manager must answer from the screen:

- **Q1** Should I re-run this? Where?
- **Q2** Why did this step fail — infra I handle, or a spec misalignment?
- **Q3** Where does the context live (spec, prompt, transcript, diff, branch, ledger row)?

Today: Q1 partly (2 clicks, and the command is a `specs/NNNN-slug.md` placeholder);
Q2 yes for infra after 2 clicks on the right node, never for spec; Q3 no — zero
hyperlinks in the whole app, worktree path only inside raw `tool_use` JSON.

## The five changes

### 1. Delete the replay bar; keep the per-agent timeline as a static strip
**Screen:** canvas. **Effort:** S. **Engine change:** none.
- Remove: Play, 5×/20×/50×, scrubber, `9m 26s / 9m 26s`, Final, "replay is available
  once it finishes". It renders on a 0 s run (`0s / 0s`) and playing at 20× hides
  the failing node you were looking at for ~28 s.
- Keep: phase ticks + per-agent bars (`markersOf`, `Replay.tsx:110-147`) — computed
  from the manifest alone, `pos` is not an input; they render identically without a
  scrubber.
- Safe: `ReplayState.pos` has exactly one consumer (`App.tsx:67` → `overlayRun(…, t)`).
  With `pos` always undefined every node shows its final state, which is what a fresh
  selection already shows. Dead code to remove after: `NodePanel.tsx:38,66,142`
  (`COPY.notYet`), `Replay.tsx:74,91,96` (`seek`, `Final`), the header's
  clock-following `elapsed` at `App.tsx:136`.

### 2. "Why it stopped" — a classified cause with a next action, on the canvas header and the home card
**Screens:** both. **Effort:** M (UI) + S (script). **Engine change:** optional, see below.
Answers **Q2**. The data is already in the manifest the page fetches; it is rendered
only as a tooltip on the right node after you click it (`AgentNode.tsx:69`,
`NodePanel.tsx:93`). Rule table, in order:

| signal (manifest / journal) | class | action text |
|---|---|---|
| `workflowProgress[].error` or `logs[]` ~ `/hit your session limit/i` | **infra · account window** | "Session limit at *review:1*, resets 4:40pm — re-run after that; nothing about the spec is known yet." |
| `status === 'killed'` or top-level `error` ~ `/Workflow aborted/` | **infra · budget/turn stop** | "Stopped by `--max-budget-usd` / `--max-turns` — raise the knob in `factory.config.json` or split the spec." |
| no manifest, journal `started` without `result` for the last agent, nothing moved ≥15 min | **infra · swept / session ended** | "The run ended without a manifest — re-run (`FACTORY_BG_WAIT_MS` is on main)." |
| `result.gate.ok === false && result.gate.step === 'ask-tier check'` | **infra · dirty ask-tier file** | "Gate step 0: an ask-tier file differs from `origin/main`; a human passes it with `FACTORY_ASK_OK=1`." |
| `result.reason` ~ `/returned nothing\|no result/` **and** that agent has an `error` | **infra** (the agent died; the fix round inherited it) | "The step never produced output — see its error." |
| `result.review.verdict === 'fail'` with real findings (title ≠ "reviewer returned nothing") | **spec** | "Reviewer failed the diff twice — read the findings; the acceptance checks are the thing to change." |
| `result.reason` ~ `/implementer escalated/` | **spec** | "The implementer could not satisfy the spec — its notes say why." |
| `result.gate.ok === false`, other step, `/gate still failing/` | **spec/code** | "Gate failed at *step* after `maxGateRounds` — read the gate log." |
| anything else | **unknown** | "Open the transcript." |

Trap verified on `wf_66ec6c31-e3f`: `result.review.verdict` is `fail`, so a naive
rule says *spec*; the finding title "reviewer returned nothing" plus the agent's
`error` ("You've hit your session limit") make it *infra*. Today the screen says
`needs-human — review fix round escalated: no result`, which reads as spec.

Also surface here, never rendered today: `logs[]` (four lines that tell the whole
story, incl. `[review:1] failed: You've hit your session limit`), the engine `status`
word (`completed` vs `killed`) next to the outcome, `result.attempts`, and the
reviewer's `findings[].title/why` lifted out of the manifest instead of behind
"Load transcript".

Script change worth making (S): `return { status, reason, cause: 'infra'|'spec'|'unknown' }`
in `.claude/workflows/implement-from-spec.js:161-211`, and propagate the failing
agent's `error` into `reason` instead of erasing it with "no result". The UI rules
above stay as the fallback for old runs.

### 3. Bind every command to the run in front of you
**Screens:** both. **Effort:** S. **Engine change:** none.
Answers **Q1**. `scripts/factory-run.sh` takes one positional arg — the spec path
(`:126-136`); everything else is `factory.config.json`. The console already knows the
spec (`format.ts:136-155`) and `Workflows.tsx:25` hardcodes `specs/NNNN-slug.md`.
- Home card, directly under LAST RUN: **Re-run** `scripts/factory-run.sh specs/0002-album-position-gate-blind-spots.md` + Copy.
- Canvas header, next to the reason: the same button for the selected run.
- Two warnings next to it, from the driver and the handoff: "re-running wipes
  `../mixtape-poc.wt` (attempt 3's uncommitted work lives there)" and "check the
  5-hour window; a line run is ~10 min". When the cause is *session limit*, show the
  reset time from the error text.
- Remove: the second (Headless) box with `--max-turns 40 --max-budget-usd 3`
  (duplicates Knobs; the driver reads the config anyway), and shrink "The console
  never starts a run…" to one line under the button.

### 4. A context row — every path a link or a copy
**Screens:** both (canvas header row; home card as a compact line). **Effort:** M.
**Engine change:** none for most; one plugin addition.
Answers **Q3**. For the selected run:
- spec → open in the panel (extend the `/api/file` allowlist to `specs/**`, read-only)
- run id → click-to-copy
- transcript per node → the absolute path shown and the transcript one click away
  (today 4 clicks: run → node → Transcript → Load)
- manifest + journal paths (the plugin walks them; just return them on `/api/runs`)
- branch + worktree → from `cwd` / `gitBranch` on every transcript line
  (`plugin.ts:508-511` drops them; parse the first line)
- RUNS.md row → `outcome` + `notes` are already parsed (`plugin.ts:619-627`,
  `types.ts:74`) and never rendered; show them and link the row
- `docs/factory/runs/<date>-NNNN*.json / .pr.md` → link when matched. Note:
  attempt-suffixed files (`-attempt3.json`) never match the `<date>-NNNN.json`
  pattern, so even the cost fallback misses them today (`plugin.ts:634-637`).
- Replace "not in RUNS.md" with a link to the ledger and the literal row to add.

### 5. Demote the reference material so the run is the focal point
**Screens:** both. **Effort:** M. **Engine change:** none.
First glance today: home — the eye lands on the two grey command boxes, which are
boilerplate; canvas — on the swimlane diagram, which is identical for every run.
- Home: fold SKILLS AND AGENTS (inert, nothing clickable) behind a disclosure;
  drop the `NATIVE` chip and the footer's project paths (constants → tooltip); make
  the LAST RUN line a link to that run on the canvas; let outcome + spec be the
  largest text on the card.
- Canvas: legend (9 swatches) → a `?` toggle (badges already say DONE/ERROR/STALLED
  in words); panel from five tabs to two — **Definition** (prompt/skill/script,
  editable) and **This run** (attempt, error, result, findings, transcript); Knobs
  → one workflow-level Settings (it is the same `factory.config.json` on every node);
  merge PROMPT PREVIEW / FULL PROMPT; no "—" grid on idle nodes (purpose + prompt only).
- Correctness note found on the way: the Script tab edits the live repo file
  (`App.tsx:171`), not the frozen copy the engine ran (`scriptPath`, never shown).
  In "This run" show the frozen path and a diff against the live file.

## Not in the five, worth a line
- Preflight failures (spec not `status: ready`, dirty checkout — `factory-run.sh`
  exits 2/3) never reach the console: no manifest, journal or ledger row. A driver
  row for them is an engine change.
- Driver JSON is joined by date + spec (`plugin.ts:634`); `runId` written by the
  driver would make `terminal_reason` / `api_error_status: 429` joinable per run.
- `args.config` — the knobs *of this run* — is in the manifest and never shown;
  the Knobs tab shows today's file instead.

## Order and shape for the implementing session
Sequential slices, one commit each, orchestrator validates before every commit,
real runs on disk as fixtures (never start a run for UI data), read-only QA re-walk
at the end, `mattpocock-skills:code-review` before the PR. Order: 1 → 3 → 2 → 4 → 5
(pure deletion first, then the two S-sized CTAs, then the two M-sized ones).
Branch `console/ux-pass-2`. Merge is the human's gate.
