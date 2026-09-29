import { useCallback, useEffect, useState } from 'react'
import { EMPTY_REGISTRY, type Registry } from '../../../core/sites'
import { messageOf } from './useContent'

/**
 * The registry, off `GET {base}/api/sites` (`multi-site.md` decision 1).
 *
 * One read of a table that is fifty rows on the deployment that motivated it, so it
 * is not paged and `sites` and `groups` arrive together. `enabled` is the gate: a
 * caller who may not manage the registry gets a 403 and, worse, an error toast for a
 * screen whose banner already explains why, so nothing is asked unless the gate said
 * `ok` (`useAccess` makes the same choice).
 */
export interface SitesData {
  registry: Registry
  loading: boolean
  error: string | null
  reload: () => void
}

export function useSites(apiBase: string, enabled: boolean): SitesData {
  const [registry, setRegistry] = useState<Registry>(EMPTY_REGISTRY)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is the reload trigger, not a value the body reads
  useEffect(() => {
    if (!enabled) return
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/sites`)
        if (!res.ok) throw new Error(await messageOf(res))
        const body = (await res.json()) as Registry
        if (live) {
          setRegistry(body)
          setError(null)
        }
      } catch (e) {
        if (live) setError((e as Error).message)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase, enabled, epoch])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])
  return { registry, loading, error, reload }
}
