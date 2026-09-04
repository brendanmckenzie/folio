/**
 * Who is making this request: session cookie, then bearer token, then nobody.
 *
 * Deliberately not a Hono middleware. Three callers need this answer and only
 * one of them has a `Context`: the middleware (middleware.ts), the preview
 * branch of `handle()` (index.tsx), which serves *draft* content from outside
 * `basePath` and so needs the same gate the API routes get, and the socket route,
 * which needs the actor before it decides how to refuse an upgrade.
 *
 * **No D1 read for a request with neither credential.** That is the same
 * discipline `withBindings`'s memoised thunk keeps and for the same reason: the
 * routes that answer from the config alone — `/schema`, a 404, a refused upgrade
 * — must not acquire a dependency on the database merely because a middleware
 * runs ahead of them.
 */
import type { ResolvedAuth } from './config'
import { readSessionCookie } from './cookie'
import type { Actor } from './roles'
import { readSession } from './session'
import { bearerToken, readToken } from './tokens'
import type { FolioDb } from '../db'

/**
 * The presented credential, without resolving it. Useful on its own: the CSRF
 * origin check applies to cookie-authenticated requests specifically (see
 * `originAllowed`), because a cookie is the only credential a browser attaches
 * ambiently.
 */
export interface Credential {
  cookie: string | null
  bearer: string | null
}

export function credentialOf(req: Request): Credential {
  return {
    cookie: readSessionCookie(req.headers.get('cookie')),
    bearer: bearerToken(req.headers.get('authorization')),
  }
}

/**
 * Resolves a credential to an actor, or null.
 *
 * Cookie first: it is what a browser in the admin always has, so trying the
 * bearer header first would cost every admin request a wasted lookup. A request
 * presenting both gets the cookie's identity — the same request, from the same
 * browser, would otherwise mean two different people depending on header order.
 *
 * Under `auth: 'open'` this answers null without touching D1: there are no users
 * to resolve, and every route gate short-circuits on the mode rather than on the
 * actor.
 */
export async function resolveActor(
  db: () => FolioDb,
  auth: ResolvedAuth<unknown>,
  credential: Credential,
): Promise<Actor | null> {
  if (auth.mode !== 'session') return null
  if (credential.cookie) return readSession(db(), credential.cookie, { days: auth.sessionDays })
  if (credential.bearer) return readToken(db(), credential.bearer)
  return null
}

/**
 * Whether a mutating request's `Origin` is this worker's own.
 *
 * Origin checking rather than CSRF tokens (architecture decision 4): every
 * mutating route is a JSON POST/PATCH/DELETE, the cookie is `SameSite=Lax`, and
 * this is the third overlapping defence — no per-form round trip, no token
 * plumbing.
 *
 * Two deliberate narrowings:
 *
 *   - **Only cookie-authenticated requests.** A cookie is the only credential a
 *     browser attaches without being asked, so it is the only one a cross-site
 *     page can borrow. A bearer token is held by a script that chose to send it;
 *     refusing it for its `Origin` would break a legitimate browser-based
 *     integration for no gain.
 *   - **An absent `Origin` passes.** Browsers set it on every POST; a request
 *     without one is `curl`, an e2e script, or a server — none of which can be
 *     tricked into replaying someone's cookie.
 */
export function originAllowed(req: Request, credential: Credential): boolean {
  if (!credential.cookie) return true
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = req.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).origin === new URL(req.url).origin
  } catch {
    return false
  }
}
