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
import { DOWNLOAD_CONTENT_TYPE, SERVED_CONTENT_TYPES } from './validate'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { keysetWhere, NEWEST_FIRST, orderBy, whereOf } from './keyset'

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

export interface ListAssetsOptions {
  limit?: number
  cursor?: string
  /** Substring of the filename. The media library had no search at all, which is
   * what made asset 201 unreachable once the list was capped at 200. */
  q?: string
  /** A `content_type` prefix — `image`, `video`, `application`. */
  kind?: string
  /** Adds `total` for the same filter. One extra `count(*)`, only when asked
   * (`../../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
}

/**
 * Newest first, paged over `(created_at, id)` — which is what `assets_created`
 * indexes.
 *
 * Was `listAssets(db, limit = 200)`, capped and clamped to 500 with no cursor and
 * no search, so the 201st asset could not be reached by any route.
 */
export async function listAssets(
  db: D1Database,
  opts: ListAssetsOptions = {},
): Promise<Page<AssetRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(NEWEST_FIRST, cursor)

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
      .prepare(`select ${COLS} from assets ${where} ${orderBy(NEWEST_FIRST)} limit ?`)
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

  const page = paginate(rows.results, limit, (row) => [row.createdAt, row.id])
  return total ? { ...page, total: total.n } : page
}

export async function assetById(db: D1Database, id: string): Promise<AssetRow | null> {
  return db.prepare(`select ${COLS} from assets where id = ?`).bind(id).first<AssetRow>()
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
  const contentType = sniffed && SERVED_CONTENT_TYPES.has(sniffed) ? sniffed : DOWNLOAD_CONTENT_TYPE
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
 * Removes the library row and the object. Documents already referencing the key
 * are deliberately left alone: rewriting other stories' drafts from here would
 * bypass the mutation log, and a missing image is easier to spot and fix than a
 * silent edit nobody saw.
 */
export async function deleteAsset(db: D1Database, bucket: R2Bucket, id: string): Promise<boolean> {
  const row = await assetById(db, id)
  if (!row) return false
  // D1 before R2: if the row survives (the delete throws), the asset is still
  // listed and still resolves, so a retry is exactly a retry. Deleting the
  // object first and then failing the D1 delete would leave a row that points
  // at nothing, silently breaking whatever still references it.
  await db.prepare('delete from assets where id = ?').bind(id).run()
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
 * `inline` for the five raster types this route renders, `attachment` for
 * everything else — svg included, since rendering it is a script-execution
 * vector on this origin the moment a browser is allowed to try.
 */
function serveHeaders(cacheControl: string, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP,
    'content-disposition': contentType === DOWNLOAD_CONTENT_TYPE ? 'attachment' : 'inline',
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

  // Second gate on the same allowlist the upload applies (validate.ts): only the
  // types this route is willing to serve inline are echoed back, so an object
  // written by anything other than `uploadAsset` — or before that allowlist
  // existed — downloads rather than rendering as HTML or SVG on this origin.
  const stored = object.httpMetadata?.contentType ?? ''
  const contentType = SERVED_CONTENT_TYPES.has(stored) ? stored : DOWNLOAD_CONTENT_TYPE

  const wantsTransform = Boolean(transform.width || transform.height || transform.format)
  // A transform only ever runs for a GET: the Cache API can only ever hold a
  // GET response, and HEAD is routable to this same path (an uptime monitor or
  // link-preview bot does exactly that) — running the transform anyway would
  // mint a billable Images invocation, and writing its result under a HEAD-keyed
  // request is what used to throw and get logged as a transform *failure* for a
  // transform that had, in fact, just succeeded.
  const canTransform =
    Boolean(images) &&
    wantsTransform &&
    contentType !== DOWNLOAD_CONTENT_TYPE &&
    request.method === 'GET'

  if (!canTransform) {
    // Nothing here was ever going to be transformed — the type isn't one this
    // route reads, or no transform was requested at all — is the correct,
    // stable response for the URL it answers and can be pinned for a year. A
    // request that *did* ask for a transform but isn't getting one right now
    // (no Images binding configured, or a non-GET method choosing not to spend
    // one) is a degraded response and must not be.
    const stable = !wantsTransform || contentType === DOWNLOAD_CONTENT_TYPE
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
 * The upload's real content type, off its own magic bytes. Covers exactly
 * `SERVED_CONTENT_TYPES` (validate.ts) — the formats `imageSize` already reads
 * (png, jpeg, gif, webp) plus avif, cheap to add since its signature is a
 * fixed 12-byte `ftyp` box. Returns `undefined` for anything else, which
 * `uploadAsset` stores as `DOWNLOAD_CONTENT_TYPE`.
 *
 * Every signature below checks its *full* length rather than a short, cheaper
 * prefix: this function's output becomes the stored — and later served —
 * content-type on a route with `nosniff` as its only other defence, so a
 * partial match (a 4-byte PNG prefix, a 2-byte JPEG SOI, a 3-byte "GIF" with no
 * version) is a gap wide enough for an attacker-chosen payload with a matching
 * prefix to be stored and echoed back as that content-type.
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
  return undefined
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
 * Two idioms on purpose (`../../../docs/specs/foundation/pagination.md`
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
