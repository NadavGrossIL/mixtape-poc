// The factory line as one deterministic script (docs/factory/plan.md, M4a).
// Every step is a skill or an agent this repo already has; this file only
// decides the order, the retries and when to stop. Sequential on purpose:
// the agents share one working tree, so there is nothing to fan out.
//
//   Implement  →  Gate  →  Review  →  ready-for-pr | needs-human
//      ▲          │ fail (≤2 rounds)      │ fail → one fix round → Gate → Review
//      └──────────┘                       ▼ still fail → needs-human
//
// Trigger: `/implement-from-spec specs/NNNN-slug.md` in a session, or headless
//   claude -p "/implement-from-spec specs/NNNN-slug.md" --permission-mode acceptEdits \
//     --max-turns 60 --max-budget-usd 5 --output-format json
// The two flags are the hard stop; `total_cost_usd` from the JSON fills RUNS.md.
// The script has no shell: the gate is `npm run gate` run by an agent, typed
// verbatim so the repo's Bash allowlist admits it without a prompt.

export const meta = {
  name: 'implement-from-spec',
  description: 'spec → /implement → npm run gate (≤2 fix rounds) → reviewer → ready-for-pr | needs-human',
  whenToUse: 'A spec under specs/ has status: ready and should go to a reviewed branch with no human in between.',
  phases: [
    { title: 'Implement', detail: '/implement skill, test-first; fix rounds land here too' },
    { title: 'Gate', detail: 'npm run gate, verbatim; pass/fail + the failing step' },
    { title: 'Review', detail: 'contract extracted, then the read-only reviewer agent' },
  ],
}

// --- inputs ----------------------------------------------------------------

// `/implement-from-spec specs/0001-x.md` arrives as the raw string; a driver
// may also pass { spec, config } (factory.config.json → args, console C4).
const spec = typeof args === 'string' ? args.trim() : args && typeof args.spec === 'string' ? args.spec.trim() : ''
const config = (args && typeof args === 'object' && args.config) || {}
const MAX_GATE_ROUNDS = Number(config.maxGateRounds) || 2
const BASE = typeof config.base === 'string' ? config.base : 'origin/main'
const REVIEWER = typeof config.reviewer === 'string' ? config.reviewer : 'reviewer'

if (!spec || !/^specs\/\d{4}-[\w-]+\.md$/.test(spec)) {
  return { status: 'needs-human', reason: `expected a spec path like specs/0001-slug.md, got ${JSON.stringify(spec)}`, attempts: 0 }
}

// --- schemas: what each agent hands back ------------------------------------

const IMPLEMENT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['gate-passed', 'needs-human'] },
    attempts: { type: 'number' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['status', 'attempts', 'files', 'notes'],
}

const GATE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    step: { type: 'string', description: 'the failing gate step name, or "" when ok' },
    log: { type: 'string', description: 'the last ~40 lines of gate output, verbatim' },
  },
  required: ['ok', 'step', 'log'],
}

const CONTRACT = {
  type: 'object',
  properties: { goal: { type: 'string' }, checks: { type: 'string' } },
  required: ['goal', 'checks'],
}

const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'why'],
      },
    },
  },
  required: ['verdict', 'findings'],
}

// --- prompts -----------------------------------------------------------------

const COMMAND_RULES = `Only these commands run without a prompt; type each exactly as written, from the repo root, with nothing before or after it (no cd, env var, pipe, tail or redirect): \`npm run gate\`, \`npm run typecheck\`, \`node evals/selftest.ts\`, \`node --test server/test/<name>.test.ts\`, \`git status\`, \`git diff\`. Never touch the never tier (evals/thresholds.json, evals/runs/, evals/baseline-logs/, .github/, CLAUDE.md, .claude/, server/.env*) or the ask tier (server/session.ts, server/caps.ts, server/env.ts, server/spotify.ts); if the work needs one of them, stop and say so.`

const implementPrompt = `Invoke the project skill \`implement\` with the Skill tool: Skill({ skill: "implement", args: "${spec}" }). Follow the skill to its end — it reads the spec, works test-first, runs the gate and writes the run record. ${COMMAND_RULES} Your structured output is the JSON object the skill tells you to reply with.`

const gatePrompt = `Run the gate for this repo: with the Bash tool, run exactly \`npm run gate\` (that string, nothing else) from the repo root and read its full output. Do not fix anything, do not edit any file, do not run any other command. Report ok=true only if the output contains "== gate passed". Otherwise ok=false, step = the name inside the quotes of the line \`== gate FAILED at "<step name>"\`, and log = the last ~40 lines of the output verbatim (the failing command and its errors).`

const fixPrompt = (reason, detail) => `You are the implementer for the spec at \`${spec}\` (read it: the spec is the contract). ${reason}

${detail}

Fix it in the smallest change that keeps the spec's acceptance checks true. Work in this tree as it is — the previous attempt's changes are present, do not revert them wholesale. ${COMMAND_RULES} Run \`npm run gate\` when you believe it is fixed; fix at most twice more if it fails. Then update the "## Run record" block at the end of ${spec} (attempts, gate, files, notes). Your structured output: { status: "gate-passed" | "needs-human", attempts: <gate runs you made>, files: [<paths you changed>], notes: "<one line>" }.`

const contractPrompt = `Read the file \`${spec}\` with the Read tool and return two sections of it verbatim: goal = the text under the heading "## Goal" (up to the next "## " heading), checks = the text under "## Acceptance checks" (up to the next "## " heading). Copy the text exactly; do not summarise, do not include Non-goals, Files touched, Notes or the Run record. Read nothing else and change nothing.`

const reviewPrompt = (contract) => `## Goal
${contract.goal}

## Acceptance checks
${contract.checks}

## Where the work is
base: ${BASE}
spec: ${spec}`

// --- the line ------------------------------------------------------------------

const attempts = { implement: 0, gate: 0, review: 0 }
let gate = null
let implemented = null
let review = null

async function runGate(round) {
  attempts.gate++
  gate = await agent(gatePrompt, { label: `gate:${round}`, phase: 'Gate', schema: GATE, effort: 'low' })
  if (!gate) gate = { ok: false, step: 'gate agent', log: 'the gate agent returned nothing' }
  log(gate.ok ? `gate ${round}: passed` : `gate ${round}: failed at "${gate.step}"`)
  return gate.ok
}

// Implement, then gate; on a gate failure, one fix round per remaining slot.
attempts.implement++
implemented = await agent(implementPrompt, { label: 'implement', phase: 'Implement', schema: IMPLEMENT })
if (!implemented) return { status: 'needs-human', spec, attempts, reason: 'the implement agent returned nothing' }
log(`implement: ${implemented.status} after ${implemented.attempts} gate run(s) — ${implemented.notes}`)
if (implemented.status !== 'gate-passed') return { status: 'needs-human', spec, attempts, reason: `implementer escalated: ${implemented.notes}`, implemented }

for (let round = 1; round <= MAX_GATE_ROUNDS; round++) {
  if (await runGate(round)) break
  if (round === MAX_GATE_ROUNDS) return { status: 'needs-human', spec, attempts, reason: `gate still failing at "${gate.step}" after ${MAX_GATE_ROUNDS} round(s)`, gate, implemented }
  attempts.implement++
  const fixed = await agent(fixPrompt(`The gate (\`npm run gate\`) failed at step "${gate.step}".`, `Gate output:\n\`\`\`\n${gate.log}\n\`\`\``), { label: `fix:gate-${round}`, phase: 'Implement', schema: IMPLEMENT })
  if (!fixed || fixed.status !== 'gate-passed') return { status: 'needs-human', spec, attempts, reason: `fix round ${round} escalated: ${fixed ? fixed.notes : 'no result'}`, gate, implemented }
}

// Review: the reviewer sees the contract and the diff, never the implementer's story.
async function runReview(round) {
  attempts.review++
  const contract = await agent(contractPrompt, { label: `contract:${round}`, phase: 'Review', schema: CONTRACT, effort: 'low' })
  if (!contract) return { verdict: 'fail', findings: [{ file: spec, line: 0, severity: 'high', title: 'contract not extracted', why: 'the extraction agent returned nothing' }] }
  const verdict = await agent(reviewPrompt(contract), { label: `review:${round}`, phase: 'Review', schema: REVIEW, agentType: REVIEWER })
  if (!verdict) return { verdict: 'fail', findings: [{ file: '', line: 0, severity: 'high', title: 'reviewer returned nothing', why: 'no structured output from the reviewer agent' }] }
  log(`review ${round}: ${verdict.verdict} (${verdict.findings.length} finding(s))`)
  return verdict
}

review = await runReview(1)
if (review.verdict === 'fail') {
  // One fix round, then the gate and the reviewer again. Still failing → a human.
  attempts.implement++
  const findings = review.findings.map((f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.title}: ${f.why}`).join('\n')
  const fixed = await agent(fixPrompt('The reviewer failed the diff against the spec.', `Findings:\n${findings}`), { label: 'fix:review', phase: 'Implement', schema: IMPLEMENT })
  if (!fixed || fixed.status !== 'gate-passed') return { status: 'needs-human', spec, attempts, reason: `review fix round escalated: ${fixed ? fixed.notes : 'no result'}`, review, implemented }
  if (!(await runGate('after-review-fix'))) return { status: 'needs-human', spec, attempts, reason: `gate failed at "${gate.step}" after the review fix`, gate, review, implemented }
  review = await runReview(2)
}

return {
  status: review.verdict === 'pass' ? 'ready-for-pr' : 'needs-human',
  spec,
  attempts,
  gate,
  review,
  implemented,
  reason: review.verdict === 'pass' ? 'gate passed and the reviewer passed the diff' : 'reviewer failed the diff twice',
}
