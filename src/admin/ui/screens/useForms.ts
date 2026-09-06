import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { FormRow } from './forms-model'
import { messageOf } from './useContent'

/**
 * The Forms list screen's data: one page of the forms table.
 *
 * The same shape as `useRedirects` — one page, a cursor stack for *previous*,
 * and a reload — over a route with no filter to debounce (`forms-model.ts`'s
 * header says why), so this is `useRedirects` minus the search box: fetch, and
 * the state it lands in. Everything decidable is in `forms-model.ts`.
 */

/** Rows per request. The route defaults to 50 and clamps at 200. */
const PAGE = 50

export interface FormsData {
  page: Page<FormRow> & { loading: boolean; error?: string }
  /** Cursors already visited, so *previous* is a pop rather than a reverse
   *  query — keyset paging only goes forwards. */
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after a create or a delete. */
  reload: () => void
}

export function useForms(apiBase: string): FormsData {
  const [page, setPage] = useState<FormsData['page']>({ rows: [], cursor: null, loading: true })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      // `count=1` for the footer's `Showing n of N`; `counts=1` for the
      // responses column — both opt-in aggregates the route only runs when asked.
      const params = new URLSearchParams({ limit: String(PAGE), count: '1', counts: '1' })
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`${apiBase}/forms?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setPage({ ...((await res.json()) as Page<FormRow>), loading: false })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, cursor])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

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
