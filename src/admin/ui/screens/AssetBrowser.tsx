import type { KeyboardEvent, ReactNode } from 'react'
import { useRef } from 'react'
import type { AssetSort } from '../../../core/story'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
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
  gridStep,
  humanSize,
  isNarrowed,
  isRenderableImage,
  KINDS,
  sortColumnKey,
  thumbUrl,
  typeLabel,
  uploadSummary,
  withFilter,
  withSort,
  withView,
} from './assets-model'
import css from './Assets.module.css'
import type { AssetsData, Uploads } from './useAssets'

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
  /** Tighter tiles and one column fewer, for the dialog mount. */
  compact?: boolean
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
  const { mount, url, onUrl, data, upload, selected, label, kinds, accept, compact } = props
  const grid = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)

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

      {firstLoad ? (
        // Skeleton tiles and rows, not a spinner: both have a known shape, so the
        // screen does not jump when the answer lands.
        <div
          className={url.view === 'grid' ? css.skeletonGrid : css.skeletonRows}
          aria-hidden="true"
        >
          {SKELETONS.slice(0, url.view === 'grid' ? 12 : 6).map((key) => (
            <div className={url.view === 'grid' ? css.skeletonTile : css.skeletonRow} key={key} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty narrowed={narrowed} onClear={() => onUrl(withFilter(url, { kind: 'all', q: '' }))}>
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
            />
          ))}
        </div>
      ) : (
        <Table
          label={label}
          columns={columns.map((column) => tableColumn(column, mount))}
          rows={rows}
          rowKey={(row) => row.id}
          currentKey={selected ?? null}
          sort={{ key: sortColumnKey(url), dir: dirOf(url) }}
          onSort={(key) => {
            const sort = ASSET_COLUMNS.find((column) => column.key === key)?.sort
            if (sort) onUrl(withSort(url, sort))
          }}
          onOpen={(row) => props.onSelect(row.id)}
        />
      )}

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
  )
}

/* -------------------------------------------------------------------- tile --- */

function Tile({
  row,
  mount,
  selected,
  focusable,
  onSelect,
}: {
  row: AssetRow
  mount: string
  selected: boolean
  focusable: boolean
  onSelect: () => void
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
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSelect()
      }}
    >
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
