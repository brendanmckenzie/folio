import { useCallback, useEffect, useState } from 'react'
import type { Redirect } from '../../server/redirects'
import { expectJson, expectOk, send } from '../api'
import type { Notify } from './useNotice'

export type RedirectFilter = 'all' | 'auto' | 'manual'

export interface Redirects {
  rows: Redirect[]
  loading: boolean
  source: RedirectFilter
  setSource: (source: RedirectFilter) => void
  reload: () => Promise<void>
  create: (from: string, to: string) => Promise<void>
  remove: (from: string) => Promise<void>
}

/**
 * The admin's Redirects screen (redirects.md): a flat list, newest first,
 * filterable by source. Reloaded whenever it becomes the active rail — the
 * same lazy-load `useVersions` already does for History — so a session that
 * never opens the tab never pays for the fetch.
 */
export function useRedirects(apiBase: string, notify: Notify, active: boolean): Redirects {
  const [rows, setRows] = useState<Redirect[]>([])
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<RedirectFilter>('all')

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const qs = source === 'all' ? '' : `?source=${source}`
      const page = await expectJson<{ rows: Redirect[] }>(await fetch(`${apiBase}/redirects${qs}`))
      setRows(page.rows)
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [apiBase, notify, source])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

  const create = useCallback(
    async (from: string, to: string) => {
      try {
        await expectOk(await send(`${apiBase}/redirects`, 'POST', { from, to }))
      } catch (e) {
        notify((e as Error).message)
        return
      }
      await reload()
    },
    [apiBase, notify, reload],
  )

  const remove = useCallback(
    async (from: string) => {
      try {
        // Not encodeURIComponent'd whole: `from` legitimately contains slashes
        // (a multi-segment path), and the route (`:from{.+}`) expects them
        // literal, the same way the path itself is stored and looked up.
        await expectOk(await fetch(`${apiBase}/redirects/${from}`, { method: 'DELETE' }))
      } catch (e) {
        notify((e as Error).message)
      }
      await reload()
    },
    [apiBase, notify, reload],
  )

  return { rows, loading, source, setSource, reload, create, remove }
}
