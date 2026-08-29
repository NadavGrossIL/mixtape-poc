import { useMemo } from 'react'
import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, MarkerType, type Edge, type EdgeProps, type Node } from '@xyflow/react'
import type { RunGraph } from '../types'
import { layout } from '../graph'
import { AgentNode, LaneNode, type AgentRFNode, type LaneRFNode } from './AgentNode'

const nodeTypes = { agent: AgentNode, lane: LaneNode }
const edgeTypes = { loop: LoopEdge }
const LOOP_DROP = 26 // how far under the lower of the two nodes a loop-back runs

export function Canvas({ graph, selectedId, onSelect }: { graph: RunGraph; selectedId?: string; onSelect: (id?: string) => void }) {
  const { nodes, edges } = useMemo(() => build(graph, selectedId), [graph, selectedId])
  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, n) => { if (n.type === 'agent') onSelect(n.id) }}
        onPaneClick={() => onSelect(undefined)}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

function build(graph: RunGraph, selectedId?: string): { nodes: Node[]; edges: Edge[] } {
  const l = layout(graph)
  const lanes: LaneRFNode[] = l.lanes.map((ln) => ({
    id: ln.id, type: 'lane', position: { x: ln.x, y: ln.y }, data: { title: ln.title },
    style: { width: ln.w, height: ln.h }, draggable: false, selectable: false, zIndex: 0,
  }))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nodes: AgentRFNode[] = l.nodes.map((p) => {
    const n = byId.get(p.id)!
    const i = graph.info[n.id]
    return {
      id: n.id, type: 'agent', parentId: p.lane, position: { x: p.x, y: p.y }, selected: n.id === selectedId, zIndex: 1, style: { width: p.w, height: p.h },
      data: { label: n.label, phase: n.phase, kind: n.kind, state: i?.state ?? 'idle', model: i?.model, attempt: i?.attempt, tokens: i?.tokens, durationMs: i?.durationMs, error: i?.agent?.error, agentType: n.agentType },
    }
  })
  const edges: Edge[] = graph.edges.map((e) => {
    const s = graph.info[e.target]?.state ?? 'idle'
    const base: Edge = { id: `${e.source}→${e.target}`, source: e.source, target: e.target, animated: s === 'running', className: `edge edge-${s}${e.loop ? ' edge-loop' : ''}` }
    if (e.loop !== 'back') return base
    // checker → fix node: out of the bottom, under both, up into the fix node's bottom; the retry edge back into the gate is an ordinary (dashed) step edge
    return { ...base, type: 'loop', sourceHandle: 'loop', targetHandle: 'loop', label: e.label, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--muted)' } }
  })
  return { nodes: [...lanes, ...nodes], edges }
}

/** A loop-back drawn as a squared U beneath its two nodes, with the bound as a pill at the bottom of the U. */
function LoopEdge({ sourceX, sourceY, targetX, targetY, label, markerEnd }: EdgeProps) {
  const y = Math.max(sourceY, targetY) + LOOP_DROP
  const r = 12
  const d = sourceX > targetX ? 1 : -1 // 1: the loop runs leftwards (the usual case: gate is right of its fix node)
  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${y - r} Q ${sourceX} ${y} ${sourceX - d * r} ${y} L ${targetX + d * r} ${y} Q ${targetX} ${y} ${targetX} ${y - r} L ${targetX} ${targetY}`
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} />
      {label != null && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${y}px)` }}>{label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
