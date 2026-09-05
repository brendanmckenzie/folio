import { describe, expect, it } from 'vitest'
import type { ContentItem } from '../../../src/core'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { collection, text } from '../../../src/core/fields'
import {
  asCollectionValue,
  type CollectionField,
  collectionQueries,
  collectionQuery,
  emptyContentPage,
  MAX_PER_PAGE,
  normaliseQuery,
  queryKey,
} from '../../../src/core/query'
import { EMPTY_RESOLUTION, resolveCollection, resolveValue } from '../../../src/core/resolve'
import type { SchemaIndex } from '../../../src/core/schema'

/** The query shape, its canonical form, and the queries a document contains. */

const list = collection({
  type: 'insight',
  filterable: ['topic', 'published'],
  maxPerPage: 12,
  defaultOrder: { field: 'published', dir: 'desc' },
}) as CollectionField

/** A `searchable` collection (`full-text-search.md` decision 10) — everything
 * `list` has, plus the flag that lets a `search` term reach `collectionQuery`. */
const searchableList = collection({
  type: 'insight',
  searchable: true,
  filterable: ['topic'],
  maxPerPage: 12,
  defaultOrder: { field: 'published', dir: 'desc' },
}) as CollectionField

const schema: SchemaIndex = {
  indexPage: { name: 'indexPage', label: 'Index', fields: { title: text(), list } },
  dualIndex: { name: 'dualIndex', label: 'Two lists', fields: { list, other: list } },
  searchPage: {
    name: 'searchPage',
    label: 'Search',
    fields: { title: text(), list: searchableList },
  },
}

/** `ContentItem` (`full-text-search.md` decision 4) has to be reachable by name off
 * the public barrel, not only structurally through `ContentPage` — a host cannot
 * write `items: ContentItem[]` of its own otherwise. */
describe('ContentItem is exported from the public core barrel', () => {
  it('is assignable from an item carrying a snippet and a score', () => {
    const item: ContentItem = {
      id: 'sty_1',
      title: 'Sunset',
      path: 'p',
      url: '/p',
      data: {},
      doc: { root: 'r', bloks: {} },
      score: 4.2,
      snippet: [{ text: 'sun', match: true }],
    }
    expect(item.score).toBe(4.2)
  })
})

function docOf(...bloks: Blok[]): Doc {
  return { root: bloks[0]!.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
}

const blok = (uid: string, data: Record<string, Json>, type = 'indexPage'): Blok => ({
  uid,
  type,
  parent: null,
  slot: null,
  order: 'a0',
  data,
})

describe('normaliseQuery', () => {
  it('clamps page to 1 and below, and perPage to the cap', () => {
    expect(normaliseQuery({ page: 0 }).page).toBe(1)
    expect(normaliseQuery({ page: -4 }).page).toBe(1)
    expect(normaliseQuery({ page: 2.7 }).page).toBe(2)
    expect(normaliseQuery({ perPage: 1000 }).perPage).toBe(MAX_PER_PAGE)
    expect(normaliseQuery({ perPage: 0 }).perPage).toBe(1)
    expect(normaliseQuery({ perPage: 50 }, 12).perPage).toBe(12)
    expect(normaliseQuery({}).perPage).toBe(20)
  })

  it('expands a bare built-in order into its own default direction', () => {
    expect(normaliseQuery({ order: 'publishedAt' }).order).toEqual({
      field: 'publishedAt',
      dir: 'desc',
    })
    expect(normaliseQuery({ order: 'title' }).order).toEqual({ field: 'title', dir: 'asc' })
    expect(normaliseQuery({ order: 'ord' }).order).toEqual({ field: 'ord', dir: 'asc' })
  })

  it('defaults to newest first', () => {
    expect(normaliseQuery({}).order).toEqual({ field: 'publishedAt', dir: 'desc' })
  })

  it('drops a where clause with an operator that does not exist', () => {
    const n = normaliseQuery({
      where: [{ field: 'topic', op: 'sqli' as never, value: 'x' }],
    })
    expect(n.where).toEqual([])
  })
})

describe('queryKey', () => {
  it('is stable across key order in the literal', () => {
    const a = queryKey({ type: 'insight', perPage: 6, page: 2 })
    const b = queryKey({ page: 2, perPage: 6, type: 'insight' })
    expect(a).toBe(b)
  })

  it('is stable across the order of types and of where clauses', () => {
    const a = queryKey({
      type: ['page', 'insight'],
      where: [
        { field: 'topic', op: 'eq', value: 'policy' },
        { field: 'featured', op: 'eq', value: 'true' },
      ],
    })
    const b = queryKey({
      type: ['insight', 'page'],
      where: [
        { field: 'featured', op: 'eq', value: 'true' },
        { field: 'topic', op: 'eq', value: 'policy' },
      ],
    })
    expect(a).toBe(b)
  })

  it('is stable across the order of an `in` list', () => {
    expect(queryKey({ where: [{ field: 't', op: 'in', value: ['b', 'a'] }] })).toBe(
      queryKey({ where: [{ field: 't', op: 'in', value: ['a', 'b'] }] }),
    )
  })

  it('separates queries that differ only by page — which is correct', () => {
    expect(queryKey({ type: 'insight', page: 1 })).not.toBe(queryKey({ type: 'insight', page: 2 }))
  })

  it('does not include the locale a render happens to be in', () => {
    // The locale rides on the Resolution, deliberately outside the query: a French
    // page and an English one share one canonical form, so `resolveCollection`
    // computes the same key whichever language it is rendering.
    expect(queryKey({ type: 'insight' })).toBe(queryKey({ type: 'insight' }))
  })
})

describe('collectionQuery', () => {
  it('drops a filter the field does not declare filterable', () => {
    const q = collectionQuery(list, {
      where: [
        { field: 'topic', op: 'eq', value: 'policy' },
        { field: 'secret', op: 'eq', value: 'x' },
      ],
    } as unknown as Json)
    expect(q.where).toEqual([{ field: 'topic', op: 'eq', value: 'policy' }])
  })

  it('caps the editor’s count at the field’s maxPerPage', () => {
    expect(collectionQuery(list, { perPage: 99 } as unknown as Json).perPage).toBe(12)
    expect(collectionQuery(list, { perPage: 4 } as unknown as Json).perPage).toBe(4)
  })

  it('falls back to defaultOrder when the stored order names something unorderable', () => {
    const q = collectionQuery(list, { order: { field: 'secret', dir: 'asc' } } as unknown as Json)
    expect(q.order).toEqual({ field: 'published', dir: 'desc' })
  })

  it('accepts an order on a filterable field or a built-in', () => {
    expect(
      collectionQuery(list, { order: { field: 'topic', dir: 'asc' } } as unknown as Json).order,
    ).toEqual({ field: 'topic', dir: 'asc' })
    expect(
      collectionQuery(list, { order: { field: 'title', dir: 'asc' } } as unknown as Json).order,
    ).toEqual({ field: 'title', dir: 'asc' })
  })

  it('lets the render’s page win over the editor’s stored one', () => {
    expect(collectionQuery(list, { page: 1 } as unknown as Json, 3).page).toBe(3)
    expect(collectionQuery(list, { page: 2 } as unknown as Json).page).toBe(2)
  })

  it('is total over a value that is not an object at all', () => {
    expect(collectionQuery(list, 'nonsense').where).toEqual([])
    expect(collectionQuery(list, null).perPage).toBe(12)
  })
})

/**
 * `search` on a `collection` field (`full-text-search.md` architecture decision
 * 10): opt-in via `searchable: true`, the render-time term beats the stored one
 * exactly as `page` already does, and `relevance` is only ever orderable when a
 * term can actually reach it.
 */
describe('collectionQuery: search (decision 10)', () => {
  it('drops both the stored and the render-time term without `searchable: true`', () => {
    expect(collectionQuery(list, { search: 'sunset' } as unknown as Json).search).toBeUndefined()
    expect(collectionQuery(list, {}, undefined, 'sunset').search).toBeUndefined()
  })

  it('carries the stored term for a searchable field', () => {
    const q = collectionQuery(searchableList, { search: 'sunset' } as unknown as Json)
    expect(q.search).toBe('sunset')
  })

  it('lets the render’s term win over the editor’s stored one, like page', () => {
    const q = collectionQuery(
      searchableList,
      { search: 'stored' } as unknown as Json,
      undefined,
      'render-time',
    )
    expect(q.search).toBe('render-time')
  })

  it('offers `relevance` as an order only when the field is searchable', () => {
    // Not searchable: `relevance` is not orderable, so a stored choice of it
    // falls back to `defaultOrder` — the pre-existing edge case this spec closes.
    expect(
      collectionQuery(list, { order: { field: 'relevance', dir: 'desc' } } as unknown as Json)
        .order,
    ).toEqual({ field: 'published', dir: 'desc' })

    // Searchable, and a term is present: `relevance` is accepted.
    expect(
      collectionQuery(searchableList, {
        order: { field: 'relevance', dir: 'desc' },
        search: 'sunset',
      } as unknown as Json).order,
    ).toEqual({ field: 'relevance', dir: 'desc' })
  })

  it('drops a stored `relevance` order when no term survives to rank by', () => {
    // Searchable, `relevance` stored, but the search box was since cleared: this
    // must never reach `contentSql` as `order: 'relevance'` with no `search`,
    // which is refused outright (decision 4's `bad_request`).
    const q = collectionQuery(searchableList, {
      order: { field: 'relevance', dir: 'desc' },
    } as unknown as Json)
    expect(q.order).not.toEqual({ field: 'relevance', dir: 'desc' })
    expect(q.search).toBeUndefined()
  })
})

describe('asCollectionValue', () => {
  it('keeps a well-formed where and drops the rest', () => {
    const parsed = asCollectionValue({
      where: [
        { field: 'topic', op: 'eq', value: 'policy' },
        { field: 'x', op: 'gte', value: 4 },
        { field: 'y', op: 'in', value: ['a', 'b'] },
        { field: 'bad', op: 'eq', value: { nested: true } },
        { field: 'worse', op: 'nope', value: 'x' },
        null,
      ],
    } as unknown as Json)
    expect(parsed.where).toEqual([
      { field: 'topic', op: 'eq', value: 'policy' },
      { field: 'x', op: 'gte', value: 4 },
      { field: 'y', op: 'in', value: ['a', 'b'] },
    ])
  })

  it('reads a stored search term, and ignores one that is not a string', () => {
    expect(asCollectionValue({ search: 'harbour' } as unknown as Json).search).toBe('harbour')
    expect(asCollectionValue({ search: 4 } as unknown as Json).search).toBeUndefined()
  })
})

describe('collectionQueries', () => {
  it('costs nothing for a document with no collection field', () => {
    const bare: SchemaIndex = { p: { name: 'p', label: 'P', fields: { title: text() } } }
    const doc: Doc = {
      root: 'r0',
      bloks: {
        r0: { uid: 'r0', type: 'p', parent: null, slot: null, order: 'a0', data: { title: 'x' } },
      },
    }
    expect(collectionQueries(doc, bare).size).toBe(0)
  })

  it('collapses two blocks with identical configuration into one query', () => {
    const doc = docOf(
      blok('r0', { list: { where: [{ field: 'topic', op: 'eq', value: 'policy' }] } }),
      blok('k1', { list: { where: [{ field: 'topic', op: 'eq', value: 'policy' }] } }),
    )
    expect(collectionQueries(doc, schema).size).toBe(1)
  })

  it('keeps two queries apart when the editor narrowed them differently', () => {
    const doc = docOf(
      blok(
        'r0',
        {
          list: { where: [{ field: 'topic', op: 'eq', value: 'policy' }] },
          other: { where: [{ field: 'topic', op: 'eq', value: 'ai' }] },
        },
        'dualIndex',
      ),
    )
    expect(collectionQueries(doc, schema).size).toBe(2)
  })

  it('keeps two apart when they differ only by page', () => {
    const doc = docOf(blok('r0', { list: { page: 1 } }), blok('k1', { list: { page: 2 } }))
    expect(collectionQueries(doc, schema).size).toBe(2)
  })

  it('threads the render’s search term into a searchable field, and ignores it for one that is not', () => {
    // `dualIndex` carries two non-searchable `list`/`other` fields — same schema
    // this describe block already uses — so the render-time term collapsing them
    // to a shared, search-less key proves it never reached either.
    const plain = docOf(blok('r0', { list: {} }, 'indexPage'))
    const [q] = [...collectionQueries(plain, schema, undefined, undefined, 'sunset').values()]
    expect(q?.search).toBeUndefined()

    const searchable = docOf(blok('r0', { list: {} }, 'searchPage'))
    const [searchQ] = [
      ...collectionQueries(searchable, schema, undefined, undefined, 'sunset').values(),
    ]
    expect(searchQ?.search).toBe('sunset')
  })
})

describe('resolveCollection', () => {
  it('hands back an empty page when the resolution ran no queries', () => {
    const answer = resolveCollection(list, {}, EMPTY_RESOLUTION)
    expect(answer).toEqual(emptyContentPage(1, 12))
    // Never null: a block writes `list.items.map(…)` with no guard.
    expect(answer.items).toEqual([])
  })

  it('finds its own answer by key, through resolveValue', () => {
    const value = { where: [{ field: 'topic', op: 'eq', value: 'policy' }] } as unknown as Json
    const key = queryKey(collectionQuery(list, value), 12)
    const page = { items: [], total: 3, page: 1, perPage: 12, pages: 1 }
    const answer = resolveValue(list, value, { ...EMPTY_RESOLUTION, collections: { [key]: page } })
    expect(answer).toEqual(page)
  })

  it('reads the resolution’s page, which is how a host paginates', () => {
    const key = queryKey(collectionQuery(list, {}, 4), 12)
    const page = { items: [], total: 40, page: 4, perPage: 12, pages: 4 }
    const answer = resolveCollection(
      list,
      {},
      {
        ...EMPTY_RESOLUTION,
        page: 4,
        collections: { [key]: page },
      },
    )
    expect(answer.page).toBe(4)
  })

  it('reads the resolution’s search term for a searchable field, exactly as page works', () => {
    const key = queryKey(collectionQuery(searchableList, {}, undefined, 'harbour'), 12)
    const page = {
      items: [{ id: 'sty_1', title: 'Harbour', path: 'p', url: '/p', data: {}, doc: {} as Doc }],
      total: 1,
      page: 1,
      perPage: 12,
      pages: 1,
    }
    const answer = resolveCollection(
      searchableList,
      {},
      {
        ...EMPTY_RESOLUTION,
        search: 'harbour',
        collections: { [key]: page },
      },
    )
    expect(answer.items).toEqual(page.items)
  })

  it('ignores the resolution’s search term for a field that is not searchable', () => {
    // `list` has no `searchable: true`, so `resolution.search` must not change
    // which key it looks up — the answer keyed with no search term at all.
    const key = queryKey(collectionQuery(list, {}), 12)
    const page = { items: [], total: 9, page: 1, perPage: 12, pages: 1 }
    const answer = resolveCollection(
      list,
      {},
      {
        ...EMPTY_RESOLUTION,
        search: 'harbour',
        collections: { [key]: page },
      },
    )
    expect(answer.total).toBe(9)
  })
})
