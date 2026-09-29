import { cacheHeaders, cacheTags, NO_STORE } from '../core/cache-tags'
import { type Blok, childrenOf, type Doc, type Json } from '../core/doc'
import { gateValue, isUngated, type PageAccess, redactDoc } from '../core/gate'
import { mergeLayers } from '../core/layers'
import { dataOf, isKnownLocale, type LocaleContext } from '../core/locales'
import type { Resolution } from '../core/resolve'
import { buildTree, type StoryMeta } from '../core/story'
import {
  chain as chainOf,
  DEFAULT_SITE,
  gate as siteGate,
  layerId,
  type Registry,
  SHARED_SCOPE,
  SINGLE_SITE_CHAIN,
  type SiteRef,
} from '../core/sites'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { createApp } from './app'
import { audit } from './audit'
import { cacheKeyFor, cacheVerdictFor } from './cache-request'
import { deleteStaleChallenges } from './auth/challenges'
import { hasDraftCookie, readGrantCookie, shareCookieTokens } from './auth/cookie'
import { sweepEvents } from './auth/events'
import { readGrant, sweepGrants } from './auth/grants'
import { credentialOf, type PreviewSite, resolveActor } from './auth/resolve'
import { allows, mayPreviewDrafts, READ_DRAFT } from './auth/roles'
import { deleteExpiredSessions } from './auth/session'
import { claimShare, sharedStoriesAt } from './auth/shares'
import { PRIMARY_FIRST, readBookmark, sessionFor } from './db'
import { envelope, FolioError } from './errors'
import type { ResolvedGate } from './gate'
import { runMigrations } from './migrate'
import { previewPage } from './pages'
import { lookupRedirect } from './redirects'
import { reindex } from './reindex'
import { alarmHookCtx, createRuntime, type FolioRuntime, type SiteRender } from './runtime'
import { runSchedules } from './scheduler'
import {
  candidateFor,
  INTERNAL_HEADERS,
  routeRequest,
  SCOPE_HEADER,
  SITE_HEADER,
  type SiteRoute,
  SURFACE_HEADER,
} from './sites'
import {
  listStories,
  pageAt,
  pathMiss,
  pickEditing,
  pickServing,
  publishedDoc,
  publishedDocsByIds,
  storyByPath,
  storyById,
  storyStatus,
  storyTree,
} from './stories'
import { SpaceDO } from './space-do'
import { createStoryDO, StoryDO } from './story-do'
import type {
  Folio,
  FolioConfig,
  FolioGateContext,
  FolioReader,
  GatedReaderFrom,
  PreviewMode,
  ReadBindings,
} from './types'
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
export type { WriteResult } from './write'
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
export { countReferencesTo, referencesTo } from './content-index'
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
/**
 * Trusted identity (`../../docs/specs/foundation/auth-providers.md` decision 4):
 * a host that already authenticates people hands Folio the verified email, and
 * Folio still owns the role, the session and revocation.
 *
 * `cloudflareAccess()` is the one Folio ships, because Access is the case a
 * Cloudflare-native CMS meets first and because doing it correctly means
 * verifying a JWT signature — the step a host writing its own would most likely
 * skip, and the step that is the whole of the security.
 */
export { trusted } from './auth/trusted'
export type { TrustedOptions } from './auth/trusted'
export { cloudflareAccess } from './auth/cloudflare-access'
export type { CloudflareAccessOptions } from './auth/cloudflare-access'
/**
 * Roles from an identity provider's claims
 * (`../../docs/specs/foundation/auth-providers.md` decision 5). `RoleMapper` is
 * a function a host writes; `roleFromClaim` is the one shape common enough to
 * ship — a flat claim of group names, looked up in a table, highest role wins.
 */
export { roleFromClaim } from './auth/roles-from'
export type { RoleFromClaimOptions } from './auth/roles-from'
/**
 * Passkeys (`../../docs/specs/foundation/passkeys.md` decision 1): opt-in per
 * deployment, and listing `passkeys()` in `auth.providers` is the whole of the
 * opt-in. It cannot be the only provider — enrolment needs a session, and the
 * first sign-in is always another door — and `resolveAuth` says so at
 * construction.
 */
export { passkeys } from './auth/passkeys-provider'
export type { PasskeyOptions } from './auth/passkeys-provider'
/**
 * The `sha256-…` of the login page's one inline script
 * (`../../docs/specs/foundation/passkeys.md` decision 4): what a host applying
 * a Content-Security-Policy to `{base}/login` puts in `script-src` to allow it.
 * Computed once in `pages.tsx` from the literal itself, so a one-character edit
 * to the script cannot silently break every such host's CSP.
 */
export { LOGIN_PASSKEY_SCRIPT_HASH } from './pages'
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
  MailProvider,
  PasskeyProvider,
  Provisioning,
  RedirectProvider,
  RedirectState,
  RoleMapper,
  TrustedProvider,
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
export { Shell } from './Document'
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
export type { CacheVerdict } from './cache-request'
/**
 * Visitor access (`../../docs/specs/platform/visitor-access.md`): the two
 * predicates a host declares, what the second is told, and the outcome it reads
 * back off `FolioPage.access`. `PageAccess` also ships from `folio/core`, with
 * the pure half — `redactDoc` and friends — a host never needs to call itself.
 */
export type { FolioGate, FolioGateContext } from './types'
export type { PageAccess } from '../core/gate'
/**
 * The describe seam (`../../docs/specs/content-model/media-library.md`
 * decision 8): the one function a host declares to give its media library
 * machine-written alt text, what it is handed, and what it may answer. Folio
 * holds no API key and makes no model call of its own, so these three types are
 * the entire contract.
 */
export type { DescribeInput, DescribeResult, FolioDescribe } from './types'
/**
 * …and the one adapter over it, so the common case is a line of config rather
 * than a research project. `anthropicDescriber` is the only place in this
 * library that names a vendor, and it is deliberately on this side of the seam:
 * it *returns* a `describe.fn` and holds no privileged access to anything, so
 * deleting it would cost a host twenty lines and no capability.
 */
export type { AnthropicDescriberOptions } from './describe-anthropic'
export {
  anthropicDescriber,
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_DESCRIBE_PROMPT,
} from './describe-anthropic'
export type {
  Folio,
  FolioBindings,
  FolioConfig,
  FolioMiss,
  FolioPage,
  FolioPageOptions,
  FolioReader,
} from './types'

/**
 * What `folio.reader(env)` with no request and no site, and every one-shot read,
 * throws on a deployment with `sites` (`../../docs/specs/foundation/multi-site.md`
 * decision 4). A throw rather than an answer "as no site": a sitemap built that way
 * would be empty, with nothing anywhere to say why.
 */
const NEEDS_SITE =
  'folio: this deployment has `sites`, so a read must say which site it is for — use folio.reader(env, req | { site })'

/**
 * The `~<scope>` segment (decision 11) at the front of a path below `{base}`: a
 * site, group or `shared` id, then the rest of the path.
 */
const SCOPE_SEGMENT = /^\/~([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)(\/.*)?$/

/**
 * `req` with every internal header removed and `set` written — the one way an
 * internal header reaches the app (`sites.ts`'s `INTERNAL_HEADERS`, the
 * `withIdentity` discipline). `new Request(url, req)` keeps the method, the body
 * and the upgrade headers, and answers a request whose headers can be written.
 */
function internalRequest(req: Request, url: string, set: Record<string, string>): Request {
  const next = new Request(url, req)
  for (const name of INTERNAL_HEADERS) next.headers.delete(name)
  for (const [name, value] of Object.entries(set)) next.headers.set(name, value)
  return next
}

/**
 * What `handle()` answers on a site's own host (decision 12). A live host answers
 * an asset's bytes and a form submit and nothing else; a preview origin adds the
 * share link, the grant handoff, draft mode's switch, and the site's own v1 reads.
 * Everything else is the host's to route.
 */
function servesOnSite(
  surface: 'live' | 'preview',
  method: string,
  below: string,
  scope: string | null,
  site: string,
): boolean {
  const reads = method === 'GET' || method === 'HEAD'
  if (scope === null && reads && below.startsWith('/asset/')) return true
  if (scope === null && /^\/f\/[^/]+$/.test(below)) return true
  if (surface !== 'preview') return false
  if (scope === null)
    return ['/share', '/site/enter', '/draft/enter', '/draft/exit'].includes(below)
  return scope === site && reads && below.startsWith('/api/v1/')
}

/**
 * `Content-Security-Policy: frame-ancestors <sites.admin>` on every response Folio
 * answers on a site's preview origin (`multi-site.md` decision 13): the admin is
 * the one page that may frame a draft. Rebuilt rather than mutated, because a
 * redirect's headers are immutable; an upgrade is never answered on a preview
 * origin, and is handed back untouched if it ever were.
 */
function framedBy(res: Response, admin: string): Response {
  if (res.status === 101 || res.webSocket) return res
  // **Never replace a policy a route already set.** `{base}/asset/:key` answers
  // `default-src 'none'; sandbox`, which is the whole reason an uploaded SVG may
  // render inline; overwriting it let such an SVG run script as the preview
  // origin, beside the grant cookie. A sandboxed response is no useful frame.
  if (res.headers.has('content-security-policy')) return res
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', `frame-ancestors ${admin}`)
  return out
}

/**
 * How a draft site's preview origin admitted a request (decision 4): by a grant
 * (`shareOnly` null), or by a share, which limits everything the request may read
 * to the stories in `shareOnly`.
 */
interface Admission {
  shareOnly: ReadonlySet<string> | null
}

/** The gated site a `?_folio=` request arrived for, on its preview origin. */
interface PreviewOn {
  render: SiteRender
  registry: Registry
  /** `sites.admin`, the one origin the preview talks to. */
  admin: string
}

/** A scope's display name, for the "Alpha overrides this page" banner. */
function scopeName(registry: Registry, scope: string): string {
  if (scope === SHARED_SCOPE) return 'Shared content'
  return (
    registry.sites.find((s) => s.id === scope)?.name ??
    registry.groups.find((g) => g.id === scope)?.name ??
    scope
  )
}

/**
 * The settings type's root as a plain value (`Folio.settings`): each field by
 * name, a `max: 1` blocks field as one object (or null), any other blocks field as
 * an array, read in the resolution's locale.
 */
function plainBlok(
  doc: Doc,
  blok: Blok,
  rt: FolioRuntime,
  locale: LocaleContext | undefined,
): Record<string, Json> {
  const fields = rt.schema[blok.type]?.fields
  const data = dataOf(blok, locale)
  if (!fields) return data
  const out: Record<string, Json> = {}
  for (const [name, field] of Object.entries(fields)) {
    if (field.kind === 'blocks') {
      const kids = childrenOf(doc, blok.uid, name).map((kid) => plainBlok(doc, kid, rt, locale))
      out[name] = field.max === 1 ? (kids[0] ?? null) : kids
      continue
    }
    if (name in data) out[name] = data[name] as Json
  }
  return out
}

/**
 * `reader.tree()` on a chain (`multi-site.md` decision 6): the served set built
 * into a tree **by path**, not by `parent_id`.
 *
 * On a chain the two disagree. A shared `info/parking` inherited by a site that
 * forked `info` has the *shared* Info as its parent row, and that row is not in
 * the site's served set; by path, its parent is the site's own Info, which is
 * where a visitor finds it. One row per path — the one `pickServing` serves, or
 * the nearest when nothing there is live — and each row's parent is the row at
 * its parent path.
 */
function treeByPath(chain: readonly string[], rows: readonly StoryMeta[]) {
  const byPath = new Map<string, StoryMeta[]>()
  const unrouted: StoryMeta[] = []
  for (const row of rows) {
    if (row.path === null) unrouted.push(row)
    else byPath.set(row.path, [...(byPath.get(row.path) ?? []), row])
  }
  const one = new Map<string, StoryMeta>()
  for (const [path, here] of byPath) {
    const served = pickServing(chain, here)
    const pick = served?.kind === 'story' ? served.story : pickEditing(chain, here)
    if (pick) one.set(path, pick)
  }
  const parentOf = (path: string) => {
    if (path === '') return null
    const cut = path.lastIndexOf('/')
    return one.get(cut === -1 ? '' : path.slice(0, cut))?.id ?? null
  }
  return buildTree([
    ...[...one.values()].map((row) => ({ ...row, parentId: parentOf(row.path!) })),
    ...unrouted,
  ])
}

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
  // `readerWith` is defined below, after the app that will call it at request time.
  const app = createApp(config, rt, (env, from) => readerWith(env, from))

  /**
   * The site a grant may be read for, on the primary (`PreviewSite`'s own comment
   * says why a grant is the one credential read there).
   */
  const previewSite = (env: Env, on: Pick<PreviewOn, 'render' | 'registry'>): PreviewSite => ({
    id: on.render.site.id,
    registry: on.registry,
    db: config.bindings(env).db.withSession(PRIMARY_FIRST),
  })

  /**
   * The site a grant or share cookie on this request verifies for, when `site` is
   * the request's preview-origin candidate (decision 4): the D1 read the status
   * gate needs to admit a **draft** site's preview origin, made after the
   * synchronous candidate step and never inside a custom resolver.
   *
   * **No read without a cookie**, the discipline `resolveActor` keeps: a stranger
   * on a draft site's preview origin costs the database nothing. Under
   * `auth: 'open'` every preview origin shows drafts without a grant (the spec's
   * edge cases), so the candidate is admitted as it stands.
   */
  const grantFor = async (
    env: Env,
    req: Request,
    registry: Registry,
    site: string,
    below: string | null,
  ): Promise<Admission | null> => {
    if (rt.auth.mode !== 'session') return { shareOnly: null }
    const cookie = req.headers.get('cookie')
    const grant = readGrantCookie(cookie)
    const shared = shareCookieTokens(cookie)
    if (!grant && shared.length === 0) return null
    const raw = config.bindings(env).db
    if (grant && (await readGrant(raw.withSession(PRIMARY_FIRST), grant, { id: site, registry }))) {
      return { shareOnly: null }
    }
    // A share admits a request for **its own story's path** and nothing else
    // (decision 4's "a story this site serves", decision 13's "limits it to its one
    // story"). Only a host path can be one: under `{base}` the pre-grant paths are
    // admitted already and nothing else is a share's.
    if (shared.length > 0 && below === null) {
      const url = new URL(req.url)
      const asked = url.searchParams.get('locale')
      const locale = asked !== null && isKnownLocale(rt.locales, asked) ? asked : undefined
      const db = sessionFor(raw, { bookmark: readBookmark(cookie) })
      const stories = await sharedStoriesAt(
        db,
        shared,
        site,
        rt.pathForLocale(url.pathname, locale),
      )
      if (stories.length > 0) return { shareOnly: new Set(stories) }
    }
    return null
  }

  /**
   * `routeRequest`, and — when the gate refused a request on a site's preview
   * origin — the same request gated again with the grant or share it carries.
   * Only a draft site's preview origin is ever refused there, so only its requests
   * pay for the second look.
   */
  const routeGranted = async (
    sites: NonNullable<FolioRuntime['sites']>,
    registry: Registry,
    req: Request,
    path: string | null,
    env: Env,
  ): Promise<SiteRoute & { shareOnly?: ReadonlySet<string> | null }> => {
    const routed = routeRequest(sites, registry, req, { path, grantFor: null })
    if (routed.kind !== 'none') return routed
    const chosen = candidateFor(sites, registry, req)
    if (!chosen || chosen === 'admin' || chosen.surface !== 'preview') return routed
    const admitted = await grantFor(env, req, registry, chosen.site, path)
    if (!admitted) return routed
    const again = routeRequest(sites, registry, req, { path, grantFor: chosen.site })
    return again.kind === 'site' ? { ...again, shareOnly: admitted.shareOnly } : again
  }

  /**
   * `?_folio=preview|draft` on a host's own URL: Folio's render of the story at
   * that path, or `null` so the host's own routing answers. On a deployment with
   * `sites` it is answered only on a site's preview origin, for the gated site
   * (`on`); with none, `on` is null and this is exactly the single-site branch.
   */
  const previewBranch = async (
    req: Request,
    url: URL,
    env: Env,
    mode: PreviewMode,
    on: PreviewOn | null,
  ): Promise<Response | null> => {
    // On a session, like every other read (`db.ts`). This branch lives outside
    // `basePath` on purpose, so `withBindings` never sees it and it is the one
    // surface that has to open its own — and it is a render, so it makes the
    // same three or four reads a published page does. An editor's bookmark
    // matters here more than anywhere: a preview opened straight after a save
    // is exactly the request that must not land on a replica behind it.
    const bound = config.bindings(env)
    const bindings: ReadBindings = {
      ...bound,
      db: sessionFor(bound.db, { bookmark: readBookmark(req.headers.get('cookie')) }),
    }

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
      // On a site's preview origin the credential is a preview grant (decision 13),
      // read on the primary; the admin's session cookie never reaches this origin.
      const preview = on ? previewSite(env, on) : undefined
      const actor = await resolveActor(() => bindings.db, rt.auth, credentialOf(req), { preview })
      // On a preview origin, decision 13's rule for this site, never `allows()`
      // alone, which ignores the scope.
      const mayDraft = on
        ? mayPreviewDrafts(actor, on.registry, on.render.site.id)
        : allows(actor, READ_DRAFT)
      if (!mayDraft) {
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
    const chain = on ? on.render.chain : SINGLE_SITE_CHAIN
    const nearest = await storyByPath(bindings.db, chain, path)
    /**
     * `_folio_id` names the story the pane is previewing (decision 13, "preview URLs
     * carry the story"), on a deployment with `sites` only. It renders when it is in
     * the site's chain and its path is this one **even where a nearer scope shadows
     * it** — the national team previews the shared page itself on a site that
     * forked it, with a banner saying so. Anything else hands the request back.
     */
    const named = on ? url.searchParams.get('_folio_id') : null
    const story = named !== null ? await storyById(bindings.db, named) : nearest
    if (named !== null && (!story || !chain.includes(story.site ?? DEFAULT_SITE))) return null
    // Not a story: hand it back so the host's own routing wins. An unrouted
    // document can never be reached here anyway — `storyByPath` matches on
    // `path = ?` and one stores NULL — but the check is spelled out because
    // "a preview request for a record is the host's, not Folio's" is a rule
    // (`document-types.md`), not an accident of SQL semantics.
    if (!story || story.path === null || story.path !== path) return null

    /**
     * The share gate, and the reason it is *here* rather than beside the actor
     * check: a grant names one story id, and the story is only known once the
     * requested path has been resolved. A cookie for another document is refused
     * the same way everything else in this branch is — by handing the request
     * back, so the visitor sees the host's ordinary published page.
     *
     * One D1 round trip, which also stamps the view (`claimShare`).
     */
    if (
      shared.length > 0 &&
      !(await claimShare(bindings.db, shared, story.id, undefined, on?.render.site.id))
    ) {
      return null
    }
    const site = on
      ? {
          site: on.render,
          admin: on.admin,
          ...(nearest && nearest.id !== story.id
            ? { overriddenBy: scopeName(on.registry, nearest.site ?? DEFAULT_SITE) }
            : {}),
        }
      : {}

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
      return previewPage(rt, bindings, story, { as, locale, mode, ...site })
    }

    return previewPage(rt, bindings, story, { locale, mode, ...site })
  }

  const handle: Folio<Env>['handle'] = async (inbound, env, ctx) => {
    const url = new URL(inbound.url)
    const underBase = url.pathname === rt.base || url.pathname.startsWith(`${rt.base}/`)
    const below = underBase ? url.pathname.slice(rt.base.length) || '/' : null
    const segment = below === null ? null : SCOPE_SEGMENT.exec(below)
    // The internal headers are deleted from **every** inbound request before
    // anything below sets one (`sites.ts`'s `INTERNAL_HEADERS`). Rebuilt only
    // when one is actually present, so an ordinary request — a socket upgrade
    // included — reaches the app as the object the host handed over.
    const req = INTERNAL_HEADERS.some((name) => inbound.headers.has(name))
      ? internalRequest(inbound, inbound.url, {})
      : inbound

    if (rt.sites) return handleSites(rt.sites, req, url, below, segment, env, ctx)

    if (underBase) {
      // `{base}/~<scope>/…` is a multi-site address, and this deployment has one
      // scope (decision 11): a 404, rather than the shell's wildcard answering
      // it with an admin page for a URL that means nothing here.
      if (below?.startsWith('/~')) {
        return Response.json(envelope(new FolioError('not_found', 'No such route')), {
          status: 404,
        })
      }
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
    if (mode === 'preview' || mode === 'draft') return previewBranch(req, url, env, mode, null)

    return null
  }

  /**
   * `handle()` on a deployment with `sites` (decisions 4, 11 and 12), in the
   * order the spec fixes:
   *
   * 0. **The admin origin first**, before any candidate, so no registry row can
   *    take the admin, sign-in or the registry offline. It answers everything
   *    under `{base}`, with a `~<scope>` segment stripped into the scope header.
   * 1. Otherwise the candidate step, then Folio's status gate — with the grant or
   *    share the request carries, for a draft site's preview origin
   *    (`routeGranted`). No site is `null`: the host's own routing answers, which
   *    is its 404.
   * 2. On a site's host, only what that surface serves (`servesOnSite`), with the
   *    gated site and surface in their headers.
   *
   * **The `?_folio=` branch is answered only on a site's preview origin**
   * (decision 13): drafts on a multi-site deployment are served nowhere else, and
   * there the credential is a preview grant. A live host hands it back.
   *
   * Every response Folio answers on a preview origin carries `frame-ancestors`
   * naming the admin (`framedBy`).
   */
  const handleSites = async (
    sites: NonNullable<FolioRuntime['sites']>,
    req: Request,
    url: URL,
    below: string | null,
    segment: RegExpExecArray | null,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response | null> => {
    if (below === null) {
      const mode = url.searchParams.get('_folio')
      if (mode !== 'preview' && mode !== 'draft') return null
      const registry = await sites.registry(env)
      const routed = await routeGranted(sites, registry, req, null, env)
      if (routed.kind !== 'site' || routed.surface !== 'preview') return null
      const render: SiteRender = {
        site: routed.site,
        surface: routed.surface,
        chain: chainOf(registry, routed.site.id),
      }
      const res = await previewBranch(req, url, env, mode, {
        render,
        registry,
        admin: sites.admin,
      })
      return res && framedBy(res, sites.admin)
    }
    const scope = segment ? segment[1]! : null
    if (below.startsWith('/~') && !segment) return null
    const rest = segment ? segment[2] || '/' : below
    const target = `${url.origin}${rt.base}${rest === '/' && segment ? '' : rest}${url.search}`

    const registry = await sites.registry(env)
    const routed = await routeGranted(sites, registry, req, rest, env)

    if (routed.kind === 'admin') {
      const next = segment ? internalRequest(req, target, { [SCOPE_HEADER]: scope! }) : req
      return app.fetch(next, env as Env & object, ctx)
    }
    if (routed.kind === 'none') return null
    if (!servesOnSite(routed.surface, req.method, rest, scope, routed.site.id)) return null
    const next = internalRequest(req, segment ? target : req.url, {
      ...(scope ? { [SCOPE_HEADER]: scope } : {}),
      [SITE_HEADER]: routed.site.id,
      [SURFACE_HEADER]: routed.surface,
    })
    const res = await app.fetch(next, env as Env & object, ctx)
    return routed.surface === 'preview' ? framedBy(res, sites.admin) : res
  }

  /**
   * One request's worth of reads, on one D1 session (`FolioReader`, `db.ts`).
   *
   * Everything below this line that reads content goes through here, including
   * the top-level `folio.published(env, …)` and friends: those are one-line
   * delegations to a throwaway reader, so there is one implementation of each
   * read and two ways to reach it, not two implementations.
   *
   * The session opens on the nearest instance, or on one at least as new as the
   * bookmark this browser carries if it is an editor who just wrote something.
   * Either way every read in the render agrees with every other, which is what a
   * page needs: a document resolved against references older than itself renders
   * a card that has since been retitled.
   */
  const readerWith = (
    env: Env,
    from?: Request | { site: string } | GatedReaderFrom,
  ): FolioReader => {
    const gatedFrom =
      from !== undefined && !(from instanceof Request) && 'gated' in from ? from : undefined
    const req = from instanceof Request ? from : gatedFrom?.request
    const named =
      from !== undefined && !(from instanceof Request) && 'site' in from ? from.site : undefined
    if (rt.sites && from === undefined) throw new Error(NEEDS_SITE)
    if (!rt.sites && named !== undefined && named !== DEFAULT_SITE) {
      throw new Error(`folio: reader(env, { site: '${named}' }) needs \`sites\` configured`)
    }
    const bound = config.bindings(env)
    const db = sessionFor(bound.db, { bookmark: readBookmark(req?.headers.get('cookie')) })
    const bindings: ReadBindings = { ...bound, db }

    /**
     * The site this reader reads for, and the chain every lookup binds —
     * **once per reader**, like the visitor below, because a render makes several
     * reads that must all agree on which site they are for.
     *
     * With no `sites` it is the single-site chain and no registry is read. With
     * `sites`, the request's host goes through the candidate step and the status
     * gate exactly as `handle()` puts it through them (decision 4); `{ site }` is
     * gated as that site's live surface. No site is an empty chain, and every
     * lookup answers an empty chain with nothing: a reader "as a site with no
     * content".
     */
    type Scoped = {
      render: SiteRender | null
      /**
       * What every lookup binds. **Empty for a request a share admitted to a draft
       * site**, so it reads nothing but its one story: `page()` and `draftAt()` look
       * that story up on the render's own chain and refuse any other id.
       */
      chain: readonly string[]
      registry: Registry | null
      shareOnly: ReadonlySet<string> | null
    }
    let scoped: Promise<Scoped> | null = null
    const scopeOnce = (): Promise<Scoped> => {
      scoped ??= (async (): Promise<Scoped> => {
        const sites = rt.sites
        if (!sites) {
          return { render: null, chain: SINGLE_SITE_CHAIN, registry: null, shareOnly: null }
        }
        const registry = await sites.registry(env)
        let site: SiteRef | null = null
        let surface: 'live' | 'preview' = 'live'
        let shareOnly: ReadonlySet<string> | null = null
        if (gatedFrom) {
          // Gated by the caller (`GatedReaderFrom`), once, in its own route.
          site = gatedFrom.gated
          surface = gatedFrom.surface
        } else if (req) {
          // With the grant or share the request carries, so a host's own route on
          // a draft site's preview origin reads that site for its previewer.
          const routed = await routeGranted(sites, registry, req, null, env)
          if (routed.kind === 'site') {
            site = routed.site
            surface = routed.surface
            shareOnly = routed.shareOnly ?? null
          }
        } else if (named !== undefined) {
          site = siteGate(
            registry,
            { site: named, surface: 'live' },
            { path: null, grantFor: null },
          )
        }
        if (!site) return { render: null, chain: [], registry, shareOnly: null }
        const chain = chainOf(registry, site.id)
        return {
          render: { site, surface, chain },
          chain: shareOnly ? [] : chain,
          registry,
          shareOnly,
        }
      })()
      return scoped
    }
    /** The single-site `resolve` option, or this reader's site — or, with `sites`
     * and no site, `null`, which `resolve` reads as an empty chain. */
    const siteOption = (s: Scoped) => (rt.sites ? { site: s.render } : {})

    /**
     * Is this request *asking* for a draft — the presence of a credential, not a
     * grant.
     *
     * **Reads no binding**, which is the whole of `draft-mode.md` decision 2: a
     * visitor with no cookie must cost nothing, and the cheapest way to be sure
     * is to answer before anything is parsed. A reader built without a `Request`
     * has nothing to ask and answers false, which is what keeps a sitemap build
     * or a warm-up from pulling a draft into something cacheable.
     */
    const wantsDraft = (): boolean =>
      gatedFrom !== undefined
        ? gatedFrom.draft
        : req !== undefined &&
          (hasDraftCookie(req.headers.get('cookie')) ||
            shareCookieTokens(req.headers.get('cookie')).length > 0 ||
            asksByCredential())

    /**
     * On a multi-site deployment **a credential is itself the ask** (decision 13,
     * step 4): a preview origin exists only to show drafts, so a host route there
     * calling `reader.page()` gets the chain's drafts for a grant — or a session or
     * token — that `mayPreviewDrafts` admits, with no draft cookie. Still a
     * presence test and still no binding read; `draftFor` refuses it off the
     * preview surface. Single-site keeps the flag and the authority separate,
     * because there an editor is signed in all day on the one origin.
     */
    const asksByCredential = (): boolean => {
      if (!rt.sites || !req || rt.auth.mode !== 'session') return false
      const presented = credentialOf(req)
      return presented.grant !== null || presented.cookie !== null || presented.bearer !== null
    }

    /**
     * May this request see `story`'s draft, and if so, what is it.
     *
     * The authority half of draft mode, split from the lookup so `draftAt` and
     * `page` share one implementation of the rule rather than two that agree
     * today. Callers have already established that the request wants a draft.
     *
     * An editor is checked first because it is the cheaper question:
     * `resolveActor` is one indexed read and `claimShare` is a read plus a write
     * that stamps a view. A browser holding both cookies is an editor who was
     * also sent a link, and charging them a share view for reading their own
     * site would make the share's view count a lie.
     */
    const draftFor = async (story: StoryMeta): Promise<Doc | null> => {
      // The caller that gated the site also decided whether it may read drafts, with
      // `mayPreviewDrafts`; there is no cookie to ask about (`GatedReaderFrom`).
      if (gatedFrom)
        return gatedFrom.draft && story.path !== null ? rt.draftFor(bindings, story) : null
      if (!req || story.path === null) return null
      // On a multi-site deployment drafts are served only on a site's preview
      // origin (decision 13), so a live host never reads one whatever the cookie
      // says.
      const within = await scopeOnce()
      if (rt.sites && within.render?.surface !== 'preview') return null
      const header = req.headers.get('cookie')
      const wants = hasDraftCookie(header)

      if ((wants || asksByCredential()) && rt.auth.mode === 'session') {
        // There, the credential is a preview grant (decision 13, step 4): a host's
        // route calling `reader.page()` gets the chain's drafts by `pickEditing`.
        const preview =
          within.render && within.registry
            ? previewSite(env, { render: within.render, registry: within.registry })
            : undefined
        const actor = await resolveActor(() => db, rt.auth, credentialOf(req), { preview })
        const mayDraft =
          within.render && within.registry
            ? mayPreviewDrafts(actor, within.registry, within.render.site.id)
            : allows(actor, READ_DRAFT)
        if (mayDraft) return rt.draftFor(bindings, story)
      }
      // `auth: 'open'` has no actor to resolve and no role to check, so the
      // draft cookie alone is the authority — the same authority `handle()`'s
      // preview branch grants there, on a site that has declared it has no
      // editors to distinguish.
      if (wants && rt.auth.mode !== 'session') return rt.draftFor(bindings, story)

      const shared = shareCookieTokens(header)
      if (
        shared.length > 0 &&
        (await claimShare(db, shared, story.id, undefined, within.render?.site.id))
      ) {
        return rt.draftFor(bindings, story)
      }
      return null
    }

    /**
     * Who is asking, as the host's `gate.visitor` answers it — **once per
     * reader**, not once per call (`visitor-access.md` decision 1).
     *
     * A reader is one request's worth of reads, and `visitor` may verify a JWT
     * or call a membership API; a page that resolves a `collection` of gated
     * cards, or a host that renders two documents off one reader, must not pay
     * for that twice. The **promise** is memoised rather than its value, because
     * two `page()` calls started together would otherwise both find the slot
     * empty and both call the host.
     *
     * The body is `async`, so a `visitor` that throws synchronously rejects this
     * promise instead of escaping `page()` — decision 7 is that a gate which
     * cannot decide denies, and `page()` never rejects. A rejection is memoised
     * like any other answer: the host is asked once, whatever it does.
     *
     * **A reader built without a `Request` never calls it at all** — a sitemap
     * build or a warm-up has nobody to be — and `allows` is handed `null`,
     * because "no request" is "nobody".
     */
    let asked: Promise<unknown> | null = null
    const visitorOnce = (gate: ResolvedGate): Promise<unknown> => {
      asked ??= (async () => (req ? await gate.config.visitor(req, env) : null))()
      return asked
    }

    /**
     * What this visitor may see of `doc` (`visitor-access.md` decisions 1, 6, 7).
     *
     * The order of the three questions is the design, and each answer is cheaper
     * than the one below it:
     *
     * 1. **Is this document gated at all** — one `Set` lookup and one strict
     *    comparison, on values Folio already holds. A page whose root does not
     *    declare the field is public (checkpoint 3), and so is one whose value is
     *    `gate.public`. Neither costs a host call, which is the property that
     *    lets a mostly-public site keep its edge cache.
     * 2. **Is this a Folio credential** — an editor in draft mode, or a reviewer
     *    holding this story's share grant (decision 6). They are not members of
     *    the host's site and have no host credential; gating them would make the
     *    draft unreadable to the person about to publish it.
     * 3. **Ask the host.** Only now, and only ever once per reader.
     */
    const accessFor = async (
      story: StoryMeta,
      doc: Doc,
      drafted: boolean,
      locale: string | undefined,
    ): Promise<PageAccess> => {
      const gate = rt.gate
      if (!gate) return 'public'

      const root = doc.bloks[doc.root]
      // Read from `data`, never `fieldValue` — `gateValue`'s header argues why,
      // and it is the one deliberate exception to this repo's rule.
      const value = gateValue(doc, gate.config.field)
      if (!root || !gate.roots.has(root.type) || isUngated(value, gate.config.public)) {
        return 'public'
      }
      if (drafted) return 'granted'

      const ctx: FolioGateContext = {
        story,
        doc,
        ...(locale !== undefined ? { locale } : {}),
        site: (await scopeOnce()).render?.site ?? null,
      }
      let who: unknown
      try {
        who = await visitorOnce(gate)
      } catch (err) {
        // The IdP is down, or a token is malformed. The host's route answers a
        // paywall rather than a 500, and this line is where the outage shows.
        rt.logger.error('folio: gate.visitor threw; denying', err)
        return 'denied'
      }
      try {
        return (await gate.config.allows(who, value, ctx)) ? 'granted' : 'denied'
      } catch (err) {
        rt.logger.error('folio: gate.allows threw; denying', err)
        return 'denied'
      }
    }

    return {
      published: async (path, locale) => {
        if (locale !== undefined && !isKnownLocale(rt.locales, locale)) return null
        return publishedDoc(db, (await scopeOnce()).chain, path)
      },
      /**
       * Draft mode's whole contract (`../../docs/specs/platform/draft-mode.md`).
       *
       * The order of the checks is the design. **The cookie presence test comes
       * first and reads no binding**, so a visitor with no credential costs
       * nothing — the discipline spec 21 established for shares and the reason
       * draft mode can be a call on every page render rather than a route
       * somebody opts into. A reader built without a `Request` has no cookie to
       * test and answers null before anything else, which is what keeps a
       * sitemap or a warm-up from pulling a draft into something cacheable.
       *
       * After that it mirrors `handle()`'s preview branch, and deliberately does
       * not share code with it: that branch answers "may I serve Folio's own
       * preview of this URL" and this answers "may the host serve its page from
       * the draft". They agree today on who may see a draft and differ on
       * everything else — the render, the response, the refusal shape — and
       * folding them together would mean one function with a mode flag deciding
       * four unrelated things.
       */
      draftAt: async (path, locale) => {
        if (!wantsDraft()) return null
        if (locale !== undefined && !isKnownLocale(rt.locales, locale)) return null
        // Unrouted documents are unreachable here by construction (`storyByPath`
        // matches `path = ?` and one stores NULL), but a record's draft not
        // being the host's to render at a URL is a rule, not an accident of SQL.
        const within = await scopeOnce()
        const story = await storyByPath(db, within.render?.chain ?? within.chain, path)
        if (within.shareOnly && !(story && within.shareOnly.has(story.id))) return null
        return story ? draftFor(story) : null
      },
      page: async (path, opts) => {
        const locale = opts?.locale
        if (locale !== undefined && !isKnownLocale(rt.locales, locale)) return null

        // One read for the row and its published document. `storyAt` and
        // `published` select the same row by the same indexed column, and a host
        // that sets cache tags needs both — a page never appears in its own
        // resolution, so `story:<id>` is the one tag it cannot derive.
        const within = await scopeOnce()
        const found = await pageAt(
          db,
          within.shareOnly ? (within.render?.chain ?? []) : within.chain,
          path,
        )
        if (!found) return null
        // A request a share admitted to a draft site reads its one story, as its
        // draft, and nothing else — not even what is published at the same path.
        if (within.shareOnly && !within.shareOnly.has(found.editing.id)) return null

        // Asked before the published document is used, not after: an editor in
        // draft mode is reading this page *instead of* what is live, and a story
        // with nothing published still has a draft to show them. The draft is
        // `editing`'s — on a chain, the nearest row whatever its state, which is
        // a fork its editor is preparing while visitors still get the page it
        // will shadow (decision 5).
        const drafted = wantsDraft() ? await draftFor(found.editing) : null
        if (within.shareOnly && !drafted) return null
        const doc = drafted ?? found.doc
        if (!doc) return null
        const story = drafted ? found.editing : found.story

        // Decided here, before the resolve, because a denied visitor's
        // resolution must be built from the *redacted* document: resolving the
        // full one and swapping the doc afterwards would hand back the titles
        // and URLs of everything the withheld body points at.
        const access = await accessFor(story, doc, drafted !== null, locale)
        const shown = access === 'denied' ? redactDoc(doc, rt.schema) : doc

        const resolution = await rt.resolve(bindings, shown, {
          ...(locale !== undefined ? { locale } : {}),
          ...(opts?.page !== undefined ? { page: opts.page } : {}),
          story,
          // A drafted page resolves its targets from their drafts too, or it
          // links to and pulls in published copies of everything else and is
          // internally inconsistent.
          ...(drafted ? { draft: true } : {}),
          ...siteOption(within),
        })

        return {
          doc: shown,
          story,
          resolution,
          draft: drafted !== null,
          access,
          /**
           * **The reason this method returns headers at all.** `cacheHeaders`
           * and `noStore` look interchangeable and only one of them keeps
           * unpublished content off the edge, and `Cache-Control` without
           * `Cache-Tag` is a page cached for a week with no purge path — the
           * half-configured state `caching.md` decision 2 calls worse than no
           * caching. Both are now impossible to get wrong from here.
           *
           * **`access !== 'public'` is the whole of visitor access's security
           * property** (`visitor-access.md` decision 5). `cacheVerdictFor`
           * answers `null` for a host's own path — Folio has no opinion there —
           * so this value is the only thing keeping a members-only page out of a
           * shared cache under its real URL. `'denied'` is `no-store` too, and
           * that is the half that looks wrong: a teaser is visitor-independent
           * and therefore *looks* cacheable, but Workers Caching has no way to
           * answer it to a stranger and not to the member who signed in a second
           * later. The cost is stated in the spec: a gated page is uncacheable
           * at the edge, for everyone, forever.
           */
          headers: {
            ...(drafted || access !== 'public'
              ? { 'cache-control': NO_STORE }
              : cacheHeaders(resolution, { story: story.id })),
            // On a site's preview origin the admin is the one page that may frame
            // this, exactly as `framedBy` says of Folio's own responses (decision
            // 13). Here because a host's page never passes through `framedBy`,
            // and never on the live surface, where it would break every embed.
            // `cacheHeaders` and `NO_STORE` set no policy, so nothing is replaced.
            ...(rt.sites && within.render?.surface === 'preview'
              ? { 'content-security-policy': `frame-ancestors ${rt.sites.admin}` }
              : {}),
          },
        }
      },
      resolve: async (doc, opts) =>
        rt.resolve(bindings, doc, { ...opts, ...siteOption(await scopeOnce()) }),
      status: async (path) => storyStatus(db, (await scopeOnce()).chain, path),
      storyAt: async (path) => {
        const within = await scopeOnce()
        const story = await storyByPath(db, within.chain, path)
        return story && rt.urlsFor(within.render?.site)(story)
      },
      redirect: async (path) => {
        const within = await scopeOnce()
        if (!rt.sites) return lookupRedirect(db, within.chain, path, rt.logger)
        // On a chain the redirect that applies is decision 5's walk — a nearer
        // scope that took the page down answers `gone`, not a farther redirect —
        // so it is `miss`'s answer, rather than the nearest row on its own.
        const miss = await pathMiss(db, within.chain, path)
        return miss.kind === 'redirect' ? { to: miss.to, status: miss.status } : null
      },
      miss: async (path) => pathMiss(db, (await scopeOnce()).chain, path),
      stories: async (opts) => {
        const within = await scopeOnce()
        const page = Math.max(Math.trunc(opts?.page ?? 1), 1)
        const perPage =
          opts?.perPage === undefined ? undefined : Math.max(Math.trunc(opts.perPage), 1)
        const window =
          perPage === undefined ? undefined : { limit: perPage, offset: (page - 1) * perPage }
        return (await listStories(db, window, within.chain)).map(rt.urlsFor(within.render?.site))
      },
      tree: async () => {
        const within = await scopeOnce()
        if (!rt.sites) return rt.decorate(await storyTree(db))
        return rt.decorate(
          treeByPath(within.chain, await listStories(db, undefined, within.chain)),
          within.render?.site,
        )
      },
      query: async (q) => {
        const within = await scopeOnce()
        return rt.query(bindings, q, within.chain, within.render?.site)
      },
      global: async (name) => {
        const type = rt.typeOf(name)
        if (type?.kind !== 'singleton') return null
        // The chain's layers, merged (`multi-site.md` decision 8). With no `sites`
        // the chain is `['default']` and this is the one `sng_<type>` read it was.
        // A request a share admitted to a draft site reads the gated site's whole
        // chain here — the same chain `page()` resolves with, so its one story has
        // its header and navigation — and, like every read, **published layers
        // only**: the share drafts its one story and nothing else.
        const within = await scopeOnce()
        const chain = within.shareOnly ? (within.render?.chain ?? []) : within.chain
        const ids = [...chain].reverse().map((scope) => layerId(name, scope))
        const docs = await publishedDocsByIds(db, ids, chain)
        return (
          mergeLayers(
            ids.map((id) => docs[id]),
            rt.schema,
          ) ?? null
        )
      },
      site: async () => (await scopeOnce()).render?.site ?? null,
      bookmark: () => db.getBookmark(),
    }
  }

  /** The public `folio.reader`: a request or a bare site, never a caller-gated site. */
  const reader: Folio<Env>['reader'] = (env, from) => readerWith(env, from)

  /**
   * `folio.cacheProps` (decision 15): the gated site and its surface, or `{}`. A
   * deployment with no `sites` answers `{}` without reading anything.
   */
  const cacheProps: Folio<Env>['cacheProps'] = async (req, env) => {
    const sites = rt.sites
    if (!sites) return {}
    const url = new URL(req.url)
    const underBase = url.pathname === rt.base || url.pathname.startsWith(`${rt.base}/`)
    const routed = routeRequest(sites, await sites.registry(env), req, {
      path: underBase ? url.pathname.slice(rt.base.length) || '/' : null,
      grantFor: null,
    })
    return routed.kind === 'site' ? { site: routed.site.id, surface: routed.surface } : {}
  }

  /** `folio.settings` (decision 2): the settings type's merged root, as a plain value. */
  const settings: Folio<Env>['settings'] = (resolution: Resolution) => {
    const name = rt.sites?.settings
    const doc = name ? resolution.globals?.[name] : undefined
    const root = doc?.bloks[doc.root]
    return doc && root ? plainBlok(doc, root, rt, resolution.locale) : null
  }

  return {
    handle,
    reader,
    cacheProps,
    settings,
    /**
     * The locale does not select a document — there is one per story, holding
     * every language (`localisation.md` checkpoint 3). What it does is refuse a
     * code this site never declared, so `/xx/about` answers the host's own 404
     * rather than serving English under a URL that means nothing. Absent, or the
     * source locale, is the pre-localisation behaviour exactly.
     */
    published: (env, path, locale) => reader(env).published(path, locale),
    status: (env, path) => reader(env).status(path),
    storyAt: (env, path) => reader(env).storyAt(path),
    redirect: (env, path) => reader(env).redirect(path),
    miss: (env, path) => reader(env).miss(path),
    draft: (env, id) => rt.draft(config.bindings(env), id),
    inDraftMode: (req) => hasDraftCookie(req.headers.get('cookie')),
    noStore: () => ({ 'cache-control': NO_STORE }),
    /** Draft mode's whole contract, implemented on `reader` — see `FolioReader.draftAt`. */
    draftAt: (env, req, path, locale) => reader(env, req).draftAt(path, locale),
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
    stories: (env, opts) => reader(env).stories(opts),
    tree: (env) => reader(env).tree(),
    registry: rt.registry,
    resolve: (env, doc, opts) => reader(env).resolve(doc, opts),
    query: (env, q) => reader(env).query(q),
    /**
     * `alarmHookCtx(env, rt.logger)` for the hook context, here and in `migrate` below.
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
          hooks: rt.hookRunner(alarmHookCtx(env, rt.logger)),
        },
        opts,
      ),
    /**
     * The scheduler's sweep (`../../docs/specs/platform/scheduled-publishing.md`).
     *
     * `alarmHookCtx(env, rt.logger)` for the hook context, exactly as `reindex` and `migrate`
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
      runSchedules(rt.publishDeps(config.bindings(env), alarmHookCtx(env, rt.logger)), opts),
    /**
     * The auth housekeeping sweep (`../../docs/specs/foundation/
     * auth-providers.md` decision 8). Assembled from bindings alone, exactly as
     * `reindex` and `migrate` above, so a cron tick and a deploy script reach the
     * identical sweep — and, like both of those, on the primary rather than a
     * read session: this is a background delete, never a request's own read.
     */
    sweepAuth: async (env, opts) => {
      const db = config.bindings(env).db
      const now = opts?.now ?? Date.now()
      // Preview grants first: their sweep drops the grants of sessions already
      // gone, and `deleteExpiredSessions` takes the expired sessions' own grants
      // in its batch. Not counted in the report, whose shape is the public type's.
      await sweepGrants(db, now)
      const [sessions, challenges, events] = await Promise.all([
        deleteExpiredSessions(db, now),
        deleteStaleChallenges(db, now),
        sweepEvents(db, now),
      ])
      return { sessions, challenges, events }
    },
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
    cacheVerdict: (req) => cacheVerdictFor(req, rt.base),
    cacheKey: (url) => cacheKeyFor(url),
    global: (env, name) => reader(env).global(name),
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
          // Without this a migration that rewrites an indexed value or any prose
          // leaves content_index and content_text describing the old document.
          projection: rt.projection,
          hooks: rt.hookRunner(alarmHookCtx(env, rt.logger)),
        },
        opts,
      )
    },
    audit: async (env, opts) =>
      audit(config.bindings(env).db, rt.schema, await rt.auditContext(env), opts),
  }
}
