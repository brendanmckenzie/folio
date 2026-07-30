# Feature: Caching published pages, and purging them on publish

> **Group:** platform
> **Build order:** 17
> **Size:** M ≈ a few days
> **Status:** ready
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-30

## Summary

Every published page is rendered from D1 on every request. There is no cache in
front of it and no `Cache-Control` on any HTML Folio or the demo emits
(`pages.tsx:252-255`, `examples/demo/src/index.tsx:440-444`). The demo's own hook
handlers say so out loud: *"This demo has no cache layer of its own yet
(ROADMAP.md's 'cache invalidation on publish'), so the example just logs; a real
host would purge `caches.default` here instead, keyed on `story.path`"*
(`examples/demo/src/index.tsx:153-156`).

`ROADMAP.md:286-298` calls this "pick a cache, not invent a mechanism". That
framing is wrong, and the research behind this spec is what corrects it: the
purge *set* is not computable from anything Folio stores. Globals leave no edge,
collection membership leaves no edge, a title change fires no event, and
`content_refs` truncates at 400 rows. A reverse index over `content_refs` would
be silently incomplete in five separate ways.

This spec takes the other route. **The dependency set is computed at render, not
looked up at purge**, emitted as `Cache-Tag` on the response, and purged by tag
through Workers Cache. Nothing is stored, no table is added, and the four
uncomputable cases stop being lookups.

## Ground truth

**server (`packages/folio/src/server/`):**
- `index.tsx:218` — `handle()` returns `null` for a published page. Folio owns
  `{base}/*` (`:159-162`) and `?_folio=preview` (`:165-216`) and nothing else.
  **Folio never constructs a published `Response`**, so it cannot cache one; the
  host does, in its own miss branch (`examples/demo/src/index.tsx:226-264`).
- `runtime.ts:478-626` — `resolve()`. Four passes. Pass 1 `storiesFor` over
  `linkedIds ∪ referencedIdsAllLocales ∪ globalIds` plus `ancestorPaths`
  (`:503-515`); pass 2 `publishedDocsByIds([...liveRefIds, ...globalIds])`
  (`:524-551`); pass 3 one level down, usually zero statements (`:560-569`);
  pass 4 collection queries, two statements each (`:582-591`).
- `runtime.ts:490` — `globalIds` comes from `FolioConfig.globals`, a **config
  constant**, mapped through `singletonId`. It is identical for every page.
- `hooks.ts:19-26` — six events: `published`, `unpublished`, `pathsChanged`,
  `created`, `deleted`, `checkpointed`.
- `hooks.ts:200-201` — `if (awaited.has(name)) await task; else ctx.waitUntil(task)`.
  Default is `waitUntil`; opting in is `FolioHooks.await` (`hooks.ts:100-101`).
- `hooks.ts:155-169` — a throwing hook is caught and logged, never fails the write.
- `hooks.ts:39-43` — `HookBase` is `{ env, waitUntil, actor }`. **There is no
  `ctx` and no `ExecutionContext` in a hook payload.**
- `runtime.ts:661, 670-674` — `internalHooks` is `[spaceBroadcastHooks(...)]`,
  composed into the runner before the host's. This is the extension point a
  purge hook joins.
- `publish.ts:154-176` — the atomic batch, then the `published` hook, with only
  pure JS in between. `unpublish` at `:211`/`:221`; the idempotent path at
  `:201-203` writes nothing and fires nothing.
- `migrate.ts:291-298` — `runMigrations` rewrites `published_doc` per story via
  `stampSchemaStatement`, one statement per story in the loop at `:200`.
  **No hook.**
- `reindex.ts:70-91` — rebuilds `content_index` and `content_refs` for every
  published document in one batch. Does not touch `published_doc`, but collection
  queries read `content_index` (`query.ts:174-181`). **No hook.**
- `routes/redirects.ts:61-88`, `:92-95` — manual redirect create and delete.
  **No hook.**
- `routes/stories.ts:214-217`, `routes/api/documents.ts:465-468` — `pathsChanged`
  is gated on `changes.length > 0`. A title-only patch writes `stories.title`
  (`stories.ts:830-837`) and fires **nothing**.
- `content-index.ts:54, 88` — `MAX_ROWS = 400` slices the ref set. A document
  with more outbound edges records only the first 400.

**core (`packages/folio/src/core/`):**
- `refs.ts:153-162` — `outboundRefs` walks `multilink`, richtext link marks,
  `reference` and `references`. `kind` is `'link' | 'reference'` only
  (`refs.ts:30-33`). **No global edge, no collection edge, no ancestor edge.**
- `resolve.ts:76-87` — `Resolution` carries `stories`, `docs`, `globals`,
  `locale`, `page`. This is the rendered page's dependency set, already assembled.
- `resolve.ts:55, 149, 166` — `StoryRef.title` and `ResolvedLink.title` come from
  `stories.title`, so a title change alters every page that links to it.
- `query.ts:191-204` — `queryKey` is computed per render and never stored.
- `locales.ts:157-164` — `localeContext` returns `undefined` for the source
  locale, so a default-locale render is byte-identical to an unlocalised one
  (`runtime.ts:485-488`).

**platform (verified against the installed toolchain, not only the docs):**
- `@cloudflare/workers-types@5.20260727.1` `index.d.ts:577-584` — `CachePurgeOptions`
  is `{ tags?, pathPrefixes?, purgeEverything? }`; `CacheContext.purge()` returns
  `Promise<{ success, errors }>`.
- Same file `:482` — `ExecutionContext.cache?: CacheContext`, **optional**.
- Same file `:14886` — `export const cache: CacheContext` inside the
  `cloudflare:workers` module namespace, **not** optional. The type lies about
  availability; the guard must be at runtime.
- `wrangler@4.114.0` `config-schema.json` — `RawConfig.properties.cache` →
  `CacheOptions` (`enabled`, `cross_version_cache`), and per-entrypoint at
  `WorkerEntrypointExport.properties.cache`.
- `miniflare@4.20260722.0` — **zero occurrences** of `purge`, `purgeEverything`,
  `pathPrefixes` or `CacheContext` in `dist/`. Workers Cache is **not simulated
  locally**, so `wrangler dev`, vitest-pool-workers and `scripts/*-test.mjs`
  cannot exercise a hit or a purge.
- Cache API (`caches.default`) deletes are **per-colo**: *"the `cache.delete`
  method only purges content of the cache in the data center that the Worker was
  invoked"* ([runtime-apis/cache](https://developers.cloudflare.com/workers/runtime-apis/cache/)).
  Already used, correctly and locally, by the asset transform route
  (`assets.ts:409-465`).
- Workers Cache purge *"propagate[s] globally with the same guarantees as
  zone-level purges"* ([workers/cache/purge](https://developers.cloudflare.com/workers/cache/purge/)).
  Limits: ≤1000 tags per response, ≤100 tags per purge call, 16 KB `Cache-Tag`
  header, and an account-wide purge rate limit of 5/minute on Free.

**measured on a deployed Worker, 2026-07-30** (a throwaway probe, `cache: { enabled: true }`,
no bindings, served from the MEL colo — these are not doc claims, they are observations):
- With caching **enabled**: `ctx.cache` is an object and `ctx.cache.purge` a function;
  `purge()` resolves `{ success: true, errors: [] }` in 68–334 ms.
- With caching **disabled**: `ctx.cache` is `undefined` **and** the `cloudflare:workers`
  `cache` export has no `purge` function. It does **not** throw and does **not**
  resolve `{ success: false }` — the capability is simply absent, so
  `typeof cache?.purge === 'function'` is a sound probe.
- `cloudflare:workers` exports `cache`, but **at module scope its `purge` is not a
  function** — it is request-scoped, like `env`. Resolving it at import time yields a
  dud; resolving it inside a request works. Both call styles behaved identically.
- A response with `Cache-Control: public, max-age=300` went `MISS` then `HIT`.
- Purge by tag was observed to produce a fresh render within **141–163 ms** at the
  serving colo, on the first poll, for `probe:page`, `global:header`, `type:insight`
  and `story:abc` alike — so a non-page tag purges its page exactly as the page's own
  id does, which is the mechanism decisions 2 and 6 rest on.
- **Single-colo.** Global propagation was not measured and cannot be from one client.
- Turning caching off does **not** purge what is already stored: one stale `HIT` was
  served after redeploying with `enabled: false`, before `Cf-Cache-Status` disappeared.

**demo (`examples/demo/`), verified by running it:**
- A published render (`GET /about`, after publishing `sty_about`) returns `200`,
  `content-type: text/html`, **no `Set-Cookie`** — with or without a session cookie on
  the request — and **no `Cache-Control` of any kind**. The `Set-Cookie` trap does not
  apply to the published path today; the missing `Cache-Control` is the gap this spec
  fills.
- `Vary: Origin` is present on every response in dev. Harmless for a browser
  navigation, which sends no `Origin`, but it is a cache variant and should be
  confirmed absent (or accepted) in production.
- The seed publishes nothing (`published_doc` appears zero times in `seed.sql`), so a
  published page has to be created before any of this is observable — worth knowing
  before writing a test that assumes otherwise.
- `src/index.tsx:226-264` — the entire published path, in host code.
- `src/index.tsx:157-165` — `published` and `unpublished` handlers that log.
- `src/index.tsx:134-137` — locale is a path prefix **by host choice**;
  `FolioConfig.route` (`types.ts:146`) lets a host put it anywhere.

## Owner decision checkpoints

**All five confirmed by the owner, 2026-07-30.** Two were confirmed *against* the
recommendation as first written; both are recorded below with what changed and
why, because the superseded reasoning is the more useful half.

1. **Workers Cache, plus a committed probe.** The Cache API cannot purge across
   colos and KV cannot propagate under 60 seconds, so Workers Cache is the only
   option that makes "publish is live now" true. The price is that no test in
   this repo can observe a hit or a purge (miniflare does not simulate it).
   **Confirmed with an amendment:** the original recommendation was to accept the
   gap and rely on pure functions. Building a throwaway probe to answer the open
   questions is what caught the request-scoped `cache` trap in decision 4 — a bug
   that would have shipped as a silent no-op and passed every unit test. So the
   probe is promoted to `scripts/cache-probe.mjs` and committed. It needs a
   deployed Worker and therefore cannot gate CI; it is a tool, not a test.
2. **Tags are emitted by the host, via one helper that carries both headers.**
   Folio has no published `Response` to attach a header to, and `handle()`
   deliberately keeps it that way. **Confirmed, with the API narrowed:**
   `cacheHeaders()` returns `Cache-Control` **and** `Cache-Tag` together and the
   docs show them applied as one spread, because the dangerous state is the
   half-configured one — `Cache-Control` without `Cache-Tag` is a page cached for
   its full TTL with no purge path, which fails silently and is worse than no
   caching at all. Forgetting both is harmless; that asymmetry is the argument.
3. **Four new hook events** — `updated`, `migrated`, `reindexed`,
   `redirectsChanged`. **Confirmed as recommended.** The first three are not
   optional: a cache without them is wrong in ways that surface days later as
   "the site didn't update". The fourth is a few lines once the pattern exists.
4. **A migration purges precisely; a reindex purges everything.** **Confirmed
   against the original recommendation**, which was `purgeEverything` for both.
   That was a mistake made before decision 2 was fully worked through: a
   migration *does* know the ids it rewrote, and because `story:X` is tagged on
   every page that *loaded* X rather than only X's own page, purging those ids is
   complete, not partial. A reindex genuinely cannot enumerate anything. See
   decision 6 for the batching threshold and why it exists.
5. **No `FolioConfig.cache` key.** **Confirmed as recommended**, and strengthened
   by measurement: `typeof cache?.purge === 'function'` is a sound probe, so a
   config key would only mirror `wrangler.jsonc` and could contradict it. The
   `auth` precedent — required with no default — does not transfer: forgetting
   `auth` silently produced a publicly editable CMS, whereas forgetting caching
   produces exactly today's behaviour.

## User stories

### An editor publishes and sees it live
**As** an editor **I want to** publish a page and have the public URL show the
change immediately **so that** I do not have to explain a stale page to anybody.

### A visitor gets a cached page
**As** a site visitor **I want** pages served from cache **so that** the site is
fast and does not rebuild itself for every reader.

### A global updates every page that renders it
**As** an editor **I want to** change the footer phone number **so that** every
page shows the new one, not just the footer's own preview.

### A host adopts caching in two lines
**As** a host developer **I want** caching to be a wrangler flag plus two headers
Folio hands me **so that** I do not have to work out a purge strategy myself.

### An editor is never shown their own draft by accident
**As** an editor **I want** preview to bypass the cache entirely **so that** a
draft can never be served to the public, or a published page to me.

## Architecture decisions

### 1. Workers Cache, not the Cache API and not KV

The Cache API is already used in this repo and is the obvious reach
(`assets.ts:409`). It is wrong here for one reason: **`cache.delete()` is
per-colo**. A publish hook runs in exactly one data centre; every other colo that
has served the page keeps serving it until TTL. That is not a cache with
invalidation, it is a TTL with extra steps.

KV loses on the other axis. Its propagation window is *"up to 60 seconds or
more"* globally for a write **or a delete**, and `cacheTtl` widens that window
rather than narrowing it. "Publish is live within about a minute" is a different
product from the one this spec is for. It also needs a namespace binding, which
means every host edits `wrangler.jsonc` **and** their `bindings` accessor — the
precedent at `types.ts:41-51` is explicit that a newly required binding *"breaks
every existing host on upgrade"*.

Workers Cache purges globally from inside the Worker with no binding, no API
token, no zone and no paid plan, and adds request collapsing and tiering that
neither alternative has. The cost is stated in decision 6.

### 2. The dependency set is computed at render, not looked up at purge

The obvious design is a reverse index: `content_refs` already stores outbound
edges and `ROADMAP.md:190` already promises it is *"what … a cache purge set will
read"*. It cannot be, and this is the load-bearing finding of the whole spec:

| Case | Why the index cannot answer it |
|---|---|
| Globals | `outboundRefs` walks fields; a global comes from config (`runtime.ts:490`). No row is ever written. |
| Collections | Membership is a query run at render (`query.ts:191-204`). No row, and `queryKey` is not stored. |
| Titles | A title-only patch changes every linking page's `ResolvedLink.title` and fires no event. |
| Large documents | `MAX_ROWS = 400` (`content-index.ts:54`) truncates the edge set by construction. |
| Ancestors | Loaded by path for breadcrumbs (`runtime.ts:513`), never an edge. |

So invert it. A render already knows every id it touched — that *is*
`Resolution` — and Workers Cache allows 1000 tags per response. Emit the
dependency set as tags at render time and the purge becomes
`purge({ tags: ['story:abc'] })` with no lookup at all. Four of the five rows
above dissolve; the fifth (ancestors) is covered because ancestors are in
`resolution.stories`.

The tag vocabulary is three prefixes:

```
story:<id>      every id in resolution.stories, plus the page's own id
global:<name>   every key in resolution.globals
type:<name>     the document type of every distinct collection query
```

`type:` is what makes collections work: an index page over `insight` is tagged
`type:insight`, and publishing any insight purges by that tag without anybody
knowing which pages exist.

### 3. Folio purges; the host tags

Ownership follows what each side actually holds. The host holds the `Response`,
so it sets `Cache-Control` and `Cache-Tag` — Folio has no published response to
put a header on (`index.tsx:218`). Folio holds the events and the id sets, so it
computes and it purges.

Rejected: the host purges too, in its own hook. It is more consistent with
`publish-hooks.md`'s "Folio computes, host acts" and it keeps an untestable
platform call out of the library. It loses because the purge set is derived from
Folio's own internals — which ids a render loads, what `type:` means, when a
migration touched everything — and every host would reimplement that mapping and
drift from it on the next release. A tag vocabulary is a contract; the thing that
mints tags should be the thing that purges them.

### 4. `import { cache } from 'cloudflare:workers'`, not `ctx.cache`

`HookBase` is `{ env, waitUntil, actor }` (`hooks.ts:39-43`); there is no
`ExecutionContext` in a hook payload, and both `hookCtx` helpers construct it by
hand from Hono's context (`routes/stories.ts:44-46`,
`routes/api/documents.ts:96-98` — duplicated, per trap I). Threading `ctx`
through would mean touching both, plus `alarmHookCtx` (`runtime.ts:741-750`),
whose whole point is that it has no request.

The module import needs none of that. The type declares
`export const cache: CacheContext` as non-optional (`index.d.ts:14886`) while
`ExecutionContext.cache` is optional (`:482`) and miniflare provides neither — so
the type is not a reliable availability signal and the call is guarded at
runtime regardless.

**Two corrections from measuring it, both load-bearing.** First, the imported
`cache` is **request-scoped**: at module scope its `purge` is not a function, so
`import { cache } from 'cloudflare:workers'` at the top of a file and caching the
reference gives a permanent dud. It must be dereferenced *inside* the hook, at
call time. Second, when the host has not enabled caching the capability is
**absent** rather than failing — no throw, no `{ success: false }` — so the guard
is `typeof cache?.purge === 'function'` and a try/catch is for genuine runtime
errors only, not for the disabled case. Both were verified on a deployed Worker;
see Ground truth.

### 5. The purge is awaited; the hook is not fire-and-forget

Hooks ride `waitUntil` by default (`hooks.ts:200-201`). For a cache purge that is
the race: the 200 reaches the editor, they reload, and a request in the window
re-populates the entry from stale D1-backed cache. `publish-hooks.md:68-71`
already chose the answer when it argued *"A cache purge sometimes should [add
latency], so that the next read is correct."*

So the internal purge hook awaits its own `purge()` and inspects
`result.success` — unlike `cache.put()`, Workers Cache purge returns a real
signal, and a rate-limit rejection arrives as `success: false` rather than a
throw. A failed purge is logged with the tags it could not clear. The host's
`await` list is untouched: this is Folio's own internal hook, and internal hooks
already run to completion before the host's (`hooks.ts:196-197`).

### 6. A migration purges precisely; a reindex purges everything

The two look alike and are not. `reindex` rebuilds `content_index` for the whole
site (`reindex.ts:70-91`), changing what every collection query returns, and its
affected set is "every page holding a collection" — which nothing records
(`query.ts:191-204`). It gets `purgeEverything: true`, because the alternative is
inventing a precision that does not exist.

`runMigrations` **does** know its affected set: it rewrites `published_doc` per
story in a loop it controls (`migrate.ts:291-298`). And decision 2 makes that set
sufficient rather than merely indicative — `story:X` is tagged on every page that
*loaded* X, not only on X's own page, so purging the migrated ids also catches
every page that references them. Precise purging is therefore **complete** here,
which is not obvious and is the reason this decision was reversed after the tag
vocabulary was settled.

The constraint is the purge rate limit: 100 tags per call, 5 calls per minute per
account on Free. So the rule is a threshold, not a principle:

```
tags in batches of 100
  ≤ MAX_PURGE_CALLS batches  → purge by tag, precisely
  > MAX_PURGE_CALLS batches  → purgeEverything, warn with the count
```

`MAX_PURGE_CALLS = 5` — one minute of Free-plan budget, so a run never spends
more than its own minute and never trips a limit it would then have to retry
past. That is roughly 500 documents; below it a three-document migration costs
one call and leaves the rest of the site cached, which is the case this
threshold exists to protect, because a migration is exactly when a site is
already churning.

Rejected: always precise, never flushing. A 10,000-document migration would be
100 calls crawling under the rate limit with the site half-invalidated for
twenty minutes, and a rejected call fails without failing the migration — the
worst of the three outcomes. Also rejected: always flushing, which is what this
spec said first and which throws away the cache of an entire site to invalidate
three pages.

Both branches log at `console.warn` naming the trigger and the count, because a
full flush is a thing an operator should be able to find afterwards.

### 7. `?_folio=preview` is a hard bypass, not a cache key component

The same URL returns draft HTML to an editor and published HTML to a visitor,
decided by the session cookie (`index.tsx:165-216`, the `return null` at `:180`),
and there is no `Vary` anywhere in `packages/folio/src`. A `Cookie` header does
not bypass Workers Cache and is not in its cache key, which is the dangerous
direction: an editor's draft and a visitor's page would collide on one entry.

So a preview response carries `Cache-Control: private, no-store` and **no**
`Cache-Tag`, set by Folio on the one preview response it does own
(`pages.tsx:252-255`). The host is told, in the README section this spec adds,
not to cache a request carrying `_folio=preview`. Belt and braces, because the
failure mode is serving an unpublished draft to the public.

### 8. Tag overflow degrades to a coarse tag rather than truncating

A page whose dependency set exceeds the budget (1000 tags, or 16 KB of header)
cannot be tagged precisely. Truncating silently would make it un-purgeable by the
dropped ids, which is the same silent-incompleteness this spec exists to avoid.

Every page therefore also carries a `site` tag, and a page over budget carries
**only** `site` plus its own `story:` id. Every purge call adds nothing, but the
two whole-site triggers (decision 6) purge `{ purgeEverything: true }` and
sweep it up. `folio.cacheTags()` returns a discriminated result so a host can
log the degradation rather than discover it.

### 9. The browser gets a zero TTL; the edge gets a long one

The default `cacheHeaders()` returns:

```
cache-control: public, max-age=0, s-maxage=604800, must-revalidate
```

**`max-age` is deliberately 0, and this is the correction that matters most in
the whole spec.** A purge reaches the edge and **cannot reach a browser cache**.
A visitor who loaded a page under `max-age=300` keeps their stale copy for five
minutes after publish and nothing can evict it — the editor sees the new page,
the visitor does not, and it fails in the one way that generates support
tickets. Earlier drafts of this spec, and the probe that measured the latency,
both used `public, max-age=300`. That was wrong, and it is the kind of wrong that
would have survived every test in Testing requirements.

`s-maxage` governs the shared cache only, which is exactly the part `purge()` can
clear. A week is deliberate: with invalidation measured under 165 ms there is no
reason for the edge copy to expire on a timer, and a long edge TTL is what turns
a correct purge into an actual hit rate. **The TTL is the fallback for a purge
that never arrives, not the mechanism.**

`must-revalidate` stops a browser serving its zero-age copy when offline.
`cacheHeaders(resolution, { maxAge })` overrides the browser number for a host
that wants one; `s-maxage` is not overridable, because a host that wants a short
edge TTL wants a different design, not a parameter.

Rejected: a single `max-age` for both, which is what almost every cache tutorial
shows. It is right when invalidation is impossible and wrong here, because it
spends the browser's staleness budget to buy nothing the edge is not already
giving for free — and purchases an unfixable stale page with it.

## Wire & schema changes

### D1 migration

None. This spec adds no table and no column — that is decision 2's whole point.

### `PROTOCOL_VERSION`

Unchanged at 4. Nothing here touches a socket frame or a logged mutation.

### Core / server types

```ts
/** The cache-tag set for a rendered page, and whether it had to be coarsened. */
export interface CacheTags {
  tags: string[]
  /** True when the dependency set exceeded the tag budget; `tags` is coarse. */
  degraded: boolean
}

/** Folio's advice for a published response. The host sets these headers. */
export interface CacheHeaders {
  'cache-control': string
  'cache-tag': string
}
```


New on `Folio<Env>`:

```ts
cacheTags(resolution: Resolution, doc?: Doc): CacheTags
cacheHeaders(resolution: Resolution, opts?: { maxAge?: number }): CacheHeaders
```

New hook events, additive to `HookEvent` and `FolioHooks`:

```ts
updated?: (e: UpdatedHookPayload<Env>) => unknown            // story, changed: ('title'|'titleI18n')[]
migrated?: (e: MigratedHookPayload<Env>) => unknown          // ids, migration ids applied
reindexed?: (e: ReindexedHookPayload<Env>) => unknown        // count
redirectsChanged?: (e: RedirectsChangedHookPayload<Env>) => unknown  // from: string[]
```

`validateHooks` (`hooks.ts:110-118`) rejects unknown keys at construction, so the
four names must be added to the runtime array at `hooks.ts:27-34` as well as the
type — a test should pin that the two lists agree.

### New or changed routes

None. Every trigger is an existing write path.

## Acceptance criteria

### Tags describe what a page rendered
```
GIVEN a page linking to story B, referencing record C, with a header global
  AND a collection field over type `insight`
WHEN the host calls folio.cacheTags(resolution)
THEN the result contains story:<page>, story:<B>, story:<C>,
     global:header, type:insight and site
AND degraded is false
```

### Publishing purges the page and its dependents
```
GIVEN story B is published
WHEN the published hook runs
THEN cache.purge is called once with tags containing story:<B>
AND with type:<B's type>, so every index page listing it is purged
```

### Publishing a global purges every page that rendered it
```
GIVEN `header` is a configured global
WHEN it is published
THEN cache.purge is called with global:header
AND no reverse index is consulted
```

### A title-only patch still purges
```
GIVEN a story is patched with a new title and an unchanged slug and parent
WHEN the write commits
THEN the `updated` hook fires with changed: ['title']
AND cache.purge is called with story:<id>
```

### A small migration purges only what it touched
```
GIVEN a content migration rewrites 142 published documents
WHEN the run completes
THEN cache.purge is called twice, with story: tags batched 100 and 42
AND purgeEverything is not used
AND pages merely referencing those documents are purged too,
    because story:<id> is tagged on every page that loaded <id>
```

### A large migration flushes instead, loudly
```
GIVEN a content migration rewrites 900 published documents
  AND MAX_PURGE_CALLS is 5
WHEN the run completes
THEN cache.purge is called once with purgeEverything: true
AND a console.warn names the migration and the document count
```

### A reindex always flushes
```
GIVEN POST /folio/reindex rebuilds the index for any number of documents
WHEN it completes
THEN cache.purge is called once with purgeEverything: true
AND a console.warn says why precision is not possible
```

### The browser is not asked to hold a copy
```
WHEN the host applies folio.cacheHeaders(resolution)
THEN cache-control contains max-age=0 and s-maxage=604800
AND a purge is therefore able to reach every copy that exists
```

### Preview is never cached
```
GIVEN a request carrying ?_folio=preview from an authenticated editor
WHEN Folio answers it
THEN the response carries Cache-Control: private, no-store
AND carries no Cache-Tag header
```

### A failed purge does not fail the write
```
GIVEN cache.purge resolves { success: false, errors: [...] }
WHEN a publish completes
THEN the publish still succeeds and the version row still exists
AND the failure is logged with the tags that were not cleared
```

### Absent platform support changes nothing
```
GIVEN a runtime where cache.purge is absent (local dev, workerd, vitest,
      or a deployed Worker with cache.enabled false)
WHEN a publish completes
THEN no error is thrown, the publish succeeds
AND behaviour is byte-identical to today
```

### The capability is resolved per call, never held
```
GIVEN the cloudflare:workers `cache` export, whose purge is request-scoped
WHEN the purge hook runs
THEN it dereferences cache.purge at call time inside the hook
AND never captures it at module scope, where purge is not a function
```

## Implementation plan

### Phase 1 — tags, pure and testable
1. `core/cache-tags.ts` — `cacheTags(resolution, doc?)`, pure, no I/O. The tag
   vocabulary, the `site` tag, and the overflow rule from decision 8.
2. `cacheHeaders()` beside it.
3. Unit tests: every field kind that contributes an id, the global case, the
   collection case, the overflow case, and the source-locale/no-locale collapse.

### Phase 2 — the four missing events
4. `hooks.ts` — add `updated`, `migrated`, `reindexed`, `redirectsChanged` to the
   type, the runtime array and the payload interfaces.
5. Fire them: `routes/stories.ts` and `routes/api/documents.ts` for `updated`
   (both copies); `migrate.ts` after the loop; `reindex.ts` after its batch;
   `routes/redirects.ts` on create and delete.
6. Workers tests that each fires with the right payload, and that `updated` does
   **not** fire when a patch changed nothing published-visible.

### Phase 3 — the purge hook
7. `server/cache-purge.ts` — an internal hook set in the shape of
   `spaceBroadcastHooks` (`space-events.ts:66-138`), mapping each event to a
   purge call. Guarded: dereference `cache.purge` **at call time inside the
   hook**, never at module scope (decision 4), and no-op when absent.
8. The batching helper from decision 6: chunk tags by 100, fall back to
   `purgeEverything` past `MAX_PURGE_CALLS`, warn on either branch. Pure, so it
   is unit-tested independently of the hook.
9. Register it in `internalHooks` (`runtime.ts:661`).
10. Workers tests against an injected fake `CacheContext`, asserting the tag sets
    per event. This is where the mapping is pinned; the real call is not testable.

### Phase 4 — the host side
11. `folio.cacheTags` / `folio.cacheHeaders` on the `Folio<Env>` object.
12. Demo: `"cache": { "enabled": true }` in `wrangler.jsonc`, one spread of
    `folio.cacheHeaders(resolution)` on the published response, and the
    `no-store` path for preview.
13. `scripts/cache-probe.mjs` (checkpoint 1) — the committed descendant of the
    throwaway probe. Takes a deployment URL, asserts MISS→HIT, purges each tag
    prefix, and reports time-to-fresh. Documented as requiring a deployed Worker
    and therefore never run by CI. It is the only thing that can catch a
    regression in the one line unit tests cannot reach.
14. `README.md` section — including the `Set-Cookie` trap, the `Vary: Origin`
    check, and why `max-age` is 0.
15. `ROADMAP.md` rewrite: the "pick a cache, not invent a mechanism" framing is
    wrong and should say so. **Done ahead of implementation**, since the
    correction is true whether or not this ships.

## Edge cases

- **`deleted.paths` contains `null`** for an unrouted document
  (`hooks.ts:64-69`) → purge by `story:<id>` from `ids`, never by path. The tag
  design sidesteps this entirely; a `pathPrefixes` design would not.
- **An idempotent unpublish writes nothing** (`publish.ts:201-203`) → no hook, no
  purge. Correct: nothing changed.
- **Two publishes of one story race** → two purges, unordered, both by the same
  tag. Idempotent, so order does not matter. This is why tags beat a
  read-then-purge design.
- **A sibling reorder fires nothing** (`stories.ts:815-818`) → `ord` is absent
  from `StoryRef` (`resolve.ts:42-59`), so no page's bytes change. A host nav
  built from `folio.tree()` is stale; named in ROADMAP already, unchanged here.
- **Purge rate limit hit** (5/min on Free) → `success: false`, logged with the
  tags. The next publish of the same story purges the same tag, so it is
  self-healing rather than permanently stale.
- **The host never sets the headers** → nothing is ever cached, purges are
  no-ops against an empty cache, and the site behaves exactly as today.
- **A deploy invalidates everything** by default, because Worker version is in
  the cache key. That is right for Folio: a renderer or block-schema change
  should not serve pre-change HTML. `cross_version_cache` is out of scope.
- **A response carrying `Set-Cookie` is never cached** by Workers Cache. The
  demo's published path sets none today — verified, including with a session
  cookie on the request — but a host that rolls a session on a published page
  silently gets zero caching and no error. Named in the README section.
- **A host turning caching off does not purge what is already cached.** Observed:
  one stale `HIT` after redeploying with `enabled: false`. Disabling is not an
  invalidation; a host that wants both should purge first, then disable.

## Testing requirements

**Unit (`packages/folio/test/unit/`):** the whole tag vocabulary. `cacheTags` is
pure, so every case above is a table test — id collection per field kind,
globals, collection types, the `site` tag, overflow degradation, and that a
source-locale render and an unlocalised one produce identical tags.

**Workers (`packages/folio/test/workers/`, real workerd):** the four new hook
events fire with correct payloads from real routes; the purge hook maps each
event to the right tag set, asserted against an **injected fake** `CacheContext`;
a `success: false` result does not fail the publish; an absent `cache` is a
no-op.

**End to end (`scripts/*.mjs`, port 5199):** nothing. Workers Cache is not
simulated by miniflare 4.20260722.0, so a local e2e script cannot observe a hit
or a purge. Stated here rather than left as a gap somebody rediscovers.

**Against a deployment (`scripts/cache-probe.mjs`):** the part no test can
reach — that a response is actually stored (MISS→HIT), that purging each tag
prefix produces a fresh render, and how long that takes. Takes a deployment URL,
runs read-only against it, and prints a table. **Not run by CI**, because it
needs a deployed Worker; run it after a change to the purge hook or the tag
vocabulary. This exists because the throwaway version of it caught the
request-scoped `cache` trap that every unit test in this spec would have passed.

**Not testable at all, and deliberately not faked:** that a purge propagates to
colos other than the one running the probe. One client cannot observe that. If a
stale page is ever reported from another region, this is the assumption to
re-test, and Ground truth records it as measured single-colo.

## Dependencies

- `platform/publish-hooks.md` — the seam. This spec adds four events to it and
  registers the first internal consumer after `spaceBroadcastHooks`.
- `content-model/globals.md` — its deferred wrinkle (`globals.md:208-212`) is
  closed here, by tags rather than by the purge-key scheme it anticipated.
- `content-model/collections.md` — `type:` tags are what make an index page
  purgeable; `content_refs` is **not** used, contrary to `ROADMAP.md:190`.
- Host: `"cache": { "enabled": true }` in `wrangler.jsonc`, Wrangler ≥ 4.107.0.
  No binding, no token, no zone, no paid plan.

## Out of scope

- **Caching the admin, the API, or preview.** Preview is explicitly bypassed
  (decision 7); the admin and `/folio/api/v1` are authenticated and change on
  every keystroke.
- **`cross_version_cache`.** Per-version keying is the safer default and the
  hit-rate cliff after a deploy is acceptable at this stage.
- **Stale-while-revalidate.** Workers Cache purge deletes rather than marks
  stale; Cloudflare has signalled a future `ctx.cache.invalidate()` that would be
  the better primitive, and this spec should not build around a shape that is
  about to change.
- **A cache for `folio.query()` / the Content API.** Different consistency
  contract; a script reading its own write must not be served a cached page.
- **Precise purging for migrations and reindex.** Decision 6.
- **Multi-site cache partitioning.** The Workers Cache key does not include the
  host, so two sites on one deployment collide at identical paths. Folio is
  single-site today; the remedy is `ctx.props`, and it belongs in whichever spec
  makes Folio multi-tenant.

## Open questions

All three opened with this spec were closed on 2026-07-30 by deploying a
throwaway probe Worker and by running the demo. The measurements are in Ground
truth; the answers are recorded here so the reasoning is not lost.

- ~~**Does `purge()` throw or resolve `{ success: false }` when caching is
  disabled?**~~ **Neither — it is absent.** `ctx.cache` is `undefined` and the
  `cloudflare:workers` `cache` export has no `purge`. The guard is a `typeof`
  probe, which is better than either alternative. Folded into decision 4.
- ~~**Actual purge propagation latency.**~~ **Under ~165 ms at the serving
  colo**, first poll, across four runs and all three tag prefixes. Fast enough
  that an editor reloading after publish sees the new page, so **no optimistic
  reload is needed**. Caveat kept: this is one colo, and global propagation
  cannot be measured from one client. If a rollout ever reports a stale page in
  another region, this is the assumption to re-test.
- ~~**Does anything on the demo's published path set a cookie?**~~ **No** — not
  on a published page, a 404, or a published page requested *with* a session
  cookie. The `Set-Cookie` trap is real but does not currently apply, and the
  edge case entry stays because a host can reintroduce it.

Still open, and now the only one:

- **Is `Vary: Origin` on the demo's responses a dev artefact or a production
  one?** It is a cache variant. Harmless for browser navigation, which sends no
  `Origin`, but it should be confirmed rather than assumed in Phase 4.
