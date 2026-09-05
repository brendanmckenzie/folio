import { describe, expect, it } from 'vitest'
import type { Blok, Doc } from '../../../src/core/doc'
import {
  asset,
  blocks,
  boolean,
  collection,
  number,
  richtext,
  select,
  text,
  textarea,
} from '../../../src/core/fields'
import type { LocaleConfig } from '../../../src/core/locales'
import {
  ftsQuery,
  isSearchable,
  MAX_SEARCH_BODY,
  MAX_SEARCH_ROWS,
  MAX_SEARCH_TITLE,
  searchRowsFor,
  splitSnippet,
} from '../../../src/core/search-projection'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'

/**
 * The publish-time projection for full-text search
 * (`full-text-search.md` architecture decisions 3 and 5). Pure, so every rule
 * about what is searchable, how a document is walked, and how a visitor's
 * input becomes `MATCH` syntax is pinned here without a database.
 */

const insightRoot = {
  name: 'insightRoot',
  label: 'Insight',
  fields: {
    title: text({ translatable: true }),
    embed: textarea({ searchable: false }),
    body: richtext(),
    sections: blocks({ allow: ['section'] }),
  },
}

const section = {
  name: 'section',
  label: 'Section',
  fields: {
    heading: text(),
    items: blocks({ allow: ['paragraph'] }),
  },
}

const paragraph = {
  name: 'paragraph',
  label: 'Paragraph',
  fields: {
    text: text(),
  },
}

const schema: SchemaIndex = { insightRoot, section, paragraph }

const insightType: DocumentType = {
  name: 'insight',
  label: 'Insight',
  kind: 'page',
  root: 'insightRoot',
}

const locales: LocaleConfig = {
  default: 'en',
  available: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
    { code: 'be', label: 'Belge', fallback: 'fr' },
  ],
}

function richtextValue(value: string) {
  return {
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
  }
}

function simpleDoc(data: Record<string, unknown>, i18n?: Blok['i18n']): Doc {
  return {
    root: 'root',
    bloks: {
      root: {
        uid: 'root',
        type: 'insightRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data: data as Blok['data'],
        ...(i18n ? { i18n } : {}),
      },
    },
  }
}

function blok(
  uid: string,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
  data: Record<string, unknown>,
): Blok {
  return { uid, type, parent, slot, order, data: data as Blok['data'] }
}

const rowFor = (rows: ReturnType<typeof searchRowsFor>, locale: string) =>
  rows.find((r) => r.locale === locale)

describe('isSearchable', () => {
  it('is true for text, textarea and richtext by default', () => {
    expect(isSearchable(text())).toBe(true)
    expect(isSearchable(textarea())).toBe(true)
    expect(isSearchable(richtext())).toBe(true)
  })

  it('is false when a field opts out with searchable: false', () => {
    expect(isSearchable(text({ searchable: false }))).toBe(false)
    expect(isSearchable(textarea({ searchable: false }))).toBe(false)
    expect(isSearchable(richtext({ searchable: false }))).toBe(false)
  })

  it('is false for every excluded kind, whatever it declares', () => {
    expect(isSearchable(number())).toBe(false)
    expect(isSearchable(boolean())).toBe(false)
    expect(isSearchable(select({ options: [{ label: 'A', value: 'a' }] }))).toBe(false)
    expect(isSearchable(asset())).toBe(false)
    expect(isSearchable(collection())).toBe(false)
  })
})

describe('searchRowsFor: whole-graph walk', () => {
  it('walks root first, then depth-first by slot with siblings sorted, orphans last in map order', () => {
    // Deliberately inserted out of document order (s2 before s1, p1b before
    // p1a, orphan2 before orphan1) so a body that reads in the right order
    // proves the walk sorts rather than following the map's own order — and
    // that it does the opposite for the two orphans, which the walk never
    // reaches from the root and which fall back to map order exactly because
    // there is no sibling relationship to sort them by.
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok('root', 'insightRoot', null, null, 'a0', {
          title: 'RootTitle',
          embed: 'ROOTEMBED-SHOULD-NOT-APPEAR',
          body: richtextValue('RootBodyProse'),
        }),
        s2: blok('s2', 'section', 'root', 'sections', 'b0', { heading: 'SectionTwoHeading' }),
        s1: blok('s1', 'section', 'root', 'sections', 'a0', { heading: 'SectionOneHeading' }),
        p1b: blok('p1b', 'paragraph', 's1', 'items', 'b0', { text: 'ParaOneBText' }),
        p1a: blok('p1a', 'paragraph', 's1', 'items', 'a0', { text: 'ParaOneAText' }),
        orphan2: blok('orphan2', 'paragraph', 'missing-parent', null, 'z0', {
          text: 'OrphanTwoText',
        }),
        orphan1: blok('orphan1', 'paragraph', 'missing-parent', null, 'a0', {
          text: 'OrphanOneText',
        }),
      },
    }

    const rows = searchRowsFor(doc, insightType, schema)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.title).toBe('RootTitle')
    expect(row.body).toBe(
      [
        'RootTitle',
        'RootBodyProse',
        'SectionOneHeading',
        'ParaOneAText',
        'ParaOneBText',
        'SectionTwoHeading',
        'OrphanTwoText',
        'OrphanOneText',
      ].join(' '),
    )
    // `embed` is searchable: false, so its content never appears anywhere.
    expect(row.body).not.toContain('ROOTEMBED')
  })

  it('emits no row for a document with nothing searchable', () => {
    const doc = simpleDoc({ title: '', embed: 'ignored anyway' })
    expect(searchRowsFor(doc, insightType, schema)).toEqual([])
  })

  it('has nothing to say when the root block is missing or unknown', () => {
    expect(searchRowsFor({ root: 'gone', bloks: {} }, insightType, schema)).toEqual([])
    const doc = simpleDoc({ title: 'A' })
    doc.bloks.root!.type = 'notInSchema'
    expect(searchRowsFor(doc, insightType, schema)).toEqual([])
  })
})

describe('searchRowsFor: title and locale', () => {
  it('takes the title from titleOf, agreeing with what fills stories.title', () => {
    const doc = simpleDoc({ title: 'Harbour Sunset', body: richtextValue('Prose.') })
    const rows = searchRowsFor(doc, insightType, schema)
    expect(rows[0]!.title).toBe('Harbour Sunset')
  })

  it('is empty for the root title field when the root declares none', () => {
    const noTitleType: DocumentType = { ...insightType, root: 'paragraph' }
    const doc: Doc = {
      root: 'p0',
      bloks: {
        p0: blok('p0', 'paragraph', null, null, 'a0', { text: 'Body only, no title field.' }),
      },
    }
    const rows = searchRowsFor(doc, noTitleType, schema)
    expect(rows[0]!.title).toBe('')
    expect(rows[0]!.body).toBe('Body only, no title field.')
  })

  it('emits a row per declared non-source locale, holding what that locale renders', () => {
    const doc = simpleDoc(
      { title: 'Grid policy', body: richtextValue('Prose about grids.') },
      { fr: { title: 'Politique du réseau' } },
    )
    const rows = searchRowsFor(doc, insightType, schema, locales)

    expect(rowFor(rows, '')?.title).toBe('Grid policy')
    expect(rowFor(rows, 'fr')?.title).toBe('Politique du réseau')
    // `title` is itself a searchable text field, so its French value rides on
    // the body too (decision 6) — but the untranslated `body` field was never
    // translated, so that half holds the fallback: what a French visitor
    // actually reads for it.
    expect(rowFor(rows, 'fr')?.body).toBe('Politique du réseau Prose about grids.')
    // `be` falls back to `fr`, which IS translated — the chain, not just source.
    expect(rowFor(rows, 'be')?.title).toBe('Politique du réseau')
    // The default locale gets no row of its own: `''` IS the source locale.
    expect(rows.some((r) => r.locale === 'en')).toBe(false)
  })

  it('caps rows at MAX_SEARCH_ROWS how ever many locales are declared', () => {
    const many: LocaleConfig = {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        ...Array.from({ length: 30 }, (_, i) => ({ code: `l${i}`, label: `Locale ${i}` })),
      ],
    }
    const doc = simpleDoc({ title: 'Hello', body: richtextValue('World.') })
    const rows = searchRowsFor(doc, insightType, schema, many)
    expect(rows).toHaveLength(MAX_SEARCH_ROWS)
    // The source row is never bumped out by the cap.
    expect(rows.some((r) => r.locale === '')).toBe(true)
  })
})

describe('searchRowsFor: cleaning', () => {
  it('strips U+0001/U+0002 and other C0 controls without fusing adjacent words', () => {
    const doc = simpleDoc({
      title: 'HelloWorld',
      body: richtextValue('LeftRightSide'),
    })
    const rows = searchRowsFor(doc, insightType, schema)
    expect(rows[0]!.title).toBe('Hello World')
    expect(rows[0]!.body).toContain('Left Right Side')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(rows[0]!.title).not.toMatch(/[\x00-\x1f\x7f]/)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(rows[0]!.body).not.toMatch(/[\x00-\x1f\x7f]/)
  })

  it('collapses runs of whitespace, including newlines between fields, to one space', () => {
    const doc = simpleDoc({ title: 'A   Title', body: richtextValue('Line one\n\nLine two') })
    const rows = searchRowsFor(doc, insightType, schema)
    expect(rows[0]!.title).toBe('A Title')
    expect(rows[0]!.body).toBe('A Title Line one Line two')
  })

  it('truncates the title at MAX_SEARCH_TITLE on a word boundary', () => {
    const long = Array.from({ length: 60 }, () => 'lorem').join(' ') // 359 chars
    const doc = simpleDoc({ title: long })
    const rows = searchRowsFor(doc, insightType, schema)
    const title = rows[0]!.title
    expect(title.length).toBeLessThanOrEqual(MAX_SEARCH_TITLE)
    expect(long.startsWith(title)).toBe(true)
    // Cut on a word boundary: every word here is identical, so a clean cut
    // always ends with a whole "lorem", never a fragment of one.
    expect(title.endsWith('lorem')).toBe(true)
  })

  it('truncates the body at MAX_SEARCH_BODY on a word boundary', () => {
    const long = Array.from({ length: 20_000 }, () => 'prose').join(' ')
    const doc = simpleDoc({ title: 'T', body: richtextValue(long) })
    const rows = searchRowsFor(doc, insightType, schema)
    const body = rows[0]!.body
    expect(body.length).toBeLessThanOrEqual(MAX_SEARCH_BODY)
    expect(body.endsWith('prose')).toBe(true)
  })
})

describe('ftsQuery', () => {
  it('quotes an ordinary single word and stars it (2+ characters)', () => {
    expect(ftsQuery('sunset')).toBe('"sunset"*')
  })

  it('quotes multiple words, starring only the last one', () => {
    expect(ftsQuery('harbour sunset')).toBe('"harbour" "sunset"*')
  })

  it('does not star a final token under two characters', () => {
    expect(ftsQuery('a')).toBe('"a"')
    expect(ftsQuery('sunset a')).toBe('"sunset" "a"')
  })

  it('a bare double quote has nothing to search for', () => {
    expect(ftsQuery('"')).toBeNull()
  })

  it('a leading hyphen is a separator, not a NOT operator', () => {
    expect(ftsQuery('-x')).toBe('"x"')
  })

  it('a colon separates rather than building a column filter', () => {
    expect(ftsQuery('foo:bar')).toBe('"foo" "bar"*')
  })

  it('an FTS5 keyword becomes an ordinary quoted term', () => {
    expect(ftsQuery('NOT')).toBe('"NOT"*')
  })

  it('a keyword beside a real word is still just two quoted terms', () => {
    expect(ftsQuery('a AND')).toBe('"a" "AND"*')
  })

  it('an unbalanced paren is a separator', () => {
    expect(ftsQuery('(unbalanced')).toBe('"unbalanced"*')
  })

  it('punctuation alone leaves nothing to search for', () => {
    expect(ftsQuery('*')).toBeNull()
    expect(ftsQuery('^')).toBeNull()
    expect(ftsQuery('"" ""')).toBeNull()
    expect(ftsQuery('')).toBeNull()
  })

  it('an emoji-only string leaves nothing to search for', () => {
    expect(ftsQuery('😀🎉')).toBeNull()
  })

  it('a huge single run is dropped by the 64-character cap, not crashed on', () => {
    expect(ftsQuery('x'.repeat(10_000))).toBeNull()
  })

  it('keeps a token at exactly 64 characters and drops one at 65', () => {
    const at64 = 'a'.repeat(64)
    const at65 = 'a'.repeat(65)
    expect(ftsQuery(at64)).toBe(`"${at64}"*`)
    expect(ftsQuery(at65)).toBeNull()
  })

  it('keeps at most 12 tokens, in order', () => {
    const words = Array.from({ length: 15 }, (_, i) => `t${i}`)
    const result = ftsQuery(words.join(' '))
    const expected = words
      .slice(0, 12)
      .map((w, i) => (i === 11 ? `"${w}"*` : `"${w}"`))
      .join(' ')
    expect(result).toBe(expected)
  })

  it('an accented letter stays inside its token — the diacritic does not split it', () => {
    expect(ftsQuery('café')).toBe('"café"*')
    expect(ftsQuery('cafe')).toBe('"cafe"*')
  })

  it('joins tokens with spaces (implicit AND), never OR', () => {
    const q = ftsQuery('sunset beach')
    expect(q).toBe('"sunset" "beach"*')
    expect(q).not.toContain(' OR ')
  })
})

describe('splitSnippet', () => {
  it('answers an empty array for null and for an empty string', () => {
    expect(splitSnippet(null)).toEqual([])
    expect(splitSnippet('')).toEqual([])
  })

  it('answers one unmatched part when there is no marker at all', () => {
    expect(splitSnippet('plain text, no match')).toEqual([
      { text: 'plain text, no match', match: false },
    ])
  })

  it('splits one match into three parts', () => {
    const raw = 'the harbour at sunset was quiet'
    expect(splitSnippet(raw)).toEqual([
      { text: 'the harbour at ', match: false },
      { text: 'sunset', match: true },
      { text: ' was quiet', match: false },
    ])
  })

  it('splits several matches, with no empty part at either end', () => {
    const raw = 'harbour and sunset'
    expect(splitSnippet(raw)).toEqual([
      { text: 'harbour', match: true },
      { text: ' and ', match: false },
      { text: 'sunset', match: true },
    ])
  })
})
