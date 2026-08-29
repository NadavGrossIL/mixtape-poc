import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConsoleEvent, RunManifest, WorkflowAgentEntry } from './types'

// The console's only "backend": a Vite dev-server middleware that READS
// workflow files in this repo and run records Claude Code wrote under
// ~/.claude/projects/<slug>/. It never writes and never starts a run.
// That is also why this directory is never deployed anywhere.
// C3 adds one long-lived GET (/api/events, SSE) so the page hears about
// changes instead of polling; the allowlisted write comes with C4.

const ID = /^[\w-]+$/ // run ids and agent ids; anything else is a 400
const SUPPORTED_MANIFEST = /^wf_[\w-]+\.json$/
const RUN_DIR = /^wf_[\w-]+$/
const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled', 'killed']) // 'killed' = a --max-budget-usd / --max-turns stop (observed 2026-08-29)
const STALE_MS = 15 * 60_000 // nothing on disk moved for this long → not live, whatever the journal says
const DEBOUNCE_MS = 300
const PING_MS = 15_000
const POLL_MS = 2_000

export interface ConsoleOptions { repoRoot: string; fixturesDir: string }

export function consolePlugin(opts: ConsoleOptions): Plugin {
  const slug = opts.repoRoot.replace(/[\\/]/g, '-')
  const projectsBase = process.env.CONSOLE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
  const projectDir = path.join(projectsBase, slug)
  const live = liveEvents(projectDir, opts.repoRoot)

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
          if (url.pathname === '/api/events') return live.subscribe(res)
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

type Manifest = RunManifest

/**
 * One record per runId from two sources. A manifest whose status is terminal is
 * the final word. Otherwise the journal (appended while the run goes, see
 * runFromJournal) is overlaid on it — or stands alone when there is no manifest
 * yet — and the record is flagged `live` / `source` so the UI can say so.
 */
function listRuns(projectDir: string, fixturesDir: string, full: boolean) {
  const manifests = new Map<string, { m: Manifest; mtime: number }>()
  const journals = new Map<string, string[]>() // runId → every session dir holding a piece of it
  for (const session of safeList(projectDir)) {
    const base = path.join(projectDir, session)
    for (const f of safeList(path.join(base, 'workflows')).filter((f) => SUPPORTED_MANIFEST.test(f))) {
      const file = path.join(base, 'workflows', f)
      const m = readJson(file)
      if (!m) continue
      // A resumed run leaves a manifest in more than one session dir under the
      // same runId (seen 2026-08-28: 13 agents in one, 26 in the other). Keep the
      // most complete one.
      const id = String(m.runId ?? f.replace(/\.json$/, ''))
      const prev = manifests.get(id)
      if (!prev || progressLen(m) > progressLen(prev.m)) manifests.set(id, { m, mtime: mtimeOf(file) })
    }
    for (const d of safeList(path.join(base, 'subagents', 'workflows')).filter((d) => RUN_DIR.test(d)))
      journals.set(d, [...(journals.get(d) ?? []), base])
  }
  let runs: Manifest[] = []
  for (const id of new Set([...manifests.keys(), ...journals.keys()])) {
    const hit = manifests.get(id)
    if (hit && TERMINAL.has(String(hit.m.status))) { runs.push({ ...settle(hit.m), source: 'manifest' }); continue }
    const j = journals.has(id) ? runFromJournal(id, journals.get(id)!) : undefined
    runs.push(mergeRun(id, hit, j))
  }
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

/** A run that ended other than 'completed' leaves agents frozen in 'progress'; show them as errors, not as running forever. */
function settle(m: Manifest): Manifest {
  if (m.status === 'completed') return m
  const progress = (m.workflowProgress ?? []).map((e) => e.type === 'workflow_agent' && (e as WorkflowAgentEntry).state === 'progress'
    ? { ...e, state: 'error', error: (e as WorkflowAgentEntry).error ?? `run ${m.status} while this agent was in progress` }
    : e)
  return { ...m, workflowProgress: progress }
}

/** Manifest wins for everything it knows; the journal wins for `state` / `lastProgressAt` and fills the gaps; totals are recomputed. */
function mergeRun(runId: string, hit: { m: Manifest; mtime: number } | undefined, j: Manifest | undefined): Manifest {
  if (!hit) return { runId, status: 'running', ...j, source: 'journal' }
  const fresh = Date.now() - hit.mtime < STALE_MS
  if (!j) return { ...hit.m, source: 'manifest', live: fresh }
  const progress = [...(hit.m.workflowProgress ?? [])]
  for (const d of agentsOf(j)) {
    const i = progress.findIndex((e) => e.type === 'workflow_agent' && sameAgent(e as WorkflowAgentEntry, d))
    if (i < 0) { progress.push(d); continue }
    const e = progress[i] as WorkflowAgentEntry
    progress[i] = { ...d, ...defined(e), state: d.state ?? e.state, lastProgressAt: d.lastProgressAt ?? e.lastProgressAt }
  }
  const agents = progress.filter((e): e is WorkflowAgentEntry => e.type === 'workflow_agent')
  const ends = agents.map((a) => a.lastProgressAt).filter(isNum)
  const startTime = hit.m.startTime ?? j.startTime
  const lastProgressAt = ends.length ? Math.max(...ends) : undefined
  return {
    ...defined(j), ...defined(hit.m),
    status: hit.m.status ?? 'running',
    workflowProgress: progress,
    agentCount: agents.length,
    totalTokens: sum(agents.map((a) => a.tokens)),
    totalToolCalls: sum(agents.map((a) => a.toolCalls)),
    lastProgressAt,
    durationMs: startTime != null && lastProgressAt != null ? Math.max(hit.m.durationMs ?? 0, lastProgressAt - startTime) : hit.m.durationMs,
    live: fresh || !!j.live,
    source: 'merged',
  }
}

/** The manifest names an agent by id once it started; before that only its prompt preview can match. */
function sameAgent(m: WorkflowAgentEntry, j: WorkflowAgentEntry): boolean {
  if (m.agentId) return m.agentId === j.agentId
  const a = (m.promptPreview ?? '').slice(0, 60), b = (j.promptPreview ?? '').slice(0, 60)
  return a.length > 20 && a === b
}

const agentsOf = (m: Manifest | undefined) => (m?.workflowProgress ?? []).filter((e): e is WorkflowAgentEntry => e.type === 'workflow_agent')
const progressLen = (m: Manifest) => (Array.isArray(m.workflowProgress) ? m.workflowProgress.length : 0)

function startOf(m: Manifest): number {
  if (typeof m.startTime === 'number') return m.startTime
  const t = m.timestamp ? Date.parse(m.timestamp) : NaN
  return Number.isFinite(t) ? t : 0
}

// --- journal fallback ------------------------------------------------------------
//
// Observed 2026-08-29 in wf_d62c68a5-d0a (a July 2026 run, 64 agents over two
// sessions), under <session>/subagents/workflows/<runId>/:
//
//   journal.jsonl — one object per line, two shapes, and NO timestamp, label,
//   phase or workflow name on either:
//     {"type":"started","key":"v2:<sha256>","agentId":"a079e68cd20ea9230"}
//     {"type":"result","key":"v2:<sha256>","agentId":"adfcc4acfc156daf5","result":{…structured output…}}
//   `key` hashes the prompt (the resume cache). A retried prompt gets a second
//   `started` under the same key with a new agentId; an agent that failed gets no
//   `result` line at all (64 started / 9 result for 26 manifest agents).
//
//   agent-<agentId>.jsonl — line 1 is {type:"user", message:{content:<full
//   prompt>}, timestamp}; every line has an ISO `timestamp`; assistant lines carry
//   message.model and message.usage {input_tokens, output_tokens,
//   cache_creation_input_tokens, cache_read_input_tokens} and are appended several
//   times per request while streaming (same requestId, growing output_tokens). An
//   API failure is an assistant line with isApiErrorMessage:true, error:"rate_limit",
//   apiErrorStatus:429, model "<synthetic>". A finished agent ends with a user line
//   carrying toolEndsTurn:true, right after a StructuredOutput tool_use.
//   agent-<id>.meta.json is {"agentType":"workflow-subagent","spawnDepth":1}.
//
//   Cross-checked against the manifest: startedAt == the first line's timestamp
//   (to the ms), lastProgressAt ≈ the last line's, toolCalls == tool_use blocks,
//   tokens == input+cache_creation+cache_read+output of the latest streamed
//   assistant line (the context size, not a running sum).
//
// Every field below is optional and a line that does not parse is skipped: a
// half-written last line is normal while the engine is still appending.

interface JournalLine { type?: string; key?: string; agentId?: string; result?: unknown; error?: unknown; label?: string; phaseTitle?: string; phase?: string; workflowName?: string; timestamp?: string | number }

function runFromJournal(runId: string, sessions: string[]): Manifest {
  const agents = new Map<string, WorkflowAgentEntry>()
  const starts = new Map<string, number>() // prompt key → times started (retries)
  const keyOf = new Map<string, string>() // agentId → prompt key
  let newest = 0, index = 0
  let workflowName: string | undefined, script: string | undefined, scriptPath: string | undefined
  for (const base of sessions) {
    const dir = path.join(base, 'subagents', 'workflows', runId)
    const journal = path.join(dir, 'journal.jsonl')
    newest = Math.max(newest, mtimeOf(journal))
    for (const l of readJsonl<JournalLine>(journal)) {
      const id = str(l.agentId) ?? str(l.key)
      if (!id) continue
      workflowName ??= str(l.workflowName)
      let a = agents.get(id)
      if (!a) agents.set(id, (a = { type: 'workflow_agent', index: ++index, agentId: str(l.agentId) }))
      if (l.key) keyOf.set(id, String(l.key))
      a.label ??= str(l.label)
      a.phaseTitle ??= str(l.phaseTitle) ?? str(l.phase)
      const ts = when(l.timestamp)
      if (l.type === 'started') {
        const n = (starts.get(String(l.key)) ?? 0) + 1
        starts.set(String(l.key), n)
        a.attempt = n
        a.state ??= 'running'
        a.startedAt ??= ts
      } else if (l.type === 'result') {
        a.state = l.error ? 'error' : 'done'
        if (l.error) a.error = String(l.error)
        a.resultPreview = clip(typeof l.result === 'string' ? l.result : JSON.stringify(l.result ?? ''), 300)
        if (ts != null) a.lastProgressAt = ts
      }
    }
    for (const a of agents.values()) {
      if (!a.agentId) continue
      const t = transcript(path.join(dir, `agent-${a.agentId}.jsonl`))
      if (!t) continue
      newest = Math.max(newest, t.mtime)
      a.startedAt = t.startedAt ?? a.startedAt
      a.lastProgressAt = Math.max(a.lastProgressAt ?? 0, t.lastAt ?? 0) || undefined
      a.durationMs = a.startedAt != null && a.lastProgressAt != null ? a.lastProgressAt - a.startedAt : undefined
      a.model ??= t.model
      a.tokens = t.tokens ?? a.tokens
      a.toolCalls = t.toolCalls
      a.lastToolName = t.lastToolName ?? a.lastToolName
      a.promptPreview = t.promptPreview ?? a.promptPreview
      a.label ??= t.title
      if (a.state === 'running' && t.apiError) { a.state = 'error'; a.error = t.apiError }
      else if (a.state === 'running' && t.ended) a.state = 'done'
      a.resultPreview ??= t.lastText
    }
    // The engine copies the script next to the manifest as <name>-<runId>.js;
    // that is the only place a journal-only run's name is written down.
    const sf = safeList(path.join(base, 'workflows', 'scripts')).find((f) => f.endsWith(`-${runId}.js`))
    if (sf) { workflowName ??= sf.slice(0, -(runId.length + 4)); scriptPath = path.join(base, 'workflows', 'scripts', sf); script = read(scriptPath) }
  }
  const list = [...agents.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  // Prompt-derived labels collide (ten reviewers open with the same sentence).
  // Retries share a key and must stack as attempts; distinct keys get a suffix
  // so a fan-out draws as a fan-out.
  const byLabel = new Map<string, string[]>()
  for (const a of list) {
    a.label ??= `agent ${(a.agentId ?? '').slice(0, 8)}`
    const k = keyOf.get(a.agentId ?? '') ?? a.agentId ?? ''
    const ks = byLabel.get(a.label) ?? []
    if (!ks.includes(k)) ks.push(k)
    byLabel.set(a.label, ks)
  }
  for (const a of list) {
    const ks = byLabel.get(a.label!)!
    if (ks.length > 1) a.label = `${a.label} · ${ks.indexOf(keyOf.get(a.agentId ?? '') ?? a.agentId ?? '') + 1}`
  }
  const startTime = min(list.map((a) => a.startedAt))
  const lastProgressAt = max(list.map((a) => a.lastProgressAt))
  const live = Date.now() - newest < STALE_MS
  const models = list.map((a) => a.model).filter((m): m is string => !!m)
  return {
    runId, workflowName, status: live ? 'running' : 'stale', startTime, lastProgressAt,
    timestamp: startTime != null ? new Date(startTime).toISOString() : undefined,
    durationMs: startTime != null && lastProgressAt != null ? lastProgressAt - startTime : undefined,
    agentCount: list.length, totalTokens: sum(list.map((a) => a.tokens)), totalToolCalls: sum(list.map((a) => a.toolCalls)),
    defaultModel: models.sort((x, y) => models.filter((m) => m === y).length - models.filter((m) => m === x).length)[0],
    phases: [...new Set(list.map((a) => a.phaseTitle).filter((p): p is string => !!p))].map((title) => ({ title })),
    script, scriptPath, workflowProgress: list, live, source: 'journal',
  }
}

// --- transcripts ---------------------------------------------------------------------

interface Line {
  type?: string; timestamp?: string; toolEndsTurn?: boolean; isApiErrorMessage?: boolean; error?: unknown
  message?: { role?: string; content?: unknown; model?: string; usage?: Record<string, unknown> }
}
interface Transcript {
  mtime: number; startedAt?: number; lastAt?: number; model?: string; tokens?: number; toolCalls: number
  lastToolName?: string; promptPreview?: string; title?: string; apiError?: string; ended: boolean; lastText?: string
}

// Parsed once per (size, mtime): a live run re-reads only the file that grew,
// and a finished run's 100+ transcripts are read once per dev-server lifetime.
const transcripts = new Map<string, { sig: string; t: Transcript }>()

function transcript(file: string): Transcript | null {
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { return null }
  const sig = `${st.size}:${st.mtimeMs}`
  const hit = transcripts.get(file)
  if (hit?.sig === sig) return hit.t
  const t: Transcript = { mtime: st.mtimeMs, toolCalls: 0, ended: false }
  const lines = readJsonl<Line>(file)
  const prompt = text(lines[0]?.message?.content)
  if (prompt) {
    t.promptPreview = clip(prompt, 300)
    const first = prompt.split('\n').find((l) => l.trim())?.trim()
    if (first) t.title = clip(first, 48)
  }
  for (const l of lines) {
    const at = when(l.timestamp)
    if (at != null) { t.startedAt ??= at; t.lastAt = at }
    if (l.toolEndsTurn) t.ended = true
    if (l.type !== 'assistant') continue
    const m = l.message
    if (l.isApiErrorMessage) { t.apiError = text(m?.content) || String(l.error ?? 'api error'); continue }
    if (m?.model && !m.model.startsWith('<')) t.model = m.model
    const u = m?.usage
    if (u) {
      const ctx = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens)
      if (ctx > 0) t.tokens = ctx
    }
    if (!Array.isArray(m?.content)) continue
    for (const block of m.content as Record<string, unknown>[]) {
      if (block.type === 'tool_use') {
        t.toolCalls++
        t.lastToolName = String(block.name ?? '')
        if (t.lastToolName === 'StructuredOutput') { t.ended = true; t.lastText = clip(JSON.stringify(block.input ?? ''), 300) }
      } else if (block.type === 'text' && String(block.text ?? '').trim()) t.lastText = clip(String(block.text), 300)
    }
  }
  transcripts.set(file, { sig, t })
  return t
}

function readAgent(projectDir: string, runId: string, agentId: string) {
  for (const session of safeList(projectDir)) {
    const file = path.join(projectDir, session, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`)
    if (!fs.existsSync(file)) continue
    const lines = readJsonl<Line>(file)
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

// --- live: fs.watch → SSE ------------------------------------------------------------

/**
 * One set of watchers shared by every open page, started with the first
 * subscriber and closed with the last. Events are batched into a fixed
 * 300 ms window (not a trailing debounce: a busy run appends every few
 * hundred ms and a trailing debounce would never fire).
 */
function liveEvents(projectDir: string, repoRoot: string) {
  const clients = new Set<ServerResponse>()
  const pending = new Map<string, ConsoleEvent>()
  let flush: NodeJS.Timeout | undefined
  let stop: (() => void) | undefined
  const emit = (e: ConsoleEvent) => {
    pending.set(e.kind === 'journal' ? `journal:${e.runId}` : e.kind, e)
    flush ??= setTimeout(() => {
      flush = undefined
      const batch = [...pending.values()]
      pending.clear()
      for (const c of clients) for (const e of batch) c.write(`data: ${JSON.stringify(e)}\n\n`)
    }, DEBOUNCE_MS)
  }
  return {
    subscribe(res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      stop ??= startWatching(projectDir, repoRoot, emit)
      const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
      res.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
        if (!clients.size) { stop?.(); stop = undefined }
      })
    },
  }
}

function startWatching(projectDir: string, repoRoot: string, emit: (e: ConsoleEvent) => void): () => void {
  const stops = [
    watchTree(projectDir, (rel) => { const e = classifyRunFile(rel); if (e) emit(e) }),
    ...['.claude/workflows', '.claude/skills', '.archon/workflows'].map((d) => watchTree(path.join(repoRoot, d), () => emit({ kind: 'workflows' }))),
  ]
  return () => { for (const s of stops) s() }
}

// <session>/workflows/wf_x.json and workflows/scripts/* → runs;
// <session>/subagents/workflows/wf_x/* (journal, transcripts) → journal.
// The session's own transcript (<session>.jsonl) grows on every turn of a
// live Claude session and must not wake the page.
function classifyRunFile(rel: string): ConsoleEvent | null {
  if (rel === '') return { kind: 'runs' }
  const p = rel.split(/[\\/]/)
  if (p[1] === 'workflows' && p[2] && (SUPPORTED_MANIFEST.test(p[2]) || p[2] === 'scripts')) return { kind: 'runs' }
  if (p[1] === 'subagents' && p[2] === 'workflows' && p[3] && RUN_DIR.test(p[3])) return { kind: 'journal', runId: p[3] }
  return null
}

/**
 * fs.watch recursive (macOS + Node 24) with two fallbacks: poll until the
 * directory exists (a repo's first run creates it), and poll the tree by
 * size+mtime every 2 s if watch throws or errors.
 */
function watchTree(dir: string, onChange: (rel: string) => void): () => void {
  let watcher: fs.FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  let snap: Map<string, string> | undefined
  const pollTree = () => {
    snap = scan(dir)
    timer = setInterval(() => {
      const next = scan(dir)
      for (const [k, v] of next) if (snap!.get(k) !== v) onChange(k)
      for (const k of snap!.keys()) if (!next.has(k)) onChange(k)
      snap = next
    }, POLL_MS)
  }
  const arm = () => {
    try {
      watcher = fs.watch(dir, { recursive: true }, (_ev, name) => onChange(name ? String(name) : ''))
      watcher.on('error', () => { watcher?.close(); watcher = undefined; pollTree() })
    } catch { pollTree() }
  }
  if (fs.existsSync(dir)) arm()
  else timer = setInterval(() => { if (fs.existsSync(dir)) { clearInterval(timer); timer = undefined; arm(); onChange('') } }, POLL_MS)
  return () => { watcher?.close(); if (timer) clearInterval(timer) }
}

function scan(dir: string, out = new Map<string, string>(), rel = '', depth = 0): Map<string, string> {
  if (depth > 5) return out
  for (const name of safeList(dir)) {
    const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name
    let st: fs.Stats
    try { st = fs.statSync(full) } catch { continue }
    if (st.isDirectory()) scan(full, out, r, depth + 1)
    else out.set(r, `${st.size}:${st.mtimeMs}`)
  }
  return out
}

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
/** Lines that do not parse are skipped: the last one is often still being written. */
function readJsonl<T>(file: string): T[] {
  let raw: string
  try { raw = read(file) } catch { return [] }
  const out: T[] = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try { const v = JSON.parse(l); if (v && typeof v === 'object') out.push(v as T) } catch { /* partial line */ }
  }
  return out
}
function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs } catch { return 0 }
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const when = (v: unknown): number | undefined => (isNum(v) ? v : typeof v === 'string' && isNum(Date.parse(v)) ? Date.parse(v) : undefined)
const min = (xs: (number | undefined)[]) => { const n = xs.filter(isNum); return n.length ? Math.min(...n) : undefined }
const max = (xs: (number | undefined)[]) => { const n = xs.filter(isNum); return n.length ? Math.max(...n) : undefined }
const sum = (xs: (number | undefined)[]) => { const n = xs.filter(isNum); return n.length ? n.reduce((a, b) => a + b, 0) : undefined }
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<T>
}
