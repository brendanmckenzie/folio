import { type RefObject, useEffect } from 'react'

/**
 * What the cycle needs to know about a candidate element. Duck-typed rather
 * than `HTMLElement` so the rule stays a pure function that can be tested
 * without a DOM — the same trick `isPlainFocus` plays in
 * `useClipboardShortcuts.ts`, and for the same reason: the admin's unit tests
 * run in Node with no jsdom.
 */
export interface Tabbable {
  /**
   * `'until-found'` is the third state of the DOM property — hidden, but
   * revealed by find-in-page. It is not focusable while hidden, and being
   * truthy it is excluded here for free.
   */
  hidden?: boolean | 'until-found'
  disabled?: boolean
  /**
   * The DOM *property*, not the attribute: a `<button>` carrying no `tabindex`
   * reads 0, anything holding itself out of the order with `tabindex="-1"`
   * reads -1.
   */
  tabIndex?: number
}

/**
 * Whether Tab would land on this, given it is already one of the element kinds
 * Tab visits at all (`CANDIDATES`).
 *
 * None of the three exclusions is defensive padding — the media library really
 * has all three. Its Upload button is `disabled` for the length of an upload,
 * the file input behind it is `hidden`, and its scrim is a real `<button>` kept
 * out of the order with `tabIndex={-1}`. A cycle that counted any of them would
 * send Tab to something that cannot take focus, which reads as the trap being
 * broken rather than as a skipped control.
 */
export function isTabbable(el: Tabbable): boolean {
  if (el.hidden || el.disabled) return false
  return (el.tabIndex ?? 0) >= 0
}

/** The element kinds Tab visits, before `isTabbable` narrows them. */
const CANDIDATES = 'a[href],button,input,select,textarea,[tabindex]'

/** Everything inside `root` that Tab would land on, in document order. */
export function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES)).filter(isTabbable)
}

/**
 * Modal keyboard behaviour for a dialog: focus moves in when it opens and back
 * to the opener when it closes, Tab and Shift+Tab cycle inside it, and Escape
 * dismisses it.
 *
 * `panel` is the element carrying `role="dialog"`, and that element must be the
 * **panel, not the overlay**. Every dialog here sits inside a full-screen
 * wrapper holding a scrim `<button>` as a sibling of the panel; pointing this
 * at the wrapper would both put a bare "Cancel" button inside the region the
 * dialog names and pull the scrim into the tab cycle. Give the panel
 * `tabIndex={-1}` too, so it can hold focus itself when it contains nothing
 * that can.
 *
 * `onClose` is what Escape calls. It may be a fresh closure on every render —
 * that is the normal case, and the reason the two effects below are kept apart
 * rather than merged.
 */
export function useFocusTrap(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  /**
   * Mount and unmount only, deliberately. Folding this into the key handler
   * below would re-run it on every render of the component above — which
   * re-steals focus back to the first control while somebody is still moving
   * through the dialog. `panel` is a ref object, whose identity never changes,
   * so naming it as a dependency does not make this run again.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panelEl = panel.current
    // The first thing Tab would reach. The panel itself is the fallback when
    // there is nothing yet — a grid still loading, every button disabled behind
    // a request in flight.
    if (panelEl) (tabbable(panelEl)[0] ?? panelEl).focus()
    return () => {
      // Only if the opener is still in the document: focusing a detached node
      // quietly sends focus to <body>, which is worse than leaving it alone.
      if (opener?.isConnected) opener.focus()
    }
  }, [panel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panelEl = panel.current
      if (!panelEl) return
      const cycle = tabbable(panelEl)
      // Nothing to land on — an empty library mid-upload. Tab still must not
      // walk out into an editor that is unreachable behind the scrim.
      if (cycle.length === 0) {
        e.preventDefault()
        panelEl.focus()
        return
      }
      const first = cycle[0]!
      const last = cycle[cycle.length - 1]!
      const active = document.activeElement
      // Focus outside the panel is a state to recover from, not just an edge:
      // the scrim is a real button and sits outside it.
      if (!panelEl.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, panel])
}
