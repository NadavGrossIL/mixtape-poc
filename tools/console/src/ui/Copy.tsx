import { useEffect, useState } from 'react'

// Click-to-copy, the one control slice 4 leans on: every path the console knows
// is a path a human wants in a terminal, and none of them are links a browser
// can follow (they live under ~/.claude, outside the repo the page can serve).

/**
 * U+200E, put around a path shown in a `.ell` box (`direction: rtl`, so the
 * ellipsis lands at the head and the tail — the part that identifies the file —
 * survives). The mark keeps the slashes, which bidi calls neutral, reading left
 * to right inside that box. Display only: what Copy writes is the raw string.
 */
export const LRM = '\u200e'

/** A path, truncated from the left, whole thing in the tooltip. Always through here — a bare path in a `.ell` box loses its leading slash to bidi. */
export function PathText({ path, className, title }: { path: string; className?: string; title?: string }) {
  return <span className={className ? `ell ${className}` : 'ell'} title={title ?? path}>{LRM}{path}{LRM}</span>
}

/** A path over a Copy, as the panel shows the file it is reading. */
export function PathRow({ path, label = 'copy path' }: { path: string; label?: string }) {
  return (
    <p className="path-row">
      <PathText path={path} className="path" />
      <CopyButton text={path} label={label} />
    </p>
  )
}

/** Copies with the clipboard API; `false` where it is missing (a non-secure origin, an old browser) so the caller can leave the text selectable and say nothing. */
export async function copyText(text: string): Promise<boolean> {
  const c = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!c) return false
  try { await c.writeText(text); return true } catch { return false }
}

/** Copies `text` and says `copied` for 1.5 s. `label` shortens it where a row carries several. */
export function CopyButton({ text, label = 'Copy', title }: { text: string; label?: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  return (
    <button
      type="button"
      className="btn btn-small copy"
      data-copied={copied || undefined}
      title={title}
      onClick={() => { void copyText(text).then((ok) => ok && setCopied(true)) }}
      aria-label={`Copy: ${text}`}
    >
      {copied ? 'copied' : label}
    </button>
  )
}
