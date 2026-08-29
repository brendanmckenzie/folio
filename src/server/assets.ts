/**
 * Uploads, the media library, and serving.
 *
 * Uploads are proxied through the Worker into an R2 binding rather than going
 * straight to R2 with a presigned PUT. That needs no credentials and no
 * S3-compatible endpoint, so it works in `wrangler dev` against the local R2
 * simulator with nothing configured. Presigning can be added later without
 * changing a single stored value.
 *
 * Resizing happens behind Folio's own route, so a stored asset never encodes a
 * resizing strategy — a document written on a `workers.dev` preview renders
 * identically on a zone.
 */
import type { AssetValue } from '../core/values'
import type { AssetTransform } from '../core/resolve'
import { FolioError } from './errors'
import { DOWNLOAD_CONTENT_TYPE, isInlineContentType, SERVED_CONTENT_TYPES } from './validate'
import { clampLimit, type CursorPart, decodeCursor, type Page, paginate } from '../core/pagination'
import { type AssetSort, DEFAULT_ASSET_SORT, type StoryMeta } from '../core/story'
import { assetReferences, clearInboundRefStatements } from './content-index'
import { type Direction, type Keyset, keysetWhere, NEWEST_FIRST, orderBy, whereOf } from './keyset'
import { storiesForChunked } from './stories'

/** Matches the Images binding's own input ceiling, so failures happen up front. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export interface AssetRow {
  id: string
  key: string
  filename: string
  contentType: string
  size: number
  width: number | null
  height: number | null
  alt: string
  createdAt: number
}

const COLS = `id, key, filename, content_type as contentType, size, width, height,
              alt, created_at as createdAt`

/**
 * The three orderings the Assets screen offers, and their natural directions.
 * `core/story.ts`'s `AssetSort` carries the argument for each direction — the
 * interesting one is `size` descending, because nobody sorts a media library
 * looking for the smallest file.
 *
 * Only `created` has an index behind it (`assets_created`); the other two are a
 * scan and a sort over a table bounded by what somebody uploaded by hand, which is
 * a deliberate non-decision recorded in `migrations/0002_asset_refs.sql` and pinned
 * as an *absence* by `migrations.test.ts`.
 */
const ORDERS = {
  created: NEWEST_FIRST,
  filename: { columns: ['filename', 'id'], direction: 'asc' },
  size: { columns: ['size', 'id'], direction: 'desc' },
} satisfies Record<AssetSort, Keyset>

/** The sort key of a row, component for component with `ORDERS` — the one
 * correspondence `paginate` cannot check for its caller, which is why the two live
 * next to each other. */
function keyOf(sort: AssetSort, row: AssetRow): [CursorPart, CursorPart] {
  switch (sort) {
    case 'created':
      return [row.createdAt, row.id]
    case 'filename':
      return [row.filename, row.id]
    case 'size':
      return [row.size, row.id]
  }
}

export interface ListAssetsOptions {
  limit?: number
  cursor?: string
  /** Substring of the filename. The media library had no search at all, which is
   * what made asset 201 unreachable once the list was capped at 200. */
  q?: string
  /** A `content_type` prefix — `image`, `video`, `application`. */
  kind?: string
  /** Adds `total` for the same filter. One extra `count(*)`, only when asked
   * (`../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
  /** One of `core/story.ts`'s `AssetSort` values. Absent is `created`. */
  sort?: AssetSort
  /**
   * Reverses the ordering. Absent means the sort's own natural direction, which is
   * what a column header shows on its first click.
   *
   * Free and correct for the same reason it is on `listDocumentPage`: `keysetWhere`
   * and `orderBy` both read the direction off one `Keyset`, so flipping it flips
   * the resume comparison and the `order by` together and cannot leave them
   * disagreeing about which way the list runs.
   */
  dir?: Direction
}

/**
 * The media library, paged. Newest first by default over `(created_at, id)`,
 * which is what `assets_created` indexes.
 *
 * Was `listAssets(db, limit = 200)`, capped and clamped to 500 with no cursor and
 * no search, so the 201st asset could not be reached by any route. Then paged, and
 * hard-wired to `NEWEST_FIRST`; the sort axis is the Assets screen's
 * (`docs/ui-architecture.md`: "filename search, type and size filters, sort by
 * date or name or size").
 */
export async function listAssets(
  db: D1Database,
  opts: ListAssetsOptions = {},
): Promise<Page<AssetRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const sort = opts.sort ?? DEFAULT_ASSET_SORT
  const keyset: Keyset = opts.dir ? { ...ORDERS[sort], direction: opts.dir } : ORDERS[sort]
  const resume = keysetWhere(keyset, cursor)

  const filters: string[] = []
  const binds: unknown[] = []
  if (opts.q) {
    filters.push('filename like ?')
    binds.push(`%${opts.q}%`)
  }
  if (opts.kind) {
    filters.push('content_type like ?')
    binds.push(`${opts.kind}%`)
  }
  const where = whereOf(...filters, resume.sql)

  const [rows, total] = await Promise.all([
    db
      .prepare(`select ${COLS} from assets ${where} ${orderBy(keyset)} limit ?`)
      .bind(...binds, ...resume.binds, limit + 1)
      .all<AssetRow>(),
    // The count ignores the cursor deliberately: it counts the whole filter, which
    // is what a header means by "of 1,284" and what a bulk guard would compare.
    opts.count
      ? db
          .prepare(`select count(*) as n from assets ${whereOf(...filters)}`)
          .bind(...binds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results, limit, (row) => keyOf(sort, row))
  return total ? { ...page, total: total.n } : page
}

export async function assetById(db: D1Database, id: string): Promise<AssetRow | null> {
  return db.prepare(`select ${COLS} from assets where id = ?`).bind(id).first<AssetRow>()
}

/* ------------------------------------------------------------------ usage --- */

/**
 * Which published documents use one asset — `docs/ui-architecture.md`
 * dependency 4, for the detail panel's "where it is used" and for a delete
 * confirmation that names what it will break.
 *
 * Deliberately the same shape and the same rules as `stories.ts`'s
 * `documentUsage`, one field narrower:
 *
 *  - **Published usage only, and the dialog says so.** `content_refs` is written
 *    inside the publish batch, so that is all the table holds. Covering drafts
 *    would mean an edge table maintained per keystroke or a scan of every Durable
 *    Object, for a confirmation dialog.
 *  - **It warns and proceeds; it does not gate the delete.** Same call as for a
 *    referenced record (`data-documents.md` decision 4): maintaining referential
 *    integrity across drafts nobody can see costs more than a broken reference,
 *    which already degrades safely — a missing image renders as a missing image,
 *    which is visible and fixable, whereas a delete that refuses leaves an editor
 *    with no way to remove a file at all.
 *  - **No `kind` and no by-kind counts**, which is the one difference. Every asset
 *    edge is one kind (`refs.ts`'s `outboundRefs` says why), so a `kind` column
 *    would be the same word on every row and `links`/`references` would both be
 *    zero. **Rejected: carrying them anyway** so the two usage payloads are
 *    byte-identical — a field that is always the same value is not a shape, it is
 *    noise, and a client that reads `usage.total` reads it the same either way.
 *
 * Keyed by the **R2 key** rather than the asset id, because that is what a
 * document stores and therefore what the edge holds. The route looks the row up
 * first, which it has to do anyway to 404 an unknown id.
 *
 * In `assets.ts` rather than beside `documentUsage`: this is the reader for an
 * asset, and `stories.ts` would otherwise have to import the media library to turn
 * an id into a key. It reaches the other way instead — one import of
 * `storiesForChunked`, and `stories.ts` learns nothing about assets.
 *
 * `storiesForChunked`, not `storiesFor`: outbound edges are capped at 400 rows per
 * document, but *inbound* ones are not, and a logo used on every page of a
 * 500-page site is the normal case for an asset rather than the pathological one.
 * `storiesFor` binds every id in one statement.
 */
export interface AssetUsage {
  /** Published documents using this asset. Routed first, by path; then unrouted
   * by title — an editor scanning "what breaks" wants the pages before the
   * records. */
  published: StoryMeta[]
  /** Distinct published documents, which is what "Used on N published pages"
   * counts. Equal to `published.length`; named so a caller reading only the count
   * does not have to know that. */
  total: number
}

export async function assetUsage(db: D1Database, key: string): Promise<AssetUsage> {
  const from = await assetReferences(db, key)
  if (from.length === 0) return { published: [], total: 0 }

  // A row whose source story has since been deleted is dropped rather than
  // reported as an untitled usage. `deleteStoryStatement` clears a deleted story's
  // edges in both directions, so this should not happen on a live site — but an
  // import that wrote edges directly would otherwise put a usage with no title and
  // no URL in front of somebody about to delete a file.
  const published = await storiesForChunked(db, from)
  published.sort(
    (a, b) =>
      (a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) ||
      (a.path ?? a.title).localeCompare(b.path ?? b.title),
  )
  return { published, total: published.length }
}

/**
 * The field value for a library row. Copies `alt` in as a starting point; from
 * then on the two are independent, because alt text depends on what the image is
 * being used to say.
 */
export function toAssetValue(row: AssetRow): AssetValue {
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

/**
 * Reads a request body under a hard byte cap, without ever buffering past it.
 *
 * `contentLengthHeader` (validate.ts) rejects a declared length over the cap
 * before a byte is read, but a declared length is only ever a claim: absent
 * entirely, or understated, it would otherwise let `uploadAsset`'s own
 * post-buffer check catch an oversized file only *after* the whole body sat in
 * memory. Reading incrementally and cancelling the moment the running total
 * passes `max` is what makes the cap real regardless of what the client
 * declared.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel()
        throw new FolioError('too_large', `File is larger than ${Math.floor(max / 1024 / 1024)}MB`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

export async function uploadAsset(
  db: D1Database,
  bucket: R2Bucket,
  input: { bytes: ArrayBuffer; filename: string },
): Promise<AssetRow> {
  if (input.bytes.byteLength === 0) throw new Error('Empty upload')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`)
  }

  const id = `ast_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const filename = safeFilename(input.filename)
  // The filename rides along in the key so a download keeps its name and the URL
  // stays legible. The id prefix makes collisions impossible.
  const key = `${id}-${filename}`
  const view = new Uint8Array(input.bytes)
  // The client's Content-Type header is a hint only, never trusted: what gets
  // stored — and later served back on this origin — is whatever the bytes
  // themselves say they are. A lying header is overridden; bytes matching no
  // known signature fall back to the download type, same as an explicit
  // mismatch would.
  const sniffed = sniffContentType(view)
  const contentType = sniffed && isInlineContentType(sniffed) ? sniffed : DOWNLOAD_CONTENT_TYPE
  const dims = imageSize(view)

  // R2 first: the alternative (row first) can leave a library entry pointing at
  // an object that never made it into the bucket, which is the worse failure —
  // a broken image nobody can explain. Putting the object first only risks the
  // narrow window below, where the insert fails and an orphaned object is left
  // behind; that window is closed immediately by the compensating delete.
  await bucket.put(key, input.bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  })

  const row: AssetRow = {
    id,
    key,
    filename,
    contentType,
    size: input.bytes.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    alt: '',
    createdAt: Date.now(),
  }

  try {
    await db
      .prepare(
        `insert into assets (id, key, filename, content_type, size, width, height, alt, created_at)
         values (?, ?, ?, ?, ?, ?, ?, '', ?)`,
      )
      .bind(
        row.id,
        row.key,
        row.filename,
        row.contentType,
        row.size,
        row.width,
        row.height,
        row.createdAt,
      )
      .run()
  } catch (e) {
    // Compensate: the object must not outlive the row that was supposed to
    // describe it. The compensating delete gets its own try/catch so a
    // failure in it can never displace `e` — the D1 failure is the one the
    // caller needs to see and debug; a failed cleanup is a secondary, orphaned
    // object, not the reportable error.
    try {
      await bucket.delete(key)
    } catch {
      // Best-effort: nothing else to do with a cleanup failure here.
    }
    throw e
  }

  return row
}

export async function updateAsset(db: D1Database, id: string, patch: { alt?: string }) {
  if (patch.alt === undefined) return assetById(db, id)
  await db.prepare('update assets set alt = ? where id = ?').bind(patch.alt, id).run()
  return assetById(db, id)
}

/**
 * Removes the library row, its inbound `content_refs` edges, and the object.
 *
 * **The documents are deliberately left alone.** Rewriting other stories' drafts
 * from here would bypass the mutation log, and a missing image is easier to spot
 * and fix than a silent edit nobody saw. `assetUsage` is what warns first, and the
 * confirmation names the pages — the same "warn and proceed" the delete of a
 * referenced record does.
 *
 * **The edges are not.** `content_refs` rows naming this key are the fact "page A
 * uses this asset", and nothing reads that fact once the asset is gone: every
 * reader of `to_id` is asked about a thing somebody is looking at. Left behind,
 * such a row is only rewritten when A is next published, so a site that never
 * republishes accumulates edges to keys with nothing behind them — exactly the
 * reasoning `clearInboundRefStatements` was written for a deleted *story*, which is
 * why this calls it unchanged rather than writing a second delete
 * (`migrations/0002_asset_refs.sql`).
 */
export async function deleteAsset(db: D1Database, bucket: R2Bucket, id: string): Promise<boolean> {
  const row = await assetById(db, id)
  if (!row) return false
  // D1 before R2: if the row survives (the delete throws), the asset is still
  // listed and still resolves, so a retry is exactly a retry. Deleting the
  // object first and then failing the D1 delete would leave a row that points
  // at nothing, silently breaking whatever still references it.
  //
  // Batched, so the library row and its edges go together: a surviving edge to a
  // key with no row is a usage count for an asset that no longer exists.
  await db.batch([
    db.prepare('delete from assets where id = ?').bind(id),
    ...clearInboundRefStatements(db, [row.key]),
  ])
  try {
    await bucket.delete(row.key)
  } catch {
    // The row is already committed gone by this point, so there is no longer
    // a "retry" that can reach this object: a second call 404s (assetById
    // finds nothing). Swallow rather than throw — the delete already
    // succeeded from the caller's perspective, and reporting a 500 on an
    // operation that in fact committed is worse than the alternative, an
    // orphaned R2 object with nothing left pointing at it.
  }
  return true
}

/* -------------------------------------------------------------- serving --- */

/**
 * Bounds on `w`/`h`. The transform query is public and uncapped otherwise:
 * every distinct `w`/`h`/`q` mints its own Images transformation and its own
 * immutable cache entry, so an unclamped number is an unbounded number of
 * billable variants behind one URL. `MIN` rules out a variant too small to be
 * worth its own Images invocation; both ends snap rather than refuse, so a
 * page whose markup asks for something out of range still renders.
 */
export const MIN_TRANSFORM_DIMENSION = 16
export const MAX_TRANSFORM_DIMENSION = 2400

/** Bounds on `q`. Below 30 is not a usable image; above 90 is not a visibly
 * better one, just another billable variant nobody asked for. */
export const MIN_TRANSFORM_QUALITY = 30
export const MAX_TRANSFORM_QUALITY = 90

/**
 * A query param clamped into `[min, max]`. `null` (the param was never given)
 * stays `undefined` — the caller must not default an absent transform into a
 * requested one — but any parseable number, including one out of range, zero,
 * negative or fractional, snaps into range rather than being dropped. Only a
 * value `Number()` cannot make sense of at all is treated as absent.
 */
function clampedParam(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : undefined
}

/** Clamps a focal-point coordinate into `[0, 1]` — the normalised range the
 * Images binding's `gravity` expects. Same snap-don't-reject rule as `w`/`h`/`q`:
 * an out-of-range `fp` (or one a page's own markup never validated) still
 * produces a servable crop instead of throwing the transform into its catch,
 * which would otherwise serve the full-size original at full R2 egress cost,
 * repeatably, since a thrown transform is never written to the Cache API. */
function clampFocal(n: number): number {
  return Math.min(Math.max(n, 0), 1)
}

export function parseTransform(
  params: URLSearchParams,
): AssetTransform & { focal?: { x: number; y: number } } {
  const fit = params.get('fit')
  const format = params.get('f')
  const [fx, fy] = (params.get('fp') ?? '').split(',').map(Number)

  return {
    width: clampedParam(params.get('w'), MIN_TRANSFORM_DIMENSION, MAX_TRANSFORM_DIMENSION),
    height: clampedParam(params.get('h'), MIN_TRANSFORM_DIMENSION, MAX_TRANSFORM_DIMENSION),
    quality: clampedParam(params.get('q'), MIN_TRANSFORM_QUALITY, MAX_TRANSFORM_QUALITY),
    ...(fit === 'cover' || fit === 'contain' || fit === 'scale-down' ? { fit } : {}),
    ...(format === 'webp' || format === 'avif' || format === 'jpeg' || format === 'png'
      ? { format }
      : {}),
    ...(Number.isFinite(fx) && Number.isFinite(fy)
      ? { focal: { x: clampFocal(fx!), y: clampFocal(fy!) } }
      : {}),
  }
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
/**
 * Cache-control for a response that is *not* the variant a transform query
 * asked for — no Images binding, a non-GET request, or a transform that threw.
 * `immutable` on one of these pins the wrong bytes (wrong content-type, wrong
 * dimensions) in every downstream cache for a year with revalidation
 * suppressed; a short, revalidatable max-age lets the next request try again
 * instead of being stuck.
 */
const DEGRADED = 'public, max-age=60'

/**
 * `sandbox` forbids scripts, forms, and origin-privileged execution outright,
 * so even a signature that slips past `sniffContentType` (or an object put into
 * the bucket by something other than `uploadAsset`) cannot run as this origin —
 * a second layer behind `nosniff`, not a replacement for it.
 */
const CSP = "default-src 'none'; sandbox"

/**
 * Headers common to every response this route returns. `nosniff` and the CSP
 * apply regardless of branch: the content type is derived from a value a
 * client supplied at upload, on a route published pages link to from the
 * site's own origin, so the browser must never be allowed to improve on it,
 * and a mis-sniffed upload must still not be able to run. `content-disposition`
 * is explicit in both directions rather than left to the browser's default:
 * `inline` for the types this route renders, `attachment` for everything else.
 *
 * SVG renders inline, and the CSP above is the entire reason it may: a
 * `sandbox` without `allow-scripts` is what stops an inline SVG on this origin
 * being a script-execution vector. Weakening `CSP` therefore has to be read as
 * a change to what `SANDBOXED_CONTENT_TYPES` is allowed to contain, not as a
 * header tweak.
 */
function serveHeaders(cacheControl: string, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP,
    'content-disposition': isInlineContentType(contentType) ? 'inline' : 'attachment',
  }
}

/**
 * The Cache API key for a transform response: origin, path, and the *clamped*
 * query — never the raw incoming request. `parseTransform` snaps every numeric
 * param into range, but that only bounds the set of distinct outputs; keying
 * the cache on the raw URL leaves every distinct raw query string (`w=99999`,
 * `w=3000`, `w=100&cachebust=1`, `w=+100`, all clamping to the same width) as
 * its own billable Images invocation and its own cache entry, which is exactly
 * the unbounded-cost hole the clamp was supposed to close. Building the key
 * from the transform Folio actually computed collapses all of those onto one
 * entry, and always as a fresh GET request — the only method the Cache API can
 * write a response against — regardless of the method the client used.
 */
function canonicalTransformRequest(
  url: string,
  transform: AssetTransform & { focal?: { x: number; y: number } },
): Request {
  const { origin, pathname } = new URL(url)
  const params = new URLSearchParams()
  if (transform.width) params.set('w', String(transform.width))
  if (transform.height) params.set('h', String(transform.height))
  if (transform.quality) params.set('q', String(transform.quality))
  if (transform.fit) params.set('fit', transform.fit)
  if (transform.format) params.set('f', transform.format)
  if (transform.focal) params.set('fp', `${transform.focal.x},${transform.focal.y}`)
  const query = params.toString()
  return new Request(`${origin}${pathname}${query ? `?${query}` : ''}`)
}

export async function serveAsset(
  bucket: R2Bucket,
  images: ImagesBinding | undefined,
  key: string,
  transform: AssetTransform & { focal?: { x: number; y: number } },
  request: Request,
): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) throw new FolioError('not_found', 'No such asset')

  // Second gate on the same allowlists the upload applies (validate.ts): only
  // the types this route is willing to serve inline are echoed back, so an
  // object written by anything other than `uploadAsset` — or before those
  // allowlists existed — downloads rather than rendering as HTML on this origin.
  const stored = object.httpMetadata?.contentType ?? ''
  const contentType = isInlineContentType(stored) ? stored : DOWNLOAD_CONTENT_TYPE

  const wantsTransform = Boolean(transform.width || transform.height || transform.format)
  // A transform only ever runs for a GET: the Cache API can only ever hold a
  // GET response, and HEAD is routable to this same path (an uptime monitor or
  // link-preview bot does exactly that) — running the transform anyway would
  // mint a billable Images invocation, and writing its result under a HEAD-keyed
  // request is what used to throw and get logged as a transform *failure* for a
  // transform that had, in fact, just succeeded.
  //
  // `SERVED_CONTENT_TYPES` rather than "not a download": a sandboxed type is
  // served inline but never transformed. For SVG that is both pointless (vector
  // — `srcFor({ width })` on one is a no-op by nature) and unwanted (the Images
  // binding has no business decoding attacker-supplied XML), so it takes the
  // untransformed branch below and keeps its immutable cache-control there.
  const canTransform =
    Boolean(images) &&
    wantsTransform &&
    SERVED_CONTENT_TYPES.has(contentType) &&
    request.method === 'GET'

  if (!canTransform) {
    // Nothing here was ever going to be transformed — the type isn't one this
    // route resizes, or no transform was requested at all — is the correct,
    // stable response for the URL it answers and can be pinned for a year. A
    // request that *did* ask for a transform but isn't getting one right now
    // (no Images binding configured, or a non-GET method choosing not to spend
    // one) is a degraded response and must not be.
    const stable = !wantsTransform || !SERVED_CONTENT_TYPES.has(contentType)
    return new Response(object.body, {
      headers: {
        ...serveHeaders(stable ? IMMUTABLE : DEGRADED, contentType),
        etag: object.httpEtag,
      },
    })
  }

  // Every distinct clamped transform below is its own billable Images
  // invocation; the canonical request built above — not the raw request — is
  // the key, so a repeated request for the identical transform is a free hit
  // regardless of what cache-busting or out-of-range query string it arrived
  // under.
  //
  // Cast rather than typed directly off the global: `lib.dom.d.ts`'s own
  // `CacheStorage` (this project's tsconfig pulls in "DOM" for react-dom/server)
  // shadows the Workers one and has no `default` property, though the runtime
  // object underneath is the same either way.
  const cache = (caches as unknown as { default: Cache }).default
  const canonical = canonicalTransformRequest(request.url, transform)
  const cached = await cache.match(canonical)
  if (cached) return cached

  let bytes: ArrayBuffer
  let outContentType: string
  try {
    const op: ImageTransform = {
      ...(transform.width ? { width: transform.width } : {}),
      ...(transform.height ? { height: transform.height } : {}),
      ...(transform.fit ? { fit: transform.fit } : {}),
      // Only meaningful when cropping, and `remainder` is the behaviour the
      // documented `XxY` gravity has: put the focal point of the output where it
      // sits in the original. `parseTransform` has already clamped both
      // coordinates into `[0, 1]`, which is what keeps an out-of-range `fp`
      // from throwing here and falling through to the degraded branch below.
      ...(transform.focal && transform.fit === 'cover'
        ? { gravity: { x: transform.focal.x, y: transform.focal.y, mode: 'remainder' as const } }
        : {}),
    }
    const result = await images!
      .input(object.body)
      .transform(op)
      .output({
        format: `image/${transform.format ?? 'webp'}` as ImageOutputOptions['format'],
        ...(transform.quality ? { quality: transform.quality } : {}),
      })

    // Buffered rather than streamed so an empty result can be caught. A
    // transform that yields nothing still comes back as a 200, and streaming it
    // through would put a silently broken image on the page — the worst
    // available failure mode. Transformed variants are small and cached
    // immutably, so this is paid once per variant.
    bytes = await result.response().arrayBuffer()
    if (bytes.byteLength === 0) throw new Error('Transform produced no output')
    outContentType = result.contentType()
  } catch (e) {
    // Never silent: a transform failure that goes unlogged is indistinguishable
    // from "nobody ever requested this variant".
    console.error(`folio: asset transform failed for ${key}`, e)
    // A transform failing is not a reason to show a broken image. Re-fetch,
    // because `object.body` was consumed by the attempt. Short-lived rather
    // than immutable: this is the original standing in for a variant that
    // failed, not the variant itself, and the failure may well be transient.
    const original = await bucket.get(key)
    if (!original) throw new FolioError('not_found', 'No such asset')
    return new Response(original.body, { headers: serveHeaders(DEGRADED, contentType) })
  }

  const response = new Response(bytes, { headers: serveHeaders(IMMUTABLE, outContentType) })
  // Deliberately outside the transform's own try/catch, and never allowed to
  // turn a successful transform into a reported failure: the transform above
  // already succeeded, so a cache-write failure only costs the next request
  // its cache hit, not this one its correct response.
  try {
    await cache.put(canonical, response.clone())
  } catch (e) {
    console.error(`folio: asset cache write failed for ${key}`, e)
  }
  return response
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'file'
  )
}

/* ------------------------------------------------------------- sniffing --- */

const ascii4 = (bytes: Uint8Array, offset: number): string =>
  bytes.length >= offset + 4
    ? String.fromCharCode(
        bytes[offset]!,
        bytes[offset + 1]!,
        bytes[offset + 2]!,
        bytes[offset + 3]!,
      )
    : ''

/**
 * The upload's real content type, off its own magic bytes. Covers exactly the
 * types validate.ts is willing to serve inline: `SERVED_CONTENT_TYPES` — the
 * formats `imageSize` already reads (png, jpeg, gif, webp) plus avif, cheap to
 * add since its signature is a fixed 12-byte `ftyp` box — and
 * `SANDBOXED_CONTENT_TYPES`, which is SVG. Returns `undefined` for anything
 * else, which `uploadAsset` stores as `DOWNLOAD_CONTENT_TYPE`.
 *
 * Every signature below checks its *full* length rather than a short, cheaper
 * prefix: this function's output becomes the stored — and later served —
 * content-type on a route with `nosniff` as its only other defence, so a
 * partial match (a 4-byte PNG prefix, a 2-byte JPEG SOI, a 3-byte "GIF" with no
 * version) is a gap wide enough for an attacker-chosen payload with a matching
 * prefix to be stored and echoed back as that content-type.
 *
 * SVG has no magic bytes to check the length of, which is what `sniffSvg` is
 * for and why it is stricter than a substring search.
 */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 0x89504e47 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(4) === 0x0d0a1a0a
  ) {
    return 'image/png'
  }
  // SOI (FF D8) is always immediately followed by another marker, which always
  // starts with FF: without that third byte, "FF D8" alone is not a JPEG
  // signature, just its first two bytes.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // The full 6-byte header, not just the 3-byte "GIF" that precedes it: either
  // version string, "GIF87a" or "GIF89a".
  if (
    bytes.length >= 6 &&
    ascii4(bytes, 0).slice(0, 3) === 'GIF' &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (bytes.length >= 12 && ascii4(bytes, 0) === 'RIFF' && ascii4(bytes, 8) === 'WEBP') {
    return 'image/webp'
  }
  if (bytes.length >= 12 && ascii4(bytes, 4) === 'ftyp' && ascii4(bytes, 8) === 'avif') {
    return 'image/avif'
  }
  if (sniffSvg(bytes)) return 'image/svg+xml'
  return undefined
}

/**
 * How far into a file the root element is looked for. An SVG may open with a
 * byte-order mark, an XML declaration, a DOCTYPE and any number of comments
 * before `<svg`, and generators are fond of long licence comments — Illustrator
 * and Inkscape both emit them. Bounded so this stays a header check rather than
 * a scan of a multi-megabyte body.
 */
const SVG_SNIFF_BYTES = 4096

/**
 * Whether the first *element* in the document is `<svg`.
 *
 * Deliberately not "does `<svg` appear near the start": an HTML page carries an
 * inline `<svg>` all the time, and matching one would store an HTML file as
 * `image/svg+xml` and serve it back on this origin. So the prologue is walked —
 * whitespace, a BOM, `<?xml …?>`, `<!DOCTYPE …>`, `<!-- … -->` — and whatever
 * follows must be the root tag itself. `<html>` fails at exactly that point.
 *
 * The scan works on bytes rather than a decoded string. Every token it needs to
 * recognise is ASCII, and a UTF-16 SVG (which would interleave NULs and fail
 * here) is not a file this route needs to serve inline.
 */
function sniffSvg(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SVG_SNIFF_BYTES)
  // UTF-8 BOM. UTF-16's BOM is deliberately not skipped: see above.
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0

  const at = (offset: number, literal: string) => {
    if (offset + literal.length > end) return false
    for (let n = 0; n < literal.length; n++) {
      if (bytes[offset + n] !== literal.charCodeAt(n)) return false
    }
    return true
  }
  /** Past the next occurrence of `literal`, or `-1` if it is not within range. */
  const skipTo = (offset: number, literal: string) => {
    for (let n = offset; n + literal.length <= end; n++) {
      if (at(n, literal)) return n + literal.length
    }
    return -1
  }

  while (i < end) {
    const byte = bytes[i]!
    // Space, tab, LF, CR.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      i++
      continue
    }
    if (at(i, '<?xml')) {
      i = skipTo(i, '?>')
    } else if (at(i, '<!--')) {
      i = skipTo(i, '-->')
    } else if (at(i, '<!DOCTYPE') || at(i, '<!doctype')) {
      // An internal subset (`[ … ]`) can itself contain `>`, so close on `]>`
      // when one is opened. A DOCTYPE this route never serves is not worth
      // parsing further than that.
      const bracket = skipTo(i, '[')
      const close = skipTo(i, '>')
      i = bracket !== -1 && (close === -1 || bracket < close) ? skipTo(i, ']>') : close
    } else {
      // The first thing that is not prologue. It is the root tag or nothing.
      // `<svg` must be followed by a delimiter, so `<svgfoo>` is not a match.
      if (!at(i, '<svg')) return false
      const next = bytes[i + 4]
      return (
        next === 0x20 ||
        next === 0x09 ||
        next === 0x0a ||
        next === 0x0d ||
        next === 0x2f || // /
        next === 0x3e // >
      )
    }
    if (i === -1) return false
  }
  return false
}

/* ------------------------------------------------------------ dimensions --- */

/**
 * Width and height straight out of the file header.
 *
 * Done by hand rather than through `env.IMAGES.info()` so dimensions are
 * recorded even when no Images binding is configured. They are worth having
 * regardless of resizing: a known aspect ratio is what lets a page reserve space
 * for an image instead of reflowing when it loads.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (o: number, le = false) => view.getUint16(o, le)
  const u32 = (o: number, le = false) => view.getUint32(o, le)
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n))

  if (bytes.length >= 24 && u32(0) === 0x89504e47 && ascii(12, 4) === 'IHDR') {
    return { width: u32(16), height: u32(20) }
  }

  if (bytes.length >= 10 && ascii(0, 3) === 'GIF') {
    return { width: u16(6, true), height: u16(8, true) }
  }

  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8X') {
      // 24-bit little-endian, stored as (dimension - 1).
      const w = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
      const h = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
      return { width: w, height: h }
    }
    if (chunk === 'VP8 ') {
      return { width: u16(26, true) & 0x3fff, height: u16(28, true) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = u32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }

  if (bytes.length >= 4 && u16(0) === 0xffd8) return jpegSize(bytes, view)

  return null
}

function jpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    // Start-of-frame markers carry the dimensions. C4, C8 and CC are tables and
    // arithmetic-coding conditioning, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    offset += 2 + view.getUint16(offset + 2)
  }
  return null
}

/**
 * The same listing, paged by **number** for `{base}/api/v1/assets`.
 *
 * Two idioms on purpose (`../../docs/specs/foundation/pagination.md`
 * decision 1): the admin's list is live and pages by cursor, while a script
 * walking a media library wants "page 3 of 7" over content that is not being
 * edited underneath it. Sharing the reader would mean giving one of them the
 * wrong one.
 *
 * Offset paging is the correct trade here and the reason is worth stating: a
 * skipped or repeated row costs a script one duplicate, and it buys a total and a
 * page count that a cursor cannot give.
 */
export async function listAssetsByPage(
  db: D1Database,
  opts: { page: number; perPage: number },
): Promise<{ assets: AssetRow[]; total: number }> {
  const perPage = clampLimit(opts.perPage, 50, 200)
  const page = Math.max(1, Math.trunc(opts.page) || 1)
  const [rows, total] = await Promise.all([
    db
      .prepare(`select ${COLS} from assets order by created_at desc, id desc limit ? offset ?`)
      .bind(perPage, (page - 1) * perPage)
      .all<AssetRow>(),
    db.prepare('select count(*) as n from assets').first<{ n: number }>(),
  ])
  return { assets: rows.results, total: total?.n ?? 0 }
}
