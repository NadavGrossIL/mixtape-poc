// CodeMirror 6 for the panel's three editable tabs (C4). Hand-wired rather
// than through a React wrapper package: the view is created once per file and
// lives outside React's render, so the theme, the keymap and the lifecycle are
// ours. Every colour is a `var(--…)` from styles.css, so one theme object
// serves dark and light — the tokens flip, the editor follows.
import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { MergeView } from '@codemirror/merge'
import { tags as t } from '@lezer/highlight'

/** Language by extension. `.yaml`/`.yml` get none — no lezer YAML here, and plain text reads fine. */
function langOf(path: string): Extension[] {
  if (/\.(mjs|cjs|js|jsx|ts|tsx)$/i.test(path)) return [javascript({ typescript: /\.tsx?$/i.test(path) })]
  if (/\.mdx?$/i.test(path)) return [markdown()]
  if (/\.json$/i.test(path)) return [json()]
  return []
}

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '8px', height: '100%' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '2px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.5', borderRadius: '8px' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--line)', borderRadius: '8px 0 0 8px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-3)', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  '.cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 22%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 28%, transparent)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)', outline: '1px solid var(--accent)' },
  '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)', outline: '1px solid var(--accent-dim)' },
  '&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket': { color: 'var(--err)', outline: '1px solid var(--err)' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panel.cm-search': { font: '12px var(--font)', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    font: 'inherit', color: 'var(--text)', backgroundColor: 'var(--bg-3)', backgroundImage: 'none',
    border: '1px solid var(--line-2)', borderRadius: '6px', padding: '2px 8px', margin: '0 4px 0 0',
  },
  '.cm-panel.cm-search button:hover': { borderColor: 'var(--accent)' },
  '.cm-panel.cm-search label': { color: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', border: 0, background: 'none', padding: '0 6px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--text)' },
  // the merge view's chunks: the a side is what is on disk, the b side what we would write
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--err) 14%, transparent)' },
  '&.cm-merge-b .cm-changedLine, .cm-insertedLine, .cm-inlineChangedLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': {
    background: 'color-mix(in srgb, var(--err) 30%, transparent)', color: 'var(--text)',
  },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--accent) 32%, transparent)', color: 'var(--text)' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: 'var(--err)' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--accent)' },
  '.cm-collapsedLines': { color: 'var(--muted)', background: 'var(--bg-2)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' },
}, { dark: false }) // the tokens carry the palette; CodeMirror's own light/dark defaults are all overridden above

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.self], color: 'var(--syn-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.monospace], color: 'var(--syn-str)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta, t.processingInstruction], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: 'var(--syn-num)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName), t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--syn-prop)' },
  { tag: [t.heading], color: 'var(--syn-kw)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syn-prop)', textDecoration: 'underline' },
  { tag: [t.quote, t.contentSeparator], color: 'var(--syn-comment)' },
  { tag: [t.list], color: 'var(--syn-num)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-kw)' },
  { tag: [t.escape, t.character], color: 'var(--syn-num)' },
  { tag: [t.invalid], color: 'var(--err)' },
])

/** Everything both the editor and the two merge panes want. */
const common = (path: string): Extension[] => [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
  EditorState.tabSize.of(2), indentUnit.of('  '),
  theme, EditorView.lineWrapping, syntaxHighlighting(highlight), ...langOf(path),
]

/**
 * One file in a CodeMirror view. `value` is the source of truth: the view is
 * built once (per `path`/`readOnly`) and an outside change — Revert — is
 * dispatched into the existing doc, so the cursor, the undo history and the
 * scroll position survive. A reload after a 409 is different: FileEditor
 * drops to its "Loading…" line while it refetches, which unmounts this view;
 * the rebuilt editor starts with a fresh undo history. `onSave` is Mod-s, the
 * same door as the Save… button: it opens the diff, it does not write.
 */
export function CodeEditor({ value, onChange, path, readOnly, onSave, label, scrollToLine }: {
  value: string; onChange?: (v: string) => void; path: string; readOnly?: boolean; onSave?: () => void; label?: string; scrollToLine?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cb = useRef({ onChange, onSave })
  cb.current = { onChange, onSave }

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...common(path),
          history(), drawSelection(), indentOnInput(), bracketMatching(),
          highlightActiveLine(), highlightSelectionMatches(), rectangularSelection(),
          search({ top: true }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cb.current.onSave?.(); return true } },
            indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
          ]),
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange?.(u.state.doc.toString()) }),
          EditorView.contentAttributes.of({ 'aria-label': label ?? path }),
        ],
      }),
    })
    view.current = v
    // Esc belongs to the editor — it closes the search panel. The page's Esc (close
    // the node panel) must not fire too, or dismissing the search bar would take the
    // panel and the unsaved text with it. The target is already detached from the DOM
    // by then, so App's `closest('.cm-editor')` guard cannot see it: stop it here.
    const stopEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation() }
    parent.addEventListener('keydown', stopEsc)
    return () => { parent.removeEventListener('keydown', stopEsc); v.destroy(); view.current = null }
  }, [path, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc.toString()
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  // Open at a line — the ledger row of the run on screen. The cursor goes there
  // (so the active-line highlight marks it) and the view scrolls it to the
  // middle. A line past the end of the document is simply the last one.
  useEffect(() => {
    const v = view.current
    if (!v || !scrollToLine) return
    const line = v.state.doc.line(Math.min(Math.max(1, scrollToLine), v.state.doc.lines))
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  }, [scrollToLine, value])

  return <div className="cm-host" ref={host} />
}

/**
 * The save preview: `@codemirror/merge` side by side — left is the file as we
 * loaded it, right is what Write file would put on disk. Both read-only (no
 * revert arrows: the only write path is the button below), unchanged stretches
 * collapsed so a one-line change in a 300-line script reads as one line.
 * `heads` renames the two sides: slice 4 reuses this view to put the frozen
 * script the engine ran next to the live repo file.
 */
export function DiffEditor({ original, modified, path, heads = ['on disk', 'after write'] }: { original: string; modified: string; path: string; heads?: [string, string] }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const side = [...common(path), EditorState.readOnly.of(true), EditorView.editable.of(false)]
    const mv = new MergeView({
      parent,
      a: { doc: original, extensions: side },
      b: { doc: modified, extensions: side },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })
    return () => mv.destroy()
  }, [original, modified, path])
  return (
    <div className="cm-diff" aria-label="diff preview">
      <div className="cm-diff-heads" aria-hidden="true"><span>{heads[0]}</span><span>{heads[1]}</span></div>
      <div className="cm-diff-body" ref={host} />
    </div>
  )
}
