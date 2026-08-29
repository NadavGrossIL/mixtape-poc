import { useMemo } from 'react'
import type { RunGraph } from '../types'
import { layout } from '../graph'

/** A small SVG of the DAG for the workflow cards: lanes, nodes coloured by state, straight edges. */
export function Thumbnail({ graph }: { graph: RunGraph }) {
  const l = useMemo(() => layout(graph), [graph])
  const pos = new Map(l.nodes.map((n) => [n.id, n]))
  const w = Math.max(l.width, 1)
  const h = Math.max(l.height, 1)
  return (
    <svg className="thumb" viewBox={`-8 -8 ${w + 16} ${h + 16}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="workflow map">
      {l.lanes.map((ln) => <rect key={ln.id} className="thumb-lane" x={ln.x} y={ln.y} width={ln.w} height={ln.h} rx={14} />)}
      {graph.edges.map((e) => {
        const s = pos.get(e.source), t = pos.get(e.target)
        if (!s || !t) return null
        const k = `${e.source}-${e.target}`
        if (e.loop === 'back') { // a squared U under both, like the canvas
          const y = Math.max(s.ay + s.h, t.ay + t.h) + 18
          return <polyline key={k} className="thumb-edge" data-loop points={`${s.ax + s.w / 2},${s.ay + s.h} ${s.ax + s.w / 2},${y} ${t.ax + t.w / 2},${y} ${t.ax + t.w / 2},${t.ay + t.h}`} />
        }
        return <line key={k} className="thumb-edge" data-loop={e.loop ? '' : undefined} x1={s.ax + s.w} y1={s.ay + s.h / 2} x2={t.ax} y2={t.ay + t.h / 2} />
      })}
      {l.nodes.map((n) => <rect key={n.id} className="thumb-node" data-state={graph.info[n.id]?.state ?? 'idle'} x={n.ax} y={n.ay} width={n.w} height={n.h} rx={16} />)}
    </svg>
  )
}
