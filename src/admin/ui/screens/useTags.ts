import { useCallback, useEffect, useState } from 'react'
import type { AssetTag } from '../../../core/assets'
import type { Page } from '../../../core/pagination'
import { messageOf } from './useContent'

/**
 * The tag vocabulary, for the Assets sidebar's chips and the detail panel's tag
 * editor (`docs/specs/content-model/media-library.md` decision 4).
 *
 * **`?counts=1`, always.** `listTags`'s counts are opt-in server-side because an
 * autocomplete does not want the extra `group by` (`asset-tags.ts`'s
 * `ListTagsOptions`) — but every caller of this hook is a sidebar or a chip list,
 * never a bare-name lookup, so asking for them here is the right default for both
 * of this hook's actual call sites.
 *
 * **One page, not a cursor loop**, for `useFolders`'s reason exactly: the
 * vocabulary is "hundreds of rows" by design (decision 4's own words), and 500 is
 * "the whole list" at that scale.
 *
 * **Two independent instances exist at once**, also for `useFolders`'s reason: a
 * tag created from the detail panel's editor does not appear as a sidebar chip
 * until the sidebar's own instance next reloads.
 */
export interface TagsData {
  tags: readonly AssetTag[]
  loading: boolean
  error: string | null
  reload: () => void
  /**
   * `ensureTag`'s create-or-find, through the route: a name that slugifies onto an
   * existing tag returns that row rather than minting a near-duplicate (decision
   * 4) — which is what makes "type a name, press Enter" safe to call on every
   * commit rather than only on a genuinely new one. Throws the server's own
   * message on failure. Reloads on success.
   */
  ensure: (name: string) => Promise<AssetTag>
}

export function useTags(apiBase: string): TagsData {
  const [tags, setTags] = useState<readonly AssetTag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/assets/tags?limit=500&counts=1`)
      if (!res.ok) throw new Error(await messageOf(res))
      const page = (await res.json()) as Page<AssetTag>
      setTags(page.rows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void reload()
  }, [reload])

  const ensure = useCallback(
    async (name: string) => {
      const res = await fetch(`${apiBase}/assets/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      const tag = (await res.json()) as AssetTag
      await reload()
      return tag
    },
    [apiBase, reload],
  )

  return { tags, loading, error, reload, ensure }
}
