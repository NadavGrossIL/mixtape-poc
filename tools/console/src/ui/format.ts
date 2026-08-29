export const dash = '—'

export function fmtTokens(n?: number): string {
  if (n == null) return dash
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return dash
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function shortModel(m?: string): string {
  if (!m) return dash
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function fmtUsd(n?: number): string {
  return n == null || !Number.isFinite(n) ? dash : `$${n.toFixed(2)}`
}

/** A short tag for where a run happened: `wt` for the driver's worktree (`<slug>.wt`), nothing for the repo itself. */
export function projectTag(slug?: string): string | undefined {
  return slug?.endsWith('.wt') ? 'wt' : undefined
}

export function fmtDate(ms?: number, iso?: string): string {
  const t = ms ?? (iso ? Date.parse(iso) : NaN)
  if (!Number.isFinite(t)) return dash
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
