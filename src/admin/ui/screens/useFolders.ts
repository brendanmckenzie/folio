import { useCallback, useEffect, useState } from 'react'
import type { AssetFolder } from '../../../core/assets'
import type { Page } from '../../../core/pagination'
import { messageOf } from './useContent'

/**
 * The folder tree, for the Assets sidebar and the detail panel's folder editor
 * (`docs/specs/content-model/media-library.md` decision 3).
 *
 * **One page, not a cursor loop.** `listFolders`'s own ceiling is 500
 * (`asset-folders.ts`), a higher default than the asset list's for the same reason
 * stated there: this is a sidebar that wants the whole tree, over a table bounded
 * by folders somebody created by hand. A library with more than 500 folders is not
 * a case this hook covers, and it is not the case decision 9 (unlimited nesting)
 * was answering either.
 *
 * **Two independent instances exist at once** when the detail panel is open beside
 * the browser — `AssetBrowser`'s sidebar and `AssetDetail`'s folder editor each call
 * this rather than sharing one fetch. A folder created from one does not appear in
 * the other until it next mounts or reloads. Named rather than fixed: a shared
 * cache across two components is a bigger investment than a single-asset phase
 * owes, and a sidebar that is stale for the length of one panel visit costs
 * nothing anybody has asked to avoid.
 */
export interface FoldersData {
  folders: readonly AssetFolder[]
  loading: boolean
  error: string | null
  reload: () => void
  /**
   * `createFolder`'s two arguments, through the route. Throws the server's own
   * message on failure — a 409 naming the sibling that already occupies the name,
   * or an unknown parent — for the caller to show. Reloads on success, so a
   * caller does not also have to remember to.
   */
  create: (input: { name: string; parentId?: string | null }) => Promise<AssetFolder>
}

export function useFolders(apiBase: string): FoldersData {
  const [folders, setFolders] = useState<readonly AssetFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/assets/folders?limit=500`)
      if (!res.ok) throw new Error(await messageOf(res))
      const page = (await res.json()) as Page<AssetFolder>
      setFolders(page.rows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = useCallback(
    async (input: { name: string; parentId?: string | null }) => {
      const res = await fetch(`${apiBase}/assets/folders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      const folder = (await res.json()) as AssetFolder
      await reload()
      return folder
    },
    [apiBase, reload],
  )

  return { folders, loading, error, reload, create }
}
