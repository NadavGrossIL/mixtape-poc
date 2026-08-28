import { useMemo } from 'react'
import type { RunManifest, WorkflowFile } from '../types'
import { graphFor, overlayRun } from '../graph'
import { Thumbnail } from './Thumbnail'
import { fmtDuration, fmtTokens, fmtDate, dash } from './format'

export interface WorkflowCard { name: string; file?: WorkflowFile; lastRun?: RunManifest; runs: number }

/** One card per workflow file, plus one per run whose workflow has no file (its script travels in the manifest). */
export function cardsFrom(files: WorkflowFile[], runs: RunManifest[]): WorkflowCard[] {
  const cards = new Map<string, WorkflowCard>()
  for (const f of files) if (f.kind !== 'skill') cards.set(f.name, { name: f.name, file: f, runs: 0 })
  for (const r of runs) {
    const name = r.workflowName ?? 'unnamed'
    const c = cards.get(name) ?? { name, runs: 0 }
    c.runs++
    if (!c.lastRun) c.lastRun = r // runs arrive newest first
    cards.set(name, c)
  }
  return [...cards.values()]
}

export function Workflows({ cards, skills, onOpen }: { cards: WorkflowCard[]; skills: WorkflowFile[]; onOpen: (name: string) => void }) {
  return (
    <section className="workflows">
      <header className="screen-head">
        <h1>Workflows</h1>
        <p className="muted">Native scripts and Archon YAML in this repo, with each one's last run. Click a card for the canvas.</p>
      </header>
      {cards.length === 0 && <p className="muted">No workflows or runs found yet.</p>}
      <div className="cards">
        {cards.map((c) => <Card key={c.name} card={c} onOpen={() => onOpen(c.name)} />)}
      </div>
      {skills.length > 0 && (
        <div className="skills">
          <span className="muted">Skills the workflows call:</span>
          {skills.map((s) => <span key={s.name} className="chip" title={s.path}>{s.name}</span>)}
        </div>
      )}
    </section>
  )
}

function Card({ card, onOpen }: { card: WorkflowCard; onOpen: () => void }) {
  const graph = useMemo(() => overlayRun(graphFor(card.file, card.lastRun), card.lastRun), [card])
  const run = card.lastRun
  const engine = card.file?.engine ?? 'native'
  return (
    <button className="card" onClick={onOpen}>
      <div className="card-head">
        <span className="card-name">{card.name}</span>
        <span className="badge" data-engine={engine}>{engine}</span>
        {card.file?.kind === 'skill' && <span className="badge">skill</span>}
        {(card.file?.fixture || run?.fixture) && <span className="badge">fixture</span>}
      </div>
      <Thumbnail graph={graph} />
      <div className="card-foot">
        {run ? (
          <>
            <span className="pill" data-status={run.status ?? 'unknown'}>{run.status ?? dash}</span>
            <span>{fmtDate(run.startTime, run.timestamp)}</span>
            <span>{fmtDuration(run.durationMs)}</span>
            <span>{fmtTokens(run.totalTokens)} tok</span>
            <span className="muted">{card.runs} run{card.runs === 1 ? '' : 's'}</span>
          </>
        ) : <span className="muted">no runs yet</span>}
      </div>
    </button>
  )
}
