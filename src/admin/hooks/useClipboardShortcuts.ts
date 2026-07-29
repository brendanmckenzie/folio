import { useEffect } from 'react'
import type { Blocks } from './useBlocks'

/**
 * `Cmd`/`Ctrl+C` and the browser's own `paste` event, mirroring
 * `useUndoShortcut`'s input-focus rule: a copy or paste while the focus is
 * inside a text input, a textarea, or a richtext field's contenteditable must
 * reach *that* field's own clipboard handling, not the document store's — a
 * copy inside a richtext field still has to copy text.
 *
 * Copy is a keydown handler (architecture decision 3: `navigator.clipboard.
 * writeText` inside the user gesture, so the same `blocks.copy` a menu action
 * calls). Paste listens to the native `paste` event instead of a keydown,
 * specifically so it can read `event.clipboardData` — the one path that needs
 * no `clipboard-read` permission at all.
 */
export function useClipboardShortcuts(
  blocks: Pick<Blocks, 'copy' | 'paste'>,
  selection: string | null,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return
      if (!isPlainFocus()) return
      if (!selection) return
      e.preventDefault()
      void blocks.copy(selection)
    }

    const onPaste = (e: ClipboardEvent) => {
      if (!isPlainFocus()) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      blocks.paste(text)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('paste', onPaste)
    }
  }, [blocks, enabled, selection])
}

/** The shape this needs from `document.activeElement` — duck-typed rather
 * than `instanceof HTMLInputElement`, which is both untestable outside a real
 * DOM and unreliable across the preview iframe's own window. Pure and
 * exported so the rule is tested directly. */
interface FocusedLike {
  tagName?: string
  isContentEditable?: boolean
}

export function isPlainFocus(active: FocusedLike | null = document.activeElement): boolean {
  if (!active) return true
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return false
  if (active.isContentEditable) return false
  return true
}
