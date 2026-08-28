import type { Graph, GraphEdge, GraphNode, NodeKind } from '../types'

// Static reading of a native workflow script. The factory scripts are short and
// regular: `export const meta = { phases: [{ title }] }` and `agent(prompt, {
// label, phase })` calls, sometimes inside `pipeline(` / `parallel(` blocks.
// Labels and phases are string literals — or start with one (`'review:' + key`),
// which becomes a template node `review:*` that a run expands into real nodes.

export function kindOf(label: string): NodeKind {
  const l = label.toLowerCase()
  if (l === 'gate' || l.startsWith('gate:') || l.startsWith('gate ')) return 'gate'
  if (l.startsWith('human') || l.startsWith('approve')) return 'human'
  return 'agent'
}

export function nodeId(label: string): string {
  return label.replace(/[^\w:*.-]+/g, '_').toLowerCase()
}

/** Index of the paren that closes the one at `open`, skipping strings/templates/comments. */
function matchParen(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return src.length; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i }
    i++
  }
  return src.length
}

/** `key: 'literal'` → literal; `key: 'lit' + expr` → `lit*`; template with ${} → prefix + `*`. */
function readStringOption(options: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])`).exec(options)
  if (!m) return undefined
  const q = m[1]
  const start = m.index + m[0].length
  let i = start
  let out = ''
  while (i < options.length && options[i] !== q) {
    if (options[i] === '\\') { out += options[i + 1]; i += 2; continue }
    if (q === '`' && options[i] === '$' && options[i + 1] === '{') return out + '*'
    out += options[i]
    i++
  }
  const rest = options.slice(i + 1).trimStart()
  if (rest.startsWith('+')) return out + '*'
  return out
}

function readMetaPhases(src: string): { name?: string; phases: string[] } {
  const metaAt = src.search(/export\s+const\s+meta\s*=\s*\{/)
  if (metaAt < 0) return { phases: [] }
  const open = src.indexOf('{', metaAt)
  const meta = src.slice(open, matchParen(src, open) + 1)
  const name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(meta)?.[1]
  const phasesAt = meta.search(/\bphases\s*:\s*\[/)
  if (phasesAt < 0) return { name, phases: [] }
  const pOpen = meta.indexOf('[', phasesAt)
  const block = meta.slice(pOpen, matchParen(meta, pOpen) + 1)
  const phases: string[] = []
  const re = /\btitle\s*:\s*['"`]([^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) phases.push(m[1])
  return { name, phases }
}

interface Call { label: string; phase: string; group: number | null; at: number }

export function parseScript(src: string): Graph {
  const { name, phases: metaPhases } = readMetaPhases(src)
  // Group ranges: pipeline( … ) / parallel( … ) — agents inside fan out together.
  const groups: { start: number; end: number }[] = []
  const gre = /\b(pipeline|parallel)\s*\(/g
  let g: RegExpExecArray | null
  while ((g = gre.exec(src))) {
    const open = g.index + g[0].length - 1
    groups.push({ start: open, end: matchParen(src, open) })
  }
  const calls: Call[] = []
  const are = /\bagent\s*\(/g
  let a: RegExpExecArray | null
  let anon = 0
  while ((a = are.exec(src))) {
    const open = a.index + a[0].length - 1
    const close = matchParen(src, open)
    const body = src.slice(open + 1, close)
    // options object = last top-level `{ … }` in the argument list
    const optAt = body.lastIndexOf('{')
    const options = optAt >= 0 ? body.slice(optAt, matchParen(body, optAt) + 1) : ''
    const phase = readStringOption(options, 'phase') ?? ''
    const label = readStringOption(options, 'label') ?? (phase ? phase.toLowerCase() : `agent ${++anon}`)
    let group: number | null = null
    groups.forEach((gr, i) => { if (a!.index > gr.start && a!.index < gr.end) group = i })
    calls.push({ label, phase, group, at: a.index })
  }

  const phases = [...metaPhases]
  for (const c of calls) if (c.phase && !phases.includes(c.phase)) phases.push(c.phase)
  const rank = (p: string) => { const i = phases.indexOf(p); return i < 0 ? phases.length : i }

  const nodes: GraphNode[] = []
  const seen = new Map<string, GraphNode>()
  for (const c of calls) {
    const id = nodeId(c.label)
    if (seen.has(id)) continue
    const n: GraphNode = { id, label: c.label, phase: c.phase || phases[0] || '', kind: kindOf(c.label), template: c.label.endsWith('*') }
    seen.set(id, n)
    nodes.push(n)
  }

  // Sequence: consecutive calls in the same group form one parallel block.
  // Declared phase order beats source order — helpers are often defined
  // above the code that calls them, and a phase is the author's own timeline.
  const ordered = metaPhases.length
    ? calls.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c.phase) - rank(b.c.phase)) || (a.i - b.i)).map((x) => x.c)
    : calls
  const blocks: string[][] = []
  let lastGroup: number | null | undefined
  for (const c of ordered) {
    const id = nodeId(c.label)
    if (c.group !== null && c.group === lastGroup && blocks.length) {
      if (!blocks[blocks.length - 1].includes(id)) blocks[blocks.length - 1].push(id)
    } else blocks.push([id])
    lastGroup = c.group
  }
  const edges: GraphEdge[] = []
  const key = (e: GraphEdge) => `${e.source}→${e.target}`
  const have = new Set<string>()
  for (let i = 1; i < blocks.length; i++) {
    for (const s of blocks[i - 1]) for (const t of blocks[i]) {
      const e = { source: s, target: t }
      if (s !== t && !have.has(key(e))) { have.add(key(e)); edges.push(e) }
    }
  }
  return { name, phases, nodes, edges }
}

/** A `/skill` is one node: the skill itself. */
export function parseSkill(name: string): Graph {
  return { name, phases: [name], nodes: [{ id: nodeId(name), label: name, phase: name, kind: kindOf(name) }], edges: [] }
}
