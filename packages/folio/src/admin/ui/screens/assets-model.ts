/**
 * The Assets screen's arithmetic: what a tile and a table cell read, which
 * orderings exist and which direction each starts in, how the screen's state gets
 * into and out of a URL, and how the keyboard moves across a grid.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts` and `documents-model.ts` are the pattern; this
 * is the third instance of it.
 *
 * It replaces the decidable half of `AssetInput.tsx`'s `MediaLibrary`, which had
 * almost none: that surface fetched page one of `GET {base}/assets` and rendered
 * it, with no search, no filter, no sort, no metadata and no usage. Everything
 * below is new rather than ported, with three exceptions noted where they appear
 * (`humanSize`, the thumbnail URL shape, and `keyAssets` at the foot of the file —
 * the last of which is a *field's* concern rather than this screen's, and says so).
 */
import type { AssetSort } from '../../../core/story'
import type { AssetValue } from '../../../core/values'
import type { AssetRow } from '../../../server/assets'

/** Re-exported so a screen file imports its row type from the model beside it
 * rather than reaching into `server/` for a shape it only ever reads. */
export type { AssetRow }

/* ------------------------------------------------------------------- kinds --- */

/**
 * The type filter. `?kind=` is a **`content_type` prefix** server-side
 * (`listAssets`: `content_type like ?`), so the URL carries the prefix itself
 * rather than a second vocabulary the client would have to translate.
 *
 * **Two kinds and no third, and `video` is the one deliberately missing.**
 * `uploadAsset` stores what the *bytes* say they are, screened against
 * `SERVED_CONTENT_TYPES` — five raster image types — and stores everything else as
 * `application/octet-stream`. So no row in the table can ever have a `video/`
 * content type, and a `Video` chip would be a filter that is guaranteed to select
 * nothing. `ui-architecture.md` names `image`, `video` and `application` as the
 * examples of a prefix; two of them are reachable.
 *
 * **Rejected: offering it anyway** so the chips read like a complete taxonomy. A
 * control that cannot produce a result is the same fault as a disabled one with no
 * explanation, and this screen has no way to explain it.
 */
export type KindFilter = 'all' | 'image' | 'application'

export const KINDS: readonly { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  // "Files" rather than "Other" or "Documents": an upload that is not one of the
  // five raster types lands here whatever it is, and the honest name for that set
  // is the generic one.
  { value: 'application', label: 'Files' },
]

/**
 * The kind a field's `accept` implies, or `undefined` when it implies none.
 *
 * This is what lets the picker filter **server-side** for an `image()` field
 * instead of hiding rows a page at a time. An `accept` of `image/*` or
 * `image/png,image/webp` is a promise that only images may be chosen, and the
 * route already answers exactly that question.
 *
 * Deliberately narrow: only an `accept` whose every entry shares one prefix maps to
 * a kind, because `?kind=` is a single prefix and `image/png,application/pdf` is
 * not expressible as one. A mixed or absent `accept` means no imposed kind and the
 * picker shows the chips.
 */
export function kindForAccept(accept: string | undefined): KindFilter | undefined {
  const parts = (accept ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return undefined
  const prefixes = new Set(parts.map((part) => part.split('/')[0] ?? ''))
  if (prefixes.size !== 1) return undefined
  const only = [...prefixes][0]
  return only === 'image' || only === 'application' ? only : undefined
}

/* -------------------------------------------------------------------- view --- */

export type AssetView = 'grid' | 'table'

/**
 * The default when neither the URL nor the browser's memory says anything. A grid,
 * because the first question about a media library is "which one is it" and a
 * filename answers that worse than a picture does; the table is for the second
 * question, which is about bytes and dates.
 */
export const DEFAULT_ASSET_VIEW: AssetView = 'grid'

export function isAssetView(raw: string): raw is AssetView {
  return raw === 'grid' || raw === 'table'
}

/* --------------------------------------------------------------------- URL --- */

export interface AssetsUrl {
  view: AssetView
  sort: AssetSort
  /** Absent means the sort's own natural direction — see `naturalDir`. Only
   * present once somebody has reversed it. */
  dir: 'asc' | 'desc' | undefined
  kind: KindFilter
  q: string
  /**
   * The asset whose detail panel is open.
   *
   * In the URL because **an asset is a thing somebody sends a colleague**: "have a
   * look at this logo" is a link, and a detail panel that only existed as component
   * state would make it a set of instructions instead. It is also the one piece of
   * this screen's state that names a *record* rather than a view — which is why it
   * survives a filter change (see `withFilter`).
   */
  asset: string | undefined
}

export function parseAssetsUrl(
  query: Readonly<Record<string, string>>,
  /** What to use when the URL says nothing — the last choice, remembered. */
  defaults: { view: AssetView },
): AssetsUrl {
  return {
    view: query.view !== undefined && isAssetView(query.view) ? query.view : defaults.view,
    sort: isAssetSort(query.sort) ? query.sort : 'created',
    dir: query.dir === 'asc' || query.dir === 'desc' ? query.dir : undefined,
    kind: isKindFilter(query.kind) ? query.kind : 'all',
    q: query.q ?? '',
    asset: query.asset || undefined,
  }
}

/**
 * The inverse, as the query object `href` takes. Defaults are written as
 * `undefined` so they leave the URL rather than sitting in it: `?view=grid&
 * sort=created&dir=desc&kind=all` says exactly what the bare path says.
 *
 * `view` is omitted when it is the *hard* default rather than the remembered one,
 * which is the same trade `contentQuery` makes: a bare `{base}/assets` sent to
 * somebody who last chose the table opens their table. The alternative is writing
 * `?view=` on every URL so a link always means one thing, at the cost of every
 * link carrying a parameter nobody set — and the owner's rule is linkable first,
 * *convenient second*, in that order but with both.
 */
export function assetsQuery(url: AssetsUrl): Record<string, string | undefined> {
  return {
    view: url.view === DEFAULT_ASSET_VIEW ? undefined : url.view,
    sort: url.sort === 'created' ? undefined : url.sort,
    dir: url.dir === naturalDir(url.sort) ? undefined : url.dir,
    kind: url.kind === 'all' ? undefined : url.kind,
    q: url.q || undefined,
    asset: url.asset,
  }
}

/**
 * Each sort's own direction — the one it shows before anybody reverses it.
 *
 * Stated here and in `server/assets.ts`'s `ORDERS` on purpose, and the two have to
 * agree: the URL is written here and read there. `core/story.ts`'s `AssetSort`
 * carries the argument for each, and the interesting one is `size` **descending** —
 * nobody sorts a media library looking for the smallest file; they sort it because
 * the bucket is bigger than expected and they are hunting the 8MB PNG.
 */
export function naturalDir(sort: AssetSort): 'asc' | 'desc' {
  return sort === 'filename' ? 'asc' : 'desc'
}

/** The direction in force, resolving the absent case. */
export function dirOf(url: AssetsUrl): 'asc' | 'desc' {
  return url.dir ?? naturalDir(url.sort)
}

/**
 * What choosing an ordering means: the same one flips direction, a different one
 * starts at its own natural direction.
 *
 * The second half is the part worth stating, and it is the same rule
 * `documents-model.ts`'s `withSort` records: carrying the previous column's
 * direction over is the obvious implementation and it is wrong. Reversing
 * `filename` to Z→A and then choosing `size` would give you smallest-first, which
 * nobody asked for and which reads as a bug rather than a preserved preference.
 */
export function withSort(url: AssetsUrl, sort: AssetSort): AssetsUrl {
  if (url.sort !== sort) return { ...url, sort, dir: naturalDir(sort) }
  return { ...url, dir: dirOf(url) === 'asc' ? 'desc' : 'asc' }
}

/**
 * Switching grid ↔ table, **and it keeps the filters** — which is the one place
 * this toggle deliberately differs from Content's `[ Tree | Flat ]`.
 *
 * `withView` there clears the state, type and search when you go back to Tree,
 * because a tree loaded one level at a time *cannot* show a filtered result
 * without silently dropping matches whose ancestors do not match. Nothing like
 * that applies here: a grid and a table are two arrangements of the same page of
 * the same query, so a filter means precisely the same thing in both and clearing
 * it would be destroying state for a cosmetic change.
 */
export function withView(url: AssetsUrl, view: AssetView): AssetsUrl {
  return { ...url, view }
}

/**
 * A filter change. **The open asset survives it**, deliberately.
 *
 * A filter is about the *list*; `asset` names a file. Closing the panel because
 * somebody typed in the search box would throw away the thing they were reading in
 * order to help them find something else. The panel renders from a row the screen
 * has already seen, so it stays correct even once the filter excludes it.
 */
export function withFilter(
  url: AssetsUrl,
  patch: Partial<Pick<AssetsUrl, 'kind' | 'q'>>,
): AssetsUrl {
  return { ...url, ...patch }
}

/**
 * Telling "nothing uploaded yet" from "nothing matches", which are different empty
 * states — offering *clear filters* under the first is offering to clear nothing.
 */
export function isNarrowed(url: AssetsUrl): boolean {
  return url.kind !== 'all' || url.q.trim() !== ''
}

/**
 * The request `GET {base}/api/assets` gets for a screen state.
 *
 * One function so the URL the screen shows and the request it makes cannot
 * disagree — the same rule `documents-model.ts`'s `documentsParams` follows.
 *
 * **`asset` is not a parameter**, and it is worth saying why it is missing rather
 * than looking missing: the selected id is a *place on this screen*, not a
 * narrowing of the list. It is resolved by `GET {base}/api/assets/:id` when the page
 * does not already hold it — see `panelSubject`.
 */
export function assetsParams(
  url: AssetsUrl,
  opts: { limit: number; cursor?: string | null; count?: boolean },
): URLSearchParams {
  const params = new URLSearchParams({
    sort: url.sort,
    dir: dirOf(url),
    limit: String(opts.limit),
  })
  if (url.kind !== 'all') params.set('kind', url.kind)
  const q = url.q.trim()
  if (q) params.set('q', q)
  if (opts.count) params.set('count', '1')
  if (opts.cursor) params.set('cursor', opts.cursor)
  return params
}

function isAssetSort(raw: string | undefined): raw is AssetSort {
  return raw === 'created' || raw === 'filename' || raw === 'size'
}

function isKindFilter(raw: string | undefined): raw is KindFilter {
  return raw === 'all' || raw === 'image' || raw === 'application'
}

/* ----------------------------------------------------------------- columns --- */

export type AssetColumnKind = 'filename' | 'type' | 'dimensions' | 'size' | 'created'

export interface AssetColumn {
  key: string
  label: string
  kind: AssetColumnKind
  /** Right-aligned and tabular. */
  numeric?: boolean
  /** The ordering this header asks the route for, or absent when the column
   * cannot be sorted. */
  sort?: AssetSort
}

/**
 * The table's columns. **Every one of the three orderings has a column here**,
 * which is the property Documents could not have — an `indexed` value lives in
 * another table and is null for anything unpublished, so two of its columns sort
 * and the rest do not. An asset's filename, size and creation stamp are all real
 * columns on `assets`, so the header row and the sort axis are the same three
 * facts, and nothing on this screen sorts by something you cannot see.
 *
 * `type` and `dimensions` are the two that do not sort, and neither wants to:
 * `core/story.ts`'s `AssetSort` argues `contentType` out (it would order by the
 * spelling of a MIME string, when `?kind=` is what somebody grouping by type
 * actually wants), and a sort by pixel area has no index, no cursor pair and no
 * question behind it.
 */
export const ASSET_COLUMNS: readonly AssetColumn[] = [
  { key: 'filename', label: 'File', kind: 'filename', sort: 'filename' },
  { key: 'type', label: 'Type', kind: 'type' },
  { key: 'dimensions', label: 'Dimensions', kind: 'dimensions', numeric: true },
  { key: 'size', label: 'Size', kind: 'size', numeric: true, sort: 'size' },
  { key: 'created', label: 'Added', kind: 'created', numeric: true, sort: 'created' },
]

/** Which column the current sort belongs to, for `Table`'s `aria-sort`. Derived
 * rather than hard-coded, so a column that gains a sort needs no edit here. */
export function sortColumnKey(url: AssetsUrl): string {
  return ASSET_COLUMNS.find((column) => column.sort === url.sort)?.key ?? ''
}

/* ------------------------------------------------------------------- cells --- */

/**
 * Bytes, as somebody reads them. Carried over from `AssetInput.tsx`'s `humanSize`,
 * which is one of exactly two things worth keeping from the surface this screen
 * replaces.
 *
 * `Math.max(1, …)` on the kB branch is not cosmetic: a 300-byte favicon rounds to
 * `0 kB` otherwise, and a file listed as taking no space reads as a broken row
 * rather than a small one. Bytes below a kilobyte are shown exactly, because at
 * that size the exact number is shorter than the rounded one.
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} kB`
}

/** `1200×800`, or `''` for a file whose header `imageSize` could not read — which
 * is every non-image and any image format it does not parse. */
export function dimensionsOf(row: Pick<AssetRow, 'width' | 'height'>): string {
  return row.width && row.height ? `${row.width}×${row.height}` : ''
}

/**
 * The short type label: the filename's extension, uppercased.
 *
 * The extension rather than the content type, and the reason is that the stored
 * content type is deliberately lossy. `uploadAsset` stores
 * `application/octet-stream` for everything outside the five raster types it
 * serves inline, so a PDF, a zip and a font are all one string — and `PDF` is what
 * a person is scanning the column for. Falls back to the content type's subtype
 * when a filename has no extension at all.
 */
export function typeLabel(row: Pick<AssetRow, 'filename' | 'contentType'>): string {
  const ext = extensionOf(row.filename)
  if (ext) return ext.toUpperCase()
  return row.contentType.split('/')[1] ?? row.contentType
}

/** The extension without its dot, lowercase, or `''`. A leading-dot filename
 * (`.gitignore`) has none — `split` would otherwise call the whole name one. */
export function extensionOf(filename: string): string {
  const at = filename.lastIndexOf('.')
  return at > 0 ? filename.slice(at + 1).toLowerCase() : ''
}

/**
 * Whether `/asset/:key` will render this row inline as an image — which is a
 * narrower question than "is this an image", and getting the two confused is how a
 * grid ends up with broken tiles.
 *
 * **Deliberately not `core/values.ts`'s `isImageAsset`.** That one also accepts a
 * *filename* that looks like an image, which is right for a field value that may
 * point at an external URL. Here the bytes are ours and the stored content type has
 * already been screened at upload against `SERVED_CONTENT_TYPES`: an SVG is stored
 * as `application/octet-stream` and `serveAsset` echoes it back as an attachment,
 * on purpose, because rendering SVG on this origin is a script-execution vector. So
 * `logo.svg` passes `isImageAsset` and would get an `<img>` pointing at a download.
 * The content type is the only honest test.
 */
export function isRenderableImage(row: Pick<AssetRow, 'contentType'>): boolean {
  return row.contentType.startsWith('image/')
}

/**
 * A thumbnail URL, through the transform route — so a 4MB original is never the
 * 160px tile.
 *
 * `mount` and **not** `apiBase`: `/asset/:key` is not part of the admin's internal
 * JSON and stays on the bare mount, because published pages point their `<img>`
 * tags at it and its URL is baked into rendered HTML through `Resolution.assetBase`
 * (`server/routes/assets.ts` says so at the mount). The same shape
 * `AssetInput.tsx` already used, which is the second of the two things worth
 * keeping from it.
 *
 * `w` and a format, and deliberately **no `fit`**: every distinct clamped transform
 * is its own billable Images invocation and its own immutable cache entry, so
 * asking for `fit=cover` at a tile's aspect ratio would mint a second variant of
 * every image in the library for a crop `object-fit: cover` does for free in the
 * browser. Widths are therefore a small fixed set — see the callers.
 */
export function thumbUrl(mount: string, row: Pick<AssetRow, 'key'>, width: number): string {
  return `${mount}/asset/${encodeURIComponent(row.key)}?w=${width}&f=webp`
}

/** The original bytes, untransformed — for a download link and for a file the
 * transform route will not touch. */
export function originalUrl(mount: string, row: Pick<AssetRow, 'key'>): string {
  return `${mount}/asset/${encodeURIComponent(row.key)}`
}

/**
 * The value an asset field stores for a library row.
 *
 * A copy of `server/assets.ts`'s `toAssetValue` rather than an import of it, and
 * the reason is bundling: that module is a Worker module — it reaches for
 * `R2Bucket`, `D1Database`, the Images binding and `readCappedBody` — and pulling
 * it into the admin's bundle to reuse eight property assignments is the wrong
 * trade. The unit test asserts the two agree over the same row, which is what keeps
 * a copy honest.
 *
 * Note what is **not** carried: `focal`. A focal point is a property of a *use*, not
 * of a file (see `AssetDetail`), so there is nothing on an `AssetRow` to copy.
 */
export function assetValue(row: AssetRow): AssetValue {
  return {
    key: row.key,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    ...(row.width ? { width: row.width } : {}),
    ...(row.height ? { height: row.height } : {}),
    alt: row.alt,
  }
}

/* ------------------------------------------------------------------- panel --- */

/**
 * What the detail column is showing, which is not simply "a row or nothing" — there
 * are five answers and four of them need saying out loud.
 */
export type PanelSubject =
  | { state: 'none' }
  | { state: 'row'; row: AssetRow }
  /** Being fetched. Skeleton, not a spinner: the panel's shape is known. */
  | { state: 'loading' }
  /** The route answered 404. A genuinely stale link — the file has been deleted. */
  | { state: 'gone' }
  /** Something else went wrong. **Not the same as `gone`**, and conflating them is
   * the failure this type exists to prevent: telling somebody their file was deleted
   * because their laptop lost wifi is a lie that would send them looking for a
   * backup. */
  | { state: 'error'; message: string }

/**
 * Which of the five the panel is in, and the precedence between them.
 *
 * `inHand` is a row the screen already has — either on the page the list returned, or
 * one it resolved earlier and kept. It **wins over every lookup state**, which is
 * what stops the panel flickering to a skeleton every time the list is re-read after
 * a `PATCH` or a delete.
 *
 * The other half of the same rule lives in the caller and is why this takes `inHand`
 * separately rather than looking at the lookup alone: **no request is made at all
 * when the row is in hand.** `?asset=` naming something on the page in front of you
 * is the common case, and it costs nothing.
 *
 * Pure and exported because the precedence is the decidable part, and because
 * `gone` vs `error` is exactly the distinction a test should hold still.
 */
export function panelSubject(
  asset: string | undefined,
  inHand: AssetRow | null,
  lookup: { row: AssetRow | null; gone: boolean; error: string | null; loading: boolean },
): PanelSubject {
  if (!asset) return { state: 'none' }
  if (inHand && inHand.id === asset) return { state: 'row', row: inHand }
  if (lookup.row && lookup.row.id === asset) return { state: 'row', row: lookup.row }
  if (lookup.gone) return { state: 'gone' }
  if (lookup.error) return { state: 'error', message: lookup.error }
  // Loading last among the failures but before `none`: an id with nothing resolved
  // and nothing refused yet is a request in flight, including the first render before
  // the effect has run.
  return { state: 'loading' }
}

/* ------------------------------------------------------------------- dates --- */

/**
 * When a file was added, relative and coarse.
 *
 * The same scale as `content-rows.ts`'s `when`, and deliberately **not** that
 * function: `when` is typed on a story's two timestamps and encodes the
 * `coalesce(draft_updated_at, updated_at)` rule that makes "last edited" mean
 * something. An asset has one timestamp and no drafts, so calling it would mean
 * handing it a fake `draftUpdatedAt: null` and making a file look like a document.
 *
 * `now` is a parameter so this is pure — a clock read inside would make it the one
 * thing in this file a test could not pin.
 */
export function addedAgo(at: number, now: number = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The absolute stamp, for the detail panel — where the exact date is the point
 * and "412d ago" is not. */
export function addedOn(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/* ---------------------------------------------------------------- keyboard --- */

/**
 * Where an arrow key moves in a **grid** of tiles.
 *
 * `rank.ts`'s `nextIndex` is the one-dimensional version and this is deliberately
 * not a call to it, for two reasons that are both about the second axis:
 *
 * 1. **↑ ↓ move by a row of tiles, not by one item.** The column count is a layout
 *    fact — `repeat(auto-fill, …)` decides it from the available width — so it is
 *    passed in, measured from the DOM by the caller. There is no way to derive it
 *    here and no way for the caller to avoid measuring it.
 * 2. **It clamps where `nextIndex` wraps.** `nextIndex`'s ArrowDown is modulo, so
 *    the last row steps to the first. In a grid that is a jump across two axes at
 *    once — bottom-right to top-left — and reads as the focus having been lost
 *    rather than moved. `Home` and `End` are how you cross the whole set.
 *
 * `null` for a key this does not claim, so the caller can leave it to the browser.
 */
export function gridStep(
  key: string,
  current: number,
  count: number,
  columns: number,
): number | null {
  if (count === 0) return null
  const cols = Math.max(1, columns)
  // -1 is "focus is on the container, nothing active yet" — every direction lands
  // on the first tile from there rather than computing an offset from nowhere.
  const from = current < 0 ? 0 : current
  const clamp = (n: number) => Math.min(count - 1, Math.max(0, n))
  switch (key) {
    case 'ArrowRight':
      return current < 0 ? 0 : clamp(from + 1)
    case 'ArrowLeft':
      return current < 0 ? 0 : clamp(from - 1)
    case 'ArrowDown':
      return current < 0 ? 0 : clamp(from + cols)
    case 'ArrowUp':
      return current < 0 ? 0 : clamp(from - cols)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    // Three rows, which is roughly a screen of tiles at the sizes this grid uses.
    // `nextIndex` pages by a flat 10 rows; in a grid the same gesture has to be
    // expressed in tiles, and 10 tiles at six columns is not a page of anything.
    case 'PageDown':
      return clamp(from + cols * 3)
    case 'PageUp':
      return clamp(from - cols * 3)
    default:
      return null
  }
}

/* ----------------------------------------------------------------- uploads --- */

export type UploadStatus = 'uploading' | 'done' | 'failed'

/** One file in the batch currently being uploaded, or the one that just was. */
export interface UploadEntry {
  /** Minted, never stored: a React key and nothing else. Two files with the same
   * name in one batch are two entries. */
  id: string
  filename: string
  status: UploadStatus
  /** Set for `failed` only, and it is the server's own message — the byte cap and
   * the empty-body refusal both say something specific and useful. */
  error?: string
}

export interface UploadSummary {
  busy: boolean
  done: number
  failed: number
  /** The line above the per-file list. */
  text: string
}

/**
 * How a batch reads while it runs and once it stops.
 *
 * **The per-file list is the report, not this line** — `ui-architecture.md`'s
 * acceptance for this phase asks for failures reported per file rather than as one
 * toast, because `MAX_UPLOAD_BYTES` and the content-length check mean a batch of
 * ten can land nine. So this is a heading over the detail, and it names the split
 * (`9 uploaded · 1 failed`) rather than rounding it to "some files failed".
 */
export function uploadSummary(entries: readonly UploadEntry[]): UploadSummary {
  const done = entries.filter((e) => e.status === 'done').length
  const failed = entries.filter((e) => e.status === 'failed').length
  const busy = entries.some((e) => e.status === 'uploading')
  if (busy) {
    // The count of what has settled, out of the batch — so a long upload shows
    // movement without needing a byte-level progress event (`fetch` has none).
    return { busy, done, failed, text: `Uploading ${done + failed + 1} of ${entries.length}…` }
  }
  if (failed === 0) {
    return { busy, done, failed, text: `Uploaded ${done} ${done === 1 ? 'file' : 'files'}` }
  }
  return {
    busy,
    done,
    failed,
    text: done === 0 ? `${failed} failed` : `${done} uploaded · ${failed} failed`,
  }
}

/* ------------------------------------------------------------- field cards --- */

/*
 * `keyAssets` and its two comparisons, moved here from `admin/AssetInput.tsx` when
 * port phase 8 deleted the old admin. It belongs to a `multiasset` *field* rather
 * than to this screen, and it is here anyway because it is the only asset
 * arithmetic in the port that a Node test can reach: the field is
 * `screens/fields/AssetField.tsx`, whose `useAssetKeys` is the hook around this and
 * cannot be tested without a renderer.
 */

/**
 * One card's stable React key, paired with the asset it is drawn from.
 *
 * The key is **local and minted here**. It is never written back: a `multiasset`
 * value is an array of `AssetValue`, and adding an id to it would put a
 * client-side render detail into the mutation log, where it would outlive every
 * deploy. So identity is reconstructed on each render instead, from the previous
 * render's answer.
 */
export interface KeyedAsset {
  /** Minted, not stored. Only ever a React key. */
  id: string
  asset: AssetValue
}

/** The R2 key, or the absolute URL for an asset hosted elsewhere. Not unique —
 * the same file may legitimately appear twice in one list, which is exactly why
 * the index was being used as a key in the first place. */
const mediaOf = (a: AssetValue) => a.key ?? a.url ?? ''

/** Whole-value equality: the card is showing precisely this, alt and focal
 * point included. */
const sameAsset = (a: AssetValue, b: AssetValue) =>
  a.key === b.key &&
  a.url === b.url &&
  a.filename === b.filename &&
  a.contentType === b.contentType &&
  a.size === b.size &&
  a.width === b.width &&
  a.height === b.height &&
  a.alt === b.alt &&
  a.focal?.x === b.focal?.x &&
  a.focal?.y === b.focal?.y

/**
 * Carry the previous render's card ids onto this render's assets, minting one
 * wherever nothing matches. Pure and exported so the reorder case is tested
 * without mounting.
 *
 * `asAssets` rebuilds every object on every render, so object identity is worth
 * nothing here and the match has to be made on content. It happens in two
 * passes, and the order is the whole point:
 *
 * 1. **Byte-identical first.** A reorder moves values around without changing
 *    any of them, so every card finds its own id and React moves DOM nodes
 *    instead of remounting them. That is what stops a reorder dropping focus.
 * 2. **Then same media, edited.** Typing in a card's alt box changes the value
 *    but not the card, so an unclaimed entry with the same `key`/`url` hands its
 *    id over. Without this pass every keystroke would remount the card and the
 *    caret would be lost after one character — a worse bug than the one being
 *    fixed.
 *
 * Both passes consume from the same pool, so two copies of one file get two
 * distinct ids and keep them.
 */
export function keyAssets(
  previous: readonly KeyedAsset[],
  assets: readonly AssetValue[],
  mint: () => string,
): KeyedAsset[] {
  const spare: (KeyedAsset | undefined)[] = [...previous]
  const out: (KeyedAsset | undefined)[] = assets.map(() => undefined)

  const claim = (at: number, asset: AssetValue): KeyedAsset => {
    const taken = spare[at]!
    spare[at] = undefined
    return { id: taken.id, asset }
  }

  assets.forEach((asset, i) => {
    const at = spare.findIndex((e) => e !== undefined && sameAsset(e.asset, asset))
    if (at !== -1) out[i] = claim(at, asset)
  })

  assets.forEach((asset, i) => {
    if (out[i]) return
    const at = spare.findIndex((e) => e !== undefined && mediaOf(e.asset) === mediaOf(asset))
    out[i] = at === -1 ? { id: mint(), asset } : claim(at, asset)
  })

  return out as KeyedAsset[]
}
