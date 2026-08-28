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
}

export interface WorkflowFile {
  name: string
  engine: 'native' | 'archon'
  kind: 'script' | 'skill' | 'yaml'
  path: string
  source: string
  fixture?: boolean
}

export interface AgentDetail {
  prompt: string
  result: string
  events: { ts: string; kind: string; name?: string; summary: string }[]
}

// --- graph -----------------------------------------------------------------

export type NodeState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'waiting'
export type NodeKind = 'agent' | 'gate' | 'human'

export interface GraphNode {
  id: string
  label: string
  phase: string
  kind: NodeKind
  /** A node whose label ended in an expression, e.g. `review:*`; a run expands it. */
  template?: boolean
}

export interface GraphEdge {
  source: string
  target: string
}

export interface Graph {
  name?: string
  phases: string[]
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
}
