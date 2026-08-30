import { useCallback, useState } from 'react'

// Per-viewer conveniences, remembered in the browser: the disclosures slice 5
// folds away (the skills table, the legend, the context grid) and the node
// panel's width. A reader who opens one of them means it, so the choice
// outlives the page. This is the whole of the console's browser state and the
// only place that touches `localStorage` — never a run, never a definition,
// which are read from disk every time (plan §11.7).

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

/**
 * One remembered number — the panel's width. `clamp` runs on whatever comes
 * back, so a width stored by an older layout (or by hand) is still a legal one.
 * Read and write are separate because the width moves with the pointer and is
 * only worth storing when the drag ends.
 */
export function readNumber(key: string, fallback: number, clamp: (n: number) => number = (n) => n): number {
  try {
    const v = localStorage.getItem(key)
    return v == null || v === '' ? fallback : clamp(Number(v))
  } catch { return fallback }
}

export function saveNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)) } catch { /* storage blocked: the choice lives for this page only */ }
}
