import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { StoryMeta } from '../../../core/story'
import {
  type ContentUrl,
  filterOf,
  filterParams,
  type Level,
  type LevelRow,
  type Levels,
  PENDING,
  ROOT,
} from './content-model'

/**
 * The Content screen's data: levels of the tree, or one page of the flat list.
 *
 * Everything decidable is in `content-model.ts`; this is the part that cannot be
 * pure — `fetch`, and the state it lands in. Kept deliberately thin for the
 * admin's testing convention (no test mounts a component, so logic that matters
 * lives next door in Node-testable functions), and the split held up: every
 * awkward question this screen raised — what rows a partly-loaded tree shows, what
 * `⌥↓` means at the end of a level, what a filter does to the view — turned out to
 * be answerable over plain data.
 */

/** Rows per request. The route defaults to 50 and clamps at 200; a tree level and
 * a flat page both want enough to fill a screen and not much more, because the
 * next one is a keystroke away. */
const PAGE = 50

export interface ContentData {
  /** Tree mode. Keyed by parent id, with `ROOT` for the top level. */
  levels: Levels
  /** Flat mode's current page. */
  flat: Page<StoryMeta> & { loading: boolean; error?: string }
  /** Cursors already visited in flat mode, so *previous* is a pop rather than a
   * reverse query. Keyset paging only goes forwards; a client-side stack is what
   * makes next / previous work without the route learning a second direction. */
  canGoBack: boolean
  /** Ask for a level's first page. Idempotent: a level already loaded or in
   * flight is left alone, which is what makes this safe to call from a render
   * effect on expand. */
  openLevel: (parent: string) => void
  /** Append the next page of a level (the `Show N more` row). */
  moreOfLevel: (parent: string) => void
  nextPage: () => void
  prevPage: () => void
  /** Re-read everything currently on screen, after a write. */
  reload: () => void
}

export function useContent(apiBase: string, url: ContentUrl): ContentData {
  const filter = filterOf(url)
  // Serialised, because a fresh object every render would restart every effect
  // below. The string is also exactly what goes on the wire, so there is no
  // second representation to keep in step.
  const params = new URLSearchParams(filterParams(filter)).toString()

  const [levels, setLevels] = useState<Levels>({})
  const [flat, setFlat] = useState<ContentData['flat']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [flatCursor, setFlatCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  /**
   * Held in a ref and read inside the fetchers rather than named as a dependency.
   *
   * `openLevel` has to be able to tell "not asked for yet" from "in flight", and
   * reading that off `levels` would make every fetcher depend on the state it
   * writes — which restarts the effect that called it. The ref is the same trick
   * `useShortcuts` uses for its bindings and `useSpace` for its event handler.
   */
  const current = useRef<Levels>(levels)
  current.current = levels

  const fetchLevel = useCallback(
    async (parent: string, mode: 'first' | 'more') => {
      const existing = current.current[parent]
      if (mode === 'more' && (!existing || existing.cursor === null)) return
      const query = new URLSearchParams(params)
      query.set('limit', String(PAGE))
      if (parent !== ROOT) query.set('parentId', parent)
      // Only the first page of a level asks for a count: it counts the whole
      // filter rather than the page, so asking again on page two would run the
      // same aggregate for the same answer (`pagination.md` decision 5).
      if (mode === 'first') query.set('count', '1')
      else if (existing?.cursor) query.set('cursor', existing.cursor)

      setLevels((prev) => ({
        ...prev,
        [parent]: { ...(prev[parent] ?? PENDING), loading: true },
      }))
      try {
        const res = await fetch(`${apiBase}/stories?${query}`)
        if (!res.ok) throw new Error(await messageOf(res))
        const page = (await res.json()) as Page<LevelRow>
        setLevels((prev) => {
          const before = prev[parent]
          const kept = mode === 'more' && before ? before.rows : []
          const level: Level = {
            rows: [...kept, ...page.rows],
            cursor: page.cursor,
            ...(page.total === undefined
              ? before?.total === undefined
                ? {}
                : { total: before.total }
              : { total: page.total }),
            loading: false,
          }
          return { ...prev, [parent]: level }
        })
      } catch (e) {
        setLevels((prev) => ({
          ...prev,
          [parent]: {
            ...(prev[parent] ?? { rows: [], cursor: null }),
            loading: false,
            error: (e as Error).message,
          },
        }))
      }
    },
    [apiBase, params],
  )

  /** Flat mode's page, as a callback rather than inline in the effect below, so
   * `reload` can re-run exactly the same request after a write. */
  const fetchFlat = useCallback(async () => {
    const query = new URLSearchParams(params)
    query.set('flat', '1')
    query.set('sort', url.sort)
    query.set('limit', String(PAGE))
    query.set('count', '1')
    if (flatCursor) query.set('cursor', flatCursor)

    setFlat((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/stories?${query}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setFlat({ ...((await res.json()) as Page<StoryMeta>), loading: false })
    } catch (e) {
      setFlat({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, params, url.sort, flatCursor])

  /**
   * The visible view's first read, and **every level is dropped when the filter
   * changes**. Keeping them would leave a level loaded under the previous filter
   * nested inside rows selected by the new one, which is a tree that disagrees with
   * its own filter.
   *
   * `url.sort` reaches this through `fetchFlat`'s identity rather than as a
   * dependency of its own, which is also what resets flat mode to page one when the
   * sort changes — as it must: a cursor is a position in one ordering and means
   * nothing in another.
   */
  useEffect(() => {
    if (url.view === 'tree') {
      setLevels({})
      void fetchLevel(ROOT, 'first')
    } else {
      void fetchFlat()
    }
  }, [fetchLevel, fetchFlat, url.view])

  /**
   * A filter or sort change invalidates the cursor stack: both are a different
   * ordering or a different set, so a cursor from the old one would resume at a
   * position that no longer exists.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: params and url.sort are the trigger, not values the body reads — it only clears. Naming them is the point; reading them to satisfy the rule would misstate what this depends on
  useEffect(() => {
    setFlatCursor(null)
    setHistory([])
  }, [params, url.sort])

  const openLevel = useCallback(
    (parent: string) => {
      const existing = current.current[parent]
      // Idempotent: in flight, or already answered without error, is left alone.
      // That is what lets the component call this straight from its expand
      // handler without tracking what it has already requested — and a level that
      // answered with no rows is *answered*, so an empty parent is not re-asked
      // every time it is opened.
      if (existing?.loading) return
      if (existing && !existing.error) return
      void fetchLevel(parent, 'first')
    },
    [fetchLevel],
  )

  const moreOfLevel = useCallback((parent: string) => void fetchLevel(parent, 'more'), [fetchLevel])

  const nextPage = useCallback(() => {
    if (!flat.cursor) return
    setHistory((prev) => [...prev, flatCursor])
    setFlatCursor(flat.cursor)
  }, [flat.cursor, flatCursor])

  const prevPage = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      setFlatCursor(prev[prev.length - 1] ?? null)
      return prev.slice(0, -1)
    })
  }, [])

  /**
   * Re-read what is on screen, after a write.
   *
   * Calls the same two fetchers the effect above does rather than bumping a
   * counter the effect depends on. The counter version worked and read worse: an
   * `epoch` in a dependency array is a value the body never looks at, which is
   * exactly the shape `useExhaustiveDependencies` is right to complain about.
   *
   * In tree mode this deliberately reloads **only the top level** and drops the
   * rest: after a reorder or a reparent, which levels a row now belongs to is the
   * server's answer, and re-expanding is one keystroke. Refetching every open level
   * would be N requests to rebuild a shape the write may have invalidated anyway.
   */
  const reload = useCallback(() => {
    if (url.view === 'tree') {
      setLevels({})
      void fetchLevel(ROOT, 'first')
    } else {
      void fetchFlat()
    }
  }, [fetchLevel, fetchFlat, url.view])

  return {
    levels,
    flat,
    canGoBack: history.length > 0,
    openLevel,
    moreOfLevel,
    nextPage,
    prevPage,
    reload,
  }
}

/**
 * The message out of Folio's one error envelope, or a fallback.
 *
 * Every failed request answers `{ error: { code, message } }` (`server/app.ts`),
 * and the message is one a route wrote deliberately — "A Person can only go
 * under: …" rather than a status code. Falling back to the status is for the case
 * this cannot happen: a proxy or a dev server answering with something that is not
 * Folio's JSON at all.
 */
export async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // Falls through.
  }
  return `Request failed (${res.status})`
}
