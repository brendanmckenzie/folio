import { useEffect, useRef } from 'react'
import { isPlainFocus } from '../hooks/useClipboardShortcuts'

/** What `chord` needs from a keyboard event. Duck-typed so the rule is a pure
 * function testable in Node, the same trick `isPlainFocus` plays next door. */
export interface ChordEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * A keypress, normalised to a canonical string: `mod+s`, `mod+shift+z`, `?`,
 * `shift+tab`, `alt+arrowup`.
 *
 * `mod` is Meta *or* Control, deliberately collapsed: a shortcut map that has to
 * name both is a map with two bugs waiting in it, and no admin shortcut needs to
 * tell a Mac from a PC.
 *
 * Shift is named only when it is not already encoded in the character. `?`
 * arrives as `?` and naming shift would make the binding unwriteable; `⇧⌘Z`
 * arrives as `Z`, which lowercases to the same `z` as `⌘Z`, so there the modifier
 * is the only thing telling redo from undo.
 */
export function chord(e: ChordEvent): string {
  const mod = Boolean(e.metaKey || e.ctrlKey)
  const key = e.key.toLowerCase()
  const parts: string[] = []
  if (mod) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey && (mod || key.length > 1)) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * What `⌘S` says. Bound on purpose rather than left to the browser, and the
 * owner's own wording: every keystroke in Folio is already a logged, synced,
 * undoable transaction, so the reflex is asking for reassurance and this is the
 * honest form of it. The binding also stops the browser's Save dialog appearing
 * over the editor, which is the real hazard.
 *
 * Publish deliberately has no chord at all — it is reachable as an action from
 * `⌘K`, which cannot be hit by muscle memory.
 */
export const SAVE_NOTICE = 'Saved! (but you didn’t need to do that)'

export type Bindings = Record<string, (e: KeyboardEvent) => void>

/**
 * One keyboard mechanism for the whole shell, driven by a map rather than by a
 * hook per shortcut. The old admin grew four bindings across three bespoke hooks
 * and had no single place that could answer "what does `⌘K` do here".
 *
 * A **bare** chord (no modifier) is ignored while focus is in a field, so `?`
 * opening help cannot happen while somebody types a question mark into a title.
 * A modified chord always fires, because `⌘S` inside a textarea still has a
 * browser dialog to suppress.
 *
 * Chord matching only. `g c`-style sequences are a state machine this does not
 * have yet and `url-and-shell.md` will need.
 */
export function useShortcuts(bindings: Bindings) {
  // Held in a ref rather than named as a dependency: a map written inline is a
  // fresh object every render, and re-subscribing a window listener per render
  // is the bug this avoids. Same shape as `useSpace`'s `onEvent`.
  const latest = useRef(bindings)
  latest.current = bindings

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = latest.current[chord(e)]
      if (!run) return
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey
      if (bare && !isPlainFocus()) return
      e.preventDefault()
      run(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
