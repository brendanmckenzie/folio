# Feature: Many brands in one deployment

> **Group:** foundation
> **Build order:** 34, per docs/specs/README.md — after 23, and its first phase before the `v1.0.0` tag
> **Size:** L
> **Status:** review — built on the branch `multi-brand` (phases 1 to 8); release and staging verification pending, so not `done`
> **Wire version:** none
> **Migration:** `0013_site_brands.sql` (one nullable column on `sites`)
> **Last updated:** 2026-09-30

## Summary

Spec 23 put many sites in one deployment on the assumption that they share one
design: one block registry, one set of document types, one preview shell, and
variation as a per-site settings document (`multi-site.md` decision 7). That
assumption is right for a portfolio of fifty sites that differ by theme tokens, and
wrong for two brands that share nothing but an agency: allaboutafrica and takeoffgo
collide on the block names `pageRoot` and `prose` and the type name `page` with
incompatible fields, and takeoffgo's blocks module imports a global CSS reset that
would restyle every allaboutafrica preview. This spec adds the **brand**: a named
registry — blocks, types, globals, preview shell, forms, describe, content
migrations — that a site belongs to. One Worker, one D1, one R2, one admin origin
and one sign-in serve both brands; everything that makes a brand look and behave
like itself is looked up through the brand of the scope a request is for.

**It supersedes spec 23 decision 7 for any deployment that configures `brands`.**
Decision 7 stays true inside one brand, and for every deployment that configures no
`brands`, which behaves exactly as it does today.

Today the gap is structural, not missing polish. `createRuntime` builds exactly one
registry at construction (`src/server/runtime.ts:598-609`), the Vite plugin
generates exactly one preview entry (`src/vite/index.ts:261-265`), and the admin
fetches one manifest at the bare API base because it "answers the same under any
scope" (`src/admin/ui/Admin.tsx:174-176`).

The forcing case is an owner test deployment: a new brand-neutral host repository
whose one Worker serves both brands' sites from a fresh D1, R2 bucket and Durable
Object namespace, with both sites' published content loaded by a scripted import.
The build and rollout are `docs/multi-brand-plan.md`.

## Ground truth

Verified against the tree at `6b4fc19` and the consumer working trees on
2026-09-30. `A` is `/Users/brendan/work/takeoffgo/allaboutafrica-website-multisite`
(branch `folio-multi-site`, the one running multi-site on staging), `B` is
`/Users/brendan/work/takeoffgo/takeoffgo-website` (`main`).

**core (`src/core/`):**

- A block registry is `Record<string, AnyBlockDef>` (`src/core/block.ts:73`).
  `toRegistry` returns the object form untouched, trusting its keys
  (`block.ts:77`), and keys the array form with `Object.fromEntries` over
  `b.name`, so **a repeated block name is silently last-wins** (`block.ts:78`). No
  test feeds it a duplicate.
- **A repeated document type name throws** — `folio: duplicate document type
  '<name>'` (`src/core/schema.ts:312`), pinned by
  `test/unit/core/document-types.test.ts:250-254`. Type names must match
  `TYPE_NAME = /^[A-Za-z0-9_-]+$/` (`schema.ts:294`, refused at `:309`), and a type
  naming a root block that is not in the registry throws (`schema.ts:318`).
- `toManifest` lists **every** block in the registry
  (`blocks: Object.values(toSchemaIndex(registry))`) and answers
  `root: defaultType(types).root` (`src/core/block.ts:118-119`). `Manifest` is
  declared at `src/core/schema.ts:120`.
- `DocumentType` has no site, scope or brand field (`src/core/schema.ts:57-105`).
  `canNest` answers false for a top-level placement of any type with `under`
  (`schema.ts:206-209`), so a brand's home page needs a type with no `under`.
- A singleton's id is derived from its type name, `sng_<type>`
  (`src/core/schema.ts:172`); on a multi-site deployment a layer is
  `sng_<type>:<scope>` except `default`'s (`src/server/stories.ts:1955`). Two brands
  declaring the same singleton name therefore get distinct rows per scope.
- `SiteRef` is `{ id, name, group, status, hosts, preview }` and `GroupRef`
  `{ id, name }` (`src/core/sites.ts:49-64`); the sites `Registry` is
  `{ sites, groups }` (`sites.ts:67-70`). `SiteContext`, which rides on
  `Resolution.site` (`src/core/resolve.ts:157`), carries `chain` and `layered`
  (`sites.ts:83-93`). None has a brand.
- `chain()` ends every site's and group's chain at `shared`
  (`src/core/sites.ts:114-124`); `SHARED_SCOPE = 'shared'` is reserved and never a
  registry row (`sites.ts:19`). `layerSeed` answers `'bare'` whenever the chain has
  a scope below the layer (`sites.ts:172-174`), so a site layer of a global seeds
  bare because `shared` is below it.
- An unknown scope has an empty chain (`src/core/sites.ts:108-112`, `:123`), and `withScope` answers an empty chain with `404 No site or group` (`src/server/middleware.ts:114-116`). That is the fence this spec reuses.
- The five scoped tag builders — `siteTag`, `scopedGlobalTag`, `scopedTypeTag`,
  `scopedAnyTypeTag`, `pathTag` — are defined at `src/core/cache-tags.ts:80-86`
  and are not in `folio/core`'s export list (`src/core/index.ts:19-31`), which
  exports a type named `Registry` that is the **block** registry
  (`src/core/index.ts:10`).
- Indexed field names are one namespace per `(schema, types)` pair: "Names rather
  than (type, field) pairs" (`src/core/index-projection.ts:76-96`), and
  `content_index` is keyed `(story_id, locale, field)` with no type or block
  column (`migrations/0001_init.sql:353`).
- `PROTOCOL_VERSION = 5` (`src/core/protocol.ts:45`).

**server (`src/server/`):**

- `FolioConfig.blocks` is required and single (`src/server/types.ts:564`);
  `types` (`:587`), `previewCss` (`:648`), `previewWrap` (`:670`), `assets`
  (`:672-678`), `describe` (`:723`), `forms` (`:737`), `globals` (`:746`) and
  `migrations` (`:763`) are single values. `sites?: SitesConfig` (`:808`) is
  `{ admin, settings?, resolve? }` (`:814-834`), and `types.ts` already imports the
  sites registry under the alias `SiteRegistry` (`types.ts:26`).
- `createRuntime` builds the registry, schema index and types once
  (`src/server/runtime.ts:598-609`), validates the gate against them (`:616`), the
  globals against the types (`:632`), and the sites config against the types
  (`validateSites`, `:677`, declared `:542`). `typeOf` (`:662`), the indexed field
  set (`:668`), the preview stylesheet list
  `[...config.previewCss, ...assets.previewCss]` (`:1333`), `previewWrap`
  (`:1347`) and the manifest (`:1359`) are all built from those one values.
- `resolve()` walks the one schema for link, reference and form ids
  (`src/server/runtime.ts:956-958`, `:1018`) and merges global layers with it
  (`:1048`); `seed` reads `schema[t.root]` (`:802-805`); the layered set is
  `sites ? sites.layered : globals` (`:943`), with `sites.layered` built once from
  `globals` plus the settings type (`:688`).
- Registry-derived reads outside `runtime.ts`, counted by grep for `rt.schema`,
  `rt.types`, `rt.registry`, `rt.typeOf`, `rt.manifest`, `rt.globals`,
  `rt.migrations`, `rt.schemaId`, `rt.defaultType`, `rt.indexedFields`, `rt.seed`,
  `rt.projection`, `rt.previewWrap`, `rt.forms`, `rt.describe` and `rt.gate`: 85 reads across 15 files — `app.ts`, `index.tsx`, `pages.tsx`, `mcp/shot.ts`,
  `routes/api/documents.ts`, `routes/api/index.ts`, `routes/assets.ts`,
  `routes/bulk.ts`, `routes/content.ts`, `routes/editor.ts`, `routes/forms.ts`,
  `routes/history.ts`, `routes/mcp.ts`, `routes/migrations.ts` and
  `routes/stories.ts`, plus schema reads through deps objects in `documents.ts`,
  `migrate.ts` and `reindex.ts`.
- The Durable Objects are schema-blind: `StoryDO` "deliberately knows nothing about
  block schemas" (`src/server/story-do.ts:241`), and its only config is the D1
  accessor (`story-do.ts:145-154`). A draft is seeded by the runtime through
  `getOrInit(seedFor(story))` (`src/server/runtime.ts:833-846`).
- The admin's manifest is `GET {base}/api/schema`, unauthenticated
  (`src/server/app.ts:131`), and v1's is `GET {base}/api/v1/schema` at `READ`
  (`src/server/routes/api/index.ts:62`). Both are in `UNSCOPED_API`, which also
  lists `/reindex`, `/migrate`, `/audit`, `/migrations` and `/assets/describe`
  (`src/server/middleware.ts:173-189`). A scope header on an unscoped route is still
  read into `c.var.scope` (`middleware.ts:113-121`).
- `FolioVars` carries `scope` and `site` and nothing about the registry in force
  (`src/server/types.ts:1282-1311`).
- A bound token supplies the scope when the URL names none
  (`src/server/middleware.ts:254-258`); a scoped route with no scope on a
  multi-site deployment answers `400 site_required` (`middleware.ts:130-153`).
- MCP's `INSTRUCTIONS` are three scope-blind sentences
  (`src/server/routes/mcp.ts:87-91`, sent at `:371`). Tool descriptions append
  `rt.types` names and `Object.keys(rt.schema)` (`mcp.ts:294-303`). The sub-request
  scope comes from `c.var.scope`, never from the client (`mcp.ts:210-221`).
- On a multi-site deployment `handle()` answers the `?_folio=` branch only on a
  site's preview origin (`src/server/index.tsx:823`) and passes the admin origin's
  requests to the app with the `~<scope>` segment stripped into the scope header
  (`index.tsx:844-846`). `servesOnSite` lets a live host answer only
  `GET {base}/asset/*` and `{base}/f/:id` (`index.tsx:370-384`).
- `previewPage` takes `rt.page('preview')`'s entries and stylesheets
  (`src/server/pages.tsx:216`), draws **every** configured global above the page
  with `rt.registry` (`pages.tsx:249-253`), writes the bootstrap
  `{ doc, resolution, admin? }` (`pages.tsx:269-275`), and renders
  `wrapPreview(rt.previewWrap, <FolioDoc registry={rt.registry} …/>)`
  (`pages.tsx:303-306`). Folio's own `Shell` sets only `lang` on `<html>` and a
  class on `<body>` (`src/server/Document.tsx:81-111`).
- `folio.render` and `folio.renderGlobal` use `rt.registry`
  (`src/server/index.tsx:1465-1467`, `:1479`), and `folio.registry` is
  `rt.registry` (`index.tsx:1404`; typed `Registry`, `types.ts:1067`).
- `folio.reader(env)` with neither a request nor a site throws on a multi-site
  deployment (`src/server/index.tsx:882`, message `:342-343`), and so do the
  one-shot `folio.status/redirect/miss(env, path)` (`index.tsx:1361-1364`).
  `FolioReader.site()` answers the gated `SiteRef` or null (`types.ts:503`), and
  `FolioMiss` is `{ kind: 'redirect', to, status } | { kind: 'gone' } |
  { kind: 'not-found' }` (`types.ts:150-159`).
- v1 `GET ~<site>/api/v1/pages/{path}` answers a bare `not_found` for anything that
  is not a page (`src/server/routes/api/pages.ts:81`) and mounts nothing without
  `sites` (`pages.ts:47`); `GET /documents/by-path` answers `not_found` for no row
  (`routes/api/documents.ts:365`) and for a row with nothing published (`:389`).
  The envelope is `{ error: { code, message } }` (`src/server/errors.ts:65-71`).
- `test/workers/api-partition.test.ts` lists `/folio/api/redirects` as internal
  (`:50`) and requires every internal name outside
  `V1_SEGMENTS = ['schema', 'documents', 'assets', 'search']` to 404 under
  `/api/v1` (`:102-112`).
- Nothing exports the multi-site types from `folio/server`: its hook type exports
  omit `HookBase`, `SubmittedHookPayload`, `FormChangedHookPayload` and
  `SiteChangedHookPayload` (declared `src/server/hooks.ts:65`, `:222`, `:192`,
  `:240`), and neither `SitesConfig`, `SiteRef`, `GroupRef`, the sites `Registry`,
  `Surface`, `SiteStatus` nor `PurgeIssued` (`src/server/cache-purge.ts:115`) is
  re-exported; the cache-tag exports are `ANY_TYPE_TAG, NO_STORE, SITE_TAG,
  globalTag, storyTag, typeTag` (`src/server/index.tsx:290`).
- `HookBase` carries `site` and `purge` and no brand (`src/server/hooks.ts:65-92`).
- A purge is issued through `cloudflare:workers`' request-scoped `cache`, imported
  at call time (`src/server/cache-purge.ts:93-100`), so it reaches only the
  entrypoint that handled the triggering request.
- `MagicLinkMail` is `{ email, url, expiresAt }` (`src/server/auth/config.ts:25-31`)
  and `send(env, mail)` receives nothing else (`config.ts:90`). The one caller
  builds the URL from the request's own origin with the `next` in the query
  (`src/server/routes/auth.ts:299-310`).
- `forms.ratePerHour` is one number read as
  `rt.forms?.ratePerHour ?? DEFAULT_RATE_PER_HOUR` (`src/server/routes/forms.ts:873`,
  default 10 at `src/server/form-responses.ts:568`), and the count has no site
  predicate (`form-responses.ts:661-671`); `verify` receives `{ req, body, form }`
  (`form-responses.ts:2198-2201`, called `routes/forms.ts:1047`), with `FormMeta`
  `{ id, name, label, version }` (`src/server/forms.ts:100-105`).
- `DescribeInput` has no site (`src/server/types.ts:317-341`).
- Content migrations are one list per deployment; ids must be non-empty, unique,
  lexicographically in run order, and all carry a numeric prefix of the same width
  (`src/core/migrate.ts:145-178`). `schema_migrations` is keyed by the id alone
  (`migrations/0001_init.sql:323-336`), and `migrate` reports `site: null` because
  "every scope's documents are migrated together" (`src/server/migrate.ts:375-376`).
- `readRegistry` selects `id, kind, name, group_id, status, preview_origin` on a
  `first-primary` session (`src/server/sites.ts:67-72`).
- A story id is `sty_<12 hex>` (`src/core/story.ts:579-580`); v1 create takes no id
  (`src/server/validate.ts:535-545`); an R2 key is `ast_<12 hex>-<filename>`
  (`src/server/assets.ts:632-635`); an asset field value carries the R2 `key`
  (`src/core/values.ts:27-39`).
- Spec 23 leaves **per-site block registries and document types** and **moving a
  site between deployments** out of scope (`docs/specs/foundation/multi-site.md:1782`,
  `:1788`).

**vite and preview (`src/vite/`, `src/preview/`):**

- The plugin's `blocks` option is one module path (`src/vite/index.ts:35`). It adds
  exactly two client inputs, `folio-preview` and `folio-admin`
  (`vite/index.ts:167-173`), pairs each with one stylesheet
  (`ENTRY_STYLESHEETS`, `:26-29`), and bakes one `__FOLIO_ASSETS__` define with
  one `preview` and one `previewCss` (`:208-214`).
- With `cssCodeSplit: false` every stylesheet in the client build — the host's
  included — goes into one `folio-client.css` that both entries link
  (`src/vite/index.ts:15`, `:192-194`, `:212-213`).
- The generated preview entry is `mountPreview(m.blocks, { wrap: m.wrap })` over the
  one blocks module (`src/vite/index.ts:261-265`). `mountPreview` returns early
  without `window.__FOLIO__` and hydrates with `toRegistry(blocks)`
  (`src/preview/mount.tsx:184-206`). Nothing compares the preview bundle's blocks
  with the server's.
- `PreviewWrap` receives only `children` (`src/core/render-wrap.ts:14`). An unknown
  block renders a placeholder in edit mode and nothing otherwise
  (`src/preview/Render.tsx:73-76`).

**admin (`src/admin/`):**

- The scope is read once from the URL (`src/admin/ui/Admin.tsx:133`) and a switch
  is a full page load (`Admin.tsx:443`). The manifest is fetched once at
  `${bare.apiBase}/schema` (`Admin.tsx:176`), and every type list comes from it
  (`Admin.tsx:244-246`): the Content screen's type chips
  (`src/admin/ui/screens/Content.tsx:574`), its create menu (`Content.tsx:1044`)
  and the sidebar's record and global groups (`src/admin/ui/nav.ts:80-93`).
- The switcher is a `<select>` labelled "Site" (`src/admin/ui/Sidebar.tsx:70-89`)
  grouped Shared / Groups / Sites (`nav.ts:296-308`). `MeScope` is
  `{ id, name, kind, group, role, chain, status, preview }`
  (`src/server/auth/me-sites.ts:19-32`).
- `document.title` is `<crumb> · Folio`, with no site (`src/admin/ui/route.ts:422-425`).

**tests:**

- `test/workers/single-site-pin.test.ts` pins a single-site render; `scope-partition.test.ts`
  walks every mounted id route against `UNSCOPED_IDS` (`:701`) with
  `DEFERRED_IDS` empty (`:726`).

**consumers:**

- Both configure one `createFolio` with the same shape: A at
  `A/app/folio/config.server.ts:105` (blocks `:106`, types `:116`, assets
  `__FOLIO_ASSETS__` `:132`, `sites` behind a build define `:138`, `route` `:144`,
  `previewWrap` `:154`, forms `:212`, hooks `:226`, describe `:248`, previewCss
  `:251`); B at `B/app/folio/config.server.ts:40` (blocks `:41`, types `:47`, hooks
  `:88`, forms `ratePerHour: 20` and hCaptcha `verify` `:140-142`, describe `:177`,
  migrations `:180`, `draftMode: true` `:193`, previewCss `:215`, previewWrap `:224`,
  auth with `passkeys({ rpName: "Take Off Go CMS" })` `:286`).
- The two register 35 and 10 blocks and collide on exactly the blocks `pageRoot` and
  `prose` and the type `page`; the fields of both blocks differ
  (`pageRoot` at `A/app/folio/blocks/roots.tsx:114` and
  `B/app/folio/blocks/roots.tsx:11`; `prose` at `A/app/folio/blocks/sections.tsx:748`
  and `B/app/folio/blocks/prose.tsx:15`; `page` at `A/app/folio/config.server.ts:118`
  and `B/app/folio/config.server.ts:49`). The set intersection of the two
  registries' `name` values is exactly those two blocks.
- B's blocks module imports its global reset: `import "../../styles/global.scss"`
  (`B/app/folio/blocks/index.ts:28`), which sets `* { margin: 0 }`,
  `box-sizing: border-box` on every element and `body { font-size: 14px;
  font-family: var(--font-body) }` (`B/app/styles/global.scss:1-24`).
- Both embed Folio forms by id: B's `enquiryForm` block imports `form` from
  `folio/core` (`B/app/folio/blocks/enquiryForm.tsx:1`), and A's `formSection` has a
  `form` field (`A/app/folio/blocks/sections.tsx:950-955`).
- B's miss path calls `folio.reader(env).miss(path)` with no request
  (`B/app/folio/page-loader.server.ts:183`) and its sitemap `folio.reader(env)`
  (`B/app/folio/sitemap.server.ts:21`); both throw on a multi-site deployment. B's
  `MISS_HEADERS` hand-spells tags (`page-loader.server.ts:159`).
- B's content migration id is `0001-fifty-fifty-to-feature`
  (`B/app/folio/migrations/0001-fifty-fifty-to-feature.ts:35`).
- Both React Router apps route `sitemap.xml`, `invoice`, `payment`, `quote/:key` and
  `itinerary/:key`, and both have a legal route of a different shape
  (`A/app/routes.ts:9-20`, `B/app/routes.ts:9-19`); both serve Folio pages from an
  index and a `*` route (`A/app/routes.ts:57-58`, `B/app/routes.ts:27-28`). Both
  `public/` directories hold a `_headers` file.
- Both Workers export a gateway and a `CachedPages` entrypoint, the only one with
  caching on (`B/workers/app.ts:113`, `:222`; `A/workers/app.ts:223`, `:322`), and A's
  gateway passes `folio.cacheProps` into the loopback (`A/workers/app.ts:356`).

## Owner decision checkpoints

All settled by the owner on 2026-09-30 and written below as decisions.

1. **One Worker for both brands** — decision 2. Federation is the rejected
   alternative.
2. **Per-brand registries inside one runtime** — decisions 1, 3 and 6. No renames.
3. **The admin, sign-in and passkeys live on a brand-neutral company domain** —
   decision 17. Folio never names it.
4. **A new brand-neutral host repository, one merged route tree** — decision 18.
5. **Content reaches the test deployment by a one-off scripted import with fresh
   ids**, living in the host repository — decision 22.

## User stories

### An author edits one brand without seeing the other
**As** an editor with roles on both brands' sites **I want to** switch from an
allaboutafrica site to the takeoffgo site and see, in the "New" menu, the sidebar,
the pickers and the preview, only that brand's types, blocks and look **so that** I
cannot create an allaboutafrica `guide` inside takeoffgo or preview a takeoffgo page
in allaboutafrica's fonts.

### A developer adds a block to one brand
**As** a developer of the host **I want to** add a block under
`brands/takeoffgo/` and have it appear in takeoffgo's registry, takeoffgo's preview
bundle and takeoffgo's MCP descriptions, and nowhere else, **so that** a block
change cannot reach the other brand's editor or public pages.

### Two brands keep their own names
**As** a developer **I want** both brands to keep a block called `pageRoot` and a
type called `page` **so that** code, stored JSON and documentation keep saying the
same thing.

### An AI agent knows which brand it is editing
**As** an AI coding agent working in the host repository or through MCP **I want**
the repository, my token and the MCP server to name the site and brand I am working
on **so that** I cannot write takeoffgo content while believing it is
allaboutafrica's.

### A headless front end handles a miss
**As** a front end reading pages over v1 **I want** a 404 to tell me whether the
path redirects, is gone, or never existed, **so that** I can answer 301, 410 or 404
without a second request.

### A single-site or single-brand host changes nothing
**As** an existing host **I want** to upgrade without touching my config.

## Architecture decisions

### 1. A brand is a registry, and every site belongs to exactly one brand

A **brand** is the unit of design: a block registry, the document types over it,
the globals and settings type, the preview shell (bundle, stylesheets, wrap), the
visitor gate, the forms policy, the describer and the content migrations. A site or
group belongs to one brand, recorded on its registry row (decision 4). Every
question that a registry answers — which blocks exist, what a type's root is, what
the preview looks like, what an MCP tool description lists — is asked of the brand
of the scope the request is for (decision 6).

This **supersedes `multi-site.md` decision 7 on a deployment with `brands`**. That
decision's reason — "a shared page renders on every site in its chain, so every
site must render every block it holds" — still holds, and decision 5 keeps it true
by construction: a chain never leaves a brand, so every page a site can render was
written against that site's own registry.

**Beat a union registry with renames** (design-options H1a + H2a): takeoffgo's
`pageRoot`, `prose` and `page` become `tgPageRoot`, `tgProse`, `tgPage`, a content
transform rewrites every stored `Blok.type`, and one preview bundle holds both
brands' components. It leaves one registry with both brands' blocks in every "New"
menu until a per-type visibility list is built, and it still puts takeoffgo's global
reset in allaboutafrica's preview bundle. **Beat a namespacing helper**
(`namespaced('tg', …)`, H2b): stored JSON says `tg-pageRoot` while the code says
`pageRoot`, so a grep for a stored name finds nothing, and every future field kind
that references a name has to be taught to rewrite it. **Beat per-site registries**
(one registry per site row): two sites of one brand would carry two copies of one
design, and a group's content would have no registry of its own.

### 2. One Worker serves both brands

The deployment is one Worker: one `createFolio`, one D1, one R2 bucket, one
`StoryDO` and `SpaceDO` namespace, one cached entrypoint, one admin origin. Both
brands' public hosts, both preview origins and the admin origin route to it.

**Beat federated brand runtimes** (design-options S1d: each brand's Worker a full
Folio runtime over a shared D1 and bucket, allaboutafrica's Worker the hub that
forwards takeoffgo's admin requests over a service binding). Federation keeps each
brand's code in its own repo and needs no per-brand registry inside Folio, and it
pays for that with a new Folio mode that forwards HTTP and WebSocket requests between
Workers (a socket upgrade through `Fetcher.fetch` has never been exercised here), an
exact-build lockstep between two deploys (`federation_mismatch` whenever one lands
before the other), two Durable Object namespaces and two cached entrypoints, and
takeoffgo's editing depending on allaboutafrica's Worker being up. All of that is
permanent semver surface for a mode no other deployment needs. **Beat
allaboutafrica as the CMS with takeoffgo headless** (S1b) and **a neutral CMS with
both headless** (S1c): every visual of the headless brand moves into the CMS
build, its public pages go down with the CMS Worker, and every publish needs a
cross-Worker purge nobody has observed. **The cost accepted:** one deploy carries
both brands' code, including both brands' payment pages, and the host's route tree
is merged (decision 18).

### 3. `createFolio({ brands })`: what moves into a brand, and what stays

```ts
// src/server/types.ts
export interface FolioBrand<Env> {
  /** Shown to people and to models: the switcher, the tab title, the sign-in
   * mail, MCP's instructions. */
  label: string
  blocks: readonly AnyBlockDef[] | Registry
  root?: string
  types?: readonly DocumentType[]
  globals?: readonly string[]
  /** This brand's site-settings singleton (`multi-site.md` decision 2). */
  settings?: string
  previewCss?: string[]
  previewWrap?: PreviewWrap
  gate?: FolioGate<Env>
  forms?: FolioForms<Env>
  describe?: FolioDescribe<Env>
  /** Ids carry the brand: `takeoffgo/0001-fifty-fifty-to-feature`. */
  migrations?: readonly Migration[]
}

export type FolioConfig<Env> = FolioSingleConfig<Env> | FolioBrandedConfig<Env>

/** Today's `FolioConfig`, unchanged, with `brands?: never`. */
export interface FolioSingleConfig<Env> { /* … every key as today … */ brands?: never }

export interface FolioBrandedConfig<Env>
  extends Omit<FolioSingleConfig<Env>,
    'blocks' | 'root' | 'types' | 'globals' | 'previewCss' | 'previewWrap'
    | 'gate' | 'forms' | 'describe' | 'migrations' | 'sites' | 'assets' | 'brands'> {
  brands: Readonly<Record<string, FolioBrand<Env>>>
  /** Required: a brand is a property of a site row. `settings` moves into the brand. */
  sites: Omit<SitesConfig, 'settings'>
  assets?: {
    admin: string
    devClient?: string
    adminCss?: string[]
    /** One preview bundle per brand, keyed like `brands` (decision 9). */
    brands: Readonly<Record<string, { preview: string; previewCss?: string[] }>>
  }
  blocks?: never; root?: never; types?: never; globals?: never; previewCss?: never
  previewWrap?: never; gate?: never; forms?: never; describe?: never; migrations?: never
}
```

For the test deployment:

```ts
createFolio<Env>({
  brands: {
    allaboutafrica: { label: 'All About Africa', blocks: aaaBlocks, types: aaaTypes,
      previewCss: aaaPreviewCss, previewWrap: AaaPreviewWrap,
      forms: { verify: verifyTurnstile, ratePerHour: 10 }, describe: aaaDescribe },
    takeoffgo: { label: 'Take Off Go', blocks: tgoBlocks, types: tgoTypes,
      previewCss: tgoPreviewCss, previewWrap: TgoPreviewWrap,
      forms: { verify: verifyHCaptcha, ratePerHour: 20 }, describe: tgoDescribe,
      migrations: [fiftyFiftyToFeature /* id 'takeoffgo/0001-fifty-fifty-to-feature' */] },
  },
  sites: { admin: FOLIO_ADMIN_ORIGIN },
  assets: __FOLIO_ASSETS__,
  auth: [magicLink({ send: sendSignIn }), passkeys({ rpName })],
  hooks, route, bindings, basePath: '/folio', draftMode: true,
})
```

**The rule for what moves:** a key moves into a brand exactly when it is validated
against the block registry or the types, or rendered with them — `blocks`, `root`,
`types`, `globals`, `settings`, `previewCss`, `previewWrap`, `assets.preview`,
`gate` (its field is checked against root blocks, `runtime.ts:616`) and
`migrations` (they walk block types) — **or** it is a per-brand policy the owner
named: `forms` (captcha provider and rate) and `describe`. Everything about people,
requests and the deployment stays at the top: `bindings`, `auth`, `basePath`,
`route`, `locales`, `adminCss`, `assets.admin`, `hooks`, `logger`, `mcp`,
`draftMode`, `sites.admin` and `sites.resolve`.

`hooks` stays deployment-wide because the runner, `await` and every purge are
deployment-level; a hook tells brands apart by the payload's new `brand`
(decision 16). `locales` stays deployment-wide because neither brand declares any
and a locale is a property of URLs, which the one `route` owns.

**Construction refusals** (each a throw naming the key): `brands` without `sites`;
`brands` empty; a brand id not matching the site id rule
`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`; any moved key at the top level beside
`brands`; `sites.settings` beside `brands`; `assets` whose `brands` keys differ from
`brands`' keys, or an `assets.preview` at the top; a brand migration id that does
not start with `<brand>/`; and every check a single-brand config already gets,
run per brand.

**Beat function-valued keys** (`previewCss: (site) => …`, `forms.ratePerHour:
number | ((site) => number)`, design-options H8b): every key becomes a function of a
site, the registry stays single, and the collisions stay unsolved. **Beat reading
brand policy from the settings document** (H8c): captcha, rate limits and senders
are security configuration, and a settings document is content an editor publishes.

### 4. `sites.brand` records the brand; `0013` adds it

`0013_site_brands.sql` adds a nullable `sites.brand` column. `SiteRef` and `GroupRef`
gain `brand: string | null`, read by the registry snapshot beside the other columns.

- **With no `brands`**, every row's brand is null and nothing reads it.
- **With `brands`**, a row's brand must be one of the configured ids. The registry
  snapshot **leaves out** a site or group whose brand is null or not configured, so it
  is no candidate, has an empty chain and answers `404 No site or group` at every
  `~<scope>` — the same fence as an unknown scope. `GET {base}/api/sites`, which a
  platform admin uses to repair it, reads rows directly and lists it with
  `brand: null`.
- **Written through the registry routes.** `POST {base}/api/sites` requires `brand`
  on a branded deployment; a site's group must have the same brand; `PATCH` may
  change `brand` only while the scope holds no content, using the same content list
  that refuses a delete (`multi-site.md` decision 1: `stories`, `assets`,
  `asset_folders`, `asset_tags`, `forms`, `redirects`), and never on a group that has
  sites.
- **`0011` inserted the `default` row with no brand.** A deployment that turns
  `brands` on sets it by SQL immediately after applying `0013` and before the deploy
  (`UPGRADING.md`), exactly as spec 23's plan wrote the `default` hosts.

**Beat mapping site ids to brands in config** (`brands.takeoffgo.sites:
['takeoffgo']`): sites are rows a platform admin creates from the admin without a
deploy (`multi-site.md` decision 1), and a second site of a brand would need one.
**Beat deriving the brand from a hostname pattern**: a preview origin, a
`workers.dev` host and the admin origin all break the pattern, and the admin origin
belongs to no brand. **Beat a default brand for a null row**: a reordered `brands`
object would silently rebrand every unmarked site.

### 5. A chain never crosses a brand; a branded deployment has no `shared` scope

On a deployment with `brands`, `chain()` omits `shared`: a site's chain is itself
and its group, a group's is itself, and `chain(registry, 'shared')` is empty, so
`~shared` is a 404 and nothing can be written there. `sitesUnder('shared')` is
empty. The sites `Registry` gains `shared: boolean`, true on every unbranded
registry, and `chain`, `sitesUnder` and `layerSeed` read it. Because a group and its
sites have one brand (decision 4), **every chain lies inside one brand**, and so
every row a request can reach — through a reference, a collection, a search, a
form, an asset picker, a fork, a global layer — was written against the same
registry that renders it.

Two consequences, both intended:

- **Global layers seed correctly.** `layerSeed` answers `'full'` for the bottom of
  a chain, which on a branded deployment is the group, or a site with no group, so a
  brand's declared defaults are what its sites start from. With `shared` left in the
  chain and closed, every site layer would seed bare over a layer that can never
  exist.
- **Tags follow.** A render emits layer and type tags for its chain's scopes only
  (`multi-site.md` decision 15), so no `global:<name>` tag for a `shared` layer is
  emitted or purged.

`default` stays an ordinary site (it is allaboutafrica's on the test deployment).

**Beat rendering `shared` content with the rendering site's brand** (design-options
default 18 as written for federation): a shared page renders in a brand that may
lack its blocks — decision 7's original reason, reintroduced — and the admin has no
registry to edit `~shared` with. **Beat a configured "shared brand"**: it names one
brand as everybody's base, which is the portfolio case, not this one; a deployment
that wants it configures no `brands`.

### 6. Every registry read goes through the scope's brand, and the compiler finds them

`createRuntime` builds one **`BrandRuntime`** per brand (one for a single-brand
deployment, whose `brand` is null): `registry`, `schema`, `types`, `typeOf`,
`defaultType`, `manifest`, `globals`, `layered`, `settings`, `migrations`,
`schemaId`, `indexedFields`, `gate`, `forms`, `describe`, `previewWrap`,
`page('preview')`, `seed`, `seedFor`, `titleFor`, `titlesFor`, `projection` and the
brand-bound `resolve`, `query` and `publishDeps`. `FolioRuntime` gains:

```ts
brands: ReadonlyMap<string | null, BrandRuntime>
/** The brand of a scope or site, by the registry snapshot the caller already holds.
 * Single-brand: always the one. Branded: null for a scope with no brand, which
 * decision 4 has already fenced off. */
forScope: (registry: SiteRegistry, scope: string | null) => BrandRuntime | null
```

**On a request, it is looked up once.** `withScope`, which already reads the
registry (`middleware.ts:115`), sets `c.var.brand` from `c.var.scope ??
c.var.site?.id`. A route reads `c.var.brand.schema`, never `rt.schema`. A scoped
route with no brand on a branded deployment is already `400 site_required`; an
unscoped route that needs a brand says so itself (decision 12).

**Off a request**, each entry point finds the brand from what it holds: the reader
and `handle()`'s `?_folio=` branch from the gated site; `folio.render` and
`renderGlobal` from `resolution.site.brand` (decision 21); `runSchedules` from each
due story's `site_id`, with deps memoised per brand per run; `migrate`, `reindex` and
`audit` by iterating brands and binding each brand's scopes.

**The old members go.** `rt.registry`, `rt.schema`, `rt.types`, `rt.typeOf`,
`rt.manifest`, `rt.globals`, `rt.migrations`, `rt.schemaId`, `rt.defaultType`,
`rt.indexedFields`, `rt.seed`, `rt.titleFor`, `rt.titlesFor`, `rt.projection`,
`rt.previewWrap`, `rt.gate`, `rt.forms` and `rt.describe` are removed from
`FolioRuntime`, so every one of the 85 reads in Ground truth fails `pnpm typecheck`
until it names a brand. During the build they first become getters that throw on a
branded runtime (plan phase 3), so an unconverted read is a loud 500 in a two-brand
test rather than an answer for the wrong brand; the last phase deletes them.

**Why one request has one brand:** every row a request can reach is in its scope's
chain (the scope fence, `CLAUDE.md` "Every id-set read takes the chain"), and a chain
lies inside one brand (decision 5). So a story loaded by id under `~takeoffgo` is a
takeoffgo story, and reading its type from `c.var.brand` is correct without looking
up the story's own site.

**Beat a default brand behind `rt.schema`** (keep the members, answer the first
brand): it compiles, passes every single-brand test, and answers a takeoffgo request
with allaboutafrica's schema wherever a reader was missed. **Beat threading a
`brand` argument through each function without a request variable**: the same
lookup repeated at eighty-five call sites, each one a place to pass the wrong one.

### 7. No renames; a duplicate name inside one registry throws

`pageRoot`, `prose` and `page` exist in both brands under their own names. Nothing in
D1 conflates them: `stories.type` indexes lead with `site_id`
(`0011_sites.sql:50`), `content_index` is keyed by story (`0001_init.sql:353`),
singleton rows are per scope, and block names live only inside documents, which
are rendered by their own brand's registry.

Inside one registry a repeat is now a construction error:

- `toRegistry` throws `folio: duplicate block '<name>'` when the array form repeats
  a name;
- for the object form it throws `folio: registry key '<key>' names block
  '<def.name>'` when a key and its block's `name` disagree.

**This lands before the `v1.0.0` tag** (`docs/1.0-plan.md` phase 6): it narrows
what `toRegistry` and `createFolio` accept, which is free now and a `2.0.0` after the
tag. Neither consumer repeats a name (their registries are 35 and 10 distinct
names), so neither is newly refused. **Beat leaving it last-wins**: merging two block
lists is exactly the act this spec invites, and last-wins turns a collision into a
page that renders the wrong block with no error anywhere.

### 8. Indexed fields, singletons and search are per brand without new machinery

`indexedFieldNames` runs per brand over that brand's schema and types, so a `where`
on `~takeoffgo` is checked against takeoffgo's indexed names only; `content_index`
rows are keyed by story and a query binds the chain, so a field name both brands
index is two disjoint row sets. Search joins through `stories` and binds the chain.
Globals and the settings type are per brand (`FolioBrand.globals`,
`FolioBrand.settings`), and `layered` is per brand, so `Resolution.site.layered`
and the layer tags a render emits are the brand's own.

### 9. One preview bundle per brand, from the Vite plugin

The plugin's `blocks` option widens to a record:

```ts
folio({ blocks: { allaboutafrica: './app/brands/allaboutafrica/folio/blocks.ts',
                  takeoffgo: './app/brands/takeoffgo/folio/blocks.ts' } })
```

For each key it generates a virtual entry `virtual:folio/preview/<brand>` that calls
`mountPreview` over that module, emits `folio-preview-<brand>.js` and
`folio-preview-<brand>.css`, runs `importHoistedCss` per entry, and bakes
`__FOLIO_ASSETS__` as `{ admin, devClient, adminCss, brands: { <brand>: { preview,
previewCss } } }`. A string keeps today's one entry and today's define, byte for
byte. **A record with `cssCodeSplit: false` fails the build**: one stylesheet would
carry both brands' CSS into both previews, which is the leak this decision exists to
prevent. Building both keys into one Vite client build keeps one `vite build` and
one set of fixed names.

`rt.forScope(…).page('preview')` answers that brand's entry and
`[...brand.previewCss, ...assets.brands[brand].previewCss]`. The admin bundle is
unchanged: it is schema-driven and ships prebuilt.

**Beat one bundle holding both brands' blocks** (H1a): takeoffgo's `global.scss`
rides every allaboutafrica preview, and a global-CSS mistake in one brand reaches the
other's editor. **Beat delegating the preview to each front end** (H1c, a v1 preview
read plus a `PreviewDocument` export): it exists for headless front ends, and this
deployment renders its own pages.

### 10. The preview shell is the brand's: stylesheets, wrap, globals and a scope attribute

`previewPage` renders with the brand's registry, stylesheets and `previewWrap`, and
draws only the brand's globals. On a branded deployment Folio's `Shell` writes
`<html data-folio-brand="<id>">` on every preview and draft page, so a host scopes a
brand's global stylesheet under `[data-folio-brand="<id>"]` and the same selector
holds on Folio's shell and on the host's own layout, which sets the same attribute
(decision 18). With per-brand bundles the attribute is a second fence, not the
first: it is what keeps a brand's reset off the other brand's pages in the host's
merged public build, where both brands' route modules ship from one client build.

**Beat passing the site to `PreviewWrap`** (`props: { children, site? }`): the wrap
would branch on brand inside one bundle, which is H1a's problem moved into a
component.

### 11. The bootstrap carries a digest of the server's blocks; a mismatch is a banner

`previewPage`'s bootstrap gains `blocks: string`, a stable digest of the brand's
schema (each block name with its field names and kinds, sorted). `mountPreview`
computes the same digest from the registry it was handed; on a mismatch in edit
mode it draws an in-page notice above the page — "This preview's blocks differ from
the server's: missing *X*, extra *Y*. Rebuild the preview bundle from the same blocks
module." — naming the differing names, and renders on. It is a separate pure module
(`src/core/registry-digest.ts`) so the server and the bundle cannot compute it two
ways. It catches the one mistake per-brand bundles make likely: a plugin key pointing
at the wrong brand's module.

**No `PROTOCOL_VERSION` bump.** The bootstrap is a server-rendered value read by
the page it is written into, not a frame; nothing crosses the admin↔preview bridge.
**Beat a new bridge frame carrying the digest to the admin**: a version bump and a
round trip for a check the page can make itself. **Beat refusing to hydrate on a
mismatch**: a preview with one stale block is still useful, and a blank one is not.

### 12. Visibility falls out of the brand: the manifest is fetched per scope

The admin fetches its manifest from the **scoped** API base once a scope is chosen
(`Admin.tsx:176`). `GET {base}/api/schema` and `GET {base}/api/v1/schema` stay in
`UNSCOPED_API` — a scope is optional there, not required — and answer:

| Route | Single-brand | Branded, scoped | Branded, no scope |
| --- | --- | --- | --- |
| `{base}/api/schema` | the manifest, as today | the scope's brand's manifest, with `brand: { id, label }` | the **neutral manifest**: no types, blocks or globals; `locales` and `hooks` as today |
| `{base}/api/v1/schema` | as today, plus `scope` when scoped on multi-site | the brand's manifest plus `scope: { id, name, kind, brand: { id, label } }` | `400 site_required`, naming the `~<site>` form |

The neutral manifest is what the bare shell needs before it redirects to the
caller's first scope. v1 refuses rather than answering neutral because a script or
agent that asked without a scope has to be told which brand it meant.

Every type list in the admin — chips, "New" menus, sidebar groups, pickers,
Settings — therefore shows the brand's types only, with no admin code that knows
what a brand is. Server create and move already take `types` from the brand
(decision 6), so an allaboutafrica type named in a takeoffgo create is
`Unknown document type`.

**Beat a per-type allowlist, `DocumentType.sites`** (H3a): it is the right tool the
first time one brand's sites have different type sets, and until then it is a
second partition beside the brand. It stays unbuilt. **Beat grouping the nav by
brand** (H3b): presentational only, and the create menu and MCP still offer the
other brand's types.

### 13. A v1 miss rides the 404 envelope; `reader.miss()` answers its headers

`GET ~<site>/api/v1/pages/{path}` and `GET ~<site>/api/v1/documents/by-path/{path}`
answer a miss as `404 { error: { code: 'not_found', message, miss: FolioMiss } }`,
computed by the reader the route already holds (`reader.miss(path)`, one batch). A
client that treats any 404 as a miss is unchanged. `ErrorEnvelope`'s `error` gains
an optional `miss`.

`FolioReader.miss()` answers each arm with `headers`: `Cache-Control` from
`cacheHeaders`' policy and a `Cache-Tag` that a later publish at the path purges —
`path:<site>:<path>` and `site:<site>` on multi-site, `site` and `type:*` on a
single-site deployment (the tags a single-site publish purges). A host answers a
cached 404, 410 or redirect with them and never spells a tag, which retires B's
`MISS_HEADERS` and its `pathPrefixes` purge hooks.

**Beat a v1 `redirects/{path}` segment** (H4b): `api-partition.test.ts` requires
`redirects` to 404 under `/api/v1`, it is a second request per miss, and it cannot
say "gone". **Beat answering `200 { kind: 'page' | 'redirect' | 'gone' }`** (H4c):
it changes an existing v1 success shape, which is a major bump.

### 14. The multi-site surface is exported, and the sites registry is `SiteRegistry`

- `folio/core` gains `siteTag`, `scopedGlobalTag`, `scopedTypeTag`,
  `scopedAnyTypeTag` and `pathTag`.
- `folio/server` gains the types `SitesConfig`, `SiteRef`, `GroupRef`, `Surface`,
  `SiteStatus`, `SiteContext`, the sites registry **as `SiteRegistry`**,
  `PurgeIssued`, `HookBase`, `SiteChangedHookPayload`, `SubmittedHookPayload`,
  `FormChangedHookPayload`, and this spec's `FolioBrand`, `BrandRef`,
  `FolioSingleConfig` and `FolioBrandedConfig`.

`SiteRegistry` is the alias `types.ts:26` already uses, so the export never shadows
`folio/core`'s block `Registry`. **Beat a new subpath `folio/sites`**: a seventh
subpath for names that belong with the modules they describe.

### 15. Purges stay in one Worker, and the entrypoint invariant still applies

One Worker means one cached entrypoint. Every write the admin makes arrives at the
host's gateway, which already routes every mutating request through `CachedPages`
(the `CLAUDE.md` rule "a purge is scoped to the entrypoint that issued it"), so
Folio's own purge runs where both brands' pages are cached. The tags are already
scoped by site, so a takeoffgo publish never purges an allaboutafrica page, and
`folio.cacheProps` already separates the two brands' entries because their sites
differ. **The invariant is unchanged and the host must still honour it**: route
writes, the cron and the form submit through `CachedPages`.

**Beat an RPC purge into another Worker** (H7b): it is the unobserved path on every
publish, and a missing forward is silent for a week.

### 16. Per-brand policy, and what a hook or a mail is told

- **Forms**: `verify` and `ratePerHour` are the brand's; a submission on a site's
  live host uses the site's brand. The rate count stays per (visitor, form) through
  the form-salted hash (`form-responses.ts:661-671`).
- **Describe**: the brand's `fn`, `onUpload` and `concurrency`; the tag vocabulary is
  already per scope.
- **Content migrations**: ids carry the brand (`takeoffgo/0001-fifty-fifty-to-feature`),
  refused at construction otherwise, because `schema_migrations` is one table keyed by
  id. `migrate` runs each brand's list over that brand's scopes only; a document's
  progress stays `stories.schema_id`. The `migrated` and `reindexed` payloads carry
  `brand`.
- **`runSchedules`, `reindex`, `audit`** act per brand as decision 6 says; `sweepAuth`
  is deployment-wide, as auth is.
- **`HookBase` gains `brand: string | null`**: the brand of the payload's `site`, null
  on a single-brand deployment and for a deployment-wide event. `hooks.submitted`
  branches on it (allaboutafrica's enquiry email, takeoffgo's Jambo forward).
- **`MagicLinkMail` gains `scope?: { id: string; name: string; brand: BrandRef | null }`**,
  parsed from the sign-in's `next` when it names a `~<scope>` in the registry, so the
  mail can say "Sign in to Take Off Go" while being sent from the admin origin's
  domain. Absent with no scope in `next`.

**`DescribeInput` and the `verify` input do not gain a `site`**: the brand is implicit
in which brand's function runs, and `verify` already receives the `Request`, whose
host names the site. **Beat per-brand `auth`**: passkeys bind to the admin origin
(`multi-site.md` decision 12), so there is one relying party and one sign-in whatever
the brand.

### 17. The admin origin is brand-neutral and configured only in the host

`sites.admin` is a host on a brand-neutral company domain in the same Cloudflare
account, configured in the host repository. Folio's documents call it "the admin
origin" and never name it. The sign-in sender is an address on that domain, and
`MagicLinkMail.scope` lets the host word the mail per brand. Passkeys (`rpId`) and
sessions bind to it, so it is chosen once: moving it later invalidates every passkey
(`UPGRADING.md`).

**Beat allaboutafrica's admin host**: takeoffgo editors would sign in on, and receive
mail from, another brand. **Beat a takeoffgo admin host**: the same, the other way
round.

### 18. The host's merged route tree is made safe by structure, not by care

One React Router app serves both brands. This is host code, and it is Folio's to
specify because `AGENTS.md` is where a host learns the pattern. The rules:

1. **One brand resolver.** `brandOf(request, env)` in `app/brand.server.ts` answers
   `(await folio.reader(env, request).site())?.brand ?? null`. Nothing else reads a
   hostname to decide a brand. The root loader calls it once and puts it on the
   loader context.
2. **Brand directories.** `app/brands/<brand>/` holds that brand's Folio blocks and
   `FolioBrand`, components, styles, route modules and GraphQL documents;
   `app/shared/` holds only code neither brand styles (the Jambo client, the payment-key
   picker, the brand resolver). A lint rule forbids an import from
   `app/brands/<a>/` into `app/brands/<b>/`.
3. **Colliding paths are dispatch modules.** `/`, `*`, `sitemap.xml`, `robots.txt`,
   `invoice`, `payment`, `quote/:key`, `itinerary/:key` and the legal routes are one
   route module each whose loader and action call the brand's module
   (`brands/<brand>/routes/<name>.ts`) and whose component renders the brand's
   component from the loader data. A path only one brand has (`newsletter`,
   `travel/*`, `guides/__unlisted`) is guarded: another brand's host answers 404.
4. **Per-brand root layout and CSS scoping.** The root sets
   `<html data-folio-brand="<brand>">` (decision 10) and renders the brand's
   layout. Every brand stylesheet is authored under `[data-folio-brand="<brand>"]`
   (resets included: `[data-folio-brand="takeoffgo"] *`), and a build check fails
   on any rule in a brand's compiled CSS outside that scope except `@font-face` and
   `@keyframes`. So takeoffgo's reset cannot reach an allaboutafrica page, whether
   the page is the host's or Folio's preview shell.
5. **`public/` holds only brand-neutral files**, because Workers Assets serve it
   before the Worker runs. `robots.txt`, favicons, `agents.txt`, `humans.txt` and each
   brand's `_headers` rules become routes or one merged `_headers`.
6. **One Jambo client.** One codegen config reading its token from the environment,
   one generated client from Jambo's current schema, both brands' query documents,
   and the two `executePayment` call shapes reconciled at their call sites.

**Beat host-dispatched brand apps** (two React Router builds behind one gateway
branch): two client builds, two asset manifests and two `public/` directories that
Workers Assets cannot tell apart, which is the collision moved one level down.
**Beat extracting the Jambo routes into their own Worker first**: orthogonal to
Folio, and it defers the test on the one work item the owner did not ask to defer.

### 19. An agent knows its brand from four independent signals

1. **The repository.** The host's root `CLAUDE.md` holds the brand map (brand id,
   sites, hosts, preview origins, the MCP URL per site), and each
   `app/brands/<brand>/CLAUDE.md` says which brand the directory is and that nothing
   in it may import from another brand's directory.
2. **The credential.** Tokens for scripts and MCP are minted **bound to a site**
   (`api_tokens.site_id`), so a takeoffgo token cannot write allaboutafrica even at an
   unscoped URL.
3. **MCP names it.** On a multi-site deployment, a scoped MCP session's
   `instructions` gain a fourth sentence: "This session is scoped to site '<name>'
   (`<id>`) of brand '<label>'; documents, types and blocks of other brands are not
   visible, and get_schema describes this brand only." Tool descriptions list the
   brand's types and blocks (decision 6).
4. **The schema says it.** v1 `GET /schema` carries `scope` (decision 12), and
   unscoped it is `400 site_required` on a branded deployment.

`bin/folio.mjs agents`' injected note gains one sentence pointing a multi-brand host's
agent at the brand map. **Beat repository documents alone**: nothing stops an unbound
token writing the wrong site.

### 20. An author sees the brand in three places, and the admin is not themed

The switcher's options read `<site name> · <brand label>` and are grouped by brand
instead of Shared / Groups / Sites on a branded deployment; `MeScope` gains
`brand: BrandRef | null`. `document.title` becomes `<crumb> · <site name> · Folio` on
any multi-site deployment. The "New" menus, chips, sidebar and pickers are the
brand's by decision 12. The Sites screen shows and sets each row's brand. The settings type is the
brand's (`FolioBrand.settings`), so on a branded deployment `/me`'s
`sites.settings` is null and the scoped manifest carries `settings`, which is what
the Settings tab reads. **No
further admin theming**: `multi-site.md` leaves per-site theming of the admin out of
scope, and a brand colour in the chrome is a design system nobody has asked for.

### 21. `folio.render`, `renderGlobal` and `registry` take their brand from the resolution

On a branded deployment `folio.render(doc, { resolution })` and
`folio.renderGlobal(resolution, name)` use `resolution.site.brand`'s registry, and
throw without a resolution that names a site. `SiteContext` gains `brand`.
`folio.registry` throws there, naming `folio.registryFor(brand)`, which is new and
answers a brand's block registry. Single-brand behaviour is unchanged.

### 22. A site's content moves by a host script, not by Folio

The test deployment starts from a fresh D1, R2 bucket and Durable Object namespace,
and both brands' content arrives by one script in the host repository: it reads
each source deployment over v1 with a read-only token and writes the new one over
v1 with site-bound tokens, minting fresh ids. It carries every document with a
published version at its published content, every asset those documents use (bytes
re-uploaded, keys re-mapped), and the form definitions they embed; it rewrites
every story, form and asset reference by the id maps and publishes. Drafts, version
history, redirects, form responses and edit logs are not carried. Folio ships none
of it.

**Beat first-class `folio export` / `folio import`** (H5b): four days of permanent CLI
and route surface for a move nobody has asked Folio to support, on a test built
from scratch.

### 23. `PROTOCOL_VERSION` stays at 5

No socket frame and no admin↔preview frame changes. Per-brand preview bundles
change which script a preview page loads, which the server decides per request and
both ends ship in one deploy; an open admin tab talks to the same bridge. The digest
(decision 11) is bootstrap data. A version bump is cheap and would buy nothing here.

## Licence ledger

| Change | Kind |
| --- | --- |
| `toRegistry` duplicate and key-mismatch throws (decision 7) | **Narrowing: free before `v1.0.0`, a `2.0.0` item after.** Lands first. |
| `brands`, `FolioBrand`, `FolioConfig` as a union, `assets.brands` | Additive config (minor): every existing config type-checks against `FolioSingleConfig` |
| Construction refusals under `brands` | None: they only refuse the new key's misuse |
| `0013_site_brands.sql` | **A migration**, additive; code without it never reads the column |
| `SiteRef.brand`, `GroupRef.brand`, `SiteContext.brand`, sites `Registry.shared` | Additive fields (minor); the types become exported here |
| `chain` without `shared`, `~shared` 404, v1 unscoped schema `400` | Behaviour under the new key only |
| `rt.*` members removed, `BrandRuntime`, `c.var.brand` | Internal: `FolioRuntime` is not exported |
| Scoped `/api/schema` answering the brand, neutral manifest | Internal admin API, free |
| v1 `schema.scope`, v1 404 `miss`, `ErrorEnvelope.error.miss` | Additive v1 fields (minor) |
| `FolioMiss` `headers` | Additive field (minor) |
| Exported builders and types, `folio.registryFor` | Additive exports (minor) |
| `folio.registry`, `render`, `renderGlobal` throwing on a branded deployment | Behaviour under the new key only |
| `HookBase.brand`, `MagicLinkMail.scope` | Additive payload fields (minor) |
| Vite `blocks` record, `folio-preview-<brand>.*`, `cssCodeSplit: false` refused with a record | Additive option (minor); the string form is byte-identical |
| Bootstrap `blocks` digest and banner, `data-folio-brand` on Folio's shell | Internal |
| MCP scoped instruction sentence | Additive prose |
| Socket and preview frames | **No `PROTOCOL_VERSION` bump** (decision 23) |

## Wire & schema changes

### D1 migration `0013_site_brands.sql`

```sql
-- The brand a site or group belongs to (docs/specs/foundation/multi-brand.md
-- decision 4). Null on every row of a deployment with no `brands`; on one with
-- `brands`, one of the configured brand ids, and a row without one serves nothing.
-- Additive: code that predates it never reads the column.
alter table sites add column brand text;
```

No index: the registry snapshot reads every row. `0012_users_role_contract.sql`
stays claimed by spec 23 and is written later; `0013` is applied before it on any
database that takes this release first, and wrangler applies by filename whatever
is unapplied, which the plan's phase 3 proves on a local database.

### Core types

- `SiteRef.brand: string | null`, `GroupRef.brand: string | null`,
  `SiteContext.brand: string | null`, `Registry.shared: boolean`
  (`src/core/sites.ts`). A single-site deployment builds no registry, so nothing
  changes for it.
- `BrandRef = { id: string; label: string }` (`src/server/types.ts`).
- `Manifest.brand?: BrandRef` and `Manifest.settings?: string` (`src/core/schema.ts`),
  present only on a branded deployment's scoped manifest. `MeScope.brand:
  BrandRef | null` (`src/server/auth/me-sites.ts`).
- `computeBlocksDigest(schema: SchemaIndex): string` and
  `diffBlocksDigest(server, client)` in the new `src/core/registry-digest.ts`.
- Documents, blocks, mutations and logs: unchanged. Nothing already stored is
  reinterpreted.

### New or changed routes

| Route | Change |
| --- | --- |
| `GET {base}/api/schema` | Scoped on a branded deployment: the brand's manifest with `brand`. Unscoped on a branded deployment: the neutral manifest |
| `GET {base}/api/v1/schema` | Scoped on multi-site: adds `scope: { id, name, kind, brand }`. Unscoped on a branded deployment: `400 site_required` |
| `GET ~<site>/api/v1/pages/{path}`, `GET ~<site>/api/v1/documents/by-path/{path}` | A miss is `404` with `error.miss: FolioMiss` |
| `POST {base}/api/sites`, `PATCH {base}/api/sites/:id` | Accept `brand`; required on create on a branded deployment; `409 conflict` changing it while the scope holds content, or on a group with sites; `400 bad_request` for an unconfigured brand or a group of another brand |
| `GET {base}/api/sites` | Rows carry `brand` |
| `GET {base}/api/me` | Each `sites.scopes[]` entry carries `brand: BrandRef | null` |
| `GET {base}/api/assets/describe` | Answers for the scope's brand; unscoped on a branded deployment, `400 site_required` |
| `POST {base}/api/migrate`, `/reindex`, `GET /audit`, `GET /migrations` | On a branded deployment unscoped is `400 site_required`; under `~<scope>` each runs that scope's brand over that brand's scopes and its report carries `brand`. `folio.migrate`, `reindex` and `audit` off a request iterate the brands |
| MCP `initialize` | `instructions` gain the scoped sentence on a multi-site deployment |

## Acceptance criteria

### Nothing changes for a single-brand host

```
GIVEN a deployment with no `brands`, single-site or multi-site
WHEN it upgrades and applies 0013
THEN every stored document, cache tag, manifest and rendered page is what it was, and each
     response differs only by the additive fields the ledger names: `brand: null` on
     `GET /api/sites` rows, on `/me` scopes and on every hook payload, `scope` on a scoped
     v1 `/schema` of a multi-site deployment, `miss` on a v1 404, `headers` on a `FolioMiss`
     and one more sentence in a scoped MCP session's instructions
AND single-site-pin.test.ts and multi-site-pin.test.ts pass unchanged
AND the Vite plugin with a string `blocks` emits folio-preview.js and the same __FOLIO_ASSETS__
```

### Construction

```
GIVEN createFolio with `brands` and a top-level `blocks`, or `brands` without `sites`,
      or a brand migration id without its brand prefix, or `assets.brands` missing a brand
WHEN it is constructed
THEN it throws, naming the key
```

```
GIVEN a blocks array naming `prose` twice, or an object registry { hero: <block named banner> }
WHEN toRegistry runs
THEN it throws `duplicate block 'prose'`, or `registry key 'hero' names block 'banner'`
```

### Two brands, the same names

```
GIVEN brands allaboutafrica and takeoffgo, each declaring block `pageRoot`, block `prose`
      and type `page` with different fields, and sites `default` (allaboutafrica)
      and `takeoffgo` (takeoffgo)
WHEN a page of type `page` is created, edited and published in each
THEN each document validates against, renders with and indexes by its own brand's schema
AND GET ~takeoffgo/api/schema lists takeoffgo's blocks only, and ~default allaboutafrica's
AND creating type `guide` under ~takeoffgo is 400 Unknown document type
```

### The fence

```
GIVEN a branded deployment
WHEN a request names ~shared, or a site whose brand is null or not configured
THEN it is 404 No site or group
AND a reference, collection or search on takeoffgo never returns an allaboutafrica row
AND PATCH /api/sites/takeoffgo { brand: 'allaboutafrica' } is 409 while it holds a story
```

### Preview

```
GIVEN the two brands with per-brand preview bundles
WHEN a takeoffgo draft is previewed on takeoffgo's preview origin
THEN the page links folio-preview-takeoffgo.js and folio-preview-takeoffgo.css only
AND <html> carries data-folio-brand="takeoffgo"
AND only takeoffgo's globals are drawn above it
```

```
GIVEN a preview bundle built from allaboutafrica's blocks module served for takeoffgo
WHEN the preview mounts in edit mode
THEN a notice names the missing and extra blocks, and the page still renders
```

### Admin, MCP, v1

```
GIVEN an editor with roles on both sites
WHEN they open ~takeoffgo
THEN the New menu, chips and sidebar list takeoffgo's types only
AND the switcher shows "<site> · Take Off Go" grouped under its brand
AND the tab title ends "· <site name> · Folio"
```

```
GIVEN an MCP client at ~takeoffgo/mcp
WHEN it initialises and lists tools
THEN the instructions name the site and brand, and every description lists takeoffgo's
     types and blocks only
AND GET /api/v1/schema with no scope and an unbound token is 400 site_required
```

### Headless miss

```
GIVEN a redirect from `old` to `new`, and an unpublished page `gone`
WHEN a front end reads ~<site>/api/v1/pages/old, /gone and /never
THEN each is 404 with error.miss { kind: 'redirect', to: '/new', status }, { kind: 'gone' },
     { kind: 'not-found' }
AND reader.miss(path).headers carry path:<site>:<path> and site:<site>
```

### Per-brand policy

```
GIVEN allaboutafrica's verify refusing and takeoffgo's accepting
WHEN a form is submitted on each brand's live host
THEN allaboutafrica's is refused and takeoffgo's accepted, each by its own brand's function
AND the submitted hook's payload carries the right brand
```

```
GIVEN takeoffgo's migration `takeoffgo/0001-…` over block `feature`
WHEN folio.migrate runs
THEN it rewrites takeoffgo's documents only, and an allaboutafrica document with a block
     named `feature` is untouched
```

## Implementation plan

Phased so each commit leaves the tree green; `docs/multi-brand-plan.md` gives the
file scoping, models, gates and reviews.

### Phase 1 — Duplicate block names throw (before `v1.0.0`)

1. `toRegistry`'s two throws; unit tests beside the type-name test.

### Phase 2 — The additive surface

1. Exports (decision 14). 2. v1 404 `miss` and `FolioMiss.headers` (decision 13).
3. The registry digest, the bootstrap field and the preview notice (decision 11).
4. `MagicLinkMail.scope` without `brand` yet.

### Phase 3 — The brand core

1. `0013`; `SiteRef`/`GroupRef`/`SiteContext.brand`, `Registry.shared`, `chain`,
   `sitesUnder`, `layerSeed` (decision 5). 2. Snapshot and registry-route validation
   (decision 4). 3. `FolioBrand`, the config union, construction refusals,
   `assets.brands` (decision 3). 4. `BrandRuntime`, `rt.brands`, `rt.forScope`,
   `c.var.brand`; the old members become throwing getters on a branded runtime
   (decision 6).

### Phase 4 — Every reader through its brand

1. Routes (`c.var.brand`). 2. Entry points off a request: the reader, `handle()`'s
   preview branch, `render`, `renderGlobal`, `registryFor`, `migrate`, `reindex`,
   `audit`, `runSchedules`, `previewPage` and the `data-folio-brand` attribute.

### Phase 5 — The old members go

1. Delete the throwing getters; `pnpm typecheck` proves no reader remains.

### Phase 6 — Per-brand preview bundles (runs beside phase 4)

1. The Vite plugin's record form and the `cssCodeSplit` refusal (decision 9).

### Phase 7 — Admin and agent surfaces

1. Scoped manifest fetch, `MeScope.brand`, switcher, title, Sites screen brand
   (decisions 12 and 20). 2. MCP instruction sentence, v1 `schema.scope`, the
   neutral manifest and the unscoped `400` (decisions 12 and 19). 3. `HookBase.brand`,
   `MagicLinkMail.scope.brand` (decision 16).

### Phase 8 — Documentation

1. `README.md`, `AGENTS.md` ("A multi-brand host", decisions 18 and 19),
   `docs/handbook.md`, `docs/configuration.md` (`brands`, `FolioBrand`, `assets.brands`,
   the refusals), `UPGRADING.md` (`0013`, setting `default`'s brand, the ledger),
   `docs/specs/README.md`, `bin/folio.mjs agents`' note, this spec's Implementation
   notes.

## Edge cases

- **A brand is removed from `brands` while sites carry it** → those rows leave the
  snapshot and serve nothing; `GET /api/sites` lists them with their brand so a
  platform admin can re-brand them once they are emptied. Loud at the host's 404,
  never another brand's registry.
- **A document whose type the brand no longer declares** → reads as today's
  "Unknown type", per brand.
- **A token bound to a site of another brand than the URL's scope** → 403 as today;
  a chain never crosses brands, so "a read up the binding's chain" never reaches the
  other brand.
- **A group** → its brand is its sites' brand; a site cannot join a group of another
  brand (400), and a group's brand cannot change while it has sites (409).
- **`auth: 'open'`** → every scope editable as today; the brand still decides the
  registry.
- **A sign-in with no `next`** → `MagicLinkMail.scope` absent; the host's mail is
  brand-neutral.
- **The same singleton name in both brands** → two rows (`sng_<type>` for `default`,
  `sng_<type>:takeoffgo`), each with its own brand's schema.
- **A migration id `takeoffgo/0001-x` declared by allaboutafrica** → refused at
  construction: the prefix must be the declaring brand's.
- **The plugin's record has a key `brands` does not** → `createFolio` refuses at
  construction when `assets.brands` and `brands` differ.

## Testing requirements

**Unit (`test/unit/`):**
- `core/block-registry.test.ts` (new): both throws, and a distinct list passes.
- `core/sites.test.ts`: `chain`, `sitesUnder`, `layerSeed` with `shared: false`;
  unchanged with `shared: true`.
- `core/registry-digest.test.ts`: stable under reordering; changes with a field.
- `server/brands-config.test.ts`: every construction refusal.
- `vite/plugin.test.ts`: the record form's inputs and define; the string form
  byte-identical; `cssCodeSplit: false` with a record throws.
- `admin/multi-site-admin.test.ts`: brand grouping in the switcher, the title, the
  scoped manifest fetch.

**Workers (`test/workers/`, real workerd):**
- `multi-brand.test.ts` (new): two brands with colliding names over one D1 —
  create, edit, publish, render, index, search, query, forms, migrate and reindex per
  brand; `~shared` 404; the brand fence on registry writes; the scoped and neutral
  manifests; v1 `schema.scope` and the unscoped `400`; MCP instructions and
  descriptions.
- `multi-site-headless.test.ts`: the 404 `miss` and `miss().headers`.
- `migrations.test.ts`: `0013` pinned (the column, null by default).
- `scope-partition.test.ts`: unchanged list, still green with a second brand.
- `single-site-pin.test.ts`: unchanged.

**End to end (`scripts/*.mjs`, port 5199):** the demo stays single-brand, so the
e2e tier is a regression gate here, not a brand test. The two-brand behaviour is
proven by the workers suite and, for what only a deployment can show, by the plan's
Phase V.

## Dependencies

- **Spec 23** built and released: the registry, scopes, chains, preview origins and
  scoped tags this spec partitions.
- **`docs/1.0-plan.md`**: phase 1 here lands before its phase 6 cuts `v1.0.0`.
- **Cloudflare:** one Worker with `enable_ctx_exports` and the cached-entrypoint
  split; custom domains for the admin origin and each brand's live host and preview
  origin; an email sender on the admin origin's domain.

## Out of scope

- **Federation** (decision 2) and any cross-Worker forwarding or purge.
- **A per-type site allowlist** (decision 12): built the first time one brand's
  sites need different type sets.
- **A shared scope on a branded deployment** (decision 5).
- **Per-brand `auth`, `hooks`, `locales` or `route`** (decision 3).
- **Admin theming per brand** (decision 20).
- **Moving a site between deployments inside Folio** (decision 22).
- **Changing a site's brand while it holds content** (decision 4): empty it, or
  create a new site.

## Implementation notes

Built on the branch `multi-brand` on 2026-09-30, one commit per phase (`d8ffe82`
phase 1 on `main`, `b27eee6` 2, `4f6c618` 3, `985963f` 6, `05fbd98` 4, `8e727cd` 5,
`5d478ff` 7, phase 8 with this text). **Staged for review, not `done`: nothing here
has run on a deployment.** The workers suite proves the two-brand behaviour in
workerd with colliding names, and the staging deployment the plan calls Phase V is
what remains. `docs/multi-brand-plan.md` is the build order and the review record.

### Phase 1: duplicate block names throw (`d8ffe82`)

`toRegistry` throws `folio: duplicate block '<name>'` for the array form and
`folio: registry key '<key>' names block '<def.name>'` for the object form, as
specified. Neither consumer, the demo nor the starter repeated a name. It went to
`main` ahead of the `v1.0.0` tag, as the ledger requires.

### Phase 2: the additive surface (`b27eee6`)

- **`FolioMiss.headers` split the type.** `pathMiss` has no site to build tags from, so
  its arm is the internal `MissArm` and `FolioMiss = MissArm & { headers }`. One helper,
  `answerMiss` (`src/server/errors.ts`), spells the headers for `reader.miss()` and both
  by-path routes. Nine `toEqual` assertions on `miss()` became `toMatchObject`.
- **The by-path documents route has no reader**, so it calls `pathMiss` over the
  request's chain and `answerMiss`. A group or `shared` scope uses the scope id as the
  site in the tags.
- **The digest is a readable `name(field:kind,…)` string, not a hash**, because the
  banner has to say which blocks differ. `diffBlocksDigest` also reports `changed`, so a
  field-only mismatch is not silent (the spec named only missing and extra).
- **`MagicLinkMail.scope` landed with `brand: null`** and phase 7 filled it.
- The brand types in decision 14's export list waited for phase 3, which defined them.

### Phase 3: the brand core (`4f6c618`)

- **`SiteContext.brand` is `brand?: string`, present only with `brands`**, not
  `string | null`: the Resolution carries `site` on every multi-site render, so a
  `brand: null` key would have changed its bytes. `Manifest.brand` follows the same
  rule. `SiteRef.brand` and `GroupRef.brand` are `string | null` as specified, and
  appear as `brand: null` on `GET {base}/api/sites` rows of a single-brand deployment.
- **`Registry.shared` is required, not optional.** An optional flag would default to
  true, which fails open: a registry literal that forgot it would have a `shared` scope
  on a branded deployment. Eight test files gained `brand: null, shared: true`.
- **Only the snapshot is filtered.** `servingRegistry` drops rows whose brand is null or
  unconfigured; `rt.sites.fresh` stays unfiltered because registry writes, `GET
  /api/sites` and credential checks need every row. Grants and token bindings still
  refuse a scope the snapshot does not serve (`400 … which is not a site or group`).
- **`chain()` also skips a group of another brand**, so the fence is structural and not
  a matter of write discipline for a row written by SQL.
- **The brand-change conflict list is the delete's `OWNED` list**, which includes
  `form_responses`. It is part of the `update` itself, one `not exists` per table, so a
  story landing between a probe and the write cannot slip through. Any change is
  refused while the scope holds content, `null` to a brand included; an explicit
  `brand: null` on a branded deployment is `400`; any non-null brand on an unbranded
  one is `400`. Group creation requires a brand.
- **A layer's seed needs the registry on a branded deployment.** `isBareLayer` is wrong
  where `shared` is absent: the bottom of a chain seeds `'full'`. `seedFor`, `draftFor`
  and `draft` take an optional registry; a branded runtime asked for a layer without one
  throws.
- **More members threw than decision 6 listed**: `draftFor`, `draftForWithSyncId`,
  `draft`, `resolve`, `query`, `publishDeps`, `auditContext` and `page('preview')`, plus
  `sites.settings`. Phase 5 removed all of them.
- **A brand's `resolve` and `query` refuse another brand's site and refuse no site**,
  because an absent site is the `default` chain and `default` may be another brand's.
- **The internal hook set is one set over every brand's globals**, since purge hooks are
  deployment-level. A type that is a global in one brand and a plain singleton in another
  purges the second as a layer plus `story:<id>`; nothing goes stale.
- **`withScope` sets `c.var.brand` as `BrandRuntime | null`**, null only on a branded
  deployment with neither scope nor site, so an unscoped route has to say what it does
  with no brand.
- **Construction refusals** also cover `assets.previewCss` at the top, an `assets` with no
  `brands` key, and a blank `label`. Per-brand refusals are the single-brand messages
  rethrown as `folio: brand '<id>': …`. Migration ids are checked for the `<brand>/`
  prefix and then validated with the prefix stripped, because `/^\d*/` reads width 0 for
  every prefixed id and the same-width rule would stop applying.
- **`FolioConfig` is a union, so `Partial<FolioConfig>` no longer spreads.** Use
  `Partial<FolioSingleConfig>`.
- **`0013` proven out of order**: applied after `0011` and before a stand-in `0012` on a
  fresh local database, wrangler applied by filename, and the stand-in ran after it.
- **`readRegistry` selects `sites.brand` on every multi-site deployment, branded or
  not.** Code that predates `0013` never reads the column (true), but code from this
  release on a database without it fails every registry read, so `0013` is applied
  before the deploy on every multi-site deployment. The spec's "with no `brands`,
  nothing reads it" was true of behaviour and not of the query.
- **Left open on purpose:** another isolate's registry snapshot answers the old brand for
  up to ten seconds after a rebrand. A first page created there in that window is written
  against the old brand's registry. Closing it means checking a story's own site brand
  against the request's, which decision 6 rules out. A rebrand is safe on a scope nobody
  is editing.

### Phase 4: every reader through its brand (`05fbd98`)

- **`/migrate`, `/reindex`, `/audit` and `/migrations` are unscoped routes and answer
  `400 site_required` on a branded deployment.** The route table said per brand, grouped
  by brand. Under `~<scope>` each runs that scope's brand over that brand's scopes and
  reports `brand`. Reports grouped by brand are `folio.migrate`, `folio.reindex` and
  `folio.audit`, which iterate the brands. `site_required` became a `FolioErrorCode` in
  phase 7 so a route can throw it.
- **The off-request sweeps walk brands with a prefixed cursor.** `continueFrom` on a
  branded deployment is `<brand>/<inner>`; each call covers one brand, in `brands`
  order, because an audit finding names a type and both brands have a `page`. A cursor
  naming no brand is `400`. In a branded `migrate` report `pending`, `behind` and
  `complete` cover the whole deployment and the per-batch counts cover this call's
  brand, so a loop that reads the last report's `complete` means every brand. The route
  reports only its own brand.
- **The out-of-order check is per brand.** `schema_migrations` holds every brand's ids,
  so once `takeoffgo/0001` is applied every unapplied `allaboutafrica/…` id sorts before
  it and the next run would throw "inserted into the past". `ownMigrations` filters to
  the brand's ids first.
- **Scheduled publishes use the story's own scope.** A cron tick has no request; the due
  row's `site_id` is the only scope there is, and its brand is its chain's. Deps are
  memoised per brand per run. A story whose scope no configured brand serves is recorded
  as a failure, not published under a guess. `folio.draft` and `folio.write` do the same
  from the id, and `folio.draft` of an id with no row throws `not_found` on a branded
  deployment.
- **A branded reader with no site** answers nothing from `page`, `stories` and `tree`,
  `null` from `global`, and throws from `resolve` and `query`, rather than pick a registry.
- **`perBrand` reads the brand's scopes from the fresh registry**, not the snapshot, so a
  site created a moment ago cannot miss a migration its brand's ledger then records as
  complete.
- **`folio.registryFor(brand)` was added to the `Folio` interface** (answers a
  configured brand's block registry, throws for any other id, and for every id on a
  single-brand deployment). `previewPage`'s `opts.brand` is required so the compiler
  finds every caller. The editor's bare global preview never passed a site; branded, a
  site renders as itself and a group as a stand-in site on its own chain.
- **The review found six and all were fixed:** a bulk describe crossed brands
  (`DescribeDeps.scopes`); a bound token at an unscoped URL was brandless; a v1 read of
  a layer created its row; a group's bare preview resolved on an empty chain; route
  reports lacked `brand`; and the scoped schedules run crossed brands.
- **A v1 read of an unwritten layer is now `404` and creates no row**, on every
  deployment with `sites`, single-brand included. A layer is created by its first write.
  A single-site deployment keeps "asking creates a singleton". The alternative, keeping
  the create, made a previewed draft site undeletable.
- **`HookBase.brand`, and `brand` on the `migrated` and `reindexed` payloads,** waited for
  phase 7: the fire sites in `hooks.ts` were in no phase 4 lane.

### Phase 5: the old members go (`8e727cd`)

The twenty-seven registry-derived members of `FolioRuntime` and `sites.settings` are
deleted, with the throwing getters and the arrays that listed them. The proof is
`pnpm typecheck` exiting 0 with them gone. Keeping the getters as a permanent guard was
the alternative; it leaves a type that promises members that throw.

### Phase 6: per-brand preview bundles (`985963f`)

- **The record form's define has no top-level `preview` or `previewCss`**:
  `{ admin, devClient, adminCss, brands: { <brand>: { preview, previewCss } } }`.
- **Virtual ids are `virtual:folio/preview/<brand>`.** In dev a brand's preview is
  `/@id/__x00__virtual:folio/preview/<brand>`. The bare id resolves for the string form
  only.
- **Two refusals beyond the spec:** an empty record, and a key that is not shaped like a
  site id, throw at plugin construction. The site-id rule is duplicated in
  `src/vite/index.ts` (`BRAND_ID`) because the plugin must not import server code.
- **The `cssCodeSplit: false` refusal is in `config()`** and covers both
  `build.cssCodeSplit` and `environments.client.build.cssCodeSplit`.
- A real Vite build of two brand modules put each brand's rule only in its own
  stylesheet. The string form is pinned byte-identical to the pre-change plugin.

### Phase 7: admin and agent surfaces (`5d478ff`)

- **`/me` gained a brand list, not only `MeScope.brand`**: `sites.brands` (`BrandRef[]`,
  present only on a branded deployment), because the Sites screen must offer a brand with
  no site yet. `sites.scopes[].brand` is `null` on every scope of a single-brand `/me`.
- **`/me`'s `sites.settings` is null on any branded deployment.** Each brand has its own
  settings type, so the Sites screen's Settings tab reads `me.sites.settings ??
  manifest.settings` and exists only under a scope (`~<scope>/sites`), listing that
  brand's scopes. At the bare base a branded deployment's Sites screen has no Settings
  tab; the settings singleton also appears in each scope's Globals group.
- **The neutral manifest** is `{ types: [], blocks: [], root: '', globals: [], locales?,
  hooks? }`, with `locales` and `hooks` read off the first brand's manifest because both
  are deployment-wide.
- **v1 `scope` on a multi-site deployment without brands** is `{ id, name, kind, brand:
  null }` (`name: 'Shared'` for `shared`). v1 `/schema` unscoped on a branded deployment
  is `400 site_required`.
- **MCP has no `initialize`** on the revision it speaks: the instructions are built at
  `server/discover`. On a scoped multi-site session without brands the fourth sentence is
  `This session is scoped to site 'N' (`id`).` (`group` or `scope` for those kinds); only
  the branded form has the brand clause.
- **`HookBase.brand` is set by the runner from its own brand**, not from the payload:
  `rt.hookRunner(ctx, brand)` takes it as a required argument so the compiler found all
  eleven call sites, and a payload that tries to stamp another brand is overwritten. Every
  single-brand payload now carries `brand: null`, including on single-site deployments.
- **`MagicLinkMail.scope.brand`** is the row's `{ id, label }` on a branded deployment and
  `null` otherwise. It is parsed from a same-origin `next`; `safeNext` fallbacks give none.
- **`isBareLayer` is out of the admin.** `inspector-model.ts` decides a layer by the
  `/me` chain of its own scope, which is `layerSeed`'s rule.
- **The switcher groups by brand** when any choice carries one, ordered by label, so a
  single-brand `/me` groups Shared, Groups, Sites as before. The token-binding picker uses
  the same function. The Sites dialog offers no impossible control: a group holding sites
  has a fixed brand and a new site is never offered a group of no brand.
- **The review found five, all fixed:** an unscoped route with a scope in the URL picked a
  brand without checking the caller reached it (403 now, branded deployments only);
  the Sites dialog offered a brand change the server always refuses, and groups with no
  brand; and the Settings blurb told a bottom-of-chain scope it inherited.
  A failed scoped manifest fetch now throws so the shell draws stubs.

### Phase 8: documentation

`README.md`, `docs/handbook.md` ("Many brands in one deployment"),
`docs/configuration.md`, `docs/api.md`, `docs/mcp.md`, `AGENTS.md` ("A multi-brand
host" and one sentence in the paste block `bin/folio.mjs agents` copies), `UPGRADING.md`
and `docs/specs/README.md`, plus the acceptance line and route table above, reworded to
what shipped.

### Deferred

- **Converting an existing deployment's unprefixed content-migration stamps.** Turning
  `brands` on for a deployment with content migrations means renaming its ids to
  `<brand>/…`, and `stories.schema_id` and `schema_migrations.id` carry the old ones, so
  every document reads as behind and the next `migrate` runs them again. Out of scope:
  the test deployment starts from scratch. A conversion would prefix both in the same SQL
  as the `default` brand update.
- **Renaming or removing a brand id once rows carry it.** The repair is SQL,
  `update sites set brand = '<new>' where brand = '<old>'`, applied with the deploy.
  `PATCH { brand }` is `409` on any scope that holds content.
- **Grouped-by-brand reports on the routes**, and a per-brand Settings tab at the bare
  base of a branded admin.
- **`DocumentType.sites`, federation, per-brand `auth`, `hooks`, `locales` or `route`**,
  as the Out of scope section says.
- **Staging verification** (the plan's Phase V): nothing here has run on a deployment.
