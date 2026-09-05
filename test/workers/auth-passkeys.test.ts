import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { AuthConfig, AuthProvider } from '../../src/server'
import { createFolio, magicLink, passkeys } from '../../src/server'
import {
  PLAIN_WEBAUTHN_COOKIE,
  SECURE_COOKIE,
  SECURE_WEBAUTHN_COOKIE,
} from '../../src/server/auth/cookie'
import { MAX_PASSKEYS_PER_USER } from '../../src/server/auth/passkeys'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser, type UserRow } from '../../src/server/auth/users'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '../../src/server/auth/webauthn'
import {
  type Authenticator,
  type CeremonyOverrides,
  createAuthenticator,
  encodeCbor,
  ES256,
  RS256,
  userHandleFor,
} from '../lib/synthetic-authenticator'

/**
 * The passkey routes, end to end against real D1 and real WebCrypto:
 * `docs/specs/foundation/passkeys.md` phase 2.
 *
 * `passkey-verify.test.ts` is the gate on the *verifier* and drives every
 * refusal in decision 3 individually. This file is the gate on what the
 * **routes** do with those answers, and the two properties it exists for are
 * things no unit test can see:
 *
 * 1. **Every refusal of `POST {base}/login/passkey` is byte-identical.** One
 *    `it` per row of the acceptance criteria's table, each asserting the whole
 *    body against `REFUSED` — because a refusal that differs by a word is an
 *    oracle for "does this credential exist and whose is it", which is exactly
 *    what `POST /login/email`'s `SENT` refuses to be.
 * 2. **The gates are three different gates.** `/me/passkeys*` needs the provider
 *    and a person; `/me/sessions*` needs neither the provider nor anything but a
 *    person; the admin's remove-all needs `admin`. Getting any of them wrong is
 *    silent.
 *
 * Each test builds its own `createFolio` and calls `handle()`, the way
 * `auth-login.test.ts` does and for its reason: the thing under test is a
 * *config* boundary — which providers are declared — and the shared `worker.ts`
 * fixture cannot carry one.
 */

const ORIGIN = 'https://folio.test'
const BASE = '/folio'
const RP_ID = 'folio.test'

/**
 * **The constant.** Every row of the refusal table asserts the response body
 * against this object and nothing looser: `toMatchObject` or a status-only
 * assertion would pass while a message drifted, and the drift is the bug.
 */
const REFUSED = {
  error: { code: 'unauthorized', message: 'That passkey was not accepted.' },
} as const

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
    basePath: BASE,
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

const mail = magicLink<Cloudflare.Env>({ send: () => {} })

/** A redirect provider that owns `client.com` — spec 28's enforced domain, which
 * is the one configuration under which a passkey is refused for an account that
 * holds one. Hand-written rather than `oidc()`: nothing here reaches an IdP, and
 * the only field under test is `domains`. */
const sso: AuthProvider<Cloudflare.Env> = {
  kind: 'redirect',
  id: 'sso',
  label: 'Sign in with SSO',
  domains: ['client.com'],
  start: async () => ({ url: 'https://idp.test/authorize', state: {} }),
  callback: async () => ({ email: 'someone@client.com' }),
}

const passkeyAuth: AuthConfig<Cloudflare.Env> = { providers: [mail, passkeys()] }
const mailOnlyAuth: AuthConfig<Cloudflare.Env> = { providers: [mail] }
const enforcedAuth: AuthConfig<Cloudflare.Env> = { providers: [mail, sso, passkeys()] }

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from login_challenges'),
    env.DB.prepare('delete from auth_events'),
    env.DB.prepare('delete from passkeys'),
    env.DB.prepare('delete from users'),
  ])
})

/* ------------------------------------------------------------- plumbing --- */

function setCookies(res: Response): string[] {
  const all = res.headers.getSetCookie?.()
  if (all && all.length > 0) return all
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

/** One cookie's value out of a response, by name, ignoring the expiry the
 * clearing headers write. */
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

/** The challenge cookie a `/options` response set, as a `Cookie` header value —
 * which is how a browser would send it back. */
function challengeCookie(res: Response): string {
  const value = cookieFrom(res, SECURE_WEBAUTHN_COOKIE)
  expect(value, 'the options route must set a challenge cookie').toBeTruthy()
  return `${SECURE_WEBAUTHN_COOKIE}=${value}`
}

/** Whether a response expires the challenge cookie under both names. A challenge
 * is single-use whatever the outcome, so this is asserted on refusals too. */
function clearsChallenge(res: Response): boolean {
  const cookies = setCookies(res)
  return (
    cookies.some((c) => c.startsWith(`${SECURE_WEBAUTHN_COOKIE}=`) && c.includes('Max-Age=0')) &&
    cookies.some((c) => c.startsWith(`${PLAIN_WEBAUTHN_COOKIE}=`) && c.includes('Max-Age=0'))
  )
}

async function seedUser(
  email = 'ann@example.com',
  role: 'viewer' | 'editor' | 'publisher' | 'admin' = 'editor',
): Promise<UserRow> {
  return createUser(env.DB, { email, name: 'Ann', role })
}

/** A signed-in browser: a user row, a session, and the cookie header for it. */
async function signIn(user: UserRow): Promise<string> {
  const session = await createSession(env.DB, user.id, { provider: 'magic' })
  return `${SECURE_COOKIE}=${session.token}`
}

const json = { 'content-type': 'application/json' }

/* ----------------------------------------------------------- ceremonies --- */

/** The enrolment round trip, driven the way the account screen's dialog will:
 * ask for options, run the authenticator, post the credential back. */
async function enrol(
  folio: Folio,
  cookie: string,
  opts: { alg?: number; name?: string; over?: Partial<CeremonyOverrides> } = {},
): Promise<{ authenticator: Authenticator; res: Response; options: Response }> {
  const authenticator = await createAuthenticator({ alg: opts.alg ?? ES256 })
  const options = await call(folio, `${BASE}/api/me/passkeys/options`, {
    method: 'POST',
    headers: { cookie },
  })
  if (options.status !== 200) return { authenticator, res: options, options }
  const { publicKey } = (await options.clone().json()) as {
    publicKey: PublicKeyCredentialCreationOptionsJSON
  }
  const credential = await authenticator.create(publicKey, { origin: ORIGIN, ...opts.over })
  const res = await call(folio, `${BASE}/api/me/passkeys`, {
    method: 'POST',
    headers: { ...json, cookie: `${cookie}; ${challengeCookie(options)}` },
    body: JSON.stringify({ credential, ...(opts.name ? { name: opts.name } : {}) }),
  })
  return { authenticator, res, options }
}

/**
 * The sign-in round trip. `cookie` defaults to the challenge the options route
 * just set; passing `null` is the "no challenge cookie" row and passing a
 * different value is the "wrong ceremony" one.
 */
async function assertWith(
  folio: Folio,
  authenticator: Authenticator,
  opts: {
    over?: Partial<CeremonyOverrides>
    cookie?: string | null
    next?: string
    credential?: unknown
  } = {},
): Promise<Response> {
  const options = await call(folio, `${BASE}/login/passkey/options`, { method: 'POST' })
  expect(options.status).toBe(200)
  const { publicKey } = (await options.clone().json()) as {
    publicKey: PublicKeyCredentialRequestOptionsJSON
  }
  const credential =
    opts.credential ?? (await authenticator.get(publicKey, { origin: ORIGIN, ...opts.over }))
  const cookie = opts.cookie === undefined ? challengeCookie(options) : opts.cookie
  return call(folio, `${BASE}/login/passkey`, {
    method: 'POST',
    headers: { ...json, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ credential, ...(opts.next ? { next: opts.next } : {}) }),
  })
}

/** Every row of the refusal table ends here. Four assertions, and each is a
 * separate property: the status, the byte-identical body, that nothing was
 * signed in, and that the challenge was spent. */
async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual(REFUSED)
  expect(cookieFrom(res, SECURE_COOKIE)).toBeNull()
  expect(clearsChallenge(res)).toBe(true)
  const sessions = await env.DB.prepare('select count(*) as n from sessions').first<{ n: number }>()
  expect(sessions?.n, 'a refused assertion must mint no session').toBe(0)
}

/* --------------------------------------------------------- the round trip --- */

describe('the round trip', () => {
  for (const [label, alg] of [
    ['ES256', ES256],
    ['RS256', RS256],
  ] as const) {
    it(`enrols and signs in with an ${label} credential`, async () => {
      const folio = folioWith(passkeyAuth)
      const user = await seedUser()
      const cookie = await signIn(user)

      const { authenticator, res } = await enrol(folio, cookie, { alg, name: 'Test' })
      expect(res.status).toBe(201)

      const listed = (await (
        await call(folio, `${BASE}/api/me/passkeys`, { headers: { cookie } })
      ).json()) as { passkeys: Record<string, unknown>[] }
      expect(listed.passkeys).toHaveLength(1)
      expect(listed.passkeys[0]).toMatchObject({ name: 'Test', backedUp: false, alg })
      // **Never the key.** `PasskeyRow` does not carry it, so a route cannot
      // hand one out by spreading the row it already has.
      expect(listed.passkeys[0]).not.toHaveProperty('publicKey')
      expect(listed.passkeys[0]).not.toHaveProperty('public_key')

      const stored = await env.DB.prepare(
        'select id, user_id, public_key, alg, counter from passkeys',
      ).first<{ id: string; user_id: string; public_key: string; alg: number; counter: number }>()
      expect(stored?.id).toBe(authenticator.credentialId)
      expect(stored?.user_id).toBe(user.id)
      expect(stored?.public_key.length).toBeGreaterThan(0)
      expect(stored?.alg).toBe(alg)

      // A second browser, with no session: signing in is the whole point.
      await env.DB.prepare('delete from sessions').run()
      const signedIn = await assertWith(folio, authenticator, {
        next: '/folio/content',
        over: { counter: 7 },
      })
      expect(signedIn.status).toBe(200)
      expect(await signedIn.json()).toEqual({ ok: true, next: '/folio/content' })
      expect(cookieFrom(signedIn, SECURE_COOKIE)).toBeTruthy()
      // The challenge is spent on success too.
      expect(clearsChallenge(signedIn)).toBe(true)

      const session = await env.DB.prepare('select provider from sessions').first<{
        provider: string
      }>()
      expect(session?.provider).toBe('passkey')
      const row = await env.DB.prepare('select provider from users where id = ?')
        .bind(user.id)
        .first<{ provider: string }>()
      expect(row?.provider).toBe('passkey')

      // The stamp rode in `completeSignIn`'s batch rather than a second round trip.
      const used = await env.DB.prepare('select counter, last_used_at from passkeys').first<{
        counter: number
        last_used_at: number | null
      }>()
      expect(used?.counter).toBe(7)
      expect(used?.last_used_at).toBeGreaterThan(0)

      const events = await env.DB.prepare(
        "select kind, provider from auth_events where kind = 'sign_in'",
      ).all<{ kind: string; provider: string }>()
      expect(events.results).toHaveLength(1)
      expect(events.results[0]?.provider).toBe('passkey')
    })
  }

  it('names the row for the host it was enrolled on when nobody named it', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const { res } = await enrol(folio, cookie)
    expect(res.status).toBe(201)
    const { passkey } = (await res.json()) as { passkey: { name: string } }
    // The only hint anybody gets that a credential made on one host cannot work
    // on another (decision 5's own edge case).
    expect(passkey.name).toBe(`Passkey · ${RP_ID}`)
  })

  it('renames a passkey, and refuses to rename somebody else’s', async () => {
    const folio = folioWith(passkeyAuth)
    const ann = await seedUser()
    const annCookie = await signIn(ann)
    const { res } = await enrol(folio, annCookie, { name: 'Old' })
    const { passkey } = (await res.json()) as { passkey: { id: string } }

    const renamed = await call(folio, `${BASE}/api/me/passkeys/${passkey.id}`, {
      method: 'PATCH',
      headers: { ...json, cookie: annCookie },
      body: JSON.stringify({ name: 'Work laptop' }),
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ passkey: { name: 'Work laptop' } })

    const boCookie = await signIn(await seedUser('bo@example.com'))
    const foreign = await call(folio, `${BASE}/api/me/passkeys/${passkey.id}`, {
      method: 'PATCH',
      headers: { ...json, cookie: boCookie },
      body: JSON.stringify({ name: 'Mine now' }),
    })
    // 404, not 403: an id that is not yours must be indistinguishable from one
    // that does not exist.
    expect(foreign.status).toBe(404)
  })
})

/**
 * Decision 2's decisive reason, as a test.
 *
 * `POST {base}/login/passkey/options` is unauthenticated and conditional UI
 * calls it on **every login-page load**. A challenge table would therefore be an
 * anonymous D1 write per page view — a storage-DoS vector needing its own rate
 * limit and its own sweep — which is why the challenge is a cookie. The property
 * that argument rests on is that this route touches no binding at all, and the
 * only way to see it is to count the accessor.
 *
 * Counting `config.bindings` rather than `prepare`: the middleware stores a
 * *memoised thunk*, so a route that answers from the config alone never invokes
 * the host's accessor, and that invocation is the observable event.
 */
describe('the unauthenticated options route costs the database nothing', () => {
  it('never reaches for the host’s bindings', async () => {
    let calls = 0
    const folio = createFolio<Cloudflare.Env>({
      blocks: [page],
      root: 'page',
      basePath: BASE,
      auth: passkeyAuth,
      bindings: (e) => {
        calls++
        return bindings(e)
      },
    })

    const res = await call(folio, `${BASE}/login/passkey/options`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(cookieFrom(res, SECURE_WEBAUTHN_COOKIE)).toBeTruthy()
    expect(calls, 'a login-page arm must not touch D1').toBe(0)

    // And the answer is the one the script converts: an empty `allowCredentials`,
    // because this route does not know whose passkeys to list and naming them
    // would be an enumeration oracle.
    const { publicKey } = (await res.json()) as {
      publicKey: PublicKeyCredentialRequestOptionsJSON
    }
    expect(publicKey).toMatchObject({
      rpId: RP_ID,
      userVerification: 'required',
      allowCredentials: [],
      timeout: 300_000,
    })
  })
})

/* --------------------------------------------- every refusal looks the same --- */

/**
 * The acceptance criteria's refusal table, one `it` per row.
 *
 * The fixture enrols a credential and then **deletes every session**, so the
 * `sessions` count `expectRefused` asserts is a real zero rather than one left
 * over from the enrolment that set the row up.
 */
describe('every assertion refusal is byte-identical', () => {
  const setup = async (
    auth: AuthConfig<Cloudflare.Env> = passkeyAuth,
    email = 'ann@example.com',
    enrolOver?: Partial<CeremonyOverrides>,
  ) => {
    const folio = folioWith(auth)
    const user = await seedUser(email)
    const cookie = await signIn(user)
    const { authenticator, res } = await enrol(folio, cookie, { over: enrolOver })
    expect(res.status).toBe(201)
    await env.DB.prepare('delete from sessions').run()
    await env.DB.prepare('delete from auth_events').run()
    return { folio, user, authenticator }
  }

  it('an unknown credential id', async () => {
    const { folio, authenticator } = await setup()
    await env.DB.prepare('delete from passkeys').run()
    await expectRefused(await assertWith(folio, authenticator))
  })

  it('a signature over the wrong challenge', async () => {
    const { folio, authenticator } = await setup()
    // The signature stays valid; it just covers a challenge this host never
    // minted, which is the replay the cookie exists to stop.
    await expectRefused(
      await assertWith(folio, authenticator, { over: { challenge: 'c29tZXRoaW5nLWVsc2U' } }),
    )
  })

  it('a clientDataJSON.origin of another host', async () => {
    const { folio, authenticator } = await setup()
    await expectRefused(
      await assertWith(folio, authenticator, { over: { origin: 'https://evil.example' } }),
    )
  })

  it('an rpIdHash of another host', async () => {
    const { folio, authenticator } = await setup()
    await expectRefused(await assertWith(folio, authenticator, { over: { rpId: 'evil.example' } }))
  })

  it('a valid signature with the UV flag clear', async () => {
    const { folio, authenticator } = await setup()
    // Checkpoint 2: user verification is `required` and the flag is *checked*,
    // not merely asked for. A passkey is the only factor in this sign-in.
    await expectRefused(await assertWith(folio, authenticator, { over: { uv: false } }))
  })

  it('a signature that does not verify', async () => {
    const { folio, authenticator } = await setup()
    await expectRefused(
      await assertWith(folio, authenticator, { over: { corruptSignature: true } }),
    )
  })

  it('an assertion naming another user', async () => {
    const { folio, authenticator } = await setup()
    await expectRefused(
      await assertWith(folio, authenticator, { over: { userHandle: userHandleFor('usr_other') } }),
    )
  })

  it('a counter equal to or below the stored one, where the stored one is non-zero', async () => {
    const { folio, authenticator, user } = await setup(passkeyAuth, 'ann@example.com', {
      counter: 5,
    })
    await expectRefused(await assertWith(folio, authenticator, { over: { counter: 3 } }))

    // **The one asymmetry**, and it is invisible to whoever was refused: a
    // regression means two authenticators hold one private key, and the host is
    // the only party who can act on that.
    const events = await env.DB.prepare('select kind, user_id, detail from auth_events').all<{
      kind: string
      user_id: string
      detail: string
    }>()
    expect(events.results).toHaveLength(1)
    expect(events.results[0]?.kind).toBe('passkey_rejected')
    expect(events.results[0]?.user_id).toBe(user.id)
    expect(JSON.parse(events.results[0]?.detail ?? '{}')).toMatchObject({ reason: 'counter' })

    // The credential survives: a clone is the person's to resolve by removing it.
    const still = await env.DB.prepare('select count(*) as n from passkeys').first<{ n: number }>()
    expect(still?.n).toBe(1)
  })

  it('a credential whose user was deleted', async () => {
    const { folio, authenticator, user } = await setup()
    // The row cascades *and* is deleted explicitly by `deleteUser`; here the
    // point is only that the credential now names nobody.
    await env.DB.batch([
      env.DB.prepare('delete from passkeys where user_id = ?').bind(user.id),
      env.DB.prepare('delete from users where id = ?').bind(user.id),
    ])
    await expectRefused(await assertWith(folio, authenticator))
  })

  it('a credential whose user is under a domain enforced to another provider', async () => {
    // **Enrolled before the domain was enforced**, which is the spec's own edge
    // case and the only way this row can exist: with `sso` already claiming
    // `client.com`, `POST /api/me/passkeys/options` is a 403 and there is
    // nothing to enrol. So the credential is made on a deployment without the
    // enforcement and asserted against one with it — same database, same rows.
    const { authenticator } = await setup(passkeyAuth, 'ann@client.com')
    await expectRefused(await assertWith(folioWith(enforcedAuth), authenticator))
  })

  it('no challenge cookie at all — the cross-site POST', async () => {
    const { folio, authenticator } = await setup()
    // `SameSite=Lax` means a POST from another site carries no challenge, so
    // this row is also the proof that such a request costs no D1 read.
    await expectRefused(await assertWith(folio, authenticator, { cookie: null }))
  })

  it('a cookie the browser has since dropped', async () => {
    const { folio, authenticator } = await setup()
    // `Max-Age=600` is enforced by the *browser*; the server holds no expiry to
    // compare against, so an expired cookie reaches it as no cookie or as one
    // whose value it cannot read. Both are this row.
    await expectRefused(
      await assertWith(folio, authenticator, {
        cookie: `${SECURE_WEBAUTHN_COOKIE}=not-a-payload`,
      }),
    )
  })

  it("a cookie from the other ceremony (k: 'create')", async () => {
    const folio = folioWith(passkeyAuth)
    const user = await seedUser()
    const cookie = await signIn(user)
    const { authenticator, res } = await enrol(folio, cookie)
    expect(res.status).toBe(201)

    // A *registration* challenge, freshly minted and perfectly valid — for the
    // other gate.
    const registration = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie },
    })
    await env.DB.prepare('delete from sessions').run()
    await expectRefused(
      await assertWith(folio, authenticator, { cookie: challengeCookie(registration) }),
    )
  })

  it('a body that is not the shape a credential has', async () => {
    const { folio, authenticator } = await setup()
    // A 400 naming the field that failed would be a difference an attacker
    // could measure, so this route is the one place a malformed body is a 401.
    await expectRefused(await assertWith(folio, authenticator, { credential: { id: 42 } }))
  })
})

/* ------------------------------------------- registration refuses what it should --- */

describe('registration refuses what it should', () => {
  /** The generic 400 the enrolment route answers for every verification
   * failure. Unlike the login route's 401 this is a convenience rather than a
   * security property — the caller is signed in and already knows whose account
   * it is — but it is still one message, because the distinctions are things a
   * browser got wrong. */
  const expectGeneric = async (res: Response) => {
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'That passkey could not be added. Try again.' },
    })
    const rows = await env.DB.prepare('select count(*) as n from passkeys').first<{ n: number }>()
    expect(rows?.n, 'a refused registration must write no row').toBe(0)
  }

  it('a challenge that does not match', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const { res } = await enrol(folio, cookie, { over: { challenge: 'c29tZXRoaW5nLWVsc2U' } })
    await expectGeneric(res)
  })

  it('an origin of another host', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const { res } = await enrol(folio, cookie, { over: { origin: 'https://evil.example' } })
    await expectGeneric(res)
  })

  it('an attestationObject that does not decode', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie },
    })
    const { publicKey } = (await options.clone().json()) as {
      publicKey: PublicKeyCredentialCreationOptionsJSON
    }
    const credential = await authenticator.create(publicKey, { origin: ORIGIN })
    await expectGeneric(
      await call(folio, `${BASE}/api/me/passkeys`, {
        method: 'POST',
        headers: { ...json, cookie: `${cookie}; ${challengeCookie(options)}` },
        body: JSON.stringify({
          credential: {
            ...credential,
            response: { ...credential.response, attestationObject: 'bm90LWNib3I' },
          },
        }),
      }),
    )
  })

  it('an unsupported algorithm', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const options = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie },
    })
    const { publicKey } = (await options.clone().json()) as {
      publicKey: PublicKeyCredentialCreationOptionsJSON
    }
    // Ed25519 (`-8`) is in the WebAuthn registry and out of scope: WebCrypto
    // does not have it everywhere yet. `pubKeyCredParams` never asks for it, so
    // an authenticator answering one is broken or lying — and there is
    // deliberately no CHECK on `passkeys.alg`, so admitting it later is a code
    // change only.
    await expectGeneric(
      await call(folio, `${BASE}/api/me/passkeys`, {
        method: 'POST',
        headers: { ...json, cookie: `${cookie}; ${challengeCookie(options)}` },
        body: JSON.stringify({
          credential: await credentialWithKey(
            publicKey.challenge,
            new Map<number, unknown>([
              [1, 1],
              [3, -8],
              [-1, 6],
              [-2, new Uint8Array(32).fill(3)],
            ]),
          ),
        }),
      }),
    )
  })

  /**
   * **The binding `u` exists for.** A challenge minted while Ann was signed in,
   * presented by Bo's browser, would otherwise hang a credential off Bo's
   * account — the cookie says who was signed in when the challenge was made, and
   * the verify route refuses when that is not who is signed in now.
   */
  it('a cookie whose u is another user', async () => {
    const folio = folioWith(passkeyAuth)
    const annCookie = await signIn(await seedUser())
    const boCookie = await signIn(await seedUser('bo@example.com'))

    const options = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie: annCookie },
    })
    const { publicKey } = (await options.clone().json()) as {
      publicKey: PublicKeyCredentialCreationOptionsJSON
    }
    const authenticator = await createAuthenticator({ alg: ES256 })
    const credential = await authenticator.create(publicKey, { origin: ORIGIN })

    await expectGeneric(
      await call(folio, `${BASE}/api/me/passkeys`, {
        method: 'POST',
        headers: { ...json, cookie: `${boCookie}; ${challengeCookie(options)}` },
        body: JSON.stringify({ credential }),
      }),
    )
  })

  it('a duplicate credential id, with 409', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const authenticator = await createAuthenticator({ alg: ES256 })

    const post = async () => {
      const options = await call(folio, `${BASE}/api/me/passkeys/options`, {
        method: 'POST',
        headers: { cookie },
      })
      const { publicKey } = (await options.clone().json()) as {
        publicKey: PublicKeyCredentialCreationOptionsJSON
      }
      const credential = await authenticator.create(publicKey, { origin: ORIGIN })
      return call(folio, `${BASE}/api/me/passkeys`, {
        method: 'POST',
        headers: { ...json, cookie: `${cookie}; ${challengeCookie(options)}` },
        body: JSON.stringify({ credential }),
      })
    }

    expect((await post()).status).toBe(201)
    // The browser's own `excludeCredentials` usually catches this first; the 409
    // covers the browsers that do not, in the round trip a pre-read would have
    // spent asking.
    const second = await post()
    expect(second.status).toBe(409)
    const rows = await env.DB.prepare('select count(*) as n from passkeys').first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  /** Decision 3: an authenticator that answers `fmt: 'packed'` despite
   * `attestation: 'none'` — Windows Hello does — is *accepted* with its
   * statement ignored. Refusing would lock those users out for a check this
   * spec does not perform. */
  it('accepts fmt: packed, statement ignored', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const { res } = await enrol(folio, cookie, {
      over: { fmt: 'packed', attStmt: new Map<unknown, unknown>([['alg', -7]]) },
    })
    expect(res.status).toBe(201)
  })

  it('refuses a new challenge at the cap, and sets no cookie', async () => {
    const folio = folioWith(passkeyAuth)
    const user = await seedUser()
    const cookie = await signIn(user)
    await env.DB.batch(
      Array.from({ length: MAX_PASSKEYS_PER_USER }, (_, i) =>
        env.DB.prepare(
          `insert into passkeys (id, user_id, public_key, alg, counter, name, backed_up, created_at)
           values (?, ?, 'AA', -7, 0, ?, 0, ?)`,
        ).bind(`cred-${i}`, user.id, `Passkey ${i}`, Date.now() + i),
      ),
    )
    const res = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(res.status).toBe(409)
    // No cookie: a challenge nobody can use is a value the browser carries
    // around for ten minutes for nothing.
    expect(cookieFrom(res, SECURE_WEBAUTHN_COOKIE)).toBeNull()
  })

  it('refuses a token actor with 403, because a token has no passkeys', async () => {
    const folio = folioWith(passkeyAuth)
    const minted = await createToken(env.DB, { name: 'CI', scopes: ['admin'] })
    const res = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}` },
    })
    // 403 and not 404: the credential is fine, it is the wrong *kind* of
    // credential, and retrying with it can never help.
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('refuses an enforced domain with 403, and says so on /api/me', async () => {
    const folio = folioWith(enforcedAuth)
    const cookie = await signIn(await seedUser('ann@client.com'))
    const res = await call(folio, `${BASE}/api/me/passkeys/options`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(res.status).toBe(403)

    const me = (await (await call(folio, `${BASE}/api/me`, { headers: { cookie } })).json()) as {
      passkeys: { allowed: boolean; reason?: string }
    }
    expect(me.passkeys.allowed).toBe(false)
    expect(me.passkeys.reason).toContain('client.com')
    expect(me.passkeys.reason).toContain('sso')
  })
})

/* ---------------------------------------------------------------- /api/me --- */

describe('GET /api/me answers the passkey block', () => {
  it('says allowed for an ordinary account on a deployment that listed passkeys', async () => {
    const folio = folioWith(passkeyAuth)
    const cookie = await signIn(await seedUser())
    const me = (await (await call(folio, `${BASE}/api/me`, { headers: { cookie } })).json()) as {
      passkeys?: { allowed: boolean }
      policy: { providers: { id: string; kind: string }[] }
    }
    expect(me.passkeys).toEqual({ allowed: true })
    // And the provider is in the policy the Settings screen draws, as a kind.
    expect(me.policy.providers.find((p) => p.id === 'passkey')?.kind).toBe('passkey')
  })

  it('omits the block entirely where the provider is not listed', async () => {
    const folio = folioWith(mailOnlyAuth)
    const cookie = await signIn(await seedUser())
    const me = (await (await call(folio, `${BASE}/api/me`, { headers: { cookie } })).json()) as {
      passkeys?: unknown
    }
    // Absent, not `{ allowed: false }`: "this site has no passkeys" is a
    // different answer from "you may not enrol one".
    expect('passkeys' in me).toBe(false)
  })
})

/* ------------------------------------------------------- nothing where none --- */

describe('nothing exists where auth does not', () => {
  const surfaces = (id: string) => [
    { method: 'POST', path: `${BASE}/login/passkey/options` },
    { method: 'POST', path: `${BASE}/login/passkey` },
    { method: 'POST', path: `${BASE}/api/me/passkeys/options` },
    { method: 'POST', path: `${BASE}/api/me/passkeys` },
    { method: 'GET', path: `${BASE}/api/me/passkeys` },
    { method: 'GET', path: `${BASE}/api/me/sessions` },
    { method: 'DELETE', path: `${BASE}/api/me/sessions/others` },
    { method: 'DELETE', path: `${BASE}/api/users/${id}/passkeys` },
  ]

  it('404s every passkey surface under auth: open', async () => {
    const folio = folioWith('open')
    for (const { method, path } of surfaces('usr_1')) {
      const res = await call(folio, path, {
        method,
        headers: json,
        body: method === 'GET' ? undefined : '{}',
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('404s the passkey surfaces without the provider, but still lists sessions', async () => {
    const folio = folioWith(mailOnlyAuth)
    const user = await seedUser()
    const cookie = await signIn(user)
    for (const path of [
      `${BASE}/login/passkey/options`,
      `${BASE}/login/passkey`,
      `${BASE}/api/me/passkeys/options`,
      `${BASE}/api/me/passkeys`,
    ]) {
      const res = await call(folio, path, {
        method: 'POST',
        headers: { ...json, cookie },
        body: '{}',
      })
      expect(res.status, path).toBe(404)
    }
    expect((await call(folio, `${BASE}/api/me/passkeys`, { headers: { cookie } })).status).toBe(404)

    // Sessions are useful without passkeys, so they are not behind the provider.
    const sessions = await call(folio, `${BASE}/api/me/sessions`, { headers: { cookie } })
    expect(sessions.status).toBe(200)
  })
})

/* --------------------------------------------------------------- removal --- */

describe('removal', () => {
  it('lets an admin remove all of somebody’s passkeys, and records who did it', async () => {
    const folio = folioWith(passkeyAuth)
    const ann = await seedUser()
    const annCookie = await signIn(ann)
    const first = await enrol(folio, annCookie)
    const second = await enrol(folio, annCookie)
    expect(first.res.status).toBe(201)
    expect(second.res.status).toBe(201)

    const admin = await seedUser('boss@example.com', 'admin')
    const adminCookie = await signIn(admin)
    const removed = await call(folio, `${BASE}/api/users/${ann.id}/passkeys`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ removed: 2 })
    const left = await env.DB.prepare('select count(*) as n from passkeys where user_id = ?')
      .bind(ann.id)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)

    const event = await env.DB.prepare(
      "select user_id, actor from auth_events where kind = 'passkeys_removed'",
    ).first<{ user_id: string; actor: string }>()
    // The subject is Ann and the actor is the admin: this is the one passkey
    // event somebody else caused.
    expect(event?.user_id).toBe(ann.id)
    expect(event?.actor).toBe(admin.id)

    // And the credentials are dead.
    await env.DB.prepare('delete from sessions').run()
    await expectRefused(await assertWith(folio, first.authenticator))
  })

  it('refuses remove-all to anybody who is not an admin', async () => {
    const folio = folioWith(passkeyAuth)
    const ann = await seedUser()
    const bo = await seedUser('bo@example.com', 'publisher')
    const res = await call(folio, `${BASE}/api/users/${ann.id}/passkeys`, {
      method: 'DELETE',
      headers: { cookie: await signIn(bo) },
    })
    expect(res.status).toBe(403)
  })

  it('deletes your own passkey and nobody else’s', async () => {
    const folio = folioWith(passkeyAuth)
    const annCookie = await signIn(await seedUser())
    const { res } = await enrol(folio, annCookie)
    const { passkey } = (await res.json()) as { passkey: { id: string } }

    const boCookie = await signIn(await seedUser('bo@example.com'))
    const foreign = await call(folio, `${BASE}/api/me/passkeys/${passkey.id}`, {
      method: 'DELETE',
      headers: { cookie: boCookie },
    })
    expect(foreign.status).toBe(404)
    const survived = await env.DB.prepare('select count(*) as n from passkeys').first<{
      n: number
    }>()
    expect(survived?.n).toBe(1)

    const own = await call(folio, `${BASE}/api/me/passkeys/${passkey.id}`, {
      method: 'DELETE',
      headers: { cookie: annCookie },
    })
    expect(own.status).toBe(200)
    expect(await own.json()).toEqual({ deleted: true })
    const event = await env.DB.prepare(
      "select count(*) as n from auth_events where kind = 'passkey_removed'",
    ).first<{ n: number }>()
    expect(event?.n).toBe(1)
  })
})

/* -------------------------------------------------------------- sessions --- */

describe('the sessions a person holds', () => {
  it('lists them, badges the one asking, and never ships the whole hash', async () => {
    const folio = folioWith(passkeyAuth)
    const user = await seedUser()
    const here = await createSession(env.DB, user.id, { provider: 'magic', userAgent: 'Here/1' })
    await createSession(env.DB, user.id, { provider: 'sso', userAgent: 'There/1' })

    const res = await call(folio, `${BASE}/api/me/sessions`, {
      headers: { cookie: `${SECURE_COOKIE}=${here.token}` },
    })
    expect(res.status).toBe(200)
    const { sessions } = (await res.json()) as {
      sessions: { id: string; current: boolean; provider: string; userAgent: string }[]
    }
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)
    expect(sessions.find((s) => s.current)?.userAgent).toBe('Here/1')
    // Truncated: the hash is not a credential, but the smallest value that still
    // tells two rows apart is the one that cannot become a problem later.
    for (const s of sessions) {
      expect(s.id).toHaveLength(12)
      expect(here.id.startsWith(s.id) || !s.current).toBe(true)
    }
  })

  it('signs out every other browser and leaves this one live', async () => {
    const folio = folioWith(passkeyAuth)
    const user = await seedUser()
    const here = await createSession(env.DB, user.id, { provider: 'magic' })
    await createSession(env.DB, user.id, { provider: 'magic' })
    await createSession(env.DB, user.id, { provider: 'magic' })
    // Somebody else's session is not "other": the delete is scoped to the user.
    const other = await seedUser('bo@example.com')
    await createSession(env.DB, other.id, { provider: 'magic' })

    const cookie = `${SECURE_COOKIE}=${here.token}`
    const res = await call(folio, `${BASE}/api/me/sessions/others`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: 2 })

    const mine = await env.DB.prepare('select id from sessions where user_id = ?')
      .bind(user.id)
      .all<{ id: string }>()
    expect(mine.results.map((r) => r.id)).toEqual([here.id])
    // The click must not sign out whoever clicked.
    expect((await call(folio, `${BASE}/api/me/sessions`, { headers: { cookie } })).status).toBe(200)

    const event = await env.DB.prepare(
      "select detail from auth_events where kind = 'sessions_revoked'",
    ).first<{ detail: string }>()
    expect(JSON.parse(event?.detail ?? '{}')).toEqual({ revoked: 2 })
  })

  it('writes no event when there was nothing to revoke', async () => {
    const folio = folioWith(passkeyAuth)
    const user = await seedUser()
    const here = await createSession(env.DB, user.id, { provider: 'magic' })
    const res = await call(folio, `${BASE}/api/me/sessions/others`, {
      method: 'DELETE',
      headers: { cookie: `${SECURE_COOKIE}=${here.token}` },
    })
    expect(await res.json()).toEqual({ revoked: 0 })
    // A no-op is not an event.
    const events = await env.DB.prepare('select count(*) as n from auth_events').first<{
      n: number
    }>()
    expect(events?.n).toBe(0)
  })

  it('refuses a token actor, because a token has no sessions', async () => {
    const folio = folioWith(passkeyAuth)
    const minted = await createToken(env.DB, { name: 'CI', scopes: ['admin'] })
    const res = await call(folio, `${BASE}/api/me/sessions`, {
      headers: { authorization: `Bearer ${minted.token}` },
    })
    expect(res.status).toBe(403)
  })
})

/* ------------------------------------------------------ the Access column --- */

describe('GET /api/users carries a passkey count', () => {
  it('counts per row, and reads zero for somebody with none', async () => {
    const folio = folioWith(passkeyAuth)
    const ann = await seedUser()
    const annCookie = await signIn(ann)
    expect((await enrol(folio, annCookie)).res.status).toBe(201)
    expect((await enrol(folio, annCookie)).res.status).toBe(201)
    await seedUser('bo@example.com')

    const admin = await seedUser('boss@example.com', 'admin')
    const res = await call(folio, `${BASE}/api/users`, { headers: { cookie: await signIn(admin) } })
    const { users } = (await res.json()) as { users: { email: string; passkeys: number }[] }
    expect(users.find((u) => u.email === 'ann@example.com')?.passkeys).toBe(2)
    expect(users.find((u) => u.email === 'bo@example.com')?.passkeys).toBe(0)
  })

  it('reads zero for every row on a deployment with no passkey provider', async () => {
    const folio = folioWith(mailOnlyAuth)
    const admin = await seedUser('boss@example.com', 'admin')
    const res = await call(folio, `${BASE}/api/users`, { headers: { cookie: await signIn(admin) } })
    const { users } = (await res.json()) as { users: { passkeys: number }[] }
    // The query is skipped entirely — every answer would be zero — and the key
    // is still present so the column has one shape to render.
    expect(users.every((u) => u.passkeys === 0)).toBe(true)
  })
})

/* ---------------------------------------------------------------- helpers --- */

/**
 * A registration response whose attested credential data carries `key` rather
 * than a key an authenticator could sign with.
 *
 * Hand-assembled for the reason `passkey-verify.test.ts` assembles its own: the
 * synthetic authenticator will only ever emit a key it holds the private half
 * of, so an unsupported algorithm cannot be produced by driving it.
 */
async function credentialWithKey(challenge: string, key: Map<number, unknown>) {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
  )
  const credentialId = new Uint8Array(32).fill(9)
  const keyBytes = encodeCbor(key)
  const authData = new Uint8Array(55 + credentialId.length + keyBytes.length)
  authData.set(rpIdHash, 0)
  // UP | UV | AT. The counter at 33..37 and the AAGUID at 37..53 stay zero,
  // which is what a platform authenticator emits under `none`.
  authData[32] = 0x01 | 0x04 | 0x40
  authData[53] = (credentialId.length >> 8) & 0xff
  authData[54] = credentialId.length & 0xff
  authData.set(credentialId, 55)
  authData.set(keyBytes, 55 + credentialId.length)

  const attestationObject = encodeCbor(
    new Map<unknown, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  )
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }),
  )
  const b64 = (bytes: Uint8Array) => {
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return {
    id: b64(credentialId),
    rawId: b64(credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64(clientDataJSON),
      attestationObject: b64(attestationObject),
    },
  }
}
