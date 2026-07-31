import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { TokenRow } from '../../../server/auth/tokens'
import type { AccessUser } from './access-model'
import { messageOf } from './useContent'

/**
 * The Access screen's data: one page of editors and one page of tokens.
 *
 * Two independent lists on one screen, which is the only thing that makes this
 * different from `useDocuments` — so it is that hook's cursor-stack shape, applied
 * twice through one generic. Sharing rather than duplicating matters here because
 * *previous* is the fiddly half: keyset paging only goes forwards, so the stack of
 * cursors already visited is what makes a Previous button work without the route
 * learning a second direction, and two hand-rolled copies of it is two chances to
 * get the last page wrong.
 *
 * Not shared with the *old* admin's `admin/hooks/useAccess.ts`, which still ships
 * until port phase 8. That one reads the first page of each list and stops, which
 * was fine for a 280px rail and is exactly what this screen exists to stop doing.
 */

/** Rows per request, matching `useDocuments`. The routes default to 50 and clamp
 * at 200. Fifty is roughly two screens, which makes paging the exception rather
 * than the rhythm — and on this screen it means most sites never page at all. */
const PAGE = 50

export interface PagedList<T> {
  page: Page<T> & { loading: boolean; error?: string }
  /** Cursors already visited, so *previous* is a pop rather than a reverse query. */
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after a write. */
  reload: () => void
}

/**
 * The two lists, and nothing shared between them.
 *
 * No combined `reload`, deliberately: every write on this screen touches exactly
 * one of the two tables, so a caller that reloaded both would be asking for a query
 * it knows the answer to. Inviting an editor reloads editors; revoking a token
 * reloads tokens.
 */
export interface AccessData {
  users: PagedList<AccessUser>
  tokens: PagedList<TokenRow>
}

export function useAccess(apiBase: string, enabled: boolean): AccessData {
  return {
    users: usePaged<AccessUser>(apiBase, '/users', 'users', enabled),
    tokens: usePaged<TokenRow>(apiBase, '/tokens', 'tokens', enabled),
  }
}

/**
 * One paged list over one of the two Access routes.
 *
 * `key` exists because neither route answers a bare `Page<T>`: `/users` answers
 * `{ users, cursor, total }` and `/tokens` answers `{ tokens, cursor, total }`.
 * That is deliberate on the server's part — the route names its own collection, and
 * `access.ts` says so — so the adapter belongs here rather than being a reason to
 * reshape two routes and every other reader of them.
 *
 * `enabled` is the gate: under `auth: 'open'`, or for a viewer who typed the URL,
 * both routes answer 404 or 403 and there is nothing worth asking. Two failed
 * requests behind a banner that already explains the situation would put a
 * misleading error in the console and, worse, would report the 404 as if it were the
 * screen's problem.
 */
function usePaged<T>(
  apiBase: string,
  path: string,
  key: 'users' | 'tokens',
  enabled: boolean,
): PagedList<T> {
  const [page, setPage] = useState<PagedList<T>['page']>({
    rows: [],
    cursor: null,
    loading: enabled,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  const params = new URLSearchParams({ limit: String(PAGE), count: '1' })
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()

  const fetchPage = useCallback(async () => {
    if (!enabled) {
      setPage({ rows: [], cursor: null, loading: false })
      return
    }
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}${path}?${query}`)
      if (!res.ok) throw new Error(await messageOf(res))
      // `{ [key]: rows, cursor, total }` → `Page<T>`.
      const body = (await res.json()) as Record<string, unknown> & {
        cursor: string | null
        total?: number
      }
      setPage({
        rows: (body[key] as T[]) ?? [],
        cursor: body.cursor,
        ...(body.total === undefined ? {} : { total: body.total }),
        loading: false,
      })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, path, key, query, enabled])

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

  /**
   * A write reloads the page you are looking at, cursor and all.
   *
   * Deliberately *not* a reset to the first page. Removing an editor from the third
   * page of a roster and being thrown back to the first is the version of this that
   * annoys; the cursor names a position in `(created_at, id)`, and neither of those
   * changes when a row above is deleted, so resuming from it is still correct.
   */
  return { page, canGoBack: history.length > 0, nextPage, prevPage, reload: fetchPage }
}
