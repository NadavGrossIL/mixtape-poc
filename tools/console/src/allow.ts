// Which repo-relative paths `/api/file` may touch, and in which direction.
//
// Two lists, not one list with a flag. WRITABLE is the C4 fence — the console
// tweaks the line, it cannot reach the product — and a read-only addition must
// never widen it: `POST /api/file` asks for `'write'`, `GET` asks for `'read'`,
// and READ_ONLY is reachable only through the second. Slice 4 adds the run's
// context to the read side: the spec a run worked on, the ledger, and the
// driver's saved results next to it.
//
// Pure and dependency-free (no `node:path`) so `node --test` can run it and so
// nothing here can touch a disk: the caller still resolves the real path and
// checks it stayed inside the repo.

/** GET and POST. A tight character class per segment: no separators, no globbing. */
export const WRITABLE: RegExp[] = [
  /^\.claude\/workflows\/[\w.-]+\.js$/,
  /^\.claude\/skills\/[\w.-]+\/SKILL\.md$/,
  /^\.claude\/agents\/[\w.-]+\.md$/,
  /^\.archon\/workflows\/[\w.-]+\.ya?ml$/,
  /^factory\.config\.json$/,
]

/** GET only — the context of a run: its spec, the ledger, the driver's saved JSON / diff / PR body. */
export const READ_ONLY: RegExp[] = [
  /^specs\/[\w.-]+\.md$/,
  /^docs\/factory\/RUNS\.md$/,
  /^docs\/factory\/runs\/[\w.-]+\.(json|diff|md)$/,
]

/**
 * A repo-relative path in its one canonical form, or `undefined` when it is not
 * one: backslashes become `/`, a leading `./` goes, and any empty, `.` or `..`
 * segment (which is how a traversal is spelled) is rejected outright — the same
 * thing `path.posix.normalize(p) !== p` catches, without the import.
 */
export function normalizePath(rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel) return undefined
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm) return undefined
  for (const seg of norm.split('/')) if (!seg || seg === '.' || seg === '..') return undefined
  return norm
}

/** The normalized path when this mode may have it, else `undefined` (the caller's 403). */
export function allowed(rel: unknown, mode: 'read' | 'write'): string | undefined {
  const norm = normalizePath(rel)
  if (!norm) return undefined
  if (WRITABLE.some((re) => re.test(norm))) return norm
  return mode === 'read' && READ_ONLY.some((re) => re.test(norm)) ? norm : undefined
}

/** Is this path one the console may write? (`allowed(p, 'write')`, as a predicate.) */
export const isWritable = (rel: unknown): boolean => allowed(rel, 'write') !== undefined
