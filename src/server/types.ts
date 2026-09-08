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
import type { Doc, Json } from '../core/doc'
import type { PageAccess } from '../core/gate'
import type { LocaleConfig } from '../core/locales'
import type { Migration } from '../core/migrate'
import type { Mutation } from '../core/mutations'
import type { ContentPage, ContentQuery } from '../core/query'
import type { Resolution } from '../core/resolve'
import type { DocumentType } from '../core/schema'
import type { StoryMeta, StoryNode } from '../core/story'
import type { RenderMode } from '../preview/Render'
import type { AuthConfig, OpenAuth } from './auth/config'
import type { Actor } from './auth/roles'
import type { FolioHooks } from './hooks'
import type { AuditOptions, AuditReport } from './audit'
import type { CacheVerdict } from './cache-request'
import type { FolioForms } from './form-responses'
import type { FolioDb } from './db'
import type { MigrateOptions, MigrateReport } from './migrate'
import type { ReindexOptions, ReindexReport } from './reindex'
import type { ResolveOptions } from './runtime'
import type { ScheduleRunOptions, ScheduleRunReport } from './scheduler'
import type { PreviewWrap } from '../core/render-wrap'
import type { SpaceDO } from './space-do'
import type { StoryDO } from './story-do'
import type { WriteResult } from './write'

/**
 * What a host may ask `resolve` for.
 *
 * **This used to omit `draft`**, on the reasoning that it was Folio's own preview
 * mode and a published render always resolves published content. Draft mode
 * (`../../docs/specs/platform/draft-mode.md`) is exactly the case that reasoning
 * did not cover: a host rendering a draft at the page's real URL must resolve the
 * *targets* from their drafts too, or a drafted page links to and pulls in
 * published copies of everything else and is internally inconsistent.
 *
 * `ResolveOptions.search` (`../../docs/specs/content-model/full-text-search.md` architecture
 * decision 10) is the same shape a host reads its own `?q=` into and hands
 * straight to `resolve`, alongside `page` — this type carries it with no
 * change of its own, being a plain alias.
 */
export type HostResolveOptions = ResolveOptions

/**
 * The two values `?_folio=` takes, and the only two `handle()` recognises
 * (`../../docs/specs/platform/mcp-server.md` decision 5). Anything else is
 * handed back to the host, exactly as an unknown value always was.
 *
 * - `preview` — the editor's iframe: a `folio-editing` body, the postMessage
 *   bridge, markers on every block whatever its `render` returns.
 * - `draft` — the same document as a page. No body class, no client entry, no
 *   bridge, and `RenderMode` `mark`: uids on host elements and no marker `<div>`.
 *   This is what a share link lands on and what a screenshot photographs.
 *
 * A mode name rather than a boolean modifier on one mode: the two differ in what
 * they *are* for, and `?_folio=preview&chrome=0` is how you end up with four
 * combinations and two of them meaningless.
 */
export type PreviewMode = 'preview' | 'draft'

export interface FolioBindings {
  db: D1Database
  story: DurableObjectNamespace<StoryDO>
  /**
   * The space channel (`../../docs/specs/editing/live-collaboration.md`):
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
  /**
   * Cloudflare Browser Rendering — "Browser Run" as of its rename — for
   * `preview_document`'s screenshot (`../../../docs/specs/platform/
   * mcp-server.md` decisions 5a, owner checkpoint 1). `{ "browser": {
   * "binding": "BROWSER" } }` in `wrangler.jsonc`.
   *
   * **Optional, and its absence is a legible refusal**, exactly as `media`
   * already works (`routes/api/index.ts`'s `if (!media) throw new
   * FolioError('unsupported', ...)`): without it the tool answers the draft
   * URL and the rendered HTML instead of an image, and says why. A paid
   * add-on the owner has to provision, and the one thing in this library that
   * does not work against a local `wrangler dev` at all — Cloudflare's browser
   * is remote and cannot reach `localhost`.
   *
   * **No new runtime dependency.** This binding answers `quickAction()`
   * directly (Cloudflare's Quick Actions surface), which returns a plain
   * `Response` carrying image bytes — no `@cloudflare/puppeteer`, no browser
   * automation library. `BrowserRun`'s type ships in `@cloudflare/workers-types`,
   * already a devDependency for every other binding here.
   */
  browser?: BrowserRun
}

/**
 * `FolioBindings` with the database widened to what a query actually uses, so a
 * `D1DatabaseSession` can stand in for the binding.
 *
 * Every internal function that reaches D1 takes this rather than `FolioBindings`
 * — `FolioBindings` is still what a *host* declares, because only the real
 * binding can open a session in the first place. `FolioBindings` is assignable
 * to this, so a call site that has not been handed a session keeps working and
 * keeps talking to the primary. See `db.ts`.
 */
export type ReadBindings = Omit<FolioBindings, 'db'> & { db: FolioDb }

/**
 * What to do about a path that has no live page, answered in one round trip
 * (`reader.miss`).
 *
 * `'redirect'` when a rename or move recorded one for the path just vacated,
 * `'gone'` when the page was taken down on purpose (410), `'not-found'` when it
 * never existed (404). The distinction is `unpublish.md`'s and every host was
 * reimplementing it as two sequential calls to `redirect` then `status`.
 */
export type FolioMiss =
  /**
   * `to` is **rooted** — `/guides/new`, not the bare `guides/new` Folio stores
   * and matches paths by. It is the one path-shaped value in this API that
   * leaves as a `Location` header, and a bare one there is a relative URL: the
   * browser resolves it against the page it is already on and lands on
   * `/old/guides/new`. So `Response.redirect(new URL(miss.to, url.origin))` and
   * the barer `redirect(miss.to)` now answer the same thing.
   */
  { kind: 'redirect'; to: string; status: number } | { kind: 'gone' } | { kind: 'not-found' }

/**
 * One request's worth of reads, on one D1 session.
 *
 * **Why this exists rather than more methods on `Folio`.** Every read method on
 * `Folio` takes `env` and opens its own connection, which is right for a
 * one-shot call from a cron or a deploy script and wrong for a page render: a
 * render is three or four reads that should (a) go to the same replica, so the
 * references a document resolves are never older than the document, and (b) pay
 * for replica selection once. A session is the platform's name for exactly that
 * grouping, so this object is a session with the read API hung off it.
 *
 * The top-level `folio.published(env, …)` and friends are one-line delegations
 * to a throwaway reader — one implementation, two ergonomics, no second code
 * path to keep in step.
 *
 * Hand it the `Request` and `draftAt` works; without one it reads published
 * content only, which is the right default for a sitemap or a warm-up that must
 * not accidentally leak a draft into something cacheable.
 */
/** What `allows` is told about the document it is being asked to admit somebody
 * to, beyond the field value itself: enough to gate on the type, the path or the
 * language without re-reading anything. */
export interface FolioGateContext {
  story: StoryMeta
  doc: Doc
  locale?: string
}

/**
 * Visitor access (`../../docs/specs/platform/visitor-access.md`): who is asking,
 * and what may they read.
 *
 * Folio never learns who a visitor is and must not start to. The host answers
 * both halves; Folio owns only the cheap part — reading one named field off the
 * root block and comparing it, strictly, to `public`. That comparison happens
 * **before** `visitor` is touched, which is the property the whole design turns
 * on: a public page stays cacheable and costs no host call, and code that may
 * verify a token or call an IdP runs only when a document has asked for it.
 *
 * **`visitor` and `allows` are declared as methods, deliberately, not as
 * property-typed arrows** (decision 1). A host writes
 * `const gate: FolioGate<Env, Member> = {…}` and hands it to a config that holds
 * `FolioGate<Env>` — i.e. `FolioGate<Env, unknown>` — and under
 * `strictFunctionTypes` only *method* parameters are bivariant. Written as
 * properties, that assignment fails, and every host would have to type its
 * member as `unknown` and cast it back on the first line of `allows`.
 *
 * `FolioConfig<Env, V>` was rejected for the same ergonomics: every host writes
 * `createFolio<Env>(…)` with an explicit type argument, and an explicit argument
 * turns off inference for the rest, so `V` would always land on `unknown`.
 */
export interface FolioGate<Env, V = unknown> {
  /**
   * The root-block field holding the gate value. Must be one of the five scalar
   * kinds, `indexed: true`, and never `translatable` — `validateGate` throws at
   * construction otherwise, each for a reason the spec argues.
   */
  field: string
  /**
   * The one stored value that means "no gate". Anything else — including no
   * value at all — reaches `allows`, so a document created before the field
   * existed fails closed rather than open.
   */
  public: string | number | boolean
  /**
   * Who is asking. Runs at most once per reader, and never for an ungated page
   * or for an editor holding a draft or share credential.
   */
  visitor(req: Request, env: Env): V | null | Promise<V | null>
  /**
   * May this visitor read a document whose gate field holds `value`.
   *
   * `value` is `undefined` when the document has no such key, and `visitor` is
   * `null` both for a visitor the host did not recognise and for a reader built
   * without a `Request` — a sitemap build or a warm-up, where "no request" is
   * "nobody".
   */
  allows(
    visitor: V | null,
    value: Json | undefined,
    ctx: FolioGateContext,
  ): boolean | Promise<boolean>
}

/**
 * Machine-written alt text and descriptions
 * (`../../docs/specs/content-model/media-library.md` decision 8): **a host
 * function, not a provider name and an API key**.
 *
 * Folio holds no key, picks no model, writes no prompt and makes no outbound
 * call of its own. That is `gate`'s shape rather than a binding's, and it is the
 * whole design: the moment Folio owns the request it owns the retry policy, the
 * timeout nobody agrees on, and a vendor list to keep current. It owns none of
 * them, so `describe` needs no allowlist and no adapter to be useful — an
 * adapter (`anthropicDescriber`) is a convenience over this seam, never a second
 * one.
 *
 * Absent is the whole of "this site does not do this": no column is written, no
 * host code runs, the admin renders no *Describe* control, and the routes answer
 * `unsupported` — exactly as `media` and `browser` already do.
 */
export interface FolioDescribe<Env> {
  /**
   * The host's own model call. Whatever it returns is clamped and bounded
   * (`server/describe.ts`) before a byte of it is stored: it is arbitrary text
   * from a model, and a model is a caller.
   *
   * **Declared as a method rather than a property-typed arrow**, for
   * `FolioGate`'s reason above: only method parameters are bivariant under
   * `strictFunctionTypes`, and without that a host's
   * `FolioDescribe<Env>` would not be assignable to the `FolioDescribe<unknown>`
   * the runtime widens it to.
   */
  fn(input: DescribeInput, env: Env): Promise<DescribeResult>
  /** Describe a new upload in the background (`ctx.waitUntil`). Default true. */
  onUpload?: boolean
  /** In-flight model calls per batch. Default 4; 1–8, refused at construction
   * outside that. */
  concurrency?: number
}

/**
 * What a host's `fn` is handed.
 *
 * **`inline()` is the one way to the pixels, and it is bytes rather than a URL.**
 * Handing a provider a URL to fetch was the original design and it does not
 * survive contact with the platform Folio runs on: that fetch arrives from the
 * provider's network announcing itself as an AI agent, and Cloudflare's
 * AI-crawler blocking is a user-agent list a content site is right to be on. The
 * result was a paid call refused by the site paying for it. `url` is still here
 * because it is a true and occasionally useful fact about the asset — do not
 * build a provider call on it.
 *
 * `inline()` answers a **512px WebP** wherever `images` is bound — transformed
 * in this isolate from the R2 stream, the same way `serveAsset` does it, never
 * by fetching our own route (that needs an `image-resizing` loop guard, which is
 * why the serving route takes the stream directly). Without the binding it is
 * the stored original, and that is the expensive case: an order of magnitude
 * more tokens, and possibly over a provider's per-image ceiling.
 *
 * **With the binding, a transform it refuses rejects rather than answering the
 * original.** The binding takes 20MB, every provider's inline ceiling is far
 * below that, so an original that reaches a `fn` from this path is one that
 * cannot be sent anyway — the rejection names the resize that failed instead of
 * leaving the provider to complain about a size (#21). A `fn` need not catch it:
 * `describeAsset` records a throw in `describe_error` like any other.
 *
 * **Lazy**, because at `concurrency: 4` eagerly reading every one would put the
 * whole batch's bytes live in one isolate.
 */
export interface DescribeInput {
  id: string
  filename: string
  contentType: string
  width: number | null
  height: number | null
  /** `{base}/asset/<key>?w=512&f=webp` when `images` is bound, the original
   * otherwise. Absolute. **Not for a provider to fetch** — see above. */
  url: string
  /**
   * The image as bytes a provider can accept, with the media type of *those
   * bytes* rather than of the stored object — the row says `image/jpeg` where
   * the rendition is `image/webp`, and sending the wrong one is a 400 about
   * something else. Read from R2 on demand; not read unless called.
   */
  inline(): Promise<{ media: string; bytes: ArrayBuffer }>
  /**
   * Every tag that exists, for the prompt — and the *only* tags a result may
   * name (decision 11). A model handed an open vocabulary invents a near-synonym
   * per image, which is what would destroy the slug identity the whole taxonomy
   * rests on.
   */
  tags: readonly { id: string; name: string }[]
}

/**
 * What a host's `fn` answers, before Folio has looked at it.
 *
 * Every field is optional and every field is checked: a string that is not a
 * string is ignored, an over-long one is truncated, and a tag matching no
 * existing slug is dropped and **counted** rather than silently discarded
 * (decision 11) — a host whose prompt keeps proposing `product-shot` should find
 * out and create the tag.
 */
export interface DescribeResult {
  /** Alt text. Truncated to 500, matching `AssetPatchBody.alt`. */
  alt?: string
  /** What the file *is*. Truncated to 2000, matching `AssetPatchBody.description`. */
  description?: string
  /** Tag names or slugs. Matched against existing tag slugs; unmatched dropped. */
  tags?: readonly string[]
}

/**
 * Everything a host needs to answer one page request: `reader.page()`.
 *
 * Assembled from **one** read of the story row plus one resolve. The three-call
 * shape it replaces (`published`, then `storyAt`, then `resolve`) read the same
 * row twice, and left the host holding two things it could get silently wrong —
 * whether this render is a draft, and whether the response carries a `Cache-Tag`
 * to go with its `Cache-Control`.
 */
export interface FolioPage {
  doc: Doc
  /**
   * The story behind the path, decorated with its urls.
   *
   * Returned rather than fetched separately because a page never appears in its
   * own `Resolution` — `resolve()` loads what a document points *at* — so its id
   * is the one cache tag that cannot be derived from the render, and it is the
   * tag its own next publish purges by.
   */
  story: StoryMeta
  resolution: Resolution
  /**
   * This render came from the draft rather than the published copy: draw a
   * banner, and do not let it near a shared cache. `headers` has already taken
   * care of the second half.
   */
  draft: boolean
  /**
   * What the `gate` decided about this visitor
   * (`../../docs/specs/platform/visitor-access.md`). **Always present**, and
   * `'public'` for every page on a host that configured no gate, so a host that
   * branches on it reads a meaningful value rather than `undefined`.
   *
   * `'denied'` is not an error and not a miss: `doc` is the *redacted*
   * document — the root block with its prose removed — so the host renders its
   * teaser and paywall from the same `<Page doc={page.doc}>` it always did, and
   * chooses the status itself.
   *
   * Here for the same reason `headers` is: it is the half of the decision that
   * is silent when wrong. `'granted'` and `'denied'` both mean this URL answered
   * differently to different visitors, which is the one thing a shared cache
   * cannot represent — so `headers` is `no-store` for both, including the teaser
   * that looks visitor-independent and is not.
   */
  access: PageAccess
  /**
   * The cache headers this response must carry, correct for whichever of the two
   * cases this is: `no-store` for a draft, `Cache-Control` **and** `Cache-Tag`
   * for a published page.
   *
   * Both halves are here because both are silent when wrong. A draft answered
   * with the published headers is unpublished content on the edge under the
   * page's real URL; a published page answered with `Cache-Control` and no
   * `Cache-Tag` is cached for a week with no purge path.
   */
  headers: Record<string, string>
}

/** What `reader.page()` needs beyond the path. */
export interface FolioPageOptions {
  /** Refused if this site never declared it, exactly as `published` refuses it. */
  locale?: string
  /**
   * The page number every `collection` field in the document offsets to
   * (`collections.md` decision 5). The host reads `?page=`; Folio never does.
   */
  page?: number
}

export interface FolioReader {
  published: (path: string, locale?: string) => Promise<Doc | null>
  /**
   * One page request, answered from one row read plus one resolve — see
   * `FolioPage`. This is what a page route should call.
   */
  page: (path: string, opts?: FolioPageOptions) => Promise<FolioPage | null>
  draftAt: (path: string, locale?: string) => Promise<Doc | null>
  resolve: (doc?: Doc, opts?: HostResolveOptions) => Promise<Resolution>
  status: (path: string) => Promise<'live' | 'unpublished' | 'unknown'>
  storyAt: (path: string) => Promise<StoryMeta | null>
  redirect: (path: string) => Promise<{ to: string; status: number } | null>
  /**
   * `redirect` and `status` for a path, batched into a single round trip.
   *
   * The 404 branch of a host's router runs both — a redirect wins if there is
   * one, otherwise 410 or 404 turns on the story's state — and they are
   * independent lookups, so sending them together costs one network round trip
   * instead of two. On the host measured in September 2026 that halved the cost
   * of every 404, which is the path a crawler spends its whole budget on.
   */
  miss: (path: string) => Promise<FolioMiss>
  stories: (opts?: { page?: number; perPage?: number }) => Promise<StoryMeta[]>
  tree: () => Promise<StoryNode[]>
  query: (q: ContentQuery) => Promise<ContentPage>
  global: (name: string) => Promise<Doc | null>
  /**
   * This session's bookmark, or null before its first query.
   *
   * A host that wants read-your-writes across two of its own requests carries
   * this forward itself. Folio's own admin does exactly that in a cookie, inside
   * `handle()`; a public page render has nothing to carry and ignores it.
   */
  bookmark: () => string | null
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

/**
 * Where Folio sends the roughly forty operational events its own code already
 * logs by hand: a cache purge that did not happen, a scheduled publish that
 * failed three times, a sign-in provider whose mapper threw. Optional on
 * `FolioConfig`, defaulting to `console`, so a host that configures nothing
 * behaves exactly as every version before this key did.
 *
 * **Two methods, not a level, a filter, or structured fields** (owner decision,
 * 2026-09-07). Every existing call site already knows whether it is `error` or
 * `warn`; asking it to pick a numeric level would decide nothing a host could
 * not already tell from which method was called. Structured event fields
 * (a request id, a trigger name, a story id) are deferred on purpose: they can
 * arrive later as an **additional optional argument** without touching this
 * signature, which is the whole reason the shape ships this narrow now rather
 * than designing that later — widening a logger's call signature is free before
 * `1.0.0` carries a semver promise and a breaking change the moment it does.
 *
 * `...detail: unknown[]` rather than a fixed second parameter: the calls this
 * replaces pass an `Error` in most places, a plain string in some, and an array
 * of D1's own errors in `cache-purge.ts` — a rest parameter accepts all three
 * without this interface deciding anything about their shape.
 */
export interface FolioLogger {
  error(message: string, ...detail: unknown[]): void
  warn(message: string, ...detail: unknown[]): void
}

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
   * Who may edit (`../../docs/specs/foundation/identity-and-access.md`).
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
   * (`../../docs/specs/content-model/localisation.md` architecture decision
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
   * (`../../docs/specs/content-model/localisation.md`). Absent means a
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
   * notifications (`../../docs/specs/platform/publish-hooks.md`). Runs after a write has
   * already landed, never inside it — there is no `before` hook and no way
   * to veto or rewrite a publish. Validated for unknown keys at construction.
   */
  hooks?: FolioHooks<Env>
  /**
   * Where Folio sends its own operational log lines — see `FolioLogger`.
   * Absent means `console`, which is also what every call site already used
   * before this key existed, so an unconfigured host's log output does not
   * move.
   *
   * Threaded through `FolioRuntime` the way `hooks` and `gate` already are:
   * resolved once here, read at every one of the roughly forty call sites
   * that used to write `console.error`/`console.warn` directly. The messages
   * at those sites, including their `folio:` prefix, are unchanged — only the
   * sink is configurable now.
   */
  logger?: FolioLogger
  /**
   * Members-only pages, for a site whose membership lives outside Folio
   * (`../../docs/specs/platform/visitor-access.md`). Names a root-block field and two host
   * predicates; `reader.page()` consults them and answers `FolioPage.access`.
   *
   * Absent is the whole of "this site is public": no field is read, no host code
   * runs, and every page answers `access: 'public'` with the cache headers it
   * always had. Validated at construction (`validateGate`) — a gate whose field
   * is translatable, unindexed, the wrong kind, or declared on no `page` root is
   * a gate the editor believes in and nothing enforces.
   */
  gate?: FolioGate<Env>
  /**
   * Machine-written alt text, descriptions and tags for the media library
   * (`../../docs/specs/content-model/media-library.md` decision 8). One host function; Folio
   * holds no API key and chooses no model.
   *
   * Absent is the whole of "this site does not do this": the describe routes
   * answer `unsupported`, no machine column is ever written, and an upload
   * behaves exactly as it does today. Validated at construction
   * (`validateDescribe`) — a `fn` that is not a function, or a `concurrency`
   * outside 1–8, is a config mistake and should not become a 500 on whichever
   * request reaches it first.
   */
  describe?: FolioDescribe<Env>
  /**
   * What a host decides about form submissions
   * (`../../docs/specs/content-model/forms.md` decision 9): a `verify` function
   * for human verification, and the per-IP-hash rate limit.
   *
   * Absent is a complete answer rather than a gap — the honeypot always runs and
   * the default limit of ten an hour still applies; what is missing is only the
   * verification Folio cannot do on a host's behalf. Validated at construction
   * (`validateForms`), a rung more insistently than `gate` or `describe`: the
   * request that would otherwise discover a broken `verify` is an anonymous POST
   * from the public internet, and `verify` fails closed, so the symptom would be
   * a contact form that silently collects nothing.
   */
  forms?: FolioForms<Env>
  /**
   * The `singleton` types loaded into every page's `Resolution` — a header, a
   * footer, site settings (`../../docs/specs/content-model/globals.md`). An
   * explicit list rather than every declared singleton: a singleton read once
   * by the host at boot (`folio.global`) has no business in a per-request
   * resolution, so declaring it here is what makes the read set obvious.
   * Validated at construction — every name must name a declared `singleton`.
   */
  globals?: readonly string[]
  /**
   * Content migrations, in run order
   * (`../../docs/specs/foundation/schema-migrations.md`). Each is a pure
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
  /**
   * `false` disables `{base}/mcp` entirely
   * (`../../docs/specs/platform/mcp-server.md` owner checkpoint 2). Default
   * true.
   *
   * On by default because it is gated by the same `api_tokens` table as
   * `/api/v1`: every tool is one of those routes, dispatched internally with the
   * caller's own credential, so "on" adds no reachable surface a token could not
   * already reach. What it does add is one more authenticated endpoint on every
   * deployment that upgrades — so a host that has minted no tokens, or that does
   * not want an agent surface at all, should be able to say so in config rather
   * than leaving it to be inferred from an empty table.
   */
  mcp?: boolean
  /**
   * **A promise that your `fetch` calls `folio.draftAt`**
   * (`../../docs/specs/platform/draft-mode.md` decision 4). Default false.
   *
   * With it, a share link redirects a reviewer to the story's *real* URL, so they
   * see the page inside your own layout. Without it they land on `?_folio=draft`,
   * which Folio answers itself with its preview shell — the document's content on
   * your block CSS, but with globals stacked above it rather than placed where you
   * place them.
   *
   * Not inferred, because there is nothing to infer from: Folio cannot see whether
   * a host's miss branch calls `draftAt`. Not defaulted on, because the failure
   * mode of guessing wrong is the worst one available here — a reviewer
   * confidently approving a *published* page that looks correct and is stale.
   *
   * **The one way to hold this wrong** is to set it and not write the branch. Then
   * every share link lands on a published page and nothing says so.
   */
  draftMode?: boolean
}

export interface Folio<Env> {
  /**
   * Mount in the host's fetch handler. Returns null for anything Folio does
   * not own, so the host's own routes always win.
   */
  handle: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>
  /**
   * One request's worth of reads on one D1 session — see `FolioReader`.
   *
   * This is what a page render should use. The individual read methods below
   * each open their own session, which is the right shape for a one-shot call
   * and the wrong one for a render that makes three or four reads that ought to
   * agree with each other.
   *
   * Pass the `Request` whenever there is one: it is what makes `draftAt` and the
   * bookmark carried by an editor's browser work. A caller with no request in
   * hand (a sitemap build, a cron, a warm-up) omits it and reads published
   * content only.
   */
  reader: (env: Env, req?: Request) => FolioReader
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
   * by (`../../docs/specs/platform/caching.md`).
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
  /**
   * `redirect` and `status` for a path in a single round trip — the whole of a
   * host's 404 branch, and the shape every host was assembling by hand out of
   * the two calls above. See `FolioReader.miss`.
   */
  miss: (env: Env, path: string) => Promise<FolioMiss>
  /** Live draft for a story id, creating it on first touch. */
  draft: (env: Env, id: string) => Promise<Doc>
  /**
   * Commits mutations to a document's log
   * (`../../docs/specs/platform/content-api.md` architecture decision 6).
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
   * (`../../docs/specs/content-model/collections.md`): filter, sort, page.
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
   * (`../../docs/specs/platform/scheduled-publishing.md`).
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
  /**
   * Housekeeping for the auth tables nothing else prunes
   * (`../../docs/specs/foundation/auth-providers.md` decision 8): sessions past
   * expiry, sign-in challenges past their fifteen minutes or already consumed,
   * and `auth_events` rows older than its 90-day retention window.
   *
   * **A host obligation with no signal when it is forgotten.** Nothing breaks
   * when a deployment never wires this into a cron — an expired session already
   * fails `sessionExpiry` on read — so the failure mode is unbounded growth, not
   * an outage, and nothing anywhere else says so. `GET {base}/api/auth-events`'s
   * `oldestAt` is the one surface that shows it: an admin looking there can see
   * an oldest row far past 90 days and know the cron was never wired up.
   *
   * Not folded into `runSchedules`: that sweep is Folio's own publish/unpublish
   * workflow over a different table with a different retention rule. The
   * demo's `scheduled()` calls both, one after the other.
   */
  sweepAuth: (
    env: Env,
    opts?: { now?: number },
  ) => Promise<{ sessions: number; challenges: number; events: number }>
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
  /**
   * The draft of the page at `path`, when this request is allowed to see it, and
   * `null` otherwise (`../../docs/specs/platform/draft-mode.md` decision 1).
   *
   * This is the whole of draft mode's contract. Call it in your miss branch
   * *before* `published`, and render whatever comes back in your own layout:
   *
   * ```tsx
   * const draft = await folio.draftAt(env, req, path, locale)
   * const doc = draft ?? (await folio.published(env, path, locale))
   * if (!doc) { … }
   * const resolution = await folio.resolve(env, doc, { locale, draft: draft !== null })
   * return html(
   *   <Shell>{folio.render(doc, { resolution, mode: draft ? 'mark' : 'off' })}</Shell>,
   *   draft ? folio.noStore() : folio.cacheHeaders(resolution, { story: story.id }),
   * )
   * ```
   *
   * Two credentials satisfy it, and neither is inferred from the other: an
   * **editor** holding a session whose role reaches `READ_DRAFT` *and* who has
   * entered draft mode at `{base}/draft/enter`, which drafts every page; or a
   * **reviewer** holding a share cookie, which drafts exactly the granted story
   * and no other.
   *
   * **A request carrying none of those cookies costs no D1 read.** The test is a
   * string check on the `Cookie` header and this returns null before touching a
   * binding, so a stranger walking the site pays nothing — the same discipline
   * `handle()`'s preview branch keeps.
   *
   * Answering `null` is not an error and must not be rendered as one: it is the
   * ordinary case for every visitor, and the published page is what follows.
   */
  draftAt: (env: Env, req: Request, path: string, locale?: string) => Promise<Doc | null>
  /**
   * Whether this request asked for draft mode — the cookie, not the authority.
   *
   * For drawing a banner, and nothing else. It answers true for a browser that
   * entered draft mode even where `draftAt` will refuse the document, so it must
   * never gate what is rendered: the two questions are deliberately different, and
   * only `draftAt` has looked at a role or a grant.
   */
  inDraftMode: (req: Request) => boolean
  /**
   * The headers a draft response must carry: `private, no-store`, no cache tag.
   *
   * Exported because the failure it prevents is catastrophic and silent. A draft
   * cached at the edge under the page's real URL serves unpublished content to the
   * public until it evicts, and `cacheHeaders` cannot help — it answers for a
   * *published* render and will happily tag a draft for a week. The two calls look
   * interchangeable and are not, so the safe one is as easy to reach as the
   * dangerous one.
   */
  noStore: () => Record<string, string>
  /**
   * The document, rendered.
   *
   * **`opts.mode` replaced `opts.edit?: boolean`** (`../../../docs/specs/platform/
   * mcp-server.md` decision 5a). The boolean answered "am I being edited", which
   * is a different question from "is this addressable", and it could not spell the
   * third state at all: `mark` emits `data-folio-uid` on host elements and
   * nothing else, so the DOM is the published one and a caller can still clip a
   * screenshot to one block. Absent still means `off` — no markers — so a host
   * rendering its published pages passes nothing and is unaffected.
   */
  render: (doc: Doc, opts?: { mode?: RenderMode; resolution?: Resolution }) => ReactNode
  /**
   * The cache tags a rendered page should carry, and whether the set had to be
   * coarsened (`../../docs/specs/platform/caching.md`).
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
   * Folio's verdict on whether a request may be served from a shared cache, or
   * `null` when the path is the host's own to classify (`cache-request.ts`).
   *
   * Workers Caching is opt-*out* — a 200 with no `Cache-Control` is stored under
   * heuristic freshness for two hours — so this question is asked about every
   * request, and the knowledge to answer it is Folio's: which paths it owns,
   * that `{base}/asset/:key` is public while `{base}/api/assets` is not, and
   * which three cookies mean "this render may be a draft".
   */
  cacheVerdict: (req: Request) => CacheVerdict
  /**
   * The URL a request should be cached under, with click identifiers (`utm_*`,
   * `gclid`, `fbclid`, …) removed and the survivors sorted.
   *
   * Pass it as `cf.cacheKey` on the loopback fetch to a cached entrypoint; a hit
   * is answered before the Worker runs, so nothing can re-key an inbound
   * request. Left in, `fbclid` and `gclid` are unique per click, so every paid
   * and social visitor both misses the cache and writes an entry nobody will
   * read again.
   */
  cacheKey: (url: string | URL) => string
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
   * that was never in `FolioConfig.globals`. Passing any `opts.mode` other than
   * `off` outside a Folio-owned preview leaks `data-folio-uid` markers onto a
   * published page; a host's own render call should not set it (`globals.md` edge
   * case). Absent is `off`, so the ordinary call is unchanged.
   */
  renderGlobal: (resolution: Resolution, name: string, opts?: { mode?: RenderMode }) => ReactNode
  /**
   * Runs the pending content migrations
   * (`../../docs/specs/foundation/schema-migrations.md`). Explicit, never on
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
  bindings: () => ReadBindings
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
