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
 * **Two-key sequences as well as chords**, because `ui-architecture.md`'s keyboard
 * map specifies `g` then `h c d a m r x s`. A sequence is written with a space —
 * `'g c'` — and matched by `LEAD_MS` of memory, which is the whole state machine:
 * a bare leader key arms, the next bare key resolves, and anything else disarms.
 *
 * Two rules the obvious implementation gets wrong:
 *
 * - **A leader only arms when it is not itself a binding.** `g` is not bound alone,
 *   so pressing it is unambiguous; a key that were both would have to wait `LEAD_MS`
 *   before doing anything, which is a shortcut that feels broken.
 * - **`preventDefault` on the leader, but only if a sequence starts with it.**
 *   Otherwise typing `g` anywhere outside a field would be swallowed by a mechanism
 *   that had no binding to run.
 *
 * The timeout exists so an armed leader cannot ambush a keystroke a minute later.
 * Rejected: arming until the next keypress whatever it is, which turns one stray `g`
 * into a navigation the next time you press `h`.
 */
/**
 * How long a sequence leader stays armed. Long enough to be typed deliberately by
 * somebody who knows the map, short enough that a stray press cannot capture an
 * unrelated keystroke later.
 */
const LEAD_MS = 1200

/**
 * The leader keys a binding map declares, e.g. `{'g'}` for `'g c'`.
 *
 * Exported for the test, because it is the one part of the sequence machine that is a
 * pure function over the map — the rest lives in an effect that owns a timer, and no
 * admin test mounts anything.
 */
export function leadersOf(bindings: Bindings): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(bindings)) {
    const space = key.indexOf(' ')
    if (space > 0) out.add(key.slice(0, space))
  }
  return out
}

export function useShortcuts(bindings: Bindings) {
  // Held in a ref rather than named as a dependency: a map written inline is a
  // fresh object every render, and re-subscribing a window listener per render
  // is the bug this avoids. Same shape as `useSpace`'s `onEvent`.
  const latest = useRef(bindings)
  latest.current = bindings

  useEffect(() => {
    /** The armed leader, and when it expires. Null when nothing is armed. */
    let armed: { key: string; at: number } | null = null

    const onKey = (e: KeyboardEvent) => {
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey
      const map = latest.current
      const pressed = chord(e)

      // A sequence's second key. Checked before anything else, so an armed `g`
      // followed by `c` cannot also be read as the bare chord `c`.
      if (armed && bare) {
        const expired = Date.now() - armed.at > LEAD_MS
        const run = expired ? undefined : map[`${armed.key} ${pressed}`]
        armed = null
        if (run) {
          e.preventDefault()
          run(e)
          return
        }
        // Fall through: an unrecognised or expired second key is an ordinary
        // keypress, not a swallowed one.
      }

      const run = map[pressed]
      if (run) {
        if (bare && !isPlainFocus()) return
        e.preventDefault()
        run(e)
        return
      }

      // Arm, if this key leads a sequence and is not a binding of its own. Never
      // while focus is in a field: `g` belongs to whoever is typing.
      if (bare && isPlainFocus() && leadersOf(map).has(pressed)) {
        armed = { key: pressed, at: Date.now() }
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
