import { dataOf, type Doc, type Resolution } from 'folio/core'
import { createFolio, magicLink, Shell } from 'folio/server'
import type { ReactElement } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import { blocks } from './blocks'

/**
 * Two Durable Object classes, re-exported so wrangler can find them.
 *
 * `StoryDO` holds one document's live draft and its mutation log — that is what
 * makes editing multiplayer and undoable. `SpaceDO` is the space channel: one
 * instance for the whole site, holding no storage at all, carrying who is where
 * and broadcasting structural events. It is declared with `new_classes` rather
 * than `new_sqlite_classes` in wrangler.jsonc for exactly that reason.
 */
export { SpaceDO, StoryDO } from 'folio/server'

/** Defined by the Vite plugin. Pass it straight through as `assets` below. */
declare const __FOLIO_ASSETS__: {
  admin: string
  preview: string
  devClient?: string
  adminCss?: string[]
  previewCss?: string[]
}

/**
 * Local development only: the sign-in link this Worker "sent".
 *
 * Module state in a Worker is per-isolate and is not something to rely on in
 * production — which is the point. It exists so you can finish a sign-in with
 * no mailbox, and the route that reads it refuses anything but localhost.
 * Delete both once you have real mail.
 */
let lastSignInUrl: string | null = null

const folio = createFolio<Env>({
  blocks,

  /**
   * Every shape of document this site has. One here; add a `record` for
   * unrouted data (people, products) or a `singleton` for site settings.
   *
   * `kind: 'page'` is the whole routing story — a page lives in the tree and
   * derives its URL from it. There is no routing rule to configure.
   */
  types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],

  bindings: (env) => ({
    db: env.DB,
    story: env.STORY,
    // Optional. Without it the editor loses cross-story presence and live tree
    // updates, and nothing else — no error, no retry loop.
    space: env.SPACE,
    media: env.MEDIA,
    images: env.IMAGES,
  }),

  /**
   * Who may edit. **There is no default** — a host that simply forgot this key
   * used to get a publicly editable CMS in silence, so `createFolio` throws
   * instead.
   *
   * Folio renders the sign-in URL and owns the session; *you* send the mail,
   * because only you have the binding and the from-address. This project has no
   * mail binding, so it logs the link — a perfectly good local flow. Swap in
   * Cloudflare Email Sending (or anything else) before you deploy.
   *
   * The first editor is a **deploy step**, not a route: a CMS with accounts
   * cannot bootstrap its own first admin over HTTP, because an endpoint that
   * creates an admin is an endpoint that creates an admin. See seed.sql.
   */
  auth: {
    providers: [
      magicLink({
        send: (_env, { email, url }) => {
          console.log(`\nfolio: sign-in link for ${email}\n  ${url}\n`)
          lastSignInUrl = url
        },
      }),
    ],
  },

  /**
   * Public URL for a story path. `''` is the root story, which serves `/`.
   *
   * You own the URL shape; Folio needs this only so it can point the editor's
   * preview iframe at the right page. Whatever it returns must be on the same
   * origin the admin is served from.
   */
  route: (path) => (path ? `/${path}` : '/'),

  // Your site stylesheet, so the editor's preview looks like the site.
  previewCss: ['/site.css'],
  assets: __FOLIO_ASSETS__,

  /**
   * A promise that the page route below calls `reader.page()`, and it does.
   * With it, a share link sends a reviewer to the page's own URL; without it
   * they land on Folio's preview shell instead.
   */
  draftMode: true,

  /**
   * After-commit callbacks in this Worker — not webhooks to yourself. They run
   * after a write has landed and can never veto one.
   *
   * Note there is no cache purge here: Folio purges by tag from the render's
   * own dependency set, which is knowledge a host cannot reconstruct.
   */
  hooks: {
    published: ({ story }) => console.log(`folio: published ${story.path || '/'}`),
    unpublished: ({ story }) => console.log(`folio: unpublished ${story.path || '/'}`),
  },
})

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url)

    // --- your own routes, which always win ------------------------------
    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    // Local development only: a stand-in for a mailbox, so `curl` can do what a
    // person would do with their inbox. Not a Folio route, and not a pattern to
    // copy into a real deployment — delete it with the `send` above.
    if (url.pathname === '/dev/last-signin') {
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return new Response('Not found', { status: 404 })
      }
      return Response.json({ url: lastSignInUrl })
    }

    if (url.pathname === '/sitemap.xml') {
      const stories = await folio.stories(env)
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${stories
          .filter((s) => s.state === 'live' || s.state === 'changed')
          .map((s) => `<url><loc>${url.origin}${s.url ?? '/'}</loc></url>`)
          .join('')}</urlset>`,
        { headers: { 'content-type': 'application/xml' } },
      )
    }

    // --- Folio: the editor, its API, and preview renders -----------------
    // Returns null for anything it does not own, so it can never swallow one of
    // your paths and needs no blocklist. Put your own routes before it only if
    // they could collide with `/folio/*`.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // --- published pages -------------------------------------------------
    return renderPage(req, env, url)
  },

  /**
   * Scheduled publish and unpublish, plus auth housekeeping. This handler and
   * `triggers.crons` in wrangler.jsonc are the entire cost of both features.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Loop on `continueFrom`, never on `report.remaining` — a schedule that
    // failed transiently in this sweep is still due, so that loop spins. The
    // batch guard bounds one tick; whatever is left is still due next minute.
    let cursor: string | null = null
    let batches = 0
    do {
      const report = await folio.runSchedules(env, { continueFrom: cursor })
      cursor = report.continueFrom
    } while (cursor !== null && ++batches < 20)

    // Expired sessions, consumed sign-in challenges, and auth_events past their
    // 90-day retention. Nothing breaks when this is never wired up — the
    // failure mode is unbounded growth rather than an outage, which is exactly
    // why it is easy to forget.
    await folio.sweepAuth(env)
  },
}

/**
 * The published page.
 *
 * **This is the function your router would call.** This project is a bare
 * Worker with nowhere to hand off to, so it is called inline above — but as
 * soon as you add React Router, TanStack Start or anything else that owns
 * routing, move this call into that framework's loader instead. `Resolution`
 * is plain JSON, so it survives a loader boundary, and you keep your layout,
 * your `<head>` and your error boundaries.
 */
async function renderPage(req: Request, env: Env, url: URL) {
  /**
   * One reader for the whole render, so every read below runs on a single D1
   * session — served by a replica near the visitor rather than by the primary
   * wherever it is, and all of them agreeing on one version of the database.
   *
   * `folio.published(env, …)` and friends still exist and each open their own
   * session: right for a cron, wrong for a page. Pass the `Request` — it is
   * what makes draft mode work at all.
   */
  const reader = folio.reader(env, req)
  const path = url.pathname.replace(/^\/+|\/+$/g, '')

  /**
   * One call for the whole page: the draft-or-published document, the story row
   * behind it, the resolution, and the cache headers this response must carry.
   *
   * Answer with `page.headers` and never assemble your own. Both halves are
   * silent when wrong — a draft answered with published headers puts
   * unpublished content on the edge under the page's real URL, and a published
   * page answered with `Cache-Control` and no `Cache-Tag` is cached for a week
   * with no way to purge it.
   */
  const asked = Number(url.searchParams.get('page') ?? '1')
  const page = await reader.page(path, {
    page: Number.isFinite(asked) && asked >= 1 ? Math.trunc(asked) : 1,
  })

  if (!page) {
    // One round trip for the whole 404 branch: the redirect lookup and the
    // published state together, so a page taken down on purpose answers 410
    // rather than being guessed at.
    const miss = await reader.miss(path)
    if (miss.kind === 'redirect') {
      const location = new URL(miss.to, url.origin)
      location.search = url.search
      return Response.redirect(location.toString(), miss.status)
    }
    return new Response('Not found', { status: miss.kind === 'gone' ? 410 : 404 })
  }

  return html(<Page doc={page.doc} resolution={page.resolution} draft={page.draft} />, page.headers)
}

function Page({ doc, resolution, draft }: { doc: Doc; resolution: Resolution; draft: boolean }) {
  const root = doc.bloks[doc.root]
  // `dataOf` rather than `.data`: metadata is read straight off the root block
  // rather than through `render`, so reading it in the active locale is this
  // page's job. Reading `blok.data[name]` directly silently ignores
  // translations, which is why it is never the right call.
  const meta = root ? dataOf(root, resolution.locale) : {}
  const title = String(meta.title ?? 'Untitled')

  return (
    <Shell
      title={title}
      stylesheets={['/site.css']}
      head={
        <>
          {meta.description ? <meta name="description" content={String(meta.description)} /> : null}
          {meta.noindex ? <meta name="robots" content="noindex" /> : null}
          <meta property="og:title" content={title} />
        </>
      }
    >
      {/* Draft mode's only visible cost: a banner, so nobody mistakes an
          unpublished page for a live one. Drawn from the flag on `page`, never
          from `folio.inDraftMode(req)` — the two answer different questions and
          only the first has been through a role or a grant. */}
      {draft ? <div className="draft-banner">Draft preview — not published</div> : null}
      {folio.render(doc, { resolution })}
    </Shell>
  )
}

async function html(node: ReactElement, headers: Record<string, string> = {}) {
  return new Response(await renderToReadableStream(node), {
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  })
}
