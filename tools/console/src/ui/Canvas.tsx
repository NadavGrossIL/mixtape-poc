import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, MarkerType, Position, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type Node } from '@xyflow/react'
import type { NodeState, RunGraph, RunManifest, WorkflowFile } from '../types'
import { layout, purposeOf, isStalled } from '../graph'
import { roundedPath, type Pt } from '../graph/layout'
import { AgentNode, LaneNode, OutcomeNode, nodeHandles, type AgentRFNode, type LaneRFNode, type OutcomeRFNode } from './AgentNode'
import { isLive, nowAt, outcomeOf } from './format'

const nodeTypes = { agent: AgentNode, lane: LaneNode, outcome: OutcomeNode }
const edgeTypes = { route: RouteEdge }
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.15 }

/**
 * The run as a picture: lanes per phase, one node per step, routed edges
 * (graph/layout.ts decides every coordinate), the outcome column, a legend.
 * Node objects keep their identity across replay ticks — only `data` moves —
 * and every node carries explicit dimensions and handle geometry, so React
 * Flow never has to re-measure and never hides a node while scrubbing.
 */
export function Canvas({ graph, files, run, selectedId, onSelect }: { graph: RunGraph; files: WorkflowFile[]; run?: RunManifest; selectedId?: string; onSelect: (id?: string) => void }) {
  const cache = useRef(new Map<string, { sig: string; node: Node }>())
  const container = useRef<HTMLDivElement>(null)
  const { nodes, edges, extent, nodesKey } = useMemo(() => build(graph, files, run, selectedId, cache.current), [graph, files, run, selectedId])
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const el = (ev.target as HTMLElement).closest?.('.react-flow__node-agent')
    const id = el?.getAttribute('data-id')
    if (id) { ev.preventDefault(); onSelect(id) }
  }
  return (
    <div className="canvas" ref={container} onKeyDown={onKeyDown}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={FIT.minZoom}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        onNodeClick={(_, n) => { if (n.type === 'agent') onSelect(n.id) }}
        onPaneClick={() => onSelect(undefined)}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} position="top-right" />
        <Fitter extent={extent} nodesKey={nodesKey} container={container} />
      </ReactFlow>
      <Legend />
    </div>
  )
}

/**
 * Fits the whole drawing (lanes, the loop band under them, the outcome
 * column) when the canvas resizes or the set of nodes changes — never on a
 * replay tick. Watches the container itself (ResizeObserver + window
 * resize) rather than the flow's store, so the fit does not depend on React
 * Flow's own measuring cycle; the drawing's extent comes from layout(), not
 * from node bounds, so the loop band under the lanes is never cut off.
 */
function Fitter({ extent, nodesKey, container }: { extent: { w: number; h: number }; nodesKey: string; container: RefObject<HTMLDivElement> }) {
  const { setViewport } = useReactFlow()
  const ready = useNodesInitialized()
  const [size, setSize] = useState({ w: 0, h: 0 })
  const last = useRef('')
  useEffect(() => {
    const el = container.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    window.addEventListener('resize', read)
    return () => { ro.disconnect(); window.removeEventListener('resize', read) }
  }, [container])
  useEffect(() => {
    const { w: width, h: height } = size
    if (!width || !height || !ready) return
    const key = `${width}x${height}:${extent.w}x${extent.h}:${nodesKey}`
    if (key === last.current) return // a replay tick or a re-render: the reader's pan and zoom stay
    const id = setTimeout(() => {
      last.current = key
      const zoom = Math.max(FIT.minZoom, Math.min(FIT.maxZoom, (width * (1 - 2 * FIT.padding)) / Math.max(extent.w, 1), (height * (1 - 2 * FIT.padding)) / Math.max(extent.h, 1)))
      void setViewport({ x: (width - extent.w * zoom) / 2, y: (height - extent.h * zoom) / 2, zoom })
    }, 80)
    return () => clearTimeout(id)
  }, [size, extent.w, extent.h, nodesKey, setViewport, ready])
  return null
}

function build(graph: RunGraph, files: WorkflowFile[], run: RunManifest | undefined, selectedId: string | undefined, cache: Map<string, { sig: string; node: Node }>) {
  const l = layout(graph)
  const keep = <N extends Node>(node: N): N => {
    const sig = JSON.stringify([node.position, node.width, node.height, node.selected, node.parentId, node.data])
    const hit = cache.get(node.id)
    if (hit && hit.sig === sig) return hit.node as N
    cache.set(node.id, { sig, node })
    return node
  }
  const declared = run?.phases?.filter((p) => p.title).map((p) => p.title) ?? []
  const lanes: LaneRFNode[] = l.lanes.map((ln) => {
    const detail = graph.phaseDetails?.[ln.title] ?? (declared.length && !declared.includes(ln.title) ? 'not in the script' : undefined)
    return keep<LaneRFNode>({
      id: ln.id, type: 'lane', position: { x: ln.x, y: ln.y }, data: detail ? { title: ln.title, detail } : { title: ln.title },
      width: ln.w, height: ln.h, measured: { width: ln.w, height: ln.h }, draggable: false, selectable: false, focusable: false, zIndex: 0,
    })
  })
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const agents: AgentRFNode[] = l.nodes.map((p) => {
    const n = byId.get(p.id)!
    const i = graph.info[n.id]
    return keep<AgentRFNode>({
      id: n.id, type: 'agent', parentId: p.lane, position: { x: p.x, y: p.y }, selected: n.id === selectedId, zIndex: 1,
      width: p.w, height: p.h, measured: { width: p.w, height: p.h }, handles: nodeHandles(n.kind),
      data: { label: n.label, purpose: purposeOf(n, files), phase: n.phase, kind: n.kind, state: i?.state ?? 'idle', model: i?.model, attempt: i?.attempt, tokens: i?.tokens, durationMs: i?.durationMs, error: i?.agent?.error, agentType: n.agentType },
    })
  })
  const nodes: Node[] = [...lanes, ...agents]
  const oc = outcomeOf(run)
  const achieved = run && oc.source === 'result' ? oc.word : undefined
  if (l.outcome) {
    const o = l.outcome
    nodes.push(keep<OutcomeRFNode>({
      id: 'outcome', type: 'outcome', position: { x: o.x, y: o.y }, width: o.w, height: o.h, measured: { width: o.w, height: o.h }, zIndex: 0,
      draggable: false, selectable: false, focusable: false,
      handles: [{ id: 'in', type: 'target', position: Position.Left, x: -3, y: o.inY - 3, width: 6, height: 6 }],
      data: { outcomes: graph.outcomes ?? [], achieved, text: outcomeText(run, achieved), inY: o.inY },
    }))
  }
  const stateOf = (e: { source: string; target: string; loop?: string }): NodeState => {
    if (e.target === 'outcome') return achieved ? (achieved === 'needs-human' ? 'error' : 'done') : 'idle'
    const t = graph.info[e.target]?.state ?? 'idle'
    // a retry only happened if the fix round before it finished
    if (e.loop === 'retry') return graph.info[e.source]?.state === 'done' ? t : 'idle'
    return t
  }
  const edges: Edge[] = l.edges.map((e) => {
    const s = stateOf(e)
    const sel = selectedId != null && (e.source === selectedId || e.target === selectedId)
    const color = s === 'running' ? 'var(--accent)' : s === 'done' ? 'var(--edge-done)' : s === 'error' ? 'var(--err)' : 'var(--muted)'
    return {
      id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, type: 'route',
      animated: s === 'running', selectable: false,
      className: `edge edge-${s}${e.loop ? ' edge-loop' : ''}${sel ? ' edge-sel' : ''}`,
      data: { points: e.points, label: e.label },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
    }
  })
  const nodesKey = nodes.map((n) => n.id).join('|')
  return { nodes, edges, extent: { w: l.width, h: l.height }, nodesKey }
}

/** The text under the outcome chips (IA-SPEC §4.4). */
function outcomeText(run: RunManifest | undefined, achieved: string | undefined): string {
  if (!run) return 'outcomes this workflow can return'
  if (achieved) {
    const r = run.result as { reason?: unknown } | null | undefined
    return r && typeof r === 'object' && typeof r.reason === 'string' ? r.reason : ''
  }
  if (run.status === 'killed') return 'killed — stopped by --max-budget-usd / --max-turns'
  if (isStalled(run)) return 'pending — nothing moved for 15 min'
  if (isLive(run)) return `pending — ${nowAt(run) ?? 'between steps'}`
  return 'the workflow returned no result'
}

type RouteRFEdge = Edge<{ points: Pt[]; label?: { text: string; x: number; y: number } }, 'route'>

/** An orthogonal polyline from graph/layout.ts, corners rounded; a loop's bound rides its horizontal run above lanes and nodes. */
function RouteEdge({ data, markerEnd }: EdgeProps<RouteRFEdge>) {
  const path = roundedPath(data?.points ?? [])
  const label = data?.label
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}>{label.text}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** What the strokes and shapes mean (IA-SPEC §4.5). Static, bottom-left, over the canvas. */
function Legend() {
  return (
    <div className="legend" role="note" aria-label="legend">
      <span><svg width="26" height="10" aria-hidden><path d="M1 5H21" className="lg-step" /><path d="M19 1.5L24 5L19 8.5" className="lg-step" /></svg>next step</span>
      <span><svg width="26" height="10" aria-hidden><path d="M1 5H21" className="lg-loop" /><path d="M19 1.5L24 5L19 8.5" className="lg-step" /></svg>retry loop (≤n = its bound)</span>
      {(['idle', 'queued', 'running', 'done', 'error', 'stalled', 'waiting'] as const).map((s) => (
        <span key={s}><i className="lg-node" data-state={s} aria-hidden />{s === 'waiting' ? 'waiting for a human' : s}</span>
      ))}
    </div>
  )
}
