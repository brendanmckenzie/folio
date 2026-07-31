import { describe, expect, it } from 'vitest'
import { select, text } from '../../../src/core/fields'
import type { ContentPage } from '../../../src/core/query'
import { queryToParams } from '../../../src/core/query'
import type { SchemaIndex } from '../../../src/core/schema'
import type { StoryNode } from '../../../src/core/story'
import { filterField, filterValue, withFilter } from '../../../src/admin/CollectionInput'
import {
  keysToFetch,
  loadCollections,
  mergeCollections,
  NO_COLLECTIONS,
} from '../../../src/admin/hooks/useCollections'
import { LEVEL_LIMIT, visibleAt } from '../../../src/admin/StoryTree'

/**
 * The admin half of collections (`collections.md` decision 5, phase 3 and 4).
 *
 * The property that matters and is easiest to lose: nothing here may fetch per
 * render. `useCollections` keys off the *set* of queries, so the tests below are of
 * the pure pieces that make that possible — which keys are outstanding, and what a
 * load's outcome folds into.
 */

const schema: SchemaIndex = {
  insightRoot: {
    name: 'insightRoot',
    label: 'Insight',
    fields: {
      topic: select({
        label: 'Topic',
        options: [{ label: 'Policy', value: 'policy' }],
        indexed: true,
      }),
      // Same name, no `indexed`: must not be what the lookup finds.
      subtitle: text({ label: 'Subtitle' }),
    },
  },
  page: { name: 'page', label: 'Page', fields: { topic: text({ label: 'Wrong one' }) } },
}

describe('filterField', () => {
  it('finds the INDEXED declaration of a name, not merely the first one', () => {
    // `page.topic` is declared first in a real object-order sense but is not
    // indexed, so it is not what a filter is about.
    expect(filterField(schema, 'topic')?.label).toBe('Topic')
    expect(filterField(schema, 'subtitle')).toBeUndefined()
    expect(filterField(schema, 'nothing')).toBeUndefined()
  })
})

describe('withFilter / filterValue', () => {
  it('replaces one filter and leaves the rest alone', () => {
    const before = {
      where: [
        { field: 'topic', op: 'eq' as const, value: 'ai' },
        { field: 'featured', op: 'eq' as const, value: 'true' },
      ],
    }
    const after = withFilter(before, 'topic', 'policy')
    expect(after.where).toEqual([
      { field: 'featured', op: 'eq', value: 'true' },
      { field: 'topic', op: 'eq', value: 'policy' },
    ])
  })

  it('removes the filter entirely for "any", rather than storing an empty value', () => {
    const after = withFilter({ where: [{ field: 'topic', op: 'eq', value: 'ai' }] }, 'topic', '')
    expect(after.where).toEqual([])
    expect(filterValue(after, 'topic')).toBe('')
  })

  it('reads back the current choice', () => {
    expect(filterValue({ where: [{ field: 'topic', op: 'eq', value: 'ai' }] }, 'topic')).toBe('ai')
    expect(filterValue({}, 'topic')).toBe('')
  })
})

describe('queryToParams', () => {
  it('spells a query exactly as GET /folio/api/content reads it', () => {
    const params = queryToParams(
      {
        type: 'insight',
        where: [{ field: 'topic', op: 'eq', value: 'policy' }],
        order: { field: 'published', dir: 'desc' },
        perPage: 6,
        page: 2,
      },
      6,
    )
    expect(params.get('type')).toBe('insight')
    expect(params.getAll('where')).toEqual(['topic:eq:policy'])
    expect(params.get('order')).toBe('published:desc')
    expect(params.get('perPage')).toBe('6')
    expect(params.get('page')).toBe('2')
  })

  it('spells an `in` list with commas, and a top-level parent as empty', () => {
    expect(
      queryToParams({ where: [{ field: 't', op: 'in', value: ['a', 'b'] }] }).getAll('where'),
    ).toEqual(['t:in:a,b'])
    expect(queryToParams({ parent: null }).get('parent')).toBe('')
    expect(queryToParams({}).has('parent')).toBe(false)
  })
})

describe('useCollections: the pure pieces', () => {
  it('asks only for keys that are not already settled either way', () => {
    const known = {
      answers: { a: { items: [], total: 0, page: 1, perPage: 6, pages: 0 } },
      failed: new Set(['b']),
    }
    expect(keysToFetch(['a', 'b', 'c'], known)).toEqual(['c'])
  })

  it('remembers a refused query, so the effect cannot retry it forever', async () => {
    const result = await loadCollections(
      '/folio/api',
      [['k', { type: 'insight' }]],
      async () => new Response('{"error":{}}', { status: 400 }),
    )
    expect(result.failed).toEqual(['k'])
    expect(result.answers).toEqual({})
  })

  it('does NOT remember a transport failure, which is no answer about the query', async () => {
    const result = await loadCollections('/folio/api', [['k', { type: 'insight' }]], async () => {
      throw new Error('offline')
    })
    expect(result.failed).toEqual([])
    expect(result.answers).toEqual({})
    // Folding nothing in returns the same object, which is what stops the effect
    // looping on its own state.
    expect(mergeCollections(NO_COLLECTIONS, result)).toBe(NO_COLLECTIONS)
  })

  it('marks every answer stale: the admin reads PUBLISHED content', async () => {
    const page: ContentPage = { items: [], total: 3, page: 1, perPage: 6, pages: 1 }
    const result = await loadCollections(
      '/folio/api',
      [['k', { type: 'insight' }]],
      async () => new Response(JSON.stringify(page), { status: 200 }),
    )
    expect(result.answers.k).toEqual({ ...page, stale: true })
  })

  it('sends the query to the content route, encoded', async () => {
    let seen = ''
    await loadCollections('/folio/api', [['k', { type: 'insight', perPage: 4 }]], async (url) => {
      seen = String(url)
      return new Response('{"items":[],"total":0,"page":1,"perPage":4,"pages":0}')
    })
    expect(seen).toContain('/folio/api/content?')
    expect(seen).toContain('type=insight')
    expect(seen).toContain('perPage=4')
  })
})

/* ------------------------------------------------------ the truncated tree --- */

const node = (id: string, children: StoryNode[] = []): StoryNode =>
  ({ id, children }) as unknown as StoryNode

describe('visibleAt', () => {
  it('draws a short level whole', () => {
    const nodes = Array.from({ length: 4 }, (_, i) => node(`n${i}`))
    expect(visibleAt(nodes, 'n0')).toHaveLength(4)
  })

  it('truncates a long level', () => {
    const nodes = Array.from({ length: 800 }, (_, i) => node(`n${i}`))
    expect(visibleAt(nodes, 'n0')).toHaveLength(LEVEL_LIMIT)
  })

  it('never hides the row that is open', () => {
    const nodes = Array.from({ length: 800 }, (_, i) => node(`n${i}`))
    const shown = visibleAt(nodes, 'n700')
    expect(shown).toHaveLength(701)
    expect(shown[shown.length - 1]!.id).toBe('n700')
  })

  it('never hides an ANCESTOR of the row that is open', () => {
    const nodes = Array.from({ length: 800 }, (_, i) =>
      i === 600 ? node('n600', [node('deep')]) : node(`n${i}`),
    )
    expect(visibleAt(nodes, 'deep').some((n) => n.id === 'n600')).toBe(true)
  })
})
