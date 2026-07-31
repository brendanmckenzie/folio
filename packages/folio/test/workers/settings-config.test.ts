import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Manifest } from '../../src/core/schema'
import { createFolio, magicLink } from '../../src/server'
import type { Folio, FolioBindings } from '../../src/server'
import type { AuthPolicy } from '../../src/server/auth/config'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'

/**
 * What the Settings screen is fed, across the **two** routes that feed it — and
 * the reason it is two.
 *
 * `docs/ui-architecture.md` decision 6 makes Settings a mirror of code, and the
 * two things missing for that were the sign-in providers and the declared publish
 * hooks. Both were added to the manifest, and one was taken straight back out:
 *
 *   - **`GET /api/schema` is ungated** (`server/app.ts`) and carries the
 *     declarations a client needs before it can authenticate. Publish hooks belong
 *     there: a declared event is a fact about the host's code.
 *   - **`GET /api/me` carries the sign-in policy.** `provision` told an
 *     unauthenticated stranger whether any account at the configured IdP becomes
 *     an editor and at what role, and `linksPerHour` published the exact throttle
 *     on the sign-in flow. Neither is a declaration; both are security posture.
 *
 * Two properties are pinned here and both are load-bearing. **Nothing a host hung
 * off a provider object reaches a client** — `authPolicy` builds each provider key
 * by key rather than spreading it, because a spread drops functions silently
 * (`JSON.stringify` does) and would look correct while carrying a `clientSecret`
 * somebody added for their own convenience. And **an unauthenticated
 * `/api/schema` carries no `auth` block at all**, which is the regression test for
 * the finding above: it fails the moment somebody moves the policy back.
 */

const ORIGIN = 'https://example.com'
const SECRET = 'sk-live-do-not-ship-this'

const page = defineBlock({
  name: 'page',
  label: 'Page',
  fields: { title: text() },
  render: () => null,
})

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

/**
 * A config with one redirect provider that hangs a secret off itself two ways: in
 * a closure, and as a plain key. Both must stay on the server, and the plain key
 * is the one a spread would carry.
 */
const leaky = () =>
  createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings,
    basePath: '/folio',
    auth: {
      providers: [
        {
          id: 'oidc',
          label: 'Sign in with Acme',
          redirect: true,
          start: async () => ({
            url: 'https://idp.example/authorize',
            state: { state: 's', nonce: 'n', verifier: 'v', next: '/' },
          }),
          callback: async () => ({ email: 'a@b.c' }),
          provision: { create: true, role: 'editor' },
          ...({ clientSecret: SECRET } as Record<string, unknown>),
        },
      ],
      sessionDays: 7,
      linksPerHour: 3,
    },
  })

const open = (hooks?: Parameters<typeof createFolio<Cloudflare.Env>>[0]['hooks']) =>
  createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings,
    basePath: '/folio',
    auth: 'open',
    ...(hooks ? { hooks } : {}),
  })

async function get(
  folio: Folio<Cloudflare.Env>,
  path: string,
  cookie?: string,
): Promise<{ status: number; body: string }> {
  const res = await folio.handle(
    new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined),
    env,
    createExecutionContext(),
  )
  return { status: res?.status ?? 0, body: res ? await res.text() : '' }
}

async function manifestOf(folio: Folio<Cloudflare.Env>) {
  const { status, body } = await get(folio, '/folio/api/schema')
  expect(status).toBe(200)
  return { manifest: JSON.parse(body) as Manifest, body }
}

/** A signed-in browser: the user row, and the cookie header to send. */
async function signIn(role: 'admin' | 'editor' | 'viewer' = 'admin'): Promise<string> {
  const user = await createUser(env.DB, { email: `${role}@example.com`, name: 'Ada', role })
  const session = await createSession(env.DB, user.id)
  return `${SECURE_COOKIE}=${session.token}`
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
  ])
})

/* ------------------------------------------- the public route says nothing --- */

describe('GET /folio/api/schema carries no auth block', () => {
  it('answers an unauthenticated caller with no sign-in policy at all', async () => {
    // **The regression test for the whole finding.** A session-mode deployment,
    // no cookie: the manifest still answers 200 (the admin bundle needs it before
    // it can draw a sign-in prompt of its own), and it describes nothing about
    // signing in.
    const { manifest, body } = await manifestOf(leaky())

    expect('auth' in manifest).toBe(false)
    expect(body).not.toContain('provision')
    expect(body).not.toContain('linksPerHour')
    expect(body).not.toContain('sessionDays')
    // Not even the provider's id or label, which a login page does render — the
    // rule is about which route answers, not about how sensitive each field feels
    // on its own.
    expect(body).not.toContain('oidc')
    expect(body).not.toContain('Sign in with Acme')
    // And obviously not the secret, by either of the two routes it was hung on.
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('clientSecret')
  })

  it('refuses /api/me to the same caller, which is why the policy lives there', async () => {
    expect((await get(leaky(), '/folio/api/me')).status).toBe(401)
  })
})

/* ------------------------------- the gated route, and no credential with it --- */

describe('GET /folio/api/me: sign-in policy', () => {
  it('carries the four facts that describe a provider and nothing else', async () => {
    const { status, body } = await get(leaky(), '/folio/api/me', await signIn())
    expect(status).toBe(200)
    const policy = (JSON.parse(body) as { policy?: AuthPolicy }).policy

    expect(policy?.providers).toEqual([
      {
        id: 'oidc',
        label: 'Sign in with Acme',
        redirect: true,
        provision: 'create',
        provisionRole: 'editor',
      },
    ])
    // The exact key set, so an added field is a failing test rather than a quiet
    // widening of what a client is told.
    expect(Object.keys(policy!.providers[0]!).sort()).toEqual([
      'id',
      'label',
      'provision',
      'provisionRole',
      'redirect',
    ])
    // And the whole response, not just the projection: the secret must not have
    // reached the body by any route. This is the assertion `authPolicy`'s
    // key-by-key construction exists to keep true.
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('clientSecret')
    expect(body).not.toContain('start')
    expect(body).not.toContain('callback')
  })

  it('reports the resolved session policy, not the raw config', async () => {
    // A screen that says "not set" where the answer is "30 days" has answered
    // nothing, so the defaults `resolveAuth` applied are what travel.
    const folio = createFolio<Cloudflare.Env>({
      blocks: [page],
      root: 'page',
      bindings,
      basePath: '/folio',
      auth: { providers: [magicLink({ send: () => {} })] },
    })

    const { body } = await get(folio, '/folio/api/me', await signIn())
    const policy = (JSON.parse(body) as { policy?: AuthPolicy }).policy
    expect(policy?.sessionDays).toBe(30)
    expect(policy?.linksPerHour).toBe(5)
    expect(policy?.providers[0]).toEqual({
      id: 'magic',
      label: 'Email me a sign-in link',
      redirect: false,
      provision: 'refuse',
    })
  })

  it('drops the send function rather than serialising something odd in its place', async () => {
    // A `send` closing over a credential is the ordinary shape: the demo's closes
    // over a console, a real one over a mail binding.
    const folio = createFolio<Cloudflare.Env>({
      blocks: [page],
      root: 'page',
      bindings,
      basePath: '/folio',
      auth: { providers: [magicLink({ send: () => console.log(SECRET) })] },
    })

    const { body } = await get(folio, '/folio/api/me', await signIn())
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('send')
  })

  it('omits the policy entirely under auth: open, so absence is the answer', async () => {
    // No providers, no session length, no throttle. A block of zeroes would be a
    // policy the screen would then have to explain away.
    const { status, body } = await get(open(), '/folio/api/me')
    expect(status).toBe(200)
    const me = JSON.parse(body) as { mode: string; policy?: AuthPolicy }
    expect(me.mode).toBe('open')
    expect('policy' in me).toBe(false)
  })

  it('still answers everything it answered before', async () => {
    const { body } = await get(leaky(), '/folio/api/me', await signIn())
    const me = JSON.parse(body) as { mode: string; actor: { role: string }; loginUrl: string }
    expect(me.mode).toBe('session')
    expect(me.actor.role).toBe('admin')
    expect(me.loginUrl).toBe('/folio/login')
  })
})

/* --------------------------------------------- declared hooks stay public --- */

describe('GET /folio/api/schema: declared publish hooks', () => {
  it('carries the event names and which of them a write waits for', async () => {
    const { manifest, body } = await manifestOf(
      open({ published: () => {}, pathsChanged: () => {}, await: ['published'] }),
    )
    expect(manifest.hooks).toEqual({
      declared: ['published', 'pathsChanged'],
      awaited: ['published'],
    })
    // `await` is not an event and must not appear as one.
    expect(manifest.hooks?.declared).not.toContain('await')
    // Names only. A hook is a function in the host's Worker and its body is not
    // something a settings screen has any business carrying.
    expect(body).not.toContain('function')
  })

  it('omits hooks when the host declared none', async () => {
    expect((await manifestOf(open())).manifest.hooks).toBeUndefined()
  })

  it('omits hooks for a config that declared only `await`', async () => {
    // Nothing to run, so nothing to report — and an empty `declared` array would
    // make the screen's empty state a thing to interpret rather than a fact.
    expect((await manifestOf(open({ await: ['published'] }))).manifest.hooks).toBeUndefined()
  })
})

describe('the manifest addition is additive', () => {
  it('leaves every existing field exactly as it was', async () => {
    const { manifest } = await manifestOf(open())
    expect(manifest.types).toEqual([{ name: 'page', label: 'Page', kind: 'page', root: 'page' }])
    expect(manifest.root).toBe('page')
    expect(manifest.globals).toEqual([])
    expect(manifest.blocks.map((b) => b.name)).toEqual(['page'])
  })
})
