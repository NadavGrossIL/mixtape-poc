import type { Graph, GraphEdge, GraphNode, NodeKind } from '../types'

// Static reading of a native workflow script. The factory scripts are short and
// regular: `export const meta = { phases: [{ title }] }` and `agent(prompt, {
// label, phase })` calls — top-level or inside helper functions (`runGate`),
// sometimes inside `pipeline(` / `parallel(` blocks. Labels and phases are
// string literals in any quote style, or start with one (`'review:' + key`,
// `` `gate:${round}` ``), which becomes a template node `review:*` that a run
// expands into real nodes. A `fix:<checker>` label is a loop, not a step:
// it is drawn back from the checker it names and into the gate again, with
// the enclosing `for` bound as its label. Nothing here evaluates the script.

export function kindOf(label: string): NodeKind {
  const l = label.toLowerCase()
  if (l === 'gate' || l.startsWith('gate:') || l.startsWith('gate ')) return 'gate'
  if (l.startsWith('human') || l.startsWith('approve')) return 'human'
  return 'agent'
}

export function nodeId(label: string): string {
  return label.replace(/[^\w:*.-]+/g, '_').toLowerCase()
}

/** Index just past the string literal opening at `i` (a quote or backtick). */
function skipString(src: string, i: number): number {
  const q = src[i++]
  while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1
  return i + 1
}

/** Index of the paren that closes the one at `open`, skipping strings/templates/comments. */
function matchParen(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return src.length; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i }
    i++
  }
  return src.length
}

/**
 * The options object of an argument list: the last `{` at depth 0. Found by
 * walking, not `lastIndexOf('{')` — a template label `` `gate:${round}` ``
 * ends in a `{` too, and that mistake once emptied the Gate lane.
 */
function optionsOf(body: string): string {
  let depth = 0, at = -1
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(body, i) - 1; continue }
    if (c === '(' || c === '[' || c === '{') { if (depth === 0 && c === '{') at = i; depth++ }
    else if (c === ')' || c === ']' || c === '}') depth--
  }
  return at < 0 ? '' : body.slice(at, matchParen(body, at) + 1)
}

/** The literal opening at `i`, unescaped; a template's `${…}` becomes `*` when `star`, else stays as text. */
function readLiteral(src: string, i: number, star: boolean): { text: string; end: number; open: boolean } {
  const q = src[i]
  let out = ''
  let open = false
  i++
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') { out += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      const close = matchParen(src, i + 1)
      if (star) return { text: out + '*', end: skipToClose(src, close, q), open: true }
      out += src.slice(i, close + 1); i = close + 1; continue
    }
    out += src[i++]
  }
  return { text: out, end: i + 1, open }
}
function skipToClose(src: string, from: number, q: string): number {
  let i = from
  while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1
  return i + 1
}

/** `key: 'literal'` → literal; `key: 'lit' + expr` → `lit*`; template with ${} → prefix + `*`; `key: IDENT` → the const's literal. */
function readStringOption(src: string, options: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`]|[A-Za-z_$][\\w$]*)`).exec(options)
  if (!m) return undefined
  if (!/^['"`]$/.test(m[1])) return constLiteral(src, m[1])
  const lit = readLiteral(options, m.index + m[0].length - 1, true)
  if (lit.open) return lit.text
  return options.slice(lit.end).trimStart().startsWith('+') ? lit.text + '*' : lit.text
}

/**
 * `const NAME = 'x'` → x. When the initializer is an expression (`typeof
 * config.reviewer === 'string' ? config.reviewer : 'reviewer'`) the last
 * literal on the line is the fallback, which is what a static drawing wants.
 */
function constLiteral(src: string, name: string): string | undefined {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=([^\\n;]*)`).exec(src)
  if (!m) return undefined
  const lits = [...m[1].matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2])
  return lits.length ? lits[lits.length - 1] : undefined
}

/** `const MAX = Number(config.maxGateRounds) || 2` → 2: the last integer on the line is the default. */
function constNumber(src: string, name: string): number | undefined {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=([^\\n;]*)`).exec(src)
  const ns = m ? m[1].match(/\b\d+\b/g) : null
  return ns ? Number(ns[ns.length - 1]) : undefined
}

/**
 * How many times the call at `at` can run: the innermost enclosing `for`'s
 * bound (`i <= N` → N, `i < N` → N-1; N a number or a const), 1 outside any
 * loop, undefined when the loop head is not of that shape (`for … of`).
 */
function loopBoundAt(src: string, at: number): number | undefined {
  let bound: number | undefined = 1
  const re = /\bfor\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const close = matchParen(src, open)
    const body = src.indexOf('{', close)
    if (body < 0 || at < body || at > matchParen(src, body)) continue
    const c = /<(=?)\s*([A-Za-z_$][\w$]*|\d+)/.exec(src.slice(open + 1, close))
    const n = !c ? undefined : /^\d/.test(c[2]) ? Number(c[2]) : constNumber(src, c[2])
    bound = n == null ? undefined : c![1] ? n : n - 1
  }
  return bound
}

/** The prompt argument as text: a literal, or a `const NAME = [(…) =>] \`…\`` the call names (also `NAME(args)`). */
function promptText(src: string, arg: string): string | undefined {
  const a = arg.trim()
  if (/^['"`]/.test(a)) return readLiteral(a, 0, false).text
  const name = /^([A-Za-z_$][\w$]*)\s*(?:\(|$)/.exec(a)?.[1]
  if (!name) return undefined
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:\\([^)]*\\)\\s*=>\\s*|[A-Za-z_$][\\w$]*\\s*=>\\s*)?(['"\`])`).exec(src)
  return m ? readLiteral(src, m.index + m[0].length - 1, false).text : undefined
}

/** `Skill({ skill: "x" })` or a `/x` command in the prompt → x. The panel checks it against the skills on disk. */
export function skillOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined
  return /\bSkill\(\s*\{\s*skill\s*:\s*['"`]([\w-]+)/.exec(prompt)?.[1] ?? /(?:^|[\s`'"(])\/([a-z][\w-]*)\b/.exec(prompt)?.[1]
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

interface Call { label: string; phase: string; group: number | null; at: number; agentType?: string; prompt?: string; bound?: number }

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
    const options = optionsOf(body)
    const phase = readStringOption(src, options, 'phase') ?? ''
    const label = readStringOption(src, options, 'label') ?? (phase ? phase.toLowerCase() : `agent ${++anon}`)
    const agentType = readStringOption(src, options, 'agentType')
    const firstArg = options ? body.slice(0, body.lastIndexOf(options)).replace(/,\s*$/, '') : body
    const prompt = promptText(src, firstArg)
    let group: number | null = null
    groups.forEach((gr, i) => { if (a!.index > gr.start && a!.index < gr.end) group = i })
    calls.push({ label, phase, group, at: a.index, agentType, prompt, bound: loopBoundAt(src, a.index) })
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
    if (c.agentType) n.agentType = c.agentType
    if (c.prompt) { n.prompt = c.prompt; const s = skillOf(c.prompt); if (s) n.skill = s }
    seen.set(id, n)
    nodes.push(n)
  }

  // Sequence: consecutive calls in the same group form one parallel block.
  // Declared phase order beats source order — helpers are often defined
  // above the code that calls them, and a phase is the author's own timeline.
  const sorted = metaPhases.length
    ? calls.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c.phase) - rank(b.c.phase)) || (a.i - b.i)).map((x) => x.c)
    : calls
  // `fix:gate-*` loops back from the gate, `fix:review` from the review; both
  // re-enter the gate. A fix whose checker is not in the chain stays a step.
  const loops: { fix: Call; from: Call; into: Call }[] = []
  const ordered = sorted.filter((c) => {
    const checker = /^fix:([a-z]+)/i.exec(c.label)?.[1].toLowerCase()
    const from = checker && sorted.find((o) => o !== c && o.label.toLowerCase().startsWith(checker))
    if (!from) return true
    loops.push({ fix: c, from, into: sorted.find((o) => o !== c && kindOf(o.label) === 'gate') ?? from })
    return false
  })
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
  for (const { fix, from, into } of loops) {
    const id = nodeId(fix.label)
    edges.push({ source: nodeId(from.label), target: id, loop: 'back', label: fix.bound == null ? 'loop' : `≤${fix.bound}` })
    edges.push({ source: id, target: nodeId(into.label), loop: 'retry' })
  }
  return { name, phases, nodes, edges }
}

/** A `/skill` is one node: the skill itself. */
export function parseSkill(name: string): Graph {
  return { name, phases: [name], nodes: [{ id: nodeId(name), label: name, phase: name, kind: kindOf(name), skill: name }], edges: [] }
}
