// Shapes of what Claude Code writes on disk, as observed 2026-08-28 on one
// real run (wf_d62c68a5-d0a). Every field is optional on purpose: the format
// belongs to one Claude Code version and the loader must show "—", not crash.

export type AgentState = 'done' | 'error' | 'running' | 'queued' | string

export interface WorkflowPhaseEntry {
  type: 'workflow_phase'
  index?: number
  title?: string
}

export interface WorkflowAgentEntry {
  type: 'workflow_agent'
  index?: number
  label?: string
  phaseIndex?: number
  phaseTitle?: string
  agentId?: string
  model?: string
  fallbackModel?: string
  state?: AgentState
  attempt?: number
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  durationMs?: number
  tokens?: number
  toolCalls?: number
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
}

export type ProgressEntry = WorkflowPhaseEntry | WorkflowAgentEntry | { type: string }

export interface RunManifest {
  runId?: string
  workflowName?: string
  status?: string
  startTime?: number
  timestamp?: string
  durationMs?: number
  agentCount?: number
  totalTokens?: number
  totalToolCalls?: number
  defaultModel?: string
  phases?: { title?: string; detail?: string }[]
  /** The script's own `log()` lines, in order (`[review:1] failed: …`). */
  logs?: string[]
  /** The engine's own error when it aborted the run (`Error: Workflow aborted` + a stack, on a `--max-budget-usd` / `--max-turns` stop). */
  error?: string
  result?: unknown
  args?: unknown
  script?: string
  scriptPath?: string
  summary?: string
  workflowProgress?: ProgressEntry[]
  /** Set by the plugin when the manifest came from fixtures/, not ~/.claude. */
  fixture?: boolean
  /** Set by the plugin: something of this run moved on disk in the last 15 min (C3). */
  live?: boolean
  /** Set by the plugin: the terminal manifest, the journal fallback, or a non-terminal manifest overlaid with the journal. */
  source?: 'manifest' | 'journal' | 'merged'
  /** Newest agent timestamp; the plugin fills it for journal-derived and merged runs. */
  lastProgressAt?: number
  /** The ~/.claude/projects dir the run was read from: the repo's slug, or a sibling checkout's (`…-mixtape-poc.wt` for the driver's worktree). */
  projectSlug?: string
  /** Set by the plugin: absolute paths to everything this run left on disk (it walks them anyway). */
  paths?: RunPaths
  /** Set by the plugin: where the run actually happened, from the first line of any agent transcript. */
  git?: RunGit
}

/**
 * Every artefact of a run, absolute, so the console can name it and a human can
 * open it in an editor. Nothing here is served by `/api/file` — these live under
 * `~/.claude`, outside the repo; they are paths to copy, and the two things the
 * page can show (the frozen script, a transcript) it already has in the run
 * record and through `/api/runs/:id/agents/:agentId`.
 */
export interface RunPaths {
  /** `<session>/workflows/<runId>.json` — absent while the run is going (the engine writes it at the end). */
  manifest?: string
  /** `<session>/subagents/workflows/<runId>/journal.jsonl`. */
  journal?: string
  /** The script the engine froze and ran (`manifest.scriptPath`, else the copy in `workflows/scripts/`) — NOT the live repo file the Script tab edits. */
  scriptCopy?: string
  /** The Claude Code session dir the run belongs to (the manifest's, else the journal's). */
  sessionDir?: string
  /** agentId → its transcript and the `agent-<id>.meta.json` next to it. */
  agents: Record<string, { transcript: string; meta?: string }>
}

/** `cwd` and `gitBranch`, on every transcript line; the plugin reads the first line of one transcript per run. */
export interface RunGit { branch?: string; cwd?: string }

/** What `GET /api/events` streams (one JSON object per SSE `data:` line). */
export type ConsoleEvent = { kind: 'runs' } | { kind: 'journal'; runId: string } | { kind: 'workflows' } | { kind: 'ledger' }

/** One row of docs/factory/RUNS.md, keyed by run id (`GET /api/ledger`). `cost` is USD. */
export interface LedgerEntry {
  cost?: number
  date?: string
  spec?: string
  outcome?: string
  notes?: string
  /** 1-based line of this row in RUNS.md, so the page can open the file at it. */
  line?: number
  /** The driver's saved results for this row, absolute, oldest attempt first (`docs/factory/runs/<date>-NNNN[-attemptN].{json,diff,pr.md}`). */
  driverFiles?: DriverFiles
  /** Parsed per driver JSON, keyed by its absolute path — what the envelope says about cost and why it stopped, so the page never opens the raw file for those. */
  driverExtracts?: Record<string, DriverExtract>
}
export interface DriverFiles { json?: string[]; diff?: string[]; pr?: string[] }

/** The `claude -p` result envelope, boiled down. Every field optional: the envelope belongs to one CLI version and a foreign file must degrade, not crash. */
export interface DriverExtract {
  /** `total_cost_usd`. */
  cost?: number
  /** `num_turns`. */
  numTurns?: number
  /** `terminal_reason`, else `stop_reason` — "completed" over the raw "end_turn". */
  stopReason?: string
  /** `is_error`. */
  isError?: boolean
  /** `api_error_status` (429 = the account window). */
  apiErrorStatus?: number
  /** The `result` string's first ~200 chars, whitespace collapsed. */
  resultHead?: string
  /** The result was the session-limit sentence (`SESSION_LIMIT_RE`). */
  sessionLimited?: boolean
  /** `4:40pm (Asia/Jerusalem)` — the reset tail, when the sentence carries one. */
  sessionLimitResets?: string
}
export type Ledger = Record<string, LedgerEntry>

/**
 * What a definition file says about itself. A script's `export const meta`
 * (description, whenToUse, phases, outcomes) or a SKILL.md / agent .md
 * frontmatter (description, argument-hint, model, tools,
 * disable-model-invocation). Every field optional: a file without a header
 * is still listed.
 */
export interface WorkflowMeta {
  description?: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  /** The words a script can `return { status }` with, e.g. `ready-for-pr | ready-for-eval | needs-human`. */
  outcomes?: string[]
  argumentHint?: string
  model?: string
  tools?: string[]
  disableModelInvocation?: boolean
}

export interface WorkflowFile {
  name: string
  engine: 'native' | 'archon'
  /** `agent` = `.claude/agents/<name>.md`, a named subagent a script calls by `agentType`. */
  kind: 'script' | 'skill' | 'agent' | 'yaml'
  path: string
  source: string
  /** sha256 of `source`: the `base` a `POST /api/file` must carry (C4). */
  sha: string
  fixture?: boolean
  meta?: WorkflowMeta
}

/** `GET /api/file` and the success reply of `POST /api/file`. */
export interface FileRead { path: string; content: string; sha: string }

export interface AgentDetail {
  prompt: string
  result: string
  events: { ts: string; kind: string; name?: string; summary: string }[]
}

// --- graph -----------------------------------------------------------------

/** `stalled`: the run is `stale` (nothing on disk moved for 15 min) and this agent never settled — it was running or queued when the trail went cold. */
export type NodeState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'waiting' | 'stalled'
export type NodeKind = 'agent' | 'gate' | 'human'

export interface GraphNode {
  id: string
  label: string
  phase: string
  kind: NodeKind
  /** A node whose label ended in an expression, e.g. `review:*`; a run expands it. */
  template?: boolean
  /** `agentType:` from the call's options (the reviewer node); its file is `.claude/agents/<agentType>.md`. */
  agentType?: string
  /** The prompt invokes this skill (`Skill({ skill: "x" })` or `/x`); its file is `.claude/skills/<skill>/SKILL.md`. */
  skill?: string
  /** The prompt's literal text when the script spells it out (a string or a `const` the call names). */
  prompt?: string
}

export interface GraphEdge {
  source: string
  target: string
  /** A loop, not a step: `back` runs from a checker to its fix node, `retry` from the fix node into the gate again. Layout ranks neither. */
  loop?: 'back' | 'retry'
  /** The loop's bound (`≤2`), read from the script when it can be. */
  label?: string
}

export interface Graph {
  name?: string
  /** `meta.description` of a script: `spec → /implement → … → ready-for-pr | needs-human`. */
  description?: string
  /** `meta.whenToUse` of a script. */
  whenToUse?: string
  /** Phase titles in order; the lanes. */
  phases: string[]
  /** `meta.phases[i].detail` by title (a run's own `phases[].detail` wins in overlayRun). Only titles that have one. */
  phaseDetails?: Record<string, string>
  /** The terminal statuses the script can return, `needs-human` last. */
  outcomes?: string[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface NodeRunInfo {
  state: NodeState
  model?: string
  attempt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
  agent?: WorkflowAgentEntry
  /** every manifest entry that matched this node (retries stack here) */
  agents: WorkflowAgentEntry[]
}

export interface RunGraph extends Graph {
  info: Record<string, NodeRunInfo>
  /** Phase titles the run brought that the script does not name (its `phases[]` or an agent's `phaseTitle`); the canvas subtitles these `not in the script`. */
  addedPhases?: string[]
}
