import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { AuthConfig, MagicLinkMail } from '../../src/server'
import { createFolio, magicLink, oidc } from '../../src/server'
import { CHALLENGE_TTL_MS } from '../../src/server/auth/challenges'
import { PLAIN_COOKIE, SECURE_COOKIE } from '../../src/server/auth/cookie'
import { resetDiscoveryCache, verifyIdToken } from '../../src/server/auth/oidc'
import type { UserActor } from '../../src/server/auth/roles'
import { readSession } from '../../src/server/auth/session'
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

  it('GET /folio/me names the actor and their role', async () => {
    const folio = folioWith(magicAuth)
    const cookie = await signedIn(folio)

    const res = await call(folio, '/folio/me', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      mode: 'session',
      actor: { kind: 'user', name: 'Ann', role: 'editor' },
      loginUrl: '/folio/login',
    })
  })

  it('GET /folio/me is 401 with no cookie', async () => {
    const res = await call(folioWith(magicAuth), '/folio/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it("GET /folio/me answers mode 'open' with a null actor when auth is open", async () => {
    const res = await call(folioWith('open'), '/folio/me')
    // 200, not 404: the admin has to tell "no auth configured" apart from "not
    // signed in", because only the first is a reason to keep its own generated
    // presence identity.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'open', actor: null })
  })

  it('POST /folio/logout revokes the session and clears both cookie names', async () => {
    const folio = folioWith(magicAuth)
    const cookie = await signedIn(folio)
    const token = cookie.split('=')[1]!

    const res = await call(folio, '/folio/logout', { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await readSession(env.DB, token)).toBeNull()
    const cleared = setCookies(res)
    expect(cleared.some((c) => c.startsWith(`${SECURE_COOKIE}=;`))).toBe(true)
    // Both names, always: a stale plain cookie from a localhost session must not
    // outlive a sign-out.
    expect(cleared.some((c) => c.startsWith(`${PLAIN_COOKIE}=;`))).toBe(true)
  })

  it('POST /folio/logout still clears the cookie for an already-dead session', async () => {
    const folio = folioWith(magicAuth)
    const res = await call(folio, '/folio/logout', {
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

/** The state cookie's payload, which the test needs so it can sign a token with
 * the right nonce — exactly what an attacker cannot do. */
function decodeStateCookie(res: Response): { state: string; nonce: string; next: string } {
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

    const state = decodeStateCookie(res)
    expect(state.state).toBe(target.searchParams.get('state'))
    expect(state.next).toBe('/folio/edit/sty_a')
  })

  it('404s for a provider that is not configured', async () => {
    expect((await call(oidcFolio(idpFetch(() => '')), '/folio/login/nope')).status).toBe(404)
  })
})

describe('GET /folio/login/oidc/callback', () => {
  async function start(folio: Folio) {
    const res = await call(folio, '/folio/login/oidc')
    const cookie = `__Host-folio_oidc=${cookieFrom(res, '__Host-folio_oidc')}`
    return { cookie, state: decodeStateCookie(res) }
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
