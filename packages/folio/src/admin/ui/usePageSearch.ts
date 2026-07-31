import { useEffect, useState } from 'react'
import type { Page } from '../../core/pagination'
import type { StoryMeta } from '../../core/story'

/**
 * Pages matching a query, debounced, for the palette.
 *
 * **The palette's half of retiring the whole-tree fetch.** It used to rank the
 * boot payload, which meant it could only find a page that had already been
 * transferred — and the transfer was every story on the site. This asks
 * `?flat=1&q=` instead, so `⌘K` reaches page 5,000 of a large site and costs
 * nothing on a small one.
 *
 * `GET {base}/api/search` (`pagination.md` decision 8) is where this ends up: one
 * route over `stories.title`, `slug`, `path` **and** `content_index`'s text values,
 * shared by the palette, every screen's search box and both pickers. Flat mode
 * answers three of those four columns today, which is the part the palette was
 * worst at; swapping the URL below for `/search` is the whole of adopting it.
 */

/** Long enough that typing a word is one request, short enough to feel immediate.
 * The same figure the editor's debounced draft write uses. */
const DEBOUNCE_MS = 150

/** Twenty is what a palette shows before scrolling stops being a list and starts
 * being a page. */
const LIMIT = 20

export interface PageSearch {
  query: string
  setQuery: (next: string) => void
  pages: readonly StoryMeta[]
}

export function usePageSearch(apiBase: string, active: boolean): PageSearch {
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<readonly StoryMeta[]>([])

  useEffect(() => {
    if (!active) {
      // Closing clears the results rather than caching them: the next ⌘K starts on
      // an empty query, so stale rows from the last search would be the first thing
      // it showed.
      setQuery('')
      setPages([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        flat: '1',
        // Sorted by last edited, because with an empty query that is the useful
        // twenty: what you were working on. A ranked query re-sorts them anyway.
        sort: 'edited',
        limit: String(LIMIT),
      })
      if (query.trim()) params.set('q', query.trim())
      fetch(`${apiBase}/stories?${params}`)
        .then(
          async (res): Promise<readonly StoryMeta[]> =>
            res.ok ? (await (res.json() as Promise<Page<StoryMeta>>)).rows : [],
        )
        .then((rows) => {
          if (live) setPages(rows)
        })
        .catch(() => {
          // A failed search is an empty list, not a toast: the palette is a
          // navigation aid and an error banner inside it would be in the way of the
          // screens it can still reach.
          if (live) setPages([])
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [apiBase, active, query])

  return { query, setQuery, pages }
}
