import { useEffect, useMemo, useRef, useState } from 'react'
import { diff, summariseDiff } from '../../core/diff'
import type { Doc } from '../../core/doc'
import type { VersionMeta } from '../../server/versions'

/**
 * "Published" is the newest `publish` version, not a second read of
 * `published_doc` (`unpublished-changes.md`'s architecture decision 1): the two
 * can never disagree, `publish()` writes them in one batch, and this rides on
 * routes that already exist rather than adding one that would return the same
 * bytes by a second path.
 */
export interface PublishedDoc {
  /** The newest `kind === 'publish'` version, or null if this story has never
   * been published. */
  version: VersionMeta | null
  /** That version's document, fetched once and cached by version id. Null
   * until it has loaded, or if there is no published version at all. */
  published: Doc | null
  /**
   * `summariseDiff(diff(published, liveDoc))` — architecture decision 2: the
   * diff is the authority on "how do these differ", not a flag kept on write,
   * so editing a value back to its published state clears this for free. Null
   * while there is nothing to compare against yet (never published, or the
   * published doc / live doc has not loaded).
   */
  delta: ReturnType<typeof summariseDiff> | null
}

interface Options {
  apiBase: string
  /** The version list the caller already loads (`useVersionsList`), newest
   * first, so the first `kind === 'publish'` entry is the one currently live. */
  versions: VersionMeta[]
  /** The live draft, for the delta against the published version. */
  liveDoc: Doc | null
}

/**
 * The pure half of `usePublishedDoc`, pulled out so the four states the
 * top bar cares about — never published, clean, dirty, edited back to clean —
 * are testable with plain documents and no React runtime. `unpublished-
 * changes.md`'s architecture decision 2: the diff is the authority on "how do
 * these differ", so editing a value back to its published state clears this
 * for free, with no flag anywhere to fall out of sync.
 */
export function publishedDelta(
  published: Doc | null,
  liveDoc: Doc | null,
): ReturnType<typeof summariseDiff> | null {
  if (!published || !liveDoc) return null
  try {
    return summariseDiff(diff(published, liveDoc))
  } catch {
    return null
  }
}

/**
 * What publishing right now would change. Deliberately does not depend on the
 * History rail being open: `useVersions` only loads its lists when `active`,
 * but the top bar needs this on every load, so the version list is lifted to
 * `Editor.tsx` and both hooks read it from there.
 */
export function usePublishedDoc({ apiBase, versions, liveDoc }: Options): PublishedDoc {
  const version = useMemo(() => versions.find((v) => v.kind === 'publish') ?? null, [versions])
  const [loaded, setLoaded] = useState<{ id: string; doc: Doc } | null>(null)
  // Keyed by version id rather than invalidated on publish: a new publish
  // produces a new version id, so the cache simply never has an entry for it
  // yet and fetches once, same as any other version this story has ever had.
  const cache = useRef(new Map<string, Doc>())

  useEffect(() => {
    if (!version) return
    const cached = cache.current.get(version.id)
    if (cached) {
      setLoaded({ id: version.id, doc: cached })
      return
    }
    let cancelled = false
    void (async () => {
      const res = await fetch(`${apiBase}/versions/${encodeURIComponent(version.id)}`)
      if (!res.ok || cancelled) return
      const { doc } = (await res.json()) as { doc: Doc }
      cache.current.set(version.id, doc)
      if (!cancelled) setLoaded({ id: version.id, doc })
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, version])

  const published = version && loaded?.id === version.id ? loaded.doc : null
  const delta = useMemo(() => publishedDelta(published, liveDoc), [liveDoc, published])

  return { version, published, delta }
}
