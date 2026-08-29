import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConsoleEvent, Ledger, RunManifest, WorkflowAgentEntry, WorkflowFile } from '../types'
import { agentsOf, graphFor, isStalled, overlayRun, runBounds } from '../graph'
import { Workflows, cardsFrom, runForms, type ConsoleMeta } from './Workflows'
import { Canvas } from './Canvas'
import { RunList } from './RunList'
import { Replay, type ReplayState } from './Replay'
import { NodePanel } from './NodePanel'
import { dash, fmtClock, fmtDuration, fmtTokens, isLive, lastProgress, nowAt, outcomeOf, projectTag, specOf, startOf, stoppedAt, usdOf, whenAbs, whenRel } from './format'

type Conn = 'connecting' | 'connected' | 'reconnecting'

const COPY = {
  stale: 'nothing moved for 15 min; the session may have ended without a manifest',
  killed: 'stopped by --max-budget-usd / --max-turns',
  runNote: 'The console never starts a run. Paste one of these in a terminal; the driver writes the RUNS.md row.',
} as const

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
  const [railOpen, setRailOpen] = useState(true) // false = the rail is a strip of dots while the panel is open
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
  const stalled = isStalled(run)
  const bounds = useMemo(() => (run ? runBounds(run) : { start: 0, end: 0 }), [run])
  const total = bounds.end - bounds.start
  // A live run follows "now": the scrubber is ignored (and hidden) until it finishes.
  // At or past the end of the replay the manifest's final word is shown, not the
  // clock's — an agent whose end lies after the run's own `durationMs` would
  // otherwise read RUNNING forever (A6).
  const t = live || replay.pos == null || replay.pos >= total ? undefined : bounds.start + replay.pos
  const graph = useMemo(() => overlayRun(graphFor(card?.file, run), run, t), [card, run, t])
  const selectedNode = graph.nodes.find((n) => n.id === selected)

  // The clock ticks every second while something is live (the selected run on the
  // canvas, or any card's last run on the workflows screen); otherwise every 30 s so
  // "2h ago" and "last progress 9m ago" stay honest.
  const ticking = live || (!workflow && cards.some((c) => isLive(c.lastRun)))
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30_000)
    return () => clearInterval(id)
  }, [ticking])

  const open = (name: string) => { setWorkflow(name); setRunId(undefined); setReplay({ playing: false, speed: 20 }); setSelected(undefined); setRailOpen(true) }
  const pickRun = (id: string) => {
    const r = runs.find((x) => x.runId === id)
    if (r && (r.workflowName ?? 'unnamed') !== workflow) setWorkflow(r.workflowName ?? 'unnamed')
    setRunId(id); setReplay((s) => ({ ...s, playing: false, pos: undefined })); setSelected(undefined); setRailOpen(true)
  }
  // Opening a node folds the rail to a strip so the canvas keeps its width (A10); `Runs` on the strip unfolds it.
  const select = useCallback((id?: string) => { setSelected(id); if (id) setRailOpen(false); else setRailOpen(true) }, [])
  const onReplay = useCallback((s: ReplayState) => setReplay(s), [])

  // Esc closes the panel (IA-SPEC §9). Not from inside the editor's textarea — its
  // unsaved text would go with the panel.
  useEffect(() => {
    if (!workflow) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'TEXTAREA') return
      if (selected) { e.preventDefault(); select(undefined) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [workflow, selected, select])

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
  const start = startOf(run)
  // Elapsed: a live run counts from its start; a stale one stops at what the journal last wrote (A5); a scrubbed replay shows the clock.
  const elapsed = live && !stalled && start != null ? Math.max(now - start, run?.durationMs ?? 0) : t != null ? t - bounds.start : run?.durationMs
  const outcome = outcomeOf(run)
  const usd = usdOf(run, ledger)
  const progress = live || stalled ? lastProgress(run, now) : undefined
  const description = card?.file?.meta?.description ?? graph.description
  const tag = projectTag(run?.projectSlug)
  return (
    <main className="shell canvas-shell">
      <header className="run-head">
        <div className="run-head-1">
          <button className="btn btn-small" onClick={() => setWorkflow(undefined)}>All workflows</button>
          <h1>{workflow}</h1>
          {card?.file && <span className="badge" data-engine={card.file.engine}>{card.file.engine}</span>}
          <span className="pill" data-status={run?.status ?? 'idle'} data-outcome={run ? outcome.word : undefined} title={run ? outcome.title : undefined}>{run ? outcome.word : 'no run'}</span>
          {live && !stalled && <span className="badge" data-live title={`from the ${run?.source ?? 'manifest'}`}>live</span>}
          {tag && <span className="badge" title={run?.projectSlug}>{tag}</span>}
          {run?.fixture && <span className="badge">fixture</span>}
          <dl className="stats">
            <div><dt>elapsed</dt><dd className="clock">{fmtDuration(elapsed)}</dd></div>
            <div><dt>tokens</dt><dd>{fmtTokens(run?.totalTokens)}</dd></div>
            <div><dt>agents</dt><dd>{run?.agentCount ?? dash}</dd></div>
            <div><dt>USD</dt><dd title={usd.title}>{run ? usd.text : dash}</dd></div>
            {progress && <div><dt>last progress</dt><dd title={whenAbs(lastProgressAt(run))}>{progress.replace(/^last progress /, '')}</dd></div>}
          </dl>
          <span className="conn" data-state={conn} title={connTitle}>{connLabel}</span>
        </div>
        {description && <p className="run-desc muted">{description}</p>}
        <RunSentence run={run} ledger={ledger} now={now} outcome={outcome} forms={runForms(workflow, card?.file?.meta)} />
      </header>
      <div className="stage">
        <Canvas graph={graph} files={files} run={run} selectedId={selected} onSelect={select} />
        <RunList runs={runs} ledger={ledger} files={files} meta={meta} now={now} selectedId={run?.runId} workflow={workflow}
          collapsed={!!selectedNode && !railOpen} onSelect={pickRun} onExpand={() => setRailOpen(true)} />
        {selectedNode && (
          <NodePanel node={selectedNode} info={graph.info[selectedNode.id]} run={run} tick={tick} files={files} now={now}
            scriptPath={card?.file && !card.file.fixture && card.file.kind !== 'skill' ? card.file.path : undefined}
            onClose={() => select(undefined)} onSaved={() => { void loadFiles().catch(() => {}) }} />
        )}
      </div>
      <Replay total={total} start={bounds.start} state={replay} run={run} phases={graph.phases} now={now} onChange={onReplay} />
    </main>
  )
}

/** The newest timestamp any agent of the run wrote — what `lastProgress` is relative to. */
function lastProgressAt(run?: RunManifest): number | undefined {
  const ts = agentsOf(run).map((a) => a.lastProgressAt).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return run?.lastProgressAt ?? (ts.length ? Math.max(...ts) : undefined)
}

/**
 * Header row 3, the run in one sentence (IA-SPEC §1.3): run id first, then
 * `<outcome> — <reason> · <spec> · <when>` for a finished run, `running <phase> ›
 * <label> for <elapsed> · <spec> · started 13:58` for a live one; no run at all
 * shows how to start one. The reason is `result.reason`; a run that returned
 * none says why the engine stopped instead (killed, stale, the first error agent).
 */
function RunSentence({ run, ledger, now, outcome, forms }: { run?: RunManifest; ledger: Ledger; now: number; outcome: ReturnType<typeof outcomeOf>; forms: ReturnType<typeof runForms> }) {
  if (!run) {
    return (
      <div className="run-sentence run-none">
        <p>No run of this workflow yet.</p>
        <div className="run-it">
          <div className="run-line"><span className="how muted">In a session</span><code>{forms.session}</code></div>
          {forms.headless && <div className="run-line"><span className="how muted">Headless</span><code>{forms.headless}</code></div>}
          <p className="run-note muted">{COPY.runNote}</p>
        </div>
      </div>
    )
  }
  const start = startOf(run)
  const spec = specOf(run, ledger)
  if (isLive(run) && !isStalled(run)) {
    return (
      <p className="run-sentence">
        <code className="run-id">{run.runId ?? dash}</code>{' · '}
        <span data-tone="warn">{nowAt(run, now) ?? 'between steps'}</span>{' · '}
        <span className="spec">{spec}</span>{' · '}
        <span title={whenAbs(start)}>started {fmtClock(start)}</span>
      </p>
    )
  }
  return (
    <p className="run-sentence">
      <code className="run-id">{run.runId ?? dash}</code>{' · '}
      <span className="outcome-word" data-tone={toneOf(run, outcome)} title={outcome.title}>{outcome.word}</span>
      {' — '}<span className="reason">{reasonOf(run)}</span>{' · '}
      <span className="spec">{spec}</span>{' · '}
      <span title={whenAbs(start)}>{whenRel(start, now)}</span>
    </p>
  )
}

/** `result.reason`; without one, why the engine stopped: killed, stale (with the last agent), the first error agent; else `—`. */
function reasonOf(run: RunManifest): string {
  const r = run.result as { reason?: unknown } | null | undefined
  if (r && typeof r === 'object' && typeof r.reason === 'string' && r.reason.trim()) return r.reason
  if (isStalled(run)) {
    const agents = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const last = agents.filter((a) => a.state === 'running' || a.state === 'progress' || a.state === 'queued').pop() ?? agents[agents.length - 1]
    return last ? `${COPY.stale} · last at ${where(last)}` : COPY.stale
  }
  if (run.status === 'killed' || run.status === 'cancelled') {
    const at = stoppedAt(run)
    return at ? `${COPY.killed} · ${at}` : COPY.killed
  }
  return stoppedAt(run) ?? dash
}

function where(a: WorkflowAgentEntry): string {
  const label = a.label ?? (a.index != null ? `agent ${a.index}` : 'agent')
  return a.phaseTitle ? `${a.phaseTitle} › ${label}` : label
}

/** The colour behind the outcome word: red for a stop a human must look at, amber while it moves, accent for a result, muted for the rest. */
function toneOf(run: RunManifest, outcome: ReturnType<typeof outcomeOf>): 'ok' | 'err' | 'warn' | 'muted' {
  if (outcome.source === 'result') return outcome.word === 'needs-human' ? 'err' : 'ok'
  if (outcome.word === 'error' || outcome.word === 'killed') return 'err'
  if (outcome.word === 'running') return 'warn'
  if (isStalled(run)) return 'warn'
  return 'muted'
}
