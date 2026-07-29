/**
 * `/folio/api/v1` — the versioned public surface
 * (`../../../../../docs/specs/platform/content-api.md` architecture decision 1).
 *
 * **Versioned in the path, and separate from the admin's routes**, because the two
 * have opposite obligations. The admin ships inside this library and is upgraded
 * with it, so `/folio/stories` may change shape whenever the editor needs it to.
 * Everything under here is a contract with a script somebody else wrote and
 * deployed, so it changes by gaining a `v2` beside `v1`, never by changing `v1`.
 *
 * It shares everything real with the admin: the same error envelope, the same
 * `withBindings` / `withActor` middleware (so a session cookie works here too and
 * the admin *could* use these routes), the same services underneath. What it does
 * not share is a single line of shape.
 */
import { Hono } from 'hono'
import {
  listAssets,
  MAX_UPLOAD_BYTES,
  readCappedBody,
  toAssetValue,
  uploadAsset,
} from '../../assets'
import { ASSETS, READ } from '../../auth/roles'
import { FolioError, rethrow } from '../../errors'
import { requireAccess } from '../../middleware'
import type { FolioRuntime } from '../../runtime'
import type { FolioEnv } from '../../types'
import { contentLengthHeader, filenameQuery } from '../../validate'
import { documentRoutes } from './documents'

/** The one version there is. A `v2` would be a second `Hono` mounted beside this. */
export const API_VERSION = 'v1'

export function apiRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * The manifest: document types, block schemas, locales.
   *
   * Gated at `content:read`, unlike `GET /folio/schema`, which is deliberately
   * open — that one is what the admin bundle fetches *before* it can draw a
   * sign-in prompt, so it has to answer an unauthenticated request. Nothing under
   * `/api/v1` has that constraint, and a schema describes the shape of a private
   * site's content.
   */
  app.get('/schema', requireAccess<Env>(rt, READ), (c) => c.json(rt.manifest))

  app.route('/', documentRoutes<Env>(rt))

  /**
   * The media library and uploads, re-exposed at `assets:write` — a scope that
   * implies nothing else, so a token that only pushes images cannot read content.
   *
   * The same service functions the admin's routes call, with the same raw-body
   * upload convention (filename in a query parameter, not multipart) and the same
   * two-stage size check: the declared length refused before a byte is read, and
   * `readCappedBody` as the guarantee for a request that declares nothing.
   *
   * `GET /folio/asset/:key` is deliberately **not** duplicated here. It is the
   * public route a published page points its `<img>` tags at; it needs no token,
   * has no envelope, and giving it a second URL would only mean two of them to
   * keep narrow.
   */
  app.get('/assets', requireAccess<Env>(rt, READ), async (c) =>
    c.json({ assets: await listAssets(c.var.bindings().db) }),
  )

  app.post('/assets', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')

    const filename = filenameQuery(c.req.query('filename'))
    contentLengthHeader(c.req.header('content-length'), MAX_UPLOAD_BYTES)
    try {
      const bytes = await readCappedBody(c.req.raw.body, MAX_UPLOAD_BYTES)
      const row = await uploadAsset(db, media, { bytes, filename })
      return c.json({ asset: row, value: toAssetValue(row) }, 201)
    } catch (e) {
      rethrow(e)
    }
  })

  return app
}
