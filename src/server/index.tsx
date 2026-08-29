import { cacheHeaders, cacheTags } from '../core/cache-tags'
import { isKnownLocale } from '../core/locales'
import { singletonId } from '../core/schema'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { createApp } from './app'
import { audit } from './audit'
import { shareCookieTokens } from './auth/cookie'
import { credentialOf, resolveActor } from './auth/resolve'
import { allows, READ_DRAFT } from './auth/roles'
import { claimShare } from './auth/shares'
import { FolioError } from './errors'
import { runMigrations } from './migrate'
import { previewPage } from './pages'
import { lookupRedirect } from './redirects'
import { reindex } from './reindex'
import { alarmHookCtx, createRuntime } from './runtime'
import { runSchedules } from './scheduler'
import {
  listStories,
  publishedDoc,
  publishedDocsByIds,
  storyByPath,
  storyById,
  storyStatus,
  storyTree,
} from './stories'
import { SpaceDO } from './space-do'
import { createStoryDO, StoryDO } from './story-do'
import type { Folio, FolioConfig } from './types'
import { commitAll } from './write'

/**
 * The story object, ready made for a host whose D1 binding is named `DB`.
 *
 * **If it is named anything else, build your own** — `createStoryDO` is exported
 * beside this for exactly that, and it is one line:
 *
 *     export const StoryDO = createStoryDO<Env>({ db: (env) => env.MY_D1 })
 *
 * A Durable Object is constructed by the runtime with the raw host env and never
 * sees `createFolio`'s `bindings`, so this is the one binding the object needs
 * declared twice. Getting it wrong used to be near-silent — the constructor now
 * refuses, because the only reader is a background alarm and the symptom was a
 * content tree that never showed unpublished changes.
 */
export { StoryDO, createStoryDO }
export type { StoryDOConfig, StoryDOInstance } from './story-do'
/**
 * The space channel's Durable Object
 * (`../../docs/specs/editing/live-collaboration.md`). A host exports this and
 * binds it as `SPACE` to get cross-story presence and structural events; without
 * it everything that channel carries is simply absent.
 *
 * **Declared with `new_classes`, not `new_sqlite_classes`** — it holds no storage
 * at all. See README.
 */
export { SpaceDO }
export type { SpaceEvent, SpacePresence } from '../core/protocol'
/**
 * The Content API (`../../docs/specs/platform/content-api.md`): what one write
 * reports, and the payload shapes the routes answer. `toNested` / `fromNested`
 * themselves ship from `folio/engine`, with the rest of the document tooling.
 */
export type { WriteResult, WriteActor } from './write'
export type { ApiDocument, ApiDocumentMeta } from './routes/api/documents'
export { API_VERSION } from './routes/api'
export type { DocumentKind, DocumentType } from '../core/schema'
export type { Migration } from '../core/migrate'
export type { VersionKind, VersionMeta } from './versions'
export type { Redirect } from './redirects'
/**
 * The migration and audit surface a host reads off a report. The *authoring*
 * side (`defineMigration`, `field`, `block`) lives in `folio/engine`, where the
 * rest of the document tooling is.
 */
export type {
  MigrateFailure,
  MigrateOptions,
  MigrateOversized,
  MigrateReport,
  MigrationStatus,
} from './migrate'
export type {
  AuditOptions,
  AuditReport,
  ContentFinding,
  DocumentSizeFinding,
  SchemaFinding,
  StoryFinding,
} from './audit'
/**
 * Collections (`../../docs/specs/content-model/collections.md`): the query
 * shapes a host writes and reads. `collection()` itself, and the resolved value a
 * block renders, ship from `folio/core` with the rest of the field builders.
 */
export type { ReindexOptions, ReindexReport } from './reindex'
/**
 * Scheduled publishing (`../../docs/specs/platform/scheduled-publishing.md`):
 * what `folio.runSchedules` takes and reports, and the row itself — a host writing
 * its own dashboard, or a deploy check asserting nothing is stuck in `failed`,
 * reads the same shape the admin does. `Schedule` and its two vocabularies come
 * from `folio/core`'s `story.ts`, since they travel in URLs and the admin reads
 * them too; they are re-exported here so a host holding a `folio` object needs one
 * import rather than two.
 */
export type { ScheduleFailure, ScheduleRunOptions, ScheduleRunReport } from './scheduler'
export { MAX_SCHEDULE_ATTEMPTS } from './scheduler'
export type { Schedule, ScheduleAction, ScheduleStatus } from '../core/story'
export type {
  ContentOrder,
  ContentPage,
  ContentQuery,
  ContentWhere,
  ResolvedCollection,
} from '../core/query'
export { countReferencesTo, indexedValuesFor, referencesTo } from './content-index'
export type { IndexedValue, IndexedValues } from './content-index'
/**
 * Data documents (`../../docs/specs/content-model/data-documents.md`): what
 * points at a document, for the warning shown before deleting it. Exported for a
 * host that wants the same answer outside the admin — a deploy check, a report —
 * rather than only from `GET {base}/documents/:id/usage`.
 */
export { documentUsage } from './stories'
export type { DocumentUsage, UsageRef } from './stories'
export type {
  CheckpointedHookPayload,
  CreatedHookPayload,
  DeletedHookPayload,
  FolioHooks,
  HookEvent,
  MigratedHookPayload,
  PathsChangedHookPayload,
  PublishedHookPayload,
  RedirectsChangedHookPayload,
  ReindexedHookPayload,
  StoryChange,
  UnpublishedHookPayload,
  UpdatedHookPayload,
} from './hooks'
export { FolioError } from './errors'
export type { ErrorEnvelope, FolioErrorCode } from './errors'
export { magicLink } from './auth/magic-link'
export { oidc } from './auth/oidc'
export {
  ADMIN,
  ASSETS,
  atLeast,
  EDIT,
  hasScope,
  CREATE,
  MANAGE,
  PUBLISH,
  READ,
  READ_DRAFT,
  ROLES,
  SCOPES,
} from './auth/roles'
export type { Access, Actor, Role, Scope, TokenActor, UserActor } from './auth/roles'
export type {
  AuthConfig,
  AuthProvider,
  MagicLinkMail,
  Provisioning,
  VerifiedIdentity,
} from './auth/config'
export type { UserRow } from './auth/users'
export type { TokenRow } from './auth/tokens'
/**
 * Draft preview sharing (`../../docs/specs/platform/draft-sharing.md`): the row a
 * screen draws, and the two bounds on a link's life.
 *
 * `ShareRow` carries no token and no hash, so it is safe to hand anywhere the row is
 * wanted. **`ShareGrant` is deliberately not exported**: it is what a live link
 * authorises, it is meaningful only inside `handle()`'s preview branch, and putting
 * it on the public surface would invite somebody to build a second gate out of it.
 */
export type { ShareRow, ShareState } from './auth/shares'
export { DEFAULT_SHARE_DAYS, MAX_SHARE_DAYS } from './auth/shares'
export { FolioDoc } from '../preview/Render'
/**
 * The two vocabularies the chrome-free draft render introduced
 * (`../../docs/specs/platform/mcp-server.md` decision 5): `RenderMode` is what
 * `folio.render`/`folio.renderGlobal` take — it replaced an `edit?: boolean` that
 * could not spell `mark` — and `PreviewMode` is the value of `?_folio=`.
 */
export type { RenderMode } from '../preview/Render'
export type { PreviewMode } from './types'
export { Shell, serializeJson } from './Document'
export type { StoryMeta, StoryNode } from '../core/story'
export type { Resolution } from '../core/resolve'
/**
 * Caching (`../../docs/specs/platform/caching.md`): what `folio.cacheTags`
 * and `folio.cacheHeaders` take and answer. The functions themselves also ship
 * from `folio/core`, since they are pure and a host rendering without a `folio`
 * object in hand can still call them.
 */
export type {
  CacheHeaderOptions,
  CacheHeaders,
  CacheTagOptions,
  CacheTags,
} from '../core/cache-tags'
export { ANY_TYPE_TAG, NO_STORE, SITE_TAG, globalTag, storyTag, typeTag } from '../core/cache-tags'
/** Locales (`localisation.md`): the config a host declares, and the context a
 * render reads. `fieldValue`/`dataOf` ship from `folio/core`, with the rest of
 * what a block author needs. */
export type { LocaleConfig, LocaleContext, LocaleDef, TranslationStatus } from '../core/locales'
export type { AssetRow } from './assets'
export type { Folio, FolioBindings, FolioConfig } from './types'

/**
 * Wires a block registry and a set of bindings into the HTTP surface, the
 * document helpers a host renders with, and nothing else: this factory owns the
 * composition and none of the behaviour.
 *
 * The pieces, in the order a request meets them: runtime.ts derives everything
 * that comes off the config once, app.ts mounts a sub-app per resource under
 * `basePath`, and publish.ts holds the workflows a route only translates for.
 */
export function createFolio<Env>(config: FolioConfig<Env>): Folio<Env> {
  const rt = createRuntime(config)
  const app = createApp(config, rt)

  const handle: Folio<Env>['handle'] = async (req, env, ctx) => {
    const url = new URL(req.url)

    if (url.pathname === rt.base || url.pathname.startsWith(`${rt.base}/`)) {
      // The one cast in the server: `Env` is unconstrained by design, and Hono
      // requires an object. See `FolioEnv` in types.ts.
      return app.fetch(req, env as Env & object, ctx)
    }

    /**
     * `_folio` is a **mode name**, and there are two (`../../../docs/specs/
     * platform/mcp-server.md` decision 5): `preview` is the editor's iframe,
     * `draft` is the same document served as a page. Anything else — a typo, a
     * third name from a newer admin talking to an older Worker — is handed back to
     * the host untouched, which is what an unrecognised value has always done here
     * and is the only answer that keeps "a host's own routes win at any path" true.
     */
    const mode = url.searchParams.get('_folio')
    if (mode === 'preview' || mode === 'draft') {
      const bindings = config.bindings(env)

      // A preview renders the *draft*, so it needs the same gate the API routes
      // got in identity-and-access.md — and it is the one such surface that lives
      // outside `basePath`, so the app's own middleware never sees it. Without
      // this, appending `?_folio=preview` to any URL would read unpublished
      // content on a site that had otherwise closed its editor entirely.
      //
      // Refused by handing the request *back* rather than by answering 401: to
      // an unauthenticated visitor the flag then means nothing at all and the
      // host serves its ordinary published page, which is both the safe answer
      // and the least surprising one.
      /**
       * A share token in the browser's cookie is the *second* way this branch can be
       * satisfied (`../../docs/specs/platform/draft-sharing.md`), and it is
       * deliberately narrower than the first in every dimension:
       *
       *   - It is **not an actor.** `claimShare` answers a `ShareGrant` — an id, one
       *     story id, an expiry — which `allows()` cannot be called with, so no route
       *     gate anywhere in the server can be satisfied by it. This branch is the
       *     only code that can act on one at all.
       *   - It authorises **one document**, checked against the story the requested
       *     path actually resolves to, below. Another page's URL with the same cookie
       *     is handed back to the host exactly as an unauthenticated one is.
       *   - It cannot ask for `?as=`, also below.
       *
       * Only reached when the ordinary gate has already failed, and only when the
       * cookie exists at all, so the "no D1 read for a request with no credential"
       * discipline is intact: a stranger appending the flag to a random URL still
       * costs the database nothing.
       */
      let shared: string[] = []
      if (rt.auth.mode === 'session') {
        const actor = await resolveActor(() => bindings.db, rt.auth, credentialOf(req))
        if (!allows(actor, READ_DRAFT)) {
          shared = shareCookieTokens(req.headers.get('cookie'))
          if (shared.length === 0) return null
        }
      }

      // `?locale=` is what the admin's switcher appends (`localisation.md`
      // decision 6). An undeclared code is refused the same way an undeclared
      // `as` below is — by handing the request back, so the host's own routes
      // win rather than Folio guessing what was meant.
      const asked = url.searchParams.get('locale')
      if (asked !== null && !isKnownLocale(rt.locales, asked)) return null
      const locale = asked ?? undefined

      // The path with the host's own locale decoration removed. Derived by
      // asking `config.route` rather than by assuming a prefix convention: the
      // admin built this URL from `previewUrls`, which `route` produced, so the
      // inverse is exact for whatever shape the host chose (`pathForLocale`).
      const path = rt.pathForLocale(url.pathname, locale)
      const story = await storyByPath(bindings.db, path)
      // Not a story: hand it back so the host's own routing wins. An unrouted
      // document can never be reached here anyway — `storyByPath` matches on
      // `path = ?` and one stores NULL — but the check is spelled out because
      // "a preview request for a record is the host's, not Folio's" is a rule
      // (`document-types.md`), not an accident of SQL semantics.
      if (!story || story.path === null) return null

      /**
       * The share gate, and the reason it is *here* rather than beside the actor
       * check: a grant names one story id, and the story is only known once the
       * requested path has been resolved. A cookie for another document is refused
       * the same way everything else in this branch is — by handing the request
       * back, so the visitor sees the host's ordinary published page.
       *
       * One D1 round trip, which also stamps the view (`claimShare`).
       */
      if (shared.length > 0 && !(await claimShare(bindings.db, shared, story.id))) return null

      // `as` previews a singleton in the context of this page (`globals.md`
      // decision 4). Naming anything that is not a configured global is the
      // same refusal shape as a path with no story: null, so the host's own
      // routes win rather than Folio guessing at what was meant.
      const as = url.searchParams.get('as')
      /**
       * **A share grant may not use it.** `?as=` swaps the editable document for a
       * *global's* draft — the site header, site settings — and the grant covers one
       * page, not a singleton every page carries. Refused before the global is even
       * looked up, so the refusal cannot depend on which globals happen to be
       * configured.
       *
       * **Nor may a `draft` request**, for a reason of the same kind: `?as=` names
       * the document being *edited* in the context of this page, and `draft` renders
       * no editing surface at all — no bootstrap for the client to read the name
       * from, no bridge to select in. Accepting it there would leave a parameter
       * that parses, is understood, and changes nothing, which is worse than a
       * refusal. Refused by handing the request back, like every other refusal in
       * this branch.
       */
      if (as !== null && (shared.length > 0 || mode === 'draft')) return null
      if (as !== null) {
        const type = rt.typeOf(as)
        if (type?.kind !== 'singleton' || !rt.globals.includes(as)) return null
        return previewPage(rt, bindings, story, { as, locale, mode })
      }

      return previewPage(rt, bindings, story, { locale, mode })
    }

    return null
  }

  return {
    handle,
    /**
     * The locale does not select a document — there is one per story, holding
     * every language (`localisation.md` checkpoint 3). What it does is refuse a
     * code this site never declared, so `/xx/about` answers the host's own 404
     * rather than serving English under a URL that means nothing. Absent, or the
     * source locale, is the pre-localisation behaviour exactly.
     */
    published: async (env, path, locale) => {
      if (locale !== undefined && !isKnownLocale(rt.locales, locale)) return null
      return publishedDoc(config.bindings(env).db, path)
    },
    status: (env, path) => storyStatus(config.bindings(env).db, path),
    storyAt: async (env, path) => {
      const story = await storyByPath(config.bindings(env).db, path)
      return story && rt.withUrls(story)
    },
    redirect: (env, path) => lookupRedirect(config.bindings(env).db, path),
    draft: (env, id) => rt.draft(config.bindings(env), id),
    /**
     * The in-process write (`content-api.md` decision 6), assembled from bindings
     * alone exactly as `publish` and `migrate` are — so a nightly sync job, a
     * deploy step and the HTTP route all reach the identical code.
     *
     * The row is looked up before the object is touched, deliberately. `commit`
     * refuses a document that has never been opened, and reaching for the draft by
     * id first would *create* a Durable Object for a story D1 no longer has — the
     * resurrection `purge()` exists to prevent.
     */
    write: async (env, id, mutations, opts) => {
      const bindings = config.bindings(env)
      const story = await storyById(bindings.db, id)
      if (!story) throw new FolioError('not_found', 'Unknown document')
      // `commit` refuses an object that holds no document, and its job is not to
      // know what a seed looks like. Creating it here is what makes writing to a
      // story nobody has opened in the editor work.
      await rt.draftFor(bindings, story)
      return commitAll(
        rt.stub(bindings, id),
        mutations,
        { id: opts.actor, name: opts.name ?? opts.actor },
        // A caller-supplied txId is already an identity for this write, which is
        // what `commitAll` derives its per-chunk ids from.
        opts.txId,
      )
    },
    /**
     * `opts` pages this (`collections.md` decision 6). Absent still answers
     * everything: a sitemap of 40 pages should not have to page, and one of 2,000
     * now can. `folio.query(env, …)` is what reports `pages`.
     */
    stories: async (env, opts) => {
      const page = Math.max(Math.trunc(opts?.page ?? 1), 1)
      const perPage =
        opts?.perPage === undefined ? undefined : Math.max(Math.trunc(opts.perPage), 1)
      const window =
        perPage === undefined ? undefined : { limit: perPage, offset: (page - 1) * perPage }
      return (await listStories(config.bindings(env).db, window)).map(rt.withUrls)
    },
    tree: async (env) => rt.decorate(await storyTree(config.bindings(env).db)),
    registry: rt.registry,
    resolve: (env, doc, opts) => rt.resolve(config.bindings(env), doc, opts),
    query: (env, q) => rt.query(config.bindings(env), q),
    /**
     * `alarmHookCtx(env)` for the hook context, here and in `migrate` below.
     * Neither method takes an `ExecutionContext` — a deploy script has none to
     * offer — and that is exactly the case the alarm fallback was built for
     * (`publish-hooks.md` decision 3): the runner cannot tell which kind of
     * `waitUntil` it was handed, and Folio's own internal hooks are awaited
     * either way, so a purge lands before this call returns.
     */
    reindex: (env, opts) =>
      reindex(
        {
          db: config.bindings(env).db,
          schema: rt.schema,
          typeOf: rt.typeOf,
          locales: rt.locales,
          hooks: rt.hookRunner(alarmHookCtx(env)),
        },
        opts,
      ),
    /**
     * The scheduler's sweep (`../../docs/specs/platform/scheduled-publishing.md`).
     *
     * `alarmHookCtx(env)` for the hook context, exactly as `reindex` and `migrate`
     * above: a `scheduled()` handler does have an `ExecutionContext`, but this
     * method's signature deliberately does not take one — a deploy script calling
     * the same sweep has none to offer, and Folio's own internal hooks (the space
     * broadcast, the cache purge) are awaited either way, so a purge lands before
     * this call returns.
     *
     * Assembled from `publishDeps` and nothing else, which is the point of
     * `publish.ts` taking no Request: a scheduled publish reaches the identical
     * workflow an editor's button does, so it retains a version, writes
     * `content_index`, fires `published` and purges the cache without any of that
     * being restated here.
     */
    runSchedules: (env, opts) =>
      runSchedules(rt.publishDeps(config.bindings(env), alarmHookCtx(env)), opts),
    render: (doc, opts) => (
      <FolioDoc doc={doc} registry={rt.registry} mode={opts?.mode} resolution={opts?.resolution} />
    ),
    /**
     * Both are the pure functions from `core/cache-tags.ts`, re-exposed here
     * rather than only from `folio/core`: a host that is already holding a
     * `folio` object to render with should not have to reach for a second
     * import to answer "what should this response say about caching".
     */
    cacheTags,
    cacheHeaders,
    global: async (env, name) => {
      const type = rt.typeOf(name)
      if (type?.kind !== 'singleton') return null
      const id = singletonId(type)
      const docs = await publishedDocsByIds(config.bindings(env).db, [id])
      return docs[id] ?? null
    },
    renderGlobal: (resolution, name, opts) => renderGlobalNode(rt.registry, resolution, name, opts),
    /**
     * Explicit, never automatic (`schema-migrations.md` checkpoint 5). Assembled
     * from bindings alone, exactly as `publishDeps` is, so a deploy script and
     * the `POST {base}/migrate` route reach the identical runner.
     */
    migrate: (env, opts) => {
      const bindings = config.bindings(env)
      return runMigrations(
        {
          db: bindings.db,
          schema: rt.schema,
          migrations: rt.migrations,
          typeOf: rt.typeOf,
          draft: (story) => rt.draftFor(bindings, story),
          stub: (id) => rt.stub(bindings, id),
          hooks: rt.hookRunner(alarmHookCtx(env)),
        },
        opts,
      )
    },
    audit: (env, opts) =>
      audit(config.bindings(env).db, rt.schema, { locales: rt.locales, types: rt.types }, opts),
  }
}
