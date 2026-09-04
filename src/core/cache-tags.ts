/**
 * The cache-tag set a rendered page carries, and the two headers a host puts on
 * a published response (`../../docs/specs/platform/caching.md`).
 *
 * **The dependency set is computed at render, not looked up at purge**
 * (architecture decision 2), and this file is where that inversion happens. The
 * obvious design — a reverse index over `content_refs` — cannot work: a global
 * comes from config and writes no edge, collection membership is a query run at
 * render, a title-only patch changes every linking page and fires nothing, and
 * `content_refs` truncates at 400 rows per document. A `Resolution` already
 * *is* the dependency set of the page that was just rendered, so emitting it as
 * tags turns the purge into `purge({ tags: ['story:abc'] })` with no lookup at
 * all.
 *
 * Pure by construction, and deliberately so: Workers Cache is not simulated by
 * miniflare, so nothing in this repo can observe a hit or a purge. Everything
 * that *can* be tested is a function in this file, and the one line that cannot
 * be is `server/cache-purge.ts`'s platform call.
 */
import type { Resolution } from './resolve'

/** Always present, so a page over the tag budget is still reachable by the two
 * whole-site triggers (decision 8). Nothing purges it by name. */
export const SITE_TAG = 'site'

/**
 * A collection query with no `type` filter lists **every** type
 * (`collection()`'s own `type` is optional), so no `type:<name>` can describe
 * it. Rather than leave such a page silently un-purgeable — the exact
 * incompleteness this design exists to avoid — it carries this one instead, and
 * every publish purges it alongside the document's own type. One extra tag per
 * purge call; nothing else changes.
 */
export const ANY_TYPE_TAG = 'type:*'

/**
 * Workers Cache's own limits: 1000 tags per response and a 16 KB `Cache-Tag`
 * header. A page over either is coarsened rather than truncated (decision 8).
 */
export const MAX_CACHE_TAGS = 1000
export const MAX_CACHE_TAG_BYTES = 16 * 1024

/** A week. See `cacheHeaders` for why the edge TTL is long and the browser's is 0. */
export const DEFAULT_S_MAXAGE = 604_800

/** What Folio puts on its own preview response (decision 7). */
export const NO_STORE = 'private, no-store'

/**
 * `Cache-Tag` is a comma-separated header, so a tag may contain neither a comma
 * nor whitespace. Story ids never do; a document type or global *name* comes
 * from a host's config and could. Encoding rather than rejecting keeps the
 * failure impossible instead of merely unlikely, and the output is ASCII-only,
 * which is what lets the budget check below count characters as bytes.
 *
 * Both ends call these: `server/cache-purge.ts` builds its purge tags from the
 * same three functions, so the render side and the purge side cannot spell a
 * name differently.
 */
const encode = (value: string) => encodeURIComponent(value)

export const storyTag = (id: string) => `story:${encode(id)}`
export const globalTag = (name: string) => `global:${encode(name)}`
export const typeTag = (name: string) => `type:${encode(name)}`

/** The cache-tag set for a rendered page, and whether it had to be coarsened. */
export interface CacheTags {
  tags: string[]
  /** True when the dependency set exceeded the tag budget; `tags` is coarse. */
  degraded: boolean
}

export interface CacheTagOptions {
  /**
   * The story this response renders, or `null` for a page the host built with
   * no document of its own (a filtered archive, a search result).
   *
   * **Required, and nullable rather than optional.** It is the one id a
   * `Resolution` does not already carry — `resolve()` loads a page's links,
   * references, globals and ancestors, but a page does not link to itself — and
   * it is also the single most important tag on the response, because it is
   * what a publish of *this* page purges. Forgetting it would produce a page
   * cached for a week with no purge path, which is decision 2's dangerous
   * half-configured state; a type error is cheaper than that.
   */
  story: string | null
}

/**
 * Folio's advice for a published response. The host sets these headers.
 *
 * A type alias rather than an interface so it carries an implicit index
 * signature and is therefore assignable to `Record<string, string>` — which is
 * what `HeadersInit` and `FolioPage.headers` want, and what an interface would
 * refuse. It is a data shape, not an extension point.
 */
export type CacheHeaders = {
  'cache-control': string
  'cache-tag': string
}

export interface CacheHeaderOptions extends CacheTagOptions {
  /**
   * The browser's TTL. Defaults to 0, and see `cacheHeaders` before raising it.
   * The edge's `s-maxage` is deliberately not overridable: a host that wants a
   * short edge TTL wants a different design, not a parameter.
   */
  maxAge?: number
}

/**
 * The document types a collection query names, read back off the key its answer
 * travels under.
 *
 * `queryKey` (`query.ts`) is the canonical query itself rather than a hash of it
 * — a decision made there for legibility, and this is the second thing it buys:
 * the types are recoverable from the `Resolution` alone, so tagging needs
 * neither the document nor the schema and stays pure.
 */
function collectionTypes(keys: readonly string[]): { types: string[]; any: boolean } {
  const types = new Set<string>()
  let any = false
  for (const key of keys) {
    let parsed: unknown
    try {
      parsed = JSON.parse(key)
    } catch {
      // A key this function cannot read is a key some future shape wrote. The
      // safe reading is "this page lists something", not "this page lists
      // nothing" — silently narrowing is what decision 2 exists to prevent.
      any = true
      continue
    }
    const named = Array.isArray(parsed) ? parsed[0] : undefined
    if (!Array.isArray(named) || named.length === 0 || !named.every((t) => typeof t === 'string')) {
      any = true
      continue
    }
    for (const t of named as string[]) types.add(t)
  }
  return { types: [...types], any }
}

/**
 * Every tag a response should carry, given what its render actually loaded.
 *
 * ```
 * story:<id>      every id in resolution.stories, plus opts.story
 * global:<name>   every key in resolution.globals
 * type:<name>     the document type of every distinct collection query
 * type:*          a collection query that filters no type at all
 * site            always
 * ```
 *
 * `type:` is what makes collections work without a membership table: an index
 * page over `insight` is tagged `type:insight`, and publishing any insight
 * purges by that tag without anybody knowing which pages exist.
 *
 * Sorted, so the header is byte-stable for the same page and a diff between two
 * renders is readable.
 */
export function cacheTags(resolution: Resolution, opts: CacheTagOptions): CacheTags {
  const tags = new Set<string>([SITE_TAG])
  if (opts.story) tags.add(storyTag(opts.story))
  // Ancestors are in here too, which is what covers a breadcrumb: rename a
  // section and every page under it is purged, with no edge ever recorded.
  for (const id of Object.keys(resolution.stories)) tags.add(storyTag(id))
  for (const name of Object.keys(resolution.globals ?? {})) tags.add(globalTag(name))

  const collections = collectionTypes(Object.keys(resolution.collections ?? {}))
  for (const type of collections.types) tags.add(typeTag(type))
  if (collections.any) tags.add(ANY_TYPE_TAG)
  // The *members* as well as the type. `type:` covers membership changing —
  // something published, unpublished or deleted — but an index page also
  // renders each item's title and URL, and renaming one of them changes neither
  // the membership nor `content_index`. A collection's answers never reach
  // `resolution.stories` (they are built by `server/query.ts`, not by the id
  // walk), so without this an index page would show a stale URL for a story it
  // lists until its own TTL ran out. Bounded by `MAX_PER_PAGE`, well inside the
  // tag budget.
  for (const answer of Object.values(resolution.collections ?? {})) {
    for (const item of answer.items) tags.add(storyTag(item.id))
  }

  const all = [...tags].sort()
  // Every tag is ASCII after `encode`, so a character is a byte. `+ 1` per tag
  // for the separators, one fewer than the count.
  const bytes = all.reduce((n, tag) => n + tag.length + 1, -1)
  if (all.length > MAX_CACHE_TAGS || bytes > MAX_CACHE_TAG_BYTES) {
    // Truncating would leave the page un-purgeable by whichever ids fell off
    // the end, and un-purgeable *silently*. Coarsening keeps the page reachable
    // by its own publish and by the two whole-site triggers, and `degraded`
    // says so out loud so a host can log it rather than discover it.
    return {
      tags: opts.story ? [SITE_TAG, storyTag(opts.story)] : [SITE_TAG],
      degraded: true,
    }
  }
  return { tags: all, degraded: false }
}

/**
 * `cache-control` and `cache-tag` together, applied to a response as one spread.
 *
 * **Together, deliberately** (decision 2). The dangerous state is the
 * half-configured one: `Cache-Control` with no `Cache-Tag` is a page cached for
 * its full TTL with no purge path, which fails silently and is worse than no
 * caching at all. Forgetting both is harmless. That asymmetry is why there is
 * one function rather than two.
 *
 * ```
 * cache-control: public, max-age=0, s-maxage=604800, must-revalidate
 * ```
 *
 * **`max-age` is 0 on purpose.** A purge reaches the edge and cannot reach a
 * browser cache: a visitor who loaded the page under `max-age=300` keeps their
 * stale copy for five minutes after publish and nothing can evict it — the
 * editor sees the new page, the visitor does not. `s-maxage` governs only the
 * shared cache, which is exactly the part `purge()` can clear, so the edge TTL
 * is a week: with invalidation measured under 165 ms there is no reason for the
 * edge copy to expire on a timer. **The TTL is the fallback for a purge that
 * never arrives, not the mechanism.** `must-revalidate` stops a browser serving
 * its zero-age copy when offline.
 */
export function cacheHeaders(resolution: Resolution, opts: CacheHeaderOptions): CacheHeaders {
  return {
    'cache-control': cacheControl(opts.maxAge),
    'cache-tag': cacheTags(resolution, opts).tags.join(','),
  }
}

/** The `Cache-Control` half on its own, for a host assembling headers itself. */
export function cacheControl(maxAge = 0): string {
  const browser = Number.isFinite(maxAge) && maxAge > 0 ? Math.trunc(maxAge) : 0
  return `public, max-age=${browser}, s-maxage=${DEFAULT_S_MAXAGE}, must-revalidate`
}
