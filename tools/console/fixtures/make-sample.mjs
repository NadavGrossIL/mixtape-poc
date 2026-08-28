// Regenerates implement-from-spec.sample.json: a synthetic manifest in the
// shape Claude Code writes, for the factory's own workflow. Numbers are
// invented but plausible (~4 min, one gate retry). Run: node fixtures/make-sample.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = fs.readFileSync(path.join(here, 'implement-from-spec.sample.js'), 'utf8')
const T0 = Date.UTC(2026, 7, 28, 9, 0, 0)
const model = 'claude-sonnet-5'
const agent = (index, label, phaseIndex, phaseTitle, agentId, state, attempt, q, s, durationMs, tokens, toolCalls, extra = {}) => ({
  type: 'workflow_agent', index, label, phaseIndex, phaseTitle, agentId, model, state, attempt,
  queuedAt: T0 + q, startedAt: T0 + s, lastProgressAt: T0 + s + durationMs, durationMs, tokens, toolCalls, ...extra,
})
const manifest = {
  runId: 'wf_sample-implement-0001',
  timestamp: new Date(T0).toISOString(),
  taskId: 'sample001',
  scriptPath: 'tools/console/fixtures/implement-from-spec.sample.js',
  args: 'specs/0001-sample.md',
  result: { status: 'ready-for-pr', review: { verdict: 'pass' } },
  agentCount: 4,
  logs: ['implement: branch feat/0001-sample', 'gate: attempt 1 failed (typecheck)', 'gate: attempt 2 passed', 'review: pass'],
  durationMs: 238000,
  summary: 'Synthetic sample run of implement-from-spec (fixture)',
  workflowName: 'implement-from-spec',
  status: 'completed',
  startTime: T0,
  phases: [
    { title: 'Implement', detail: 'the implementer works the spec on a branch' },
    { title: 'Gate', detail: 'types → tests → selftest → build, at most 2 tries' },
    { title: 'Review', detail: 'a separate read-only reviewer, then a human merges' },
  ],
  defaultModel: model,
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Implement' },
    agent(1, 'implement', 1, 'Implement', 'a0sample0implement', 'done', 1, 0, 1500, 95000, 40000, 31, {
      lastToolName: 'Edit', lastToolSummary: 'server/curator.ts', promptPreview: '/implement specs/0001-sample.md', resultPreview: 'Implemented on feat/0001-sample; 3 files changed',
    }),
    { type: 'workflow_phase', index: 2, title: 'Gate' },
    agent(2, 'gate', 2, 'Gate', 'a0sample0gate00001', 'error', 1, 96600, 97800, 38000, 8000, 6, {
      lastToolName: 'Bash', lastToolSummary: 'npm run gate', promptPreview: 'Run `npm run gate`; return {ok, log}', error: 'gate failed: typecheck — 2 errors in server/curator.ts',
    }),
    agent(3, 'gate', 2, 'Gate', 'a0sample0gate00002', 'done', 2, 136000, 137200, 41000, 8000, 6, {
      lastToolName: 'Bash', lastToolSummary: 'npm run gate', promptPreview: 'Run `npm run gate`; return {ok, log}', resultPreview: '{"ok":true,"log":"types ok · 41 tests · selftest ok · build ok"}',
    }),
    { type: 'workflow_phase', index: 3, title: 'Review' },
    agent(4, 'review', 3, 'Review', 'a0sample0review000', 'done', 1, 178300, 179600, 58000, 15000, 14, {
      lastToolName: 'Read', lastToolSummary: 'server/curator.ts', promptPreview: 'Review specs/0001-sample.md against the diff', resultPreview: '{"verdict":"pass","notes":["…"]}',
    }),
  ],
  totalTokens: 71000,
  totalToolCalls: 57,
  script,
}
fs.writeFileSync(path.join(here, 'implement-from-spec.sample.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('wrote implement-from-spec.sample.json')
