# Building a host on Folio

Instructions for a coding agent adding Folio to a project. `docs/handbook.md`
explains what each feature *is* and `docs/configuration.md` is every config key;
this file says what to do, in what order, and what you will get wrong. Where
they disagree, this file is about integration and those are about features and
settings — neither overrides the other.

Folio is a library, not an application. **The host owns its Worker, its routing
and its public pages.** Folio owns the editor, the sync engine and the block
render. Everything below follows from that.

## Install

```
npm install github:brendanmckenzie/folio#<full-sha>
```

**Starting a project from nothing?** Scaffold it instead — you get a working
Worker, a `wrangler.jsonc` with every binding, and a pinned SHA:

```
npx github:brendanmckenzie/folio init my-site
```

Pin a **full 40-character SHA**, never a branch. There is no npm package and no
tag; a SHA is the version. `npm install` runs the package's `prepare`, which
builds `dist/` on your machine — expect the install to take a few seconds and to
need `esbuild` and `typescript` to succeed.

Peer dependencies: React 19, React DOM 19, Vite 7 or 8.

**When you bump the pin, delete `node_modules/folio` first.** npm skips the
package's build if the directory is already there, leaving no `dist/`.

An upgrade is more than the pin when Folio has landed a D1 migration since
yours. `UPGRADING.md` is the procedure and the per-migration ledger — two of
them need a reindex, and one needs a cron you may not have.

## Point your own agent at this file

An agent working in *your* repository reads *your* root instructions, not this
file buried in `node_modules`. Paste this into your `AGENTS.md` or `CLAUDE.md`
so it knows to come here. The markers exist so it can be replaced wholesale on
an upgrade without disturbing anything around it.

```markdown
<!-- folio:begin -->
## Folio (CMS)

This project uses Folio, a Cloudflare-native block CMS mounted as a library.
**Before changing anything that touches it — blocks, the Worker entry, routing,
the Vite config — read `node_modules/folio/AGENTS.md`.** It states the one
sanctioned integration shape and the traps that read as library bugs when you
hit them.

The three rules broken most often:

- `folio.handle()` runs **first** in the Worker's `fetch` and returns `null` for
  anything it does not own. Your router runs after it, not before.
- A published page is **your** route, calling `folio.reader(env, req).page()` in its loader.
  Never render pages in the Worker entry — it works, and silently bypasses your
  framework's layout, meta and error boundaries.
- Read fields with `fieldValue()` / `dataOf()` from `folio/core`, never
  `blok.data[name]`, or translations silently fall back to the source locale.

After bumping the pinned SHA, `rm -rf node_modules/folio` before installing.
<!-- folio:end -->
```

## The integration shape

There is one correct arrangement. Use it.

**1. Folio goes first in your Worker's `fetch`, as a miss-through.**

```tsx
export { SpaceDO, StoryDO } from 'folio/server'

export default {
  async fetch(req, env, ctx) {
    // Your own routes win. Put them before folio.handle() if they could collide.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // …then your router, unchanged.
    return router.fetch(req, env, ctx)
  },
}
```

`folio.handle()` returns a `Response` for surfaces Folio owns (the admin, its
JSON API, `{base}/mcp`, preview) and **`null` for everything else**. It never
intercepts, so it needs no blocklist and cannot swallow one of your paths.

**2. A published page stays *your* route.** Do not render pages inside the
Worker entry. In your framework's loader (or handler, or controller):

```tsx
const r = folio.reader(env, req)                  // one D1 session per request
const page = await r.page(path, { locale })       // doc + story + resolution + access + headers
if (!page) {
  const miss = await r.miss(path)                 // redirect + state, one round trip
  // `miss.to` is rooted (`/guides/new`), so this is a URL and not a path the
  // browser would resolve against the page it is already on. Reattach
  // `url.search` yourself if you want query strings to survive.
  if (miss.kind === 'redirect') return Response.redirect(new URL(miss.to, url.origin), miss.status)
  return new Response('Not found', { status: miss.kind === 'gone' ? 410 : 404 })
}
return html(
  <YourLayout>
    {folio.render(page.doc, { resolution: page.resolution })}
    {/* Only reachable at all if `createFolio` declared `gate` — otherwise
        `page.access` is always 'public'. On 'denied', `page.doc` is already
        the redacted document (root kept, body dropped), so this render is
        unchanged; add your own paywall where the body was. */}
    {page.access === 'denied' ? <YourPaywall /> : null}
  </YourLayout>,
  page.headers,                                   // no-store on a draft or a gated page, tags on a public one
)
```

**A gated page is `private, no-store` whether it answers `granted` or
`denied`** — see "Visitor access" in `docs/handbook.md`. `page.access` is the whole
security property: `cacheVerdictFor` has no opinion on your own route, so this
value is the only thing keeping members-only content out of a shared cache
under its real URL.

**Always `folio.reader(env, req)` for a page, never the top-level
`folio.published(env, …)`.** A render makes three or four reads, and a reader
runs them on one D1 session: that is what lets a read replica near the visitor
answer them instead of the primary (which may be on another continent — it was
~280ms per query on the first production host), and it is what guarantees they
all see the same version of the database. The top-level calls each open their
own session and are for one-shot use from a cron or a deploy script. Pass the
`Request`; it is what makes draft mode work and what carries an editor's
read-your-writes bookmark.

This keeps your framework's layout, `meta`/`head` exports, error boundaries and
SEO helpers. It works because `Resolution` is plain JSON — the rich objects
(`asset.srcFor`, a reference's `content`) are rebuilt from it at render time, so
it survives a loader boundary.

**Draft mode comes with `page()`**, so editors and reviewers see the page
rendered from its draft at its own URL: `page.draft` tells you to draw a banner
and `page.headers` is already `no-store`. All you add is `draftMode: true` in
`createFolio`, which is the promise to Folio that this branch exists — without
it a share link lands on `?_folio=draft` and Folio answers with its own preview
shell instead of your page.

It costs an ordinary visitor nothing: the credential is a cookie, so the test is
a header read before any query.

**3. Add the Vite plugin.** `folio/vite` supplies the admin entry, the client
build and the asset constants. Do not hand-roll them.

## A multi-site host

Skip this unless `createFolio` has a `sites` key. Without one, none of it applies
and nothing above changes. With one, the deployment holds many sites (spec 23,
`docs/specs/foundation/multi-site.md`; the feature is `docs/handbook.md` "Many sites
in one deployment"), and the host does six things differently. **Turning `sites` on
is the point of no return** (`UPGRADING.md`); do not do it to a production
deployment on the strength of this file.

**1. Three hostnames per site, and one admin.** A site has live hosts
(`alpha.example`) and, if it previews drafts, a preview origin
(`https://preview.alpha.example`). The whole deployment has one admin origin,
`sites.admin` (`https://cms.example`). Route all of them to the Worker. Folio answers
a different slice on each and returns `null` for the rest:

| Origin | `folio.handle()` answers |
| --- | --- |
| admin | the admin, its API, sign-in, passkeys, the registry, `{base}/mcp` |
| a live host | `{base}/asset/:key` and `POST {base}/f/:id` only. **Published pages are your route.** |
| a preview origin | those two, plus `share`, `site/enter`, `draft/enter|exit`, `?_folio=` and `GET {base}/~<site>/api/v1/*`. **Drafts exist only here.** |

**2. `sites.admin` and `route`.**

```tsx
const folio = createFolio<Env>({
  …,
  sites: { admin: 'https://cms.example', settings: 'siteSettings' },
  // Absolute for a site: the admin is on another origin. `site` is undefined for
  // a scope that is not a site, and for Folio's own preview branch.
  route: (path, locale, site) => {
    const tail = path ? `/${path}` : '/'
    return site?.hosts[0] ? `https://${site.hosts[0]}${tail}` : tail
  },
})
```

The admin origin must not be any site's live host or preview origin.

**3. A reader always says which site.** `folio.reader(env, req)` reads the request's
host and gates it by the site's status. `folio.reader(env, { site: 'alpha' })` is for
a caller with no request (a sitemap build, a cron) and reads that site's live surface.
**`folio.reader(env)` with neither throws** on this deployment, as do the top-level
one-shot reads. A host that is not any site's (an unknown hostname, a draft site's
live host, a site not yet `live`) gets a reader that answers as a site with no content:
`page()` is `null`, so your existing miss branch produces your 404. `await
reader.site()` answers the registry row or `null`, and `folio.settings(page.resolution)`
the merged site settings (`null` with no settings type):

```tsx
const r = folio.reader(env, req)
const page = await r.page(path, { locale })
const theme = page ? folio.settings(page.resolution) : null
```

Call `page.headers` as before; its tags now include `site:<id>` and `path:<id>:<path>`.

**4. The cached loopback passes props.** The Workers Cache key is not the host, so
the site and the surface have to be in the props or two sites at one path share an
entry:

```ts
this.ctx.exports.CachedPages({ props: await folio.cacheProps(req, this.env) })
  .fetch(req, { cf: { cacheKey: folio.cacheKey(req.url) } })
```

`cacheProps` takes `env` (it reads the registry). Everything else in "Caching goes on
one entrypoint" stands, including routing writes through the cached entrypoint.

**5. Redirect the admin path on live hosts.** `handle()` leaves `{base}/…` to you on a
live host, so an editor's `alpha.example/folio` bookmark lands on your 404. Before
`folio.handle`, for a `GET` or `HEAD` on any host that is not the admin origin whose
path is `{base}` or `{base}/…` other than `{base}/asset/…` and `{base}/f/…`, answer a
`302` to the same path and query on the admin origin.

**6. A preview origin renders drafts through your route too.** There the credential
is the ask: a request whose preview grant (or session, or token) may preview the site
gets the chain's drafts from your `reader.page()` route, with no draft cookie. A
share keeps to its one story, a live host never gets a draft whatever the request
carries, and a single-site deployment still needs the draft cookie (as in "Draft mode
comes with `page()`"). With `draftMode: true`, `{base}/draft/enter` on the preview
origin accepts a preview grant in place of a session, and with neither redirects to
`site/start`, which is how an editor arriving without a grant gets one. Cache none of it: `page.headers` is already
`no-store`, and `folio.cacheVerdict` bypasses a request carrying the grant, draft or
share cookie. A response header you set only on preview origins
(`X-Robots-Tag: noindex`) is safe because the surface is in the cache key.

**A headless front end** (a separate Worker or a service binding) does not link
Folio's reader; it calls, with a token, `GET {base}/api/v1/sites/resolve?host=` (host
to site and surface, `grantRequired: true` for a draft site's preview origin),
`GET {base}/api/v1/sites` (every non-draft site, its hosts and preview origin) and
`GET {base}/~<site>/api/v1/pages/{path}?surface=live|preview` (`{ story, document,
resolution, draft, access }` plus a `folio-cache-tags` header). A `hooks` handler
forwards each payload's `purge` (`{ tags }` or `{ everything: true }`) to the front
end's cached entrypoint, because a purge reaches only the entrypoint that issued it,
and `siteChanged` refreshes its host map.

**Scripts, MCP and tokens** address a scope: `{base}/~<site>/api/v1/…`,
`{base}/~<site>/mcp`. An unscoped call to a scoped route is `400 site_required`. A
token can be bound to one site (`POST /tokens` with `site`), and then supplies the
scope itself.

## Rules

- **`folio.handle()` first, and it returns `null`.** If a Folio path 404s, your
  router ran first.
- **`redirect()` and `status()` belong in your own miss branch.** Folio will not
  answer them for you, deliberately — it does not own your 404.
- **Read fields with `fieldValue(blok, name, locale)` / `dataOf(blok, locale)`**
  from `folio/core`. Never `blok.data[name]`: translations live in `i18n`, a
  sibling of `data`, and a direct read silently returns the source locale.
- **`folio/core` is the contract** for defining blocks and rendering resolved
  pages. `folio/engine` is bulk-import and migration tooling — its `apply()`
  outside a transaction bypasses sync, undo and multiplayer, so it must never
  run against content someone might have open.
- **A block's `render` is a pure function of its own fields.** It receives
  `PropsOf<fields> & { uid: string }` and nothing else.
- **Pin a full SHA.** A short SHA or a branch will resolve differently later.

## Do not

- **Do not render published pages in the Worker entry** when you have a router.
  It works, and it silently bypasses your framework's layout, meta and error
  boundaries. The demo in `examples/demo` does exactly this because it is a bare
  Worker with nowhere to hand off to — that part of it is not a template.
- **Do not install by directory path or symlink.** It resolves `vite` from
  Folio's own tree and TypeScript then sees two incompatible `Plugin` types. Use
  a git SHA, or `npm pack` a tarball.
- **Do not override `optimizeDeps` without re-including `react-dom/server.edge`.**
  See the table below.
- **Do not write `published_doc` or a story's `doc` row directly.** Writes go
  through the mutation log or they break sync, undo, presence and the activity
  trail — visibly only to whoever had the page open.
- **Do not add a `{base}/api/v1/*` route of your own.** A version segment is a
  promise to somebody's script; unversioned `{base}/api/*` is internal to the
  admin and changes shape freely.

## When something breaks

| What you see | What it is |
| --- | --- |
| `ReferenceError: require is not defined` at Worker startup, from a stack naming nothing you wrote | `react-dom/server.edge` is CommonJS and was left external. `folio/vite` force-includes it in `optimizeDeps`; a host that replaced that config dropped it. |
| Admin renders unstyled; its stylesheet 404s behind a 200 | `build.cssCodeSplit: false` reached the build without being set in your own `vite.config.ts` — usually a framework plugin set it. The plugin cannot see that and throws at `configResolved` naming the cause. Set it in your own config. |
| The editor's preview iframe renders your blocks unstyled, and the live page is fine | Fixed in the plugin: with code splitting on, Rollup hoists CSS shared between the preview entry and your own pages into a content-hashed chunk that `previewCss` could not name, and `folio-preview.css` held only Folio's editing chrome. The plugin now `@import`s the hoisted files from it. If you still see this, your `folio` is older than that fix. |
| A referenced document's asset field is empty | A block's `render` gets no `Resolution`, so it cannot resolve an asset belonging to a *referenced* document. Only the `url` arm works today. Known limitation. |
| Typecheck reports two incompatible `Plugin` types | Folio installed by directory path. Use a SHA or a tarball. |
| A path Folio should own returns your 404 | Your router ran before `folio.handle()`. |
| With `sites`: `folio.reader` throws "a read must say which site it is for" | Pass `req`, or `{ site }`. `reader(env)` is only valid on a single-site deployment. |
| With `sites`: a page that renders on the live host is a 404 on its preview origin, or two sites serve each other's page | The site is `draft`, or the loopback passes no `cacheProps`. The first is the status gate; the second is a shared cache entry. |
| With `sites`: `alpha.example/folio` is your 404 | Live hosts answer only assets and forms. Redirect the admin path to `sites.admin` (step 5). |
| A page taken down reads as 404 instead of 410 | You did not call `reader.miss()` (or `folio.status()`). It exists to tell "unpublished on purpose" from "never existed". |
| Pages are fast for you and slow for everyone else | Your D1 primary is far from your readers. Turn on read replication for the database (**Settings → Enable Read Replication**) and make sure every page read goes through `folio.reader(env, req)`. Folio issues every query on a session; without replication enabled they all still go to the primary. |
| Login appears to do nothing | The `users` table is empty. The login route answers 200 identically whether or not an address is known, so it cannot enumerate accounts — an unknown email looks exactly like a successful one. |
| Editor loads but shows no other cursors and the tree never updates | The optional `space` binding is absent. Nothing else depends on it. |
| After bumping the pinned SHA, imports fail or `dist/` is missing from `node_modules/folio` | npm skipped the package's `prepare` build because a `node_modules/folio` directory was already there. `rm -rf node_modules/folio` and install again. A clean install has never had this problem, which is why it survives so long unnoticed. |

## Limitations worth knowing before you design around them

- **A block's `render` receives no `Resolution`** (above). If a block must show
  data from a document it references, that data has to arrive through the
  reference's own resolved `content`.
- **Draft mode is opt-in, and forgetting the branch fails quietly.** Set
  `draftMode: true` *and* render pages through `reader.page()`. Setting the key
  without the branch sends reviewers to a published page that looks correct and
  is stale, which is the one way to hold this wrong. Answer with `page.headers`
  and never assemble your own: `folio.noStore()` and `folio.cacheHeaders()` look
  interchangeable and the wrong one puts unpublished content at the edge under
  the page's real URL.
- **Caching goes on one entrypoint, never on the Worker.** Workers Caching is
  opt-out and stores an untagged `200` for two hours, so enabling it Worker-wide
  puts the admin's cookie-authenticated JSON in a shared cache. Disable it on the
  default entrypoint, enable it on one cached entrypoint, and gate what reaches
  that with `folio.cacheVerdict(req)`. Use Workers Caching and not the Cache API:
  they are separate stores and `cache.purge()` — what a publish calls — only
  reaches the former.
- **Many sites in one deployment is opt-in and one-way.** Without `sites` a deployment
  is one site, as it always was. With it, see "A multi-site host" above; there is no
  turning it off again once a second site exists.
- **No host-defined custom field types.** The field set is what `folio/core`
  exports.

## Where to look next

- `docs/configuration.md` — every `createFolio()` key, every binding, every
  Vite option, each with its default and its failure mode. Start here for
  "what does this setting do".
- `docs/handbook.md` — every feature, with worked examples and the reasoning.
- `UPGRADING.md` — bumping the pinned SHA, and which D1 migrations need more
  than applying.
- `docs/api.md` — the `{base}/api/v1` contract.
- `docs/mcp.md` — pointing an assistant at a running site.
- `examples/starter` — the smallest correct host, and what `folio init`
  scaffolds. **This is the template**; it renders its page through a function
  the comments name as the one a router would call.
- `examples/demo` — a working host with nearly every feature switched on. Read
  it for block definitions and config; see the "Do not" note above about its
  page rendering.
