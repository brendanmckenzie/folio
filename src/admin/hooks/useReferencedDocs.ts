import { useEffect, useMemo, useState } from 'react'
import type { Doc } from '../../core/doc'
import { referencedIdsAllLocales } from '../../core/refs'
import type { SchemaIndex } from '../../core/schema'

/**
 * What the editor knows about the documents `reference` fields point at.
 *
 * `missing` is the negative half and is what makes this safe to consult on every
 * document change: without it, a reference to a deleted page is re-requested
 * every time any *other* reference resolves, forever, because the id never
 * appears in `docs`.
 */
export interface ReferencedDocs {
  docs: Readonly<Record<string, Doc>>
  /** Ids the server answered for with no usable document. Never asked for again. */
  missing: ReadonlySet<string>
}

export const NO_REFERENCED_DOCS: ReferencedDocs = { docs: {}, missing: new Set() }

/** Ids that are wanted and not already settled, either way. */
export function idsToFetch(wanted: readonly string[], known: ReferencedDocs): string[] {
  return wanted.filter((id) => !known.docs[id] && !known.missing.has(id))
}

export interface ReferencedDocsResult {
  docs: Record<string, Doc>
  /** Answered, but with nothing usable: a deleted story, or an unreadable body. */
  missing: string[]
}

/**
 * Fetches the documents for `ids`, one request each.
 *
 * Never rejects, because a rejection here would be an unhandled one in an effect.
 * A transport failure is left out of *both* lists on purpose: it is not an answer
 * about the story, so it must not be remembered as a miss — the next change to
 * the referenced set asks again.
 */
export async function loadReferencedDocs(
  apiBase: string,
  ids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReferencedDocsResult> {
  const docs: Record<string, Doc> = {}
  const missing: string[] = []

  await Promise.all(
    ids.map(async (id) => {
      let res: Response
      try {
        res = await fetchImpl(`${apiBase}/story/${encodeURIComponent(id)}/document`)
      } catch {
        return
      }
      if (!res.ok) {
        missing.push(id)
        return
      }
      const body = (await res.json().catch(() => null)) as { doc?: Doc } | null
      if (body?.doc) docs[id] = body.doc
      else missing.push(id)
    }),
  )

  return { docs, missing }
}

/**
 * Folds a load's outcome in. Returns the same object when nothing was settled —
 * the whole load was transport failures — which is what stops the effect that
 * calls it from looping on its own state.
 */
export function mergeReferencedDocs(
  prev: ReferencedDocs,
  result: ReferencedDocsResult,
): ReferencedDocs {
  const found = Object.keys(result.docs).length > 0
  if (!found && result.missing.length === 0) return prev
  return {
    docs: found ? { ...prev.docs, ...result.docs } : prev.docs,
    missing: result.missing.length ? new Set([...prev.missing, ...result.missing]) : prev.missing,
  }
}

/**
 * The referenced-id set to fetch, as a sorted, joined string so an unchanged
 * set is an unchanged `useMemo`/`useEffect` dependency.
 *
 * `referencedIdsAllLocales`, not the source-locale-only `referencedIds`: the
 * server's own resolution walks every locale (`core/refs.ts`'s header), so a
 * `reference` a translation points at but the source value does not must still
 * be fetched here, or the editor's preview would be missing a document the
 * published render has.
 */
export function wantedReferencedIds(doc: Doc | null, schema: SchemaIndex): string {
  return doc ? referencedIdsAllLocales(doc, schema).sort().join(',') : ''
}

/**
 * Documents pulled in by `reference` and `references` fields, across every
 * locale — the same set the server's own resolution loads, so a target only a
 * translation points at is not missing from the editor's copy.
 *
 * Fetched only when the *set* of referenced ids changes — never per render,
 * because the preview re-renders on every keystroke and there must be no network
 * in that loop.
 */
export function useReferencedDocs(
  apiBase: string,
  doc: Doc | null,
  schema: SchemaIndex,
): Readonly<Record<string, Doc>> {
  const [known, setKnown] = useState<ReferencedDocs>(NO_REFERENCED_DOCS)

  const wantedIds = useMemo(() => wantedReferencedIds(doc, schema), [doc, schema])

  useEffect(() => {
    const wanted = idsToFetch(wantedIds ? wantedIds.split(',') : [], known)
    if (wanted.length === 0) return
    let live = true
    void loadReferencedDocs(apiBase, wanted).then((result) => {
      if (live) setKnown((prev) => mergeReferencedDocs(prev, result))
    })
    return () => {
      live = false
    }
  }, [apiBase, known, wantedIds])

  return known.docs
}
