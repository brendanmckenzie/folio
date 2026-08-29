import type { Context, MiddlewareHandler } from 'hono'
import { credentialOf, originAllowed, resolveActor } from './auth/resolve'
import { type Access, type Actor, allows, refusalOf } from './auth/roles'
import { FolioError } from './errors'
import type { HookRunnerCtx } from './hooks'
import type { FolioRuntime } from './runtime'
import { storyById } from './stories'
import type { FolioBindings, FolioConfig, FolioEnv } from './types'
import { idParam, safeNext } from './validate'

/**
 * The one place the host's `Env` becomes Folio's bindings. Every handler then
 * reads `c.var.bindings()`, instead of each one calling `config.bindings` on an
 * env it first has to cast.
 *
 * What is stored is a memoised thunk, not the bindings: this middleware runs
 * ahead of every route, and the ones that answer from the config alone — the
 * `/schema` manifest, a 404, a refused socket upgrade — answered without the
 * host's accessor before it existed and must keep doing so. See `FolioVars` in
 * types.ts. Memoising means the routes that do need it (and their own
 * middleware, which asks first) still call it exactly once per request.
 */
export function withBindings<Env>(config: FolioConfig<Env>): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    let resolved: FolioBindings | undefined
    c.set('bindings', () => (resolved ??= config.bindings(c.env)))
    await next()
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
    if (rt.auth.mode !== 'session') {
      c.set('actor', null)
      await next()
      return
    }
    const credential = credentialOf(c.req.raw)
    if (!originAllowed(c.req.raw, credential)) {
      throw new FolioError(
        'forbidden',
        'That request came from another site. Reload the editor and try again.',
      )
    }
    c.set('actor', await resolveActor(() => c.var.bindings().db, rt.auth, credential))
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
      const next = safeNext(`${url.pathname}${url.search}`, `${rt.base}/edit`)
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
 * Screens the `:id` in the path and loads the story row behind it, or 404s.
 *
 * Mounted on the routes that need the row itself — its `title` seeds the draft on
 * first touch — so the existence check and the read are one query rather than the
 * two the same handler used to run back to back. Routes whose 404 is not a JSON
 * envelope (the admin HTML pages) or not a 404 at all (the sync socket, which
 * upgrades and closes) do their own lookup instead; see their own comments.
 */
export function loadStory<Env>(): MiddlewareHandler<FolioEnv<Env>> {
  return async (c, next) => {
    const id = idParam('id', c.req.param('id'))
    const story = await storyById(c.var.bindings().db, id)
    if (!story) throw new FolioError('not_found', 'Unknown story')
    c.set('story', story)
    await next()
  }
}

/**
 * `c.env` and a `waitUntil` built from `c.executionCtx` — the two halves of a
 * `HookRunnerCtx` (`../../docs/specs/platform/publish-hooks.md` decision 3),
 * for every route that fires a lifecycle hook.
 *
 * One copy, here. It used to be two identical private helpers in
 * `routes/stories.ts` and `routes/api/documents.ts` plus a third spelled out
 * inline in `routes/history.ts`; `../platform/caching.md` added two more
 * hook-firing routes, at which point five copies of the same three lines was
 * the wrong shape. Not in `hooks.ts`, which deliberately knows nothing about
 * Hono or a Request — the whole reason a Durable Object alarm can fire the same
 * hooks (`alarmHookCtx`, runtime.ts).
 */
export function hookCtx<Env>(c: Context<FolioEnv<Env>>): HookRunnerCtx {
  return { env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) }
}
