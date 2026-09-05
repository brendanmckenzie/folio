import { describe, expect, it } from 'vitest'
import { queryKey } from '../../../src/core/query'
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

/**
 * Full-text search (`docs/specs/content-model/full-text-search.md` decision 4).
 * The statement is nested for one reason — the snippet — and the nesting is what
 * makes the bind order load-bearing, so it is pinned here rather than inferred
 * from a passing workers test that would pass just as happily with the binds the
 * other way round.
 */
describe('contentSql: full-text search', () => {
  it('joins the match subquery and ranks by negated bm25, title weighted over body', () => {
    const { page } = sql({ search: 'harbour sunset' })
    expect(page.text).toContain('join content_text ct on ct.id = content_fts.rowid')
    expect(page.text).toContain('where content_fts match ? and ct.locale = ?')
    // Negated so a bigger score is a better match, which is what lets
    // `relevance` sort `desc` like every other "best first" order.
    expect(page.text).toContain('-bm25(content_fts, 10.0, 1.0) as score')
    expect(page.text).toContain('order by fts.score desc, stories.id asc')
  })

  it('never aliases content_fts inside the match subquery', () => {
    // FTS5's hidden `MATCH` column bears the *table* name. Alias it and
    // `content_fts match ?` stops resolving — which is why `content_text` is the
    // one carrying an alias in there.
    const { page, count } = sql({ search: 'sunset' })
    for (const text of [page.text, count.text]) {
      expect(text).not.toMatch(/content_fts\s+(as\s+)?f\b/)
      expect(text).toContain('from content_fts\n')
    }
  })

  it('takes the snippet as a correlated subquery over the paged rows, not inside the match', () => {
    // Inside the match subquery `snippet()` would run for every hit before the
    // sort: a 2,000-hit query reading 2,000 bodies to show twenty. Out here it
    // runs `perPage` times, and `match ? and rowid = ?` is an equality probe.
    const { page } = sql({ search: 'sunset' })
    const snippetAt = page.text.indexOf('snippet(content_fts')
    const subqueryAt = page.text.indexOf('from (select')
    expect(snippetAt).toBeGreaterThan(-1)
    expect(snippetAt).toBeLessThan(subqueryAt)
    expect(page.text).toContain("snippet(content_fts, 1, char(1), char(2), '…', 32)")
    expect(page.text).toContain('content_fts match ? and content_fts.rowid = p.fts_rowid')
  })

  it('binds the outer snippet first, then the join, then the locale, order, where and limit', () => {
    const { page } = sql(
      {
        search: 'harbour sunset',
        type: 'insight',
        where: [{ field: 'topic', op: 'eq', value: 'policy' }],
        order: { field: 'published', dir: 'desc' },
        perPage: 5,
        page: 3,
      },
      'fr',
    )
    // The select-list `?` is textually first, so it binds first — the whole
    // reason the same match string appears twice.
    const fts = '"harbour" "sunset"*'
    expect(page.binds).toEqual([
      fts,
      fts,
      'fr',
      'fr',
      'published',
      'insight',
      'fr',
      'topic',
      'policy',
      5,
      10,
    ])
  })

  it('counts over the same join, without the score or the snippet', () => {
    const { count } = sql({ search: 'sunset', type: 'insight' })
    expect(count.text).toContain('select ct.story_id\n')
    expect(count.text).not.toContain('bm25')
    expect(count.text).not.toContain('snippet')
    expect(count.binds).toEqual(['"sunset"*', '', 'insight'])
  })

  it('tokenises the visitor’s input rather than passing it through', () => {
    // Nothing a search box can hold reaches FTS5 as syntax: punctuation is a
    // separator and a bare keyword becomes a quoted term.
    // The trailing `*` is the type-ahead rule and only applies to a last token
    // of two characters or more, which `y` is not.
    expect(sql({ search: 'NOT "x" -y' }).count.binds[0]).toBe('"NOT" "x" "y"')
    expect(sql({ search: '(sunset' }).count.binds[0]).toBe('"sunset"*')
  })

  it('defaults the order to relevance, and keeps every item scored under another order', () => {
    expect(sql({ search: 'sunset' }).normalised.order).toEqual({
      field: 'relevance',
      dir: 'desc',
    })
    const dated = sql({ search: 'sunset', order: 'publishedAt' })
    expect(dated.page.text).toContain('order by stories.published_at desc, stories.id asc')
    // Still the join, so `fts.score` is still on every row.
    expect(dated.page.text).toContain('as score')
  })

  it('refuses `relevance` without a search, naming it, rather than sorting by something else', () => {
    const err = bad(() => sql({ order: 'relevance' }))
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain('relevance')
    expect(err.message).toContain('search')
  })

  it('counts a search as narrowing, so a bare `contains` is allowed beside it', () => {
    expect(() =>
      sql({ search: 'sunset', where: [{ field: 'topic', op: 'contains', value: 'pol' }] }),
    ).not.toThrow()
  })

  it('compiles a term with no token at all to an empty page, never a 500 and never everything', () => {
    for (const search of ['???', '🙂🙂', '-', '"']) {
      const { page, count } = sql({ search })
      expect(count.text).not.toContain('content_fts')
      expect(page.text).not.toContain('content_fts')
      expect(count.text).toContain('0 = 1')
      expect(page.text).toContain('0 = 1')
      expect(page.text).toContain('order by stories.id asc')
    }
    // `'   '` normalises away entirely, so it is not a search at all.
    expect(sql({ search: '   ' }).normalised.search).toBeUndefined()
    expect(sql({ search: '???' }).normalised.search).toBe('???')
  })
})

/**
 * Decision 11: a search on a gated deployment is scoped to the gate's public
 * value unless the caller filters the field itself.
 *
 * **The predicate keys off `stories.type`.** `projectValue` answers null for an
 * absent value, so a document with no value for an indexed field gets no
 * `content_index` row — which makes a `record` whose root never declares the
 * gate field and a gated `page` that declares it and holds nothing look
 * identical to any test for a missing row. The first must stay searchable and
 * the second must not. Only the type list tells them apart.
 */
describe('contentSql: the gate clause', () => {
  const gate = { field: 'access', public: 'public', types: new Set(['page', 'insight']) }
  const gated = (q: Parameters<typeof contentSql>[0], locale = '') =>
    contentSql(q, new Set([...indexed, 'access']), locale, undefined, gate)

  it('emits nothing at all with no gate: the SQL is byte-identical to the ungated form', () => {
    // A stray `and 1=1` is a silently different query plan, so this is a whole-
    // statement pin rather than a `not.toContain`.
    const { count } = sql({ search: 'sunset' })
    expect(count.text).toBe(`select count(*) as n from stories
             join (select ct.story_id
                      from content_fts
                      join content_text ct on ct.id = content_fts.rowid
                     where content_fts match ? and ct.locale = ?) fts
                 on fts.story_id = stories.id
             where stories.published_doc is not null`)
    expect(sql({ search: 'sunset' }).page.text).not.toContain('content_index cg')
  })

  it('keys off stories.type, never off the absence of an index row', () => {
    const { count } = gated({ search: 'sunset' })
    expect(count.text).toContain('stories.type not in (?, ?)')
    expect(count.text).toContain('exists (select 1 from content_index cg')
    // The reversal this test exists to catch: `not exists` would admit a
    // declaring type holding no value, which spec 31 checkpoint 2 fails closed.
    expect(count.text).not.toContain('not exists')
  })

  it('joins its binds to the where binds last, in clause order, in both statements', () => {
    const { count, page } = gated(
      { search: 'sunset', where: [{ field: 'topic', op: 'eq', value: 'policy' }] },
      'fr',
    )
    const tail = ['fr', 'topic', 'policy', 'page', 'insight', 'fr', 'access', 'public']
    expect(count.binds).toEqual(['"sunset"*', 'fr', ...tail])
    expect(page.binds).toEqual(['"sunset"*', '"sunset"*', 'fr', ...tail, 20, 0])
  })

  it('binds the public value as content_index stores it, not as the host wrote it', () => {
    const boolGate = { field: 'members', public: false, types: new Set(['page']) }
    const { count } = contentSql(
      { search: 'sunset' },
      new Set([...indexed, 'members']),
      '',
      undefined,
      boolGate,
    )
    // `projectValue` writes 'false' into text_value; binding the boolean would
    // compare a boolean to a text column and match nothing on every row.
    expect(count.binds).toEqual(['"sunset"*', '', 'page', '', 'members', 'false'])
  })

  it('is suppressed entirely when the caller filters the gate field itself', () => {
    // How a host builds a members' search over members' content: the caller has
    // taken the scoping on itself, and the same double enforcement `filterable`
    // uses says the caller wins.
    const { count } = gated({
      search: 'sunset',
      where: [{ field: 'access', op: 'in', value: ['public', 'members'] }],
    })
    expect(count.text).not.toContain('content_index cg')
    expect(count.text).not.toContain('stories.type not in')
  })

  it('is never emitted for a query with no search', () => {
    // Spec 31 checkpoint 6 leaves lists alone, twice over. A collection of cards
    // is something a host laid out and can see; a search result is not.
    for (const q of [
      {},
      { type: 'insight' },
      { where: [{ field: 'topic', op: 'eq', value: 'x' }] },
    ]) {
      expect(gated(q as Parameters<typeof contentSql>[0]).count.text).not.toContain('cg')
    }
  })
})

describe('queryKey with a search', () => {
  it('appends the term as the eighth element, so every key written before it still reads the same', () => {
    expect(JSON.parse(queryKey({ type: 'insight' }))).toHaveLength(8)
    expect(JSON.parse(queryKey({ type: 'insight' }))[7]).toBe('')
    expect(JSON.parse(queryKey({ type: 'insight', search: 'harbour' }))[7]).toBe('harbour')
  })

  it('separates two queries that differ only by their search term', () => {
    expect(queryKey({ search: 'harbour' })).not.toBe(queryKey({ search: 'sunset' }))
    // …and joins two spellings of one term, which is what the collapse is for.
    expect(queryKey({ search: '  harbour   sunset ' })).toBe(queryKey({ search: 'harbour sunset' }))
  })
})

describe('queryFromParams with a search', () => {
  const parse = (qs: string) => queryFromParams(new URLSearchParams(qs))

  it('reads `search` off the query string beside everything else', () => {
    expect(parse('type=insight&search=harbour+sunset&order=relevance')).toEqual({
      type: ['insight'],
      search: 'harbour sunset',
      order: 'relevance',
      status: 'published',
    })
  })

  it('accepts `relevance` bare and with a direction', () => {
    expect(parse('search=x&order=relevance').order).toBe('relevance')
    expect(parse('search=x&order=relevance:desc').order).toEqual({
      field: 'relevance',
      dir: 'desc',
    })
  })

  it('refuses nothing a search box can hold', () => {
    // Every one of these is a 200 with a well-formed page. A `MATCH` syntax
    // error would be a 500 with the visitor's own text in the log, and
    // `ftsQuery` is what makes that impossible rather than merely unlikely.
    for (const raw of ['"', '-x', 'foo:bar', 'NOT', '(x', '*', '^', '🙂', 'a'.repeat(10_000)]) {
      const params = new URLSearchParams()
      params.set('search', raw)
      expect(() => queryFromParams(params)).not.toThrow()
    }
  })

  it('truncates an oversized term rather than refusing it', () => {
    const params = new URLSearchParams()
    params.set('search', 'a'.repeat(10_000))
    const { count } = contentSql(queryFromParams(params), indexed, '')
    // 200 characters is one token after `ftsQuery`'s 64-character screen drops
    // it — an empty page, honestly, rather than a 400 a visitor cannot act on.
    expect(count.text).toContain('0 = 1')
  })
})
