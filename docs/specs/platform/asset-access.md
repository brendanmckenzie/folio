# Feature: Visitor access for media library assets

> **Group:** platform
> **Build order:** 43
> **Size:** L
> **Status:** draft
> **Wire version:** none. Nothing here crosses the socket or the admin↔preview bridge; `PROTOCOL_VERSION` stays where spec 39 leaves it.
> **Migration:** `0019_asset_access.sql` (claimed). `0018` is spec 39's claim (`editing/agent-suggestions.md`). If this spec builds first, it still takes `0019`: the two are independent `alter table add column` files, and wrangler applies whatever is unapplied by filename, so a database that takes `0019` first takes `0018` later exactly as `0013` was taken before `0012`.
> **Build sequence:** after 31 (visitor access), 32 (media library), 17 (caching), 21 (draft sharing), 23 (multi-site) and 34 (multi-brand), all done. Independent of 39 and 42; shares no source file with 39 except `CLAUDE.md` and the ledgers.
> **Tracker:** GitHub issue #178.
> **Last updated:** 2026-11-16

## Summary

Visitor access (spec 31) gates pages only. `{base}/asset/:key` serves every file in the
library to anyone holding its URL, and `cacheVerdictFor` sends every request for it to the
cached entrypoint, so a PDF linked from a members-only page is public bytes in a shared
cache under a stable URL. `src/server/routes/assets.ts:849-860` is the gap: the route reads
the key, parses a transform and calls `serveAsset`, which reads R2 and nothing else. The
random `ast_` id makes a key hard to guess and does nothing about a forwarded link.

This spec gives an asset (and a media-library folder) an access value in the gate field's
own vocabulary, checks it on the asset route itself with one indexed read and no host call
for a public file, asks the host's new `gate.allowsAsset` only for a gated one, and serves a
granted file `private, no-store` so it never enters the edge cache. A deployment that does
not configure `gate.allowsAsset` runs today's code path, byte for byte.

## Ground truth

Verified against `main` at `1e9c53e` (2026-11-16). Paths are from the repository root.

**The asset route and serving (`src/server/`):**

- `routes/assets.ts:849-860`: `GET /asset/:key` takes `media` and `images` from bindings,
  validates the key with `assetKeyParam` and calls `serveAsset(media, images, key,
  parseTransform(...), c.req.raw, rt.logger)`. It is mounted with no `requireAccess`. It
  reads **no D1 row**: `serveAsset` (`assets.ts:980`) starts at `bucket.get(key)`
  (`assets.ts:988`). The middleware comment calling it "one indexed read"
  (`middleware.ts:52`) and `cache-request.ts:96-99` are both stale on that point.
- `validate.ts:927-934`: `ASSET_KEY` is `^ast_[0-9a-f]{12}-[a-z0-9.-]{1,80}$`. The id
  (`ast_` plus 12 hex, 16 characters) is the key's prefix (`assets.ts:635-640`:
  `key = ${id}-${filename}`), and `assets.id` is the primary key, so no key is a string
  prefix of another asset's key.
- `assets.ts:908` `IMMUTABLE = "public, max-age=31536000, immutable"`; `assets.ts:917`
  `DEGRADED = "public, max-age=60"`; `assets.ts:942` `serveHeaders` sets `content-type`,
  `cache-control`, `nosniff`, the sandbox CSP and `content-disposition`. **No asset
  response carries `Cache-Tag` today.**
- `assets.ts:1018-1029`: an untransformed response streams `object.body` with `IMMUTABLE`
  (or `DEGRADED` for a transform that will not run) and `etag`. There is **no `Range`
  support** on this route: `bucket.get(key)` is called with no `range` option and nothing
  sets `accept-ranges`. Uploads are capped at 20 MB (`assets.ts:32`, `MAX_UPLOAD_BYTES`).
- `assets.ts:1043-1101`: a transform reads and writes `caches.default` (the Cache API),
  keyed by `canonicalTransformRequest` (`assets.ts:964`), the request's own origin and
  path plus the clamped transform query. The Cache API is a separate store from Workers
  Caching and `cache.purge()` does not reach it (`docs/handbook.md`, "Workers Caching, and
  why the entrypoint split is not optional"; `CLAUDE.md`, caching invariant).
- `assets.ts:657`: the R2 object is written with `httpMetadata.cacheControl` set to the
  immutable value. `serveAsset` never echoes it; it builds its own headers.
- `cache-request.ts:107-127`: `cacheVerdictFor` answers `bypass` for any non-GET/HEAD, an
  upgrade, any Folio session, grant, draft or share cookie, and `?_folio=preview|draft`;
  then `cache` for `{base}/asset` and `{base}/asset/*` (line 122); then `bypass` for the
  rest of `{base}`. It is pure and reads no binding.
- `index.tsx:463-475` `servesOnSite`: on a registered site's host, a GET or HEAD for
  `/asset/*` with no `~scope` segment is served. The asset route therefore runs with
  `c.var.scope === null` on every site host and on the admin origin.
- `app.ts:83-97`: `withBindings`, `withScope` and `withActor` run for every request,
  the asset route included. `withActor` (`middleware.ts:382-407`) resolves an actor from
  any presented credential (session cookie, bearer token, preview grant); with no
  credential `c.var.actor` is null.
- `index.tsx:488-495` `framedBy` never replaces a CSP a route set, which is why the
  sandbox CSP survives on a preview origin.
- `cache-purge.ts:94-101` `platformPurge` dereferences `cache` from `cloudflare:workers`
  per call and answers null when the capability is absent. `MAX_TAGS_PER_PURGE = 100`
  (line 59), `MAX_PURGE_CALLS = 5` (line 71), `SITE_PURGE_DELAY_MS = 25_000` (line 108,
  multi-site decision 4's second purge past any replica or isolate lag).
- `CachePurgeOptions` (`@cloudflare/workers-types`, `index.d.ts:606-610`) is
  `{ tags?, pathPrefixes?, purgeEverything? }`. Cloudflare's purge documentation
  (developers.cloudflare.com/workers/cache/purge/, read 2026-11-16): entries in
  `pathPrefixes` are request paths with no scheme, host, query string or fragment; `tags`
  and `pathPrefixes` in one call are unioned; every mode is scoped to the entrypoint
  that called it. Nothing in this repository uses `pathPrefixes` yet.
- `multi-site.md` addendum in `caching.md` (2026-09-29): the Workers Caching key is path,
  entrypoint, `ctx.props` and version, **not the host**. A path-prefix purge therefore
  reaches every site host and both surfaces at once.

**Visitor access (`src/core/gate.ts`, `src/server/gate.ts`, `src/server/index.tsx`):**

- `types.ts:230-262` `FolioGate<Env, V>`: `field`, `public`, `visitor(req, env)`,
  `allows(visitor, value, ctx: FolioGateContext)`. `FolioGateContext` (`types.ts:195-205`)
  is `{ story, doc, locale?, site }`, with `story` and `doc` required.
- `core/gate.ts:62-67` `isUngated(value, public)` is strict equality.
- `server/gate.ts:56-136` `validateGate` returns `ResolvedGate { config, roots, types }`
  and throws at construction for a gate field that is not one of five scalar kinds, is
  `translatable`, is not `indexed`, has the wrong primitive for `public`, or (for
  `select`) does not list `public` among its options. Two roots may declare the field
  with different definitions; each is checked on its own.
- `index.tsx:1305-1345` `accessFor`: no gate is public; a root without the field or a
  value equal to `public` is public; `drafted` is granted; else `visitor` once per reader
  (`visitorOnce`, `index.tsx:1283`) then `allows`, each in its own `try` that logs and
  denies.
- `index.tsx:1416-1424`: `drafted || access !== 'public'` answers `NO_STORE`
  (`core/cache-tags.ts:49`, `"private, no-store"`); otherwise `cacheHeaders`.
- `index.tsx:1194-1258`: `draftFor` and `editorAdmits` are the draft authority. An
  editor needs the draft cookie (single-site) or a credential on a preview origin
  (multi-site), then `allows(actor, READ_DRAFT)` or `mayPreviewDrafts`; a share is
  checked with `claimShare` (`auth/shares.ts:399`), which also stamps a view.
  `auth/shares.ts:361` `readShareByToken` is the read-only lookup.
- `gate` is per brand: `FolioBrand.gate` (`types.ts:679`), `FolioSingleConfig.gate`
  (`types.ts:886`), `BrandRuntime.gate: ResolvedGate | null` (`runtime.ts:295`).
  `rt.forScope(registry, scope)` (`runtime.ts:2151-2157`) answers the one brand of an
  unbranded deployment, and on a branded one the brand of a site or group row, or null
  for `shared` and for a row with no configured brand.
- `examples/demo/src/index.tsx:54-62`: the demo's `gate` (`field: 'access'`,
  `public: 'public'`, a fake `demo_member=1` cookie visitor).

**Assets in D1 (`migrations/`, `src/server/assets.ts`, `asset-folders.ts`, `asset-bulk.ts`):**

- `0001_init.sql:190-201`: `assets.key text not null unique`, so `where key = ?` is one
  lookup on SQLite's automatic unique index. `0011_sites.sql:75` adds
  `assets.site_id text not null default 'default'`.
- `0008_asset_organisation.sql` and `0011_sites.sql:83-96`: `asset_folders (id,
  parent_id, name, path, created_at, site_id)`, `path` unique per site.
- `assets.ts:34-59` `AssetRow` and `assets.ts:61` `COLS`, shared by every list and read.
- `assets.ts:564-575` `toAssetValue`: the `AssetValue` copied into a document holds key,
  filename, content type, size, dimensions and alt. `media-library.md` decision 7:
  library organisation never reaches `AssetValue`.
- `assets.ts:620-718` `uploadAsset` inserts every row unfiled (`folder_id` null).
- `assets.ts:751-797` `updateAsset`: absent-means-leave-alone patch of `alt`,
  `description`, `folder_id`, then tags.
- `asset-folders.ts:302-353` `updateFolder` (rename and move, one subtree rewrite over
  the materialised path with five binds); `asset-folders.ts:404-465` `deleteFolder`
  re-parents children and sets `folder_id = null` on directly filed assets
  (`media-library.md` decision 14). `subtreeWhere` / `descendantsWhere`
  (`asset-folders.ts:77-97`) are the range predicates.
- `asset-bulk.ts:319-327`: the bulk `move` is `update assets set folder_id = ? where id
  = ? and site_id = ?`. `core/assets.ts:80` `AssetBulkAction` is
  `'tag' | 'untag' | 'move' | 'delete'`.
- `content-index.ts:435-444` `assetReferences(db, key)`: published stories whose
  `content_refs` point at the key. `content_refs` is written inside the publish batch,
  so it holds published usage only.
- `core/refs.ts:255-292` `assetKeys(doc, schema)`: every key reached through `asset`,
  `multiasset`, `multilink` and richtext link marks.

**Rendering (`src/core/resolve.ts`, `src/server/runtime.ts`, `src/core/cache-tags.ts`):**

- `runtime.ts:943` `assetBase = ${base}/asset`, **root-relative**, so a page rendered by
  the host Worker loads its assets from its own origin.
- `resolve.ts:286-297` `ResolvedAsset { src, objectPosition, isImage, srcFor }`;
  `resolve.ts:318-340` `decorateAsset` builds `src` from `assetBase` and the key, and
  `srcFor` appends `w`, `h`, `fit`, `f`, `q`, `fp`. An asset link resolves through the
  same function (`resolve.ts:269-272`).
- `runtime.ts:1647-1660`: pass three (nested forms) runs after pass two;
  `runtime.ts:1701-1713`: pass four (collections) and option lists run in one
  `Promise.all`; `runtime.ts:1737-1751`: the resolution is assembled with every optional
  key absent rather than empty.
- `cache-tags.ts:209-298` `cacheTags`: `story:`, `global:`, `form:`, `type:`, `site`
  (and the scoped variants), sorted; over 1000 tags or 16 KB it degrades to the page's
  own story and site tags.

**Other surfaces:**

- `routes/api/index.ts:126-139` `GET /api/v1/assets` and `:159-198` `POST /api/v1/assets`
  are the whole v1 asset surface. **There is no v1 asset update route.**
- `mcp/tools.ts:546-563` `upload_asset` proxies `POST /assets` with `query: ['filename']`
  and a base64 body. `test/unit/mcp/tools.test.ts` pins seventeen tools.
- `checks.ts` (spec 40) is advisory; check names are a v1 contract, added never renamed.
- `describe.ts:221-230` `describeUrl` hands a model provider an absolute
  `{origin}{base}/asset/{key}?w=512&f=webp`; `DescribeInput.inline()` reads R2 directly,
  and `describe-anthropic.ts:304` uses `inline()`, not the URL.
- `auth/cookie.ts`: every Folio cookie is `Path=/` and host-only (`__Host-` when
  secure), so a Folio session, draft, share or grant cookie reaches the asset route on
  the origin that set it.
- `hooks.ts:266-280` `HookPayloadMap` lists thirteen events; `PurgeIssued`
  (`cache-purge.ts`) is `{ tags } | { everything: true }`.

**tests:**

- `test/unit/server/cache-request.test.ts`, `test/unit/core/cache-tags.test.ts`,
  `test/unit/server/cache-purge.test.ts`, `test/unit/core/gate.test.ts`,
  `test/unit/server/gate.test.ts`, `test/unit/core/resolve.test.ts`.
- `test/workers/assets.test.ts`, `asset-folders.test.ts`, `asset-bulk.test.ts`,
  `gate.test.ts`, `migrations.test.ts`, `scope-partition.test.ts` (fails on any mounted
  id route that is not fence-tested), `api-partition.test.ts`, `single-site-pin.test.ts`,
  `checks.test.ts`, `mcp.test.ts`, `shares.test.ts`.
- `scripts/gate-test.mjs` and `scripts/media-library-test.mjs` are the end-to-end
  precedents; `test/unit/cli/ledger.test.ts` checks `upgrade-ledger.json` against
  `migrations/`, `CHANGELOG.md` and `UPGRADING.md`.

## User stories

### A member downloads a members-only report
**As** a signed-in member **I want to** click "Download the 2026 report" on a page and get
the PDF **so that** what I pay for is what I get.

### A stranger is turned away from the file, not just the page
**As** the site owner **I want** a forwarded link to a members-only PDF to stop at a
sign-in page **so that** the file is as protected as the page that offers it.

### A public page sells a members-only download
**As** an editor **I want to** put a "Members only: download the template" link on a public
landing page **so that** non-members see what they would get, and members get it.

### An editor files protected material in a protected folder
**As** an editor **I want to** mark the "Member downloads" folder members-only and have
every file I drop in it inherit that **so that** I do not have to remember per file.

### A migration loads protected files with their access set
**As** a developer migrating a site **I want to** upload files through the Content API or
MCP with `access` already set **so that** no protected file is public, even for a moment.

## Architecture decisions

### 1. Asset gating is its own opt-in method, `gate.allowsAsset`, and its absence is the whole of "this deployment does not gate files"

```ts
interface FolioGate<Env, V = unknown> {
  // …field, public, visitor, allows, unchanged
  allowsAsset?(visitor: V | null, value: Json, ctx: FolioAssetGateContext): boolean | Promise<boolean>;
  assetDenied?(req: Request, env: Env, ctx: FolioAssetDeniedContext): Response | null | undefined | Promise<Response | null | undefined>;
}
```

`visitor` is shared: one host function answers "who is asking" for pages and files alike.
"May they" is a second method because the context differs in kind, not degree: a page
check is handed a document and a story, a file check is handed a library row and has
neither.

**Rejected: call the existing `allows` with a widened `ctx`** (the issue's "one host
predicate answers both"). `FolioGateContext.story` and `.doc` are required today, and a
host's `allows` is written against them (`ctx.story.type === 'report'`). Making `ctx` a
union is a type-narrowing change to a contract the host implements, so a host compiled
against `1.x` reads `ctx.story.type` off an asset context, throws, is logged as
"`gate.allows` threw; denying", and every gated file is refused with no compile error to
say why. Under semver (CLAUDE.md, the licence table) that is `2.0.0` for a feature that
can be additive. An optional method is a minor.

**Rejected: gate assets whenever `gate` is configured.** Every deployment that gates pages
today would start reading a D1 row on every asset miss the day it upgrades, for a feature
it has not adopted. Opt-in keeps the acceptance criterion literal: without `allowsAsset`,
nothing in this spec runs.

`validateGate` (`server/gate.ts`) gains three refusals at construction, following decision
8 of spec 31 ("a key that reads as a constraint and enforces nothing throws"):
`allowsAsset` present and not a function; `assetDenied` present without `allowsAsset`;
`assetDenied` not a function. On a branded deployment each brand's gate is validated on
its own and `FolioRuntime` precomputes `assetGating: boolean`, true when any brand's gate
has `allowsAsset`.

```ts
interface FolioAssetGateContext {
  asset: { id: string; key: string; filename: string; contentType: string; size: number; folderId: string | null };
  /** The scope that owns the file: `assets.site_id`, `'default'` with no `sites`. */
  scope: string;
  /** The site whose host served this request, or null (no `sites`, or the admin origin). */
  site: SiteRef | null;
  /** True when the value came from a folder rather than from the file itself. */
  inherited: boolean;
}
interface FolioAssetDeniedContext extends FolioAssetGateContext { value: Json }
```

`ctx.asset.id` is what lets a host answer per file ("has this visitor bought `ast_…`")
rather than only per value.

### 2. The value is the gate field's vocabulary, stored as JSON text; null means inherit, and an effective null means public

An asset or folder access value is any value the gate field could hold on a page: one of
the `select` options, a boolean, a number or a string, whichever the declared field is.
`gate.public` means ungated, exactly as on a page, and the comparison is `isUngated`,
strict, unchanged.

Stored as JSON text so the primitive survives the round trip: `'"members"'`, `'true'`,
`'3'`. Strict equality against `gate.public` is then the comparison spec 31 already makes,
with no coercion rule to get wrong.

**An effective value of `null` is public**, and that is a deliberate difference from pages,
where a missing value fails closed (spec 31 checkpoint 2). Every existing asset predates
this column and the acceptance criterion requires each to stay public; a page type that
declares the gate field is an editor's statement that the type is gated, whereas an asset
row with no value is a file nobody has said anything about. Writing `gate.public` into
every existing row instead was rejected: it couples stored data to a config value a host
may rename, and a rename would then gate the whole library.

A stored value is validated on every write against the brand's gate field (decision 11).
If a host later removes `allowsAsset`, stored values become inert and every file is served
as today, the same fail-open spec 31 has for removing `gate` from a page site. If a host
changes `gate.public`, assets whose stored value is the old public value become gated,
again matching pages.

### 3. A folder carries an access value; assets inherit it; the effective value is denormalised onto both tables

```
assets.access                 own value, JSON, null = inherit from folder
assets.effective_access       what the route reads, JSON, null = public
asset_folders.access          own value, JSON, null = inherit from parent
asset_folders.effective_access own ?? parent's effective
```

**The route stays one indexed lookup**: `select id, site_id, folder_id, filename,
content_type, size, access, effective_access from assets where key = ?`, on the unique
key's index. `access` is read only to fill `ctx.inherited`.

**Rejected: inherit at read through the folder chain.** The ancestors of a folder are the
folders whose `path` is a prefix of its own, which with a materialised path is computable
but not indexable from the asset side: either a second round trip (asset row, then
`path in (…)` for its ancestors) or a join on a range over the other row's column, which
SQLite answers by scanning the site's folders. The asset route is the highest-volume
Folio path; it gets one point read. The cost moves to folder writes, which are rare,
editor-driven and already rewrite subtrees (`updateFolder`).

**Maintenance is one module**, `src/server/asset-access.ts`, and every write that changes
an asset's `folder_id` or `access`, or a folder's `access` or `parent_id`, goes through it.
The statements:

- **Asset own value or folder change** (one row): `update assets set access = ?,
  effective_access = coalesce(?, (select effective_access from asset_folders where id =
  assets.folder_id)) where id = ? and site_id = ?`. The bulk `move` gains the same
  `effective_access = case when access is null then (select effective_access from
  asset_folders where id = ?) else access end`.
- **Folder own value, or folder move** (a subtree): read the subtree's folders with
  `subtreeWhere` (one statement, five binds), compute each folder's effective value
  top-down in JavaScript from the moved folder's new parent, write `update asset_folders
  set effective_access = ? where id = ?` per folder in one `db.batch`, then one
  statement for the assets: `update assets set effective_access = (select
  f.effective_access from asset_folders f where f.id = assets.folder_id) where site_id =
  ? and access is null and folder_id in (select id from asset_folders where site_id = ?
  and <subtreeWhere>)`. Fixed binds whatever the subtree's size, which is
  `asset-folders.ts`'s own rule for never building a caller-sized bind list.
- **Folder create**: `effective_access` is its own value, else its parent's.
- **Folder rename**: nothing; the path is not the structure.

Nested folders therefore inherit through any depth, a nearer folder's own value overrides
a farther one's, and an asset's own value overrides every folder.

### 4. Moving a file or a folder changes its effective value; deleting a folder never opens a file

**A move is an editor's explicit act**, so it recomputes: a file moved out of "Member
downloads" into "Press" takes Press's value, which may be public. The admin's move
confirmations (single and bulk) say how many files change from gated to public and
the reverse before the editor commits; the server does not refuse.

**A folder delete is tidying, not a decision about access** (`media-library.md` decision
14: "an organisational mistake must not be destructive"). Opening every file in a
members-only folder because somebody removed the folder is that mistake in the
disclosure direction. So `deleteFolder` gains two statements in its existing batch,
before the re-parent and the unfile:

- every asset filed directly in the folder with `access is null` gets `access =
  effective_access` (its inherited value becomes its own);
- every direct child folder with `access is null` gets `access = effective_access`.

Every effective value is then unchanged by the delete, by construction, and no purge is
needed. The cost is that re-creating the folder and re-filing those files leaves them with
an explicit value rather than "inherit"; the detail panel shows which, and an editor can
reset it to inherit.

**Rejected: let effective values fall to the grandparent's (possibly public) value.**
Fails open on a tidy-up. **Rejected: refuse to delete a gated folder while it holds
files.** Decision 14 rejected refusal for the same reason it rejected cascade.

### 5. The URL in the page is the stable asset URL; the gate is checked when that URL is requested

A page embeds and links `{base}/asset/:key` exactly as it does today, through
`Resolution.assetBase`. Published HTML is unchanged, stays cacheable, and is the same for
every visitor. The route decides, per request:

1. **No asset gating on the deployment** (`rt.assetGating` false): today's code, today's
   call, no D1 read. Nothing below runs.
2. **Read the row** (decision 3). No row (an R2 object with no library entry), no brand for
   its scope, a brand whose gate has no `allowsAsset`, an effective value of null, or one
   for which `isUngated` holds: `serveAsset` as today, with today's headers. No host call.
3. **Gated.** Admit in this order, cheapest first, stopping at the first yes:
   a. a valid signature on the URL (decision 9);
   b. a Folio credential that may read the asset's scope (decision 8);
   c. a share cookie whose story uses the file (decision 8);
   d. `gate.visitor(req, env)` then `gate.allowsAsset(visitor, value, ctx)`. Either
      throwing is logged (`folio: gate.visitor threw; denying asset`, `folio:
      gate.allowsAsset threw; denying`) and is a denial, spec 31 decision 7 unchanged.
4. **Granted**: the bytes, streamed by `serveAsset` in its private mode (decision 6).
   **Denied**: decision 7.

The brand is the asset's own scope's (`rt.forScope(await rt.sites.registry(env),
row.site_id)` on a branded deployment, the one brand otherwise), never the request's: the
route has no scope (`servesOnSite`, `index.tsx:471`), and a file is governed by the brand
that owns it. The registry read is the isolate's cached snapshot, not a D1 query per
request.

**Rejected: sign URLs at render, always.** The obvious design for "short-lived links" is
broken by the edge cache in two ways at once. A signature baked into a cached public page
is shared with every visitor who receives that copy, so it authorises strangers; and the
page is cached for `s-maxage=604800` (`cache-tags.ts:46`) while the signature expires in
minutes, so after the first few minutes every visitor, members included, gets a link that
no longer works. Signing at render is only sound for a response that is itself never
cached, which decision 9 provides as a host-called option rather than a default.

**Rejected: 302 a granted request to a short-lived signed URL** (an R2 presigned URL, or a
Folio-signed one). An R2 presigned URL needs S3 API credentials and an S3 endpoint, which
`assets.ts`'s header records the media library was designed to need neither of, and it
serves the object with R2's headers, so the sandbox CSP, `nosniff` and the
`content-disposition` rule (`assets.ts:942-950`) are lost on exactly the files most
likely to be documents. A Folio-signed redirect target costs a second round trip per
file and gains nothing a stream does not already give: the bytes are capped at 20 MB, the
Worker streams R2's body without buffering (`assets.ts:1025`), and the one case a redirect
helps, a client without the visitor's cookie, is decision 9's case and is served by
handing that client a signed URL directly.

### 6. A granted response is `private, no-store`, originals and variants alike; transforms run through the same gate and may reuse the Cache API only after it

`serveAsset` gains a final parameter, `mode: 'public' | 'private'`, default `'public'`.
`'public'` is byte-identical to today. `'private'`:

- every `cache-control` the function would have answered (`IMMUTABLE`, `DEGRADED`) is
  `NO_STORE` (`private, no-store`). Workers Caching stores neither, so a gated file is
  never written to the edge cache, original or variant;
- every other header (`nosniff`, CSP, `content-disposition`, `etag`) is unchanged;
- a transform reads and writes `caches.default` under a **separate key**: the canonical
  request with `__folio_private=1` appended to its query. The stored copy keeps
  `IMMUTABLE` (the Cache API will not store a `private` response) and the response
  returned to the client is rebuilt with `NO_STORE`.

The Cache API is safe to use here because it is reachable only through Worker code, and
in Folio's code the only path to these `cache.match` calls passes the gate first. The
separate key exists so a gated variant is never stored under a URL that a public request
for the same key would match, which keeps "a gated variant is in a public slot" impossible
even across a later gated-to-public-to-gated sequence. A public variant already in
`caches.default` from before the file was gated is never read for a gated request (the
private key differs) and costs nothing: the Cache API is per colo and expires on its own.

**Rejected: exclude gated images from the Images binding** (serve originals only). A
members-only photo gallery would then send 20 MB originals into `<img srcset>` on every
view. **Rejected: transform gated variants without any cache.** The admin's grid requests
`?w=320&f=webp` thumbnails (`AssetField.tsx:33-35`, `assets-model.ts`), so a library of
gated images would mint a billable Images transformation on every grid render, forever.

### 7. A denied visitor gets a bare `403`, or whatever the host's `gate.assetDenied` answers, and either is `private, no-store`

Default: status `403`, empty body, headers `cache-control: private, no-store`,
`x-content-type-options: nosniff` and the sandbox CSP. **403 rather than 404** because the
file's existence is not a secret this feature protects: the page that links it, its
filename in the link, and its metadata in `folio.query` are all public by design
(decision 13), and a 404 would only mislead a host's logs and a member whose session had
lapsed into thinking the file was deleted.

`gate.assetDenied(req, env, ctx)` lets the host turn a denial into a sign-in or purchase
page: typically `Response.redirect('/sign-in?next=' + encodeURIComponent(req.url), 302)`.
`ctx` carries the asset, its scope, the serving site and the value, so the redirect can
differ per tier ("buy Premium" for `premium`, "sign in" for `members`). Folio rebuilds
whatever it returns (a redirect's headers are immutable) with `cache-control: private,
no-store` forced, because the response varies by visitor. `null` or `undefined` falls
back to the 403. A throw is logged (`folio: gate.assetDenied threw`) and is the 403.
The handbook shows branching on `Sec-Fetch-Dest: image` so an `<img>` gets the 403 rather
than an HTML redirect it cannot render.

**Rejected: redirect to a Folio-configured URL** (`gate.signInUrl`). It cannot express
per-tier destinations or a host whose sign-in is not a URL, and it would be the second
config key in this feature that a function already covers.

### 8. Editors, preview origins and share links see gated files exactly as they see gated pages

Spec 31 decision 6 ("a Folio credential skips the gate") carried to the file route:

- **A resolved actor that may read the asset's scope** is granted: on a deployment with no
  `sites`, `allows(actor, READ)`; with `sites`, the actor's role in the asset's scope by
  `effectiveRole(actor.grants, registry, row.site_id)` (`auth/roles.ts:129`), or for a
  preview-grant actor `mayPreviewDrafts(actor, registry, site)` for the request's gated
  site **and** the asset's scope in `chain(registry, site)`. This is what makes the admin's
  own thumbnails, the inspector's previews and the `?_folio=preview` iframe render gated
  images. It does not need the draft cookie: unlike a page, a file has no draft to choose
  between, and the admin requests thumbnails with only its session cookie.
- **`auth: 'open'` with the draft cookie** is granted, mirroring `editorAdmits`
  (`index.tsx:1245-1250`).
- **A share cookie** is granted when, for one of its (at most five) tokens, a live share
  exists (`readShareByToken`, read only, no view stamped; site-fenced on a multi-site
  deployment) and `assetKeys(draftDoc, schema)` of that share's story includes the key.
  The draft is read through the brand's `draft()` (the `initDraft` path, never a direct
  `getOrInit`, per CLAUDE.md's invariant). A share therefore opens the files its own page
  uses and nothing else, which is the share's existing scope rule ("a share link covers one
  story") applied to files. Cost: one D1 read and one Durable Object read per gated file
  request from a reviewer, which is review traffic.

None of these requests can be cached: `cacheVerdictFor` already answers `bypass` for any
request carrying a Folio session, grant, draft or share cookie, and the response is
`private, no-store` regardless.

**Rejected: require draft mode for editors**, as pages do. The admin would then show broken
thumbnails for every gated image until the editor toggled draft mode, which is a mode about
*which version of a document* and has no meaning for a file.

### 9. Signed URLs are an opt-in credential the host mints for uncached responses; Folio never signs into a cacheable page

```ts
createFolio({ assetSigning: { keys: (env) => [env.ASSET_KEY_2026_11, env.ASSET_KEY_2026_05] } })

await folio.signAsset(env, src, { expiresIn: 300 })   // a host route: "download" → 302
page.signAsset(src, { expiresIn: 300 })               // inside a render, see below
```

A signed URL is the stable URL plus `exp` (Unix seconds) and `sig`:
`base64url(HMAC-SHA256(key, "folio-asset\n" + assetKey + "\n" + exp))`. It covers the key
and the expiry and **not** the transform query, so one signature serves every `srcFor`
variant of that file (each variant is still clamped by `parseTransform`). It is a fourth
credential at step 3a of decision 5: valid and unexpired is granted with no host call;
missing, malformed, expired or wrong falls through to steps b to d, so an expired link in
a member's browser still works on their cookie.

What it is for, concretely: a download manager, a mobile share sheet or an external PDF
viewer that re-fetches the URL without the visitor's cookie; an emailed "your purchase"
link; a headless front end on another origin whose visitor credential never reaches the
Folio Worker's host (the headless host shares the secret and implements the same five-line
HMAC, which the handbook documents).

- **`assetSigning` is deployment-level, not per brand.** Verification must not depend on
  which brand a key belongs to before the row is read, and `folio.signAsset` must not need
  a D1 read. It is a top-level key on both `FolioSingleConfig` and `FolioBrandedConfig`.
  `keys(env)` returns one or more secrets; the first signs and all verify, which is
  rotation: add the new key first, wait out the longest expiry, drop the old one. Each key
  must be at least 32 characters; a shorter one makes `signAsset` throw and the route treat
  every signature as invalid with one logged line (`env` is not available at construction,
  so this cannot be a construction error).
- **Lifetime**: `expiresIn` defaults to 300 seconds and is capped at 86 400. The cap bounds
  how long a leaked link is useful; a host that needs a long-lived download link mints a
  fresh one from its own route on each click.
- **A signed request is never edge-cached.** `cacheVerdictFor` answers `bypass` for an asset
  path carrying a `sig` parameter (the one change to that function; every other input
  answers what it answers today), and a signature-granted response is `private, no-store`
  like any grant. A signed URL in a shared cache would outlive its expiry, which is the
  failure decision 5 rejects render-time signing for. Signed responses also carry
  `referrer-policy: no-referrer`, so a PDF that links out does not hand the signature to
  the next site.
- **`page.signAsset`** is the render-time option, and it is safe by construction: it signs
  only when the `FolioPage` it hangs off answered `cache-control: private, no-store` (a
  gated page, a draft, a share, a page with uncacheable params). On a page whose headers are
  `cacheHeaders`, it returns `src` unchanged, so a host template that calls it everywhere
  degrades to the cookie-gated URL on public pages rather than baking a shared, expiring
  signature into the edge cache. Without `assetSigning` it returns `src` unchanged.
- **The describer.** For a gated file, `DescribeInput.url` is a five-minute signed URL when
  `assetSigning` is configured, and the plain URL otherwise (which a model provider will
  receive a 403 for; `inline()` is unaffected and is what the shipped Anthropic adapter
  uses).

**Rejected: R2 presigned URLs.** Decision 5's reasons, plus they cannot be verified by the
Worker, so steps b to d could not apply when one expires.

### 10. Gating a file purges its edge copies by path prefix, twice; the HTML that shows a lock is purged by tag

When an asset's effective value changes **from public to gated**, every copy in Workers
Caching (the original and every variant, under every site host and surface) must go, or the
edge keeps serving it for up to a year without consulting the Worker. Purge:

```ts
{ pathPrefixes: [`${base}/asset/${key}`] }
```

A prefix is a request path with no host and no query (Ground truth), so one entry reaches
every query-string variant and every site host's copy (the cache key carries no host).
No key is a prefix of another asset's key (Ground truth, `ASSET_KEY`), so the prefix
reaches only this file. **No `Cache-Tag` is added to asset responses**, so a public file's
response is unchanged on every deployment, gated or not, and copies cached before this
release are reached by the same purge.

**Twice**: once after the write commits, and again `SITE_PURGE_DELAY_MS` (25 s) later under
`waitUntil`. The asset route reads on a D1 session (`withBindings`, read replicas), so a
request racing the change can read the old public value on a replica, answer `IMMUTABLE`,
and be stored after the first purge. Multi-site decision 4 closes the same race for the
site registry with the same delay.

**The lock in page HTML** (decision 12) is visitor-independent but changes with the value,
so every effective-value change in **either direction** also purges `asset:<id>` (the pages
that rendered a lock for this file), and a change from public to gated additionally purges
`story:<id>` for each published story in `assetReferences(db, key)` (pages that embed or
link it and so far rendered no lock).

Batching reuses the purger's rule: entries (prefixes plus tags) in calls of at most
`MAX_TAGS_PER_PURGE`, and more than `MAX_PURGE_CALLS` calls becomes one `purgeEverything`
with the existing warning line. A folder change that gates 400 files is four calls; one
that gates 40 000 flushes. `PurgeIssued` gains a third arm, `{ tags, pathPrefixes }`, for
the hook payload.

**The entrypoint trap applies unchanged**: the purge is issued by whichever entrypoint
handled the admin, API or MCP write that changed the value. A host that already routes
writes through its cached entrypoint (the handbook's requirement since 2026-09-04) is
covered; one that does not leaves gated files' public copies at the edge. The handbook's
caching section says so beside the publish case.

**Rejected: tag every asset response `asset:<id>` and purge by tag.** It changes every
public asset response on every deployment (the acceptance criterion), and copies cached
before the release carry no tag and could not be reached at all. **Rejected:
`purgeEverything` on every gating.** Correct, and it throws away a whole site's cache to
protect one PDF.

What no purge reaches, stated in the handbook: a copy already in a visitor's browser
(`immutable`, a year) or in an intermediate proxy. Gating a file that was public is
effective from the edge inward.

### 11. The value is set through the same routes as every other asset field, and validated against the brand's gate field

- **Admin** (`{base}/api`, internal): `PATCH /assets/:id` accepts `access: <value> | null`
  (absent leaves it alone, `null` is inherit, decision 2). `PATCH /assets/folders/:id` and
  `POST /assets/folders` accept the same. `POST /assets` accepts `?access=`. A new bulk
  action, `POST /assets/bulk/access` with `{ selection, access }`, joins `tag`, `untag`,
  `move` and `delete`; `AssetBulkAction` gains `'access'`.
- **Content API** (`{base}/api/v1`, a contract, so additive only): `POST /assets` accepts
  `?access=`; **new** `PATCH /assets/:id` accepts `{ access?, alt?, description? }` at
  `assets:write` and answers the row. Folder ids and tag ids have no versioned routes
  (`media-library.md` decision 13), so `folderId` and `tags` stay admin-only.
- **MCP**: `upload_asset` gains an optional `access` argument (forwarded as `?access=`), and
  an eighteenth tool, `update_asset` (`PATCH /assets/:id`, `need: ASSETS`), takes `id`,
  `access`, `alt`, `description`.
- **`?access=` on an upload is typed by `gate.public`'s primitive**: a number gate parses it
  with `Number`, a boolean gate accepts `true` and `false`, a string gate takes it as is.
  `inherit` is not meaningful on an upload (a new file is unfiled), so an absent parameter
  is public.

Validation (`validateAccessValue` in `asset-access.ts`): the value must be the gate field's
primitive and, where any declaring root's field is a `select`, one of the options **every**
declaring root's `select` lists, so a file's value means the same thing whichever page type
links it. A text value is capped at 200 characters. An unknown value is `400 bad_request`
naming the allowed values. Setting `access` on a scope whose brand has no `allowsAsset` is
`400 unsupported` ("This site does not gate files"), the shape `describe` uses for an
unconfigured feature.

Every one of these writes reports its effective-value transitions to the purger
(decision 10) and to a new hook event, `assetAccessChanged`
(`{ assets: { id, key, scope, from, to }[], truncated, purge }`, at most 500 entries),
for a headless host that caches on an entrypoint of its own (multi-site decision 16's
precedent).

**Rejected: `access` on `AssetValue`** (copy it into the document at pick time). It would
be stale from the first change, which `media-library.md` decision 7 already argued for
tags, and the route would have to trust a document over the library.

### 12. `resolveAsset` and asset links expose the stored value of a gated file as `access`; the visitor's own verdict is never in the HTML

`Resolution` gains `gatedAssets?: Record<string, Json>`: for every library key the
resolution's documents reach, whose effective value is gated, that value. `ResolvedAsset`
and the `asset` arm of a resolved link gain `access?: Json`, present exactly when the key is
in that map. A host renders a lock, a "Members only" label or a "Premium" badge from it:

```tsx
const file = resolveAsset(blok.data.download, resolution)
<a href={file.src}>{file.access !== undefined ? '[Members] ' : ''}Download</a>
```

The value is the same for every visitor, so a public page's HTML stays cacheable and the
same for everyone. **Whether this visitor may open the file is never rendered by Folio**:
that would make the public page vary per visitor, which decision 5 of spec 31 showed a
shared cache cannot represent. A host that wants "Download" for members and "Buy" for
everyone else already renders a gated page (`private, no-store`) and calls its own
predicate there, or links to the file and lets `assetDenied` send non-members to the
purchase page.

**Where the values come from**: one statement, `select key, effective_access from assets
where key in (…) and effective_access is not null`, chunked by `bindChunks`, over
`assetKeys` of the document, `docs` and `globals`. It runs only when the brand's gate has
`allowsAsset` and the key set is non-empty, in the same `Promise.all` as pass four
(collections and option lists), so it adds no sequential round trip. The map is filtered
in JavaScript to values for which `isUngated` is false. Absent rather than `{}` when empty,
so a resolution with no gated files serialises byte for byte as today.

**Collection item documents are not walked**: their ids are only known when pass four
returns, so including them would add a sequential round trip to every collection page. A
card's thumbnail of a gated image therefore has no `access` (it is still gated at the
route). Stated in the handbook.

**Cache tags**: `cacheTags` adds `asset:<id>` (a new `assetTag` builder, the 16-character id
read off the key) for every key in `gatedAssets`. Decision 10 purges these. A public page
that renders no gated file carries no new tag, so the acceptance criterion holds for an
all-public library. The overflow rule is unchanged: a degraded tag set drops asset tags with
everything else, and such a page's lock is stale until its own next purge (it is cosmetic;
the route still decides).

**Rejected: tag every rendered asset id** (so a public-to-gated change purges by tag alone).
A 300-image gallery would spend a third of the tag budget on files that are all public,
and every page on a gated deployment would change its `Cache-Tag` header on upgrade. The
`content_refs` purge in decision 10 covers direct embeds and links; a gated file reached only
through a global or a referenced document shows its lock after that page's next purge.

### 13. Search, lists and metadata stay public; the gate protects the bytes

`folio.query`, `collection`, `{base}/api/v1/assets` and the admin's lists answer a gated
file's filename, alt text, description, dimensions and tags exactly as today. That is the
issue's position and spec 31's ("a denied page answers its metadata by design"). The
handbook's Assets and Visitor access sections say it in one sentence each.

Rows gain two fields, `access` and `effectiveAccess` (decoded JSON, null for inherit and
public respectively), **only when the scope's brand has `allowsAsset`**. A deployment
without asset gating answers rows without the keys, so its admin and v1 JSON are byte
identical, the precedent `Manifest.locales` and every optional `Resolution` key follow.
The manifest gains `assetAccess?: { field: string; public: string | number | boolean;
options?: { value: string; label: string }[] }` on the same condition, which is everything
the admin needs to draw the control.

### 14. The editor is warned about an embedded gated image on a public page, and not about a link

A gated **image in an `asset` or `multiasset` field** on a page whose own gate value is
public (or whose root does not declare the gate field) renders as a broken image for most
visitors. A gated file in a `multilink` or a richtext link, or a non-image in an asset
field, is a download offer, which is the legitimate case this spec exists for.

- **`check_document`** gains `gated-asset-embedded` (severity `warning`, `fix:
  'patch_fields'`, detail `{ key, access }`), computed in `targetFindings` from one
  `select key, effective_access from assets where key in (…)` over the document's
  image keys. Advisory, like every check (spec 40 decision 18). `isImageAsset` decides
  "image"; the field kind decides "embed".
- **The inspector**: `AssetCard` (`fields/AssetField.tsx`) shows a lock glyph on any gated
  file and, on a public page, a one-line warning under an embedded gated image ("Members
  only: most visitors will see a broken image"). Its data comes from one new internal
  route per open document, `GET {base}/api/assets/access?key=…` (repeated, at most 50,
  `READ`, the request's chain), answering `{ [key]: value }` for gated keys only.

**Rejected: refuse to publish.** A teaser page that shows a members-only cover image to
members (the host renders it inside a member check) is legitimate, and a check that blocks
it would be switched off.

## Wire & schema changes

### D1 migration `0019_asset_access.sql`

```sql
-- Visitor access for media library assets (docs/specs/platform/asset-access.md).
--
-- Four nullable columns, all additive. JSON text so the gate field's primitive
-- survives the round trip (decision 2). No index: the asset route reads by key, on
-- the unique index 0001 already has; the "gated only" filter is a scan, like every
-- other asset filter but folder and tag (0002, 0008).
--
-- own value; null = inherit from the folder
alter table assets add column access text;
-- what the route reads; null = public. Maintained by server/asset-access.ts.
alter table assets add column effective_access text;
-- own value; null = inherit from the parent folder
alter table asset_folders add column access text;
-- own ?? parent's effective
alter table asset_folders add column effective_access text;
```

Apply class: **before-deploy** (the Worker that carries it selects the columns). Every
existing row reads null, null: public, inheriting. No backfill and no reindex.

`upgrade-ledger.json`: `"0019_asset_access.sql": { "release": "<the release that carries
it>", "apply": "before-deploy" }`. `UPGRADING.md`: a ledger row and a `###` entry
(decision on rollback below).

**Rollback is not free, and the entry says so.** A Worker from before this release ignores
the columns and serves every gated file publicly, and its responses are `IMMUTABLE`, so a
rollback re-opens gated files at the edge for a year. Roll forward. A host that must roll
back first moves protected files out of the library (or deletes them), then rolls back.

### Core types

Additive throughout; no stored document or mutation log changes.

- `core/resolve.ts`: `Resolution.gatedAssets?: Record<string, Json>`;
  `ResolvedAsset.access?: Json`; the `asset` arm of `ResolvedLink` gains `access?: Json`.
- `core/cache-tags.ts`: `assetTag(id)` → `asset:<id>`.
- `core/assets.ts`: `AssetFilter.gated?: boolean`; `AssetBulkAction` adds `'access'`;
  `AssetFolder` gains `access?` and `effectiveAccess?`.
- `server/types.ts`: `FolioGate.allowsAsset?`, `FolioGate.assetDenied?`,
  `FolioAssetGateContext`, `FolioAssetDeniedContext`, `assetSigning?: { keys(env): readonly
  string[] }` on both config shapes, `FolioPage.signAsset(src, opts?)`,
  `Folio.signAsset(env, src, opts?)`, `HookPayloadMap.assetAccessChanged`.
- `server/cache-purge.ts`: `PurgeIssued` gains `{ tags: string[]; pathPrefixes: string[] }`.
- `Manifest.assetAccess?` (decision 13).

`folio/core` exports: `assetTag`. `folio/server` exports: the two context types.

### New or changed routes

| Method and path | Auth | Change |
| --- | --- | --- |
| `GET {base}/asset/:key` | none (gate) | decision 5. Gated and denied: `403` or `assetDenied`'s response; gated and granted: bytes, `private, no-store`. |
| `PATCH {base}/api/assets/:id` | `ASSETS`, fenced | body gains `access` |
| `POST {base}/api/assets` | `ASSETS` | `?access=` |
| `POST {base}/api/assets/folders` | `ASSETS` | body gains `access` |
| `PATCH {base}/api/assets/folders/:id` | `ASSETS`, fenced | body gains `access` |
| `POST {base}/api/assets/bulk/access` | `ASSETS` | new; `{ selection, access, continueFrom?, dryRun? }`, the other bulk routes' shape and report |
| `GET {base}/api/assets/access?key=` | `READ`, chain | new; `{ [key]: value }`; `400 unsupported` without asset gating |
| `GET {base}/api/assets?gated=1` | `READ` | new filter |
| `POST {base}/api/v1/assets` | `assets:write` | `?access=` |
| `PATCH {base}/api/v1/assets/:id` | `assets:write`, fenced | new; `{ access?, alt?, description? }` → the row; `404` unknown or outside the scope |
| MCP `upload_asset` | `ASSETS` | optional `access` |
| MCP `update_asset` | `ASSETS` | new, the eighteenth tool |

Every `access` input: absent leaves it alone; `null` inherits (`PATCH` and folders only);
a value is validated (decision 11). Errors: `400 bad_request` (wrong primitive, unknown
option, over 200 characters), `400 unsupported` (no asset gating for this scope).

## Acceptance criteria

### A deployment without asset gating is unchanged

```
GIVEN a deployment with no `gate`, or a `gate` with no `allowsAsset`
WHEN any asset is requested, original or transformed, GET or HEAD
THEN the response status, headers and body are byte-identical to v-current
AND the route issues no D1 query
AND every page's `FolioPage.headers`, `Resolution` and HTML are byte-identical
AND asset rows in admin and v1 JSON carry no `access` or `effectiveAccess` key
AND the manifest carries no `assetAccess` key
```

### Public files on a gated deployment are unchanged

```
GIVEN `allowsAsset` is configured and an asset's effective value is null or `gate.public`
WHEN it is requested
THEN the response is byte-identical to v-current, including `cache-control: public, max-age=31536000, immutable`
AND `visitor` and `allowsAsset` are not called
AND exactly one D1 statement was issued
```

### A gated file is never edge-cached and never served to a denied visitor

```
GIVEN an asset whose effective value is `members`
WHEN a request with no credential, no signature and a visitor `allowsAsset` refuses arrives, for the original or for `?w=320&f=webp`
THEN the status is 403 with an empty body and `cache-control: private, no-store`
AND R2 is not read and the Images binding is not called
WHEN `allowsAsset` grants
THEN the bytes are served with `cache-control: private, no-store` and the original's `nosniff`, CSP and `content-disposition`
AND a transformed variant is stored in `caches.default` only under the private key
```

### The host decides denial

```
GIVEN `assetDenied` returns a 302 to `/sign-in?next=…`
WHEN a denied visitor requests the file
THEN the response is that 302 with `cache-control: private, no-store`
GIVEN `assetDenied` throws, or returns null
THEN the response is the bare 403 and the throw is logged once
```

### Gating a public file purges its copies

```
GIVEN a public file with cached copies of the original and two variants
WHEN an editor sets it to `members`
THEN `cache.purge` is called with `pathPrefixes: ['/folio/asset/<key>']`, plus `asset:<id>` and the `story:` tags of its published referrers
AND the same purge is issued again 25 seconds later
AND the `assetAccessChanged` hook receives `{ from: null, to: 'members', purge }`
AND, against a staging deployment, all three copies MISS afterwards (cache-probe)
```

### Folders gate what they hold

```
GIVEN folder A (`members`) containing folder B (no value) containing file f (no value)
THEN f's effective value is `members`
WHEN B is set to `public`
THEN f's effective value is `public`, and no purge is issued for f's bytes
WHEN f is moved to the top level (Unfiled)
THEN f's effective value is null
WHEN A is deleted
THEN B's own value is unchanged, every file filed directly in A has its inherited value as its own, and no effective value changed
```

### Editors and reviewers see gated files

```
GIVEN a signed-in editor with READ on the asset's scope
WHEN the admin requests a gated thumbnail with only the session cookie
THEN it is served, `private, no-store`
GIVEN a share cookie for story S whose draft uses the file
THEN the file is served; for a story whose draft does not use it, the request falls through to the host's gate
```

### Signed URLs

```
GIVEN `assetSigning` is configured
WHEN `folio.signAsset(env, src, { expiresIn: 60 })` is requested without any cookie within 60 s
THEN it is served `private, no-store` with `referrer-policy: no-referrer`, and `cacheVerdict` answered `bypass`
WHEN it is requested after 61 s, or with one character of `sig` changed
THEN the host's gate decides, exactly as for the unsigned URL
GIVEN a public page (`cacheHeaders`)
WHEN the host calls `page.signAsset(src)`
THEN `src` is returned unchanged
```

### Editing and APIs

```
GIVEN asset gating is configured
THEN the media library shows a lock on gated files, filters to them, edits the value on a file and on a folder, and bulk-sets it
AND `POST /api/v1/assets?access=members` stores a file that is gated from its first byte served
AND `PATCH /api/v1/assets/:id` and MCP `update_asset` set and clear it
AND `check_document` reports `gated-asset-embedded` for a gated image in an `asset` field on a public page and nothing for the same file in a `multilink`
```

### Documentation

```
THEN the handbook's "Visitor access", "Assets", "Caching" and "Auth" sections describe this, and the Auth section's "stays public" sentence is replaced
```

## Implementation plan

Each phase leaves `pnpm typecheck`, `./node_modules/.bin/biome ci .` and `pnpm test` green
(gate on exit codes, per CLAUDE.md). Phases 1 to 3 are sequential. After phase 3, phases 4,
5 and 8 can run in parallel (they touch disjoint files except `types.ts`, which phase 1 has
already extended). Phase 6 needs 2; phase 7 needs 6; phase 9 is last.

### Phase 1: config, types and validation

1. `src/server/types.ts`: `allowsAsset?`, `assetDenied?` on `FolioGate` (as methods, for
   the bivariance argument at `types.ts:214-228`); `FolioAssetGateContext`,
   `FolioAssetDeniedContext`; `assetSigning?` on `FolioSingleConfig` and
   `FolioBrandedConfig` (not on `FolioBrand`); `FolioPage.signAsset`; `Folio.signAsset`;
   `HookPayloadMap.assetAccessChanged` and `FolioHooks.assetAccessChanged`.
2. `src/server/gate.ts`: the three refusals of decision 1; `ResolvedGate` gains
   `assets: AssetAccessDomain | null` (`{ primitive, options? }`, options the intersection of
   every declaring `select`'s values, with labels from the first declaration), null when
   `allowsAsset` is absent. A gate whose declarations share no `select` option except
   `public` is a construction error naming the roots.
3. `src/server/runtime.ts`: `FolioRuntime.assetGating` (any brand's `gate.assets` non-null).
4. `src/server/hooks.ts`: add `assetAccessChanged` to `HOOK_EVENTS` and the payload map.
5. Tests: `test/unit/server/gate.test.ts` (each refusal, the option intersection),
   `test/unit/server/pure.test.ts`'s `validateHooks` block (`assetAccessChanged` accepted).

### Phase 2: schema and the effective-value module

1. `migrations/0019_asset_access.sql` (the DDL above). Never edit after it lands.
2. `src/server/asset-access.ts` (new): `encodeAccess`/`decodeAccess` (JSON; an unreadable
   stored value decodes as a gated sentinel and logs once, fail closed);
   `validateAccessValue(domain, raw)`; `parseAccessQuery(domain, raw)`;
   `isPublicEffective(stored, gate)`; `setAssetAccess`; `recomputeFolderSubtree(db, folderId,
   site)`; `assetAccessByKey(db, key)` (the route's one statement); `gatedValues(db, keys)`
   (chunked, for resolve, checks and the inspector route). Every write returns its
   transitions `{ id, key, scope, from, to }`, capped at 501 rows read so the caller knows
   when to flush.
3. Wire it in, so no write bypasses it:
   - `assets.ts`: `AssetRow` gains `access`, `effectiveAccess` (raw JSON strings internally);
     `COLS` selects them; `uploadAsset` takes `access?` and inserts both columns;
     `updateAsset` takes `patch.access` and recomputes on `folderId` change; `AssetPatch`
     gains `access`; `assetFilterSql` gains `gated` (`effective_access is not null and
     effective_access <> ?`, binding the encoded public value).
   - `asset-folders.ts`: `createFolder` sets both columns; `updateFolder` handles
     `patch.access` and recomputes the subtree on a parent change; `deleteFolder` adds
     decision 4's two materialising statements to its batch, ahead of the re-parent.
   - `asset-bulk.ts`: the `move` statement of decision 3; a new `access` action
     (validated once before the walk, like `move`'s folder).
   - `validate.ts`: `AssetPatchBody`, `AssetFolderCreateBody`, `AssetFolderPatchBody`
     gain `access: v.optional(v.nullable(scalar))`; the domain check is
     `validateAccessValue`'s, after parsing, because it needs the brand.
4. A row presenter, `presentAssetRows(rows, domain | null)`, decoding the two fields when
   the scope's brand gates assets and deleting them otherwise. Every route answering rows
   uses it (`routes/assets.ts` list, get, patch, upload; `routes/api/index.ts` list and
   upload).
5. Tests: `test/workers/migrations.test.ts` (the four columns exist and default null; no new
   index); `test/workers/asset-access.test.ts` (new): inheritance through three levels,
   override, move in and out, folder move, folder delete materialises and changes no
   effective value, bulk move and bulk access, the fixed-bind subtree statement over a
   folder of 600 files, transitions reported; `test/workers/assets.test.ts`: rows carry no
   access keys without asset gating.

### Phase 3: the route

1. `src/server/assets.ts`: `serveAsset(…, mode = 'public')` per decision 6. The `'public'`
   path must not change by a byte; refactor by adding a header-mapping step at the three
   `new Response` sites and the `cache.match` return, rather than editing their bodies.
2. `src/server/routes/assets.ts`: `assetFileRoutes` implements decision 5. Keep today's
   call as the first branch, verbatim, under `if (!rt.assetGating)`. The admission order is
   one function, `admitAsset(c, rt, row, brand)`, in a new `src/server/asset-gate.ts`, which
   also builds the denial (decision 7) and owns the three log lines. Signature verification
   is stubbed to "absent" until phase 8.
3. Credential admission (decision 8): `c.var.actor` from `withActor`; `effectiveRole` and
   `mayPreviewDrafts` from `auth/roles.ts`; shares through `readShareByToken` and
   `brand.draft(bindings, storyId, registry)` then `assetKeys`.
4. Correct the stale comments at `middleware.ts:52` and `cache-request.ts:96-99` (the route
   reads no row without asset gating, one with it).
5. Tests: `test/workers/asset-gate.test.ts` (new), with a test gate whose `visitor` reads a
   header: public bytes and headers identical to a no-gate run (snapshot both); gated
   denied 403 empty no-store, R2 and Images not touched (a proxy on the bucket and the
   binding); granted no-store with original headers; variant cached under the private key
   only (inspect `caches.default` in workerd); `visitor` throws, `allowsAsset` throws,
   `assetDenied` throws, returns null, returns a redirect (headers forced); editor session
   granted, viewer in another scope refused on a multi-site fixture; share for a story using
   the file granted, for one that does not falls through, and no view stamped;
   branded fixture: the asset's brand's gate is used, not another brand's.
   `test/workers/single-site-pin.test.ts` gains a no-gate asset response pin.

### Phase 4: purge and the hook

1. `src/server/cache-purge.ts`: export a `purgeAssetChange(capability, base, transitions,
   referrers, logger)` that builds prefixes and tags per decision 10, batches with
   `purgePlan`'s rule extended to count prefixes, and answers `PurgeIssued`. Reuse
   `platformPurge`; never hold the capability (trap 1).
2. Call it from every write in phase 2's list through one helper in `asset-access.ts`
   (`afterAccessChange(c, transitions)`), which awaits the first purge, schedules the second
   with `c.executionCtx.waitUntil` after `SITE_PURGE_DELAY_MS`, reads `assetReferences` for
   public-to-gated keys (skipped when over 500 transitions, which flushes), and runs the
   `assetAccessChanged` hook with the issued purge.
3. Tests: `test/unit/server/cache-purge.test.ts` with an injected capability: one gating
   gives one call with the prefix, the id tag and the referrer tags; gated-to-public gives
   the id tag and no prefix; 600 transitions flush; absent capability returns the plan and
   issues nothing. `test/workers/asset-access.test.ts`: the hook payload and the delayed
   second call (fake timers or an injected delay).

### Phase 5: resolve, tags and checks (parallel with 4 and 8)

1. `src/core/resolve.ts`: `Resolution.gatedAssets`, `ResolvedAsset.access`, the link arm;
   `decorateAsset` reads the map.
2. `src/server/runtime.ts`: the lookup of decision 12 inside the pass-four `Promise.all`,
   only when `brand.gate?.assets`; the key absent when empty.
3. `src/core/cache-tags.ts`: `assetTag`; `cacheTags` adds one per `gatedAssets` key.
4. `src/server/checks.ts`: `gated-asset-embedded` in `targetFindings`.
5. Tests: `test/unit/core/resolve.test.ts` (access present only for gated keys, links too);
   `test/unit/core/cache-tags.test.ts` (tags only for gated keys; a resolution without
   `gatedAssets` produces the identical sorted string); `test/workers/read-session.test.ts`
   pattern for the query count (one more statement only when a gated deployment's page has
   asset keys, issued concurrently with collections); `test/workers/checks.test.ts` (image
   in `asset` warns, the same file in `multilink` does not, a gated page does not).

### Phase 6: APIs and MCP

1. `src/server/routes/assets.ts`: `access` on the patch, upload and folder routes; the bulk
   `access` route; `GET /assets/access` (registered before `/assets/:id`, which would
   otherwise match `access` as an id, the same ordering note as `/assets/folders`); the
   `gated` filter.
2. `src/server/routes/api/index.ts`: `?access=` on upload; `PATCH /assets/:id` with
   `fenceRow(rt, 'write', assetSiteOf, 'asset')` and `requireAccess(rt, ASSETS)`.
3. `src/server/mcp/tools.ts`: `access` on `upload_asset` (`query: ['filename', 'access']`);
   `update_asset`. `test/unit/mcp/tools.test.ts`: count 18.
4. Tests: `test/workers/scope-partition.test.ts` fence tests for `PATCH /api/v1/assets/:id`
   and `GET /api/assets/access` (it fails until they exist); `api-partition.test.ts`
   accepts the new v1 route; `test/workers/mcp.test.ts` upload with access and update;
   `scripts/api-test.mjs` and `scripts/mcp-test.mjs` extended.

### Phase 7: admin

1. `src/core/schema.ts` `Manifest.assetAccess?` and its builder in `core/block.ts`
   `toManifest` (only when the brand gates assets).
2. `src/admin/ui/screens/assets-model.ts`: decode `access`/`effectiveAccess`; a `gated`
   filter; the bulk action; move-confirmation counts (gated to public and public to gated)
   computed from the selection's rows and the destination folder's effective value.
3. `AssetBrowser.tsx` and `Assets.module.css`: lock glyph on gated tiles and rows; the
   "Gated" filter; "Set access" in the bulk bar; folder access in the folder edit dialog
   with "Inherit (Members, from Member downloads)" as the label of the null option.
4. `AssetDetail.tsx`: an access control, the same option list, the inherited source shown.
5. `fields/AssetField.tsx` and `Inspector.tsx`: decision 14's lock and warning, from one
   `GET {base}/api/assets/access` request per open document's asset keys, refetched when
   the key set changes.
6. Portals and dialogs reuse `useFocusTrap` and `scoped()` (CLAUDE.md invariants); no
   hand-rolled trap.
7. Tests: `test/unit/admin/` model tests for decode, filter, move counts; `scripts/media-library-test.mjs`
   extended for the routes the screen calls. A browser review on the demo before merge (the
   lock and the warning are UI-review findings no test can catch).

### Phase 8: signed URLs (parallel with 4 and 5)

1. `src/server/asset-signing.ts` (new): `signAssetUrl(keys, src, expiresIn, now)` and
   `verifyAssetSignature(keys, assetKey, exp, sig, now)` over `crypto.subtle` HMAC-SHA256,
   base64url, `crypto.subtle.verify` for the comparison; the 32-character and 86 400-second
   rules.
2. `src/server/asset-gate.ts`: step 3a; signed responses add `referrer-policy: no-referrer`.
3. `src/server/cache-request.ts`: `bypass` for an asset path with a `sig` parameter, placed
   above the asset `cache` line.
4. `src/server/index.tsx`: `folio.signAsset`; `FolioPage.signAsset` in `pageOf`, closed over
   whether `headers['cache-control'] === NO_STORE`.
5. `src/server/describe.ts`: `describeUrl` signs for a gated file when `assetSigning` is
   configured (the row's effective value is already in hand).
6. Tests: `test/unit/server/asset-signing.test.ts` (round trip, expiry, tamper on key, exp
   and sig, rotation verifies with the second key, short key throws);
   `test/unit/server/cache-request.test.ts` (sig bypasses, no-sig unchanged);
   `test/workers/asset-gate.test.ts` (signed granted with no cookie, expired falls through to
   the host); `test/workers/gate.test.ts` (`page.signAsset` on a public page returns `src`,
   on a gated page signs).

### Phase 9: demo, documentation, end to end, staging

1. `examples/demo/src/index.tsx`: `allowsAsset: (visitor) => visitor !== null` and an
   `assetDenied` redirecting to the demo's members page; `assetSigning` with a constant
   dev-only key carrying the same "this is not how you do it" comment as `demo_member`.
   `examples/starter` is not changed: it has no `gate`.
2. `scripts/asset-access-test.mjs` (new; reads `FOLIO_E2E_BASE`, signs in with
   `signInGlobally()`): upload with access, fetch as stranger (403) and as `demo_member`
   (bytes, no-store), fetch a variant, gate a folder and check an inherited file, delete the
   folder and check it stays gated, signed URL with no cookie. The sweep's count in
   CLAUDE.md goes from 26 to 27.
3. `scripts/cache-probe.mjs`: an `--asset <key>` mode: warm the original and `?w=320`,
   gate the file through the admin API, assert both MISS within 15 s and still MISS after
   30 s, then restore. **Run against a consumer's staging deployment before tagging**; it is
   the only check of decision 10's prefix semantics (Workers Caching is not simulated
   locally). If a variant survives the prefix purge, the purge for an asset change becomes
   `purgeEverything` (one constant in `cache-purge.ts`) and the handbook says why.
4. Docs: `docs/handbook.md` "Visitor access" (a section on files), "Assets" (access values,
   folders, metadata stays public), "Caching" (the asset purge and the entrypoint rule),
   "Auth" (replace the "stays public" sentence at line 3829), "Content API", "An MCP server";
   `docs/configuration.md` (`gate.allowsAsset`, `gate.assetDenied`, `assetSigning`);
   `AGENTS.md` (setting access on upload); `UPGRADING.md` (ledger row, the `###` entry with
   apply order and the rollback warning); `upgrade-ledger.json`; `CHANGELOG.md`;
   `docs/specs/README.md` (row 43, the migration ledger, "next free is `0020`");
   `CLAUDE.md` ("The two ledgers": `0019`, next free `0020`; MCP tools eighteen; two new
   invariants below); `ROADMAP.md` if it lists file gating.
5. New invariants for `CLAUDE.md`:
   - **The asset route's gate precedes every cache read**, and a gated asset never answers a
     `public` cache-control: `serveAsset`'s private mode is the only way bytes of a gated
     file leave the Worker.
   - **Every write that changes an asset's `folder_id` or `access`, or a folder's `access`
     or `parent_id`, goes through `asset-access.ts`**, which recomputes `effective_access`
     and reports transitions to the purger. A fifth write path that sets `folder_id`
     directly leaves a stale effective value, and the route reads only that column.

## Edge cases

- **A file is gated, then made public again** → no prefix purge (nothing was cached while
  gated); `asset:<id>` purged so pages drop the lock. The `caches.default` private-key
  variants are never read for a public request.
- **The value changes from `members` to `premium`** → no prefix purge; `asset:<id>` purged so
  a badge updates.
- **An R2 object with no `assets` row** → served as today: there is no value to read, and
  only library files can be gated.
- **A gated file referenced by a page on another brand** → cannot happen through the picker
  (chains never cross a brand); an imported key would be served under the owning brand's
  gate, which is the right owner.
- **A file in the `shared` scope on a branded deployment** → `forScope` answers null, no
  gate applies, and setting `access` is `400 unsupported` for that scope.
- **The stored value is unreadable JSON** → treated as gated (fail closed), logged once per
  isolate per key; the host's `allowsAsset` receives `undefined` as the value.
- **`gate.public` is renamed in config** → files whose stored value is the old public value
  become gated, as pages do; the handbook's upgrade note for the gate says to rewrite both.
- **HEAD on a gated file** → the same admission; the response is the same headers with no
  body, `private, no-store`.
- **Range requests** (PDF viewers, download managers) → answered with a full `200`, as for
  every asset today; for a public file Cloudflare serves ranges from its cached copy, for a
  gated one the client takes the whole file (at most 20 MB).
- **Replica lag past 25 seconds** → a public copy can be stored after the second purge and
  served until the next purge of that prefix. This is the residual window of decision 10;
  the probe in phase 9 measures it on staging. Setting the file public and gating it again
  issues the prefix purge again.
- **A signed URL for a file that is public** → served as a public file (the signature is
  never consulted), but with `bypass` from `cacheVerdict`, so it is not stored under the
  signed key.
- **Two tabs, one gates a folder while the other uploads into it** → the upload inserts
  unfiled; a later move into the folder recomputes. No upload is ever filed by the route.
- **A folder delete whose children already had their own values** → only null values are
  materialised; explicit values are untouched.
- **Bulk access on a selection of 40 000 files** → the walk's batching applies; each batch
  purges its own transitions and a batch over the threshold flushes once.
- **The editor's session expires while the admin is open** → thumbnails of gated files go to
  403 like every other admin request goes to 401; the admin's sign-in redirect handles it.
- **Form uploads (`sub_` keys)** → unaffected: `ASSET_KEY` refuses them on this route and
  `form-responses.ts` serves them on its own authenticated route.

## Testing requirements

**Unit (`test/unit/`):**
- `server/gate.test.ts`: construction refusals; the option intersection.
- `server/cache-request.test.ts`: `sig` bypass; every existing case unchanged.
- `server/cache-purge.test.ts`: the asset plan, directions, batching, flush, absent capability.
- `server/asset-signing.test.ts`: sign, verify, expiry, tamper, rotation, short key.
- `core/resolve.test.ts`, `core/cache-tags.test.ts`: `access` and `asset:` only for gated keys.
- `mcp/tools.test.ts`: eighteen tools; `update_asset`'s schema.
- `admin/`: model decode, filter, move-confirmation counts.

**Workers (`test/workers/`, real workerd):**
- `asset-access.test.ts` (new): inheritance, overrides, moves, folder delete, bulk, fixed binds, transitions, hook.
- `asset-gate.test.ts` (new): the route matrix in phase 3, private-key Cache API use, signed URLs.
- `migrations.test.ts`: the four columns, no new index.
- `single-site-pin.test.ts`: a no-gate asset response and a no-gate page render pinned.
- `assets.test.ts`, `asset-folders.test.ts`, `asset-bulk.test.ts`: existing suites pass unchanged on a no-gate config.
- `scope-partition.test.ts`, `api-partition.test.ts`: the new routes.
- `checks.test.ts`, `mcp.test.ts`, `gate.test.ts` (`page.signAsset`).
- A query-count test in `read-session.test.ts`'s style: zero D1 statements on the asset route without asset gating, one with it for a public file.

**End to end (`scripts/*-test.mjs` against a live dev server):**
- `scripts/asset-access-test.mjs` (new), per phase 9.
- `scripts/api-test.mjs`, `scripts/mcp-test.mjs`, `scripts/media-library-test.mjs` extended.

**Against a deployment (a tool, never CI):**
- `scripts/cache-probe.mjs --asset`, on a consumer's staging deployment, before the release tag.

## Dependencies

- Spec 31 (`gate`, `visitor`, `isUngated`, `ResolvedGate`), spec 32 (folders, bulk walk,
  `content_refs` asset edges), spec 17 (the purger and its batching rule), spec 21 (shares),
  spec 23 (scopes, chains, preview grants, `servesOnSite`), spec 34 (per-brand gate,
  `forScope`), spec 40 (`check_document`), spec 24 (MCP tool table).
- Cloudflare: Workers Caching with `pathPrefixes` purge on the cached entrypoint (a host that
  caches assets already has it); the Images binding is unchanged. No new binding. A host
  using signed URLs adds one or two secrets (`wrangler secret put`).
- Host: `gate.allowsAsset` (required to turn this on), optionally `gate.assetDenied` and
  `assetSigning`. Writes routed through the cached entrypoint (already required).

## Out of scope

- **Range requests on the asset route.** Absent today for every file; adding them is
  independent of gating and would change public responses too.
- **Hiding a gated file's metadata** from lists, search and `folio.query`. The gate protects
  bytes (decision 13); a host that needs a filename hidden names the file accordingly.
- **Per-visitor rendering of "can open / cannot open"** in Folio's output. Decision 12.
- **Evicting copies already in browsers or proxies** when a public file is gated. Not
  reachable by any purge (decision 10).
- **Gating by tag.** Folders are the inheritance structure; a tag is a filter
  (`media-library.md` decision 2), and two inheritance sources would need a precedence rule
  nobody asked for.
- **Scheduled access changes** ("public from 1 March"). The scheduler acts on documents; a
  host can call the v1 `PATCH` from its own cron.
- **`access` on collection item cards** (decision 12's stated limit).
- **R2 presigned URLs** (decisions 5 and 9).
