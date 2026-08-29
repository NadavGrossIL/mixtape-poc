import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConsoleEvent, Ledger, RunManifest, WorkflowFile } from '../types'
import { graphFor, overlayRun, runBounds } from '../graph'
import { Workflows, cardsFrom, type ConsoleMeta } from './Workflows'
import { Canvas } from './Canvas'
import { RunList } from './RunList'
import { Replay, type ReplayState } from './Replay'
import { NodePanel } from './NodePanel'
import { fmtDuration, fmtTokens, fmtUsd, isLive, projectTag, dash } from './format'

type Conn = 'connecting' | 'connected' | 'reconnecting'

export function App() {
  const [files, setFiles] = useState<WorkflowFile[]>([])
  const [runs, setRuns] = useState<RunManifest[]>([])
  const [ledger, setLedger] = useState<Ledger>({})
  const [meta, setMeta] = useState<ConsoleMeta>({})
  const [error, setError] = useState<string>()
  const [workflow, setWorkflow] = useState<string>()
  const [runId, setRunId] = useState<string>()
  const [replay, setReplay] = useState<ReplayState>({ playing: false, speed: 20 })
  const [selected, setSelected] = useState<string>()
  const [conn, setConn] = useState<Conn>('connecting')
  const [tick, setTick] = useState(0) // journal events; the node panel reloads an open transcript on it
  const [now, setNow] = useState(() => Date.now())

  const loadFiles = useCallback(() => fetch('/api/workflows').then((r) => r.json()).then(setFiles), [])
  const loadRuns = useCallback(() => fetch('/api/runs?full=1').then((r) => r.json()).then(setRuns), [])
  const loadLedger = useCallback(() => fetch('/api/ledger').then((r) => r.json()).then(setLedger), [])
  useEffect(() => {
    Promise.all([loadFiles(), loadRuns(), loadLedger(), fetch('/api/meta').then((r) => r.json()).then(setMeta)]).catch((e) => setError(String(e)))
  }, [loadFiles, loadRuns, loadLedger])

  // One event stream for the page's life. The browser reconnects on its own;
  // a refetch that fails is left to the next event rather than blanking the page.
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConn('connected')
    es.onerror = () => setConn('reconnecting')
    es.onmessage = (m) => {
      let e: ConsoleEvent
      try { e = JSON.parse(m.data) } catch { return }
      if (e.kind === 'workflows') void loadFiles().catch(() => {})
      else if (e.kind === 'ledger') void loadLedger().catch(() => {})
      else { void loadRuns().catch(() => {}); if (e.kind === 'journal') setTick((t) => t + 1) }
    }
    return () => es.close()
  }, [loadFiles, loadRuns, loadLedger])

  const cards = useMemo(() => cardsFrom(files, runs), [files, runs])
  const card = cards.find((c) => c.name === workflow)
  const wfRuns = useMemo(() => runs.filter((r) => (r.workflowName ?? 'unnamed') === workflow), [runs, workflow])
  const run = runs.find((r) => r.runId === runId) ?? wfRuns[0]
  const live = !!run?.live
  const bounds = useMemo(() => (run ? runBounds(run) : { start: 0, end: 0 }), [run])
  const total = bounds.end - bounds.start
  // A live run follows "now": the scrubber is ignored (and hidden) until it finishes.
  const t = live || replay.pos == null ? undefined : bounds.start + replay.pos
  const graph = useMemo(() => overlayRun(graphFor(card?.file, run), run, t), [card, run, t])
  const selectedNode = graph.nodes.find((n) => n.id === selected)

  // The clock ticks while something is live: the selected run on the canvas, or any card's last run on the workflows screen.
  const ticking = live || (!workflow && cards.some((c) => isLive(c.lastRun)))
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  const open = (name: string) => { setWorkflow(name); setRunId(undefined); setReplay({ playing: false, speed: 20 }); setSelected(undefined) }
  const pickRun = (id: string) => {
    const r = runs.find((x) => x.runId === id)
    if (r && (r.workflowName ?? 'unnamed') !== workflow) setWorkflow(r.workflowName ?? 'unnamed')
    setRunId(id); setReplay((s) => ({ ...s, playing: false, pos: undefined })); setSelected(undefined)
  }
  const onReplay = useCallback((s: ReplayState) => setReplay(s), [])
  const connLabel = conn === 'connected' ? 'live' : conn

  const connTitle = conn === 'reconnecting' ? 'the event stream dropped; the browser retries on its own' : 'event stream'
  if (error) {
    return (
      <main className="shell">
        <section className="workflows">
          <header className="screen-head"><h1>Workflows</h1></header>
          <div className="state">
            <p className="err">Could not reach the console plugin at {window.location.host || '127.0.0.1:5174'}.</p>
            <p>Start it from the repo root: <code>npm run console</code></p>
            <p>Then reload this page.</p>
            <pre className="mono">{error}</pre>
          </div>
        </section>
      </main>
    )
  }
  if (!workflow) {
    return (
      <main className="shell">
        <Workflows cards={cards} files={files} ledger={ledger} meta={meta} now={now} onOpen={open} />
        <p className="muted small foot">
          <span className="conn" data-state={conn} title={connTitle}>{connLabel}</span>
          {' · '}reads {meta.projectDirs?.length ? meta.projectDirs.join(', ') : '~/.claude/projects/<slug>*'}{meta.exists === false ? ' (repo dir not found)' : ''}
          {' · '}local only
        </p>
      </main>
    )
  }
  const elapsed = live && bounds.start ? Math.max(now - bounds.start, run?.durationMs ?? 0) : t != null ? t - bounds.start : run?.durationMs
  return (
    <main className="shell canvas-shell">
      <header className="run-head">
        <button className="btn btn-small" onClick={() => setWorkflow(undefined)}>All workflows</button>
        <h1>{workflow}</h1>
        {card?.file && <span className="badge" data-engine={card.file.engine}>{card.file.engine}</span>}
        <span className="pill" data-status={run?.status ?? 'idle'}>{run?.status ?? 'no run'}</span>
        {live && <span className="badge" data-live title={`from the ${run?.source ?? 'manifest'}`}>live</span>}
        {run?.fixture && <span className="badge">fixture</span>}
        {projectTag(run?.projectSlug) && <span className="badge" title={run?.projectSlug}>{projectTag(run?.projectSlug)}</span>}
        <dl className="stats">
          <div><dt>elapsed</dt><dd className="clock">{fmtDuration(elapsed)}</dd></div>
          <div><dt>tokens</dt><dd>{fmtTokens(run?.totalTokens)}</dd></div>
          <div><dt>agents</dt><dd>{run?.agentCount ?? dash}</dd></div>
          <div><dt>USD</dt><dd title="from docs/factory/RUNS.md">{fmtUsd(run?.runId ? ledger[run.runId]?.cost : undefined)}</dd></div>
        </dl>
        <span className="conn" data-state={conn} title="event stream">{connLabel}</span>
      </header>
      <div className="stage">
        <Canvas graph={graph} files={files} run={run} selectedId={selected} onSelect={setSelected} />
        <RunList runs={runs} ledger={ledger} selectedId={run?.runId} onSelect={pickRun} />
        {selectedNode && (
          <NodePanel node={selectedNode} info={graph.info[selectedNode.id]} run={run} tick={tick} files={files}
            scriptPath={card?.file && !card.file.fixture && card.file.kind !== 'skill' ? card.file.path : undefined}
            onClose={() => setSelected(undefined)} onSaved={() => { void loadFiles().catch(() => {}) }} />
        )}
      </div>
      {live
        ? <footer className="replay following"><span className="muted small">Following the run as it happens ({run?.source}). Replay is available once it finishes.</span></footer>
        : <Replay total={total} state={replay} onChange={onReplay} />}
    </main>
  )
}
