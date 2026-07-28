import { useEffect } from 'react'
import type { StoryStore } from '../store'

/**
 * Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z on the document store.
 *
 * `enabled` is false while a past version is on screen: undo would edit the live
 * document, which is not what the screen is showing.
 */
export function useUndoShortcut(store: StoryStore, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      // A rich text field keeps its own history: TipTap must undo the keystroke,
      // not the document store, which would revert the whole field instead.
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return
      e.preventDefault()
      if (e.shiftKey) store.redo()
      else store.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, store])
}
