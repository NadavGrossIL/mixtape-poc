import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { AgentDetail, FileRead, GraphNode, NodeRunInfo, NodeState, RunManifest, WorkflowAgentEntry, WorkflowFile } from '../types'
import { agentsOf, isStalled, purposeOf, stateAt } from '../graph'
import { fmtDuration, fmtTime, fmtTokens, isLive, shortModel, whenAbs, whenRel, dash } from './format'
import { CodeEditor, DiffEditor } from './CodeEditor'
import { PathRow } from './Copy'

type Tab = 'prompt' | 'knobs' | 'script' | 'result' | 'transcript'
const TABS: [Tab, string][] = [['prompt', 'Prompt'], ['knobs', 'Knobs'], ['script', 'Script'], ['result', 'Result'], ['transcript', 'Transcript']]
const CONFIG = 'factory.config.json'

const COPY = {
  notRun: 'This step has not run in the selected run.',
  noResult: 'No result was recorded for this attempt.',
  fixture: 'Fixture run: results and transcripts are not shipped with the repo.',
  live: 'Live — reloads as the transcript grows.',
  literal: 'Literal prompt from the script, read-only. ${…} is filled in at run time. Edit it under Script.',
  noFile: 'No workflow file on disk for this run.',
  noFileCopy: 'No workflow file on disk for this run. The script the engine copied, read-only:',
} as const

// The panel's width is the one per-viewer convenience kept in the browser.
const WIDTH_KEY = 'console.panelWidth'
const WIDTH = { min: 360, max: 720, default: 440 }

/**
 * The node panel: the full label, what the step is for, the facts of its last
 * attempt, then tabs. Prompt / Knobs / Script edit the files a node is drawn
 * from (plan §11.5: prompts and knobs in place, the script as text with a
 * diff); Result / Transcript read the selected run. `tick` bumps when the
 * run's journal moved; a transcript already on screen is reloaded then.
 * `onSaved` asks the page to refetch workflows so the graph re-parses the new
 * text. A flex sibling of the canvas (A10), resizable from its left edge.
 */
export function NodePanel({ node, info, run, tick, files, scriptPath, now = Date.now(), onClose, onSaved }: {
  node: GraphNode; info?: NodeRunInfo; run?: RunManifest; tick?: number; files: WorkflowFile[]; scriptPath?: string; now?: number; onClose: () => void; onSaved: () => void
}) {
  const a = info?.agent // the node's last attempt in this run — the facts follow it
  const [tab, setTab] = useState<Tab>('prompt')
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
  // The Transcript tab loads itself (§4: the transcript was four clicks away —
  // run, node, tab, button — and the button is the one nobody expected to need).
  // The button stays for a load that failed and for a run whose transcript is
  // not on this machine.
  useEffect(() => { if (tab === 'transcript' && canLoad && !detail && !loading) void load() }, [tab, canLoad]) // eslint-disable-line react-hooks/exhaustive-deps
  const { width, grip } = usePanelWidth()

  // Which file the Prompt tab owns: a skill the prompt invokes (only if it exists on disk), else a named subagent's file.
  const skill = node.skill && files.some((f) => f.kind === 'skill' && f.name === node.skill) ? node.skill : undefined
  const promptFile = skill ? `.claude/skills/${skill}/SKILL.md` : node.agentType ? `.claude/agents/${node.agentType}.md` : undefined

  const purpose = purposeOf(node, files)
  const kind = node.agentType ? `${node.kind} · @${node.agentType}` : node.kind
  const attempts = useMemo(() => (info ? attemptRows(info.agents, node, run) : []), [info, node, run])
  const last = attempts[attempts.length - 1]
  const live = isLive(run) && !isStalled(run)
  const ran = (info?.agents.length ?? 0) > 0 // did the step run at all in this run
  const empty = !ran ? COPY.notRun : run?.fixture ? COPY.fixture : undefined
  const transcriptPath = a?.agentId ? run?.paths?.agents?.[a.agentId]?.transcript : undefined
  const loadButton = (label: string) => canLoad && !detail && <button type="button" className="btn btn-small" onClick={load} disabled={loading}>{loading ? 'Loading…' : label}</button>

  const rows: [string, string, string?][] = [
    ['phase', node.phase || dash],
    ['kind', kind],
    ['state', info?.state ?? 'idle'],
    ['outcome', last?.outcome ?? dash],
    ['model', shortModel(a?.model)],
    ['attempt', a ? String(info?.attempt ?? a.attempt ?? 1) : dash],
    ['tokens', fmtTokens(a?.tokens)],
    ['tool calls', a?.toolCalls != null ? String(a.toolCalls) : dash],
    ['duration', fmtDuration(info?.durationMs ?? a?.durationMs)],
    ['started', whenRel(a?.startedAt, now), a?.startedAt != null ? whenAbs(a.startedAt) : undefined],
    ['last tool', a?.lastToolName ?? dash],
    ['agent id', a?.agentId ?? dash],
  ]
  return (
    <aside className="panel" aria-label="node details" style={{ width }}>
      <div className="panel-grip" role="separator" aria-orientation="vertical" aria-label="resize the panel" aria-valuenow={width} aria-valuemin={WIDTH.min} aria-valuemax={WIDTH.max} tabIndex={0} title="drag to resize" {...grip} />
      <div className="panel-body">
        <header className="panel-head">
          <h2 title={node.label}>{node.label}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="close">Close</button>
        </header>
        <p className="panel-sub muted small">{node.phase || dash} › {kind} · {purpose}</p>
        <dl className="facts">{rows.map(([k, v, title]) => <div key={k}><dt>{k}</dt><dd title={title}>{v}</dd></div>)}</dl>
        {a?.error && <section><h3>error</h3><Mono className="err">{a.error}</Mono></section>}
        <nav className="tabs" role="tablist">
          {TABS.map(([id, name]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className="tab" data-on={tab === id || undefined} onClick={() => setTab(id)}>{name}</button>)}
        </nav>
        {tab === 'prompt' && (promptFile
          ? <FileEditor key={promptFile} path={promptFile} note={skill ? `This node invokes the \`${skill}\` skill; this is its SKILL.md.` : `This node runs as the \`${node.agentType}\` subagent; this is its definition.`} onSaved={onSaved} />
          : node.prompt
            ? <section>
                <p className="muted small">{COPY.literal}</p>
                <Mono tall>{node.prompt}</Mono>
              </section>
            : <section>
                {/* A journal-only node: the manifest carries an 80-char preview; the full prompt is in the agent's transcript file (A18). */}
                <h3>prompt preview (journal)</h3>
                <Mono>{a?.promptPreview ?? dash}</Mono>
                {!ran && <p className="muted small">{COPY.notRun}</p>}
                {canLoad && !detail && <p>{loadButton('Load full prompt')}</p>}
                {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
                {detail && 'prompt' in detail && <><h3>full prompt</h3><Mono tall>{detail.prompt || dash}</Mono></>}
              </section>)}
        {tab === 'knobs' && <FileEditor key={CONFIG} path={CONFIG} note="factory.config.json — what a driver passes to the run as args.config (maxGateRounds, base, reviewer) and the claude -p hard stops (maxTurns, maxBudgetUsd, permissionMode). Created on first save." onSaved={onSaved} validate={validJson} />}
        {tab === 'script' && (scriptPath
          ? <FileEditor key={scriptPath} path={scriptPath} note="The graph is drawn from this text; edit it as code." onSaved={onSaved} />
          : <section>
              <p className="muted small">{run?.script ? COPY.noFileCopy : COPY.noFile}</p>
              {run?.script && <Mono tall>{run.script}</Mono>}
            </section>)}
        {tab === 'result' && (
          <section>
            {!ran
              ? <p className="muted small">{COPY.notRun}</p>
              : <>
                  <h3>attempts</h3>
                  <div className="table-wrap">
                    <table className="attempts">
                      <thead><tr><th>attempt</th><th>outcome</th><th>duration</th><th>tokens</th><th>failing step</th></tr></thead>
                      <tbody>
                        {attempts.map((r) => (
                          <tr key={r.key} data-state={r.state}>
                            <td>{r.attempt}</td><td>{r.outcome}</td><td className="clock">{r.duration}</td><td>{r.tokens}</td><td>{r.step}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {run?.fixture
                    ? <p className="muted small">{COPY.fixture}</p>
                    : <>
                        <h3>result preview</h3>
                        {a?.resultPreview ? <Mono>{a.resultPreview}</Mono> : <p className="muted small">{COPY.noResult}</p>}
                        {canLoad && !detail && <p>{loadButton('Load full result')}</p>}
                        {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
                        {detail && 'prompt' in detail && <><h3>result</h3><Mono tall>{detail.result || dash}</Mono></>}
                      </>}
                </>}
          </section>
        )}
        {tab === 'transcript' && (
          <section>
            {empty
              ? <p className="muted small">{empty}</p>
              : <>
                  {/* The file itself, named: the panel shows a reading of it, and the whole thing is one `cat` away. */}
                  {transcriptPath && <PathRow path={transcriptPath} />}
                  <h3>prompt preview</h3>
                  <Mono>{a?.promptPreview ?? dash}</Mono>
                  <p className="load-row">
                    {loadButton('Load transcript')}
                    {loading && !detail && <span className="muted small">Loading…</span>}
                    {live && <span className="muted small">{COPY.live}</span>}
                  </p>
                  {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
                  {detail && 'prompt' in detail && (
                    <>
                      <h3>full prompt</h3>
                      <Mono tall>{detail.prompt || dash}</Mono>
                      <h3>events ({detail.events.length})</h3>
                      <ol className="events">{detail.events.map((e, i) => <li key={i}><span className="muted clock" title={e.ts}>{fmtTime(e.ts)}</span> <b>{e.kind}{e.name ? ` ${e.name}` : ''}</b> <span className="mono">{e.summary}</span></li>)}</ol>
                    </>
                  )}
                </>}
          </section>
        )}
      </div>
    </aside>
  )
}

// --- one file, read-only (the context row's Open) -----------------------------------

/**
 * What the canvas's context row can put in the panel. `file` is one
 * allowlisted repo file (`GET /api/file`: the spec, RUNS.md, a driver result);
 * `diff` is the script the engine froze for this run against the live repo file
 * — the correctness note in §5, since the Script tab edits the live file and
 * the run did not necessarily use it.
 */
export type PanelView =
  | { kind: 'file'; path: string; title: string; note?: string; line?: number }
  | { kind: 'diff'; title: string; note?: string; frozenPath?: string; frozen: string; livePath?: string }

const VIEW_COPY = {
  same: 'The frozen copy is identical to the live file — the script on disk is what this run ran.',
  noLive: 'No workflow file on disk to compare with; this is the frozen copy the engine ran.',
  readOnly: 'Read-only here. This page writes only the definition files (Prompt / Knobs / Script).',
} as const

/**
 * The same aside as the node panel — same width, same grip — showing one file
 * instead of one node. Read-only throughout: `POST /api/file` never accepts
 * these paths (src/allow.ts), and the page says so rather than offering a Save
 * that would 403.
 */
export function FilePanel({ view, onClose }: { view: PanelView; onClose: () => void }) {
  const { width, grip } = usePanelWidth()
  const target = view.kind === 'file' ? view.path : view.livePath
  const [file, setFile] = useState<FileRead | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    setFile(null)
    if (!target) return
    void (async () => {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(target)}`)
        const body = await res.json().catch(() => ({}))
        if (live) setFile(res.ok ? body : { error: `${res.status}: ${body.error ?? 'failed'}` })
      } catch (e) { if (live) setFile({ error: String(e) }) }
    })()
    return () => { live = false }
  }, [target])
  const content = file && 'content' in file ? file.content : undefined
  const shown = view.kind === 'file' ? target : view.frozenPath
  return (
    <aside className="panel" aria-label={view.title} style={{ width }}>
      <div className="panel-grip" role="separator" aria-orientation="vertical" aria-label="resize the panel" aria-valuenow={width} aria-valuemin={WIDTH.min} aria-valuemax={WIDTH.max} tabIndex={0} title="drag to resize" {...grip} />
      <div className="panel-body">
        <header className="panel-head">
          <h2 title={view.title}>{view.title}</h2>
          <button className="btn btn-small" onClick={onClose} aria-label="close">Close</button>
        </header>
        {view.note && <p className="panel-sub muted small">{view.note}</p>}
        {shown && <PathRow path={shown} />}
        <p className="muted small">{VIEW_COPY.readOnly}</p>
        {file && 'error' in file && <p className="err small">{file.error}</p>}
        {view.kind === 'file' && (
          !file ? <p className="muted small">Loading {target}…</p>
            : content != null && (
              <div className="cm-wrap">
                <CodeEditor key={target} path={target!} value={content} readOnly scrollToLine={view.line} label={view.title} />
              </div>
            )
        )}
        {view.kind === 'diff' && (
          !view.livePath ? <><p className="muted small">{VIEW_COPY.noLive}</p><Mono tall>{view.frozen}</Mono></>
            : !file ? <p className="muted small">Loading {view.livePath}…</p>
              : content == null ? <Mono tall>{view.frozen}</Mono>
                : content === view.frozen
                  ? <><p className="muted small">{VIEW_COPY.same}</p><div className="cm-wrap"><CodeEditor key={view.livePath} path={view.livePath} value={content} readOnly label={view.title} /></div></>
                  : <DiffEditor original={view.frozen} modified={content} path={view.livePath} heads={['frozen copy (this run)', 'live repo file']} />
        )}
      </div>
    </aside>
  )
}

// --- attempts ---------------------------------------------------------------------

interface AttemptRow { key: string; attempt: string; outcome: string; duration: string; tokens: string; step: string; state: NodeState }

/**
 * One row per matched agent (IA-SPEC §5): the outcome read from the agent's
 * `resultPreview` — a gate's `ok`, a reviewer's `verdict` with its findings
 * count, apply's `applied`/`skipped`, implement's `status` — else its settled
 * state. The failing step is a gate's `step`; for the last gate of a finished
 * run the manifest's `result.gate.step` wins when it says something.
 */
function attemptRows(agents: WorkflowAgentEntry[], node: GraphNode, run?: RunManifest): AttemptRow[] {
  const isGate = node.kind === 'gate' || /^gate(?::|$)/i.test(node.label)
  const stalled = isStalled(run)
  const finished = !!run && !isLive(run)
  const gates = agentsOf(run).filter((x) => /^gate(?::|$)/i.test(x.label ?? '')).sort((x, y) => (x.startedAt ?? x.queuedAt ?? 0) - (y.startedAt ?? y.queuedAt ?? 0))
  const lastGate = gates[gates.length - 1]
  const gateStep = ((run?.result as { gate?: { step?: unknown } } | null | undefined)?.gate?.step)
  const resultStep = typeof gateStep === 'string' && gateStep.trim() ? gateStep.trim() : undefined
  return agents.map((x, i) => {
    const state = stateAt(x, undefined, stalled)
    const p = parseResult(x.resultPreview)
    let outcome: string
    if (p?.ok != null) outcome = p.ok ? 'passed' : 'failed'
    else if (p?.verdict) outcome = p.findings != null ? `${p.verdict} (${p.findings} finding${p.findings === 1 ? '' : 's'})` : p.verdict
    else if (p?.applied != null) outcome = `applied ${p.applied}, skipped ${p.skipped ?? 0}`
    else if (p?.status) outcome = p.status
    else outcome = state
    let step = dash
    if (isGate) {
      if (finished && lastGate && x === lastGate && resultStep) step = resultStep
      else if (p?.step) step = p.step
    }
    return { key: x.agentId ?? String(i), attempt: String(x.attempt ?? i + 1), outcome, duration: fmtDuration(x.durationMs), tokens: fmtTokens(x.tokens), step, state }
  })
}

interface Parsed { ok?: boolean; status?: string; verdict?: string; findings?: number; step?: string; applied?: number; skipped?: number }
type TextKey = 'status' | 'verdict' | 'step'

/** `resultPreview` as JSON; a clipped preview falls back to picking the known keys out of the text. */
function parseResult(rp?: string): Parsed | undefined {
  if (!rp || !rp.trim()) return undefined
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : undefined)
  try {
    const o = JSON.parse(rp)
    if (o && typeof o === 'object') {
      return { ok: typeof o.ok === 'boolean' ? o.ok : undefined, status: str(o.status), verdict: str(o.verdict), findings: Array.isArray(o.findings) ? o.findings.length : undefined, step: str(o.step), applied: count(o.applied), skipped: count(o.skipped) }
    }
  } catch { /* truncated: fall through to the regex */ }
  // Only the top level: a clipped `{"claims":[{"verdict":…` must not lend its nested verdict to the agent.
  const top = rp.slice(rp.indexOf('{') + 1).replace(/[[{][\s\S]*$/, '')
  const p: Parsed = {}
  const re = /"(status|ok|verdict|step|applied|skipped)":\s*("(?:[^"\\]|\\.)*"|[\w-]+)/g
  for (let m = re.exec(top); m; m = re.exec(top)) {
    const key = m[1] as keyof Parsed
    const raw = m[2]
    const val = raw.startsWith('"') ? raw.slice(1, -1) : raw
    if (key === 'ok') p.ok = val === 'true' ? true : val === 'false' ? false : undefined
    else if (key === 'applied' || key === 'skipped') p[key] = Number.isFinite(Number(val)) ? Number(val) : undefined
    else if (val) p[key as TextKey] = val
  }
  return Object.keys(p).length ? p : undefined
}

// --- width -----------------------------------------------------------------------

const clampWidth = (w: number) => (Number.isFinite(w) ? Math.min(WIDTH.max, Math.max(WIDTH.min, Math.round(w))) : WIDTH.default)
function readWidth(): number {
  try { const v = localStorage.getItem(WIDTH_KEY); return v ? clampWidth(Number(v)) : WIDTH.default } catch { return WIDTH.default }
}
function saveWidth(w: number) { try { localStorage.setItem(WIDTH_KEY, String(w)) } catch { /* private window or storage blocked: the width lives for this page only */ } }

/** The panel's width: dragged from its left edge (pointer events, no library), nudged with ← → when the grip has focus, kept in localStorage. */
function usePanelWidth() {
  const [width, setWidth] = useState(readWidth)
  const drag = useRef<{ right: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const panel = e.currentTarget.parentElement
    if (!panel) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { right: panel.getBoundingClientRect().right }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(clampWidth(drag.current.right - e.clientX)) }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    setWidth((w) => { saveWidth(w); return w })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0 // the panel grows leftwards
    if (!step) return
    e.preventDefault()
    setWidth((w) => { const n = clampWidth(w + step); saveWidth(n); return n })
  }
  return { width, grip: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown } }
}

// --- a scrolling text box with "show all" ------------------------------------------

/** A `.mono` block: 240 px (480 px tall) and scrolling; when the text is longer, a `show all` toggle lets the whole thing through. */
function Mono({ children, tall, className }: { children: ReactNode; tall?: boolean; className?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const [all, setAll] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setOverflows(all || el.scrollHeight > el.clientHeight + 1)
  }, [children, all])
  return (
    <>
      <pre ref={ref} className={`mono${tall ? ' tall' : ''}${className ? ` ${className}` : ''}`} data-all={all || undefined}>{children}</pre>
      {overflows && <button type="button" className="mono-toggle" onClick={() => setAll((v) => !v)}>{all ? 'show less' : 'show all'}</button>}
    </>
  )
}

const validJson = (s: string) => { try { JSON.parse(s); return undefined } catch (e) { return `not valid JSON: ${e instanceof Error ? e.message : String(e)}` } }

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved' } | { kind: 'error'; text: string } | { kind: 'conflict' }

/**
 * One file, one CodeMirror editor, one Save that shows the diff before it
 * writes. `base` is the sha the plugin gave us for what we loaded; a 409 means
 * the disk moved underneath us and Reload is the only way forward — no merge
 * here (the merge view is a preview, both sides read-only).
 */
function FileEditor({ path, note, onSaved, validate }: { path: string; note: string; onSaved: () => void; validate?: (s: string) => string | undefined }) {
  const [file, setFile] = useState<FileRead | { error: string } | null>(null) // null = loading; sha '' = does not exist yet
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const reload = async () => {
    setFile(null); setPreview(false); setStatus({ kind: 'idle' })
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
      if (res.status === 404) { setFile({ path, content: '', sha: '' }); setText(''); return }
      const body = await res.json()
      if (!res.ok) { setFile({ error: `${res.status}: ${body.error ?? 'failed'}` }); return }
      setFile(body); setText(body.content)
    } catch (e) { setFile({ error: String(e) }) }
  }
  useEffect(() => { void reload() }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = file && 'content' in file ? file : undefined
  const dirty = !!loaded && text !== loaded.content
  const invalid = validate?.(text)

  // Save… — the button and the editor's Mod-s, one door: it opens the diff, it never writes.
  const save = () => { if (dirty && !invalid) setPreview(true) }

  const write = async () => {
    if (!loaded) return
    setStatus({ kind: 'busy' })
    try {
      const res = await fetch('/api/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: text, base: loaded.sha }) })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) { setStatus({ kind: 'conflict' }); return } // the server's current sha rides in `body.current`; Reload refetches it, so it is not kept here
      if (!res.ok) { setStatus({ kind: 'error', text: `${res.status}: ${body.error ?? 'write failed'}` }); return }
      setFile({ path, content: text, sha: body.sha }); setPreview(false); setStatus({ kind: 'saved' })
      onSaved()
    } catch (e) { setStatus({ kind: 'error', text: String(e) }) }
  }

  if (!file) return <p className="muted small">Loading {path}…</p>
  if ('error' in file) return <p className="err small">{file.error}</p>
  return (
    <section className="editor">
      <p className="muted small" style={{ margin: 0 }}>{note}</p>
      <div className="editor-bar">
        <span className="path">{path}{file.sha === '' ? ' (new file)' : ''}</span>
      </div>
      {preview ? (
        <>
          <DiffEditor original={loaded!.content} modified={text} path={path} />
          <div className="editor-bar">
            <button className="btn btn-small" data-on onClick={write} disabled={status.kind === 'busy' || !dirty}>{status.kind === 'busy' ? 'Writing…' : 'Write file'}</button>
            <button className="btn btn-small" onClick={() => { setPreview(false); setStatus({ kind: 'idle' }) }}>Cancel</button>
            {!dirty && <span className="muted small">No changes.</span>}
          </div>
        </>
      ) : (
        <>
          <div className="cm-wrap">
            <CodeEditor
              path={path}
              value={text}
              onChange={(v) => { setText(v); setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)) }}
              onSave={save}
            />
          </div>
          <div className="editor-bar">
            <button className="btn btn-small" onClick={save} disabled={!dirty || !!invalid}>Save…</button>
            <button className="btn btn-small" onClick={() => setText(loaded!.content)} disabled={!dirty}>Revert</button>
            <span className="muted small">⌘S diff · ⌘F find</span>
            {invalid && <span className="err small">{invalid}</span>}
            {status.kind === 'saved' && <span className="small" style={{ color: 'var(--accent)' }}>Written.</span>}
          </div>
        </>
      )}
      {status.kind === 'error' && <p className="err small">{status.text}</p>}
      {status.kind === 'conflict' && (
        <p className="err small">Changed on disk — reload to see the current file (your edits stay in this box until you do). <button className="btn btn-small" onClick={reload}>Reload</button></p>
      )}
    </section>
  )
}
