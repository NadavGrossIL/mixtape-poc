import type { CauseVerdict } from '../graph'

// The tag on "why it stopped", in one place. The canvas header's block and the
// home card's line render exactly the same pill from the same verdict, so the
// two screens cannot drift in wording, colour or tooltip; `hasCause` (graph/
// cause.ts) is the predicate that decides whether either of them renders at
// all. Copy: docs/factory/console-simplification.md §2.

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
