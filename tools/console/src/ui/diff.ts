// A line diff for the save preview: LCS over lines, then a walk-back. The
// files here are a few hundred lines (a SKILL.md, a workflow script), so the
// O(n·m) table is fine and a library would be more code than this.

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string } | { kind: 'skip'; count: number }

export function diffLines(before: string, after: string): DiffLine[] {
  const a = split(before), b = split(after)
  const n = a.length, m = b.length
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ kind: 'ctx', text: a[i++] }), j++
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ kind: 'del', text: a[i++] }) // removed before added, as `diff -u` orders a replacement
    else out.push({ kind: 'add', text: b[j++] })
  }
  return out
}

/** Collapse context beyond `context` lines around a change into `skip` markers, like a unified diff. */
export function hunks(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => { if (l.kind !== 'ctx') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (keep[i]) { if (skipped) out.push({ kind: 'skip', count: skipped }); skipped = 0; out.push(l) }
    else skipped++
  })
  if (skipped) out.push({ kind: 'skip', count: skipped })
  return out
}

export const changed = (lines: DiffLine[]) => lines.some((l) => l.kind === 'add' || l.kind === 'del')

/** Lines without a trailing empty element for a final newline, so "add a newline at EOF" is one line, not two. */
function split(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
