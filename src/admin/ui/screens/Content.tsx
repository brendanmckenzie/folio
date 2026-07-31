import type { CSSProperties, KeyboardEvent } from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { DocumentType } from '../../../core/schema'
import type { BulkAction, FlatSort } from '../../../core/story'
import type { BulkRefusal } from '../../../server/bulk'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { List, ListHeader, Row } from '../List'
import { Menu } from '../Menu'
import { href, type Screen } from '../route'
import {
  actionsFor,
  allShownSelected,
  type BulkAnswer,
  type BulkRequest,
  confirmOf,
  type ContentUrl,
  contentQuery,
  type Destination,
  filterOf,
  type Gesture,
  gestureMove,
  isAll,
  isNarrowed,
  isSelected,
  type LevelRow,
  type Matchable,
  type Move,
  NOTHING,
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
  storyRowsOf,
  summarise,
  toggleAllShown,
  toggleSelected,
  type TreeRow,
  urlOfCaptured,
  verbOf,
  type ViewMode,
  type VisibleRow,
  visibleRows,
  withFilter,
  withView,
} from './content-model'
import { ConfirmBulkDialog } from './ConfirmBulkDialog'
import { stateTone, when } from './content-rows'
import css from './Content.module.css'
import { MoveDialog } from './MoveDialog'
import { messageOf, useContent } from './useContent'

interface Props {
  /** Where Folio is mounted, for the real `<a href>` inside each row. */
  mount: string
  /** The admin's internal JSON base — the reads here and the writes the bulk
   * actions make. */
  apiBase: string
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
  onOpen: (screen: Screen) => void
  onNotice: (message: string) => void
  /** The open document, if the editor was reached from here — so walking back to
   * the tree shows you where you were. */
  selected?: string
  /** Declared page types, for the type chips and the create menu. */
  pageTypes: readonly DocumentType[]
  /** The remembered view and sort, used when the URL names neither. */
  remembered: { view: ViewMode; sort: FlatSort }
  onRemember: (next: { view: ViewMode; sort: FlatSort }) => void
}

/** Eight placeholder rows, named rather than indexed — an index key on a list
 * that never reorders is harmless, but writing one teaches the wrong habit for the
 * lists here that do. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']

const STATES = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'changed', label: 'Changed' },
  { value: 'live', label: 'Live' },
  { value: 'unpublished', label: 'Unpublished' },
] as const

const SORTS: { value: FlatSort; label: string }[] = [
  { value: 'edited', label: 'Last edited' },
  { value: 'title', label: 'Title' },
  { value: 'path', label: 'Path' },
]

/**
 * The page tree, given the whole screen instead of 280px — which is most of what
 * `docs/ui-review.md` found wrong with it. The path stops truncating, the state
 * badge and the timestamp fit at once, and the type is a column rather than a word
 * repeated on every row.
 *
 * This is `docs/ui-architecture.md`'s port phase 2, and it replaces the prototype
 * that stood here. Four things changed in the porting, each because the route
 * underneath it did:
 *
 * 1. **It loads one level at a time.** `GET {base}/api/stories` answers a
 *    parent's children over a keyset cursor, so a collapsed node costs nothing and
 *    "Show all 812" is gone. The screen therefore never holds "the tree" — it
 *    holds levels, and `content-model.ts` turns those into rows.
 * 2. **`showType` comes from the manifest, not from what is in use.** The
 *    prototype counted distinct types across the whole tree, which a paged tree
 *    cannot do; and the honest replacement is the declared list, because a column
 *    that appears once you scroll to page three is worse than one that is always
 *    there. If you can filter by type, you can see type.
 * 3. **Filtering moves you to flat mode**, because a filtered tree loaded per
 *    level silently drops matches whose ancestors do not match. The argument, and
 *    the two rejected alternatives, are on `withFilter`.
 * 4. **Keyboard reorder is real**, which was the last open a11y item in
 *    `ROADMAP.md`. `⌥↑ ⌥↓ ⌥← ⌥→` are four `PATCH /stories/:id { parentId, index }`
 *    calls with different arguments; `content-model.ts`'s `gestureMove` is the
 *    arithmetic, and it is where the off-by-one on a downward move lives.
 */
export function Content(props: Props) {
  const { mount, apiBase, pageTypes, onNotice, onQuery, onRemember, onOpen } = props
  const url = parseContentUrl(props.query, props.remembered)
  const filter = filterOf(url)
  const data = useContent(apiBase, url)

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<Selection>(NOTHING)
  const [moving, setMoving] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The job's own `seen`/`total`, while a run takes more than one call. */
  const [progress, setProgress] = useState<string | null>(null)
  /** A confirmation waiting on an answer. */
  const [pending, setPending] = useState<Job | null>(null)
  /** The 409, with the job it refused — so one button can re-post with the count
   * the server just reported. */
  const [refused, setRefused] = useState<{ job: Job; refusal: BulkRefusal } | null>(null)

  const showType = pageTypes.length > 1
  /** Type name → label, so a captured `type` reads as the chip did rather than as
   * the wire value. */
  const labels = useMemo(
    () => Object.fromEntries(pageTypes.map((type) => [type.name, type.label])),
    [pageTypes],
  )

  const go = useCallback(
    (next: ContentUrl) => {
      // Remembered *and* in the URL: linkable first, convenient second — the same
      // rule Assets' grid/table toggle gets. The URL is what a person sends a
      // colleague; the memory is what they get when they arrive without one.
      onRemember({ view: next.view, sort: next.sort })
      onQuery(contentQuery(next))
    },
    [onQuery, onRemember],
  )

  /* ------------------------------------------------------------------ rows --- */

  const rows: VisibleRow[] = useMemo(
    () =>
      url.view === 'tree'
        ? visibleRows(data.levels, expanded)
        : data.flat.rows.map((row, index) => ({
            kind: 'story' as const,
            // Flat rows never disclose, so `childCount` is 0 by construction
            // rather than fetched: the column exists for the tree's twisty and
            // there is no twisty here.
            row: { ...row, childCount: 0 },
            depth: 0,
            parent: ROOT,
            index,
            siblings: data.flat.rows.length,
            expandable: false,
            expanded: false,
          })),
    [url.view, data.levels, data.flat.rows, expanded],
  )
  const stories = useMemo(() => storyRowsOf(rows), [rows])
  /** The rows themselves rather than their ids: a select-all is a *filter*, so
   * deciding whether a row is in it means evaluating that filter against the row.
   * `content-model.ts`'s `isSelected` is where it happens. */
  const visible = useMemo<Matchable[]>(() => stories.map((r) => r.row), [stories])
  const bar = summarise(selection, visible, labels)

  const rootLevel = data.levels[ROOT]
  const loading = url.view === 'tree' ? (rootLevel?.loading ?? true) : data.flat.loading
  const firstLoad = loading && stories.length === 0
  const error = url.view === 'tree' ? rootLevel?.error : data.flat.error
  const total = url.view === 'tree' ? rootLevel?.total : data.flat.total

  const toggleOpen = (row: LevelRow) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(row.id)) {
        next.add(row.id)
        // Asked for on expand rather than up front, which is the whole point of
        // per-level loading. `openLevel` is idempotent, so re-opening a node
        // already fetched costs no request.
        data.openLevel(row.id)
      }
      return next
    })
  }

  /* -------------------------------------------------------------- keyboard --- */

  const patchMove = useCallback(
    async (move: Move) => {
      const res = await fetch(`${apiBase}/stories/${encodeURIComponent(move.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: move.parentId, index: move.index }),
      })
      if (!res.ok) {
        const { error: err } = (await res.json().catch(() => ({}))) as {
          error?: { message?: string }
        }
        throw new Error(err?.message ?? `Move failed (${res.status})`)
      }
    },
    [apiBase],
  )

  const gesture = useCallback(
    async (which: Gesture, at: TreeRow) => {
      if (url.view === 'flat') {
        // Order and structure are the same axis in a tree — `ord` *is* the sibling
        // order — so a reorder inside a list sorted by title or by edit time has
        // no meaning to express. Refused with the reason rather than silently
        // ignored, which is the rule the whole screen follows.
        onNotice('Reordering is a tree operation — switch to Tree to move pages')
        return
      }
      const outcome = gestureMove(which, at, rows, data.levels)
      if ('refusal' in outcome) {
        onNotice(outcome.refusal)
        return
      }
      // Focus survives the reload because rows are keyed by story id and the moved
      // row keeps its own id; the browser restores focus to the same element.
      try {
        await patchMove(outcome.move)
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      }
    },
    [rows, data, url.view, onNotice, patchMove],
  )

  /**
   * → ← and the four ⌥ gestures, for whichever row has focus.
   *
   * Reached through `List`'s `onUnhandledKey` rather than a handler on a wrapper
   * div: the list already knows which row is focused and what index it is, so it
   * hands both over. ↑ ↓ Home End PageUp PageDown never arrive here — those are
   * `List`'s, and it consumed them.
   */
  const onRowKey = (
    e: KeyboardEvent<HTMLDivElement>,
    index: number,
    focus: (i: number) => void,
  ) => {
    const at = stories[index]
    if (!at) return

    if (e.altKey) {
      const which = GESTURES[e.key]
      if (!which) return
      e.preventDefault()
      void gesture(which, at)
      return
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    if (e.key === 'ArrowRight') {
      // → on a closed parent opens it; on an open one it steps to the first child,
      // which is the row physically below. Leaving that to ↓ would mean → doing
      // nothing at all on an already-open node.
      if (at.expandable && !at.expanded) toggleOpen(at.row)
      else focus(index + 1)
      return
    }
    // ← collapses an open node, and steps out to the parent otherwise. The same
    // asymmetry, the other way round.
    if (at.expanded) toggleOpen(at.row)
    else focus(stories.findIndex((r) => r.row.id === at.parent))
  }

  /* ------------------------------------------------------------------ bulk --- */

  /**
   * Ticking a row. In select-all mode this adds to `exclude`, and a row outside the
   * captured conditions cannot join at all — refused with the reason rather than
   * silently doing nothing, which is `toggleSelected`'s whole argument.
   *
   * Computed here rather than inside the `setSelection` updater: an updater has to
   * be a pure function of the previous state, and React calls it twice in
   * development to prove it.
   */
  const tick = (row: Matchable) => {
    const outcome = toggleSelected(selection, row)
    if ('refusal' in outcome) {
      onNotice(outcome.refusal)
      return
    }
    setSelection(outcome.selection)
  }

  /**
   * A whole bulk job: **one `POST {apiBase}/bulk/{action}` per batch**, looped on
   * the report's `continueFrom` until it comes back null.
   *
   * This used to be N sequential per-item calls, and that shape is what made
   * select-all-matching impossible to offer — "select all 51,420 matching" over a
   * per-item loop means fetching 51,420 rows to iterate. It was also quietly wrong
   * in two ways a selection bar makes easy to hit: the loop acted on the *visible*
   * part of the selection only, so publishing a selection that survived a filter
   * change published three of twelve pages; and it passed `index: 0` per document,
   * which landed a moved set reversed.
   *
   * `override` is the corrected selection a 409 re-confirmation carries. It is an
   * argument rather than a state write followed by a run, because the state write
   * would not be visible to this closure until the next render.
   */
  const run = useCallback(
    async (job: Job, override?: Selection) => {
      const target = override ?? selection
      setBusy(true)
      setProgress(null)
      try {
        const result = await runBulkJob((body) => postBulk(apiBase, job.action, body), target, {
          ...(job.destination ? { destination: job.destination } : {}),
          onProgress: (seen, total) => setProgress(progressOf(seen, total)),
        })
        if ('refused' in result) {
          setRefused({ job, refusal: result.refused })
          return
        }
        setSelection(NOTHING)
        data.reload()
        // Once, at the end, over the summed `done` and the concatenated `failed`:
        // both are per call by design, because the server cannot know what an
        // earlier call did.
        onNotice(reportOf(job.action, result.done, result.failed))
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
        setProgress(null)
      }
    },
    [apiBase, data, onNotice, selection],
  )

  /** What a confirmation would say, or null when the action can be taken as read.
   * The rule is `confirmOf`'s; the captured filter is only passed in select-all
   * mode, because that is the only mode with conditions to restate. */
  const confirmation = (action: BulkAction) =>
    confirmOf(action, bar, isAll(selection) ? selection.filter : undefined, labels)

  /** A bar button. Move opens its destination picker, which is its confirmation;
   * everything else asks first when there is something to say. */
  const start = (action: BulkAction) => {
    if (action === 'move') {
      setMoving(true)
      return
    }
    if (confirmation(action)) setPending({ action })
    else void run({ action })
  }

  const ask = pending ? confirmation(pending.action) : null

  /* ------------------------------------------------------------------ view --- */

  if (error && stories.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Content</ListHeader>
        <EmptyState
          title="Could not load the page tree"
          body={error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <>
            <input
              className={css.search}
              type="search"
              value={url.q}
              placeholder="Search pages"
              aria-label="Search pages"
              onChange={(e) => go(withFilter(url, { q: e.target.value }))}
            />
            <NewPageButton
              types={pageTypes}
              apiBase={apiBase}
              onCreated={(id) => {
                data.reload()
                onOpen({ name: 'edit', id })
              }}
              onNotice={onNotice}
            />
          </>
        }
      >
        Content
      </ListHeader>

      <div className={css.controls}>
        {/*
          The toggle. `pagination.md` decision 2a: a tree tells you how the site is
          shaped, a flat sortable list tells you what was touched last, and on a
          large site the second is how a person finds anything.
        */}
        <fieldset className={css.toggle}>
          <legend className={css.srOnly}>View</legend>
          {(['tree', 'flat'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`${css.segment} ${url.view === mode ? css.segmentOn : ''}`}
              aria-pressed={url.view === mode}
              title={
                mode === 'tree' && isNarrowed(filter)
                  ? 'Clears the filters: a tree loads one level at a time, so it cannot show a filtered result without hiding matches'
                  : undefined
              }
              onClick={() => go(withView(url, mode))}
            >
              {mode === 'tree' ? 'Tree' : 'Flat'}
            </button>
          ))}
        </fieldset>

        <fieldset className={css.chips}>
          <legend className={css.srOnly}>Filter by state</legend>
          {STATES.map((state) => (
            <button
              key={state.value}
              type="button"
              className={`${css.chip} ${url.state === state.value ? css.chipOn : ''}`}
              aria-pressed={url.state === state.value}
              onClick={() => go(withFilter(url, { state: state.value }))}
            >
              {state.label}
            </button>
          ))}
        </fieldset>

        {/* Only when there is a choice to make. One page type means the chip set
            would be "All" and one other thing that selects the same rows. */}
        {showType ? (
          <fieldset className={css.chips}>
            <legend className={css.srOnly}>Filter by type</legend>
            <button
              type="button"
              className={`${css.chip} ${url.type === undefined ? css.chipOn : ''}`}
              aria-pressed={url.type === undefined}
              onClick={() => go(withFilter(url, { type: undefined }))}
            >
              Any type
            </button>
            {pageTypes.map((type) => (
              <button
                key={type.name}
                type="button"
                className={`${css.chip} ${url.type === type.name ? css.chipOn : ''}`}
                aria-pressed={url.type === type.name}
                onClick={() => go(withFilter(url, { type: type.name }))}
              >
                {type.label}
              </button>
            ))}
          </fieldset>
        ) : null}

        {url.view === 'flat' ? (
          <label className={css.sort}>
            Sort
            <select
              value={url.sort}
              onChange={(e) => go({ ...url, sort: e.target.value as FlatSort })}
            >
              {SORTS.map((sort) => (
                <option key={sort.value} value={sort.value}>
                  {sort.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {bar.count > 0 ? (
        <SelectionBar
          summary={bar}
          busy={busy}
          progress={progress}
          actions={actionsFor(selection)}
          onClear={() => setSelection(NOTHING)}
          onRun={start}
          // Only a select-all can show what it selected: a captured filter is a URL
          // and twelve ids are not. `urlOfCaptured` carries the argument.
          onShowSelected={isAll(selection) ? () => go(urlOfCaptured(url, selection)) : undefined}
        />
      ) : null}

      {firstLoad ? (
        <div className={css.skeletons} aria-hidden="true">
          {/* Skeleton rows, not a spinner: `--row-h` is fixed, so the shape of the
              answer is known before it arrives and the screen does not jump. */}
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : stories.length === 0 ? (
        <EmptyState
          title={isNarrowed(filter) ? 'Nothing matches' : 'No pages yet'}
          body={
            isNarrowed(filter)
              ? 'Try a different state, or clear the search.'
              : 'A page is a document in the tree. Every one of them has a URL.'
          }
          action={
            isNarrowed(filter) ? (
              <Button size="sm" onClick={() => go(withView(url, 'tree'))}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <List
          label={url.view === 'tree' ? 'Page tree' : 'Pages'}
          tree={url.view === 'tree'}
          multiselect
          onUnhandledKey={onRowKey}
        >
          {rows.map((row) =>
            row.kind === 'more' ? (
              <MoreRow
                key={`more:${row.parent}`}
                row={row}
                onMore={() => data.moreOfLevel(row.parent)}
              />
            ) : (
              <PageRow
                key={row.row.id}
                at={row}
                tree={url.view === 'tree'}
                mount={mount}
                showType={showType}
                typeLabel={pageTypes.find((t) => t.name === row.row.type)?.label}
                ticked={isSelected(selection, row.row)}
                current={row.row.id === props.selected}
                onToggleOpen={() => toggleOpen(row.row)}
                onToggleTick={() => tick(row.row)}
                onOpen={() => onOpen({ name: 'edit', id: row.row.id })}
              />
            ),
          )}
        </List>
      )}

      <div className={css.footer}>
        <button
          type="button"
          className={css.selectAll}
          onClick={() => setSelection((prev) => toggleAllShown(prev, visible))}
          disabled={visible.length === 0}
        >
          {allShownSelected(selection, visible) ? 'Deselect all shown' : 'Select all shown'}
        </button>
        {/*
          Select-all-matching, and **only in flat mode**. `expected` has to be the
          count of the set the guard will re-run, and the only count this screen is
          shown is the one beside it: in flat mode that is the whole filter's total,
          while in tree mode it is the *top level*'s. Offering it over the tree's
          number would capture 12 and mean 51,420, so the control is absent there
          rather than disabled — there is no version of it a tree can honestly draw.
        */}
        {url.view === 'flat' && total !== undefined && !isAll(selection) ? (
          <button
            type="button"
            className={css.selectAll}
            onClick={() => setSelection(selectAllMatching(filter, total))}
            disabled={total === 0}
          >
            {selectAllLabel(total)}
          </button>
        ) : null}
        {/*
          `Showing n of N`, which is the owner's answer to the paging control
          (Resolved 5): next / previous plus an exact count, never "page 3 of 7".
          In tree mode the count is the *top level*'s, because that is the list the
          number is next to — a site-wide total beside a tree would be a number
          nothing on screen adds up to.
        */}
        <span className={css.count}>
          {total === undefined
            ? `${stories.length} shown`
            : url.view === 'tree'
              ? `${rootLevel?.rows.length ?? 0} of ${total} top-level pages`
              : `${stories.length} of ${total} pages`}
        </span>
        {url.view === 'flat' ? (
          <span className={css.pager}>
            <Button
              size="sm"
              disabled={!data.canGoBack}
              reason="This is the first page"
              onClick={data.prevPage}
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={data.flat.cursor === null}
              reason="This is the last page"
              onClick={data.nextPage}
            >
              Next
            </Button>
          </span>
        ) : null}
      </div>

      {moving ? (
        <MoveDialog
          apiBase={apiBase}
          count={bar.count}
          // The picker is the move's confirmation, so it carries the sentence about
          // the invisible part rather than a second dialog appearing behind it.
          note={confirmation('move')?.body}
          onClose={() => setMoving(false)}
          onConfirm={(parentId) => {
            setMoving(false)
            void run({ action: 'move', destination: { parentId } })
          }}
        />
      ) : null}

      {pending && ask ? (
        <ConfirmBulkDialog
          confirmation={ask}
          confirmLabel={verbOf(pending.action)}
          onClose={() => setPending(null)}
          onConfirm={() => {
            const job = pending
            setPending(null)
            void run(job)
          }}
        />
      ) : null}

      {/*
        The 409. A door rather than a wall: the set moved between the number the
        person read and the button they pressed, so the new count is in the sentence
        and one button re-posts with it as `expected`. Only reachable in select-all
        mode, because the count guard is what an explicit id list does not have — the
        ids *are* the version of the set.
      */}
      {refused && isAll(selection) ? (
        <ConfirmBulkDialog
          confirmation={refusalOf(refused.job.action, refused.refusal)}
          confirmLabel={retryLabel(refused.job.action, refused.refusal)}
          onClose={() => setRefused(null)}
          onConfirm={() => {
            const { job, refusal } = refused
            const corrected: Selection = { ...selection, expected: refusal.actual }
            setRefused(null)
            setSelection(corrected)
            void run(job, corrected)
          }}
        />
      ) : null}
    </div>
  )
}

/** One bulk job in flight or awaiting confirmation: what to do, and for a move,
 * where. */
interface Job {
  action: BulkAction
  destination?: Destination
}

/* ------------------------------------------------------------------- a row --- */

function PageRow({
  at,
  tree,
  mount,
  showType,
  typeLabel,
  ticked,
  current,
  onToggleOpen,
  onToggleTick,
  onOpen,
}: {
  at: { kind: 'story' } & TreeRow
  tree: boolean
  mount: string
  showType: boolean
  typeLabel: string | undefined
  ticked: boolean
  current: boolean
  onToggleOpen: () => void
  onToggleTick: () => void
  onOpen: () => void
}) {
  const { row } = at
  return (
    <Row
      depth={at.depth}
      tree={tree}
      {...(at.expandable ? { expanded: at.expanded } : {})}
      selected={ticked}
      current={current}
      onOpen={onOpen}
      onSelect={onToggleTick}
      lead={
        <input
          type="checkbox"
          className={css.tick}
          checked={ticked}
          // Held out of the tab order: the list is one tab stop by design (roving
          // tabindex), and a checkbox per row would make a hundred-row list a
          // hundred stops. Space on the focused row is the keyboard route, which
          // is `Row`'s `onSelect`.
          tabIndex={-1}
          aria-label={`Select ${row.title || 'Untitled'}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleTick}
        />
      }
      handle={
        at.expandable ? (
          <button
            type="button"
            className={css.twisty}
            data-open={at.expanded ? '' : undefined}
            aria-label={`${at.expanded ? 'Collapse' : 'Expand'} ${row.title}`}
            // No `aria-expanded` here: the treeitem around it already carries it,
            // and two elements announcing the same state is one of them lying as
            // soon as they disagree.
            onClick={(e) => {
              // The row's own click opens the document. A twisty inside it must
              // not do both.
              e.stopPropagation()
              onToggleOpen()
            }}
          >
            ›
          </button>
        ) : (
          // A leaf still owes the column its width, or every leaf title sits 16px
          // left of its siblings' and the indent stops reading as depth.
          <span className={css.twistySpacer} />
        )
      }
      /*
       * The slug in tree mode, the **full path** in flat.
       *
       * `pagination.md` phase 7 item 3, and it is the opposite rule in each view
       * for one reason: inside a tree the indent carries the ancestry, so a path
       * would repeat what the shape already says; in a flat list there is no
       * indent, so the slug alone cannot tell `/about/team` from `/careers/team`.
       */
      meta={tree ? (row.slug === '' ? '/' : row.slug) : row.path === '' ? '/' : `/${row.path}`}
      trailing={
        // Fixed-width columns rather than a flex run of chips. Right-aligned
        // metadata is the correct pattern for a list row, but the first version
        // let each cell size to its content, so `live · 2m ago` and `draft · 22 Jan`
        // put their badges at different x positions on adjacent rows — which is
        // what makes a wide list read as scattered instead of tabular.
        <span className={css.cols} data-typed={showType ? '' : undefined}>
          {showType ? <Badge>{typeLabel ?? row.type}</Badge> : null}
          <Badge tone={stateTone(row.state)}>{row.state}</Badge>
          <span className={css.stamp}>{when(row)}</span>
        </span>
      }
    >
      {/* A real link inside the row, so the title is cmd-clickable and copyable
          even though the whole row is clickable too. */}
      <a
        className={css.title}
        href={href({ name: 'edit', id: row.id }, mount)}
        // The row is already handling the click and navigating; letting this
        // bubble would do it twice.
        onClick={(e) => e.stopPropagation()}
      >
        {row.title || <span className={css.untitled}>Untitled</span>}
      </a>
    </Row>
  )
}

/** The rest of an incomplete level. See `Level` in `content-model.ts` for why a
 * tree appends rather than paging next / previous. */
function MoreRow({
  row,
  onMore,
}: {
  row: Extract<VisibleRow, { kind: 'more' }>
  onMore: () => void
}) {
  const remaining = row.total === undefined ? undefined : row.total - row.loaded
  return (
    <div className={css.moreRow} style={{ '--depth': row.depth } as CSSProperties}>
      <span className={css.moreIndent} />
      <button type="button" className={css.more} disabled={row.loading} onClick={onMore}>
        {row.loading
          ? 'Loading…'
          : remaining === undefined
            ? 'Show more'
            : `Show ${remaining} more`}
      </button>
    </div>
  )
}

/* --------------------------------------------------------------- the bar --- */

function SelectionBar({
  summary,
  busy,
  progress,
  actions,
  onClear,
  onRun,
  onShowSelected,
}: {
  summary: ReturnType<typeof summarise>
  busy: boolean
  /** The job's own progress, while a run takes more than one call. */
  progress: string | null
  /** Which of the five this selection may be given — `duplicate` is absent for a
   * select-all, because the server refuses it there and an impossible control is
   * absent rather than disabled. */
  actions: readonly BulkAction[]
  onClear: () => void
  onRun: (action: BulkAction) => void
  /** Absent for an explicit selection: twelve ids are not a filter, so there is no
   * URL that shows them. */
  onShowSelected?: () => void
}) {
  return (
    // `role="status"`, so the count and the mode are announced when they change:
    // "acting on more than you can see" is the hazard this bar exists to name, and
    // a sighted user reads it while a screen reader user would otherwise not be
    // told at all. A literal rather than an expression, because an `aria-*` or a
    // `role` computed from state is one Biome cannot verify — and switching from
    // twelve ids to "all 51,420 matching" changes this text, which is exactly the
    // change that has to be announced.
    <div className={css.bar} role="status">
      <span className={css.barCount}>{progress ?? summary.text}</span>
      <span className={css.barActions}>
        {onShowSelected ? (
          <Button size="sm" variant="subtle" disabled={busy} onClick={onShowSelected}>
            Show only selected
          </Button>
        ) : null}
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            {...(action === 'delete' ? { variant: 'danger' as const } : {})}
            disabled={busy}
            onClick={() => onRun(action)}
          >
            {ACTION_LABELS[action]}
          </Button>
        ))}
        <Button size="sm" variant="subtle" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </span>
    </div>
  )
}

/** The bar's buttons. `Move…` keeps its ellipsis because it opens a dialog rather
 * than acting, which is the same convention the palette follows. */
const ACTION_LABELS: Record<BulkAction, string> = {
  publish: 'Publish',
  unpublish: 'Unpublish',
  duplicate: 'Duplicate',
  move: 'Move…',
  delete: 'Delete',
}

/* ------------------------------------------------------------------ create --- */

/**
 * One affordance while there is one thing it could mean; a menu the moment there
 * is a choice — the rule `document-types.md` phase 3 already established for the
 * old tree's `+ New`.
 *
 * `under` is deliberately **not** applied here: the button creates at the top
 * level, and every declared page type can go there unless its own `under` says
 * otherwise. Creating *inside* a page is the row's `+`, which port phase 7 brings
 * back with the editor — this is the screen-level create and nothing more.
 */
function NewPageButton({
  types,
  apiBase,
  onCreated,
  onNotice,
}: {
  types: readonly DocumentType[]
  apiBase: string
  onCreated: (id: string) => void
  onNotice: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  const top = types.filter((t) => (t.under ?? []).length === 0)

  const create = async (type: string | undefined) => {
    setPending(true)
    try {
      const res = await fetch(`${apiBase}/stories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled', parentId: null, ...(type ? { type } : {}) }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        throw new Error(body.error?.message ?? `Could not create the page (${res.status})`)
      }
      onCreated(((await res.json()) as { id: string }).id)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (top.length > 1) {
    return (
      <Menu
        align="end"
        trigger="New page"
        items={top.map((type) => ({
          id: type.name,
          label: type.label,
          run: () => void create(type.name),
        }))}
      />
    )
  }
  return (
    <Button
      variant="primary"
      size="sm"
      disabled={pending || top.length === 0}
      reason={top.length === 0 ? 'No page type may be created at the top level' : 'Creating…'}
      onClick={() => void create(top[0]?.name)}
    >
      New page
    </Button>
  )
}

/* ------------------------------------------------------------------ writes --- */

/**
 * One batch of one bulk action: `POST {apiBase}/bulk/{action}`.
 *
 * **One route per action, not one route with the action in the body**, and the
 * reason is the gate: each of the five carries the same `requireAccess` its
 * single-document twin carries, so bulk publishing forty pages is neither more nor
 * less privileged than publishing forty pages by hand (`bulk-writes.md`
 * decision 1). `delete` keeps `redirect` at its default rather than sending it, for
 * the same reason the single-document route defaults it to true.
 *
 * A **409 is not an error here.** It is the count guard refusing a set that moved,
 * and its body is the error envelope *plus* the two counts — so it comes back as a
 * value the caller can offer a button for, rather than a thrown message.
 */
async function postBulk(
  apiBase: string,
  action: BulkAction,
  body: BulkRequest,
): Promise<BulkAnswer> {
  const res = await fetch(`${apiBase}/bulk/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as Partial<BulkRefusal> & {
      error?: { message?: string }
    }
    // Narrowed rather than trusted: `error` is where every client already looks, so
    // a 409 that is *not* the count guard — a conflict thrown by a hook, say — still
    // reads as a sentence rather than as a refusal with `undefined` in it.
    if (body.refused === 'count' && typeof body.actual === 'number') {
      return { refused: 'count', expected: body.expected ?? 0, actual: body.actual }
    }
    throw new Error(body.error?.message ?? 'HTTP 409')
  }
  if (!res.ok) throw new Error(await messageOf(res))
  return (await res.json()) as BulkAnswer
}

/**
 * Which gesture an ⌥-arrow means. A table rather than a nested ternary, because
 * four two-word branches read as four rules and a ternary chain reads as one
 * expression nobody checks.
 */
const GESTURES: Record<string, Gesture | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'out',
  ArrowRight: 'in',
}
