import { useMemo, type ReactNode } from 'react'
import type { Ledger, NodeState, RunManifest, WorkflowFile, WorkflowMeta } from '../types'
import { classify, firstSentence, graphFor, hasCause, isStalled, overlayRun, stateAt } from '../graph'
import { dash, elapsedOf, fmtDuration, isLive, nowAt, outcomeOf, projectTag, specOf, specPath, startOf, stopReason, toneOf, usdOf, whenAbs, whenRel } from './format'
import { CauseTag } from './Cause'
import { CopyButton } from './Copy'
import { useRemembered } from './remember'

// The "all workflows" screen: one card per workflow that says what it does,
// how its last run ended (one line that opens that run), where each phase got
// to (the strip), and the one command that runs it again — bound to the spec
// of the run on screen, pasted in a terminal, never started from here. Under
// the cards, the skills and agents the workflows are made of, each with who
// calls it. Copy is docs/factory IA-SPEC §1–§3 and §8, pasted verbatim.

export interface WorkflowCard { name: string; file?: WorkflowFile; lastRun?: RunManifest; runs: number }
/** `GET /api/meta`. */
export interface ConsoleMeta { slug?: string; projectsBase?: string; projectDirs?: string[]; exists?: boolean }

const COPY = {
  subtitle: "The factory's saved workflows and their runs on this machine. Nothing here starts a run.",
  /** Where the command goes and what happens then — the h1 already says the console starts nothing, so this rides on Copy rather than under every card. */
  copyTitle: 'paste in a terminal — the driver writes the RUNS.md row',
  skillsSub: 'The files the workflows are made of. Each line says who calls it.',
  definitionDirs: '.claude/workflows/, .claude/skills/, .archon/workflows/',
} as const

/** The skills table is reference material — folded away by default (§5), remembered once a reader opens it. */
const SKILLS_KEY = 'console.skills'

/**
 * The one command that runs each workflow, keyed by name: the driver where
 * there is one (it reads the knobs from `factory.config.json`, so no flags
 * belong on screen), the in-session slash form where there is not —
 * `review-spec` has no driver. Anything else gets the slash form.
 */
const RUN_FORMS: Record<string, (spec: string) => string> = {
  'implement-from-spec': (spec) => `scripts/factory-run.sh ${spec}`,
  'review-spec': (spec) => `/review-spec ${spec}`,
}

/** Does this command start the driver, which cuts the worktree from scratch? */
export const isDriverCommand = (command: string) => command.startsWith('scripts/factory-run.sh ')

/** The command that runs a workflow again on one spec — `specPath(specOf(run))`; the `specs/NNNN-slug.md` placeholder only when there is no run to read a spec from. */
export function runCommand(name: string, spec?: string, meta?: WorkflowMeta): string {
  const arg = spec ?? meta?.argumentHint ?? 'specs/NNNN-slug.md'
  return (RUN_FORMS[name] ?? ((s: string) => `/${name} ${s}`))(arg)
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
  cards: WorkflowCard[]; files: WorkflowFile[]; ledger: Ledger; meta: ConsoleMeta; now: number; onOpen: (name: string, runId?: string) => void
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
        : <div className="cards">{cards.map((c) => <Card key={c.name} card={c} ledger={ledger} now={now} onOpen={(runId) => onOpen(c.name, runId)} />)}</div>}
      {rows.length > 0 && <SkillsTable rows={rows} files={files} cards={cards} />}
    </section>
  )
}

// --- the card -------------------------------------------------------------------

function Card({ card, ledger, now, onOpen }: { card: WorkflowCard; ledger: Ledger; now: number; onOpen: (runId?: string) => void }) {
  const run = card.lastRun
  const graph = useMemo(() => overlayRun(graphFor(card.file, run), run), [card, run])
  const meta = card.file?.meta
  const engine = card.file?.engine ?? 'native'
  const description = meta?.description ?? graph.description
  const whenToUse = meta?.whenToUse ?? graph.whenToUse
  const command = runCommand(card.name, specPath(specOf(run, ledger)), meta)
  const outcome = outcomeOf(run)
  const tag = projectTag(run?.projectSlug)
  // `native` is true of every workflow here — a constant is not a chip (§5). It rides in the name's tooltip; `archon` still earns one.
  const title = [card.file?.path, `${engine} engine`].filter(Boolean).join(' · ')
  return (
    <div className="card">
      <div className="card-head">
        <button type="button" className="card-name" onClick={() => onOpen()} title={title}>{card.name}</button>
        {engine !== 'native' && <span className="badge" data-engine={engine}>{engine}</span>}
        {(card.file?.fixture || run?.fixture) && <span className="badge">fixture</span>}
      </div>
      <p className="card-desc">{description || dash}</p>
      {whenToUse && <p className="card-when"><span className="muted">Use when: </span>{whenToUse}</p>}

      <h3>Last run</h3>
      {run
        ? <LastRun run={run} ledger={ledger} now={now} outcome={outcome} tag={tag} onOpen={() => onOpen(run.runId)} />
        : <p className="last-run muted">no runs yet</p>}
      <RunCommand label={run ? 'Re-run' : 'Run'} command={command} />
      <PhaseStrip graph={graph} run={run} now={now} outcome={run ? outcome : undefined} />

      <div className="card-foot">
        <span className="muted">{card.runs === 0 ? 'no runs yet' : card.runs === 1 ? '1 run' : `${card.runs} runs`}</span>
        <button type="button" className="link" onClick={() => onOpen()}>Open canvas →</button>
      </div>
    </div>
  )
}

/**
 * Line 1 is the whole run, in the card's largest type after its name, and it is
 * the link: clicking it opens that run on the canvas (the card's other two paths
 * open the workflow's newest). Directly under it, why it stopped. The branch and
 * the worktree are the line's tooltip only — spelled out they wrapped over three
 * lines in a 350 px card, and the canvas's Context line is where they belong.
 */
function LastRun({ run, ledger, now, outcome, tag, onOpen }: { run: RunManifest; ledger: Ledger; now: number; outcome: ReturnType<typeof outcomeOf>; tag?: string; onOpen: () => void }) {
  const start = startOf(run)
  const duration = fmtDuration(elapsedOf(run, now))
  const usd = usdOf(run, ledger)
  const { branch, cwd } = run.git ?? {}
  const where = [branch && `branch ${branch}`, cwd && `worktree ${cwd}`].filter(Boolean).join(' · ')
  return (
    <>
      <button type="button" className="last-run last-run-open" onClick={onOpen}
        title={`open ${run.runId ?? 'this run'} on the canvas${where ? `\n${where}` : ''}`}>
        <span className="outcome-word" data-tone={toneOf(run, outcome)} title={outcome.title}>{outcome.word}</span>
        {' · '}<span className="spec">{specOf(run, ledger)}</span>
        {' · '}<span title={whenAbs(start)}>{whenRel(start, now)}</span>
        {' · '}<span className="clock">{duration}</span>
        {' · '}<span title={usd.title}>{usd.text}</span>
        {tag && <> <span className="badge" title={run.projectSlug}>{tag}</span></>}
      </button>
      <WhyLine run={run} />
      {lineTwo(run, outcome, now) && <p className="last-run-2 muted">{lineTwo(run, outcome, now)}</p>}
    </>
  )
}

/**
 * The card is a summary, so it carries the tag and the headline only — the
 * action sentence, the evidence and the logs are on the canvas, one click away
 * through the LAST RUN line above.
 */
function WhyLine({ run }: { run: RunManifest }) {
  const v = classify(run)
  if (!hasCause(v.cause)) return null
  return <p className="why-line why-card" data-cause={v.cause}><CauseTag verdict={v} /></p>
}

/** Line 2 of the last-run block — the first that applies: stale (prefixed `stale — `, IA-SPEC §2), live, killed, an error agent (`stopReason`), a `needs-human` reason; else nothing. */
function lineTwo(run: RunManifest, outcome: ReturnType<typeof outcomeOf>, now: number): string | undefined {
  if (isStalled(run)) return `stale — ${stopReason(run)}`
  if (isLive(run)) return nowAt(run, now)
  const why = stopReason(run)
  if (why) return why
  if (outcome.source === 'result' && outcome.word === 'needs-human') {
    const reason = (run.result as { reason?: unknown } | null)?.reason
    if (typeof reason === 'string' && reason) return reason
  }
  return undefined
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
        const s = stateAt(a, undefined, stalled)
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

/**
 * One action row: what it would do, the exact line to paste, Copy. Used by the
 * card (stacked) and by the canvas header (`compact`, a row under the run
 * sentence, with the warnings as `children`). No flags — the driver reads
 * `factory.config.json`, which the canvas header's Settings button opens. What
 * to do with the line is the Copy button's tooltip: the screen title already
 * says the console never starts a run, and the paragraph that repeated it under
 * every card was two lines of boilerplate above the fold.
 */
export function RunCommand({ label, command, compact, children }: {
  label: string; command: string; compact?: boolean; children?: ReactNode
}) {
  return (
    <div className="run-cmd" data-compact={compact || undefined}>
      <div className="run-line">
        <span className="how muted">{label}</span>
        <code>{command}</code>
        <CopyButton text={command} title={COPY.copyTitle} />
        {compact && children}
      </div>
      {!compact && children}
    </div>
  )
}

// --- skills and agents ---------------------------------------------------------

/**
 * The files the workflows are made of — a table nothing on it is clickable, and
 * the eye landed on it before it landed on the runs. Folded away by default
 * (§5); the summary counts what is inside, and an open one is remembered.
 */
function SkillsTable({ rows, files, cards }: { rows: WorkflowFile[]; files: WorkflowFile[]; cards: WorkflowCard[] }) {
  // Static graphs (no run overlaid) so a template node reads `review:*`, the way the script names it.
  const graphs = useMemo(() => cards.filter((c) => c.file || c.lastRun?.script).map((c) => ({ name: c.name, graph: graphFor(c.file, c.lastRun) })), [cards])
  const sorted = rows.slice().sort((a, b) => (a.kind === 'agent' ? 1 : 0) - (b.kind === 'agent' ? 1 : 0) || a.name.localeCompare(b.name))
  const [open, setOpen] = useRemembered(SKILLS_KEY, false)
  return (
    <details className="skills fold" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Skills and agents ({sorted.length})</summary>
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
    </details>
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
  return (
    <div className="state">
      <p>Nothing to show yet.</p>
      <p className="muted">This page reads {dirs} for runs and {COPY.definitionDirs} for definitions.</p>
      <p>Start a run from a terminal:</p>
      <code>{runCommand('implement-from-spec')}</code>
      <p className="muted">The console never starts a run.</p>
    </div>
  )
}
