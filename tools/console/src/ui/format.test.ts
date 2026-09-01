import test from 'node:test'
import assert from 'node:assert/strict'
import type { RunManifest } from '../types'
import { baseName, driverSummary, isoDate, ledgerLine, prefillRow, repoRel, rowValuesOf, specCell } from './format'

// The context row's own readings (§4). The header below is docs/factory/RUNS.md's,
// verbatim — the point of prefillRow is that the row follows the file's column
// order rather than a hardcoded one, so the test reorders it too.

const HEADER = ['date', 'spec', 'engine', 'attempts (impl/gate/review)', 'gate', 'review', 'outcome', 'cost (USD)', 'run', 'notes']

const RUN: RunManifest = {
  runId: 'wf_66ec6c31-e3f',
  workflowName: 'implement-from-spec',
  status: 'completed',
  startTime: Date.parse('2026-08-29T14:37:04'),
  durationMs: 566042,
  agentCount: 5,
  totalTokens: 180_000,
  git: { branch: 'factory/0002-album-position-gate-blind-spots', cwd: '/Users/x/Projects/mixtape-poc.wt' },
  result: {
    status: 'needs-human',
    spec: 'specs/0002-album-position-gate-blind-spots.md',
    attempts: { implement: 2, gate: 1, review: 1 },
    gate: { ok: true },
    review: { verdict: 'fail', findings: [{ title: 'reviewer returned nothing' }] },
  },
}

test('prefillRow follows the file’s column order', () => {
  const row = prefillRow(HEADER, { date: '2026-08-29', spec: '0002 x', outcome: 'needs-human', notes: 'n' })
  assert.equal(row, '| 2026-08-29 | 0002 x |  |  |  |  | needs-human |  |  | n |')
  const flipped = prefillRow(['run', 'date', 'notes'], { date: 'd', run: 'r', notes: 'n' })
  assert.equal(flipped, '| r | d | n |')
})

test('prefillRow leaves a column it knows nothing about empty', () => {
  assert.equal(prefillRow(['date', 'reviewer mood'], { date: 'd' }), '| d |  |')
})

test('rowValuesOf reads the run, and never invents a cost', () => {
  const v = rowValuesOf(RUN)
  assert.equal(v.date, '2026-08-29')
  assert.equal(v.spec, '0002 album-position-gate-blind-spots')
  assert.equal(v.engine, 'native `/implement-from-spec`')
  assert.equal(v.attempts, '2 / 1 / 1')
  assert.equal(v.gate, 'passed')
  assert.equal(v.review, 'fail, 1 finding')
  assert.equal(v.outcome, 'needs-human')
  assert.equal(v.cost, undefined)
  assert.match(v.run!, /^`wf_66ec6c31-e3f` · 5 agents · 180k tok · 9m 26s$/)
  assert.match(v.notes!, /^branch factory\/0002-album-position-gate-blind-spots · worktree \/Users\/x\/Projects\/mixtape-poc\.wt/)
  assert.deepEqual(rowValuesOf(undefined), {})
})

test('a gate that failed names its step', () => {
  const v = rowValuesOf({ ...RUN, result: { gate: { ok: false, step: 'ask-tier check' } } })
  assert.equal(v.gate, 'failed at ask-tier check')
})

test('repoRel converts a driver path and refuses anything else', () => {
  assert.equal(repoRel('/Users/x/Projects/mixtape-poc/docs/factory/runs/2026-08-30-0002.json'), 'docs/factory/runs/2026-08-30-0002.json')
  assert.equal(repoRel('/Users/x/.claude/projects/-slug/session/workflows/wf_1.json'), undefined)
  assert.equal(repoRel(undefined), undefined)
})

test('driverSummary words the extract, session limit over the raw stop', () => {
  assert.equal(
    driverSummary({ cost: 2.9338674999999994, numTurns: 5, stopReason: 'completed', isError: false }),
    '$2.93 · 5 turns · stopped: completed',
  )
  assert.equal(
    driverSummary({ cost: 2.7352977999999997, numTurns: 1, stopReason: 'api_error', isError: true, apiErrorStatus: 429, sessionLimited: true, sessionLimitResets: '4:40pm (Asia/Jerusalem)' }),
    'error · $2.74 · 1 turn · session limit, resets 4:40pm (Asia/Jerusalem)',
  )
  assert.equal(driverSummary({ isError: true, sessionLimited: true }), 'error · session limit')
  assert.equal(driverSummary({ resultHead: 'words only' }), undefined)
  assert.equal(driverSummary(undefined), undefined)
})

test('baseName, specCell, isoDate, ledgerLine', () => {
  assert.equal(baseName('/a/b/2026-08-29-0002-attempt3.pr.md'), '2026-08-29-0002-attempt3.pr.md')
  assert.equal(baseName(undefined), '—')
  assert.equal(specCell('specs/0002-album-position-gate-blind-spots.md'), '0002 album-position-gate-blind-spots')
  assert.equal(specCell('0002 album-position-gate-blind-spots'), '0002 album-position-gate-blind-spots')
  assert.equal(specCell('—'), undefined)
  assert.equal(isoDate(Date.parse('2026-08-30T09:05:00')), '2026-08-30')
  assert.equal(isoDate(undefined), undefined)
  assert.equal(ledgerLine({ outcome: 'autonomous', notes: 'attempt 4' }), 'autonomous — attempt 4')
  assert.equal(ledgerLine({ outcome: 'autonomous' }), 'autonomous')
  assert.equal(ledgerLine(undefined), undefined)
})
