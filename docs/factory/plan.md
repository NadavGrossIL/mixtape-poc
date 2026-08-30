# Mixtape feature factory — plan

Written 2026-08-28; alignment-checked against current Anthropic docs and
practitioner write-ups the same day (section 9). Source talk: Nir Parisian
(Enpitech), *"5 אבני הבניין של Workflow אוטונומי בפיתוח תוכנה"* —
youtube.com/watch?v=YrgW2FPjxl4 (Aug 26 2026, 53 min).
Goal: a workflow that takes a one-line feature request for Mixtape and delivers
a reviewed branch, with a human at exactly two points — approving the spec and
merging the PR. In Addy Osmani's terms this is a deliberate **light factory**,
not a dark one. Kept small; the point is practice and a story to tell in
AI-enablement interviews, not a platform.

## 1. What the talk actually says

**The ladder** (Dan Shapiro's levels, Jan 2026): 0 autocomplete · 1 "write
this function", read the code · 2 pair-program · 3 hand it a feature, read
the PR · 4 write the spec, argue with it, leave, check the tests · 5 dark
factory. Most companies sit at 2–3. Nobody has a full factory — everybody has
*workflows*. A factory is many workflows.

**Five building blocks every workflow must carry:**

1. **Context — a map, not a dump.** CLAUDE.md points at where things are;
   `specs/` (the tickets), `decisions/` (architecture), `playbooks/` (how we
   do X). The window runs out sooner than it seems; a 10k-line CLAUDE.md is
   waste. "Everything is context" — Slack, Zoom, feedback — but collect it
   deliberately.
2. **Evals — tests for prompts.** Cases + criteria; a second (cheaper) model
   judges the first's output; snapshot a baseline; no regression per
   category. Run on prompt change, before deploy, on a model change.
3. **Commands** — `/spec`, `/implement`, `/review`, `/triage`. Command = "do
   this now"; skill = a recipe the agent loads only when needed.
4. **Gates — deterministic guards, in cost order.** Types and lint, then
   tests, then evals last because they cost money. **Protection tiers**:
   free / ask-me-first (auth, payments) / never (the eval baseline — models
   want to please and will edit the test instead of the code). The honest
   point: a rule in a prompt is forgotten at 20–30% context; only a hook, a
   git hook, CI or file permissions actually stop the agent. Retry a few
   times, then escalate to a human.
5. **Observability + learning loop.** Every bug fix ships with a new test or
   eval case; user feedback becomes a spec, which becomes context; keep data
   on runs — how many, autonomous vs human-in-the-loop.

**The workflow shape he ships:** ticket → `/spec` → **human approves** →
implement → deterministic tests → evals (loop, max 3) → review by a
*different* agent with its own context (self-review justifies itself) →
ship. Patterns: prompt chaining; routing with a cheap model (feature / bug /
don't-know→human); evaluator loop (implementer ≠ reviewer, and the reviewer
can be a smaller model); team agents (good context isolation, drinks tokens).

**Agent shaping:** narrow goal, minimal tools (his reviewer had read, grep,
list — no git, no web: "it simply can't"), JSON-schema handoffs, hard stops on
turns and tokens (the half-billion-dollar loop with no max-retry), and feature
flags so a bad merge is a flip, not a revert. Developers become operators.

## 2. What we take, what we skip

| Take | Why |
| --- | --- |
| All five blocks | They are the checklist an interviewer will recognise |
| Two workflows, split at human approval | `spec` ends at "approve"; `implement` starts from an approved spec. Claude Code's workflow runtime takes no mid-run input — its docs say to split stages exactly here |
| A separate, read-only reviewer that never sees the implementer's notes | The talk's rule; StrongDM's holdout; coleam00's FACTORY_RULES word it identically; Anthropic's harness-design post: self-evaluating agents "confidently praise" their own work |
| Retry ≤2 then escalate | coleam00's factory escalates on the third cycle; cheaper than the talk's 3 and the story writes itself |
| A run ledger | The operator role needs data; a table is enough |

| Skip | Why |
| --- | --- |
| LangGraph, n8n as orchestrators | Claude Code's own `Workflow` tool is native; Archon is kept as a **second engine for learning** — see section 10 |
| Notion / n8n / webhook triggers | Specs are markdown files in the repo; the trigger is you, later a launchd timer |
| Team-agent fan-outs | Parallel high-effort agents burn the Pro 5-hour window — measured, Aug 2026. coleam00 runs 4 in parallel; this is a deliberate simplification, not a disagreement |
| Evals in a retry loop | One eval run spends ~90 Spotify searches out of a few hundred a day; it runs once and a human reads it |
| A dashboard UI | `RUNS.md` |

## 3. Where the repo already is

**Have.** Unit tests, server typecheck, evals selftest and client build in CI.
A truthfulness eval with a **measured baseline and thresholds set from it**
(2026-08-18, `evals/thresholds.json` — the README's "ships empty" is stale).
A reliability eval that already reports pass@k / pass^k. A validated fix
(invented notes 24.0% → 10.1%, 2026-08-23). `docs/reviews/` and
`docs/research/`. Env-var flags for modes and caps. Decisions worth an ADR
already exist — inside the README and commit messages.

**Missing.** No `CLAUDE.md`, no `.claude/` at all: no skills, agents,
permission rules or workflows. No `specs/`. No protection tiers. The client
is never typechecked in CI (`npx vite build`, not `tsc -b && vite build`).
No run log.

## 4. Target shape

```
request ─▶ /spec ─▶ specs/NNNN.md ─▶ [HUMAN: status: ready]
                                          │
   ┌──────────────────────────────────────┘
   ▼
implement (agent) ─▶ gate (bash: types → tests → selftest → build)
        ▲                     │ fail, ≤2
        └─────────────────────┘
                              │ pass
                              ▼
                    review (separate read-only agent)
                              │
                 pass ────────┴──────── fail → one fix round → escalate
                  │
                  ▼
        branch + PR draft + RUNS.md row ─▶ [HUMAN: merge] ─▶ flag on/off
```

Evals are not on the line. A spec marked `touches_prompt: true` gets one
eval run after review, and the aggregate is read by a human against the
thresholds. Nothing loops on it.

## 5. Milestones — one sitting each

### M1 · The map (context)

- `CLAUDE.md`, pointers only: what lives where, how to run the gate, the
  three tiers, links to specs / decisions / playbooks. Anthropic's stated
  ceiling is **under 200 lines**; aim for ~60 — your own A/B (Aug 18) showed
  a CLAUDE.md of *rules* added nothing over in-code comments, and a map is
  a different object. Generate the first draft with
  `CLAUDE_CODE_NEW_INIT=1 claude` → `/init` (it proposes CLAUDE.md, skills
  and hooks from a codebase scan, for review before writing); then
  `/doctor` trims what the code already says.
- Gotchas that only matter in one part of the tree go in `.claude/rules/`
  with `paths:` frontmatter, so they load only when that file is touched:
  `rules/curator.md` (paths `server/curator.ts` — "a prompt change means one
  eval run; here is what it costs"), `rules/spotify.md` (quota, dead
  endpoints), `rules/evals.md` (never invent thresholds).
- `docs/decisions/` seeded with three ADRs that already exist in prose:
  keyed object over array in the tool schema; host-account public playlists
  over per-user saves; tests vs evals split.
- `docs/playbooks/`: add a server route + its test; add an eval case; change
  the curator prompt (what to run afterwards, what it costs).
- `specs/_template.md`: goal, non-goals, files touched (by tier), acceptance
  checks that are runnable, `touches_prompt`, `flag`, `status`.

**Done when** a fresh `claude` session asked "where do I add a server route
and how do I verify it" answers from the map without grepping.

### M2 · Gates

- Root `npm run gate`, cheapest first: server typecheck → client typecheck →
  unit tests → evals selftest → client build. `ci.yml` calls the same
  script, which also closes the client-typecheck gap.
- Protection tiers live in **`.claude/settings.json` permission rules**
  rather than the talk's hook script. Both are client-enforced hard stops —
  the talk's principle. Rules win on fewer moving parts: declarative,
  checked in, and the ask-tier is one line; the hook wins if you want a
  block message with an unlock path, which is what the talk demoed. Deny
  rules are evaluated before ask and allow, a `PreToolUse` hook cannot
  override them, and they also cover `cat`/`head`/`sed` in Bash. Only `Edit(path)` and `Read(path)` rules are
  consulted for files (`Write(...)` rules are accepted and ignored), and
  `Edit(...)` covers Write too:

  ```json
  {
    "permissions": {
      "deny": [
        "Edit(evals/thresholds.json)", "Edit(evals/runs/**)",
        "Edit(evals/baseline-logs/**)", "Edit(.github/**)",
        "Edit(CLAUDE.md)", "Edit(.claude/**)",
        "Read(server/.env*)", "Edit(server/.env*)"
      ],
      "ask": [
        "Edit(server/session.ts)", "Edit(server/caps.ts)",
        "Edit(server/env.ts)", "Edit(server/spotify.ts)"
      ]
    }
  }
  ```

  - **never** = the deny list: the eval baseline and its evidence, CI, the
    factory's own config, secrets.
  - **ask** = identity, caps and tokens — this app's "auth and payments".
    In a headless run an ask *is* the escalation: the run stops and the row
    in `RUNS.md` says why.
  - **free** = everything else.
- Escape hatch: none in the environment. You edit a never-tier file
  yourself, outside the agent — which is the actual point of the tier. (The
  talk's `FACTORY_UNLOCK`-style env var only makes sense for a hook; with
  deny rules the unlock is your editor.)
- Not covered by rules or hooks: a Node/Python script that opens a
  never-tier file itself. The docs' answer is the sandbox; at this scale,
  the reviewer reading the diff is enough.

**Done when** an agent told to "loosen `evals/thresholds.json`" is refused
by the client with the rule shown, and a request to edit `server/caps.ts`
prompts.

**Verified 2026-08-28 — headless `claude -p` from the repo, real tool
calls, files checked with `git status` after each run:**

| Mode | Never tier (`evals/thresholds.json`) | Ask tier (`server/caps.ts`) |
| --- | --- | --- |
| `default` | Edit tool: `File is in a directory that is denied by your permission settings`. Bash `>>`: `Permission to use Bash … has been denied`. `sed -i`: blocked. | Edit → prompt → denied headless. Bash `>>` → prompt → denied headless. Holds — but so does everything else the implementer needs. |
| `auto` (the user-level default) | Model refused before calling a tool; docs: deny holds in every mode and a hook can't override it. | Edit tool: `requested permissions … haven't granted` → run stops ✓. Bash `printf > tmp && mv`: **approved by the classifier, file changed** ✗. |
| `acceptEdits` | as `default` | Free-tier Edit accepted ✓. Bash `printf '\n' >> server/caps.ts`: **ran, file changed** ✗. |

Why: the docs say Read/Edit *deny* rules also cover the Bash file commands
and redirect targets; *ask* rules are not on that list, and the measurement
agrees. A `Bash(*caps.ts*)` rule — tried as ask and as deny — never matched
the redirect command, so Bash text patterns are not the tool either.

What M2 does about it: the never tier stays on deny rules (proven, every
mode). The ask tier becomes **gate step 0**, `scripts/protected-check.sh`:
free, deterministic, fails when an ask-tier file differs from `origin/main`
or is changed in the tree; a human passes it with `FACTORY_ASK_OK=1`, the
agent can't because its allowlist admits `npm run gate` verbatim only. The
Edit ask rules stay for the interactive case. Factory runs use
`--permission-mode acceptEdits` (edits flow, Bash is enumerated — never a
broad `Bash(*)`). The documented hole remains: a Node script that opens the
file itself; the reviewer reads the diff.

Two operational facts found on the way: `permissions.allow` entries in the
repo's settings are **ignored until the workspace is trusted** (one
interactive `claude` in the repo, accept the dialog) — required before M4a
runs headless; and the `-p` JSON result carries `total_cost_usd` (a
no-op call from this repo costs ~$0.06–0.27 depending on cache).

### M3 · Skills and the reviewer

Slash commands and skills are now one mechanism (`.claude/commands/x.md`
and `.claude/skills/x/SKILL.md` both create `/x`). Use skills: the folder
holds the template and rubric next to the instructions.

- `.claude/skills/spec/SKILL.md` — one-line request in,
  `specs/NNNN-slug.md` out from the template that lives beside it, at most
  three clarifying questions, ends with "set `status: ready` to approve".
  This is Anthropic's "sprint contract" checkpoint by another name.
- `.claude/skills/implement/SKILL.md` — reads the spec and the relevant
  playbook, works test-first (the installed `mattpocock-skills:tdd`), runs
  `npm run gate`, fixes at most twice, writes the run record.
- `.claude/skills/review/SKILL.md` — launches the reviewer.
- `.claude/agents/reviewer.md` — frontmatter `tools: Read, Grep, Glob,
  Bash(git diff *)`; `model: sonnet`. Input: the spec's goal + acceptance
  checks and the diff — not the implementer's notes. Output:
  `{ verdict: pass|fail, findings: [] }`. Evaluate it on Sonnet as well as
  Opus — Opus reasons around weak instructions and hides the defect.

**Done when** `/spec` → `/implement` → `/review` runs end to end by hand on
a toy spec.

**Verified 2026-08-29** on a toy spec (`GET /api/health` with `uptimeSeconds`;
kept as `specs/0000-toy-health-uptime.md`, `status: toy`, never merged), run
headless in a throwaway worktree: `/spec` $0.95 (16 turns) → `/implement`
$0.98 (22 turns: tdd skill, red → green, `npm run gate` passed first time) →
`/review` $0.71 → `{ "verdict": "pass", "findings": [] }`; with one comment
line planted in `server/caps.ts`, `/review` $0.72 → `fail`, one `high`
finding naming the file. Reviewer on `model: sonnet` both times.

Two corrections to the text above, from the run: an agent's frontmatter
`tools:` takes tool *names* only — `Bash(git diff *)` granted Bash wholesale
(measured: the agent ran `git status`, `ls`, `cat`). First fix was to paste
the diff into the prompt; Nadav rejected that (2026-08-29) and the reviewer
now has `Bash` and collects the diff itself — the repo's allowlist
(`git diff*`/`status*`/`log*`) is what scopes it in a headless run, one
layer below the frontmatter. Verified: empty tree → the `empty diff`
finding ($0.40); planted `server/caps.ts` comment → `fail`, high finding
on that file ($0.44). `git diff --no-index` is denied by that allowlist, so
untracked files are read with `Read`.
And the implementer's allowlisted commands must be typed verbatim — the
first transcript showed `npm run gate 2>&1 | tail -40`, which is a
different command to the rule engine; the skill now says so.

**2026-08-29 — the sprint-contract checkpoint made mechanical:
`/review-spec`** (`.claude/workflows/review-spec.js`, Check → Clarity →
Craft → Apply). Approving a spec was the one human step with nothing
behind it; the panel run by hand that day on a carefully drafted spec found
3 wrong claims and 16 must-adds (`docs/reviews/0002-spec-panel-2026-08-29.md`),
so the panel is now a saved workflow that runs before the flip. Three
reviewers, sequential and read-only: `spec-checker`
(`.claude/agents/spec-checker.md`, Sonnet) replays every factual claim
against the code and data — line numbers, function behaviour, cache rows,
run numbers, red/green-today — because a spec that cites the code is
usually slightly wrong about it; a clarity reviewer states both readings
wherever two engineers would build different things and holds the
acceptance checks against the implementer's allowlist and the reviewer's
rubric, because the implementer cannot ask; a craft reviewer (low effort)
judges structure, durability of snapshot-dependent claims, demo-able
metrics at the run's sample size and scope for one run. An Apply agent
then writes the corrections and must-adds into the spec, leaves `status:`
as it was and appends `## Panel review` with the open decisions — the
human still flips to ready, now with the facts checked and the decisions
listed. Verified offline: `scripts/workflow-selftest.mjs` drives it against
stub agents (12 cases), and the console parser draws its four phases and
four nodes. Playbook: `docs/playbooks/run-the-factory.md`, "Before
status: ready".

**First real run, 2026-08-29** on `specs/0002` (`wf_48b9d383-e37`,
in-session, 4 agents, 392k tokens, 24 min): 65 claims replayed, 0 wrong,
2 fragile, 15 must-adds, 5 decisions; `status: draft` kept. Against the
hand-run panel of the same day
(`docs/reviews/0002-spec-panel-2026-08-29.md`: 3 wrong, 16 must-adds, 3
decisions): 12 of the 16 must-adds overlapped in substance; the workflow
missed one wrong claim (a token count — "nine" for ten), the eval-case
sentence, the bundling note and an import reuse, and it silently took one
reading that was the author's decision (possessive after a link word); it
found three things the hand panel had not — the `SYSTEM` bullet must be
one physical line or its own test fails, the Led Zeppelin IV false
positive deserved its own fixture and slice, and a "one new hit" count
that was two. The Apply agent also told the implementer to "verify against
the cache" in a spec that forbids opening the cache. Verdict: the panel is
worth running before every flip, and the orchestrator still reads the
diff. Nadav resolved the decisions (edition words only; possessive =
idiom; slices 4–7 stay; persisting bounces deferred) and the misses were
folded in by hand (`41d5884`); flipped to ready at `d1b15f3`.

### M4 · Assembly — twice, same blocks

M1–M3 are engine-agnostic: the map, the rules, the skills and the reviewer
are what *both* orchestrators call. Only this milestone forks. **M4a** is
Claude Code native (below); **M4b** is the same pipeline as an Archon YAML —
section 10 has the comparison and the order.

- Turn on Dynamic workflows in `/config` (Pro plans have it off by
  default; needs v2.1.154+).
- `.claude/workflows/implement-from-spec.js`: phases Implement → Gate →
  Review. The gate is a Bash step run by an agent (the script itself has no
  shell). Loop ≤2. Review returns a schema-validated object; on fail, one
  fix round, then return `needs-human`. Single sequential agents, medium
  effort, no `parallel()`. Set `subagentPromptCacheTtl: "1h"` so the run's
  agents share cache for the whole loop.
- Trigger, first by hand: the saved file already runs as
  `/implement-from-spec specs/0003-….md`. Headless:
  `claude -p --max-turns 60 --max-budget-usd 5 --output-format json
  "/implement-from-spec specs/0003-….md"` with
  `"allow": ["Workflow(implement-from-spec)"]` in settings — headless never
  shows the approval card. The two flags are the talk's hard stop, as
  flags; `total_cost_usd` in the JSON output fills the ledger's cost
  column. Later, a launchd timer over every spec with `status: ready` —
  job-scan already runs this way.

**Done when** one spec goes from `ready` to a PR branch with no human
between approval and review.

**Verified 2026-08-29** — `.claude/workflows/implement-from-spec.js`
committed (`1758ad2`). Shape as built: Implement (the `implement` skill
through the Skill tool) → Gate (a low-effort agent types `npm run gate`
verbatim and returns `{ok, step, log}`) → Review (a low-effort extractor
copies the spec's Goal + Acceptance checks, then `agentType: 'reviewer'`
with schema `{verdict, findings}` — the same three-part prompt `/review`
builds). Gate loop ≤2; a review fail buys one fix round → gate → review,
else `needs-human`; no `parallel()`. Settings: `Workflow(implement-from-spec)`
in allow, `subagentPromptCacheTtl: "1h"`. Registry facts: saved workflows
are scanned at session start, so a file added mid-session needs
`/reload-skills`; `meta.name` defines the `/name`; no CLI lists saved
workflows. Load check: `claude -p "/implement-from-spec"` with no argument
ran the workflow (`wf_b18901ad-f4e`, 13 ms, `needs-human` from the no-arg
guard) — and then the headless top-level model found the ready spec and
re-launched the workflow on `main` by itself (`wf_2a52cfdf-b8a`, killed by
`--max-budget-usd 0.5` after 4.8 s, no file touched; $0.68 for the probe).
The budget flag is the hard stop it was written up as.

Two corrections to the text above, from the run: "the saved file already
runs as `/name`" holds only in a fresh session; and never probe from the
main checkout — the M5 driver cuts a worktree for exactly this. And the
cost expectation: a full line run is ~$3.9 (dry run 1, section 6), not the
$0.4–1.3 M3 measured per skill; the implementer is 94% of it. Done-when
met: `specs/0001` went from `ready` to draft PR #1 with no human between
approval and the verdict (one stash, section 6).

### M5 · Observability and the learning loop

- `docs/factory/RUNS.md`: date · spec · **engine** · attempts · gate ·
  review · autonomous / escalated · cost (USD, from the JSON output).
- Three rules, written in the map: a bug fix ships with a test or eval
  case; friend feedback (the usage ledger, WhatsApp) becomes a `/spec`; a
  prompt-touching spec gets one eval run, human-read.

**Done when** `RUNS.md` has three rows and one eval case exists because of a
factory-built feature.

**Verified 2026-08-29** — `docs/factory/RUNS.md` created (`7da57a5`), one
row (dry run 1, $3.92), written by hand. The done-when — three rows and an
eval case from a factory-built feature — is not yet met; `specs/0002`
(section 6) carries the first candidate case. The driver,
`scripts/factory-run.sh` (`f4dc989`): preflight (spec `status: ready`,
clean main checkout, exit 2 otherwise); worktree `../mixtape-poc.wt` cut
from `origin/main` per run (project slug `-Users-…-mixtape-poc.wt`, which
the console globs); `npm ci` there (server 84 packages in ~0.4 s, client 75
in ~0.9 s, from the cache); a trust check on `~/.claude.json`
`projects[path].hasTrustDialogAccepted` — a worktree is a new directory,
untrusted, and an untrusted directory ignores `permissions.allow`, so the
script exits 3 with the one-time `cd … && claude` instruction rather than
parking a headless run on the approval card; args as one JSON string
`{spec, config}` from `factory.config.json`; the `claude -p` JSON result
saved to `docs/factory/runs/<date>-NNNN.json`; the row inserted from the
run manifest. Exercised with `--dry-run`; `npm run gate` passed inside the
worktree. The matching script patch (JSON `args`, an `implementModel` knob
on the implement and fix agents only, `ready-for-eval` when the contract's
`touches_prompt` is true) sits in the scratchpad for a human to apply —
`.claude/workflows/` is never tier. `factory.config.json` carries
`implementModel: "sonnet"` for dry run 2.

*2026-08-30:* `RUNS.md` has four rows — row 1 autonomous (PR #1), rows 2
and 3 the two escalated attempts of dry run 2, row 4 its autonomous fourth
attempt (section 6) — so the "three rows" half of the done-when is met, and
met twice over by real autonomous runs rather than by escalations. The
eval-case half is still open: `statbait-album-openers` exists on
`factory/0002-album-position-gate-blind-spots`, and the case counts only
once that branch merges. Four
driver corrections, each measured on the day: (1) the trust check was a
false negative — on 2.1.251 a worktree of a trusted repo shows no dialog
and gets no `~/.claude.json` entry; a headless `claude -p` in it ran an
allowlisted `git status` with no denial ($0.26 probe); the check now falls
back to the repo's entry (`f4a39e1`). (2) `claude -p` waits at most 600 s
for a background task, and a Workflow is one; attempt 1 was killed in
Review after 609 s. (3) `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, which the
terminate message recommends "to wait indefinitely", sweeps at once on
2.1.251 (`ceiling = env ?? 600000`, 0 counts as exceeded) — attempt 2 died
after 15 s, $0.35; the driver passes a one-hour ceiling (`e0a0d42`). (4)
the worktree's project dir is `-Users-…-mixtape-poc-wt` (every
non-alphanumeric character becomes `-`, the dot included), not `.wt`; the
finder reads both and prints the journal path when a run ends without a
manifest. Two operational facts outside the driver: the auto-mode
classifier blocks the agent from committing `scripts/factory-run.sh` and
from launching it, so a human runs both lines (`! git commit …`,
`! scripts/factory-run.sh …`); and the account's session limit ("You've
hit your session limit · resets 4:40pm") can end a run mid-line —
attempt 3's reviewer errored at 116 s and the fix round got 0 tokens.

### M6 · The console (visualization layer)

The factory drawn, live, in a browser: every workflow as an animated DAG,
every run as history you can replay, every node's prompt and knobs editable
in place. Section 11 has the research, the decision and the build slices.
One sitting for the read-only view, one more for editing.

**Done when** a dry-run is watched end to end in the console and one prompt
tweak is made from its node panel instead of the editor.

## 6. Dry runs

1. **Client-only, free tier, no prompt — on Claude Code native.** Proves
   M2–M4a with nothing at risk. *2026-08-29:* the "copy link" control this
   line used to name already shipped with the guest flow (`4385a75`,
   `client/src/App.tsx:1759`) — `/spec` found that on its own and wrote a
   contract instead of a delta ($1.22, discarded). Candidates now: a
   **Share** button on the pressed card (`navigator.share` on phones, copy
   as the fallback — real value for friends on mobile), or a keyboard
   shortcut for the existing copy. Human picks; then `/spec` runs once.

   **Verified 2026-08-29 — done.** Share on the pressed card,
   `specs/0001-share-pressed-card.md` (`5dccb5e` draft, `a790832`
   rewritten test-first, `772e833` ready), branch `factory/0001-share`:
   `claude -p "/implement-from-spec specs/0001-share-pressed-card.md"
   --permission-mode acceptEdits --max-turns 60 --max-budget-usd 5
   --output-format json`. Run `wf_9fda3778-dbf`: implement 1 / gate 1 /
   review 1, all first attempt; 4 agents — implement (fable-5, 49k
   tokens, 2m31s), gate (14k, 10 s), contract extractor (18k, 17 s),
   reviewer (sonnet-5, 25k, 1m24s); 106k tokens, 4m22s, 3 top-level
   turns, no permission denials; reviewer `{verdict: pass, findings: []}`;
   `total_cost_usd` $3.92 (fable-5 $3.69 + sonnet $0.22). Gate passed by
   hand again before the commit. Draft PR #1, not merged — the human
   gate. One intervention mid-run: uncommitted console work in the tree
   would have reached the reviewer's `git diff`; stashed by hand before
   the Review phase, and the driver now cuts a worktree so it cannot
   recur. Row 1 of `RUNS.md`. Headless spend for the day: $0.68 (the M4a
   probe) + $3.92 = $4.60.
2. **Prompt-touching.** *2026-08-29:* the lever this line used to name —
   show `track_number` to the curator — already shipped in `6815090` on
   2026-08-23. Replaying the current gate over both judged runs: album
   position still tops invented notes (5/13 on 08-23 → 2/10 on 08-24; the
   08-24 headline is inventedRate 0.099 on 101 checkable, 14/18 cards
   judged), the four refutable 08-23 cases are gone, the two 08-24
   survivors are blind spots of `albumPositionContext` (album words beyond
   "album"; per-disc `track_number`), and the rule bounces four
   judged-true notes. The feature is now
   `specs/0002-album-position-gate-blind-spots.md` (`ba55caf`, draft):
   `touches_prompt: true`, no ask-tier file, one eval case
   `statbait-album-openers`. It touches `server/curator.ts`, so it
   exercises `touches_prompt: true`, the driver's `ready-for-eval` outcome
   and the one-shot eval read; on the Archon leg (item 3, section 10) the
   same spec is where the in-workflow approval node before the eval spend
   gets felt. Dry run 2 runs it with `implementModel: "sonnet"`.

   **Verified 2026-08-29/30 — three attempts, no autonomous row yet.**
   Spec 0002 reviewed by `/review-spec` and by hand (M3), flipped to
   ready (`d1b15f3`), run through `scripts/factory-run.sh` with
   `implementModel: "sonnet"`. Attempt 1 (`wf_0684802b-74d`, $3.26):
   implement on Sonnet 6m49s, 106k tokens, gate passed first run,
   contract extracted, reviewer cut at 2m14s by the 600 s ceiling — no
   verdict; branch validated by hand (gate, 125 tests), diff kept as
   `docs/factory/runs/2026-08-29-0002-attempt1.diff`. Attempt 2
   (`wf_b0d5ee18-0a6`, $0.35): swept after 15 s by the ceiling set to 0.
   Attempt 3 (`wf_66ec6c31-e3f`, $2.74): implement 6m36s, 101k tokens,
   gate passed first run, contract extracted, then the reviewer and the
   fix round hit the account session limit; branch validated by hand
   again (gate, 125/125), diff kept as `…-attempt3.diff`.

   **Verified 2026-08-30 — attempt 4 is the autonomous row.** Relaunched
   from a clean `main` into a fresh session window; the two fixes that
   mattered were the one-hour background ceiling (`e0a0d42`) and the
   window itself. Run `wf_2d570cca-1ac`, 11.2 min, 197k tokens, 4 agents,
   exit 0: implement 1 / gate 1 / review 1, every phase first-try, gate
   passed on its first run, and the reviewer returned
   `{verdict: pass, findings: []}` — the first real verdict this spec has
   ever had, since attempts 1 and 3 were both cut inside Review. Outcome
   `autonomous (ready-for-eval)`, the `touches_prompt: true` path the spec
   was chosen to exercise. Validated by hand before the PR: `npm run gate`
   passed in 3 s, 125/125 tests, +8 tests in `server/test/curator.test.ts`
   (61 → 69) carrying the spec's eight slices, its 7-row fixture table cell
   for cell, and both must-stay-green guards; no ask-tier, never-tier or
   `package.json` path. Branch `factory/0002-album-position-gate-blind-spots`
   at `23e87a4`; ledger rows and the PR body on `main` (`a700392`,
   `588c59a`).

   One permission denial, and it is the allowlist working: an agent tried a
   compound `git status && echo … && node -e …` line, which the
   exact-string allowlist refuses, and it recovered without help.

   What the four attempts say about the engines: Sonnet implements this
   8-slice spec in ~6.7 min for ≈$2.5 against Fable's 2.5 min / $3.69 on
   the one-slice spec 0001 — cheaper per run, not per minute. **The
   like-for-like row (item 3) is still owed, and attempt 4 is not it:**
   its $2.93 splits as $1.91 sonnet plus $1.02 opus-5[1m] at the top level,
   because `claude -p` inherits the CLI's default model and a `/model` in an
   interactive session that morning moved orchestration off fable-5, where
   attempts 1–3 ran. That is a knob nobody had counted — the driver pins
   the implementer's model through `factory.config.json` but the
   orchestrator's model rides on whatever the human last chose. Sonnet
   again wrote all eight tests and the code together — three runs, three
   times, no red-then-green per slice as the spec asks, a standing point
   for the pre-merge `/code-review`. Headless spend: $6.61 on 2026-08-29
   plus $2.93 on 2026-08-30 = $9.54 across the four attempts;
   `/review-spec` ran in-session. Next, all Nadav's: the draft PR,
   `/code-review`, the merge, and the one eval run read against
   `evals/thresholds.json`.
3. **The same feature on the other engine**, once each, so `RUNS.md` has a
   like-for-like row: lines of orchestration, cost, minutes, and where each
   one made you intervene.

Take the features from friends' feedback first — that is the loop the talk
describes.

## 7. The interview map

| Block | What you show | The number |
| --- | --- | --- |
| Context | `CLAUDE.md` as a map, path-scoped rules, three ADRs | ~60 lines under a 200-line ceiling; the A/B that made it a map |
| Evals | `thresholds.json` set from a baseline; one-shot gate; pass^k in `reliability.ts` | 24.0% → 10.1% invented notes |
| Commands | `/spec` `/implement` `/review` as skills | 3 skills, 1 agent |
| Gates | `npm run gate`; deny/ask rules refusing an edit | "prompt rules die at 20–30% context; deny rules are evaluated before the model gets a say" |
| Observability | `RUNS.md` with real cost per run; the bug → eval-case rule; **the console** — the DAG animating while a run is live, then replayed | attempts and escalations per run; tokens per node |
| Shaping | the reviewer's tools, the ≤2 retry, `--max-budget-usd`, the schema handoff | the half-billion-dollar loop, now a CLI flag |

## 8. Order and effort

M1 + M2 in one evening, M3 in one, M4 in one, M5 folds into dry run 1,
M6 (the console) one or two more once there are runs to draw.
About five or six sittings. The write-up is this file plus `RUNS.md` — no separate
blog post needed.

## 9. Alignment check — 2026-08-28

Three research passes (Anthropic docs + engineering blog; practitioner
write-ups; evals and guardrail tooling), then the load-bearing claims
re-read in the docs by hand. What changed in this plan, and what held.

**Changed**

- *Tiers: `permissions.deny` / `permissions.ask` instead of a hook — a
  preference, not a correction.* The talk's hook is equally hard
  enforcement. Docs: "Rules are evaluated in order: deny, then ask, then
  allow"; "Hook decisions don't bypass permission rules"; deny rules also
  apply to `cat`/`head`/`sed` in Bash. Hooks remain the tool for logic a
  glob can't express, or for a block message with an unlock path. The
  env-var escape hatch went with the hook. (code.claude.com/docs/en/permissions)
- *Retry ≤2 — preference, not a correction.* The talk says 3.
- *Commands → skills.* "Custom commands have been merged into skills";
  `.claude/commands/` still works, but a skill folder carries the template
  and rubric. (code.claude.com/docs/en/skills)
- *CLAUDE.md ceiling is Anthropic's 200, not 60.* Keep ~60 as the personal
  target; move path-specific gotchas to `.claude/rules/` with `paths:`.
  `/init` under `CLAUDE_CODE_NEW_INIT=1` and `/doctor` do the first draft
  and the trim. (code.claude.com/docs/en/memory)
- *Retry ≤2, not ≤3.* coleam00's `FACTORY_RULES.md` escalates on the third
  cycle; nothing argues for a third attempt at this scale.
- *Hard stops are flags now.* `claude -p --max-turns N --max-budget-usd X`;
  the JSON output's `total_cost_usd` feeds the ledger.
  (code.claude.com/docs/en/headless)
- *Workflow mechanics.* Pro must enable Dynamic workflows in `/config`;
  headless runs need `Workflow(<name>)` in allow rules; the script has no
  shell of its own; "no mid-run user input — for sign-off between stages,
  run each stage as its own workflow", which is the two-workflow split.
  (code.claude.com/docs/en/workflows)
- *Reviewer gets a model.* `model: sonnet` in the agent frontmatter — the
  talk's "the judge needn't be the heavy model", now a one-liner.

**Held, with better citations**

- Separate evaluator: Anthropic, *Harness design for long-running
  application development* (2026-03-24) — a generator reviewing its own diff
  "confidently praises" mediocre work; tune a standalone evaluator to be
  skeptical instead. Its "sprint contract" is our spec approval.
- Holdout reviewer: StrongDM's rule and coleam00's "the validator must never
  see the coder's reasoning, plans, or implementation artifacts".
- Evals once, human-read: Anthropic, *Demystifying evals for AI agents*
  (2026-01-09) — keep reading transcripts by hand; promptfoo gates on a
  pass-rate threshold, never 100%, because judges are non-deterministic.
  Braintrust auto-blocks merges on eval breach; LangSmith informs. This plan
  is on the LangSmith side on purpose, because of the Spotify quota.
- Two human touchpoints: matches Shapiro's level 4 and spec-kit's "approved
  by the user" gate; StrongDM and coleam00 remove the merge touchpoint too.
  We don't — light factory.
- Bug fix ships with a test: coleam00's PR rule ("fail on main, pass on
  branch").

**Tension left open**

- Anthropic's eval guidance wants multiple trials (pass^k) on every agent
  change; the truthfulness eval can only afford one run per prompt change.
  `reliability.ts` already does pass^k on the cheaper contract check —
  run *that* k=3 on prompt-touching specs and accept a single truthfulness
  run. Revisit if the Spotify quota situation changes.
- The "never" list in the wild is wider (secrets, auth, rate limits,
  deploy config). Auth and caps are "ask" here because the owner is the only
  operator; promote them to deny the day someone else runs the factory.

## 10. Two engines — Archon vs Claude Code native

Archon is the engine the talk demos: open source (MIT, ~23k stars, Homebrew
install, `.archon/workflows/*.yaml`). The fact that makes trying it cheap:
**Archon's agent is Claude Code.** Its `command:` nodes run your skills, its
`bash:` nodes run your gate, and the agents it spawns obey the same
`.claude/settings.json` rules. So M1–M3 are shared; only the orchestration
file is written twice.

| | Archon | Claude Code native |
| --- | --- | --- |
| The plan lives in | a YAML DAG: `nodes`, `depends_on`, `when`, `loop … until`, `trigger_rule` | a JS script: `agent()`, `pipeline()`, ordinary `if`/`for` |
| Install | `brew install coleam00/archon/archon`, needs Bun + `gh` + the `claude` binary | toggle in `/config` |
| Human approval | inside the workflow: a node with `interactive: true` pauses until `APPROVED` | not possible mid-run — split into two workflows at the gate |
| Deterministic gate | a `bash:` node, no model involved | an agent runs `npm run gate` for you (the script has no shell) |
| Agent per step | `command:` = a skill; `model:` and `context: fresh` per node | `agent(prompt, {agentType, model, effort})` |
| Structured handoff | `output_format:` JSON schema on a node | `schema:` option on `agent()` |
| Reviewer isolation | `context: fresh` + a different `command:` | a separate `.claude/agents/reviewer.md` |
| Retry loop | `loop: { until, max_iterations }` | `for (let i = 0; i < 2; i++)` |
| Triggers | CLI `archon workflow run`, `archon serve` webhooks (GitHub, Slack, Telegram), cron via the server | `/name` in a session, `claude -p`, launchd, cloud Routines |
| Watching a run | "Mission Control" web dashboard, per-run artifacts dir, worktree per run | `/workflows` view, `--output-format json` cost, `isolation: 'worktree'` |
| Readable by | humans and models — the talk's argument for YAML | you, and Claude, who wrote it |
| Failure modes to expect | another daemon, `gh` auth, `CLAUDE_BIN_PATH`, checking how it launches `claude` (verify deny rules still hold under its flags) | Pro window burn, the approval-card rule in headless |

**The same three steps, both ways** — after M3 the intelligence is in the
skills, so both files are short:

```yaml
# .archon/workflows/implement-from-spec.yaml
name: implement-from-spec
provider: claude
model: sonnet
nodes:
  - id: implement
    command: implement            # your .claude/skills/implement
    loop: { until: GATE_PASSED, max_iterations: 2 }
  - id: gate
    bash: npm run gate
    depends_on: [implement]
  - id: review
    command: review               # your reviewer agent
    depends_on: [gate]
    context: fresh
    output_format: { type: object, properties: { verdict: { enum: [pass, fail] } } }
  - id: approve
    depends_on: [review]
    loop: { interactive: true, until: APPROVED }
```

```js
// .claude/workflows/implement-from-spec.js
export const meta = { name: 'implement-from-spec', description: 'spec → reviewed branch' }
const spec = args
let gate
for (let i = 0; i < 2; i++) {
  await agent(`/implement ${spec}`, { phase: 'Implement' })
  gate = await agent('Run `npm run gate`; return {ok, log}', { schema: GATE, phase: 'Gate' })
  if (gate.ok) break
}
if (!gate.ok) return { status: 'needs-human', gate }
const review = await agent(`Review ${spec} against the diff`, { agentType: 'reviewer', schema: REVIEW, phase: 'Review' })
return { status: review.verdict === 'pass' ? 'ready-for-pr' : 'needs-human', review }
```

(Both are sketches: Archon's exact loop/`until` grammar and the JS
`schema` objects get filled in from the docs when M4 starts.)

**How to proceed**

1. M1–M3 first, unchanged. They are 80% of the work and both engines eat
   them as-is.
2. M4a native, dry run 1. Zero install, one sitting, and it proves the
   blocks before a second tool enters the picture. If Archon setup eats an
   evening later, you already have a working factory.
3. M4b Archon, dry run 2. Install via Homebrew (not `curl | bash`), let the
   repo's own `claude` session run "Set up Archon", write the YAML above
   against your skills. Its in-workflow approval node is the thing to feel
   — it's the talk's "lights on" moment, and native can't do it.
4. One like-for-like run each way, logged in `RUNS.md` with an `engine`
   column. That table is the interview answer to "why did you pick X":
   you didn't — you measured.

What Archon adds for learning: a DAG you can read in a `git diff`, an
approval step inside the run, a dashboard, webhook triggers you'd otherwise
never wire. What it costs: a daemon and one more thing that can be
misconfigured. For Mixtape alone, native is enough; for the job search, the
comparison is the deliverable.


## 11. The console — a visualization layer for the factory

Added 2026-08-28 after a research pass (tools surveyed, libraries measured,
Claude Code's on-disk run records read by hand). The ask: an admin page where
every workflow is a clear, animated flow, each run can be watched and replayed,
and the parts that need tweaking can be tweaked there — light, one person,
beautiful.

### 11.1 The decision

Build a small page of our own, don't adopt a platform. Verdict in one line:
**nothing off the shelf reads Claude Code workflow runs, and everything that
draws DAGs well is a service (Postgres, Docker, a JVM) or the wrong shape
(durable-execution timelines, LLM-chain canvases).** The data we need already
exists on disk, so the "backend" is a dev-server plugin of ~60 lines.

| Option | Why not (or why yes) |
| --- | --- |
| **Archon Mission Control** | Yes — for the Archon leg (M4b). It ships run history, a step-by-step execution view, a drag-and-drop DAG builder and the in-run approval UI. Don't rebuild it; later, point the console at Archon's SQLite so both engines draw in one place. |
| Kestra | Closest turnkey match (live topology, YAML editor, Pause task = approval, shell tasks) — but Java + Docker for a hobby box. |
| n8n, Windmill, Trigger.dev | Services with databases; general automation, won't read Claude Code runs; n8n's shell node is off by default since 2.0. |
| Temporal, Inngest, Restate, Vercel Workflow, DBOS | Durable-execution engines: the UI is a step timeline, not a graph, and the factory would have to be rewritten in their SDK. |
| Mastra Studio | The nicest graph view with live steps and suspend/resume — but only for workflows written in Mastra. |
| Prefect, Dagster | Python, data-asset model. |
| Flyde, Node-RED, Rivet | In-code dataflow / event flows / a desktop app whose last release was Aug 2025. Wrong shape. |
| Motia | Winding down (site redirects). |
| `claude-workflow-viz` | Zero-dep viewer of the exact run files we use: terminal DAG, gantt, single-file HTML with a replay scrubber, `wfviz watch` for live runs. 10 stars. **Stopgap today and the reference for the file format**, not a dependency. |

The Claude Code `/workflows` view is a TUI — phases, agents, tokens, `p`/`x`/`r`
— with no browser surface and no export. That is the gap the console fills.

### 11.2 What the engine already writes (verified 2026-08-28, one real run)

Every native run leaves, under `~/.claude/projects/<slug>/<session>/`:

- `workflows/wf_<id>.json` — the run manifest. Top level: `runId`,
  `workflowName`, `status` (`completed` …), `startTime`, `durationMs`,
  `agentCount`, `totalTokens`, `totalToolCalls`, `defaultModel`, `phases`
  (`title`, `detail`), `logs[]`, `result`, `args`, `script`, `scriptPath`
  (→ `workflows/scripts/<name>-<runId>.js`), and `workflowProgress[]`.
- `workflowProgress` entries are `workflow_phase` (`index`, `title`) and
  `workflow_agent`: `label`, `phaseIndex`, `phaseTitle`, `agentId`, `model`,
  `fallbackModel`, `state` (`done` | `error`; live states not yet observed),
  `attempt`, `queuedAt`, `startedAt`, `lastProgressAt`, `durationMs`,
  `tokens`, `toolCalls`, `lastToolName`, `lastToolSummary`, `promptPreview`
  (80 chars), `resultPreview`, `error`.
- `subagents/workflows/wf_<id>/journal.jsonl` — `started` / `result` per
  agent keyed by a prompt hash (the resume cache), plus one full transcript
  per agent, `agent-<id>.jsonl` (first line = the full prompt; every line has
  a `timestamp`; assistant lines carry `usage` and `model`).

So the console reads files; it never talks to Claude. Two things the manifest
does **not** have: USD cost (tokens only — USD comes from the `claude -p
--output-format json` result, which the driver writes into `RUNS.md`), and
the prompt beyond 80 characters (read the agent transcript's first line).
Hooks exist for live pushes (`SubagentStart` / `SubagentStop` with `agent_id`)
but carry no label; the manifest already does, so hooks are not needed.

Unverified, and the first thing to check in the build: whether
`wf_<id>.json` is rewritten *during* the run (`lastProgressAt` suggests it)
or only at the end. If only at the end, live view falls back to tailing
`journal.jsonl` + agent transcripts, which are appended as they go.
Measured 2026-08-29: only at the end — on `wf_9fda3778-dbf` the journal
opened 09:43:38, the manifest appeared 09:48:00, nothing between; a budget
kill writes one with `status: killed`. `journal.jsonl` has the `started` /
`result` lines keyed by prompt hash with no timestamp or label;
`agent-<id>.jsonl` carries the timestamps, usage and model; a live agent's
manifest `state` is `progress` (not in the list above). So the live view
is journal-driven — C3.

### 11.3 Shape

```
tools/console/                      a second Vite root, never deployed
  index.html · main.tsx · vite.config.ts
  plugin.ts      ← the "backend": a Vite configureServer middleware
  graph/         ← script → nodes+edges (static), run → node states (dynamic)
  ui/            ← Canvas · RunList · NodePanel · Replay
npm run console  →  http://127.0.0.1:5174
```

- **Rendering:** `@xyflow/react` 12.x (58 kB gz, MIT, released this week —
  the canvas under n8n, Windmill and DBOS's viewer) + `@dagrejs/dagre` 3.x for
  layout (15 kB; the unscoped `dagre` has been dead since 2019). Optional:
  `motion` for node pulses. ~75 kB total. React 18 is already the client's
  stack, so nothing new to learn.
- **The plugin** (`plugin.ts`): `GET /api/workflows` lists `.claude/workflows/*.js`,
  `.claude/skills/*/SKILL.md`, `.archon/workflows/*.yaml`; `GET /api/runs`
  globs `~/.claude/projects/<slug>/*/workflows/wf_*.json` for this repo's
  slug and returns them newest first; `GET /api/runs/:id/agent/:agentId`
  returns the full prompt and result from the transcript; `GET /api/events`
  is SSE from `fs.watch` on those directories; `POST /api/file` writes back
  — path-allowlisted to the three workflow/skill/YAML globs plus
  `factory.config.json`, nothing else. No database, no auth, bound to
  127.0.0.1. It reads the home directory, which is exactly why it never
  ships anywhere.
- **Two sources for the graph, one drawing.** Static: parse the script for
  `meta.phases` and every `agent(…, { label, phase })` call — the factory
  scripts are short and regular enough for a regex, and the same parser reads
  Archon YAML `nodes` / `depends_on` for real. Dynamic: overlay a run's
  `workflowProgress` onto those nodes by `label`. A run that spawned nodes the
  script doesn't name (a `pipeline()` fan-out) adds them under their phase.

### 11.4 What it looks like

Three screens, one accent color, dark by default, no chrome that a screenshot
would have to crop.

1. **Workflows.** A card per workflow (native and Archon side by side, an
   `engine` badge) with its DAG drawn small and the last run's status. Click
   → the canvas.
2. **Canvas.** Phases as swimlanes left to right, agents as nodes inside
   them, the gate as a diamond, the human points as octagons. State is color
   and motion, never text alone: idle grey · queued dotted · running pulsing
   with the incoming edge's dash animating (`animated` edge) · done solid ·
   error red with the error string on hover · waiting-for-human amber and
   breathing. Node chips: model, attempt, tokens, duration. Run header:
   status, elapsed, total tokens, USD when `RUNS.md` has it. A run picker on
   the right lists history; a **replay scrubber** at the bottom plays a
   finished run back at 20× from `queuedAt` / `startedAt` / `lastProgressAt`
   — that is the demo clip.
3. **Node panel** (slides in on click). Tabs: *Prompt* (the skill's
   `SKILL.md` for a `/skill` node, or the literal prompt), *Knobs* (`model`,
   `effort`, `schema`, retries, `--max-budget-usd` — read from
   `factory.config.json`, which the driver passes to the run as `args`),
   *Last result* (the schema'd object, pretty-printed), *Transcript* (tool
   calls in order, from `agent-<id>.jsonl`). Save writes the file through
   `POST /api/file` and shows the diff first.

### 11.5 What "tweak" means, honestly

- **Prompts and knobs — yes, in place.** They live in files the node panel
  can own: `SKILL.md`, `factory.config.json`, the reviewer agent's
  frontmatter. This is 90% of what you will ever change.
- **The script text — yes, as text with a diff.** A `.js` workflow is
  imperative; the console shows it as a graph but edits it as code.
- **Drag-editing the DAG — only for Archon YAML.** A node/edge is a real
  thing there (`id`, `depends_on`), so drag → YAML is a faithful round trip;
  Archon's own builder already does it, and the console can defer to it.
  For a `.js` script the graph is emergent from `if`/`for`, so a drag-edit
  would be a lie. Don't build it.

### 11.6 Build slices — each one demoable

- **C1 · Draw the map.** Static graph from the script/YAML, dagre layout,
  swimlanes, the six node states styled with fixture data. No plugin yet —
  fixtures in `graph/fixtures/`. *Done when* the plan's §4 diagram is
  recognisable on screen and a designer wouldn't wince.
- **C2 · Runs and replay.** The plugin's read endpoints; the run picker;
  overlay real `wf_*.json` (use the July job-scan review run as the first
  fixture — 26 agents, errors included); the scrubber. *Done when* a
  finished run replays with correct timing and the failed agents go red at
  the right moment.
- **C3 · Live.** SSE + `fs.watch`; confirm whether the manifest updates
  mid-run, fall back to `journal.jsonl` if not. *Done when* dry-run 1 is
  watched from the console with the terminal closed.
- **C4 · Tweak.** Node panel, the allowlisted write, the diff preview,
  `factory.config.json` → `args`. *Done when* the M6 done-when holds.
- **C5 · Archon lane** (after M4b). Read `.archon/workflows/*.yaml` for the
  graph and Archon's SQLite for runs; same canvas, `engine` badge. *Done
  when* dry-run 2 shows up next to dry-run 1.

C1–C2 are one sitting; C3–C4 another. C5 waits for Archon to exist.

**Verified 2026-08-29** — C3 (`342d3c7`) and C4 (`01c904e`, `1edd82a`)
done; the M6 done-when holds. C3: the manifest is written only at run end
(11.2), so `/api/runs` derives a live record from `journal.jsonl` plus the
agent transcripts, pushed by SSE over `fs.watch`, every record tagged
`source: journal | merged | manifest`; dry run 1 was watched live in the
browser. C4: `POST /api/file` allowlisted to the workflow / skill / agent /
YAML globs plus `factory.config.json`, a sha256 `base` → 409 when the file
changed on disk, an LCS line diff before the write (no library). Verified
by editing one line of `implement/SKILL.md` from the node panel and
reverting it the same way — byte-identical afterwards. The parser was
fixed for template-literal labels (`gate:${round}` → `gate:*`; the Gate
and Review lanes had been drawn empty). Then `1edd82a`: runs read from
every `<slug>`, `<slug>.x` and `<slug>-x` project dir (the driver's
worktree), loop-back edges for `fix:*` nodes labelled with the enclosing
`for` bound (≤2 / ≤1), USD from `RUNS.md` through `GET /api/ledger`.

One correction to 11.5 and 11.7: the console *can* write never-tier files
— `.claude/skills/*/SKILL.md`, `.claude/agents/*.md` and
`.claude/workflows/*.js` are on its allowlist by design. That is the Node
`fs` hole M2 documents, and the console is the human's tool, not the
agent's: a human edits the line from the panel; the agent, verifying it,
edits and reverts.

**UX pass 1, 2026-08-29 (branch `console/ux-pass-1`)** — the console
audited as a monitoring product, in a real browser against the six runs
on this machine, and reworked screen by screen. What the reader now gets:
a card says what the workflow does (`meta.description`, `whenToUse`), its
last run in one line (outcome in the workflow's own words · spec · when ·
duration · USD, then where it stopped or what runs now), a phase strip in
place of the unlabelled thumbnail, and a copyable "run it" block under the
reminder that the console never starts a run; a skills-and-agents table
says what each file does and which step calls it. The canvas reads left
to right — lane subtitles from the phase `detail`, a purpose line per step,
orthogonal edges routed by `layout.ts` (the fix loops run under the shelf
with their `≤n` bound readable), and an OUTCOME column lit by
`result.status`. A journal-only run takes its step labels from the copied
script; a stale run's unfinished agents are `stalled`, not `running`. The
panel never clips a label, sits beside the canvas, and edits files in
CodeMirror 6 with a side-by-side diff (the one dependency added on
purpose; the write path is unchanged). The rail groups runs by workflow
with a filter; the replay bar marks phases and agents. Deferred items and
the ranked audit are in the PR.

### 11.7 Rules

- Local only, forever. It reads `~/.claude`; the shareable artifacts are
  the code, screenshots and a replay GIF — hold those to the same bar as
  the product itself (LinkedIn-shareable by default).
- The console must never be able to *start* a run. Starting is `claude -p`
  with the hard-stop flags, or Archon; the console watches and edits. One
  less way to burn a window by accident.
- Tolerate missing keys. The manifest shape above is from one Claude Code
  version; the loader treats every field as optional and shows "—".
- No new state. If something needs remembering, it is a file the repo
  already has (`RUNS.md`, `factory.config.json`), not a console database
  (the one exception: the node panel's width, a per-viewer convenience in
  the browser's `localStorage` — never a run, never a definition).

### 11.8 Sources

Anthropic docs: `code.claude.com/docs/en/workflows` (the `/workflows` TUI,
run persistence under the session dir, resume semantics), `…/hooks`
(`SubagentStart`/`SubagentStop`, `agent_id`/`agent_type`). On-disk: run
`wf_d62c68a5-d0a` (2026-07-31, job-scan review). Tools: coleam00/Archon README
(dashboard, builder, `interactive: true`), kestra-io/kestra, n8n Execute
Command docs, windmill flow editor, temporalio/ui, inngest dev server,
trigger.dev self-hosting, mastra-ai/mastra, restatedev, dbos-inc + tmarkovski/
dbos-argus, democra-ai/claude-workflow-viz, d-kimuson/claude-code-viewer.
Libraries: xyflow/xyflow (`animating-edges`, dagre and elkjs examples; the
"Workflow Editor" template is Pro-only, its mechanics are in the free
examples), dagrejs/dagre, erikbrinkman/d3-dag, kieler/elkjs, mermaid
(no drag, `securityLevel: 'loose'` for clicks — rejected), jerosoler/Drawflow
(stale 2024 — rejected), GoJS (commercial — rejected). Sizes from
bundlephobia, 2026-08-28.
