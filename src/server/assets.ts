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

export async function listAssets(db: D1Database, limit = 200): Promise<AssetRow[]> {
  const { results } = await db
    .prepare(`select ${COLS} from assets order by created_at desc limit ?`)
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<AssetRow>()
  return results
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

export async function uploadAsset(
  db: D1Database,
  bucket: R2Bucket,
  input: { bytes: ArrayBuffer; filename: string; contentType: string },
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
  const contentType = input.contentType || 'application/octet-stream'
  const dims = imageSize(new Uint8Array(input.bytes))

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

export function parseTransform(
  params: URLSearchParams,
): AssetTransform & { focal?: { x: number; y: number } } {
  const num = (key: string) => {
    const raw = Number(params.get(key))
    return Number.isFinite(raw) && raw > 0 ? raw : undefined
  }
  const fit = params.get('fit')
  const format = params.get('f')
  const [fx, fy] = (params.get('fp') ?? '').split(',').map(Number)

  return {
    width: num('w'),
    height: num('h'),
    quality: num('q'),
    ...(fit === 'cover' || fit === 'contain' || fit === 'scale-down' ? { fit } : {}),
    ...(format === 'webp' || format === 'avif' || format === 'jpeg' || format === 'png'
      ? { format }
      : {}),
    ...(Number.isFinite(fx) && Number.isFinite(fy) ? { focal: { x: fx!, y: fy! } } : {}),
  }
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

export async function serveAsset(
  bucket: R2Bucket,
  images: ImagesBinding | undefined,
  key: string,
  transform: AssetTransform & { focal?: { x: number; y: number } },
): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) return new Response('Not found', { status: 404 })

  const wanted = transform.width || transform.height || transform.format
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream'

  // No Images binding, or nothing to do: hand back the original. Folio stays
  // usable with only an R2 bucket configured, which is the point of not putting
  // the resizing strategy into stored values.
  if (!images || !wanted || !contentType.startsWith('image/') || contentType === 'image/svg+xml') {
    return new Response(object.body, {
      headers: { 'content-type': contentType, 'cache-control': IMMUTABLE, etag: object.httpEtag },
    })
  }

  try {
    const op: ImageTransform = {
      ...(transform.width ? { width: transform.width } : {}),
      ...(transform.height ? { height: transform.height } : {}),
      ...(transform.fit ? { fit: transform.fit } : {}),
      // Only meaningful when cropping, and `remainder` is the behaviour the
      // documented `XxY` gravity has: put the focal point of the output where it
      // sits in the original.
      ...(transform.focal && transform.fit === 'cover'
        ? { gravity: { x: transform.focal.x, y: transform.focal.y, mode: 'remainder' as const } }
        : {}),
    }
    const result = await images
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
    const bytes = await result.response().arrayBuffer()
    if (bytes.byteLength === 0) throw new Error('Transform produced no output')

    return new Response(bytes, {
      headers: { 'content-type': result.contentType(), 'cache-control': IMMUTABLE },
    })
  } catch {
    // A transform failing is not a reason to show a broken image. Re-fetch,
    // because `object.body` was consumed by the attempt.
    const original = await bucket.get(key)
    return original
      ? new Response(original.body, {
          headers: { 'content-type': contentType, 'cache-control': IMMUTABLE },
        })
      : new Response('Not found', { status: 404 })
  }
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
