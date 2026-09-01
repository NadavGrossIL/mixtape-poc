import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDriver } from './driverExtract'

// Field values from the real envelopes on disk: docs/factory/runs/
// 2026-08-30-0002.json (a clean finish) and 2026-08-29-0002-attempt3.json
// (the 429 session-limit stop) — the two shapes the summary line must read.

test('a clean finish: cost, turns, terminal_reason over stop_reason', () => {
  const x = extractDriver({
    duration_api_ms: 709939,
    stop_reason: 'end_turn',
    total_cost_usd: 2.9338674999999994,
    terminal_reason: 'completed',
    is_error: false,
    num_turns: 5,
    api_error_status: null,
    result: 'Workflow `wf_2d570cca-1ac` finished: **ready-for-eval**, one attempt at each phase.\n\nMore lines follow.',
  })
  assert.equal(x?.cost, 2.9338674999999994)
  assert.equal(x?.numTurns, 5)
  assert.equal(x?.stopReason, 'completed')
  assert.equal(x?.isError, false)
  assert.equal(x?.apiErrorStatus, undefined) // null is not a status
  assert.equal(x?.sessionLimited, undefined)
  assert.match(x?.resultHead ?? '', /^Workflow `wf_2d570cca-1ac` finished: \*\*ready-for-eval\*\*, one attempt at each phase\. More lines follow\.$/)
})

test('the 429 stop: session limit and its reset tail', () => {
  const x = extractDriver({
    stop_reason: 'stop_sequence',
    total_cost_usd: 2.7352977999999997,
    terminal_reason: 'api_error',
    is_error: true,
    num_turns: 1,
    api_error_status: 429,
    result: "You've hit your session limit · resets 4:40pm (Asia/Jerusalem)",
  })
  assert.equal(x?.isError, true)
  assert.equal(x?.apiErrorStatus, 429)
  assert.equal(x?.stopReason, 'api_error')
  assert.equal(x?.sessionLimited, true)
  assert.equal(x?.sessionLimitResets, '4:40pm (Asia/Jerusalem)')
})

test('a long result is clipped and whitespace-collapsed', () => {
  const x = extractDriver({ result: 'a '.repeat(300) })
  assert.equal(x?.resultHead?.length, 200)
  assert.ok(x?.resultHead?.endsWith('…'))
  assert.ok(!x?.resultHead?.includes('  '))
})

test('garbage in, nothing out', () => {
  assert.equal(extractDriver(null), undefined)
  assert.equal(extractDriver(undefined), undefined)
  assert.equal(extractDriver('not an object'), undefined)
  assert.equal(extractDriver([1, 2]), undefined)
  assert.equal(extractDriver(42), undefined)
})

test('an object with none of the fields, or the wrong types, is nothing', () => {
  assert.equal(extractDriver({}), undefined)
  assert.equal(extractDriver({ total_cost_usd: 'expensive', num_turns: NaN, result: '   ' }), undefined)
})
