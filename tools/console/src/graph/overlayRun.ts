import type { Graph, GraphEdge, GraphNode, NodeRunInfo, NodeState, RunGraph, RunManifest, WorkflowAgentEntry } from '../types'
import { kindOf, nodeId } from './parseScript'

export function agentsOf(m: RunManifest | undefined): WorkflowAgentEntry[] {
  return (m?.workflowProgress ?? []).filter((e): e is WorkflowAgentEntry => e.type === 'workflow_agent')
}

/** Where an agent's clock ends: startedAt + durationMs, else lastProgressAt. */
export function agentEnd(a: WorkflowAgentEntry): number | undefined {
  if (a.startedAt != null && a.durationMs != null) return a.startedAt + a.durationMs
  return a.lastProgressAt
}

export function runBounds(m: RunManifest): { start: number; end: number } {
  const agents = agentsOf(m)
  const qs = agents.map((a) => a.queuedAt ?? a.startedAt).filter((x): x is number => x != null)
  const es = agents.map(agentEnd).filter((x): x is number => x != null)
  const start = m.startTime ?? (qs.length ? Math.min(...qs) : 0)
  const end = m.startTime != null && m.durationMs != null ? m.startTime + m.durationMs : es.length ? Math.max(...es) : start
  return { start, end: Math.max(end, ...es) }
}

/** The state of one agent at wall-clock `t` (undefined = the manifest's final word). */
export function stateAt(a: WorkflowAgentEntry, t?: number): NodeState {
  const final = finalState(a)
  if (t == null) return final
  const q = a.queuedAt ?? a.startedAt
  if (q != null && t < q) return 'idle'
  if (a.startedAt != null && t < a.startedAt) return 'queued'
  const end = agentEnd(a)
  if (end != null && t < end) return 'running'
  if (end == null && (final === 'running' || final === 'queued')) return final
  return final
}

function finalState(a: WorkflowAgentEntry): NodeState {
  switch (a.state) {
    case 'done': return 'done'
    case 'error': return 'error'
    case 'running': return 'running'
    case 'progress': return 'running' // what the engine actually writes for a live agent (observed 2026-08-29, wf_2a52cfdf-b8a)
    case 'queued': return 'queued'
    default: return a.error ? 'error' : a.state ? 'done' : 'idle'
  }
}

/** Shared label segments (`verify:testing:x` ~ `review:testing`) hint at a parent. */
function segments(label: string): string[] {
  return label.split(/[:/]/).slice(1).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2)
}

/**
 * A run whose trail went cold: the plugin says `stale` (nothing on disk moved
 * for 15 min), or `running` with `live: false`. Its unfinished agents are not
 * running — nobody will ever settle them.
 */
export function isStalled(m: RunManifest | undefined): boolean {
  return !!m && (m.status === 'stale' || (m.status === 'running' && m.live === false))
}

/**
 * Overlay a run onto a static graph. Agents match nodes by label; a template
 * node (`review:*`) is replaced by every agent whose label starts with its
 * prefix, inheriting its edges; agents nobody names are added under their
 * phase, wired by shared label segments or, failing that, fanned in from the
 * previous non-empty phase. `t` scrubs the replay clock. The script's meta
 * (description, whenToUse, phase details, outcomes) rides along; a run's own
 * `phases[].detail` wins over the script's.
 */
export function overlayRun(graph: Graph, manifest: RunManifest | undefined, t?: number): RunGraph {
  const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }))
  let edges: GraphEdge[] = graph.edges.map((e) => ({ ...e }))
  const phases = [...graph.phases]
  const phaseDetails: Record<string, string> = { ...graph.phaseDetails }
  const info: Record<string, NodeRunInfo> = {}
  const byId = () => new Map(nodes.map((n) => [n.id, n]))
  const stalled = isStalled(manifest)

  const agents = manifest ? agentsOf(manifest) : []
  for (const p of manifest?.phases ?? []) {
    if (!p.title) continue
    if (!phases.includes(p.title)) phases.push(p.title)
    if (p.detail) phaseDetails[p.title] = p.detail
  }
  for (const a of agents) if (a.phaseTitle && !phases.includes(a.phaseTitle)) phases.push(a.phaseTitle)

  const matched = new Map<string, WorkflowAgentEntry[]>()
  const unmatched: WorkflowAgentEntry[] = []
  const templates = nodes.filter((n) => n.template)
  const expansion = new Map<string, string[]>() // template id → concrete node ids
  for (const a of agents) {
    const label = a.label ?? ''
    const id = nodeId(label)
    const exact = byId().get(id)
    const tpl = templates.find((n) => label.startsWith(n.label.slice(0, -1)))
    if (exact && !exact.template) push(matched, id, a)
    else if (tpl) {
      if (!byId().has(id)) {
        // `gate:1` is the template's call with `round` filled in: same prompt, same agentType, same files to edit.
        nodes.push({ id, label, phase: a.phaseTitle ?? tpl.phase, kind: kindOf(label), agentType: tpl.agentType, skill: tpl.skill, prompt: tpl.prompt })
        push(expansion, tpl.id, id)
      }
      push(matched, id, a)
    } else unmatched.push(a)
  }
  // Expanded templates leave the stage; their edges are re-drawn between the
  // concrete nodes. Template→template edges use shared label segments
  // (`verify:testing:x` ← `review:testing`) and fall back to a full fan-in.
  const templateEdges = edges.filter((e) => expansion.has(e.source) || expansion.has(e.target))
  edges = edges.filter((e) => !expansion.has(e.source) && !expansion.has(e.target))
  for (const e of templateEdges) {
    const sources = expansion.get(e.source) ?? [e.source]
    const targets = expansion.get(e.target) ?? [e.target]
    const both = expansion.has(e.source) && expansion.has(e.target)
    for (const t of targets) {
      const tsegs = segments(byId().get(t)?.label ?? '')
      let parents = both ? sources.filter((s) => segments(byId().get(s)?.label ?? '').some((x) => tsegs.includes(x))) : sources
      if (!parents.length) parents = sources
      for (const s of parents) edges.push({ ...e, source: s, target: t }) // a loop stays a loop once `gate:*` is `gate:1`
    }
  }
  for (const tplId of expansion.keys()) {
    const i = nodes.findIndex((n) => n.id === tplId)
    if (i >= 0) nodes.splice(i, 1)
  }

  for (const a of unmatched) {
    const label = a.label ?? `agent ${a.index ?? '?'}`
    const id = nodeId(label)
    if (!byId().has(id)) {
      const phase = a.phaseTitle ?? phases[(a.phaseIndex ?? 1) - 1] ?? phases[0] ?? ''
      nodes.push({ id, label, phase, kind: kindOf(label) })
      const pi = phases.indexOf(phase)
      const earlier = nodes.filter((n) => n.id !== id && phases.indexOf(n.phase) < pi)
      const segs = segments(label)
      let parents = earlier.filter((n) => segments(n.label).some((s) => segs.includes(s)))
      if (!parents.length && earlier.length) {
        const lastPhase = Math.max(...earlier.map((n) => phases.indexOf(n.phase)))
        parents = earlier.filter((n) => phases.indexOf(n.phase) === lastPhase)
      }
      for (const p of parents) edges.push({ source: p.id, target: id })
    }
    push(matched, id, a)
  }

  for (const n of nodes) {
    const list = (matched.get(n.id) ?? []).slice().sort((x, y) => (x.startedAt ?? x.queuedAt ?? 0) - (y.startedAt ?? y.queuedAt ?? 0))
    const visible = t == null ? list : list.filter((a) => (a.queuedAt ?? a.startedAt ?? 0) <= t)
    const cur = visible[visible.length - 1]
    if (cur) {
      let state = stateAt(cur, t)
      // Past the last thing the agent wrote (or with no clock at all), an
      // unfinished agent of a stale run is stalled, not running. Scrubbing
      // back into its active window still shows it running — that happened.
      if (stalled && (state === 'running' || state === 'queued')) {
        const end = agentEnd(cur)
        if (t == null || end == null || t >= end) state = 'stalled'
      }
      info[n.id] = {
        state,
        model: cur.model,
        attempt: Math.max(...visible.map((a) => a.attempt ?? 1)),
        tokens: cur.tokens,
        toolCalls: cur.toolCalls,
        durationMs: t == null ? cur.durationMs : elapsedAt(cur, t),
        agent: cur,
        agents: list,
      }
    } else info[n.id] = { state: 'idle', agents: list }
  }
  // A human stop waits once everything feeding it is done.
  if (manifest) for (const n of nodes) if (n.kind === 'human' && info[n.id].state === 'idle') {
    const parents = edges.filter((e) => e.target === n.id).map((e) => info[e.source]?.state)
    if (parents.length && parents.every((s) => s === 'done')) info[n.id].state = 'waiting'
  }
  // Dedupe edges; drop dangling ones.
  const ids = new Set(nodes.map((n) => n.id))
  const seen = new Set<string>()
  edges = edges.filter((e) => {
    const k = `${e.source}→${e.target}`
    if (seen.has(k) || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target) return false
    seen.add(k)
    return true
  })
  const out: RunGraph = { name: graph.name ?? manifest?.workflowName, phases, nodes, edges, info }
  if (graph.description) out.description = graph.description
  if (graph.whenToUse) out.whenToUse = graph.whenToUse
  if (Object.keys(phaseDetails).length) out.phaseDetails = phaseDetails
  if (graph.outcomes) out.outcomes = graph.outcomes
  return out
}

function elapsedAt(a: WorkflowAgentEntry, t: number): number | undefined {
  if (a.startedAt == null) return undefined
  const end = agentEnd(a)
  return Math.max(0, Math.min(t, end ?? t) - a.startedAt)
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k)
  if (l) l.push(v)
  else m.set(k, [v])
}
