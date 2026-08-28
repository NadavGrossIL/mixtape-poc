import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { NodeKind, NodeState } from '../types'
import { NODE_W, NODE_H, GATE_H } from '../graph'
import { fmtDuration, fmtTokens, shortModel } from './format'

export type AgentNodeData = {
  label: string
  phase: string
  kind: NodeKind
  state: NodeState
  model?: string
  attempt?: number
  tokens?: number
  durationMs?: number
  error?: string
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

function AgentNodeView({ data, selected }: NodeProps<AgentRFNode>) {
  const { state, kind } = data
  const chips = [
    data.model && shortModel(data.model),
    data.attempt != null && data.attempt > 1 && `attempt ${data.attempt}`,
    data.tokens != null && fmtTokens(data.tokens),
    data.durationMs != null && fmtDuration(data.durationMs),
  ].filter(Boolean) as string[]
  return (
    <div className="node" data-state={state} data-kind={kind} data-selected={selected || undefined} title={data.error ?? undefined} style={{ height: heightOf(kind) }}>
      <svg className="node-shape" viewBox={`0 0 ${W} ${heightOf(kind)}`} width={W} height={heightOf(kind)} aria-hidden>
        {state === 'running' && <Shape kind={kind} className="ring" />}
        {state === 'waiting' && <Shape kind={kind} className="breath" />}
        <Shape kind={kind} className="fill" />
      </svg>
      <Handle type="target" position={Position.Left} className="port" />
      <div className="node-body">
        <div className="node-title">
          <span className="node-label">{data.label}</span>
          {state !== 'idle' && <span className="node-state">{state}</span>}
        </div>
        {chips.length > 0 && <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="port" />
    </div>
  )
}

export const AgentNode = memo(AgentNodeView)

export type LaneRFNode = Node<{ title: string }, 'lane'>
function LaneNodeView({ data }: NodeProps<LaneRFNode>) {
  return <div className="lane"><span className="lane-title">{data.title || 'untitled phase'}</span></div>
}
export const LaneNode = memo(LaneNodeView)
