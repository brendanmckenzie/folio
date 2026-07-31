/**
 * The media library, and the public route published pages point their `<img>`
 * tags at.
 *
 * An asset knows nothing about blocks or stories — with exactly one exception,
 * added with the Assets screen: `GET /assets/:id/usage` answers *which documents*
 * use a file, so it needs the host's URL shaping (`rt.withUrls`) the same way the
 * document usage route does. `assetFileRoutes` below stays entirely
 * runtime-independent, which is what lets it be mounted on the bare path.
 */
import { Hono } from 'hono'
import {
  assetById,
  assetUsage,
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
import { ASSETS, EDIT, READ } from '../auth/roles'
import { FolioError, rethrow } from '../errors'
import { requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import {
  assetKeyParam,
  AssetPatchBody,
  assetSortQuery,
  contentLengthHeader,
  filenameQuery,
  idParam,
  limitParam,
  parseOptionalBody,
  requireCursor,
  sortDirQuery,
} from '../validate'

export function assetRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/assets', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listAssets(c.var.bindings().db, {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        q: c.req.query('q'),
        kind: c.req.query('kind'),
        count: c.req.query('count') === '1',
        sort: assetSortQuery(c.req.query('sort')),
        dir: sortDirQuery(c.req.query('dir')),
      }),
    )
  })

  /**
   * Which published documents use one asset — the detail panel's "where it is
   * used", and the confirmation shown before a delete
   * (`docs/ui-architecture.md`'s Assets section and dependency 4).
   *
   * **The same shape as `GET {base}/api/documents/:id/usage`**: one usage payload,
   * two subjects. `published` rows carry `{ id, title, path, url }` so the dialog
   * can name and link what it will break, and `total` is the distinct document
   * count. No `kind` and no by-kind totals — every asset edge is one kind, and
   * `assetUsage` says why.
   *
   * **Warns with a count and proceeds.** This route informs a dialog; it does not
   * gate `DELETE /assets/:id`. Blocking would mean maintaining referential
   * integrity across draft documents nobody can see, and a broken reference
   * already degrades safely — a missing image is visible and fixable, while a
   * delete that refuses leaves an editor unable to remove a file at all.
   *
   * `EDIT` (editor+), matching the document route exactly: it reports on published
   * content an editor can already read, so the lower bar leaks nothing, and the
   * delete it precedes is `ASSETS` — also editor+, which is the one place the two
   * usage routes differ in consequence rather than in shape.
   *
   * Unlike the document route it **404s an unknown id** rather than answering an
   * empty usage. Not a departure for its own sake: the key is what the edges hold,
   * so the library row has to be read to answer at all, and "no such asset" is a
   * more useful answer than "used by nobody" for a stale link.
   */
  app.get('/assets/:id/usage', requireAccess<Env>(rt, EDIT), async (c) => {
    const { db } = c.var.bindings()
    const row = await assetById(db, idParam('id', c.req.param('id')))
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    const usage = await assetUsage(db, row.key)
    return c.json({
      published: usage.published.map((story) => ({
        id: story.id,
        title: story.title,
        path: story.path,
        // `''` rather than absent for an unrouted document, matching the document
        // usage route: a record using an asset has no URL to offer.
        url: rt.withUrls(story).url ?? '',
      })),
      total: usage.total,
    })
  })

  /**
   * One asset by id.
   *
   * **The route that makes `{base}/assets?asset=<id>` a real link.** The Assets
   * screen keeps the selected asset in its URL, because an asset is a thing somebody
   * sends a colleague — and without this, a cold load of that URL had nothing to
   * resolve the id with unless the asset happened to be on the first page the list
   * returned. Found by building the screen, which is the third time in this port that
   * the screen was the thing that could say what the route owed.
   *
   * `404` for an unknown id rather than an empty body, matching
   * `GET {base}/api/assets/:id/usage` beside it: a stale link deserves to say the file
   * is gone rather than to render a blank panel.
   *
   * `READ`, matching the list: it answers one row of what the list already answers.
   * Deliberately **not** a `PATCH` with an empty body, which happens to return the row
   * because `updateAsset` short-circuits when `alt` is absent — a read that works by
   * being a write nobody noticed is a read that breaks the first time the write grows
   * a side effect.
   */
  app.get('/assets/:id', requireAccess<Env>(rt, READ), async (c) => {
    const row = await assetById(c.var.bindings().db, idParam('id', c.req.param('id')))
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    return c.json(row)
  })

  /**
   * Raw body upload with the filename in a query parameter, rather than
   * multipart: it keeps the Worker out of the business of parsing form data, and
   * the browser sets Content-Type and Content-Length from the File for free.
   */
  app.post('/assets', requireAccess<Env>(rt, ASSETS), async (c) => {
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

  app.patch('/assets/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseOptionalBody(c.req, AssetPatchBody)
    const row = await updateAsset(c.var.bindings().db, id, body)
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    return c.json(row)
  })

  app.delete('/assets/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')
    const gone = await deleteAsset(db, media, idParam('id', c.req.param('id')))
    if (!gone) throw new FolioError('not_found', 'Unknown asset')
    return c.json({ deleted: true })
  })

  return app
}

/**
 * Serving a file, which is **not** part of the admin's JSON API and therefore not
 * under `{base}/api` (`../../../docs/specs/foundation/pagination.md` decision 3).
 *
 * Two reasons it stays on the bare mount. It is public — published pages point
 * their `<img>` tags here, so it is exactly as public as the page embedding it —
 * and its URL is **baked into published HTML** through `Resolution.assetBase`
 * (`runtime.ts`), so moving it would rewrite every rendered page's image sources
 * for no gain.
 *
 * Resizing lives behind this route so a stored value never names a resizing
 * service. The narrowness of `assetKeyParam` is what makes a public read
 * acceptable: it is anchored to Folio's own mint format rather than being a
 * charset screen, so this cannot be turned into a read primitive for a
 * co-tenanted key.
 */
export function assetFileRoutes<Env>(): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

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
