import { useEffect, useMemo, useRef, useState } from 'react'
import type { Doc } from '../../core/doc'
import type { LocaleContext } from '../../core/locales'
import {
  collectionQueries,
  type ContentPage,
  type ContentQuery,
  queryToParams,
  type ResolvedCollection,
} from '../../core/query'
import type { SchemaIndex } from '../../core/schema'

/**
 * The answers to the `collection` queries the open document contains
 * (`../../../docs/specs/content-model/collections.md` decision 5).
 *
 * `useReferencedDocs`'s pattern exactly, one level up, and for the identical
 * reason: fetched when the **set of queries** changes, never per render, because
 * the preview re-renders on every keystroke and there must be no network in that
 * loop. Typing into an unrelated field changes no query, so it changes no
 * dependency, so it fetches nothing and the list re-renders from data already
 * held.
 *
 * Everything here is `stale: true`. The admin reads published content — the same
 * trade decision 3 makes on the server, and for the same reason: querying drafts
 * would mean opening every candidate Durable Object per keystroke.
 */
export interface Collections {
  answers: Readonly<Record<string, ResolvedCollection>>
  /** Keys the server answered for with nothing usable. Never asked for again. */
  failed: ReadonlySet<string>
}

export const NO_COLLECTIONS: Collections = { answers: {}, failed: new Set() }

/** Keys that are wanted and not already settled, either way. */
export function keysToFetch(wanted: readonly string[], known: Collections): string[] {
  return wanted.filter((key) => !known.answers[key] && !known.failed.has(key))
}

export interface CollectionsResult {
  answers: Record<string, ResolvedCollection>
  failed: string[]
}

/**
 * Runs each query once against `GET /folio/content`.
 *
 * Never rejects, because a rejection here would be an unhandled one in an effect.
 * A transport failure is left out of *both* lists deliberately: it is not an answer
 * about the query, so it must not be remembered as one — the next change to the
 * query set asks again. A 4xx **is** an answer (an unindexed field, most likely a
 * schema the editor is ahead of) and is remembered, or the effect would retry it
 * forever.
 */
export async function loadCollections(
  apiBase: string,
  queries: readonly [string, ContentQuery][],
  fetchImpl: typeof fetch = fetch,
): Promise<CollectionsResult> {
  const answers: Record<string, ResolvedCollection> = {}
  const failed: string[] = []

  await Promise.all(
    queries.map(async ([key, q]) => {
      let res: Response
      try {
        res = await fetchImpl(`${apiBase}/content?${queryToParams(q).toString()}`)
      } catch {
        return
      }
      if (!res.ok) {
        failed.push(key)
        return
      }
      const body = (await res.json().catch(() => null)) as ContentPage | null
      if (body && Array.isArray(body.items)) answers[key] = { ...body, stale: true }
      else failed.push(key)
    }),
  )

  return { answers, failed }
}

/** Folds a load's outcome in, returning the same object when nothing settled — which
 * is what stops the effect that calls it from looping on its own state. */
export function mergeCollections(prev: Collections, result: CollectionsResult): Collections {
  const found = Object.keys(result.answers).length > 0
  if (!found && result.failed.length === 0) return prev
  return {
    answers: found ? { ...prev.answers, ...result.answers } : prev.answers,
    failed: result.failed.length ? new Set([...prev.failed, ...result.failed]) : prev.failed,
  }
}

export function useCollections(
  apiBase: string,
  doc: Doc | null,
  schema: SchemaIndex,
  locale?: LocaleContext,
): Readonly<Record<string, ResolvedCollection>> {
  const [known, setKnown] = useState<Collections>(NO_COLLECTIONS)

  const wanted = useMemo(
    () => (doc ? [...collectionQueries(doc, schema, undefined, locale)] : []),
    [doc, schema, locale],
  )
  // A sorted, joined string of the keys, so an unchanged query *set* is an
  // unchanged dependency however the document was edited around it.
  const signature = useMemo(
    () =>
      wanted
        .map(([key]) => key)
        .sort()
        .join('|'),
    [wanted],
  )

  // The latest queries, off the render path. `wanted` is a fresh array on every
  // keystroke (the store hands out a new `Doc`), so depending on it would run this
  // effect per keystroke — which is the one thing this hook exists not to do. The
  // dependency is `signature`, the sorted key set, which is what actually decides
  // whether there is anything new to ask for.
  const latest = useRef(wanted)
  latest.current = wanted

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` reads as an extra dependency because the body deliberately goes through `latest.current`. It is the dependency that matters — the sorted key set is what decides whether there is anything new to ask for, and depending on `wanted` instead would run this per keystroke
  useEffect(() => {
    const queries = latest.current
    const missing = new Set(
      keysToFetch(
        queries.map(([key]) => key),
        known,
      ),
    )
    if (missing.size === 0) return
    let live = true
    void loadCollections(
      apiBase,
      queries.filter(([key]) => missing.has(key)),
    ).then((result) => {
      if (live) setKnown((prev) => mergeCollections(prev, result))
    })
    return () => {
      live = false
    }
  }, [apiBase, known, signature])

  return known.answers
}
