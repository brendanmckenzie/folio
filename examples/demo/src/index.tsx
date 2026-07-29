import { createFolio, magicLink, Shell } from 'folio/server'
import { resolveAsset, type Doc, type Resolution } from 'folio/core'
import type { ReactElement } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import { blocks } from './blocks'

export { StoryDO } from 'folio/server'

declare const __FOLIO_ASSETS__: {
  admin: string
  preview: string
  devClient?: string
  adminCss?: string[]
  previewCss?: string[]
}

const folio = createFolio<Env>({
  blocks,
  // document-types.md: four shapes of document, not one. `root: 'page'` still
  // works and is sugar for exactly the first entry here; this spells it out
  // because the point of the demo is to show what a real host declares.
  //
  // `kind` is the whole routing story. A `page` lives in the tree and owns a
  // URL; a `record` and a `singleton` leave the tree entirely (parent_id and
  // path both null), so naming a person "Contact" cannot take /contact away
  // from the page that needs it.
  types: [
    { name: 'page', label: 'Page', kind: 'page', root: 'page' },
    // A second *routable* type. No routing rule to configure: an insight
    // created under the "Insights" page already serves at /insights/whatever,
    // because Folio derives a path from the tree (checkpoint 3). `under`
    // constrains where one may be created *and* dragged, with a refusal notice.
    { name: 'insight', label: 'Insight', kind: 'page', root: 'insightPage', under: ['page'] },
    // Unrouted, and many of them. `titleField` is needed because personRecord
    // has no `title` field for the tree cache to have guessed at.
    {
      name: 'person',
      label: 'Person',
      kind: 'record',
      root: 'personRecord',
      titleField: 'fullName',
    },
    // Unrouted, and exactly one — enforced by the derived id `sng_settings`
    // rather than by a constraint. Created on first access, never by an editor.
    { name: 'settings', label: 'Site settings', kind: 'singleton', root: 'settingsRoot' },
    // A second singleton, also a global (below): the site header. `previewPath:
    // ''` is what lets the admin preview it sitting on the homepage instead of
    // a blank background (`content-model/globals.md` decision 4) — opening it
    // points the iframe at `/?_folio=preview&as=header`.
    { name: 'header', label: 'Header', kind: 'singleton', root: 'headerRoot', previewPath: '' },
  ],
  bindings: (env) => ({ db: env.DB, story: env.STORY, media: env.MEDIA, images: env.IMAGES }),
  // identity-and-access.md: `auth` has no default (checkpoint 2), so a host that
  // forgets this key fails at construction rather than serving a publicly
  // editable CMS. `auth: 'open'` is the one-line escape hatch for a throwaway
  // local instance and is what this demo used to say; a real deployment names
  // providers, so this one does.
  //
  // Folio renders the sign-in URL and owns the session; the *host* sends the
  // mail, because only the host has the binding and the from-address
  // (architecture decision 2). This project has no mail binding at all, so
  // `send` logs the link — which is a perfectly good local-dev flow, and is
  // exactly what makes the provider exercisable with no external credentials.
  // A real deployment calls Cloudflare Email Sending here instead.
  //
  // Editors are seeded in seed.sql: a CMS with accounts cannot bootstrap its
  // first admin over HTTP, so that row is a deploy step.
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
  basePath: '/folio',
  // '' is the root story, which serves '/'.
  route: (path) => (path ? `/${path}` : '/'),
  previewCss: ['/site.css'],
  assets: __FOLIO_ASSETS__,
  // Loaded into every page's Resolution, so any render can place them
  // (`content-model/globals.md`). `settings` doubles as the footer here —
  // its root block already renders a `<footer>`.
  globals: ['header', 'settings'],
  // publish-hooks.md: an after-commit callback, not a webhook -- the host and
  // Folio are the same Worker, so a cache purge or a notification is a typed
  // function call rather than an HTTP round trip to itself. This demo has no
  // cache layer of its own yet (ROADMAP.md's "cache invalidation on publish"),
  // so the example just logs; a real host would purge `caches.default` here
  // instead, keyed on `story.path`.
  hooks: {
    published: ({ story }) => {
      console.log(`folio: published ${story.path || '/'}`)
    },
    unpublished: ({ story }) => {
      console.log(`folio: unpublished ${story.path || '/'}`)
    },
  },
})

/**
 * The last sign-in link this worker "sent", for `/dev/last-signin` below.
 *
 * Module state in a Worker is per-isolate and is not something to rely on in
 * production — which is the point: this exists so a local dev server and
 * `scripts/auth-test.mjs` can finish a flow that would otherwise need a mailbox,
 * and the route that reads it refuses anything but localhost.
 */
let lastSignInUrl: string | null = null

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    // --- this project's own non-CMS routes, which always win -------------
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'demo' })
    }
    // Local development only: the link `send` above logged, so a script can do
    // what a person would do with their inbox. Not a Folio route and not a
    // pattern to copy into a real host — it is a stand-in for a mailbox.
    if (url.pathname === '/dev/last-signin') {
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return new Response('Not found', { status: 404 })
      }
      return Response.json({ url: lastSignInUrl })
    }
    if (url.pathname === '/sitemap.xml') {
      return sitemap(await folio.stories(env), url.origin)
    }

    // --- Folio: editor, its API, and preview renders ---------------------
    // Returns null for anything it does not own, including a preview request
    // for a path with no story behind it.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // --- published pages -------------------------------------------------
    const path = url.pathname.replace(/^\/+|\/+$/g, '')
    const doc = await folio.published(env, path)
    if (!doc) {
      // A live story always wins: folio.published is checked first, and
      // creating a story at a redirected path deletes the row anyway, so the
      // redirect can never shadow a real page.
      const hit = await folio.redirect(env, path)
      if (hit) {
        const location = new URL(hit.to, url.origin)
        location.search = url.search
        return Response.redirect(location.toString(), hit.status)
      }
      // folio.status tells apart a page taken down on purpose from one that
      // never existed, so a host can answer 410 for the former and 404 for
      // the latter instead of guessing. Folio itself never assumes either.
      const status = await folio.status(env, path)
      return new Response('Not found', { status: status === 'unpublished' ? 410 : 404 })
    }

    // Story links store an id, so hrefs are resolved per render rather than
    // frozen at publish time. Renaming a page fixes every link to it.
    const resolution = await folio.resolve(env, doc)
    return html(<Page doc={doc} resolution={resolution} />)
  },
} satisfies ExportedHandler<Env>

/** Page metadata comes off the document's root block. */
function Page({ doc, resolution }: { doc: Doc; resolution: Resolution }) {
  const meta = doc.bloks[doc.root]?.data ?? {}
  const title = String(meta.title ?? 'Untitled')
  // Metadata is read straight off the root block rather than through `render`,
  // so resolving the asset is this page's job.
  const social = resolveAsset(meta.socialImage, resolution)

  return (
    <Shell
      title={title}
      stylesheets={['/site.css']}
      head={
        <>
          {meta.description ? <meta name="description" content={String(meta.description)} /> : null}
          {meta.noindex ? <meta name="robots" content="noindex" /> : null}
          <meta property="og:title" content={title} />
          {social ? (
            <meta
              property="og:image"
              content={social.srcFor({ width: 1200, height: 630, fit: 'cover' })}
            />
          ) : null}
        </>
      }
    >
      {/*
        The host places globals in its own shell (`content-model/globals.md`
        decision 2) — Folio never wraps the page in a layout, so this project
        decides the header goes above the content and the footer below it,
        not Folio. Both come from the same `resolve()` call `doc` already
        needed, so this costs no extra request.
      */}
      {folio.renderGlobal(resolution, 'header')}
      {/* No client entry, so a published page ships zero JavaScript. */}
      <div id="folio-root">{folio.render(doc, { resolution })}</div>
      {folio.renderGlobal(resolution, 'settings')}
    </Shell>
  )
}

function sitemap(stories: Awaited<ReturnType<typeof folio.stories>>, origin: string) {
  const urls = stories
    // `folio.stories` returns every document, records and singletons included
    // (document-types.md). An unrouted one has `path === null` and no URL at
    // all, so it is not a sitemap entry — filtering on `publishedAt` alone
    // would have emitted `/null`.
    .filter((s) => s.publishedAt && s.path !== null)
    .map((s) => `  <url><loc>${origin}${s.url ?? `/${s.path}`}</loc></url>`)
    .join('\n')

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
    { headers: { 'content-type': 'application/xml' } },
  )
}

async function html(node: ReactElement) {
  return new Response(await renderToReadableStream(node), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
