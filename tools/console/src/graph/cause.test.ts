import test from 'node:test'
import assert from 'node:assert/strict'
import type { RunManifest } from '../types'
import { classify, findingsOf, firedOn } from './cause'

// One case per row of the rule table (docs/factory/console-simplification.md §2),
// plus the two real runs on this machine that the table was written from —
// their fields copied verbatim (jq'd out of
// ~/.claude/projects/-Users-nadavgross-Projects-mixtape-poc*/…/workflows/*.json
// on 2026-08-30), because the interesting bug is an ordering bug and only a real
// manifest has both signals at once.
//
// Run: `npm test` in tools/console (Node ≥ 22.18 strips the types; the resolve
// hook in test/ lets these extensionless imports find their .ts files).

const LIMIT = "You've hit your session limit · resets 4:40pm (Asia/Jerusalem)"

/** wf_66ec6c31-e3f — the trap: `review.verdict: 'fail'` (so a naive rule says *spec*) with the reviewer's "returned nothing" placeholder and the account window in both the agent errors and the logs. */
const TRAP: RunManifest = {
  runId: 'wf_66ec6c31-e3f',
  workflowName: 'implement-from-spec',
  status: 'completed',
  source: 'manifest',
  startTime: 1788003424113,
  durationMs: 566042,
  logs: [
    'implement: gate-passed after 1 gate run(s) — Widened the album-word set …',
    'gate 1: passed',
    `[review:1] failed: ${LIMIT}`,
    `[fix:review] failed: ${LIMIT}`,
  ],
  result: {
    status: 'needs-human',
    spec: 'specs/0002-album-position-gate-blind-spots.md',
    attempts: { implement: 2, gate: 1, review: 1 },
    reason: 'review fix round escalated: no result',
    review: {
      verdict: 'fail',
      findings: [{ file: '', line: 0, severity: 'high', title: 'reviewer returned nothing', why: 'no structured output from the reviewer agent' }],
    },
    implemented: { status: 'gate-passed', attempts: 1, notes: 'Widened the album-word set …' },
  },
  workflowProgress: [
    { type: 'workflow_agent', index: 1, label: 'implement', phaseTitle: 'Implement', state: 'done', attempt: 1 },
    { type: 'workflow_agent', index: 2, label: 'gate:1', phaseTitle: 'Gate', state: 'done', attempt: 1 },
    { type: 'workflow_agent', index: 3, label: 'contract:1', phaseTitle: 'Review', state: 'done', attempt: 1 },
    { type: 'workflow_agent', index: 4, label: 'review:1', phaseTitle: 'Review', state: 'error', attempt: 1, error: LIMIT },
    { type: 'workflow_agent', index: 5, label: 'fix:review', phaseTitle: 'Implement', state: 'error', attempt: 1, error: LIMIT },
  ],
}

/** wf_2a52cfdf-b8a — a `--max-budget-usd` stop: `status: killed`, an abort error, no result, one agent frozen in `progress`. */
const KILLED: RunManifest = {
  runId: 'wf_2a52cfdf-b8a',
  workflowName: 'implement-from-spec',
  status: 'killed',
  source: 'manifest',
  logs: [],
  result: null,
  error: 'Error: Workflow aborted\n    at u (/$bunfs/root/chunk-xdx612ep.js:79:5190)\n    at abort (unknown)',
  workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'implement', state: 'progress', attempt: 1 }],
}

const run = (m: Partial<RunManifest>): RunManifest => ({ runId: 'wf_test', status: 'completed', source: 'manifest', ...m })
const needsHuman = (result: Record<string, unknown>, m: Partial<RunManifest> = {}) => run({ result: { status: 'needs-human', ...result }, ...m })

test('the real trap: session limit beats the reviewer verdict', () => {
  const v = classify(TRAP)
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'session-limit')
  assert.equal(v.at, 'review:1')
  assert.equal(v.evidence, LIMIT)
  assert.match(v.action, /resets 4:40pm \(Asia\/Jerusalem\)/)
  assert.match(v.action, /nothing about the spec is known yet/)
  assert.ok(v.headline.split(/\s+/).length <= 8, v.headline)
  // the placeholder finding is not a finding about the diff
  assert.deepEqual(findingsOf(TRAP), [])
})

test('the real killed run: budget', () => {
  const v = classify(KILLED)
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'budget')
  assert.equal(v.evidence, 'Error: Workflow aborted')
  assert.match(v.action, /--max-budget-usd/)
})

test('rule 1 — the account window from the logs alone (a journal-derived run)', () => {
  const v = classify(run({ status: 'completed', logs: [`[review:1] failed: ${LIMIT}`], result: { status: 'needs-human', reason: 'x' } }))
  assert.equal(v.kind, 'session-limit')
  assert.equal(v.at, 'review:1')
  assert.equal(v.evidence, `[review:1] failed: ${LIMIT}`)
})

test('rule 2 — an abort error without a killed status is still a hard stop', () => {
  const v = classify(run({ status: 'failed', error: 'Error: Workflow aborted\n    at u (…)' }))
  assert.equal(v.kind, 'budget')
})

test('rule 3 — swept: stale, no terminal manifest', () => {
  const m = run({
    status: 'stale', source: 'journal', live: false,
    workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'implement', state: 'running' }],
  })
  const v = classify(m)
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'swept')
  assert.equal(v.at, 'implement')
  assert.match(v.action, /without a manifest/)
  // the same run with the rail's verdict passed in
  assert.equal(classify({ ...m, status: 'running' }, { stale: true }).kind, 'swept')
  // …and not stale: it is simply still going
  assert.equal(classify({ ...m, status: 'running', live: true }, { stale: false }).cause, 'running')
})

test('rule 4 — gate step 0, an ask-tier file differs from origin/main', () => {
  const v = classify(needsHuman({ reason: 'gate still failing at "ask-tier check" after 2 round(s)', gate: { ok: false, step: 'ask-tier check', log: 'server/caps.ts differs from origin/main' } }))
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'ask-tier')
  assert.match(v.action, /FACTORY_ASK_OK=1/)
  assert.equal(v.evidence, 'server/caps.ts differs from origin/main')
})

test('rule 5 — the agent died and the reason erased it', () => {
  const v = classify(needsHuman(
    { reason: 'fix round 1 escalated: no result' },
    { workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'fix:gate-1', state: 'error', error: 'the agent process exited\n  stack' }] },
  ))
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'agent-died')
  assert.equal(v.at, 'fix:gate-1')
  assert.equal(v.evidence, 'the agent process exited')
})

test('rule 5 — two dead agents: the reason says which phase it is about', () => {
  const both: Partial<RunManifest> = {
    workflowProgress: [
      { type: 'workflow_agent', index: 1, label: 'implement', state: 'error', error: 'the implement agent exited\n  stack' },
      { type: 'workflow_agent', index: 2, label: 'gate:1', state: 'done' },
      { type: 'workflow_agent', index: 3, label: 'review:1', state: 'error', error: 'the reviewer agent exited\n  stack' },
    ],
  }
  // the reason names the second phase — the review agent's error is the story, not the first error by index
  const review = classify(needsHuman({ reason: 'review fix round escalated: no result' }, both))
  assert.equal(review.kind, 'agent-died')
  assert.equal(review.at, 'review:1')
  assert.equal(review.evidence, 'the reviewer agent exited')
  // the same manifest with a reason that names the first phase still points at it
  const implement = classify(needsHuman({ reason: 'implement returned nothing' }, both))
  assert.equal(implement.at, 'implement')
  assert.equal(implement.evidence, 'the implement agent exited')
  // a reason that names no phase falls back to the first errored agent
  assert.equal(classify(needsHuman({ reason: 'the step returned nothing' }, both)).at, 'implement')
})

test('rule 5 does not fire without an error to point at', () => {
  assert.equal(classify(needsHuman({ reason: 'the implement agent returned nothing' })).kind, 'unknown')
})

test('rule 6 — the reviewer failed the diff with real findings', () => {
  const v = classify(needsHuman({
    reason: 'reviewer failed the diff twice',
    review: { verdict: 'fail', findings: [{ file: 'server/curator.ts', line: 12, severity: 'high', title: 'acceptance check 3 not covered', why: 'no test asserts the closer row' }] },
  }))
  assert.equal(v.cause, 'spec')
  assert.equal(v.kind, 'reviewer-fail')
  assert.match(v.action, /acceptance checks/)
})

test('rule 7 — the implementer escalated', () => {
  const v = classify(needsHuman({ reason: 'implementer escalated: the spec asks for two conflicting behaviours', implemented: { status: 'escalated', notes: 'the spec asks for two conflicting behaviours' } }))
  assert.equal(v.cause, 'spec')
  assert.equal(v.kind, 'implementer-escalated')
  assert.equal(v.evidence, 'the spec asks for two conflicting behaviours')
})

test('rule 8 — the gate never went green', () => {
  const v = classify(needsHuman({ reason: 'gate still failing at "unit tests" after 2 round(s)', gate: { ok: false, step: 'unit tests', log: '1 test failed\n  curator.test.ts' } }))
  assert.equal(v.cause, 'spec')
  assert.equal(v.kind, 'gate-failing')
  assert.match(v.action, /"unit tests"/)
  assert.equal(v.evidence, '1 test failed')
})

test('rule 9 — anything else', () => {
  const v = classify(needsHuman({ reason: 'something nobody has a rule for yet' }))
  assert.equal(v.cause, 'unknown')
  assert.equal(v.action, 'Open the transcript.')
  assert.equal(v.evidence, 'something nobody has a rule for yet')
  assert.equal(classify(undefined).cause, 'unknown')
})

test('a returned outcome that is not the escalation is ok — nothing to handle', () => {
  for (const status of ['ready-for-pr', 'ready-for-eval', 'reviewed']) {
    const v = classify(run({ result: { status, reason: 'gate passed and the reviewer passed the diff' } }))
    assert.equal(v.cause, 'ok', status)
  }
  // the script's own words when a run ever carries them: the last is the escalation
  const meta = { meta: { outcomes: ['reviewed', 'blocked'] } } as Partial<RunManifest>
  assert.equal(classify(run({ result: { status: 'blocked', reason: 'x' }, ...meta })).cause, 'unknown')
  assert.equal(classify(run({ result: { status: 'needs-human', reason: 'x' }, ...meta })).cause, 'ok')
})

test('a live run is running, not stopped', () => {
  assert.equal(classify(run({ status: 'running', live: true, result: null })).cause, 'running')
})

test("the script's own `cause` wins over the table's class", () => {
  const v = classify(needsHuman({ reason: 'gate still failing at "unit tests" after 2 round(s)', cause: 'infra', gate: { ok: false, step: 'unit tests' } }))
  assert.equal(v.cause, 'infra')
  assert.equal(v.kind, 'gate-failing') // the kind, headline and action still come from the signals
})

test('firedOn highlights the log line the rule fired on', () => {
  const v = classify(TRAP)
  const hits = (TRAP.logs ?? []).map((l) => firedOn(l, v))
  assert.deepEqual(hits, [false, false, true, true])
  assert.equal(firedOn('gate 1: passed', classify(KILLED)), false)
})
