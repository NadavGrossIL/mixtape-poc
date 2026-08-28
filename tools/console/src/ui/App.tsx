import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RunManifest, WorkflowFile } from '../types'
import { graphFor, overlayRun, runBounds } from '../graph'
import { Workflows, cardsFrom } from './Workflows'
import { Canvas } from './Canvas'
import { RunList } from './RunList'
import { Replay, type ReplayState } from './Replay'
import { NodePanel } from './NodePanel'
import { fmtDuration, fmtTokens, dash } from './format'

export function App() {
  const [files, setFiles] = useState<WorkflowFile[]>([])
  const [runs, setRuns] = useState<RunManifest[]>([])
  const [meta, setMeta] = useState<{ projectDir?: string; exists?: boolean }>({})
  const [error, setError] = useState<string>()
  const [workflow, setWorkflow] = useState<string>()
  const [runId, setRunId] = useState<string>()
  const [replay, setReplay] = useState<ReplayState>({ playing: false, speed: 20 })
  const [selected, setSelected] = useState<string>()

  useEffect(() => {
    Promise.all([fetch('/api/workflows'), fetch('/api/runs?full=1'), fetch('/api/meta')])
      .then(async ([w, r, m]) => { setFiles(await w.json()); setRuns(await r.json()); setMeta(await m.json()) })
      .catch((e) => setError(String(e)))
  }, [])

  const cards = useMemo(() => cardsFrom(files, runs), [files, runs])
  const skills = useMemo(() => files.filter((f) => f.kind === 'skill'), [files])
  const card = cards.find((c) => c.name === workflow)
  const wfRuns = useMemo(() => runs.filter((r) => (r.workflowName ?? 'unnamed') === workflow), [runs, workflow])
  const run = runs.find((r) => r.runId === runId) ?? wfRuns[0]
  const bounds = useMemo(() => (run ? runBounds(run) : { start: 0, end: 0 }), [run])
  const total = bounds.end - bounds.start
  const t = replay.pos == null ? undefined : bounds.start + replay.pos
  const graph = useMemo(() => overlayRun(graphFor(card?.file, run), run, t), [card, run, t])
  const selectedNode = graph.nodes.find((n) => n.id === selected)

  const open = (name: string) => { setWorkflow(name); setRunId(undefined); setReplay({ playing: false, speed: 20 }); setSelected(undefined) }
  const pickRun = (id: string) => {
    const r = runs.find((x) => x.runId === id)
    if (r && (r.workflowName ?? 'unnamed') !== workflow) setWorkflow(r.workflowName ?? 'unnamed')
    setRunId(id); setReplay((s) => ({ ...s, playing: false, pos: undefined })); setSelected(undefined)
  }
  const onReplay = useCallback((s: ReplayState) => setReplay(s), [])

  if (error) return <main className="shell"><p className="err">Could not reach the console plugin: {error}</p></main>
  if (!workflow) {
    return (
      <main className="shell">
        <Workflows cards={cards} skills={skills} onOpen={open} />
        <p className="muted small foot">Reads {meta.projectDir ?? '~/.claude/projects/<slug>'}{meta.exists === false ? ' (not found — showing fixtures)' : ''}. Local only; nothing here can start a run.</p>
      </main>
    )
  }
  const elapsed = t != null ? t - bounds.start : run?.durationMs
  return (
    <main className="shell canvas-shell">
      <header className="run-head">
        <button className="btn btn-small" onClick={() => setWorkflow(undefined)}>All workflows</button>
        <h1>{workflow}</h1>
        {card?.file && <span className="badge" data-engine={card.file.engine}>{card.file.engine}</span>}
        <span className="pill" data-status={run?.status ?? 'idle'}>{run?.status ?? 'no run'}</span>
        <dl className="stats">
          <div><dt>elapsed</dt><dd className="clock">{fmtDuration(elapsed)}</dd></div>
          <div><dt>tokens</dt><dd>{fmtTokens(run?.totalTokens)}</dd></div>
          <div><dt>agents</dt><dd>{run?.agentCount ?? dash}</dd></div>
          <div><dt>USD</dt><dd>{dash}</dd></div>
        </dl>
        {run?.fixture && <span className="badge">fixture</span>}
      </header>
      <div className="stage">
        <Canvas graph={graph} selectedId={selected} onSelect={setSelected} />
        <RunList runs={runs} selectedId={run?.runId} onSelect={pickRun} />
        {selectedNode && <NodePanel node={selectedNode} info={graph.info[selectedNode.id]} run={run} onClose={() => setSelected(undefined)} />}
      </div>
      <Replay total={total} state={replay} onChange={onReplay} />
    </main>
  )
}
