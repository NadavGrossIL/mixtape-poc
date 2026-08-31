import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeState, RunManifest, WorkflowAgentEntry } from '../types'
import { agentEnd, agentsOf, isStalled, labelOf, nodeId, stateAt } from '../graph'
import { fmtDuration, fmtTime, fmtTokens, isLive, nowAt } from './format'

/**
 * Bottom strip: a static picture of when things ran — a tick where each phase
 * began and one bar per agent from its start to its end, coloured by how it
 * settled (IA-SPEC §7). Everything here is computed from the manifest alone,
 * so it needs no clock of its own: a finished run draws its final shape, a live
 * one redraws as the journal grows (an agent that never settled runs to `now`).
 * Clicking a bar selects that agent's node on the canvas.
 */
export function Timeline({ total, start, run, phases, now, onSelect }: {
  total: number; start: number; run?: RunManifest; phases: string[]; now: number; onSelect?: (id: string) => void
}) {
  const live = isLive(run) && !isStalled(run)
  const markers = useMemo(() => markersOf(run, phases, start, total, now), [run, phases, start, total, now])
  // The track's width in px, so two phase labels that would overlap keep only their ticks (the title still names the phase).
  const wrap = useRef<HTMLDivElement>(null)
  const [trackW, setTrackW] = useState(0)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const read = () => setTrackW(el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const labelFits = (i: number) => {
    const p = markers.phases[i], next = markers.phases[i + 1]
    if (!next || !trackW) return true
    return ((next.left - p.left) / 100) * trackW >= p.name.length * 6.6 + 12
  }

  const following = live ? `Following the run live from the ${run?.source === 'manifest' ? 'manifest' : 'journal'} · ${nowAt(run, now) ?? 'between steps'}.` : undefined
  const nothing = total <= 0 || markers.agents.length === 0 // a 13 ms run with no agents has nothing to draw (A20)
  if (nothing) {
    return (
      <footer className="timeline empty">
        <span className="muted small">{following ?? 'No agent ran long enough to draw a timeline.'}</span>
      </footer>
    )
  }
  return (
    <footer className="timeline">
      <div className="track-wrap" ref={wrap}>
        <div className="phase-labels" aria-hidden>
          {markers.phases.map((p, i) => <span key={p.name} className="phase-label" style={{ left: `${p.left}%` }} title={p.title}>{labelFits(i) ? p.name : ''}</span>)}
        </div>
        <div className="track" style={{ height: markers.rows * 8 + 6 }} aria-label="phases and agents on the timeline">
          {markers.phases.map((p) => <i key={p.name} className="phase-tick" style={{ left: `${p.left}%` }} title={p.title} />)}
          {markers.agents.map((a) => (
            <button key={a.key} type="button" className="agent-bar" data-state={a.state} style={{ left: `${a.left}%`, width: `${a.width}%`, top: a.row * 8 + 3 }} title={a.title}
              aria-label={a.title} disabled={!onSelect} onClick={() => onSelect?.(a.nodeId)} />
          ))}
        </div>
      </div>
      {following && <span className="muted small following">{following}</span>}
    </footer>
  )
}

interface PhaseMark { name: string; left: number; title: string }
interface AgentMark { key: string; nodeId: string; left: number; width: number; row: number; state: NodeState; title: string }

/**
 * Where things sit on the track, in percent of the run. A phase's tick is the
 * earliest `queuedAt ?? startedAt` of its agents; an agent's bar runs from
 * `startedAt` to `agentEnd` (or now, for one that never settled). Bars that
 * overlap in time take separate rows (a fan-out), greedily.
 */
function markersOf(run: RunManifest | undefined, phases: string[], start: number, total: number, now: number): { phases: PhaseMark[]; agents: AgentMark[]; rows: number } {
  const agents = agentsOf(run)
  const stalled = isStalled(run)
  const pct = (t: number) => (total > 0 ? Math.max(0, Math.min(100, ((t - start) / total) * 100)) : 0)
  const endOf = (a: WorkflowAgentEntry) => agentEnd(a) ?? now

  const byPhase = new Map<string, WorkflowAgentEntry[]>()
  for (const a of agents) {
    const p = a.phaseTitle ?? phases[(a.phaseIndex ?? 1) - 1] ?? phases[0] ?? ''
    const l = byPhase.get(p)
    if (l) l.push(a); else byPhase.set(p, [a])
  }
  const order = [...phases, ...[...byPhase.keys()].filter((p) => !phases.includes(p))]
  const phaseMarks: PhaseMark[] = []
  for (const name of order) {
    const list = byPhase.get(name) ?? []
    const froms = list.map((a) => a.queuedAt ?? a.startedAt).filter((x): x is number => x != null)
    if (!froms.length) continue
    const from = Math.min(...froms)
    const to = Math.max(from, ...list.map(endOf))
    phaseMarks.push({ name, left: pct(from), title: `${name} · from ${fmtTime(from)} · ${fmtDuration(to - from)}` })
  }

  const rowEnds: number[] = [] // the time each row is busy until
  const agentMarks: AgentMark[] = []
  const timed = agents.filter((a) => a.startedAt != null).sort((a, b) => a.startedAt! - b.startedAt!)
  timed.forEach((a, i) => {
    const s = a.startedAt!
    const e = Math.max(s, endOf(a))
    let row = rowEnds.findIndex((end) => end <= s)
    if (row < 0) { row = rowEnds.length; rowEnds.push(e) } else rowEnds[row] = e
    const state = stateAt(a, stalled)
    const label = labelOf(a)
    const left = pct(s)
    const width = Math.max(0.4, pct(e) - left)
    // The same id `overlayRun` gives the node it drew for this agent, so a click can select it.
    agentMarks.push({ key: a.agentId ?? `${label}-${i}`, nodeId: nodeId(label), left, width, row, state, title: `${label} · ${fmtTime(s)} → ${fmtTime(e)} · ${fmtDuration(e - s)} · ${state} · ${fmtTokens(a.tokens)} tok` })
  })
  return { phases: phaseMarks, agents: agentMarks, rows: Math.max(1, rowEnds.length) }
}
