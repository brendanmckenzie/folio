import { isKnownLocale } from '../core/locales'
import { singletonId } from '../core/schema'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { createApp } from './app'
import { audit } from './audit'
import { credentialOf, resolveActor } from './auth/resolve'
import { allows, READ_DRAFT } from './auth/roles'
import { FolioError } from './errors'
import { runMigrations } from './migrate'
import { previewPage } from './pages'
import { lookupRedirect } from './redirects'
import { reindex } from './reindex'
import { alarmHookCtx, createRuntime } from './runtime'
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
import { StoryDO } from './story-do'
import type { Folio, FolioConfig } from './types'
import { commitAll } from './write'

export { StoryDO }
/**
 * The space channel's Durable Object
 * (`../../../docs/specs/editing/live-collaboration.md`). A host exports this and
 * binds it as `SPACE` to get cross-story presence and structural events; without
 * it everything that channel carries is simply absent.
 *
 * **Declared with `new_classes`, not `new_sqlite_classes`** — it holds no storage
 * at all. See README.
 */
export { SpaceDO }
export type { SpaceEvent, SpacePresence } from '../core/protocol'
/**
 * The Content API (`../../../docs/specs/platform/content-api.md`): what one write
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
  AuditReport,
  ContentFinding,
  DocumentSizeFinding,
  SchemaFinding,
  StoryFinding,
} from './audit'
/**
 * Collections (`../../../docs/specs/content-model/collections.md`): the query
 * shapes a host writes and reads. `collection()` itself, and the resolved value a
 * block renders, ship from `folio/core` with the rest of the field builders.
 */
export type { ReindexOptions, ReindexReport } from './reindex'
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
 * Data documents (`../../../docs/specs/content-model/data-documents.md`): what
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
export { FolioDoc } from '../preview/Render'
export { Shell, serializeJson } from './Document'
export type { StoryMeta, StoryNode } from '../core/story'
export type { Resolution } from '../core/resolve'
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

    if (url.searchParams.get('_folio') === 'preview') {
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
      if (rt.auth.mode === 'session') {
        const actor = await resolveActor(() => bindings.db, rt.auth, credentialOf(req))
        if (!allows(actor, READ_DRAFT)) return null
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

      // `as` previews a singleton in the context of this page (`globals.md`
      // decision 4). Naming anything that is not a configured global is the
      // same refusal shape as a path with no story: null, so the host's own
      // routes win rather than Folio guessing at what was meant.
      const as = url.searchParams.get('as')
      if (as !== null) {
        const type = rt.typeOf(as)
        if (type?.kind !== 'singleton' || !rt.globals.includes(as)) return null
        return previewPage(rt, bindings, story, { as, locale })
      }

      return previewPage(rt, bindings, story, { locale })
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
    render: (doc, opts) => (
      <FolioDoc doc={doc} registry={rt.registry} edit={opts?.edit} resolution={opts?.resolution} />
    ),
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
    audit: (env) =>
      audit(config.bindings(env).db, rt.schema, { locales: rt.locales, types: rt.types }),
  }
}
