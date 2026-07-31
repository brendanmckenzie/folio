/**
 * The Content screen's arithmetic: what rows a partly-loaded tree produces, what
 * a keyboard gesture means, what a selection is, and how the screen's state gets
 * into and out of a URL.
 *
 * Everything here is a pure function over plain data, for the admin's testing
 * convention: no admin test mounts a component (`vitest.config.ts` runs the unit
 * project under `environment: 'node'`), so a screen's *logic* has to live
 * somewhere a Node test can reach it. What is left in `Content.tsx` is markup,
 * fetching and event wiring.
 *
 * `content-rows.ts` is this file's predecessor and still holds the two pieces
 * that survived the port unchanged — `stateTone` and `when` — because they are
 * about a *row*, not about the tree. Its `flatten` is gone: it walked a whole
 * `StoryNode` tree with children in hand, which is precisely what a paged tree
 * does not have.
 */
import type { FlatSort, StoryFilter, StoryMeta, StoryState } from '../../../core/story'

/* ------------------------------------------------------------------- modes --- */

export type ViewMode = 'tree' | 'flat'

/** The state filter's "no filter" value. A chip needs a value for "All", and
 * `undefined` cannot be one. */
export type StateFilter = 'all' | StoryState

/* ------------------------------------------------------------------ levels --- */

/**
 * The key one level is stored under. The top level's parent is `null`, and
 * `null` is not a usable object key, so it gets a name.
 *
 * Deliberately a string that cannot collide with a story id: ids are screened to
 * `[A-Za-z0-9_.:-]+` server-side (`validate.ts`'s `ID`), so a leading `#` is
 * unreachable.
 */
export const ROOT = '#root'

/** A story row as the level route answers it: `StoryMeta` plus how many children
 * it has, which is what tells the screen whether to draw a twisty without
 * fetching the level below to find out. */
export interface LevelRow extends StoryMeta {
  childCount: number
}

/**
 * One loaded (or loading, or failed) level of the tree.
 *
 * **`rows` accumulates: paging a level appends rather than replacing**, and that
 * is a decision rather than laziness.
 *
 * Every other list in this admin pages with next / previous, which is the owner's
 * answer (`ui-architecture.md`, Resolved 5) and correct for a flat list. A tree
 * cannot use it: a level's rows have *expanded descendants nested inside them*, so
 * replacing page one of a level with page two would either drop those subtrees or
 * leave them under rows no longer on screen — and the indent, which is the only
 * thing carrying ancestry here, would stop meaning anything.
 *
 * Appending is the one paging gesture that preserves a tree's structure. So the
 * tree gets a `Show N more` row at the end of an incomplete level and flat mode
 * gets real next / previous: not two paging models by accident, but one cursor
 * with the one control each view can honestly offer.
 *
 * Rejected: paging the flattened tree — `pagination.md` decision 2 already
 * rejects it for the route, because a window across a depth-first walk cuts a
 * subtree in half at an arbitrary depth. Rejected: loading a level whole, which is
 * `StoryTree.tsx:523`'s "Show all 812" — it pays for every row and then hides them
 * anyway.
 */
export interface Level {
  rows: readonly LevelRow[]
  /** Null when the level is fully loaded. */
  cursor: string | null
  /** Only present on the first page, from `?count=1`. */
  total?: number
  loading: boolean
  /** A failed fetch, so the row can say so instead of looking empty. */
  error?: string
}

export type Levels = Readonly<Record<string, Level>>

/** An empty level, before anything has been asked for. */
export const PENDING: Level = { rows: [], cursor: null, loading: true }

/* -------------------------------------------------------------------- rows --- */

/** One visible row of the tree, with the depth its indent comes from. */
export interface TreeRow {
  row: LevelRow
  depth: number
  /** The parent's level key, so a reorder knows which sibling list this row is
   * counted into without re-deriving it from `parentId`. */
  parent: string
  /** Its index among the siblings currently loaded at this level. */
  index: number
  /** How many siblings are loaded at this level. Not the level's `total`: a
   * gesture can only be judged against rows that exist on the client. */
  siblings: number
  /** True when a twisty belongs here — the row has children, loaded or not. */
  expandable: boolean
  expanded: boolean
}

/**
 * A trailing row offering the rest of an incomplete level. Interleaved with the
 * tree rows rather than rendered separately, because it belongs *inside* the
 * level's indent — a "Show 25 more" sitting at depth 0 under a level at depth 3
 * reads as a control over the whole screen.
 */
export interface MoreRow {
  kind: 'more'
  parent: string
  depth: number
  /** How many are loaded so far — the honest half of the label, since a level's
   * `total` is only known when the count was asked for. */
  loaded: number
  total?: number
  loading: boolean
}

export type VisibleRow = ({ kind: 'story' } & TreeRow) | MoreRow

/**
 * The visible rows of a partly-loaded tree, in order, with depths.
 *
 * This is the shape ↑ ↓ traversal needs: a keyboard walks the rows that are *on
 * screen*, not the structure, so the flattening is what makes "the next row" a
 * well-defined thing at all.
 *
 * A node is descended into when it is expanded **and** its level has been asked
 * for. Those are two different facts: expanding is instant and the fetch is not,
 * so an expanded node whose level is still in flight contributes a `more` row
 * marked `loading` rather than nothing — an expanded twisty over no rows at all
 * looks like an empty page rather than a slow one.
 */
export function visibleRows(
  levels: Levels,
  expanded: ReadonlySet<string>,
  depth = 0,
  parent: string = ROOT,
): VisibleRow[] {
  const level = levels[parent]
  if (!level) return []
  const out: VisibleRow[] = []
  level.rows.forEach((row, index) => {
    const isOpen = expanded.has(row.id)
    out.push({
      kind: 'story',
      row,
      depth,
      parent,
      index,
      siblings: level.rows.length,
      expandable: row.childCount > 0,
      expanded: isOpen,
    })
    if (isOpen) out.push(...visibleRows(levels, expanded, depth + 1, row.id))
  })
  // Either there is more to fetch, or a fetch for this level is in flight. The
  // second half is what keeps an expanded-but-not-yet-loaded node from reading as
  // an empty page rather than a slow one. The screen's *initial* load is the one
  // case this does not cover, and deliberately: a root level with no rows yet
  // draws skeletons over the whole list, which is `Content.tsx`'s call to make
  // because it is about the shape of the screen rather than the shape of a level.
  if (level.cursor !== null || level.loading) {
    out.push({
      kind: 'more',
      parent,
      depth,
      loaded: level.rows.length,
      ...(level.total === undefined ? {} : { total: level.total }),
      loading: level.loading,
    })
  }
  return out
}

/** The story rows of a visible list, which is what a keyboard gesture and a
 * select-all-shown act on. */
export function storyRowsOf(rows: readonly VisibleRow[]): TreeRow[] {
  return rows.filter((r): r is { kind: 'story' } & TreeRow => r.kind === 'story')
}

/* ---------------------------------------------------------------- keyboard --- */

/**
 * What a keyboard gesture on a focused row asks the server to do.
 *
 * A `PATCH /stories/:id { parentId, index }` in every case, because that is the
 * one write the tree has: `updateStoryStatement` turns `index` into the fractional
 * `ord` (`orderAt`), so all four gestures are the same call with different
 * arguments. That is the answer `ROADMAP.md` asks for — "one place at a time, so
 * 'between these two siblings' never has to be expressed".
 */
export interface Move {
  id: string
  parentId: string | null
  /** Counted into the sibling list **excluding the row being moved**, which is
   * what `orderAt(rows, group, index, ignore)` compares against. Getting this
   * wrong is an off-by-one that only shows on a downward move. */
  index: number
}

/** Why a gesture cannot happen, for the notice. Null when it can. */
export type Refusal = string | null

export type Gesture = 'up' | 'down' | 'out' | 'in'

/**
 * The `Move` a gesture produces, or a refusal.
 *
 * Four gestures, and the two depth changes are ordinary outliner semantics:
 * `in` makes a row a child of the sibling above it, `out` makes it a sibling of
 * its own parent, placed just after it. That pair is `⌥← ⌥→`; `up`/`down` is
 * `⌥↑ ⌥↓` and stays within one parent.
 *
 * **The root is immovable**, and refuses with a reason rather than doing nothing:
 * it owns `/` and `updateStoryStatement` will not reslug or reparent it, so a
 * silent no-op here would be a gesture that looks broken instead of constrained.
 *
 * The index arithmetic, since it is the part that is easy to get wrong. Sibling
 * lists here *include* the moved row, and `orderAt` excludes it:
 *
 * - `up`: the row is at `index`; landing before its predecessor is exclusive
 *   index `index - 1`.
 * - `down`: removing the row shifts its successor down to exclusive index
 *   `index`, so landing after it is `index + 1`.
 */
export function gestureMove(
  gesture: Gesture,
  at: TreeRow,
  /** The visible rows, for `in`/`out`, which need a neighbour or a parent. */
  rows: readonly VisibleRow[],
  levels: Levels,
): { move: Move } | { refusal: string } {
  if (at.row.path === '') {
    return { refusal: 'The home page owns / and cannot be moved' }
  }

  if (gesture === 'up' || gesture === 'down') {
    const last = at.siblings - 1
    if (gesture === 'up' && at.index === 0) return { refusal: 'Already first among its siblings' }
    if (gesture === 'down' && at.index >= last) {
      // "Loaded" rather than "all": a level with a cursor has siblings the client
      // has not seen, and saying so is better than refusing as though it were the
      // end of the list.
      const more = levels[at.parent]?.cursor !== null
      return {
        refusal: more
          ? 'Already last of the siblings loaded — show more of this level first'
          : 'Already last among its siblings',
      }
    }
    return {
      move: {
        id: at.row.id,
        parentId: at.row.parentId,
        index: gesture === 'up' ? at.index - 1 : at.index + 1,
      },
    }
  }

  if (gesture === 'in') {
    const above = storyRowsOf(rows).find((r) => r.parent === at.parent && r.index === at.index - 1)
    if (!above) return { refusal: 'Nothing above it to nest under' }
    // The end of the new parent's children — and `keyAtIndex` clamps an
    // out-of-range index, so an unloaded level's count being unknown is not a
    // problem: a number past the end appends, which is what "nest under" means.
    const known = levels[above.row.id]
    const index = known && known.cursor === null ? known.rows.length : above.row.childCount
    return { move: { id: at.row.id, parentId: above.row.id, index } }
  }

  // `out`: a sibling of the parent, immediately after it.
  if (at.parent === ROOT) return { refusal: 'Already at the top level' }
  const parentRow = storyRowsOf(rows).find((r) => r.row.id === at.parent)
  if (!parentRow) return { refusal: 'Its parent is not loaded' }
  return {
    move: {
      id: at.row.id,
      parentId: parentRow.row.parentId,
      // The row is leaving a different level entirely, so the parent's own
      // sibling list already excludes it — `+ 1` lands after the parent with no
      // adjustment of the kind `up`/`down` need.
      index: parentRow.index + 1,
    },
  }
}

/* --------------------------------------------------------------- selection --- */

/**
 * A selection is a set of ids, and it survives filtering, sorting, paging and the
 * `[ Tree | Flat ]` toggle (`ui-architecture.md` decision 7a).
 *
 * A `Set` and nothing else, because **explicit** selection is small by
 * construction: you can only tick what you can see, a page at a time.
 *
 * **Select-all-matching-the-filter is not here**, and its absence is a decision.
 * Decision 7a specifies it as a flag plus a captured filter plus an expected count
 * plus exclusions — no ids materialised — and the reason that shape works is that
 * the *server* re-runs the filter, compares the count and executes as a batched,
 * resumable job. Those endpoints do not exist (`ui-architecture.md` dependency 7,
 * and `pagination.md` puts them out of scope), and the actions below are N
 * per-item calls from the client. Offering "select all 51,420 matching" over that
 * would mean fetching 51,420 rows to loop over them, which is the single thing
 * the shape exists to avoid. So the affordance is absent rather than disabled —
 * the same rule the top bar already follows for controls that cannot act.
 */
export type Selection = ReadonlySet<string>

export function toggleSelected(selection: Selection, id: string): Set<string> {
  const next = new Set(selection)
  if (!next.delete(id)) next.add(id)
  return next
}

/** Select-all-shown, or clear it when everything shown is already selected —
 * the header checkbox's two states, as one function. */
export function toggleAllShown(selection: Selection, shown: readonly string[]): Set<string> {
  const next = new Set(selection)
  if (shown.every((id) => next.has(id))) {
    for (const id of shown) next.delete(id)
  } else {
    for (const id of shown) next.add(id)
  }
  return next
}

/**
 * What the selection bar says.
 *
 * `shown` is the part of the selection currently on screen, and the split is the
 * point: **acting on more than you can see is the hazard**, so the count that is
 * invisible gets named rather than implied. A bar reading "12 selected" over a
 * list with nothing highlighted reads as broken software, which is why the
 * `none` case is worded rather than left to the numbers.
 */
export interface SelectionSummary {
  count: number
  shown: number
  hidden: number
  text: string
}

export function summarise(selection: Selection, visible: readonly string[]): SelectionSummary {
  const count = selection.size
  const here = new Set(visible)
  const shown = [...selection].filter((id) => here.has(id)).length
  const hidden = count - shown
  const pages = `${count} ${count === 1 ? 'page' : 'pages'}`
  const text =
    count === 0
      ? 'Nothing selected'
      : shown === 0
        ? `${pages} selected, none shown by this filter`
        : hidden === 0
          ? `${pages} selected`
          : `${pages} selected · ${shown} shown here`
  return { count, shown, hidden, text }
}

/**
 * The five bulk actions (`ui-architecture.md` decision 7).
 *
 * `move` is in the set, and the reasoning that once excluded it — "a tree
 * operation with fractional indices and cycle checks" — was our implementation's
 * problem dressed up as a product decision. `PATCH /stories/:id { parentId,
 * index }` already encodes every rule that applies, so bulk move is per-item
 * calls with refusals reported.
 */
export const BULK_ACTIONS = ['publish', 'unpublish', 'duplicate', 'move', 'delete'] as const
export type BulkAction = (typeof BULK_ACTIONS)[number]

/**
 * What N per-item writes did, as one sentence.
 *
 * **Nothing here is atomic and the UI must not imply it is.** Each of N sequential
 * writes can be refused on its own — by role, or by a tree rule — so the report
 * counts both and names the failures rather than showing a single tick.
 * Contentful's API offers an all-or-nothing batch; Folio has no equivalent, and
 * pretending otherwise would be the lie.
 */
export function reportOf(
  action: BulkAction,
  done: number,
  failures: readonly { title: string; message: string }[],
): string {
  const verb = PAST_TENSE[action]
  if (failures.length === 0) return `${verb} ${done} ${done === 1 ? 'page' : 'pages'}`
  const named = failures
    .slice(0, 2)
    .map((f) => `${f.title || 'Untitled'} (${f.message})`)
    .join(', ')
  const rest = failures.length > 2 ? `, and ${failures.length - 2} more` : ''
  return done === 0
    ? `Could not ${action} ${failures.length === 1 ? 'it' : 'any of them'}: ${named}${rest}`
    : `${verb} ${done}, ${failures.length} refused: ${named}${rest}`
}

const PAST_TENSE: Record<BulkAction, string> = {
  publish: 'Published',
  unpublish: 'Unpublished',
  duplicate: 'Duplicated',
  move: 'Moved',
  delete: 'Deleted',
}

/* --------------------------------------------------------------------- URL --- */

/**
 * The screen's state, as it appears in its query string.
 *
 * All of it in the URL, because `design-system.md`'s first commitment is that a
 * person who can see something can link to it — with two deliberate exceptions,
 * both of which are gestures rather than places:
 *
 * - **the selection** (decision 7a: three hundred ids is not a link anybody
 *   wants), and
 * - **which nodes are expanded**, because a link to a page in a tree is a link to
 *   the page, not to a particular shape of tree.
 */
export interface ContentUrl {
  view: ViewMode
  sort: FlatSort
  state: StateFilter
  type: string | undefined
  q: string
}

export function parseContentUrl(
  query: Readonly<Record<string, string>>,
  /** What to use when the URL says nothing — the last choice, remembered. */
  defaults: { view: ViewMode; sort: FlatSort },
): ContentUrl {
  return {
    view: query.view === 'flat' ? 'flat' : query.view === 'tree' ? 'tree' : defaults.view,
    sort: isFlatSort(query.sort) ? query.sort : defaults.sort,
    state: isStateFilter(query.state) ? query.state : 'all',
    type: query.type || undefined,
    q: query.q ?? '',
  }
}

/**
 * The inverse, as the query object `href` takes.
 *
 * Defaults are written as `undefined` so they leave the URL rather than sitting
 * in it: `?view=tree&sort=edited&state=all` is four times the length of the bare
 * path and says exactly the same thing. `sort` is omitted in tree mode entirely,
 * because a tree's order is its structure — `ord` *is* the sibling order — so a
 * sort parameter there would be a promise the view cannot keep.
 */
export function contentQuery(url: ContentUrl): Record<string, string | undefined> {
  return {
    view: url.view === 'tree' ? undefined : url.view,
    sort: url.view === 'flat' && url.sort !== 'edited' ? url.sort : undefined,
    state: url.state === 'all' ? undefined : url.state,
    type: url.type,
    q: url.q || undefined,
  }
}

function isFlatSort(raw: string | undefined): raw is FlatSort {
  return raw === 'edited' || raw === 'title' || raw === 'path'
}

function isStateFilter(raw: string | undefined): raw is StateFilter {
  return (
    raw === 'all' || raw === 'draft' || raw === 'live' || raw === 'changed' || raw === 'unpublished'
  )
}

/**
 * The `StoryFilter` a URL means — the object the route takes and the object a
 * captured selection would serialise (`pagination.md` decision 9).
 *
 * `parentId` is absent, deliberately: it is structure rather than a filter, and
 * the level walk supplies it per request. `all` becomes absent rather than a
 * fifth state value, which is what keeps the wire vocabulary the same four states
 * `StoryState` names.
 */
export function filterOf(url: ContentUrl): StoryFilter {
  return {
    ...(url.state === 'all' ? {} : { state: url.state }),
    ...(url.type ? { type: url.type } : {}),
    ...(url.q.trim() ? { q: url.q.trim() } : {}),
  }
}

/** A `StoryFilter` as query parameters, for the fetch. One function so the URL
 * the screen shows and the request it makes cannot disagree about a filter. */
export function filterParams(filter: StoryFilter): Record<string, string> {
  return {
    ...(filter.state ? { state: filter.state } : {}),
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.q ? { q: filter.q } : {}),
    ...(filter.locale ? { locale: filter.locale } : {}),
  }
}

/**
 * Whether a filter is narrowing anything.
 *
 * Used for two things: telling "no pages yet" from "nothing matches", which are
 * different empty states — offering *clear filters* under the first is offering to
 * clear nothing — and `narrowingForcesFlat` below.
 */
export function isNarrowed(filter: StoryFilter): boolean {
  return Boolean(filter.state || filter.type || filter.q)
}

/**
 * **A filter moves you to flat, and this is the screen's one genuinely surprising
 * rule — so it is stated here rather than emerging from the wiring.**
 *
 * Found by building this screen, and it is a consequence of the route rather than
 * a preference. The tree loads **one level at a time**, so a filtered tree can
 * only ever show matches whose *entire ancestor chain also matches*: a `changed`
 * page nested under an untouched parent is unreachable, because walking down from
 * the root never returns its parent. The old prototype had no such problem — it
 * held the whole tree and `content-rows.ts`'s `flatten` kept a match's ancestors —
 * and that is exactly the capability paging removes.
 *
 * A filter that silently omits matching pages is worse than no filter, so the
 * filter controls write `view=flat` in the same URL update that sets them. Flat
 * mode *is* the filtered view: every routed page, no structure, full paths, three
 * sorts. The toggle moves visibly, the URL says so, and one click on `Tree` clears
 * the filters and goes back to the shape of the site.
 *
 * **Rejected: filtering the tree per level anyway.** One line of code and it
 * quietly loses rows — the failure mode nobody notices until they trust the
 * result.
 *
 * **Rejected: answering "matches, plus every ancestor of a match" server-side.**
 * Correct, and buildable: `exists (select 1 from stories m where m.path like
 * child.path || '/%' and <match>)` is an index range scan over `stories_path`. It
 * was rejected on what it costs *above* the query — a level's page can then
 * contain rows that are only there to hold a descendant, so paging it means
 * paging two interleaved result sets, and the client has to be told which nodes to
 * auto-expand to reveal the matches. That is a lot of machinery to reproduce, worse,
 * what the flat twin already answers better: sortable, with full paths, which is
 * how a person actually reads "what changed lately".
 *
 * **Rejected: hiding the state chips in tree mode.** It makes the tree honest by
 * making the feature undiscoverable, and the chips are the home screen's
 * "unpublished changes" block in their new home (`ui-architecture.md`, Home).
 */
export function withFilter(url: ContentUrl, patch: Partial<ContentUrl>): ContentUrl {
  const next = { ...url, ...patch }
  return isNarrowed(filterOf(next)) ? { ...next, view: 'flat' } : next
}

/**
 * Switching to a named view.
 *
 * `tree` **clears the filters**, because a filtered tree is the thing
 * `withFilter` exists to prevent and bouncing straight back to flat would make
 * the toggle look broken. Tree means "show me the shape of the site", which is
 * unfiltered by construction; the search box and the chips are how you ask a
 * question instead, and that question is answered flat.
 *
 * `flat` keeps everything: it can express every filter the chips offer.
 */
export function withView(url: ContentUrl, view: ViewMode): ContentUrl {
  if (view === 'flat') return { ...url, view }
  return { ...url, view, state: 'all', type: undefined, q: '' }
}
