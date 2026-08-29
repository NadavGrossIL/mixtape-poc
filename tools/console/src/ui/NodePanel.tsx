import { useEffect, useState } from 'react'
import type { AgentDetail, GraphNode, NodeRunInfo, RunManifest } from '../types'
import { fmtDuration, fmtTokens, shortModel, dash } from './format'

/** `tick` bumps when the run's journal moved; a transcript already on screen is reloaded then. */
export function NodePanel({ node, info, run, tick, onClose }: { node: GraphNode; info?: NodeRunInfo; run?: RunManifest; tick?: number; onClose: () => void }) {
  const a = info?.agent
  const [detail, setDetail] = useState<AgentDetail | { error: string } | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { setDetail(null); setLoading(false) }, [node.id, run?.runId])
  const canLoad = !!(run?.runId && a?.agentId && !run.fixture)
  const load = async () => {
    if (!canLoad) return
    setLoading(true)
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run!.runId!)}/agents/${encodeURIComponent(a!.agentId!)}`)
      setDetail(res.ok ? await res.json() : { error: `${res.status}: ${(await res.json().catch(() => ({}))).error ?? 'not found'}` })
    } catch (e) { setDetail({ error: String(e) }) } finally { setLoading(false) }
  }
  const loaded = !!detail && 'prompt' in detail
  useEffect(() => { if (loaded && tick) void load() }, [tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows: [string, string][] = [
    ['phase', node.phase || dash],
    ['kind', node.kind],
    ['state', info?.state ?? 'idle'],
    ['model', shortModel(a?.model)],
    ['attempt', a ? String(info?.attempt ?? a.attempt ?? 1) : dash],
    ['tokens', fmtTokens(a?.tokens)],
    ['tool calls', a?.toolCalls != null ? String(a.toolCalls) : dash],
    ['duration', fmtDuration(a?.durationMs)],
    ['last tool', a?.lastToolName ?? dash],
    ['agent id', a?.agentId ?? dash],
  ]
  return (
    <aside className="panel" aria-label="node details">
      <header className="panel-head">
        <h2>{node.label}</h2>
        <button className="btn btn-small" onClick={onClose} aria-label="close">Close</button>
      </header>
      <dl className="facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {a?.error && <section><h3>error</h3><pre className="mono err">{a.error}</pre></section>}
      <section><h3>prompt preview</h3><pre className="mono">{a?.promptPreview ?? dash}</pre></section>
      <section><h3>result preview</h3><pre className="mono">{a?.resultPreview ?? dash}</pre></section>
      {info && info.agents.length > 1 && (
        <section><h3>attempts</h3><ul className="muted small">{info.agents.map((x, i) => <li key={i}>attempt {x.attempt ?? i + 1}: {x.state ?? dash} · {fmtDuration(x.durationMs)} · {fmtTokens(x.tokens)} tok</li>)}</ul></section>
      )}
      <section>
        <h3>full prompt</h3>
        {!a && <p className="muted small">This node has not run in the selected run.</p>}
        {a && run?.fixture && <p className="muted small">Fixture run: the transcript is not shipped with the repo.</p>}
        {canLoad && !detail && <button className="btn btn-small" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Load transcript'}</button>}
        {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
        {detail && 'prompt' in detail && (
          <>
            <pre className="mono tall">{detail.prompt || dash}</pre>
            <h3>result</h3>
            <pre className="mono tall">{detail.result || dash}</pre>
            <h3>events ({detail.events.length})</h3>
            <ol className="events">{detail.events.map((e, i) => <li key={i}><span className="muted">{e.ts.slice(11, 19)}</span> <b>{e.kind}{e.name ? ` ${e.name}` : ''}</b> <span className="mono">{e.summary}</span></li>)}</ol>
          </>
        )}
      </section>
    </aside>
  )
}
