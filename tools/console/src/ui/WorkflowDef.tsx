import type { Graph, Ledger, RunManifest } from '../types'
import { NO_ROW, dotOf, elapsedOf, fmtDuration, outcomeOf, specOf, specPath, startOf, toneOf, usdOf, whenAbs, whenRel } from './format'
import { DriverWarnings, RunCommand, runCommand, type WorkflowCard } from './Workflows'
import type { PanelView } from './NodePanel'

// The definition view's header: what stands in the run header's place when a
// workflow is open with no run selected. It wears the same three rows as a run
// — a sentence, the command, then a line of context — so moving between the two
// views does not move the furniture.
//
// What it deliberately does NOT carry is the flow. The canvas below draws the
// phases as lanes with those same subtitles, the nodes with their purposes and
// the outcome column with every word this workflow can return; a numbered list
// of them in the header was the same page twice, stacked, and it pushed the
// graph — the reason to be on this screen — a further 120 px down.

export function WorkflowDef({ card, graph, wfRuns, ledger, now, onView, onOpen }: {
  card: WorkflowCard; graph: Graph; wfRuns: RunManifest[]; ledger: Ledger; now: number
  onView: (runId: string) => void; onOpen: (v: PanelView) => void
}) {
  const meta = card.file?.meta
  const whenToUse = meta?.whenToUse ?? graph.whenToUse
  const description = meta?.description ?? graph.description
  const file = card.file
  const last = wfRuns[0]
  const command = runCommand(card.name, specPath(specOf(last, ledger)), meta)
  return (
    <>
      {/* Row 2, where a run puts its sentence: what this workflow is for. `whenToUse` is a
          condition whose subject is the spec, so it keeps its label — without one it reads
          as a description of the wrong thing. The arrow chain is the fallback and the tooltip. */}
      <p className="wfdef-when" title={description}>
        {whenToUse
          ? <><span className="muted">Use when: </span>{whenToUse}</>
          : <span className="mono-inline">{description}</span>}
      </p>
      {/* Row 3, where a run puts Re-run: the same row, bound to the newest run's spec. */}
      <RunCommand label={last ? 'Re-run' : 'Run'} command={command} compact>
        <DriverWarnings command={command} />
      </RunCommand>
      {/* Row 4, where a run puts its Context line: the definition's own context — the file
          the graph is drawn from, and the runs behind it. */}
      <p className="ctx-1 wfdef-ctx">
        <span className="ctx-head">Definition</span>
        {file && (
          <span className="ctx-one">
            <span className="ctx-val" title={file.path}>{file.path}</span>
            <button type="button" className="btn btn-small" title="the workflow file the graph is drawn from — editable here"
              onClick={() => onOpen({ kind: 'edit', path: file.path, title: file.name, note: COPY.scriptNote })}>Open</button>
          </span>
        )}
        <span className="ctx-one">
          <span className="muted">runs</span>
          <span className="ctx-val">{wfRuns.length === 0 ? 'none yet' : wfRuns.length === 1 ? '1' : String(wfRuns.length)}</span>
          {last && <LastRunLine run={last} ledger={ledger} now={now} onView={onView} />}
        </span>
      </p>
    </>
  )
}

const COPY = {
  scriptNote: 'The workflow script. The graph on this screen is drawn from this text, so a saved edit redraws it.',
} as const

/**
 * The newest run, as one clause of the Definition line: the same dot the Runs
 * tab draws, the outcome, when, how long, what it cost — and the click that
 * turns the run view on. The Runs tab lists them all; this is the one that is next.
 */
function LastRunLine({ run, ledger, now, onView }: { run: RunManifest; ledger: Ledger; now: number; onView: (runId: string) => void }) {
  const outcome = outcomeOf(run)
  const usd = usdOf(run, ledger)
  const start = startOf(run)
  const dot = dotOf(run)
  return (
    <button type="button" className="link wfdef-last" onClick={() => run.runId && onView(run.runId)}
      title={`${specOf(run, ledger)} · ${whenAbs(start)} — open this run on the canvas`}>
      <span className="muted">· last</span>
      <span className="dot" data-status={dot.status} aria-hidden />
      <span className="outcome-word" data-tone={toneOf(run, outcome)}>{outcome.word}</span>
      <span className="muted">{whenRel(start, now)} · {fmtDuration(elapsedOf(run, now))} ·</span>
      {/* The cost cell, or — with no ledger row — the one cell of this line that is an action:
          `no RUNS.md row` reads as a link, and the click this line already performs opens the
          run on the canvas, where `add row` lives. Same title as the other two wordings. */}
      {usd.noRow
        ? <span className="no-row" title={NO_ROW.title}>{NO_ROW.card}</span>
        : <span className="muted" title={usd.title}>{usd.text}</span>}
      <span className="wfdef-view">View →</span>
    </button>
  )
}
