import type { Ledger, RunManifest, WorkflowAgentEntry } from '../types'
import { agentsOf, isStalled, labelOf, stateAt } from '../graph/overlayRun'

export { labelOf }

// Pure formatters for the page. Every input is optional and a partial
// manifest never throws: a field the engine did not write shows `—`. The
// wording is docs/factory IA-SPEC §0 (shared formats), pasted verbatim.

export const dash = '—'

export function fmtTokens(n?: number): string {
  if (n == null) return dash
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return dash
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function shortModel(m?: string): string {
  if (!m) return dash
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function fmtUsd(n?: number): string {
  return n == null || !Number.isFinite(n) ? dash : `$${n.toFixed(2)}`
}

/** A short tag for where a run happened: `wt` for the driver's worktree (`<slug>.wt`, which Claude Code slugs as `…-wt`), nothing for the repo itself. */
export function projectTag(slug?: string): string | undefined {
  return slug && /[-.]wt$/.test(slug) ? 'wt' : undefined
}

export function fmtDate(ms?: number, iso?: string): string {
  const t = ms ?? (iso ? Date.parse(iso) : NaN)
  if (!Number.isFinite(t)) return dash
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// --- time (local, 24 h) ------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number) => String(n).padStart(2, '0')

function toMs(ts: number | string | undefined): number | undefined {
  const t = typeof ts === 'number' ? ts : typeof ts === 'string' && ts ? Date.parse(ts) : NaN
  return Number.isFinite(t) ? t : undefined
}

/** `HH:MM:SS`, local. */
export function fmtTime(ts?: number | string): string {
  const t = toMs(ts)
  if (t == null) return dash
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** `13:58`, local — the rail's and header's `started 13:58`. */
export function fmtClock(ts?: number | string): string {
  const t = toMs(ts)
  if (t == null) return dash
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `29 Aug 12:03`, local. */
function dayClock(t: number): string {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Under 24 h: `just now` (<60 s), `35m ago`, `2h ago`; else `29 Aug 12:03`. */
export function whenRel(ts?: number | string, now: number = Date.now()): string {
  const t = toMs(ts)
  if (t == null) return dash
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return dayClock(t)
}

/** `Sat 29 Aug 2026, 12:03:06`, local — the hover title behind every relative time. */
export function whenAbs(ts?: number | string): string {
  const t = toMs(ts)
  if (t == null) return dash
  const d = new Date(t)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${fmtTime(t)}`
}

/** When a run started: `startTime`, else its `timestamp`. */
export function startOf(run?: RunManifest): number | undefined {
  return toMs(run?.startTime) ?? toMs(run?.timestamp)
}

// --- the run in one line ---------------------------------------------------------

export const OUTCOME_TITLE = {
  result: 'workflow outcome (result.status)',
  engine: 'engine status (manifest.status) — the workflow returned no result',
} as const

/**
 * The word for how a run ended: `result.status` when the script returned one
 * (`ready-for-pr`, `reviewed`, `needs-human`), else the engine's own status,
 * worded so a reader knows it is not the workflow speaking.
 */
export function outcomeOf(run?: RunManifest): { word: string; source: 'result' | 'engine'; title: string } {
  const r = run?.result as { status?: unknown } | null | undefined
  if (r && typeof r === 'object' && typeof r.status === 'string' && r.status) return { word: r.status, source: 'result', title: OUTCOME_TITLE.result }
  const s = run?.status
  const word = s === 'completed' ? 'completed — no result'
    : s === 'killed' || s === 'running' || s === 'stale' ? s
    : s === 'failed' || s === 'error' || s === 'cancelled' ? 'error'
    : s || dash
  return { word, source: 'engine', title: OUTCOME_TITLE.engine }
}

const SPEC_PATH = /specs\/\d{4}-[\w-]+\.md/

/**
 * The spec a run worked on, first hit of: `args` as a plain string; `.spec`
 * of `args` when it is JSON (the driver's `{ spec, config }`) or already an
 * object; `result.spec`; the ledger row's `spec` (shown as is, `0002 album-…`);
 * a `specs/NNNN-slug.md` in any agent's prompt preview; else `—`.
 */
export function specOf(run?: RunManifest, ledger?: Ledger): string {
  const args = run?.args
  if (typeof args === 'string' && args.trim()) {
    const a = args.trim()
    if (!a.startsWith('{')) return a
    try { const o = JSON.parse(a); if (o && typeof o.spec === 'string' && o.spec.trim()) return o.spec.trim() } catch { /* not JSON: fall through */ }
  } else if (args && typeof args === 'object' && typeof (args as { spec?: unknown }).spec === 'string') {
    const spec = (args as { spec: string }).spec.trim()
    if (spec) return spec
  }
  const r = run?.result as { spec?: unknown } | null | undefined
  if (r && typeof r === 'object' && typeof r.spec === 'string' && r.spec.trim()) return r.spec.trim()
  const row = run?.runId ? ledger?.[run.runId] : undefined
  if (row?.spec?.trim()) return row.spec.trim()
  for (const a of agentsOf(run)) {
    const m = SPEC_PATH.exec(a.promptPreview ?? '')
    if (m) return m[0]
  }
  return dash
}

/** `specs/0001-share-pressed-card.md` → `0001-share-pressed-card`; `—` stays. */
export function specShort(spec?: string): string {
  if (!spec) return dash
  return spec.replace(/^specs\//, '').replace(/\.md$/, '')
}

/**
 * The spec as a path a driver can take (`scripts/factory-run.sh specs/…md`),
 * from whatever `specOf` found: a path as is, the ledger's own cell shape
 * (`0002 album-position-gate-blind-spots`) rebuilt, `—` and anything else
 * `undefined` — the caller then has no run to bind a command to.
 */
export function specPath(spec?: string): string | undefined {
  if (!spec || spec === dash) return undefined
  const m = SPEC_PATH.exec(spec)
  if (m) return m[0]
  const row = /^(\d{4})[ -]([\w-]+?)(?:\.md)?$/.exec(spec.trim())
  return row ? `specs/${row[1]}-${row[2]}.md` : undefined
}

// --- the account window ------------------------------------------------------

/**
 * The account-window stop, as the engine writes it into the failing agent's
 * `error`: `You've hit your session limit · resets 4:40pm (Asia/Jerusalem)`
 * (`wf_66ec6c31-e3f`, review:1 and fix:review). Exported for slice 2's
 * classifier, which needs the same match plus the rest of the rule table.
 */
export const SESSION_LIMIT_RE = /hit your session limit/i
const RESETS_RE = /resets\s+([^·\n]+)/i

/** The first agent stopped by the account window: when it resets, where it stopped, and the one line to show. Nothing when no agent hit it. */
export function sessionLimit(run?: RunManifest): { text: string; resets?: string; at?: string } | undefined {
  for (const a of agentsOf(run)) {
    if (typeof a.error !== 'string' || !SESSION_LIMIT_RE.test(a.error)) continue
    const resets = RESETS_RE.exec(a.error)?.[1]?.trim()
    return { resets, at: labelOf(a), text: resets ? `session limit — resets ${resets}; re-run after` : 'session limit — re-run once the window resets' }
  }
  return undefined
}

/** Is the run still going (as far as the plugin can tell)? */
export function isLive(run?: RunManifest): boolean {
  return !!run && (run.live === true || run.status === 'running')
}

/** Elapsed: a live run counts from its start (never less than what it already reported); a stale or finished one is what the manifest says. */
export function elapsedOf(run: RunManifest | undefined, now: number = Date.now()): number | undefined {
  const start = startOf(run)
  return isLive(run) && !isStalled(run) && start != null ? Math.max(now - start, run?.durationMs ?? 0) : run?.durationMs
}

/** The colour behind the outcome word: red for a stop a human must look at, amber while it moves or went cold, accent for a result, muted for the rest. */
export function toneOf(run: RunManifest | undefined, outcome: ReturnType<typeof outcomeOf>): 'ok' | 'err' | 'warn' | 'muted' {
  if (!run) return 'muted'
  if (outcome.source === 'result') return outcome.word === 'needs-human' ? 'err' : 'ok'
  if (outcome.word === 'error' || outcome.word === 'killed') return 'err'
  if (outcome.word === 'running' || isStalled(run)) return 'warn'
  return 'muted'
}

/**
 * Cost, which only the ledger knows: `$3.92` from the RUNS.md row; a run in
 * progress has no row yet; a finished run without one is missing from the
 * ledger; a fixture never had one.
 */
export function usdOf(run?: RunManifest, ledger?: Ledger): { text: string; title: string } {
  if (run?.fixture) return { text: dash, title: 'fixture run — no ledger row' }
  const cost = run?.runId ? ledger?.[run.runId]?.cost : undefined
  if (cost != null && Number.isFinite(cost)) return { text: fmtUsd(cost), title: 'from docs/factory/RUNS.md' }
  if (isLive(run)) return { text: 'no cost yet', title: 'written to RUNS.md when the driver finishes' }
  return { text: 'not in RUNS.md', title: 'docs/factory/RUNS.md has no row for this run id' }
}

/** Where a run went wrong: the first agent (by index) whose settled state is `error` → `stopped at <label>`. Nothing when none did. */
export function stoppedAt(run?: RunManifest): string | undefined {
  const agents = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const hit = agents.find((a) => stateAt(a) === 'error')
  return hit ? `stopped at ${labelOf(hit)}` : undefined
}

/** `<phase> › <label>`, or the label alone when the agent has no phase. */
export function whereOf(a: WorkflowAgentEntry): string {
  return a.phaseTitle ? `${a.phaseTitle} › ${labelOf(a)}` : labelOf(a)
}

/** Why the engine stopped, worded once for the header, the card and the rail's tooltips (IA-SPEC §1.3, §2, §6). */
export const RUN_COPY = {
  stale: 'nothing moved for 15 min; the session may have ended without a manifest',
  killed: 'stopped by --max-budget-usd / --max-turns',
} as const

/**
 * Why the engine stopped, the first that applies: stale (with the agent it
 * was last at), killed (with the first error agent, if any), the first error
 * agent; nothing when the run simply finished.
 */
export function stopReason(run?: RunManifest): string | undefined {
  if (!run) return undefined
  if (isStalled(run)) {
    const agents = agentsOf(run).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const last = agents.filter((a) => a.state === 'running' || a.state === 'progress' || a.state === 'queued').pop() ?? agents[agents.length - 1]
    return last ? `${RUN_COPY.stale} · last at ${whereOf(last)}` : RUN_COPY.stale
  }
  if (run.status === 'killed' || run.status === 'cancelled') {
    const at = stoppedAt(run)
    return at ? `${RUN_COPY.killed} · ${at}` : RUN_COPY.killed
  }
  return stoppedAt(run)
}

/** Live only: `running <phase> › <label> for <elapsed>` for the last agent still going, else `between steps`. */
export function nowAt(run?: RunManifest, now: number = Date.now()): string | undefined {
  if (!isLive(run)) return undefined
  const running = agentsOf(run).filter((a) => a.state === 'running' || a.state === 'progress')
  const a = running[running.length - 1]
  if (!a) return 'between steps'
  const where = whereOf(a)
  const started = toMs(a.startedAt)
  return started != null ? `running ${where} for ${fmtDuration(Math.max(0, now - started))}` : `running ${where}`
}

/** The newest timestamp any agent of the run wrote (the run's own `lastProgressAt` first); nothing when none ever did. */
export function lastProgressAt(run?: RunManifest): number | undefined {
  const ts = agentsOf(run).map((a) => a.lastProgressAt).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return toMs(run?.lastProgressAt) ?? (ts.length ? Math.max(...ts) : undefined)
}

/** `last progress 9m ago` from `lastProgressAt`; nothing when no agent ever wrote one. */
export function lastProgress(run?: RunManifest, now: number = Date.now()): string | undefined {
  const t = lastProgressAt(run)
  return t == null ? undefined : `last progress ${whenRel(t, now)}`
}
