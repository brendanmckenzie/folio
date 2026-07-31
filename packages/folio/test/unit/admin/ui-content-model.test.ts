import { describe, expect, it } from 'vitest'
import type { BulkReport } from '../../../src/server/bulk'
import {
  actionsFor,
  allShownSelected,
  type BulkAnswer,
  bulkBody,
  type BulkRequest,
  confirmOf,
  type ContentUrl,
  contentQuery,
  filterOf,
  filterParams,
  gestureMove,
  isAll,
  isNarrowed,
  isSelected,
  type Level,
  type LevelRow,
  type Levels,
  matchesFilter,
  parseContentUrl,
  progressOf,
  refusalOf,
  reportOf,
  retryLabel,
  ROOT,
  runBulkJob,
  selectAllLabel,
  selectAllMatching,
  type Selection,
  selectionSize,
  storyRowsOf,
  summarise,
  toggleAllShown,
  toggleSelected,
  urlOfCaptured,
  verbOf,
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

describe('an explicit selection', () => {
  const ids = (selection: Selection) => [...(selection as ReadonlySet<string>)]
  const ticked = (selection: Selection, row: LevelRow) => {
    const outcome = toggleSelected(selection, row)
    if ('refusal' in outcome) throw new Error(outcome.refusal)
    return outcome.selection
  }

  it('toggles one id without touching the rest', () => {
    expect(ids(ticked(new Set(['a']), row('b')))).toEqual(['a', 'b'])
    expect(ids(ticked(new Set(['a', 'b']), row('a')))).toEqual(['b'])
  })

  it('select-all-shown adds, then clears once everything shown is in', () => {
    const shown = [row('a'), row('b')]
    const all = toggleAllShown(new Set(['z']), shown)
    expect(ids(all).sort()).toEqual(['a', 'b', 'z'])
    // Clearing takes out only what is shown: `z` was selected elsewhere and a
    // footer control must not reach beyond the rows it sits under.
    expect(ids(toggleAllShown(all, shown))).toEqual(['z'])
  })

  it('names the invisible part, because acting on more than you can see is the hazard', () => {
    expect(summarise(new Set(['a', 'b', 'c']), [row('a')]).text).toBe(
      '3 pages selected · 1 shown here',
    )
    expect(summarise(new Set(['a', 'b']), [row('a'), row('b')]).text).toBe('2 pages selected')
    expect(summarise(new Set(['a']), [row('a')]).text).toBe('1 page selected')
    expect(summarise(new Set(), []).text).toBe('Nothing selected')
  })

  it('says so when a selection matches nothing on screen', () => {
    // A bar reading "12 selected" over a list with nothing highlighted reads as
    // broken software. This is the recovery wording.
    expect(summarise(new Set(['a', 'b']), [row('x')]).text).toBe(
      '2 pages selected, none shown by this filter',
    )
  })

  it('survives the `[ Tree | Flat ]` toggle, and every filter change under it', () => {
    // The property decision 7a is built around: a selection *captures* rather than
    // tracks. Both views hand `summarise` a different visible set and the count
    // never moves — only the split does.
    const selection = new Set(['home', 'team', 'history'])
    expect(summarise(selection, [row('home'), row('about')]).count).toBe(3)
    expect(summarise(selection, [row('team'), row('history')]).text).toBe(
      '3 pages selected · 2 shown here',
    )
    expect(summarise(selection, []).text).toBe('3 pages selected, none shown by this filter')
  })

  it('offers all five actions, duplicate included', () => {
    expect(actionsFor(new Set(['a']))).toEqual([
      'publish',
      'unpublish',
      'duplicate',
      'move',
      'delete',
    ])
  })

  it('reports N writes as N, never as one atomic result', () => {
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

/* -------------------------------------------------------------- select-all --- */

describe('select-all-matching', () => {
  const DRAFTS = { state: 'draft' as const }
  const drafts = (expected = 51420) => selectAllMatching(DRAFTS, expected)

  it('captures `routed: true`, without which the guard refuses it forever', () => {
    // Flat mode's header counts `path is not null`, so a captured filter missing
    // this axis counts records too — `expected` and the server's count then differ
    // by however many unrouted documents the site has, and no re-confirmation can
    // ever close the gap. A wall, which is the thing decision 7a forbids by name.
    expect(drafts().filter).toEqual({ state: 'draft', routed: true })
  })

  it('is four fields at any size, so 51,420 costs what 12 costs', () => {
    const selection = drafts()
    expect(Object.keys(selection).sort()).toEqual(['all', 'exclude', 'expected', 'filter'])
    expect(selectionSize(selection)).toBe(51420)
  })

  it('states the mode and writes the captured conditions out', () => {
    // Decision 7a's own example, to the character. "51,420 selected" is meaningless
    // without *matching what*.
    const bar = summarise(drafts(), [row('a'), row('b')])
    expect(bar.text).toBe('All 51,420 matching state is draft · 2 shown here')
  })

  it('reads the type chip’s label rather than the wire value', () => {
    const selection = selectAllMatching({ state: 'draft', type: 'insight', q: 'team' }, 12)
    expect(summarise(selection, [], { insight: 'Insight' }).text).toBe(
      'All 12 matching state is draft and type is Insight and search is “team”, none shown by this filter',
    )
  })

  it('says "every page" rather than "matching nothing" for an unfiltered capture', () => {
    expect(summarise(selectAllMatching({}, 8), [row('a')]).text).toBe('All 8 pages · 1 shown here')
  })

  it('ticking a row off means excluding it, and the count comes down', () => {
    const outcome = toggleSelected(drafts(), row('a'))
    if ('refusal' in outcome) throw new Error(outcome.refusal)
    expect(isAll(outcome.selection) && [...outcome.selection.exclude]).toEqual(['a'])
    expect(selectionSize(outcome.selection)).toBe(51419)
    // The subtraction is explained rather than left as a number that does not match
    // the one the person clicked.
    expect(summarise(outcome.selection, [row('a')]).text).toBe(
      'All 51,420 matching state is draft, except the 1 you ticked off, none shown by this filter',
    )
  })

  it('un-ticks an excluded row back into the set', () => {
    const off = toggleSelected(drafts(), row('a'))
    if ('refusal' in off) throw new Error(off.refusal)
    const on = toggleSelected(off.selection, row('a'))
    if ('refusal' in on) throw new Error(on.refusal)
    expect(selectionSize(on.selection)).toBe(51420)
  })

  it('refuses a row outside the captured conditions, with the reason', () => {
    // The case the filter chips make easy: capture every draft, then clear the
    // filter. A live page is *not* in the selection, so its checkbox is empty — and
    // clicking it cannot add it, because the wire has one selection with two shapes
    // and no way to say "every draft, plus this live page".
    const live = row('news', { state: 'live' })
    expect(isSelected(drafts(), live)).toBe(false)
    expect(toggleSelected(drafts(), live)).toMatchObject({
      refusal: expect.stringContaining('not in the selection'),
    })
  })

  it('counts only the rows that match the captured filter as shown', () => {
    const bar = summarise(drafts(20), [row('a'), row('b', { state: 'live' }), row('c')])
    expect(bar.shown).toBe(2)
    expect(bar.text).toBe('All 20 matching state is draft · 2 shown here')
  })

  it('select-all-shown works on exclusions, and ignores rows it cannot reach', () => {
    const shown = [row('a'), row('b'), row('news', { state: 'live' })]
    const off = toggleAllShown(drafts(), shown)
    expect(isAll(off) && [...off.exclude].sort()).toEqual(['a', 'b'])
    expect(allShownSelected(off, shown)).toBe(false)
    const back = toggleAllShown(off, shown)
    expect(isAll(back) && back.exclude.size).toBe(0)
  })

  it('drops duplicate from the actions, because the server refuses it', () => {
    // A duplicate adds documents to the very set it is walking, and excluding what
    // the job created would mean materialising the id list. Structural, so the
    // control is absent rather than disabled.
    expect(actionsFor(drafts())).toEqual(['publish', 'unpublish', 'move', 'delete'])
  })

  it('survives the `[ Tree | Flat ]` toggle, exactly as an explicit one does', () => {
    const selection = drafts(300)
    expect(summarise(selection, []).count).toBe(300)
    expect(summarise(selection, [row('a')]).count).toBe(300)
    expect(summarise(selection, [row('a')]).text).toBe(
      'All 300 matching state is draft · 1 shown here',
    )
  })

  it('shows only what is selected by navigating to the captured conditions', () => {
    const url: ContentUrl = { view: 'tree', sort: 'title', state: 'live', type: 'page', q: 'x' }
    const selection = selectAllMatching({ state: 'draft', q: 'team' }, 4)
    // Flat, always: a narrowed tree drops matches whose ancestors do not match, so a
    // "show me exactly what is selected" landing in the tree would show less than is
    // selected. The visible filter is replaced wholesale rather than merged.
    expect(urlOfCaptured(url, selection)).toEqual({
      view: 'flat',
      sort: 'title',
      state: 'draft',
      type: undefined,
      q: 'team',
    })
  })
})

/* ------------------------------------------------------------ matchesFilter --- */

describe('matchesFilter', () => {
  it('matches state and type exactly', () => {
    expect(matchesFilter(row('a'), { state: 'draft' })).toBe(true)
    expect(matchesFilter(row('a', { state: 'live' }), { state: 'draft' })).toBe(false)
    expect(matchesFilter(row('a'), { type: 'page' })).toBe(true)
    expect(matchesFilter(row('a'), { type: 'insight' })).toBe(false)
  })

  it('matches `q` as a case-insensitive substring of title, slug or path', () => {
    const team = row('team', { title: 'Our Team', slug: 'team', path: 'about/team' })
    expect(matchesFilter(team, { q: 'TEAM' })).toBe(true)
    expect(matchesFilter(team, { q: 'about/' })).toBe(true)
    expect(matchesFilter(team, { q: 'teem' })).toBe(false)
  })

  it('reads `routed` off the path, which is what the whole axis is', () => {
    expect(matchesFilter(row('a'), { routed: true })).toBe(true)
    expect(matchesFilter(row('r', { path: null }), { routed: true })).toBe(false)
    expect(matchesFilter(row('r', { path: null }), { routed: false })).toBe(true)
  })

  it('treats an empty filter as matching everything', () => {
    expect(matchesFilter(row('a', { path: null }), {})).toBe(true)
  })
})

/* ----------------------------------------------------------- confirmations --- */

describe('confirmations', () => {
  it('names the invisible part, which is where the hazard gets said', () => {
    // Decision 7a's own example.
    const bar = summarise(new Set(['a', 'b', 'c']), [row('a')])
    expect(confirmOf('publish', bar)).toMatchObject({
      title: 'Publish 3 pages?',
      body: '2 are not shown by the current filter.',
      danger: false,
    })
  })

  it('does not interrupt an action whose whole selection is on screen', () => {
    // Rejected: confirming all five, always — a modal in front of "publish these two
    // visible pages I just ticked" teaches people to dismiss the one that matters.
    const bar = summarise(new Set(['a', 'b']), [row('a'), row('b')])
    expect(confirmOf('publish', bar)).toBeNull()
    expect(confirmOf('unpublish', bar)).toBeNull()
    // Delete is the exception, because a report cannot undo it.
    expect(confirmOf('delete', bar)).toMatchObject({ title: 'Delete 2 pages?', danger: true })
    expect(confirmOf('delete', bar)?.body).toContain('redirect')
  })

  it('restates the captured conditions for a select-all, however many are on screen', () => {
    const selection = selectAllMatching({ state: 'draft' }, 51420)
    const bar = summarise(selection, [row('a')])
    expect(confirmOf('publish', bar, selection.filter)).toMatchObject({
      title: 'Publish 51,420 pages?',
      body: 'Everything matching state is draft, as it stood when you chose it. 51,419 are not shown by the current filter.',
    })
  })

  it('says "none of them" rather than a number equal to the count', () => {
    const bar = summarise(new Set(['a', 'b']), [row('x')])
    expect(confirmOf('publish', bar)?.body).toBe('None of them are shown by the current filter.')
  })

  it('asks nothing about an empty selection', () => {
    expect(confirmOf('delete', summarise(new Set(), []))).toBeNull()
  })

  it('turns a refusal into a door: the new count, and one button carrying it', () => {
    const refusal = { refused: 'count' as const, expected: 15, actual: 16 }
    expect(refusalOf('publish', refusal)).toMatchObject({
      title: '16 pages match now, not 15',
      danger: false,
    })
    expect(refusalOf('publish', refusal).body).toContain('Publish the 16 that match now?')
    expect(retryLabel('publish', refusal)).toBe('Publish 16 pages')
    expect(verbOf('unpublish')).toBe('Unpublish')
    // One is the case a template with a bare "pages match" gets wrong, and a
    // refusal is the last place to look sloppy: it is asking for a second click.
    expect(refusalOf('delete', { refused: 'count', expected: 4, actual: 1 })).toMatchObject({
      title: '1 page matches now, not 4',
      danger: true,
    })
  })

  it('groups the thousands the way the sentences around them are written', () => {
    expect(selectAllLabel(51420)).toBe('Select all 51,420 matching')
    expect(progressOf(240, 51418)).toBe('Working… 240 of 51,418')
  })
})

/* --------------------------------------------------------------- the writes --- */

describe('the request body', () => {
  it('posts an explicit selection as ids, in the order the set holds them', () => {
    expect(bulkBody(new Set(['c', 'a', 'b']))).toEqual({ selection: { ids: ['c', 'a', 'b'] } })
  })

  it('posts a select-all as the four fields, with `exclude` omitted when empty', () => {
    const selection = selectAllMatching({ state: 'draft' }, 51420)
    expect(bulkBody(selection)).toEqual({
      selection: { all: true, filter: { state: 'draft', routed: true }, expected: 51420 },
    })
    // Omitted rather than `[]`, because both options are `v.strictObject`: every key
    // in this body is one the route reads.
    expect(bulkBody({ ...selection, exclude: new Set(['a']) })).toEqual({
      selection: {
        all: true,
        filter: { state: 'draft', routed: true },
        expected: 51420,
        exclude: ['a'],
      },
    })
  })

  it('gives a move ONE index for the whole set — the reversal this replaces', () => {
    /*
     * The defect, pinned. The per-item client loop sent one `PATCH` per document
     * with `index: 0` on each, so every write pushed the previous one down and a
     * moved set landed **reversed**. `index` belongs to the set: it is where the
     * *first* document lands, and the route adds the job's own position to it.
     *
     * Nothing could catch that while the loop lived in a component, which is why
     * `bulkBody` and `runBulkJob` are here.
     */
    expect(
      bulkBody(new Set(['a', 'b', 'c']), { destination: { parentId: 'about', index: 2 } }),
    ).toEqual({ selection: { ids: ['a', 'b', 'c'] }, parentId: 'about', index: 2 })
    // No index at all is the top of the destination, which is the route's default
    // rather than something the client restates.
    expect(bulkBody(new Set(['a']), { destination: { parentId: null } })).toEqual({
      selection: { ids: ['a'] },
      parentId: null,
    })
  })

  it('carries a cursor only when there is one', () => {
    expect(bulkBody(new Set(['a']), { continueFrom: null })).not.toHaveProperty('continueFrom')
    expect(bulkBody(new Set(['a']), { continueFrom: 'cur' }).continueFrom).toBe('cur')
  })
})

describe('runBulkJob', () => {
  const report = (over: Partial<BulkReport> = {}): BulkReport => ({
    action: 'publish',
    done: 0,
    failed: [],
    total: 0,
    seen: 0,
    continueFrom: null,
    dryRun: false,
    ...over,
  })

  /** A sender that answers a scripted list and records every body it was given. */
  const sender = (answers: BulkAnswer[]) => {
    const sent: BulkRequest[] = []
    return {
      sent,
      send: (body: BulkRequest) => {
        sent.push(body)
        const next = answers.shift()
        if (!next) throw new Error('one call too many')
        return Promise.resolve(next)
      },
    }
  }

  it('is ONE request per batch, not one per document', () => {
    // The whole point of the rewrite: forty ticked rows are one call, and 51,420
    // matching rows are a filter rather than 51,420 ids.
    const s = sender([report({ done: 3, total: 3, seen: 3 })])
    return runBulkJob(s.send, new Set(['a', 'b', 'c'])).then((result) => {
      expect(s.sent).toHaveLength(1)
      expect(result).toEqual({ done: 3, failed: [] })
    })
  })

  it('loops on `continueFrom`, sums `done` and concatenates `failed`', async () => {
    const fail = { id: 'x', title: 'X', message: 'Cannot delete the root story' }
    const s = sender([
      report({ done: 25, total: 60, seen: 25, continueFrom: 'c1' }),
      report({ done: 24, failed: [fail], total: 60, seen: 50, continueFrom: 'c2' }),
      report({ done: 10, total: 60, seen: 60 }),
    ])
    const selection = selectAllMatching({ state: 'draft' }, 60)
    const seen: string[] = []
    const result = await runBulkJob(s.send, selection, {
      onProgress: (at, total) => seen.push(`${at}/${total}`),
    })
    expect(result).toEqual({ done: 59, failed: [fail] })
    // The cursor is threaded back verbatim, and only the first call goes without one.
    expect(s.sent.map((body) => body.continueFrom)).toEqual([undefined, 'c1', 'c2'])
    // Progress is the report's own numbers — the job's, not this call's — so there is
    // no arithmetic here to get wrong.
    expect(seen).toEqual(['25/60', '50/60', '60/60'])
  })

  it('loops on the cursor rather than on `seen < total`, which would spin', async () => {
    // A batch whose documents were all refused still advances the cursor. `total`
    // never falls for a move, either — the filter still matches every document
    // afterwards.
    const s = sender([
      report({
        done: 0,
        failed: [{ id: 'a', title: 'A', message: 'no' }],
        total: 2,
        seen: 1,
        continueFrom: 'c1',
      }),
      report({ done: 1, total: 2, seen: 2 }),
    ])
    const result = await runBulkJob(s.send, new Set(['a', 'b']))
    expect(result).toEqual({ done: 1, failed: [{ id: 'a', title: 'A', message: 'no' }] })
    expect(s.sent).toHaveLength(2)
  })

  it('stops on a refusal, before a second call and before anything is written', async () => {
    const refusal = { refused: 'count' as const, expected: 15, actual: 16 }
    const s = sender([refusal, report()])
    const result = await runBulkJob(s.send, selectAllMatching({ state: 'draft' }, 15))
    expect(result).toEqual({ refused: refusal })
    expect(s.sent).toHaveLength(1)
  })

  it('gives up on a cursor that does not move, rather than posting forever', async () => {
    // A server answering the same cursor twice is a bug, and the honest client
    // response is to stop with what it has. "Loop on `continueFrom`" is right about
    // the condition and silent about a cursor that stands still.
    const s = sender([
      report({ done: 1, total: 9, seen: 1, continueFrom: 'stuck' }),
      report({ done: 1, total: 9, seen: 2, continueFrom: 'stuck' }),
    ])
    expect(await runBulkJob(s.send, new Set(['a', 'b']))).toEqual({ done: 2, failed: [] })
    expect(s.sent).toHaveLength(2)
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
