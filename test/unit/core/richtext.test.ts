import { describe, expect, it } from 'vitest'
import {
  asRichtext,
  EMPTY_DOC,
  isRichtextEmpty,
  richtextToText,
  sanitiseRichtext,
  type RichtextDoc,
} from '../../../src/core/richtext'

describe('asRichtext', () => {
  it('splits plain text into paragraphs on blank lines', () => {
    expect(asRichtext('Hello\n\nWorld')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    })
  })

  it('keeps a single newline as literal text within one paragraph', () => {
    expect(asRichtext('Hello\nWorld')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello\nWorld' }] }],
    })
  })

  it('returns null for an empty or whitespace-only string', () => {
    expect(asRichtext('')).toBeNull()
    expect(asRichtext('   ')).toBeNull()
  })

  it('returns null for values that are not a doc', () => {
    expect(asRichtext(null)).toBeNull()
    expect(asRichtext(undefined)).toBeNull()
    expect(asRichtext(42)).toBeNull()
    expect(asRichtext([1, 2, 3])).toBeNull()
    expect(asRichtext({ type: 'paragraph', content: [] })).toBeNull()
  })

  it('returns null for a doc with no content, rather than EMPTY_DOC', () => {
    expect(asRichtext({ type: 'doc' })).toBeNull()
    expect(asRichtext({ type: 'doc', content: [] })).toBeNull()
  })

  it('returns null when content is present but not an array', () => {
    expect(asRichtext({ type: 'doc', content: 'garbage' })).toBeNull()
  })
})

describe('isRichtextEmpty', () => {
  it('treats EMPTY_DOC as empty', () => {
    expect(isRichtextEmpty(EMPTY_DOC)).toBe(true)
  })

  it('treats a null doc as empty', () => {
    expect(isRichtextEmpty(null)).toBe(true)
  })

  it('treats whitespace-only text as empty', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
    }
    expect(isRichtextEmpty(doc)).toBe(true)
  })

  it('treats a horizontalRule-only doc as non-empty even without text', () => {
    const doc = { type: 'doc' as const, content: [{ type: 'horizontalRule' }] }
    expect(isRichtextEmpty(doc)).toBe(false)
  })

  it('treats a doc with real text as non-empty', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    }
    expect(isRichtextEmpty(doc)).toBe(false)
  })
})

describe('richtextToText', () => {
  it('returns an empty string for a doc with no content', () => {
    expect(richtextToText(null)).toBe('')
    expect(richtextToText({ type: 'doc' })).toBe('')
  })

  it('joins sibling block nodes with a single space', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    }
    expect(richtextToText(doc)).toBe('Hello World')
  })

  it('collapses nested block structure to single-spaced words', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }],
            },
          ],
        },
      ],
    }
    expect(richtextToText(doc)).toBe('One Two')
  })

  it('renders a hardBreak as a space', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'hardBreak' },
            { type: 'text', text: 'World' },
          ],
        },
      ],
    }
    expect(richtextToText(doc)).toBe('Hello World')
  })
})

describe('sanitiseRichtext', () => {
  it('returns the same doc reference when no limits are configured', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    }
    expect(sanitiseRichtext(doc, {})).toBe(doc)
  })

  it('returns doc unchanged when doc is null or has no content', () => {
    expect(sanitiseRichtext(null, { nodes: ['paragraph'] })).toBeNull()
    const noContent = { type: 'doc' as const }
    expect(sanitiseRichtext(noContent, { nodes: ['paragraph'] })).toBe(noContent)
  })

  it('unwraps a disallowed block, re-wrapping its inline content in a paragraph', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      ],
    }
    expect(sanitiseRichtext(doc, { nodes: ['paragraph'] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
    })
  })

  it('unwraps a disallowed block with block children by promoting them directly', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }],
        },
      ],
    }
    // The blockquote is dropped and its paragraph child is promoted as-is: it is already a
    // block, so it is not re-wrapped in a second paragraph.
    expect(sanitiseRichtext(doc, { nodes: ['paragraph'] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }],
    })
  })

  it('treats an unknown node type the same as any other disallowed node', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'fooBar', content: [{ type: 'text', text: 'x' }] }],
    }
    expect(sanitiseRichtext(doc, { nodes: ['paragraph'] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    })
  })

  it('a permitted list implies its listItem even when listItem is not listed explicitly', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
      ],
    }
    // paragraph is not permitted either, so it unwraps and its text lands straight in listItem.
    expect(sanitiseRichtext(doc, { nodes: ['bulletList'] })).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    })
  })

  it('snaps a heading level to the nearest permitted level', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'heading',
          attrs: { level: 4, textAlign: 'center' },
          content: [{ type: 'text', text: 'H' }],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { headingLevels: [1, 2, 3, 5] })
    expect(result?.content?.[0]?.attrs).toEqual({ level: 3, textAlign: 'center' })
  })

  it('breaks a level-snap tie toward whichever permitted level is listed first', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }],
    }
    // 1 and 3 are equidistant from 2; headingLevels lists 1 first, so 1 wins the tie.
    const result = sanitiseRichtext(doc, { headingLevels: [1, 3] })
    expect(result?.content?.[0]?.attrs?.level).toBe(1)
  })

  it('leaves an already-permitted heading level untouched', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }],
    }
    const result = sanitiseRichtext(doc, { headingLevels: [1, 2, 3] })
    expect(result?.content?.[0]?.attrs).toEqual({ level: 2 })
  })

  it('strips marks not on the allow-list by type, keeping a surviving mark intact', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { marks: ['link'] })
    expect(result?.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com' } },
    ])
  })

  it('merges adjacent text nodes that end up with equal marks', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A' },
            { type: 'text', text: 'B' },
          ],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { nodes: ['paragraph'] })
    expect(result?.content?.[0]?.content).toEqual([{ type: 'text', text: 'AB' }])
  })

  it('does not merge across a text node carrying different marks', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'kept ', marks: [{ type: 'bold' }, { type: 'strike' }] },
            { type: 'text', text: 'struck', marks: [{ type: 'strike' }] },
            { type: 'text', text: ' text', marks: [{ type: 'bold' }, { type: 'strike' }] },
          ],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { marks: ['bold'] })
    expect(result?.content?.[0]?.content).toEqual([
      { type: 'text', text: 'kept ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'struck' },
      { type: 'text', text: ' text', marks: [{ type: 'bold' }] },
    ])
  })
})

describe('sanitiseRichtext known bugs', () => {
  // SPEC(heading-empty-levels): headingLevels: [] must not leave a heading with an invalid
  // (undefined/NaN) level; the heading should keep a valid numeric level or be unwrapped
  // entirely. Currently fails: `[...levels].sort((a, b) => ...)[0]!` reads index 0 of an
  // empty array, so `nearest` is `undefined` and that is written straight into `attrs.level`.
  it.fails('does not produce an invalid heading level when headingLevels is empty', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hi' }] }],
    }
    const result = sanitiseRichtext(doc, { headingLevels: [] })
    const node = result?.content?.[0]
    if (node?.type === 'heading') {
      expect(typeof node.attrs?.level).toBe('number')
      expect(Number.isFinite(node.attrs?.level)).toBe(true)
    }
    // else: the heading was unwrapped entirely, which also satisfies the spec.
  })

  // SPEC(link-mark-href): a link mark carrying a javascript: URL must not survive sanitisation
  // with that URL intact — it should be dropped or have its href neutralised. Currently fails:
  // marks are filtered by `type` only (`marks.has(m.type)`), so a permitted mark's `attrs`
  // (including `href`) pass through completely unchecked.
  it.fails('does not let a javascript: URL survive in a permitted link mark', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { marks: ['link'] })
    const textNode = result?.content?.[0]?.content?.[0]
    const linkMark = textNode?.marks?.find((m) => m.type === 'link')
    expect(String(linkMark?.attrs?.href ?? '')).not.toMatch(/^javascript:/i)
  })

  // SPEC(sanitise-non-array-content): sanitiseRichtext must not throw when `doc.content` is
  // present but not an array (e.g. corrupted storage or a hand-rolled API call) — it should be
  // treated as a doc with no usable content. Currently fails: `walk` calls `list.flatMap`
  // directly with no `Array.isArray` guard, so a non-array `content` throws a TypeError.
  it.fails('does not throw when doc.content is not an array', () => {
    const doc = { type: 'doc', content: 'not-an-array' } as unknown as RichtextDoc
    expect(() => sanitiseRichtext(doc, { nodes: ['paragraph'] })).not.toThrow()
  })

  // SPEC(sanitise-junk-entries): sanitiseRichtext must not throw when the content array holds
  // non-object entries (null, undefined, primitives) — malformed entries should be skipped
  // rather than crashing the whole document. Currently fails: `walk` destructures
  // `node.content`/`node.type` for every entry with no per-entry guard.
  it.fails('does not throw when the content array holds non-object entries', () => {
    const doc = {
      type: 'doc',
      content: [null, undefined, 42, 'garbage', { type: 'text', text: 'ok' }],
    } as unknown as RichtextDoc
    expect(() => sanitiseRichtext(doc, { nodes: ['paragraph'] })).not.toThrow()
  })
})

describe('richtextToText known bugs', () => {
  // SPEC(text-junk-entries): richtextToText must not throw when the content array holds
  // non-object entries — it should skip them and still return the text that is present.
  // Currently fails: its `walk` reads `node.type` for every entry with no per-entry guard.
  it.fails('does not throw when the content array holds non-object entries', () => {
    const doc = {
      type: 'doc',
      content: [null, { type: 'text', text: 'ok' }],
    } as unknown as RichtextDoc
    expect(() => richtextToText(doc)).not.toThrow()
  })
})
