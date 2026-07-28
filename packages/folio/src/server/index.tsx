import { Hono } from 'hono'
import type { ReactElement, ReactNode } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import {
  toManifest,
  toRegistry,
  toSchemaIndex,
  type AnyBlockDef,
  type Registry,
} from '../core/block'
import type { Doc } from '../core/doc'
import type { ActivityEntry } from '../core/protocol'
import { buildResolution, referencedIds, type Resolution } from '../core/resolve'
import { blankBlok } from '../core/schema'
import type { StoryMeta, StoryNode } from '../core/story'
import { FolioDoc } from '../preview/Render'
import { Bootstrap, ReactRefreshPreamble, Shell } from './Document'
import {
  createStory,
  deleteStoryStatement,
  listStories,
  publishStoryStatement,
  publishedDoc,
  publishedDocsByIds,
  storyById,
  storyByPath,
  storyTree,
  updateStory,
} from './stories'
import {
  deleteAsset,
  listAssets,
  parseTransform,
  serveAsset,
  toAssetValue,
  updateAsset,
  uploadAsset,
} from './assets'
import { StoryDO } from './story-do'
import {
  buildVersionWrite,
  deleteVersionsStatement,
  getVersion,
  listVersions,
  writeVersion,
} from './versions'

export { StoryDO }
export type { VersionKind, VersionMeta } from './versions'
export { FolioDoc } from '../preview/Render'
export { Shell, serializeJson } from './Document'
export type { StoryMeta, StoryNode } from '../core/story'
export type { Resolution } from '../core/resolve'
export type { AssetRow } from './assets'

export interface FolioBindings {
  db: D1Database
  story: DurableObjectNamespace<StoryDO>
  /** R2 bucket for uploads. Without it the media library is read-only. */
  media?: R2Bucket
  /**
   * Images binding. Without it assets serve at their original size, which keeps
   * Folio working on a bare `wrangler dev` with nothing else configured.
   */
  images?: ImagesBinding
}

interface StoryStub {
  getOrInit(seed: Doc): Promise<Doc>
  recent(limit?: number): Promise<ActivityEntry[]>
  purge(): Promise<void>
  fetch(req: Request): Promise<Response>
}

export interface FolioConfig<Env> {
  blocks: readonly AnyBlockDef[] | Registry
  /** Block type used as the document root. Also where page metadata lives. */
  root: string
  bindings: (env: Env) => FolioBindings
  /** Where these routes are mounted. Default `/folio`. */
  basePath?: string
  /** Public URL for a story path. `''` is the site root. */
  route?: (path: string) => string
  adminCss?: string[]
  previewCss?: string[]
  /** Pass the `__FOLIO_ASSETS__` global the Vite plugin defines. */
  assets?: {
    admin: string
    preview: string
    devClient?: string
    adminCss?: string[]
    previewCss?: string[]
  }
}

export interface Folio<Env> {
  /**
   * Mount in the host's fetch handler. Returns null for anything Folio does
   * not own, so the host's own routes always win.
   */
  handle: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>
  /** Published document for a URL path, or null. */
  published: (env: Env, path: string) => Promise<Doc | null>
  /** Live draft for a story id, creating it on first touch. */
  draft: (env: Env, id: string) => Promise<Doc>
  /** Every story, for sitemaps and static generation. */
  stories: (env: Env) => Promise<StoryMeta[]>
  tree: (env: Env) => Promise<StoryNode[]>
  registry: Registry
  /**
   * Context the document deliberately does not contain: story ids to their
   * current URLs, and so on. Await it before rendering.
   *
   * Resolution happens per render rather than being baked in at publish, because
   * a link stores a story id: renaming the linked-to page has to change every
   * href pointing at it, and a snapshot taken at publish time could not.
   */
  resolve: (env: Env, doc?: Doc) => Promise<Resolution>
  render: (doc: Doc, opts?: { edit?: boolean; resolution?: Resolution }) => ReactNode
}

const DEFAULT_BASE = '/folio'

/**
 * Application close code: the story this object backed has been deleted.
 * Mirrors story-do.ts's own (private) constant by hand — a wire constant, not
 * shared code — so a reconnect that discovers the deletion here closes with
 * the identical code a live purge closes with.
 */
const CLOSE_PURGED = 4002

export function createFolio<Env>(config: FolioConfig<Env>): Folio<Env> {
  const registry = toRegistry(config.blocks)
  const schema = toSchemaIndex(registry)
  const base = config.basePath ?? DEFAULT_BASE
  const route = config.route ?? ((path: string) => `/${path}`)
  const manifest = toManifest(registry, config.root)
  const dev = Boolean(config.assets?.devClient)

  const previewUrlFor = (path: string) => {
    const url = route(path)
    return `${url}${url.includes('?') ? '&' : '?'}_folio=preview`
  }

  const withUrls = <T extends StoryMeta>(story: T): T => ({
    ...story,
    url: route(story.path),
    previewUrl: previewUrlFor(story.path),
  })

  const decorate = (nodes: StoryNode[]): StoryNode[] =>
    nodes.map((n) => ({ ...withUrls(n), children: decorate(n.children) }))

  const seed = (title: string): Doc => {
    const root = blankBlok(schema, config.root, null, null, 'a0')
    if ('title' in root.data) root.data.title = title
    return { root: root.uid, bloks: { [root.uid]: root } }
  }

  const stub = (env: Env, id: string): StoryStub => {
    const { story } = config.bindings(env)
    return story.get(story.idFromName(id)) as unknown as StoryStub
  }

  const draft = async (env: Env, id: string) => {
    const meta = await storyById(config.bindings(env).db, id)
    return stub(env, id).getOrInit(seed(meta?.title ?? 'Untitled'))
  }

  const assetBase = `${base}/asset`

  /**
   * One D1 query for the story map, the same one the tree already runs, plus one
   * more only if the document actually has `reference` fields pointing somewhere.
   * Cheap enough to do per page render; a cache layer in front of it is Phase 4's
   * problem.
   *
   * `draft` is what the preview passes: an editor looking at a page that
   * references a form should see the form as they just edited it, not the last
   * published copy. A live page always resolves published content.
   */
  const resolve = async (env: Env, doc?: Doc, opts?: { draft?: boolean }): Promise<Resolution> => {
    const db = config.bindings(env).db
    const resolution = buildResolution((await listStories(db)).map(withUrls), assetBase)
    if (!doc) return resolution

    const ids = referencedIds(doc, schema).filter((id) => resolution.stories[id])
    if (ids.length === 0) return resolution

    const docs = opts?.draft
      ? Object.fromEntries(
          await Promise.all(ids.map(async (id) => [id, await draft(env, id)] as const)),
        )
      : await publishedDocsByIds(db, ids)

    return { ...resolution, docs }
  }

  /* ------------------------------------------------------------ routes --- */

  const app = new Hono<{ Bindings: never }>().basePath(base)

  app.get('/schema', (c) => c.json(manifest))

  app.get('/stories', async (c) => {
    const db = config.bindings(c.env as Env).db
    return c.json(decorate(await storyTree(db)))
  })

  app.post('/stories', async (c) => {
    const db = config.bindings(c.env as Env).db
    const body = await c.req.json<{ title?: string; slug?: string; parentId?: string | null }>()
    if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400)
    try {
      return c.json(
        withUrls(
          await createStory(db, { title: body.title, slug: body.slug, parentId: body.parentId }),
        ),
      )
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400)
    }
  })

  app.patch('/stories/:id', async (c) => {
    const db = config.bindings(c.env as Env).db
    const body = await c.req.json<{
      title?: string
      slug?: string
      parentId?: string | null
      index?: number
    }>()
    try {
      return c.json(withUrls(await updateStory(db, c.req.param('id'), body)))
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400)
    }
  })

  app.delete('/stories/:id', async (c) => {
    const env = c.env as Env
    const db = config.bindings(env).db

    let found: Awaited<ReturnType<typeof deleteStoryStatement>>
    try {
      found = await deleteStoryStatement(db, c.req.param('id'))
      if (!found) return c.json({ deleted: [] })

      // One batch for the story rows and their version history: either both
      // disappear or neither does, so a reader never finds versions for a story
      // that is already gone (or vice versa). `found.ids` always contains at
      // least the target's own id, so `versions` is never actually null here;
      // the guard stays because the helper's signature allows it.
      const versions = deleteVersionsStatement(db, found.ids)
      await db.batch(versions ? [found.statement, versions] : [found.statement])
    } catch (e) {
      // Nothing has committed yet at this point, so reporting a failure here
      // is accurate.
      return c.json({ error: String((e as Error).message) }, 400)
    }

    // The Durable Object is purged only once that batch has committed.
    // Purging first and then failing the D1 write would leave this id
    // deletable-again while its object already has a blank doc — the
    // opposite of the bug this guards against, but a data-loss bug all the
    // same. Purging after means a crash between the two leaves an orphaned
    // object rather than a resurrected one, which is the safer side to fail on.
    //
    // This runs outside the try/catch above on purpose: the D1 rows are
    // already gone by now, so a purge failure must never be reported back as
    // a failed delete — the caller already got what it asked for. It is
    // best-effort cleanup of an object that a reused id would otherwise
    // resurrect from; an object left un-purged here still cannot be reached
    // under this id (D1 no longer has it), only under a *reused* one, which is
    // the narrow, already-documented window above.
    await Promise.all(
      found.ids.map((id) =>
        stub(env, id)
          .purge()
          .catch(() => {}),
      ),
    )
    return c.json({ deleted: found.ids })
  })

  app.get('/story/:id/socket', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
    const env = c.env as Env
    const id = c.req.param('id')
    if (!(await storyById(config.bindings(env).db, id))) {
      // A plain HTTP 404 here is indistinguishable, on the wire, from a
      // dropped upgrade: the client's WebSocket only ever sees a failed
      // handshake either way, and reconnects on a backoff forever — a
      // deleted story never comes back, so that backoff never ends. Upgrading
      // anyway and closing with the same application code a live purge uses
      // (see story-do.ts's `purge()`) lets the client's existing terminal
      // handling for that code cover this path too, whether the purge raced a
      // still-open socket or a reconnect discovers the deletion afterwards.
      const pair = new WebSocketPair()
      pair[1].accept()
      pair[1].close(CLOSE_PURGED, 'story deleted')
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    await draft(env, id)
    // TODO: validate the session here and hand the verified identity to the DO
    // rather than letting the client self-report it in `hello`.
    return stub(env, id).fetch(c.req.raw)
  })

  app.post('/story/:id/publish', async (c) => {
    const env = c.env as Env
    const db = config.bindings(env).db
    const id = c.req.param('id')
    const meta = await storyById(db, id)
    if (!meta) return c.json({ error: 'Unknown story' }, 404)

    const doc = await draft(env, id)
    // Every publish is a retained version, so "restore what was live before" is
    // always possible. The version row and the stories.published_doc update
    // land in one batch: run separately, a failure between the two could leave
    // a retained version nothing points at, or a live page with no version to
    // restore it from — the two are no longer allowed to disagree.
    const { meta: version, statement: versionStatement } = buildVersionWrite(db, {
      storyId: id,
      kind: 'publish',
      doc,
      actor: c.req.header('x-folio-actor') ?? null,
      fallbackTitle: meta.title,
    })
    const { publishedAt, statement: publishStatement } = publishStoryStatement(
      db,
      id,
      doc,
      meta.title,
    )
    await db.batch([versionStatement, publishStatement])

    return c.json({ ok: true, publishedAt, version })
  })

  /**
   * A story's live draft, for resolving a `reference` in the admin.
   *
   * The admin fetches this when the *set* of referenced ids changes, not per
   * render, and pushes the result into the preview with the resolution. The
   * preview re-renders on every keystroke and must never reach the network.
   */
  app.get('/story/:id/document', async (c) => {
    const env = c.env as Env
    const id = c.req.param('id')
    if (!(await storyById(config.bindings(env).db, id)))
      return c.json({ error: 'Unknown story' }, 404)
    return c.json({ doc: await draft(env, id) })
  })

  /* ----------------------------------------------------------- assets --- */

  app.get('/assets', async (c) => {
    const db = config.bindings(c.env as Env).db
    return c.json(await listAssets(db))
  })

  /**
   * Raw body upload with the filename in a query parameter, rather than
   * multipart: it keeps the Worker out of the business of parsing form data, and
   * the browser sets Content-Type and Content-Length from the File for free.
   */
  app.post('/assets', async (c) => {
    const { db, media } = config.bindings(c.env as Env)
    if (!media) return c.json({ error: 'No media bucket is configured' }, 501)

    const filename = c.req.query('filename')
    if (!filename) return c.json({ error: 'filename is required' }, 400)

    const bytes = await c.req.arrayBuffer()
    try {
      const row = await uploadAsset(db, media, {
        bytes,
        filename,
        contentType: c.req.header('content-type') ?? '',
      })
      return c.json({ asset: row, value: toAssetValue(row) }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/assets/:id', async (c) => {
    const db = config.bindings(c.env as Env).db
    const body = await c.req.json<{ alt?: string }>().catch(() => ({}))
    const row = await updateAsset(db, c.req.param('id'), body)
    return row ? c.json(row) : c.json({ error: 'Unknown asset' }, 404)
  })

  app.delete('/assets/:id', async (c) => {
    const { db, media } = config.bindings(c.env as Env)
    if (!media) return c.json({ error: 'No media bucket is configured' }, 501)
    const gone = await deleteAsset(db, media, c.req.param('id'))
    return gone ? c.json({ deleted: true }) : c.json({ error: 'Unknown asset' }, 404)
  })

  /**
   * Public: published pages point their `<img>` tags here. Resizing lives behind
   * this route so a stored value never names a resizing service.
   */
  app.get('/asset/:key', async (c) => {
    const { media, images } = config.bindings(c.env as Env)
    if (!media) return c.text('No media bucket is configured', 501)
    return serveAsset(
      media,
      images,
      c.req.param('key'),
      parseTransform(new URL(c.req.url).searchParams),
    )
  })

  /* ---------------------------------------------------------- history --- */

  app.get('/story/:id/versions', async (c) => {
    const db = config.bindings(c.env as Env).db
    return c.json(await listVersions(db, c.req.param('id')))
  })

  app.post('/story/:id/versions', async (c) => {
    const env = c.env as Env
    const db = config.bindings(env).db
    const id = c.req.param('id')
    const story = await storyById(db, id)
    if (!story) return c.json({ error: 'Unknown story' }, 404)

    const body: { label?: string; actor?: string } = await c.req
      .json<{ label?: string; actor?: string }>()
      .catch(() => ({}))
    const doc = await draft(env, id)
    return c.json(
      await writeVersion(db, {
        storyId: id,
        kind: 'checkpoint',
        doc,
        label: body.label ?? null,
        actor: body.actor ?? null,
        fallbackTitle: story.title,
      }),
    )
  })

  /**
   * Returns the version's document. Restoring happens on the client: it diffs
   * the live document against this one and applies the result as a single
   * transaction, so a restore syncs to other editors and can be undone.
   */
  app.get('/versions/:versionId', async (c) => {
    const db = config.bindings(c.env as Env).db
    const found = await getVersion(db, c.req.param('versionId'))
    return found ? c.json(found) : c.json({ error: 'Unknown version' }, 404)
  })

  app.get('/story/:id/activity', async (c) => {
    const env = c.env as Env
    const id = c.req.param('id')
    if (!(await storyById(config.bindings(env).db, id)))
      return c.json({ error: 'Unknown story' }, 404)
    return c.json(await stub(env, id).recent(clampLimit(c.req.query('limit'), 60, 200)))
  })

  app.get('/edit/:id', async (c) => {
    const env = c.env as Env
    const id = c.req.param('id')
    const meta = await storyById(config.bindings(env).db, id)
    if (!meta) return c.notFound()

    return html(
      <Shell
        title={`${meta.title} · Folio`}
        stylesheets={[...(config.assets?.adminCss ?? []), ...(config.adminCss ?? [])]}
        head={
          <>
            {dev ? <ReactRefreshPreamble /> : null}
            <Bootstrap global="__FOLIO_ADMIN__" value={{ storyId: id, apiBase: base }} />
          </>
        }
      >
        <div id="folio-admin" />
      </Shell>,
      entries(config, 'admin'),
    )
  })

  app.get('/edit', async (c) => {
    const db = config.bindings(c.env as Env).db
    const root = await storyByPath(db, '')
    const first = root ?? (await listStories(db))[0]
    return first ? c.redirect(`${base}/edit/${first.id}`) : c.notFound()
  })

  /* ------------------------------------------------------------ handle --- */

  const handle: Folio<Env>['handle'] = async (req, env, ctx) => {
    const url = new URL(req.url)

    if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
      return app.fetch(req, env as never, ctx)
    }

    if (url.searchParams.get('_folio') === 'preview') {
      const path = url.pathname.replace(/^\/+|\/+$/g, '')
      const meta = await storyByPath(config.bindings(env).db, path)
      // Not a story: hand it back so the host's own routing wins.
      if (!meta) return null

      const doc = await draft(env, meta.id)
      const resolution = await resolve(env, doc, { draft: true })
      return html(
        <Shell
          title={`Preview · ${meta.title}`}
          stylesheets={[...(config.previewCss ?? []), ...(config.assets?.previewCss ?? [])]}
          bodyClass="folio-editing"
          head={
            <>
              {dev ? <ReactRefreshPreamble /> : null}
              {/* The resolution rides along with the document so the client can
                  re-render per keystroke without going back to the network. */}
              <Bootstrap global="__FOLIO__" value={{ doc, resolution }} />
            </>
          }
        >
          <div id="folio-root">
            <FolioDoc doc={doc} registry={registry} edit resolution={resolution} />
          </div>
        </Shell>,
        entries(config, 'preview'),
      )
    }

    return null
  }

  return {
    handle,
    published: (env, path) => publishedDoc(config.bindings(env).db, path),
    draft,
    stories: async (env) => (await listStories(config.bindings(env).db)).map(withUrls),
    tree: async (env) => decorate(await storyTree(config.bindings(env).db)),
    registry,
    resolve,
    render: (doc, opts) => (
      <FolioDoc doc={doc} registry={registry} edit={opts?.edit} resolution={opts?.resolution} />
    ),
  }
}

/**
 * A query-string limit, defaulted and bounded. `Number(undefined)` and
 * `Number('not-a-number')` both produce `NaN`, which must never reach the SQL
 * bind inside the Durable Object (`Math.max(NaN, 1)` is itself `NaN`, not 1) —
 * so absent or non-numeric input falls back to `fallback` here, before the
 * clamp, rather than trusting the DO's own bound to catch it.
 */
function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), max)
}

function entries<Env>(config: FolioConfig<Env>, which: 'admin' | 'preview'): string[] {
  const assets = config.assets
  if (!assets) return []
  return assets.devClient ? [assets.devClient, assets[which]] : [assets[which]]
}

async function html(node: ReactElement, bootstrapModules: string[]) {
  const stream = await renderToReadableStream(node, { bootstrapModules })
  return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
