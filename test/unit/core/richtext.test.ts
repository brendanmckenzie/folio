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
  it('returns the same doc reference when no limits are configured and nothing to strip', () => {
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

  // A Folio-native link mark stores a structured `link` and no `href`, because
  // the href is derived from the resolution at render time. Judging safety on the
  // `href` string alone stripped every internal link, so prose rendered the text
  // with no anchor around it and a link inside richtext silently stopped working.
  it('keeps a link mark that carries a structured link and no href', () => {
    const link = { kind: 'story', id: 'sty_about' }
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { link } }] }],
        },
      ],
    }
    const result = sanitiseRichtext(doc, { marks: ['link'] })
    expect(result?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'link', attrs: { link } }])
  })

  it('strips a structured link mark whose value is not a usable link', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'link', attrs: { link: { kind: 'url', url: 'javascript:alert(1)' } } }],
            },
          ],
        },
      ],
    }
    // Stripping the only mark drops the `marks` key rather than leaving it empty.
    const result = sanitiseRichtext(doc, { marks: ['link'] })
    expect(result?.content?.[0]?.content?.[0]?.marks).toBeUndefined()
    expect(result?.content?.[0]?.content?.[0]?.text).toBe('x')
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
  // SPEC(heading-empty-levels): headingLevels: [] leaves no representable heading, so the
  // heading is unwrapped (keeping its words) rather than snapped to a level that does not
  // exist. A heading that survives always carries a finite numeric level.
  it('does not produce an invalid heading level when headingLevels is empty', () => {
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hi' }] }],
    }
    const result = sanitiseRichtext(doc, { headingLevels: [] })
    // Asserted as a whole shape, not guarded on `type === 'heading'`: the guard is
    // vacuous once the heading is gone, and the words surviving is half the rule.
    expect(result).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    })
  })

  // SPEC(link-mark-href): a link mark's `attrs.href` goes through the same scheme allow-list
  // as a `multilink`, so a javascript: URL loses the mark however the mark allow-list is set.
  it('does not let a javascript: URL survive in a permitted link mark', () => {
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
    const hrefIn = (result: RichtextDoc) => {
      const marks = result?.content?.[0]?.content?.[0]?.marks
      return String(marks?.find((m) => m.type === 'link')?.attrs?.href ?? '')
    }
    expect(hrefIn(sanitiseRichtext(doc, { marks: ['link'] }))).not.toMatch(/^javascript:/i)
    // However the mark allow-list is set, including not set at all: `richtext()` takes
    // no limits and is the shape the renderer passes, so it cannot be the exempt case.
    expect(hrefIn(sanitiseRichtext(doc, {}))).not.toMatch(/^javascript:/i)
    expect(hrefIn(sanitiseRichtext(doc, { nodes: ['paragraph'] }))).not.toMatch(/^javascript:/i)
  })

  // SPEC(sanitise-non-array-content): a `content` that is present but not an array (corrupted
  // storage, a hand-rolled API call) is treated as a doc with no usable content.
  it('does not throw when doc.content is not an array', () => {
    const doc = { type: 'doc', content: 'not-an-array' } as unknown as RichtextDoc
    expect(() => sanitiseRichtext(doc, { nodes: ['paragraph'] })).not.toThrow()
  })

  // SPEC(sanitise-junk-entries): non-object entries in a content array (null, undefined,
  // primitives) are skipped, so one malformed entry cannot take the document with it.
  it('does not throw when the content array holds non-object entries', () => {
    const doc = {
      type: 'doc',
      content: [null, undefined, 42, 'garbage', { type: 'text', text: 'ok' }],
    } as unknown as RichtextDoc
    expect(() => sanitiseRichtext(doc, { nodes: ['paragraph'] })).not.toThrow()
  })
})

describe('richtextToText known bugs', () => {
  // SPEC(text-junk-entries): richtextToText skips non-object entries in a content array and
  // still returns the text that is present.
  it('does not throw when the content array holds non-object entries', () => {
    const doc = {
      type: 'doc',
      content: [null, { type: 'text', text: 'ok' }],
    } as unknown as RichtextDoc
    expect(() => richtextToText(doc)).not.toThrow()
  })
})
