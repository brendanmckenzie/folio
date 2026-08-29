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
 * **One export is not a pure function, and it is deliberate: `runBulkJob`.** A
 * bulk write is a loop over `continueFrom`, and what that loop does with each
 * report — sum `done`, concatenate `failed`, stop on a refusal — is exactly the
 * kind of arithmetic that belongs in a Node test. So it takes the request-sender
 * as an argument rather than calling `fetch` itself, which leaves it decidable:
 * a fake sender pins how many requests a run makes and what is in each of them.
 * The alternative was leaving the loop in `Content.tsx`, where the only thing
 * that could have caught the reversed bulk move is somebody moving three pages.
 *
 * `content-rows.ts` is this file's predecessor and still holds the two pieces
 * that survived the port unchanged — `stateTone` and `when` — because they are
 * about a *row*, not about the tree. Its `flatten` is gone: it walked a whole
 * `StoryNode` tree with children in hand, which is precisely what a paged tree
 * does not have.
 */
import type { BulkAction, FlatSort, StoryFilter, StoryMeta, StoryState } from '../../../core/story'
import type { BulkFailure, BulkRefusal, BulkReport } from '../../../server/bulk'

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
 * The parts of a row a captured filter can be evaluated against.
 *
 * `StoryMeta` narrowed to the seven fields `matchesFilter` reads, so a test can
 * write a row without inventing a watermark pair — and so it is obvious that
 * nothing here depends on a field only one of the two views loads.
 */
export type Matchable = Pick<
  StoryMeta,
  'id' | 'type' | 'state' | 'title' | 'slug' | 'path' | 'parentId'
>

/**
 * Every document matching a filter, as it stood when *select all* was pressed —
 * a flag, the conditions **captured** at that moment, the count the person was
 * shown, and whatever they ticked off afterwards (`ui-architecture.md`
 * decision 7a).
 *
 * **No ids are materialised**, which is the whole point: "select all 51,420
 * matching" is the same amount of data as "select all 12 matching", so the
 * question of a ceiling never arises on this side of the wire either.
 */
export interface AllMatching {
  all: true
  /** A snapshot, never a live read of whatever the chips currently say. */
  filter: StoryFilter
  /** `total` from the `?count=1` header the person was reading. */
  expected: number
  /** Rows ticked *off* afterwards. Bounded by what a person can see. */
  exclude: ReadonlySet<string>
}

/**
 * A selection, in the two shapes decision 7a specifies, and both **capture**
 * rather than track — which is what makes a selection survive filtering,
 * sorting, paging and the `[ Tree | Flat ]` toggle.
 *
 * **Explicit** is a set of ids, small by construction: you can only tick what you
 * can see, a page at a time. **Select-all-matching** is `AllMatching` above.
 *
 * The second shape used to be *absent*, and the comment here argued for the
 * absence: the five actions were N per-item calls from the client, so offering
 * "select all 51,420 matching" would have meant fetching 51,420 rows to loop
 * over them — the single thing the shape exists to avoid. That was the blocker,
 * and `platform/bulk-writes.md` removed exactly it: the server re-runs the
 * captured filter, checks the count once, and walks it as a batched job resumable
 * by a cursor. The whole selection now travels as four fields, so the affordance
 * is here rather than reasoned about.
 *
 * One thing the client still has to decide for itself: **whether a row on screen
 * is in the set**. In explicit mode that is `has`; in select-all mode it is
 * `matchesFilter` against the *captured* filter, because the visible filter may
 * have moved on. That evaluation is for the tick and the split only — the server
 * re-runs the filter in SQL and is the authority on what gets written.
 */
export type Selection = ReadonlySet<string> | AllMatching

/** Nothing selected. A named constant because the empty case is written in five
 * places and `new Set()` in a component body is a fresh object every render. */
export const NOTHING: Selection = new Set<string>()

export function isAll(selection: Selection): selection is AllMatching {
  return 'all' in selection
}

/**
 * Capture a select-all, at click time.
 *
 * **`routed: true` is added here rather than left to the caller, and it is
 * load-bearing.** Content's flat list counts `path is not null` in the reader, so
 * a captured filter without this axis counts records too — and `expected` would
 * then differ from the guard's count by however many unrouted documents the site
 * has, forever. A mismatch that cannot be re-confirmed is a wall, which
 * decision 7a forbids by name (`bulk-writes.md` decision 4 is the same fact from
 * the server's side).
 */
export function selectAllMatching(filter: StoryFilter, expected: number): AllMatching {
  return { all: true, filter: { ...filter, routed: true }, expected, exclude: new Set() }
}

/** How many documents the selection means. */
export function selectionSize(selection: Selection): number {
  return isAll(selection)
    ? Math.max(selection.expected - selection.exclude.size, 0)
    : selection.size
}

/**
 * Whether a row on screen is in the selection.
 *
 * The select-all branch is where a bar and a list stop disagreeing: a row that
 * does not match the *captured* conditions is not in the set, however the visible
 * filter has changed since, so its checkbox is empty and the "shown here" count
 * does not include it.
 */
export function isSelected(selection: Selection, row: Matchable): boolean {
  if (!isAll(selection)) return selection.has(row.id)
  return !selection.exclude.has(row.id) && matchesFilter(row, selection.filter)
}

/**
 * A captured `StoryFilter` evaluated client-side, for display only.
 *
 * The same four axes `filterOf` can produce plus `routed`, matched the way
 * `storyFilters` matches them: exact on `state` and `type`, substring on title,
 * slug and path for `q` (SQLite's `like` is case-insensitive over ASCII, so both
 * sides are lowered). `locale` is not evaluated because Content never captures
 * one — translation completeness is the Documents screen's axis — and because a
 * client holding a row's title cannot answer it anyway.
 *
 * **It is not the guard.** The server re-runs the filter in SQL and refuses on a
 * count mismatch; this decides whether to draw a tick. A disagreement between the
 * two costs a checkbox, never a write.
 */
export function matchesFilter(row: Matchable, filter: StoryFilter): boolean {
  if (filter.state !== undefined && row.state !== filter.state) return false
  if (filter.type !== undefined && row.type !== filter.type) return false
  if (filter.routed === true && row.path === null) return false
  if (filter.routed === false && row.path !== null) return false
  if (filter.parentId !== undefined && row.parentId !== filter.parentId) return false
  if (filter.q !== undefined && filter.q !== '') {
    const needle = filter.q.toLowerCase()
    const haystack = [row.title, row.slug, row.path ?? '']
    if (!haystack.some((field) => field.toLowerCase().includes(needle))) return false
  }
  return true
}

/**
 * Ticking one row, which in select-all mode means **adding to `exclude`**.
 *
 * `{ selection } | { refusal }` — `gestureMove`'s shape, for the same reason it
 * has it. A row that does not match the captured conditions cannot join a
 * select-all: the wire has one selection with two shapes and no way to say "every
 * draft, plus this live page" (`bulk-writes.md` decision 13 refuses a mixed body
 * deliberately, and a stripped key there would change which documents get
 * written). So the click is refused *with the reason* rather than quietly doing
 * nothing, which is the difference between a constrained control and a broken one.
 *
 * Rejected: hiding the checkbox on a row that cannot join. `## Cross-cutting`
 * says an impossible control is absent — but a checkbox missing from one row of a
 * list reads as a rendering fault, and the same click is perfectly possible on the
 * row above it. This is a refusable control, and it explains itself.
 */
export function toggleSelected(
  selection: Selection,
  row: Matchable,
): { selection: Selection } | { refusal: string } {
  if (!isAll(selection)) {
    const next = new Set(selection)
    if (!next.delete(row.id)) next.add(row.id)
    return { selection: next }
  }
  const exclude = new Set(selection.exclude)
  if (!exclude.delete(row.id)) {
    if (!matchesFilter(row, selection.filter)) {
      return {
        refusal:
          'This page is not in the selection — a select-all covers the conditions it captured. Clear the selection to tick pages one at a time.',
      }
    }
    exclude.add(row.id)
  }
  return { selection: { ...selection, exclude } }
}

/**
 * Select-all-shown, or clear it when everything shown is already selected — the
 * footer's two states, as one function.
 *
 * In select-all mode it works on `exclude`, and unlike `toggleSelected` it refuses
 * nothing: a gesture over a list applies to the rows it can apply to, and a row
 * outside the captured conditions is simply not one of them. A refusal here would
 * fire on a mixed list where the gesture did exactly what it said.
 */
export function toggleAllShown(selection: Selection, shown: readonly Matchable[]): Selection {
  if (!isAll(selection)) {
    const next = new Set(selection)
    if (shown.every((row) => next.has(row.id))) {
      for (const row of shown) next.delete(row.id)
    } else {
      for (const row of shown) next.add(row.id)
    }
    return next
  }
  const inSet = shown.filter((row) => matchesFilter(row, selection.filter))
  const exclude = new Set(selection.exclude)
  if (inSet.every((row) => !exclude.has(row.id))) {
    for (const row of inSet) exclude.add(row.id)
  } else {
    for (const row of inSet) exclude.delete(row.id)
  }
  return { ...selection, exclude }
}

/** Whether the footer's control would clear rather than select. */
export function allShownSelected(selection: Selection, shown: readonly Matchable[]): boolean {
  return shown.length > 0 && shown.every((row) => isSelected(selection, row))
}

/**
 * What the selection bar says.
 *
 * `shown` is the part of the selection currently on screen, and the split is the
 * point: **acting on more than you can see is the hazard**, so the count that is
 * invisible gets named rather than implied. A bar reading "12 selected" over a
 * list with nothing highlighted reads as broken software, which is why the
 * `none` case is worded rather than left to the numbers.
 *
 * **The bar states the mode too**, because "51,420 selected" is meaningless
 * without *matching what* — so a select-all writes its captured conditions out
 * rather than implying them, and the sentence changes shape when the mode does,
 * which is what makes `role="status"` announce it.
 */
export interface SelectionSummary {
  /** How many documents the selection means. */
  count: number
  /** How many of them are on screen. */
  shown: number
  hidden: number
  /** The mode, for the actions the bar may offer and the recovery it may offer. */
  all: boolean
  text: string
}

export function summarise(
  selection: Selection,
  visible: readonly Matchable[],
  /** Type name → label, so the conditions read as the chips do. */
  labels: Readonly<Record<string, string>> = {},
): SelectionSummary {
  const count = selectionSize(selection)
  const shown = visible.filter((row) => isSelected(selection, row)).length
  const hidden = Math.max(count - shown, 0)
  const all = isAll(selection)
  // Nothing to add when the whole selection is on screen: "3 pages selected · 3
  // shown here" says one thing twice.
  const split =
    hidden === 0 ? '' : shown === 0 ? ', none shown by this filter' : ` · ${shown} shown here`
  if (!all) {
    return {
      count,
      shown,
      hidden,
      all,
      text: count === 0 ? 'Nothing selected' : `${pages(count)} selected${split}`,
    }
  }
  const conditions = conditionsOf(selection.filter, labels)
  const ticked = selection.exclude.size
  // "All 51,420 matching state is draft" is a lie once two rows have been ticked
  // off, and the number the actions will act on is the one after the subtraction —
  // so both appear, and only when there is a difference to explain.
  const head = `All ${num(selection.expected)}${conditions ? ` matching ${conditions}` : ' pages'}`
  const less = ticked === 0 ? '' : `, except the ${num(ticked)} you ticked off`
  return { count, shown, hidden, all, text: `${head}${less}${split}` }
}

/**
 * A captured filter as English, for the bar and the confirmations.
 *
 * Decision 7a asks for the conditions "written out rather than implied", and the
 * one axis deliberately left out is **`routed`**: every row Content lists is
 * routed, so it is the screen's own scope rather than a condition anybody chose,
 * and writing it out would put a word in the sentence no chip can turn off.
 */
export function conditionsOf(
  filter: StoryFilter,
  labels: Readonly<Record<string, string>> = {},
): string {
  const parts: string[] = []
  if (filter.state) parts.push(`state is ${filter.state}`)
  if (filter.type) parts.push(`type is ${labels[filter.type] ?? filter.type}`)
  if (filter.q) parts.push(`search is “${filter.q}”`)
  return parts.join(' and ')
}

/** The footer's select-all-matching control, which names the number it captures. */
export function selectAllLabel(total: number): string {
  return `Select all ${num(total)} matching`
}

/**
 * The five bulk actions (`ui-architecture.md` decision 7), in the order the bar
 * offers them.
 *
 * `move` is in the set, and the reasoning that once excluded it — "a tree
 * operation with fractional indices and cycle checks" — was our implementation's
 * problem dressed up as a product decision. `updateStoryStatement` already
 * encodes every rule that applies, so a page that cannot go where it was asked is
 * one named line in the report.
 *
 * `BulkAction` itself is `core/story.ts`'s: the value is in a URL — one route per
 * action — so the screen that posts it and the runner that performs it share one
 * vocabulary rather than two lists that agree today.
 */
export const BULK_ACTIONS: readonly BulkAction[] = [
  'publish',
  'unpublish',
  'duplicate',
  'move',
  'delete',
]

/**
 * The actions a selection may be given, which is not always all five.
 *
 * **`duplicate` is absent in select-all mode**, not disabled. The server refuses
 * it there (`bulk-writes.md` decision 6) because a duplicate adds documents to the
 * very set it is walking — the copy of a draft is a draft — and fixing that
 * properly would mean remembering the ids it created, which is materialising the
 * id list this shape exists to avoid. So the refusal is structural rather than
 * situational, and `## Cross-cutting` says an impossible control is absent.
 */
export function actionsFor(selection: Selection): readonly BulkAction[] {
  return isAll(selection) ? BULK_ACTIONS.filter((action) => action !== 'duplicate') : BULK_ACTIONS
}

/**
 * The confirmation before a bulk write, or null when the action can be taken as
 * read.
 *
 * **It names the invisible part**, which is the whole reason it exists: acting on
 * more than you can see is the hazard, so *"Publish 12 pages? 9 are not shown by
 * the current filter."* rather than a count on its own.
 *
 * Three cases earn a dialog and the rest do not: anything the current view cannot
 * account for (`hidden > 0`), every select-all (51,420 documents on one click is
 * the hazard in its purest form, and the conditions want restating), and every
 * delete (the one action a report cannot undo).
 *
 * **Rejected: confirming all five, always.** A modal in front of "publish these
 * two pages, both of which are on screen and both of which I ticked" teaches
 * people to dismiss the dialog without reading it — which is exactly the one that
 * matters when it is 51,420 pages instead.
 */
export interface Confirmation {
  title: string
  /** One line under the title, in `Dialog`'s `description` slot. */
  body: string
  danger: boolean
}

export function confirmOf(
  action: BulkAction,
  summary: SelectionSummary,
  filter?: StoryFilter,
  labels: Readonly<Record<string, string>> = {},
): Confirmation | null {
  if (summary.count === 0) return null
  if (!summary.all && summary.hidden === 0 && action !== 'delete') return null
  const invisible =
    summary.hidden === 0
      ? ''
      : summary.shown === 0
        ? 'None of them are shown by the current filter.'
        : `${num(summary.hidden)} ${summary.hidden === 1 ? 'is' : 'are'} not shown by the current filter.`
  const captured = summary.all && filter ? whatWasCaptured(conditionsOf(filter, labels)) : ''
  return {
    title: `${VERB[action]} ${pages(summary.count)}?`,
    body: [captured, invisible, action === 'delete' ? DELETE_NOTE : ''].filter(Boolean).join(' '),
    danger: action === 'delete',
  }
}

function whatWasCaptured(conditions: string): string {
  return conditions
    ? `Everything matching ${conditions}, as it stood when you chose it.`
    : 'Every page, as it stood when you chose it.'
}

/** The same sentence `DeleteDialog` and `AssetDeleteDialog` use, plus what a bulk
 * delete leaves behind — a redirect per vacated path, exactly as deleting them
 * one at a time would (`redirects.md` decision 4). */
const DELETE_NOTE =
  'Each page, its subtree, its history and its index rows all go, and each vacated path gets a redirect to its parent. This cannot be undone.'

/**
 * What the guard said when it refused, and it is **a door rather than a wall**:
 * the new count is in the sentence and re-confirming is one button.
 *
 * The refusal fires when the set moved between the number a person read and the
 * button they pressed, which on a busy site with a `state: draft` filter is
 * routine — and is the point. The alternative it beat is running anyway, which is
 * a bulk publish quietly including nine pages nobody looked at.
 */
export function refusalOf(action: BulkAction, refusal: BulkRefusal): Confirmation {
  const verb = refusal.actual === 1 ? 'matches' : 'match'
  return {
    title: `${pages(refusal.actual)} ${verb} now, not ${num(refusal.expected)}`,
    body: `Somebody else changed what matches while you were reading the number. ${VERB[action]} the ${num(refusal.actual)} that ${verb} now?`,
    danger: action === 'delete',
  }
}

/** The affirmative button beside `refusalOf`'s question. */
export function retryLabel(action: BulkAction, refusal: BulkRefusal): string {
  return `${VERB[action]} ${pages(refusal.actual)}`
}

/**
 * What one or more batched writes did, as one sentence.
 *
 * **Nothing here is atomic and the UI must not imply it is.** Each document is its
 * own write and can be refused on its own — by role, or by a tree rule — so the
 * report counts both and names the failures rather than showing a single tick.
 * Contentful's API offers an all-or-nothing batch; Folio has no equivalent, and
 * pretending otherwise would be the lie.
 *
 * Called **once**, at the end of the job, over the summed `done` and the
 * concatenated `failed`: `BulkReport`'s two per-call numbers are per call
 * precisely because the server cannot know what an earlier call did.
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

/** Progress across a run that takes several calls. `seen` and `total` are the
 * report's own numbers — the job's, not this call's — so there is no arithmetic
 * here to get wrong. */
export function progressOf(seen: number, total: number): string {
  return `Working… ${num(seen)} of ${num(total)}`
}

const PAST_TENSE: Record<BulkAction, string> = {
  publish: 'Published',
  unpublish: 'Unpublished',
  duplicate: 'Duplicated',
  move: 'Moved',
  delete: 'Deleted',
}

const VERB: Record<BulkAction, string> = {
  publish: 'Publish',
  unpublish: 'Unpublish',
  duplicate: 'Duplicate',
  move: 'Move',
  delete: 'Delete',
}

/** The imperative, for a confirmation's affirmative button. One table for the
 * question and the button, so "Publish 12 pages?" cannot be answered by *Apply*. */
export function verbOf(action: BulkAction): string {
  return VERB[action]
}

function pages(n: number): string {
  return `${num(n)} ${n === 1 ? 'page' : 'pages'}`
}

/**
 * A number as every sentence here writes it.
 *
 * `en-US` explicitly rather than the host's locale, which `Home.tsx` uses for its
 * cards: the sentence around this one is English, and a number grouped by one
 * locale inside a sentence written in another reads as a bug. It also makes the
 * wording testable — `toLocaleString()` with no argument answers differently
 * depending on the machine running the test.
 */
function num(n: number): string {
  return n.toLocaleString('en-US')
}

/* ------------------------------------------------------------- bulk writes --- */

/**
 * The body of `POST {apiBase}/bulk/{action}` (`bulk-writes.md`'s route table).
 *
 * One request per **batch**, not per document. The client half used to be N
 * sequential per-item calls, which is what made select-all-matching impossible to
 * offer at all; now the selection is one argument with two shapes and the server
 * walks it.
 */
export interface BulkRequest {
  selection:
    | { ids: string[] }
    | { all: true; filter: StoryFilter; expected: number; exclude?: string[] }
  /** The previous call's cursor. Absent on the first call of a job. */
  continueFrom?: string
  /** `move` only, and required for it. `null` is the top level. */
  parentId?: string | null
  /** `move` only: where the **first** document lands among its new siblings. */
  index?: number
}

/** Where a bulk move is going. */
export interface Destination {
  parentId: string | null
  index?: number
}

/**
 * One request body.
 *
 * **`index` belongs to the set, not to a document**, and that is the fix for a real
 * defect: the per-item client loop passed `index: 0` for every document, so a moved
 * set landed **reversed** — each write pushing the previous one down. The route adds
 * the job's own position to this number, so the walk order survives a batch boundary
 * too (`bulk-writes.md` decision 14).
 *
 * An explicit selection is posted **in the order the set holds it**, which is the
 * order the rows were ticked — `toggleAllShown` adds in the order they are shown, so
 * the common gesture gives visible order. Rejected: re-sorting the ids into the
 * visible order at post time, which can only order the part that is on screen and
 * would therefore interleave two orderings for a selection that survived paging.
 */
export function bulkBody(
  selection: Selection,
  opts: { continueFrom?: string | null; destination?: Destination } = {},
): BulkRequest {
  const exclude = isAll(selection) ? [...selection.exclude] : []
  return {
    selection: isAll(selection)
      ? {
          all: true,
          filter: selection.filter,
          expected: selection.expected,
          // Omitted when empty rather than sent as `[]`: the two options are
          // `v.strictObject`, so every key in this body is one the route reads.
          ...(exclude.length === 0 ? {} : { exclude }),
        }
      : { ids: [...selection] },
    ...(opts.continueFrom ? { continueFrom: opts.continueFrom } : {}),
    ...(opts.destination
      ? {
          parentId: opts.destination.parentId,
          ...(opts.destination.index === undefined ? {} : { index: opts.destination.index }),
        }
      : {}),
  }
}

/** What a bulk route answers: the report, or the 409's refusal. */
export type BulkAnswer = BulkReport | BulkRefusal

export function wasRefused(answer: BulkAnswer): answer is BulkRefusal {
  return 'refused' in answer
}

/** A finished job, or the refusal that stopped it before anything was written. */
export type BulkResult = { done: number; failed: BulkFailure[] } | { refused: BulkRefusal }

/**
 * A whole bulk job: post, read the report, post again with its cursor.
 *
 * **Loop on `continueFrom`, never on `seen < total`** — a batch whose documents
 * were all refused still advances the cursor, and a comparison of counts would
 * spin. `done` is summed and `failed` concatenated across calls because both are
 * per call by design; `total` and `seen` are the job's, so progress needs no
 * arithmetic here.
 *
 * The sender is an argument rather than a `fetch` in the body, which is what makes
 * this testable in Node: a fake sender records how many requests a run makes and
 * what was in each. That is the only thing that could have caught the reversed
 * move, and nothing did.
 */
export async function runBulkJob(
  send: (body: BulkRequest) => Promise<BulkAnswer>,
  selection: Selection,
  opts: { destination?: Destination; onProgress?: (seen: number, total: number) => void } = {},
): Promise<BulkResult> {
  let continueFrom: string | null = null
  let done = 0
  const failed: BulkFailure[] = []
  for (;;) {
    const answer = await send(
      bulkBody(selection, {
        ...(continueFrom === null ? {} : { continueFrom }),
        ...(opts.destination ? { destination: opts.destination } : {}),
      }),
    )
    // The guard runs once, at the start of a job, so a refusal can only arrive on
    // the first call — and it arrives before anything is written.
    if (wasRefused(answer)) return { refused: answer }
    done += answer.done
    failed.push(...answer.failed)
    opts.onProgress?.(answer.seen, answer.total)
    // A cursor that has not moved is a server that will answer the same thing
    // forever, and this loop would post until the tab was closed. Named because
    // decision 11's "loop on `continueFrom`" is right about the condition and
    // silent about a cursor that stands still.
    if (answer.continueFrom === null || answer.continueFrom === continueFrom) {
      return { done, failed }
    }
    continueFrom = answer.continueFrom
  }
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

/**
 * *Show only selected*, for a select-all: **the captured conditions, as a URL.**
 *
 * Decision 7a calls this the recovery path — one click to see exactly what is
 * selected regardless of the visible filter — and for a select-all it is an
 * ordinary paged read of the filter the selection is holding, which is why it
 * needs no new route. It is also the answer to "what changed" that a refusal
 * declines to compute server-side (`bulk-writes.md` decision 7): comparing the old
 * set to the new one would mean having materialised the old set.
 *
 * **Flat, always.** The captured filter narrows, and `withFilter`'s rule is that a
 * narrowed tree silently drops matches whose ancestors do not match — so a "show
 * me exactly what is selected" that landed in the tree would show *less* than what
 * is selected, which is the one thing this control must not do.
 *
 * There is no explicit-mode counterpart, and that is a real absence rather than an
 * oversight: twelve ids are not expressible as a filter, so the honest version
 * would need a route that takes ids. Filtering the loaded page down to the ticked
 * rows would answer "which of the rows already on screen are selected" — a
 * question the ticks already answer — while calling itself the thing that shows the
 * rest.
 */
export function urlOfCaptured(url: ContentUrl, selection: AllMatching): ContentUrl {
  return {
    ...url,
    view: 'flat',
    state: selection.filter.state ?? 'all',
    type: selection.filter.type,
    q: selection.filter.q ?? '',
  }
}
