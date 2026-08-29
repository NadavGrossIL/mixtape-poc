import { useEffect, useMemo, useState } from 'react'
import type { AgentDetail, FileRead, GraphNode, NodeRunInfo, RunManifest, WorkflowFile } from '../types'
import { fmtDuration, fmtTokens, shortModel, dash } from './format'
import { diffLines, hunks, changed, type DiffLine } from './diff'

type Tab = 'prompt' | 'knobs' | 'script' | 'result' | 'transcript'
const TABS: [Tab, string][] = [['prompt', 'Prompt'], ['knobs', 'Knobs'], ['script', 'Script'], ['result', 'Last result'], ['transcript', 'Transcript']]
const CONFIG = 'factory.config.json'

/**
 * The node panel. Prompt / Knobs / Script edit the files a node is drawn from
 * (plan §11.5: prompts and knobs in place, the script as text with a diff);
 * Last result / Transcript read the selected run. `tick` bumps when the run's
 * journal moved; a transcript already on screen is reloaded then. `onSaved`
 * asks the page to refetch workflows so the graph re-parses the new text.
 */
export function NodePanel({ node, info, run, tick, files, scriptPath, onClose, onSaved }: {
  node: GraphNode; info?: NodeRunInfo; run?: RunManifest; tick?: number; files: WorkflowFile[]; scriptPath?: string; onClose: () => void; onSaved: () => void
}) {
  const a = info?.agent
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

  // Which file the Prompt tab owns: a skill the prompt invokes (only if it exists on disk), else a named subagent's file.
  const skill = node.skill && files.some((f) => f.kind === 'skill' && f.name === node.skill) ? node.skill : undefined
  const promptFile = skill ? `.claude/skills/${skill}/SKILL.md` : node.agentType ? `.claude/agents/${node.agentType}.md` : undefined

  const rows: [string, string][] = [
    ['phase', node.phase || dash],
    ['kind', node.agentType ? `${node.kind} · @${node.agentType}` : node.kind],
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
      <nav className="tabs" role="tablist">
        {TABS.map(([id, name]) => <button key={id} role="tab" className="tab" data-on={tab === id || undefined} onClick={() => setTab(id)}>{name}</button>)}
      </nav>
      {tab === 'prompt' && (promptFile
        ? <FileEditor key={promptFile} path={promptFile} note={skill ? `This node invokes the \`${skill}\` skill; this is its SKILL.md.` : `This node runs as the \`${node.agentType}\` subagent; this is its definition.`} onSaved={onSaved} />
        : <section>
            <p className="muted small">Literal prompt from the script, read-only{node.prompt ? ' (`${…}` are filled in at run time)' : ''}. Edit it under Script.</p>
            <pre className="mono tall">{node.prompt ?? a?.promptPreview ?? dash}</pre>
          </section>)}
      {tab === 'knobs' && <FileEditor key={CONFIG} path={CONFIG} note="factory.config.json — what a driver passes to the run as args.config (maxGateRounds, base, reviewer) and the claude -p hard stops (maxTurns, maxBudgetUsd, permissionMode). Created on first save." onSaved={onSaved} validate={validJson} />}
      {tab === 'script' && (scriptPath
        ? <FileEditor key={scriptPath} path={scriptPath} note="The graph is drawn from this text; edit it as code." onSaved={onSaved} />
        : <section>
            <p className="muted small">No workflow file on disk for this run{run?.script ? '; the script the engine copied, read-only:' : '.'}</p>
            {run?.script && <pre className="mono tall">{run.script}</pre>}
          </section>)}
      {tab === 'result' && (
        <section>
          <h3>result preview</h3>
          <pre className="mono">{a?.resultPreview ?? dash}</pre>
          {info && info.agents.length > 1 && (
            <><h3>attempts</h3><ul className="muted small">{info.agents.map((x, i) => <li key={i}>attempt {x.attempt ?? i + 1}: {x.state ?? dash} · {fmtDuration(x.durationMs)} · {fmtTokens(x.tokens)} tok</li>)}</ul></>
          )}
          {canLoad && !detail && <p><button className="btn btn-small" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Load full result'}</button></p>}
          {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
          {detail && 'prompt' in detail && <><h3>result</h3><pre className="mono tall">{detail.result || dash}</pre></>}
        </section>
      )}
      {tab === 'transcript' && (
        <section>
          <h3>prompt preview</h3>
          <pre className="mono">{a?.promptPreview ?? dash}</pre>
          {!a && <p className="muted small">This node has not run in the selected run.</p>}
          {a && run?.fixture && <p className="muted small">Fixture run: the transcript is not shipped with the repo.</p>}
          {canLoad && !detail && <p><button className="btn btn-small" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Load transcript'}</button></p>}
          {detail && 'error' in detail && <p className="err small">{detail.error}</p>}
          {detail && 'prompt' in detail && (
            <>
              <h3>full prompt</h3>
              <pre className="mono tall">{detail.prompt || dash}</pre>
              <h3>events ({detail.events.length})</h3>
              <ol className="events">{detail.events.map((e, i) => <li key={i}><span className="muted">{e.ts.slice(11, 19)}</span> <b>{e.kind}{e.name ? ` ${e.name}` : ''}</b> <span className="mono">{e.summary}</span></li>)}</ol>
            </>
          )}
        </section>
      )}
    </aside>
  )
}

const validJson = (s: string) => { try { JSON.parse(s); return undefined } catch (e) { return `not valid JSON: ${e instanceof Error ? e.message : String(e)}` } }

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved' } | { kind: 'error'; text: string } | { kind: 'conflict'; current: string }

/**
 * One file, one textarea, one Save that shows the diff before it writes.
 * `base` is the sha the plugin gave us for what we loaded; a 409 means the
 * disk moved underneath us and Reload is the only way forward — no merge here.
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
  const diff = useMemo(() => (preview && loaded ? hunks(diffLines(loaded.content, text)) : []), [preview, loaded, text])

  const write = async () => {
    if (!loaded) return
    setStatus({ kind: 'busy' })
    try {
      const res = await fetch('/api/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: text, base: loaded.sha }) })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) { setStatus({ kind: 'conflict', current: String(body.current ?? '') }); return }
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
          <DiffView lines={diff} />
          <div className="editor-bar">
            <button className="btn btn-small" data-on onClick={write} disabled={status.kind === 'busy' || !changed(diff)}>{status.kind === 'busy' ? 'Writing…' : 'Write file'}</button>
            <button className="btn btn-small" onClick={() => { setPreview(false); setStatus({ kind: 'idle' }) }}>Cancel</button>
            {!changed(diff) && <span className="muted small">No changes.</span>}
          </div>
        </>
      ) : (
        <>
          <textarea value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); if (status.kind === 'saved') setStatus({ kind: 'idle' }) }} />
          <div className="editor-bar">
            <button className="btn btn-small" onClick={() => setPreview(true)} disabled={!dirty || !!invalid}>Save…</button>
            <button className="btn btn-small" onClick={() => setText(loaded!.content)} disabled={!dirty}>Revert</button>
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

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="diff" aria-label="diff preview">
      {lines.map((l, i) => l.kind === 'skip'
        ? <div key={i} data-kind="skip" data-sign="…">{l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
        : <div key={i} data-kind={l.kind} data-sign={l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}>{l.text || ' '}</div>)}
    </pre>
  )
}
