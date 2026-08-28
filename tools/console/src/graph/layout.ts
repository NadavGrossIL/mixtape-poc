import dagre from '@dagrejs/dagre'
import type { Graph, NodeKind } from '../types'

// Phases are swimlanes left → right. Each lane is laid out by dagre on its
// own (rankdir LR, intra-lane edges only), then lanes are placed side by
// side with a shared height so the bands line up. Cross-lane edges are
// drawn by React Flow between absolute positions and need no layout help.

export const NODE_W = 216
export const NODE_H = 88
export const GATE_H = 124
export const nodeSize = (kind: NodeKind) => ({ w: NODE_W, h: kind === 'gate' ? GATE_H : NODE_H })
export const LANE_PAD = 28
export const LANE_HEAD = 44
export const LANE_GAP = 36
const MAX_ROWS = 8

/** x/y are relative to the lane (React Flow parent); ax/ay are absolute (thumbnails). */
export interface LaidOutNode { id: string; x: number; y: number; ax: number; ay: number; w: number; h: number; lane: string }
export interface Lane { id: string; title: string; x: number; y: number; w: number; h: number }
export interface Layout { lanes: Lane[]; nodes: LaidOutNode[]; width: number; height: number }

export function layout(graph: Graph): Layout {
  const phases = graph.phases.length ? graph.phases : ['']
  const laneOf = (p: string) => (phases.includes(p) ? p : phases[0])
  const lanes: Lane[] = []
  const out: LaidOutNode[] = []
  let x = 0
  const perLane = phases.map((phase) => {
    const ns = graph.nodes.filter((n) => laneOf(n.phase) === phase)
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 56, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of ns) { const { w, h } = nodeSize(n.kind); g.setNode(n.id, { width: w, height: h }) }
    const ids = new Set(ns.map((n) => n.id))
    for (const e of graph.edges) if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target)
    let pos: { id: string; cx: number; cy: number; h: number }[]
    if (g.edgeCount() === 0 && ns.length > MAX_ROWS) {
      // A fan-out with nothing between its nodes: pack it into columns so a
      // 15-agent phase is a block, not a 1700px tower.
      const cols = Math.ceil(ns.length / MAX_ROWS)
      const rows = Math.ceil(ns.length / cols)
      pos = ns.map((n, i) => ({ id: n.id, h: NODE_H, cx: Math.floor(i / rows) * (NODE_W + 22) + NODE_W / 2, cy: (i % rows) * (NODE_H + 22) + NODE_H / 2 }))
    } else {
      if (ns.length) dagre.layout(g)
      pos = ns.map((n) => {
        const p = g.node(n.id) as { x: number; y: number } | undefined
        const { h } = nodeSize(n.kind)
        return { id: n.id, h, cx: p?.x ?? NODE_W / 2, cy: p?.y ?? h / 2 }
      })
    }
    const w = pos.length ? Math.max(...pos.map((p) => p.cx + NODE_W / 2)) : NODE_W
    const h = pos.length ? Math.max(...pos.map((p) => p.cy + p.h / 2)) : NODE_H
    return { phase, pos, w, h }
  })
  const bodyH = Math.max(...perLane.map((l) => l.h), NODE_H)
  const laneH = bodyH + LANE_PAD * 2 + LANE_HEAD
  perLane.forEach((l, i) => {
    const laneW = l.w + LANE_PAD * 2
    const id = `lane:${i}`
    lanes.push({ id, title: l.phase, x, y: 0, w: laneW, h: laneH })
    const dy = (bodyH - l.h) / 2
    for (const p of l.pos) {
      const nx = LANE_PAD + p.cx - NODE_W / 2
      const ny = LANE_HEAD + LANE_PAD + dy + p.cy - p.h / 2
      out.push({ id: p.id, lane: id, w: NODE_W, h: p.h, x: nx, y: ny, ax: x + nx, ay: ny })
    }
    x += laneW + LANE_GAP
  })
  return { lanes, nodes: out, width: Math.max(0, x - LANE_GAP), height: laneH }
}
