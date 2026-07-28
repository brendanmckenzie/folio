/**
 * The media library, and the public route published pages point their `<img>`
 * tags at. Nothing here needs the runtime: an asset knows nothing about blocks,
 * stories or their URLs.
 */
import { Hono } from 'hono'
import {
  deleteAsset,
  listAssets,
  MAX_UPLOAD_BYTES,
  parseTransform,
  readCappedBody,
  serveAsset,
  toAssetValue,
  updateAsset,
  uploadAsset,
} from '../assets'
import { FolioError, rethrow } from '../errors'
import type { FolioEnv } from '../types'
import {
  AssetPatchBody,
  assetKeyParam,
  contentLengthHeader,
  filenameQuery,
  idParam,
  parseOptionalBody,
} from '../validate'

export function assetRoutes<Env>(): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/assets', async (c) => c.json(await listAssets(c.var.bindings().db)))

  /**
   * Raw body upload with the filename in a query parameter, rather than
   * multipart: it keeps the Worker out of the business of parsing form data, and
   * the browser sets Content-Type and Content-Length from the File for free.
   */
  app.post('/assets', async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')

    const filename = filenameQuery(c.req.query('filename'))
    // A declared length already over the cap is refused before a byte is
    // read. That is the fast path, not the guarantee: `readCappedBody` is what
    // makes the cap hold for a request with no Content-Length, or a lying one.
    contentLengthHeader(c.req.header('content-length'), MAX_UPLOAD_BYTES)
    try {
      const bytes = await readCappedBody(c.req.raw.body, MAX_UPLOAD_BYTES)
      const row = await uploadAsset(db, media, { bytes, filename })
      return c.json({ asset: row, value: toAssetValue(row) }, 201)
    } catch (e) {
      // An empty upload is a bad request; one over either size ceiling is
      // `too_large`; a failed R2 put or D1 insert is internal.
      rethrow(e)
    }
  })

  app.patch('/assets/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseOptionalBody(c.req, AssetPatchBody)
    const row = await updateAsset(c.var.bindings().db, id, body)
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    return c.json(row)
  })

  app.delete('/assets/:id', async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')
    const gone = await deleteAsset(db, media, idParam('id', c.req.param('id')))
    if (!gone) throw new FolioError('not_found', 'Unknown asset')
    return c.json({ deleted: true })
  })

  /**
   * Public: published pages point their `<img>` tags here. Resizing lives behind
   * this route so a stored value never names a resizing service.
   */
  app.get('/asset/:key', async (c) => {
    const { media, images } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')
    return serveAsset(
      media,
      images,
      assetKeyParam(c.req.param('key')),
      parseTransform(new URL(c.req.url).searchParams),
      c.req.raw,
    )
  })

  return app
}
