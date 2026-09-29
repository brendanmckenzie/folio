/**
 * Who is making this request: session cookie, then — on a site's preview origin,
 * when the caller asks — a preview grant, then bearer token, then nobody.
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
import type { Registry } from '../../core/sites'
import type { ResolvedAuth } from './config'
import { readGrantCookie, readSessionCookie } from './cookie'
import { readGrant } from './grants'
import { type Actor, mayPreviewDrafts } from './roles'
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
  /**
   * A preview grant cookie (`multi-site.md` decision 13), screened, or null. Carried
   * whatever the request, and **worth nothing unless `resolveActor` is told which
   * preview origin it arrived on**: a grant is one site's, and only a caller that
   * knows the gated site and surface can ask for it.
   */
  grant: string | null
}

export function credentialOf(req: Request): Credential {
  const cookie = req.headers.get('cookie')
  return {
    cookie: readSessionCookie(cookie),
    bearer: bearerToken(req.headers.get('authorization')),
    grant: readGrantCookie(cookie),
  }
}

/**
 * The site a request was gated as on its **preview** origin, for a caller that
 * may accept a grant there: `withActor` for a read, `handle()`'s `?_folio=` branch
 * and a reader's draft. Nothing else passes one, which is what keeps a grant off
 * every admin route and every socket.
 */
export interface PreviewSite {
  id: string
  registry: Registry
  /**
   * The session the grant is read on: **`first-primary`**, unlike every other
   * credential read. A grant is redeemed on the primary one redirect before the
   * first page asks for it, and a replica behind that write would refuse it — the
   * pane's first render showing the published page as though it were the draft.
   * Only a request carrying a grant cookie on a preview origin pays for it.
   */
  db: FolioDb
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
  opts: { preview?: PreviewSite } = {},
): Promise<Actor | null> {
  if (auth.mode !== 'session') return null
  const preview = opts.preview
  if (!preview) {
    if (credential.cookie) return readSession(db(), credential.cookie, { days: auth.sessionDays })
    if (credential.bearer) return readToken(db(), credential.bearer)
    return null
  }
  // On a preview origin (decision 13) a session is kept only if it may preview
  // this site; one that may not — a cookie that leaked across ports in
  // development, or a person with no role on the chain — falls through to the
  // grant rather than hiding it.
  const session = credential.cookie
    ? await readSession(db(), credential.cookie, { days: auth.sessionDays })
    : null
  if (session && mayPreviewDrafts(session, preview.registry, preview.id)) return session
  // Ahead of the bearer header: a headless front end forwards the visitor's
  // `Cookie` on its own call (decision 13, "every surface"), and the grant in it is
  // the visitor's right to the draft, whatever the front end's own token holds.
  if (credential.grant) {
    const grant = await readGrant(preview.db, credential.grant, preview)
    if (grant) return grant
  }
  if (credential.bearer) return readToken(db(), credential.bearer)
  // The ineligible session still identifies somebody: the caller decides what it
  // may do (`mayPreviewDrafts` on a render path, `scopedActor` on a v1 route).
  return session
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
 *   - **Only cookie-authenticated requests** — the session's or a preview
 *     grant's. A cookie is the only credential a browser attaches without being
 *     asked, so it is the only one a cross-site page can borrow. A bearer token is held by a script that chose to send it;
 *     refusing it for its `Origin` would break a legitimate browser-based
 *     integration for no gain.
 *   - **An absent `Origin` passes.** Browsers set it on every POST; a request
 *     without one is `curl`, an e2e script, or a server — none of which can be
 *     tricked into replaying someone's cookie.
 */
export function originAllowed(req: Request, credential: Credential): boolean {
  if (!credential.cookie && !credential.grant) return true
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
