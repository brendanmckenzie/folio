/**
 * The documents a `reference`, a `references` or a story `multilink` may point at,
 * searched over the routes rather than held in memory.
 *
 * **This is the one place port phase 7b had to change behaviour rather than
 * styling**, and the reason is that its data source no longer exists.
 * `admin/Inspector.tsx`, `LinkInput.tsx` and `ReferencesInput.tsx` all read
 * `useFolio().stories` — every document on the site, flat — and filtered it with
 * `referenceCandidates` / `linkCandidates`. That whole-tree fetch is what
 * `docs/specs/foundation/pagination.md` removed: `useEditor` replaced it with
 * `useRefStories`, which asks for **only the ids a document points at**, so
 * `EditorSlot` carries no story list and cannot be given one without undoing
 * pagination phase 3.
 *
 * So the candidate list is a search, not a filter. Two consequences, both good:
 *
 *  - The `q` goes to the route (`?q=`), so a picker on a site with 2,000 pages
 *    matches all of them. The old `<select>` was capped by whatever the tree fetch
 *    returned and had no search at all — `ROADMAP.md` calls an unsorted flat list
 *    "stops working somewhere around 15", and this list was that list.
 *  - **The current value costs nothing.** `Resolution.stories` already holds every
 *    id this document points at — that is precisely what `useRefStories` fetched —
 *    so rendering "what is picked" needs no request. Only the *candidates* do, and
 *    only while a picker is open.
 *
 * The pure halves are exported and tested in Node; the hook is the thin fetch
 * around them.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../../core/pagination'
import type { StoryMeta } from '../../../../core/story'

/** One offered document, flattened to what a picker row draws. */
export interface Candidate {
  id: string
  title: string
  /** `null` for an unrouted document — a record or a singleton. */
  path: string | null
  type: string
}

/**
 * What a field is asking for.
 *
 * `routed` is the difference between a link and a reference, and it is not a
 * cosmetic one: an unrouted document has no URL, so `resolveLink` refuses to emit
 * an href from it and the picker must never offer one (`document-types.md`). A
 * `reference`, by contrast, *may* point at a record — pulling a person's details
 * into a card is the whole point — so nothing is excluded for being unrouted.
 */
export interface CandidateQuery {
  /** Free text, straight through to the route's `?q=`. */
  q: string
  /** The field's `types`, or undefined for "every type". */
  types?: readonly string[]
  /** Routed pages only. True for a story link, false for a reference. */
  routed: boolean
  /** Ids already picked, which a `references` picker must not offer again. */
  exclude?: readonly string[]
}

/** How many candidates one request asks for. A picker is a search box, not a
 * catalogue: fifty rows is more than anybody scrolls past before typing, and the
 * route's own ceiling is 200. */
export const CANDIDATE_LIMIT = 50

/**
 * The requests one query needs, as paths relative to the admin's JSON base.
 *
 * Two of them for a reference and one for a link, and the split is the routes'
 * rather than ours: `?flat=1` filters `path is not null`, so it is every routed
 * *page* and can never return a record, while `GET /documents` with no `?type=` is
 * every *unrouted* document. Neither is a superset of the other, so a field that
 * offers both has to ask twice.
 *
 * `?type=` is sent only when the field names exactly one type, because the routes
 * take one. A field naming two or three still narrows — `narrow` below does it over
 * the merged rows — and it narrows a fifty-row page rather than the table, which is
 * the honest cost of a route that filters on a single type. Named here rather than
 * hidden in the hook so the limitation is reviewable.
 */
export function candidateRequests(query: CandidateQuery): string[] {
  const only = query.types?.length === 1 ? query.types[0] : undefined
  const shared = new URLSearchParams({ limit: String(CANDIDATE_LIMIT) })
  if (query.q.trim()) shared.set('q', query.q.trim())
  if (only) shared.set('type', only)

  const pages = new URLSearchParams(shared)
  pages.set('flat', '1')
  pages.set('sort', 'path')
  const out = [`/stories?${pages}`]
  if (!query.routed) out.push(`/documents?${shared}`)
  return out
}

/**
 * The rows a query will accept, narrowed and sorted.
 *
 * The narrowing is `referenceCandidates`' and `linkCandidates`' rules, carried over
 * unchanged: `types` when the field declares them, `path !== null` for a link, and
 * anything already picked dropped. The sort is `referenceCandidates`' too — routed
 * documents first by path, unrouted ones by title — which puts the site's structure
 * in front of its data and reads as a sitemap rather than as an alphabet.
 */
export function narrow(rows: readonly StoryMeta[], query: CandidateQuery): Candidate[] {
  const taken = new Set(query.exclude ?? [])
  const seen = new Set<string>()
  return rows
    .filter((row) => {
      if (taken.has(row.id) || seen.has(row.id)) return false
      if (query.routed && row.path === null) return false
      if (query.types && !query.types.includes(row.type)) return false
      seen.add(row.id)
      return true
    })
    .map((row) => ({ id: row.id, title: row.title, path: row.path, type: row.type }))
    .sort((a, b) =>
      a.path === null || b.path === null
        ? (a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) || a.title.localeCompare(b.title)
        : a.path.localeCompare(b.path),
    )
}

/** One candidate as a row's secondary line: its URL, or its type when it has none. */
export function candidateHint(candidate: Candidate): string {
  return candidate.path === null ? candidate.type : `/${candidate.path}`
}

export interface Candidates {
  rows: Candidate[]
  loading: boolean
  /** The route refused or the network did. Shown in the picker rather than swallowed:
   * an empty list and a failed list look identical and mean opposite things. */
  error: string | null
}

/**
 * `candidateRequests` fetched and `narrow`ed, re-run when the query changes.
 *
 * `enabled` is what keeps this off the keystroke path: a picker asks only while it
 * is open, so an inspector with six reference fields makes no requests at all until
 * one of them is clicked.
 */
export function useCandidates(
  apiBase: string,
  query: CandidateQuery,
  enabled: boolean,
): Candidates {
  const [state, setState] = useState<Candidates>({ rows: [], loading: false, error: null })
  // Serialised, so an unchanged query is an unchanged dependency: `types` and
  // `exclude` are fresh arrays on every render of the field above.
  const key = JSON.stringify(query)

  const run = useCallback(
    async (signal: AbortSignal) => {
      const paths = candidateRequests(JSON.parse(key) as CandidateQuery)
      const answers = await Promise.all(
        paths.map(async (path) => {
          const res = await fetch(`${apiBase}${path}`, { signal })
          if (!res.ok) throw new Error(`Could not list documents (${res.status})`)
          return (await res.json()) as Page<StoryMeta>
        }),
      )
      return narrow(
        answers.flatMap((page) => page.rows),
        JSON.parse(key) as CandidateQuery,
      )
    },
    [apiBase, key],
  )

  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    setState((prev) => ({ ...prev, loading: true, error: null }))
    run(abort.signal)
      .then((rows) => setState({ rows, loading: false, error: null }))
      .catch((e: Error) => {
        // An aborted request is this effect being superseded, not a failure to
        // report: leaving the previous rows on screen while the next query lands is
        // what stops the list flashing empty on every keystroke.
        if (abort.signal.aborted) return
        setState({ rows: [], loading: false, error: e.message })
      })
    return () => abort.abort()
  }, [enabled, run])

  return state
}
