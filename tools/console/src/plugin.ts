import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The console's only "backend": a Vite dev-server middleware that READS
// workflow files in this repo and run records Claude Code wrote under
// ~/.claude/projects/<slug>/. It never writes and never starts a run.
// That is also why this directory is never deployed anywhere.

const ID = /^[\w-]+$/ // run ids and agent ids; anything else is a 400
const SUPPORTED_MANIFEST = /^wf_[\w-]+\.json$/

export interface ConsoleOptions { repoRoot: string; fixturesDir: string }

export function consolePlugin(opts: ConsoleOptions): Plugin {
  const slug = opts.repoRoot.replace(/[\\/]/g, '-')
  const projectsBase = process.env.CONSOLE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
  const projectDir = path.join(projectsBase, slug)

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  return {
    name: 'mixtape-factory-console',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (!url.pathname.startsWith('/api/')) return next()
        if (req.method !== 'GET') return json(res, 405, { error: 'read-only' })
        try {
          if (url.pathname === '/api/workflows') return json(res, 200, listWorkflows(opts))
          if (url.pathname === '/api/runs') return json(res, 200, listRuns(projectDir, opts.fixturesDir, url.searchParams.get('full') === '1'))
          const m = /^\/api\/runs\/([^/]+)\/agents\/([^/]+)$/.exec(url.pathname)
          if (m) {
            const [, runId, agentId] = m
            if (!ID.test(runId) || !ID.test(agentId)) return json(res, 400, { error: 'bad id' })
            const detail = readAgent(projectDir, runId, agentId)
            return detail ? json(res, 200, detail) : json(res, 404, { error: 'no transcript for this run/agent (fixtures have none)' })
          }
          if (url.pathname === '/api/meta') return json(res, 200, { slug, projectDir, exists: fs.existsSync(projectDir) })
          return json(res, 404, { error: 'unknown endpoint' })
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}

// --- workflows ---------------------------------------------------------------

function listWorkflows(opts: ConsoleOptions) {
  const out: { name: string; engine: 'native' | 'archon'; kind: 'script' | 'skill' | 'yaml'; path: string; source: string; fixture?: boolean }[] = []
  const rel = (p: string) => path.relative(opts.repoRoot, p)
  const scripts = path.join(opts.repoRoot, '.claude', 'workflows')
  for (const f of safeList(scripts).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')))
    out.push({ name: f.replace(/\.m?js$/, ''), engine: 'native', kind: 'script', path: rel(path.join(scripts, f)), source: read(path.join(scripts, f)) })
  const skills = path.join(opts.repoRoot, '.claude', 'skills')
  for (const d of safeList(skills)) {
    const md = path.join(skills, d, 'SKILL.md')
    if (fs.existsSync(md)) out.push({ name: d, engine: 'native', kind: 'skill', path: rel(md), source: read(md) })
  }
  const archon = path.join(opts.repoRoot, '.archon', 'workflows')
  for (const f of safeList(archon).filter((f) => /\.ya?ml$/.test(f)))
    out.push({ name: f.replace(/\.ya?ml$/, ''), engine: 'archon', kind: 'yaml', path: rel(path.join(archon, f)), source: read(path.join(archon, f)) })
  if (out.length) return out
  const sample = path.join(opts.fixturesDir, 'implement-from-spec.sample.js')
  return fs.existsSync(sample)
    ? [{ name: 'implement-from-spec', engine: 'native' as const, kind: 'script' as const, path: 'tools/console/fixtures/implement-from-spec.sample.js', source: read(sample), fixture: true }]
    : []
}

// --- runs ------------------------------------------------------------------------

type Manifest = Record<string, unknown> & { startTime?: number; timestamp?: string }

function listRuns(projectDir: string, fixturesDir: string, full: boolean) {
  const found: Manifest[] = []
  for (const session of safeList(projectDir)) {
    const dir = path.join(projectDir, session, 'workflows')
    for (const f of safeList(dir).filter((f) => SUPPORTED_MANIFEST.test(f))) {
      const m = readJson(path.join(dir, f))
      if (m) found.push(m)
    }
  }
  // A resumed run leaves a manifest in more than one session dir under the
  // same runId (seen 2026-08-28: 13 agents in one, 26 in the other). Keep the
  // most complete one.
  const byId = new Map<string, Manifest>()
  for (const m of found) {
    const id = String(m.runId ?? '')
    const prev = byId.get(id)
    if (!prev || progressLen(m) > progressLen(prev)) byId.set(id, m)
  }
  let runs = [...byId.values()]
  if (!runs.length) {
    runs = safeList(fixturesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(fixturesDir, f)))
      .filter((m): m is Manifest => !!m)
      .map((m) => ({ ...m, fixture: true }))
  }
  runs.sort((a, b) => startOf(b) - startOf(a))
  if (full) return runs
  return runs.map(({ script: _s, args: _a, ...rest }) => rest)
}

const progressLen = (m: Manifest) => (Array.isArray(m.workflowProgress) ? m.workflowProgress.length : 0)

function startOf(m: Manifest): number {
  if (typeof m.startTime === 'number') return m.startTime
  const t = m.timestamp ? Date.parse(m.timestamp) : NaN
  return Number.isFinite(t) ? t : 0
}

// --- one agent transcript ------------------------------------------------------

interface Line { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } }

function readAgent(projectDir: string, runId: string, agentId: string) {
  for (const session of safeList(projectDir)) {
    const file = path.join(projectDir, session, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`)
    if (!fs.existsSync(file)) continue
    const lines = read(file).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Line } catch { return null } }).filter((l): l is Line => !!l)
    const prompt = text(lines[0]?.message?.content)
    let result = ''
    const events: { ts: string; kind: string; name?: string; summary: string }[] = []
    for (const l of lines) {
      const c = l.message?.content
      if (!Array.isArray(c)) continue
      for (const block of c as Record<string, unknown>[]) {
        const ts = l.timestamp ?? ''
        if (block.type === 'tool_use') {
          const name = String(block.name ?? '')
          if (name === 'StructuredOutput') result = JSON.stringify(block.input, null, 2)
          events.push({ ts, kind: 'tool_use', name, summary: clip(JSON.stringify(block.input ?? {}), 160) })
        } else if (block.type === 'text' && l.type === 'assistant') {
          const t = String(block.text ?? '')
          if (t.trim()) { result = result || t; events.push({ ts, kind: 'text', summary: clip(t, 160) }) }
        } else if (block.type === 'tool_result') {
          events.push({ ts, kind: 'tool_result', summary: clip(text(block.content), 160) })
        }
      }
    }
    return { prompt, result, events }
  }
  return null
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n')
  return ''
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// --- fs helpers (never throw on a missing directory) ---------------------------------

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir).sort() } catch { return [] }
}
function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}
function readJson(file: string): Manifest | null {
  try { return JSON.parse(read(file)) as Manifest } catch { return null }
}
