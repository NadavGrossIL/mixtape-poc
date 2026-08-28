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

### M5 · Observability and the learning loop

- `docs/factory/RUNS.md`: date · spec · **engine** · attempts · gate ·
  review · autonomous / escalated · cost (USD, from the JSON output).
- Three rules, written in the map: a bug fix ships with a test or eval
  case; friend feedback (the usage ledger, WhatsApp) becomes a `/spec`; a
  prompt-touching spec gets one eval run, human-read.

**Done when** `RUNS.md` has three rows and one eval case exists because of a
factory-built feature.

## 6. Dry runs

1. **Client-only, free tier, no prompt — on Claude Code native.** A "copy
   link" control on the finished card, or a keyboard shortcut. Proves
   M2–M4a with nothing at risk.
2. **Prompt-touching — on Archon.** Show `track_number` to the curator so
   opener / closer claims are grounded (the next lever named in the Aug 23
   validation). Touches `server/curator.ts`, so it exercises
   `touches_prompt: true` and the one-shot eval read — and Archon's
   in-workflow approval node before the eval spend.
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
| Observability | `RUNS.md` with real cost per run; the bug → eval-case rule | attempts and escalations per run |
| Shaping | the reviewer's tools, the ≤2 retry, `--max-budget-usd`, the schema handoff | the half-billion-dollar loop, now a CLI flag |

## 8. Order and effort

M1 + M2 in one evening, M3 in one, M4 in one, M5 folds into dry run 1.
About four sittings. The write-up is this file plus `RUNS.md` — no separate
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
