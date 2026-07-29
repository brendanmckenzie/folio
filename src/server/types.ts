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
import type { Doc } from '../core/doc'
import type { Resolution } from '../core/resolve'
import type { DocumentType } from '../core/schema'
import type { StoryMeta, StoryNode } from '../core/story'
import type { AuthConfig, OpenAuth } from './auth/config'
import type { Actor } from './auth/roles'
import type { FolioHooks } from './hooks'
import type { StoryDO } from './story-do'

export interface FolioBindings {
  db: D1Database
  story: DurableObjectNamespace<StoryDO>
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
  'getOrInit' | 'getOrInitWithSyncId' | 'head' | 'recent' | 'purge' | 'commit' | 'fetch'
>

export interface FolioConfig<Env> {
  blocks: readonly AnyBlockDef[] | Registry
  /**
   * Sugar for a single routable page type, and the only shape that existed
   * before `document-types.md`: `root: 'page'` is expanded to
   * `[{ name: 'page', label: 'Page', kind: 'page', root: 'page' }]`. The type's
   * *name* is always `'page'` whatever the root block is called, because that
   * is what `migrations/0006_document_types.sql` defaults every pre-existing
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
   */
  route?: (path: string) => string
  adminCss?: string[]
  previewCss?: string[]
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
}

export interface Folio<Env> {
  /**
   * Mount in the host's fetch handler. Returns null for anything Folio does
   * not own, so the host's own routes always win.
   */
  handle: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>
  /** Published document for a URL path, or null. */
  published: (env: Env, path: string) => Promise<Doc | null>
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
  /** Every story, for sitemaps and static generation. */
  stories: (env: Env) => Promise<StoryMeta[]>
  tree: (env: Env) => Promise<StoryNode[]>
  registry: Registry
  /**
   * Context the document deliberately does not contain: story ids to their
   * current URLs, and so on. Await it before rendering.
   *
   * Resolution happens per render rather than being baked in at publish, because
   * a link stores a story id: renaming the linked-to page has to change every
   * href pointing at it, and a snapshot taken at publish time could not.
   */
  resolve: (env: Env, doc?: Doc) => Promise<Resolution>
  render: (doc: Doc, opts?: { edit?: boolean; resolution?: Resolution }) => ReactNode
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
