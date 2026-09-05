import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { AuthConfig, MagicLinkMail, Role, RoleMapper } from '../../src/server'
import { createFolio, magicLink, oidc, roleFromClaim } from '../../src/server'
import { CHALLENGE_TTL_MS, createChallenge } from '../../src/server/auth/challenges'
import { PLAIN_COOKIE, SECURE_COOKIE } from '../../src/server/auth/cookie'
import { resetDiscoveryCache, verifyIdToken } from '../../src/server/auth/oidc'
import type { UserActor } from '../../src/server/auth/roles'
import { createSession, readSession } from '../../src/server/auth/session'
import { createUser, userByEmail } from '../../src/server/auth/users'

/**
 * Signing in: the magic-link flow, the OIDC flow, and the properties both are
 * supposed to have — single use, short lived, non-enumerable, and unable to be
 * talked into a redirect off-site.
 *
 * Each test builds its own `createFolio` and calls `handle()` rather than going
 * through `SELF`: the thing under test is a *config* boundary (which providers
 * are declared, and what their callbacks do), and the shared `worker.ts` fixture
 * cannot carry one — see the note in test/workers/http.test.ts about the pool's
 * RPC boundary.
 */

const ORIGIN = 'https://folio.test'
const BASE = `${ORIGIN}/folio`

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title', required: true }) },
  render: () => null,
})

const bindings = (e: Cloudflare.Env) => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function folioWith(auth: AuthConfig<Cloudflare.Env> | 'open') {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings,
    basePath: '/folio',
    auth,
  })
}

type Folio = ReturnType<typeof folioWith>

function call(folio: Folio, path: string, init?: RequestInit): Promise<Response> {
  return folio.handle(
    new Request(`${ORIGIN}${path}`, init),
    env,
    createExecutionContext(),
  ) as Promise<Response>
}

/** The `Set-Cookie` values a response carries, in order. */
function setCookies(res: Response): string[] {
  const all = res.headers.getSetCookie?.()
  if (all && all.length > 0) return all
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

/** One cookie's value out of a response, by name. */
function cookieFrom(res: Response, name: string): string | null {
  for (const raw of setCookies(res)) {
    const [pair] = raw.split(';')
    const eq = pair?.indexOf('=') ?? -1
    if (eq === -1 || !pair) continue
    if (pair.slice(0, eq) !== name) continue
    return pair.slice(eq + 1) || null
  }
  return null
}

/** The captured sign-in mail, since the host's `send` is what receives it. */
let outbox: MagicLinkMail[] = []

const capturingMagicLink = magicLink<Cloudflare.Env>({
  send: (_env, mail) => {
    outbox.push(mail)
  },
})

const magicAuth: AuthConfig<Cloudflare.Env> = { providers: [capturingMagicLink] }

beforeEach(async () => {
  outbox = []
  resetDiscoveryCache()
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from login_challenges'),
    env.DB.prepare('delete from auth_events'),
    env.DB.prepare('delete from users'),
  ])
})

const seedEditor = (role: 'viewer' | 'editor' | 'publisher' | 'admin' = 'editor') =>
  createUser(env.DB, { email: 'ann@example.com', name: 'Ann', role })

/* --------------------------------------------------------- the login page --- */

describe('GET /folio/login', () => {
  it('renders a form with no client bundle at all', async () => {
    const res = await call(folioWith(magicAuth), '/folio/login')
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('action="/folio/login/email"')
    expect(html).toContain('name="email"')
    // Architecture decision 7: a login page that needs a bundle to work is a
    // worse failure than an ugly one. No module script, no bootstrap global.
    expect(html).not.toContain('<script')
    expect(html).toContain('Email me a sign-in link')
  })

  it('renders one button per redirect provider and the form for the mail one', async () => {
    const res = await call(
      folioWith({
        providers: [
          capturingMagicLink,
          oidc<Cloudflare.Env>({
            issuer: 'https://idp.test',
            clientId: 'cid',
            clientSecret: 'secret',
            label: 'Sign in with Work',
          }),
        ],
      }),
      '/folio/login',
    )
    const html = await res.text()
    expect(html).toContain('href="/folio/login/oidc?next=%2Ffolio%2Fedit"')
    expect(html).toContain('Sign in with Work')
    expect(html).toContain('name="email"')
  })

  it("404s under auth: 'open', where there is nothing to sign in to", async () => {
    const res = await call(folioWith('open'), '/folio/login')
    expect(res.status).toBe(404)
  })

  it('refuses to carry an off-site `next` through the form', async () => {
    const res = await call(folioWith(magicAuth), '/folio/login?next=%2F%2Fevil.example%2Fsteal')
    const html = await res.text()
    // `//evil.example` is a protocol-relative URL: the case a bare
    // startsWith('/') check waves through, and an open redirect out of a login
    // page is the most useful kind there is.
    expect(html).not.toContain('evil.example')
    expect(html).toContain('value="/folio/edit"')
  })
})

/* ------------------------------------------------------------ magic links --- */

async function requestLink(folio: Folio, email: string): Promise<Response> {
  return call(folio, '/folio/login/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email }),
  })
}

describe('POST /folio/login/email', () => {
  it('mails a link to a known address', async () => {
    await seedEditor()
    const res = await requestLink(folioWith(magicAuth), 'ann@example.com')

    expect(res.status).toBe(200)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.email).toBe('ann@example.com')
    expect(outbox[0]?.url).toContain('/folio/login/verify?t=')
    // 15 minutes, and the host is told when so it can say so in the mail.
    expect(outbox[0]?.expiresAt).toBeGreaterThan(Date.now())
    expect(outbox[0]?.expiresAt).toBeLessThanOrEqual(Date.now() + CHALLENGE_TTL_MS)
  })

  it('answers an unknown address byte-identically and sends nothing', async () => {
    await seedEditor()
    const known = await requestLink(folioWith(magicAuth), 'ann@example.com')
    const unknown = await requestLink(folioWith(magicAuth), 'nobody@example.com')

    expect(unknown.status).toBe(known.status)
    // Byte-identical: a different message, or even a different status, turns
    // this route into an oracle for who has access to the CMS.
    expect(await unknown.text()).toBe(await known.text())
    expect(outbox).toHaveLength(1)
    // And nothing was written for the unknown address either — a row count is
    // just as much of a leak to anyone who can read the database.
    const rows = await env.DB.prepare('select email from login_challenges').all<{ email: string }>()
    expect(rows.results.map((r) => r.email)).toEqual(['ann@example.com'])
  })

  it('stops mailing past the per-address hourly limit, with the same answer', async () => {
    await seedEditor()
    const folio = folioWith({ providers: [capturingMagicLink], linksPerHour: 2 })

    const first = await requestLink(folio, 'ann@example.com')
    await requestLink(folio, 'ann@example.com')
    const third = await requestLink(folio, 'ann@example.com')

    expect(outbox).toHaveLength(2)
    // The limit bounds how much mail one address can be made to receive; it
    // must not become a way to find out that the limit was hit.
    expect(await third.text()).toBe(await first.text())
  })

  it('re-renders the login page for a form post, since the page ships no JS', async () => {
    await seedEditor()
    const res = await call(folioWith(magicAuth), '/folio/login/email', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ email: 'ann@example.com' }).toString(),
    })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('a sign-in link is on its way')
    expect(outbox).toHaveLength(1)
  })

  it('refuses a body that is not an email address', async () => {
    const res = await requestLink(folioWith(magicAuth), 'not-an-address')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } })
  })
})

describe('GET /folio/login/verify', () => {
  const tokenOf = (mail: MagicLinkMail) => new URL(mail.url).searchParams.get('t') ?? ''

  it('creates a session, sets the prefixed cookie on https, and redirects', async () => {
    const user = await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    const token = tokenOf(outbox[0]!)

    const res = await call(folio, `/folio/login/verify?t=${token}&next=%2Ffolio%2Fedit`)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit')
    const cookie = cookieFrom(res, SECURE_COOKIE)
    expect(cookie).toMatch(/^[0-9a-f]{64}$/)
    expect(cookieFrom(res, PLAIN_COOKIE)).toBeNull()

    const actor = (await readSession(env.DB, cookie!)) as UserActor
    expect(actor).toMatchObject({ kind: 'user', id: user.id, name: 'Ann', role: 'editor' })
  })

  it('is single use: the second open is refused and creates no session', async () => {
    await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    const token = tokenOf(outbox[0]!)

    await call(folio, `/folio/login/verify?t=${token}`)
    const again = await call(folio, `/folio/login/verify?t=${token}`)

    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toContain('error=link')
    expect(setCookies(again)).toEqual([])
    const rows = await env.DB.prepare('select count(*) as n from sessions').first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('is refused past its expiry, with the same generic message', async () => {
    await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    const token = tokenOf(outbox[0]!)
    // Aged past the window, leeway included.
    await env.DB.prepare('update login_challenges set expires_at = ?')
      .bind(Date.now() - 5 * 60 * 1000)
      .run()

    const res = await call(folio, `/folio/login/verify?t=${token}`)
    expect(res.headers.get('location')).toContain('error=link')
    const rows = await env.DB.prepare('select count(*) as n from sessions').first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('refuses a token nobody minted', async () => {
    await seedEditor()
    const res = await call(folioWith(magicAuth), `/folio/login/verify?t=${'a'.repeat(64)}`)
    expect(res.headers.get('location')).toContain('error=link')
  })

  it('refuses a valid link whose account has been removed since it was issued', async () => {
    const user = await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    await env.DB.prepare('delete from users where id = ?').bind(user.id).run()

    const res = await call(folio, `/folio/login/verify?t=${tokenOf(outbox[0]!)}`)
    // Refused, not provisioned: a magic link proves an address, and access is a
    // list someone maintains.
    expect(res.headers.get('location')).toContain('error=refused')
  })

  it('stamps `users.provider` with the provider that signed them in', async () => {
    // **The bug `completeSignIn` exists to make unrepeatable.** `users.provider`
    // was written by the OIDC callback's inline `createUser` and by nothing
    // else, so every magic-link user read "—" in the Access screen's "Signs in
    // with" column — a visible wrong answer, three files from the omission.
    const user = await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    expect(user.provider).toBeNull()

    await call(folio, `/folio/login/verify?t=${tokenOf(outbox[0]!)}`)

    expect((await userByEmail(env.DB, 'ann@example.com'))?.provider).toBe('magic')
    // And the session records the provider that minted it, which is what logout
    // reads to decide where the browser goes next.
    const row = await env.DB.prepare('select provider from sessions').first<{
      provider: string | null
    }>()
    expect(row?.provider).toBe('magic')
  })

  it('records the sign-in as one auth_events row, in the session’s own batch', async () => {
    const user = await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')
    await call(folio, `/folio/login/verify?t=${tokenOf(outbox[0]!)}`)

    const { results } = await env.DB.prepare(
      'select kind, user_id, actor, provider from auth_events',
    ).all<{ kind: string; user_id: string; actor: string; provider: string }>()
    // A sign-in is the one event whose actor is its own subject.
    expect(results).toEqual([
      { kind: 'sign_in', user_id: user.id, actor: user.id, provider: 'magic' },
    ])
  })

  it('will not be talked into redirecting off-site', async () => {
    await seedEditor()
    const folio = folioWith(magicAuth)
    await requestLink(folio, 'ann@example.com')

    const res = await call(
      folio,
      `/folio/login/verify?t=${tokenOf(outbox[0]!)}&next=https%3A%2F%2Fevil.example`,
    )
    expect(res.headers.get('location')).toBe('/folio/edit')
  })
})

/* --------------------------------------------------------- logout and /me --- */

describe('sessions over HTTP', () => {
  async function signedIn(folio: Folio): Promise<string> {
    await seedEditor()
    await requestLink(folio, 'ann@example.com')
    const token = new URL(outbox[0]!.url).searchParams.get('t') ?? ''
    const res = await call(folio, `/folio/login/verify?t=${token}`)
    return `${SECURE_COOKIE}=${cookieFrom(res, SECURE_COOKIE)}`
  }

  it('GET /folio/api/me names the actor and their role', async () => {
    const folio = folioWith(magicAuth)
    const cookie = await signedIn(folio)

    const res = await call(folio, '/folio/api/me', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      mode: 'session',
      actor: { kind: 'user', name: 'Ann', role: 'editor' },
      loginUrl: '/folio/login',
    })
  })

  it('GET /folio/api/me names the provider that minted this browser’s session', async () => {
    // `session.provider` is `sessions.provider`, not `users.provider`: which
    // door *this* browser came through, which is what
    // `foundation/passkeys.md`'s account screen lists beside each one.
    const folio = folioWith(magicAuth)
    const cookie = await signedIn(folio)

    const res = await call(folio, '/folio/api/me', { headers: { cookie } })
    expect(await res.json()).toMatchObject({ session: { provider: 'magic' } })
  })

  it('GET /folio/api/me carries no session block under auth: open', async () => {
    const res = await call(folioWith('open'), '/folio/api/me')
    expect(await res.json()).not.toHaveProperty('session')
  })

  it('GET /folio/api/me is 401 with no cookie', async () => {
    const res = await call(folioWith(magicAuth), '/folio/api/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it("GET /folio/api/me answers mode 'open' with a null actor when auth is open", async () => {
    const res = await call(folioWith('open'), '/folio/api/me')
    // 200, not 404: the admin has to tell "no auth configured" apart from "not
    // signed in", because only the first is a reason to keep its own generated
    // presence identity.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'open', actor: null })
  })

  it('POST /folio/api/logout revokes the session and clears both cookie names', async () => {
    const folio = folioWith(magicAuth)
    const cookie = await signedIn(folio)
    const token = cookie.split('=')[1]!

    const res = await call(folio, '/folio/api/logout', { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    // A mail provider has no sign-out URL of its own, so `next` is the page that
    // deliberately does not resolve trusted identity. The admin follows it.
    expect(await res.clone().json()).toEqual({ ok: true, next: '/folio/login?signedout=1' })
    expect(await readSession(env.DB, token)).toBeNull()
    const cleared = setCookies(res)
    expect(cleared.some((c) => c.startsWith(`${SECURE_COOKIE}=;`))).toBe(true)
    // Both names, always: a stale plain cookie from a localhost session must not
    // outlive a sign-out.
    expect(cleared.some((c) => c.startsWith(`${PLAIN_COOKIE}=;`))).toBe(true)
  })

  it('POST /folio/api/logout still clears the cookie for an already-dead session', async () => {
    const folio = folioWith(magicAuth)
    const res = await call(folio, '/folio/api/logout', {
      method: 'POST',
      headers: { cookie: `${SECURE_COOKIE}=${'b'.repeat(64)}` },
    })
    expect(res.status).toBe(200)
    expect(setCookies(res).length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------- oidc --- */

const IDP = 'https://idp.test'

interface Keys {
  privateKey: CryptoKey
  jwks: { keys: JsonWebKey[] }
}

let keys: Keys

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function signIdToken(claims: Record<string, unknown>, kid = 'k1'): Promise<string> {
  const header = encodeJson({ alg: 'RS256', kid, typ: 'JWT' })
  const payload = encodeJson(claims)
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  keys = {
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey] },
  }
})

/**
 * A stand-in identity provider: the three documents the flow fetches, and
 * whatever id token the test wants signed. Injected through `oidc`'s `fetchImpl`
 * rather than by stubbing a global, so the provider is exercised exactly as
 * configured and nothing else in the isolate is affected.
 */
function idpFetch(idToken: () => Promise<string> | string, opts: { tokenStatus?: number } = {}) {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer: IDP,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        jwks_uri: `${IDP}/jwks`,
      })
    }
    if (url === `${IDP}/token`) {
      if (opts.tokenStatus) return new Response('no', { status: opts.tokenStatus })
      return Response.json({ id_token: await idToken(), token_type: 'Bearer' })
    }
    if (url === `${IDP}/jwks`) return Response.json(keys.jwks)
    return new Response('not found', { status: 404 })
  }
}

/**
 * The state cookie's payload, which the test needs so it can sign a token with
 * the right nonce — exactly what an attacker cannot do.
 *
 * An **envelope**: `next` is Folio's and `state` is whatever the provider asked
 * to remember, handed back to it unread. It used to be one flat OIDC-shaped
 * object with `next` as a fourth field beside the three the protocol needs.
 */
function decodeStateCookie(res: Response): {
  next: string
  state: { state: string; nonce: string; verifier: string }
} {
  const raw = cookieFrom(res, '__Host-folio_oidc')
  if (!raw) throw new Error('no oidc state cookie was set')
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(new TextDecoder().decode(bytes))
}

function oidcFolio(
  fetchImpl: typeof fetch,
  provision: 'refuse' | { create: true; role?: 'viewer' | 'editor' } = 'refuse',
) {
  return folioWith({
    providers: [
      oidc<Cloudflare.Env>({
        issuer: IDP,
        clientId: 'folio-client',
        clientSecret: (e) => (e ? 'shh' : 'shh'),
        provision,
        fetchImpl,
      }),
    ],
  })
}

const claimsFor = (state: { nonce: string }, over: Record<string, unknown> = {}) => ({
  iss: IDP,
  aud: 'folio-client',
  sub: 'idp-subject',
  nonce: state.nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: 'ann@example.com',
  email_verified: true,
  name: 'Ann Editor',
  ...over,
})

describe('GET /folio/login/oidc', () => {
  it('redirects to the authorization endpoint with PKCE and remembers the state', async () => {
    const folio = oidcFolio(idpFetch(() => ''))
    const res = await call(folio, '/folio/login/oidc?next=%2Ffolio%2Fedit%2Fsty_a')

    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') ?? '')
    expect(target.origin + target.pathname).toBe(`${IDP}/authorize`)
    expect(target.searchParams.get('response_type')).toBe('code')
    expect(target.searchParams.get('client_id')).toBe('folio-client')
    expect(target.searchParams.get('redirect_uri')).toBe(`${BASE}/login/oidc/callback`)
    // PKCE even for a confidential client: it binds the code to this browser,
    // so an intercepted code is useless without the verifier.
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(target.searchParams.get('nonce')).toBeTruthy()

    const envelope = decodeStateCookie(res)
    expect(envelope.state.state).toBe(target.searchParams.get('state'))
    // `next` rides in Folio's half of the envelope, and the provider never sees
    // it: `start` is handed a `redirectUri` and nothing else.
    expect(envelope.next).toBe('/folio/edit/sty_a')
    expect(Object.keys(envelope.state).sort()).toEqual(['nonce', 'state', 'verifier'])
  })

  it('404s for a provider that is not configured', async () => {
    expect((await call(oidcFolio(idpFetch(() => '')), '/folio/login/nope')).status).toBe(404)
  })
})

describe('GET /folio/login/oidc/callback', () => {
  async function start(folio: Folio) {
    const res = await call(folio, '/folio/login/oidc')
    const cookie = `__Host-folio_oidc=${cookieFrom(res, '__Host-folio_oidc')}`
    return { cookie, state: decodeStateCookie(res).state }
  }

  it('signs in a known user and clears the state cookie', async () => {
    const user = await seedEditor('publisher')
    let claims: Record<string, unknown> = {}
    const folio = oidcFolio(idpFetch(() => signIdToken(claims)))
    const { cookie, state } = await start(folio)
    claims = claimsFor(state)

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit')
    const session = cookieFrom(res, SECURE_COOKIE)
    const actor = (await readSession(env.DB, session!)) as UserActor
    expect(actor).toMatchObject({ id: user.id, role: 'publisher' })
    // The one-round-trip state cookie is spent.
    expect(setCookies(res).some((c) => c.startsWith('__Host-folio_oidc=;'))).toBe(true)
  })

  it('refuses a mismatched state before it fetches anything', async () => {
    await seedEditor()
    let fetches = 0
    const counting: typeof fetch = (input, init) => {
      fetches++
      return idpFetch(() => '')(input, init)
    }
    const folio = oidcFolio(counting)
    const { cookie } = await start(folio)
    const before = fetches

    const res = await call(folio, '/folio/login/oidc/callback?code=abc&state=not-the-state', {
      headers: { cookie },
    })

    expect(res.headers.get('location')).toContain('error=provider')
    // Nothing to exchange: a mismatched state is a CSRF attempt or a stale tab.
    expect(fetches).toBe(before)
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
  })

  it('refuses a callback with no state cookie at all', async () => {
    await seedEditor()
    const folio = oidcFolio(idpFetch(() => ''))
    const res = await call(folio, '/folio/login/oidc/callback?code=abc&state=anything')
    expect(res.headers.get('location')).toContain('error=provider')
  })

  it('refuses an id token carrying a different nonce', async () => {
    await seedEditor()
    let claims: Record<string, unknown> = {}
    const folio = oidcFolio(idpFetch(() => signIdToken(claims)))
    const { cookie, state } = await start(folio)
    // Signed by the right key, for the right client, from the right issuer —
    // and replayed from a different sign-in attempt.
    claims = claimsFor(state, { nonce: 'someone-elses-nonce' })

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })
    expect(res.headers.get('location')).toContain('error=provider')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
  })

  it("refuses a verified email that matches no user when provision is 'refuse'", async () => {
    let claims: Record<string, unknown> = {}
    const folio = oidcFolio(idpFetch(() => signIdToken(claims)))
    const { cookie, state } = await start(folio)
    claims = claimsFor(state, { email: 'stranger@example.com' })

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })
    // Access is a list someone maintains, not a consequence of holding an
    // account at the identity provider.
    expect(res.headers.get('location')).toContain('error=refused')
    expect(await userByEmail(env.DB, 'stranger@example.com')).toBeNull()
  })

  it('creates the user on first sign-in when provisioning is switched on', async () => {
    let claims: Record<string, unknown> = {}
    const folio = oidcFolio(
      idpFetch(() => signIdToken(claims)),
      { create: true, role: 'viewer' },
    )
    const { cookie, state } = await start(folio)
    claims = claimsFor(state, { email: 'newstaff@example.com', name: 'New Staff' })

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit')
    const created = await userByEmail(env.DB, 'newstaff@example.com')
    expect(created).toMatchObject({ name: 'New Staff', role: 'viewer', provider: 'oidc' })
  })

  it('refuses an unverified email address', async () => {
    await seedEditor()
    let claims: Record<string, unknown> = {}
    const folio = oidcFolio(idpFetch(() => signIdToken(claims)))
    const { cookie, state } = await start(folio)
    claims = claimsFor(state, { email_verified: false })

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })
    expect(res.headers.get('location')).toContain('error=provider')
  })

  it('reports a failed token exchange as a provider error, not a 500', async () => {
    await seedEditor()
    const folio = oidcFolio(idpFetch(() => '', { tokenStatus: 400 }))
    const { cookie, state } = await start(folio)

    const res = await call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=provider')
  })

  it('passes the provider’s own `error` back as a refusal', async () => {
    await seedEditor()
    const folio = oidcFolio(idpFetch(() => ''))
    const { cookie, state } = await start(folio)

    const res = await call(
      folio,
      `/folio/login/oidc/callback?error=access_denied&state=${state.state}`,
      { headers: { cookie } },
    )
    expect(res.headers.get('location')).toContain('error=provider')
  })
})

/* ------------------------------------------------------ roles from claims --- */

/**
 * A tenant that has delegated roles to its directory
 * (`docs/specs/foundation/auth-providers.md` decision 5).
 *
 * The whole of what makes this feature safe is the **interaction table** — seven
 * rows over (a user row exists) × (the mapper answered nothing, a role, or
 * `null`) — and the two rows the owner put a checkpoint on are the ones with
 * teeth: a changed role revokes every other browser, and a mapper answering
 * `null` for a user *this provider* placed refuses the sign-in outright, because
 * their group was removed and the stored role is now stale privilege.
 */
function oidcWith(
  fetchImpl: typeof fetch,
  over: {
    id?: string
    roleFrom?: RoleMapper
    provision?: 'refuse' | { create: true; role?: Role }
    domains?: readonly string[]
  } = {},
) {
  return oidc<Cloudflare.Env>({
    issuer: IDP,
    clientId: 'folio-client',
    clientSecret: () => 'shh',
    provision: over.provision ?? 'refuse',
    fetchImpl,
    ...(over.id ? { id: over.id } : {}),
    ...(over.roleFrom ? { roleFrom: over.roleFrom } : {}),
    ...(over.domains ? { domains: over.domains } : {}),
  })
}

/** Starts a redirect flow and hands back what the callback needs: the state
 * cookie to send, and the nonce to sign a token with. */
async function startFlow(folio: Folio, id = 'oidc') {
  const res = await call(folio, `/folio/login/${id}`)
  return {
    cookie: `__Host-folio_oidc=${cookieFrom(res, '__Host-folio_oidc')}`,
    state: decodeStateCookie(res).state,
  }
}

const CMS_GROUPS = roleFromClaim({
  claim: 'groups',
  map: { 'cms-admins': 'admin', 'cms-editors': 'editor' },
})

/**
 * Every `auth_events` row, with `detail` parsed.
 *
 * Ordered by `kind`, **not** by `(at, id)`. Every event a sign-in writes is
 * batched with the same `at`, so the id is the only tiebreak — and an id is
 * `evt_<random hex>`, which makes `order by at, id` a coin toss that passes
 * until it does not. What the tests below actually assert is the *set*, and the
 * batch order is pinned where it matters (the revocation before the insert) by
 * the session that survives it rather than by a row order here.
 */
async function events(): Promise<
  { kind: string; user_id: string | null; actor: string | null; detail: unknown }[]
> {
  const { results } = await env.DB.prepare(
    'select kind, user_id, actor, detail from auth_events order by kind',
  ).all<{ kind: string; user_id: string | null; actor: string | null; detail: string | null }>()
  return results.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }))
}

describe('roles come from the directory', () => {
  /**
   * One SSO tenant, and a whole round trip per call.
   *
   * The stand-in IdP signs whatever `claims` currently holds, so the closure is
   * over the variable rather than the value: `start` has to run before the test
   * knows the nonce it must sign.
   */
  function tenant(over: Parameters<typeof oidcWith>[1] = {}) {
    let claims: Record<string, unknown> = {}
    const folio = folioWith({
      providers: [
        oidcWith(
          idpFetch(() => signIdToken(claims)),
          over,
        ),
      ],
    })
    return {
      folio,
      async signIn(overrides: Record<string, unknown>): Promise<Response> {
        const { cookie, state } = await startFlow(folio)
        claims = claimsFor(state, overrides)
        return call(folio, `/folio/login/oidc/callback?code=abc&state=${state.state}`, {
          headers: { cookie },
        })
      },
    }
  }

  it('takes the role from the claim, revokes every other browser, and records who did it', async () => {
    const bob = await createUser(env.DB, { email: 'bob@example.com', role: 'editor' })
    // A browser he already had open somewhere else.
    const stale = await createSession(env.DB, bob.id)
    const { signIn } = tenant({ roleFrom: CMS_GROUPS })

    const res = await signIn({ email: 'bob@example.com', groups: ['cms-admins'] })

    expect(res.status).toBe(302)
    const row = await userByEmail(env.DB, 'bob@example.com')
    expect(row).toMatchObject({ role: 'admin', roleFrom: 'oidc' })
    // The old browser is gone in the same batch that minted the new one — a
    // claim-driven downgrade must not sit in an open socket's attachment for the
    // window an ordinary revocation may.
    expect(await readSession(env.DB, stale.token)).toBeNull()
    // …and the browser that just signed in is not, which is what the statement
    // order inside the batch is for.
    expect(await readSession(env.DB, cookieFrom(res, SECURE_COOKIE)!)).toMatchObject({
      role: 'admin',
    })

    // The event this table was argued for: a role change with nobody clicking.
    expect(await events()).toEqual([
      {
        kind: 'role_changed',
        user_id: bob.id,
        actor: 'provider:oidc',
        detail: { from: 'editor', to: 'admin' },
      },
      { kind: 'sign_in', user_id: bob.id, actor: bob.id, detail: null },
    ])
  })

  it('writes nothing at all when the claim agrees with the stored role', async () => {
    const bob = await createUser(env.DB, {
      email: 'bob@example.com',
      role: 'admin',
      roleFrom: 'oidc',
    })
    const other = await createSession(env.DB, bob.id)
    const { signIn } = tenant({ roleFrom: CMS_GROUPS })

    await signIn({ email: 'bob@example.com', groups: ['cms-admins'] })

    // No update, no revocation, no event: a no-op is not a change, and a
    // `role_changed` row per sign-in would bury the ones that mean something.
    expect(await readSession(env.DB, other.token)).not.toBeNull()
    expect((await events()).map((e) => e.kind)).toEqual(['sign_in'])
  })

  it('refuses a user this provider placed whose groups have gone', async () => {
    // Checkpoint 3. The alternative was falling back to `provision.role`, which
    // would make "in no group" silently mean "editor" on a tenant that delegated
    // roles to its directory precisely so that it would not.
    const bob = await createUser(env.DB, {
      email: 'bob@example.com',
      role: 'admin',
      roleFrom: 'oidc',
    })
    const { signIn } = tenant({ roleFrom: CMS_GROUPS })

    const res = await signIn({ email: 'bob@example.com', groups: [] })

    expect(res.headers.get('location')).toContain('error=refused')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
    expect(
      await env.DB.prepare('select count(*) as n from sessions').first<{ n: number }>(),
    ).toEqual({ n: 0 })
    // The role is left standing: refusing the sign-in is the remedy, and
    // rewriting the row would lose the record of what the directory once said.
    expect((await userByEmail(env.DB, 'bob@example.com'))?.role).toBe('admin')
    expect(await events()).toEqual([
      {
        kind: 'sign_in_refused',
        user_id: bob.id,
        actor: bob.id,
        detail: { email: 'bob@example.com', reason: 'role_removed' },
      },
    ])
  })

  it('leaves a Folio-placed role alone when the mapper has no opinion', async () => {
    // Carol was invited by an admin, so `role_from` is null and this provider was
    // never the authority on her role. "No group" is not a demotion.
    await createUser(env.DB, { email: 'carol@example.com', role: 'publisher' })
    const { signIn } = tenant({ roleFrom: CMS_GROUPS })

    const res = await signIn({ email: 'carol@example.com', groups: [] })

    expect(res.status).toBe(302)
    expect(await userByEmail(env.DB, 'carol@example.com')).toMatchObject({
      role: 'publisher',
      roleFrom: null,
    })
  })

  it('provisions at the mapped role, stamping the provider as its author', async () => {
    const { signIn } = tenant({ roleFrom: CMS_GROUPS, provision: { create: true, role: 'viewer' } })

    await signIn({ email: 'new@example.com', groups: ['cms-editors'] })

    // The claim wins over `provision.role`: the mapper is a statement about this
    // person, and `provision.role` is the default for somebody it says nothing
    // about.
    expect(await userByEmail(env.DB, 'new@example.com')).toMatchObject({
      role: 'editor',
      roleFrom: 'oidc',
    })
  })

  it('refuses to invent a role for an unmapped stranger', async () => {
    // A provider that maps roles and a `provision` with no role named: creating
    // them at the implicit `editor` default would be the same silent promotion
    // checkpoint 3 refuses one row up.
    const { signIn } = tenant({ roleFrom: CMS_GROUPS, provision: { create: true } })

    const res = await signIn({ email: 'new@example.com', groups: ['nothing-mapped'] })

    expect(res.headers.get('location')).toContain('error=refused')
    expect(await userByEmail(env.DB, 'new@example.com')).toBeNull()
    expect(await events()).toEqual([
      {
        kind: 'sign_in_refused',
        user_id: null,
        actor: null,
        detail: { email: 'new@example.com', reason: 'not_invited' },
      },
    ])
  })

  it('creates an unmapped stranger at the role the host named, owned by Folio', async () => {
    const { signIn } = tenant({ roleFrom: CMS_GROUPS, provision: { create: true, role: 'viewer' } })

    await signIn({ email: 'new@example.com', groups: ['nothing-mapped'] })

    // `role_from` stays null: the host decided this, not the directory, so an
    // admin may edit it and the next sign-in will not take it back.
    expect(await userByEmail(env.DB, 'new@example.com')).toMatchObject({
      role: 'viewer',
      roleFrom: null,
    })
  })

  it('treats a mapper answering a non-role as a configuration bug, not a default', async () => {
    await createUser(env.DB, { email: 'bob@example.com', role: 'editor' })
    const { signIn } = tenant({ roleFrom: () => 'owner' as Role })

    const res = await signIn({ email: 'bob@example.com' })

    expect(res.headers.get('location')).toContain('error=provider')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
    expect((await userByEmail(env.DB, 'bob@example.com'))?.role).toBe('editor')
  })

  it('treats a mapper that throws the same way', async () => {
    await createUser(env.DB, { email: 'bob@example.com', role: 'editor' })
    const { signIn } = tenant({
      roleFrom: () => {
        throw new Error('the directory API is down')
      },
    })

    const res = await signIn({ email: 'bob@example.com' })

    expect(res.headers.get('location')).toContain('error=provider')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
  })

  it('hands the whole id token to the mapper, not only the two fields a user row needs', async () => {
    await createUser(env.DB, { email: 'bob@example.com', role: 'editor' })
    const seen: unknown[] = []
    const { signIn } = tenant({
      roleFrom: (identity) => {
        seen.push(identity.claims)
        return null
      },
    })

    await signIn({ email: 'bob@example.com', groups: ['cms-admins'], sub: 'idp-subject' })

    expect(seen[0]).toMatchObject({ groups: ['cms-admins'], sub: 'idp-subject', iss: IDP })
  })
})

/* ---------------------------------------------------- one domain, one door --- */

describe('an enforced domain is exactly one door', () => {
  /** Magic link plus an SSO tenant that owns `client.com`. */
  function agency(fetchImpl: typeof fetch = idpFetch(() => '')) {
    return folioWith({
      providers: [capturingMagicLink, oidcWith(fetchImpl, { id: 'okta', domains: ['client.com'] })],
    })
  }

  it('sends an enforced address to its provider before any D1 read, known or not', async () => {
    await createUser(env.DB, { email: 'ann@client.com', role: 'editor' })
    const folio = agency()

    for (const email of ['ann@client.com', 'nobody@client.com']) {
      const res = await requestLink(folio, email)
      expect(res.status).toBe(302)
      // Identical for both, which is what keeps it non-enumerating *with respect
      // to accounts* — the property `SENT` protects. What it does disclose is a
      // configuration fact about the domain, which the SSO button on the same
      // page already discloses.
      expect(res.headers.get('location')).toBe('/folio/login/okta?next=%2Ffolio%2Fedit')
    }

    expect(outbox).toHaveLength(0)
    // No challenge, and no read that could have told the two addresses apart.
    const rows = await env.DB.prepare('select email from login_challenges').all()
    expect(rows.results).toEqual([])
  })

  it('answers a form post and a JSON caller the same way', async () => {
    // A script follows redirects and the admin never posts here, so there is no
    // caller for whom a 200-with-a-message would be better than the 302.
    const folio = agency()
    const form = await call(folio, '/folio/login/email', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: 'email=ann%40client.com',
    })
    expect(form.status).toBe(302)
    expect(form.headers.get('location')).toBe('/folio/login/okta?next=%2Ffolio%2Fedit')
  })

  it('leaves every other address on the byte-identical answer', async () => {
    await createUser(env.DB, { email: 'dan@agency.example', role: 'editor' })
    const folio = agency()

    const known = await requestLink(folio, 'dan@agency.example')
    const unknown = await requestLink(folio, 'nobody@agency.example')

    expect(known.status).toBe(200)
    expect(await unknown.text()).toBe(await known.text())
    expect(outbox.map((m) => m.email)).toEqual(['dan@agency.example'])
  })

  it('refuses a link that was somehow minted for an enforced address', async () => {
    // Unreachable through the route above, which is exactly why it is written:
    // `completeSignIn` re-checks the map for every kind, so a challenge that
    // predates the configuration cannot become a session.
    await createUser(env.DB, { email: 'ann@client.com', role: 'editor' })
    const challenge = await createChallenge(env.DB, 'ann@client.com')

    const res = await call(agency(), `/folio/login/verify?t=${challenge.token}`)

    expect(res.headers.get('location')).toContain('error=refused')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
    expect(await env.DB.prepare('select count(*) as n from sessions').first()).toEqual({ n: 0 })
    expect(await events()).toEqual([
      {
        kind: 'sign_in_refused',
        // No `user_id`: enforcement happens before the row is read, because the
        // answer does not depend on there being one.
        user_id: null,
        actor: null,
        detail: { email: 'ann@client.com', reason: 'domain' },
      },
    ])
  })

  it('refuses a second SSO tenant for a domain another one owns', async () => {
    // Two `oidc({ id })` providers side by side, which is the other half of what
    // the configurable id bought: a staff directory and a client's, at once.
    await createUser(env.DB, { email: 'ann@client.com', role: 'editor' })
    let claims: Record<string, unknown> = {}
    const fetchImpl = idpFetch(() => signIdToken(claims))
    const folio = folioWith({
      providers: [
        oidcWith(fetchImpl, { id: 'okta', domains: ['client.com'] }),
        oidcWith(fetchImpl, { id: 'entra' }),
      ],
    })

    const { cookie, state } = await startFlow(folio, 'entra')
    claims = claimsFor(state, { email: 'ann@client.com' })
    const res = await call(folio, `/folio/login/entra/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })

    expect(res.headers.get('location')).toContain('error=refused')
    expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
    // The point of the rule: the client's directory controls revocation, and a
    // second door around it is not a door the deployment agreed to.
    expect((await events())[0]).toMatchObject({
      kind: 'sign_in_refused',
      detail: { reason: 'domain' },
    })
  })

  it('lets the domain’s own provider through', async () => {
    await createUser(env.DB, { email: 'ann@client.com', role: 'editor' })
    let claims: Record<string, unknown> = {}
    const fetchImpl = idpFetch(() => signIdToken(claims))
    const folio = folioWith({
      providers: [capturingMagicLink, oidcWith(fetchImpl, { id: 'okta', domains: ['client.com'] })],
    })

    const { cookie, state } = await startFlow(folio, 'okta')
    claims = claimsFor(state, { email: 'ann@client.com' })
    const res = await call(folio, `/folio/login/okta/callback?code=abc&state=${state.state}`, {
      headers: { cookie },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit')
    expect((await userByEmail(env.DB, 'ann@client.com'))?.provider).toBe('okta')
  })
})

describe('GET /folio/login for a browser that is already signed in', () => {
  it('redirects to next rather than rendering a form that would sign them in again', async () => {
    const user = await seedEditor()
    const session = await createSession(env.DB, user.id)

    const res = await call(folioWith(magicAuth), '/folio/login?next=%2Ffolio%2Fedit%2Fsty_a', {
      headers: { cookie: `${SECURE_COOKIE}=${session.token}` },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit/sty_a')
  })
})

describe('verifyIdToken', () => {
  const expected = () => ({
    issuer: IDP,
    clientId: 'folio-client',
    nonce: 'the-nonce',
    jwks: keys.jwks,
  })
  const good = () => ({
    iss: IDP,
    aud: 'folio-client',
    nonce: 'the-nonce',
    exp: Math.floor(Date.now() / 1000) + 300,
    email: 'ann@example.com',
  })

  it('accepts a well-formed token and returns its claims', async () => {
    const claims = await verifyIdToken(await signIdToken(good()), expected())
    expect(claims.email).toBe('ann@example.com')
  })

  it('refuses a different issuer, even with everything else right', async () => {
    // The issuer is the check, not the email domain: a personal account signing
    // into a tenant-scoped app has a perfectly valid verified email.
    await expect(
      verifyIdToken(await signIdToken({ ...good(), iss: 'https://elsewhere.test' }), expected()),
    ).rejects.toThrow(/different issuer/)
  })

  it('refuses a token minted for another client', async () => {
    await expect(
      verifyIdToken(await signIdToken({ ...good(), aud: 'someone-else' }), expected()),
    ).rejects.toThrow(/different client/)
  })

  it('accepts an audience array that contains the client id', async () => {
    const claims = await verifyIdToken(
      await signIdToken({ ...good(), aud: ['other', 'folio-client'] }),
      expected(),
    )
    expect(claims.email).toBe('ann@example.com')
  })

  it('refuses an expired token, leeway included', async () => {
    await expect(
      verifyIdToken(
        await signIdToken({ ...good(), exp: Math.floor(Date.now() / 1000) - 120 }),
        expected(),
      ),
    ).rejects.toThrow(/expired/)
  })

  it('refuses a token whose signature does not verify', async () => {
    const token = await signIdToken(good())
    const tampered = `${token.slice(0, -6)}AAAAAA`
    await expect(verifyIdToken(tampered, expected())).rejects.toThrow(/signature|key/)
  })

  it('refuses a token naming a kid the JWKS does not hold', async () => {
    await expect(verifyIdToken(await signIdToken(good(), 'rotated'), expected())).rejects.toThrow(
      /does not have/,
    )
  })

  it("refuses alg 'none' and every symmetric alg outright", async () => {
    const header = encodeJson({ alg: 'none', typ: 'JWT' })
    const payload = encodeJson(good())
    await expect(verifyIdToken(`${header}.${payload}.`, expected())).rejects.toThrow(
      /unsupported id token algorithm/,
    )
    const hs = encodeJson({ alg: 'HS256', typ: 'JWT' })
    await expect(verifyIdToken(`${hs}.${payload}.AAAA`, expected())).rejects.toThrow(
      /unsupported id token algorithm/,
    )
  })

  it('refuses something that is not a JWS at all', async () => {
    await expect(verifyIdToken('nonsense', expected())).rejects.toThrow(/not a JWS/)
  })
})
