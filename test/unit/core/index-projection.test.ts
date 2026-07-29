import { describe, expect, it } from 'vitest'
import type { Blok, Doc } from '../../../src/core/doc'
import { boolean, number, richtext, select, text, textarea } from '../../../src/core/fields'
import {
  indexRowsFor,
  indexedFieldNames,
  indexedFields,
  isIndexed,
  projectValue,
} from '../../../src/core/index-projection'
import type { LocaleConfig } from '../../../src/core/locales'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'

/**
 * The publish-time projection (`collections.md` architecture decision 1). Pure, so
 * every rule about what gets indexed is pinned here without a database — which is
 * also what lets `POST /folio/reindex` rebuild rows by running this rather than by
 * restating the rules in SQL.
 */

const insightRoot = {
  name: 'insightRoot',
  label: 'Insight',
  fields: {
    title: text({ indexed: true, translatable: true }),
    topic: select({ options: [{ label: 'Policy', value: 'policy' }], indexed: true }),
    published: text({ indexed: true }),
    readingTime: number({ indexed: true }),
    featured: boolean({ indexed: true }),
    standfirst: textarea({ translatable: true }),
    body: richtext(),
  },
}

const nested = {
  name: 'pullquote',
  label: 'Pullquote',
  fields: { credit: text({ indexed: true }) },
}

const schema: SchemaIndex = { insightRoot, pullquote: nested }

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

function doc(data: Record<string, unknown>, i18n?: Blok['i18n']): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: {
        uid: 'r0',
        type: 'insightRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data: data as Blok['data'],
        ...(i18n ? { i18n } : {}),
      },
      // A nested blok with an `indexed` field, which must be ignored: the index is
      // a fixed projection, so a block insert must not change the row set.
      k1: {
        uid: 'k1',
        type: 'pullquote',
        parent: 'r0',
        slot: 'body',
        order: 'a0',
        data: { credit: 'Someone' },
      },
    },
  }
}

const rowFor = (rows: ReturnType<typeof indexRowsFor>, locale: string, field: string) =>
  rows.find((r) => r.locale === locale && r.field === field)

describe('projectValue', () => {
  it('fills text for every scalar and num only where a number is meant', () => {
    expect(projectValue('policy')).toEqual({ text: 'policy', num: null })
    expect(projectValue(7)).toEqual({ text: '7', num: 7 })
    expect(projectValue(true)).toEqual({ text: 'true', num: 1 })
    expect(projectValue(false)).toEqual({ text: 'false', num: 0 })
  })

  it('stores an ISO date in BOTH columns, so it sorts as text and ranges as a number', () => {
    const row = projectValue('2026-03-14')
    expect(row?.text).toBe('2026-03-14')
    expect(row?.num).toBe(Date.parse('2026-03-14'))

    const stamped = projectValue('2026-03-14T09:30:00Z')
    expect(stamped?.num).toBe(Date.parse('2026-03-14T09:30:00Z'))
  })

  it('does not coerce a string that merely starts with digits', () => {
    expect(projectValue('2 minutes')).toEqual({ text: '2 minutes', num: null })
    // Deliberately narrow: a generic Number() would make a slug of '2' numeric and
    // sort a handful of rows ahead of everything else for no findable reason.
    expect(projectValue('2')).toEqual({ text: '2', num: null })
  })

  it('has nothing to index for an absent, empty, or non-scalar value', () => {
    expect(projectValue(undefined)).toBeNull()
    expect(projectValue(null)).toBeNull()
    expect(projectValue('')).toBeNull()
    expect(projectValue({ key: 'a.png' } as never)).toBeNull()
    expect(projectValue([] as never)).toBeNull()
    expect(projectValue(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('isIndexed / indexedFields', () => {
  it('is true only for the five scalar kinds carrying the flag', () => {
    expect(isIndexed(text({ indexed: true }))).toBe(true)
    expect(isIndexed(number({ indexed: true }))).toBe(true)
    expect(isIndexed(text())).toBe(false)
    // `richtext({ indexed: true })` does not compile; this is the shape an
    // importer or a hand-written schema can still produce, and it reads as
    // not-indexed rather than throwing. The audit is what reports it.
    expect(isIndexed({ ...richtext(), indexed: true } as never)).toBe(false)
  })

  it('lists a block’s indexed fields in declaration order', () => {
    expect(indexedFields(schema, 'insightRoot').map(([n]) => n)).toEqual([
      'title',
      'topic',
      'published',
      'readingTime',
      'featured',
    ])
    expect(indexedFields(schema, 'nosuchblock')).toEqual([])
  })

  it('collects queryable names from ROOT blocks only', () => {
    const names = indexedFieldNames(schema, [insightType])
    expect([...names].sort()).toEqual(['featured', 'published', 'readingTime', 'title', 'topic'])
    // `pullquote.credit` is marked indexed and is nobody's root block, so it is
    // not queryable — the audit's `indexed-not-root` finding.
    expect(names.has('credit')).toBe(false)
  })
})

describe('indexRowsFor', () => {
  it('projects the root block and nothing else', () => {
    const rows = indexRowsFor(doc({ title: 'Grid policy', topic: 'policy' }), insightType, schema)
    expect(rows.map((r) => r.field).sort()).toEqual(['title', 'topic'])
    expect(rows.every((r) => r.locale === '')).toBe(true)
    // The nested pullquote's `credit` never appears, whatever it holds.
    expect(rows.some((r) => r.field === 'credit')).toBe(false)
  })

  it('writes no row for a field with no value, so eq cannot match it', () => {
    const rows = indexRowsFor(doc({ title: 'Only a title' }), insightType, schema)
    expect(rows.map((r) => r.field)).toEqual(['title'])
  })

  it('is exactly one row per field on a single-locale site', () => {
    const rows = indexRowsFor(doc({ title: 'A', topic: 'policy' }), insightType, schema)
    expect(rows).toHaveLength(2)
  })

  it('writes a row per declared non-source locale, holding what that locale renders', () => {
    const rows = indexRowsFor(
      doc({ title: 'Grid policy', topic: 'policy' }, { fr: { title: 'Politique du réseau' } }),
      insightType,
      schema,
      locales,
    )

    expect(rowFor(rows, '', 'title')?.text).toBe('Grid policy')
    expect(rowFor(rows, 'fr', 'title')?.text).toBe('Politique du réseau')
    // Untranslated, so the French row holds the fallback: filtering a French index
    // page matches what a French visitor actually reads.
    expect(rowFor(rows, 'fr', 'topic')?.text).toBe('policy')
    // `be` falls back to `fr`, which is translated — the chain, not just the source.
    expect(rowFor(rows, 'be', 'title')?.text).toBe('Politique du réseau')
    // The default locale gets no rows of its own: `''` IS the source locale, the
    // same convention `Resolution.locale` uses for it.
    expect(rows.some((r) => r.locale === 'en')).toBe(false)
  })

  it('projects numbers and booleans into num_value', () => {
    const rows = indexRowsFor(
      doc({ title: 'A', readingTime: 6, featured: true }),
      insightType,
      schema,
    )
    expect(rowFor(rows, '', 'readingTime')).toMatchObject({ text: '6', num: 6 })
    expect(rowFor(rows, '', 'featured')).toMatchObject({ text: 'true', num: 1 })
  })

  it('has nothing to say about a document whose root block is missing or unknown', () => {
    expect(indexRowsFor({ root: 'gone', bloks: {} }, insightType, schema)).toEqual([])
    const other = doc({ title: 'A' })
    other.bloks.r0!.type = 'notInSchema'
    expect(indexRowsFor(other, insightType, schema)).toEqual([])
  })
})
