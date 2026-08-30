import { useCallback, useState } from 'react'

// Disclosure state, remembered per viewer. Slice 5 folds the reference material
// away (the skills table, the legend, the context grid); a reader who opens one
// of them means it, so the choice outlives the page. Same rule as the panel's
// width: localStorage is for per-viewer conveniences only — never for runs or
// definitions, which are read from disk every time.

/** `localStorage` in a private window (or with storage blocked) throws on read as well as write; the default stands and the choice lives for this page only. */
function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : v === '1'
  } catch { return fallback }
}

/** One remembered boolean: `[open, setOpen]`, written through on every change. */
export function useRemembered(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => read(key, fallback))
  const set = useCallback((v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* storage blocked: the choice lives for this page only */ }
  }, [key])
  return [open, set]
}
