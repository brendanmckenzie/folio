import { useEffect, useState } from 'react'

/** How long a message stays on screen before it clears itself. */
const NOTICE_MS = 6000

/** Puts a message in front of the editor. Stable, so hooks can hold onto it. */
export type Notify = (message: string) => void

export interface Notice {
  notice: string | null
  notify: Notify
}

/**
 * The editor's single toast. Every domain hook is handed `notify` rather than its
 * own error state, so a refused publish, a rejected transaction and a failed
 * restore all surface in the same place.
 *
 * The timer is keyed on the message rather than reset per call on purpose:
 * repeating the *same* message is React's no-op update, so a second identical
 * failure does not extend the first one's six seconds.
 */
export function useNotice(): Notice {
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  return { notice, notify: setNotice }
}
