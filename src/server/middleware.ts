import type { Context, MiddlewareHandler } from 'hono'
import {
  ALL_SCOPES,
  chain,
  DEFAULT_SITE,
  SHARED_SCOPE,
  SINGLE_SITE_CHAIN,
  type SiteRef,
} from '../core/sites'
import type { StoryMeta } from '../core/story'
import { readSessionCookie } from './auth/cookie'
import { credentialOf, originAllowed, type PreviewSite, resolveActor } from './auth/resolve'
import {
  type Access,
  type Actor,
  allows,
  effectiveRole,
  refusalOf,
  type Role,
  tokenScopesOn,
} from './auth/roles'
import {
  bookmarkCookie,
  type DbSession,
  type FolioDb,
  PRIMARY_FIRST,
  readBookmark,
  sessionFor,
} from './db'
import { FolioError } from './errors'
import type { HookRunnerCtx } from './hooks'
import type { FolioRuntime } from './runtime'
import { SCOPE_HEADER, SITE_HEADER, SURFACE_HEADER } from './sites'
import { storyById } from './stories'
import type { ReadBindings, FolioConfig, FolioEnv } from './types'
import { idParam, safeNext } from './validate'

/**
 * The one place the host's `Env` becomes Folio's bindings, and the one place a
 * request gets the D1 session its queries run on.
 *
 * What is stored is a memoised thunk, not the bindings: this middleware runs
 * ahead of every route, and the ones that answer from the config alone — the
 * `/schema` manifest, a 404, a refused socket upgrade — answered without the
 * host's accessor before it existed and must keep doing so. See `FolioVars` in
 * types.ts. Memoising means the routes that do need it (and their own
 * middleware, which asks first) still call it exactly once per request, and that
 * one session covers every query the request makes.
 *
 * **The constraint is chosen by method, not by route.** A GET opens on whatever
 * instance is nearest, which is the whole point of `db.ts` and is what makes
 * `{base}/asset/:key` — public, high volume, one indexed read — cost a local
 * round trip instead of a transcontinental one. Anything else is about to write,
 * and a request that writes and then reads its own row back must not have opened
 * on a replica that is behind it.
 *
 * **The bookmark cookie closes the gap between two requests**, and is written
 * for exactly one population: a signed-in editor who just wrote something. Their
 * next read then starts from a database version at least as new as their own
 * write, so the tree cannot show a story they just published as still a draft.
 * Deliberately not written for a GET, and not for an anonymous request: a
 * `Set-Cookie` on `{base}/asset/:key` would make every media response
 * uncacheable to buy nothing at all.
 */
export function withBindings<Env>(config: FolioConfig<Env>): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    const cookie = c.req.raw.headers.get('cookie')
    const writes = c.req.method !== 'GET' && c.req.method !== 'HEAD'

    let resolved: ReadBindings | undefined
    let session: DbSession | undefined
    c.set('bindings', () => {
      if (!resolved) {
        const bound = config.bindings(c.env)
        session = sessionFor(bound.db, { bookmark: readBookmark(cookie), write: writes })
        resolved = { ...bound, db: session }
      }
      return resolved
    })

    await next()

    if (!writes || !session) return
    if (readSessionCookie(cookie) === null) return
    const bookmark = session.getBookmark()
    if (bookmark) c.res.headers.append('set-cookie', bookmarkCookie(c.req.url, bookmark))
  }
}

/**
 * Reads the request's scope and gated site into `c.var.scope` and `c.var.site`
 * (`../../docs/specs/foundation/multi-site.md` decision 11).
 *
 * **Both come only from headers `handle()` wrote.** `handle()` deletes every
 * internal header from every inbound request before setting any (`INTERNAL_HEADERS`,
 * `sites.ts`), so a value here is one Folio put there: the `~<scope>` segment it
 * stripped from the path, and the site and surface its status gate admitted.
 *
 * A scope nobody registered is a 404 — a route below never sees a scope it cannot
 * resolve a chain for — and costs a registry read from this isolate's snapshot,
 * only for a request that named one. On a deployment with no `sites` there is no
 * scope and no site, and nothing is read: `handle()` answers a `~` segment there
 * with a 404 before the app is reached.
 *
 * It also sets `c.var.brand` (`multi-brand.md` decision 6), the registry every route
 * below reads. On a deployment with `brands`, `~shared` and a row of no configured
 * brand have empty chains, so they are this same 404.
 */
export function withScope<Env>(rt: FolioRuntime): MiddlewareHandler<FolioEnv<Env>> {
  // The one brand of a deployment with no `brands`: every request's, with no read.
  const only = rt.brands.get(null) ?? null
  return async (c, next) => {
    if (!rt.sites) {
      c.set('scope', null)
      c.set('site', null)
      c.set('brand', only)
      await next()
      return
    }
    const scope = c.req.raw.headers.get(SCOPE_HEADER)
    // Read only for a request that named a scope, or (with `brands`) one that
    // arrived on a site's host: a bare admin request costs nothing, as it did.
    const site = c.req.raw.headers.get(SITE_HEADER)
    const registry =
      scope !== null || (!only && site !== null) ? await rt.sites.registry(c.env) : null
    if (scope !== null && chain(registry!, scope).length === 0) {
      throw new FolioError('not_found', `No site or group '${scope}'`)
    }
    const surface = c.req.raw.headers.get(SURFACE_HEADER)
    c.set('scope', scope)
    c.set(
      'site',
      site !== null && (surface === 'live' || surface === 'preview') ? { id: site, surface } : null,
    )
    // The request's brand (`multi-brand.md` decision 6), looked up once: the scope's,
    // else the gated site's. With `brands` a scope or site the snapshot holds always
    // has one (a row of no configured brand is not in it, so it 404'd above), and no
    // scope and no site is null — never the first brand.
    const at = scope ?? c.var.site?.id ?? null
    c.set('brand', only ?? (registry && at !== null ? rt.forScope(registry, at) : null))
    await next()
  }
}

/**
 * Refuses a scoped route that named no scope, on a deployment with `sites`:
 * `400 site_required` (decision 11). A deployment with no `sites` has one scope,
 * so there is nothing to require.
 *
 * Answered here rather than thrown as a `FolioError`, because `site_required` is
 * its own code in the error envelope and not one of `errors.ts`'s general ones: a
 * script that forgot its `~<site>` segment should be able to tell that apart from
 * every other 400 without parsing a message.
 */
export function requireScope<Env>(rt: FolioRuntime): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    if (rt.sites && c.var.scope === null) return siteRequired(c, rt)
    await next()
  }
}

function siteRequired<Env>(c: Context<FolioEnv<Env>>, rt: FolioRuntime): Response {
  return c.json(
    {
      error: {
        code: 'site_required',
        message: `Name the site: ${rt.base}/~<site>/… (this deployment has many)`,
      },
    },
    400,
  )
}

/* ------------------------------------------------------ which routes scope --- */

/**
 * The paths below `{base}/api` that name no scope (`multi-site.md` decision 11):
 * sign-in and the caller's own account, the platform tier (users, tokens, auth
 * events, the registry, reindex, migrate, audit, bulk describe), and the two
 * config-only reads. **Every other `{base}/api` route is scoped**: on a deployment
 * with `sites` it is `400 site_required` without a `~<scope>` segment or a bound
 * token to supply one, and a caller whose grants do not reach the scope is a 403
 * naming it. A scope on one of these is ignored — it is not refused, and it does
 * not change the role the route sees.
 *
 * A list rather than a flag at each mount, so `scope-partition.test.ts` can walk
 * every mounted route against it: a new route is scoped unless somebody adds it
 * here, which is the direction that fails closed.
 */
export const UNSCOPED_API: readonly RegExp[] = [
  /^\/schema$/,
  /^\/v1\/schema$/,
  /^\/v1\/sites(\/|$)/,
  /^\/me(\/|$)/,
  /^\/logout$/,
  /^\/users(\/|$)/,
  /^\/tokens(\/|$)/,
  /^\/auth-events$/,
  /^\/sites(\/|$)/,
  /^\/reindex$/,
  /^\/migrate$/,
  /^\/audit$/,
  /^\/migrations$/,
  /^\/assets\/describe$/,
]

/**
 * The pages below `{base}` that name no scope: sign-in, the public bytes and form
 * submit a site's hosts answer, the share link, the preview handoff's second hop,
 * draft mode's switch, and the two admin screens that are about every site (the
 * shell's landing and the Sites screen). Every other page — the shell below a
 * `~<scope>`, the editor — sees the 403 for a scope its caller cannot reach.
 */
export const UNSCOPED_PAGES: readonly RegExp[] = [
  /^\/?$/,
  /^\/sites$/,
  /^\/login(\/|$)/,
  /^\/asset\//,
  /^\/f\/[^/]+$/,
  /^\/share$/,
  /^\/draft\/(enter|exit)$/,
  /^\/site\/enter$/,
]

/**
 * **The routes marked `reach: 'preview'`, which is `site/start` and nothing else**
 * (`multi-site.md` decisions 10 and 13). There `withActor` does not refuse a caller
 * whose grants give no role on the site, because previewing is the one read that
 * flows *down*: `READ_DRAFT` on any scope in the site's chain — the group, `shared`
 * — lets a person preview it, and the route checks that itself (`previewEligible`).
 * Without the exemption a shared-only or group-only editor would be refused at the
 * first hop of every preview. `scope-partition.test.ts` asserts this list exactly.
 */
export const PREVIEW_REACH: readonly string[] = ['/site/start']

/** How a path below `{base}` is scoped, by the three lists above. */
export function routeScope(below: string): 'unscoped' | 'scoped' | 'preview' {
  if (PREVIEW_REACH.includes(below)) return 'preview'
  if (below.startsWith('/api/')) {
    const rest = below.slice('/api'.length)
    return UNSCOPED_API.some((r) => r.test(rest)) ? 'unscoped' : 'scoped'
  }
  return UNSCOPED_PAGES.some((r) => r.test(below)) ? 'unscoped' : 'scoped'
}

/**
 * The actor as it stands on this request's scope, on a deployment with `sites`
 * (decisions 10, 11 and 14), or a refusal.
 *
 * - **A bound token supplies the scope** when the URL named none, into
 *   `c.var.scope`, so every route below reads one value however it arrived.
 * - **A scoped `{base}/api` route, or `{base}/mcp`, with no scope is
 *   `400 site_required`.**
 * - **On a scoped route, the effective role** replaces `role` (and a token's scopes
 *   become what they are worth there), so `allows()` and every mount keep their
 *   shape. Grants that do not reach the scope are a 403 naming it — except on
 *   `PREVIEW_REACH`, whose route decides for itself.
 * - **An unscoped route ignores the scope**: a person keeps their `*` role, a token
 *   its scopes. The platform tier then reads the `*` grant and the token's binding
 *   itself, in `allows()`, whatever this left in `role`.
 */
async function scopedActor<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  sites: NonNullable<FolioRuntime['sites']>,
  actor: Actor | null,
): Promise<Actor | Response | null> {
  const below = c.req.path.slice(rt.base.length) || '/'
  const kind = routeScope(below)
  let scope = c.var.scope
  const bound = actor?.kind === 'token' ? (actor.site ?? null) : null
  if (scope === null && bound !== null) {
    scope = bound
    c.set('scope', scope)
  }
  if (scope === null) {
    // `{base}/mcp` too: it is a scoped surface (`{base}/~<scope>/mcp`, decision 11),
    // and without a scope its tools would run on a person's `*` role — or `viewer`
    // for somebody who holds none — against every site at once.
    if (kind === 'scoped' && (below.startsWith('/api/') || below === '/mcp')) {
      return siteRequired(c, rt)
    }
    return actor
  }
  if (!actor || kind === 'unscoped') return actor

  const registry = await sites.registry(c.env)
  // A preview grant reads its site's chain and nothing else (decision 13); on any
  // other scope it is a caller with no role there.
  if (actor.kind === 'grant') {
    if (!chain(registry, actor.site).includes(scope)) {
      throw new FolioError('forbidden', `A preview of '${actor.site}' cannot read '${scope}'.`)
    }
    return actor
  }
  if (bound !== null && chain(registry, bound).length === 0) {
    throw new FolioError('forbidden', `This token is bound to '${bound}', which no longer exists.`)
  }
  if (actor.kind === 'token') {
    const scopes = tokenScopesOn(actor.scopes, bound, registry, scope)
    if (scopes === null && kind !== 'preview') {
      throw new FolioError(
        'forbidden',
        `This token is bound to '${bound}' and cannot reach '${scope}'.`,
      )
    }
    return { ...actor, scopes: scopes ?? [] }
  }
  const role = effectiveRole(actor.grants ?? { [ALL_SCOPES]: actor.role }, registry, scope)
  if (role === null && kind !== 'preview') {
    throw new FolioError('forbidden', `You have no role on '${scope}'.`)
  }
  // The one route with no role to give: it checks preview eligibility itself.
  return { ...actor, role: role ?? 'viewer' }
}

/**
 * Where a preview grant is worth asking about (`multi-site.md` decisions 12 and
 * 13): a read, on the preview origin `handle()` gated this request as, of that
 * site's v1 routes (a headless front end's draft read) or draft mode's switch.
 * **Nowhere else** — no `{base}/api` admin route, no socket, no `/mcp`, no write —
 * so a grant cookie anywhere else is no credential at all, and the request is as
 * anonymous as it would be without it. `handle()` already answers nothing else on
 * a preview origin; this is the same rule held a second time, where the actor is
 * made.
 *
 * The grant is read on a `first-primary` session, from the raw binding
 * (`PreviewSite.db` says why); only a request carrying a grant cookie on a
 * preview origin reaches that read.
 */
const GRANT_READS = [/^\/api\/v1\//, /^\/draft\/enter$/]

async function grantSite<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  sites: NonNullable<FolioRuntime['sites']>,
): Promise<PreviewSite | undefined> {
  const site = c.var.site
  if (site?.surface !== 'preview') return undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return undefined
  const below = c.req.path.slice(rt.base.length) || '/'
  if (!GRANT_READS.some((r) => r.test(below))) return undefined
  return {
    id: site.id,
    registry: await sites.registry(c.env),
    db: sites.rawDb(c.env).withSession(PRIMARY_FIRST),
  }
}

/**
 * Resolves who is making this request, once, for every route below
 * (`../../docs/specs/foundation/identity-and-access.md`).
 *
 * Stored as a value rather than a memoised thunk, unlike `bindings`, and the
 * difference is deliberate: invoking the host's `bindings` accessor is
 * observable, so the routes that answer from the config alone must not be made
 * to do it — whereas resolving the actor *is* this middleware's job, and a route
 * gated on a role has to have it resolved before its handler runs.
 *
 * The memoised-thunk discipline still applies underneath: `resolveActor` reads
 * no D1 for a request that presents neither a cookie nor a bearer token, so
 * `/schema`, a 404 and a refused socket upgrade still cost the database nothing.
 *
 * Under `auth: 'open'` this sets null and returns immediately: there are no users
 * to resolve, and every gate short-circuits on the mode rather than on the actor.
 *
 * The origin check lives here too (architecture decision 4), applied before the
 * credential is resolved so a cross-site attempt is refused without a lookup.
 */
export function withActor<Env>(rt: FolioRuntime): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    let actor: Actor | null = null
    if (rt.auth.mode === 'session') {
      const credential = credentialOf(c.req.raw)
      if (!originAllowed(c.req.raw, credential)) {
        throw new FolioError(
          'forbidden',
          'That request came from another site. Reload the editor and try again.',
        )
      }
      const preview = rt.sites ? await grantSite(c, rt, rt.sites) : undefined
      actor = await resolveActor(() => c.var.bindings().db, rt.auth, credential, { preview })
    }
    // With `sites`, the scope decides the role (`multi-site.md` decision 10). With
    // none there is one scope, the actor is exactly what was resolved, and nothing
    // here reads the registry — `allows()` then answers what it always has.
    if (rt.sites) {
      const scoped = await scopedActor(c, rt, rt.sites, actor)
      if (scoped instanceof Response) return scoped
      actor = scoped
    }
    c.set('actor', actor)
    await next()
  }
}

/**
 * Refuses a request whose actor may not do this (architecture decision 5).
 *
 * One middleware for both currencies — a minimum role for a person, a scope for a
 * token — because they are the same requirement expressed twice and separating
 * them is how the two drift. A route declares its requirement at the mount:
 * `app.post('/stories', requireAccess<Env>(rt, MANAGE), handler)`.
 *
 * 401 and 403 are kept strictly apart. 401 means there is no usable credential,
 * and is the only one the admin turns into a sign-in redirect; 403 means the
 * credential is fine and the answer will not change on a retry.
 *
 * `auth: 'open'` passes everything, and that check is here rather than inside
 * `allows` on purpose: `allows(null, …)` is unconditionally false, so the
 * predicate can never be the reason an unauthenticated request got through.
 */
export function requireAccess<Env>(
  rt: FolioRuntime,
  access: Access,
): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    if (rt.auth.mode !== 'session') {
      await next()
      return
    }
    const actor = c.var.actor
    if (!actor) throw new FolioError('unauthorized', 'Sign in to continue.')
    if (!allows(actor, access)) throw new FolioError('forbidden', refusalOf(actor, access))
    await next()
  }
}

/**
 * The same check inside a handler, for a route whose requirement depends on what
 * the request asked for rather than on which path it hit.
 *
 * `GET /api/v1/documents/:id` is the case: it needs `content:read` to read
 * published content and `content:read:draft` to read a draft, and which one is
 * decided by `?status=draft` — so it cannot be declared at the mount the way every
 * other route's is. Same predicate, same `auth: 'open'` short-circuit, same
 * refusal wording; the only difference is where it is asked.
 */
export function ensureAccess(rt: FolioRuntime, actor: Actor | null, access: Access): void {
  if (rt.auth.mode !== 'session') return
  if (!actor) throw new FolioError('unauthorized', 'Sign in to continue.')
  if (!allows(actor, access)) throw new FolioError('forbidden', refusalOf(actor, access))
}

/**
 * The same gate for a route that answers HTML: an unauthenticated request is a
 * 302 to the login page, not a JSON envelope.
 *
 * A person who typed an editor URL into a browser and is not signed in wants a
 * sign-in form, and `?next=` brings them back to the page they asked for. An
 * *authenticated* request that is merely not allowed still gets the JSON
 * refusal — it is a permissions answer, and no amount of signing in again
 * changes it.
 */
export function requireHtmlAccess<Env>(
  rt: FolioRuntime,
  access: Access,
): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    if (rt.auth.mode !== 'session') {
      await next()
      return
    }
    const actor = c.var.actor
    if (!actor) {
      const url = new URL(c.req.url)
      const next = safeNext(
        `${url.pathname}${url.search}`,
        rt.sites ? `${rt.base}/` : `${rt.base}/edit`,
      )
      return c.redirect(`${rt.base}/login?next=${encodeURIComponent(next)}`)
    }
    if (!allows(actor, access)) throw new FolioError('forbidden', refusalOf(actor, access))
    await next()
  }
}

/**
 * Refuses a route that only means something on a deployment with real accounts:
 * managing editors and tokens under `auth: 'open'` would be a list nobody can
 * sign in as and a permission nothing checks.
 */
export function requireAuthConfigured<Env>(rt: FolioRuntime): MiddlewareHandler<FolioEnv<Env>> {
  return async (_c, next) => {
    if (rt.auth.mode !== 'session') throw new FolioError('not_found', 'Auth is not configured')
    await next()
  }
}

/**
 * The same for the passkey surface, which is opt-in per deployment
 * (`../../docs/specs/foundation/passkeys.md` decision 1): a host that did not
 * list `passkeys()` has no enrolment screen, no login button and no script, so
 * the routes behind them do not exist either.
 *
 * 404 rather than 403, and it subsumes `requireAuthConfigured`'s check: "there
 * is no such thing here" is the honest answer for a surface the configuration
 * never created, and it is the same answer `auth: 'open'` gets, so a probe
 * cannot tell a deployment without passkeys from a deployment without accounts.
 *
 * Deliberately **not** on `DELETE {base}/api/users/:id/passkeys`. Removing a
 * lost device's credentials is the one passkey act that must keep working after
 * a host takes the provider back out, and stale rows nobody can clear is a
 * worse state than an admin route that answers on a deployment with none.
 */
export function requirePasskeys<Env>(rt: FolioRuntime): MiddlewareHandler<FolioEnv<Env>> {
  return async (_c, next) => {
    if (rt.auth.mode !== 'session' || !rt.auth.passkey) {
      throw new FolioError('not_found', 'Passkeys are not configured')
    }
    await next()
  }
}

/**
 * Screens the `:id` in the path and loads the story row behind it, or 404s.
 *
 * Mounted on the routes that need the row itself — its `title` seeds the draft on
 * first touch — so the existence check and the read are one query rather than the
 * two the same handler used to run back to back. Routes whose 404 is not a JSON
 * envelope (the admin HTML pages) or not a 404 at all (the sync socket, which
 * upgrades and closes) do their own lookup instead; see their own comments.
 */
export function loadStory<Env>(rt: FolioRuntime, reach: Reach): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    const id = idParam('id', c.req.param('id'))
    const story = await storyById(c.var.bindings().db, id)
    if (!story || !(await inFence(c, rt, story, reach))) {
      throw new FolioError('not_found', 'Unknown story')
    }
    c.set('story', story)
    await next()
  }
}

/* ---------------------------------------------------------------- fences --- */

/**
 * What a loader is about to do with a row (`multi-site.md` decision 10's row
 * checks): `'write'` needs the row in the request's scope, `'read'` anywhere in its
 * chain. **Reads flow up the chain; writes never do.**
 */
export type Reach = 'read' | 'write'

/**
 * The scope a request acts in: the `~<scope>` segment or a bound token's binding,
 * and `default` on a deployment with no `sites`. Null on a multi-site request that
 * named none, which reaches no row.
 */
export function requestScope<Env>(c: Context<FolioEnv<Env>>, rt: FolioRuntime): string | null {
  return rt.sites ? c.var.scope : DEFAULT_SITE
}

/** The request's chain, nearest first: `['default']` with no `sites`, empty for a
 * multi-site request with no scope. What every id-set and path read takes. */
export async function requestChain<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): Promise<readonly string[]> {
  if (!rt.sites) return SINGLE_SITE_CHAIN
  const scope = c.var.scope
  return scope === null ? [] : chain(await rt.sites.registry(c.env), scope)
}

/**
 * Whether a row owned by `site` is inside this request's fence: in its scope for a
 * write, in its chain for a read. **Always true with no `sites`**, and decided
 * without a read: every row is `default` there, and a check that cost a query
 * would move a single-site deployment's statement counts for nothing.
 */
export async function inFence<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  row: Pick<StoryMeta, 'site'>,
  reach: Reach,
): Promise<boolean> {
  if (!rt.sites) return true
  const site = row.site ?? DEFAULT_SITE
  if (reach === 'write') return site === c.var.scope
  return (await requestChain(c, rt)).includes(site)
}

/**
 * The fence for a route whose workflow loads the story itself (`publish`,
 * `moveDocument`, `deleteDocument`): an id outside it is a 404 before the workflow
 * runs. **Mounts nothing with no `sites`** — no read, no statement — so a
 * single-site request is exactly what it was.
 *
 * `absent: 'pass'` for the routes whose answer to an id nothing is behind is not a
 * 404 (an empty history, a schedule cancelled for a deleted story): only a row that
 * exists and is outside the fence is refused there.
 */
export function fenceStory<Env>(
  rt: FolioRuntime,
  reach: Reach,
  opts: { absent?: 'pass' | 'refuse' } = {},
): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    if (rt.sites) {
      const id = idParam('id', c.req.param('id'))
      const story = await storyById(c.var.bindings().db, id)
      const outside = story ? !(await inFence(c, rt, story, reach)) : opts.absent !== 'pass'
      if (outside) throw new FolioError('not_found', 'Unknown story')
    }
    await next()
  }
}

/**
 * The fence for a parent named in a body (a create, a move, a duplicate's new
 * parent): a parent outside the request's chain is exactly an unknown one, a 404,
 * never the 409 `createStory` / `updateStoryStatement` answer for a parent in the
 * chain but in another scope — that message names the parent, which a caller who
 * cannot read it must not learn. With no `sites`, nothing is read.
 */
export async function fenceParent<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  parentId: string | null | undefined,
): Promise<void> {
  if (!rt.sites || !parentId) return
  const parent = await storyById(c.var.bindings().db, parentId)
  if (parent && !(await inFence(c, rt, parent, 'read'))) {
    throw new FolioError('not_found', 'Unknown parent')
  }
}

/**
 * The site row the request's scope names, or undefined: a group, `shared`, a
 * scope nobody registered, and a deployment with no `sites` have none. What a
 * reader that builds URLs (`rt.query`'s `site`, `rt.urlsFor`) is handed.
 */
export async function requestSite<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): Promise<SiteRef | undefined> {
  const scope = rt.sites ? c.var.scope : null
  if (!rt.sites || scope === null) return undefined
  return (await rt.sites.registry(c.env)).sites.find((site) => site.id === scope)
}

/**
 * `rt.withUrls` as the request's site would see it: on a deployment with `sites`, a
 * story's `url`, `previewUrl` and `draftUrl` are the host's `route()` answer **for
 * that site** — an absolute URL on its host, and its preview URL on its preview
 * origin (`multi-site.md` decisions 4 and 13). Without the site the admin, which sits
 * on its own origin, would be handed paths that resolve to nothing there. A group or
 * `shared` scope has no host, so its rows are decorated as `withUrls` always has.
 */
export async function requestUrls<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): Promise<FolioRuntime['withUrls']> {
  if (!rt.sites) return rt.withUrls
  return rt.urlsFor(await requestSite(c, rt))
}

/**
 * Every scope the caller may read — the request's chain, and any other scope they hold
 * a role on (`multi-site.md`: usage lists "uses in readable scopes", counts the rest).
 * A platform admin reads them all; a shared publisher who is also alpha's editor reads
 * shared and alpha. Without `sites` it is the single-site chain.
 */
export async function readableScopes<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): Promise<readonly string[]> {
  const within = await requestChain(c, rt)
  const actor = c.var.actor
  if (!rt.sites || !actor) return within
  const registry = await rt.sites.registry(c.env)
  const every = [
    SHARED_SCOPE,
    ...registry.groups.map((g) => g.id),
    ...registry.sites.map((s) => s.id),
  ]
  const readable = every.filter((scope) => {
    if (actor.kind === 'user') {
      return effectiveRole(actor.grants ?? { [ALL_SCOPES]: actor.role }, registry, scope) !== null
    }
    if (actor.kind === 'token') {
      return tokenScopesOn(actor.scopes, actor.site ?? null, registry, scope) !== null
    }
    return false
  })
  return [...new Set([...within, ...readable])]
}

/**
 * A scope's chain for a workflow that learns the scope only from a row it has just
 * read (`documents.ts`' delete, which must know whether a scope above a deleted
 * root has a root of its own). Absent with no `sites`, where a scope is its own whole
 * chain.
 */
export function chainResolver<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): ((scope: string) => Promise<readonly string[]>) | undefined {
  const sites = rt.sites
  return sites ? async (scope) => chain(await sites.registry(c.env), scope) : undefined
}

/**
 * The fence for a route whose `:param` names a row that is not a story — an asset, a
 * folder, a tag, a form. `siteOf` answers the scope that owns the row (a column of its
 * own, so no payload changes shape) or null for none, and a row outside the request's
 * chain (a read) or scope (a write) is exactly an unknown one (`multi-site.md`
 * decision 10).
 *
 * **Absent passes**, so each route keeps its own 404 for an id nothing is behind.
 * **Mounts nothing with no `sites`**: no read, no statement, so a single-site request
 * is exactly what it was.
 */
export function fenceRow<Env>(
  rt: FolioRuntime,
  reach: Reach,
  siteOf: (db: FolioDb, id: string) => Promise<string | null>,
  what: string,
  param = 'id',
): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    if (rt.sites) {
      const site = await siteOf(c.var.bindings().db, c.req.param(param) ?? '')
      if (site !== null && !(await inFence(c, rt, { site }, reach))) {
        throw new FolioError('not_found', `Unknown ${what}`)
      }
    }
    await next()
  }
}

/**
 * A person's effective role on one scope, for a check that is about a *row's*
 * scope rather than the request's — the story socket, whose role is the one on the
 * story's own scope (decision 10), so a site editor on a shared page is a viewer.
 * With no `sites` it is `role`, untouched.
 */
export async function roleOnScope<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  actor: Extract<Actor, { kind: 'user' }>,
  scope: string,
): Promise<Role | null> {
  if (!rt.sites || !actor.grants) return actor.role
  return effectiveRole(actor.grants, await rt.sites.registry(c.env), scope)
}

/**
 * `c.env` and a `waitUntil` built from `c.executionCtx` — the two halves of a
 * `HookRunnerCtx` (`../../docs/specs/platform/publish-hooks.md` decision 3),
 * for every route that fires a lifecycle hook.
 *
 * One copy, here. It used to be two identical private helpers in
 * `routes/stories.ts` and `routes/api/documents.ts` plus a third spelled out
 * inline in `routes/history.ts`; `../../docs/specs/platform/caching.md` added two more
 * hook-firing routes, at which point five copies of the same three lines was
 * the wrong shape. Not in `hooks.ts`, which deliberately knows nothing about
 * Hono or a Request — the whole reason a Durable Object alarm can fire the same
 * hooks (`alarmHookCtx`, runtime.ts).
 */
export function hookCtx<Env>(c: Context<FolioEnv<Env>>): HookRunnerCtx {
  return { env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) }
}
