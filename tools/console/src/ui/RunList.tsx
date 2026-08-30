import { useMemo, useState } from 'react'
import type { Ledger, RunManifest, WorkflowFile } from '../types'
import { isStalled } from '../graph'
import type { ConsoleMeta } from './Workflows'
import { runCommand } from './Workflows'
import { RUN_COPY, dash, elapsedOf, fmtClock, fmtDuration, isLive, outcomeOf, projectTag, specOf, specShort, startOf, usdOf, whenAbs, whenRel } from './format'

// The run rail (IA-SPEC §6): runs grouped by workflow — the reader arrives from
// a card, so "the other runs of this workflow" is the question — newest first
// inside a group, one text filter. Each row is two lines: the outcome word and
// the spec, then when / how long / what it cost. While the node panel is open
// the rail folds to a strip of the same dots (A10) so the canvas keeps its width.

const TIP = { ...RUN_COPY, live: 'following the journal' } as const
const PLACEHOLDER = 'filter by spec, outcome or run id'

interface Row {
  run: RunManifest
  id: string
  workflow: string
  word: string
  wordTitle: string
  tone: 'ok' | 'err' | 'warn' | 'muted'
  dot: { status: string; title: string }
  spec: string
  badges: { text: string; title?: string; live?: boolean }[]
  line2: { text: string; title?: string }[]
  start?: number
}

export function RunList({ runs, ledger, files, meta, now, selectedId, workflow, collapsed, onSelect, onExpand }: {
  runs: RunManifest[]; ledger: Ledger; files: WorkflowFile[]; meta: ConsoleMeta; now: number; selectedId?: string; workflow?: string
  collapsed?: boolean; onSelect: (id: string) => void; onExpand: () => void
}) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const rows = useMemo(() => runs.map((r, i) => rowOf(r, i, ledger, now)), [runs, ledger, now])
  const q = filter.trim().toLowerCase()
  const shown = q ? rows.filter((x) => [x.spec, x.word, x.run.runId ?? ''].some((s) => s.toLowerCase().includes(q))) : rows
  // Groups: the current workflow first, then the others by their newest run; newest first inside each.
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const x of shown.slice().sort((a, b) => (b.start ?? 0) - (a.start ?? 0))) {
      const l = m.get(x.workflow)
      if (l) l.push(x); else m.set(x.workflow, [x])
    }
    const list = [...m.entries()].map(([name, list]) => ({ name, rows: list }))
    return list.sort((a, b) => (a.name === workflow ? 0 : 1) - (b.name === workflow ? 0 : 1))
  }, [shown, workflow])
  const isOpen = (name: string) => (q ? true : open[name] ?? name === workflow)

  if (collapsed) {
    return (
      <aside className="rail rail-strip" aria-label="runs">
        <button type="button" className="rail-toggle" onClick={onExpand} title="show the run list">Runs</button>
        <ul className="strip-dots">
          {groups.flatMap((g) => g.rows).map((x) => (
            <li key={x.id}>
              <button type="button" className="strip-dot" data-selected={x.run.runId === selectedId || undefined} title={`${x.workflow} · ${line1Text(x)}\n${x.line2.map((s) => s.text).join(' · ')}\n${x.run.runId ?? dash}`} onClick={() => x.run.runId && onSelect(x.run.runId)}>
                <span className="dot" data-status={x.dot.status} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </aside>
    )
  }
  return (
    <aside className="rail" aria-label="runs">
      <h2>Runs</h2>
      {runs.length === 0
        ? <Empty files={files} meta={meta} />
        : <input className="filter" type="search" value={filter} placeholder={PLACEHOLDER} aria-label={PLACEHOLDER} onChange={(e) => setFilter(e.target.value)} />}
      {runs.length > 0 && shown.length === 0 && <p className="muted small">No run matches “{filter.trim()}”.</p>}
      {groups.map((g) => (
        <section key={g.name} className="run-group" data-open={isOpen(g.name) || undefined}>
          <button type="button" className="group-head" aria-expanded={isOpen(g.name)} onClick={() => setOpen((o) => ({ ...o, [g.name]: !isOpen(g.name) }))}>
            <span className="caret" aria-hidden>{isOpen(g.name) ? '▾' : '▸'}</span>
            <span className="group-name">{g.name}</span>
            <span className="muted">{' · '}{g.rows.length === 1 ? '1 run' : `${g.rows.length} runs`}</span>
          </button>
          {isOpen(g.name) && (
            <ul className="runs">
              {g.rows.map((x) => (
                <li key={x.id}>
                  <button type="button" className="run" data-selected={x.run.runId === selectedId || undefined} title={x.run.runId ?? dash} onClick={() => x.run.runId && onSelect(x.run.runId)}>
                    <span className="dot" data-status={x.dot.status} title={x.dot.title} role="img" aria-label={x.dot.status} />
                    <span className="run-main">
                      <span className="run-1">
                        <span className="outcome-word" data-tone={x.tone} title={x.wordTitle}>{x.word}</span>
                        {' · '}<span className="spec">{x.spec}</span>
                        {x.badges.map((b) => <span key={b.text} className="badge" data-live={b.live || undefined} title={b.title}>{b.text}</span>)}
                      </span>
                      <span className="run-2 muted">
                        {x.line2.map((s, i) => <span key={i}>{i > 0 && ' · '}<span title={s.title}>{s.text}</span></span>)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </aside>
  )
}

function line1Text(x: Row): string {
  return [x.word, x.spec, ...x.badges.map((b) => b.text)].join(' · ')
}

/** One row's texts, computed once per run: the outcome word, the dot and its tooltip, the two lines. */
function rowOf(run: RunManifest, i: number, ledger: Ledger, now: number): Row {
  const oc = outcomeOf(run)
  const stalled = isStalled(run)
  const live = isLive(run) && !stalled
  const killed = run.status === 'killed' || run.status === 'cancelled'
  const start = startOf(run)
  const usd = usdOf(run, ledger)
  const word = stalled ? 'stale' : killed ? 'killed' : oc.word
  const dot = stalled ? { status: 'stale', title: TIP.stale }
    : killed ? { status: 'killed', title: TIP.killed }
    : live ? { status: 'running', title: TIP.live }
    : oc.source === 'result' ? { status: oc.word === 'needs-human' ? 'needs-human' : 'result', title: oc.title }
    : run.status === 'error' || run.status === 'failed' ? { status: 'error', title: oc.title }
    : run.status === 'completed' ? { status: 'result', title: oc.title }
    : { status: 'unknown', title: oc.title }
  const tone: Row['tone'] = oc.source === 'result' ? (oc.word === 'needs-human' ? 'err' : 'ok') : killed || oc.word === 'error' ? 'err' : live || stalled ? 'warn' : 'muted'
  const badges: Row['badges'] = []
  const tag = projectTag(run.projectSlug)
  if (tag) badges.push({ text: tag, title: run.projectSlug })
  if (live) badges.push({ text: 'live', live: true, title: `from the ${run.source ?? 'manifest'}` })
  if (run.fixture) badges.push({ text: 'fixture' })
  const line2: Row['line2'] = live
    ? [{ text: `started ${fmtClock(start)}`, title: whenAbs(start) }, { text: fmtDuration(elapsedOf(run, now)) }, { text: usd.text, title: usd.title }]
    : [{ text: whenRel(start, now), title: whenAbs(start) }, { text: fmtDuration(run.durationMs) }, { text: usd.text, title: usd.title }]
  return {
    run, id: run.runId ?? `run-${i}`, workflow: run.workflowName ?? 'unnamed', word, wordTitle: stalled ? TIP.stale : killed ? TIP.killed : oc.title, tone, dot,
    spec: specShort(specOf(run, ledger)), badges, line2, start,
  }
}

/** Nothing on disk: where the page looked, and the one command that starts a run (no spec to bind to yet — the placeholder). */
function Empty({ files, meta }: { files: WorkflowFile[]; meta: ConsoleMeta }) {
  const dirs = meta.projectDirs?.length ? meta.projectDirs : ['~/.claude/projects/<slug>*']
  const first = files.filter((f) => f.kind === 'script' || f.kind === 'yaml').sort((a, b) => a.name.localeCompare(b.name))[0]
  const command = runCommand(first?.name ?? 'implement-from-spec', undefined, first?.meta)
  return (
    <div className="rail-empty">
      <p>No runs on disk for this repo.</p>
      {dirs.map((d) => <p key={d} className="muted small dir">{d}</p>)}
      <p>Start one: </p>
      <code>{command}</code>
    </div>
  )
}
