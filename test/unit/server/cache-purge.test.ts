import { describe, expect, it, vi } from 'vitest'
import { ANY_TYPE_TAG, formTag, globalTag, storyTag, typeTag } from '../../../src/core/cache-tags'
import type { Doc } from '../../../src/core/doc'
import type { Registry } from '../../../src/core/sites'
import type { StoryMeta } from '../../../src/core/story'
import {
  cachePurgeHooks,
  MAX_PURGE_CALLS,
  MAX_TAGS_PER_PURGE,
  purgeSite,
  SITE_PURGE_DELAY_MS,
  purgeFormLayout,
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

  it('formChanged purges exactly one tag, with no lookup of the pages holding it', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability)

    await fire(hooks, 'formChanged', {
      ...BASE,
      form: { id: 'frm_abc123abc123', name: 'contact', label: 'Contact', version: 2 },
      version: 2,
    })

    // `form:<id>` is emitted at render from `resolution.forms`, so the pages
    // that hold the form already carry it and nothing has to enumerate them —
    // which is what makes `content_refs`' 400-row truncation irrelevant here
    // (forms.md architecture decision 8).
    expect(calls).toEqual([{ tags: [formTag('frm_abc123abc123')] }])
  })

  describe('purgeFormLayout', () => {
    it('purges exactly `form:<id>`, the same tag `formChanged` purges, with no host-visible event', async () => {
      const { calls, capability } = recorder()
      await purgeFormLayout('frm_abc123abc123', capability, console)
      expect(calls).toEqual([{ tags: [formTag('frm_abc123abc123')] }])
    })

    it('is a silent no-op when the platform capability is absent', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(purgeFormLayout('frm_abc123abc123', ABSENT, console)).resolves.toBeUndefined()
      expect(logged).not.toHaveBeenCalled()
      logged.mockRestore()
    })
  })

  it('registers nothing for created, checkpointed or redirectsChanged', () => {
    const hooks = cachePurgeHooks<Env>([], ABSENT)
    expect(hooks.created).toBeUndefined()
    expect(hooks.checkpointed).toBeUndefined()
    // A redirect changes what an uncached 404 path answers; Folio's tags
    // describe rendered pages, so there is no right tag to purge. The event
    // exists for a host that caches its own 404s. (With `sites` it purges the
    // `path:` tags a fallen-back page carries: see "the owner-scoped purges".)
    expect(hooks.redirectsChanged).toBeUndefined()
    expect(hooks.siteChanged).toBeUndefined()
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

    /**
     * `FolioLogger` (#16, `types.ts`): a real, already-provoked failure — the
     * same rejected purge the first test in this block asserts — reaches a
     * configured logger instead of `console`. This is the proof for #16, not a
     * synthetic call: `cachePurgeHooks`'s third argument is exactly what
     * `runtime.ts` threads `FolioConfig.logger` through as.
     */
    it('reaches a configured logger instead of console', async () => {
      const { capability } = recorder({ success: false, errors: [{ code: 1, message: 'rate' }] })
      const errors: unknown[][] = []
      const logger = { error: (...args: unknown[]) => errors.push(args), warn: () => {} }
      const hooks = cachePurgeHooks<Env>([], capability, logger)
      const consoleLogged = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(
        fire(hooks, 'published', {
          ...BASE,
          story: STORY,
          doc: DOC,
          version: VERSION,
          publishedAt: 1,
        }),
      ).resolves.toBeUndefined()

      expect(errors).toHaveLength(1)
      expect(errors[0]?.[0]).toBe('folio: publish could not purge')
      expect(String(errors[0]?.[1])).toContain(storyTag('sty_a'))
      // The whole point of a configured logger: console stays untouched.
      expect(consoleLogged).not.toHaveBeenCalled()
      consoleLogged.mockRestore()
    })

    /**
     * The other half of the contract: a host that configures nothing keeps
     * reaching `console`, byte-identical to every version before this key
     * existed. Already covered above (`cachePurgeHooks<Env>([], capability)`
     * with no third argument), named here so the pairing is explicit.
     */
    it('falls back to console when no logger is configured', async () => {
      const { capability } = recorder({ success: false, errors: [{ code: 1, message: 'rate' }] })
      const hooks = cachePurgeHooks<Env>([], capability)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      await fire(hooks, 'published', {
        ...BASE,
        story: STORY,
        doc: DOC,
        version: VERSION,
        publishedAt: 1,
      })

      expect(logged).toHaveBeenCalledTimes(1)
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

describe('multi-site purges (decisions 4 and 15)', () => {
  const registry: Registry = {
    groups: [{ id: 'north', name: 'North' }],
    sites: ['default', 'alpha', 'gamma', 'bravo'].map((id) => ({
      id,
      name: id,
      group: id === 'alpha' || id === 'gamma' ? 'north' : null,
      status: 'live' as const,
      hosts: [],
      preview: null,
    })),
  }
  const hooksFor = (capability: PurgeCapability) =>
    cachePurgeHooks<Env>(['header'], capability, undefined, {
      registry: async () => registry,
      layered: ['header', 'siteSettings'],
    })
  const owned = (site: string, over: Partial<StoryMeta> = {}): StoryMeta => ({
    ...STORY,
    id: 'sty_ev',
    type: 'event',
    path: 'events/a',
    site,
    ...over,
  })
  const publish = (hooks: FolioHooks<Env>, story: StoryMeta) =>
    fire(hooks, 'published', { ...BASE, story, doc: DOC, version: VERSION, publishedAt: 1 })

  it('a publish in bravo purges no tag an alpha render carries', async () => {
    const { calls, capability } = recorder()
    await publish(hooksFor(capability), owned('bravo'))
    expect(new Set(calls[0]!.tags)).toEqual(
      new Set(['story:sty_ev', 'type:event@bravo', 'type:*@bravo', 'path:bravo:events%2Fa']),
    )
    // alpha's chain is alpha, north, shared: none of its tags is bravo's.
    expect(calls[0]!.tags!.some((t) => t.includes('alpha') || t.endsWith('@north'))).toBe(false)
  })

  it("a publish in a group fans its path out over the group's sites only", async () => {
    const { calls, capability } = recorder()
    await publish(hooksFor(capability), owned('north'))
    expect(new Set(calls[0]!.tags)).toEqual(
      new Set([
        'story:sty_ev',
        'type:event@north',
        'type:*@north',
        'path:alpha:events%2Fa',
        'path:gamma:events%2Fa',
      ]),
    )
  })

  it('a publish in shared fans its path out over every site', async () => {
    const { calls, capability } = recorder()
    await publish(hooksFor(capability), owned('shared', { path: 'stores' }))
    expect(new Set(calls[0]!.tags)).toEqual(
      new Set([
        'story:sty_ev',
        'type:event@shared',
        'type:*@shared',
        'path:default:stores',
        'path:alpha:stores',
        'path:gamma:stores',
        'path:bravo:stores',
      ]),
    )
  })

  it('a fork publishing purges the path on the forking site (a story without a path adds none)', async () => {
    const { calls, capability } = recorder()
    await publish(hooksFor(capability), owned('alpha', { path: 'stores', type: 'page' }))
    expect(calls[0]!.tags).toContain('path:alpha:stores')
    const unrouted = recorder()
    await publish(hooksFor(unrouted.capability), owned('alpha', { path: null }))
    expect(unrouted.calls[0]!.tags!.some((t) => t.startsWith('path:'))).toBe(false)
  })

  it('unpublish purges the same set as publish', async () => {
    const a = recorder()
    const b = recorder()
    await publish(hooksFor(a.capability), owned('north'))
    await fire(hooksFor(b.capability), 'unpublished', { ...BASE, story: owned('north') })
    expect(b.calls[0]!.tags).toEqual(a.calls[0]!.tags)
  })

  it('a first layer publish purges the layer tag, the unscoped one for shared', async () => {
    const shared = recorder()
    await publish(
      hooksFor(shared.capability),
      owned('shared', { id: 'sng_header:shared', type: 'header', path: null }),
    )
    expect(new Set(shared.calls[0]!.tags)).toEqual(
      new Set(['story:sng_header%3Ashared', 'global:header']),
    )

    const group = recorder()
    await publish(
      hooksFor(group.capability),
      owned('north', { id: 'sng_header:north', type: 'header', path: null }),
    )
    expect(group.calls[0]!.tags).toContain('global:header@north')

    const site = recorder()
    await publish(
      hooksFor(site.capability),
      owned('alpha', { id: 'sng_siteSettings:alpha', type: 'siteSettings', path: null }),
    )
    expect(site.calls[0]!.tags).toContain('global:siteSettings@alpha')
  })

  it('a retitle purges the story and its path fan-out, not a type', async () => {
    const { calls, capability } = recorder()
    await fire(hooksFor(capability), 'updated', {
      ...BASE,
      story: owned('north'),
      changed: ['title'],
    })
    expect(new Set(calls[0]!.tags)).toEqual(
      new Set(['story:sty_ev', 'path:alpha:events%2Fa', 'path:gamma:events%2Fa']),
    )
  })

  it("stays byte-identical without a registry: today's unscoped tags, whatever story.site says", async () => {
    const { calls, capability } = recorder()
    await fire(cachePurgeHooks<Env>([], capability), 'published', {
      ...BASE,
      story: owned('alpha'),
      doc: DOC,
      version: VERSION,
      publishedAt: 1,
    })
    expect(new Set(calls[0]!.tags)).toEqual(new Set(['story:sty_ev', 'type:event', ANY_TYPE_TAG]))
  })

  it('returns the set it issued, even with no capability to carry it out', async () => {
    const hooks = hooksFor(ABSENT)
    const issued = await (hooks.published as (e: unknown) => Promise<unknown>)({
      ...BASE,
      story: owned('bravo'),
      doc: DOC,
      version: VERSION,
      publishedAt: 1,
    })
    expect(issued).toEqual({
      tags: ['path:bravo:events%2Fa', 'story:sty_ev', 'type:*@bravo', 'type:event@bravo'],
    })
  })

  it('flushes rather than guess when the registry cannot be read', async () => {
    const { calls, capability } = recorder()
    const error = vi.fn()
    const hooks = cachePurgeHooks<Env>(
      ['header'],
      capability,
      { warn() {}, error, info() {} } as never,
      {
        registry: async () => {
          throw new Error('d1 down')
        },
        layered: [],
      },
    )
    await publish(hooks, owned('north'))
    expect(calls).toEqual([{ purgeEverything: true }])
    expect(error).toHaveBeenCalled()
  })

  it('still respects 100 tags per call on a shared publish across many sites', async () => {
    const big: Registry = {
      groups: [],
      sites: Array.from({ length: 150 }, (_, i) => ({
        id: `s${i}`,
        name: `s${i}`,
        group: null,
        status: 'live' as const,
        hosts: [],
        preview: null,
      })),
    }
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability, undefined, {
      registry: async () => big,
      layered: [],
    })
    await publish(hooks, owned('shared'))
    expect(calls.length).toBe(2)
    expect(calls.every((c) => c.tags!.length <= MAX_TAGS_PER_PURGE)).toBe(true)
    expect(calls.flatMap((c) => c.tags!)).toHaveLength(153)
  })

  describe('purgeSite', () => {
    it('purges site:<id> now and again 25 seconds later under waitUntil', async () => {
      const { calls, capability } = recorder()
      const pending: Promise<unknown>[] = []
      const slept: number[] = []
      const issued = await purgeSite('alpha', (p) => pending.push(p), {
        capability,
        sleep: async (ms) => {
          slept.push(ms)
        },
      })
      expect(issued).toEqual({ tags: ['site:alpha'] })
      expect(calls).toEqual([{ tags: ['site:alpha'] }])
      expect(pending).toHaveLength(1)
      await Promise.all(pending)
      expect(slept).toEqual([25_000])
      expect(SITE_PURGE_DELAY_MS).toBe(25_000)
      expect(calls).toEqual([{ tags: ['site:alpha'] }, { tags: ['site:alpha'] }])
    })

    it('does not run the second purge until the delay has elapsed', async () => {
      const { calls, capability } = recorder()
      const pending: Promise<unknown>[] = []
      let release: () => void = () => {}
      await purgeSite('alpha', (p) => pending.push(p), {
        capability,
        sleep: () => new Promise<void>((r) => (release = r)),
      })
      await Promise.resolve()
      expect(calls).toHaveLength(1)
      release()
      await Promise.all(pending)
      expect(calls).toHaveLength(2)
    })
  })

  it('reindex and migrate keep their meaning: reindex flushes, migrate is by story id', async () => {
    const { calls, capability } = recorder()
    const hooks = hooksFor(capability)
    await fire(hooks, 'reindexed', { ...BASE, count: 3 })
    await fire(hooks, 'migrated', { ...BASE, ids: ['sty_a'], migrations: ['m'] })
    expect(calls).toEqual([{ purgeEverything: true }, { tags: ['story:sty_a'] }])
  })
})
