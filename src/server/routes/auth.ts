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
  type TrustedProvider,
  type VerifiedIdentity,
} from '../auth/config'
import {
  challengeBytes,
  clearOidcCookies,
  clearSessionCookies,
  clearWebauthnCookies,
  cookieName,
  decodeChallenge,
  oidcCookieName,
  readOidcCookie,
  readWebauthnCookie,
  serialiseCookie,
} from '../auth/cookie'
import { listEvents, recordEventStatement } from '../auth/events'
import { base64url } from '../auth/jwt'
import { passkeyForAssertion, usePasskeyStatement } from '../auth/passkeys'
import { credentialOf, resolveActor } from '../auth/resolve'
import { READ } from '../auth/roles'
import { revokeSession, sessionProvider } from '../auth/session'
import { completeSignIn, domainOf } from '../auth/sign-in'
import type { NewSession } from '../auth/session'
import { userByEmail, userById } from '../auth/users'
import { requestOptions, verifyAssertion, WebAuthnError } from '../auth/webauthn'
import { FolioError } from '../errors'
import { requireAccess, requireAuthConfigured } from '../middleware'
import { loginPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import {
  LoginEmailBody,
  PasskeyAssertionBody,
  type PasskeyAssertionInput,
  parseBody,
  parseOrThrow,
  safeNext,
  wantsJson,
} from '../validate'
import { mintChallenge, passkeyEnrolmentRefusal, passkeyRefusalBody, rpIdOf } from './passkeys'

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

/**
 * The fixed error vocabulary of the login page, as prose.
 *
 * A closed set, and the reason is the same one `SENT` records: the parameter
 * *selects* a message rather than carrying one, so nothing a stranger puts in
 * the query string can be rendered, and nothing a refusal knows — which account,
 * which domain, which claim — reaches the page. `?error=` gains no new values
 * for trusted identity: a refused identity is `refused`, a resolver that threw
 * is `provider`.
 */
function loginNotice(code: string | null | undefined): string | null {
  switch (code) {
    case 'link':
      return 'That sign-in link has already been used or has expired. Ask for a new one.'
    case 'refused':
      return 'That account does not have access to this site.'
    case 'provider':
      return 'Signing in with that provider did not work. Try again.'
    default:
      return null
  }
}

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

  /**
   * Signs a trusted identity in, on whichever route asked.
   *
   * Each `trusted` provider is consulted in declaration order until one answers
   * an identity, and **the first identity is terminal whatever happens to it**.
   * A host moving from one proxy to another may list two, and "the second one
   * might like this person better" is not a rule anybody could reason about. A
   * throw is terminal for the same reason and a stronger one: it means a
   * credential arrived and did not verify, which is a fact to show rather than a
   * reason to keep asking around.
   *
   * Answers a signed-in `Response`, a refusal word, or `null` for "nobody here".
   */
  const signInTrusted = async (
    c: Context<FolioEnv<Env>>,
    auth: Extract<ResolvedAuth<unknown>, { mode: 'session' }>,
    providers: readonly TrustedProvider<unknown>[],
    next: string,
  ): Promise<Response | 'refused' | 'provider' | null> => {
    for (const provider of providers) {
      let identity: VerifiedIdentity | null
      try {
        identity = await provider.resolve(c.env, c.req.raw)
      } catch (err) {
        // Logged and shown, never swallowed: a gate that has stopped verifying
        // looks exactly like a gate nobody is standing at.
        console.error(`folio: ${provider.id} could not resolve an identity`, err)
        return 'provider'
      }
      if (!identity) continue
      const result = await completeSignIn(c.var.bindings().db, auth, provider, identity, {
        userAgent: c.req.header('user-agent') ?? null,
      })
      if (!result.ok) return result.reason
      return new Response(null, {
        status: 302,
        headers: { location: next, 'set-cookie': signInCookie(c, result.session) },
      })
    }
    return null
  }

  /**
   * The login page — and, for a deployment with a `trusted` provider, the whole
   * of signing in (`../../../docs/specs/foundation/auth-providers.md`
   * decision 4).
   *
   * Three branches, in order, and the order is the design:
   *
   *   1. **A credential that resolves answers `302 next`.** It used to render
   *      the form to a signed-in person, which was merely pointless; with
   *      implicit resolution it would be a form that signs you in again.
   *   2. **Implicit resolution**, unless the query carries `error`, `sent` or
   *      `signedout`. Each of those three marks a page that is here to be
   *      *read* — a refusal to explain, a "check your mail", a sign-out — and
   *      resolving on one of them either loops (a refusal redirecting here
   *      would resolve, refuse and redirect again, forever) or undoes the thing
   *      the page is announcing.
   *   3. **The page**, carrying whatever notice the attempt produced. A failure
   *      renders **in place** and never redirects to `/login`, for the same
   *      loop reason.
   */
  app.get('/login', async (c) => {
    const auth = sessionAuth()
    const next = safeNext(c.req.query('next'), editorUrl)
    // `?error=` is set by the redirects below rather than by anything a stranger
    // can craft into a message: the parameter selects one of a fixed set.
    const error = c.req.query('error')
    const sent = c.req.query('sent') !== undefined
    const signedOut = c.req.query('signedout') !== undefined

    // Costs nothing for an anonymous browser: `resolveActor` reads no D1 for a
    // request carrying neither cookie nor bearer.
    const actor = await resolveActor(() => c.var.bindings().db, rt.auth, credentialOf(c.req.raw))
    if (actor) return c.redirect(next)

    let refused: 'refused' | 'provider' | null = null
    if (error === undefined && !sent && !signedOut && auth.trusted.length > 0) {
      const outcome = await signInTrusted(c, auth, auth.trusted, next)
      if (outcome instanceof Response) return outcome
      refused = outcome
    }

    return loginPage(rt, {
      next,
      sent: sent ? SENT : null,
      error: loginNotice(error ?? refused),
      signedOut,
    })
  })

  /**
   * Requests a sign-in link. **Always** answers the same thing.
   *
   * Note what is *not* awaited differently between the branches: an unknown
   * address does exactly the same amount of work minus the send, and the answer
   * is assembled before either branch runs.
   *
   * The one exception is an **enforced domain**, and it is not an exception to
   * the rule `SENT` protects (checkpoint 1). `SENT` is non-enumerating *with
   * respect to accounts*; the `302` below is identical for every address at that
   * domain whether or not a user row exists, so it discloses a configuration
   * fact about the domain and nothing about anybody's account — and the SSO
   * button on the same page already discloses that fact. What the alternative
   * bought was a legitimate user waiting for a mail nobody was going to send.
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

    // **Before any D1 read**, so there is no timing difference and no challenge
    // row to be consumed later — `completeSignIn` would refuse the link anyway,
    // but a mail per refusal is a round trip to say what this form could say.
    // A `mail` provider cannot itself claim a domain (`resolveAuth` refuses it),
    // so the comparison is defensive rather than reachable.
    const enforced = auth.domains.get(domainOf(body.email))
    if (enforced !== undefined && enforced !== provider.id) {
      // The same answer for a JSON caller: a script follows redirects, and the
      // admin never posts to this route.
      return c.redirect(`${rt.base}/login/${enforced}?next=${encodeURIComponent(next)}`)
    }

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
   * The request options and a `k: 'get'` challenge cookie.
   *
   * **Unauthenticated, and called on every login-page load** — conditional UI
   * arms itself from this before anybody has typed anything (decision 4) — which
   * is the whole reason the challenge is a cookie and not a row (decision 2): a
   * table would be an anonymous D1 write per page view. This handler touches no
   * binding at all.
   *
   * `allowCredentials` is empty and stays empty. The route does not know whose
   * passkeys to list, and listing them would be an enumeration oracle; a
   * discoverable credential needs no list.
   *
   * Registered before `/login/:provider` for the reason `/login/verify` is,
   * although here it is belt and braces: these two are POSTs and that one is a
   * GET, so nothing could swallow them today. The next person to add
   * `POST /login/:provider` would find out the hard way.
   */
  app.post('/login/passkey/options', (c) => {
    const auth = sessionAuth()
    if (!auth.passkey) throw new FolioError('not_found', 'Passkeys are not configured')
    const url = new URL(c.req.url)
    const minted = mintChallenge(url, 'get')
    return new Response(
      JSON.stringify({
        publicKey: requestOptions({ rpId: rpIdOf(url), challenge: minted.challenge }),
      }),
      {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['set-cookie', minted.cookie],
        ],
      },
    )
  })

  /**
   * Signs in with a passkey. **Every failure answers the byte-identical 401.**
   *
   * That is `SENT`'s discipline one route along: an attacker holding a
   * credential id must learn nothing about whether it exists, whose it is, or
   * why it was refused — an unknown id, a wrong challenge, a foreign origin, a
   * foreign `rpIdHash`, a clear UV flag, a counter regression, a deleted user,
   * an enforced domain and a missing cookie all read the same. The one asymmetry
   * is invisible to the caller and visible to the host: a counter regression
   * means two authenticators hold one private key, so it alone writes a
   * `passkey_rejected` row.
   *
   * The cookie is the gate, and it runs **before any D1 read**. A cross-site
   * POST carries no `SameSite=Lax` cookie and a scanner carries none either, so
   * neither costs a query — and the challenge cookie is cleared on the way out
   * whatever happened, because a challenge is single-use whether or not it
   * verified.
   */
  app.post('/login/passkey', async (c) => {
    const auth = sessionAuth()
    if (!auth.passkey) throw new FolioError('not_found', 'Passkeys are not configured')
    const provider = auth.passkey
    const url = new URL(c.req.url)

    /** The one answer every refusal gives. Built once per call rather than held
     * as a module constant so the cleared-cookie headers travel with it. */
    const refuse = (): Response =>
      new Response(JSON.stringify(passkeyRefusalBody()), {
        status: 401,
        headers: [
          ['content-type', 'application/json'],
          ...clearWebauthnCookies(url).map((value) => ['set-cookie', value] as [string, string]),
        ],
      })

    const challenge = decodeChallenge(readWebauthnCookie(c.req.header('cookie')))
    // A `create` cookie here is the enrolment ceremony's, and the two are
    // different gates: one proves a device to an account that is already
    // signed in, the other decides who is signing in.
    if (challenge?.k !== 'get') return refuse()

    let body: PasskeyAssertionInput
    try {
      body = await parseBody(c.req, PasskeyAssertionBody)
    } catch {
      // A 400 naming the field that failed would be a difference an attacker
      // could measure. This is the one route where a malformed body is a 401.
      return refuse()
    }

    const db = c.var.bindings().db
    const found = await passkeyForAssertion(db, body.credential.id)
    if (!found) return refuse()

    let asserted: { counter: number; backedUp: boolean }
    try {
      asserted = await verifyAssertion({
        credential: body.credential,
        stored: {
          publicKey: found.passkey.publicKey,
          alg: found.passkey.alg,
          counter: found.passkey.counter,
          userId: found.user.id,
        },
        expected: {
          challenge: base64url(challengeBytes(challenge.c)),
          origin: url.origin,
          rpId: rpIdOf(url),
        },
      })
    } catch (err) {
      if (err instanceof WebAuthnError && err.code === 'counter') {
        // The only refusal anybody can ever see. A clone is the person's to
        // resolve by removing the credential, so this records and refuses
        // rather than deleting the row out from under them.
        await db.batch([
          recordEventStatement(db, {
            kind: 'passkey_rejected',
            userId: found.user.id,
            actor: found.user.id,
            provider: provider.id,
            detail: { passkey: found.passkey.id, reason: 'counter' },
          }),
        ])
      }
      return refuse()
    }

    // The assertion proves the credential; everything after it — the enforced
    // domain, the provider stamp, the audit row — is `completeSignIn`'s, with
    // the passkey's own stamp riding in the same batch rather than a second
    // round trip.
    // biome-ignore lint/correctness/useHookAtTopLevel: `usePasskeyStatement` is a D1 statement builder, not a React hook — `use` is the verb ("use this passkey"), and nothing in this file renders.
    const stamp = usePasskeyStatement(db, found.passkey.id, asserted.counter, asserted.backedUp)
    const result = await completeSignIn(
      db,
      auth,
      provider,
      { email: found.user.email },
      { userAgent: c.req.header('user-agent') ?? null, extra: [stamp] },
    )
    if (!result.ok) return refuse()

    return new Response(JSON.stringify({ ok: true, next: safeNext(body.next, editorUrl) }), {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', signInCookie(c, result.session)],
        ...clearWebauthnCookies(url).map((value) => ['set-cookie', value] as [string, string]),
      ],
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
    const auth = sessionAuth()
    const provider = providerById(c.req.param('provider'))
    const url = new URL(c.req.url)
    const next = safeNext(c.req.query('next'), editorUrl)

    /**
     * The explicit half of trusted identity, and the only other place it
     * resolves: the button on the signed-out page.
     *
     * A failure redirects to `/login?error=…` rather than rendering in place,
     * which is the opposite of what `GET /login` does and is right for the
     * opposite reason: the page it lands on carries `error`, so implicit
     * resolution is skipped there and the loop the in-place rule guards against
     * cannot start. `null` — no identity on this request — is `refused`,
     * because the person clicked a button that turned out to lead nowhere.
     */
    if (provider.kind === 'trusted') {
      const outcome = await signInTrusted(c, auth, [provider], next)
      if (outcome instanceof Response) return outcome
      const reason = outcome ?? 'refused'
      return c.redirect(`${rt.base}/login?error=${reason}&next=${encodeURIComponent(next)}`)
    }

    if (provider.kind !== 'redirect') {
      throw new FolioError('not_found', 'That provider is not a redirect flow')
    }
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
   *
   * **Answers `next`, and the admin follows it**
   * (`../../../docs/specs/foundation/auth-providers.md` decision 4). The session
   * row records which provider minted it, so a redirect or trusted provider with
   * a `signOutUrl` — Cloudflare Access's `/cdn-cgi/access/logout`, an IdP's
   * RP-initiated endpoint — gets the browser sent on to end the *upstream*
   * session too. With no such URL the answer is `{base}/login?signedout=1`, a
   * page that deliberately does not resolve trusted identity: on a deployment
   * whose upstream session Folio cannot end, the very next request still carries
   * the identity, and signing the person back in would make sign-out look broken
   * rather than refused.
   *
   * The provider is read *before* the revocation, because after it there is no
   * row to read it from.
   */
  app.post('/logout', async (c) => {
    const url = new URL(c.req.url)
    const token = credentialOf(c.req.raw).cookie
    let next = `${rt.base}/login?signedout=1`
    if (token && rt.auth.mode === 'session') {
      const db = c.var.bindings().db
      const minted = await sessionProvider(db, token)
      await revokeSession(db, token)
      const provider = minted ? rt.auth.config.providers.find((p) => p.id === minted) : undefined
      if (provider && 'signOutUrl' in provider && provider.signOutUrl) {
        next = provider.signOutUrl
      }
      // After the revoke, not before: the row this describes has just stopped
      // existing. `c.var.actor` is who `withActor` resolved from this same
      // cookie at the top of the request, before the revoke — a token never
      // reaches this branch, since `credentialOf(...).cookie` is empty for one.
      const actor = c.var.actor
      if (actor?.kind === 'user') {
        await db.batch([
          recordEventStatement(db, {
            kind: 'sign_out',
            userId: actor.id,
            actor: actor.id,
            provider: minted,
          }),
        ])
      }
    }
    return new Response(JSON.stringify({ ok: true, next }), {
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
              // The caller's own address, and who decided their role. Both are
              // answered only to the person they describe, and the account screen
              // needs them: an editor should see which address they are signed in
              // as, and `roleFrom` is the reason the role control is not theirs to
              // change (`foundation/passkeys.md` decision 6).
              email: actor.email,
              roleFrom: actor.roleFrom ?? null,
            }
          : { kind: 'token' as const, id: actor.id, name: actor.name, scopes: actor.scopes }
    // Omitted rather than null under `auth: 'open'`, where there are no providers,
    // no session length and no throttle: absence is the honest answer, and a block
    // of zeroes would be a policy the screen would then have to explain away.
    const policy = authPolicy(rt.auth)
    // Which provider minted *this* browser's session, from the join `readSession`
    // already runs. Present only when there is one to name, so the key's absence
    // means "not a session" rather than "a session by an unknown door".
    const session =
      actor?.kind === 'user' && actor.provider ? { session: { provider: actor.provider } } : {}
    /**
     * The passkey block (`../../../docs/specs/foundation/passkeys.md`
     * decision 6). Present only when the deployment listed `passkeys()`, so its
     * absence is the account screen's "this site has no passkeys" and not "you
     * may not".
     *
     * `allowed: false` carries the reason, and the account screen renders it as
     * a sentence *in place of* the Add button — the admin's "absent, not
     * disabled" rule for a permission the person cannot change. One extra read
     * to get there, because `Actor` carries no email and an enforced domain is a
     * fact about the address; it is paid only by a deployment that asked for
     * passkeys, and `/me` is already reading D1 for the session.
     */
    let passkeys: { passkeys?: { allowed: boolean; reason?: string } } = {}
    if (rt.auth.mode === 'session' && rt.auth.passkey) {
      let reason: string | null = null
      if (actor?.kind === 'user') {
        const row = await userById(c.var.bindings().db, actor.id)
        reason = row ? passkeyEnrolmentRefusal(rt.auth, row.email) : null
      }
      passkeys = { passkeys: reason ? { allowed: false, reason } : { allowed: true } }
    }
    return c.json({
      mode: rt.auth.mode,
      actor: safe,
      loginUrl: `${rt.base}/login`,
      ...session,
      ...passkeys,
      ...(policy ? { policy } : {}),
    })
  })

  /**
   * The caller's own last twenty rows of `../../../docs/specs/foundation/
   * auth-providers.md`'s audit table — spec 29's account screen reads this.
   *
   * **A user actor only.** `requireAccess(READ)` passes a read-scoped token
   * straight through — a script may hold `content:read` — so the kind check
   * after it is load-bearing, not defensive: a token's own record of its use is
   * `api_tokens.last_used_at`, not a person's sign-in history, and there is no
   * account for `?user=` to mean here in the first place.
   */
  app.get('/me/events', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, READ), async (c) => {
    const actor = c.var.actor
    if (actor?.kind !== 'user') {
      throw new FolioError('forbidden', 'A token has no sign-in history of its own.')
    }
    const page = await listEvents(c.var.bindings().db, { user: actor.id, limit: 20 })
    return c.json({ events: page.rows })
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
