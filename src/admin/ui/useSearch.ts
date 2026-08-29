import { useEffect, useState } from 'react'
import type { Page } from '../../core/pagination'
import type { SearchSort, StoryMeta } from '../../core/story'

/**
 * Documents matching a query, debounced — the client half of
 * `GET {base}/api/search` (`docs/specs/foundation/pagination.md` decision 8).
 *
 * **This was `usePageSearch`, and the rename is the whole change.** It asked
 * `?flat=1&q=`, which was the stopgap the palette got when the shell stopped
 * holding every story: flat mode is every *routed page*, so `⌘K` reached page 5,000
 * of a large site and could not find a person at all. The palette papered over that
 * by ranking the boot payload's records alongside the search results, which only
 * worked because the boot payload was every record on the site.
 *
 * One route replaces both halves. It spans every kind, and it reaches
 * `content_index`'s values — so a record is findable by the field that identifies
 * it, not only by its title cache.
 *
 * Decision 8 names three consumers and this is the first. The link and reference
 * pickers are the other two; they filter a full list in memory today and adopt this
 * with their own ports (`?kind=page` and `?kind=record` are the axis they need,
 * which is why the route has it before anything passes it).
 */

/** Long enough that typing a word is one request, short enough to feel immediate.
 * The same figure the editor's debounced draft write uses. */
const DEBOUNCE_MS = 150

/** Twenty is what a palette shows before scrolling stops being a list and starts
 * being a page. It is also the route's own default. */
const LIMIT = 20

export interface SearchResults {
  query: string
  setQuery: (next: string) => void
  rows: readonly StoryMeta[]
}

/**
 * `sort` decides **which twenty rows get ranked**, not the order they appear in —
 * `rank.ts` does that on the client. `edited` for the palette, because the twenty
 * most recently touched documents contain the one you were working on and the
 * twenty alphabetically first contain whatever begins with "A". `core/story.ts`'s
 * `SearchSort` carries the argument.
 */
export function useSearch(
  apiBase: string,
  active: boolean,
  sort: SearchSort = 'edited',
): SearchResults {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<readonly StoryMeta[]>([])

  useEffect(() => {
    if (!active) {
      // Closing clears the results rather than caching them: the next ⌘K starts on
      // an empty query, so stale rows from the last search would be the first thing
      // it showed.
      setQuery('')
      setRows([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ sort, limit: String(LIMIT) })
      if (query.trim()) params.set('q', query.trim())
      fetch(`${apiBase}/search?${params}`)
        .then(
          async (res): Promise<readonly StoryMeta[]> =>
            res.ok ? (await (res.json() as Promise<Page<StoryMeta>>)).rows : [],
        )
        .then((found) => {
          if (live) setRows(found)
        })
        .catch(() => {
          // A failed search is an empty list, not a toast: the palette is a
          // navigation aid and an error banner inside it would be in the way of the
          // screens it can still reach.
          if (live) setRows([])
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [apiBase, active, query, sort])

  return { query, setQuery, rows }
}
