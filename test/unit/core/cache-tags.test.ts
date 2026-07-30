import { describe, expect, it } from 'vitest'
import {
  ANY_TYPE_TAG,
  cacheControl,
  cacheHeaders,
  cacheTags,
  DEFAULT_S_MAXAGE,
  globalTag,
  MAX_CACHE_TAGS,
  SITE_TAG,
  storyTag,
  typeTag,
} from '../../../src/core/cache-tags'
import type { Doc } from '../../../src/core/doc'
import { collection, multilink, reference } from '../../../src/core/fields'
import { collectionQueries, queryKey } from '../../../src/core/query'
import { buildResolution, type Resolution } from '../../../src/core/resolve'
import type { SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta } from '../../../src/core/story'

function story(overrides: Partial<StoryMeta> = {}): StoryMeta {
  return {
    id: 'sty_page',
    type: 'page',
    parentId: null,
    slug: 'page',
    path: 'page',
    ord: 'a0',
    title: 'Page',
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    updatedAt: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    ...overrides,
  }
}

const EMPTY_DOC: Doc = { root: 'r', bloks: {} }

/**
 * The whole acceptance criterion in one fixture: a page that links to B,
 * references record C, renders the `header` global, and carries a collection
 * over `insight`. The collection key is built by the same `collectionQueries`
 * a real `resolve()` uses, so this pins the two ends against each other rather
 * than against a hand-written key.
 */
function pageResolution(): Resolution {
  const schema: SchemaIndex = {
    page: {
      name: 'page',
      label: 'Page',
      fields: {
        link: multilink({ label: 'Link' }),
        person: reference({ label: 'Person' }),
        list: collection({ label: 'List', type: 'insight' }),
      },
    },
  } as unknown as SchemaIndex
  const doc: Doc = {
    root: 'r',
    bloks: {
      r: { uid: 'r', type: 'page', parent: null, slot: null, order: 'a0', data: {} },
    },
  }
  const keys = [...collectionQueries(doc, schema).keys()]

  return {
    ...buildResolution([
      story({ id: 'sty_b', path: 'b', title: 'B' }),
      story({ id: 'rec_c', type: 'person', path: null, title: 'C' }),
    ]),
    globals: { header: EMPTY_DOC },
    collections: Object.fromEntries(
      keys.map((key) => [key, { items: [], total: 0, page: 1, perPage: 20, pages: 0 }]),
    ),
  }
}

describe('cacheTags', () => {
  it('describes what the page rendered: its own id, what it loaded, its globals and its collection types', () => {
    const { tags, degraded } = cacheTags(pageResolution(), { story: 'sty_page' })

    expect(new Set(tags)).toEqual(
      new Set([
        SITE_TAG,
        storyTag('sty_page'),
        storyTag('sty_b'),
        storyTag('rec_c'),
        globalTag('header'),
        typeTag('insight'),
      ]),
    )
    expect(degraded).toBe(false)
  })

  it('always carries the site tag, even for a resolution that loaded nothing at all', () => {
    expect(cacheTags({ stories: {}, assetBase: '/a' }, { story: null })).toEqual({
      tags: [SITE_TAG],
      degraded: false,
    })
  })

  it('tags the page itself even when nothing links to it', () => {
    const { tags } = cacheTags({ stories: {}, assetBase: '/a' }, { story: 'sty_page' })
    expect(tags).toEqual([SITE_TAG, storyTag('sty_page')].sort())
  })

  it('is sorted, so the header is byte-stable between two renders of the same page', () => {
    const first = cacheTags(pageResolution(), { story: 'sty_page' }).tags
    const second = cacheTags(pageResolution(), { story: 'sty_page' }).tags
    expect(first).toEqual([...first].sort())
    expect(first.join(',')).toBe(second.join(','))
  })

  it('tags an ancestor, which is what makes a breadcrumb purgeable with no edge recorded', () => {
    const resolution = buildResolution([story({ id: 'sty_root', path: '', title: 'Home' })])
    const { tags } = cacheTags(resolution, { story: 'sty_deep' })
    expect(tags).toContain(storyTag('sty_root'))
  })

  describe('globals', () => {
    it('names every global the render loaded, with no reverse index consulted', () => {
      const resolution: Resolution = {
        stories: {},
        assetBase: '/a',
        globals: { header: EMPTY_DOC, settings: EMPTY_DOC },
      }
      const { tags } = cacheTags(resolution, { story: 'sty_page' })
      expect(tags).toContain(globalTag('header'))
      expect(tags).toContain(globalTag('settings'))
    })

    it('emits none for a site with no globals configured', () => {
      const { tags } = cacheTags({ stories: {}, assetBase: '/a' }, { story: 'sty_page' })
      expect(tags.some((t) => t.startsWith('global:'))).toBe(false)
    })
  })

  describe('collections', () => {
    const withKeys = (keys: string[]): Resolution => ({
      stories: {},
      assetBase: '/a',
      collections: Object.fromEntries(
        keys.map((key) => [key, { items: [], total: 0, page: 1, perPage: 20, pages: 0 }]),
      ),
    })

    it('reads the document types back off the query key', () => {
      const key = queryKey({ type: 'insight', status: 'published' })
      const { tags } = cacheTags(withKeys([key]), { story: 'sty_page' })
      expect(tags).toContain(typeTag('insight'))
      expect(tags).not.toContain(ANY_TYPE_TAG)
    })

    it('names every type of a query over several', () => {
      const key = queryKey({ type: ['insight', 'page'], status: 'published' })
      const { tags } = cacheTags(withKeys([key]), { story: 'sty_page' })
      expect(tags).toContain(typeTag('insight'))
      expect(tags).toContain(typeTag('page'))
    })

    it('degrades a query that filters no type at all to the wildcard, rather than to nothing', () => {
      const key = queryKey({ status: 'published' })
      const { tags } = cacheTags(withKeys([key]), { story: 'sty_page' })
      expect(tags).toContain(ANY_TYPE_TAG)
      expect(tags.some((t) => t.startsWith('type:') && t !== ANY_TYPE_TAG)).toBe(false)
    })

    it('treats a key it cannot parse as the wildcard, never as no dependency', () => {
      const { tags } = cacheTags(withKeys(['not json at all']), { story: 'sty_page' })
      expect(tags).toContain(ANY_TYPE_TAG)
    })

    it('collapses two pages of one query onto the same type tag', () => {
      const one = queryKey({ type: 'insight', page: 1, status: 'published' })
      const two = queryKey({ type: 'insight', page: 2, status: 'published' })
      expect(one).not.toBe(two)
      const { tags } = cacheTags(withKeys([one, two]), { story: 'sty_page' })
      expect(tags.filter((t) => t.startsWith('type:'))).toEqual([typeTag('insight')])
    })
  })

  describe('locales', () => {
    it('gives a source-locale render and an unlocalised one identical tags', () => {
      const unlocalised = pageResolution()
      const sourceLocale: Resolution = { ...pageResolution(), page: 1 }
      expect(cacheTags(sourceLocale, { story: 'sty_page' }).tags).toEqual(
        cacheTags(unlocalised, { story: 'sty_page' }).tags,
      )
    })

    it('gives a French render the same tags as an English one, so one publish purges both', () => {
      const english = pageResolution()
      const french: Resolution = {
        ...pageResolution(),
        locale: { code: 'fr', fallbacks: [] },
      }
      expect(cacheTags(french, { story: 'sty_page' }).tags).toEqual(
        cacheTags(english, { story: 'sty_page' }).tags,
      )
    })
  })

  describe('overflow', () => {
    const manyStories = (n: number): Resolution => ({
      stories: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `sty_${i}`,
          { id: `sty_${i}`, path: '', url: '', title: '', type: 'page', routable: true },
        ]),
      ),
      assetBase: '/a',
    })

    it('coarsens rather than truncates past the tag count budget', () => {
      const result = cacheTags(manyStories(MAX_CACHE_TAGS + 1), { story: 'sty_page' })
      expect(result.degraded).toBe(true)
      expect(result.tags).toEqual([SITE_TAG, storyTag('sty_page')])
    })

    it('stays precise just under the budget', () => {
      // 998 stories + the page's own id + `site` is exactly MAX_CACHE_TAGS.
      const result = cacheTags(manyStories(MAX_CACHE_TAGS - 2), { story: 'sty_page' })
      expect(result.degraded).toBe(false)
      expect(result.tags).toHaveLength(MAX_CACHE_TAGS)
    })

    it('coarsens on header bytes as well as on count', () => {
      const long = 'x'.repeat(2000)
      const resolution: Resolution = {
        stories: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `${long}${i}`,
            { id: `${long}${i}`, path: '', url: '', title: '', type: 'page', routable: true },
          ]),
        ),
        assetBase: '/a',
      }
      const result = cacheTags(resolution, { story: 'sty_page' })
      expect(result.degraded).toBe(true)
      expect(result.tags).toEqual([SITE_TAG, storyTag('sty_page')])
    })

    it('keeps only the site tag when a degraded page has no story of its own', () => {
      expect(cacheTags(manyStories(MAX_CACHE_TAGS + 1), { story: null })).toEqual({
        tags: [SITE_TAG],
        degraded: true,
      })
    })
  })

  describe('encoding', () => {
    it('escapes a name that would otherwise split the comma-separated header', () => {
      const resolution: Resolution = {
        stories: {},
        assetBase: '/a',
        globals: { 'site, settings': EMPTY_DOC },
      }
      const { tags } = cacheTags(resolution, { story: null })
      expect(tags).toContain('global:site%2C%20settings')
      expect(tags.join(',').split(',')).toHaveLength(tags.length)
    })

    it('leaves an ordinary name alone', () => {
      expect(storyTag('sty_abc')).toBe('story:sty_abc')
      expect(globalTag('header')).toBe('global:header')
      expect(typeTag('insight')).toBe('type:insight')
    })
  })
})

describe('cacheHeaders', () => {
  it('asks the browser to hold nothing and the edge to hold it for a week', () => {
    const headers = cacheHeaders(pageResolution(), { story: 'sty_page' })
    expect(headers['cache-control']).toBe(
      `public, max-age=0, s-maxage=${DEFAULT_S_MAXAGE}, must-revalidate`,
    )
  })

  it('carries the tags in the same call, so the half-configured state is unspellable', () => {
    const headers = cacheHeaders(pageResolution(), { story: 'sty_page' })
    expect(headers['cache-tag'].split(',')).toEqual(
      cacheTags(pageResolution(), { story: 'sty_page' }).tags,
    )
  })

  it('lets a host raise the browser TTL and never the edge one', () => {
    const headers = cacheHeaders(pageResolution(), { story: 'sty_page', maxAge: 60 })
    expect(headers['cache-control']).toBe(
      `public, max-age=60, s-maxage=${DEFAULT_S_MAXAGE}, must-revalidate`,
    )
  })

  it('clamps a nonsense maxAge back to 0 rather than emitting it', () => {
    expect(cacheControl(-5)).toContain('max-age=0')
    expect(cacheControl(Number.NaN)).toContain('max-age=0')
    expect(cacheControl(12.7)).toContain('max-age=12')
  })
})
