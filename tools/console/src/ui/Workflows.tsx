import { useEffect, useMemo, useState } from 'react'
import type { Ledger, NodeState, RunManifest, WorkflowAgentEntry, WorkflowFile, WorkflowMeta } from '../types'
import { agentsOf, firstSentence, graphFor, isStalled, overlayRun, stateAt } from '../graph'
import { dash, fmtDuration, isLive, nowAt, outcomeOf, projectTag, specOf, startOf, stoppedAt, usdOf, whenAbs, whenRel } from './format'

// The "all workflows" screen: one card per workflow that says what it does,
// how its last run ended (one line), where each phase got to (the strip),
// and how to start one — from a terminal, never from here. Under the cards,
// the skills and agents the workflows are made of, each with who calls it.
// Copy is docs/factory IA-SPEC §1–§3 and §8, pasted verbatim.

export interface WorkflowCard { name: string; file?: WorkflowFile; lastRun?: RunManifest; runs: number }
/** `GET /api/meta`. */
export interface ConsoleMeta { slug?: string; projectsBase?: string; projectDirs?: string[]; exists?: boolean }

const COPY = {
  subtitle: "The factory's saved workflows and their runs on this machine. Nothing here starts a run.",
  runNote: 'The console never starts a run. Paste one of these in a terminal; the driver writes the RUNS.md row.',
  skillsSub: 'The files the workflows are made of. Each line says who calls it.',
  stale: 'stale — nothing moved for 15 min; the session may have ended without a manifest',
  killed: 'stopped by --max-budget-usd / --max-turns',
  definitionDirs: '.claude/workflows/, .claude/skills/, .archon/workflows/',
} as const

/** How to start each workflow, keyed by name; anything else gets the slash form only. */
const RUN_FORMS: Record<string, { session: string; headless?: string }> = {
  'implement-from-spec': { session: '/implement-from-spec specs/NNNN-slug.md', headless: 'scripts/factory-run.sh specs/NNNN-slug.md' },
  'review-spec': { session: '/review-spec specs/NNNN-slug.md', headless: "claude -p '/review-spec specs/NNNN-slug.md' --max-turns 40 --max-budget-usd 3 --output-format json" },
}
export function runForms(name: string, meta?: WorkflowMeta): { session: string; headless?: string } {
  return RUN_FORMS[name] ?? { session: `/${name} ${meta?.argumentHint ?? 'specs/NNNN-slug.md'}` }
}

/** One card per workflow file, plus one per run whose workflow has no file (its script travels in the manifest). Files first, alphabetical; run-only cards after. */
export function cardsFrom(files: WorkflowFile[], runs: RunManifest[]): WorkflowCard[] {
  const cards = new Map<string, WorkflowCard>()
  for (const f of files) if (f.kind === 'script' || f.kind === 'yaml') cards.set(f.name, { name: f.name, file: f, runs: 0 })
  for (const r of runs) {
    const name = r.workflowName ?? 'unnamed'
    const c = cards.get(name) ?? { name, runs: 0 }
    c.runs++
    if (!c.lastRun) c.lastRun = r // runs arrive newest first
    cards.set(name, c)
  }
  return [...cards.values()].sort((a, b) => (a.file ? 0 : 1) - (b.file ? 0 : 1) || a.name.localeCompare(b.name))
}

export function Workflows({ cards, files, ledger, meta, now, onOpen }: {
  cards: WorkflowCard[]; files: WorkflowFile[]; ledger: Ledger; meta: ConsoleMeta; now: number; onOpen: (name: string) => void
}) {
  const fixtureRun = cards.find((c) => c.file?.fixture || c.lastRun?.fixture)?.lastRun
  const fixture = cards.some((c) => c.file?.fixture || c.lastRun?.fixture)
  const rows = useMemo(() => files.filter((f) => f.kind === 'skill' || f.kind === 'agent'), [files])
  return (
    <section className="workflows">
      <header className="screen-head">
        <h1>Workflows</h1>
        <p className="muted">{COPY.subtitle}</p>
      </header>
      {fixture && (
        <p className="banner" role="status">
          Fixture data — no run of this repo was found under {meta.projectsBase ?? '~/.claude/projects'}. Everything below is a redacted sample ({fixtureRun?.runId ?? 'wf_d62c68a5-d0a'}, {fixtureRun?.agentCount ?? 26} agents). Real runs appear here on their own once one is started from a terminal.
        </p>
      )}
      {cards.length === 0
        ? <Empty meta={meta} />
        : <div className="cards">{cards.map((c) => <Card key={c.name} card={c} ledger={ledger} now={now} onOpen={() => onOpen(c.name)} />)}</div>}
      {rows.length > 0 && <SkillsTable rows={rows} files={files} cards={cards} />}
    </section>
  )
}

// --- the card -------------------------------------------------------------------

function Card({ card, ledger, now, onOpen }: { card: WorkflowCard; ledger: Ledger; now: number; onOpen: () => void }) {
  const run = card.lastRun
  const graph = useMemo(() => overlayRun(graphFor(card.file, run), run), [card, run])
  const meta = card.file?.meta
  const engine = card.file?.engine ?? 'native'
  const description = meta?.description ?? graph.description
  const whenToUse = meta?.whenToUse ?? graph.whenToUse
  const forms = runForms(card.name, meta)
  const outcome = outcomeOf(run)
  const tag = projectTag(run?.projectSlug)
  return (
    <div className="card">
      <div className="card-head">
        <button type="button" className="card-name" onClick={onOpen} title={card.file?.path}>{card.name}</button>
        <span className="badge" data-engine={engine}>{engine}</span>
        {(card.file?.fixture || run?.fixture) && <span className="badge">fixture</span>}
      </div>
      <p className="card-desc">{description || dash}</p>
      {whenToUse && <p className="card-when"><span className="muted">Use when: </span>{whenToUse}</p>}

      <h3>Last run</h3>
      {run ? <LastRun run={run} ledger={ledger} now={now} outcome={outcome} tag={tag} /> : <p className="last-run muted">no runs yet</p>}
      <PhaseStrip graph={graph} run={run} now={now} outcome={run ? outcome : undefined} />

      <h3>Run it</h3>
      <div className="run-it">
        <RunLine how="In a session" text={forms.session} />
        {forms.headless && <RunLine how="Headless" text={forms.headless} />}
        <p className="run-note muted">{COPY.runNote}</p>
      </div>

      <div className="card-foot">
        <span className="muted">{card.runs === 0 ? 'no runs yet' : card.runs === 1 ? '1 run' : `${card.runs} runs`}</span>
        <button type="button" className="link" onClick={onOpen}>Open canvas →</button>
      </div>
    </div>
  )
}

function LastRun({ run, ledger, now, outcome, tag }: { run: RunManifest; ledger: Ledger; now: number; outcome: ReturnType<typeof outcomeOf>; tag?: string }) {
  const start = startOf(run)
  const live = isLive(run) && !isStalled(run)
  const duration = live && start != null ? fmtDuration(Math.max(now - start, run.durationMs ?? 0)) : fmtDuration(run.durationMs)
  const usd = usdOf(run, ledger)
  return (
    <>
      <p className="last-run">
        <span className="outcome-word" data-tone={toneOf(run, outcome)} title={outcome.title}>{outcome.word}</span>
        {' · '}<span className="spec">{specOf(run, ledger)}</span>
        {' · '}<span title={whenAbs(start)}>{whenRel(start, now)}</span>
        {' · '}<span className="clock">{duration}</span>
        {' · '}<span title={usd.title}>{usd.text}</span>
        {tag && <> <span className="badge" title={run.projectSlug}>{tag}</span></>}
      </p>
      {lineTwo(run, outcome, now) && <p className="last-run-2 muted">{lineTwo(run, outcome, now)}</p>}
    </>
  )
}

/** Line 2 of the last-run block — the first that applies: live, stale, killed, an error agent, a `needs-human` reason; else nothing. */
function lineTwo(run: RunManifest, outcome: ReturnType<typeof outcomeOf>, now: number): string | undefined {
  if (isStalled(run)) {
    const agents = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const last = agents.filter((a) => a.state === 'running' || a.state === 'progress' || a.state === 'queued').pop() ?? agents[agents.length - 1]
    return last ? `${COPY.stale} · last at ${where(last)}` : COPY.stale
  }
  if (isLive(run)) return nowAt(run, now)
  if (run.status === 'killed' || run.status === 'cancelled') {
    const at = stoppedAt(run)
    return at ? `${COPY.killed} · ${at}` : COPY.killed
  }
  const at = stoppedAt(run)
  if (at) return at
  if (outcome.source === 'result' && outcome.word === 'needs-human') {
    const reason = (run.result as { reason?: unknown } | null)?.reason
    if (typeof reason === 'string' && reason) return reason
  }
  return undefined
}

function where(a: WorkflowAgentEntry): string {
  const label = a.label ?? (a.index != null ? `agent ${a.index}` : 'agent')
  return a.phaseTitle ? `${a.phaseTitle} › ${label}` : label
}

/** The colour behind the outcome word: red for a stop a human must look at, amber while it moves, accent for a result, muted for the rest. */
function toneOf(run: RunManifest | undefined, outcome: ReturnType<typeof outcomeOf>): 'ok' | 'err' | 'warn' | 'muted' {
  if (!run) return 'muted'
  if (outcome.source === 'result') return outcome.word === 'needs-human' ? 'err' : 'ok'
  if (outcome.word === 'error' || outcome.word === 'killed') return 'err'
  if (outcome.word === 'running') return 'warn'
  return 'muted'
}

// --- the phase strip ------------------------------------------------------------

const RANK: Record<string, number> = { error: 6, running: 5, stalled: 4, waiting: 4, done: 3, queued: 2, idle: 1 }

/**
 * One segment per phase, coloured by the worst thing that happened in it
 * during the last run (error > running/stalled > done > queued > idle), the
 * outcome word at the end. Hover a segment for its agents.
 */
function PhaseStrip({ graph, run, now, outcome }: { graph: ReturnType<typeof overlayRun>; run?: RunManifest; now: number; outcome?: ReturnType<typeof outcomeOf> }) {
  const stalled = isStalled(run)
  const segments = graph.phases.map((phase) => {
    const lines: string[] = []
    let worst: NodeState = 'idle'
    for (const n of graph.nodes) {
      if (n.phase !== phase) continue
      const info = graph.info[n.id]
      if (!info) continue
      if (RANK[info.state] > RANK[worst]) worst = info.state
      for (const a of info.agents) {
        let s = stateAt(a)
        if (stalled && (s === 'running' || s === 'queued')) s = 'stalled'
        const ms = s === 'running' && a.startedAt != null ? Math.max(now - a.startedAt, a.durationMs ?? 0) : a.durationMs
        lines.push(`${phase} · ${a.label ?? n.label} · ${s} · ${fmtDuration(ms)}`)
      }
    }
    return { phase, state: worst, title: lines.length ? lines.join('\n') : `${phase} · idle` }
  })
  return (
    <div className="strip" aria-label="phases of the last run">
      {segments.map((s) => (
        <div key={s.phase} className="strip-seg" data-state={s.state} title={s.title}>
          <span className="strip-bar" />
          <span className="strip-name">{s.phase}</span>
        </div>
      ))}
      <span className="strip-chip" data-tone={toneOf(run, outcome ?? outcomeOf(undefined))} title={outcome?.title}>{outcome?.word ?? dash}</span>
    </div>
  )
}

// --- run it ---------------------------------------------------------------------

function RunLine({ how, text }: { how: string; text: string }) {
  return (
    <div className="run-line">
      <span className="how muted">{how}</span>
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  )
}

/** Copies with the clipboard API and says `copied` for 1.5 s; where the API is missing the code stays selectable and nothing else happens. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  const copy = () => {
    const c = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!c) return
    c.writeText(text).then(() => setCopied(true)).catch(() => {})
  }
  return <button type="button" className="btn btn-small copy" data-copied={copied || undefined} onClick={copy} aria-label={`Copy: ${text}`}>{copied ? 'copied' : 'Copy'}</button>
}

// --- skills and agents ---------------------------------------------------------

function SkillsTable({ rows, files, cards }: { rows: WorkflowFile[]; files: WorkflowFile[]; cards: WorkflowCard[] }) {
  // Static graphs (no run overlaid) so a template node reads `review:*`, the way the script names it.
  const graphs = useMemo(() => cards.filter((c) => c.file || c.lastRun?.script).map((c) => ({ name: c.name, graph: graphFor(c.file, c.lastRun) })), [cards])
  const sorted = rows.slice().sort((a, b) => (a.kind === 'agent' ? 1 : 0) - (b.kind === 'agent' ? 1 : 0) || a.name.localeCompare(b.name))
  return (
    <section className="skills">
      <h2>Skills and agents</h2>
      <p className="muted">{COPY.skillsSub}</p>
      <div className="table-wrap">
        <table className="skills-table">
          <thead><tr><th>name</th><th>what it does</th><th>argument</th><th>called by</th></tr></thead>
          <tbody>
            {sorted.map((f) => (
              <tr key={`${f.kind}:${f.name}`} title={f.path}>
                <td>
                  <span className="row-name">
                    <code>{f.name}</code>
                    <span className="badge" data-kind={f.kind}>{f.kind}</span>
                    {f.kind === 'agent' && f.meta?.model && <span className="badge">{f.meta.model}</span>}
                    {f.meta?.disableModelInvocation && <span className="badge">human-only</span>}
                  </span>
                </td>
                <td>{firstSentence(f.meta?.description) || dash}</td>
                <td>{f.meta?.argumentHint ? <code>{f.meta.argumentHint}</code> : dash}</td>
                <td>{calledBy(f, files, graphs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Every workflow node that invokes this file, `<workflow> (<label>)`; none → who else does (another skill's `/name`), else the human. */
function calledBy(f: WorkflowFile, files: WorkflowFile[], graphs: { name: string; graph: ReturnType<typeof graphFor> }[]): string {
  const hits: string[] = []
  for (const { name, graph } of graphs) {
    for (const n of graph.nodes) {
      if ((f.kind === 'skill' && n.skill === f.name) || (f.kind === 'agent' && n.agentType === f.name)) hits.push(`${name} (${n.label})`)
    }
  }
  if (hits.length) return hits.join(', ')
  if (f.kind !== 'skill') return 'not called by a workflow'
  const slash = new RegExp(`/${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
  const caller = files.find((o) => o.kind === 'skill' && o.name !== f.name && slash.test(o.source))
  return caller ? `not called by a workflow — /${caller.name} calls it` : `not called by a workflow — a human runs /${f.name}`
}

// --- states --------------------------------------------------------------------

function Empty({ meta }: { meta: ConsoleMeta }) {
  const dirs = meta.projectDirs?.length ? meta.projectDirs.join(', ') : '~/.claude/projects/<slug>*'
  const forms = runForms('implement-from-spec')
  return (
    <div className="state">
      <p>Nothing to show yet.</p>
      <p className="muted">This page reads {dirs} for runs and {COPY.definitionDirs} for definitions.</p>
      <p>Start a run from a terminal:</p>
      <code>{forms.session}</code>
      {forms.headless && <code>{forms.headless}</code>}
      <p className="muted">The console never starts a run.</p>
    </div>
  )
}
