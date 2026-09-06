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
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AssetTag } from '../../core/assets'
import { wasRefused } from '../../core/bulk'
import { type AssetBulkOptions, type AssetBulkOutcome, runAssetBulk } from '../asset-bulk'
import { createFolder, deleteFolder, listFolders, updateFolder } from '../asset-folders'
import { deleteTag, ensureTag, listTags, renameTag, tagsForAssets } from '../asset-tags'
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
import { describeAsset } from '../describe'
import type { FolioDb } from '../db'
import { FolioError, rethrow } from '../errors'
import { requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import {
  AssetBulkBody,
  AssetBulkMoveBody,
  AssetBulkTagBody,
  AssetFolderCreateBody,
  AssetFolderPatchBody,
  assetKeyParam,
  AssetPatchBody,
  assetSortQuery,
  AssetTagBody,
  contentLengthHeader,
  filenameQuery,
  folderQuery,
  idParam,
  limitParam,
  parseBody,
  parseOptionalBody,
  requireCursor,
  sortDirQuery,
  tagsQuery,
} from '../validate'

/**
 * `?folder=` and `?unfiled=1`, which are **mutually exclusive**
 * (`core/assets.ts`'s `AssetFilter`): one narrows to a folder and its
 * descendants, the other to the rows in no folder at all.
 *
 * Refused rather than resolved. `assetFilterSql` composes both clauses honestly
 * when both are set, which yields an empty list — truthful, and indistinguishable
 * on screen from a folder that happens to be empty. A 400 naming the two
 * parameters is the difference between "you asked for something that cannot
 * exist" and a grid that looks broken.
 */
function assetFolderFilter(
  folder: string | undefined,
  unfiled: string | undefined,
): { folder?: string; unfiled?: boolean } {
  const path = folderQuery(folder)
  const none = unfiled === '1'
  if (path !== undefined && none) {
    throw new FolioError('bad_request', '`folder` and `unfiled` cannot both be given')
  }
  if (path !== undefined) return { folder: path }
  return none ? { unfiled: true } : {}
}

/**
 * `?tags=` (repeated, ANDed) and `?untagged=1`, the tag half of the same rule.
 *
 * Refused together for `assetFolderFilter`'s reason exactly: an asset carrying
 * `headshots` is by definition not untagged, so the pair can only ever return
 * nothing, and a grid that renders nothing looks like a bug rather than like an
 * answer. The two helpers are separate rather than one four-argument screen
 * because the pairs are independent — `?folder=clients&untagged=1` is a perfectly
 * good question — and merging them is how that combination would come to be
 * refused too.
 */
function assetTagFilter(
  tags: string[] | undefined,
  untagged: string | undefined,
): { tags?: string[]; untagged?: boolean } {
  const slugs = tagsQuery(tags)
  const none = untagged === '1'
  if (slugs !== undefined && none) {
    throw new FolioError('bad_request', '`tags` and `untagged` cannot both be given')
  }
  if (slugs !== undefined) return { tags: slugs }
  return none ? { untagged: true } : {}
}

/**
 * Each row's tags, attached to what the admin's routes answer.
 *
 * **One read for a whole page**, through `tagsForAssets`, which chunks its binds:
 * the alternative — a query per tile — is 200 round trips for a full page and is
 * the shape this repo has got wrong twice. A row with no tags carries `[]` rather
 * than being absent, so a client renders a chip list without a null check.
 *
 * Only the **unversioned** routes get this. `{base}/api/v1/assets` answers the
 * envelope it always has (decision 13: a version segment is a promise), and the
 * admin's own surface may change shape in any commit — which is exactly the
 * freedom that lets the grid show a tile's tags without a second request.
 */
async function withTags<T extends { id: string }>(
  db: FolioDb,
  rows: readonly T[],
): Promise<(T & { tags: AssetTag[] })[]> {
  const byAsset = await tagsForAssets(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({ ...row, tags: byAsset.get(row.id) ?? [] }))
}

export function assetRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/assets', requireAccess<Env>(rt, READ), async (c) => {
    const { db } = c.var.bindings()
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const page = await listAssets(db, {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      q: c.req.query('q'),
      kind: c.req.query('kind'),
      count: c.req.query('count') === '1',
      sort: assetSortQuery(c.req.query('sort')),
      dir: sortDirQuery(c.req.query('dir')),
      ...assetFolderFilter(c.req.query('folder'), c.req.query('unfiled')),
      ...assetTagFilter(c.req.queries('tags'), c.req.query('untagged')),
    })
    return c.json({ ...page, rows: await withTags(db, page.rows) })
  })

  /* ------------------------------------------------------------ folders --- */

  /**
   * The folder tree, keyset-paged over `path` — **so the page order *is* the tree
   * order** (`media-library.md` decision 3). A client appends rows as they arrive:
   * every folder follows its parent and siblings are alphabetical, because that is
   * what sorting a slugified materialised path does. It performs no sort of its
   * own, which is the property that makes paging a tree possible at all.
   *
   * Registered **before** `/assets/:id`, and that ordering is load-bearing rather
   * than cosmetic: `folders` is a legal `:id` as far as the router is concerned.
   *
   * `READ` (viewer+), matching the asset list it narrows: a folder name is
   * organisation, not content, and anyone who can see the library can see how it
   * is filed.
   */
  app.get('/assets/folders', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listFolders(c.var.bindings().db, {
        limit: limitParam(c.req.query('limit'), 100, 500),
        cursor,
        count: c.req.query('count') === '1',
      }),
    )
  })

  /**
   * A new folder. 409 when its name slugifies onto a sibling's, naming the
   * sibling — deliberately not de-duplicated silently, because two names that
   * slugify alike are different names and the editor should choose.
   */
  app.post('/assets/folders', requireAccess<Env>(rt, ASSETS), async (c) => {
    const body = await parseBody(c.req, AssetFolderCreateBody)
    return c.json(await createFolder(c.var.bindings().db, body), 201)
  })

  /**
   * Rename, move, or both — one subtree path rewrite either way
   * (`asset-folders.ts`'s `updateFolder` says why the two are one operation).
   *
   * 409 on a cycle, naming the path that made it one, and 409 on a collision. A
   * missed cycle detaches a subtree from the tree permanently: there is no
   * recursive query anywhere here to find it again.
   */
  app.patch('/assets/folders/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, AssetFolderPatchBody)
    const row = await updateFolder(c.var.bindings().db, id, body)
    if (!row) throw new FolioError('not_found', 'Unknown folder')
    return c.json(row)
  })

  /**
   * Deletes the folder and **nothing else** (decision 14): children re-parent to
   * its own parent, its assets land back in *Unfiled*, and no asset and no R2
   * object is touched. The counts come back so the dialog can say what happened
   * rather than guess.
   *
   * Note it does not need the `media` binding, unlike `DELETE /assets/:id` — a
   * folder is metadata, and deleting metadata reaches no bucket.
   */
  app.delete('/assets/folders/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const report = await deleteFolder(c.var.bindings().db, id)
    if (!report) throw new FolioError('not_found', 'Unknown folder')
    return c.json({ deleted: true, ...report })
  })

  /* --------------------------------------------------------------- tags --- */

  /**
   * The tag vocabulary, keyset-paged over `slug`.
   *
   * `?counts=1` adds `count` — how many assets carry each tag — as one grouped
   * query, opt-in for `?count=1`'s reason (`pagination.md` decision 5): the
   * sidebar's chip list wants it and an autocomplete does not. **Note it is
   * `counts`, not `count`**, and there is deliberately no `count` here: two
   * parameters one letter apart meaning "how many tags" and "how many assets per
   * tag" is a trap, and `asset-tags.ts`'s `ListTagsOptions` says so.
   *
   * Registered **before** `/assets/:id` for the reason `folders` is: `tags` is a
   * legal `:id` as far as the router is concerned.
   *
   * `READ` (viewer+), matching the list it narrows — a tag is organisation, not
   * content.
   */
  app.get('/assets/tags', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listTags(c.var.bindings().db, {
        limit: limitParam(c.req.query('limit'), 100, 500),
        cursor,
        counts: c.req.query('counts') === '1',
      }),
    )
  })

  /**
   * A tag, created **or found** (decision 4).
   *
   * `201` for a new slug, `200` for one that already existed — and the existing
   * row comes back rather than a 409, which is what makes "type a name, press
   * enter" one call from a chip input instead of a create-then-recover dance. The
   * match is on the slug, so `Headshots` finds `headshot` and the vocabulary
   * stays a taxonomy rather than growing a near-synonym per typist.
   */
  app.post('/assets/tags', requireAccess<Env>(rt, ASSETS), async (c) => {
    const body = await parseBody(c.req, AssetTagBody)
    const { tag, created } = await ensureTag(c.var.bindings().db, body.name)
    return c.json(tag, created ? 201 : 200)
  })

  /**
   * Renames a tag, re-slugging it. `409` when the new slug is another tag's,
   * naming it: a rename onto an existing tag would otherwise be a **merge**,
   * rewriting taggings for assets the editor is not looking at, with no undo.
   * Changing only the display — `head shots` to `Headshots` — is always allowed,
   * because the slug does not move.
   */
  app.patch('/assets/tags/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, AssetTagBody)
    const row = await renameTag(c.var.bindings().db, id, body.name)
    if (!row) throw new FolioError('not_found', 'Unknown tag')
    return c.json(row)
  })

  /**
   * Deletes a tag and its taggings, and **no asset** (decision 14). `removedFrom`
   * is how many assets stop carrying it, so the dialog can say what will happen
   * rather than guess — and, like the folder delete beside it, this reaches no
   * bucket and needs no `media` binding.
   */
  app.delete('/assets/tags/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const report = await deleteTag(c.var.bindings().db, id)
    if (!report) throw new FolioError('not_found', 'Unknown tag')
    return c.json({ deleted: true, ...report })
  })

  /* --------------------------------------------------------------- bulk --- */

  /**
   * One run, and the two shapes it can answer with — `routes/bulk.ts`'s `answer`
   * for the media library, and the same 409 body: the error envelope a generic
   * fetch wrapper already reads, plus the machine-readable counts beside it.
   *
   * A refusal has to be a **door rather than a wall**, which is what the `actual`
   * count buys: "somebody uploaded three files while you were reading the number"
   * is re-confirmed in one click instead of investigated.
   */
  const answer = (c: Context<FolioEnv<Env>>, outcome: AssetBulkOutcome): Response => {
    if (!wasRefused(outcome)) return c.json(outcome)
    return c.json(
      {
        error: {
          code: 'conflict',
          message: `${outcome.expected} files matched when you chose them and ${outcome.actual} match now. Check the number and try again.`,
        },
        refused: outcome.refused,
        expected: outcome.expected,
        actual: outcome.actual,
      },
      409,
    )
  }

  /** The job-control fields, off any of the three bodies. No `actor`: none of
   * these four actions writes a version row or fires a hook, because none of them
   * changes a document. */
  const control = (body: {
    dryRun?: boolean
    continueFrom?: string | null
    batch?: number
  }): AssetBulkOptions => {
    requireCursor(body.continueFrom ?? undefined)
    return {
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
      ...(body.continueFrom === undefined ? {} : { continueFrom: body.continueFrom }),
      ...(body.batch === undefined ? {} : { batch: body.batch }),
    }
  }

  /**
   * Tagging and untagging a selection — **add and remove, never replace**, which
   * is the whole difference between these and `PATCH /assets/:id`'s `tags`. A
   * bulk replace would wipe every per-file tag an editor had applied by hand,
   * which is not something a person asking to "add `2024` to these forty" means.
   *
   * Registered **before** `/assets/:id`: `bulk` is a legal `:id` as far as the
   * router is concerned, the same trap `folders` and `tags` sit in above.
   *
   * `ASSETS` (editor+), matching the single-asset patch these are forty of
   * (decision 16). The one route in this feature that is `ADMIN` is phase 7's
   * describe run, because that one spends the host's money.
   */
  for (const action of ['tag', 'untag'] as const) {
    app.post(`/assets/bulk/${action}`, requireAccess<Env>(rt, ASSETS), async (c) => {
      const body = await parseBody(c.req, AssetBulkTagBody)
      return answer(
        c,
        await runAssetBulk({ db: c.var.bindings().db }, action, body.selection, {
          ...control(body),
          tagIds: body.tagIds,
        }),
      )
    })
  }

  /** Filing a selection. `folderId: null` is *Unfiled*, a real destination, which
   * is why the field is required and nullable rather than optional. Touches one
   * column per row and no R2 object at all (decision 1). */
  app.post('/assets/bulk/move', requireAccess<Env>(rt, ASSETS), async (c) => {
    const body = await parseBody(c.req, AssetBulkMoveBody)
    return answer(
      c,
      await runAssetBulk({ db: c.var.bindings().db }, 'move', body.selection, {
        ...control(body),
        folderId: body.folderId,
      }),
    )
  })

  /**
   * Deleting a selection — the one irreversible action in this feature.
   *
   * The report carries `usedOnPublished` on the first call (decision 15), which
   * is what a confirmation reads by posting this with `dryRun: true` first. It
   * **warns and proceeds**: gating would leave an editor unable to remove a file
   * that a published page happens to point at, and a broken image reference
   * degrades visibly and fixably.
   *
   * Needs the bucket, like `DELETE /assets/:id` — `runAssetBulk` refuses a delete
   * without one, but the check is here too so the failure is a request-shaped
   * `unsupported` before a count guard runs rather than after it.
   */
  app.post('/assets/bulk/delete', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db, media } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')
    const body = await parseBody(c.req, AssetBulkBody)
    return answer(c, await runAssetBulk({ db, media }, 'delete', body.selection, control(body)))
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

  /* ----------------------------------------------------------- describe --- */

  /**
   * Alt text, a description and tags for one asset, from the host's own model
   * call (`media-library.md` decision 8). Synchronous: one asset, one call, and
   * the row that results — the *Describe* button on the detail panel. The batched
   * run over a selection is phase 7's `POST {base}/api/assets/describe`, and it
   * is the one route in this feature that is `ADMIN`, because it spends money by
   * the hundred rather than by the one.
   *
   * **Two refusals, and the order matters.** No bucket comes first: there is
   * nothing to look at, so "no media" is the truer answer than "no describe".
   * Then the config key itself, named in the message — absence is a legible
   * refusal here exactly as it is for `media` and `browser`, and the admin reads
   * it off the manifest and renders no control at all.
   *
   * **`ASSETS` (editor+)**, matching `PATCH /assets/:id`: this writes the same
   * kind of metadata onto one row, and it cannot touch a document. Nothing it
   * writes reaches `alt` or `description` — the human columns — so the worst a
   * misfired call can do is put a sentence in `alt_auto` that the next editor
   * overtypes.
   *
   * **A failed model call is a 200 carrying `error`, not a 500.** `fn` is
   * somebody else's HTTP call and it will time out, rate-limit and answer junk;
   * every one of those is recorded in `describe_error` and *is* the outcome the
   * caller asked for. A 500 would say Folio broke.
   */
  app.post('/assets/:id/describe', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db, media, images } = c.var.bindings()
    if (!media) throw new FolioError('unsupported', 'No media bucket is configured')
    if (!rt.describe) {
      throw new FolioError('unsupported', 'No `describe` function is configured')
    }

    const row = await assetById(db, idParam('id', c.req.param('id')))
    if (!row) throw new FolioError('not_found', 'Unknown asset')

    // Absolute, from this request's own origin: `DescribeInput.url` is handed to
    // somebody else's API to fetch, and `rt.base` alone is a path rather than a
    // URL. The origin is only knowable here.
    const assetBase = `${new URL(c.req.url).origin}${rt.base}/asset`
    const outcome = await describeAsset(
      { db, media, images, assetBase, describe: rt.describe, env: c.env },
      row,
    )
    return c.json({
      asset: (await withTags(db, [outcome.row]))[0],
      skipped: outcome.skipped,
      tagged: outcome.tagged,
      tagsIgnored: outcome.tagsIgnored,
      error: outcome.error,
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
    const { db } = c.var.bindings()
    const row = await assetById(db, idParam('id', c.req.param('id')))
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    return c.json((await withTags(db, [row]))[0])
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

  /**
   * Alt text, description, folder and tags — `AssetPatchBody` (`validate.ts`) has
   * the field-by-field rules, and the one worth knowing here is that **absent is
   * not empty**: `{ alt: '' }` clears the alt text and `{ folderId: null }`
   * unfiles the asset, while an absent key leaves the stored value alone.
   *
   * Answers the row **with its tags**, so a detail panel that just replaced the
   * chip list renders what is stored rather than what it sent. An unknown folder
   * or an unknown tag id is a 400 naming it, not a silently dangling reference:
   * neither column is a foreign key, so nothing downstream would catch it.
   */
  app.patch('/assets/:id', requireAccess<Env>(rt, ASSETS), async (c) => {
    const { db } = c.var.bindings()
    const id = idParam('id', c.req.param('id'))
    const body = await parseOptionalBody(c.req, AssetPatchBody)
    const row = await updateAsset(db, id, body)
    if (!row) throw new FolioError('not_found', 'Unknown asset')
    return c.json((await withTags(db, [row]))[0])
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
