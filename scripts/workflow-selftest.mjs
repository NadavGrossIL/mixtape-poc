#!/usr/bin/env node
// Offline selftest for the orchestration logic in .claude/workflows/*.js —
// no API calls, no cost, no filesystem for the script under test. The
// workflow scripts are never-tier (a human edits them, or the console's
// Script tab writes them), so the cheapest way to catch a broken line is to
// run it here against stub agents before a real run spends money on it.
//
// The harness runs these scripts as plain JavaScript in an async context
// with globals `agent`, `parallel`, `pipeline`, `log`, `phase`, `args`,
// `budget`, `workflow`; `Date.now()`, `Math.random()` and `new Date()` throw;
// there is no filesystem. The loader below reproduces that shape — and is
// stricter where this factory is: `parallel`/`pipeline` throw, because the
// agents share one working tree and the line is sequential on purpose.
//
// Usage:
//   node scripts/workflow-selftest.mjs
//   WORKFLOWS_DIR=/some/dir node scripts/workflow-selftest.mjs   # test-only: point at a copy
//
// Exit 1 if any case fails. Unknown scripts get the meta sanity case and a SKIP line.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || path.join(ROOT, '.claude', 'workflows')

// --- loader ---------------------------------------------------------------------

const denied = (what) => () => { throw new Error(`${what} is not allowed in a workflow script`) }
const notHere = (what) => () => { throw new Error(`${what} not allowed in this factory: sequential agents only`) }
// Date is both callable and constructible in the harness; both paths throw.
function DateShim() { throw new Error('Date is not allowed in a workflow script') }
DateShim.now = denied('Date.now()')
const MathShim = Object.create(Math, { random: { value: denied('Math.random()') } })

/** Index of the `}` closing the object literal opening at `open`, skipping string literals. */
function closeOf(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') { i++; while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1; continue }
    if (c === '{') depth++
    if (c === '}' && --depth === 0) return i
  }
  throw new Error('meta object literal never closes')
}

/** { meta, run } for one script: meta evaluated on its own, the body wrapped as the harness wraps it. */
function load(file) {
  const src = readFileSync(file, 'utf8')
  const m = /^export\s+const\s+meta\s*=\s*\{/m.exec(src)
  if (!m) throw new Error('no `export const meta = {` at top level')
  const open = m.index + m[0].length - 1
  const meta = new Function(`return ${src.slice(open, closeOf(src, open) + 1)}`)()
  const body = src.slice(0, m.index) + src.slice(m.index + 'export '.length)
  // The body has top-level `await` and `return`, so it lives inside the async
  // function; the shims are parameters so they shadow the real globals.
  const factory = new Function(
    'parallel', 'pipeline', 'budget', 'workflow', 'Date', 'Math', 'process', 'require',
    `return async function run(args, agent, log, phase) {\n${body}\n}`,
  )
  const run = factory(notHere('parallel'), notHere('pipeline'), {}, { name: meta.name }, DateShim, MathShim, undefined, undefined)
  return { meta, run }
}

// --- harness ---------------------------------------------------------------------

const allCalls = [] // every agent call from every case, for the cross-cutting checks

/** An `agent` that records every call and answers by the first handler whose key prefixes opts.label. */
function stub(handlers) {
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts }
    calls.push(call)
    allCalls.push(call)
    const key = Object.keys(handlers).find((k) => String(opts.label).startsWith(k))
    if (!key) throw new Error(`no stub for label ${JSON.stringify(opts.label)}`)
    const h = handlers[key]
    return typeof h === 'function' ? h(prompt, opts) : h
  }
  return { agent, calls }
}

/** Run a script with args against stubs; returns the result and the recorded calls. */
async function drive(wf, args, handlers) {
  const { agent, calls } = stub(handlers)
  const result = await wf.run(args, agent, () => {}, () => {})
  return { result, calls, labels: calls.map((c) => c.opts.label) }
}

let passed = 0, failed = 0, skipped = 0
function ok(cond, detail) { if (!cond) throw new Error(detail) }
function same(actual, expected, what) { ok(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`) }
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed++; console.log(`FAIL ${name} — ${e.message}`) }
}

// --- stubs shared by the implement-from-spec cases ----------------------------------

const IMPLEMENTED = { status: 'gate-passed', attempts: 1, files: ['client/src/App.tsx'], notes: 'done' }
const GATE_OK = { ok: true, step: '', log: '== gate passed in 40s' }
const GATE_FAIL = { ok: false, step: 'unit tests', log: 'not ok 1 - share button' }
const CONTRACT = { goal: 'A Share control on the pressed card.', checks: '- copies the link', touchesPrompt: false }
const PASS = { verdict: 'pass', findings: [] }
const FAIL = { verdict: 'fail', findings: [{ file: 'client/src/App.tsx', line: 12, severity: 'high', title: 'no share', why: 'missing' }] }
const happy = () => ({ implement: IMPLEMENTED, fix: IMPLEMENTED, gate: GATE_OK, contract: CONTRACT, review: PASS })
/** A handler that answers from a queue, then repeats the last answer. */
const seq = (...answers) => () => (answers.length > 1 ? answers.shift() : answers[0])

// --- per-script cases (keyed by script name) ------------------------------------------

const CASES = {
  async 'implement-from-spec'(wf) {
    const SPEC = 'specs/0001-share-pressed-card.md'
    const noModel = (calls, label) => ok(!('model' in calls.find((c) => c.opts.label === label).opts), `${label} opts carry a model`)

    await check('meta: name and phases', () => {
      same(wf.meta.name, 'implement-from-spec', 'name')
      same(wf.meta.phases.map((p) => p.title), ['Implement', 'Gate', 'Review'], 'phase titles')
    })
    await check('no args → needs-human, no agent calls', async () => {
      const { result, calls } = await drive(wf, undefined, {})
      same(result.status, 'needs-human', 'status'); same(calls.length, 0, 'calls')
    })
    let happyCalls // kept for the reviewer-prompt case below
    await check('plain spec path, everything passes → ready-for-pr', async () => {
      const { result, calls, labels } = await drive(wf, SPEC, happy())
      happyCalls = calls
      same(result.status, 'ready-for-pr', 'status')
      same(labels, ['implement', 'gate:1', 'contract:1', 'review:1'], 'labels')
      noModel(calls, 'implement')
      same(calls[3].opts.agentType, 'reviewer', 'review agentType')
      same(calls[1].opts.effort, 'low', 'gate effort'); same(calls[2].opts.effort, 'low', 'contract effort')
    })
    await check('JSON args with implementModel, touches_prompt → ready-for-eval', async () => {
      const args = JSON.stringify({ spec: 'specs/0002-x.md', config: { implementModel: 'sonnet', maxGateRounds: 2 } })
      const { result, calls } = await drive(wf, args, { ...happy(), contract: { ...CONTRACT, touchesPrompt: true } })
      same(result.status, 'ready-for-eval', 'status')
      same(calls[0].opts.model, 'sonnet', 'implement model')
      for (const l of ['gate:1', 'contract:1', 'review:1']) noModel(calls, l)
    })
    await check('malformed JSON args → needs-human, no agent calls', async () => {
      const { result, calls } = await drive(wf, '{not json', {})
      same(result.status, 'needs-human', 'status'); same(calls.length, 0, 'calls')
    })
    await check('gate fails once, fix, passes → ready-for-pr', async () => {
      const { result, labels } = await drive(wf, SPEC, { ...happy(), gate: seq(GATE_FAIL, GATE_OK) })
      same(result.status, 'ready-for-pr', 'status')
      same(labels, ['implement', 'gate:1', 'fix:gate-1', 'gate:2', 'contract:1', 'review:1'], 'labels')
      same(result.attempts, { implement: 2, gate: 2, review: 1 }, 'attempts')
    })
    await check('gate fails twice → needs-human naming the step, no review', async () => {
      const { result, labels } = await drive(wf, SPEC, { ...happy(), gate: GATE_FAIL })
      same(result.status, 'needs-human', 'status')
      ok(result.reason.includes(GATE_FAIL.step), `reason does not name the step: ${result.reason}`)
      ok(!labels.some((l) => l.startsWith('review')), `review ran: ${labels}`)
    })
    await check('review fails twice → needs-human after one fix round', async () => {
      const { result, labels } = await drive(wf, SPEC, { ...happy(), review: FAIL })
      same(result.status, 'needs-human', 'status')
      same(result.attempts.review, 2, 'attempts.review')
      same(labels.slice(-4), ['fix:review', 'gate:after-review-fix', 'contract:2', 'review:2'], 'last labels')
    })
    await check('implement agent returns null → needs-human, no throw', async () => {
      const { result } = await drive(wf, SPEC, { ...happy(), implement: null })
      same(result.status, 'needs-human', 'status')
    })
    await check('reviewer prompt: contract headings and base, no run record', () => {
      ok(happyCalls, 'the happy-path case above did not complete')
      const p = happyCalls.find((c) => c.opts.label === 'review:1').prompt
      for (const h of ['## Goal', '## Acceptance checks', '## Where the work is', 'base: origin/main']) ok(p.includes(h), `missing "${h}"`)
      ok(!/Run record/.test(p), 'the reviewer was handed the run record')
    })
  },

  // The spec-review panel (Check → Clarity → Craft → Apply). The stubs mirror
  // the hand-run panel in docs/reviews/0002-spec-panel-2026-08-29.md at a
  // toy size: one wrong claim, one fragile, three must-adds, one decision.
  async 'review-spec'(wf) {
    const SPEC = 'specs/0002-album-position-gate-blind-spots.md'
    const WRONG = { claim: 'Test 2: "record" is nine tokens after closer', verdict: 'WRONG', correction: 'it is the tenth token after closer; still outside the 5-token window', where: 'server/curator.ts albumPositionContext, replayed with node -e' }
    const FRAGILE = { claim: 'all cited line numbers in server/curator.ts', verdict: 'FRAGILE', correction: 'cite the function name next to each line', where: 'server/curator.ts at HEAD' }
    const RIGHT = { claim: '61 curator tests pass at HEAD', verdict: 'VERIFIED', correction: '', where: 'node --test server/test/curator.test.ts' }
    const CHECK_OK = { claims: [WRONG, FRAGILE, RIGHT], design: [{ concern: 'rule precedence', why: 'the object guard must run before the album-word window or slice 3 stays red' }], summary: '3 claims, 1 wrong, 1 fragile' }
    const CLARITY_OK = {
      mustAdd: [
        { where: '## Acceptance checks', text: 'node --test server/test/curator.test.ts   # red on slice 1 first, then all green', why: 'cd server && … is not on the implement skill allowlist' },
        { where: '## Notes', text: 'Token = the existing albumPositionContext split (whitespace, non-letters stripped); the keyword itself is not counted.', why: 'two readings of "token"' },
      ],
      leaveToBuilder: [{ note: 'SYSTEM is exported and already imported in the test file' }],
    }
    const CRAFT_OK = {
      mustAdd: [{ where: '## Notes', text: 'The table is the fixture, not the cache: copy these values verbatim into ROWS.', why: 'cache rows expire after 7 days' }],
      decisions: [{ question: 'Closer no-op breadth (test 5)', options: ['edition words only inside the parenthetical', 'any parenthetical'], recommendation: 'edition words only, so "(Live)" rows stay checkable' }],
    }
    const APPLY_OK = { applied: 4, skipped: [], decisionsOpen: 1 }
    const panel = () => ({ check: CHECK_OK, clarity: CLARITY_OK, craft: CRAFT_OK, apply: APPLY_OK })

    await check('meta: name and phases', () => {
      same(wf.meta.name, 'review-spec', 'name')
      same(wf.meta.phases.map((p) => p.title), ['Check', 'Clarity', 'Craft', 'Apply'], 'phase titles')
    })
    await check('no args → needs-human, no agent calls', async () => {
      const { result, calls } = await drive(wf, undefined, {})
      same(result.status, 'needs-human', 'status'); same(calls.length, 0, 'calls')
    })
    await check('malformed JSON args → needs-human, no agent calls', async () => {
      const { result, calls } = await drive(wf, '{not json', {})
      same(result.status, 'needs-human', 'status'); same(calls.length, 0, 'calls')
    })
    await check('plain spec path, panel finds 1 wrong + 3 must-adds, all applied → reviewed', async () => {
      const { result, calls, labels } = await drive(wf, SPEC, panel())
      same(result.status, 'reviewed', 'status')
      same(labels, ['check', 'clarity', 'craft', 'apply'], 'labels')
      same(result.wrong, 1, 'wrong'); same(result.fragile, 1, 'fragile'); same(result.mustAdd, 3, 'mustAdd')
      same(result.decisions.length, 1, 'decisions')
      same(result.applied.applied, 4, 'applied count')
      same(calls[0].opts.agentType, 'spec-checker', 'check agentType')
      same(calls[2].opts.effort, 'low', 'craft effort')
      for (const l of ['clarity', 'craft', 'apply']) ok(!('agentType' in calls.find((c) => c.opts.label === l).opts), `${l} carries an agentType`)
      const p = calls[3].prompt
      ok(p.includes(WRONG.correction), 'apply prompt lacks the WRONG correction')
      for (const m of [...CLARITY_OK.mustAdd, ...CRAFT_OK.mustAdd]) ok(p.includes(m.text), `apply prompt lacks must-add "${m.text.slice(0, 30)}…"`)
      ok(p.includes(FRAGILE.claim), 'apply prompt lacks the FRAGILE claim')
      ok(p.includes(CRAFT_OK.decisions[0].recommendation), 'apply prompt lacks the decision recommendation')
      ok(/status:/.test(p) && /Panel review/.test(p), 'apply prompt does not mention status: or ## Panel review')
    })
    await check('JSON args with apply: false → no apply call, reviewed, findings returned', async () => {
      const args = JSON.stringify({ spec: SPEC, config: { apply: false } })
      const { result, labels } = await drive(wf, args, panel())
      same(result.status, 'reviewed', 'status')
      same(labels, ['check', 'clarity', 'craft'], 'labels')
      ok(!('applied' in result), 'result carries applied without an apply run')
      same(result.mustAdd, 3, 'mustAdd'); ok(result.findings && result.findings.check, 'findings missing')
    })
    await check('JSON args with checker → that agentType on the check call', async () => {
      const args = JSON.stringify({ spec: SPEC, config: { checker: 'reviewer' } })
      const { calls } = await drive(wf, args, panel())
      same(calls[0].opts.agentType, 'reviewer', 'check agentType')
    })
    await check('checker returns null → needs-human, no further calls', async () => {
      const { result, calls } = await drive(wf, SPEC, { ...panel(), check: null })
      same(result.status, 'needs-human', 'status'); same(calls.length, 1, 'calls')
    })
    await check('apply returns null → needs-human', async () => {
      const { result } = await drive(wf, SPEC, { ...panel(), apply: null })
      same(result.status, 'needs-human', 'status')
    })
    await check('apply skips a WRONG correction → needs-human naming the claim', async () => {
      const skipped = { applied: 3, skipped: [{ text: WRONG.correction, why: 'the sentence it corrects is gone' }], decisionsOpen: 1 }
      const { result, labels } = await drive(wf, SPEC, { ...panel(), apply: skipped })
      same(result.status, 'needs-human', 'status')
      same(labels, ['check', 'clarity', 'craft', 'apply'], 'labels')
      ok(result.reason.includes(WRONG.claim), `reason does not name the claim: ${result.reason}`)
    })
    await check('apply skips only a must-add → still reviewed', async () => {
      const skipped = { applied: 3, skipped: [{ text: CRAFT_OK.mustAdd[0].text, why: 'already present' }], decisionsOpen: 1 }
      const { result } = await drive(wf, SPEC, { ...panel(), apply: skipped })
      same(result.status, 'reviewed', 'status')
    })
  },
}

// --- main -------------------------------------------------------------------------

const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.js')).sort()
for (const f of files) {
  const name = f.replace(/\.js$/, '')
  console.log(`\n${path.join(WORKFLOWS_DIR, f)}`)
  let wf
  await check(`${name}: loads; meta name, description, phases`, () => {
    wf = load(path.join(WORKFLOWS_DIR, f))
    same(wf.meta.name, name, 'meta.name vs file name')
    ok(typeof wf.meta.description === 'string' && wf.meta.description.trim(), 'meta.description empty')
    ok(Array.isArray(wf.meta.phases) && wf.meta.phases.length && wf.meta.phases.every((p) => p && typeof p.title === 'string'), 'meta.phases missing titles')
  })
  if (!wf) continue
  if (CASES[name]) await CASES[name](wf)
  else { skipped++; console.log(`SKIP ${name}: no per-script cases (meta sanity only)`) }
  // Cross-cutting, for whichever calls the cases above made: every call is
  // typed (schema) and placed (phase from the meta). parallel/pipeline throw,
  // so a script that used them already failed a case above.
  const titles = wf.meta.phases.map((p) => p.title)
  await check(`${name}: every agent call has a schema object and a meta phase`, () => {
    ok(allCalls.length > 0 || !CASES[name], 'no calls recorded')
    for (const { opts } of allCalls) {
      ok(opts.schema && typeof opts.schema === 'object', `${opts.label}: no schema`)
      ok(titles.includes(opts.phase), `${opts.label}: phase ${JSON.stringify(opts.phase)} not in meta`)
    }
  })
  allCalls.length = 0
}

console.log(`\n[workflow-selftest] ${files.length} script(s): ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed ? 1 : 0)
