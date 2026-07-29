import { describe, expect, it } from 'vitest'
import type { Doc, Json } from '../../../src/core/doc'
import {
  asset as assetField,
  boolean,
  multiasset,
  multilink,
  number,
  reference,
  text,
} from '../../../src/core/fields'
import {
  buildResolution,
  EMPTY_RESOLUTION,
  referencedIds,
  resolveAsset,
  resolveAssets,
  resolveLink,
  resolveReference,
  resolveValue,
  type Resolution,
} from '../../../src/core/resolve'
import type { SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta } from '../../../src/core/story'
import type { AssetValue } from '../../../src/core/values'

function story(overrides: Partial<StoryMeta> = {}): StoryMeta {
  return {
    id: 'sty_home',
    parentId: null,
    slug: 'home',
    path: 'home',
    ord: 'a0',
    title: 'Home',
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 0,
    state: 'draft',
    ...overrides,
  }
}

// Typed as `Json` (not `AssetValue`) because every call site here hands the
// value to a function that reads it as stored, untyped document data.
function assetValue(overrides: Partial<AssetValue> = {}): Json {
  return {
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    size: 1024,
    alt: '',
    ...overrides,
  } as unknown as Json
}

describe('resolveLink', () => {
  const resolution = buildResolution([story({ id: 'sty_home', path: 'home', title: 'Home' })])

  it('resolves a story link to its current path', () => {
    const link = resolveLink({ kind: 'story', id: 'sty_home' }, resolution)
    expect(link).toEqual({ kind: 'story', href: '/home', title: 'Home' })
  })

  it('appends a missing # when a story link carries an anchor', () => {
    const link = resolveLink({ kind: 'story', id: 'sty_home', anchor: 'intro' }, resolution)
    expect(link?.href).toBe('/home#intro')
  })

  it('does not double the # when the stored anchor already has one', () => {
    const link = resolveLink({ kind: 'story', id: 'sty_home', anchor: '#intro' }, resolution)
    expect(link?.href).toBe('/home#intro')
  })

  it('marks a story link whose target has been deleted as broken, without dropping it', () => {
    const link = resolveLink({ kind: 'story', id: 'sty_ghost' }, resolution)
    expect(link).toEqual({ kind: 'story', href: '#', broken: true })
  })

  it('resolves a url link verbatim', () => {
    const link = resolveLink({ kind: 'url', url: 'https://example.com/page' }, resolution)
    expect(link).toEqual({ kind: 'url', href: 'https://example.com/page' })
  })

  it('encodes the subject of a mailto link', () => {
    const link = resolveLink(
      { kind: 'email', email: 'hello@example.com', subject: 'Hello & welcome' },
      resolution,
    )
    expect(link?.href).toBe('mailto:hello@example.com?subject=Hello%20%26%20welcome')
  })

  it('leaves a subject-less mailto link without a query string', () => {
    const link = resolveLink({ kind: 'email', email: 'hello@example.com' }, resolution)
    expect(link?.href).toBe('mailto:hello@example.com')
  })

  it('normalises a bare anchor link to a single #', () => {
    expect(resolveLink({ kind: 'anchor', anchor: 'section-2' }, resolution)?.href).toBe(
      '#section-2',
    )
    expect(resolveLink({ kind: 'anchor', anchor: '#section-2' }, resolution)?.href).toBe(
      '#section-2',
    )
  })

  it('resolves an asset link by decorating the underlying asset', () => {
    const link = resolveLink(
      {
        kind: 'asset',
        asset: assetValue({ key: 'files/brochure.pdf', contentType: 'application/pdf' }),
      },
      resolution,
    )
    expect(link?.href).toBe('/folio/asset/files/brochure.pdf')
  })

  it('returns null for a value that is not a recognised link', () => {
    expect(resolveLink(undefined, resolution)).toBeNull()
    expect(resolveLink({ kind: 'nonsense' }, resolution)).toBeNull()
  })

  describe('windowing (target/rel defaulting)', () => {
    it('adds neither target nor rel when nothing is set', () => {
      const link = resolveLink({ kind: 'url', url: 'https://example.com' }, resolution)
      expect(link?.target).toBeUndefined()
      expect(link?.rel).toBeUndefined()
    })

    it('passes an explicit rel through when there is no target', () => {
      const link = resolveLink(
        { kind: 'url', url: 'https://example.com', rel: 'sponsored' },
        resolution,
      )
      expect(link).toMatchObject({ rel: 'sponsored' })
      expect(link?.target).toBeUndefined()
    })

    it('defaults rel to noopener noreferrer for a new-window link with no rel of its own', () => {
      const link = resolveLink(
        { kind: 'url', url: 'https://example.com', target: '_blank' },
        resolution,
      )
      expect(link).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
    })

    it('keeps an explicit rel on a new-window link instead of the default', () => {
      const link = resolveLink(
        { kind: 'url', url: 'https://example.com', target: '_blank', rel: 'nofollow' },
        resolution,
      )
      expect(link).toMatchObject({ target: '_blank', rel: 'nofollow' })
    })

    it('still defaults rel for a new-window story link, which carries no rel of its own', () => {
      const link = resolveLink({ kind: 'story', id: 'sty_home', target: '_blank' }, resolution)
      expect(link).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
    })
  })
})

describe('resolveAsset (decorateAsset)', () => {
  const resolution: Resolution = { stories: {}, assetBase: '/folio/asset' }

  it('builds the src from assetBase + key', () => {
    const resolved = resolveAsset(assetValue({ key: 'library/photo.jpg' }), resolution)
    expect(resolved?.src).toBe('/folio/asset/library/photo.jpg')
  })

  it('falls back to the stored url for an asset with no key', () => {
    const resolved = resolveAsset(
      assetValue({ url: 'https://cdn.example.com/photo.jpg', key: undefined }),
      resolution,
    )
    expect(resolved?.src).toBe('https://cdn.example.com/photo.jpg')
  })

  it('passes the focal point through as an object-position', () => {
    const resolved = resolveAsset(
      assetValue({ key: 'a.jpg', focal: { x: 0.3, y: 0.75 } }),
      resolution,
    )
    expect(resolved?.objectPosition).toBe('30% 75%')
  })

  it('defaults object-position to centered when no focal point is set', () => {
    const resolved = resolveAsset(assetValue({ key: 'a.jpg' }), resolution)
    expect(resolved?.objectPosition).toBe('50% 50%')
  })

  it('flags an image asset by content type or filename extension', () => {
    expect(
      resolveAsset(assetValue({ key: 'a.jpg', contentType: 'image/jpeg' }), resolution)?.isImage,
    ).toBe(true)
    expect(
      resolveAsset(
        assetValue({ key: 'a.pdf', contentType: 'application/pdf', filename: 'a.pdf' }),
        resolution,
      )?.isImage,
    ).toBe(false)
  })

  it('returns null for a value with neither a key nor a url', () => {
    expect(
      resolveAsset({ filename: 'x', contentType: '', size: 0, alt: '' }, resolution),
    ).toBeNull()
  })

  describe('srcFor', () => {
    it('builds a query string from the requested transform', () => {
      const resolved = resolveAsset(assetValue({ key: 'a.jpg' }), resolution)!
      expect(
        resolved.srcFor({ width: 800, height: 600, fit: 'cover', format: 'webp', quality: 80 }),
      ).toBe('/folio/asset/a.jpg?w=800&h=600&fit=cover&f=webp&q=80')
    })

    it('rounds fractional transform dimensions', () => {
      const resolved = resolveAsset(assetValue({ key: 'a.jpg' }), resolution)!
      expect(resolved.srcFor({ width: 800.6 })).toBe('/folio/asset/a.jpg?w=801')
    })

    it('adds a focal point only when a resize is also requested', () => {
      const resolved = resolveAsset(
        assetValue({ key: 'a.jpg', focal: { x: 0.5, y: 0.25 } }),
        resolution,
      )!
      expect(resolved.srcFor({ width: 400 })).toBe('/folio/asset/a.jpg?w=400&fp=0.5%2C0.25')
      expect(resolved.srcFor({})).toBe('/folio/asset/a.jpg')
    })

    it('returns the plain src when the transform is empty', () => {
      const resolved = resolveAsset(assetValue({ key: 'a.jpg' }), resolution)!
      expect(resolved.srcFor({})).toBe('/folio/asset/a.jpg')
    })

    it('never transforms an asset Folio does not host', () => {
      const resolved = resolveAsset(
        assetValue({ url: 'https://cdn.example.com/a.jpg', key: undefined }),
        resolution,
      )!
      expect(resolved.srcFor({ width: 400, height: 400 })).toBe('https://cdn.example.com/a.jpg')
    })
  })
})

describe('resolveAssets (multiasset)', () => {
  const resolution: Resolution = { stories: {}, assetBase: '/folio/asset' }

  it('maps each stored asset to its resolved form, in order', () => {
    const resolved = resolveAssets(
      [assetValue({ key: 'a.jpg' }), assetValue({ key: 'b.jpg' })],
      resolution,
    )
    expect(resolved.map((a) => a.src)).toEqual(['/folio/asset/a.jpg', '/folio/asset/b.jpg'])
  })

  it('returns an empty array for an absent value', () => {
    expect(resolveAssets(undefined, resolution)).toEqual([])
  })

  it('drops entries that do not look like an asset instead of throwing', () => {
    const resolved = resolveAssets(
      [assetValue({ key: 'a.jpg' }), { nonsense: true }, null],
      resolution,
    )
    expect(resolved).toHaveLength(1)
  })
})

describe('referencedIds', () => {
  const schema: SchemaIndex = {
    page: { name: 'page', label: 'Page', fields: { hero: reference(), title: text() } },
  }

  const doc: Doc = {
    root: 'root',
    bloks: {
      root: {
        uid: 'root',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { hero: 'sty_a', title: 'Hi' },
      },
      other: {
        uid: 'other',
        type: 'page',
        parent: 'root',
        slot: 'body',
        order: 'a0',
        data: { hero: 'sty_a' },
      },
      unknown: {
        uid: 'unknown',
        type: 'not-in-schema',
        parent: 'root',
        slot: 'body',
        order: 'a1',
        data: { hero: 'sty_b' },
      },
    },
  }

  it('collects the deduplicated set of story ids reference fields point at, across every blok', () => {
    expect(referencedIds(doc, schema)).toEqual(['sty_a'])
  })

  it('ignores fields on a block type absent from the schema', () => {
    expect(referencedIds(doc, schema)).not.toContain('sty_b')
  })

  it('ignores an empty reference value', () => {
    const empty: Doc = {
      root: 'root',
      bloks: {
        root: {
          uid: 'root',
          type: 'page',
          parent: null,
          slot: null,
          order: 'a0',
          data: { hero: '', title: 'Hi' },
        },
      },
    }
    expect(referencedIds(empty, schema)).toEqual([])
  })
})

describe('resolveReference (one level deep)', () => {
  const target = story({ id: 'sty_about', path: 'about', title: 'About' })
  const targetDoc: Doc = {
    root: 'about-root',
    bloks: {
      'about-root': {
        uid: 'about-root',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'About us' },
      },
    },
  }
  const resolution: Resolution = {
    ...buildResolution([target]),
    docs: { sty_about: targetDoc },
  }

  it('resolves a reference to its story metadata and root block data', () => {
    const resolved = resolveReference('sty_about', resolution)
    expect(resolved).toEqual({
      id: 'sty_about',
      title: 'About',
      path: 'about',
      url: '/about',
      data: { title: 'About us' },
      doc: targetDoc,
    })
  })

  it('returns null when nothing is set', () => {
    expect(resolveReference(undefined, resolution)).toBeNull()
    expect(resolveReference('', resolution)).toBeNull()
  })

  it('returns null when the referenced story no longer exists', () => {
    expect(resolveReference('sty_gone', resolution)).toBeNull()
  })

  it('returns null when the story exists but its document was never loaded, which is what bounds resolution to one level', () => {
    // This is exactly the shape the renderer hands down when recursing into a
    // reference's own content: `docs` is cleared, so a second-level reference
    // cannot itself resolve and the recursion stops there.
    const oneLevelDown: Resolution = { ...resolution, docs: {} }
    expect(resolveReference('sty_about', oneLevelDown)).toBeNull()
  })
})

describe('resolveValue', () => {
  it('passes a text value through, defaulting to an empty string when absent', () => {
    expect(resolveValue(text(), 'hello', EMPTY_RESOLUTION)).toBe('hello')
    expect(resolveValue(text(), undefined, EMPTY_RESOLUTION)).toBe('')
  })

  it('dispatches a multilink field through resolveLink', () => {
    expect(
      resolveValue(multilink(), { kind: 'url', url: 'https://example.com' }, EMPTY_RESOLUTION),
    ).toEqual({ kind: 'url', href: 'https://example.com' })
    expect(resolveValue(multilink(), undefined, EMPTY_RESOLUTION)).toBeNull()
  })

  it('dispatches an asset field through resolveAsset', () => {
    const resolution: Resolution = { stories: {}, assetBase: '/folio/asset' }
    const resolved = resolveValue(assetField(), assetValue({ key: 'a.jpg' }), resolution) as {
      src: string
    }
    expect(resolved.src).toBe('/folio/asset/a.jpg')
  })

  it('dispatches a multiasset field through resolveAssets', () => {
    const resolution: Resolution = { stories: {}, assetBase: '/folio/asset' }
    const resolved = resolveValue(multiasset(), [assetValue({ key: 'a.jpg' })], resolution)
    expect(Array.isArray(resolved)).toBe(true)
    expect((resolved as { src: string }[])[0]?.src).toBe('/folio/asset/a.jpg')
  })

  // SPEC(valueof-defaults): resolveValue dispatches on every field kind, so an absent
  // number field yields its schema default (0) and an absent boolean field yields false,
  // matching the `ValueOf<Field>` contract in fields.ts.
  it('SPEC(valueof-defaults): resolves absent number/boolean fields to their typed defaults, not ""', () => {
    const resolvedNumber = resolveValue(number(), undefined, EMPTY_RESOLUTION)
    expect(typeof resolvedNumber).toBe('number')
    expect(resolvedNumber).toBe(0)

    const resolvedBoolean = resolveValue(boolean(), undefined, EMPTY_RESOLUTION)
    expect(typeof resolvedBoolean).toBe('boolean')
    expect(resolvedBoolean).toBe(false)
  })
})

describe('known bugs', () => {
  const resolution: Resolution = { stories: {}, assetBase: '/folio/asset' }

  // SPEC(href-scheme): every href resolveLink emits has passed the scheme allow-list, so a
  // stored `javascript:` URL never reaches the DOM.
  it('SPEC(href-scheme): does not resolve a javascript: URL to a clickable href', () => {
    const resolved = resolveLink({ kind: 'url', url: 'javascript:alert(1)' }, resolution)
    // Refused outright: there is no href at all, which is stronger than a neutralised one.
    // Stringified because `.toMatch` cannot be handed the resulting `undefined`.
    expect(resolved).toBeNull()
    expect(String(resolved?.href ?? '')).not.toMatch(/^javascript:/i)
  })

  it('refuses an asset whose only location is an href the allow-list rejects', () => {
    // The same stored string must not be safe through a multilink and executable
    // through an asset field: `src` and `srcFor` come off the same value.
    const unsafe = assetValue({ url: 'javascript:alert(1)', key: undefined })
    expect(resolveAsset(unsafe, resolution)).toBeNull()
    expect(resolveAssets([unsafe], resolution)).toEqual([])
    expect(resolveLink({ kind: 'asset', asset: unsafe }, resolution)).toBeNull()
  })

  // SPEC(asset-url-encoding): an asset key is encoded per path segment, so a space or a `#`
  // in a key produces a valid src URL: nothing is read back as a fragment, and the original
  // key round-trips through decoding.
  it('SPEC(asset-url-encoding): encodes spaces and # in an asset key so the URL is not truncated', () => {
    const key = 'my photos/a #1.jpg'
    const resolved = resolveAsset(assetValue({ key }), resolution)
    const url = new URL(resolved!.src, 'https://example.test')
    expect(url.hash).toBe('')
    expect(decodeURIComponent(url.pathname)).toBe(`/folio/asset/${key}`)
  })
})
