import type { RunManifest } from '../types'
import { agentsOf, labelOf } from './overlayRun'

// The signals a run carries about itself, read once and read here: is it still
// going, and did the account window stop it. `graph/` is the pure half of the
// console — a manifest in, a verdict out — so the classifier (cause.ts) must
// not reach into `ui/` for them; `ui/format.ts` re-exports both, which is why
// every existing import still resolves.

/** Is the run still going (as far as the plugin can tell)? */
export function isLive(run?: RunManifest): boolean {
  return !!run && (run.live === true || run.status === 'running')
}

/**
 * The account-window stop, as the engine writes it into the failing agent's
 * `error`: `You've hit your session limit · resets 4:40pm (Asia/Jerusalem)`
 * (`wf_66ec6c31-e3f`, review:1 and fix:review). The classifier's rule 1 and
 * the header's copy read the same match, so there is one place that knows what
 * that sentence looks like.
 */
export const SESSION_LIMIT_RE = /hit your session limit/i
const RESETS_RE = /resets\s+([^·\n]+)/i

/** `[review:1] failed: …` — how the script's `logs[]` names the agent that hit it. */
const LOG_AT_RE = /^\[([^\]]+)\]/

/**
 * The first agent stopped by the account window: when it resets, where it
 * stopped, the raw string that said so, and the one line to show. Agents
 * first, then the script's own `logs[]` (a journal-derived run has the log
 * lines but not always the agent errors). Nothing when neither hit it.
 */
export function sessionLimit(run?: RunManifest): { text: string; raw: string; resets?: string; at?: string } | undefined {
  for (const a of agentsOf(run)) {
    if (typeof a.error !== 'string' || !SESSION_LIMIT_RE.test(a.error)) continue
    return { ...parseSessionLimit(a.error), raw: a.error, at: labelOf(a) }
  }
  for (const line of run?.logs ?? []) {
    if (typeof line !== 'string' || !SESSION_LIMIT_RE.test(line)) continue
    return { ...parseSessionLimit(line), raw: line, at: LOG_AT_RE.exec(line)?.[1] }
  }
  return undefined
}

/** When the window resets, out of whatever text carried it, and the one line to show for it. */
export function parseSessionLimit(text: string): { text: string; resets?: string } {
  const resets = RESETS_RE.exec(text)?.[1]?.trim()
  return { resets, text: resets ? `session limit — resets ${resets}; re-run after` : 'session limit — re-run once the window resets' }
}
