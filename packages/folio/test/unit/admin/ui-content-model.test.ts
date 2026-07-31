import { describe, expect, it } from 'vitest'
import {
  type ContentUrl,
  contentQuery,
  filterOf,
  filterParams,
  gestureMove,
  isNarrowed,
  type Level,
  type LevelRow,
  type Levels,
  parseContentUrl,
  reportOf,
  ROOT,
  storyRowsOf,
  summarise,
  toggleAllShown,
  toggleSelected,
  type VisibleRow,
  visibleRows,
  withFilter,
  withView,
} from '../../../src/admin/ui/screens/content-model'

/**
 * The Content screen's arithmetic, in Node with nothing mounted — the admin's
 * convention, and the reason this file exists at all rather than the assertions
 * living in a browser test.
 *
 * Four things are pinned harder than the rest, because all four are wrong in ways
 * that look right:
 *
 * - **`⌥↓` is `index + 1`, not `index`.** `orderAt` counts into the sibling list
 *   *excluding* the row being moved, so moving down has to step past where the row
 *   used to be. Off by one here means a downward move that does nothing.
 * - **A `more` row is not a story row.** Keyboard gestures index into the story
 *   rows only, and interleaving the two lists is what makes ↑ ↓ land on a button.
 * - **A filter forces flat mode**, because a tree loaded one level at a time cannot
 *   show a match whose ancestors do not match.
 * - **Defaults leave the URL.** `?view=tree&sort=edited&state=all` and the bare path
 *   are the same screen, and only one of them is a link worth sending.
 */

const row = (id: string, extra: Partial<LevelRow> = {}): LevelRow =>
  ({
    id,
    type: 'page',
    parentId: null,
    slug: id,
    path: id,
    ord: 'a0',
    title: id,
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 1000,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    titleI18n: null,
    state: 'draft',
    hasUnpublishedChanges: false,
    childCount: 0,
    ...extra,
  }) as LevelRow

const level = (rows: LevelRow[], extra: Partial<Level> = {}): Level => ({
  rows,
  cursor: null,
  loading: false,
  ...extra,
})

const NONE = new Set<string>()
const shape = (rows: VisibleRow[]) =>
  rows.map((r) => (r.kind === 'more' ? `more@${r.depth}:${r.parent}` : `${r.depth}:${r.row.id}`))

/* -------------------------------------------------------------- visibleRows --- */

describe('visibleRows', () => {
  const LEVELS: Levels = {
    [ROOT]: level([row('home', { path: '' }), row('about', { childCount: 2 })]),
    about: level([row('team', { parentId: 'about' }), row('history', { parentId: 'about' })]),
  }

  it('draws only the top level while nothing is expanded', () => {
    expect(shape(visibleRows(LEVELS, NONE))).toEqual(['0:home', '0:about'])
  })

  it('nests an expanded level under its parent at the next depth', () => {
    expect(shape(visibleRows(LEVELS, new Set(['about'])))).toEqual([
      '0:home',
      '0:about',
      '1:team',
      '1:history',
    ])
  })

  it('costs nothing for an expanded node whose level has not been asked for', () => {
    // The state between clicking a twisty and the response arriving. It must not be
    // silence: an open twisty over no rows reads as an empty page rather than a slow
    // one, so the level contributes a `more` row marked loading.
    const pending: Levels = { ...LEVELS, about: { rows: [], cursor: null, loading: true } }
    expect(shape(visibleRows(pending, new Set(['about'])))).toEqual([
      '0:home',
      '0:about',
      'more@1:about',
    ])
  })

  it('offers the rest of an incomplete level, inside that level’s indent', () => {
    const partial: Levels = {
      ...LEVELS,
      about: level([row('team', { parentId: 'about' })], { cursor: 'c1' }),
    }
    expect(shape(visibleRows(partial, new Set(['about'])))).toEqual([
      '0:home',
      '0:about',
      '1:team',
      'more@1:about',
    ])
  })

  it('keeps `more` out of the story rows, so a keyboard index never lands on it', () => {
    const partial: Levels = { [ROOT]: level([row('home')], { cursor: 'c1' }) }
    const rows = visibleRows(partial, NONE)
    expect(rows).toHaveLength(2)
    expect(storyRowsOf(rows).map((r) => r.row.id)).toEqual(['home'])
  })

  it('reports each row’s sibling count and index, which is what a reorder needs', () => {
    const rows = storyRowsOf(visibleRows(LEVELS, new Set(['about'])))
    expect(rows.map((r) => `${r.parent}[${r.index}/${r.siblings}]`)).toEqual([
      `${ROOT}[0/2]`,
      `${ROOT}[1/2]`,
      'about[0/2]',
      'about[1/2]',
    ])
  })

  it('marks a row expandable from `childCount`, not from loaded children', () => {
    // The whole point of the column: a closed node has fetched nothing, so the only
    // thing that can say whether it has children is the count that came with it.
    const rows = storyRowsOf(visibleRows(LEVELS, NONE))
    expect(rows.map((r) => r.expandable)).toEqual([false, true])
  })

  it('returns nothing when the top level has not loaded, rather than throwing', () => {
    expect(visibleRows({}, NONE)).toEqual([])
  })
})

/* -------------------------------------------------------------- gestureMove --- */

describe('gestureMove', () => {
  const LEVELS: Levels = {
    [ROOT]: level([row('home', { path: '' }), row('a', { childCount: 1 }), row('b'), row('c')]),
    a: level([row('a1', { parentId: 'a' })]),
  }
  const rows = visibleRows(LEVELS, new Set(['a']))
  const at = (id: string) => {
    const found = storyRowsOf(rows).find((r) => r.row.id === id)
    if (!found) throw new Error(`no row ${id}`)
    return found
  }

  it('moves up to the index before its predecessor', () => {
    expect(gestureMove('up', at('c'), rows, LEVELS)).toEqual({
      move: { id: 'c', parentId: null, index: 2 },
    })
  })

  it('moves down past where it used to be — the off-by-one that matters', () => {
    // `b` is at index 2 of [home, a, b, c]. Excluding `b`, its successor `c` is at
    // index 2, so landing *after* `c` is index 3. Passing `index` would be a no-op.
    expect(gestureMove('down', at('b'), rows, LEVELS)).toEqual({
      move: { id: 'b', parentId: null, index: 3 },
    })
  })

  it('refuses the root, which owns / and cannot be reparented or reslugged', () => {
    expect(gestureMove('down', at('home'), rows, LEVELS)).toEqual({
      refusal: 'The home page owns / and cannot be moved',
    })
    expect(gestureMove('in', at('home'), rows, LEVELS)).toMatchObject({
      refusal: expect.stringContaining('home page'),
    })
  })

  it('refuses to move above the first sibling', () => {
    // `a1` is the only child of `a`, so it is index 0 of its own level. `a` itself
    // is index 1 of the top level and moves up perfectly well — "first" is per
    // level, not per screen, which is the distinction a flat row index would lose.
    expect(gestureMove('up', at('a1'), rows, LEVELS)).toEqual({
      refusal: 'Already first among its siblings',
    })
    expect(gestureMove('up', at('a'), rows, LEVELS)).toEqual({
      move: { id: 'a', parentId: null, index: 0 },
    })
  })

  it('distinguishes the end of a level from the end of the loaded rows', () => {
    expect(gestureMove('down', at('c'), rows, LEVELS)).toEqual({
      refusal: 'Already last among its siblings',
    })
    // With a cursor, "last" is only last of what arrived — and saying so is better
    // than refusing as though it were the end of the list.
    const more: Levels = {
      ...LEVELS,
      [ROOT]: { ...level([...(LEVELS[ROOT]?.rows ?? [])]), cursor: 'c1' },
    }
    const moreRows = visibleRows(more, NONE)
    const last = storyRowsOf(moreRows).at(-1)
    expect(last && gestureMove('down', last, moreRows, more)).toMatchObject({
      refusal: expect.stringContaining('show more'),
    })
  })

  it('nests under the sibling above, at the end of its children', () => {
    // `a`'s level is loaded and complete, so the index is its real length.
    expect(gestureMove('in', at('b'), rows, LEVELS)).toEqual({
      move: { id: 'b', parentId: 'a', index: 1 },
    })
  })

  it('falls back to `childCount` when the new parent’s level is not loaded', () => {
    // `keyAtIndex` clamps an out-of-range index, so a number past the end appends —
    // which is exactly what "nest under" means, and why an unloaded level is not a
    // reason to refuse.
    const unloaded: Levels = { [ROOT]: level([row('p', { childCount: 7 }), row('q')]) }
    const list = visibleRows(unloaded, NONE)
    const q = storyRowsOf(list)[1]
    expect(q && gestureMove('in', q, list, unloaded)).toEqual({
      move: { id: 'q', parentId: 'p', index: 7 },
    })
  })

  it('refuses to nest the first row of a level, which has nothing above it', () => {
    expect(gestureMove('in', at('a1'), rows, LEVELS)).toEqual({
      refusal: 'Nothing above it to nest under',
    })
  })

  it('outdents to just after its own parent', () => {
    // `a1` leaves `a`'s level entirely, so `a`'s sibling list already excludes it —
    // `+ 1` needs no adjustment of the kind up/down do.
    expect(gestureMove('out', at('a1'), rows, LEVELS)).toEqual({
      move: { id: 'a1', parentId: null, index: 2 },
    })
  })

  it('refuses to outdent a top-level row', () => {
    expect(gestureMove('out', at('b'), rows, LEVELS)).toEqual({
      refusal: 'Already at the top level',
    })
  })
})

/* ---------------------------------------------------------------- selection --- */

describe('selection', () => {
  it('toggles one id without touching the rest', () => {
    expect([...toggleSelected(new Set(['a']), 'b')]).toEqual(['a', 'b'])
    expect([...toggleSelected(new Set(['a', 'b']), 'a')]).toEqual(['b'])
  })

  it('select-all-shown adds, then clears once everything shown is in', () => {
    const shown = ['a', 'b']
    const all = toggleAllShown(new Set(['z']), shown)
    expect([...all].sort()).toEqual(['a', 'b', 'z'])
    // Clearing takes out only what is shown: `z` was selected elsewhere and a
    // header checkbox must not reach beyond the rows it sits above.
    expect([...toggleAllShown(all, shown)]).toEqual(['z'])
  })

  it('names the invisible part, because acting on more than you can see is the hazard', () => {
    expect(summarise(new Set(['a', 'b', 'c']), ['a']).text).toBe('3 pages selected · 1 shown here')
    expect(summarise(new Set(['a', 'b']), ['a', 'b']).text).toBe('2 pages selected')
    expect(summarise(new Set(['a']), ['a']).text).toBe('1 page selected')
  })

  it('says so when a selection matches nothing on screen', () => {
    // A bar reading "12 selected" over a list with nothing highlighted reads as
    // broken software. This is the recovery wording.
    expect(summarise(new Set(['a', 'b']), ['x']).text).toBe(
      '2 pages selected, none shown by this filter',
    )
  })

  it('reports N per-item writes as N, never as one atomic result', () => {
    expect(reportOf('publish', 3, [])).toBe('Published 3 pages')
    expect(reportOf('delete', 1, [])).toBe('Deleted 1 page')
    expect(reportOf('publish', 2, [{ title: 'Team', message: 'Refused' }])).toBe(
      'Published 2, 1 refused: Team (Refused)',
    )
  })

  it('names the failures, and stops naming them at two', () => {
    const fails = [
      { title: 'A', message: 'x' },
      { title: 'B', message: 'y' },
      { title: 'C', message: 'z' },
    ]
    expect(reportOf('move', 0, fails)).toBe('Could not move any of them: A (x), B (y), and 1 more')
    expect(reportOf('move', 0, [{ title: '', message: 'x' }])).toBe(
      'Could not move it: Untitled (x)',
    )
  })
})

/* ---------------------------------------------------------------------- URL --- */

describe('the URL', () => {
  const DEFAULTS = { view: 'tree' as const, sort: 'edited' as const }

  it('falls back to the remembered choice when the URL names neither', () => {
    expect(parseContentUrl({}, { view: 'flat', sort: 'title' })).toMatchObject({
      view: 'flat',
      sort: 'title',
    })
  })

  it('lets the URL beat the memory, which is what makes a link a link', () => {
    expect(parseContentUrl({ view: 'tree' }, { view: 'flat', sort: 'path' }).view).toBe('tree')
  })

  it('ignores a value it does not recognise rather than 400ing the screen', () => {
    // A stale bookmark or a hand-edited URL must not be able to break the read that
    // would be assembled from it.
    const url = parseContentUrl({ view: 'grid', sort: 'colour', state: 'wat' }, DEFAULTS)
    expect(url).toMatchObject({ view: 'tree', sort: 'edited', state: 'all' })
  })

  it('round-trips through the query string', () => {
    const url: ContentUrl = { view: 'flat', sort: 'title', state: 'changed', type: 'page', q: 'ab' }
    expect(parseContentUrl(strings(contentQuery(url)), DEFAULTS)).toEqual(url)
  })

  it('leaves every default out of the URL', () => {
    const bare: ContentUrl = { view: 'tree', sort: 'edited', state: 'all', type: undefined, q: '' }
    expect(contentQuery(bare)).toEqual({
      view: undefined,
      sort: undefined,
      state: undefined,
      type: undefined,
      q: undefined,
    })
  })

  it('omits `sort` in tree mode, where order is structure rather than a choice', () => {
    expect(contentQuery({ ...base(), view: 'tree', sort: 'title' }).sort).toBeUndefined()
    expect(contentQuery({ ...base(), view: 'flat', sort: 'title' }).sort).toBe('title')
  })

  it('turns into the `StoryFilter` the route takes, with no `parentId`', () => {
    const filter = filterOf({ ...base(), state: 'live', type: 'insight', q: '  team  ' })
    expect(filter).toEqual({ state: 'live', type: 'insight', q: 'team' })
    expect(filter).not.toHaveProperty('parentId')
    expect(filterParams(filter)).toEqual({ state: 'live', type: 'insight', q: 'team' })
  })

  it('treats `all` as absent rather than a fifth state on the wire', () => {
    expect(filterOf(base())).toEqual({})
    expect(isNarrowed(filterOf(base()))).toBe(false)
  })
})

describe('withFilter and withView', () => {
  it('moves you to flat as soon as a filter narrows anything', () => {
    // The screen's one surprising rule, and it is the route's fault rather than a
    // preference: a tree loaded one level at a time can only show matches whose
    // whole ancestor chain also matches, so a filtered tree silently loses rows.
    expect(withFilter({ ...base(), view: 'tree' }, { state: 'changed' }).view).toBe('flat')
    expect(withFilter({ ...base(), view: 'tree' }, { q: 'team' }).view).toBe('flat')
    expect(withFilter({ ...base(), view: 'tree' }, { type: 'insight' }).view).toBe('flat')
  })

  it('leaves you in the tree when a filter is cleared back to nothing', () => {
    const filtered: ContentUrl = { ...base(), view: 'flat', state: 'live' }
    expect(withFilter(filtered, { state: 'all' }).view).toBe('flat')
    // Still flat: clearing a filter is not a reason to change the view out from
    // under somebody. Only the Tree button does that, and it is explicit.
    expect(withView(withFilter(filtered, { state: 'all' }), 'tree').view).toBe('tree')
  })

  it('clearing to Tree drops the filters, so the toggle cannot bounce back', () => {
    const filtered: ContentUrl = {
      view: 'flat',
      sort: 'title',
      state: 'changed',
      type: 'page',
      q: 'x',
    }
    expect(withView(filtered, 'tree')).toEqual({
      view: 'tree',
      sort: 'title',
      state: 'all',
      type: undefined,
      q: '',
    })
  })

  it('switching to Flat keeps everything, because flat can express every filter', () => {
    const treeish: ContentUrl = { ...base(), view: 'tree', state: 'all' }
    expect(withView(treeish, 'flat')).toEqual({ ...treeish, view: 'flat' })
  })
})

const base = (): ContentUrl => ({
  view: 'tree',
  sort: 'edited',
  state: 'all',
  type: undefined,
  q: '',
})

/** `contentQuery`'s output with the undefineds dropped, as a URL would carry it. */
function strings(query: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) if (value !== undefined) out[key] = value
  return out
}
