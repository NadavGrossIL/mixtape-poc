import type { RunManifest, WorkflowAgentEntry } from '../types'
import { isLive, sessionLimit } from './signals'
import { agentsOf, isStalled, labelOf } from './overlayRun'

// Why a run stopped, in the one word the manager needs before deciding what to
// do: **infra** (the machine, the account window, the budget — a human handles
// it and nothing about the spec is known yet) or **spec** (the reviewer or the
// implementer disagreed with what the ticket asks — the acceptance checks are
// the thing to change). The rule table is docs/factory/console-simplification.md
// §2, in that order, first match wins; everything the rules read is already in
// the manifest the page fetches.
//
// Pure: one manifest in, one verdict out, no fetch and no clock of its own
// (a stale run's 15-minute verdict is `isStalled`, the same one the rail draws
// with, and it can be passed in). It reads `graph/signals`' account-window
// reading so there is exactly one place that knows what "You've hit your
// session limit" looks like — and nothing under `graph/` imports `ui/`.

export type Cause = 'infra' | 'spec' | 'unknown' | 'ok' | 'running'

export interface CauseVerdict {
  /** infra = a human handles the machine; spec = the ticket is wrong; ok/running = nothing to handle. */
  cause: Cause
  /** A short slug for the rule that fired: `session-limit`, `budget`, `swept`, `ask-tier`, `agent-died`, `reviewer-fail`, `implementer-escalated`, `gate-failing`. */
  kind: string
  /** ≤ 8 words, e.g. `Infrastructure — account session limit`. */
  headline: string
  /** One sentence: what to do next. */
  action: string
  /** The raw string that fired the rule (an agent's error, the engine's abort, a gate log line). */
  evidence?: string
  /** The agent it happened at, e.g. `review:1`. */
  at?: string
}

export interface Finding { file?: string; line?: number; severity?: string; title?: string; why?: string }

/**
 * Did something stop this run that a human has to act on? `ok` (it returned
 * one of the script's own words) and `running` are the two causes with nothing
 * to handle — the one predicate the header block, the home card's line and the
 * rail's tooltip all ask, instead of three spellings of the same comparison.
 */
export function hasCause(cause: Cause): boolean {
  return cause !== 'ok' && cause !== 'running'
}

/** What `implement-from-spec.js` returns (`{ status, reason, review, gate, attempts, implemented }`), read defensively — every field is optional. */
export interface RunResult {
  status?: string
  reason?: string
  /** Not written today: the script change §2 proposes. When it is there, its word wins over the table's class. */
  cause?: string
  spec?: string
  attempts?: Record<string, number>
  gate?: { ok?: boolean; step?: string; log?: string }
  review?: { verdict?: string; findings?: Finding[] }
  implemented?: { status?: string; notes?: string; files?: string[] }
}

export const CAUSE_COPY = {
  sessionLimit: 'nothing about the spec is known yet',
  budget: 'Stopped by --max-budget-usd / --max-turns — raise the knob in factory.config.json or split the spec.',
  swept: 'The run ended without a manifest — re-run (FACTORY_BG_WAIT_MS is on main).',
  askTier: 'Gate step 0: an ask-tier file differs from origin/main; a human passes it with FACTORY_ASK_OK=1.',
  died: 'The step never produced output — see its error.',
  reviewer: 'Reviewer failed the diff twice — read the findings; the acceptance checks are the thing to change.',
  implementer: 'The implementer could not satisfy the spec — its notes say why.',
  unknown: 'Open the transcript.',
} as const

/** The engine's own word for a run it aborted on a hard stop (`--max-budget-usd` / `--max-turns`). */
const ABORTED = /workflow aborted/i
/** `reason` when an agent died: the script writes `no result` / `returned nothing` and erases the agent's error. */
const NOTHING = /returned nothing|no result/i
/** The reviewer's placeholder finding for "the agent died" — not a finding about the spec. */
const NO_FINDING = /returned nothing/i
const IMPLEMENTER = /implementer escalated/i
const GATE_FAILING = /gate still failing|gate failed/i
const ASK_TIER = /ask-tier/i
/** The word a script returns when it hands the run to a human; the last of its `outcomes` when a run ever carries the script's meta. */
const ESCALATION = 'needs-human'

export function resultOf(run?: RunManifest): RunResult | undefined {
  const r = run?.result
  return r && typeof r === 'object' ? (r as RunResult) : undefined
}

/** The reviewer's findings that say something about the diff; its "reviewer returned nothing" placeholder is not one. */
export function findingsOf(run?: RunManifest): Finding[] {
  const f = resultOf(run)?.review?.findings
  if (!Array.isArray(f)) return []
  return f.filter((x): x is Finding => !!x && typeof x === 'object' && !NO_FINDING.test(String(x.title ?? '')))
}

/** Did this log line carry what the rule fired on? (`[review:1] failed: <the agent's error>`). */
export function firedOn(line: string, v: CauseVerdict): boolean {
  const e = v.evidence?.trim()
  if (!e || e.length < 12) return false
  const l = line.trim()
  return l.includes(e) || (l.length >= 12 && e.includes(l))
}

/**
 * Why the run stopped. `opts.stale` overrides the 15-minute verdict (the rail
 * computes it once); without it `isStalled` decides, exactly as the canvas does.
 */
export function classify(run?: RunManifest, opts?: { stale?: boolean }): CauseVerdict {
  if (!run) return { cause: 'unknown', kind: 'no-run', headline: 'No run to read', action: CAUSE_COPY.unknown }
  const result = resultOf(run)
  const stale = opts?.stale ?? isStalled(run)
  const v = verdict(run, result, stale)
  if (v.cause === 'ok' || v.cause === 'running') return v
  // Future-proof: when the script itself says `cause`, that word wins; the kind,
  // headline and action still come from the signals on disk.
  const said = result?.cause
  return said === 'infra' || said === 'spec' || said === 'unknown' ? { ...v, cause: said } : v
}

function verdict(run: RunManifest, result: RunResult | undefined, stale: boolean): CauseVerdict {
  // A run that returned one of the script's own words, escalation aside, is
  // finished — there is nothing for a human to handle.
  const status = typeof result?.status === 'string' ? result.status.trim() : ''
  if (status && status !== escalationOf(run)) {
    return { cause: 'ok', kind: 'done', headline: `Finished — ${status}`, action: '' }
  }
  if (isLive(run) && !stale) return { cause: 'running', kind: 'running', headline: 'Still running', action: '' }

  // 1 — the account window: an agent's error or one of the script's log lines.
  const limit = sessionLimit(run)
  if (limit) {
    const where = limit.at ? ` at ${limit.at}` : ''
    const when = limit.resets ? `, resets ${limit.resets} — re-run after that` : ' — re-run once the window resets'
    return {
      cause: 'infra', kind: 'session-limit', headline: 'Infrastructure — account session limit',
      action: `Session limit${where}${when}; ${CAUSE_COPY.sessionLimit}.`, evidence: limit.raw, at: limit.at,
    }
  }

  // 2 — a hard stop: the engine killed the run, or aborted it.
  if (run.status === 'killed' || run.status === 'cancelled' || ABORTED.test(run.error ?? '')) {
    return {
      cause: 'infra', kind: 'budget', headline: 'Infrastructure — budget or turn stop',
      action: CAUSE_COPY.budget, evidence: firstLine(run.error), at: erroredAt(run),
    }
  }

  // 3 — swept: nothing moved for 15 min and no terminal manifest was ever written.
  if (stale && run.source !== 'manifest') {
    return {
      cause: 'infra', kind: 'swept', headline: 'Infrastructure — swept or session ended',
      action: CAUSE_COPY.swept, at: lastMovingAt(run),
    }
  }

  const gate = result?.gate
  const reason = typeof result?.reason === 'string' ? result.reason : ''

  // 4 — gate step 0: an ask-tier file differs from origin/main.
  if (gate?.ok === false && ASK_TIER.test(gate.step ?? '')) {
    return {
      cause: 'infra', kind: 'ask-tier', headline: 'Infrastructure — ask-tier file is dirty',
      action: CAUSE_COPY.askTier, evidence: firstLine(gate.log) ?? gate.step, at: 'gate',
    }
  }

  // 5 — the agent died and the reason erased it ("no result"); its error is the real story.
  const dead = deadAgent(run, reason)
  if (NOTHING.test(reason) && dead) {
    return {
      cause: 'infra', kind: 'agent-died', headline: 'Infrastructure — the step returned nothing',
      action: CAUSE_COPY.died, evidence: firstLine(dead.error), at: labelOf(dead),
    }
  }

  // 6 — the reviewer failed the diff and said why: the spec and the code disagree.
  const findings = findingsOf(run)
  if (result?.review?.verdict === 'fail' && findings.length) {
    return {
      cause: 'spec', kind: 'reviewer-fail', headline: 'Spec — the reviewer failed the diff',
      action: CAUSE_COPY.reviewer, at: 'review',
    }
  }

  // 7 — the implementer could not satisfy the spec.
  if (IMPLEMENTER.test(reason)) {
    return {
      cause: 'spec', kind: 'implementer-escalated', headline: 'Spec — the implementer escalated',
      action: CAUSE_COPY.implementer, evidence: result?.implemented?.notes ?? reason, at: 'implement',
    }
  }

  // 8 — the gate never went green: the code (or the checks) are wrong.
  if (gate?.ok === false || GATE_FAILING.test(reason)) {
    const step = gate?.step ? `"${gate.step}"` : 'its step'
    return {
      cause: 'spec', kind: 'gate-failing', headline: 'Spec or code — the gate keeps failing',
      action: `Gate failed at ${step} after every fix round — read the gate log.`,
      evidence: firstLine(gate?.log) ?? (reason || undefined), at: 'gate',
    }
  }

  // 9 — anything else.
  return {
    cause: 'unknown', kind: 'unknown', headline: 'Unclear — the manifest says no more',
    action: CAUSE_COPY.unknown, evidence: reason || firstLine(run.error), at: erroredAt(run),
  }
}

/** The script's own word for "a human must step in": the last of `meta.outcomes` when a run carries it, else `needs-human`. */
function escalationOf(run: RunManifest): string {
  const outcomes = (run as { meta?: { outcomes?: unknown } }).meta?.outcomes
  if (Array.isArray(outcomes) && outcomes.length) {
    const last = outcomes[outcomes.length - 1]
    if (typeof last === 'string' && last.trim()) return last.trim()
  }
  return ESCALATION
}

/**
 * Which agents a phase named in the reason owns: the script says `review fix
 * round escalated`, `implementer escalated`, `gate still failing`, and names
 * its agents `review:1` / `fix:review` / `implement` / `fix:gate-1` / `gate:1`.
 * First match wins, so a reason that says both (`review fix round`) is a
 * review, not a fix.
 */
const PHASE_AGENTS: [RegExp, RegExp][] = [
  [/review/i, /^(review\b|review:|fix:review\b|contract\b)/i],
  [/implement/i, /^(implement\b|fix:)/i],
  [/gate/i, /^gate\b|^gate:/i],
]

/**
 * The agent whose error the reason is about: when the reason names a phase
 * (`review fix round escalated: no result`), the *last* errored agent of that
 * phase — a run where implement failed early and review failed at the end must
 * not blame implement. Nothing to go on falls back to the first errored agent
 * by index.
 */
function deadAgent(run: RunManifest, reason?: string): WorkflowAgentEntry | undefined {
  const errored = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((a) => typeof a.error === 'string' && !!a.error.trim())
  if (!errored.length) return undefined
  const phase = reason ? PHASE_AGENTS.find(([names]) => names.test(reason)) : undefined
  if (phase) {
    const owned = errored.filter((a) => phase[1].test(labelOf(a)))
    if (owned.length) return owned[owned.length - 1]
  }
  return errored[0]
}

/** Where a stopped run last was: the failing agent, else the last one the journal saw. */
function erroredAt(run: RunManifest): string | undefined {
  const dead = deadAgent(run)
  return dead ? labelOf(dead) : lastMovingAt(run)
}

function lastMovingAt(run: RunManifest): string | undefined {
  const agents = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const last = agents.filter((a) => a.state === 'running' || a.state === 'progress' || a.state === 'queued').pop() ?? agents[agents.length - 1]
  return last ? labelOf(last) : undefined
}

/** A stack trace is not evidence; the first line of it is. */
function firstLine(s?: string): string | undefined {
  const line = s?.split('\n').map((l) => l.trim()).find((l) => !!l)
  return line || undefined
}
