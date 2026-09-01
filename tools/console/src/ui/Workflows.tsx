import { useMemo, type ReactNode } from 'react'
import type { Ledger, RunManifest, WorkflowFile, WorkflowMeta } from '../types'
import { firstSentence, graphFor } from '../graph'
import { dash, dotOf, outcomeOf, outcomeTone, specOf, startOf, toneOf, whenAbs, whenRel } from './format'
import { CopyButton } from './Copy'

// The "all workflows" screen: which workflows this machine has and what each
// one is for. A card says it in plain words — when to use it, then the flow in
// the file's own shorthand — and ends in one quiet line: how the last run
// ended, and the click that opens it. Everything a run knows about itself (the
// spec, the clock, the cost, why it stopped, the command that runs it again)
// belongs to the workflow's own screen, a level down. Under the cards, the
// skills and agents the workflows are made of, each a row that says who calls
// it and opens the file itself.

export interface WorkflowCard { name: string; file?: WorkflowFile; lastRun?: RunManifest; runs: number }
/** `GET /api/meta`. */
export interface ConsoleMeta { slug?: string; projectsBase?: string; projectDirs?: string[]; exists?: boolean }

const COPY = {
  subtitle: "The factory's saved workflows and their runs on this machine. Nothing here starts a run.",
  /** Where the command goes and what happens then — the h1 already says the console starts nothing, so this rides on Copy rather than under every card. */
  copyTitle: 'paste in a terminal — the driver writes the RUNS.md row',
  skillsSub: 'A procedure run by name, by a workflow step or by you. Click one to open its SKILL.md.',
  agentsSub: 'A subagent a workflow step spawns, with its own model and its own tools. Click one to open its definition.',
  definitionDirs: '.claude/workflows/, .claude/skills/, .archon/workflows/',
  /** The driver removes and re-adds `../mixtape-poc.wt` before it starts (`scripts/factory-run.sh`, "worktree:"), so anything uncommitted in there goes with it. */
  wipes: 're-running wipes the worktree',
  wipesTitle: 'scripts/factory-run.sh removes ../mixtape-poc.wt and cuts it again from origin/main — uncommitted work in that worktree is gone',
  window: '~10 min — check the 5-hour window',
  windowTitle: 'a full line run takes about ten minutes; the account window is five hours, and a run that hits its end stops mid-line',
} as const

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

/** The two warnings a driver command earns wherever it appears: what it wipes, and what it costs the account window. Nothing for the in-session forms. */
export function DriverWarnings({ command }: { command: string }) {
  if (!isDriverCommand(command)) return null
  return (
    <>
      <span className="run-warn" title={COPY.wipesTitle}>{COPY.wipes}</span>
      <span className="run-warn" title={COPY.windowTitle}>{COPY.window}</span>
    </>
  )
}

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

export function Workflows({ cards, files, ledger, meta, now, onOpen, onOpenDef }: {
  cards: WorkflowCard[]; files: WorkflowFile[]; ledger: Ledger; meta: ConsoleMeta; now: number
  onOpen: (name: string, runId?: string) => void; onOpenDef: (f: WorkflowFile) => void
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
      {rows.length > 0 && <SkillsAgents rows={rows} files={files} cards={cards} onOpenDef={onOpenDef} />}
    </section>
  )
}

// --- the card -------------------------------------------------------------------

/**
 * A card is the workflow, not its last run: the name, what it is for in plain
 * words, and the flow in the shorthand the file itself uses. The run details —
 * the spec, the clock, the cost, why it stopped, the command that runs it
 * again — are a level down, on the workflow's own screen, because this screen
 * answers "which workflows do I have and what do they do". All that survives
 * here is one quiet clause in the foot: how the last one ended, which is the
 * only run fact worth a glance from across the grid, and the click that opens it.
 */
function Card({ card, ledger, now, onOpen }: { card: WorkflowCard; ledger: Ledger; now: number; onOpen: (runId?: string) => void }) {
  const run = card.lastRun
  const graph = useMemo(() => graphFor(card.file, run), [card, run])
  const meta = card.file?.meta
  const engine = card.file?.engine ?? 'native'
  const description = meta?.description ?? graph.description
  const whenToUse = meta?.whenToUse ?? graph.whenToUse
  // The steps in the order they run, and what the workflow can end in — the two halves
  // of the description's arrow chain, which as one mono string broke mid-word and read
  // as decoration. The chain itself stays, in the row's tooltip.
  const steps = graph.phases.filter(Boolean)
  const outcomes = graph.outcomes ?? []
  // `native` is true of every workflow here — a constant is not a chip (§5). It rides in the name's tooltip; `archon` still earns one.
  const title = [card.file?.path, `${engine} engine`].filter(Boolean).join(' · ')
  return (
    <div className="card">
      <div className="card-head">
        <button type="button" className="card-name" onClick={() => onOpen()} title={title}>{card.name}</button>
        {engine !== 'native' && <span className="badge" data-engine={engine}>{engine}</span>}
        {(card.file?.fixture || run?.fixture) && <span className="badge">fixture</span>}
      </div>
      {/* `whenToUse` is a condition, and its subject is the spec, not the workflow — it needs
          its label to parse. Without one, "A spec under specs/ has status: ready and should
          go to…" reads as a description of the wrong thing. */}
      <p className="card-desc">
        {whenToUse ? <><span className="muted">Use when: </span>{whenToUse}</> : description || dash}
      </p>
      {/* The steps read in the lanes' own type, so the card and the canvas you open from it
          say the flow the same way. */}
      {steps.length > 0 && (
        <p className="card-flow" title={description}>
          {steps.map((s, i) => (
            <span key={s} className="card-step-wrap">
              {i > 0 && <span className="card-arrow" aria-hidden>→</span>}
              <span className="card-step">{s}</span>
            </span>
          ))}
        </p>
      )}
      {/* The words it can end in, toned so the one that wants a human stands out. Words, not
          the canvas's chips: three pills do not fit a 360 px card, and a chip on the canvas
          means the outcome a run reached — these are only the ones it could. */}
      {outcomes.length > 0 && (
        <p className="card-ends">
          <span className="muted">ends in </span>
          {outcomes.map((o, i) => (
            <span key={o}>
              {i > 0 && <span className="muted"> · </span>}
              <span data-tone={outcomeTone(o)}>{o}</span>
            </span>
          ))}
        </p>
      )}

      <div className="card-foot">
        {run
          ? <CardLastRun run={run} ledger={ledger} now={now} onOpen={() => onOpen(run.runId)} />
          : <span className="muted">no runs yet</span>}
        {card.runs > 0 && <span className="muted card-count">{card.runs === 1 ? '1 run' : `${card.runs} runs`}</span>}
        <button type="button" className="link card-open" onClick={() => onOpen()}>Open →</button>
      </div>
    </div>
  )
}

/**
 * How the last run ended, in the foot: the same dot the Runs tab draws, the outcome word and
 * the day, nothing else. It stays a button — the click that opens that exact run
 * is the one path from this screen straight into a run, and the spec, the clock
 * and the cost are all one line down on the workflow screen.
 */
function CardLastRun({ run, ledger, now, onOpen }: { run: RunManifest; ledger: Ledger; now: number; onOpen: () => void }) {
  const outcome = outcomeOf(run)
  const start = startOf(run)
  const dot = dotOf(run)
  return (
    <button type="button" className="link card-last" onClick={onOpen}
      title={`${specOf(run, ledger)} · ${whenAbs(start)} — open this run`}>
      <span className="dot" data-status={dot.status} aria-hidden />
      <span className="outcome-word" data-tone={toneOf(run, outcome)}>{outcome.word}</span>
      <span className="muted">{whenRel(start, now)}</span>
    </button>
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
 * The files the workflows are made of, in the two kinds they actually are: a
 * **skill** is a procedure invoked by name (`/implement`), an **agent** is a
 * subagent a step spawns with its own model and tools. Mixed into one grid they
 * were told apart only by a badge, and five of them wrapped 4 + 1 with a hole
 * in the row; split, each group fills its own. The kind is the heading now, so
 * the badge is gone from the rows. A row is the way in: clicking it opens the
 * file itself (SKILL.md or the agent's `.md`) in the panel, editable through
 * the same allowlist the node panel writes.
 */
function SkillsAgents({ rows, files, cards, onOpenDef }: { rows: WorkflowFile[]; files: WorkflowFile[]; cards: WorkflowCard[]; onOpenDef: (f: WorkflowFile) => void }) {
  // Static graphs (no run overlaid) so a template node reads `review:*`, the way the script names it.
  const graphs = useMemo(() => cards.filter((c) => c.file || c.lastRun?.script).map((c) => ({ name: c.name, graph: graphFor(c.file, c.lastRun) })), [cards])
  const groups = (['skill', 'agent'] as const)
    .map((kind) => ({ kind, list: rows.filter((f) => f.kind === kind).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((g) => g.list.length > 0)
  return (
    <section className="defs" aria-label="skills and agents">
      {groups.map(({ kind, list }) => (
        <div key={kind} className="def-group">
          <h2>{kind === 'skill' ? 'Skills' : 'Agents'} ({list.length})</h2>
          <p className="muted small">{kind === 'skill' ? COPY.skillsSub : COPY.agentsSub}</p>
          <div className="def-rows">
            {list.map((f) => (
              <button key={f.name} type="button" className="def-row" title={`open ${f.path}`} onClick={() => onOpenDef(f)}>
                <span className="def-top">
                  {/* A skill is named the way it is run; an agent is named the way a step asks for it. */}
                  <code className="def-name">{kind === 'skill' ? `/${f.name}` : f.name}</code>
                  {f.meta?.argumentHint && <code className="def-arg muted">{f.meta.argumentHint}</code>}
                  {(f.meta?.model || f.meta?.disableModelInvocation) && (
                    <span className="def-tags">
                      {f.meta?.model && <span className="badge">{f.meta.model}</span>}
                      {f.meta?.disableModelInvocation && <span className="badge" title="a person runs this one; a model may not invoke it">human-only</span>}
                    </span>
                  )}
                </span>
                <span className="def-desc">{firstSentence(f.meta?.description) || dash}</span>
                {/* What it may touch — the frontmatter's own list. "Read-only" is a claim in the
                    description; the tools are the proof, and they were never on screen. */}
                {!!f.meta?.tools?.length && (
                  <span className="def-tools muted small">tools {f.meta.tools.join(' · ')}</span>
                )}
                <span className="def-by muted small">{calledBy(f, files, graphs)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

/** Every workflow node that invokes this file, `<workflow> ▸ <labels>` deduped per workflow; none → who else does (another skill's `/name`), else the human. */
function calledBy(f: WorkflowFile, files: WorkflowFile[], graphs: { name: string; graph: ReturnType<typeof graphFor> }[]): string {
  const hits: string[] = []
  for (const { name, graph } of graphs) {
    const labels = graph.nodes.filter((n) => (f.kind === 'skill' ? n.skill === f.name : n.agentType === f.name)).map((n) => n.label)
    if (labels.length) hits.push(`${name} ▸ ${[...new Set(labels)].join(', ')}`)
  }
  if (hits.length) return `used by ${hits.join(' · ')}`
  if (f.kind !== 'skill') return 'no workflow step spawns it'
  const slash = new RegExp(`/${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
  const caller = files.find((o) => o.kind === 'skill' && o.name !== f.name && slash.test(o.source))
  return caller ? `used by /${caller.name}, not by a workflow` : `no workflow calls it — you run /${f.name}`
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
