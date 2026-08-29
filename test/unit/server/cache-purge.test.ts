import { describe, expect, it, vi } from 'vitest'
import { ANY_TYPE_TAG, globalTag, storyTag, typeTag } from '../../../src/core/cache-tags'
import type { Doc } from '../../../src/core/doc'
import type { StoryMeta } from '../../../src/core/story'
import {
  cachePurgeHooks,
  MAX_PURGE_CALLS,
  MAX_TAGS_PER_PURGE,
  purgePlan,
  type PurgeCapability,
} from '../../../src/server/cache-purge'
import type { FolioHooks } from '../../../src/server/hooks'
import type { VersionMeta } from '../../../src/server/versions'

type Env = { DB: unknown }

/**
 * The event→tags mapping, driven through an injected capability.
 *
 * Deliberately **not** a fake of the platform behaviour: nothing here asserts
 * that a purge invalidates anything, because that is exactly the claim a local
 * test cannot make and faking it would produce a green suite that proves
 * nothing (`caching.md`'s Testing requirements). What is asserted is which tags
 * Folio *asks* for, per event — which is the part that can be wrong in a way a
 * reader would never notice.
 */
function recorder(result: CachePurgeResult = { success: true, errors: [] }) {
  const calls: CachePurgeOptions[] = []
  const capability: PurgeCapability = async () => async (options) => {
    calls.push(options)
    return result
  }
  return { calls, capability }
}

const ABSENT: PurgeCapability = async () => null

const STORY: StoryMeta = {
  id: 'sty_a',
  type: 'insight',
  parentId: null,
  slug: 'a',
  path: 'a',
  ord: 'a0',
  title: 'A',
  publishedAt: 1,
  unpublishedAt: null,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  updatedAt: 0,
  state: 'live',
  hasUnpublishedChanges: false,
}

const BASE = { env: {} as Env, waitUntil: () => {}, actor: null }
const DOC: Doc = { root: 'r', bloks: {} }
const VERSION = { id: 'ver_1' } as VersionMeta

/** Fires one event on a hook set, awaiting whatever it returns. */
async function fire<E extends keyof FolioHooks<Env>>(
  hooks: FolioHooks<Env>,
  event: E,
  payload: unknown,
): Promise<void> {
  const fn = hooks[event] as ((e: unknown) => unknown) | undefined
  await fn?.(payload)
}

describe('purgePlan', () => {
  it('is empty for no tags at all, so a trigger with nothing to purge costs no call', () => {
    expect(purgePlan([])).toEqual({ batches: [], everything: false, tags: 0 })
  })

  it('dedupes and sorts, so the same id from two sources costs one slot', () => {
    expect(purgePlan(['b', 'a', 'b'])).toEqual({
      batches: [['a', 'b']],
      everything: false,
      tags: 2,
    })
  })

  it('batches at the platform cap', () => {
    const tags = Array.from({ length: 142 }, (_, i) => `story:sty_${String(i).padStart(4, '0')}`)
    const plan = purgePlan(tags)
    expect(plan.everything).toBe(false)
    expect(plan.batches.map((b) => b.length)).toEqual([MAX_TAGS_PER_PURGE, 42])
    expect(plan.batches.flat()).toHaveLength(142)
  })

  it('stays precise at exactly the call budget', () => {
    const n = MAX_TAGS_PER_PURGE * MAX_PURGE_CALLS
    const tags = Array.from({ length: n }, (_, i) => `story:sty_${String(i).padStart(5, '0')}`)
    const plan = purgePlan(tags)
    expect(plan.everything).toBe(false)
    expect(plan.batches).toHaveLength(MAX_PURGE_CALLS)
  })

  it('flushes one tag past it, rather than crawling under the rate limit', () => {
    const n = MAX_TAGS_PER_PURGE * MAX_PURGE_CALLS + 1
    const tags = Array.from({ length: n }, (_, i) => `story:sty_${String(i).padStart(5, '0')}`)
    const plan = purgePlan(tags)
    expect(plan).toEqual({ batches: [], everything: true, tags: n })
  })
})

describe('cachePurgeHooks', () => {
  describe('published', () => {
    it('purges the story, its type and the untyped-collection wildcard', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)

      await fire(hooks, 'published', {
        ...BASE,
        story: STORY,
        doc: DOC,
        version: VERSION,
        publishedAt: 1,
      })

      expect(calls).toHaveLength(1)
      expect(new Set(calls[0]!.tags)).toEqual(
        new Set([storyTag('sty_a'), typeTag('insight'), ANY_TYPE_TAG]),
      )
      // The index page listing this insight is purged by `type:insight`, and
      // nothing had to know which pages those are.
      expect(calls[0]!.purgeEverything).toBeUndefined()
    })

    it('adds the global tag when the published document is a configured global', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>(['header'], capability)

      await fire(hooks, 'published', {
        ...BASE,
        story: { ...STORY, id: 'sng_header', type: 'header' },
        doc: DOC,
        version: VERSION,
        publishedAt: 1,
      })

      expect(calls[0]!.tags).toContain(globalTag('header'))
    })

    it('does not add a global tag for a singleton nobody declared as one', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>(['header'], capability)

      await fire(hooks, 'published', {
        ...BASE,
        story: { ...STORY, id: 'sng_settings', type: 'settings' },
        doc: DOC,
        version: VERSION,
        publishedAt: 1,
      })

      expect(calls[0]!.tags?.some((t) => t.startsWith('global:'))).toBe(false)
    })
  })

  it('unpublished purges the same set: the page is gone from every index too', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability)

    await fire(hooks, 'unpublished', { ...BASE, story: STORY })

    expect(new Set(calls[0]!.tags)).toEqual(
      new Set([storyTag('sty_a'), typeTag('insight'), ANY_TYPE_TAG]),
    )
  })

  it('deleted purges by id and by type, never by path', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability)

    await fire(hooks, 'deleted', {
      ...BASE,
      ids: ['sty_a', 'rec_b'],
      // `null` is an unrouted document, which is exactly why the tag design
      // does not purge by path.
      paths: ['a', null],
      types: ['insight', 'person'],
    })

    expect(new Set(calls[0]!.tags)).toEqual(
      new Set([
        storyTag('sty_a'),
        storyTag('rec_b'),
        typeTag('insight'),
        typeTag('person'),
        ANY_TYPE_TAG,
      ]),
    )
  })

  it('pathsChanged purges every moved id, which reaches the old URL as well as the new', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability)

    await fire(hooks, 'pathsChanged', {
      ...BASE,
      changes: [
        { id: 'sty_a', from: 'a', to: 'b' },
        { id: 'sty_child', from: 'a/c', to: 'b/c' },
      ],
    })

    expect(new Set(calls[0]!.tags)).toEqual(new Set([storyTag('sty_a'), storyTag('sty_child')]))
  })

  describe('updated', () => {
    it('purges on a title change, which alters every page linking here', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)

      await fire(hooks, 'updated', { ...BASE, story: STORY, changed: ['title'] })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.tags).toEqual([storyTag('sty_a')])
    })

    it('does nothing for a sibling reorder, whose ord no render reads', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)

      await fire(hooks, 'updated', { ...BASE, story: STORY, changed: ['ord'] })

      expect(calls).toEqual([])
    })

    it('leaves a slug-only change to pathsChanged, which purges the same id', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)

      await fire(hooks, 'updated', { ...BASE, story: STORY, changed: ['slug'] })

      expect(calls).toEqual([])
    })
  })

  describe('migrated', () => {
    it('purges precisely, in batches of the platform cap', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)
      const ids = Array.from({ length: 142 }, (_, i) => `sty_${String(i).padStart(4, '0')}`)

      await fire(hooks, 'migrated', { ...BASE, ids, migrations: ['0001'] })

      expect(calls).toHaveLength(2)
      expect(calls[0]!.tags).toHaveLength(MAX_TAGS_PER_PURGE)
      expect(calls[1]!.tags).toHaveLength(42)
      expect(calls.every((c) => c.purgeEverything === undefined)).toBe(true)
    })

    it('flushes instead past the call budget, and says so with the count', async () => {
      const { calls, capability } = recorder()
      const hooks = cachePurgeHooks<Env>([], capability)
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ids = Array.from({ length: 900 }, (_, i) => `sty_${String(i).padStart(4, '0')}`)

      await fire(hooks, 'migrated', { ...BASE, ids, migrations: ['0001'] })

      expect(calls).toEqual([{ purgeEverything: true }])
      expect(warned.mock.calls[0]?.[0]).toContain('migration purged the whole cache')
      expect(warned.mock.calls[0]?.[0]).toContain('900')
      warned.mockRestore()
    })
  })

  it('reindexed always flushes, and says why precision is not possible', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fire(hooks, 'reindexed', { ...BASE, count: 3 })

    expect(calls).toEqual([{ purgeEverything: true }])
    expect(warned.mock.calls[0]?.[0]).toContain('not recorded anywhere')
    warned.mockRestore()
  })

  it('registers nothing for created, checkpointed or redirectsChanged', () => {
    const hooks = cachePurgeHooks<Env>([], ABSENT)
    expect(hooks.created).toBeUndefined()
    expect(hooks.checkpointed).toBeUndefined()
    // A redirect changes what an uncached 404 path answers; Folio's tags
    // describe rendered pages, so there is no right tag to purge. The event
    // exists for a host that caches its own 404s.
    expect(hooks.redirectsChanged).toBeUndefined()
  })

  describe('when the platform capability is absent', () => {
    it('is a silent no-op, not an error', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const hooks = cachePurgeHooks<Env>([], ABSENT)

      await expect(
        fire(hooks, 'published', {
          ...BASE,
          story: STORY,
          doc: DOC,
          version: VERSION,
          publishedAt: 1,
        }),
      ).resolves.toBeUndefined()

      expect(logged).not.toHaveBeenCalled()
      expect(warned).not.toHaveBeenCalled()
      logged.mockRestore()
      warned.mockRestore()
    })

    it('does not even warn about a would-be flush, since there is nothing to flush', async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const hooks = cachePurgeHooks<Env>([], ABSENT)

      await fire(hooks, 'reindexed', { ...BASE, count: 3 })

      expect(warned).not.toHaveBeenCalled()
      warned.mockRestore()
    })
  })

  describe('failure', () => {
    it('logs a rejected purge with the tags it could not clear, and does not throw', async () => {
      const { capability } = recorder({ success: false, errors: [{ code: 1, message: 'rate' }] })
      const hooks = cachePurgeHooks<Env>([], capability)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(
        fire(hooks, 'published', {
          ...BASE,
          story: STORY,
          doc: DOC,
          version: VERSION,
          publishedAt: 1,
        }),
      ).resolves.toBeUndefined()

      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0]?.[0]).toBe('folio: publish could not purge')
      expect(String(logged.mock.calls[0]?.[1])).toContain(storyTag('sty_a'))
      logged.mockRestore()
    })

    it('swallows a throwing purge, so a publish that has already committed still succeeds', async () => {
      const capability: PurgeCapability = async () => async () => {
        throw new Error('boom')
      }
      const hooks = cachePurgeHooks<Env>([], capability)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(fire(hooks, 'unpublished', { ...BASE, story: STORY })).resolves.toBeUndefined()

      expect(logged.mock.calls[0]?.[0]).toBe('folio: unpublish failed to purge')
      logged.mockRestore()
    })
  })

  it('resolves the capability per call rather than holding it', async () => {
    // The trap that cost a deployed probe to find: `cloudflare:workers`'
    // `cache` export is request-scoped, so a reference taken once is a
    // permanent no-op that never purges and never errors.
    let resolved = 0
    const capability: PurgeCapability = async () => {
      resolved++
      return async () => ({ success: true, errors: [] })
    }
    const hooks = cachePurgeHooks<Env>([], capability)

    await fire(hooks, 'unpublished', { ...BASE, story: STORY })
    await fire(hooks, 'unpublished', { ...BASE, story: STORY })

    expect(resolved).toBe(2)
  })
})
