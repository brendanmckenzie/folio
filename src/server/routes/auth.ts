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
import type { AuthProvider, OidcState } from '../auth/config'
import {
  clearOidcCookies,
  clearSessionCookies,
  cookieName,
  oidcCookieName,
  readOidcCookie,
  serialiseCookie,
} from '../auth/cookie'
import { credentialOf, resolveActor } from '../auth/resolve'
import { createSession, revokeSession } from '../auth/session'
import { createUser, userByEmail } from '../auth/users'
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

  /** The configured providers, or a 404 for a deployment with `auth: 'open'`:
   * there is nothing to sign in to, so a login page would be a lie. */
  const providers = (): readonly AuthProvider<unknown>[] => {
    if (rt.auth.mode !== 'session') throw new FolioError('not_found', 'Auth is not configured')
    return rt.auth.config.providers
  }

  const providerById = (id: string): AuthProvider<unknown> => {
    const found = providers().find((p) => p.id === id)
    if (!found) throw new FolioError('not_found', 'Unknown sign-in provider')
    return found
  }

  /** One place mints the cookie for a fresh session, so the name rule and the
   * attributes cannot differ between the magic-link and the OIDC paths. */
  const signIn = async (
    c: Context<FolioEnv<Env>>,
    userId: string,
    days: number,
  ): Promise<string> => {
    const session = await createSession(c.var.bindings().db, userId, {
      days,
      userAgent: c.req.header('user-agent') ?? null,
    })
    const url = new URL(c.req.url)
    return serialiseCookie(url, cookieName(url), session.token, {
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
    })
  }

  app.get('/login', async (c) => {
    providers()
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
    const list = providers()
    const provider = list.find((p) => !p.redirect && typeof p.send === 'function')
    if (!provider?.send) {
      throw new FolioError('unsupported', 'No email sign-in provider is configured')
    }
    const body = await loginBody(c.req.raw)
    const next = safeNext(body.next, editorUrl)
    const db = c.var.bindings().db

    const user = await userByEmail(db, body.email)
    if (user) {
      const perHour = rt.auth.mode === 'session' ? rt.auth.linksPerHour : 5
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
    providers()
    const next = safeNext(c.req.query('next'), editorUrl)
    const token = c.req.query('t')
    const db = c.var.bindings().db

    const email = token ? await consumeChallenge(db, token) : null
    if (!email) return c.redirect(`${rt.base}/login?error=link&next=${encodeURIComponent(next)}`)

    const user = await userByEmail(db, email)
    // The challenge was valid but the account has gone since it was issued.
    // Refused, not provisioned: a magic link is proof of an address, and access
    // is a list someone maintains.
    if (!user) {
      return c.redirect(`${rt.base}/login?error=refused&next=${encodeURIComponent(next)}`)
    }

    const days = rt.auth.mode === 'session' ? rt.auth.sessionDays : 30
    const cookie = await signIn(c, user.id, days)
    return new Response(null, { status: 302, headers: { location: next, 'set-cookie': cookie } })
  })

  /** Starts a redirect flow. The state, nonce and PKCE verifier ride in a
   * short-lived httpOnly cookie: they must survive a trip to the IdP and be
   * unreadable to anything else, which is exactly a cookie's job. */
  app.get('/login/:provider', async (c) => {
    const provider = providerById(c.req.param('provider'))
    if (!provider.redirect || !provider.start) {
      throw new FolioError('not_found', 'That provider is not a redirect flow')
    }
    const url = new URL(c.req.url)
    const next = safeNext(c.req.query('next'), editorUrl)
    const redirectUri = `${url.origin}${rt.base}/login/${provider.id}/callback`

    let started: { url: string; state: OidcState }
    try {
      started = await provider.start(c.env, { redirectUri, next })
    } catch (err) {
      console.error(`folio: ${provider.id} sign-in could not start`, err)
      return c.redirect(`${rt.base}/login?error=provider&next=${encodeURIComponent(next)}`)
    }

    return new Response(null, {
      status: 302,
      headers: {
        location: started.url,
        'set-cookie': serialiseCookie(url, oidcCookieName(url), encodeState(started.state), {
          maxAge: OIDC_STATE_TTL_S,
        }),
      },
    })
  })

  app.get('/login/:provider/callback', async (c) => {
    const provider = providerById(c.req.param('provider'))
    if (!provider.callback) throw new FolioError('not_found', 'That provider has no callback')
    const url = new URL(c.req.url)
    const state = decodeState(readOidcCookie(c.req.header('cookie')))
    const next = safeNext(state?.next, editorUrl)
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
    if (!state) return bail('provider')

    let identity: { email: string; name?: string }
    try {
      identity = await provider.callback(c.env, {
        url,
        redirectUri: `${url.origin}${rt.base}/login/${provider.id}/callback`,
        state,
      })
    } catch (err) {
      console.error(`folio: ${provider.id} sign-in failed`, err)
      return bail('provider')
    }

    const db = c.var.bindings().db
    let user = await userByEmail(db, identity.email)
    if (!user) {
      const provision = provider.provision ?? 'refuse'
      if (provision === 'refuse') return bail('refused')
      user = await createUser(db, {
        email: identity.email,
        name: identity.name,
        role: provision.role ?? 'editor',
        provider: provider.id,
      })
    }

    const days = rt.auth.mode === 'session' ? rt.auth.sessionDays : 30
    const cookie = await signIn(c, user.id, days)
    return new Response(null, {
      status: 302,
      headers: [
        ['location', next],
        ['set-cookie', cookie],
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
    return c.json({ mode: rt.auth.mode, actor: safe, loginUrl: `${rt.base}/login` })
  })

  return app
}

/* ------------------------------------------------------------------ state --- */

/**
 * The OIDC state cookie's payload. Base64url over UTF-8 rather than raw JSON: a
 * cookie value may not contain `;` or a comma, and JSON is full of characters
 * that survive some proxies and not others.
 */
function encodeState(state: OidcState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Total over its input: the cookie is attacker-supplied like any other, and an
 * unreadable one means "no state", which the callback already refuses. */
function decodeState(value: string | null): OidcState | null {
  if (!value) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OidcState>
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.verifier !== 'string'
    ) {
      return null
    }
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      verifier: parsed.verifier,
      next: typeof parsed.next === 'string' ? parsed.next : '',
    }
  } catch {
    return null
  }
}

/** Re-exported so the login routes and the OIDC provider agree on the leeway
 * every expiry comparison in this feature uses. */
export { CLOCK_LEEWAY_MS }
