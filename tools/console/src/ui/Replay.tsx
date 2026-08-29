import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeState, RunManifest, WorkflowAgentEntry } from '../types'
import { agentEnd, agentsOf, isStalled, labelOf, stateAt } from '../graph'
import { fmtDuration, fmtTime, fmtTokens, isLive, nowAt } from './format'

export const SPEEDS = [5, 20, 50] as const

export interface ReplayState { pos?: number; playing: boolean; speed: number }

/**
 * Bottom bar: play/pause, speed, scrubber, and under the scrubber a marker
 * track — a tick where each phase began and one bar per agent from its start
 * to its end, coloured by how it settled; click a bar to seek there (IA-SPEC
 * §7). `pos` is ms since the run started; undefined means "show the finished
 * run". The clock advances by real time × speed. A live run has no scrubber:
 * one sentence says what runs now, until the run finishes.
 */
export function Replay({ total, start, state, run, phases, now, onChange }: {
  total: number; start: number; state: ReplayState; run?: RunManifest; phases: string[]; now: number; onChange: (s: ReplayState) => void
}) {
  const ref = useRef(state)
  ref.current = state
  const live = isLive(run) && !isStalled(run)
  useEffect(() => {
    if (!state.playing || live) return
    let last = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const s = ref.current
      const next = (s.pos ?? 0) + (t - last) * s.speed
      last = t
      if (next >= total) onChange({ ...s, pos: total, playing: false })
      else { onChange({ ...s, pos: next }); raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.playing, state.speed, total, live, onChange])

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
  }, [live])
  const labelFits = (i: number) => {
    const p = markers.phases[i], next = markers.phases[i + 1]
    if (!next || !trackW) return true
    return ((next.left - p.left) / 100) * trackW >= p.name.length * 6.6 + 12
  }

  if (live) {
    return (
      <footer className="replay following">
        <span className="muted small">Following the run live from the {run?.source === 'manifest' ? 'manifest' : 'journal'} · {nowAt(run, now) ?? 'between steps'} · replay is available once it finishes.</span>
      </footer>
    )
  }
  const pos = state.pos ?? total
  const nothing = total <= 0 || markers.agents.length === 0 // a 13 ms run with no agents has nothing to replay (A20)
  // The input's max is `total` rounded up to a step, so its last notch reaches the end of the run (A6: a notch short of it left the last agent RUNNING).
  const STEP = 250
  const max = Math.max(STEP, Math.ceil(total / STEP) * STEP)
  const toggle = () => {
    if (state.playing) onChange({ ...state, playing: false })
    else onChange({ ...state, playing: true, pos: state.pos == null || state.pos >= total ? 0 : state.pos })
  }
  const seek = (ms: number) => onChange({ ...state, playing: false, pos: Math.max(0, Math.min(total, ms)) })
  return (
    <footer className="replay">
      <button className="btn" onClick={toggle} disabled={nothing} aria-label={state.playing ? 'pause' : 'play'}>{state.playing ? 'Pause' : 'Play'}</button>
      <div className="speeds" role="group" aria-label="speed">
        {SPEEDS.map((s) => <button key={s} className="btn btn-small" data-on={s === state.speed || undefined} onClick={() => onChange({ ...state, speed: s })}>{s}×</button>)}
      </div>
      <div className="scrub-wrap" ref={wrap}>
        <div className="phase-labels" aria-hidden>
          {markers.phases.map((p, i) => <span key={p.name} className="phase-label" style={{ left: `${p.left}%` }} title={p.title}>{labelFits(i) ? p.name : ''}</span>)}
        </div>
        <input className="scrub" type="range" min={0} max={max} step={STEP} value={Math.min(pos >= total ? max : pos, max)} disabled={nothing}
          onChange={(e) => onChange({ ...state, playing: false, pos: Math.min(total, Number(e.target.value)) })} aria-label="replay position" />
        <div className="track" style={{ height: markers.rows * 8 + 6 }} aria-label="phases and agents on the timeline">
          {markers.phases.map((p) => <i key={p.name} className="phase-tick" style={{ left: `${p.left}%` }} title={p.title} />)}
          {markers.agents.map((a) => (
            <button key={a.key} type="button" className="agent-bar" data-state={a.state} style={{ left: `${a.left}%`, width: `${a.width}%`, top: a.row * 8 + 3 }} title={a.title}
              aria-label={a.title} disabled={total <= 0} onClick={() => seek(a.at - start)} />
          ))}
        </div>
      </div>
      <span className="clock">{fmtDuration(pos)} / {fmtDuration(total)}</span>
      <button className="btn btn-small" onClick={() => onChange({ ...state, playing: false, pos: undefined })} disabled={state.pos == null}>Final</button>
    </footer>
  )
}

interface PhaseMark { name: string; left: number; title: string }
interface AgentMark { key: string; at: number; left: number; width: number; row: number; state: NodeState; title: string }

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
    const state = stateAt(a, undefined, stalled)
    const label = labelOf(a)
    const left = pct(s)
    const width = Math.max(0.4, pct(e) - left)
    agentMarks.push({ key: a.agentId ?? `${label}-${i}`, at: s, left, width, row, state, title: `${label} · ${fmtTime(s)} → ${fmtTime(e)} · ${fmtDuration(e - s)} · ${state} · ${fmtTokens(a.tokens)} tok` })
  })
  return { phases: phaseMarks, agents: agentMarks, rows: Math.max(1, rowEnds.length) }
}
