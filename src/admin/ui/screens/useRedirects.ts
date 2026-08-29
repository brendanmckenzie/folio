import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import { type RedirectRow, type RedirectsUrl, redirectsParams } from './redirects-model'
import { messageOf } from './useContent'

/**
 * The Redirects screen's data: one page of the redirect table.
 *
 * The same shape as `useDocuments` — one page, a cursor stack for *previous*, and a
 * reload — because it is the same job over a route that was already doing it
 * properly. `listRedirects` is where `core/pagination.ts` came from
 * (`docs/specs/foundation/pagination.md` decision 6), so this is the first screen
 * whose paging needed nothing added to the reader beyond a count and a search.
 *
 * Everything decidable is in `redirects-model.ts`; what is here is `fetch` and the
 * state it lands in.
 *
 * Not a copy of `admin/hooks/useRedirects.ts`, which is the *old* admin's and still
 * ships until port phase 8. That one holds `source` in `useState` and fetches only
 * the first page, which is the two things this replaces: the filter belongs in the
 * URL, and page two exists.
 */

/** Rows per request. The route defaults to 50 and clamps at 200. Fifty is roughly
 * two screens, which makes paging the exception rather than the rhythm. */
const PAGE = 50

/**
 * How long the search box waits before it is a request.
 *
 * The same reasoning `useDocuments` records: the header asks `?count=1`, so an
 * undebounced box does not just run a query per keystroke, it drags a full
 * `count(*)` over the table behind each one. 150ms, matching the palette's search
 * and the editor's debounced draft write.
 */
const DEBOUNCE_MS = 150

export interface RedirectsData {
  page: Page<RedirectRow> & { loading: boolean; error?: string }
  /** Cursors already visited, so *previous* is a pop rather than a reverse query.
   * Keyset paging only goes forwards; a client-side stack is what makes next /
   * previous work without the route learning a second direction. */
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after a write. */
  reload: () => void
}

export function useRedirects(apiBase: string, url: RedirectsUrl): RedirectsData {
  const [page, setPage] = useState<RedirectsData['page']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  /**
   * The query the *request* uses, which trails what is in the box by `DEBOUNCE_MS`.
   *
   * Only `q` is debounced. A chip and a page are single deliberate gestures and
   * should answer immediately; a search term arrives one character at a time, and
   * its intermediate states are not states anybody asked to see.
   */
  const q = useDebounced(url.q)
  const settled = { ...url, q }

  // Serialised, because a fresh object every render would restart the effect below.
  // The string is also exactly what goes on the wire, so there is no second
  // representation to keep in step.
  const params = redirectsParams(settled, { limit: PAGE, cursor, count: true }).toString()

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/redirects?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setPage({ ...((await res.json()) as Page<RedirectRow>), loading: false })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, params])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  /**
   * A filter change invalidates the cursor stack: it is a different set, so a
   * cursor from the old one would resume at a position that no longer exists.
   *
   * Keyed on the request *minus* the cursor — the same string the fetch uses, with
   * the one parameter that is allowed to change without a reset taken out. Deriving
   * it rather than listing `source` and `q` separately is what keeps a third filter
   * from being added without a reset.
   */
  const identity = redirectsParams(settled, { limit: PAGE, count: true }).toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger, not a value the body reads — it only clears. Naming it is the point; reading it to satisfy the rule would misstate what this depends on
  useEffect(() => {
    setCursor(null)
    setHistory([])
  }, [identity])

  const nextPage = useCallback(() => {
    if (!page.cursor) return
    setHistory((prev) => [...prev, cursor])
    setCursor(page.cursor)
  }, [page.cursor, cursor])

  const prevPage = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      setCursor(prev[prev.length - 1] ?? null)
      return prev.slice(0, -1)
    })
  }, [])

  return { page, canGoBack: history.length > 0, nextPage, prevPage, reload: fetchPage }
}

/**
 * A value that trails its input by `DEBOUNCE_MS`.
 *
 * The third copy of six lines, and it stays local for the reason `useDocuments`
 * gives: this belongs in `ui/` the moment something other than a search box wants
 * it, and a shared hook with one shape and three identical callers is a decision
 * that can be made in one edit later. Promoting it now would mean touching a shared
 * file while three screens are being built in parallel.
 */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
