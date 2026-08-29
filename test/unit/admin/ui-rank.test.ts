import { describe, expect, it } from 'vitest'
import { highlight, matchText, nextIndex, rank } from '../../../src/admin/ui/rank'

/**
 * The command palette's ranking and every list's keyboard arithmetic, tested
 * without a DOM — which is the point of them being pure. The admin's whole unit
 * suite runs under `environment: 'node'` and nothing in it mounts a component;
 * the rebuilt shell keeps that convention, and this file is the proof that a
 * palette and a keyboard-traversable list can live inside it.
 */

describe('matchText', () => {
  it('matches everything with score 0 for an empty query, so a fresh palette shows its whole list', () => {
    expect(matchText('Content', '')).toEqual({ score: 0, spans: [] })
    expect(matchText('Content', '   ')).toEqual({ score: 0, spans: [] })
  })

  it('returns null when the characters are not there at all', () => {
    expect(matchText('Content', 'zq')).toBeNull()
  })

  it('scores a substring above a subsequence', () => {
    const substring = matchText('Redirects', 'red')
    const subsequence = matchText('Restore a deleted page', 'red')
    expect(substring).not.toBeNull()
    expect(subsequence).not.toBeNull()
    expect(substring?.score).toBeGreaterThan(subsequence?.score ?? 0)
  })

  it('scores a word-start substring above one buried mid-word', () => {
    const start = matchText('Site settings', 'set')
    const buried = matchText('Unset', 'set')
    expect(start?.score).toBeGreaterThan(buried?.score ?? 0)
  })

  it('treats a path separator as a word start, because half of what it searches is paths', () => {
    const afterSlash = matchText('/about/team', 'team')
    const midWord = matchText('steamroller', 'team')
    expect(afterSlash?.score).toBeGreaterThan(midWord?.score ?? 0)
  })

  it('matches a subsequence and reports its spans', () => {
    const match = matchText('Content', 'ct')
    expect(match).not.toBeNull()
    expect(match?.spans).toEqual([
      [0, 1],
      [3, 4],
    ])
  })

  it('merges a contiguous run into one span rather than one per character', () => {
    // "ont" is contiguous inside "Content" but not at its start, so this takes
    // the subsequence path and still has to produce a single range.
    const match = matchText('Content', 'ont')
    expect(match?.spans).toEqual([[1, 4]])
  })

  it('prefers a tight match in a short label over a scattered one in a long label', () => {
    const tight = matchText('Assets', 'as')
    const scattered = matchText('A very long screen name with spares', 'as')
    expect(tight?.score).toBeGreaterThan(scattered?.score ?? 0)
  })
})

describe('rank', () => {
  const items = [
    { label: 'Content', keywords: 'pages tree' },
    { label: 'Documents', keywords: 'records data' },
    { label: 'Assets', keywords: 'media images' },
  ]

  it('keeps declaration order for an empty query, so a group order is the author’s', () => {
    expect(rank('', items).map((r) => r.item.label)).toEqual(['Content', 'Documents', 'Assets'])
  })

  it('drops non-matches', () => {
    expect(rank('zzz', items)).toEqual([])
  })

  it('ranks a label match above a keyword match', () => {
    const ranked = rank('media', [
      { label: 'Media library' },
      { label: 'Assets', keywords: 'media' },
    ])
    expect(ranked.map((r) => r.item.label)).toEqual(['Media library', 'Assets'])
  })

  it('finds an item by keyword alone, and reports no spans for it', () => {
    const ranked = rank('records', items)
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.item.label).toBe('Documents')
    // Nothing in "Documents" matched, so highlighting it would be a lie.
    expect(ranked[0]?.match.spans).toEqual([])
  })

  it('is stable across equal scores', () => {
    const same = [{ label: 'aa' }, { label: 'aa' }, { label: 'aa' }]
    const ranked = rank('aa', same)
    expect(ranked).toHaveLength(3)
    expect(ranked.every((r) => r.match.score === ranked[0]?.match.score)).toBe(true)
  })
})

describe('highlight', () => {
  it('splits into alternating runs', () => {
    expect(highlight('Content', [[0, 3]])).toEqual([
      { text: 'Con', hit: true },
      { text: 'tent', hit: false },
    ])
  })

  it('handles a span at the end without emitting an empty tail', () => {
    expect(highlight('Content', [[4, 7]])).toEqual([
      { text: 'Cont', hit: false },
      { text: 'ent', hit: true },
    ])
  })

  it('returns the whole string as one unmatched run when nothing matched', () => {
    expect(highlight('Content', [])).toEqual([{ text: 'Content', hit: false }])
  })
})

describe('nextIndex', () => {
  it('lands on the first row from nothing-active, not the second', () => {
    expect(nextIndex('ArrowDown', -1, 5)).toBe(0)
  })

  it('wraps at both ends', () => {
    expect(nextIndex('ArrowDown', 4, 5)).toBe(0)
    expect(nextIndex('ArrowUp', 0, 5)).toBe(4)
  })

  it('goes to the last row when arrowing up from nothing-active', () => {
    expect(nextIndex('ArrowUp', -1, 5)).toBe(4)
  })

  it('handles Home and End', () => {
    expect(nextIndex('Home', 3, 5)).toBe(0)
    expect(nextIndex('End', 1, 5)).toBe(4)
  })

  it('clamps a page jump rather than wrapping it', () => {
    expect(nextIndex('PageDown', 0, 5)).toBe(4)
    expect(nextIndex('PageUp', 4, 5)).toBe(0)
    expect(nextIndex('PageDown', 0, 50)).toBe(10)
  })

  it('returns null for a key that is not ours, so the event stays unhandled', () => {
    expect(nextIndex('Enter', 0, 5)).toBeNull()
    expect(nextIndex('a', 0, 5)).toBeNull()
  })

  it('returns null for an empty list rather than 0', () => {
    expect(nextIndex('ArrowDown', -1, 0)).toBeNull()
  })
})
