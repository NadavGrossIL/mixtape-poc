import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConsoleEvent, Ledger, LedgerEntry, RunManifest, WorkflowFile } from '../types'
import { classify, findingsOf, firedOn, graphFor, hasCause, isStalled, overlayRun, runBounds } from '../graph'
import { DriverWarnings, RunCommand, Workflows, cardsFrom, runCommand, type ConsoleMeta } from './Workflows'
import { WorkflowDef } from './WorkflowDef'
import { Canvas } from './Canvas'
import { RunList } from './RunList'
import { Timeline } from './Timeline'
import { NodePanel, FilePanel, type PanelView } from './NodePanel'
import { CopyButton, PathText, copyText } from './Copy'
import { useRemembered } from './remember'
import { CauseTag, Findings } from './Cause'
import { baseName, dash, driverSummary, elapsedOf, fmtClock, fmtDuration, fmtTokens, isLive, lastProgress, lastProgressAt, ledgerLine, nowAt, outcomeOf, prefillRow, projectTag, repoRel, rowValuesOf, specOf, specPath, startOf, stopReason, usdOf, whenAbs, whenRel } from './format'

type Conn = 'connecting' | 'connected' | 'reconnecting'
const LEDGER_PATH = 'docs/factory/RUNS.md'
const CONFIG_PATH = 'factory.config.json'
/** The context line is one line; `more` opens the rest of the artefacts, and the choice is remembered. */
const CTX_KEY = 'console.context'

const COPY = {
  settings: 'factory.config.json — the knobs of the whole line, not of one step: what a driver passes the script as `args.config` (maxGateRounds, base, reviewer, implementModel) and the `claude -p` hard stops (maxTurns, maxBudgetUsd, permissionMode). Created on first save.',
  ctx: 'Where this run lives. Paths under ~/.claude are copy-only — the page cannot serve them; the repo files open here, read-only.',
  addRow: 'A row for this run is on your clipboard, in the table\'s own column order. Paste it at the end of the table and fill the cells only you know (cost is in the driver\'s JSON). This page never writes RUNS.md.',
  specNote: 'The spec this run worked on, read-only.',
  frozenNote: 'The script the engine froze for this run, against the live repo file the Script tab edits.',
  runsNote: 'The ledger. One row per run of the line.',
  skillNote: 'The SKILL.md a workflow node or a /command runs. Saved through the same allowlist as the node panel.',
  agentNote: 'The subagent\'s definition — its frontmatter and prompt. Saved through the same allowlist as the node panel.',
  toDef: 'back to the workflow — the flow in its own words, no run overlaid',
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
  const [view, setView] = useState<PanelView>() // a file open in the panel (the context row's Open) — mutually exclusive with a selected node
  // Flow or Runs: the two things a workflow screen is for. The runs used to sit in a 280 px
  // column beside the canvas, which cost the graph its width and squeezed every run into
  // four wrapped lines; as a tab each gets the whole screen.
  const [tab, setTab] = useState<'flow' | 'runs'>('flow')
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
  // No fallback to the newest run: a workflow with no run selected is the definition
  // view — the flow in its own words, no overlay. (A runId that no longer matches
  // after a refetch degrades to the definition view rather than jumping runs.)
  const run = runId ? runs.find((r) => r.runId === runId) : undefined
  const live = !!run?.live
  const stalled = isStalled(run)
  const bounds = useMemo(() => (run ? runBounds(run) : { start: 0, end: 0 }), [run])
  const total = bounds.end - bounds.start
  // No clock of our own: every node shows the manifest's final word for it (a live
  // run's manifest is simply what has been written so far).
  // A run-only workflow (no file on disk) borrows its newest run for the graph's
  // *shape*; the overlay still follows only the selected run.
  const shapeRun = run ?? (card?.file ? undefined : wfRuns[0])
  const graph = useMemo(() => overlayRun(graphFor(card?.file, shapeRun), run), [card, shapeRun, run])
  const selectedNode = graph.nodes.find((n) => n.id === selected)

  // The clock ticks every second while something is live (the selected run on the
  // canvas, the workflow's newest run behind the definition view's LAST RUN line,
  // or any card's last run on the workflows screen); otherwise every 30 s so
  // "2h ago" and "last progress 9m ago" stay honest.
  const ticking = live || (!!workflow && !runId && wfRuns.some((r) => isLive(r))) || (!workflow && cards.some((c) => isLive(c.lastRun)))
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30_000)
    return () => clearInterval(id)
  }, [ticking])

  const open = (name: string) => { setWorkflow(name); setRunId(undefined); setSelected(undefined); setView(undefined); setTab('flow') }
  const pickRun = (id: string) => {
    const r = runs.find((x) => x.runId === id)
    if (r && (r.workflowName ?? 'unnamed') !== workflow) setWorkflow(r.workflowName ?? 'unnamed')
    setRunId(id); setSelected(undefined); setView(undefined); setTab('flow')
  }
  /** Run view → definition view: drop the run, keep the workflow. */
  const toDefinition = useCallback(() => { setRunId(undefined); setSelected(undefined); setView(undefined); setTab('flow') }, [])
  const goHome = () => { setWorkflow(undefined); setRunId(undefined); setSelected(undefined); setView(undefined); setTab('flow') }
  const select = useCallback((id?: string) => { setSelected(id); setView(undefined) }, [])
  // A file and a node share the one panel: opening either closes the other.
  const openView = useCallback((v: PanelView) => { setView(v); setSelected(undefined) }, [])
  const closeView = useCallback(() => { setView(undefined) }, [])

  // Esc closes the panel (IA-SPEC §9), then walks the run view back to the
  // definition view — and stops there, so a stray Esc never loses the workflow.
  // Not from inside a file editor — its unsaved text would go with the panel,
  // and inside CodeMirror Esc is the search panel's own close key. No workflow
  // gate: the home screen's panel closes on Esc too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'TEXTAREA') return
      if (el?.closest?.('.cm-editor')) return
      if (selected) { e.preventDefault(); select(undefined) }
      else if (view) { e.preventDefault(); closeView() }
      else if (workflow && runId) { e.preventDefault(); toDefinition() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [workflow, runId, selected, view, select, closeView, toDefinition])

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
      <main className="shell home-shell">
        <div className="stage home-stage">
          {/* The card's name and its "Open canvas" open the workflow's definition view; its LAST RUN line names a run, and that run is the one selected.
              A skills-and-agents row opens the file itself, in the same panel the canvas uses. */}
          <Workflows cards={cards} files={files} ledger={ledger} meta={meta} now={now} onOpen={(name, id) => (id ? pickRun(id) : open(name))}
            onOpenDef={(f) => openView({ kind: 'edit', path: f.path, title: `${f.name} — ${f.kind}`, note: f.kind === 'skill' ? COPY.skillNote : COPY.agentNote })} />
          {view && <FilePanel view={view} onClose={closeView} onSaved={() => { void loadFiles().catch(() => {}) }} />}
        </div>
        {/* One dot for the whole footer: the dirs it reads and "local only" are constants of the machine, and they were the widest line on the screen (§5). */}
        <p className="muted small foot">
          <span className="conn" data-state={conn} title={`${connTitle} · reads ${meta.projectDirs?.length ? meta.projectDirs.join(', ') : '~/.claude/projects/<slug>*'}${meta.exists === false ? ' (repo dir not found)' : ''} · local only, never deployed`}>{connLabel}</span>
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
  const entry = run?.runId ? ledger[run.runId] : undefined
  const livePath = card?.file && !card.file.fixture && card.file.kind !== 'skill' ? card.file.path : undefined

  /** Opens RUNS.md at its last row with a row for this run on the clipboard, built from the table's own header. */
  const addLedgerRow = async () => {
    let line: number | undefined
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(LEDGER_PATH)}`)
      const body = await res.json().catch(() => ({}))
      const text: string = res.ok && typeof body.content === 'string' ? body.content : ''
      const rows = text.split('\n').map((l, i) => ({ line: i + 1, text: l.trim() })).filter((r) => r.text.startsWith('|'))
      const header = rows.find((r) => /\|\s*run\s*\|/i.test(r.text))
      line = rows[rows.length - 1]?.line
      if (header) await copyText(prefillRow(header.text.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()), rowValuesOf(run, ledger)))
    } catch { /* the file still opens; only the clipboard is lost */ }
    openView({ kind: 'file', path: LEDGER_PATH, title: 'RUNS.md — add a row', note: COPY.addRow, line })
  }
  return (
    <main className="shell canvas-shell">
      <header className="run-head">
        <div className="run-head-1">
          <button className="btn btn-small" onClick={goHome}>All workflows</button>
          {/* Run view only: the way back to the definition view — the h1 already names the workflow, so the button carries the word, not the name. */}
          {run && <button className="btn btn-small" title={COPY.toDef} onClick={toDefinition}>‹ workflow</button>}
          {/* What the workflow is for is the same sentence on every one of its runs — it belongs to the card on the home screen, not to the run in front of you (§5); `native` is likewise a constant, not a chip. Both ride in the tooltip. */}
          <h1 title={[description, card?.file && `${card.file.path} · ${card.file.engine} engine`].filter(Boolean).join('\n') || undefined}>{workflow}</h1>
          {card?.file && card.file.engine !== 'native' && <span className="badge" data-engine={card.file.engine}>{card.file.engine}</span>}
          {run && <span className="pill" data-status={run.status ?? 'idle'} data-outcome={outcome.word} title={outcome.title}>{outcome.word}</span>}
          {run && engineWord(run, outcome) && <span className="engine-word muted small" title={`manifest.status — the engine's own word for this run, which the outcome does not say`}>engine: {engineWord(run, outcome)}</span>}
          {live && !stalled && <span className="badge" data-live title={`from the ${run?.source ?? 'manifest'}`}>live</span>}
          {tag && <span className="badge" title={run?.projectSlug}>{tag}</span>}
          {run?.fixture && <span className="badge">fixture</span>}
          {run && (
            <dl className="stats">
              <div><dt>elapsed</dt><dd className="clock">{fmtDuration(elapsed)}</dd></div>
              <div><dt>tokens</dt><dd>{fmtTokens(run.totalTokens)}</dd></div>
              <div><dt>agents</dt><dd>{run.agentCount ?? dash}</dd></div>
              {/* A figure, or `—` when the ledger has no row for this run: writing that row is an
                  action, and it belongs in the Context line's RUNS.md slot, not in a stat cell. */}
              <div><dt>USD</dt><dd title={usd.title}>{usd.noRow ? dash : usd.text}</dd></div>
              {progress && <div><dt>last progress</dt><dd title={whenAbs(lastProgressAt(run))}>{progress.replace(/^last progress /, '')}</dd></div>}
            </dl>
          )}
          {/* The knobs are of the line, not of a step: one entry point here, instead of the same file on every node's Knobs tab (§5). */}
          <button type="button" className={run ? 'btn btn-small' : 'btn btn-small push-right'} title={CONFIG_PATH}
            onClick={() => openView({ kind: 'edit', path: CONFIG_PATH, title: 'Settings', note: COPY.settings })}>Settings</button>
          <span className="conn" data-state={conn} title={connTitle}>{connLabel}</span>
        </div>
        {run
          ? (
            <>
              <RunSentence run={run} ledger={ledger} now={now} outcome={outcome}
                command={runCommand(workflow, specPath(specOf(run, ledger)), card?.file?.meta)} />
              <ContextRow run={run} entry={entry} spec={specOf(run, ledger)} livePath={livePath} onOpen={openView} onAddRow={addLedgerRow} />
            </>
          )
          : card && <WorkflowDef card={card} graph={graph} wfRuns={wfRuns} ledger={ledger} now={now} onView={pickRun} onOpen={openView} />}
        {/* The two things this screen is for. The runs sat beside the canvas, which cost the
            graph a third of its width and gave each run four wrapped lines. */}
        <nav className="stage-tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'flow'} data-on={tab === 'flow' || undefined} onClick={() => setTab('flow')}>Flow</button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'runs'} data-on={tab === 'runs' || undefined} onClick={() => setTab('runs')}>
            Runs <span className="muted">{wfRuns.length}</span>
          </button>
        </nav>
      </header>
      <div className="stage">
        {/* The Runs tab gets `wfRuns`, not `runs`: its badge counts this workflow's runs, and
            forty rows under a badge saying 3 is the two of them disagreeing. You change
            workflows from the home screen, so one group — this one — is the whole tab. */}
        {tab === 'flow'
          ? <Canvas graph={graph} files={files} run={run} selectedId={selected} onSelect={select} />
          : <RunList runs={wfRuns} ledger={ledger} files={files} meta={meta} now={now} selectedId={runId} workflow={workflow} onSelect={pickRun} />}
        {selectedNode
          ? <NodePanel node={selectedNode} info={graph.info[selectedNode.id]} run={run} tick={tick} files={files} now={now}
              scriptPath={livePath}
              onClose={() => select(undefined)} onSaved={() => { void loadFiles().catch(() => {}) }} />
          : view ? <FilePanel view={view} onClose={closeView} onSaved={() => { void loadFiles().catch(() => {}) }} /> : null}
      </div>
      {tab === 'flow' && run && <Timeline total={total} start={bounds.start} run={run} phases={graph.phases} now={now} onSelect={select} />}
    </main>
  )
}

/**
 * Header row 3, the run in one sentence (IA-SPEC §1.3): run id first, then
 * `<outcome> — <reason> · <spec> · <when>` for a finished run, `running <phase> ›
 * <label> for <elapsed> · <spec> · started 13:58` for a live one (a workflow
 * with no run selected renders the definition view, never this).
 * The reason is `result.reason`; a run that returned
 * none says why the engine stopped instead (killed, stale, the first error agent).
 * A run whose stop the block below classifies drops the reason here: the block
 * says it better, in the classifier's words, with the evidence under it — and
 * the two of them side by side read as a contradiction ("no result" against
 * "account session limit"), which is the one thing a reason must never do.
 *
 * Under it, the command that runs *this* run again — its own spec, not a
 * placeholder — with the warning a manager needs before pasting it: the driver
 * wipes the worktree. A run that stopped badly carries that command inside the
 * "why it stopped" block instead of under it (§5): the action and the line that
 * performs it are one thought, and two stacked boxes pushed the canvas 330 px
 * down the screen.
 */
function RunSentence({ run, ledger, now, outcome, command }: { run: RunManifest; ledger: Ledger; now: number; outcome: ReturnType<typeof outcomeOf>; command: string }) {
  const start = startOf(run)
  const spec = specOf(run, ledger)
  const why = classify(run)
  const explained = hasCause(why.cause) // the block below carries the reason and its evidence
  const tries = <Attempts run={run} />
  const sentence = isLive(run) && !isStalled(run)
    ? (
      <p className="run-sentence">
        <code className="run-id">{run.runId ?? dash}</code>{' · '}
        <span data-tone="warn">{nowAt(run, now) ?? 'between steps'}</span>{' · '}
        <span className="spec">{spec}</span>{' · '}
        <span title={whenAbs(start)}>started {fmtClock(start)}</span>
        {tries}
      </p>
    )
    : (
      <p className="run-sentence">
        <code className="run-id">{run.runId ?? dash}</code>
        {/* Not the outcome word: the pill above it already carries that, and when a block
            explains the stop it says it a third time. This line is provenance — which run,
            on what, when — and it is sized to be read second. */}
        {/* No `data-tone` here: `.run-sentence .reason` outranks `[data-tone]` on specificity,
            so the tone never painted anyway — and the reason keeping the text colour and the
            weight is what §1.3 asks for. The pill above carries the verdict's colour. */}
        {!explained && <>{' · '}<span className="reason" title={outcome.title}>{reasonOf(run)}</span></>}
        {' · '}<span className="spec">{spec}</span>{' · '}
        <span title={whenAbs(start)}>{whenRel(start, now)}</span>
        {tries}
      </p>
    )
  const rerun = <ReRun command={command} />
  return (
    <>
      {sentence}
      {explained ? <WhyStopped run={run} verdict={why} rerun={rerun} /> : rerun}
    </>
  )
}

/**
 * What the run spent its rounds on: `result.attempts` ({ implement, gate,
 * review }), which the manifest has carried all along and no screen showed —
 * one implement against two says the fix loop ran. Nothing when the script
 * returned no counts.
 */
function Attempts({ run }: { run: RunManifest }) {
  const a = (run.result as { attempts?: Record<string, unknown> } | null | undefined)?.attempts
  if (!a || typeof a !== 'object') return null
  const order = ['implement', 'gate', 'review']
  const keys = [...order.filter((k) => k in a), ...Object.keys(a).filter((k) => !order.includes(k))]
  const parts = keys.filter((k) => typeof a[k] === 'number').map((k) => `${k} ×${a[k]}`)
  if (!parts.length) return null
  return <span className="muted attempts-frag" title="result.attempts — how many rounds each step took"> · attempts {parts.join(' · ')}</span>
}

/** The one command that runs this run again, wherever it is standing, with the two warnings the driver form earns (DriverWarnings): what it wipes, and what it costs the account window. */
function ReRun({ command }: { command: string }) {
  return (
    <RunCommand label="Re-run" command={command} compact>
      <DriverWarnings command={command} />
    </RunCommand>
  )
}

/**
 * Why it stopped (§2, Q2): infra or spec, in one tag, one headline and one
 * action — the single source of truth for the account-window hint the Re-run
 * row used to carry. Under it, what the manifest already knew and never showed:
 * the string the rule fired on, the reviewer's findings when they are about the
 * diff, and the script's own log lines with that string highlighted.
 *
 * Last line: the command that acts on the action, and the logs disclosure
 * beside it (§5). A run that finished, or one still going, renders nothing —
 * its Re-run row stands on its own instead.
 */
function WhyStopped({ run, verdict: v, rerun }: { run: RunManifest; verdict: ReturnType<typeof classify>; rerun: ReactNode }) {
  if (!hasCause(v.cause)) return null
  const findings = findingsOf(run)
  const logs = run.logs ?? []
  return (
    <section className="why" data-cause={v.cause} aria-label="why it stopped">
      <p className="why-line">
        <CauseTag verdict={v} />
        {v.at && <span className="muted"> · at {v.at}</span>}
      </p>
      {/* What to do, then what is wrong with the diff if anything, then the command that does
          it — the button used to sit under the evidence, two blocks below the sentence that
          told you to press it. The proof (the raw string, the log) is reference and goes last. */}
      <p className="why-action">{v.action}</p>
      <Findings findings={findings} />
      <div className="why-do">{rerun}</div>
      {/* A div, not a p: the logs disclosure is a `<details>`, which the HTML parser is not
          allowed to nest in a paragraph — React logs a validateDOMNesting warning on every
          render of a stopped run, and the browser would close the `p` before it. */}
      {(v.evidence || logs.length > 0) && (
        <div className="why-proof">
          {v.evidence && <code className="why-evidence" title={v.evidence}>{v.evidence}</code>}
          {logs.length > 0 && (
            <details className="why-logs">
              <summary>what the script logged ({logs.length} {logs.length === 1 ? 'line' : 'lines'})</summary>
              <ol className="mono tall">
                {logs.map((l, i) => <li key={i} data-fired={firedOn(l, v) || undefined}>{l}</li>)}
              </ol>
            </details>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Where the context lives (§4, Q3). Every artefact of the run on screen, named
 * once: the spec it worked on, the branch and worktree it ran in (`cwd` /
 * `gitBranch` off the first transcript line, which the loader used to drop),
 * the run id, the manifest, the journal, the frozen script the engine actually
 * ran, the ledger row, and the driver's saved JSON / diff / PR body. Repo files
 * open in the panel read-only (`GET /api/file`, the read allowlist in
 * src/allow.ts); the `~/.claude` ones cannot be served, so they are Copy only —
 * which is what a terminal wants anyway. Visible without selecting a node: this
 * is about the run, not about a step.
 *
 * One line by default (§5): the three a manager reaches for — the spec, the
 * branch, the ledger row — and `more`, which unfolds the rest and is remembered.
 * As a grid of nine rows this block alone was 120 px of the 330 the header had
 * taken from the canvas.
 */
function ContextRow({ run, entry, spec, livePath, onOpen, onAddRow }: {
  run: RunManifest; entry?: LedgerEntry; spec: string; livePath?: string; onOpen: (v: PanelView) => void; onAddRow: () => Promise<void>
}) {
  const [open, setOpen] = useRemembered(CTX_KEY, false)
  const p = run.paths
  const specFile = specPath(spec)
  const df = entry?.driverFiles
  // The driver's saved files, labelled by what they answer, not by their extension:
  // the result carries its extract as the value (`$0.84 · 5 turns · stopped: completed`)
  // — that summary is what a reader came for; the raw JSON stays behind Open.
  const drivers: { label: string; file: string; text?: string }[] = [
    ...(df?.json ?? []).map((f) => ({ label: 'driver result', file: f, text: driverSummary(entry?.driverExtracts?.[f]) })),
    ...(df?.diff ?? []).map((f) => ({ label: 'diff it produced', file: f })),
    ...(df?.pr ?? []).map((f) => ({ label: 'PR body', file: f })),
  ]
  const row = ledgerLine(entry)
  const openFile = (path: string, title: string, note?: string, line?: number) => () => onOpen({ kind: 'file', path, title, note, line })
  const ledgerAt = entry ? `RUNS.md${entry.line ? `:${entry.line}` : ''}` : undefined
  return (
    <section className="ctx" aria-label="where this run lives">
      <p className="ctx-1">
        <span className="ctx-head">Context</span>
        {specFile
          ? <span className="ctx-one"><span className="ctx-val" title={specFile}>{baseName(specFile)}</span>
              <button type="button" className="btn btn-small" onClick={openFile(specFile, baseName(specFile), COPY.specNote)}>Open</button></span>
          : spec !== dash && <span className="ctx-one"><span className="ctx-val">{spec}</span></span>}
        {run.git?.branch && <span className="ctx-one"><span className="muted">branch</span>
          <span className="ctx-val" title={run.git.branch}>{run.git.branch}</span><CopyButton text={run.git.branch} label="copy" /></span>}
        {/* The ledger row, and — when there is none — the one place that writes one. It used
            to sit in the USD stat cell, where a button stood in for a figure (§4). */}
        <span className="ctx-one">
          <span className="muted">RUNS.md</span>
          {ledgerAt
            ? <><span className="ctx-val" title={row ?? LEDGER_PATH}>{entry!.line ? `row ${entry!.line}` : 'row'}</span>
                <button type="button" className="btn btn-small" onClick={openFile(LEDGER_PATH, ledgerAt, COPY.runsNote, entry!.line)}>Open</button></>
            : <button type="button" className="btn btn-small" title="open RUNS.md and copy a row for this run" onClick={() => { void onAddRow() }}>add row</button>}
        </span>
        <button type="button" className="link ctx-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'less ▴' : 'more ▾'}
        </button>
      </p>
      {/* Unfolded, the rest of the artefacts are a box of their own: 180 px, scrolling inside.
          Grown into the header they took a third of the canvas, and the canvas is the page.
          Two clusters: what the run produced (openable, labelled by what it answers) and
          where its files live (copy-only paths, bound for a terminal). */}
      {open && (
        <div className="ctx-open">
          <h4 className="ctx-h">artefacts</h4>
          <div className="ctx-grid">
            <Item label="frozen script" value={p?.scriptCopy} title={`${p?.scriptCopy} — the copy the engine ran, not the live repo file`}>
              {run.script && <button type="button" className="btn btn-small" title="diff the frozen copy against the live repo file"
                onClick={() => onOpen({ kind: 'diff', title: 'Frozen script vs live', note: COPY.frozenNote, frozenPath: p?.scriptCopy, frozen: run.script!, livePath })}>Diff</button>}
              {p?.scriptCopy && <CopyButton text={p.scriptCopy} label="copy path" />}
            </Item>
            {drivers.map(({ label, file, text }) => {
              const rel = repoRel(file)
              return (
                <Item key={file} label={label} value={file} text={text}>
                  {rel && <button type="button" className="btn btn-small" onClick={openFile(rel, baseName(file))}>Open</button>}
                  <CopyButton text={file} label="copy path" />
                </Item>
              )
            })}
          </div>
          <h4 className="ctx-h">paths</h4>
          <div className="ctx-grid">
            <Item label="worktree" value={run.git?.cwd}><CopyButton text={run.git!.cwd!} label="copy" /></Item>
            <Item label="run id" value={run.runId}><CopyButton text={run.runId!} label="copy" /></Item>
            <Item label="manifest" value={p?.manifest}><CopyButton text={p!.manifest!} label="copy path" /></Item>
            <Item label="journal" value={p?.journal}><CopyButton text={p!.journal!} label="copy path" /></Item>
            <Item label="spec" value={specFile}><CopyButton text={specFile!} label="copy path" /></Item>
          </div>
          {/* The ledger's own words about this run. Two lines here, the whole note in the
              tooltip and one Open away in RUNS.md itself: in full it ran four lines of prose
              and the 180 px box cut it mid-word anyway, so nothing was gained by the height. */}
          {row && <p className="ctx-note" title={row}><span className="muted">RUNS.md: </span>{row}</p>}
          <p className="ctx-foot muted small">{COPY.ctx}</p>
        </div>
      )}
    </section>
  )
}

/**
 * One context line: what it is, the value, what you can do with it. The value is
 * the path, truncated from the left with the whole thing in the tooltip — unless
 * `text` says it in words (the driver result's extract), and then the path is
 * what moves into the tooltip.
 */
function Item({ label, value, title, text, children }: { label: string; value?: string; title?: string; text?: string; children?: ReactNode }) {
  if (!value) return null
  return (
    <div className="ctx-row">
      <span className="ctx-label">{label}</span>
      {text
        ? <span className="ctx-val ctx-sum" title={title ?? value}>{text}</span>
        : <PathText path={value} className="ctx-val" title={title} />}
      <span className="ctx-acts">{children}</span>
    </div>
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
