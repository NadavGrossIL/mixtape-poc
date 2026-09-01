import type { CauseVerdict, Finding } from '../graph'
import { dash } from './format'

// The tag on "why it stopped", in one place. The canvas header's block is its
// one caller now — the home card's cause line is gone, because why a run
// stopped is a fact about that run and the canvas is a click away — and
// `hasCause` (graph/cause.ts) is the predicate that decides whether the block
// renders at all. Copy: docs/factory/console-simplification.md §2.

export const CAUSE_TAG: Record<string, { text: string; title: string }> = {
  infra: { text: 'INFRA — you handle it', title: 'the machine, the account window or the budget stopped it; nothing about the spec is known yet' },
  spec: { text: 'SPEC — the reviewer disagreed', title: 'the diff and the ticket disagree; the acceptance checks are the thing to change' },
  unknown: { text: 'UNKNOWN', title: 'no rule matched this manifest — the transcript is the only source left' },
}

/** The pill and the headline beside it: `INFRA — you handle it · Infrastructure — account session limit`. Nothing when the run did not stop (`ok`, `running`). */
export function CauseTag({ verdict }: { verdict: CauseVerdict }) {
  const tag = CAUSE_TAG[verdict.cause]
  if (!tag) return null
  return (
    <>
      <span className="why-tag">{tag.text}</span>
      <span className="why-head" title={tag.title}>{verdict.headline}</span>
    </>
  )
}

/**
 * The reviewer's findings, one line each: what it found, why, and the file and
 * line it is about. The canvas header's "why it stopped" block and the node
 * panel's *This run* tab render the same list from the same `findingsOf` — the
 * placeholder finding is already gone by the time it gets here. Nothing when
 * there are none, so a caller can render it unconditionally.
 */
export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null
  return (
    <ul className="why-findings">
      {findings.map((f, i) => (
        <li key={i}>
          <span className="why-finding-title">{f.title ?? dash}</span>
          {f.why ? <> — {f.why}</> : null}
          {f.file ? <span className="muted"> · <code>{f.file}{f.line ? `:${f.line}` : ''}</code></span> : null}
        </li>
      ))}
    </ul>
  )
}
