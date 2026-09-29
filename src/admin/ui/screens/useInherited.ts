import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { StoryMeta } from '../../../core/story'
import type { InheritedRow } from '../../../server/stories'
import { messageOf } from './useContent'

/**
 * What Home's *Inherited pages* block reads: the routed pages this scope inherits
 * (`GET /inherited`, keyset-paged by path), and the scope's own home page if it has
 * one (`GET /stories?paths=`, the row at `''`), which is what decides whether
 * *Create home page* is on offer.
 *
 * `enabled` is `showsInherited` — off for `shared` and for a single-site host, where
 * the route does not exist and asking would be a 404 in the console.
 */
export interface InheritedData {
  rows: readonly InheritedRow[]
  more: boolean
  loading: boolean
  failed: boolean
  /** The scope's own row at the root path, or undefined while unknown or absent. */
  ownRoot: StoryMeta | undefined
  /** Whether `ownRoot` has been answered, so the button does not flash on load. */
  rootKnown: boolean
  showMore: () => void
  reload: () => void
}

export function useInherited(apiBase: string, enabled: boolean): InheritedData {
  const [rows, setRows] = useState<readonly InheritedRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [ownRoot, setOwnRoot] = useState<StoryMeta | undefined>(undefined)
  const [rootKnown, setRootKnown] = useState(false)
  const [epoch, setEpoch] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is the reload trigger, not a value the body reads
  useEffect(() => {
    if (!enabled) return
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const [inherited, mine] = await Promise.all([
          fetch(`${apiBase}/inherited?limit=50`),
          fetch(`${apiBase}/stories?${new URLSearchParams({ paths: '' })}`),
        ])
        if (!inherited.ok) throw new Error(await messageOf(inherited))
        const page = (await inherited.json()) as Page<InheritedRow>
        const own = mine.ok
          ? ((await mine.json()) as { rows: StoryMeta[] }).rows.find((row) => row.path === '')
          : undefined
        if (!live) return
        setRows(page.rows)
        setCursor(page.cursor)
        setOwnRoot(own)
        setRootKnown(mine.ok)
        setFailed(false)
      } catch {
        if (live) setFailed(true)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase, enabled, epoch])

  const showMore = useCallback(() => {
    if (cursor === null) return
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase}/inherited?limit=50&cursor=${encodeURIComponent(cursor)}`,
        )
        if (!res.ok) throw new Error(await messageOf(res))
        const page = (await res.json()) as Page<InheritedRow>
        setRows((prev) => [...prev, ...page.rows])
        setCursor(page.cursor)
      } catch {
        setFailed(true)
      }
    })()
  }, [apiBase, cursor])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])
  return { rows, more: cursor !== null, loading, failed, ownRoot, rootKnown, showMore, reload }
}
