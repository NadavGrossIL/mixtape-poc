import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { NodeKind, NodeState } from '../types'
import { NODE_W, NODE_H, GATE_H, handlePoints, type HandleId } from '../graph/layout'
import { fmtDuration, fmtTokens, shortModel } from './format'

export type AgentNodeData = {
  label: string
  /** one line under the label saying what the step is for (graph/purpose.ts) */
  purpose: string
  phase: string
  kind: NodeKind
  state: NodeState
  model?: string
  attempt?: number
  tokens?: number
  durationMs?: number
  error?: string
  /** a named subagent (`agentType: 'reviewer'`) — its own file, its own chip */
  agentType?: string
}
export type AgentRFNode = Node<AgentNodeData, 'agent'>

const W = NODE_W
const heightOf = (kind: NodeKind) => (kind === 'gate' ? GATE_H : NODE_H)
function points(kind: NodeKind): string {
  const H = heightOf(kind)
  if (kind === 'gate') return `${W / 2},2 ${W - 2},${H / 2} ${W / 2},${H - 2} 2,${H / 2}`
  return `26,2 ${W - 26},2 ${W - 2},26 ${W - 2},${H - 26} ${W - 26},${H - 2} 26,${H - 2} 2,${H - 26} 2,26`
}

function Shape({ kind, className }: { kind: NodeKind; className: string }) {
  if (kind === 'agent') return <rect className={className} x={2} y={2} width={W - 4} height={NODE_H - 4} rx={14} />
  return <polygon className={className} points={points(kind)} />
}

/** Every handle has an id, so an edge always names the side it uses — nothing leaves from "the first handle". */
const HANDLES: { id: HandleId; type: 'source' | 'target'; position: Position }[] = [
  { id: 'in', type: 'target', position: Position.Left },
  { id: 'out', type: 'source', position: Position.Right },
  { id: 'loop-out', type: 'source', position: Position.Bottom },
  { id: 'loop-in', type: 'target', position: Position.Bottom },
  { id: 'retry-in', type: 'target', position: Position.Bottom },
]
/** The same geometry as a React Flow `handles` array, so the flow never has to measure the DOM to place an edge. */
export function nodeHandles(kind: NodeKind) {
  const pts = handlePoints(kind)
  return HANDLES.map((h) => ({ id: h.id, type: h.type, position: h.position, x: pts[h.id].x - 3, y: pts[h.id].y - 3, width: 6, height: 6 }))
}

/**
 * At most three chips, so a `check`-style node (agent type + model + tokens +
 * duration) never spills out of its box: who runs it, which attempt (or which
 * model), and `tokens · duration` as one. The gate keeps two.
 */
export function chipsOf(data: AgentNodeData): string[] {
  const stat = [data.tokens != null && fmtTokens(data.tokens), data.durationMs != null && fmtDuration(data.durationMs)].filter(Boolean).join(' · ')
  const who = data.attempt != null && data.attempt > 1 ? `attempt ${data.attempt}` : data.model ? shortModel(data.model) : ''
  const at = data.agentType ? `@${data.agentType}` : ''
  const list = data.kind === 'gate' ? [at || who, stat] : [at, who, stat]
  return list.filter(Boolean)
}

function AgentNodeView({ data, selected }: NodeProps<AgentRFNode>) {
  const { state, kind } = data
  const pts = handlePoints(kind)
  const chips = chipsOf(data)
  return (
    <div className="node" data-state={state} data-kind={kind} data-selected={selected || undefined} title={data.error ?? undefined} style={{ height: heightOf(kind) }}>
      <svg className="node-shape" viewBox={`0 0 ${W} ${heightOf(kind)}`} width={W} height={heightOf(kind)} aria-hidden>
        {state === 'running' && <Shape kind={kind} className="ring" />}
        {state === 'waiting' && <Shape kind={kind} className="breath" />}
        <Shape kind={kind} className="fill" />
      </svg>
      {HANDLES.map((h) => <Handle key={h.id} id={h.id} type={h.type} position={h.position} className="port" style={{ left: pts[h.id].x, top: pts[h.id].y }} />)}
      <div className="node-body">
        <div className="node-title">
          <span className="node-label" title={data.label}>{data.label}</span>
          {state !== 'idle' && <span className="node-state">{state}</span>}
        </div>
        <div className="node-purpose" title={data.purpose}>{data.purpose}</div>
        {chips.length > 0 && <div className="chips">{chips.map((c) => <span key={c} className="chip" data-agent={c.startsWith('@') || undefined}>{c}</span>)}</div>}
      </div>
    </div>
  )
}

export const AgentNode = memo(AgentNodeView)

export type LaneRFNode = Node<{ title: string; detail?: string }, 'lane'>
function LaneNodeView({ data }: NodeProps<LaneRFNode>) {
  return (
    <div className="lane">
      <span className="lane-title">{data.title || 'untitled phase'}</span>
      {data.detail && <span className="lane-detail" title={data.detail}>{data.detail}</span>}
    </div>
  )
}
export const LaneNode = memo(LaneNodeView)

/** The visible end: every word the script can return, the one this run returned lit, and its reason. `dim`: a killed run — every chip outlined dim (IA-SPEC §4.4). */
export type OutcomeNodeData = { outcomes: string[]; achieved?: string; text: string; inY: number; dim?: boolean }
export type OutcomeRFNode = Node<OutcomeNodeData, 'outcome'>
function OutcomeNodeView({ data }: NodeProps<OutcomeRFNode>) {
  return (
    <div className="lane outcome">
      <Handle id="in" type="target" position={Position.Left} className="port" style={{ left: 0, top: data.inY }} />
      <span className="lane-title">Outcome</span>
      <div className="outcome-chips">
        {data.outcomes.map((o) => <span key={o} className="outcome-chip" data-on={o === data.achieved || undefined} data-dim={data.dim || undefined} data-tone={o === 'needs-human' ? 'err' : 'ok'}>{o}</span>)}
      </div>
      {data.text && <p className="outcome-text" title={data.text}>{data.text}</p>}
    </div>
  )
}
export const OutcomeNode = memo(OutcomeNodeView)
