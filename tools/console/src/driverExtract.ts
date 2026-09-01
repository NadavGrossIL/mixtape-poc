import type { DriverExtract } from './types'
import { SESSION_LIMIT_RE } from './graph/signals'

// The driver's saved `claude -p` result envelope, boiled down to the fields a
// reader acts on: what it cost, how many turns, why it stopped. Pure — the
// plugin runs it once per docs/factory/runs/*.json when it builds the ledger,
// so the page never has to open the raw file to answer those.

const RESULT_HEAD = 200
// signals.ts owns the session-limit sentence; the reset tail is the same shape
// its private parser reads out of an agent's error.
const RESETS_RE = /resets\s+([^·\n]+)/i

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** Nothing when the input is not an object or carries none of the fields — a truncated or foreign JSON degrades to the raw-file row, not a crash. */
export function extractDriver(j: unknown): DriverExtract | undefined {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const o = j as Record<string, unknown>
  const out: DriverExtract = {}
  if (isNum(o.total_cost_usd)) out.cost = o.total_cost_usd
  if (isNum(o.num_turns)) out.numTurns = o.num_turns
  const stop = str(o.terminal_reason) ?? str(o.stop_reason)
  if (stop) out.stopReason = stop
  if (typeof o.is_error === 'boolean') out.isError = o.is_error
  if (isNum(o.api_error_status)) out.apiErrorStatus = o.api_error_status
  if (typeof o.result === 'string' && o.result.trim()) {
    const head = o.result.trim().replace(/\s+/g, ' ')
    out.resultHead = head.length > RESULT_HEAD ? head.slice(0, RESULT_HEAD - 1) + '…' : head
    if (SESSION_LIMIT_RE.test(o.result)) {
      out.sessionLimited = true
      const resets = RESETS_RE.exec(o.result)?.[1]?.trim()
      if (resets) out.sessionLimitResets = resets
    }
  }
  return Object.keys(out).length ? out : undefined
}
