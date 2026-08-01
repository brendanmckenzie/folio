/**
 * The shapes a host application configures Folio with, and the ones the route
 * files share with each other.
 *
 * Types only, with no runtime half: a route module can name the request context
 * and the config without importing the factory that builds them, which is what
 * keeps `index.tsx` free to import every route module in turn.
 */
import type { ReactNode } from 'react'
import type { AnyBlockDef, Registry } from '../core/block'
import type {
  CacheHeaderOptions,
  CacheHeaders,
  CacheTagOptions,
  CacheTags,
} from '../core/cache-tags'
import type { Doc } from '../core/doc'
import type { LocaleConfig } from '../core/locales'
import type { Migration } from '../core/migrate'
import type { Mutation } from '../core/mutations'
import type { ContentPage, ContentQuery } from '../core/query'
import type { Resolution } from '../core/resolve'
import type { DocumentType } from '../core/schema'
import type { StoryMeta, StoryNode } from '../core/story'
import type { AuthConfig, OpenAuth } from './auth/config'
import type { Actor } from './auth/roles'
import type { FolioHooks } from './hooks'
import type { AuditOptions, AuditReport } from './audit'
import type { MigrateOptions, MigrateReport } from './migrate'
import type { ReindexOptions, ReindexReport } from './reindex'
import type { ResolveOptions } from './runtime'
import type { ScheduleRunOptions, ScheduleRunReport } from './scheduler'
import type { PreviewWrap } from '../core/render-wrap'
import type { SpaceDO } from './space-do'
import type { StoryDO } from './story-do'
import type { WriteResult } from './write'

/**
 * `ResolveOptions` minus `draft`, which is Folio's own preview mode and not
 * something a host chooses: a published render always resolves published content.
 */
export type HostResolveOptions = Omit<ResolveOptions, 'draft'>

export interface FolioBindings {
  db: D1Database
  story: DurableObjectNamespace<StoryDO>
  /**
   * The space channel (`../../../docs/specs/editing/live-collaboration.md`):
   * cross-story presence and structural events.
   *
   * **Optional, deliberately.** Without it everything in that spec degrades to
   * the behaviour before it — per-story presence, a tree you refresh yourself —
   * rather than failing: the admin is told through its bootstrap and never opens
   * the socket, and no route 500s for want of a binding. A library that
   * hard-requires a new binding breaks every existing host on upgrade, and this
   * one needs a `wrangler.jsonc` migration tag as well as a binding
   * (`new_classes`, since the class holds no storage).
   */
  space?: DurableObjectNamespace<SpaceDO>
  /** R2 bucket for uploads. Without it the media library is read-only. */
  media?: R2Bucket
  /**
   * Images binding. Without it assets serve at their original size, which keeps
   * Folio working on a bare `wrangler dev` with nothing else configured.
   */
  images?: ImagesBinding
}

/**
 * The Durable Object's RPC surface, derived from the class rather than restated.
 *
 * `DurableObjectStub<StoryDO>` is what `story.get()` returns and is the honest
 * type, but *calling* a method on it fails to compile with TS2589 ("type
 * instantiation is excessively deep"): the RPC type mapper cannot chew through
 * `Doc`, whose value type is recursive. Picking the methods off the class keeps
 * every signature generated from the one definition — a hand-written mirror of
 * them drifts the moment the class changes — and never instantiates the mapper.
 * test/workers/smoke.test.ts hits the same wall and says so.
 */
export type StoryStub = Pick<
  StoryDO,
  'getOrInit' | 'getOrInitWithSyncId' | 'head' | 'recent' | 'purge' | 'commit' | 'hasTx' | 'fetch'
>

/**
 * The space object's RPC surface, picked off the class for the same reason
 * `StoryStub` is. Two methods: the upgrade, and the event broadcast.
 */
export type SpaceStub = Pick<SpaceDO, 'broadcastEvent' | 'fetch'>

export interface FolioConfig<Env> {
  blocks: readonly AnyBlockDef[] | Registry
  /**
   * Sugar for a single routable page type, and the only shape that existed
   * before `document-types.md`: `root: 'page'` is expanded to
   * `[{ name: 'page', label: 'Page', kind: 'page', root: 'page' }]`. The type's
   * *name* is always `'page'` whatever the root block is called, because that
   * is what `stories.type`'s default in `migrations/0001_init.sql` gives every
   * row's `type` column to — so an unchanged host config keeps resolving every
   * row it already had.
   *
   * Mutually exclusive with `types`, and `createFolio` throws at construction
   * when both or neither are given: a configuration mistake in a CMS should not
   * become a runtime 500 on one code path.
   *
   * @deprecated Declare `types` instead. `root` keeps working; the deprecation
   * is documented, not enforced.
   */
  root?: string
  /**
   * Every shape of document this site has: a routable page, an unrouted record,
   * or a singleton (`DocumentKind`). Each declares its own root block, so an
   * insight is not a page with six unused fields.
   */
  types?: readonly DocumentType[]
  bindings: (env: Env) => FolioBindings
  /**
   * Who may edit (`../../../docs/specs/foundation/identity-and-access.md`).
   *
   * **Required, with no default.** Either name the sign-in providers, or write
   * `auth: 'open'` to say deliberately that anyone who reaches the editor may
   * edit and publish. `createFolio` throws at construction otherwise
   * (checkpoint 2): Folio is a library, and a host that simply forgot this key
   * used to get a publicly editable CMS silently, whose failure mode is a
   * defaced site.
   *
   * Site-visitor auth — who may *read* a published page — is deliberately not
   * this key. See the spec's "Out of scope".
   */
  auth: AuthConfig<Env> | OpenAuth
  /** Where these routes are mounted. Default `/folio`. */
  basePath?: string
  /**
   * Public URL for a story path. `''` is the site root. `previewUrl` (see
   * `withUrls` in server/runtime.ts) is this same URL with a preview flag
   * appended, loaded straight into the admin's iframe — so it is a hard
   * requirement, not a courtesy, that it resolve to the *same origin* the
   * admin itself is served from. The admin↔preview postMessage bridge (see
   * core/protocol.ts and admin/hooks/usePreviewBridge.ts) checks
   * `event.origin` on every frame in both directions and drops anything else
   * silently; a `route` that points a story at a different origin does not
   * degrade to a broken preview, the iframe just never talks to the editor
   * at all.
   *
   * `locale` is the second parameter and the only place a locale reaches a URL
   * (`../../../docs/specs/content-model/localisation.md` architecture decision
   * 5). **The host owns the URL shape** — a path prefix, a subdomain, a query
   * parameter — because only the host knows how it encoded it; Folio needs the
   * inverse only for its own preview route, and derives that by asking this
   * function rather than by assuming a convention (see `pathForLocale` in
   * server/runtime.ts). Optional, so every existing `(path) => …` still
   * compiles and still means "the source locale".
   */
  route?: (path: string, locale?: string) => string
  /**
   * The languages this site is available in
   * (`../../../docs/specs/content-model/localisation.md`). Absent means a
   * single-locale site: no locale reaches a `Resolution`, every read is the
   * source locale, and nothing about any document or any URL changes.
   *
   * `default` is the **source** locale — the one `Blok.data` holds. Everything
   * else is a per-field override in `Blok.i18n`, so one document holds every
   * language and publishing publishes all of them at once (checkpoint 3).
   *
   * Validated at construction: a default that is not available, a duplicate
   * code, a fallback that does not exist, and a fallback cycle all throw.
   */
  locales?: LocaleConfig
  adminCss?: string[]
  previewCss?: string[]
  /**
   * Wraps the previewed document in the host's own providers, for the **server**
   * render of the preview page.
   *
   * Blocks are the host's components, and a real host's components sit inside
   * providers: a router, a theme, an i18n context. On a published page those
   * come from the host's own tree, but Folio's preview mounts a document and
   * nothing else — so a block calling `useLocation()` or rendering a `<Link>`
   * throws before a byte is sent, from a stack that names the block and not the
   * missing provider.
   *
   * **Its client half is a `wrap` export from the blocks module**, which the
   * Vite plugin's generated preview entry passes to `mountPreview`. Both are
   * required: this one alone and hydration throws, that one alone and the
   * server render throws, different ones and React discards the server markup
   * as a mismatch. Export the component once and name it in both places.
   *
   * A memory router rather than a browser one is usually right — the iframe's
   * URL is Folio's, not the page's — but that is the host's call and Folio has
   * no opinion.
   */
  previewWrap?: PreviewWrap
  /** Pass the `__FOLIO_ASSETS__` global the Vite plugin defines. */
  assets?: {
    admin: string
    preview: string
    devClient?: string
    adminCss?: string[]
    previewCss?: string[]
  }
  /**
   * After-commit callbacks for the host: cache purges, search indexing,
   * notifications (`../platform/publish-hooks.md`). Runs after a write has
   * already landed, never inside it — there is no `before` hook and no way
   * to veto or rewrite a publish. Validated for unknown keys at construction.
   */
  hooks?: FolioHooks<Env>
  /**
   * The `singleton` types loaded into every page's `Resolution` — a header, a
   * footer, site settings (`../../../docs/specs/content-model/globals.md`). An
   * explicit list rather than every declared singleton: a singleton read once
   * by the host at boot (`folio.global`) has no business in a per-request
   * resolution, so declaring it here is what makes the read set obvious.
   * Validated at construction — every name must name a declared `singleton`.
   */
  globals?: readonly string[]
  /**
   * Content migrations, in run order
   * (`../../../docs/specs/foundation/schema-migrations.md`). Each is a pure
   * function from a document to a list of mutations, written with
   * `defineMigration` from `folio/engine`.
   *
   * Declared here rather than discovered, because the order is the contract:
   * `stories.schema_id` records how far a document has come and compares
   * lexicographically, so the ids must sort in run order. `createFolio` checks
   * that (`validateMigrations`) rather than assuming it — a set of ids whose
   * declared order and sort order disagree would migrate documents in an order
   * that depends on which comparison happened to be used.
   *
   * Nothing runs automatically. `folio.migrate(env)` from a script, a deploy
   * step, or `POST {base}/migrate` (checkpoint 5).
   */
  migrations?: readonly Migration[]
}

export interface Folio<Env> {
  /**
   * Mount in the host's fetch handler. Returns null for anything Folio does
   * not own, so the host's own routes always win.
   */
  handle: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>
  /**
   * Published document for a URL path, or null. `path` is locale-*independent*
   * (`localisation.md` checkpoint 4): `/about` and `/fr/about` are the same
   * story, so the host strips its own locale prefix before calling this.
   *
   * `locale` does not choose a document — there is only one, holding every
   * language, and the locale rides on the `Resolution` instead. What it does do
   * is **refuse a locale this site has not declared**, so `/xx/about` answers
   * null (and the host's own 404) rather than serving English under a URL that
   * means nothing. Absent, or the source locale, behaves exactly as before.
   */
  published: (env: Env, path: string, locale?: string) => Promise<Doc | null>
  /**
   * What a path answers when it is not currently live: `'unpublished'` for a
   * story that was live and has been taken down, `'unknown'` for a path with
   * no story or one that has never been published — both never having served
   * the public. Folio itself only ever hands back `null` from `published`; a
   * host that wants to answer `410 Gone` for the former and `404` for the
   * latter calls this instead (`unpublish.md`).
   */
  status: (env: Env, path: string) => Promise<'live' | 'unpublished' | 'unknown'>
  /**
   * The story row behind a URL path, decorated with its urls, or null. One
   * indexed read.
   *
   * `published(env, path)` answers with the document alone, which is everything
   * a render needs and one thing short of everything a *response* needs: the
   * story's own id. Two things want it. `resolve(env, doc, { story })` needs it
   * to load this page's ancestors, so a breadcrumb resolves; and
   * `cacheHeaders(resolution, { story })` needs it because a page never appears
   * in its own resolution and `story:<id>` is the tag its next publish purges
   * by (`../platform/caching.md`).
   *
   * Deliberately a second call rather than a wider return from `published`,
   * which is a published type host code already reads.
   */
  storyAt: (env: Env, path: string) => Promise<StoryMeta | null>
  /**
   * A redirect for a path, or null. One indexed read.
   *
   * Called from the host's own 404 branch (`redirects.md`), after
   * `folio.published` has already answered null — Folio never intercepts
   * inside `handle()`, so a host's own routes always win, and a redirect is
   * for a path Folio no longer owns. `to` is either a path (resolve it against
   * the request's own origin) or an absolute URL for a manual off-site
   * redirect; either way it has already passed `isSafeHref` on the way out, so
   * it is always safe to hand straight to a `Location` header. Reattaching the
   * request's own query string is the host's job, not this call's: only the
   * host knows what it did with the rest of the URL.
   */
  redirect: (env: Env, path: string) => Promise<{ to: string; status: number } | null>
  /** Live draft for a story id, creating it on first touch. */
  draft: (env: Env, id: string) => Promise<Doc>
  /**
   * Commits mutations to a document's log
   * (`../../../docs/specs/platform/content-api.md` architecture decision 6).
   *
   * A host's own Worker already holds the bindings and should not have to make an
   * HTTP request to itself to write content. This is the same `commit` path
   * `PUT /api/v1/documents/:id/content` takes, with the same chunking at
   * `MAX_TX_MUTATIONS` and the same guarantees: the edit reaches every open
   * editor, lands in the activity trail under `opts.actor`, and is undoable.
   * `folio.draft(env, id)` is how you get the document to diff against;
   * `fromNested` / `diff` from `folio/engine` are how you turn a payload into
   * mutations.
   *
   * `opts.txId` is the idempotency handle: the same id twice is written once and
   * answered `replayed`. Scoped per document, because the log is.
   *
   * Refuses rather than half-applies. An unknown id is `not_found`, a document
   * over its caps is `too_large`, a structurally invalid transaction is
   * `conflict` — all as `FolioError`, which `folio/server` exports.
   */
  write: (
    env: Env,
    id: string,
    mutations: Mutation[],
    opts: { actor: string; name?: string; txId?: string },
  ) => Promise<WriteResult>
  /**
   * Every story, for sitemaps and static generation. With `locales` configured
   * each routed row also carries `urls` and `previewUrls` — the host's own
   * `route` called once per locale — so a sitemap covering every language needs
   * no second call and no knowledge of the URL shape.
   */
  stories: (env: Env, opts?: { page?: number; perPage?: number }) => Promise<StoryMeta[]>
  tree: (env: Env) => Promise<StoryNode[]>
  /**
   * Published documents matching a query
   * (`../../../docs/specs/content-model/collections.md`): filter, sort, page.
   *
   * The primitive an insights index, a news list, a team grid and a paginated
   * archive all turn out to be. Filters and sorts read `content_index`, which is
   * written inside the publish batch, so a query can never return a document that
   * is not live. `where`/`order` may only name a field a root block declares
   * `indexed: true`; anything else is a `bad_request` naming the field, never a
   * silent empty result.
   *
   * Two D1 statements: a `count(*)` for `total`, and the page itself with its
   * documents. Offset pagination, so a page can render "page 4 of 9".
   */
  query: (env: Env, q: ContentQuery) => Promise<ContentPage>
  /**
   * Rebuilds `content_index` and `content_refs` from `published_doc`
   * (`collections.md` architecture decision 3).
   *
   * Publish writes these rows, so this exists for the one case that cannot: a
   * schema change that marks an existing field `indexed`, where nothing
   * republishes. Batched and resumable — re-call with the previous answer's
   * `continueFrom` until it is null — and idempotent, so racing a publish is
   * harmless.
   */
  reindex: (env: Env, opts?: ReindexOptions) => Promise<ReindexReport>
  /**
   * Fires every publish and unpublish that is now due
   * (`../../../docs/specs/platform/scheduled-publishing.md`).
   *
   * **This is what a host calls from its own `scheduled()` handler**, and the cron
   * trigger in `wrangler.jsonc` is the whole of the integration:
   *
   * ```jsonc
   * // wrangler.jsonc
   * "triggers": { "crons": ["* * * * *"] }
   * ```
   *
   * ```ts
   * async scheduled(_controller, env, ctx) {
   *   let cursor: string | null = null
   *   do {
   *     const report = await folio.runSchedules(env, { continueFrom: cursor })
   *     cursor = report.continueFrom
   *   } while (cursor !== null)
   * }
   * ```
   *
   * Batched and resumable exactly like `migrate` and `reindex`: one call fires up
   * to `opts.batch` schedules and answers `continueFrom`, so a backlog of 500
   * pages cannot exceed one invocation's CPU limit. **Loop on `continueFrom`, not
   * on the report's `remaining`** — a schedule that failed transiently in this
   * sweep is still pending and still due, so the second loop spins.
   *
   * Granularity is the cron's. A schedule fires on the first sweep at or after its
   * due time, so it is never early and is late by at most one cron period.
   *
   * Without a cron the routes still work and nothing fires: `POST
   * {base}/api/schedules/run` is the manual trigger, and a site with nothing
   * scheduled costs one indexed read over an empty partial index.
   */
  runSchedules: (env: Env, opts?: ScheduleRunOptions) => Promise<ScheduleRunReport>
  registry: Registry
  /**
   * Context the document deliberately does not contain: story ids to their
   * current URLs, and so on. Await it before rendering.
   *
   * Resolution happens per render rather than being baked in at publish, because
   * a link stores a story id: renaming the linked-to page has to change every
   * href pointing at it, and a snapshot taken at publish time could not.
   *
   * `opts.locale` is what makes the whole render French: it becomes
   * `Resolution.locale`, which every field read goes through. An undeclared code
   * — or the source locale — leaves it absent, which is the source-locale read
   * path unchanged.
   *
   * **This used to load every story in the site on every render**
   * (`collections.md` decision 6). It now loads the ids the document needs: the
   * targets of its links (`multilink` fields *and* the link marks inside its
   * richtext), of its references, of the documents those pull in, and the
   * ancestors of `opts.story` when one is given. `opts.stories: 'all'` is the
   * escape hatch for a host that wants the full map — a navigation built from the
   * tree — and is exactly the old behaviour.
   */
  resolve: (env: Env, doc?: Doc, opts?: HostResolveOptions) => Promise<Resolution>
  render: (doc: Doc, opts?: { edit?: boolean; resolution?: Resolution }) => ReactNode
  /**
   * The cache tags a rendered page should carry, and whether the set had to be
   * coarsened (`../../../docs/specs/platform/caching.md`).
   *
   * Pure — no `env`, no I/O — because a `Resolution` already *is* the
   * dependency set of the page that was just rendered. That inversion is the
   * whole design: the purge set is not computable from anything Folio stores
   * (a global comes from config and writes no `content_refs` edge, collection
   * membership is a query run at render, a title change fires no event, and the
   * ref index truncates at 400 rows), so it is computed here instead and purged
   * by tag.
   *
   * Reach for this over `cacheHeaders` when you want to log `degraded`, or to
   * add tags of your own before setting the header.
   */
  cacheTags: (resolution: Resolution, opts: CacheTagOptions) => CacheTags
  /**
   * `cache-control` and `cache-tag` for a published response, as one spread:
   *
   * ```ts
   * return new Response(html, {
   *   headers: { 'content-type': 'text/html', ...folio.cacheHeaders(resolution, { story: story.id }) },
   * })
   * ```
   *
   * **Both headers or neither.** `Cache-Control` without `Cache-Tag` is a page
   * cached for its full TTL with no purge path — it fails silently and is worse
   * than no caching at all — whereas forgetting both is exactly today's
   * behaviour. That asymmetry is why this is one call.
   *
   * Needs `"cache": { "enabled": true }` in the host's `wrangler.jsonc` to do
   * anything. No binding, no token, no zone, no paid plan; without it these are
   * two headers nothing acts on, and every purge is a no-op.
   */
  cacheHeaders: (resolution: Resolution, opts: CacheHeaderOptions) => CacheHeaders
  /**
   * Published document for a global, or null — `name` is not required to be
   * one of `FolioConfig.globals`, since a host may read a singleton by name
   * (the "SEO defaults read once at boot" case) without wanting it fetched on
   * every page render (`globals.md`). Null for an unknown name, a non-singleton
   * type, or a singleton nothing has published yet — the same "nothing to show,
   * no error" shape as `published`.
   */
  global: (env: Env, name: string) => Promise<Doc | null>
  /**
   * A global, rendered from an already-built `Resolution` — never fetches, so
   * it is safe to call per keystroke in the preview. Null when the resolution
   * carries nothing for `name`: a global nobody has published yet, or a name
   * that was never in `FolioConfig.globals`. Passing `edit: true` outside a
   * Folio-owned preview leaks `data-folio-uid` markers onto a published page;
   * a host's own render call should not set it (`globals.md` edge case).
   */
  renderGlobal: (resolution: Resolution, name: string, opts?: { edit?: boolean }) => ReactNode
  /**
   * Runs the pending content migrations
   * (`../../../docs/specs/foundation/schema-migrations.md`). Explicit, never on
   * boot: a migration that runs itself on the first request after a deploy runs
   * inside a request whose CPU limit it can exceed, on a cold Worker, with
   * nobody watching (checkpoint 5).
   *
   * One call sweeps up to `opts.batch` documents and answers `continueFrom`;
   * re-call with it until it is null. `{ dryRun: true }` computes everything and
   * writes nothing — including no ledger row — and answers the same shape.
   *
   * Safe to run twice: migrations are idempotent, so a second run over a
   * migrated document produces zero mutations and reports it `unchanged`. That
   * is also how you check the first one worked.
   */
  migrate: (env: Env, opts?: MigrateOptions) => Promise<MigrateReport>
  /**
   * The drift report (`schema-migrations.md` decision 7): orphaned keys, unknown
   * block and document types, missing fields and document size across the
   * *published* documents, plus the schema-only checks. Read-only — nothing is
   * modified, and it is deliberately not part of the migrate path, since an audit
   * that runs as a side effect of a write is an audit nobody reads.
   *
   * **Batched like `migrate`**: one call reads up to `opts.batch` published
   * documents and answers `continueFrom`; re-call with it until it is null and add
   * the tallies up. A caller that stops early has audited a prefix of the site, so
   * `documents` and every count are that prefix's.
   */
  audit: (env: Env, opts?: AuditOptions) => Promise<AuditReport>
}

/**
 * Request-scoped values the handlers read off the context.
 *
 * `bindings` is set for every request by the middleware in middleware.ts, which
 * is the one place the host's `Env` is turned into Folio's own bindings.
 *
 * It is a call rather than a value, and that is the whole point: `config.bindings`
 * belongs to the host, so *invoking* it is observable — it may throw, or read
 * something lazily. The routes that answer without touching D1, R2 or the Durable
 * Object (`/schema`, which is a pure manifest; any 404; a socket upgrade refused
 * for want of the header) must not start depending on it merely because a
 * middleware runs ahead of them. The thunk is memoised per request, so a route
 * that does need the bindings costs exactly one call however many times it and
 * its middleware ask.
 *
 * `story` is only set on the routes that mount `loadStory`, and is typed as
 * always-present because Hono has no way to say otherwise: reading it in a
 * handler that does not sit behind that middleware is the mistake this comment
 * exists to name.
 */
export interface FolioVars {
  bindings: () => FolioBindings
  story: StoryMeta
  /**
   * Who is making this request, resolved by `withActor` (middleware.ts) from the
   * session cookie, then a bearer token, then nothing.
   *
   * A value, not a thunk — the opposite of `bindings`, and deliberately so.
   * `bindings` is memoised behind a call because *invoking* the host's accessor
   * is observable and some routes must not; resolving the actor is this
   * middleware's whole job, and a route that is gated on a role has already had
   * it resolved before its handler runs.
   *
   * Null means "nobody", which is either an unauthenticated request (the route
   * gate has already refused it, so a handler never sees this) or `auth: 'open'`,
   * where there are no users at all and every gate passes.
   */
  actor: Actor | null
}

/**
 * Hono's env for every Folio app and sub-app.
 *
 * `Env & object` rather than `Env`: Hono constrains `Bindings` to `object`, and
 * `createFolio`'s `Env` is deliberately unconstrained so a host can pass
 * whatever shape its Worker's env has. Intersecting satisfies the constraint and
 * leaves `c.env` assignable to `Env`, so `config.bindings(c.env)` needs no cast
 * — the previous `Bindings: never` made every handler write one.
 */
export interface FolioEnv<Env> {
  Bindings: Env & object
  Variables: FolioVars
}
