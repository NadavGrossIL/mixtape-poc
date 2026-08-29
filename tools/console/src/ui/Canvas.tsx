import { useMemo } from 'react'
import { ReactFlow, Background, BackgroundVariant, Controls, type Edge, type Node } from '@xyflow/react'
import type { RunGraph } from '../types'
import { layout } from '../graph'
import { AgentNode, LaneNode, type AgentRFNode, type LaneRFNode } from './AgentNode'

const nodeTypes = { agent: AgentNode, lane: LaneNode }

export function Canvas({ graph, selectedId, onSelect }: { graph: RunGraph; selectedId?: string; onSelect: (id?: string) => void }) {
  const { nodes, edges } = useMemo(() => build(graph, selectedId), [graph, selectedId])
  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
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
    return { id: `${e.source}→${e.target}`, source: e.source, target: e.target, animated: s === 'running', className: `edge edge-${s}` }
  })
  return { nodes: [...lanes, ...nodes], edges }
}
