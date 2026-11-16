# Feature: Visitor access for media library assets

> **Group:** platform
> **Build order:** 43
> **Size:** L
> **Status:** draft
> **Wire version:** none. Nothing here crosses the socket or the admin↔preview bridge; `PROTOCOL_VERSION` stays where spec 39 leaves it.
> **Migration:** `0019_asset_access.sql` (claimed). `0018` is spec 39's claim (`editing/agent-suggestions.md`). If this spec builds first, it still takes `0019`: the two are independent, additive files, and wrangler applies whatever is unapplied by filename, so a database that takes `0019` first takes `0018` later exactly as `0013` was taken before `0012`.
> **Build sequence:** after 31 (visitor access), 32 (media library), 17 (caching), 21 (draft sharing), 23 (multi-site) and 34 (multi-brand), all done. Independent of 39 and 42; shares no source file with 39 except `CLAUDE.md` and the ledgers.
> **Release:** v1.6.0.
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
  `/asset/*` with no `~scope` segment is served, so on every site host the asset route
  runs with `c.var.scope === null`. On a multi-site **admin** origin,
  `{base}/~<scope>/asset/:key` also reaches the app with the scope header set
  (`handleSites`, the `routed.kind === "admin"` branch); `cacheVerdictFor` answers
  `bypass` for that path, because it is under `{base}/~…` rather than `{base}/asset/`.
  The request scope is therefore not a fact the asset route may assume either way.
- `app.ts:83-97`: `withBindings`, `withScope` and `withActor` run for every request,
  the asset route included. `withActor` (`middleware.ts:382-407`) resolves an actor from
  any presented credential (session cookie, bearer token, preview grant); with no
  credential `c.var.actor` is null.
- `index.tsx:488-495` `framedBy` never replaces a CSP a route set, which is why the
  sandbox CSP survives on a preview origin.
- `cache-purge.ts:94-101` `platformPurge` dereferences `cache` from `cloudflare:workers`
  per call and answers null when the capability is absent. `MAX_TAGS_PER_PURGE = 100`
  (line 59), `MAX_PURGE_CALLS = 5` (line 71), `SITE_PURGE_DELAY_MS = 25_000` (line 108,
  sized for the 10-second isolate registry snapshot, `cache-purge.ts:104-107`; it says
  nothing about D1 replica lag, for which D1 publishes no bound).
- `cache-purge.ts:260-272` and `:429-430`: a purge answering `success: false`, or one that
  throws, is logged with `logger.error` and dropped. Nothing records it and nothing retries
  it; for a page that is a stale page until the next publish of the same story.
- Cloudflare's purge documentation (developers.cloudflare.com/workers/cache/purge/ and
  cache/how-to/purge-cache/, read 2026-11-16): Workers Caching purges run under the Free
  plan's limits whatever the account's plan, 5 requests a minute with a bucket of 25,
  shared with every other purge the deployment issues, page publishes included.
- `CachePurgeOptions` (`@cloudflare/workers-types`, `index.d.ts:606-610`) is
  `{ tags?, pathPrefixes?, purgeEverything? }`. Cloudflare's purge documentation
  (developers.cloudflare.com/workers/cache/purge/, read 2026-11-16): entries in
  `pathPrefixes` are request paths with no scheme, host, query string or fragment; `tags`
  and `pathPrefixes` in one call are unioned; every mode is scoped to the entrypoint
  that called it. Nothing in this repository uses `pathPrefixes` yet.
- The Workers Caching key is path and query, entrypoint, `ctx.props` and the Worker
  version (`caching.md`'s multi-site addendum; Cloudflare's workers/cache/cache-keys/).
  **The host is in the key on every deployment that follows the handbook**: the documented
  gateway (`docs/handbook.md:3555-3559`, `docs/configuration.md:920`, `AGENTS.md:310`)
  passes `cf: { cacheKey: folio.cacheKey(req.url) }`, `cacheKeyFor`
  (`cache-request.ts:65-76`) returns a full URL with scheme and host, and Cloudflare: a
  `cf.cacheKey` "replaces the path and query string in the key". So one file has a
  separate entry per site host, per surface (`ctx.props`), and per Worker version.
  Cloudflare documents `pathPrefixes` as matching the request path and says nothing about
  entries stored under a custom `cf.cacheKey` or about `ctx.props` variants. A tag purge
  reaches every props variant (`caching.md`'s addendum: "a tag purge reaches every props
  variant, so one purge clears both surfaces").
- `docs/handbook.md:3710`: "A deploy invalidates everything, because the Worker version is
  part of the cache key." A new version never serves an entry an older version stored,
  unless the host has opted into sharing the cache across versions (Cloudflare's
  cache-keys page). Which versions a purge reaches during a gradual deployment is not
  documented.

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
- `index.tsx:1416-1424`: a page answers `NO_STORE` (`core/cache-tags.ts:49`,
  `"private, no-store"`) when it is drafted, when `access` is `granted` **or `denied`**,
  when it was given `params` without `cacheable`, or when an option list was unavailable;
  otherwise `cacheHeaders`. `no-store` therefore says "this response varied", never "this
  visitor is entitled".
- `auth/roles.ts`: an `Actor` is one of three kinds. `user` carries `role` and optional
  `grants` (absent outside a multi-site deployment); `token` carries `scopes` and a bound
  `site`, and no `grants`; `grant` (a preview grant) carries one `site`.
  `effectiveRole(grants, registry, scope)` (line 129) reads `grants`, so it cannot be
  handed a token. `tokenScopesOn(scopes, site, registry, scope)` (line 167) is a token's
  scopes in a given scope. `mayPreviewDrafts` (line 290) falls back to
  `{ [ALL_SCOPES]: actor.role }` for a user with no `grants`.
- `scheduler.ts:139-166`: `runSchedules`' report already carries a second, durable work
  queue, the form delivery pass (`form-actions.md` decision 12), drained by the host's cron
  through the cached entrypoint (`docs/handbook.md:3234`).
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
- `assets.ts:813-840` `deleteAsset` commits the D1 delete, then deletes the R2 object and
  swallows a failure there, so an orphaned object with no row is a real state.
- `admin/hooks/useUpload.ts:11`: the admin's upload posts `?filename=` and nothing else,
  so every file uploaded from the admin lands unfiled whatever folder the editor is
  browsing.
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
- `describe.ts:245-252` `describeUrl` (used at `:432`) hands a model provider an absolute
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
**As** an editor **I want to** mark the "Member downloads" folder members-only, and have
every file I upload while browsing it, or move into it, inherit that **so that** I do not
have to remember per file.

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

**Rejected: call the existing `allows` with a widened `ctx`.** `FolioGateContext.story`
and `.doc` are required today, and a host's `allows` is written against them
(`ctx.story.type === 'report'`). Making `ctx` a union is a type-narrowing change to a
contract the host implements, so a host compiled against `1.x` reads `ctx.story.type` off
an asset context, throws, is logged as "`gate.allows` threw; denying", and every gated
file is refused with no compile error to say why. Under semver that is `2.0.0` for a
feature that can be additive. An optional method is a minor.

**Rejected: gate assets whenever `gate` is configured.** Every deployment that gates pages
today would start reading a D1 row on every asset miss the day it upgrades, for a feature
it has not adopted. Opt-in keeps the acceptance criterion literal: without `allowsAsset`,
nothing in this spec runs.

`validateGate` (`server/gate.ts`) gains three refusals at construction, following spec 31
decision 8 ("a key that reads as a constraint and enforces nothing throws"):
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
this column and must stay public; a page type that declares the gate field is an editor's
statement that the type is gated, whereas an asset row with no value is a file nobody has
said anything about. **Rejected: write `gate.public` into every existing row.** It couples
stored data to a config value a host may rename, and a rename would then gate the whole
library.

A stored value is validated on every write against the brand's gate field (decision 11).
If a host later removes `allowsAsset` from a brand that still resolves, stored values
become inert and every file of that brand is served as today, the same fail-open spec 31
has for removing `gate` from a page site. That is the only fail-open: a file whose scope
resolves to **no brand** is decision 5's denial, not this. If a host changes
`gate.public`, assets whose stored value is the old public value become gated, matching
pages.

### 3. A folder carries an access value; assets inherit it; the effective value is denormalised onto both tables and always derived from own values

```
assets.access                  own value, JSON, null = inherit from folder
assets.effective_access        what the route reads, JSON, null = public
asset_folders.access           own value, JSON, null = inherit from ancestors
asset_folders.effective_access the nearest own value on the folder or an ancestor
```

**The route stays one indexed lookup**: `select id, site_id, folder_id, filename,
content_type, size, access, effective_access from assets where key = ?`, on the unique
key's index. `access` is read only to fill `ctx.inherited`.

**Rejected: inherit at read through the folder chain.** The ancestors of a folder are the
folders whose `path` is a prefix of its own, which with a materialised path is computable
but not indexable from the asset side: either a second round trip (asset row, then
`path in (…)` for its ancestors) or a join on a range over another row's column, which
SQLite answers by scanning the site's folders. The asset route is the highest-volume
Folio path; it gets one point read. The cost moves to folder writes, which are rare,
editor-driven and already rewrite subtrees (`updateFolder`).

**Maintenance is one module**, `src/server/asset-access.ts`, and every write that changes
an asset's `folder_id` or `access`, or a folder's `access` or `parent_id`, goes through it.
Every statement is set-based and reads **own** values, never another row's effective value
computed earlier in JavaScript, so two concurrent edits converge whichever commits first:

- **A folder's effective value** is computed in SQL from the own values along its path:

  ```sql
  update asset_folders
     set effective_access = (
       select a.access from asset_folders a
        where a.site_id = asset_folders.site_id and a.access is not null
          and (a.path = asset_folders.path
               or substr(asset_folders.path, 1, length(a.path) + 1) = a.path || '/')
        order by length(a.path) desc limit 1)
   where site_id = ? and <subtreeWhere('path', ?)>
  ```

  One statement over the changed or moved folder's subtree, fixed binds whatever its size
  (`asset-folders.ts`'s rule against caller-sized bind lists). The correlated subquery
  scans the site's folders once per subtree row; folders number in the hundreds and are
  written by hand.
- **The assets under it**, in the same `db.batch` (one transaction) and after the folder
  statement: `update assets set effective_access = coalesce(access, (select
  f.effective_access from asset_folders f where f.id = assets.folder_id)) where site_id = ?
  and folder_id in (select id from asset_folders where site_id = ? and <subtreeWhere>)`.
- **One asset's own value or folder** is a separate statement **after** the write that sets
  `folder_id`, binding the destination folder id explicitly: `update assets set
  effective_access = coalesce(access, (select effective_access from asset_folders where
  id = ?)) where id = ? and site_id = ?`. Never folded into `updateAsset`'s single `update`:
  SQLite evaluates every `set` expression against the row as it was before the statement,
  so a correlated `assets.folder_id` there reads the folder the file is leaving. The bulk
  `move` binds the destination the same way.
- **Folder create** runs the folder statement for the new row; **rename** recomputes the
  renamed subtree (a rename rewrites `path`, which the derivation reads).

Why this converges: editor 1 sets folder A to `members` while editor 2 moves public folder
C under A. If editor 2's batch commits first, C's path is under A's and editor 1's batch
selects its subtree by path at commit time, so C is recomputed from A's new own value. If
editor 1's commits first, editor 2's recompute of C reads A's own value, already `members`.
**Rejected: read the subtree, compute top-down in JavaScript, write per folder.** The read
and the write are different transactions, so a folder moved in between keeps the value
computed from a stale ancestor, with nothing to correct it.

Nested folders therefore inherit through any depth, a nearer folder's own value overrides
a farther one's, and an asset's own value overrides every folder.

### 4. Moving a file or a folder changes its effective value; deleting a folder never opens a file

**A move is an editor's explicit act**, so it recomputes: a file moved out of "Member
downloads" into "Press" takes Press's value, which may be public. The admin's move
confirmations (single and bulk) say how many files change from gated to public and the
reverse before the editor commits; the server does not refuse.

**A folder delete is tidying, not a decision about access** (`media-library.md` decision
14: an organisational mistake must not be destructive). Opening every file in a
members-only folder because somebody removed the folder is that mistake in the disclosure
direction. So `deleteFolder` gains two statements in its existing batch, before the
re-parent and the unfile:

- every asset filed directly in the folder with `access is null` gets `access =
  effective_access` (its inherited value becomes its own);
- every direct child folder with `access is null` gets `access = effective_access`.

Every effective value is then unchanged by the delete, by construction, and no purge is
needed. Re-creating the folder and re-filing those files leaves them with an explicit value
rather than "inherit"; the detail panel shows which, and an editor can reset it.

**Rejected: let effective values fall to the grandparent's (possibly public) value.**
Fails open on a tidy-up. **Rejected: refuse to delete a gated folder while it holds
files.** Decision 14 rejected refusal for the same reason it rejected cascade.

**An upload made while browsing a folder is filed in it.** The admin's `POST
{base}/api/assets` accepts `?folderId=`, and the Assets screen sends the folder the editor
has open; `uploadAsset` inserts `folder_id` and the inherited `effective_access` in the
one `insert`, so the file is gated from its first byte served. **Rejected: keep uploads
unfiled and rely on the editor filing them.** Until they do, a file uploaded "into" Member
downloads and linked from a gated page is public, and a forwarded link works, which is the
threat this feature exists for. The inspector's upload (`AssetField`) has no folder in view
and stays unfiled; the Content API takes `?access=` instead (decision 11).

### 5. The URL in the page is the stable asset URL; the gate is checked when that URL is requested

A page embeds and links `{base}/asset/:key` exactly as it does today, through
`Resolution.assetBase`. Published HTML is unchanged, stays cacheable, and is the same for
every visitor. The route decides, per request:

1. **No asset gating on the deployment** (`rt.assetGating` false): today's code, today's
   call, no D1 read. Nothing below runs.
2. **Read the row** (decision 3).
   - **No row**: `404`, `private, no-store`. Every object Folio mints has a row
     (`uploadAsset` writes the row before answering), so an object without one is an
     orphan, most often a deleted file whose R2 delete failed (`deleteAsset` swallows that
     failure). **Rejected: serve it as today.** The orphan of a gated file would go out
     `public, immutable` and into the edge cache for a year.
   - **Effective value null, or `isUngated`**: `serveAsset` as today, with the asset tags
     of decision 10. No host call.
   - **Gated, and the row's scope resolves to no brand** (`forScope` answers null: `shared`
     on a branded deployment, a brand id no longer in config): the bare `403` of decision
     7, never the host's hook (there is no brand to take it from). CLAUDE.md's invariant
     "a null brand serves nothing" applied to files. **Rejected: serve it public.**
     Removing a brand from config, even by mistake for one deploy, would publish that
     brand's gated library into the edge cache.
   - **Gated, and the brand's gate has no `allowsAsset`**: served as today. This is
     decision 2's sanctioned fail-open for a host that switched the feature off.
3. **Gated, with a gate.** Admit in this order, cheapest first, stopping at the first yes:
   a. a valid signature on the URL (decision 9);
   b. a Folio credential that may read the asset's scope (decision 8);
   c. a share cookie whose story uses the file and whose chain holds its scope (decision 8);
   d. `gate.visitor(req, env)` then `gate.allowsAsset(visitor, value, ctx)`. Either
      throwing is logged (`folio: gate.visitor threw; denying asset`, `folio:
      gate.allowsAsset threw; denying`) and is a denial, spec 31 decision 7 unchanged.
4. **Granted**: the bytes, streamed by `serveAsset` in its private mode (decision 6).
   **Denied**: decision 7.

The brand is the asset's own scope's (`rt.forScope(await rt.sites.registry(env),
row.site_id)` on a branded deployment, the one brand otherwise), never the request's: the
request scope is null on a site host and may be any scope on the admin origin (Ground
truth), and a file is governed by the brand that owns it. The registry read is the
isolate's cached snapshot, not a D1 query per request.

**Rejected: sign URLs at render, always.** The obvious design for "short-lived links" is
broken by the edge cache in two ways at once. A signature baked into a cached public page
is shared with every visitor who receives that copy, so it authorises strangers; and the
page is cached for `s-maxage=604800` (`cache-tags.ts:46`) while the signature expires in
minutes, so after the first few minutes every visitor, members included, gets a link that
no longer works. Decision 9 signs at render only for a visitor the page has itself admitted
to the file.

**Rejected: 302 a granted request to a short-lived signed URL** (an R2 presigned URL, or a
Folio-signed one). An R2 presigned URL needs S3 API credentials and an S3 endpoint, which
`assets.ts`'s header records the media library was designed to need neither of, and it
serves the object with R2's headers, so the sandbox CSP, `nosniff` and the
`content-disposition` rule (`assets.ts:942-950`) are lost on exactly the files most likely
to be documents. A Folio-signed redirect target costs a second round trip per file and
gains nothing a stream does not: the bytes are capped at 20 MB, the Worker streams R2's
body without buffering (`assets.ts:1025`), and the one case a redirect helps, a client
without the visitor's cookie, is served by handing that client a signed URL directly.

### 6. A granted response is `private, no-store`, originals and variants alike; transforms run through the same gate and may reuse the Cache API only after it

`serveAsset` gains a final parameter, `mode: 'public' | 'private'`, default `'public'`.
`'public'` is today's behaviour. `'private'`:

- every `cache-control` the client receives (`IMMUTABLE`, `DEGRADED`) is `NO_STORE`.
  Workers Caching stores neither, so a gated file is never written to the edge cache,
  original or variant;
- every other header (`nosniff`, CSP, `content-disposition`, `etag`) is unchanged;
- a transform reads and writes `caches.default` under a **separate key**: the canonical
  request with `__folio_private=1` appended to its query. The copy put into the Cache API
  keeps `IMMUTABLE` (the Cache API will not store a `private` response); the response
  returned to the client is a rebuilt copy with `NO_STORE`. The mapping happens after the
  `cache.put` and on the `cache.match` hit, never on the response being stored.

The Cache API is safe to use here because it is reachable only through Worker code, and
in Folio's code the only path to these `cache.match` calls passes the gate first. The
separate key keeps a gated variant from ever being stored under a URL a public request for
the same key would match. A public variant already in `caches.default` from before the
file was gated is never read for a gated request (the key differs) and expires on its own
in its colo.

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
per-tier destinations or a host whose sign-in is not a URL, and it would be a second config
key for what a function already covers.

### 8. Editors, tokens, preview origins and share links see gated files exactly as they see gated pages

Spec 31 decision 6 ("a Folio credential skips the gate") carried to the file route, one
rule per actor kind (`auth/roles.ts`):

- **A `user` actor** is granted when its role in the asset's scope allows `READ`: with no
  `sites`, `allows(actor, READ)`; with `sites`, `effectiveRole(actor.grants ?? {
  [ALL_SCOPES]: actor.role }, registry, row.site_id)` is a role at or above `viewer`
  (the fallback `mayPreviewDrafts` already uses for a user with no grants).
- **A `token` actor** is granted when its scopes reach `content:read` in the asset's scope:
  with no `sites`, `allows(actor, READ)`; with `sites`, `hasScope(tokenScopesOn(actor.scopes,
  actor.site, registry, row.site_id) ?? [], 'content:read')`. This is what lets an import
  script or MCP verify a file it just uploaded. `effectiveRole` is never handed a token,
  which has no `grants`.
- **A `grant` actor** (a preview grant on a site's preview origin) is granted when
  `mayPreviewDrafts(actor, registry, site)` holds for the request's gated site **and** the
  asset's scope is in `chain(registry, site)`.
- **`auth: 'open'` with the draft cookie** is granted, mirroring `editorAdmits`
  (`index.tsx:1245-1250`).

This is what makes the admin's thumbnails, the inspector's previews and the
`?_folio=preview` iframe render gated images. It does not need the draft cookie: unlike a
page, a file has no draft to choose between, and the admin requests thumbnails with only
its session cookie. **Rejected: require draft mode for editors**, as pages do. The admin
would show broken thumbnails for every gated image until the editor toggled a mode that is
about which version of a document to show and means nothing for a file.

**A share cookie** admits a file when, for one of its (at most five) tokens:

1. a live share exists (`readShareByToken`, read only, no view stamped; on a multi-site
   deployment passed the request's gated site, so a link redeems only where it was issued);
2. the asset's scope is in the share's story's chain, `chain(registry,
   story.site_id).includes(row.site_id)` (always true with no `sites`). Chains never cross a
   brand, so this also fences brands;
3. `assetKeys(draftDoc, schema)` of that story includes the key. The draft is read through
   the brand's `draft()` (the `initDraft` path, never a direct `getOrInit`).

**Rejected: admit on step 3 alone.** An asset value in a document is not validated against
the library's scopes, so an editor on site `alpha` could paste the key of `beta`'s
members-only PDF (public by decision 7, because `beta`'s page links it) into an `alpha`
draft, share it, and read a file in a scope where they hold no role. Step 2 makes a share
open exactly the files its page could legitimately render.

Step 3 costs a Durable Object read. It is memoised per isolate for 30 seconds as
`share id → asset key set`, while step 1 runs on every request, so revoking a share takes
effect at once and only a file just added to the draft waits up to 30 seconds. A 50-image
gated page viewed by a reviewer is then one D1 read per image and one Durable Object read
per share. **Rejected: memoise the whole admission.** It would let a revoked share keep
working for the memo's lifetime.

None of these requests can be cached: `cacheVerdictFor` answers `bypass` for any request
carrying a Folio session, grant, draft or share cookie, and the response is `private,
no-store` regardless. A bearer-token request is not a cookie and is routed to the cached
entrypoint, where its `private, no-store` response is not stored.

### 9. Signed URLs are an opt-in credential, minted by the host for a visitor it has itself admitted

```ts
createFolio({ assetSigning: { keys: (env) => [env.ASSET_KEY_2026_11, env.ASSET_KEY_2026_05] } })

await folio.signAsset(env, src, { expiresIn: 300 })   // a host route: "download" → 302
await page.signAsset(asset, { expiresIn: 300 })       // inside a render, see below
```

A signed URL is the stable URL plus `exp` (Unix seconds) and `sig`:
`base64url(HMAC-SHA256(key, "folio-asset\n" + assetKey + "\n" + exp))`. It covers the key
and the expiry and **not** the transform query, so one signature serves every `srcFor`
variant of that file (each still clamped by `parseTransform`). It is the credential at step
3a of decision 5: valid and unexpired is granted with no host call; missing, malformed,
expired, wrong, or carrying an `exp` more than 86 460 seconds ahead (the lifetime cap plus a
minute of clock skew; a headless host's own signer is held to the same cap) falls through to
steps b to d, so an expired link in a member's browser still works on their cookie.

What it is for: a download manager, a share sheet or an external PDF viewer that re-fetches
the URL without the visitor's cookie; an emailed "your purchase" link; a headless front end
on another origin whose visitor credential never reaches the Folio Worker's host (that host
shares the secret and implements the same HMAC, which the handbook documents).

- **`assetSigning` is deployment-level, not per brand.** Verification must not depend on
  which brand a key belongs to before the row is read, and `folio.signAsset` must not need
  a D1 read. It is a top-level key on both `FolioSingleConfig` and `FolioBrandedConfig`.
  `keys(env)` returns one or more secrets; the first signs and all verify, which is
  rotation: add the new key first, wait out the longest expiry, drop the old one. Each key
  must be at least 32 characters; a shorter one makes signing throw and the route treat
  every signature as invalid with one logged line (`env` is not available at construction).
  The HMAC binds no deployment, so the handbook requires a distinct key per deployment:
  staging and production sharing one would let a staging signature open a production file.
- **Lifetime**: `expiresIn` defaults to 300 seconds and is capped at 86 400. The cap bounds
  how long a leaked link is useful; a host that needs a long-lived download link mints a
  fresh one from its own route on each click.
- **A signed request is never edge-cached.** `cacheVerdictFor` answers `bypass` for an asset
  path carrying a `sig` parameter (its one change; every other input answers what it does
  today), and a signature-granted response is `private, no-store` with `referrer-policy:
  no-referrer`, so a PDF that links out does not hand the signature on.
- **`folio.signAsset(env, src, opts)`** signs unconditionally. It is for a host route that
  has made its own entitlement decision (checked the purchase, then `302`s to the signed
  URL), and the handbook says that in its first sentence. That route owns its own caching.
- **`page.signAsset(asset, opts)`** is the render-time option, and it signs **only for a
  visitor this page has itself admitted to this file's value**. It is async and answers the
  asset's plain `src` unless every one of these holds:
  1. `assetSigning` is configured and the asset is a library file whose effective value is
     gated (it is in the render's gated-asset lookup, decision 12);
  2. either the page is `draft` (an editor or a share admitted by `draftFor`) and the
     file's scope is in the render's chain, **or** `page.access === 'granted'` and
     `gate.allowsAsset(visitor, fileValue, ctx)` answers true for the visitor the reader
     already asked (`visitorOnce`), memoised per reader and key. A throw is false.

  It never signs on a `public` or a `denied` page, whatever that page's headers say.
  **Rejected: sign whenever the page answered `no-store`.** `no-store` means "this response
  varied" (Ground truth, `index.tsx:1416-1424`): a denied teaser, a public page rendered
  with uncacheable `params`, and a page with an unavailable option list are all `no-store`,
  and signing there hands a stranger a working link by appending a query string. Even a
  `granted` page is not enough: page access is the page's value, and a members page may
  link a premium file. Asking `allowsAsset` for the file's own value is the same question
  the route would ask.
- **The describer.** For a gated file, `DescribeInput.url` is a five-minute signed URL when
  `assetSigning` is configured, and the plain URL otherwise (which a model provider receives
  a 403 for; `inline()` is unaffected and is what the shipped Anthropic adapter uses).

**Rejected: R2 presigned URLs.** Decision 5's reasons, plus the Worker cannot verify them,
so steps b to d could not apply when one expires.

### 10. Asset responses carry a key-derived tag when gating is on; gating a file queues a durable purge that retries until it has succeeded after a settling window

**The tag.** On a deployment with `rt.assetGating`, every public-mode response from the
asset route carries `Cache-Tag: asset:<id>,asset:*`, where `<id>` is the 16-character id
read off the key (no D1 read is needed for it). Gating a file purges `asset:<id>`, which a
tag purge reaches on every site host, surface and `cf.cacheKey` variant (Ground truth).
`asset:*` is the coarse tag every asset response carries, so one purge can clear every
cached file without flushing pages. Cloudflare strips `Cache-Tag` before the response
reaches a client, so what a visitor receives is unchanged; a deployment without
`allowsAsset` emits no tag at all.

**Rejected: purge by `pathPrefixes`.** Every host that follows the handbook stores asset
entries under a `cf.cacheKey` that carries the host, Cloudflare documents prefixes only as
matching the request path, and it documents nothing about prefixes against a custom cache
key or across `ctx.props` variants. A prefix purge that passes a probe on one host could
leave the second site host's copy, or the preview surface's, serving gated bytes for a year.
Tags are Cloudflare's documented exact selector, and the one Folio already relies on for
pages. **Rejected: tag asset responses on every deployment.** It changes every public asset
response on deployments that have not adopted the feature.

**Copies cached before a deployment turns `allowsAsset` on** carry no tag. Turning it on is
a deploy, and the Worker version is in the cache key (Ground truth, `handbook.md:3710`), so
the new version never serves an entry an older version stored. Two cases are not covered by
that, and `UPGRADING.md` (v1.6.0) names both:

- **A host sharing the cache across versions.** It runs `POST {base}/api/assets/purge-all`
  (ADMIN, routed through the cached entrypoint like any write) once after the deploy that
  enables `allowsAsset`. The route issues one `purgeEverything`, the only selector that
  reaches an untagged entry, and is also the Assets screen's "Clear cached files" action
  for an administrator. The same applies after re-enabling `allowsAsset` that was removed.
- **A gradual deployment.** Until the version carrying `allowsAsset` serves 100% of traffic,
  the older version answers some requests from its own untagged copies and ignores the
  columns. No file may be gated before the rollout completes. Later gradual deployments of
  versions that both carry the feature are covered by the durable queue below, which keeps
  purging after the rollout finishes.

**The purge is durable.** A purge cannot join the D1 transaction that gates the file, it can
fail, and Workers Caching purges share a 5-a-minute budget with every page publish (Ground
truth). Today a failed purge is logged and dropped (`cache-purge.ts:260-272`), which for a
page is a stale page and for a newly gated file is a public copy for a year. So:

- **The queue.** `asset_purges (asset_id primary key, site_id, queued_at, settle_at,
  purged_at, attempts, last_error)`. Every public-to-gated transition writes its row **in the
  same `db.batch` as the transition**, so a gated file without a queued purge cannot be
  committed. `settle_at` is `queued_at + 10 minutes`; a re-queue keeps the row and moves
  `settle_at` forward.
- **A drain** reads up to 101 rows and issues **exactly one** purge call: `asset:<id>` for
  each row when there are at most 100, else `asset:*`. On success it stamps `purged_at` and
  deletes the rows whose `settle_at` has passed; on failure it records `attempts` and
  `last_error` and leaves every row. A drain never throws into the write that ran it.
- **Who drains**: the write that queued the rows, after it commits (awaited, so the
  response reports the outcome); the same write again `SITE_PURGE_DELAY_MS` later under
  `waitUntil`; every later asset write request (an empty queue costs one indexed read); and
  `folio.runSchedules`, which gains an `assetPurges` pass beside form deliveries. All of
  these run on the cached entrypoint when the host routes writes and its cron there, which
  the handbook already requires; the purge is scoped to the entrypoint that issues it,
  exactly as for publishes.
- **Why a settling window, and why ten minutes.** The asset route reads on a D1 session that
  may be a replica, so a request racing the gating can read the old public value, answer
  `IMMUTABLE` and be stored after a purge succeeded. A row is therefore only retired by a
  purge that succeeded **after** `settle_at`, which clears anything a replica up to ten
  minutes behind could have let in. D1 publishes no bound on replica lag; ten minutes is
  this spec's bound, and lag beyond it is the residual (Edge cases).
- **Visible when it is behind.** Every access-changing route answers `purge: { pending }`,
  the scope's rows still owed (`purged_at` null, or stamped but not yet after `settle_at`), and the Assets screen shows "N files may still be
  served from the edge cache; Folio is retrying" from `GET {base}/api/assets/purges`
  (`{ pending, oldest }`) while that count is non-zero. The `assetAccessChanged` hook payload
  carries the issued `purge` and `pending`.
- **Bulk walks** queue per batch and drain only on the batch that completes the walk (and
  its delayed repeat), so a forty-batch gating spends two purge calls rather than eighty.

**Rejected: fail the gating write when the purge fails.** The D1 write has already committed
by the time the purge can be tried, so failing the response leaves the file gated in D1 and
public at the edge while telling the editor nothing happened; reverting the write instead
would make the file public in D1 as well. Under the shared rate limit it would also make
bulk gating fail at random. A queue that cannot lose a row and an admin notice while it is
non-empty keep the guarantee and say when it is late.

**Pages that show a lock** (decision 12) carry the same `asset:<id>` tag, so the drain that
clears a file's copies also refreshes the pages that labelled it. A public-to-gated
transition also purges, best effort and not queued, `story:<id>` for each published story
in `assetReferences(db, key)`: pages that link the file and so far drew no lock. A
gated-to-public or gated-to-gated change purges `asset:<id>` once, best effort: no gated
response was ever stored, so only the cosmetic lock is at stake.

What no purge reaches, stated in the handbook: a copy already in a visitor's browser
(`immutable`, a year) or in an intermediate proxy. Gating a file that was public is
effective from the edge inward.

### 11. The value is set through the same routes as every other asset field, and validated against the brand's gate field

- **Admin** (`{base}/api`, internal): `PATCH /assets/:id` accepts `access: <value> | null`
  (absent leaves it alone, `null` is inherit). `PATCH /assets/folders/:id` and
  `POST /assets/folders` accept the same. `POST /assets` accepts `?access=` and
  `?folderId=` (decision 4). A new bulk action, `POST /assets/bulk/access` with
  `{ selection, access }`, joins `tag`, `untag`, `move` and `delete`; `AssetBulkAction`
  gains `'access'`.
- **Content API** (`{base}/api/v1`, a contract, so additive only): `POST /assets` accepts
  `?access=`; **new** `PATCH /assets/:id` accepts `{ access?, alt?, description? }` at
  `assets:write` and answers the row. Folder ids and tag ids have no versioned routes
  (`media-library.md` decision 13), so `folderId` and `tags` stay admin-only.
- **MCP**: `upload_asset` gains an optional `access` argument (forwarded as `?access=`), and
  an eighteenth tool, `update_asset` (`PATCH /assets/:id`, `need: ASSETS`), takes `id`,
  `access`, `alt`, `description`.
- **`?access=` is typed by `gate.public`'s primitive**: a number gate parses it with
  `Number`, a boolean gate accepts `true` and `false`, a string gate takes it as is. An
  absent `?access=` on an upload inherits from `?folderId=`, and is public for an unfiled
  file.

Validation (`validateAccessValue` in `asset-access.ts`): the value must be the gate field's
primitive and, where any declaring root's field is a `select`, one of the options **every**
declaring root's `select` lists, so a file's value means the same thing whichever page type
links it. A text value is capped at 200 characters. An unknown value is `400 bad_request`
naming the allowed values. Setting `access` on a scope whose brand has no `allowsAsset` is
`400 unsupported` ("This site does not gate files"), the shape `describe` uses for an
unconfigured feature.

Every one of these writes goes through `asset-access.ts`, which queues decision 10's purge
in its batch and runs the new hook event `assetAccessChanged` (`{ assets: { id, key, scope,
from, to }[], truncated, purge, pending }`, at most 500 entries), for a headless host that
caches on an entrypoint of its own (multi-site decision 16's precedent).

**Rejected: `access` on `AssetValue`** (copy it into the document at pick time). It would be
stale from the first change, which `media-library.md` decision 7 already argued for tags,
and the route would have to trust a document over the library.

### 12. `resolveAsset` and asset links expose the stored value of a gated file as `access`; the visitor's own verdict is never in the HTML

`Resolution` gains `gatedAssets?: Record<string, Json>`: for every library key the
resolution's documents reach whose effective value is gated, that value. `ResolvedAsset`
and the `asset` arm of a resolved link gain `access?: Json`, present exactly when the key is
in that map. A host renders a lock, a "Members only" label or a "Premium" badge from it:

```tsx
const file = resolveAsset(blok.data.download, resolution)
<a href={file.src}>{file.access !== undefined ? '[Members] ' : ''}Download</a>
```

The value is the same for every visitor, so a public page's HTML stays cacheable and the
same for everyone. **Whether this visitor may open the file is never rendered by Folio**:
that would make the public page vary per visitor, which spec 31 decision 5 showed a shared
cache cannot represent. A host that wants "Download" for members and "Buy" for everyone
else already renders a gated page (`private, no-store`) and calls its own predicate there,
or links to the file and lets `assetDenied` send non-members to the purchase page.

**Where the values come from**: one statement, `select key, site_id, effective_access from
assets where key in (…) and effective_access is not null`, chunked by `bindChunks`, over
`assetKeys` of the document, `docs` and `globals`. It runs only when the brand's gate has
`allowsAsset` and the key set is non-empty, in the same `Promise.all` as pass four
(collections and option lists), so it adds no sequential round trip. The map is filtered to
values for which `isUngated` is false. `site_id` is kept on the reader, not the resolution,
for `page.signAsset`'s chain check. Absent rather than `{}` when empty, so a resolution with
no gated files serialises byte for byte as today.

**Collection item documents are not walked**: their ids are only known when pass four
returns, so including them would add a sequential round trip to every collection page. A
card's thumbnail of a gated image therefore has no `access` (it is still gated at the
route).

**Cache tags**: `cacheTags` adds `asset:<id>` (a new `assetTag` builder) for every key in
`gatedAssets`; decision 10's drain purges it. A public page that renders no gated file
carries no new tag, so an all-public library changes no page header. The overflow rule is
unchanged: a degraded tag set drops asset tags with everything else, and such a page's lock
is stale until its own next purge (it is cosmetic; the route still decides).

**Rejected: tag every rendered asset id**, so a public-to-gated change refreshes locks by tag
alone. A 300-image gallery would spend a third of the tag budget on files that are all
public, and every page on a gated deployment would change its `Cache-Tag` on upgrade. The
`content_refs` purge in decision 10 covers direct embeds and links; a gated file reached
only through a global or a referenced document shows its lock after that page's next purge.

### 13. Search, lists and metadata stay public; the gate protects the bytes

`folio.query`, `collection`, `{base}/api/v1/assets` and the admin's lists answer a gated
file's filename, alt text, description, dimensions and tags exactly as today, which is spec
31's position for pages ("a denied page answers its metadata by design"). The handbook's
Assets and Visitor access sections say it in one sentence each.

Rows gain two fields, `access` and `effectiveAccess` (decoded JSON, null for inherit and
public respectively), **only when the scope's brand has `allowsAsset`**. `COLS`
(`assets.ts:61`) does not change. A gated scope's routes add the two fields through one
presenter, `presentAssetRows(db, rows, domain)`, which issues one `select id, access,
effective_access from assets where id in (…)` and merges; with no domain it returns the rows
untouched and reads nothing. **Rejected: add the columns to `COLS` and strip them on the way
out.** Every route that answers a row (the describe route at `routes/assets.ts:676-718`
answers one through `withTags` and is easy to miss) would have to remember to strip, and one
that forgot would put raw encoded columns into a no-gate deployment's JSON. With `COLS`
unchanged, a route that forgets the presenter answers a row without access fields, which is
a missing feature on one screen rather than a changed contract everywhere. The manifest
gains `assetAccess?: { field: string; public: string | number | boolean; options?: { value:
string; label: string }[] }` on the same condition, which is everything the admin needs to
draw the control.

### 14. The editor is warned about an embedded gated image on a public page, and not about a link

A gated **image in an `asset` or `multiasset` field** on a page whose own gate value is
public (or whose root does not declare the gate field) renders as a broken image for most
visitors. A gated file in a `multilink` or a richtext link, or a non-image in an asset
field, is a download offer, which is the legitimate case this spec exists for.

- **`check_document`** gains `gated-asset-embedded` (severity `warning`, `fix:
  'patch_fields'`, detail `{ key, access }`), computed in `targetFindings` from one
  `select key, effective_access from assets where key in (…)` over the document's image
  keys. Advisory, like every check (spec 40 decision 18). `isImageAsset` decides "image";
  the field kind decides "embed".
- **The inspector**: `AssetCard` (`fields/AssetField.tsx`) shows a lock glyph on any gated
  file and, on a public page, a one-line warning under an embedded gated image ("Members
  only: most visitors will see a broken image"). Its data comes from one new internal route
  per open document, `GET {base}/api/assets/access?key=…` (repeated, at most 50, `READ`,
  the request's chain), answering `{ [key]: value }` for gated keys only.

**Rejected: refuse to publish.** A teaser page that shows a members-only cover image to
members (the host renders it inside a member check) is legitimate, and a check that blocks
it would be switched off.

## Wire & schema changes

### D1 migration `0019_asset_access.sql`

```sql
-- Visitor access for media library assets (docs/specs/platform/asset-access.md).
--
-- Four nullable columns and one table, all additive. Access values are JSON text so
-- the gate field's primitive survives the round trip (decision 2). No index on
-- assets: the asset route reads by key, on the unique index 0001 already has; the
-- "gated only" filter is a scan, like every asset filter but folder and tag.

-- own value; null = inherit from the folder
alter table assets add column access text;
-- what the route reads; null = public. Maintained by server/asset-access.ts.
alter table assets add column effective_access text;
-- own value; null = inherit from the ancestors
alter table asset_folders add column access text;
-- the nearest own value on this folder or an ancestor, by path
alter table asset_folders add column effective_access text;

-- Edge purges owed for files that went from public to gated (decision 10). A row is
-- written in the same batch as the transition and retired only by a purge that
-- succeeded after settle_at. No foreign key, following 0010, and deleteAsset leaves
-- the row: the edge copy is named by tag and outlives the file.
create table asset_purges (
  asset_id   text primary key,
  site_id    text not null,
  queued_at  integer not null,
  settle_at  integer not null,
  purged_at  integer,
  attempts   integer not null default 0,
  last_error text
);
-- The admin's pending count, per scope.
create index asset_purges_pending on asset_purges (site_id) where purged_at is null;
```

Apply class: **before-deploy** (the Worker that carries it selects the columns and writes
the table). Every existing row reads null, null: public, inheriting. No backfill and no
reindex.

`upgrade-ledger.json`: `"0019_asset_access.sql": { "release": "1.6.0", "apply":
"before-deploy" }`. `UPGRADING.md`: a ledger row and a `### Visitor access for files
(v1.6.0)` entry with four instructions: apply `0019` before deploying; let the deploy that
enables `allowsAsset` reach 100% of traffic before gating any file; on a deployment that
shares the Workers cache across versions, run `POST {base}/api/assets/purge-all` once after
that deploy (and after any re-enable); route the cron's `runSchedules` through the cached
entrypoint if it is not already.

**Rollback is not free, and the entry says so.** A pre-v1.6.0 Worker ignores the columns,
serves every gated file publicly with `IMMUTABLE`, and, because the Worker version is in the
cache key, answers from the entries that version stored before any file was gated. A
rollback therefore re-opens gated files at the edge for a year. Roll forward. A host that
must roll back first moves protected files out of the library (or deletes them), then rolls
back.

### Core types

Additive throughout; no stored document or mutation log changes.

- `core/resolve.ts`: `Resolution.gatedAssets?: Record<string, Json>`;
  `ResolvedAsset.access?: Json`; the `asset` arm of `ResolvedLink` gains `access?: Json`.
- `core/cache-tags.ts`: `assetTag(id)` → `asset:<id>` and `ANY_ASSET_TAG` = `asset:*`.
- `core/assets.ts`: `AssetFilter.gated?: boolean`; `AssetBulkAction` adds `'access'`;
  `AssetFolder` gains `access?` and `effectiveAccess?`.
- `server/types.ts`: `FolioGate.allowsAsset?`, `FolioGate.assetDenied?`,
  `FolioAssetGateContext`, `FolioAssetDeniedContext`; `assetSigning?: { keys(env): readonly
  string[] }` on both config shapes; `FolioPage.signAsset(asset, opts?): Promise<string>`;
  `Folio.signAsset(env, src, opts?): Promise<string>`; `HookPayloadMap.assetAccessChanged`.
- `server/scheduler.ts`: `ScheduleRunReport.assetPurges?: { purged: number; pending: number;
  failed?: string }`.
- `Manifest.assetAccess?` (decision 13).

`PurgeIssued` is unchanged: an asset drain issues `{ tags }`. `folio/core` exports
`assetTag`; `folio/server` exports the two context types.

### New or changed routes

| Method and path | Auth | Change |
| --- | --- | --- |
| `GET {base}/asset/:key` | none (gate) | decision 5. With asset gating: public responses gain `Cache-Tag`; no row is `404`; gated and denied is `403` or `assetDenied`'s response; gated and granted is the bytes, `private, no-store`. |
| `PATCH {base}/api/assets/:id` | `ASSETS`, fenced | body gains `access`; answers `purge` |
| `POST {base}/api/assets` | `ASSETS` | `?access=`, `?folderId=` |
| `POST {base}/api/assets/folders` | `ASSETS` | body gains `access` |
| `PATCH {base}/api/assets/folders/:id` | `ASSETS`, fenced | body gains `access`; answers `purge` |
| `POST {base}/api/assets/bulk/access` | `ASSETS` | new; `{ selection, access, continueFrom?, dryRun? }`, the other bulk routes' shape and report |
| `GET {base}/api/assets/access?key=` | `READ`, chain | new; `{ [key]: value }` |
| `GET {base}/api/assets/purges` | `READ` | new; `{ pending, oldest }` for the request's scope |
| `POST {base}/api/assets/purge-all` | `ADMIN` | new; one `purgeEverything`; `{ ok }` |
| `GET {base}/api/assets?gated=1` | `READ` | new filter |
| `POST {base}/api/v1/assets` | `assets:write` | `?access=` |
| `PATCH {base}/api/v1/assets/:id` | `assets:write`, fenced | new; `{ access?, alt?, description? }` → the row; `404` unknown or outside the scope |
| MCP `upload_asset` | `ASSETS` | optional `access` |
| MCP `update_asset` | `ASSETS` | new, the eighteenth tool |

Every `access` input: absent leaves it alone; `null` inherits (`PATCH` and folders only);
a value is validated (decision 11). Errors: `400 bad_request` (wrong primitive, unknown
option, over 200 characters, unknown folder), `400 unsupported` (no asset gating for this
scope; every new admin route but `purge-all` answers it on such a scope).

## Acceptance criteria

### A deployment without asset gating is unchanged

```
GIVEN a deployment with no `gate`, or a `gate` with no `allowsAsset`
WHEN any asset is requested, original or transformed, GET or HEAD
THEN the response status, headers and body are byte-identical to v1.5.4
AND the route issues no D1 query
AND every page's `FolioPage.headers`, `Resolution` and HTML are byte-identical
AND every admin and v1 asset row is byte-identical, with no `access` or `effectiveAccess` key
AND the manifest carries no `assetAccess` key
```

### Public files on a gated deployment keep their caching

```
GIVEN `allowsAsset` is configured and an asset's effective value is null or `gate.public`
WHEN it is requested
THEN status, body and every header but `Cache-Tag` are byte-identical to v1.5.4, including `cache-control: public, max-age=31536000, immutable`
AND `Cache-Tag` is `asset:<id>,asset:*`
AND `visitor` and `allowsAsset` are not called, and exactly one D1 statement was issued
```

### A gated file is never edge-cached and never served to a denied visitor

```
GIVEN an asset whose effective value is `members`
WHEN a request with no credential, no signature and a visitor `allowsAsset` refuses arrives, for the original or for `?w=320&f=webp`
THEN the status is 403 with an empty body and `cache-control: private, no-store`
AND R2 is not read and the Images binding is not called
WHEN `allowsAsset` grants
THEN the bytes are served with `cache-control: private, no-store` and the original's `nosniff`, CSP and `content-disposition`
AND a transformed variant is stored in `caches.default` only under the private key, and a second request for it does not call the Images binding
GIVEN the row was deleted and its R2 object survived
THEN the key answers 404, `private, no-store`
GIVEN the asset's scope resolves to no brand
THEN it answers 403 and `assetDenied` is not called
```

### The host decides denial

```
GIVEN `assetDenied` returns a 302 to `/sign-in?next=…`
WHEN a denied visitor requests the file
THEN the response is that 302 with `cache-control: private, no-store`
GIVEN `assetDenied` throws, or returns null
THEN the response is the bare 403 and the throw is logged once
```

### Gating a public file purges its copies, and the purge cannot be lost

```
GIVEN a public file with cached copies of the original and a variant on two site hosts, the admin origin and a preview origin
WHEN an editor sets it to `members`
THEN an `asset_purges` row is committed in the same batch as the change
AND `cache.purge` is called with `tags` including `asset:<id>`, and again 25 seconds later
AND, against a staging deployment, every one of those copies MISSES afterwards (cache-probe)
GIVEN the purge answers `success: false`
THEN the row survives with `attempts` and `last_error`, the response answers `purge.pending >= 1`, the Assets screen shows the notice
AND the next `runSchedules` run purges it and the row is retired only by a success after `settle_at`
GIVEN a bulk access walk of 40 batches
THEN it issues at most two purge calls, both from the final batch
```

### Folders gate what they hold

```
GIVEN folder A (`members`) containing folder B (no value) containing file f (no value)
THEN f's effective value is `members`
WHEN B is set to `public`
THEN f's effective value is `public`
WHEN f is moved to the top level (Unfiled) with one PATCH
THEN f's effective value is null; moved back into A with one PATCH, it is `members`
WHEN A is deleted
THEN B's own value is `public`, every file filed directly in A has its inherited value as its own, and no effective value changed
WHEN A is set to `members` while, concurrently, a public folder C is moved under A
THEN after both commit, in either order, C and its files are `members`
WHEN an editor browsing A uploads a file
THEN the file is filed in A and gated in the insert that created it
```

### Editors, tokens and reviewers see gated files; reviewers only their page's

```
GIVEN a signed-in editor with READ on the asset's scope
WHEN the admin requests a gated thumbnail with only the session cookie
THEN it is served, `private, no-store`
GIVEN a bearer token with `content:read` reaching the asset's scope
THEN it is served; a token without it falls through to the host's gate, and nothing throws
GIVEN a share cookie for story S on site alpha whose draft uses the file, and the file's scope is in alpha's chain
THEN the file is served and no share view is stamped
GIVEN the same share and a draft that embeds the key of a gated file owned by site beta
THEN the request falls through to the host's gate
```

### Signed URLs

```
GIVEN `assetSigning` is configured
WHEN `folio.signAsset(env, src, { expiresIn: 60 })` is requested without any cookie within 60 s
THEN it is served `private, no-store` with `referrer-policy: no-referrer`, and `cacheVerdict` answered `bypass`
WHEN it is requested after 61 s, with one character of `sig` changed, or with an `exp` two days ahead
THEN the host's gate decides, exactly as for the unsigned URL
GIVEN a page whose access is `public`, or `denied`, or one rendered `no-store` because of `params`
WHEN the host calls `page.signAsset(file)` for a gated file
THEN the plain `src` is returned
GIVEN a `granted` members page and a file whose value is `premium` that `allowsAsset` refuses for this visitor
THEN the plain `src` is returned; for a `members` file `allowsAsset` grants, a signed URL
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
AND `UPGRADING.md` carries `### Visitor access for files (v1.6.0)` with its four instructions and the rollback warning
```

## Implementation plan

Each phase leaves `pnpm typecheck`, `./node_modules/.bin/biome ci .` and `pnpm test` green
(gate on exit codes, per CLAUDE.md). Order: 1 → 2 → 3 → 4 → 6 → 7 → 9. Phases 5 and 8
start after 3 and run in parallel with 4 and with each other (they touch `runtime.ts`,
`resolve.ts`, `cache-tags.ts`, `checks.ts` and `asset-signing.ts`, `cache-request.ts`,
`index.tsx` respectively, none of which 4 or 6 edit). Phase 6 waits for 4, because both
would otherwise edit `routes/assets.ts` and `routes/api/index.ts`: 4 builds the purge
machinery and wires no route; 6 wires every route, purge calls included.

### Phase 1: config, types and validation

1. `src/server/types.ts`: `allowsAsset?`, `assetDenied?` on `FolioGate` (as methods, for the
   bivariance argument in `FolioGate`'s header); `FolioAssetGateContext`,
   `FolioAssetDeniedContext`; `assetSigning?` on `FolioSingleConfig` and
   `FolioBrandedConfig` (not on `FolioBrand`); `FolioPage.signAsset`; `Folio.signAsset`;
   `HookPayloadMap.assetAccessChanged` and `FolioHooks.assetAccessChanged`.
2. `src/server/gate.ts`: the three refusals of decision 1; `ResolvedGate` gains
   `assets: AssetAccessDomain | null` (`{ primitive, options? }`, options the intersection of
   every declaring `select`'s values, labels from the first declaration), null when
   `allowsAsset` is absent. Declarations sharing no `select` option but `public` are a
   construction error naming the roots.
3. `src/server/runtime.ts`: `FolioRuntime.assetGating`.
4. `src/server/hooks.ts`: `assetAccessChanged` in `HOOK_EVENTS` and the payload map.
5. Tests: `test/unit/server/gate.test.ts` (each refusal, the intersection);
   `test/unit/server/pure.test.ts`'s `validateHooks` block (the new key accepted).

### Phase 2: schema and the effective-value module

1. `migrations/0019_asset_access.sql` (above). Never edited after it lands.
2. `src/server/asset-access.ts` (new): `encodeAccess` / `decodeAccess` (JSON; an unreadable
   stored value decodes as gated, logged once, fail closed); `validateAccessValue(domain,
   raw)`; `parseAccessQuery(domain, raw)`; `isPublicEffective(stored, gate)`;
   `folderRecomputeStatements(db, site, path)` (decision 3's two statements);
   `assetRecomputeStatement(db, id, site, folderId)`; `assetAccessByKey(db, key)` (the
   route's one statement); `gatedValues(db, keys)` (chunked; resolve, checks, the inspector
   route); `queuePurgeStatements(db, transitions, now)`. Every service write returns its
   transitions `{ id, key, scope, from, to }`, reading at most 501 so a caller knows when to
   truncate the hook payload.
3. Wire it in so no write bypasses it, each change in the write's own `db.batch`:
   - `assets.ts`: `COLS` and `AssetRow` **unchanged**; `uploadAsset` takes `access?` and
     `folderId?` (checked against the scope like `updateAsset`'s) and inserts both columns;
     `updateAsset` takes `patch.access` and appends `assetRecomputeStatement` after the
     `folder_id` update; `assetFilterSql` gains `gated` (`effective_access is not null and
     effective_access <> ?`, binding the encoded public value); `deleteAsset` leaves the
     file's `asset_purges` row, which the drain retires (the edge copy outlives the row).
   - `asset-folders.ts`: `createFolder`, `updateFolder` (access, rename, move) append
     `folderRecomputeStatements`; `deleteFolder` adds decision 4's two materialising
     statements ahead of the re-parent.
   - `asset-bulk.ts`: `move` binds the destination in its recompute; a new `access` action
     validated once before the walk, like `move`'s folder.
   - `validate.ts`: `AssetPatchBody`, `AssetFolderCreateBody`, `AssetFolderPatchBody` gain
     `access: v.optional(v.nullable(scalar))`; the domain check is `validateAccessValue`'s.
4. `presentAssetRows(db, rows, domain | null)` (decision 13).
5. Tests: `test/workers/migrations.test.ts` (columns default null, the table and its
   partial index exist, no index on `assets`); `test/workers/asset-access.test.ts` (new):
   inheritance through three levels, overrides, a one-PATCH move into and out of a gated
   folder (the before-image trap), folder move, rename, folder delete materialises and
   changes no effective value, bulk move and bulk access, a 600-file folder through the
   fixed-bind statements, both interleavings of "gate A" and "move C under A" applied as
   batches in each order, upload with `folderId`, transitions and queued purge rows written
   in the same batch (a proxy recording `db.batch`); `test/workers/assets.test.ts`: every
   row-answering route's JSON is unchanged on a no-gate config, the describe route included.

### Phase 3: the route

1. `src/server/assets.ts`: `serveAsset(…, mode = 'public')` per decision 6. Map
   `cache-control` on the response handed back, after `cache.put` stores the `IMMUTABLE`
   copy and on a `cache.match` hit, never on the stored one. The `'public'` path's bytes are
   untouched; the asset tags of decision 10 are added by the route, not by `serveAsset`.
2. `src/server/routes/assets.ts`: `assetFileRoutes` implements decision 5. Today's call stays
   the first branch, verbatim, under `if (!rt.assetGating)`. Everything after it is
   `admitAsset(c, rt, row, brand)` in a new `src/server/asset-gate.ts`, which owns the order
   of decision 5 step 3, the no-row 404, the no-brand 403, the denial of decision 7 and its
   log lines, and never reads `c.var.scope`. Signature verification answers "absent" until
   phase 8.
3. Credential admission per decision 8: the three actor kinds, `auth: 'open'`, and shares
   (`readShareByToken` with the gated site, the chain check, the per-isolate key-set memo,
   `brand.draft()` and `assetKeys`).
4. Correct the stale comments at `middleware.ts:52` and `cache-request.ts:96-99`.
5. Tests: `test/workers/asset-gate.test.ts` (new), with a test gate whose `visitor` reads a
   header: public bytes and headers identical to a no-gate run except `Cache-Tag`; gated
   denied 403 empty no-store with R2 and Images untouched (proxies on both); granted
   no-store with the original's headers; the private-key variant stored with `IMMUTABLE`
   and served twice for one Images call; no row 404; no-brand 403 without the hook;
   `visitor`, `allowsAsset`, `assetDenied` throwing, `assetDenied` null and redirect;
   user, token (with and without `content:read`, bound and unbound) and grant actors on a
   multi-site fixture; share granted, share for a story not using the file, share whose
   draft embeds another site's key, no view stamped, memo honoured and revocation immediate;
   branded fixture using the asset's brand's gate; a `~scope` admin-origin request.
   `test/workers/single-site-pin.test.ts` gains a no-gate asset response pin.

### Phase 4: the purge queue and the hook

1. `src/server/cache-purge.ts`: `drainAssetPurges(db, capability, now, logger)` per
   decision 10 (one call per drain, `asset:<id>` up to 100 else `asset:*`, stamp or record,
   retire past `settle_at`), and `purgeAssetsNow(capability, tags)` for the best-effort page
   tags. Reuse `platformPurge`; never hold the capability.
2. `src/server/asset-access.ts`: `afterAccessChange(c, transitions, opts)`: drain (awaited,
   never throwing into the write), the delayed repeat under `c.executionCtx.waitUntil`, the
   best-effort `story:` tags from `assetReferences` (skipped above 500 transitions), the
   hook, and the `purge: { pending }` value for the response. `opts.final` false skips the
   drain for a non-final bulk batch. Built and unit-tested here; called from routes in
   phase 6.
3. `src/server/scheduler.ts`: the `assetPurges` pass, after deliveries, with its own
   `try` so a failure is `failed` in the report rather than a thrown run.
4. Tests: `test/unit/server/cache-purge.test.ts` with an injected capability: 3 rows give
   one call with three tags; 150 rows give one `asset:*` call; failure leaves rows with
   `attempts` and `last_error`; success before `settle_at` keeps the row, after deletes it;
   absent capability issues nothing and keeps rows. `test/workers/scheduler.test.ts` (or the
   suite that covers `runSchedules`): the pass drains and reports.

### Phase 5: resolve, tags and checks (parallel with 4 and 8)

1. `src/core/resolve.ts`: `Resolution.gatedAssets`, `ResolvedAsset.access`, the link arm;
   `decorateAsset` reads the map.
2. `src/server/runtime.ts`: decision 12's lookup inside the pass-four `Promise.all`, only
   when `brand.gate?.assets`; the key absent when empty; the per-key scope kept for the
   reader.
3. `src/core/cache-tags.ts`: `assetTag`, `ANY_ASSET_TAG`; `cacheTags` adds one per
   `gatedAssets` key.
4. `src/server/checks.ts`: `gated-asset-embedded` in `targetFindings`.
5. Tests: `test/unit/core/resolve.test.ts` (access only for gated keys, links too);
   `test/unit/core/cache-tags.test.ts` (tags only for gated keys; no `gatedAssets` gives the
   identical string); `test/workers/read-session.test.ts`-style count (one more statement,
   concurrent with collections, only on a gated deployment with asset keys);
   `test/workers/checks.test.ts` (`asset` warns, `multilink` does not, a gated page does not).

### Phase 6: routes, APIs and MCP

1. `src/server/routes/assets.ts`: `access` on patch, upload (with `folderId`) and folder
   routes; `/assets/bulk/access`; `GET /assets/access`, `GET /assets/purges`, `POST
   /assets/purge-all` (all registered before `/assets/:id`, which would otherwise read their
   names as ids, as `/assets/folders` already is); the `gated` filter; `presentAssetRows` on
   every row-answering route; `afterAccessChange` after every access-changing write, with
   `final` from the bulk report; a drain attempt on every other asset write.
2. `src/server/routes/api/index.ts`: `?access=` on upload; `PATCH /assets/:id` with
   `fenceRow(rt, 'write', assetSiteOf, 'asset')` and `requireAccess(rt, ASSETS)`;
   `presentAssetRows`; `afterAccessChange`.
3. `src/server/mcp/tools.ts`: `access` on `upload_asset` (`query: ['filename', 'access']`);
   `update_asset`.
4. Tests: `test/unit/mcp/tools.test.ts` (eighteen); `test/workers/scope-partition.test.ts`
   fence tests for `PATCH /api/v1/assets/:id`, `GET /api/assets/access` and `GET
   /api/assets/purges`; `api-partition.test.ts`; `test/workers/mcp.test.ts`;
   `test/workers/asset-access.test.ts`: a route-level gating with an injected failing
   capability answers `pending: 1`, then a `runSchedules` call retires it after `settle_at`
   (fake clock); a 40-batch bulk access issues two purge calls; `scripts/api-test.mjs` and
   `scripts/mcp-test.mjs` extended.

### Phase 7: admin

1. `src/core/schema.ts` `Manifest.assetAccess?` and its builder in `core/block.ts`
   `toManifest` (only when the brand gates assets).
2. `src/admin/hooks/useUpload.ts`: an optional folder id, sent as `?folderId=`.
3. `src/admin/ui/screens/assets-model.ts`: decode `access` / `effectiveAccess`; the `gated`
   filter; the bulk action; move-confirmation counts (gated to public and public to gated)
   from the selection's rows and the destination's effective value; the pending-purge
   notice state from `GET /assets/purges`, refetched after each access change while
   non-zero.
4. `AssetBrowser.tsx`, `Assets.tsx`, `Assets.module.css`: lock glyph on gated tiles and rows;
   the "Gated" filter; "Set access" in the bulk bar; folder access in the folder edit
   dialog, with "Inherit (Members, from Member downloads)" as the null option's label;
   uploads pass the open folder; the pending notice; "Clear cached files" for an
   administrator.
5. `AssetDetail.tsx`: the access control, the same options, the inherited source shown.
6. `fields/AssetField.tsx` and `Inspector.tsx`: decision 14's lock and warning, from one `GET
   {base}/api/assets/access` per open document's asset keys, refetched when the set changes.
7. Dialogs reuse `useFocusTrap` and `scoped()` (CLAUDE.md invariants).
8. Tests: `test/unit/admin/` model tests (decode, filter, move counts, notice state);
   `scripts/media-library-test.mjs` extended. A browser review on the demo before merge.

### Phase 8: signed URLs (parallel with 4 and 5)

1. `src/server/asset-signing.ts` (new): `signAssetUrl(keys, src, expiresIn, now)` and
   `verifyAssetSignature(keys, assetKey, exp, sig, now)` over `crypto.subtle` HMAC-SHA256,
   base64url, compared with `crypto.subtle.verify`; the 32-character, 86 400-second and
   far-future rules.
2. `src/server/asset-gate.ts`: step 3a; signed responses add `referrer-policy: no-referrer`.
3. `src/server/cache-request.ts`: `bypass` for an asset path with a `sig` parameter, above
   the asset `cache` line.
4. `src/server/index.tsx`: `folio.signAsset`; `FolioPage.signAsset` in `pageOf`, closed over
   `drafted`, `access`, the reader's `visitorOnce`, the gated-asset scopes and a per-reader
   memo of `allowsAsset` verdicts by key.
5. `src/server/describe.ts`: `describeUrl` signs for a gated file when `assetSigning` is set.
6. Tests: `test/unit/server/asset-signing.test.ts` (round trip, expiry, tampered key, exp and
   sig, far-future exp, rotation, short key); `test/unit/server/cache-request.test.ts` (sig
   bypasses, no-sig unchanged); `test/workers/asset-gate.test.ts` (signed with no cookie;
   expired falls through); `test/workers/gate.test.ts` (`page.signAsset`: public page,
   denied teaser, public page with uncacheable `params`, granted page with a refused
   higher-tier file, granted page with an allowed file, draft page with an in-chain file).

### Phase 9: demo, documentation, end to end, staging

1. `examples/demo/src/index.tsx`: `allowsAsset: (visitor) => visitor !== null`, an
   `assetDenied` redirecting to the demo's members page, and `assetSigning` with a constant
   dev-only key carrying the same warning comment as `demo_member`. `examples/starter` has no
   `gate` and is not changed.
2. `scripts/asset-access-test.mjs` (new; reads `FOLIO_E2E_BASE`, signs in with
   `signInGlobally()`): upload with access, fetch as stranger (403) and as `demo_member`
   (bytes, no-store), a variant, a gated folder and an inherited file, an upload into the
   gated folder, a folder delete that keeps its files gated, a signed URL with no cookie. The
   sweep's count in CLAUDE.md goes from 26 to 27.
3. `scripts/cache-probe.mjs`: an `--asset <key>` mode taking `--site` twice, `--admin` and
   `--preview`: warm the original and `?w=320` on two site hosts, the admin origin and a
   preview origin; gate the file through the admin API; assert every copy MISSes within 15 s
   and still MISSes after `settle_at`; fire a member and a stranger request concurrently for
   a gated file and assert the stranger gets 403 (request collapsing on a `private`
   response); restore. **Run against a consumer's staging deployment before tagging v1.6.0.
   Any surviving copy blocks the release.**
4. Docs: `docs/handbook.md` "Visitor access" (a section on files), "Assets" (access values,
   folders, uploads into a folder, metadata stays public), "Caching" (the asset tags, the
   queue, the cron, the entrypoint rule, per-deployment signing keys, the version-key
   consequences), "Auth" (replace the "stays public" sentence at line 3829), "Content
   API", "An MCP server"; `docs/configuration.md` (`gate.allowsAsset`, `gate.assetDenied`,
   `assetSigning`); `AGENTS.md` (setting access on upload); `UPGRADING.md`; `CHANGELOG.md`;
   `upgrade-ledger.json`; `docs/specs/README.md` (row 43, the migration ledger, "next free is
   `0020`"); `CLAUDE.md` ("The two ledgers": `0019`, next free `0020`; MCP tools eighteen;
   the invariants below).
5. New invariants for `CLAUDE.md`:
   - **The asset route's gate precedes every cache read**, and a gated asset never answers a
     `public` cache-control: `serveAsset`'s private mode is the only way bytes of a gated
     file leave the Worker.
   - **Every write that changes an asset's `folder_id` or `access`, or a folder's `access`,
     `path` or `parent_id`, goes through `asset-access.ts`**, in the write's own batch. A
     path that sets `folder_id` directly leaves a stale effective value, and the route reads
     only that column.
   - **A public-to-gated transition commits its `asset_purges` row in the same batch.** The
     purge itself may fail; the row is what makes that recoverable.

## Edge cases

- **A file is gated, then made public again** → no queued purge (nothing was stored while
  gated); `asset:<id>` purged once, best effort, so pages drop the lock.
- **The value changes from `members` to `premium`** → no queued purge; `asset:<id>` best
  effort, so a badge updates.
- **An R2 object with no `assets` row** → `404`, `private, no-store`, with asset gating on;
  as today without it.
- **A gated file referenced by a page on another brand** → cannot happen through the picker
  (chains never cross a brand); an imported key is governed by the owning brand's gate, and
  a share cannot open it (decision 8).
- **A gated file in a scope with no brand** → `403`. Setting `access` there is `400
  unsupported`.
- **The stored value is unreadable JSON** → treated as gated, logged once per isolate per
  key; `allowsAsset` receives `undefined` as the value.
- **`gate.public` is renamed in config** → files whose stored value is the old public value
  become gated, as pages do.
- **HEAD on a gated file** → the same admission; the same headers with no body.
- **Range requests** → a full `200`, as for every asset today; for a public file Cloudflare
  serves ranges from its cached copy, for a gated one the client takes the whole file (at
  most 20 MB).
- **Replica lag beyond ten minutes** → a request reading a replica that far behind can store
  a public copy after the queue has retired the file's row. This is the residual window of
  decision 10; the staging probe measures real lag, and an administrator's "Clear cached
  files" reaches it.
- **No cron on the host** → a failed purge waits in the queue for the next asset write, and
  the Assets screen shows the pending count meanwhile; the handbook says asset gating wants
  the cron that scheduled publishing and form deliveries already use.
- **A gradual deployment while files are being gated** → each version's purges are retried
  by the queue, and entries stored by a version that stops serving are never read again
  (the version is in the key).
- **A signed URL for a file that is public** → served as a public file (the signature is not
  consulted), with `bypass` from `cacheVerdict`, so it is not stored under the signed key.
- **A folder delete whose children already had their own values** → only null values are
  materialised.
- **Bulk access on 40 000 files** → batches queue rows; the final batch drains once, which
  is one `asset:*` call.
- **The editor's session expires while the admin is open** → thumbnails of gated files go to
  403 as other admin requests go to 401; the admin's sign-in redirect handles it.
- **A share whose story is deleted** → `readShareByToken` still finds the share but the
  draft read finds no story, so step 3 has no keys and the request falls through.
- **Form uploads (`sub_` keys)** → unaffected: `ASSET_KEY` refuses them on this route.

## Testing requirements

**Unit (`test/unit/`):**
- `server/gate.test.ts`: construction refusals; the option intersection.
- `server/pure.test.ts`: `assetAccessChanged` accepted by `validateHooks`.
- `server/cache-request.test.ts`: `sig` bypass; every existing case unchanged.
- `server/cache-purge.test.ts`: the drain (one call, tag or coarse tag, failure kept,
  settle rule, absent capability).
- `server/asset-signing.test.ts`: sign, verify, expiry, tamper, far-future, rotation, short key.
- `core/resolve.test.ts`, `core/cache-tags.test.ts`: `access` and `asset:` only for gated keys.
- `mcp/tools.test.ts`: eighteen tools; `update_asset`'s schema.
- `admin/`: decode, filter, move-confirmation counts, pending notice.

**Workers (`test/workers/`, real workerd):**
- `asset-access.test.ts` (new): inheritance, overrides, the one-PATCH move, concurrent
  interleavings, folder delete, uploads into a folder, bulk, fixed binds, queued rows in the
  write's batch, route-level pending and retry, bulk purge count, hook.
- `asset-gate.test.ts` (new): the route matrix of phase 3, private-key Cache API use, signed
  URLs, every actor kind, the share chain fence.
- `migrations.test.ts`: four columns, the table, its partial index, no index on `assets`.
- `single-site-pin.test.ts`: a no-gate asset response and a no-gate page render pinned.
- `assets.test.ts`: every row-answering route unchanged without asset gating.
- `asset-folders.test.ts`, `asset-bulk.test.ts`: existing suites pass unchanged on a no-gate config.
- `scope-partition.test.ts`, `api-partition.test.ts`: the new routes.
- `checks.test.ts`, `mcp.test.ts`, `gate.test.ts` (`page.signAsset`'s six cases), the
  `runSchedules` suite (the `assetPurges` pass).
- A query-count test in `read-session.test.ts`'s style: zero D1 statements on the asset
  route without asset gating, one with it for a public file.

**End to end (`scripts/*-test.mjs` against a live dev server):**
- `scripts/asset-access-test.mjs` (new), per phase 9.
- `scripts/api-test.mjs`, `scripts/mcp-test.mjs`, `scripts/media-library-test.mjs` extended.

**Against a deployment (a tool, never CI):**
- `scripts/cache-probe.mjs --asset` on a consumer's staging deployment, across two site hosts,
  the admin origin and a preview origin, before the v1.6.0 tag; any survivor blocks the
  release.

## Dependencies

- Spec 31 (`gate`, `visitor`, `isUngated`, `ResolvedGate`), spec 32 (folders, bulk walk,
  `content_refs` asset edges), spec 17 (the purger), spec 19 (`runSchedules`), spec 21
  (shares), spec 23 (scopes, chains, preview grants, `servesOnSite`, token bindings), spec 34
  (per-brand gate, `forScope`), spec 36 (the durable delivery queue this one mirrors), spec
  40 (`check_document`), spec 24 (the MCP tool table).
- Cloudflare: Workers Caching tag purges on the cached entrypoint. No new binding. A host
  using signed URLs adds one secret per deployment (`wrangler secret put`).
- Host: `gate.allowsAsset` (required to turn this on), optionally `gate.assetDenied` and
  `assetSigning`; writes and the `runSchedules` cron routed through the cached entrypoint
  (already required for publishes and scheduled publishing).

## Out of scope

- **Range requests on the asset route.** Absent today for every file; adding them is
  independent of gating and would change public responses too.
- **Hiding a gated file's metadata** from lists, search and `folio.query` (decision 13).
- **Per-visitor rendering of "can open / cannot open"** in Folio's output (decision 12).
- **Evicting copies already in browsers or proxies** when a public file is gated (decision 10).
- **Gating by tag.** Folders are the inheritance structure; a tag is a filter
  (`media-library.md` decision 2), and two inheritance sources would need a precedence rule.
- **Scheduled access changes** ("public from 1 March"). A host can call the v1 `PATCH` from
  its own cron.
- **`access` on collection item cards** (decision 12).
- **R2 presigned URLs** (decisions 5 and 9).
