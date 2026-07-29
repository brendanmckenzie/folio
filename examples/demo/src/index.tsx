import { createFolio, Shell } from 'folio/server'
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
  ],
  bindings: (env) => ({ db: env.DB, story: env.STORY, media: env.MEDIA, images: env.IMAGES }),
  basePath: '/folio',
  // '' is the root story, which serves '/'.
  route: (path) => (path ? `/${path}` : '/'),
  previewCss: ['/site.css'],
  assets: __FOLIO_ASSETS__,
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    // --- this project's own non-CMS routes, which always win -------------
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'demo' })
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
      {/* No client entry, so a published page ships zero JavaScript. */}
      <div id="folio-root">{folio.render(doc, { resolution })}</div>
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
