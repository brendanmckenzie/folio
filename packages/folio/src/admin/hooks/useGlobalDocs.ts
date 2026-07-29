import { useEffect, useState } from 'react'
import type { Doc } from '../../core/doc'
import { singletonId, type DocumentType } from '../../core/schema'
import { globalTypes } from '../GlobalsList'

/**
 * Each configured global's own document, keyed by type name rather than story
 * id — fetched once per global rather than per keystroke, since its only job
 * is letting "Edit `<name>` →" (`../../../docs/specs/content-model/globals.md`
 * checkpoint 3) tell a clicked uid inside a global apart from one inside the
 * document actually open. A block's uid never changes when only its field
 * values do, so a copy fetched once is still a correct *set* of ids even after
 * an editor changes the global from its own screen; refreshing the rendered
 * *content* live across stories is `../../../docs/specs/editing/
 * live-collaboration.md`, not this.
 */
export function useGlobalDocs(
  apiBase: string,
  types: readonly DocumentType[],
  globals: readonly string[],
): Readonly<Record<string, Doc>> {
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const key = globals.join(',')

  useEffect(() => {
    const wanted = globalTypes(types, key ? key.split(',') : [])
    if (wanted.length === 0) return
    let live = true

    void Promise.all(
      wanted.map(async (type) => {
        try {
          const res = await fetch(
            `${apiBase}/story/${encodeURIComponent(singletonId(type))}/document`,
          )
          if (!res.ok) return null
          const body = (await res.json().catch(() => null)) as { doc?: Doc } | null
          return body?.doc ? ([type.name, body.doc] as const) : null
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (!live) return
      const found = results.filter((r): r is readonly [string, Doc] => r !== null)
      if (found.length) setDocs((prev) => ({ ...prev, ...Object.fromEntries(found) }))
    })

    return () => {
      live = false
    }
  }, [apiBase, key, types])

  return docs
}
