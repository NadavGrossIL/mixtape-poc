# Handoff — console UX pass 2 (paste into a new session)

Implement `docs/factory/console-simplification.md` in `tools/console/` on a new
branch `console/ux-pass-2` cut from `origin/main`. Read that doc, then
`tools/console/README.md` and `docs/factory/plan.md` §11 before touching code.

Rules that held in UX pass 1 and hold here:
- Five sequential slices in this order: **1** delete the replay bar (keep the static
  agent timeline) → **3** run-bound re-run command + warnings, remove the boilerplate
  boxes → **2** "Why it stopped": classified cause + action on the canvas header and
  the home card, `logs[]` timeline, findings lifted from the manifest → **4** context
  row: spec/transcript/manifest/journal/branch/worktree/RUNS.md as links or copies
  (`/api/file` allowlist gains `specs/**` read-only; plugin parses `cwd`/`gitBranch`
  from the transcript's first line and returns paths on `/api/runs`) → **5** demote the
  reference material (fold SKILLS AND AGENTS, legend → `?`, panel to Definition /
  This run, Knobs → workflow Settings, no "—" grid on idle nodes, frozen `scriptPath`
  shown with a diff against the live file).
- One commit per slice. Each implementation slice runs on a subagent (Opus, not
  Fable — Fable subagents can hit the session limit mid-slice; relaunch with the same
  brief after `git status`). The orchestrator runs `cd tools/console && npm run build`
  and looks at the screen in Chrome before every commit.
- Fixtures are the real runs on this machine — `wf_66ec6c31-e3f` (needs-human, the
  session-limit trap: `review.verdict: fail` but the cause is infra),
  `wf_2a52cfdf-b8a` (killed), `wf_0684802b-74d` (stale, journal only),
  `wf_2d570cca-1ac` (2026-08-30). **Never start a run for UI data.** Update
  `tools/console/fixtures/` if a new field is needed (`npm run fixtures`).
- The classifier rule table in the doc is the spec for slice 2; write it as a pure
  function in `src/graph/` with a unit test per row, the trap run included. The
  optional script change (`cause` on the return, error propagated into `reason`) is
  a separate commit and a separate decision — stage it at the repo root for the
  human to apply; the agent cannot write `.claude/**`.
- Check `git branch --show-current` before every commit (another session may be in
  this checkout). Read-only QA re-walk in Chrome at the end against Q1–Q3 with click
  counts; then `mattpocock-skills:code-review` against `origin/main`; then a draft
  PR. Merge is Nadav's gate.
- Leave `docs/factory/runs/*` alone (the driver writes there; a 0-byte
  `2026-08-30-0002.json` is a live run's placeholder).
