import { describe, expect, it } from 'vitest'
import {
  asset,
  blocks,
  boolean,
  defaultValue,
  multiasset,
  multilink,
  number,
  reference,
  richtext as richtextField,
  select,
  text,
  textarea,
} from '../../../src/core/fields'
import { asRichtext } from '../../../src/core/richtext'
import {
  asAsset,
  asAssets,
  asLink,
  isImageAsset,
  isLinkEmpty,
  LINK_KINDS,
} from '../../../src/core/values'

describe('asLink', () => {
  it('rejects anything that is not a plain object', () => {
    expect(asLink(null)).toBeNull()
    expect(asLink(undefined)).toBeNull()
    expect(asLink('a string')).toBeNull()
    expect(asLink(42)).toBeNull()
    expect(asLink([])).toBeNull()
    expect(asLink({})).toBeNull()
  })

  it('rejects a kind that is not one of the known link kinds', () => {
    expect(asLink({ kind: 'bogus', id: 'x' })).toBeNull()
    expect(asLink({ id: 'x' })).toBeNull()
    expect(asLink({ kind: 42 })).toBeNull()
  })

  it('lists the five known link kinds', () => {
    expect(LINK_KINDS).toEqual(['story', 'url', 'email', 'anchor', 'asset'])
  })

  describe('kind: story', () => {
    it('round-trips the minimal shape', () => {
      expect(asLink({ kind: 'story', id: 'home' })).toEqual({ kind: 'story', id: 'home' })
    })

    it('carries an anchor and a _blank target when present', () => {
      expect(asLink({ kind: 'story', id: 'home', anchor: 'top', target: '_blank' })).toEqual({
        kind: 'story',
        id: 'home',
        anchor: 'top',
        target: '_blank',
      })
    })

    it('drops a non-string anchor and a target that is not exactly _blank', () => {
      expect(asLink({ kind: 'story', id: 'home', anchor: 42, target: 'other' })).toEqual({
        kind: 'story',
        id: 'home',
      })
    })

    it('rejects a missing, empty, or non-string id', () => {
      expect(asLink({ kind: 'story' })).toBeNull()
      expect(asLink({ kind: 'story', id: '' })).toBeNull()
      expect(asLink({ kind: 'story', id: 42 })).toBeNull()
    })
  })

  describe('kind: url', () => {
    it('round-trips the minimal shape', () => {
      expect(asLink({ kind: 'url', url: 'https://example.com' })).toEqual({
        kind: 'url',
        url: 'https://example.com',
      })
    })

    it('carries rel and a _blank target when present', () => {
      expect(
        asLink({ kind: 'url', url: 'https://example.com', rel: 'nofollow', target: '_blank' }),
      ).toEqual({
        kind: 'url',
        url: 'https://example.com',
        rel: 'nofollow',
        target: '_blank',
      })
    })

    it('rejects a missing or empty url', () => {
      expect(asLink({ kind: 'url' })).toBeNull()
      expect(asLink({ kind: 'url', url: '' })).toBeNull()
    })

    it('accepts safe schemes: http(s), mailto, tel, relative, protocol-relative, anchor', () => {
      const urls = [
        'https://example.com/path?x=1',
        'http://example.com',
        'mailto:person@example.com',
        'tel:+61400000000',
        '/relative/path',
        '//cdn.example.com/asset.js',
        '#section-2',
        'page/child',
      ]
      for (const url of urls) {
        expect(asLink({ kind: 'url', url })).toEqual({ kind: 'url', url })
      }
    })

    // SPEC(url-scheme): asLink must reject (or neutralise) javascript:, data:, and
    // vbscript: schemes for kind 'url', since this value is trusted straight into an
    // href. Currently fails: the check is only `typeof v.url === 'string' && v.url`,
    // so any non-empty string is accepted regardless of scheme.
    it.fails('rejects javascript:, data:, and vbscript: schemes', () => {
      expect(asLink({ kind: 'url', url: 'javascript:alert(1)' })).toBeNull()
      expect(asLink({ kind: 'url', url: 'JAVASCRIPT:alert(1)' })).toBeNull()
      expect(asLink({ kind: 'url', url: 'data:text/html,<script>alert(1)</script>' })).toBeNull()
      expect(asLink({ kind: 'url', url: 'vbscript:msgbox(1)' })).toBeNull()
    })
  })

  describe('kind: email', () => {
    it('round-trips the minimal shape', () => {
      expect(asLink({ kind: 'email', email: 'a@b.com' })).toEqual({
        kind: 'email',
        email: 'a@b.com',
      })
    })

    it('carries a subject when present', () => {
      expect(asLink({ kind: 'email', email: 'a@b.com', subject: 'Hello' })).toEqual({
        kind: 'email',
        email: 'a@b.com',
        subject: 'Hello',
      })
    })

    it('drops target even when _blank, since email links do not support it', () => {
      expect(asLink({ kind: 'email', email: 'a@b.com', target: '_blank' })).toEqual({
        kind: 'email',
        email: 'a@b.com',
      })
    })

    it('rejects a missing or empty email', () => {
      expect(asLink({ kind: 'email' })).toBeNull()
      expect(asLink({ kind: 'email', email: '' })).toBeNull()
    })
  })

  describe('kind: anchor', () => {
    it('round-trips the minimal shape', () => {
      expect(asLink({ kind: 'anchor', anchor: 'top' })).toEqual({ kind: 'anchor', anchor: 'top' })
    })

    it('drops target even when _blank, since anchor links do not support it', () => {
      expect(asLink({ kind: 'anchor', anchor: 'top', target: '_blank' })).toEqual({
        kind: 'anchor',
        anchor: 'top',
      })
    })

    it('rejects a missing or empty anchor', () => {
      expect(asLink({ kind: 'anchor' })).toBeNull()
      expect(asLink({ kind: 'anchor', anchor: '' })).toBeNull()
    })
  })

  describe('kind: asset', () => {
    const validAsset = { key: 'library/pic.png', filename: 'pic.png', alt: '' }

    it('round-trips a valid nested asset', () => {
      expect(asLink({ kind: 'asset', asset: validAsset })).toEqual({
        kind: 'asset',
        asset: {
          key: 'library/pic.png',
          filename: 'pic.png',
          contentType: '',
          size: 0,
          alt: '',
        },
      })
    })

    it('carries a _blank target when present', () => {
      expect(asLink({ kind: 'asset', asset: validAsset, target: '_blank' })).toMatchObject({
        target: '_blank',
      })
    })

    it('rejects when the nested asset cannot be read', () => {
      expect(asLink({ kind: 'asset', asset: { filename: 'x.png' } })).toBeNull()
      expect(asLink({ kind: 'asset', asset: null })).toBeNull()
      expect(asLink({ kind: 'asset' })).toBeNull()
    })
  })
})

describe('isLinkEmpty', () => {
  it('mirrors asLink returning null', () => {
    expect(isLinkEmpty(null)).toBe(true)
    expect(isLinkEmpty({ kind: 'anchor', anchor: '' })).toBe(true)
    expect(isLinkEmpty({ kind: 'anchor', anchor: 'top' })).toBe(false)
  })
})

describe('asAsset', () => {
  describe('legacy string form', () => {
    it('turns a bare URL string into an AssetValue', () => {
      expect(asAsset('https://cdn.example.com/folder/photo.png?w=200')).toEqual({
        url: 'https://cdn.example.com/folder/photo.png?w=200',
        filename: 'photo.png',
        contentType: 'image/png',
        size: 0,
        alt: '',
      })
    })

    it('rejects an empty string', () => {
      expect(asAsset('')).toBeNull()
    })

    it('falls back to "image" when the path has no filename segment', () => {
      expect(asAsset('https://example.com/')).toMatchObject({ filename: 'image' })
    })

    it('guesses content type from the extension, blank for unknown extensions', () => {
      expect(asAsset('a.jpg')).toMatchObject({ contentType: 'image/jpeg' })
      expect(asAsset('a.jpeg')).toMatchObject({ contentType: 'image/jpeg' })
      expect(asAsset('a.svg')).toMatchObject({ contentType: 'image/svg+xml' })
      expect(asAsset('a.webp')).toMatchObject({ contentType: 'image/webp' })
      expect(asAsset('a.pdf')).toMatchObject({ contentType: '' })
    })
  })

  describe('junk objects', () => {
    it('rejects null, undefined, numbers, and arrays', () => {
      expect(asAsset(null)).toBeNull()
      expect(asAsset(undefined)).toBeNull()
      expect(asAsset(42)).toBeNull()
      expect(asAsset([])).toBeNull()
    })

    it('rejects an object with neither key nor url, however many other fields it has', () => {
      expect(asAsset({})).toBeNull()
      expect(asAsset({ filename: 'a.png', alt: 'hi', size: 10 })).toBeNull()
    })

    it('rejects an object where key and url are both blank strings', () => {
      expect(asAsset({ key: '', url: '' })).toBeNull()
    })
  })

  describe('requires key||url, and derives partial fields', () => {
    it('accepts key alone and derives filename from it', () => {
      expect(asAsset({ key: 'library/sub/pic.png' })).toEqual({
        key: 'library/sub/pic.png',
        filename: 'pic.png',
        contentType: '',
        size: 0,
        alt: '',
      })
    })

    it('accepts url alone and derives filename from it', () => {
      expect(asAsset({ url: 'https://cdn.example.com/pic.jpg' })).toEqual({
        url: 'https://cdn.example.com/pic.jpg',
        filename: 'pic.jpg',
        contentType: '',
        size: 0,
        alt: '',
      })
    })

    it('carries both key and url when both are present', () => {
      expect(asAsset({ key: 'k.png', url: 'https://cdn.example.com/k.png' })).toMatchObject({
        key: 'k.png',
        url: 'https://cdn.example.com/k.png',
      })
    })

    it('prefers an explicit filename over the derived one', () => {
      expect(asAsset({ key: 'a/b/c.png', filename: 'custom.png' })).toMatchObject({
        filename: 'custom.png',
      })
    })

    it('defaults contentType, size, and alt when absent', () => {
      expect(asAsset({ key: 'x' })).toMatchObject({ contentType: '', size: 0, alt: '' })
    })

    it('only carries width/height when they are numbers', () => {
      expect(asAsset({ key: 'x', width: 100, height: '200' })).toMatchObject({ width: 100 })
      expect(asAsset({ key: 'x', width: 100, height: '200' })).not.toHaveProperty('height')
      expect(asAsset({ key: 'x', width: 100, height: 200 })).toMatchObject({
        width: 100,
        height: 200,
      })
    })
  })

  describe('focal, clamped to [0,1]', () => {
    it('clamps a negative coordinate up to 0', () => {
      expect(asAsset({ key: 'x', focal: { x: -5, y: 0.5 } })).toMatchObject({
        focal: { x: 0, y: 0.5 },
      })
    })

    it('clamps a coordinate above 1 down to 1', () => {
      expect(asAsset({ key: 'x', focal: { x: 0.5, y: 5 } })).toMatchObject({
        focal: { x: 0.5, y: 1 },
      })
    })

    it('passes through in-range coordinates unchanged, including the 0 and 1 edges', () => {
      expect(asAsset({ key: 'x', focal: { x: 0, y: 1 } })).toMatchObject({ focal: { x: 0, y: 1 } })
    })

    it('drops focal entirely when x or y is not a number', () => {
      const withBadFocal = asAsset({ key: 'x', focal: { x: 'a', y: 0.5 } })
      expect(withBadFocal).not.toHaveProperty('focal')
    })

    it('drops focal entirely when it is not an object', () => {
      expect(asAsset({ key: 'x', focal: null })).not.toHaveProperty('focal')
      expect(asAsset({ key: 'x', focal: 'x' })).not.toHaveProperty('focal')
    })
  })
})

describe('asAssets', () => {
  it('maps a multiasset array, dropping anything unreadable', () => {
    expect(asAssets([{ key: 'a' }, {}, { key: 'b' }, null])).toEqual([
      expect.objectContaining({ key: 'a' }),
      expect.objectContaining({ key: 'b' }),
    ])
  })

  it('wraps a single value that is not an array', () => {
    expect(asAssets({ key: 'a' })).toEqual([expect.objectContaining({ key: 'a' })])
  })

  it('returns an empty array for a single unreadable value', () => {
    expect(asAssets({})).toEqual([])
    expect(asAssets(null)).toEqual([])
  })
})

describe('isImageAsset', () => {
  it('is true when contentType starts with image/', () => {
    expect(isImageAsset({ filename: 'doc', contentType: 'image/png', size: 0, alt: '' })).toBe(true)
  })

  it('is true when the filename has an image extension, case-insensitively', () => {
    expect(isImageAsset({ filename: 'photo.PNG', contentType: '', size: 0, alt: '' })).toBe(true)
  })

  it('is false for a non-image contentType and non-image extension', () => {
    expect(
      isImageAsset({ filename: 'report.pdf', contentType: 'application/pdf', size: 0, alt: '' }),
    ).toBe(false)
  })
})

describe('asRichtext', () => {
  it('turns a plain string into a doc with one paragraph per blank-line-separated block', () => {
    expect(asRichtext('Hello world')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    })
  })

  it('splits on blank lines into multiple paragraphs', () => {
    expect(asRichtext('First\n\nSecond')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
      ],
    })
  })

  it('treats an empty or whitespace-only string as no content', () => {
    expect(asRichtext('')).toBeNull()
    expect(asRichtext('   \n\n  ')).toBeNull()
  })

  it('accepts a doc-shaped object with content', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
    expect(asRichtext(doc)).toEqual(doc)
  })

  it('rejects a doc-shaped object with no content, or empty content', () => {
    expect(asRichtext({ type: 'doc' })).toBeNull()
    expect(asRichtext({ type: 'doc', content: [] })).toBeNull()
  })

  it('rejects junk objects, arrays, null, and undefined', () => {
    expect(asRichtext({ type: 'paragraph' })).toBeNull()
    expect(asRichtext([])).toBeNull()
    expect(asRichtext(null)).toBeNull()
    expect(asRichtext(undefined)).toBeNull()
  })
})

describe('defaultValue', () => {
  it('is 0 for number', () => {
    expect(defaultValue(number())).toBe(0)
  })

  it('is false for boolean', () => {
    expect(defaultValue(boolean())).toBe(false)
  })

  it('is the first option value for select', () => {
    expect(defaultValue(select({ options: [{ label: 'A', value: 'a' }] }))).toBe('a')
  })

  it('is an empty string for select with no options', () => {
    expect(defaultValue(select({ options: [] }))).toBe('')
  })

  it('is null for blocks, since children are separate bloks', () => {
    expect(defaultValue(blocks({ allow: ['x'] }))).toBeNull()
  })

  it('is null for multilink, asset, richtext, and reference', () => {
    expect(defaultValue(multilink())).toBeNull()
    expect(defaultValue(asset())).toBeNull()
    expect(defaultValue(richtextField())).toBeNull()
    expect(defaultValue(reference())).toBeNull()
  })

  it('is an empty array for multiasset', () => {
    expect(defaultValue(multiasset())).toEqual([])
  })

  it('is an empty string for text and textarea', () => {
    expect(defaultValue(text())).toBe('')
    expect(defaultValue(textarea())).toBe('')
  })
})
