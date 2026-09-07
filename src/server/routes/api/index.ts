/**
 * `/folio/api/v1` — the versioned public surface
 * (`../../../../docs/specs/platform/content-api.md` architecture decision 1).
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
import type { AssetFilter } from '../../../core/assets'
import {
  listAssetsByPage,
  MAX_UPLOAD_BYTES,
  readCappedBody,
  toAssetValue,
  uploadAsset,
} from '../../assets'
import { ASSETS, READ } from '../../auth/roles'
import { describeOnUpload } from '../../describe'
import { FolioError, rethrow } from '../../errors'
import { requireAccess } from '../../middleware'
import type { FolioRuntime } from '../../runtime'
import type { FolioEnv } from '../../types'
import {
  contentLengthHeader,
  filenameQuery,
  folderQuery,
  limitParam,
  tagsQuery,
} from '../../validate'
import { documentRoutes } from './documents'
import { searchRoutes } from './search'

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
  app.route('/', searchRoutes<Env>(rt))

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
  /**
   * Paged in **v1's own idiom**, which is page numbers — the shape
   * `collections.md` established for `/documents` and the shape a script listing a
   * media library wants. The admin's own `/api/assets` pages by cursor instead,
   * because its list is live (`../../../../docs/specs/foundation/pagination.md`
   * decision 1).
   *
   * So this route keeps its `{ assets }` envelope and gains `page`, `perPage` and
   * `total` beside it. That is additive: a caller reading `assets` still reads
   * `assets`, which is what `{base}/api/v1` promises.
   */
  app.get('/assets', requireAccess<Env>(rt, READ), async (c) => {
    const perPage = limitParam(c.req.query('perPage'), 50, 200)
    const page = Math.max(1, Math.trunc(Number(c.req.query('page') ?? 1)) || 1)
    const listed = await listAssetsByPage(c.var.bindings().db, {
      page,
      perPage,
      filter: assetFilterQuery(c.req),
    })
    return c.json({ assets: listed.assets, page, perPage, total: listed.total })
  })

  /**
   * **A file uploaded here is described exactly as one dropped on the admin's
   * grid is** — the same `ctx.waitUntil(describeOnUpload(...))` the admin's
   * `POST {base}/api/assets` carries
   * (`../../../../docs/specs/content-model/media-library.md` decision 10).
   *
   * It is the same six lines twice rather than a shared helper because the two
   * routes share nothing else: they have different envelopes, different
   * middleware in front of them, and the whole point of the partition is that
   * one may be reshaped and the other may not. What they must not have is
   * different *behaviour*, and this is the route **MCP's `upload_asset` proxies
   * to** — so without this, a file an agent or a script pushes lands in the
   * enrichment backlog while the identical file dragged onto the grid arrives
   * described.
   *
   * **Additive to the versioned contract**, which is why it may land here at
   * all: nothing about the response changes. The body is the row as written,
   * before the model call that has not happened yet, exactly as it is today.
   */
  app.post('/assets', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db, media, images } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')

    const filename = filenameQuery(c.req.query('filename'))
    contentLengthHeader(c.req.header('content-length'), MAX_UPLOAD_BYTES)
    try {
      const bytes = await readCappedBody(c.req.raw.body, MAX_UPLOAD_BYTES)
      const row = await uploadAsset(db, media, { bytes, filename })
      if (rt.describe?.onUpload) {
        const assetBase = `${new URL(c.req.url).origin}${rt.base}/asset`
        c.executionCtx.waitUntil(
          describeOnUpload(
            { db, media, images, assetBase, describe: rt.describe, env: c.env, logger: rt.logger },
            row,
          ),
        )
      }
      return c.json({ asset: row, value: toAssetValue(row) }, 201)
    } catch (e) {
      rethrow(e)
    }
  })

  return app
}

/**
 * `?q=`, `?folder=` and `?tags=` on the versioned list
 * (`../../../../docs/specs/content-model/media-library.md` decision 13).
 *
 * **Additive, which is the only reason it may be added to a `v1` at all**: a
 * caller passing none of the three composes an empty filter, `assetFilterSql`
 * emits no clause, and the statement is the unfiltered one this route has
 * always answered. The envelope, the ordering and the row shape are untouched.
 *
 * The composition itself is `assetFilterSql`, the same function the admin's
 * list goes through, so `folder` means "and its descendants" in both and `q`
 * searches the same five columns in both. Two `where` builders over one table
 * is how they come to mean different things by one word.
 *
 * **`tags`, repeated — not `tag`.** The spec's route table writes it singular
 * and the admin's has always been `?tags=a&tags=b`, parsed by `tagsQuery` with
 * its eight-slug cap and its refusal message. One spelling and one parser beat
 * a spec table, because a second name is a second implementation of the cap.
 *
 * `unfiled`, `untagged`, `undescribed` and `failed` are deliberately not here.
 * They are the admin's retro-organising and enrichment affordances, not
 * questions a script asks of a media library, and a version segment is a
 * promise: adding one later is additive, and unadding one is not.
 */
function assetFilterQuery(req: {
  query(name: string): string | undefined
  queries(name: string): string[] | undefined
}): AssetFilter {
  const q = req.query('q')
  const folder = folderQuery(req.query('folder'))
  const tags = tagsQuery(req.queries('tags'))
  return {
    ...(q ? { q } : {}),
    ...(folder === undefined ? {} : { folder }),
    ...(tags === undefined ? {} : { tags }),
  }
}
