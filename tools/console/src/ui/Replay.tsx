import { useEffect, useRef } from 'react'
import { fmtDuration } from './format'

export const SPEEDS = [5, 20, 50] as const

export interface ReplayState { pos?: number; playing: boolean; speed: number }

/**
 * Bottom bar: play/pause, speed, scrubber. `pos` is ms since the run started;
 * undefined means "show the finished run". The clock advances by real time × speed.
 */
export function Replay({ total, state, onChange }: { total: number; state: ReplayState; onChange: (s: ReplayState) => void }) {
  const ref = useRef(state)
  ref.current = state
  useEffect(() => {
    if (!state.playing) return
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const s = ref.current
      const next = (s.pos ?? 0) + (now - last) * s.speed
      last = now
      if (next >= total) onChange({ ...s, pos: total, playing: false })
      else { onChange({ ...s, pos: next }); raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.playing, state.speed, total, onChange])

  const pos = state.pos ?? total
  const toggle = () => {
    if (state.playing) onChange({ ...state, playing: false })
    else onChange({ ...state, playing: true, pos: state.pos == null || state.pos >= total ? 0 : state.pos })
  }
  return (
    <footer className="replay">
      <button className="btn" onClick={toggle} disabled={total <= 0} aria-label={state.playing ? 'pause' : 'play'}>{state.playing ? 'Pause' : 'Play'}</button>
      <div className="speeds" role="group" aria-label="speed">
        {SPEEDS.map((s) => <button key={s} className="btn btn-small" data-on={s === state.speed || undefined} onClick={() => onChange({ ...state, speed: s })}>{s}×</button>)}
      </div>
      <input className="scrub" type="range" min={0} max={Math.max(total, 1)} step={250} value={Math.min(pos, total)} disabled={total <= 0}
        onChange={(e) => onChange({ ...state, playing: false, pos: Number(e.target.value) })} aria-label="replay position" />
      <span className="clock">{fmtDuration(pos)} / {fmtDuration(total)}</span>
      <button className="btn btn-small" onClick={() => onChange({ ...state, playing: false, pos: undefined })} disabled={state.pos == null}>Final</button>
    </footer>
  )
}
