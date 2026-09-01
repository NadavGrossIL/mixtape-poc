// Turns a real Claude Code run manifest into a shareable fixture: the SHAPE,
// phases, labels, states, timestamps, tokens, tool calls, models and
// durations stay; every piece of content (prompts, results, args, logs, the
// script body, paths, repo name) is replaced with a placeholder. Re-runnable:
//   node fixtures/redact.mjs <source.json> [name-to-scrub ...]
//
// Both the source path and the names to scrub are arguments, and neither has a
// default any more. They used to be baked in — a manifest path under the
// author's ~/.claude (home directory plus a live session UUID) and the private
// repo's own name as a string constant. That put in this tracked file exactly
// the things it exists to remove, and this repo is public.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// Empty strings are dropped: replaceAll('') matches between every character
// and would splice the placeholder into every gap in the file.
const [source, ...names] = process.argv.slice(2).filter((a, i) => i === 0 || a !== '')
if (!source) {
  console.error('usage: node fixtures/redact.mjs <source.json> [name-to-scrub ...]\n' +
    '  source is a run manifest: ~/.claude/projects/<project>/<session-id>/workflows/wf_*.json\n' +
    '  each name-to-scrub (a private repo or project name) becomes "redacted-repo";\n' +
    '  the home directory is always scrubbed to "~".')
  process.exit(1)
}
if (!names.length) console.error('note: no names to scrub given — only the home directory will be replaced')
const HOME = os.homedir()
const secrets = [...names, HOME]

const m = JSON.parse(fs.readFileSync(source, 'utf8'))
const scrub = (s) => typeof s !== 'string' ? s
  : names.reduce((acc, n) => acc.replaceAll(n, 'redacted-repo'), s).replaceAll(HOME, '~')

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
  summary: 'redacted fixture',
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
// No whitelist. The check used to exempt any line containing
// '(redacted fixture)' — which was exactly the summary line this script wrote
// the repo name into, so the guard could not catch itself and the name shipped
// in the tracked fixture. Every line is checked now; if one trips, fix the line.
const leaks = text.split('\n').filter((l) => secrets.some((s) => l.includes(s)))
if (leaks.length) { console.error('refusing to write: content leaked\n' + leaks.join('\n')); process.exit(1) }
fs.writeFileSync(path.join(here, path.basename(source).replace(/\.json$/, '.redacted.json')), text)
console.log(`wrote ${path.basename(source).replace(/\.json$/, '.redacted.json')} (${out.workflowProgress.length} progress entries)`)
