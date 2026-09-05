import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { AuthConfig, VerifiedIdentity } from '../../src/server'
import { cloudflareAccess, createFolio, magicLink, oidc, trusted } from '../../src/server'
import { resetAccessCertsCache } from '../../src/server/auth/cloudflare-access'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { readSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'

/**
 * Trusted identity: a host that already knows who this is hands Folio the
 * answer, and Folio still owns the role, the session and revocation
 * (`docs/specs/foundation/auth-providers.md` decision 4).
 *
 * Three things here are the whole feature and each is easy to get subtly wrong:
 *
 *   - **Resolution runs on `GET {base}/login` and nowhere else.** Not inside
 *     `resolveActor`, which four callers share and which must read no D1 for an
 *     anonymous request; not on every request as a fallback, which would make a
 *     session cookie optional and leave two authentication models to keep
 *     correct.
 *   - **Three query parameters suppress it** — `error`, `sent`, `signedout` —
 *     because each marks a page that is here to be *read*. Without the guard a
 *     refusal that redirected to `/login` would resolve, refuse and redirect
 *     again forever, and a sign-out would be undone by the request that follows
 *     it.
 *   - **Nothing about a header is trusted without a signature.** The Cloudflare
 *     Access helper verifies the assertion against the team's published keys
 *     before it reads an address out of it, because the header is settable by
 *     anything that reaches the Worker without passing through Access.
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

function setCookies(res: Response): string[] {
  const all = res.headers.getSetCookie?.()
  if (all && all.length > 0) return all
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

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

const sessionRows = () =>
  env.DB.prepare('select id, user_id, provider from sessions')
    .all<{ id: string; user_id: string; provider: string | null }>()
    .then((r) => r.results)

const eventRows = () =>
  env.DB.prepare('select kind, user_id, actor, provider, detail from auth_events order by at')
    .all<{
      kind: string
      user_id: string | null
      actor: string | null
      provider: string | null
      detail: string | null
    }>()
    .then((r) => r.results)

const providerOf = (email: string) =>
  env.DB.prepare('select provider from users where email = ?')
    .bind(email)
    .first<{ provider: string | null }>()
    .then((r) => r?.provider ?? null)

/** A trusted provider that reads a header, with no verification whatsoever —
 * which is what makes it a test double rather than something to copy. */
function headerProvider(
  id: string,
  header: string,
  extra: { signOutUrl?: string; provision?: 'refuse' | { create: true; role?: 'editor' } } = {},
) {
  let calls = 0
  const provider = trusted<Cloudflare.Env>({
    id,
    label: `Continue with ${id}`,
    ...(extra.signOutUrl ? { signOutUrl: extra.signOutUrl } : {}),
    ...(extra.provision ? { provision: extra.provision } : {}),
    resolve: (_env, req) => {
      calls += 1
      const email = req.headers.get(header)
      return email ? { email } : null
    },
  })
  return { provider, calls: () => calls }
}

const capturingMagicLink = magicLink<Cloudflare.Env>({ send: () => {} })

beforeEach(async () => {
  resetAccessCertsCache()
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from login_challenges'),
    env.DB.prepare('delete from auth_events'),
    env.DB.prepare('delete from users'),
  ])
})

const seedAnn = (role: 'viewer' | 'editor' | 'publisher' | 'admin' = 'editor') =>
  createUser(env.DB, { email: 'ann@example.com', name: 'Ann', role })

/* ------------------------------------------------- implicit on GET /login --- */

describe('GET /folio/login resolves a trusted identity', () => {
  it('signs the browser in and redirects to next', async () => {
    const ann = await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity')
    const folio = folioWith({ providers: [capturingMagicLink, provider] })

    const res = await call(folio, '/folio/login?next=%2Ffolio%2Fedit%2Fsty_a', {
      headers: { 'x-identity': 'ann@example.com' },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit/sty_a')
    const token = cookieFrom(res, SECURE_COOKIE)
    expect(token).toBeTruthy()
    // An *ordinary* session from here on: the socket route, the per-minute
    // revocation re-check and `originAllowed` all see exactly what a magic-link
    // session gives them.
    const actor = await readSession(env.DB, token as string)
    expect(actor).toMatchObject({ kind: 'user', id: ann.id, role: 'editor' })
  })

  it('stamps the provider on the session and on the user', async () => {
    await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity')
    await call(folioWith({ providers: [provider, capturingMagicLink] }), '/folio/login', {
      headers: { 'x-identity': 'ann@example.com' },
    })

    expect(await sessionRows()).toMatchObject([{ provider: 'proxy' }])
    expect(await providerOf('ann@example.com')).toBe('proxy')
  })

  it('records one sign_in event naming the user and the provider', async () => {
    const ann = await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity')
    await call(folioWith({ providers: [provider, capturingMagicLink] }), '/folio/login', {
      headers: { 'x-identity': 'ann@example.com' },
    })

    expect(await eventRows()).toEqual([
      // The actor of a sign-in is its own subject: nobody else caused it.
      { kind: 'sign_in', user_id: ann.id, actor: ann.id, provider: 'proxy', detail: null },
    ])
  })

  it('renders the ordinary page and writes nothing when nobody is there', async () => {
    await seedAnn()
    const { provider, calls } = headerProvider('proxy', 'x-identity')
    const res = await call(folioWith({ providers: [capturingMagicLink, provider] }), '/folio/login')
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(calls()).toBe(1)
    expect(html).toContain('name="email"')
    expect(setCookies(res)).toEqual([])
    expect(await sessionRows()).toEqual([])
    expect(await eventRows()).toEqual([])
  })

  it('renders the page in place with the provider notice when resolve throws', async () => {
    await seedAnn()
    const provider = trusted<Cloudflare.Env>({
      id: 'proxy',
      label: 'Proxy',
      resolve: () => {
        throw new Error('the upstream JWKS is unreachable')
      },
    })
    const res = await call(folioWith({ providers: [capturingMagicLink, provider] }), '/folio/login')
    const html = await res.text()

    // **In place, not a redirect to /login.** A redirect there would resolve
    // again, throw again, and redirect again.
    expect(res.status).toBe(200)
    expect(html).toContain('Signing in with that provider did not work')
    expect(html).toContain('name="email"')
    expect(await sessionRows()).toEqual([])
  })

  it('renders the page in place with the refused notice for an identity with no account', async () => {
    const { provider } = headerProvider('proxy', 'x-identity')
    const res = await call(
      folioWith({ providers: [provider, capturingMagicLink] }),
      '/folio/login',
      {
        headers: { 'x-identity': 'stranger@example.com' },
      },
    )
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('does not have access to this site')
    expect(await sessionRows()).toEqual([])
    // Access is a list somebody maintains: a verified identity Folio has never
    // heard of does not become a user.
    expect(await providerOf('stranger@example.com')).toBeNull()
  })

  it('provisions when the provider says to', async () => {
    const { provider } = headerProvider('proxy', 'x-identity', {
      provision: { create: true, role: 'editor' },
    })
    const res = await call(folioWith({ providers: [provider] }), '/folio/login', {
      headers: { 'x-identity': 'newstaff@example.com' },
    })

    expect(res.status).toBe(302)
    expect(await providerOf('newstaff@example.com')).toBe('proxy')
  })

  it('takes the first provider that answers, in declaration order', async () => {
    await seedAnn()
    await createUser(env.DB, { email: 'bob@example.com', name: 'Bob', role: 'admin' })
    const first = headerProvider('first', 'x-first')
    const second = headerProvider('second', 'x-second')
    const folio = folioWith({ providers: [first.provider, second.provider] })

    const both = await call(folio, '/folio/login', {
      headers: { 'x-first': 'ann@example.com', 'x-second': 'bob@example.com' },
    })
    expect(both.status).toBe(302)
    expect(await sessionRows()).toMatchObject([{ provider: 'first' }])
    // The second is never consulted once the first has answered.
    expect(second.calls()).toBe(0)
  })

  it('falls through a provider that answers null to the next one', async () => {
    await createUser(env.DB, { email: 'bob@example.com', name: 'Bob', role: 'admin' })
    const first = headerProvider('first', 'x-first')
    const second = headerProvider('second', 'x-second')
    const res = await call(
      folioWith({ providers: [first.provider, second.provider] }),
      '/folio/login',
      {
        headers: { 'x-second': 'bob@example.com' },
      },
    )

    expect(res.status).toBe(302)
    expect(first.calls()).toBe(1)
    expect(await sessionRows()).toMatchObject([{ provider: 'second' }])
  })

  it('stops at a provider that throws rather than asking the next one', async () => {
    await createUser(env.DB, { email: 'bob@example.com', name: 'Bob', role: 'admin' })
    const broken = trusted<Cloudflare.Env>({
      id: 'broken',
      label: 'Broken',
      resolve: () => {
        throw new Error('nope')
      },
    })
    const second = headerProvider('second', 'x-second')
    const res = await call(folioWith({ providers: [broken, second.provider] }), '/folio/login', {
      headers: { 'x-second': 'bob@example.com' },
    })

    // A credential that arrived and did not verify is a fact to show, not a
    // reason to keep asking around until somebody says yes.
    expect(res.status).toBe(200)
    expect(await (res.clone() as Response).text()).toContain('did not work')
    expect(second.calls()).toBe(0)
  })
})

/* ------------------------------------------------------- the three guards --- */

describe('the queries that suppress resolution', () => {
  const guarded = ['error=link', 'error=refused', 'error=provider', 'sent=1', 'signedout=1']

  for (const query of guarded) {
    it(`does not resolve on ?${query}`, async () => {
      await seedAnn()
      const { provider, calls } = headerProvider('proxy', 'x-identity')
      const res = await call(
        folioWith({ providers: [capturingMagicLink, provider] }),
        `/folio/login?${query}`,
        { headers: { 'x-identity': 'ann@example.com' } },
      )

      expect(res.status).toBe(200)
      expect(calls()).toBe(0)
      expect(setCookies(res)).toEqual([])
      expect(await sessionRows()).toEqual([])
    })
  }

  it('answers 302 to a browser that already holds a session, consulting nobody', async () => {
    await seedAnn()
    const { provider, calls } = headerProvider('proxy', 'x-identity')
    const folio = folioWith({ providers: [capturingMagicLink, provider] })
    const signedIn = await call(folio, '/folio/login', {
      headers: { 'x-identity': 'ann@example.com' },
    })
    const cookie = `${SECURE_COOKIE}=${cookieFrom(signedIn, SECURE_COOKIE)}`

    const again = await call(folio, '/folio/login?next=%2Ffolio%2Fedit', { headers: { cookie } })

    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('/folio/edit')
    // One call, from the sign-in above: the cookie branch returns first.
    expect(calls()).toBe(1)
    expect(await sessionRows()).toHaveLength(1)
  })
})

/* --------------------------------------------------- the signed-out page --- */

describe('signing out under trusted identity', () => {
  const signIn = async (folio: Folio) => {
    const res = await call(folio, '/folio/login', { headers: { 'x-identity': 'ann@example.com' } })
    return `${SECURE_COOKIE}=${cookieFrom(res, SECURE_COOKIE)}`
  }

  it('answers the signed-out page as `next` when the provider has no sign-out URL', async () => {
    await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity')
    const folio = folioWith({ providers: [provider] })
    const cookie = await signIn(folio)

    const out = await call(folio, '/folio/api/logout', { method: 'POST', headers: { cookie } })

    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true, next: '/folio/login?signedout=1' })
    expect(setCookies(out).some((c) => c.startsWith(`${SECURE_COOKIE}=;`))).toBe(true)
    expect(await sessionRows()).toEqual([])
  })

  it("answers the provider's own sign-out URL when it has one", async () => {
    await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity', {
      signOutUrl: 'https://acme.cloudflareaccess.com/cdn-cgi/access/logout',
    })
    const folio = folioWith({ providers: [provider] })
    const cookie = await signIn(folio)

    const out = await call(folio, '/folio/api/logout', { method: 'POST', headers: { cookie } })
    expect(await out.json()).toMatchObject({
      next: 'https://acme.cloudflareaccess.com/cdn-cgi/access/logout',
    })
  })

  it('reads the session that minted it, not the user’s most recent provider', async () => {
    await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity', { signOutUrl: 'https://out.test/' })
    const folio = folioWith({ providers: [capturingMagicLink, provider] })
    const trustedCookie = await signIn(folio)
    // A second sign-in elsewhere, by another door, rewrites `users.provider` —
    // and must not change where *this* browser's sign-out goes.
    await env.DB.prepare(
      "update users set provider = 'magic' where email = 'ann@example.com'",
    ).run()

    const out = await call(folio, '/folio/api/logout', {
      method: 'POST',
      headers: { cookie: trustedCookie },
    })
    expect(await out.json()).toMatchObject({ next: 'https://out.test/' })
  })

  it('falls back to the signed-out page when there is no cookie at all', async () => {
    const folio = folioWith({ providers: [capturingMagicLink] })
    const out = await call(folio, '/folio/api/logout', { method: 'POST' })
    expect(await out.json()).toEqual({ ok: true, next: '/folio/login?signedout=1' })
  })

  it('renders a button per trusted provider and sets no cookie, header or no header', async () => {
    await seedAnn()
    const { provider, calls } = headerProvider('proxy', 'x-identity')
    const res = await call(
      folioWith({ providers: [capturingMagicLink, provider] }),
      '/folio/login?signedout=1',
      {
        // Still present: this is the deployment whose upstream session Folio
        // cannot end, which is the whole reason the page exists.
        headers: { 'x-identity': 'ann@example.com' },
      },
    )
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(calls()).toBe(0)
    expect(setCookies(res)).toEqual([])
    expect(html).toContain('You have signed out')
    expect(html).toContain('href="/folio/login/proxy?next=%2Ffolio%2Fedit"')
    expect(html).toContain('Continue with proxy')
    // Still no bundle, on this page as on the ordinary one.
    expect(html).not.toContain('<script')
  })

  it('does not draw trusted buttons on the ordinary page', async () => {
    const { provider } = headerProvider('proxy', 'x-identity')
    const res = await call(folioWith({ providers: [capturingMagicLink, provider] }), '/folio/login')
    // Resolution has just run: a button here is either redundant or a dead end.
    expect(await res.text()).not.toContain('/folio/login/proxy')
  })
})

/* ------------------------------------------------- explicit GET /login/:id --- */

describe('GET /folio/login/:id for a trusted provider', () => {
  it('signs in when the identity is there', async () => {
    const ann = await seedAnn()
    const { provider } = headerProvider('proxy', 'x-identity')
    const res = await call(
      folioWith({ providers: [provider] }),
      '/folio/login/proxy?next=%2Ffolio%2Fedit',
      {
        headers: { 'x-identity': 'ann@example.com' },
      },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/folio/edit')
    expect(await sessionRows()).toMatchObject([{ user_id: ann.id, provider: 'proxy' }])
  })

  it('redirects to a page that will not resolve again when it answers nothing', async () => {
    const { provider } = headerProvider('proxy', 'x-identity')
    const res = await call(folioWith({ providers: [provider] }), '/folio/login/proxy')

    expect(res.status).toBe(302)
    // `?error=` is what stops the landing page from resolving, refusing and
    // redirecting here forever.
    expect(res.headers.get('location')).toContain('error=refused')
  })

  it('redirects with the provider notice when resolve throws', async () => {
    const provider = trusted<Cloudflare.Env>({
      id: 'proxy',
      label: 'Proxy',
      resolve: () => {
        throw new Error('nope')
      },
    })
    const res = await call(folioWith({ providers: [provider] }), '/folio/login/proxy')
    expect(res.headers.get('location')).toContain('error=provider')
  })

  it('404s for a mail provider, as an unknown id does', async () => {
    const { provider } = headerProvider('proxy', 'x-identity')
    const folio = folioWith({ providers: [capturingMagicLink, provider] })
    expect((await call(folio, '/folio/login/magic')).status).toBe(404)
    expect((await call(folio, '/folio/login/nobody')).status).toBe(404)
  })
})

/* ------------------------------------------------------- cloudflare access --- */

const TEAM = 'https://acme.cloudflareaccess.com'
const CERTS = `${TEAM}/cdn-cgi/access/certs`

let accessKeys: { privateKey: CryptoKey; jwks: { keys: JsonWebKey[] } }
let otherKey: CryptoKey

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function signAssertion(
  claims: Record<string, unknown>,
  opts: { kid?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = encodeJson({ alg: 'RS256', kid: opts.kid ?? 'access-k1', typ: 'JWT' })
  const payload = encodeJson(claims)
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    opts.key ?? accessKeys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`
}

beforeAll(async () => {
  const rsa = async () =>
    (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
  const pair = await rsa()
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  accessKeys = {
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...jwk, kid: 'access-k1', alg: 'RS256', use: 'sig' } as JsonWebKey] },
  }
  otherKey = (await rsa()).privateKey
})

/**
 * A stand-in for the team's certs endpoint, injected through `fetchImpl` exactly
 * as `auth-login.test.ts` injects a stand-in IdP — the provider is exercised as
 * configured, and nothing else in the isolate is stubbed.
 *
 * `keys` beside `public_certs` is one of the two shapes the spec flags as
 * unverified against a live Access tenant; this document is written the way the
 * helper expects to read it.
 */
function certsFetch(doc: unknown = { keys: accessKeys.jwks.keys, public_certs: [] }) {
  let hits = 0
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS) {
      hits += 1
      return Response.json(doc)
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, hits: () => hits }
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: TEAM,
  aud: ['the-aud-tag'],
  sub: 'access-subject',
  exp: Math.floor(Date.now() / 1000) + 300,
  email: 'ann@example.com',
  ...over,
})

function accessFolio(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return folioWith({
    providers: [
      cloudflareAccess<Cloudflare.Env>({
        teamDomain: 'acme',
        aud: 'the-aud-tag',
        fetchImpl,
        ...over,
      }),
    ],
  })
}

describe('cloudflareAccess', () => {
  it('signs in the holder of a valid assertion', async () => {
    const ann = await seedAnn()
    const certs = certsFetch()
    const res = await call(accessFolio(certs.fetchImpl), '/folio/login', {
      headers: { 'cf-access-jwt-assertion': await signAssertion(goodClaims()) },
    })

    expect(res.status).toBe(302)
    expect(await sessionRows()).toMatchObject([{ user_id: ann.id, provider: 'cloudflare-access' }])
  })

  it('hands every claim to the identity, for roleFrom to read', async () => {
    // Asserted on the provider directly: `roleFrom` is applied by
    // `completeSignIn` in the spec's phase 3, and what phase 2 owes it is a
    // `claims` bag that actually arrives.
    const certs = certsFetch()
    const provider = cloudflareAccess<Cloudflare.Env>({
      teamDomain: 'acme.cloudflareaccess.com',
      aud: 'the-aud-tag',
      fetchImpl: certs.fetchImpl,
    })
    const identity = (await provider.resolve(
      env,
      new Request(`${BASE}/login`, {
        headers: {
          'cf-access-jwt-assertion': await signAssertion(goodClaims({ groups: ['cms-admins'] })),
        },
      }),
    )) as VerifiedIdentity

    expect(identity.email).toBe('ann@example.com')
    expect(identity.claims).toMatchObject({ groups: ['cms-admins'], sub: 'access-subject' })
  })

  it('defaults its sign-out URL to the team’s own logout, which really does end it', async () => {
    await seedAnn()
    const certs = certsFetch()
    const folio = accessFolio(certs.fetchImpl)
    const signedIn = await call(folio, '/folio/login', {
      headers: { 'cf-access-jwt-assertion': await signAssertion(goodClaims()) },
    })
    const cookie = `${SECURE_COOKIE}=${cookieFrom(signedIn, SECURE_COOKIE)}`

    const out = await call(folio, '/folio/api/logout', { method: 'POST', headers: { cookie } })
    expect(await out.json()).toMatchObject({
      next: `${TEAM}/cdn-cgi/access/logout`,
    })
  })

  it('renders the ordinary page and fetches nothing without the header', async () => {
    await seedAnn()
    const certs = certsFetch()
    const res = await call(accessFolio(certs.fetchImpl), '/folio/login')

    expect(res.status).toBe(200)
    expect(certs.hits()).toBe(0)
    expect(await sessionRows()).toEqual([])
  })

  it('reads the header and never the CF_Authorization cookie', async () => {
    // The cookie carries the same token, and is deliberately not a credential
    // here: one carrier per surface, and a cookie is the shape
    // `readSessionCookie` does not look at.
    await seedAnn()
    const certs = certsFetch()
    const res = await call(accessFolio(certs.fetchImpl), '/folio/login', {
      headers: { cookie: `CF_Authorization=${await signAssertion(goodClaims())}` },
    })

    expect(res.status).toBe(200)
    expect(certs.hits()).toBe(0)
    expect(await sessionRows()).toEqual([])
  })

  const bad: [string, () => Promise<string>][] = [
    ['a different team as issuer', () => signAssertion(goodClaims({ iss: 'https://evil.test' }))],
    ['an audience for another application', () => signAssertion(goodClaims({ aud: ['other'] }))],
    ['no audience at all', () => signAssertion(goodClaims({ aud: undefined }))],
    [
      'an expiry in the past, leeway included',
      () => signAssertion(goodClaims({ exp: Math.floor(Date.now() / 1000) - 120 })),
    ],
    ['no expiry', () => signAssertion(goodClaims({ exp: undefined }))],
    ['no email', () => signAssertion(goodClaims({ email: undefined }))],
    [
      'a signature by a key the team never published',
      () => signAssertion(goodClaims(), { key: otherKey }),
    ],
    [
      'a kid the certs document does not hold',
      () => signAssertion(goodClaims(), { kid: 'rotated' }),
    ],
    ['something that is not a JWS', async () => 'not-a-token'],
  ]

  for (const [label, mint] of bad) {
    it(`refuses ${label}`, async () => {
      await seedAnn()
      const certs = certsFetch()
      const res = await call(accessFolio(certs.fetchImpl), '/folio/login', {
        headers: { 'cf-access-jwt-assertion': await mint() },
      })

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Signing in with that provider did not work')
      expect(await sessionRows()).toEqual([])
    })
  }

  it('refuses a certs document with no `keys`, loudly', async () => {
    // The spec flags the `keys` array as an assumption unverified against a live
    // tenant. If it is wrong, this is the failure: a refusal that says so, not a
    // verification that quietly stops happening.
    await seedAnn()
    const certs = certsFetch({ public_certs: ['-----BEGIN CERTIFICATE-----'] })
    const res = await call(accessFolio(certs.fetchImpl), '/folio/login', {
      headers: { 'cf-access-jwt-assertion': await signAssertion(goodClaims()) },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('did not work')
  })

  it('caches the certs document per isolate', async () => {
    await seedAnn()
    const certs = certsFetch()
    const folio = accessFolio(certs.fetchImpl)
    const assertion = await signAssertion(goodClaims())
    await call(folio, '/folio/login', { headers: { 'cf-access-jwt-assertion': assertion } })
    await call(folio, '/folio/login', { headers: { 'cf-access-jwt-assertion': assertion } })

    expect(certs.hits()).toBe(1)
  })

  it('takes its AUD tag from the env when it is a function', async () => {
    await seedAnn()
    const certs = certsFetch()
    const res = await call(
      accessFolio(certs.fetchImpl, { aud: () => 'the-aud-tag' }),
      '/folio/login',
      { headers: { 'cf-access-jwt-assertion': await signAssertion(goodClaims()) } },
    )
    expect(res.status).toBe(302)
  })
})

/* ------------------------------------------------------------ coexistence --- */

describe('a trusted provider beside the others', () => {
  it('leaves the redirect and mail flows exactly as they were', async () => {
    const { provider } = headerProvider('proxy', 'x-identity')
    const folio = folioWith({
      providers: [
        capturingMagicLink,
        oidc<Cloudflare.Env>({ issuer: 'https://idp.test', clientId: 'c', clientSecret: 's' }),
        provider,
      ],
    })
    const html = await (await call(folio, '/folio/login')).text()

    expect(html).toContain('action="/folio/login/email"')
    expect(html).toContain('href="/folio/login/oidc?next=%2Ffolio%2Fedit"')
  })
})
