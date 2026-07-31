import { createFolio, magicLink, Shell } from 'folio/server'
import { dataOf, resolveAsset, toSchemaIndex, type Doc, type Resolution } from 'folio/core'
// `folio/engine` is the entry point for host-side tooling that manipulates
// documents — a sync job is exactly the case its doc comment names. Ordinary
// block and page code never needs it.
import { diff, fromNested } from 'folio/engine'
import type { ReactElement } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import { blocks } from './blocks'
import { migrations } from './migrations'

// Two Durable Object classes now. SpaceDO is the space channel
// (editing/live-collaboration.md): one instance for the whole site, no storage at
// all, carrying who is where and broadcasting structural events. It is declared
// with `new_classes` rather than `new_sqlite_classes` in wrangler.jsonc for
// exactly that reason.
export { SpaceDO, StoryDO } from 'folio/server'

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
    //
    // content-model/data-documents.md is what makes a record *usable*: the Data
    // rail lists People with a count, selecting it opens a table whose columns
    // are personRecord's `indexed` fields, and opening one is a full-width form
    // with no preview — there is nothing to preview.
    {
      name: 'person',
      label: 'Person',
      kind: 'record',
      root: 'personRecord',
      titleField: 'fullName',
    },
    // A second record type, and the one that shows checkpoint 1: `officeRecord`
    // declares no `render` at all. An office is an address and a phone number,
    // with no layout of its own, so `officeCard` reads `office.data` and
    // `office.content` is genuinely null.
    {
      name: 'office',
      label: 'Office',
      kind: 'record',
      root: 'officeRecord',
      titleField: 'city',
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
  bindings: (env) => ({
    db: env.DB,
    story: env.STORY,
    // Optional, and this is the binding editing/live-collaboration.md adds. Drop
    // it and the editor loses cross-story presence and live tree updates and
    // nothing else — no error, no retry loop, because the admin is told through
    // its bootstrap that the channel does not exist.
    space: env.SPACE,
    media: env.MEDIA,
    images: env.IMAGES,
  }),
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
  // content-model/localisation.md: two languages, one document per story.
  // `default` is the *source* locale — the one `Blok.data` holds — and everything
  // else is a per-field override in `Blok.i18n`. Marking a field
  // `translatable: true` is what puts it in front of a translator; see
  // src/blocks/*.tsx, and `GET /folio/api/audit` for the ones nobody marked.
  locales: {
    default: 'en',
    available: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
    ],
  },
  // '' is the root story, which serves '/'.
  //
  // The locale reaches the URL *here*, and only here (decision 5): Folio owns no
  // URL shape, so this project decides French lives under `/fr` rather than on a
  // subdomain or behind `?lang=`. Paths are locale-independent (checkpoint 4) —
  // `/about` and `/fr/about` are the same story — so the prefix is all there is
  // to it, and `parseLocale` below is the one-line inverse.
  route: (path, locale) => {
    const prefix = locale && locale !== 'en' ? `/${locale}` : ''
    return path ? `${prefix}/${path}` : prefix || '/'
  },
  previewCss: ['/site.css'],
  assets: __FOLIO_ASSETS__,
  // Loaded into every page's Resolution, so any render can place them
  // (`content-model/globals.md`). `settings` doubles as the footer here —
  // its root block already renders a `<footer>`.
  globals: ['header', 'settings'],
  // schema-migrations.md: content migrations, in run order, each a pure function
  // from a document to a list of mutations. Nothing runs on boot — `POST
  // /folio/api/migrate` (admin) or `folio.migrate(env)` from a deploy step, because
  // a migration that runs itself on the first request after a deploy runs inside
  // a request whose CPU limit it can exceed, on a cold Worker, with nobody
  // watching. See src/migrations.ts.
  migrations,
  // publish-hooks.md: an after-commit callback, not a webhook — the host and
  // Folio are the same Worker, so a notification is a typed function call
  // rather than an HTTP round trip to itself. This example just logs.
  //
  // **The cache purge is deliberately not here.** platform/caching.md made it
  // Folio's own internal hook rather than something each host writes: the purge
  // set is derived from Folio's internals — which ids a render loaded, what a
  // `type:` tag means, when a migration touched everything — so a host
  // reimplementing it would drift from the tag vocabulary on the next release.
  // All this project does is set the two headers `folio.cacheHeaders` returns on
  // its published response (see the fetch handler) and turn `cache.enabled` on
  // in wrangler.jsonc.
  //
  // What a host must still never do is `caches.default.delete()` keyed on
  // `story.path`: that delete is per-colo, and a hook runs in exactly one data
  // centre, so every other one goes on serving the stale page until its TTL.
  // Invalidation in appearance only.
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
    // A filtered archive as ordinary application code, which is the fourth user
    // story in `content-model/collections.md`: no Folio route is involved, just
    // `folio.query` over published content. `/archive?topic=policy&page=2`.
    if (url.pathname === '/archive') {
      return archive(env, url)
    }
    // The in-process write (`platform/content-api.md` decision 6): a host's own
    // Worker already holds the bindings, so a nightly ERP sync should not have to
    // make an HTTP request to itself. Behind `/dev/` and localhost-only here only
    // because a route that writes content with no credential is not a pattern to
    // copy — a real one would be a `scheduled()` handler or sit behind the host's
    // own auth. The *code* is what a real one looks like.
    if (url.pathname === '/dev/sync' && req.method === 'POST') {
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return new Response('Not found', { status: 404 })
      }
      return sync(env, req)
    }

    // --- Folio: editor, its API, and preview renders ---------------------
    // Returns null for anything it does not own, including a preview request
    // for a path with no story behind it.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // --- published pages -------------------------------------------------
    // The inverse of `route` above, and this project's job rather than Folio's:
    // only the host knows how it encoded the locale (`localisation.md` decision
    // 5). One line, as the spec promised.
    const { locale, path } = parseLocale(url.pathname)
    // `locale` does not choose a document — there is one per story, holding every
    // language — but it *is* checked: `/xx/about` answers null here and falls
    // through to the 404 below rather than serving English under a URL that means
    // nothing.
    const doc = await folio.published(env, path, locale)
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
    //
    // The locale rides on the resolution, which is what makes the whole render
    // French: every field read in `folio.render` goes through it, and an
    // untranslated field falls back to the source rather than leaving a hole.
    // `?page=` is the host's, not Folio's (`content-model/collections.md`
    // decision 5): the host reads it and passes it in, and it offsets every
    // `collection` field in the document. One number for the page, deliberately —
    // per-field pagination keyed by uid is out of scope until something needs it.
    const page = Number(url.searchParams.get('page') ?? '1')
    // The row behind this path, for two things at once (`platform/caching.md`):
    // `story` lets the resolution reach this page's ancestors, so a breadcrumb
    // resolves; and its id is the one tag a page cannot derive from its own
    // resolution, because a page never links to itself.
    const story = await folio.storyAt(env, path)
    const resolution = await folio.resolve(env, doc, {
      locale,
      page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
      ...(story ? { story } : {}),
    })
    return html(<Page doc={doc} resolution={resolution} locale={locale} />, {
      // Two headers, always together — `Cache-Control` without `Cache-Tag`
      // would be a page cached for a week with no way to purge it, which fails
      // silently and is worse than not caching at all. `max-age` in there is 0
      // on purpose: a purge reaches the edge and cannot reach a browser cache,
      // so a visitor holding a stale copy is a stale copy nothing can evict.
      // The edge's `s-maxage` is a week, because invalidation is the mechanism
      // and the TTL is only the fallback for a purge that never arrived.
      ...folio.cacheHeaders(resolution, { story: story?.id ?? null }),
    })
  },
} satisfies ExportedHandler<Env>

/** The locales this site serves, mirroring `locales.available` above. */
const LOCALES = ['en', 'fr'] as const

/**
 * The locale a URL names, and the story path underneath it — the inverse of the
 * `route` config above.
 *
 * Deliberately host code (`localisation.md` decision 5): Folio only ever needs
 * this for its own preview branch, where it derives the answer by calling `route`
 * itself, so a host that changed its mind about the URL shape would change one
 * function here and one there and nothing else.
 *
 * An unrecognised first segment is a path, not a locale, so `/energy/about` is a
 * page rather than a language nobody declared.
 */
function parseLocale(pathname: string): { locale: string; path: string } {
  const clean = pathname.replace(/^\/+|\/+$/g, '')
  const [first, ...rest] = clean.split('/')
  if (first && first !== 'en' && (LOCALES as readonly string[]).includes(first)) {
    return { locale: first, path: rest.join('/') }
  }
  return { locale: 'en', path: clean }
}

/** Page metadata comes off the document's root block. */
function Page({ doc, resolution, locale }: { doc: Doc; resolution: Resolution; locale: string }) {
  const root = doc.bloks[doc.root]
  // `dataOf` rather than `.data`: metadata is read straight off the root block
  // rather than through `render`, so reading it in the active locale is this
  // page's job (`content-model/localisation.md`). A `title` translated into
  // French belongs in `<title>` and in `og:title`, not only in the body.
  const meta = root ? dataOf(root, resolution.locale) : {}
  const title = String(meta.title ?? 'Untitled')
  // Metadata is read straight off the root block rather than through `render`,
  // so resolving the asset is this page's job.
  const social = resolveAsset(meta.socialImage, resolution)

  return (
    <Shell
      title={title}
      // The one bit of chrome only the host can set, and the reason switching
      // locale in the editor reloads the preview rather than pushing a frame.
      lang={locale}
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

/**
 * A filtered archive, written as ordinary application code — the point being that
 * `folio.query` needs no block, no page and no editor
 * (`content-model/collections.md`). Answers JSON so it is legible in a terminal and
 * usable by `scripts/collections-test.mjs`.
 *
 * An unknown `topic` is a 400 from Folio naming the field, not a silent empty
 * result, which is the whole reason `where` is checked against the schema's indexed
 * set before it reaches SQL.
 */
async function archive(env: Env, url: URL) {
  const topic = url.searchParams.get('topic')
  const page = Number(url.searchParams.get('page') ?? '1')
  const result = await folio.query(env, {
    type: 'insight',
    ...(topic ? { where: [{ field: 'topic', op: 'eq' as const, value: topic }] } : {}),
    order: { field: 'published', dir: 'desc' },
    perPage: 5,
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
  })

  return Response.json({
    total: result.total,
    page: result.page,
    pages: result.pages,
    // Deliberately not the whole document: an archive listing needs a title and a
    // URL, and `items` carries the document for the cases that need more.
    items: result.items.map((i) => ({
      id: i.id,
      title: i.title,
      url: i.url,
      topic: i.data.topic ?? null,
      published: i.data.published ?? null,
    })),
  })
}

/**
 * One document updated from "another system", in process — the second user story
 * in `platform/content-api.md`, and the whole of its decision 6 in a dozen lines.
 *
 * Read the draft, build the target with `fromNested`, `diff`, `folio.write`. That
 * is the same read-diff-commit `PUT /api/v1/documents/:id/content` performs, so
 * this write inherits every property that one has: an editor with the page open
 * sees it arrive, the activity trail says `sync-job`, and Cmd+Z undoes it.
 *
 * `mode: 'merge'` is why the body can be `{ fields: { role: 'CTO' } }` and nothing
 * else — absent fields are left alone, so a partial payload from an ERP is safe.
 * `txId` makes a retry after a timeout write once rather than twice, which is what
 * a scheduled job needs and what nobody remembers to build.
 *
 * `POST /dev/sync` with `{ "id": "sty_x", "fields": { "role": "CTO" } }`.
 */
async function sync(env: Env, req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string
    fields?: Record<string, unknown>
    txId?: string
  }
  if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })

  const doc = await folio.draft(env, body.id)
  const target = fromNested(
    { uid: doc.root, fields: body.fields ?? {} },
    toSchemaIndex(folio.registry),
    doc,
    { mode: 'merge' },
  )
  const result = await folio.write(env, body.id, diff(doc, target), {
    actor: 'sync-job',
    name: 'Nightly sync',
    ...(body.txId ? { txId: body.txId } : {}),
  })
  return Response.json(result)
}

function sitemap(stories: Awaited<ReturnType<typeof folio.stories>>, origin: string) {
  const urls = stories
    // `folio.stories` returns every document, records and singletons included
    // (document-types.md). An unrouted one has `path === null` and no URL at
    // all, so it is not a sitemap entry — filtering on `publishedAt` alone
    // would have emitted `/null`.
    .filter((s) => s.publishedAt && s.path !== null)
    // Every language, because publishing publishes them all at once
    // (`localisation.md` checkpoint 3): a French page is live the moment its
    // English one is, with fallbacks wherever it is untranslated, so leaving it
    // out of the sitemap would be a lie. `urls` is the host's own `route` called
    // once per declared locale, so this needs no knowledge of the URL shape —
    // and is absent entirely on a site with no locales, hence the fallback.
    .flatMap((s) => Object.values(s.urls ?? { en: s.url ?? `/${s.path}` }))
    .map((url) => `  <url><loc>${origin}${url}</loc></url>`)
    .join('\n')

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
    { headers: { 'content-type': 'application/xml' } },
  )
}

async function html(node: ReactElement, headers: Record<string, string> = {}) {
  return new Response(await renderToReadableStream(node), {
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  })
}
