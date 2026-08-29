import { describe, expect, it } from 'vitest'
import { queryFromParams } from '../../../src/server/routes/content'
import { contentSql } from '../../../src/server/query'
import { FolioError } from '../../../src/server/errors'

/**
 * `ContentQuery` → SQL. Pure, so every operator, every refusal and every clamp is
 * pinned without a database (`test/workers/collections.test.ts` runs the same
 * queries against real D1).
 *
 * The refusals matter more than the happy paths. A filter on a field nobody marked
 * `indexed` has to be a 400 **naming the field** — never a silent empty result,
 * which is the failure mode that costs an afternoon.
 */

const indexed = new Set(['topic', 'published', 'readingTime', 'featured'])
const sql = (q: Parameters<typeof contentSql>[0], locale = '') => contentSql(q, indexed, locale)

const bad = (fn: () => unknown): FolioError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof FolioError) return e
    throw e
  }
  throw new Error('expected a FolioError')
}

describe('contentSql: the predicate', () => {
  it('always requires something published', () => {
    expect(sql({}).count.text).toContain('published_doc is not null')
  })

  it('binds every type name, never interpolating one', () => {
    const { count } = sql({ type: ['insight', 'page'] })
    expect(count.text).toContain('stories.type in (?, ?)')
    expect(count.binds).toEqual(['insight', 'page'])
  })

  it('tells `parent: null` (top level) apart from an absent parent (anywhere)', () => {
    expect(sql({ parent: null }).count.text).toContain('stories.parent_id is null')
    const withParent = sql({ parent: 'sty_insights' })
    expect(withParent.count.text).toContain('stories.parent_id = ?')
    expect(withParent.count.binds).toContain('sty_insights')
    expect(sql({}).count.text).not.toContain('parent_id')
  })
})

describe('contentSql: operators', () => {
  const one = (op: string, value: unknown) =>
    sql({ type: 'insight', where: [{ field: 'topic', op, value } as never] }).count

  it('eq and in read text_value', () => {
    expect(one('eq', 'policy').text).toContain('ci0.text_value = ?')
    expect(one('in', ['a', 'b']).text).toContain('ci0.text_value in (?, ?)')
  })

  it('ne is a NOT EXISTS, so a document with no value matches', () => {
    // "topic is not 'ai'" is true of an insight with no topic at all. An
    // `exists (… <> ?)` would silently exclude every one of them.
    expect(one('ne', 'ai').text).toContain('not exists')
  })

  it('startsWith and contains become LIKE with an explicit escape', () => {
    expect(one('startsWith', 'pol').text).toContain("like ? escape '\\'")
    expect(one('startsWith', 'pol').binds).toContain('pol%')
    expect(one('contains', 'lic').binds).toContain('%lic%')
  })

  it('escapes the LIKE wildcards, so a filter for "50%" is a filter for "50%"', () => {
    expect(one('contains', '50%_x').binds).toContain('%50\\%\\_x%')
  })

  it('a numeric bound compares num_value; a string bound compares text_value', () => {
    const numeric = sql({
      type: 'insight',
      where: [{ field: 'readingTime', op: 'gte', value: 5 }],
    })
    expect(numeric.count.text).toContain('ci0.num_value >= ?')

    const dated = sql({
      type: 'insight',
      where: [{ field: 'published', op: 'gte', value: '2026-01-01' }],
    })
    expect(dated.count.text).toContain('ci0.text_value >= ?')
  })

  it('ands several clauses, each its own indexed subquery', () => {
    const { count } = sql({
      where: [
        { field: 'topic', op: 'eq', value: 'policy' },
        { field: 'featured', op: 'eq', value: 'true' },
      ],
    })
    expect(count.text).toContain('ci0')
    expect(count.text).toContain('ci1')
    expect(count.binds).toEqual(['', 'featured', 'true', '', 'topic', 'policy'])
  })

  it('scopes every subquery to the locale it was asked for', () => {
    const { count } = sql({ where: [{ field: 'topic', op: 'eq', value: 'politique' }] }, 'fr')
    expect(count.binds[0]).toBe('fr')
  })
})

describe('contentSql: refusals', () => {
  it('names the field, and lists the queryable ones, for a where on something unindexed', () => {
    const err = bad(() => sql({ where: [{ field: 'secret', op: 'eq', value: 'x' }] }))
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain("'secret'")
    expect(err.message).toContain('topic')
  })

  it('refuses an unindexed order field too', () => {
    expect(bad(() => sql({ order: { field: 'secret', dir: 'asc' } })).code).toBe('bad_request')
  })

  it('cannot be injected through a field name: it is a bind, and it is checked first', () => {
    const err = bad(() => sql({ where: [{ field: "topic' or 1=1 --", op: 'eq', value: 'x' }] }))
    expect(err.code).toBe('bad_request')
    // And a *legitimate* field name with a hostile value never reaches SQL as SQL.
    const ok = sql({ where: [{ field: 'topic', op: 'eq', value: "x'; drop table stories; --" }] })
    expect(ok.count.text).not.toContain('drop table')
    expect(ok.count.binds).toContain("x'; drop table stories; --")
  })

  it('refuses a bare `contains`, which is a scan of the whole site', () => {
    const err = bad(() => sql({ where: [{ field: 'topic', op: 'contains', value: 'pol' }] }))
    expect(err.message).toContain('scan')
    // Allowed the moment something can narrow first.
    expect(() =>
      sql({ type: 'insight', where: [{ field: 'topic', op: 'contains', value: 'pol' }] }),
    ).not.toThrow()
    expect(() =>
      sql({
        where: [
          { field: 'featured', op: 'eq', value: 'true' },
          { field: 'topic', op: 'contains', value: 'pol' },
        ],
      }),
    ).not.toThrow()
  })
})

describe('contentSql: ordering and paging', () => {
  it('uses a stories column for a built-in sort, with id as the tiebreak', () => {
    const { page } = sql({ order: 'publishedAt' })
    expect(page.text).toContain('order by stories.published_at desc, stories.id asc')
    expect(page.text).not.toContain('left join')
  })

  it('joins the index once for an indexed sort, nulls last in both directions', () => {
    const asc = sql({ order: { field: 'published', dir: 'asc' } })
    expect(asc.page.text).toContain('left join content_index co')
    expect(asc.page.text).toContain('co.num_value asc nulls last')
    expect(asc.page.text).toContain('co.text_value asc nulls last')
    const desc = sql({ order: { field: 'published', dir: 'desc' } })
    expect(desc.page.text).toContain('co.num_value desc nulls last')
  })

  it('puts the join’s binds before the predicate’s, matching the statement’s order', () => {
    const { page } = sql({
      type: 'insight',
      order: { field: 'published', dir: 'desc' },
      perPage: 6,
      page: 2,
    })
    expect(page.binds).toEqual(['', 'published', 'insight', 6, 6])
  })

  it('turns page and perPage into limit and offset', () => {
    expect(sql({ perPage: 6, page: 1 }).page.binds.slice(-2)).toEqual([6, 0])
    expect(sql({ perPage: 6, page: 4 }).page.binds.slice(-2)).toEqual([6, 18])
    // Clamped, not refused: a stale bookmark should not break a page.
    expect(sql({ perPage: 1000, page: 0 }).page.binds.slice(-2)).toEqual([100, 0])
  })

  it('counts without the order join', () => {
    expect(sql({ order: { field: 'published', dir: 'asc' } }).count.text).toBe(
      'select count(*) as n from stories where stories.published_doc is not null',
    )
  })
})

describe('queryFromParams', () => {
  const parse = (qs: string) => queryFromParams(new URLSearchParams(qs))

  it('reads the whole query off a query string', () => {
    expect(
      parse('type=insight&where=topic:eq:policy&order=published:desc&perPage=6&page=2'),
    ).toEqual({
      type: ['insight'],
      where: [{ field: 'topic', op: 'eq', value: 'policy' }],
      order: { field: 'published', dir: 'desc' },
      perPage: 6,
      page: 2,
      status: 'published',
    })
  })

  it('splits only the first two colons, so an ISO timestamp survives', () => {
    expect(parse('where=published:gte:2026-01-01T09:00:00Z').where).toEqual([
      { field: 'published', op: 'gte', value: '2026-01-01T09:00:00Z' },
    ])
  })

  it('reads a numeric range bound as a number', () => {
    expect(parse('where=readingTime:gte:5').where).toEqual([
      { field: 'readingTime', op: 'gte', value: 5 },
    ])
  })

  it('takes an `in` as a comma-separated list', () => {
    expect(parse('where=topic:in:policy,ai').where).toEqual([
      { field: 'topic', op: 'in', value: ['policy', 'ai'] },
    ])
  })

  it('accepts several types, comma-separated or repeated', () => {
    expect(parse('type=insight,page').type).toEqual(['insight', 'page'])
    expect(parse('type=insight&type=page').type).toEqual(['insight', 'page'])
  })

  it('tells an empty parent (top level) apart from an absent one (anywhere)', () => {
    expect(parse('parent=').parent).toBeNull()
    expect(parse('parent=sty_x').parent).toBe('sty_x')
    expect('parent' in parse('type=insight')).toBe(false)
  })

  it('accepts a bare built-in order', () => {
    expect(parse('order=publishedAt').order).toBe('publishedAt')
  })

  it('refuses a malformed where, op, order or page rather than guessing', () => {
    expect(bad(() => parse('where=topic')).code).toBe('bad_request')
    expect(bad(() => parse('where=topic:sideways:x')).message).toContain('where op')
    expect(bad(() => parse('order=published:sideways')).message).toContain('direction')
    expect(bad(() => parse('page=0')).code).toBe('bad_request')
    expect(bad(() => parse('perPage=abc')).code).toBe('bad_request')
  })

  it('bounds how many filters one request may carry', () => {
    const many = Array.from({ length: 9 }, (_, i) => `where=topic:eq:v${i}`).join('&')
    expect(bad(() => parse(many)).message).toContain('at most')
  })

  it('screens a type name before it becomes a bind', () => {
    expect(bad(() => parse("type=insight';drop--")).code).toBe('bad_request')
  })
})
