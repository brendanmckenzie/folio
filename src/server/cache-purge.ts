/**
 * Folio's second after-commit hook: turning a lifecycle event into a Workers
 * Cache purge (`../../docs/specs/platform/caching.md` decision 3).
 *
 * A plain `FolioHooks` literal on the same internal array `space-events.ts`
 * hangs off — one after-commit path in this codebase, not a host-facing one and
 * a private one that drift.
 *
 * **Folio purges; the host tags.** Ownership follows what each side holds: the
 * host holds the `Response` and sets `Cache-Control`/`Cache-Tag` on it (Folio
 * never constructs a published response), and Folio holds the events and the id
 * sets, so it computes and it purges. The rejected alternative was to let each
 * host purge in its own hook — more consistent with "Folio computes, host acts",
 * and it would keep an untestable platform call out of the library — but the
 * purge set is derived from Folio's own internals, so every host would
 * reimplement that mapping and drift from it on the next release. A tag
 * vocabulary is a contract; the thing that mints tags should be the thing that
 * purges them.
 *
 * **Three traps, all measured on a deployed Worker on 2026-07-30 rather than
 * read out of the docs.**
 *
 * 1. The `cache` export of `cloudflare:workers` is **request-scoped**. At module
 *    scope its `purge` is not a function, so importing it once and holding the
 *    reference gives a permanent no-op that never purges, never errors and
 *    passes every test. It is dereferenced inside `capability()`, at call time,
 *    every time.
 * 2. When the host has not enabled caching the capability is **absent**, not
 *    failing: no throw, no `{ success: false }`. So the guard is a `typeof`
 *    probe and the try/catch below is for genuine runtime errors only.
 * 3. The Cache API (`caches.default.delete()`, already used correctly by
 *    `assets.ts`) is **per-colo**. A publish hook runs in exactly one data
 *    centre, so purging that way is a TTL with extra steps. This is the whole
 *    reason the purge is Workers Cache's rather than the obvious one.
 *
 * None of it is testable locally — miniflare simulates no part of Workers Cache
 * — so everything computable lives in `purgePlan` and `core/cache-tags.ts`, and
 * `scripts/cache-probe.mjs` is what exercises the rest against a deployment.
 */
import { ANY_TYPE_TAG, globalTag, storyTag, typeTag } from '../core/cache-tags'
import type { FolioHooks } from './hooks'

/** Workers Cache's own cap on one `purge()` call. */
export const MAX_TAGS_PER_PURGE = 100

/**
 * How many purge calls one trigger may spend before flushing instead.
 *
 * One minute of the Free plan's account-wide budget (5 purges/minute), so a run
 * never spends more than its own minute and never trips a limit it would then
 * have to retry past. Roughly 500 documents; below it a three-document
 * migration costs one call and leaves the rest of the site cached, which is the
 * case this threshold exists to protect — a migration is exactly when a site is
 * already churning.
 */
export const MAX_PURGE_CALLS = 5

/** What `cache.purge` looks like once resolved. */
type Purge = (options: CachePurgeOptions) => Promise<CachePurgeResult>

/**
 * How the hook reaches Workers Cache. Resolved per call, never held (trap 1),
 * and injectable so the event→tags mapping can be tested without a platform
 * that simulates none of this.
 */
export type PurgeCapability = () => Promise<Purge | null>

/**
 * The real thing. `null` whenever the capability is absent — a host without
 * `"cache": { "enabled": true }`, `wrangler dev`, workerd under vitest, or a
 * Node unit test where the module does not resolve at all — in which case every
 * purge below is a no-op and behaviour is byte-identical to before this file.
 *
 * A dynamic import rather than a static one, for two reasons that point the same
 * way: it cannot be hoisted into a module-scope dereference (trap 1), and
 * `cloudflare:workers` does not resolve under Node, where the unit suite imports
 * `runtime.ts` for `alarmHookCtx`.
 */
const platformPurge: PurgeCapability = async () => {
  try {
    const { cache } = await import('cloudflare:workers')
    return typeof cache?.purge === 'function' ? (options) => cache.purge(options) : null
  } catch {
    return null
  }
}

/** What one trigger's tags turn into: some number of calls, or one flush. */
export interface PurgePlan {
  /** Tag batches, each within `MAX_TAGS_PER_PURGE`. Empty when flushing. */
  batches: string[][]
  /** Purge the whole cache instead, because precision would cost too much. */
  everything: boolean
  /** Distinct tags the trigger asked for, for the log line. */
  tags: number
}

/**
 * The batching rule from decision 6, pure so it is testable independently of
 * the platform call it feeds.
 *
 * ```
 * tags in batches of 100
 *   ≤ MAX_PURGE_CALLS batches  → purge by tag, precisely
 *   > MAX_PURGE_CALLS batches  → purgeEverything
 * ```
 *
 * Rejected: always precise. A 10,000-document migration would be 100 calls
 * crawling under the rate limit with the site half-invalidated for twenty
 * minutes, and a rejected call fails without failing the migration — the worst
 * of the three outcomes. Also rejected: always flushing, which throws away the
 * cache of an entire site to invalidate three pages.
 */
export function purgePlan(tags: readonly string[]): PurgePlan {
  const distinct = [...new Set(tags)].sort()
  if (distinct.length === 0) return { batches: [], everything: false, tags: 0 }

  const batches: string[][] = []
  for (let i = 0; i < distinct.length; i += MAX_TAGS_PER_PURGE) {
    batches.push(distinct.slice(i, i + MAX_TAGS_PER_PURGE))
  }
  return batches.length > MAX_PURGE_CALLS
    ? { batches: [], everything: true, tags: distinct.length }
    : { batches, everything: false, tags: distinct.length }
}

/**
 * The tags a document's own publish, unpublish or delete invalidates.
 *
 * `type:` is not the document's own page — it is every *index* page listing this
 * type, which is what makes collections purgeable with no membership table.
 * `ANY_TYPE_TAG` covers a collection field that filters no type at all and would
 * otherwise be silently un-purgeable (see `core/cache-tags.ts`). A configured
 * global also carries its own name, because `global:` is how a page that
 * *rendered* the header is reached — `story:` alone would only reach the
 * header's own preview.
 */
function tagsFor(id: string, type: string, globals: readonly string[]): string[] {
  const tags = [storyTag(id), typeTag(type), ANY_TYPE_TAG]
  if (globals.includes(type)) tags.push(globalTag(type))
  return tags
}

/**
 * The internal hook set. `globals` is `FolioConfig.globals` as the runtime
 * resolved it — the explicit list, not every singleton — so publishing the
 * header purges `global:header` and publishing a person record that happens to
 * be a singleton does not.
 */
export function cachePurgeHooks<Env>(
  globals: readonly string[],
  capability: PurgeCapability = platformPurge,
): FolioHooks<Env> {
  /**
   * Awaited, not fired and forgotten (decision 5). `waitUntil` would let the
   * 200 reach the editor before the purge lands, and the editor's very next act
   * is to reload the page they just published. Workers Cache purge returns a
   * real signal — unlike `cache.put()` — and a rate-limit rejection arrives as
   * `success: false` rather than a throw, so both are inspected. Internal hooks
   * are awaited by `createHookRunner` regardless of the host's `await` list,
   * which is what makes this an actual guarantee rather than a hope.
   */
  const purge = async (trigger: string, tags: readonly string[]): Promise<void> => {
    const plan = purgePlan(tags)
    if (plan.batches.length === 0 && !plan.everything) return

    const fn = await capability()
    // Not an error, and not logged as one: this is `wrangler dev`, a test, or a
    // host that has not turned caching on, and for all three the right answer is
    // exactly the behaviour that existed before this file (decision 5).
    if (!fn) return

    try {
      if (plan.everything) {
        console.warn(
          `folio: ${trigger} purged the whole cache — ${plan.tags} tags is over ${MAX_PURGE_CALLS} calls`,
        )
        const result = await fn({ purgeEverything: true })
        if (!result.success) {
          console.error(`folio: ${trigger} could not flush the cache`, result.errors)
        }
        return
      }
      for (const batch of plan.batches) {
        const result = await fn({ tags: batch })
        // A failed purge never fails the write that caused it: the commit has
        // already landed. Self-healing rather than permanently stale — the next
        // publish of the same story purges the same tag.
        if (!result.success) {
          console.error(`folio: ${trigger} could not purge`, batch.join(','), result.errors)
        }
      }
    } catch (err) {
      // Trap 2: the absent capability is handled above, so anything reaching
      // here is a genuine runtime error and worth a line of its own.
      console.error(`folio: ${trigger} failed to purge`, err)
    }
  }

  return {
    published: ({ story }) => purge('publish', tagsFor(story.id, story.type, globals)),

    unpublished: ({ story }) => purge('unpublish', tagsFor(story.id, story.type, globals)),

    /**
     * Purged by id, never by path — `paths` carries `null` for an unrouted
     * document, and a `pathPrefixes` design would have had to special-case it.
     * The tag design sidesteps it entirely.
     */
    deleted: ({ ids, types }) =>
      purge(
        'delete',
        ids.flatMap((id, i) => tagsFor(id, types[i] ?? '', globals)),
      ),

    /**
     * A rename or a move. The *old* URL's cached entry is reached the same way
     * the new one is: it was rendered from this story, so it carries this
     * story's tag. Nothing has to know the old path, which is the second thing
     * decision 2's inversion buys.
     */
    pathsChanged: ({ changes }) =>
      purge(
        'rename',
        changes.map((c) => storyTag(c.id)),
      ),

    /**
     * Only a title matters here. `slug` and `parent` arrive with a
     * `pathsChanged` that purges the same id, and `ord` alone changes no page's
     * bytes at all — `ord` is absent from `StoryRef`, so a sibling reorder is
     * invisible to every render (the spec's own edge case). Purging on it would
     * be a cache flush for a row moving up one place.
     */
    updated: ({ story, changed }) =>
      changed.includes('title') ? purge('retitle', [storyTag(story.id)]) : undefined,

    /**
     * A migration knows exactly which published snapshots it rewrote, and
     * decision 2 makes that set *complete* rather than merely indicative:
     * `story:X` is tagged on every page that loaded X, not only on X's own page,
     * so purging the migrated ids also catches everything referencing them.
     * Over `MAX_PURGE_CALLS` batches it flushes instead, loudly.
     */
    migrated: ({ ids }) => purge('migration', ids.map(storyTag)),

    /**
     * The one trigger that genuinely cannot enumerate anything. A reindex
     * rebuilds `content_index` for the whole site, changing what every
     * collection query answers, and its affected set is "every page holding a
     * collection" — which nothing records. `purgeEverything`, because the
     * alternative is inventing a precision that does not exist.
     */
    reindexed: async ({ count }) => {
      const fn = await capability()
      if (!fn) return
      console.warn(
        `folio: reindex purged the whole cache — ${count} documents, and which pages hold a collection is not recorded anywhere`,
      )
      try {
        const result = await fn({ purgeEverything: true })
        if (!result.success) {
          console.error('folio: reindex could not flush the cache', result.errors)
        }
      } catch (err) {
        console.error('folio: reindex failed to purge', err)
      }
    },

    // `created` and `checkpointed` are deliberately absent: neither publishes
    // anything, so no cached page can be describing either of them yet.
    //
    // `redirectsChanged` is deliberately absent too, and for a different
    // reason. A redirect changes what an *uncached* 404 path answers, and
    // Folio's tags describe rendered pages rather than paths — there is no tag
    // that would be the right one to purge. A host that caches its own 404s
    // knows its origin and can purge by `pathPrefixes` in its own hook; the
    // event exists so that it can.
  }
}
