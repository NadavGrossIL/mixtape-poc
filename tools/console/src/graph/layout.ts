import dagre from '@dagrejs/dagre'
import type { Graph, NodeKind } from '../types'

// Phases are swimlanes left → right. Each lane is laid out by dagre on its
// own (rankdir LR, intra-lane edges only), then lanes are placed side by
// side with a shared height so the bands line up. Loop edges are never
// ranked; the fix nodes they land on form a row under the lane's steps (a
// shelf), chained by layout-only edges so a lane with `implement` above
// `fix:gate-*` and `fix:review` reads as one step and its retries, not as
// three steps.
//
// Edges are routed here too, in flow coordinates, so the picture is a pure
// function of the graph (the probe can print every path) and React Flow
// only draws: every step is an orthogonal polyline right → left with its
// vertical jog in a corridor free of nodes, spread so two jogs never share
// an x; loops leave a checker's bottom, run BELOW the lanes (each on its
// own y, the bound pill on the horizontal), and rise into the fix node from
// below; the retry back into the gate does the same on its own y. A
// last column, `OUTCOME`, is the visible end of the story.

export const NODE_W = 216
export const NODE_H = 112
export const GATE_H = 144
export const nodeSize = (kind: NodeKind) => ({ w: NODE_W, h: kind === 'gate' ? GATE_H : NODE_H })
export const LANE_PAD = 28
/** Lane header: title plus up to three lines of phase detail (`laneHead` grows it when a subtitle needs the third line). */
export const LANE_HEAD = 70
const HEAD_BASE = 38
const DETAIL_LINE = 16
const DETAIL_CHAR = 6.3 // 12 px sans, average glyph
export const LANE_GAP = 36
export const OUTCOME_W = 240
/** The first loop's horizontal runs this far under the lanes; each further loop 18 px lower. */
export const LOOP_DROP = 30
export const LOOP_STEP = 18
/** `loop-out` sits this far left of a node's bottom centre, `loop-in` this far right, so a fix node's "in" and "out" never share a line. */
export const HANDLE_OFF = 22
const MAX_ROWS = 8
const COL_GAP = 22
const ROW_GAP = 22
/** Minimum distance between two vertical jogs that overlap in y. */
const JOG_MIN = 14
const JOG_MARGIN = 12
/** Clearance kept from a node's box when a jog corridor is chosen. */
const CLEAR = 6

export type HandleId = 'in' | 'out' | 'loop-out' | 'loop-in' | 'retry-in'
export interface Pt { x: number; y: number }

/**
 * Where each handle sits on a node of this kind, relative to the node. The
 * gate is a diamond, so its loop handles sit on the lower faces just beside
 * the tip; every other shape has a flat bottom.
 */
export function handlePoints(kind: NodeKind): Record<HandleId, Pt> {
  const { w, h } = nodeSize(kind)
  const cx = w / 2
  if (kind === 'gate') {
    // the lower faces run from the tip (cx, h-2) up to (2, h/2) and (w-2, h/2)
    const faceY = (x: number) => Math.round(h - 2 - (h / 2 - 2) * Math.abs(x - cx) / (cx - 2))
    return {
      in: { x: 0, y: h / 2 }, out: { x: w, y: h / 2 },
      'loop-out': { x: cx - HANDLE_OFF, y: faceY(cx - HANDLE_OFF) },
      'loop-in': { x: cx + HANDLE_OFF, y: faceY(cx + HANDLE_OFF) },
      'retry-in': { x: cx, y: h },
    }
  }
  return { in: { x: 0, y: h / 2 }, out: { x: w, y: h / 2 }, 'loop-out': { x: cx - HANDLE_OFF, y: h }, 'loop-in': { x: cx + HANDLE_OFF, y: h }, 'retry-in': { x: cx, y: h } }
}

/** x/y are relative to the lane (React Flow parent); ax/ay are absolute (thumbnails, routing). */
export interface LaidOutNode { id: string; x: number; y: number; ax: number; ay: number; w: number; h: number; lane: string; kind: NodeKind }
export interface Lane { id: string; title: string; x: number; y: number; w: number; h: number }
export interface RoutedEdge {
  id: string
  source: string
  target: string
  loop?: 'back' | 'retry'
  sourceHandle: HandleId
  targetHandle: HandleId
  /** Absolute flow coordinates, an orthogonal polyline from the source handle to the target handle. */
  points: Pt[]
  /** The loop's bound, placed on the horizontal run. */
  label?: { text: string; x: number; y: number }
}
/** The outcome column: a lane-like box right of the last lane; `inY` is where its `in` handle sits (relative), level with the last chain node. */
export interface OutcomeBox { x: number; y: number; w: number; h: number; inY: number; from?: string }
export interface Layout {
  lanes: Lane[]
  nodes: LaidOutNode[]
  edges: RoutedEdge[]
  outcome?: OutcomeBox
  /** Bottom of the lanes; loops run below it. */
  laneBottom: number
  width: number
  height: number
}

export function layout(graph: Graph): Layout {
  const phases = graph.phases.length ? graph.phases : ['']
  const laneOf = (p: string) => (phases.includes(p) ? p : phases[0])
  const lanes: Lane[] = []
  const out: LaidOutNode[] = []
  let x = 0
  const perLane = phases.map((phase) => {
    const ns = graph.nodes.filter((n) => laneOf(n.phase) === phase)
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: ROW_GAP, ranksep: 56, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of ns) { const { w, h } = nodeSize(n.kind); g.setNode(n.id, { width: w, height: h }) }
    const ids = new Set(ns.map((n) => n.id))
    for (const e of graph.edges) if (!e.loop && ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target)
    const shelf = ns.filter((n) => graph.edges.some((e) => e.loop === 'back' && e.target === n.id) && !graph.edges.some((e) => !e.loop && e.target === n.id))
    for (let i = 1; i < shelf.length; i++) g.setEdge(shelf[i - 1].id, shelf[i].id)
    let pos: { id: string; cx: number; cy: number; h: number }[]
    if (g.edgeCount() === 0 && ns.length > MAX_ROWS) {
      // A fan-out with nothing between its nodes: pack it into columns so a
      // 15-agent phase is a block, not a 1700px tower. Odd columns are
      // staggered by half a row, so an edge leaving a first-column node runs
      // through the gutter of the second column instead of through a node.
      const cols = Math.ceil(ns.length / MAX_ROWS)
      const rows = Math.ceil(ns.length / cols)
      const pitch = Math.max(...ns.map((n) => nodeSize(n.kind).h)) + ROW_GAP
      pos = ns.map((n, i) => {
        const col = Math.floor(i / rows)
        const { h } = nodeSize(n.kind)
        return { id: n.id, h, cx: col * (NODE_W + COL_GAP) + NODE_W / 2, cy: (i % rows) * pitch + (col % 2) * (pitch / 2) + h / 2 }
      })
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
    return { phase, pos, w, h, nodes: ns }
  })
  const bodyH = Math.max(...perLane.map((l) => l.h), NODE_H)
  const headH = Math.max(LANE_HEAD, ...perLane.map((l) => {
    const detail = graph.phaseDetails?.[l.phase]
    const lines = detail ? Math.min(3, Math.ceil((detail.length * DETAIL_CHAR) / (l.w + LANE_PAD * 2 - 36))) : 0
    return HEAD_BASE + lines * DETAIL_LINE
  }))
  const laneH = bodyH + LANE_PAD * 2 + headH
  const kindOfId = new Map(graph.nodes.map((n) => [n.id, n.kind]))
  perLane.forEach((l, i) => {
    const laneW = l.w + LANE_PAD * 2
    const id = `lane:${i}`
    lanes.push({ id, title: l.phase, x, y: 0, w: laneW, h: laneH })
    const dy = (bodyH - l.h) / 2
    const placed: LaidOutNode[] = []
    for (const p of l.pos) {
      const nx = LANE_PAD + p.cx - NODE_W / 2
      const ny = headH + LANE_PAD + dy + p.cy - p.h / 2
      placed.push({ id: p.id, lane: id, w: NODE_W, h: p.h, x: nx, y: ny, ax: x + nx, ay: ny, kind: kindOfId.get(p.id) ?? 'agent' })
    }
    // Reading (and Tab) order inside a lane: top → bottom, then left → right.
    placed.sort((a, b) => a.y - b.y || a.x - b.x)
    out.push(...placed)
    x += laneW + LANE_GAP
  })
  const lanesWidth = Math.max(0, x - LANE_GAP)

  // The visible end: one column right of the last lane, fed by the last node
  // of the last lane that still has nodes and no step leaving it.
  let outcome: OutcomeBox | undefined
  if (graph.outcomes?.length) {
    const lastLane = [...lanes].reverse().find((ln) => out.some((n) => n.lane === ln.id))
    const ends = out.filter((n) => n.lane === lastLane?.id && !graph.edges.some((e) => !e.loop && e.source === n.id))
    const from = ends.sort((a, b) => b.ax - a.ax || b.ay - a.ay)[0]
    const box = { x: lanesWidth + LANE_GAP, y: 0, w: OUTCOME_W, h: laneH }
    outcome = { ...box, inY: from ? from.ay + from.h / 2 - box.y : headH + LANE_PAD + NODE_H / 2, from: from?.id }
  }

  const edges = routeEdges(graph, out, laneH, outcome)
  const loopBottom = edges.reduce((m, e) => Math.max(m, ...e.points.map((p) => p.y)), laneH)
  return { lanes, nodes: out, edges, outcome, laneBottom: laneH, width: outcome ? outcome.x + outcome.w : lanesWidth, height: loopBottom > laneH ? loopBottom + 12 : laneH }
}

// --- routing -------------------------------------------------------------------

interface Box { id: string; x: number; y: number; w: number; h: number; kind: NodeKind }
const boxOf = (n: LaidOutNode): Box => ({ id: n.id, x: n.ax, y: n.ay, w: n.w, h: n.h, kind: n.kind })
const handleAt = (b: Box, id: HandleId): Pt => { const p = handlePoints(b.kind)[id]; return { x: b.x + p.x, y: b.y + p.y } }

function routeEdges(graph: Graph, nodes: LaidOutNode[], laneBottom: number, outcome?: OutcomeBox): RoutedEdge[] {
  const boxes = new Map(nodes.map((n) => [n.id, boxOf(n)]))
  const all = [...boxes.values()]
  const steps = graph.edges.filter((e) => !e.loop && boxes.has(e.source) && boxes.has(e.target))
  const outDeg = new Map<string, number>()
  const inDeg = new Map<string, number>()
  for (const e of steps) { outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1); inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1) }
  const dyOf = (e: { source: string; target: string }) => Math.abs(handleAt(boxes.get(e.target)!, 'in').y - handleAt(boxes.get(e.source)!, 'out').y)

  // Where along its corridor an edge wants its jog: in a fan-out the farthest
  // target turns first (nearest the source), in a fan-in the nearest source
  // turns first — either way no branch crosses another's horizontal.
  const fraction = (e: { source: string; target: string }): number => {
    const o = outDeg.get(e.source) ?? 0, i = inDeg.get(e.target) ?? 0
    if (o > 1 && i <= 1) {
      const sibs = steps.filter((s) => s.source === e.source).sort((a, b) => dyOf(b) - dyOf(a))
      return (sibs.indexOf(e as never) + 1) / (sibs.length + 1)
    }
    if (i > 1 && o <= 1) {
      const sibs = steps.filter((s) => s.target === e.target).sort((a, b) => dyOf(a) - dyOf(b))
      return (sibs.indexOf(e as never) + 1) / (sibs.length + 1)
    }
    return 0.5
  }

  const result: RoutedEdge[] = []
  const jogs: { x: number; y1: number; y2: number }[] = [] // vertical segments already placed
  const forward = steps.map((e) => ({ e, f: fraction(e) })).sort((a, b) => a.f - b.f || boxes.get(a.e.source)!.y - boxes.get(b.e.source)!.y)
  for (const { e, f } of forward) {
    const S = boxes.get(e.source)!, T = boxes.get(e.target)!
    const a = handleAt(S, 'out'), b = handleAt(T, 'in')
    result.push({ id: `${e.source}→${e.target}`, source: e.source, target: e.target, sourceHandle: 'out', targetHandle: 'in', points: stepPath(a, b, S, T, all, f, jogs) })
  }

  // Loops: below the lanes, the shortest run nearest the lanes, each on its own y.
  const loops = graph.edges.filter((e) => e.loop && boxes.has(e.source) && boxes.has(e.target)).map((e) => {
    const S = boxes.get(e.source)!, T = boxes.get(e.target)!
    const a = handleAt(S, 'loop-out')
    const b = handleAt(T, e.loop === 'back' ? 'loop-in' : 'retry-in')
    return { e, a, b, span: Math.abs(a.x - b.x) }
  }).sort((p, q) => p.span - q.span || (p.e.loop === 'back' ? -1 : 1))
  const loopYs = loops.map((_, k) => laneBottom + LOOP_DROP + k * LOOP_STEP)
  loops.forEach(({ e, a, b }, k) => {
    const y = loopYs[k]
    const points = [a, { x: a.x, y }, { x: b.x, y }, b]
    const route: RoutedEdge = { id: `${e.source}→${e.target}`, source: e.source, target: e.target, loop: e.loop, sourceHandle: 'loop-out', targetHandle: e.loop === 'back' ? 'loop-in' : 'retry-in', points }
    if (e.loop === 'back' && e.label) {
      // The pill sits mid-run, nudged off any other loop's vertical that passes this y.
      const lo = Math.min(a.x, b.x) + 24, hi = Math.max(a.x, b.x) - 24
      const verticals = loops.flatMap((o, j) => (j === k ? [] : [{ x: o.a.x, y: loopYs[j] }, { x: o.b.x, y: loopYs[j] }])).filter((v) => v.y >= y)
      let lx = (a.x + b.x) / 2
      for (let i = 0; i < 12; i++) {
        const cand = lx + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 36
        if (cand < lo || cand > hi) continue
        if (verticals.every((v) => Math.abs(v.x - cand) >= 28)) { lx = cand; break }
      }
      route.label = { text: e.label, x: lx, y }
    }
    result.push(route)
  })

  if (outcome?.from) {
    const S = boxes.get(outcome.from)!
    const a = handleAt(S, 'out')
    const b = { x: outcome.x, y: outcome.y + outcome.inY }
    result.push({ id: `${outcome.from}→outcome`, source: outcome.from, target: 'outcome', sourceHandle: 'out', targetHandle: 'in', points: stepPath(a, b, S, { id: 'outcome', ...outcome, kind: 'agent' }, all, 0.5, jogs) })
  }
  return result
}

/**
 * Right of S to left of T: straight when level; else out, across to a jog x
 * in a corridor no node touches (the widest one), down or up, and in. Jogs
 * that overlap in y keep JOG_MIN apart.
 */
function stepPath(a: Pt, b: Pt, S: Box, T: Box, all: Box[], f: number, jogs: { x: number; y1: number; y2: number }[]): Pt[] {
  if (Math.abs(a.y - b.y) < 1) return [a, b]
  if (b.x <= a.x + 2 * JOG_MARGIN) {
    // Target is not right of the source: go around underneath both.
    const y = Math.max(S.y + S.h, T.y + T.h) + LOOP_DROP
    return [a, { x: a.x + JOG_MARGIN, y: a.y }, { x: a.x + JOG_MARGIN, y }, { x: b.x - JOG_MARGIN, y }, { x: b.x - JOG_MARGIN, y: b.y }, b]
  }
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y)
  const blocked = all
    .filter((n) => n.id !== S.id && n.id !== T.id && n.x < b.x && n.x + n.w > a.x && n.y - CLEAR < y2 && n.y + n.h + CLEAR > y1)
    .map((n) => [n.x - CLEAR, n.x + n.w + CLEAR] as [number, number])
    .sort((p, q) => p[0] - q[0])
  const free: [number, number][] = []
  let cur = a.x
  for (const [l, r] of blocked) { if (l > cur) free.push([cur, l]); cur = Math.max(cur, r) }
  if (cur < b.x) free.push([cur, b.x])
  const corridor = free.filter(([l, r]) => r - l >= 2 * JOG_MARGIN + 2).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0] ?? [a.x, b.x]
  const lo = corridor[0] + JOG_MARGIN, hi = corridor[1] - JOG_MARGIN
  const ideal = lo + (hi - lo) * f
  const clash = (x: number) => jogs.some((j) => Math.abs(j.x - x) < JOG_MIN && j.y1 < y2 && j.y2 > y1)
  let cx = ideal
  for (let i = 0; i < 40; i++) {
    const cand = ideal + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * JOG_MIN
    if (cand < lo || cand > hi) continue
    if (!clash(cand)) { cx = cand; break }
  }
  jogs.push({ x: cx, y1, y2 })
  return [a, { x: cx, y: a.y }, { x: cx, y: b.y }, b]
}

/** An SVG path through orthogonal points with rounded corners (radius shrinks on short legs). */
export function roundedPath(points: Pt[], radius = 10): string {
  if (points.length < 2) return ''
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1], c = points[i], n = points[i + 1]
    const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2)
    const inX = c.x - Math.sign(c.x - p.x) * r, inY = c.y - Math.sign(c.y - p.y) * r
    const outX = c.x + Math.sign(n.x - c.x) * r, outY = c.y + Math.sign(n.y - c.y) * r
    d += ` L ${inX} ${inY} Q ${c.x} ${c.y} ${outX} ${outY}`
  }
  const last = points[points.length - 1]
  return d + ` L ${last.x} ${last.y}`
}
