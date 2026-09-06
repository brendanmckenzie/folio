import type { KeyboardEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import type {
  AssetBulkAction,
  AssetFilter,
  AssetFolder,
  AssetSort,
  AssetTag,
} from '../../../core/assets'
import type { BulkFailure, BulkRefusal, BulkReport } from '../../../core/bulk'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Field, Input, Select } from '../Field'
import { type Column, Table } from '../Table'
import {
  addedAgo,
  ASSET_COLUMNS,
  type AssetColumn,
  type AssetRow,
  type AssetsUrl,
  type AssetView,
  dimensionsOf,
  dirOf,
  folderDepth,
  gridStep,
  humanSize,
  indentedFolderName,
  isNarrowed,
  isRenderableImage,
  KINDS,
  sortColumnKey,
  tagChipLabel,
  thumbUrl,
  toggleTagFilter,
  typeLabel,
  uploadSummary,
  withFilter,
  withSort,
  withView,
} from './assets-model'
import css from './Assets.module.css'
import type { AssetsData, Uploads } from './useAssets'
import { messageOf } from './useContent'
import { useDescribe } from './useDescribe'
import { type FoldersData, useFolders } from './useFolders'
import { type TagsData, useTags } from './useTags'

/**
 * The width asked of the transform route, per surface. Three values and no more:
 * every distinct clamped transform is its own billable Images invocation and its own
 * immutable cache entry, so a width per breakpoint would multiply the library by the
 * number of breakpoints. These are generous enough to stay sharp on a 2× display at
 * the CSS sizes in `Assets.module.css`, and the browser downscales.
 */
const TILE_WIDTH = 320
const CELL_WIDTH = 96

/** Placeholder tiles and rows. Named rather than indexed, matching Content's and
 * Documents'. */
const SKELETONS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12']

const SORTS: readonly { value: AssetSort; label: string }[] = [
  { value: 'created', label: 'Date added' },
  { value: 'filename', label: 'Filename' },
  { value: 'size', label: 'Size' },
]

export interface AssetBrowserProps {
  /** The admin's internal JSON base — `{base}/api`. The sidebar's own reads and
   * writes (`useFolders`, `useTags`, and the *New folder* dialog) go through it,
   * same as everything else in this admin. */
  apiBase: string
  /**
   * Where Folio is mounted — **not** `apiBase`. `/asset/:key` serves bytes into an
   * `<img>` and stays on the bare mount, because its URL is baked into published
   * HTML through `Resolution.assetBase`.
   */
  mount: string
  url: AssetsUrl
  onUrl: (next: AssetsUrl) => void
  data: AssetsData
  upload: Uploads
  /** The row this surface is pointing at. What that *means* is the mount's business
   * — see the header. */
  selected: string | undefined
  onSelect: (id: string) => void
  /** The list's accessible name, which differs by mount: the screen's subject is
   * the library, the picker's is a choice. */
  label: string
  /**
   * Whether the type chips are offered. Absent (false) when the mount has imposed a
   * kind of its own — a field whose `accept` is `image/*` — because widening it
   * would offer a file the field cannot store. Impossible controls are absent.
   */
  kinds?: boolean
  /** Passed to the file input only. The *listing* is narrowed server-side through
   * `?kind=`; see `kindForAccept`. */
  accept?: string
  /**
   * The dialog mount: tighter tiles, one column fewer, and no *New folder* dialog —
   * a second `useFocusTrap` inside the picker's own is the bug that guard exists for.
   *
   * **Not the scrolling.** Both mounts frame the browser and scroll `.results`
   * inside it; they differ only in where the height comes from, which is the mount's
   * business and is settled in CSS (`Dialog`'s `.fill` body, or `.screen`'s own
   * height above 1100px). See the chain's note in `Assets.module.css`.
   */
  compact?: boolean
  /**
   * Whether the **selection layer** is offered: a checkbox per tile and per row,
   * a bar over the grid, *select all matching*, and the four bulk actions.
   *
   * A prop the screen passes and the picker does not, exactly as `kinds` works —
   * and for a stronger reason than "the picker has no use for it". Every one of
   * the four actions opens a `Dialog`, and the picker's own `AssetBrowser`
   * already sits inside `AssetPicker.tsx`'s `Dialog`; two mounted `useFocusTrap`
   * instances fight over every Tab press, which is the bug phase 4 hit with the
   * *New folder* dialog and fixed with `compact`. Filing forty files is a
   * library-management gesture and belongs on the screen; picking one is what the
   * picker is for.
   */
  bulk?: boolean
  /**
   * How a completed bulk run reports itself. Screen-only, like `bulk` — and
   * absent for the picker deliberately, which is `AssetPicker.tsx`'s own rule
   * (it takes no `onNotice`, because a dialog has nowhere to put a toast).
   */
  onNotice?: (message: string) => void
}

/**
 * **The browsing surface, and there is exactly one of it.**
 *
 * `docs/ui-architecture.md`'s Assets section ends with the sentence this component
 * exists to satisfy: *"picking an asset for a field is still a modal, and it is the
 * same grid in a `Dialog` at `wide`. One implementation, two mounts."* So this holds
 * the search box, the type chips, the `[ Grid | Table ]` toggle, the sort, the tiles,
 * the table, the skeletons, the empty state, the upload control and the pager — and
 * `Assets.tsx` renders it full width while `AssetPicker.tsx` renders it inside a
 * dialog.
 *
 * **The seam is a selection, and nothing else.** This component knows which row is
 * pointed at and reports when that changes; it does not know whether pointing at a
 * row opens a detail panel (the screen) or arms a *Use this file* button (the
 * picker). That is what keeps the two mounts from growing separate grids:
 *
 *  - It takes `url` and `onUrl` rather than reading a URL. The screen's state lives
 *    in the address bar and the picker's lives in `useState`, and neither fact
 *    reaches in here.
 *  - It takes `data` and `upload` rather than calling the hooks itself, for the same
 *    reason: the screen's upload callback selects what was just uploaded and the
 *    picker's does not.
 *  - **It has no `onChoose`.** An earlier shape gave it a *choose* affordance per
 *    tile and a double-click accelerator, which made the picker's commit exist in
 *    three places and only one of them keyboard-operable. The dialog's footer is the
 *    single commit, over the selection this reports.
 */
export function AssetBrowser(props: AssetBrowserProps) {
  const { apiBase, mount, url, onUrl, data, upload, selected, label, kinds, accept, compact } =
    props
  const { bulk, onNotice } = props
  const grid = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)

  /**
   * **One instance of each per mount**, held here rather than in `Sidebar`.
   *
   * Phase 4 gave the sidebar its own `useFolders`/`useTags` and named the cost:
   * two independent copies whenever the detail panel is open beside it. This
   * phase adds a third and fourth consumer — the bulk *Tag* and *Move* dialogs
   * pick from exactly the same two lists — and four copies of one fetch is the
   * point at which lifting it one level is cheaper than explaining it again. The
   * detail panel's own copies are still its own: that component is mounted by
   * `Assets.tsx`, not by this one, and threading a hook's value through a
   * screen to a sibling is a bigger change than this phase owes.
   */
  const folders = useFolders(apiBase)
  const tags = useTags(apiBase)
  /** Whether this deployment describes anything. Absent config draws no control
   * at all rather than one that answers `unsupported` when it is pressed. */
  const describe = useDescribe(apiBase)

  /**
   * The bulk selection. `NOTHING` unless `bulk` is set, in which case the
   * checkbox layer writes to it — a captured *select all* included, which is
   * why this is a discriminated union rather than a `Set`.
   */
  const [ticked, setTicked] = useState<Ticked>(NOTHING)
  /** Which bulk dialog is open, or null. One at a time by construction: the
   * state is a single value, not four booleans. */
  const [job, setJob] = useState<AssetBulkAction | null>(null)
  const [running, setRunning] = useState(false)
  /**
   * What the delete confirmation's dry run found — `usedOnPublished`, or the
   * reason it could not be asked.
   *
   * Held **here**, and fired by the button that opens the dialog rather than by
   * the dialog itself: a probe started while the dialog renders is a side effect
   * in render, and one started in its `useEffect` needs a dependency list over a
   * `selection` object that is rebuilt every render. The gesture is what asks.
   */
  const [probe, setProbe] = useState<{ used: number | null; error: string | null }>({
    used: null,
    error: null,
  })

  /**
   * The describe run, or null when its panel is closed.
   *
   * **A panel rather than a fifth bulk dialog**, because this is the one action
   * here that takes minutes rather than seconds: it is N calls to somebody
   * else's model API, ten per batch, and a dialog that said *Working…* over four
   * thousand files would be a spinner somebody watches for an hour with no way
   * to tell whether it is progressing or wedged. So the batches are reported as
   * they land and there is a *Stop*, which costs nothing to offer precisely
   * because decision 10 put the cursor in the caller's hand: stopping is not
   * cancelling a job, it is declining to ask for the next batch.
   */
  const [describeRun, setDescribeRun] = useState<DescribeRunState | null>(null)
  /** Read between batches. A ref rather than state because the loop below reads
   * it after an `await` and would otherwise close over the value it started
   * with — the classic version of this bug is a *Stop* that does nothing. */
  const stopping = useRef(false)

  const rows = data.page.rows
  const firstLoad = data.page.loading && rows.length === 0
  const narrowed = isNarrowed(url)
  const columns = compact
    ? ASSET_COLUMNS.filter((column) => column.kind !== 'dimensions')
    : ASSET_COLUMNS

  /**
   * Which tile carries the tab stop. Roving tabindex, the same property `List.tsx`
   * gives a list: the grid is **one** stop in the page's tab order and the arrows
   * move within it — a 48-tile grid with a stop per tile is 48 stops between the
   * search box and the pager.
   *
   * The first tile when nothing is selected, so tabbing in always lands somewhere.
   */
  const focusable = selected && rows.some((row) => row.id === selected) ? selected : rows[0]?.id

  /**
   * Arrow keys across the grid. The arithmetic is `gridStep` in the model — pure and
   * tested — and what is left here is the two things only the DOM can answer: which
   * tile has focus, and how many tiles are in a row.
   *
   * **Focus moves; it does not select.** A single-select listbox conventionally moves
   * selection with focus, and here that would fire a `replaceState` and a usage fetch
   * per arrow key. Enter or Space selects, which is also the rule `List.tsx`'s `Row`
   * follows.
   */
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const box = grid.current
    if (!box) return
    const tiles = [...box.querySelectorAll<HTMLElement>('[data-tile]')]
    const active = document.activeElement
    const current = active instanceof HTMLElement ? tiles.indexOf(active) : -1
    const next = gridStep(e.key, current, tiles.length, columnsOf(tiles))
    if (next === null) return
    e.preventDefault()
    tiles[next]?.focus()
  }

  /**
   * A finished run: say what happened, drop the selection, and re-read.
   *
   * The selection is cleared rather than kept, and that is the safe direction:
   * a captured *select all* that survived a delete would still claim its
   * `expected`, and the very next action over it would be refused by the count
   * guard — a correct refusal that reads as a bug. Ticked ids that no longer
   * exist have the same problem one row at a time.
   */
  const finished = (
    action: AssetBulkAction,
    outcome: { done: number; failed: BulkFailure[] } | { refused: BulkRefusal },
  ) => {
    setJob(null)
    if ('refused' in outcome) {
      // A door, not a wall: the refusal carries the *new* count, so the
      // selection is re-captured at it and pressing the same button again is
      // the whole recovery.
      setTicked((prev) => (prev.all ? { ...prev, expected: outcome.refused.actual } : prev))
      onNotice?.(
        `The library changed while you were choosing: ${outcome.refused.actual} files match now, not ${outcome.refused.expected}. Check the number and try again.`,
      )
      return
    }
    setTicked(NOTHING)
    data.reload()
    // The vocabulary's counts moved, and a tag can have been left carrying
    // nothing at all.
    if (action === 'tag' || action === 'untag') tags.reload()
    onNotice?.(runSummary(action, outcome.done, outcome.failed))
  }

  const run = async (action: AssetBulkAction, extra: Record<string, unknown> = {}) => {
    setRunning(true)
    try {
      finished(action, await runAssetJob(apiBase, action, { selection: bodyOf(ticked), ...extra }))
    } catch (e) {
      setJob(null)
      onNotice?.((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  /** Opens the delete confirmation and asks, in that order: the dialog paints
   * immediately and fills its warning in, rather than the button hanging for a
   * round trip with nothing on screen. */
  const askDelete = async () => {
    setProbe({ used: null, error: null })
    setJob('delete')
    try {
      const outcome = await runAssetJob(apiBase, 'delete', {
        selection: bodyOf(ticked),
        dryRun: true,
      })
      if ('refused' in outcome) {
        setProbe({
          used: null,
          error: `${outcome.refused.actual} files match now, not ${outcome.refused.expected}. Close this and choose again.`,
        })
      } else setProbe({ used: outcome.usedOnPublished ?? 0, error: null })
    } catch (e) {
      setProbe({ used: null, error: (e as Error).message })
    }
  }

  /**
   * The body a describe run posts, built **once** and posted by both the dry run
   * and the real one — so the number somebody read is the number the count guard
   * re-checks, and a *select all* cannot be previewed as one set and run over
   * another.
   *
   * `backlogOnly` is the only thing that reshapes it, and it is offered for a
   * captured *select all* alone: it adds `undescribed` to the filter and reads
   * the count **for that narrowed filter**, because `expected` has to be the
   * count of the set actually being run over or the guard refuses every time.
   * For a ticked list of ids there is nothing to narrow — those files were
   * chosen one at a time.
   */
  const describeBody = async (backlogOnly: boolean): Promise<Record<string, unknown>> => {
    if (!ticked.all || !backlogOnly) return bodyOf(ticked)
    const filter: AssetFilter = { ...ticked.filter, undescribed: true }
    return {
      all: true,
      filter,
      expected: await countMatching(apiBase, filter),
      // Kept, not dropped: a file somebody ticked off must stay untouched. It
      // may not be in the narrowed set at all, which makes the job's ceiling an
      // under-count and stops the walk early — the safe direction, and the only
      // one available without materialising ids.
      ...(ticked.exclude.size === 0 ? {} : { exclude: [...ticked.exclude] }),
    }
  }

  /** Opens the panel and asks what the run would do — `dryRun`, which calls the
   * host's function zero times and answers the job's total. */
  const previewDescribe = async (backlogOnly: boolean) => {
    setDescribeRun({
      backlogOnly,
      body: null,
      total: null,
      error: null,
      running: false,
      progress: null,
      finished: false,
    })
    try {
      const body = await describeBody(backlogOnly)
      const outcome = await postDescribe(apiBase, { ...body, dryRun: true })
      setDescribeRun((prev) =>
        prev === null
          ? prev
          : 'refused' in outcome
            ? { ...prev, error: refusedText(outcome.refused) }
            : { ...prev, body, total: outcome.total },
      )
    } catch (e) {
      setDescribeRun((prev) => (prev === null ? prev : { ...prev, error: (e as Error).message }))
    }
  }

  /**
   * The run itself: post, read the report, post again with its cursor.
   *
   * **Loop on `continueFrom`, never on `seen < total`**, and stop on a cursor
   * that did not move — `runAssetJob`'s rule, and it matters more here, because
   * a spin costs a model call per iteration rather than a D1 read.
   */
  const startDescribe = async () => {
    const body = describeRun?.body
    if (!body) return
    stopping.current = false
    setDescribeRun((prev) =>
      prev === null ? prev : { ...prev, running: true, progress: emptyRun() },
    )

    let continueFrom: string | null = null
    const totals = emptyRun()
    try {
      for (;;) {
        const outcome = await postDescribe(apiBase, {
          ...body,
          ...(continueFrom === null ? {} : { continueFrom }),
        })
        if ('refused' in outcome) {
          setDescribeRun((prev) =>
            prev === null ? prev : { ...prev, error: refusedText(outcome.refused) },
          )
          break
        }
        totals.seen = outcome.seen
        totals.done += outcome.done
        totals.skipped += outcome.skipped
        totals.tagsIgnored += outcome.tagsIgnored
        totals.failed = [...totals.failed, ...outcome.failed]
        setDescribeRun((prev) => (prev === null ? prev : { ...prev, progress: { ...totals } }))
        if (outcome.continueFrom === null || outcome.continueFrom === continueFrom) break
        continueFrom = outcome.continueFrom
        // Between batches, never mid-batch: the ten calls already in flight are
        // paid for either way, and abandoning their answers would waste them.
        if (stopping.current) break
      }
    } catch (e) {
      setDescribeRun((prev) => (prev === null ? prev : { ...prev, error: (e as Error).message }))
    } finally {
      setDescribeRun((prev) => (prev === null ? prev : { ...prev, running: false, finished: true }))
      // Only when a batch actually ran. A refusal on the first call — the count
      // guard, before a single model call — is reported in the panel, and a
      // toast reading "Described 0 files" beside it would be the same event told
      // twice and wrongly.
      if (totals.seen > 0) {
        // The rows carry machine text now, and the vocabulary's counts moved
        // with whatever the model chose from it.
        data.reload()
        tags.reload()
        onNotice?.(describeRunSummary(totals))
      }
    }
  }

  const count = tickCount(ticked)
  const allShown = rows.length > 0 && rows.every((row) => isTicked(ticked, row.id))
  const tick = (id: string) => setTicked((prev) => toggleTick(prev, id))

  const report = uploadSummary(upload.entries)

  const uploadButton = (
    <Button
      size="sm"
      variant="primary"
      disabled={upload.busy}
      reason="Uploading…"
      onClick={() => file.current?.click()}
    >
      Upload
    </Button>
  )

  return (
    <div className={css.browser}>
      {/*
        The real file input, always present. Dropping is the fast path and it is a
        pointer gesture, so it can never be the only one — `ui-architecture.md`'s
        acceptance for every phase includes "fully keyboard-operable".
      */}
      <input
        ref={file}
        type="file"
        multiple
        accept={accept}
        className={css.srOnly}
        aria-label="Upload files"
        onChange={(e) => {
          upload.add(e.target.files)
          // Cleared so choosing the same file twice in a row is two uploads rather
          // than one and then silence.
          e.target.value = ''
        }}
      />

      <div className={css.layout}>
        {/*
          The folder tree and the tag chips — filters, never a place to navigate
          into (decision 2, checkpoint 10). One instance per mount, same as
          everything else `AssetBrowser` holds: the screen and the picker each get
          their own sidebar over the same routes.
        */}
        <Sidebar
          folders={folders}
          tags={tags}
          url={url}
          onUrl={onUrl}
          compact={compact}
          {...(onNotice ? { onNotice } : {})}
        />

        <div className={css.main}>
          <div className={css.controls}>
            <input
              className={css.search}
              type="search"
              value={url.q}
              placeholder="Search filenames"
              aria-label="Search filenames"
              onChange={(e) => onUrl(withFilter(url, { q: e.target.value }))}
            />

            {/*
          The `[ Grid | Table ]` toggle. `ui-architecture.md` gives Assets exactly the
          rule Content's `[ Tree | Flat ]` has — the mode is in the URL and the last
          choice is remembered as the default when arriving without one, linkable
          first and convenient second. Unlike Content's, it keeps the filters: see
          `withView`.
        */}
            <fieldset className={css.toggle}>
              <legend className={css.srOnly}>View</legend>
              {(['grid', 'table'] as AssetView[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${css.segment} ${url.view === mode ? css.segmentOn : ''}`}
                  aria-pressed={url.view === mode}
                  onClick={() => onUrl(withView(url, mode))}
                >
                  {mode === 'grid' ? 'Grid' : 'Table'}
                </button>
              ))}
            </fieldset>

            {kinds ? (
              <fieldset className={css.chips}>
                <legend className={css.srOnly}>Filter by type</legend>
                {KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    type="button"
                    className={`${css.chip} ${url.kind === kind.value ? css.chipOn : ''}`}
                    aria-pressed={url.kind === kind.value}
                    onClick={() => onUrl(withFilter(url, { kind: kind.value }))}
                  >
                    {kind.label}
                  </button>
                ))}
              </fieldset>
            ) : null}

            {/*
              The backlog split, as two filters rather than as a mode — drawn
              only where the host configured a `describe`, because "never
              described" and "failed to describe" are not distinctions on a
              site that describes nothing.

              Both sit with `kind` rather than in the sidebar because they
              narrow the *grid* the way a type does, and both deliberately
              clear nothing: a backlog or a failure is a question asked inside
              a folder, a tag or a search, and every one of those combinations
              means something — including each other, since "never attempted"
              and "attempted and failed" cannot both be true of one row and so
              can only ever narrow to an (honest) empty grid. The run panel's
              own *backlog only* checkbox is a different control over a
              different thing — that one narrows the job, this one narrows the
              screen. Retrying a failure is the ordinary bulk *Describe*
              action over a selection captured with `failed` on: a successful
              re-describe clears `describe_error` (`describe.ts`'s `stamp`),
              so a file this chip shows leaves the set on its own once it is
              fixed.
            */}
            {describe.configured ? (
              <fieldset className={css.chips}>
                <legend className={css.srOnly}>Filter by description</legend>
                <button
                  type="button"
                  className={`${css.chip} ${url.undescribed ? css.chipOn : ''}`}
                  aria-pressed={url.undescribed}
                  onClick={() => onUrl(withFilter(url, { undescribed: !url.undescribed }))}
                >
                  Not described
                </button>
                <button
                  type="button"
                  className={`${css.chip} ${url.failed ? css.chipOn : ''}`}
                  aria-pressed={url.failed}
                  onClick={() => onUrl(withFilter(url, { failed: !url.failed }))}
                >
                  Failed
                </button>
              </fieldset>
            ) : null}

            {/*
          The sort, in grid mode only. The table's own headers carry the same two
          facts — which column and which direction — and offering both at once is how
          two controls over one piece of state start disagreeing about it.
        */}
            {url.view === 'grid' ? (
              <fieldset className={css.sortGroup}>
                <legend className={css.srOnly}>Sort</legend>
                <label className={css.sortLabel}>
                  Sort
                  <select
                    className={css.sortSelect}
                    value={url.sort}
                    onChange={(e) => onUrl(withSort(url, e.target.value as AssetSort))}
                  >
                    {SORTS.map((sort) => (
                      <option key={sort.value} value={sort.value}>
                        {sort.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={css.dirButton}
                  // Names the state and the effect together, because a bare ↑ is the
                  // unlabelled glyph `docs/ui-review.md` found twice in the old top bar.
                  aria-label={
                    dirOf(url) === 'asc'
                      ? 'Ascending. Reverse to descending'
                      : 'Descending. Reverse to ascending'
                  }
                  onClick={() => onUrl(withSort(url, url.sort))}
                >
                  <span aria-hidden="true">{dirOf(url) === 'asc' ? '↑' : '↓'}</span>
                </button>
              </fieldset>
            ) : null}

            <span className={css.controlsEnd}>{uploadButton}</span>
          </div>

          {/*
            The selection bar. Above the grid rather than below it, unlike
            Content's: this list has a second column beside it and a footer that
            already carries the pager, and a bar that appears under a
            twelve-tile grid is a control that moves every time a filter changes.
          */}
          {bulk ? (
            <div className={css.bulkBar}>
              <button
                type="button"
                className={css.selectAll}
                disabled={rows.length === 0}
                onClick={() => setTicked((prev) => tickAllShown(prev, rows))}
              >
                {allShown ? 'Deselect all shown' : 'Select all shown'}
              </button>
              {/*
                Select-all-matching, offered only when the list has been asked
                for a count. `expected` has to be the number the person read, or
                the guard is comparing against something nobody agreed to —
                which is why this reads `data.page.total` rather than counting
                the rows on screen.
              */}
              {data.page.total !== undefined && !ticked.all ? (
                <button
                  type="button"
                  className={css.selectAll}
                  onClick={() =>
                    setTicked({
                      all: true,
                      filter: capturedFilter(url),
                      expected: data.page.total ?? 0,
                      exclude: new Set(),
                    })
                  }
                >
                  {`Select all ${data.page.total.toLocaleString('en-US')} matching`}
                </button>
              ) : null}
              {/* Announced: the count changes without the focus moving, so a
                  screen reader user is otherwise never told what they have. */}
              <span className={css.bulkText} role="status">
                {summarise(ticked, rows)}
              </span>
              <span className={css.bulkActions}>
                <Button
                  size="sm"
                  disabled={count === 0 || running}
                  reason={running ? 'Working…' : 'Select some files first'}
                  onClick={() => setJob('tag')}
                >
                  Tag
                </Button>
                <Button
                  size="sm"
                  disabled={count === 0 || running}
                  reason={running ? 'Working…' : 'Select some files first'}
                  onClick={() => setJob('untag')}
                >
                  Untag
                </Button>
                <Button
                  size="sm"
                  disabled={count === 0 || running}
                  reason={running ? 'Working…' : 'Select some files first'}
                  onClick={() => setJob('move')}
                >
                  Move
                </Button>
                {/*
                  Absent, not disabled, with no `describe` configured — and the
                  only bulk control here that is `ADMIN` rather than `ASSETS`
                  (decision 16). The role is enforced by the route; this button
                  is drawn for an editor too, and an editor pressing it gets the
                  403 as a message. Hiding it by role would need the admin to
                  know the viewer's role here, which it does not, and a control
                  that appears for some people and not others is a worse way to
                  learn about a permission than a sentence saying so.
                */}
                {describe.configured ? (
                  <Button
                    size="sm"
                    disabled={count === 0 || running}
                    reason={running ? 'Working…' : 'Select some files first'}
                    onClick={() => void previewDescribe(false)}
                  >
                    Describe
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={count === 0 || running}
                  reason={running ? 'Working…' : 'Select some files first'}
                  onClick={() => void askDelete()}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={count === 0 || running}
                  reason="Nothing is selected"
                  onClick={() => setTicked(NOTHING)}
                >
                  Clear
                </Button>
              </span>
            </div>
          ) : null}

          {/*
        The per-file upload report. `role="status"` so the outcome is announced: a
        batch can partly succeed, and a sighted user reads the failed rows while a
        screen reader user would otherwise never be told.
      */}
          {upload.entries.length > 0 ? (
            <div className={css.uploads} role="status">
              <div className={css.uploadsHead}>
                <span className={css.uploadsText}>{report.text}</span>
                {report.busy ? null : (
                  <Button size="sm" variant="subtle" onClick={upload.dismiss}>
                    Dismiss
                  </Button>
                )}
              </div>
              <ul className={css.uploadList}>
                {upload.entries.map((entry) => (
                  <li key={entry.id} className={css.uploadRow} data-status={entry.status}>
                    <span className={css.uploadName}>{entry.filename}</span>
                    <span className={css.uploadState}>
                      {entry.status === 'uploading'
                        ? 'Uploading…'
                        : entry.status === 'done'
                          ? 'Uploaded'
                          : (entry.error ?? 'Failed')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            The results region: the flex chain's terminus, and the only part of the
            browser that scrolls in either mount. It is what keeps the search box, the
            folder list and the pager on screen while two hundred tiles go by. It
            wraps all four result states rather than the grid alone — a skeleton or an
            empty state sitting outside the scroller would size the frame differently
            from the thing that replaces it.
          */}
          <div className={css.results}>
            {firstLoad ? (
              // Skeleton tiles and rows, not a spinner: both have a known shape, so the
              // screen does not jump when the answer lands.
              <div
                className={url.view === 'grid' ? css.skeletonGrid : css.skeletonRows}
                aria-hidden="true"
              >
                {SKELETONS.slice(0, url.view === 'grid' ? 12 : 6).map((key) => (
                  <div
                    className={url.view === 'grid' ? css.skeletonTile : css.skeletonRow}
                    key={key}
                  />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <Empty
                narrowed={narrowed}
                onClear={() =>
                  onUrl(
                    withFilter(url, {
                      kind: 'all',
                      q: '',
                      folder: undefined,
                      unfiled: false,
                      tags: [],
                      untagged: false,
                      undescribed: false,
                    }),
                  )
                }
              >
                {uploadButton}
              </Empty>
            ) : url.view === 'grid' ? (
              <div
                ref={grid}
                className={`${css.grid} ${compact ? css.gridCompact : ''}`}
                role="listbox"
                aria-label={label}
                onKeyDown={onGridKey}
              >
                {rows.map((row) => (
                  <Tile
                    key={row.id}
                    row={row}
                    mount={mount}
                    selected={row.id === selected}
                    focusable={row.id === focusable}
                    onSelect={() => props.onSelect(row.id)}
                    {...(bulk
                      ? { ticked: isTicked(ticked, row.id), onTick: () => tick(row.id) }
                      : {})}
                  />
                ))}
              </div>
            ) : (
              <Table
                label={label}
                columns={columns.map((column) => tableColumn(column, mount))}
                rows={rows}
                rowKey={(row) => row.id}
                {...(bulk
                  ? {
                      select: {
                        head: (
                          <input
                            type="checkbox"
                            className={css.tick}
                            checked={allShown}
                            disabled={rows.length === 0}
                            aria-label="Select every file shown"
                            onChange={() => setTicked((prev) => tickAllShown(prev, rows))}
                          />
                        ),
                        cell: (row: AssetRow) => (
                          <input
                            type="checkbox"
                            className={css.tick}
                            checked={isTicked(ticked, row.id)}
                            aria-label={`Select ${row.filename}`}
                            onChange={() => tick(row.id)}
                          />
                        ),
                      },
                    }
                  : {})}
                currentKey={selected ?? null}
                sort={{ key: sortColumnKey(url), dir: dirOf(url) }}
                onSort={(key) => {
                  const sort = ASSET_COLUMNS.find((column) => column.key === key)?.sort
                  if (sort) onUrl(withSort(url, sort))
                }}
                onOpen={(row) => props.onSelect(row.id)}
              />
            )}
          </div>

          <div className={css.footer}>
            {/*
          `Showing n of N` — next / previous plus an exact count, never page numbers
          (`ui-architecture.md` Resolved 5). The old library showed neither, which is
          how asset 201 became unreachable.
        */}
            <span className={css.count}>
              {data.page.total === undefined
                ? `${rows.length} shown`
                : `${rows.length} of ${data.page.total} ${data.page.total === 1 ? 'file' : 'files'}`}
            </span>
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
                disabled={data.page.cursor === null}
                reason="This is the last page"
                onClick={data.nextPage}
              >
                Next
              </Button>
            </span>
          </div>
        </div>
      </div>

      {/*
        The bulk dialogs. **Screen-only by construction**, because they are
        rendered under `bulk`, which the picker does not pass: a `Dialog` opened
        from inside `AssetPicker.tsx`'s own would mount a second `useFocusTrap`
        and take every Tab press away from itself.
      */}
      {job === 'tag' || job === 'untag' ? (
        <BulkTagDialog
          action={job}
          count={count}
          tags={tags.tags}
          busy={running}
          onClose={() => setJob(null)}
          onRun={(tagIds) => void run(job, { tagIds })}
        />
      ) : job === 'move' ? (
        <BulkMoveDialog
          count={count}
          folders={folders.folders}
          busy={running}
          onClose={() => setJob(null)}
          onRun={(folderId) => void run('move', { folderId })}
        />
      ) : job === 'delete' ? (
        <BulkDeleteDialog
          count={count}
          used={probe.used}
          error={probe.error}
          busy={running}
          onClose={() => setJob(null)}
          onRun={() => void run('delete')}
        />
      ) : null}

      {describeRun === null ? null : (
        <DescribeRunDialog
          state={describeRun}
          count={count}
          images={describe.images}
          onUpload={describe.onUpload}
          {...(ticked.all ? { onBacklogOnly: (only: boolean) => void previewDescribe(only) } : {})}
          onRun={() => void startDescribe()}
          onStop={() => {
            stopping.current = true
          }}
          onClose={() => {
            stopping.current = true
            setDescribeRun(null)
            // A finished run leaves the selection where a bulk write does not:
            // the files are still there, still selected, and running again over
            // the ones that failed is a reasonable next gesture.
            if (describeRun.finished) setTicked(NOTHING)
          }}
        />
      )}
    </div>
  )
}

/* --------------------------------------------------------------- selection --- */

/**
 * What the bulk layer holds, in the two shapes a selection comes in
 * (`core/bulk.ts`'s `BulkSelection<AssetFilter>`, as component state).
 *
 * `Set`s rather than arrays because every read here is a membership test — one
 * per tile, per render — and the wire shape is built once, at post time, by
 * `bodyOf`. The captured half stores the *filter*, not the URL: a select-all
 * captures conditions at the moment it is clicked and must survive the person
 * changing a chip afterwards, which is the property the server's `expected`
 * guard is checking against.
 */
type Ticked =
  | { all: false; ids: ReadonlySet<string> }
  | { all: true; filter: AssetFilter; expected: number; exclude: ReadonlySet<string> }

const NOTHING: Ticked = { all: false, ids: new Set() }

function isTicked(ticked: Ticked, id: string): boolean {
  return ticked.all ? !ticked.exclude.has(id) : ticked.ids.has(id)
}

/** How many files the selection means. Never below zero: `exclude` can outgrow
 * `expected` if the set shrank under a person who kept ticking. */
function tickCount(ticked: Ticked): number {
  return ticked.all ? Math.max(ticked.expected - ticked.exclude.size, 0) : ticked.ids.size
}

/** Ticking a row off a select-all **adds to `exclude`** rather than collapsing
 * the selection into ids — which is what keeps "all 4,812 except these two" four
 * small JSON fields instead of 4,810 of them. */
function toggleTick(ticked: Ticked, id: string): Ticked {
  if (ticked.all) {
    const exclude = new Set(ticked.exclude)
    if (!exclude.delete(id)) exclude.add(id)
    return { ...ticked, exclude }
  }
  const ids = new Set(ticked.ids)
  if (!ids.delete(id)) ids.add(id)
  return { all: false, ids }
}

function tickAllShown(ticked: Ticked, rows: readonly AssetRow[]): Ticked {
  const on = rows.length > 0 && rows.every((row) => isTicked(ticked, row.id))
  if (ticked.all) {
    const exclude = new Set(ticked.exclude)
    for (const row of rows) {
      if (on) exclude.add(row.id)
      else exclude.delete(row.id)
    }
    return { ...ticked, exclude }
  }
  const ids = new Set(ticked.ids)
  for (const row of rows) {
    if (on) ids.delete(row.id)
    else ids.add(row.id)
  }
  return { all: false, ids }
}

/**
 * The screen's filter as a captured `AssetFilter` — the same conditions
 * `assetsParams` puts on the list request, so the count the person read and the
 * count the guard re-runs are over one set of clauses.
 *
 * `kind: 'all'` and an empty `q` are omitted rather than sent, because
 * `assetFilterSql` reads both for truthiness and a captured `q: ''` would be a
 * filter key that means nothing and looks like it means something.
 */
function capturedFilter(url: AssetsUrl): AssetFilter {
  const q = url.q.trim()
  return {
    ...(q ? { q } : {}),
    ...(url.kind === 'all' ? {} : { kind: url.kind }),
    ...(url.folder === undefined ? {} : { folder: url.folder }),
    ...(url.unfiled ? { unfiled: true } : {}),
    ...(url.tags.length === 0 ? {} : { tags: [...url.tags] }),
    ...(url.untagged ? { untagged: true } : {}),
    ...(url.undescribed ? { undescribed: true } : {}),
    ...(url.failed ? { failed: true } : {}),
  }
}

/** The `selection` field of a bulk body. `exclude` is omitted when empty rather
 * than sent as `[]`: the route's two options are `v.strictObject`, so every key
 * in the body is one it reads. */
function bodyOf(ticked: Ticked): Record<string, unknown> {
  if (!ticked.all) return { ids: [...ticked.ids] }
  return {
    all: true,
    filter: ticked.filter,
    expected: ticked.expected,
    ...(ticked.exclude.size === 0 ? {} : { exclude: [...ticked.exclude] }),
  }
}

/**
 * What the bar says.
 *
 * **The invisible part of a selection is named rather than implied**, because
 * acting on more than you can see is the hazard: a bar reading "12 selected"
 * over a grid with nothing ticked reads as broken software.
 */
function summarise(ticked: Ticked, rows: readonly AssetRow[]): string {
  const count = tickCount(ticked)
  if (count === 0) return 'Nothing selected'
  const shown = rows.filter((row) => isTicked(ticked, row.id)).length
  const hidden = Math.max(count - shown, 0)
  const split = hidden === 0 ? '' : shown === 0 ? ', none shown here' : ` · ${shown} shown here`
  const files = `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`
  if (!ticked.all) return `${files} selected${split}`
  const off = ticked.exclude.size === 0 ? '' : `, except the ${ticked.exclude.size} you ticked off`
  return `All ${ticked.expected.toLocaleString('en-US')} matching${off}${split}`
}

/** What a bulk answer looks like on the wire: the report, plus the delete's one
 * extra field (decision 15). */
type AssetBulkAnswer = BulkReport<AssetBulkAction> & { usedOnPublished?: number }

/**
 * A whole bulk job: post, read the report, post again with its cursor.
 *
 * **Loop on `continueFrom`, never on `seen < total`** — a batch whose files were
 * all refused still advances the cursor, and a comparison of counts would spin.
 * A cursor that has not *moved* ends the loop too, which is the case
 * `content-model.ts`'s own runner had to name: decision 11 is right about the
 * condition and silent about a server that answers the same cursor forever.
 */
async function runAssetJob(
  apiBase: string,
  action: AssetBulkAction,
  body: Record<string, unknown>,
): Promise<
  { done: number; failed: BulkFailure[]; usedOnPublished?: number } | { refused: BulkRefusal }
> {
  let continueFrom: string | null = null
  let done = 0
  let usedOnPublished: number | undefined
  const failed: BulkFailure[] = []
  for (;;) {
    const res = await fetch(`${apiBase}/assets/bulk/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(continueFrom === null ? {} : { continueFrom }) }),
    })
    // The guard runs once, at the start of a job, so a refusal can only arrive
    // on the first call — and it arrives before anything is written.
    if (res.status === 409) return { refused: (await res.json()) as BulkRefusal }
    if (!res.ok) throw new Error(await messageOf(res))
    const report = (await res.json()) as AssetBulkAnswer
    done += report.done
    failed.push(...report.failed)
    if (usedOnPublished === undefined) usedOnPublished = report.usedOnPublished
    if (report.continueFrom === null || report.continueFrom === continueFrom) {
      return { done, failed, ...(usedOnPublished === undefined ? {} : { usedOnPublished }) }
    }
    continueFrom = report.continueFrom
  }
}

const PAST_TENSE: Record<AssetBulkAction, string> = {
  tag: 'Tagged',
  untag: 'Untagged',
  move: 'Filed',
  delete: 'Deleted',
}

/** One sentence for a finished run. **Never atomic and never implied to be**:
 * each file is its own write, so the successes are counted and the failures are
 * named. */
function runSummary(action: AssetBulkAction, done: number, failed: readonly BulkFailure[]): string {
  const files = `${done.toLocaleString('en-US')} ${done === 1 ? 'file' : 'files'}`
  if (failed.length === 0) return `${PAST_TENSE[action]} ${files}`
  const named = failed
    .slice(0, 2)
    .map((one) => one.title || one.id)
    .join(', ')
  const rest = failed.length > 2 ? ` and ${failed.length - 2} more` : ''
  return `${PAST_TENSE[action]} ${files}. Could not: ${named}${rest}`
}

/* ---------------------------------------------------------------- describe --- */

/**
 * What the describe run panel holds. One object rather than six `useState`s,
 * for `Ticked`'s reason: several of these are only meaningful together — a
 * `total` with no `body` is a preview of a job nobody can start — and a single
 * value makes the impossible combinations unwritable.
 */
interface DescribeRunState {
  /** Narrowed to files that have never been described. Offered for a captured
   * *select all* only; a ticked list of ids has nothing to narrow. */
  backlogOnly: boolean
  /** The body the dry run built, reposted verbatim by the real run. Null while
   * the preview is in flight. */
  body: Record<string, unknown> | null
  /** The job's ceiling, as the dry run reported it. */
  total: number | null
  error: string | null
  running: boolean
  /** Cumulative across the batches so far, or null before the first lands. */
  progress: DescribeTotals | null
  /** Whether the loop has ended — by finishing, by stopping, or by failing. */
  finished: boolean
}

interface DescribeTotals {
  seen: number
  done: number
  skipped: number
  tagsIgnored: number
  failed: BulkFailure[]
}

/** A fresh zero, as a factory rather than a shared constant: `failed` is an
 * array, and one module-level object handed to both the run's accumulator and
 * React state is two owners of one list. */
const emptyRun = (): DescribeTotals => ({
  seen: 0,
  done: 0,
  skipped: 0,
  tagsIgnored: 0,
  failed: [],
})

/** What a describe batch answers: `BulkReport` plus the two numbers only this
 * run has (`server/describe.ts`'s `DescribeRunReport`). */
type DescribeAnswer = BulkReport<'describe'> & { skipped: number; tagsIgnored: number }

async function postDescribe(
  apiBase: string,
  body: Record<string, unknown>,
): Promise<DescribeAnswer | { refused: BulkRefusal }> {
  const res = await fetch(`${apiBase}/assets/describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // The guard runs once at the start of a job, so a refusal can only arrive on
  // the first call — and it arrives before a single model call is made.
  if (res.status === 409) return { refused: (await res.json()) as BulkRefusal }
  if (!res.ok) throw new Error(await messageOf(res))
  return (await res.json()) as DescribeAnswer
}

/**
 * How many files a filter matches, straight from the list route's `?count=1`.
 *
 * **Not `assetsParams`**, which builds a query from the screen's `AssetsUrl`:
 * what is needed here is the *captured* filter, plus `undescribed`, which the
 * URL shape does not carry and should not — the backlog is a property of a run,
 * not a state of the screen. The one number this reads is the `expected` the
 * server's count guard will re-check, so it has to come off exactly the clauses
 * the run will walk.
 */
async function countMatching(apiBase: string, filter: AssetFilter): Promise<number> {
  const params = new URLSearchParams({ limit: '1', count: '1' })
  if (filter.q) params.set('q', filter.q)
  if (filter.kind) params.set('kind', filter.kind)
  if (filter.folder) params.set('folder', filter.folder)
  if (filter.unfiled) params.set('unfiled', '1')
  // Repeated, not comma-joined: `c.req.queries('tags')` is what the route
  // parses, exactly as `assetsParams` does it.
  for (const slug of filter.tags ?? []) params.append('tags', slug)
  if (filter.untagged) params.set('untagged', '1')
  if (filter.undescribed) params.set('undescribed', '1')
  if (filter.failed) params.set('failed', '1')
  const res = await fetch(`${apiBase}/assets?${params.toString()}`)
  if (!res.ok) throw new Error(await messageOf(res))
  const page = (await res.json()) as { total?: number }
  return page.total ?? 0
}

function refusedText(refusal: BulkRefusal): string {
  return `${refusal.actual.toLocaleString('en-US')} files match now, not ${refusal.expected.toLocaleString('en-US')}. Close this and choose again.`
}

/** One sentence for a finished run — the successes counted, the failures named,
 * and the drops reported rather than swallowed, so a prompt that keeps proposing
 * a tag nobody created is visible. */
function describeRunSummary(totals: DescribeTotals): string {
  const files = `${totals.done.toLocaleString('en-US')} ${totals.done === 1 ? 'file' : 'files'}`
  const parts = [`Described ${files}`]
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped as not images`)
  if (totals.tagsIgnored > 0) {
    parts.push(
      `${totals.tagsIgnored} suggested ${totals.tagsIgnored === 1 ? 'tag' : 'tags'} ignored`,
    )
  }
  if (totals.failed.length > 0) {
    const named = totals.failed
      .slice(0, 2)
      .map((one) => one.title || one.id)
      .join(', ')
    const rest = totals.failed.length > 2 ? ` and ${totals.failed.length - 2} more` : ''
    parts.push(`could not: ${named}${rest}`)
  }
  return `${parts.join('. ')}.`
}

/**
 * The run panel: what it will cost, then what it is doing, then what it did.
 *
 * **The dry run is what opens it**, and it is free by construction — `runDescribe`
 * calls the host's function zero times under `dryRun` (decision 10). So the
 * first thing anybody sees is the number of model calls they are about to pay
 * for, before a button that starts them.
 *
 * **The batches are reported as they land, and there is a *Stop*.** Both fall
 * out of the cursor living in the caller's hand: this loop is N requests, so
 * declining to send the next one is all stopping means, and there is no job
 * record left behind to reconcile. It is the one screen in this admin where
 * that design is visible rather than merely cheap.
 */
function DescribeRunDialog({
  state,
  count,
  images,
  onUpload,
  onBacklogOnly,
  onRun,
  onStop,
  onClose,
}: {
  state: DescribeRunState
  count: number
  /** Whether the Images binding is bound. It changes what a run *costs*, not
   * what it does, which is why it is said once here rather than as a warning. */
  images: boolean
  onUpload: boolean
  /** Absent for a ticked list of ids: there is no backlog to narrow to. */
  onBacklogOnly?: (only: boolean) => void
  onRun: () => void
  onStop: () => void
  onClose: () => void
}) {
  const { total, progress, running, finished, error } = state
  const files = `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`

  return (
    <Dialog
      title={`Describe ${files}`}
      description="Each image is sent to this site's own describe function — one model call per file, and it is your account that pays for them."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{finished ? 'Close' : 'Cancel'}</Button>
          {running ? (
            <Button variant="primary" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={total === null || finished || error !== null}
              reason={error ?? (finished ? 'This run has finished' : 'Working out how many…')}
              onClick={onRun}
            >
              {total === null ? 'Describe' : `Describe ${total.toLocaleString('en-US')}`}
            </Button>
          )}
        </>
      }
    >
      {onBacklogOnly ? (
        <label className={css.pickRow}>
          <input
            type="checkbox"
            checked={state.backlogOnly}
            disabled={running || finished}
            onChange={(e) => onBacklogOnly(e.target.checked)}
          />
          Only files that have never been described
        </label>
      ) : null}

      {error ? <p className={css.warn}>{error}</p> : null}

      {progress === null ? (
        total === null ? (
          <p className={css.note}>Working out how many files this would be…</p>
        ) : (
          <p className={css.note}>
            {total === 0
              ? 'Nothing to do: no file in this selection needs describing.'
              : `${total.toLocaleString('en-US')} ${total === 1 ? 'file' : 'files'} will be sent, one model call each. Files that are not images are skipped and cost nothing.`}
            {onUpload ? ' New uploads are described on their own as they arrive.' : ''}
          </p>
        )
      ) : (
        <>
          {/* Announced: the numbers change without focus moving, so a screen
              reader user is otherwise never told the run is progressing. */}
          <p className={css.note} role="status">
            {running
              ? `Working… ${progress.seen.toLocaleString('en-US')} of ${(total ?? progress.seen).toLocaleString('en-US')}`
              : `Finished ${progress.seen.toLocaleString('en-US')} of ${(total ?? progress.seen).toLocaleString('en-US')}`}
          </p>
          <dl className={css.runStats}>
            <RunStat label="Described" value={progress.done} />
            <RunStat label="Not images" value={progress.skipped} />
            <RunStat label="Failed" value={progress.failed.length} />
            <RunStat label="Tags ignored" value={progress.tagsIgnored} />
          </dl>
          {progress.failed.length > 0 ? (
            <ul className={css.runFailures}>
              {progress.failed.slice(0, 5).map((one) => (
                <li key={one.id || one.title}>
                  <b>{one.title || one.id}</b> — {one.message}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {/* Said once, where the cost is being decided, rather than as a warning:
          without the Images binding the original bytes are described instead of
          a 512px WebP, which works and costs more per call. */}
      {images ? null : (
        <p className={css.note}>
          No Images binding is configured, so the original file is sent rather than a small preview.
          It works, and each call costs more.
        </p>
      )}
      {progress !== null && progress.tagsIgnored > 0 ? (
        <p className={css.note}>
          A model may only choose tags that already exist. Create the ones it keeps proposing and
          run it again to pick them up.
        </p>
      ) : null}
    </Dialog>
  )
}

function RunStat({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt className={css.runStatLabel}>{label}</dt>
      <dd className={css.runStatValue}>{value.toLocaleString('en-US')}</dd>
    </>
  )
}

/* ----------------------------------------------------------------- sidebar --- */

/**
 * The folder tree and the tag chips — the two filters decision 2 adds beside
 * `kind` and `q`. **A filter list, not a place to navigate into**: clicking a
 * folder narrows the one grid this component already draws, and does not open it
 * as a second view.
 *
 * `listFolders` and `listTags` already answer their lists in the order a tree and
 * a vocabulary should render in — depth-first and alphabetical for folders
 * (decision 3), alphabetical by slug for tags — so this renders both flat and
 * lets the server's ordering do the work, rather than reconstructing a nested
 * structure in JavaScript.
 *
 * **One instance per mount.** `AssetBrowser` is the "one implementation, two
 * mounts" component, and this lives inside it rather than being lifted to a
 * caller, which is what makes the picker's sidebar the same code as the screen's
 * without either `Assets.tsx` or `AssetPicker.tsx` having to wire it up.
 */
function Sidebar({
  folders,
  tags,
  url,
  onUrl,
  compact,
  onNotice,
}: {
  /** Held by `AssetBrowser` and passed down, so the sidebar, the bulk *Tag*
   * dialog and the bulk *Move* dialog read one fetch rather than three. */
  folders: FoldersData
  tags: TagsData
  url: AssetsUrl
  onUrl: (next: AssetsUrl) => void
  /** Whether this mount is already inside a `Dialog` — the picker's, at `wide`.
   * Suppresses every affordance that opens a second one: creating a folder,
   * editing a folder, and managing the tag vocabulary. See `NewFolderDialog`'s
   * own header for why a `Dialog` cannot be opened from on top of one. */
  compact: boolean | undefined
  onNotice?: (message: string) => void
}) {
  const [creating, setCreating] = useState(false)
  /** The folder being edited, or null. One at a time, and the same single-value
   * rule the bulk dialogs follow rather than a boolean per dialog. */
  const [editing, setEditing] = useState<AssetFolder | null>(null)
  const [managingTags, setManagingTags] = useState(false)

  const atRoot = url.folder === undefined && !url.unfiled

  return (
    <div className={css.sidebar}>
      <section className={css.sidebarSection}>
        <h3 className={css.sidebarTitle}>Folders</h3>
        <fieldset className={css.folderTree}>
          <legend className={css.srOnly}>Filter by folder</legend>
          <button
            type="button"
            className={`${css.folderRow} ${atRoot ? css.folderRowOn : ''}`}
            aria-pressed={atRoot}
            onClick={() => onUrl(withFilter(url, { folder: undefined, unfiled: false }))}
          >
            All files
          </button>
          {folders.folders.map((folder) => (
            /*
             * A row is now **two** controls, so the filter button can no longer
             * be the row: a button inside a button is not markup any browser
             * accepts. The wrapper carries the hover state and positions the
             * edit affordance over the row's right edge — `position: absolute`
             * rather than a flex sibling, because a hover-revealed control that
             * holds layout makes every folder name reflow as the pointer
             * crosses the tree.
             */
            <div key={folder.id} className={css.folderRowWrap}>
              <button
                type="button"
                className={`${css.folderRow} ${url.folder === folder.path ? css.folderRowOn : ''}`}
                style={{ paddingLeft: `calc(var(--space-2) + ${folderDepth(folder) * 14}px)` }}
                aria-pressed={url.folder === folder.path}
                onClick={() => onUrl(withFilter(url, { folder: folder.path }))}
              >
                {folder.name}
              </button>
              {compact ? null : (
                <button
                  type="button"
                  className={css.rowEdit}
                  // Named per row rather than "Edit": a tree of twenty folders
                  // otherwise announces twenty identical buttons.
                  aria-label={`Edit folder ${folder.name}`}
                  onClick={() => setEditing(folder)}
                >
                  <span aria-hidden="true">⋯</span>
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className={`${css.folderRow} ${url.unfiled ? css.folderRowOn : ''}`}
            aria-pressed={url.unfiled}
            onClick={() => onUrl(withFilter(url, { unfiled: true }))}
          >
            Unfiled
          </button>
        </fieldset>
        {compact ? null : (
          <Button size="sm" variant="subtle" onClick={() => setCreating(true)}>
            New folder
          </Button>
        )}
      </section>

      <section className={css.sidebarSection}>
        <h3 className={css.sidebarTitle}>Tags</h3>
        {tags.tags.length === 0 && !tags.loading ? (
          <p className={css.note}>No tags yet.</p>
        ) : (
          <fieldset className={css.chips}>
            <legend className={css.srOnly}>Filter by tag</legend>
            <button
              type="button"
              className={`${css.chip} ${url.untagged ? css.chipOn : ''}`}
              aria-pressed={url.untagged}
              onClick={() => onUrl(withFilter(url, { untagged: !url.untagged }))}
            >
              Untagged
            </button>
            {tags.tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={`${css.chip} ${url.tags.includes(tag.slug) ? css.chipOn : ''}`}
                aria-pressed={url.tags.includes(tag.slug)}
                onClick={() =>
                  onUrl(withFilter(url, { tags: toggleTagFilter(url.tags, tag.slug) }))
                }
              >
                {tagChipLabel(tag)}
              </button>
            ))}
          </fieldset>
        )}
        {/*
          Renaming and deleting a tag live behind **one** control rather than an
          affordance per chip, and that is the one place this differs from the
          folder tree above. A chip list wraps: a hover-revealed edit button
          inside each chip would be four pixels wide at the end of a two-word
          label, and a vocabulary is hundreds of chips by design (decision 4).
          A folder row is a full-width line in a spine you point at, so it can
          carry its own.
        */}
        {compact || tags.tags.length === 0 ? null : (
          <Button size="sm" variant="subtle" onClick={() => setManagingTags(true)}>
            Manage tags
          </Button>
        )}
      </section>

      {creating ? (
        <NewFolderDialog
          folders={folders.folders}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const folder = await folders.create(input)
            setCreating(false)
            onUrl(withFilter(url, { folder: folder.path }))
          }}
        />
      ) : editing ? (
        <FolderEditDialog
          folder={editing}
          folders={folders.folders}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const folder = await folders.update(editing.id, patch)
            setEditing(null)
            // The path moved, so a filter pointing at the old one now matches
            // nothing. Following it is what makes a rename feel like a rename
            // rather than like the folder disappearing.
            if (url.folder !== undefined) onUrl(withFilter(url, { folder: folder.path }))
            onNotice?.(`Renamed to ${folder.name}`)
          }}
          onDelete={async () => {
            const report = await folders.remove(editing.id)
            setEditing(null)
            if (url.folder !== undefined) onUrl(withFilter(url, { folder: undefined }))
            onNotice?.(deletedFolderSummary(editing.name, report))
          }}
        />
      ) : managingTags ? (
        <TagManagerDialog
          tags={tags.tags}
          onClose={() => setManagingTags(false)}
          onRename={async (id, name) => {
            const tag = await tags.rename(id, name)
            onNotice?.(`Renamed to ${tag.name}`)
          }}
          onDelete={async (tag) => {
            const report = await tags.remove(tag.id)
            // The chip may be in the filter, and a filter naming a slug nothing
            // has is a grid that renders nothing for no visible reason.
            if (url.tags.includes(tag.slug)) {
              onUrl(withFilter(url, { tags: url.tags.filter((slug) => slug !== tag.slug) }))
            }
            onNotice?.(
              `Deleted the tag ${tag.name}. ${report.removedFrom === 1 ? '1 file' : `${report.removedFrom.toLocaleString('en-US')} files`} no longer carry it. No file was deleted.`,
            )
          }}
        />
      ) : null}
    </div>
  )
}

/** What a folder delete actually did, in one sentence — the counts come back
 * from the route because nothing before the delete can know them: the folder
 * filter includes descendants, and only the folder's *own* files are unfiled. */
function deletedFolderSummary(
  name: string,
  report: { unfiled: number; reparented: number },
): string {
  const files =
    report.unfiled === 0
      ? 'No files were in it'
      : report.unfiled === 1
        ? '1 file is now unfiled'
        : `${report.unfiled.toLocaleString('en-US')} files are now unfiled`
  const kids =
    report.reparented === 0
      ? ''
      : report.reparented === 1
        ? ', and 1 subfolder moved up a level'
        : `, and ${report.reparented} subfolders moved up a level`
  return `Deleted ${name}. ${files}${kids}. No file was deleted.`
}

/**
 * The one place a folder is created (decision 3's tree is the browse spine, and
 * this is what plants it). A name and, optionally, a parent — nothing else,
 * matching `CreateDialog.tsx`'s rule that a create dialog asks for the one field
 * that would otherwise leave a row unrepresentable and nothing more.
 *
 * **Screen-only, never offered when `Sidebar`'s `compact` is set** — the picker
 * mount, whose own `AssetBrowser` already sits inside `AssetPicker.tsx`'s
 * `Dialog`. `useFocusTrap` attaches one `keydown` listener per mounted `Dialog`
 * and each cycles Tab within *its own* `panel`; a portal detaches DOM
 * containment, so the outer trap's "is focus inside my panel?" check reads
 * false for anything focused inside this one and yanks focus back into the
 * outer dialog on every Tab press — not a hypothetical, verified by opening
 * this from inside the picker before the `compact` guard was added. **One
 * focus trap** (`CLAUDE.md`) turns out to mean one *mounted* `Dialog` at a
 * time, not merely one implementation shared by every caller, and this is the
 * mount where that distinction bites: creating a folder from the picker is
 * left to the screen, where nothing else is layered on top.
 *
 * **The error is shown inline**, not through a toast: `AssetPicker.tsx`
 * deliberately takes no `onNotice` (see its own header), and now that this
 * dialog is screen-only that constraint is not load-bearing for the reason
 * above — but a self-contained error still costs nothing and needs no channel
 * threaded down from either mount.
 */
function NewFolderDialog({
  folders,
  onClose,
  onCreate,
}: {
  folders: readonly AssetFolder[]
  onClose: () => void
  onCreate: (input: { name: string; parentId: string | null }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setPending(true)
    setError(null)
    try {
      await onCreate({ name: trimmed, parentId: parentId || null })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      title="New folder"
      description="Nothing is created until you press Create."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || name.trim() === ''}
            reason={pending ? 'Creating…' : 'Name a folder first'}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </>
      }
    >
      {/* A real `<form>`, so Enter submits — `Dialog` owns the footer, so the
          buttons that act on this form live outside the element itself. */}
      <form
        className={css.folderForm}
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending) void submit()
        }}
      >
        <Field label="Name" required error={error}>
          {(id) => (
            <Input
              id={id}
              value={name}
              placeholder="Folder name"
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Parent folder" help="Top level if none is chosen.">
          {(id) => (
            <Select
              id={id}
              value={parentId}
              disabled={pending}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">Top level</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {indentedFolderName(folder)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  )
}

/**
 * Renaming, moving and deleting one folder — the surface phase 4 named as
 * missing, since `updateFolder` and `deleteFolder` were reachable only through
 * the raw API.
 *
 * **One dialog for all three**, because on a materialised path a rename and a
 * move are the same operation (`server/asset-folders.ts`'s `updateFolder`), and
 * splitting them here would be two dialogs over one `PATCH`. Delete sits in the
 * same panel behind its own confirmation step rather than a second dialog: two
 * mounted `Dialog`s fight over the focus trap, which is the bug phase 4 found.
 *
 * **The delete copy is the load-bearing part** (decision 14). Filing is meant to
 * be cheap to undo, and an editor who miscategorised forty photographs must not
 * be able to delete them by tidying up — so the confirmation says, in the panel
 * rather than in a tooltip, that no file is deleted and where the files and the
 * subfolders go. An editor who believes otherwise will not press the button.
 */
function FolderEditDialog({
  folder,
  folders,
  onClose,
  onSave,
  onDelete,
}: {
  folder: AssetFolder
  folders: readonly AssetFolder[]
  onClose: () => void
  onSave: (patch: { name?: string; parentId?: string | null }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [name, setName] = useState(folder.name)
  const [parentId, setParentId] = useState(folder.parentId ?? '')
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (what: () => Promise<void>) => {
    setPending(true)
    setError(null)
    try {
      await what()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const changed = name.trim() !== folder.name || (parentId || null) !== folder.parentId

  return (
    <Dialog
      danger={confirming}
      title={confirming ? `Delete ${folder.name}?` : `Edit ${folder.name}`}
      description={
        confirming
          ? 'No file is deleted. This only removes the folder.'
          : 'Renaming or moving a folder rewrites the paths beneath it.'
      }
      onClose={onClose}
      actions={
        confirming ? (
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={pending}
              reason="Deleting…"
              onClick={() => void attempt(onDelete)}
            >
              Delete folder
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending || !changed || name.trim() === ''}
              reason={pending ? 'Saving…' : 'Change something first'}
              onClick={() =>
                void attempt(() =>
                  onSave({
                    ...(name.trim() === folder.name ? {} : { name: name.trim() }),
                    ...((parentId || null) === folder.parentId
                      ? {}
                      : { parentId: parentId || null }),
                  }),
                )
              }
            >
              Save
            </Button>
          </>
        )
      }
    >
      {confirming ? (
        <div className={css.folderForm}>
          <p className={css.note}>
            Files in this folder go back to <strong>Unfiled</strong>, where you can find them again.
            Any subfolders move up one level, keeping their own files.
          </p>
          {error ? <p className={css.warn}>{error}</p> : null}
        </div>
      ) : (
        <form
          className={css.folderForm}
          onSubmit={(e) => {
            e.preventDefault()
          }}
        >
          <Field label="Name" required error={error}>
            {(id) => (
              <Input
                id={id}
                value={name}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Parent folder" help="Top level if none is chosen.">
            {(id) => (
              <Select
                id={id}
                value={parentId}
                disabled={pending}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">Top level</option>
                {folders
                  // A folder cannot be moved into itself or into its own
                  // subtree. The route refuses both with a 409; offering them
                  // and then reporting a cycle is a control that exists to fail.
                  .filter(
                    (one) => one.path !== folder.path && !one.path.startsWith(`${folder.path}/`),
                  )
                  .map((one) => (
                    <option key={one.id} value={one.id}>
                      {indentedFolderName(one)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <div>
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
              Delete folder
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

/**
 * The tag vocabulary, editable — rename and delete, one row each.
 *
 * A list in **one** dialog rather than an edit affordance per chip, for the
 * reason `Sidebar` states where the button is: chips wrap, and a hover control
 * inside one is unhittable. It also makes the vocabulary legible as a
 * vocabulary, which is what somebody who came here to tidy up is looking at.
 *
 * Delete confirms **inline, in the row**, not in a second dialog — same rule as
 * `FolderEditDialog`'s, and it keeps the sentence that matters (decision 14: no
 * file is deleted) attached to the row it is about, with the count of files that
 * lose the tag right there in the label.
 */
function TagManagerDialog({
  tags,
  onClose,
  onRename,
  onDelete,
}: {
  tags: readonly AssetTag[]
  onClose: () => void
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (tag: AssetTag) => Promise<void>
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (what: () => Promise<void>) => {
    setPending(true)
    setError(null)
    try {
      await what()
      setRenaming(null)
      setConfirming(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      title="Manage tags"
      description="Deleting a tag never deletes a file."
      onClose={onClose}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {error ? <p className={css.warn}>{error}</p> : null}
      <ul className={css.manageList}>
        {tags.map((tag) => (
          <li key={tag.id} className={css.manageRow}>
            {renaming === tag.id ? (
              <>
                <Input
                  value={draft}
                  aria-label={`New name for ${tag.name}`}
                  disabled={pending}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button size="sm" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending || draft.trim() === ''}
                  reason={pending ? 'Saving…' : 'Name it first'}
                  onClick={() => void attempt(() => onRename(tag.id, draft.trim()))}
                >
                  Save
                </Button>
              </>
            ) : confirming === tag.id ? (
              <>
                <span className={css.manageName}>
                  {tag.count === undefined
                    ? `Delete ${tag.name}? No file is deleted.`
                    : `Delete ${tag.name}? It comes off ${tag.count === 1 ? '1 file' : `${tag.count.toLocaleString('en-US')} files`}. No file is deleted.`}
                </span>
                <Button size="sm" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  reason="Deleting…"
                  onClick={() => void attempt(() => onDelete(tag))}
                >
                  Delete
                </Button>
              </>
            ) : (
              <>
                <span className={css.manageName}>{tagChipLabel(tag)}</span>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    setDraft(tag.name)
                    setRenaming(tag.id)
                  }}
                >
                  Rename
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirming(tag.id)}>
                  Delete
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

/* --------------------------------------------------------- bulk dialogs --- */

/**
 * Which tags to add to, or remove from, a selection.
 *
 * **Add and remove, never replace** — the difference between this and the detail
 * panel's chip editor, and the reason there are two routes rather than a bulk
 * `PATCH`. A bulk replace would wipe every per-file tag somebody had applied by
 * hand, which is not what "add `2024` to these forty" means.
 *
 * A checkbox list rather than the detail panel's type-to-create input: this
 * dialog may only *choose* from the vocabulary, because minting a tag while
 * applying it to four hundred files is two decisions wearing one button.
 */
function BulkTagDialog({
  action,
  count,
  tags,
  busy,
  onClose,
  onRun,
}: {
  action: 'tag' | 'untag'
  count: number
  tags: readonly AssetTag[]
  busy: boolean
  onClose: () => void
  onRun: (tagIds: string[]) => void
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const files = `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`

  return (
    <Dialog
      title={action === 'tag' ? `Tag ${files}` : `Untag ${files}`}
      description={
        action === 'tag'
          ? 'Adds these tags. Tags already on a file stay.'
          : 'Removes these tags. Other tags on a file stay.'
      }
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || chosen.size === 0}
            reason={busy ? 'Working…' : 'Choose a tag first'}
            onClick={() => onRun([...chosen])}
          >
            {action === 'tag' ? 'Add tags' : 'Remove tags'}
          </Button>
        </>
      }
    >
      {tags.length === 0 ? (
        <p className={css.note}>
          There are no tags yet. Tag a single file from its detail panel to make one.
        </p>
      ) : (
        <fieldset className={css.pickList}>
          <legend className={css.srOnly}>Tags</legend>
          {tags.map((tag) => (
            <label key={tag.id} className={css.pickRow}>
              <input
                type="checkbox"
                checked={chosen.has(tag.id)}
                onChange={() =>
                  setChosen((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(tag.id)) next.add(tag.id)
                    return next
                  })
                }
              />
              {tagChipLabel(tag)}
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  )
}

/** Where a selection is filed. *Unfiled* is a real destination rather than a
 * cancel, which is why it is an option in the list and not an absence. */
function BulkMoveDialog({
  count,
  folders,
  busy,
  onClose,
  onRun,
}: {
  count: number
  folders: readonly AssetFolder[]
  busy: boolean
  onClose: () => void
  onRun: (folderId: string | null) => void
}) {
  const [folderId, setFolderId] = useState('')
  const files = `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`

  return (
    <Dialog
      title={`Move ${files}`}
      description="Filing changes nothing about the file itself: its link keeps working and published pages are untouched."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            reason="Working…"
            onClick={() => onRun(folderId || null)}
          >
            Move
          </Button>
        </>
      }
    >
      <Field label="Folder" help="Unfiled if none is chosen.">
        {(id) => (
          <Select
            id={id}
            value={folderId}
            disabled={busy}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">Unfiled</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {indentedFolderName(folder)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  )
}

/**
 * The one irreversible action in this screen, and the one dialog that has to say
 * what it is about to break.
 *
 * It opens by posting the delete with **`dryRun: true`** and reading
 * `usedOnPublished` (decision 15) — one aggregate for the whole selection, not
 * `assetUsage` per file, which for four hundred files would be four hundred
 * round trips and a list nobody can read. The number **warns and proceeds**: it
 * does not disable the button, for the reason `assetUsage`'s own header gives —
 * a broken image reference degrades visibly and fixably, while a delete that
 * refuses leaves an editor unable to remove a file at all.
 *
 * The button stays disabled until the probe answers, which is not a spinner for
 * politeness: pressing *Delete* before the warning has arrived is exactly the
 * click this dialog exists to prevent.
 */
function BulkDeleteDialog({
  count,
  used,
  error,
  busy,
  onClose,
  onRun,
}: {
  count: number
  /** How many of the selected files a published page points at, or null while
   * the dry run is still in flight. */
  used: number | null
  error: string | null
  busy: boolean
  onClose: () => void
  onRun: () => void
}) {
  const files = `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`

  return (
    <Dialog
      danger
      title={`Delete ${files}?`}
      description="This cannot be undone."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || used === null}
            reason={busy ? 'Deleting…' : (error ?? 'Checking what uses these files…')}
            onClick={onRun}
          >
            Delete
          </Button>
        </>
      }
    >
      {error ? (
        <p className={css.warn}>{error}</p>
      ) : used === null ? (
        <p className={css.note}>Checking what uses these files…</p>
      ) : used === 0 ? (
        <p className={css.note}>
          None of these files is used on a published page. The files themselves are removed; nothing
          else is.
        </p>
      ) : (
        <p className={css.warn}>
          {used === 1
            ? '1 of these files is used on a published page and will stop loading there.'
            : `${used.toLocaleString('en-US')} of these files are used on published pages and will stop loading there.`}{' '}
          Deleting does not edit those pages.
        </p>
      )}
    </Dialog>
  )
}

/* -------------------------------------------------------------------- tile --- */

function Tile({
  row,
  mount,
  selected,
  focusable,
  onSelect,
  ticked,
  onTick,
}: {
  row: AssetRow
  mount: string
  selected: boolean
  focusable: boolean
  onSelect: () => void
  /** Absent on a mount with no selection layer — the picker's. */
  ticked?: boolean
  onTick?: () => void
}) {
  return (
    // A real `option` inside the grid's `listbox`, focusable and named by its own
    // content — which is what the old library's tiles were not: they were buttons
    // wrapping an image with the filename beside them, so the grid had no traversal
    // at all and every tile was its own tab stop.
    <div
      data-tile=""
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      className={`${css.tile} ${selected ? css.tileOn : ''}`}
      data-ticked={ticked ? '' : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        // **Space ticks and Enter opens**, the Finder and Gmail convention, and
        // the same split `List.tsx`'s `Row` makes — it is the only way a keyboard
        // reaches a checkbox inside a roving-tabindex grid without the checkbox
        // becoming its own tab stop and costing the grid its "one stop in the tab
        // order" property. With no selection layer, both keys select.
        if (e.key === ' ' && onTick) onTick()
        else onSelect()
      }}
    >
      {onTick ? (
        <input
          type="checkbox"
          className={css.tileTick}
          checked={ticked === true}
          // Held out of the tab order for the reason above. `stopPropagation` so
          // ticking a tile does not also open it in the detail panel.
          tabIndex={-1}
          aria-label={`Select ${row.filename}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onTick}
        />
      ) : null}
      <span className={css.tileFrame}>
        {isRenderableImage(row) ? (
          <img
            className={css.tileImage}
            src={thumbUrl(mount, row, TILE_WIDTH)}
            // Empty on purpose: the filename is the accessible name of the option
            // this sits inside, and the row's own `alt` describes the image where it
            // is *used*, not this thumbnail of it.
            alt=""
            loading="lazy"
          />
        ) : (
          <span className={css.tileExt}>{typeLabel(row)}</span>
        )}
      </span>
      <span className={css.tileName}>{row.filename}</span>
      <span className={css.tileMeta}>
        {[dimensionsOf(row), humanSize(row.size)].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------- table --- */

function tableColumn(column: AssetColumn, mount: string): Column<AssetRow> {
  return {
    key: column.key,
    label: column.label,
    ...(column.numeric ? { numeric: true } : {}),
    ...(column.sort ? { sortable: true } : {}),
    cell: (row) => <Cell row={row} column={column} mount={mount} />,
  }
}

function Cell({ row, column, mount }: { row: AssetRow; column: AssetColumn; mount: string }) {
  switch (column.kind) {
    case 'filename':
      return (
        <span className={css.cellFile}>
          {/* A thumbnail even in the table. The filename is what sorts and what you
              search, but "which one is it" is still answered by the picture, and at
              24px it costs one more transform width than the grid already asks for. */}
          {isRenderableImage(row) ? (
            <img
              className={css.cellThumb}
              src={thumbUrl(mount, row, CELL_WIDTH)}
              alt=""
              loading="lazy"
            />
          ) : (
            <span className={css.cellExt}>{typeLabel(row)}</span>
          )}
          <span className={css.cellName}>{row.filename}</span>
        </span>
      )
    case 'type':
      return <span className={css.cellMuted}>{typeLabel(row)}</span>
    case 'dimensions':
      // A dash rather than nothing, so an empty cell reads as deliberate: a file
      // whose header `imageSize` cannot read has no dimensions to show, and every
      // non-image is one of those.
      return dimensionsOf(row) ? (
        <span className={css.cellNum}>{dimensionsOf(row)}</span>
      ) : (
        <span className={css.cellBlank}>—</span>
      )
    case 'size':
      return <span className={css.cellNum}>{humanSize(row.size)}</span>
    case 'created':
      return <span className={css.cellNum}>{addedAgo(row.createdAt)}</span>
  }
}

/* ------------------------------------------------------------------- empty --- */

/** Two empty states, because they are different facts: an empty library wants an
 * upload, and a filter that matches nothing wants clearing. An `EmptyState` with no
 * action is an error message. */
function Empty({
  narrowed,
  onClear,
  children,
}: {
  narrowed: boolean
  onClear: () => void
  children: ReactNode
}) {
  if (narrowed) {
    return (
      <EmptyState
        title="Nothing matches"
        body="Try a different type, or clear the search."
        action={
          <Button size="sm" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    )
  }
  return (
    <EmptyState
      title="Nothing uploaded yet"
      body="Drop files anywhere here, or choose them. Images get their dimensions read on the way in, and are resized on the way out."
      action={children}
    />
  )
}

/**
 * How many tiles are in a row, measured rather than declared.
 *
 * `repeat(auto-fill, minmax(…))` decides the count from the available width, so the
 * only place the number exists is the rendered layout: a CSS custom property would
 * have to be kept in step with the grid template by hand, in a second file, and
 * would be wrong at every breakpoint nobody remembered to update. Counting the tiles
 * that share the first one's `offsetTop` asks the browser what it did.
 */
function columnsOf(tiles: readonly HTMLElement[]): number {
  const top = tiles[0]?.offsetTop
  if (top === undefined) return 1
  let n = 0
  for (const tile of tiles) {
    if (tile.offsetTop !== top) break
    n += 1
  }
  return Math.max(1, n)
}
