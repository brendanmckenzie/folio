import { useCallback, useState } from 'react'
import { afterWrite, expectOk, send } from '../api'
import type { Notify } from './useNotice'

/** How long the "Published" flash stays next to the button. */
const FLASH_MS = 2000

export interface Publish {
  publish: () => Promise<void>
  publishing: boolean
  /** The transient confirmation next to the button. */
  published: boolean
}

interface Options {
  apiBase: string
  storyId: string
  notify: Notify
  /**
   * Reloads whatever the publish changed: the tree's badge and the version
   * list. Runs only after a publish the server accepted, and its own failure is
   * not reported as the publish failing.
   */
  onPublished: () => Promise<void>
}

export function usePublish({ apiBase, storyId, notify, onPublished }: Options): Publish {
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)

  const publish = useCallback(async () => {
    setPublishing(true)
    try {
      // A refused publish used to flash "Published" anyway and then reload the
      // same unpublished tree, which is the one failure mode worse than an error.
      await expectOk(await send(`${apiBase}/story/${encodeURIComponent(storyId)}/publish`, 'POST'))
      setPublished(true)
      setTimeout(() => setPublished(false), FLASH_MS)
      // Everything after the line above describes a publish that has happened,
      // so `onPublished` goes through `afterWrite`: letting its rejection reach
      // the catch would put an error toast next to the green flash, which is the
      // same contradiction the other way round.
      await afterWrite(onPublished())
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }, [apiBase, notify, onPublished, storyId])

  return { publish, publishing, published }
}
