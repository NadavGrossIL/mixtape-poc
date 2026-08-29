import type { GraphNode, WorkflowFile } from '../types'

// One line under a node that says what the step is for. The factory's own
// labels get a fixed sentence (matched on the static pattern, so `gate:1`
// and `gate:after-review-fix` read like `gate:*`); anything else falls back
// to the file the node runs — the skill's or the agent's description — and
// last to the prompt's own first sentence. Copy is docs/factory IA-SPEC §4.3.

const PURPOSE: [RegExp, string][] = [
  [/^implement$/, '/implement on the spec, test-first, gate run'],
  [/^gate(?::|$)/, 'npm run gate'],
  [/^fix:gate(?:-|$)/, 'fix round after a failed gate'],
  [/^fix:review$/, 'fix round after a failed review'],
  [/^contract(?::|$)/, 'acceptance checks extracted from the spec'],
  [/^review(?::|$)/, 'read-only reviewer judges the diff against the contract'],
  [/^check$/, 'every factual claim replayed against code and data'],
  [/^clarity$/, 'places two engineers would build different things'],
  [/^craft$/, 'structure, durability, metrics, scope'],
  [/^apply$/, 'corrections and must-adds written into the spec'],
]
const MAX_PROMPT = 72

/** Text up to the first sentence end (`.`, `!` or `?` followed by whitespace or the end) or newline, without the terminator. Empty in → empty out. */
export function firstSentence(s: string | undefined): string {
  const t = (s ?? '').trim()
  if (!t) return ''
  const m = /[.!?](?=\s|$)|\n/.exec(t)
  return (m ? t.slice(0, m.index) : t).trim()
}

export function purposeOf(node: GraphNode, files: WorkflowFile[]): string {
  const label = node.label.trim().toLowerCase()
  for (const [re, line] of PURPOSE) if (re.test(label)) return line
  const desc = (kind: 'skill' | 'agent', name: string | undefined) => (name ? firstSentence(files.find((f) => f.kind === kind && f.name === name)?.meta?.description) : '')
  const fromSkill = desc('skill', node.skill)
  if (fromSkill) return fromSkill
  const fromAgent = desc('agent', node.agentType)
  if (fromAgent) return fromAgent
  const fromPrompt = firstSentence(node.prompt).replace(/\s+/g, ' ')
  if (fromPrompt) return fromPrompt.length > MAX_PROMPT ? fromPrompt.slice(0, MAX_PROMPT).trimEnd() + '…' : fromPrompt
  return '—'
}
