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
  logs?: string[]
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
}

/** What `GET /api/events` streams (one JSON object per SSE `data:` line). */
export type ConsoleEvent = { kind: 'runs' } | { kind: 'journal'; runId: string } | { kind: 'workflows' } | { kind: 'ledger' }

/** One row of docs/factory/RUNS.md, keyed by run id (`GET /api/ledger`). `cost` is USD. */
export interface LedgerEntry { cost?: number; date?: string; spec?: string; outcome?: string; notes?: string }
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
