// Turns a real Claude Code run manifest into a shareable fixture: the SHAPE,
// phases, labels, states, timestamps, tokens, tool calls, models and
// durations stay; every piece of content (prompts, results, args, logs, the
// script body, paths, repo name) is replaced with a placeholder. Re-runnable:
//   node fixtures/redact.mjs [source.json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE = path.join(os.homedir(), '.claude/projects/-Users-nadavgross/c63aa424-98f1-4f09-a645-4bc727e85799/workflows/wf_d62c68a5-d0a.json')
const source = process.argv[2] ?? DEFAULT_SOURCE
const REPO = 'job-scan' // the private repo's name; must not appear in the fixture
const HOME = os.homedir()

const m = JSON.parse(fs.readFileSync(source, 'utf8'))
const scrub = (s) => (typeof s === 'string' ? s.replaceAll(REPO, 'redacted-repo').replaceAll(HOME, '~') : s)

// script: keep only `export const meta = { … }`
let script = ''
const metaAt = m.script?.search(/export\s+const\s+meta\s*=\s*\{/) ?? -1
if (metaAt >= 0) {
  let depth = 0
  let i = m.script.indexOf('{', metaAt)
  for (; i < m.script.length; i++) {
    if (m.script[i] === '{') depth++
    if (m.script[i] === '}' && --depth === 0) break
  }
  script = scrub(m.script.slice(metaAt, i + 1)) + '\n'
}


// Labels in the real run embed private file paths (`verify:x:file.py:123`).
// Keep the shape, drop the name: every path-looking segment becomes file-N.
const fileIds = new Map()
const anonLabel = (label) => typeof label !== 'string' ? label : label.split(':').map((seg) => {
  if (!/^[\w.\/-]+\.(py|html|js|ts|tsx|mjs|sh|md|json|ya?ml|css|txt)$/.test(seg)) return seg
  if (!fileIds.has(seg)) fileIds.set(seg, fileIds.size + 1)
  return `file-${fileIds.get(seg)}`
}).join(':')

const out = {
  ...m,
  workflowName: scrub(m.workflowName),
  script,
  scriptPath: '[redacted]',
  args: '[redacted]',
  result: {},
  summary: `${REPO} review (redacted fixture)`,
  logs: Array.isArray(m.logs) && m.logs.length ? [scrub(m.logs[0]), ...(m.logs.length > 1 ? [`[${m.logs.length - 1} lines redacted]`] : [])] : [],
  phases: (m.phases ?? []).map((p) => ({ ...p, title: scrub(p.title), detail: scrub(p.detail) })),
  workflowProgress: (m.workflowProgress ?? []).map((e) => {
    if (e.type !== 'workflow_agent') return { ...e, title: scrub(e.title) }
    const r = { ...e, label: anonLabel(scrub(e.label)), phaseTitle: scrub(e.phaseTitle) }
    if ('promptPreview' in r) r.promptPreview = '[prompt redacted]'
    if ('resultPreview' in r) r.resultPreview = '[result redacted]'
    if ('lastToolSummary' in r) r.lastToolSummary = '[redacted]'
    if (typeof r.error === 'string') r.error = scrub(r.error.slice(0, 40))
    return r
  }),
}
const text = JSON.stringify(out, null, 2) + '\n'
const leaks = text.split('\n').filter((l) => (l.includes(REPO) || l.includes(HOME)) && !l.includes('(redacted fixture)'))
if (leaks.length) { console.error('refusing to write: content leaked\n' + leaks.join('\n')); process.exit(1) }
fs.writeFileSync(path.join(here, path.basename(source).replace(/\.json$/, '.redacted.json')), text)
console.log(`wrote ${path.basename(source).replace(/\.json$/, '.redacted.json')} (${out.workflowProgress.length} progress entries)`)
