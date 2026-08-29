// The spec-review panel as one deterministic script (docs/factory/plan.md,
// M3 — the "sprint contract" checkpoint made mechanical). Three read-only
// reviewers look at a draft spec in turn, then one agent writes what they
// found into the spec; this file only decides the order and when to stop.
// Sequential on purpose: the Apply agent edits the one file the reviewers
// read, and a later reviewer must not see an earlier one's edits mid-flight.
//
//   Check  →  Clarity  →  Craft  →  Apply  →  reviewed | needs-human
//   facts     two readings  craft    edits the spec; status stays draft
//
// The spec keeps `status: draft`: a human reads the appended "## Panel
// review", resolves the decisions it lists and flips the status to ready
// (specs/_template.md). The hand-run panel this replaces found 3 wrong
// claims and 16 must-adds on a carefully drafted spec —
// docs/reviews/0002-spec-panel-2026-08-29.md.
//
// Trigger: `/review-spec specs/NNNN-slug.md` in a session, or headless:
//   claude -p '/review-spec specs/NNNN-slug.md' --max-turns 40 --max-budget-usd 3 --output-format json
// A driver may pass { spec, config } as a JSON string; `config.apply: false`
// returns the findings without touching the spec. The script has no shell:
// the checker's replays (`node --test …`, git) are run by an agent, typed
// verbatim so the repo's Bash allowlist admits them without a prompt.

export const meta = {
  name: 'review-spec',
  description: 'spec (draft) → fact-check → clarity → product craft → edits applied, status stays draft → reviewed | needs-human',
  whenToUse: 'A spec under specs/ is a draft and should be checked against the codebase before a human sets status: ready.',
  phases: [
    { title: 'Check', detail: 'the spec-checker agent replays every factual claim against code and data' },
    { title: 'Clarity', detail: 'every place two engineers would build different things; the implementer\'s constraints' },
    { title: 'Craft', detail: 'structure, durability of claims, demo-able metrics, scope, open questions' },
    { title: 'Apply', detail: 'corrections and must-adds written into the spec; ## Panel review appended' },
  ],
}

// --- inputs ----------------------------------------------------------------

// `/review-spec specs/0002-x.md` arrives as the raw string. A driver passes
// { spec, config } — but the slash form hands the script one plain string, so
// the object comes JSON-encoded. A string that starts with `{` and fails to
// parse is treated as a path and rejected by the spec check below.
let input = args
if (typeof input === 'string' && input.trim().startsWith('{')) {
  try { input = JSON.parse(input) } catch { /* not JSON: the string path handles it */ }
}
const spec = typeof input === 'string' ? input.trim() : input && typeof input.spec === 'string' ? input.spec.trim() : ''
const config = (input && typeof input === 'object' && input.config) || {}
// apply: false = findings only, the spec is not touched (a dry read of a panel).
const APPLY = config.apply !== false
// The fact-checker's agent type; its model is that file's (.claude/agents/spec-checker.md).
const CHECKER = typeof config.checker === 'string' ? config.checker : 'spec-checker'

if (!spec || !/^specs\/\d{4}-[\w-]+\.md$/.test(spec)) {
  return { status: 'needs-human', reason: `expected a spec path like specs/0001-slug.md, got ${JSON.stringify(spec)}`, spec, wrong: 0, fragile: 0, mustAdd: 0, decisions: [] }
}

// --- schemas: what each agent hands back ------------------------------------

const CHECK = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'the spec\'s claim, quoted or closely paraphrased' },
          verdict: { type: 'string', enum: ['VERIFIED', 'WRONG', 'FRAGILE'] },
          correction: { type: 'string', description: 'the corrected value or wording; "" when VERIFIED' },
          where: { type: 'string', description: 'file:line, command or data path where you saw it' },
        },
        required: ['claim', 'verdict', 'correction', 'where'],
      },
    },
    design: {
      type: 'array',
      items: {
        type: 'object',
        properties: { concern: { type: 'string' }, why: { type: 'string' } },
        required: ['concern', 'why'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['claims', 'design', 'summary'],
}

const EDIT = {
  type: 'object',
  properties: {
    where: { type: 'string', description: 'the heading or line the text goes under' },
    text: { type: 'string', description: 'the sentence(s) to insert, ready to paste as written' },
    why: { type: 'string' },
  },
  required: ['where', 'text', 'why'],
}

const EDITS = {
  type: 'object',
  properties: {
    mustAdd: { type: 'array', items: EDIT },
    leaveToBuilder: {
      type: 'array',
      items: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    },
  },
  required: ['mustAdd', 'leaveToBuilder'],
}

const CRAFT = {
  type: 'object',
  properties: {
    mustAdd: { type: 'array', items: EDIT },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
        required: ['question', 'options', 'recommendation'],
      },
    },
  },
  required: ['mustAdd', 'decisions'],
}

const APPLIED = {
  type: 'object',
  properties: {
    applied: { type: 'number', description: 'corrections and must-adds written into the spec' },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string', description: 'the skipped item\'s text, verbatim from the list' }, why: { type: 'string' } },
        required: ['text', 'why'],
      },
    },
    decisionsOpen: { type: 'number', description: 'decisions listed under ## Panel review' },
  },
  required: ['applied', 'skipped', 'decisionsOpen'],
}

// --- prompts -----------------------------------------------------------------

const TIER_RULES = `Never touch the never tier (evals/thresholds.json, evals/runs/, evals/baseline-logs/, .github/, CLAUDE.md, .claude/, server/.env*) or the ask tier (server/session.ts, server/caps.ts, server/env.ts, server/spotify.ts): read them where the spec cites them, change nothing. Only these commands run without a prompt; type each exactly as written, from the repo root, with nothing before or after it (no cd, env var, pipe, tail or redirect): \`node --test server/test/<name>.test.ts\`, \`npm run typecheck\`, \`node evals/selftest.ts\`, \`git status\`, \`git diff\`, \`git log\`.`

const checkPrompt = `Fact-check the draft spec at \`${spec}\` against this repository as it is right now. You are read-only: edit, create or delete nothing. ${TIER_RULES} The spec is the thing under test: do not trust its numbers, its line references or its summaries of what the code does — replay each one against the real code and data. Line numbers and function behaviour against the file at HEAD; fixture values against server/.search-cache.json; run numbers against evals/runs/*/summary.json; quoted judge notes against verdicts.json; "red today" / "green today" claims by running the named test file or importing the module the way its test file does; commit claims with git. Then list the design stresses an implementer would hit: rule precedence, window definitions, interactions with existing tests, contradictions with existing prompt bullets. Your structured output: { claims: [{ claim, verdict: "VERIFIED" | "WRONG" | "FRAGILE", correction, where }], design: [{ concern, why }], summary } — one entry per claim; correction = the corrected value or wording ("" when VERIFIED); where = the file:line, command or data path you saw it in. WRONG = the code or data says otherwise today. FRAGILE = true today but will shift under the spec's own edits or with time (a line number, a cache row that expires, a count from one run).`

const clarityPrompt = `You review the draft spec at \`${spec}\` for the engineer who will implement it without talking to its author — an agent, in one autonomous run. Read the spec, then \`.claude/skills/implement/SKILL.md\` (the implementer's instructions and its allowlisted commands) and \`.claude/agents/reviewer.md\` (the rubric the diff is judged by). You are read-only: edit, create or delete nothing. ${TIER_RULES}

Find every place two reasonable engineers would build different things, and state both readings — the fix is a sentence that leaves one. Then hold the spec against the implementer's constraints: (a) every acceptance check must be a command on the implement skill's list, typed verbatim from the repo root — \`cd server && …\`, \`node -e\`, pipes and \`git diff --stat\` are not on it; say what replaces each, and what is for the human instead; (b) nothing the spec needs may sit in the ask tier or the never tier — the implementer stops there; (c) the reviewer's rubric counts every acceptance check, so a check only a human can run (an eval leg, a manual read) must be retitled out of "## Acceptance checks". Your structured output: { mustAdd: [{ where, text, why }], leaveToBuilder: [{ note }] } — where = the heading or the line the edit goes under; text = the sentence(s) to insert, ready to paste as written; why = the two readings it removes or the constraint it meets. leaveToBuilder = ambiguities where either reading is fine, one note each.`

const craftPrompt = `You review the draft spec at \`${spec}\` as a spec editor: is this a strong short document, and can one autonomous run deliver it? You are read-only: edit, create or delete nothing. ${TIER_RULES} Read the spec and its template \`specs/_template.md\`, then \`evals/thresholds.json\` and, when the spec cites an eval run, that run's summary.json under evals/runs/.

Judge, in this order. Structure against strong-short-doc practice: problem, users, scope, non-goals, metrics, acceptance — each present and doing its job (a Goal is two user-facing sentences; evidence moves to Notes). Durability: a claim that depends on a snapshot — a cache row in server/.search-cache.json, a line number, one run's count — must say so and carry the values it needs inside the spec, so the spec stays true after the snapshot is gone. Metrics: a metric is demo-able only if it can be read against evals/thresholds.json at the run's sample size; name what is readable and what is noise, and pre-register the read. Scope: defensible for one autonomous run; when slices are bundled, the spec says why. Open questions: each with its readings in brackets and a recommendation. Your structured output: { mustAdd: [{ where, text, why }], decisions: [{ question, options: [string], recommendation }] } — mustAdd text is ready to paste as written; decisions are the questions only the author can settle, recommendation first.`

const applyPrompt = (findings) => `You edit the draft spec at \`${spec}\` and nothing else. A review panel has finished; its findings are below, verbatim. Apply every WRONG correction and every must-add as written, at the place each names; when two items say the same thing, apply it once. Leave the frontmatter line \`status:\` exactly as it is. Do not rewrite anything the findings do not name. Then append a section \`## Panel review\` at the end of the spec (above "## Run record" when one exists) with two lists: "Decisions for the author" — one bullet per decision, its options, and the recommendation in square brackets, for the human to resolve when flipping the status to ready; "Fragile claims" — one line per FRAGILE claim with where it was seen. ${TIER_RULES} Touch no other file. Your structured output: { applied: <count of corrections and must-adds written>, skipped: [{ text, why }], decisionsOpen: <count of decisions listed> } — skip an item only when the spec no longer has the place it names, and put the item's text verbatim from the list below in skipped[].text.

${findings}`

// --- the panel -------------------------------------------------------------------

const isWrong = (c) => c.verdict === 'WRONG'
const isFragile = (c) => c.verdict === 'FRAGILE'
// The text an item is matched by when the Apply agent reports it skipped.
const keyOf = (c) => c.correction || c.claim

function findingsText(check, clarity, craft) {
  const wrong = check.claims.filter(isWrong)
  const fragile = check.claims.filter(isFragile)
  const adds = [
    ...clarity.mustAdd.map((m) => ({ ...m, from: 'clarity' })),
    ...craft.mustAdd.map((m) => ({ ...m, from: 'craft' })),
  ]
  const list = (items, render) => (items.length ? items.map(render).join('\n') : '(none)')
  return [
    '## WRONG claims — apply the correction',
    list(wrong, (c, i) => `W${i + 1}. claim: ${c.claim}\n    correction: ${c.correction}\n    seen at: ${c.where}`),
    '',
    '## Must add — insert the text as written',
    list(adds, (m, i) => `M${i + 1} (${m.from}). where: ${m.where}\n    text: ${m.text}\n    why: ${m.why}`),
    '',
    '## Decisions — list under ## Panel review, recommendation in brackets',
    list(craft.decisions, (d, i) => `D${i + 1}. ${d.question}\n    options: ${d.options.join(' | ')}\n    recommendation: ${d.recommendation}`),
    '',
    '## FRAGILE claims — one line each under ## Panel review',
    list(fragile, (c, i) => `F${i + 1}. ${c.claim} — seen at: ${c.where}${c.correction ? ` — note: ${c.correction}` : ''}`),
  ].join('\n')
}

const check = await agent(checkPrompt, { label: 'check', phase: 'Check', schema: CHECK, agentType: CHECKER })
if (!check) return { status: 'needs-human', spec, wrong: 0, fragile: 0, mustAdd: 0, decisions: [], reason: 'the check agent returned nothing' }
const wrong = check.claims.filter(isWrong).length
const fragile = check.claims.filter(isFragile).length
log(`check: ${check.claims.length} claim(s) — ${wrong} wrong, ${fragile} fragile, ${check.design.length} design concern(s) — ${check.summary}`)

const clarity = await agent(clarityPrompt, { label: 'clarity', phase: 'Clarity', schema: EDITS })
if (!clarity) return { status: 'needs-human', spec, wrong, fragile, mustAdd: 0, decisions: [], findings: { check }, reason: 'the clarity agent returned nothing' }
log(`clarity: ${clarity.mustAdd.length} must-add(s), ${clarity.leaveToBuilder.length} left to the builder`)

const craft = await agent(craftPrompt, { label: 'craft', phase: 'Craft', schema: CRAFT, effort: 'low' })
if (!craft) return { status: 'needs-human', spec, wrong, fragile, mustAdd: clarity.mustAdd.length, decisions: [], findings: { check, clarity }, reason: 'the craft agent returned nothing' }
log(`craft: ${craft.mustAdd.length} must-add(s), ${craft.decisions.length} decision(s)`)

const mustAdd = clarity.mustAdd.length + craft.mustAdd.length
const findings = { check, clarity, craft }
const base = { spec, wrong, fragile, mustAdd, decisions: craft.decisions, findings }

if (!APPLY) {
  return { status: 'reviewed', ...base, reason: `findings only (config.apply: false): ${wrong} wrong, ${fragile} fragile, ${mustAdd} must-add(s), ${craft.decisions.length} decision(s) — the spec was not touched` }
}

const applied = await agent(applyPrompt(findingsText(check, clarity, craft)), { label: 'apply', phase: 'Apply', schema: APPLIED })
if (!applied) return { status: 'needs-human', ...base, reason: 'the apply agent returned nothing; the spec may be half-edited — read git diff' }
log(`apply: ${applied.applied} written, ${applied.skipped.length} skipped, ${applied.decisionsOpen} decision(s) open`)

// A WRONG claim that stays in the spec is the one thing a human must not miss.
const skippedWrong = check.claims.filter(isWrong).filter((c) => {
  const key = keyOf(c)
  return key && applied.skipped.some((s) => s.text && (s.text.includes(key) || key.includes(s.text)))
})
if (skippedWrong.length) {
  return { status: 'needs-human', ...base, applied, reason: `the apply agent skipped ${skippedWrong.length} WRONG correction(s): ${skippedWrong.map((c) => c.claim).join('; ')}` }
}

return {
  status: 'reviewed',
  ...base,
  applied,
  reason: `${wrong} wrong claim(s) corrected, ${mustAdd} must-add(s) applied (${applied.skipped.length} skipped), ${applied.decisionsOpen} decision(s) open under ## Panel review; status left as it was`,
}
