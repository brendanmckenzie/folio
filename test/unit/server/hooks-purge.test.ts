import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pathTag,
  scopedAnyTypeTag,
  scopedTypeTag,
  siteTag,
  storyTag,
} from '../../../src/core/cache-tags'
import type { Doc } from '../../../src/core/doc'
import type { Registry } from '../../../src/core/sites'
import type { StoryMeta } from '../../../src/core/story'
import {
  cachePurgeHooks,
  MAX_PURGE_CALLS,
  MAX_TAGS_PER_PURGE,
  type PurgeCapability,
  type PurgeIssued,
} from '../../../src/server/cache-purge'
import { createHookRunner, type FolioHooks } from '../../../src/server/hooks'
import { spaceNameFor } from '../../../src/server/space-events'
import type { VersionMeta } from '../../../src/server/versions'

type Env = { DB: unknown }

/**
 * What a hook payload carries beyond the event itself
 * (`docs/specs/foundation/multi-site.md` decision 16): the `site` that owns what
 * changed, and the `purge` **Folio's purger issued** — recorded by the capability it
 * called, so the equality asserted here is between two independent records of the same
 * act and cannot be satisfied by computing the set twice.
 *
 * And the three purges that were still unscoped when phase 6 landed: `deleted`,
 * `pathsChanged` and `redirectsChanged` (decision 15, "Purged by").
 */

function recorder() {
  const calls: CachePurgeOptions[] = []
  const capability: PurgeCapability = async () => async (options) => {
    calls.push(options)
    return { success: true, errors: [] }
  }
  return { calls, capability }
}

const ABSENT: PurgeCapability = async () => null

const REGISTRY: Registry = {
  sites: [
    {
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      hosts: [],
      preview: null,
      brand: null,
    },
    {
      id: 'beta',
      name: 'Beta',
      group: 'north',
      status: 'live',
      hosts: [],
      preview: null,
      brand: null,
    },
    {
      id: 'bravo',
      name: 'Bravo',
      group: null,
      status: 'live',
      hosts: [],
      preview: null,
      brand: null,
    },
  ],
  groups: [{ id: 'north', name: 'North', brand: null }],
  shared: true,
}
const SITES = { registry: async () => REGISTRY, layered: [] as string[] }

const STORY: StoryMeta = {
  id: 'sty_a',
  type: 'page',
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
  site: 'alpha',
}
const DOC: Doc = { root: 'r', bloks: {} }
const VERSION = { id: 'ver_1' } as VersionMeta

const CTX = { env: {} as Env, waitUntil: () => {}, brand: null }
const silent = { error: () => {}, warn: () => {} }

/** Fires one event through the real runner with Folio's own purge hook first. */
async function run(
  internal: FolioHooks<Env>,
  host: FolioHooks<Env>,
  fire: (runner: ReturnType<typeof createHookRunner<Env>>) => Promise<void>,
) {
  await fire(
    createHookRunner<Env>(
      { ...host, await: ['published', 'deleted', 'migrated'] },
      CTX,
      [internal],
      silent,
    ),
  )
}

describe('a host hook is told exactly what Folio purged', () => {
  it('carries the tags the capability was asked for, on a publish', async () => {
    const { calls, capability } = recorder()
    const seen: unknown[] = []
    await run(
      cachePurgeHooks<Env>([], capability, silent, SITES),
      { published: (e) => void seen.push(e) },
      (runner) =>
        runner.run('published', {
          story: STORY,
          doc: DOC,
          version: VERSION,
          publishedAt: 1,
          actor: null,
        }),
    )
    const payload = seen[0] as { site: string; purge: PurgeIssued }
    expect(payload.site).toBe('alpha')
    expect(payload.purge).toEqual({ tags: calls.flatMap((c) => c.tags ?? []) })
    expect(calls).toHaveLength(1)
    expect((payload.purge as { tags: string[] }).tags).toContain(pathTag('alpha', 'a'))
  })

  it('carries a flush as a flush, when the set is too wide to purge by tag', async () => {
    const { calls, capability } = recorder()
    const seen: unknown[] = []
    const ids = Array.from(
      { length: MAX_TAGS_PER_PURGE * MAX_PURGE_CALLS + 1 },
      (_, i) => `sty_${i}`,
    )
    await run(
      cachePurgeHooks<Env>([], capability, silent, SITES),
      { migrated: (e) => void seen.push(e) },
      (runner) => runner.run('migrated', { ids, migrations: ['m'], actor: null, site: null }),
    )
    expect(calls).toEqual([{ purgeEverything: true }])
    expect((seen[0] as { purge: PurgeIssued; site: null }).purge).toEqual({ everything: true })
    expect((seen[0] as { site: null }).site).toBeNull()
  })

  it('still reports what it computed when there is no platform to purge on', async () => {
    const seen: unknown[] = []
    await run(
      cachePurgeHooks<Env>([], ABSENT, silent, SITES),
      { published: (e) => void seen.push(e) },
      (runner) =>
        runner.run('published', {
          story: STORY,
          doc: DOC,
          version: VERSION,
          publishedAt: 1,
          actor: null,
        }),
    )
    expect((seen[0] as { purge: { tags: string[] } }).purge.tags).toContain(storyTag('sty_a'))
  })

  it('leaves it off an event that purged nothing, and defaults the site to default', async () => {
    const { capability } = recorder()
    const seen: unknown[] = []
    await run(
      cachePurgeHooks<Env>([], capability, silent),
      { created: (e) => void seen.push(e) },
      (runner) => runner.run('created', { story: { ...STORY, site: undefined }, actor: null }),
    )
    const payload = seen[0] as { purge?: unknown; site: string }
    expect(payload.purge).toBeUndefined()
    expect(payload.site).toBe('default')
  })
})

describe('the owner-scoped purges', () => {
  it('deleted: the owner’s type tags and its path on every site it reaches', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability, silent, SITES)
    await hooks.deleted!({
      ...CTX,
      actor: null,
      site: 'north',
      ids: ['sty_1', 'sty_2'],
      paths: ['about', null],
      types: ['page', 'post'],
    })
    expect(calls.flatMap((c) => c.tags ?? []).sort()).toEqual(
      [
        storyTag('sty_1'),
        scopedTypeTag('page', 'north'),
        scopedAnyTypeTag('north'),
        pathTag('alpha', 'about'),
        pathTag('beta', 'about'),
        storyTag('sty_2'),
        scopedTypeTag('post', 'north'),
      ].sort(),
    )
  })

  it('deleted in shared reaches every site, and in a site only itself', async () => {
    const shared = recorder()
    await cachePurgeHooks<Env>([], shared.capability, silent, SITES).deleted!({
      ...CTX,
      actor: null,
      site: 'shared',
      ids: ['sty_1'],
      paths: ['x'],
      types: ['page'],
    })
    const tags = shared.calls.flatMap((c) => c.tags ?? [])
    for (const site of ['alpha', 'beta', 'bravo']) expect(tags).toContain(pathTag(site, 'x'))

    const own = recorder()
    await cachePurgeHooks<Env>([], own.capability, silent, SITES).deleted!({
      ...CTX,
      actor: null,
      site: 'bravo',
      ids: ['sty_1'],
      paths: ['x'],
      types: ['page'],
    })
    const ownTags = own.calls.flatMap((c) => c.tags ?? [])
    expect(ownTags).toContain(pathTag('bravo', 'x'))
    expect(ownTags.filter((t) => /alpha|beta/.test(t))).toEqual([])
  })

  it('pathsChanged: the story and both paths, on the sites the owner reaches', async () => {
    const { calls, capability } = recorder()
    await cachePurgeHooks<Env>([], capability, silent, SITES).pathsChanged!({
      ...CTX,
      actor: null,
      site: 'alpha',
      changes: [{ id: 'sty_f', from: 'stores', to: 'our-stores' }],
    })
    expect(calls.flatMap((c) => c.tags ?? []).sort()).toEqual(
      [storyTag('sty_f'), pathTag('alpha', 'stores'), pathTag('alpha', 'our-stores')].sort(),
    )
  })

  it('redirectsChanged: the path on each site the redirect’s scope reaches; nothing without sites', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability, silent, SITES)
    const out = await hooks.redirectsChanged!({
      ...CTX,
      actor: null,
      site: 'north',
      from: ['a', 'b'],
    })
    expect(calls.flatMap((c) => c.tags ?? []).sort()).toEqual(
      [
        pathTag('alpha', 'a'),
        pathTag('alpha', 'b'),
        pathTag('beta', 'a'),
        pathTag('beta', 'b'),
      ].sort(),
    )
    expect(out).toEqual({ tags: calls.flatMap((c) => c.tags ?? []) })
    expect(cachePurgeHooks<Env>([], capability, silent).redirectsChanged).toBeUndefined()
  })

  it('flushes rather than guess when the registry cannot be read', async () => {
    const { calls, capability } = recorder()
    const hooks = cachePurgeHooks<Env>([], capability, silent, {
      registry: async () => {
        throw new Error('D1 is down')
      },
      layered: [],
    })
    const out = await hooks.pathsChanged!({
      ...CTX,
      actor: null,
      site: 'alpha',
      changes: [{ id: 's', from: 'a', to: 'b' }],
    })
    expect(out).toEqual({ everything: true })
    expect(calls).toEqual([{ purgeEverything: true }])
  })
})

describe('siteChanged', () => {
  afterEach(() => vi.useRealTimers())

  it('purges site:<id> now and again later, and reports the first', async () => {
    vi.useFakeTimers()
    const { calls, capability } = recorder()
    const later: Promise<unknown>[] = []
    const out = await cachePurgeHooks<Env>([], capability, silent, SITES).siteChanged!({
      ...CTX,
      waitUntil: (p) => void later.push(p),
      actor: null,
      site: 'alpha',
      kind: 'site',
      change: 'updated',
      row: null,
    })
    expect(out).toEqual({ tags: [siteTag('alpha')] })
    expect(calls).toEqual([{ tags: [siteTag('alpha')] }])
    await vi.advanceTimersByTimeAsync(25_000)
    await Promise.all(later)
    expect(calls).toEqual([{ tags: [siteTag('alpha')] }, { tags: [siteTag('alpha')] }])
  })

  it('is not registered on a deployment with no sites', () => {
    expect(cachePurgeHooks<Env>([], ABSENT, silent).siteChanged).toBeUndefined()
  })
})

describe('the space channel’s name', () => {
  it('is space for default and space:<scope> for every other scope', () => {
    expect(spaceNameFor('default')).toBe('space')
    expect(spaceNameFor(null)).toBe('space')
    expect(spaceNameFor('alpha')).toBe('space:alpha')
    expect(spaceNameFor('shared')).toBe('space:shared')
    expect(spaceNameFor('north')).toBe('space:north')
  })
})
