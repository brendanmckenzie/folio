/**
 * Signing in, signing out, and "who am I".
 *
 * Every route here is reachable without a credential, by definition — that is
 * what a login page is — so the discipline is different from the rest of the
 * server: nothing may leak whether an address is known, and nothing may accept a
 * redirect target it was handed.
 *
 * Managing editors and tokens is *not* here. Those routes are gated on the
 * `admin` role and live in `users.ts`, so that this file's "no credential
 * required" rule holds for the whole file rather than per handler.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  CLOCK_LEEWAY_MS,
  consumeChallenge,
  createChallenge,
  recentChallengeCount,
} from '../auth/challenges'
import {
  type AuthProvider,
  authPolicy,
  type RedirectProvider,
  type RedirectState,
  type ResolvedAuth,
} from '../auth/config'
import {
  clearOidcCookies,
  clearSessionCookies,
  cookieName,
  oidcCookieName,
  readOidcCookie,
  serialiseCookie,
} from '../auth/cookie'
import { credentialOf, resolveActor } from '../auth/resolve'
import { revokeSession } from '../auth/session'
import { completeSignIn } from '../auth/sign-in'
import type { NewSession } from '../auth/session'
import { userByEmail } from '../auth/users'
import { FolioError } from '../errors'
import { loginPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { LoginEmailBody, parseOrThrow, safeNext } from '../validate'

/** How long the OIDC state cookie lives: one round trip to an IdP, not a
 * session. Ten minutes is generous for a login form and short enough that a
 * stale tab fails closed. */
const OIDC_STATE_TTL_S = 600

/**
 * The generic answer a sign-in request always gets, whether or not the address
 * is known and whether or not the mail actually went out.
 *
 * Byte-identical in every case, deliberately: a different message, a different
 * status, or even a noticeably different response time for an unknown address
 * turns this route into an oracle for "does this person have access to that
 * site's CMS", which is a useful thing for an attacker to learn and a useless
 * thing for a legitimate user to be told.
 */
const SENT = 'If that address has access, a sign-in link is on its way. It expires in 15 minutes.'

/** Reads either a JSON body or an HTML form post, since the login page ships no
 * JavaScript and therefore posts a form. */
async function loginBody(req: Request): Promise<{ email: string; next?: string }> {
  const type = req.headers.get('content-type') ?? ''
  let raw: unknown
  if (type.includes('application/json')) {
    raw = await req.json().catch(() => ({}))
  } else {
    const form = await req.formData().catch(() => new FormData())
    raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
  }
  return parseOrThrow(LoginEmailBody, raw, 'body')
}

/** True when the caller wants JSON back — a script or the admin — rather than
 * the login page re-rendered. */
function wantsJson(req: Request): boolean {
  const accept = req.headers.get('accept') ?? ''
  if (accept.includes('application/json')) return true
  return !accept.includes('text/html') && (req.headers.get('content-type') ?? '').includes('json')
}

export function authRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const editorUrl = `${rt.base}/edit`

  /** The resolved auth, or a 404 for a deployment with `auth: 'open'`: there is
   * nothing to sign in to, so a login page would be a lie. */
  const sessionAuth = (): Extract<ResolvedAuth<unknown>, { mode: 'session' }> => {
    if (rt.auth.mode !== 'session') throw new FolioError('not_found', 'Auth is not configured')
    return rt.auth
  }

  const providerById = (id: string): AuthProvider<unknown> => {
    const found = sessionAuth().config.providers.find((p) => p.id === id)
    if (!found) throw new FolioError('not_found', 'Unknown sign-in provider')
    return found
  }

  /**
   * One place turns a minted session into a cookie, so the name rule and the
   * attributes cannot differ between the paths that mint one.
   *
   * Everything *before* the cookie — finding or provisioning the user, stamping
   * the provider, appending the audit row — is `completeSignIn`'s
   * (`../auth/sign-in.ts`), which is why this is three lines rather than the
   * twice-written block it replaced.
   */
  const signInCookie = (c: Context<FolioEnv<Env>>, minted: NewSession): string => {
    const url = new URL(c.req.url)
    return serialiseCookie(url, cookieName(url), minted.token, {
      maxAge: Math.floor((minted.expiresAt - Date.now()) / 1000),
    })
  }

  app.get('/login', async (c) => {
    sessionAuth()
    const next = safeNext(c.req.query('next'), editorUrl)
    // `?error=` is set by the redirects below rather than by anything a stranger
    // can craft into a message: the parameter selects one of a fixed set.
    const error = c.req.query('error')
    return loginPage(rt, {
      next,
      sent: c.req.query('sent') !== undefined ? SENT : null,
      error:
        error === 'link'
          ? 'That sign-in link has already been used or has expired. Ask for a new one.'
          : error === 'refused'
            ? 'That account does not have access to this site.'
            : error === 'provider'
              ? 'Signing in with that provider did not work. Try again.'
              : null,
    })
  })

  /**
   * Requests a sign-in link. **Always** answers the same thing.
   *
   * Note what is *not* awaited differently between the branches: an unknown
   * address does exactly the same amount of work minus the send, and the answer
   * is assembled before either branch runs.
   */
  app.post('/login/email', async (c) => {
    const auth = sessionAuth()
    // The mail provider by *kind*, not by which functions the object happens to
    // carry, and there is at most one of them by construction.
    const provider = auth.mail
    if (!provider) {
      throw new FolioError('unsupported', 'No email sign-in provider is configured')
    }
    const body = await loginBody(c.req.raw)
    const next = safeNext(body.next, editorUrl)
    const db = c.var.bindings().db

    const user = await userByEmail(db, body.email)
    if (user) {
      const perHour = auth.linksPerHour
      const recent = await recentChallengeCount(db, body.email)
      if (recent < perHour) {
        const challenge = await createChallenge(db, body.email)
        const url = new URL(c.req.url)
        url.pathname = `${rt.base}/login/verify`
        url.search = ''
        url.searchParams.set('t', challenge.token)
        url.searchParams.set('next', next)
        try {
          await provider.send(c.env, {
            email: body.email,
            url: url.toString(),
            expiresAt: challenge.expiresAt,
          })
        } catch (err) {
          // A failed send is the host's problem to see in its logs, never the
          // requester's to learn about: "we could not mail you" is a weaker
          // oracle than an outright "unknown address", but it is still one.
          console.error('folio: a sign-in link failed to send', err)
        }
      }
    }

    if (wantsJson(c.req.raw)) return c.json({ ok: true, message: SENT })
    return loginPage(rt, { next, sent: SENT })
  })

  /**
   * Consumes a link and signs the browser in.
   *
   * Registered ahead of `/login/:provider` so `verify` is never read as a
   * provider id. A refused link redirects back to the login page with a generic
   * reason rather than rendering an error in place, so the address in the bar
   * afterwards is a page that can be reloaded.
   */
  app.get('/login/verify', async (c) => {
    const auth = sessionAuth()
    const next = safeNext(c.req.query('next'), editorUrl)
    const token = c.req.query('t')
    const db = c.var.bindings().db

    const email = token ? await consumeChallenge(db, token) : null
    if (!email) return c.redirect(`${rt.base}/login?error=link&next=${encodeURIComponent(next)}`)

    // Unreachable in practice — only `POST /login/email` mints a challenge and
    // it needs this provider — but a token cannot be trusted to imply a
    // configuration, so the branch is written rather than asserted.
    if (!auth.mail) {
      return c.redirect(`${rt.base}/login?error=refused&next=${encodeURIComponent(next)}`)
    }

    // The challenge proves the address. Everything after it — the account must
    // exist (a link never provisions, because `mail` cannot carry `provision`),
    // the provider stamp, the audit row — is `completeSignIn`'s.
    const result = await completeSignIn(
      db,
      auth,
      auth.mail,
      { email },
      { userAgent: c.req.header('user-agent') ?? null },
    )
    if (!result.ok) {
      return c.redirect(`${rt.base}/login?error=${result.reason}&next=${encodeURIComponent(next)}`)
    }

    return new Response(null, {
      status: 302,
      headers: { location: next, 'set-cookie': signInCookie(c, result.session) },
    })
  })

  /**
   * Starts a redirect flow.
   *
   * Whatever the provider asked to remember — for OIDC the state, nonce and PKCE
   * verifier — rides in a short-lived httpOnly cookie beside Folio's own `next`:
   * both must survive a trip to the IdP and be unreadable to anything else,
   * which is exactly a cookie's job.
   */
  app.get('/login/:provider', async (c) => {
    const provider = providerById(c.req.param('provider'))
    if (provider.kind !== 'redirect') {
      throw new FolioError('not_found', 'That provider is not a redirect flow')
    }
    const url = new URL(c.req.url)
    const next = safeNext(c.req.query('next'), editorUrl)
    const redirectUri = `${url.origin}${rt.base}/login/${provider.id}/callback`

    let started: { url: string; state: RedirectState }
    try {
      // `next` is not handed to the provider: it is Folio's, it has already been
      // screened same-origin, and a provider that never sees it cannot be talked
      // into putting it somewhere. The cookie envelope below carries it.
      started = await provider.start(c.env, { redirectUri })
    } catch (err) {
      console.error(`folio: ${provider.id} sign-in could not start`, err)
      return c.redirect(`${rt.base}/login?error=provider&next=${encodeURIComponent(next)}`)
    }

    return new Response(null, {
      status: 302,
      headers: {
        location: started.url,
        'set-cookie': serialiseCookie(
          url,
          oidcCookieName(url),
          encodeState({ next, state: started.state }),
          { maxAge: OIDC_STATE_TTL_S },
        ),
      },
    })
  })

  app.get('/login/:provider/callback', async (c) => {
    const auth = sessionAuth()
    const provider = providerById(c.req.param('provider'))
    if (provider.kind !== 'redirect') {
      throw new FolioError('not_found', 'That provider has no callback')
    }
    const url = new URL(c.req.url)
    const envelope = decodeState(readOidcCookie(c.req.header('cookie')))
    const next = safeNext(envelope?.next, editorUrl)
    const bail = (reason: 'provider' | 'refused') =>
      new Response(null, {
        status: 302,
        headers: [
          ['location', `${rt.base}/login?error=${reason}&next=${encodeURIComponent(next)}`],
          ...clearOidcCookies(url).map((value) => ['set-cookie', value] as [string, string]),
        ],
      })

    // No state cookie at all: a bookmarked callback, a cookie-less browser, or a
    // cross-site attempt. There is nothing to verify the response against, so
    // there is nothing to exchange.
    if (!envelope) return bail('provider')

    let identity: Awaited<ReturnType<RedirectProvider<unknown>['callback']>>
    try {
      identity = await provider.callback(c.env, {
        // The query only. A provider that cannot see the request's own URL
        // cannot decide anything from it, and the callback is GET with
        // `response_mode=query` by decision 2.
        params: url.searchParams,
        redirectUri: `${url.origin}${rt.base}/login/${provider.id}/callback`,
        state: envelope.state,
      })
    } catch (err) {
      console.error(`folio: ${provider.id} sign-in failed`, err)
      return bail('provider')
    }

    const result = await completeSignIn(c.var.bindings().db, auth, provider, identity, {
      userAgent: c.req.header('user-agent') ?? null,
    })
    if (!result.ok) return bail(result.reason)

    return new Response(null, {
      status: 302,
      headers: [
        ['location', next],
        ['set-cookie', signInCookie(c, result.session)],
        ...clearOidcCookies(url).map((value) => ['set-cookie', value] as [string, string]),
      ],
    })
  })

  return app
}

/**
 * The two JSON routes of the session: who am I, and sign me out.
 *
 * Split from the sign-in flow above because they land on opposite sides of the
 * `{base}/api` line (`../../../docs/specs/foundation/pagination.md` decision 3).
 * The flow is HTML and redirects — a form post, an emailed link, an OIDC callback,
 * and a page that deliberately ships no JavaScript — so it keeps the bare mount
 * where a browser can be sent to it. These two are the admin talking to its own
 * server, so they move.
 */
export function sessionRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Signs out. Reads the cookie itself rather than `c.var.actor`, so a browser
   * holding a session that has already been revoked server-side still gets its
   * cookie cleared instead of a 401 it can do nothing about.
   */
  app.post('/logout', async (c) => {
    const url = new URL(c.req.url)
    const token = credentialOf(c.req.raw).cookie
    if (token && rt.auth.mode === 'session') {
      await revokeSession(c.var.bindings().db, token)
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ...clearSessionCookies(url).map((value) => ['set-cookie', value] as [string, string]),
      ],
    })
  })

  /**
   * The current actor, for the admin's user menu and its read-only mode.
   *
   * Answers 200 with `actor: null` under `auth: 'open'` rather than 404: the
   * admin asks this on every load and needs to be able to tell "no auth
   * configured here" apart from "not signed in", and only the first of those is
   * a reason to keep the anonymous presence identity it generates itself.
   *
   * **It also answers the sign-in policy**, for the Settings screen
   * (`../../../docs/ui-architecture.md` decision 6): which providers are
   * configured, how long a session lasts, and how many links an address may
   * request per hour. That block briefly lived on the ungated `/api/schema` and
   * this is where it belongs — `auth/config.ts`'s `AuthPolicy` carries the
   * argument, and `server/app.ts` states the rule it follows. The route needed no
   * new gate to hold it: session mode already refuses a caller with no actor two
   * lines below, and `auth: 'open'` has no policy to describe.
   */
  app.get('/me', async (c) => {
    const credential = credentialOf(c.req.raw)
    const actor = await resolveActor(() => c.var.bindings().db, rt.auth, credential)
    if (rt.auth.mode === 'session' && !actor) {
      throw new FolioError('unauthorized', 'Not signed in')
    }
    // Redacted, not the actor verbatim: `session` is the SHA-256 of the cookie's
    // token and `expiresAt` is bookkeeping, and neither is any use to the admin.
    // Handing a browser its own session id is not a credential leak — the hash
    // cannot be presented as the token — but it is internal detail with no
    // reader, and the smallest response is the one that cannot leak later.
    const safe =
      actor === null
        ? null
        : actor.kind === 'user'
          ? {
              kind: 'user' as const,
              id: actor.id,
              name: actor.name,
              colour: actor.colour,
              role: actor.role,
            }
          : { kind: 'token' as const, id: actor.id, name: actor.name, scopes: actor.scopes }
    // Omitted rather than null under `auth: 'open'`, where there are no providers,
    // no session length and no throttle: absence is the honest answer, and a block
    // of zeroes would be a policy the screen would then have to explain away.
    const policy = authPolicy(rt.auth)
    return c.json({
      mode: rt.auth.mode,
      actor: safe,
      loginUrl: `${rt.base}/login`,
      ...(policy ? { policy } : {}),
    })
  })

  return app
}

/* ------------------------------------------------------------------ state --- */

/**
 * The redirect-state cookie's payload: **an envelope**, `{ next, state }`.
 *
 * `next` is Folio's — screened same-origin before it is written and screened
 * again when it comes back — and `state` is whatever the provider asked to
 * remember, handed back to it unread. It used to be one flat OIDC-shaped object
 * with `next` as a fourth field beside `state`, `nonce` and `verifier`, which
 * made the cookie a protocol's shape rather than a provider's.
 *
 * Base64url over UTF-8 rather than raw JSON: a cookie value may not contain `;`
 * or a comma, and JSON is full of characters that survive some proxies and not
 * others.
 */
interface StateEnvelope {
  next: string
  state: RedirectState
}

function encodeState(envelope: StateEnvelope): string {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Total over its input: the cookie is attacker-supplied like any other, and an
 * unreadable one means "no state", which the callback already refuses.
 *
 * `state` is screened to a string-valued record — the provider is handed a
 * `RedirectState` and must not have to defend against a nested object, an array
 * or a number arriving where it wrote a string.
 */
function decodeState(value: string | null): StateEnvelope | null {
  if (!value) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StateEnvelope>
    if (typeof parsed.next !== 'string') return null
    const state = parsed.state
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return null
    const screened: Record<string, string> = {}
    for (const [key, entry] of Object.entries(state)) {
      if (typeof entry !== 'string') return null
      screened[key] = entry
    }
    return { next: parsed.next, state: screened }
  } catch {
    return null
  }
}

/** Re-exported so the login routes and the OIDC provider agree on the leeway
 * every expiry comparison in this feature uses. */
export { CLOCK_LEEWAY_MS }
