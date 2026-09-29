import { useEffect, useState } from 'react'
import type { Doc } from '../../../core/doc'
import { layerId } from '../../../core/sites'
import type { StoryMeta } from '../../../core/story'

/**
 * What the editor asks about an open document that only a deployment with `sites`
 * has an answer to. Three reads, each off a route that exists only there, each
 * gated by an `enabled` the caller computes so a single-site editor makes none of
 * them.
 */

/**
 * This scope's own page at the open page's path — the fork, or a page made by hand
 * there — when the open page belongs to a scope above (`multi-site.md` decision 5).
 * It is what makes "Alpha overrides this page" true rather than assumed.
 *
 * `GET /stories?paths=` is the scope's own rows, so a hit that is not the open page
 * is by construction the scope's. Undefined until it answers, and while it is off.
 */
export function useOverride(
  apiBase: string,
  story: Pick<StoryMeta, 'id' | 'path'>,
  enabled: boolean,
): Pick<StoryMeta, 'id'> | undefined {
  const [row, setRow] = useState<Pick<StoryMeta, 'id'> | undefined>(undefined)
  const { id, path } = story

  useEffect(() => {
    if (!enabled || path === null) {
      setRow(undefined)
      return
    }
    let live = true
    fetch(`${apiBase}/stories?${new URLSearchParams({ paths: path })}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
      .then(({ rows }) => {
        if (live) setRow(rows.find((candidate) => candidate.path === path && candidate.id !== id))
      })
      .catch(() => {
        if (live) setRow(undefined)
      })
    return () => {
      live = false
    }
  }, [apiBase, enabled, id, path])

  return row
}

/** `GET /story/:id/fork`: where a fork came from and whether that has been published
 * since. Null for a page that is not a fork, undefined until it answers. */
export interface ForkStatus {
  source: StoryMeta | null
  changed: boolean
}

export function useForkStatus(
  apiBase: string,
  story: Pick<StoryMeta, 'id' | 'forkedFrom'>,
  enabled: boolean,
): ForkStatus | null | undefined {
  const [status, setStatus] = useState<ForkStatus | null | undefined>(undefined)
  const { id, forkedFrom } = story

  useEffect(() => {
    if (!enabled || !forkedFrom) {
      setStatus(undefined)
      return
    }
    let live = true
    fetch(`${apiBase}/story/${encodeURIComponent(id)}/fork`)
      .then((res) =>
        res.ok ? (res.json() as Promise<{ fork: ForkStatus | null }>) : { fork: null },
      )
      .then(({ fork }) => {
        if (live) setStatus(fork)
      })
      .catch(() => {
        if (live) setStatus(undefined)
      })
    return () => {
      live = false
    }
  }, [apiBase, enabled, id, forkedFrom])

  return status
}

/**
 * The layers **below** an open global, most general first (`multi-site.md` decision
 * 8): what `layerStates` compares the open layer against to say *Inherited from
 * Shared* or *Overridden here*. A layer that does not exist is `undefined` in its
 * slot, not a missing entry — the slots stay parallel to `scopes`.
 *
 * Fetched once per open layer, as their drafts (`/story/:id/document`), and not
 * live: an inherited value another editor changes while this one is open is picked
 * up on the next open. `below` is the chain without the open layer's own scope.
 */
export function useLayerDocs(
  apiBase: string,
  type: string | null,
  below: readonly string[],
): { docs: readonly (Doc | undefined)[]; loading: boolean } {
  const [docs, setDocs] = useState<readonly (Doc | undefined)[]>([])
  const [loading, setLoading] = useState(false)
  const key = below.join(',')

  useEffect(() => {
    if (type === null || key === '') {
      setDocs([])
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void Promise.all(
      key.split(',').map(async (scope) => {
        try {
          const res = await fetch(
            `${apiBase}/story/${encodeURIComponent(layerId(type, scope))}/document`,
          )
          if (!res.ok) return undefined
          return ((await res.json().catch(() => null)) as { doc?: Doc } | null)?.doc
        } catch {
          return undefined
        }
      }),
    ).then((found) => {
      if (!live) return
      setDocs(found)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [apiBase, type, key])

  return { docs, loading }
}
