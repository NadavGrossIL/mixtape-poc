import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConsoleEvent, Ledger, RunManifest, WorkflowFile } from '../types'
import { classify, findingsOf, firedOn, graphFor, isStalled, overlayRun, runBounds } from '../graph'
import { RunCommand, Workflows, cardsFrom, isDriverCommand, runCommand, type ConsoleMeta } from './Workflows'
import { Canvas } from './Canvas'
import { RunList } from './RunList'
import { Timeline } from './Timeline'
import { NodePanel } from './NodePanel'
import { CAUSE_TAG, dash, elapsedOf, fmtClock, fmtDuration, fmtTokens, isLive, lastProgress, lastProgressAt, nowAt, outcomeOf, projectTag, specOf, specPath, startOf, stopReason, toneOf, usdOf, whenAbs, whenRel } from './format'

type Conn = 'connecting' | 'connected' | 'reconnecting'

const COPY = {
  runNote: 'The console never starts a run — paste this in a terminal. The driver writes the RUNS.md row.',
  /** The driver removes and re-adds `../mixtape-poc.wt` before it starts (`scripts/factory-run.sh`, "worktree:"), so anything uncommitted in there goes with it. */
  wipes: 're-running wipes the worktree',
  wipesTitle: 'scripts/factory-run.sh removes ../mixtape-poc.wt and cuts it again from origin/main — uncommitted work in that worktree is gone',
} as const

export function App() {
  const [files, setFiles] = useState<WorkflowFile[]>([])
  const [runs, setRuns] = useState<RunManifest[]>([])
  const [ledger, setLedger] = useState<Ledger>({})
  const [meta, setMeta] = useState<ConsoleMeta>({})
  const [error, setError] = useState<string>()
  const [workflow, setWorkflow] = useState<string>()
  const [runId, setRunId] = useState<string>()
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
  // No clock of our own: every node shows the manifest's final word for it (a live
  // run's manifest is simply what has been written so far).
  const graph = useMemo(() => overlayRun(graphFor(card?.file, run), run), [card, run])
  const selectedNode = graph.nodes.find((n) => n.id === selected)

  // The clock ticks every second while something is live (the selected run on the
  // canvas, or any card's last run on the workflows screen); otherwise every 30 s so
  // "2h ago" and "last progress 9m ago" stay honest.
  const ticking = live || (!workflow && cards.some((c) => isLive(c.lastRun)))
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30_000)
    return () => clearInterval(id)
  }, [ticking])

  const open = (name: string) => { setWorkflow(name); setRunId(undefined); setSelected(undefined); setRailOpen(true) }
  const pickRun = (id: string) => {
    const r = runs.find((x) => x.runId === id)
    if (r && (r.workflowName ?? 'unnamed') !== workflow) setWorkflow(r.workflowName ?? 'unnamed')
    setRunId(id); setSelected(undefined); setRailOpen(true)
  }
  // Opening a node folds the rail to a strip so the canvas keeps its width (A10); `Runs` on the strip unfolds it.
  const select = useCallback((id?: string) => { setSelected(id); if (id) setRailOpen(false); else setRailOpen(true) }, [])

  // Esc closes the panel (IA-SPEC §9). Not from inside a file editor — its unsaved
  // text would go with the panel, and inside CodeMirror Esc is the search panel's
  // own close key.
  useEffect(() => {
    if (!workflow) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'TEXTAREA') return
      if (el?.closest?.('.cm-editor')) return
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
        {/* The card's name and its "Open canvas" open the workflow at its newest run; its LAST RUN line names a run, and that run is the one selected. */}
        <Workflows cards={cards} files={files} ledger={ledger} meta={meta} now={now} onOpen={(name, id) => (id ? pickRun(id) : open(name))} />
        <p className="muted small foot">
          <span className="conn" data-state={conn} title={connTitle}>{connLabel}</span>
          {' · '}reads {meta.projectDirs?.length ? meta.projectDirs.join(', ') : '~/.claude/projects/<slug>*'}{meta.exists === false ? ' (repo dir not found)' : ''}
          {' · '}local only
        </p>
      </main>
    )
  }
  // Elapsed: a live run counts from its start, a stale one stops at what the journal last wrote (A5).
  const elapsed = elapsedOf(run, now)
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
          {engineWord(run, outcome) && <span className="engine-word muted small" title={`manifest.status — the engine's own word for this run, which the outcome does not say`}>engine: {engineWord(run, outcome)}</span>}
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
        <RunSentence run={run} ledger={ledger} now={now} outcome={outcome}
          command={runCommand(workflow, specPath(specOf(run, ledger)), card?.file?.meta)} />
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
      <Timeline total={total} start={bounds.start} run={run} phases={graph.phases} now={now} onSelect={select} />
    </main>
  )
}

/**
 * Header row 3, the run in one sentence (IA-SPEC §1.3): run id first, then
 * `<outcome> — <reason> · <spec> · <when>` for a finished run, `running <phase> ›
 * <label> for <elapsed> · <spec> · started 13:58` for a live one; no run at all
 * shows how to start one. The reason is `result.reason`; a run that returned
 * none says why the engine stopped instead (killed, stale, the first error agent).
 *
 * Under it, the command that runs *this* run again — its own spec, not a
 * placeholder — with the two things a manager needs before pasting it: the
 * driver wipes the worktree, and the account window may still be shut. The
 * sentence already wraps for a long reason, so the command is its own row
 * rather than a tail that would push past 1400 px.
 */
function RunSentence({ run, ledger, now, outcome, command }: { run?: RunManifest; ledger: Ledger; now: number; outcome: ReturnType<typeof outcomeOf>; command: string }) {
  if (!run) {
    return (
      <div className="run-sentence run-none">
        <p>No run of this workflow yet.</p>
        <RunCommand label="Run" command={command} note={COPY.runNote} />
      </div>
    )
  }
  const start = startOf(run)
  const spec = specOf(run, ledger)
  const sentence = isLive(run) && !isStalled(run)
    ? (
      <p className="run-sentence">
        <code className="run-id">{run.runId ?? dash}</code>{' · '}
        <span data-tone="warn">{nowAt(run, now) ?? 'between steps'}</span>{' · '}
        <span className="spec">{spec}</span>{' · '}
        <span title={whenAbs(start)}>started {fmtClock(start)}</span>
      </p>
    )
    : (
      <p className="run-sentence">
        <code className="run-id">{run.runId ?? dash}</code>{' · '}
        <span className="outcome-word" data-tone={toneOf(run, outcome)} title={outcome.title}>{outcome.word}</span>
        {' — '}<span className="reason">{reasonOf(run)}</span>{' · '}
        <span className="spec">{spec}</span>{' · '}
        <span title={whenAbs(start)}>{whenRel(start, now)}</span>
      </p>
    )
  return (
    <>
      {sentence}
      <WhyStopped run={run} />
      <RunCommand label="Re-run" command={command} compact>
        {isDriverCommand(command) && <span className="run-warn" title={COPY.wipesTitle}>{COPY.wipes}</span>}
      </RunCommand>
    </>
  )
}

/**
 * Why it stopped (§2, Q2): infra or spec, in one tag, one headline and one
 * action — the single source of truth for the account-window hint the Re-run
 * row used to carry. Under it, what the manifest already knew and never showed:
 * the string the rule fired on, the reviewer's findings when they are about the
 * diff, and the script's own log lines with that string highlighted.
 * A run that finished, or one still going, renders nothing.
 */
function WhyStopped({ run }: { run: RunManifest }) {
  const v = classify(run)
  const tag = CAUSE_TAG[v.cause]
  if (!tag) return null
  const findings = findingsOf(run)
  const logs = run.logs ?? []
  return (
    <section className="why" data-cause={v.cause} aria-label="why it stopped">
      <p className="why-line">
        <span className="why-tag">{tag.text}</span>
        <span className="why-head" title={tag.title}>{v.headline}</span>
        {v.at && <span className="muted"> · at {v.at}</span>}
      </p>
      <p className="why-action">{v.action}</p>
      {v.evidence && <code className="why-evidence">{v.evidence}</code>}
      {findings.length > 0 && (
        <ul className="why-findings">
          {findings.map((f, i) => (
            <li key={i}>
              <span className="why-finding-title">{f.title ?? dash}</span>
              {f.why ? <> — {f.why}</> : null}
              {f.file ? <span className="muted"> · <code>{f.file}{f.line ? `:${f.line}` : ''}</code></span> : null}
            </li>
          ))}
        </ul>
      )}
      {logs.length > 0 && (
        <details className="why-logs">
          <summary>what the script logged ({logs.length} {logs.length === 1 ? 'line' : 'lines'})</summary>
          <ol className="mono tall">
            {logs.map((l, i) => <li key={i} data-fired={firedOn(l, v) || undefined}>{l}</li>)}
          </ol>
        </details>
      )}
    </section>
  )
}

/**
 * The engine's own status word, shown only when the outcome pill does not
 * already say it: a run that returned `needs-human` while the engine says
 * `killed` reads as a workflow decision until you see the second word. A
 * `completed` engine behind a script's own outcome is the normal case and
 * stays off the screen.
 */
function engineWord(run: RunManifest | undefined, outcome: ReturnType<typeof outcomeOf>): string | undefined {
  const s = run?.status
  if (!s || s === 'completed' || s === outcome.word) return undefined
  return s
}

/** `result.reason`; without one, why the engine stopped (`stopReason`: stale, killed, the first error agent); else `—`. */
function reasonOf(run: RunManifest): string {
  const r = run.result as { reason?: unknown } | null | undefined
  if (r && typeof r === 'object' && typeof r.reason === 'string' && r.reason.trim()) return r.reason
  return stopReason(run) ?? dash
}
