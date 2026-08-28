import type { Graph, GraphEdge, GraphNode } from '../types'
import { kindOf, nodeId } from './parseScript'

// A deliberately tiny reader for Archon workflow YAML of this shape:
//   name: implement-from-spec
//   nodes:
//     - id: gate
//       depends_on: [implement]
//       loop: { interactive: true }
// Not a YAML parser. It reads `name:`, each `- id:` under `nodes:`, its
// `depends_on` (flow `[a, b]` or block `- a` list) and whether the node's
// `loop:` / `interactive:` marks it as a human stop.

interface YNode { id: string; depends: string[]; interactive: boolean }

export function parseYaml(text: string): Graph {
  const lines = text.split(/\r?\n/)
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const nodes: YNode[] = []
  let inNodes = false
  let nodesIndent = -1
  let cur: YNode | null = null
  let collectingDeps = false
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const t = line.trim()
    if (/^nodes:\s*$/.test(t) && indent === 0) { inNodes = true; nodesIndent = indent; continue }
    if (!inNodes) continue
    if (indent <= nodesIndent && !t.startsWith('-')) { inNodes = false; continue }
    const idM = /^-\s*id:\s*(.+)$/.exec(t)
    if (idM) { cur = { id: idM[1].trim(), depends: [], interactive: false }; nodes.push(cur); collectingDeps = false; continue }
    if (!cur) continue
    const depFlow = /^depends_on:\s*\[(.*)\]\s*$/.exec(t)
    if (depFlow) { cur.depends = depFlow[1].split(',').map((s) => s.trim()).filter(Boolean); collectingDeps = false; continue }
    if (/^depends_on:\s*$/.test(t)) { collectingDeps = true; continue }
    if (collectingDeps && t.startsWith('-')) { cur.depends.push(t.slice(1).trim()); continue }
    collectingDeps = false
    if (/interactive:\s*true/.test(t)) cur.interactive = true
  }
  const gnodes: GraphNode[] = nodes.map((n) => ({
    id: nodeId(n.id),
    label: n.id,
    phase: n.id,
    kind: n.interactive && kindOf(n.id) === 'agent' ? 'human' : kindOf(n.id),
  }))
  const edges: GraphEdge[] = []
  for (const n of nodes) for (const d of n.depends) edges.push({ source: nodeId(d), target: nodeId(n.id) })
  // Archon has no phases; each node is its own lane, in file order.
  return { name, phases: gnodes.map((n) => n.phase), nodes: gnodes, edges }
}
