import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import { type DocumentRow, type DocumentsUrl, documentsParams } from './documents-model'
import { messageOf } from './useContent'

/**
 * The Documents screen's data: one page of one type's records.
 *
 * Simpler than `useContent` by exactly the amount a flat list is simpler than a
 * tree — there are no levels to accumulate, so this is one page, a cursor stack for
 * *previous*, and a reload. Everything decidable is in `documents-model.ts`; what is
 * here is `fetch` and the state it lands in.
 */

/** Rows per request. The route defaults to 50 and clamps at 200. Twenty was
 * `DataTable.tsx`'s page and it was chosen for a client-side pager over data
 * already transferred; fifty is right when the next page is a request, because it
 * is roughly two screens and makes paging the exception rather than the rhythm. */
const PAGE = 50

/**
 * How long a search box waits before it is a request.
 *
 * **Not optional here, and `pagination.md` decision 5 says why.** Every list
 * header asks `?count=1`, so an undebounced search box does not just run a query
 * per keystroke — it drags a full `count(*)` over the type behind each one. The
 * decision's exact words are that a search box "does not want it", and one request
 * per *settled* query is how this screen honours that: the count is asked for on a
 * query somebody finished typing, which is also the only query whose number is
 * worth reading.
 *
 * The same 150ms as the palette's search and the editor's debounced draft write.
 */
const DEBOUNCE_MS = 150

export interface DocumentsData {
  page: Page<DocumentRow> & { loading: boolean; error?: string }
  /** Cursors already visited, so *previous* is a pop rather than a reverse query.
   * Keyset paging only goes forwards; a client-side stack is what makes next /
   * previous work without the route learning a second direction. */
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after a write. */
  reload: () => void
}

export function useDocuments(apiBase: string, type: string, url: DocumentsUrl): DocumentsData {
  const [page, setPage] = useState<DocumentsData['page']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  /**
   * The query the *request* uses, which trails what is in the box by `DEBOUNCE_MS`.
   *
   * Only `q` is debounced. A chip, a sort and a page are single deliberate
   * gestures and should answer immediately; a search term arrives one character at
   * a time, and it is the only one of the four where the intermediate states are
   * not states anybody asked to see.
   */
  const q = useDebounced(url.q)
  const settled = { ...url, q }

  // Serialised, because a fresh object every render would restart the effect
  // below. The string is also exactly what goes on the wire, so there is no second
  // representation to keep in step.
  const params = documentsParams(settled, type, { limit: PAGE, cursor, count: true }).toString()

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/documents?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setPage({ ...((await res.json()) as Page<DocumentRow>), loading: false })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, params])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  /**
   * A filter, a sort or a direction change invalidates the cursor stack: each is a
   * different ordering or a different set, so a cursor from the old one would resume
   * at a position that no longer exists.
   *
   * Keyed on the request *minus* the cursor — the same string the fetch uses, with
   * the one parameter that is allowed to change without a reset taken out. Deriving
   * it rather than listing `sort`, `dir`, `state` and `q` separately is what keeps a
   * fifth filter from being added without a reset.
   */
  const identity = documentsParams(settled, type, { limit: PAGE, count: true }).toString()
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
 * Deliberately generic and deliberately tiny: `useContent`'s search box has exactly
 * the same problem and this is what it will take when phase 2's screen is next
 * touched. Kept local rather than promoted to `ui/` until it has a second caller —
 * a shared hook with one user is a directory entry, not a decision.
 */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
