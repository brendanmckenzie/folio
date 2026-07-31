import { describe, expect, it } from 'vitest'
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  paginate,
  windowOf,
} from '../../../src/core/pagination'

/**
 * The cursor codec and the over-fetch arithmetic — the two things eight paged
 * routes would otherwise each hand-roll (`docs/specs/foundation/pagination.md`
 * decision 6). Pure, so this runs in Node with no database.
 */

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a two-part key, which is what every keyset cursor here is', () => {
    expect(decodeCursor(encodeCursor(['a0', 'sty_abc']))).toEqual(['a0', 'sty_abc'])
    expect(decodeCursor(encodeCursor([1735689600000, 'about/team']))).toEqual([
      1735689600000,
      'about/team',
    ])
  })

  it('keeps numbers as numbers, so a bound comparison is numeric not lexicographic', () => {
    // The bug this prevents: '9' > '10' as text. A `created_at` cursor compared as
    // a string pages in the wrong order past the first order of magnitude.
    const [first] = decodeCursor(encodeCursor([9, 'x'])) ?? []
    expect(typeof first).toBe('number')
  })

  it('survives a component containing the old separator', () => {
    // `redirects.ts` packed `${createdAt}_${from}` and split on the first `_`,
    // which worked only because `from_path` never led with a digit-underscore.
    // Nothing about `a_b_c` is special here.
    expect(decodeCursor(encodeCursor(['a_b_c', 'sty_1']))).toEqual(['a_b_c', 'sty_1'])
  })

  it('survives a non-ASCII component, which flat mode’s title sort will produce', () => {
    expect(decodeCursor(encodeCursor(['À propos', 'sty_fr']))).toEqual(['À propos', 'sty_fr'])
    expect(decodeCursor(encodeCursor(['日本語のページ', 'sty_jp']))).toEqual([
      '日本語のページ',
      'sty_jp',
    ])
  })

  it('is URL-safe: no +, / or = to escape in a query string', () => {
    // Every byte value, to force the base64 alphabet's awkward characters.
    const wide = String.fromCharCode(...Array.from({ length: 120 }, (_, i) => i + 130))
    const cursor = encodeCursor([wide, 'z'])
    expect(cursor).not.toMatch(/[+/=]/)
    expect(decodeCursor(cursor)).toEqual([wide, 'z'])
  })

  it('survives a round trip through an actual query string', () => {
    const cursor = encodeCursor(['a0', 'sty_abc'])
    const url = new URL(`https://example.com/folio/api/stories?cursor=${cursor}`)
    expect(decodeCursor(url.searchParams.get('cursor') ?? '')).toEqual(['a0', 'sty_abc'])
  })

  it('rejects anything that is not a cursor, rather than guessing', () => {
    // A route turns null into a 400. Silently restarting from the first page reads
    // as a list that jumped, which is unactionable.
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(btoa('not json'))).toBeNull()
    expect(decodeCursor(btoa('"a string"'))).toBeNull()
    expect(decodeCursor(btoa('{"a":1}'))).toBeNull()
    expect(decodeCursor(btoa('[]'))).toBeNull()
  })

  it('rejects a part that is not a string or a finite number', () => {
    // These go straight into a bound parameter. `null` in a comparison matches
    // nothing rather than erroring, so it has to be refused here.
    expect(decodeCursor(btoa('[null]'))).toBeNull()
    expect(decodeCursor(btoa('[{"a":1}]'))).toBeNull()
    expect(decodeCursor(btoa('[[1,2]]'))).toBeNull()
    expect(decodeCursor(btoa('[true]'))).toBeNull()
    // JSON has no Infinity literal, so this is the shape that reaches us.
    expect(decodeCursor(btoa('[1e999]'))).toBeNull()
  })
})

describe('windowOf', () => {
  const rows = [1, 2, 3, 4, 5]

  it('reports more when the over-fetch came back full, and drops the extra row', () => {
    // A route asks for limit + 1; the extra row is the signal, never shown.
    expect(windowOf(rows, 4)).toEqual({ rows: [1, 2, 3, 4], hasMore: true })
  })

  it('reports no more at exactly the limit', () => {
    expect(windowOf(rows, 5)).toEqual({ rows: [1, 2, 3, 4, 5], hasMore: false })
  })

  it('reports no more below the limit', () => {
    expect(windowOf(rows, 10)).toEqual({ rows: [1, 2, 3, 4, 5], hasMore: false })
  })

  it('handles an empty result', () => {
    expect(windowOf([], 20)).toEqual({ rows: [], hasMore: false })
  })

  it('copies rather than aliasing its input', () => {
    const input = [1, 2]
    const out = windowOf(input, 10)
    out.rows.push(3)
    expect(input).toEqual([1, 2])
  })
})

describe('paginate', () => {
  interface Row {
    ord: string
    id: string
  }
  const rows: Row[] = [
    { ord: 'a0', id: 'one' },
    { ord: 'a1', id: 'two' },
    { ord: 'a2', id: 'three' },
  ]
  const keyOf = (r: Row) => [r.ord, r.id]

  it('cursors on the last row of the page, not the last row fetched', () => {
    // The over-fetched row is the *next* page's first row. Keying on it would skip
    // it entirely — the classic off-by-one in a keyset pager.
    const page = paginate(rows, 2, keyOf)
    expect(page.rows.map((r) => r.id)).toEqual(['one', 'two'])
    expect(decodeCursor(page.cursor ?? '')).toEqual(['a1', 'two'])
  })

  it('has a null cursor on the last page', () => {
    const page = paginate(rows, 3, keyOf)
    expect(page.rows).toHaveLength(3)
    expect(page.cursor).toBeNull()
  })

  it('has a null cursor for an empty page', () => {
    expect(paginate([], 20, keyOf)).toEqual({ rows: [], cursor: null })
  })

  it('carries no total: a count is asked for separately', () => {
    expect(paginate(rows, 2, keyOf).total).toBeUndefined()
    expect('total' in paginate(rows, 2, keyOf)).toBe(false)
  })

  it('walks a whole list exactly once, which is the property that matters', () => {
    // The simulation a real route performs: page, resume after the cursor, repeat.
    const all = Array.from({ length: 17 }, (_, i) => ({
      ord: `a${String(i).padStart(2, '0')}`,
      id: `sty_${i}`,
    }))
    const seen: string[] = []
    let after: readonly (string | number)[] | null = null
    for (let guard = 0; guard < 20; guard++) {
      const remaining = after
        ? all.filter(
            (r) =>
              r.ord > String(after?.[0]) || (r.ord === after?.[0] && r.id > String(after?.[1])),
          )
        : all
      const page = paginate(remaining.slice(0, 6), 5, keyOf)
      seen.push(...page.rows.map((r) => r.id))
      if (!page.cursor) break
      after = decodeCursor(page.cursor)
    }
    expect(seen).toEqual(all.map((r) => r.id))
    expect(new Set(seen).size).toBe(17)
  })
})

describe('clampLimit', () => {
  it('falls back when absent or not a number', () => {
    expect(clampLimit(undefined, 50, 200)).toBe(50)
    expect(clampLimit(Number.NaN, 50, 200)).toBe(50)
  })

  it('clamps to at least one and at most max', () => {
    expect(clampLimit(0, 50, 200)).toBe(1)
    expect(clampLimit(-10, 50, 200)).toBe(1)
    expect(clampLimit(5000, 50, 200)).toBe(200)
    expect(clampLimit(20, 50, 200)).toBe(20)
  })

  it('truncates a fractional limit rather than passing it to SQL', () => {
    expect(clampLimit(20.7, 50, 200)).toBe(20)
  })
})
