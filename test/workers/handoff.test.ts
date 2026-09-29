import { createExecutionContext, env } from 'cloudflare:test'
import { createElement } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { Mutation } from '../../src/core/mutations'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink, type Role, trusted } from '../../src/server'
import { createApp } from '../../src/server/app'
import { SECURE_COOKIE, SECURE_GRANT_COOKIE } from '../../src/server/auth/cookie'
import type { Grants } from '../../src/server/auth/roles'
import { hashToken } from '../../src/server/auth/secrets'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser, replaceGrantsStatements } from '../../src/server/auth/users'
import { MCP_PROTOCOL_VERSION } from '../../src/server/mcp/rpc'
import { createRuntime } from '../../src/server/runtime'

/**
 * Many sites in one deployment, phase 5 (`docs/specs/foundation/multi-site.md`
 * decision 13): drafts reach a site's preview origin through a one-time,
 * site-bound handoff, and nowhere else.
 *
 * **The four-step trace is the specification of record**, and each step has its
 * own section here, in order: `site/start` on the admin origin, `site/enter` on
 * the preview origin, its `check=1` hop, and the page. Then the acceptance
 * criteria under "Preview across origins" and the draft-site rows of "Registry and
 * status", each in the spec's own words.
 *
 * The registry: group `north`; `alpha` (in north, live, `alpha.example`, preview
 * `https://preview.alpha.example`); `bravo` (live, `bravo.example`, preview
 * `https://preview.bravo.example`); `gamma` (in north, **draft**, `gamma.example`,
 * preview `https://preview.gamma.example`); `hotel` (draft, preview only, owns
 * nothing). Every story's row title is its *draft* title and its published
 * document carries a different one, so a page says which it rendered: an object's
 * first draft is seeded from the row (`runtime.ts`' `seed`).
 */

const ADMIN = 'https://cms.example'
const ALPHA = 'https://preview.alpha.example'
const BRAVO = 'https://preview.bravo.example'
const GAMMA = 'https://preview.gamma.example'
const HOTEL = 'https://preview.hotel.example'

const page = defineBlock({
  name: 'hPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: ({ title }) => createElement('main', null, createElement('h1', null, title)),
})

const settingsRoot = defineBlock({
  name: 'hSettingsRoot',
  label: 'Settings',
  fields: { tagline: text({ label: 'Tagline' }) },
  render: ({ tagline }) => createElement('p', null, tagline),
})

/** What the fake Browser Run binding was asked to open, per screenshot. */
const shots: { url: string; headers: Record<string, string> }[] = []

const browser = {
  quickAction: async (_action: string, opts: { url: string; setExtraHTTPHeaders?: object }) => {
    shots.push({ url: opts.url, headers: { ...(opts.setExtraHTTPHeaders ?? {}) } as never })
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    })
  },
} as unknown as BrowserRun

/** Every Durable Object name the library asks the story namespace for. */
const touched: string[] = []

function watched(ns: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (prop === 'idFromName') {
        return (name: string) => {
          touched.push(name)
          return target.idFromName(name)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const config: FolioConfig<Cloudflare.Env> = {
  blocks: [page, settingsRoot],
  types: [
    { name: 'hPage', label: 'Page', kind: 'page', root: 'hPage', default: true },
    { name: 'hSettings', label: 'Settings', kind: 'singleton', root: 'hSettingsRoot' },
  ],
  bindings: (e): FolioBindings => ({
    db: e.DB,
    story: watched(e.STORY as unknown as DurableObjectNamespace) as typeof e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
    browser,
  }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN, settings: 'hSettings' },
}

const folio = createFolio<Cloudflare.Env>(config)

const call = (url: string, init?: RequestInit) =>
  folio.handle(new Request(url, init), env, createExecutionContext())

async function must(url: string, init?: RequestInit): Promise<Response> {
  const res = await call(url, init)
  if (!res) throw new Error(`handle() answered null for ${url}`)
  return res
}

function rootDoc(title: string): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: { uid: 'r0', type: 'hPage', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

/** A published page whose draft (seeded from the row) says `<title> draft`. */
async function story(id: string, site: string, path: string, title: string, forkedFrom?: string) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at, forked_from)
     values (?, 'hPage', null, ?, ?, 'a0', ?, 1, ?, ?, 2, ?)`,
  )
    .bind(
      id,
      path,
      path,
      `${title} draft`,
      site,
      JSON.stringify(rootDoc(`${title} published`) as unknown as Json),
      forkedFrom ?? null,
    )
    .run()
}

interface Person {
  headers: Record<string, string>
  userId: string
  sessionId: string
}

async function person(email: string, grants: Grants): Promise<Person> {
  const user = await createUser(env.DB, { email, grants })
  const session = await createSession(env.DB, user.id)
  return {
    headers: { cookie: `${SECURE_COOKIE}=${session.token}` },
    userId: user.id,
    sessionId: session.id,
  }
}

const start = (who: Person | null, site: string, next: string) =>
  must(`${ADMIN}/folio/~${site}/site/start?next=${encodeURIComponent(next)}`, {
    headers: who?.headers ?? {},
  })

/** The grant token a `site/enter` response set, or null. */
function grantOf(res: Response): string | null {
  const match = /__Host-folio_grant=([0-9a-f]{64})/.exec(res.headers.get('set-cookie') ?? '')
  return match?.[1] ?? null
}

const grantCookie = (grant: string) => ({ cookie: `${SECURE_GRANT_COOKIE}=${grant}` })

/** All three hops, asserting each, and the grant they end holding. */
async function handoff(who: Person, site: string, next: string): Promise<string> {
  const first = await start(who, site, next)
  expect(first.status).toBe(302)
  const second = await must(first.headers.get('location')!)
  expect(second.status).toBe(302)
  const grant = grantOf(second)
  expect(grant).not.toBeNull()
  const third = await must(second.headers.get('location')!, { headers: grantCookie(grant!) })
  expect(third.status).toBe(302)
  expect(third.headers.get('location')).toBe(next)
  return grant!
}

/** A page on a preview origin with a grant cookie, as HTML, or null. */
async function pageAt(origin: string, path: string, grant: string | null) {
  const res = await call(`${origin}${path}`, { headers: grant ? grantCookie(grant) : {} })
  return res ? { status: res.status, html: await res.text(), headers: res.headers } : null
}

const stubOf = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as {
    commit: (m: Mutation[], actor: { id: string; name: string }) => Promise<unknown>
  }

let E: Person // {alpha: editor}
let N: Person // {shared: publisher}
let R: Person // {north: editor}
let P: Person // {'*': admin}
let B: Person // {bravo: editor}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', '${ALPHA}', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', '${BRAVO}', 0, 0),
         ('gamma', 'site', 'Gamma', 'north', 'draft', '${GAMMA}', 0, 0),
         ('hotel', 'site', 'Hotel', null, 'draft', '${HOTEL}', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('alpha.example', 'alpha'), ('bravo.example', 'bravo'), ('gamma.example', 'gamma')`,
    ),
  ])
  await story('sty_h_alpha_about', 'alpha', 'about', 'Alpha about')
  await story('sty_h_bravo_about', 'bravo', 'about', 'Bravo about')
  await story('sty_h_offers', 'shared', 'offers', 'Shared offers')
  await story('sty_h_stores', 'shared', 'stores', 'Shared stores')
  await story('sty_h_alpha_stores', 'alpha', 'stores', 'Alpha stores', 'sty_h_stores')
  await story('sty_h_north_news', 'north', 'news', 'North news')
  await story('sty_h_gamma_welcome', 'gamma', 'welcome', 'Gamma welcome')
  await story('sty_h_gamma_other', 'gamma', 'other', 'Gamma other')

  E = await person('e@example.com', { alpha: 'editor' })
  N = await person('n@example.com', { shared: 'publisher' })
  R = await person('r@example.com', { north: 'editor' })
  P = await person('p@example.com', { '*': 'admin' })
  B = await person('b@example.com', { bravo: 'editor' })
})

/* ------------------------------------------------ step 1: site/start --- */

describe('step 1: site/start on the admin origin', () => {
  it('mints a sixty-second code on the session and 302s to the preview origin', async () => {
    const before = Date.now()
    const res = await start(E, 'alpha', '/about?_folio=preview')
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe(ALPHA)
    expect(location.pathname).toBe('/folio/site/enter')
    expect(location.searchParams.get('next')).toBe('/about?_folio=preview')
    const code = location.searchParams.get('code')!
    expect(code).toMatch(/^[0-9a-f]{64}$/)

    const row = await env.DB.prepare(
      'select session_id, token_id, site_id, token_hash, expires_at from site_grants where code_hash = ?',
    )
      .bind(await hashToken(code))
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({
      session_id: E.sessionId,
      token_id: null,
      site_id: 'alpha',
      token_hash: null,
    })
    expect(row!.expires_at as number).toBeGreaterThanOrEqual(before + 60_000)
    expect(row!.expires_at as number).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('replaces a next that is not a path with the fallback', async () => {
    for (const next of [
      'https://elsewhere.example',
      '//elsewhere.example',
      '/\\elsewhere.example',
    ]) {
      const res = await start(E, 'alpha', next)
      expect(new URL(res.headers.get('location')!).searchParams.get('next'), next).toBe('/')
    }
  })

  it('sends a browser with no session to sign in, and back here, scope and all', async () => {
    const res = await start(null, 'alpha', '/about')
    expect(res.status).toBe(302)
    const login = new URL(res.headers.get('location')!, ADMIN)
    expect(login.pathname).toBe('/folio/login')
    expect(login.searchParams.get('next')).toBe('/folio/~alpha/site/start?next=%2Fabout')
  })

  it('admits anyone with READ_DRAFT on a scope of the chain, and 403s everyone else', async () => {
    // Shared-only and group-only: not refused at the start of a preview (decision 10).
    expect((await start(N, 'alpha', '/')).status).toBe(302)
    expect((await start(R, 'alpha', '/')).status).toBe(302)
    expect((await start(P, 'gamma', '/')).status).toBe(302)
    // R {north: editor} and bravo, which is in no group: the route's own refusal.
    const refused = await start(R, 'bravo', '/')
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('needs a role on it, its group, or shared content')
    expect((await start(E, 'bravo', '/')).status).toBe(403)
    expect((await start(B, 'alpha', '/')).status).toBe(403)
  })

  it('is no route for a group, shared content, a site with no scope, or on a site host', async () => {
    expect((await start(P, 'north', '/')).status).toBe(404)
    expect((await start(P, 'shared', '/')).status).toBe(404)
    expect((await must(`${ADMIN}/folio/site/start?next=/`, { headers: P.headers })).status).toBe(
      400,
    )
    // On a preview origin `handle()` answers no `site/start` at all.
    expect(await call(`${ALPHA}/folio/site/start?next=/`, { headers: P.headers })).toBeNull()
  })
})

/* ------------------------------------------------ step 2: site/enter --- */

describe('step 2: site/enter on the preview origin', () => {
  async function code(who: Person = E, site = 'alpha', next = '/about?_folio=preview') {
    return (await start(who, site, next)).headers.get('location')!
  }

  it('consumes the code, sets the partitioned grant cookie, and 302s to its own check', async () => {
    const enter = await code()
    const res = await must(enter)
    expect(res.status).toBe(302)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const check = new URL(res.headers.get('location')!)
    expect(`${check.origin}${check.pathname}`).toBe(`${ALPHA}/folio/site/enter`)
    expect(check.searchParams.get('check')).toBe('1')
    expect(check.searchParams.get('next')).toBe('/about?_folio=preview')
    expect(check.searchParams.has('code')).toBe(false)

    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-folio_grant=[0-9a-f]{64}; /)
    for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=None', 'Secure', 'Partitioned']) {
      expect(cookie.split('; '), attribute).toContain(attribute)
    }
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1])
    expect(maxAge).toBeGreaterThan(86_000)
    expect(maxAge).toBeLessThanOrEqual(86_400)

    // The row is now a grant: no code, a token hash, a day's expiry.
    const row = await env.DB.prepare(
      'select code_hash, token_hash, expires_at from site_grants where token_hash = ?',
    )
      .bind(await hashToken(grantOf(res)!))
      .first<{ code_hash: string | null; expires_at: number }>()
    expect(row?.code_hash).toBeNull()
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 86_000_000)
  })

  it('expires with the session when the session ends sooner than a day', async () => {
    const user = await createUser(env.DB, {
      email: 'short@example.com',
      grants: { alpha: 'editor' },
    })
    const session = await createSession(env.DB, user.id)
    await env.DB.prepare('update sessions set expires_at = ? where id = ?')
      .bind(Date.now() + 3_600_000, session.id)
      .run()
    const who = {
      headers: { cookie: `${SECURE_COOKIE}=${session.token}` },
      userId: user.id,
      sessionId: session.id,
    }
    const res = await must(await code(who))
    const maxAge = Number(/Max-Age=(\d+)/.exec(res.headers.get('set-cookie')!)![1])
    expect(maxAge).toBeLessThanOrEqual(3600)
    expect(maxAge).toBeGreaterThan(3500)
  })

  it('cannot be redeemed twice, one after the other', async () => {
    const enter = await code()
    expect(grantOf(await must(enter))).not.toBeNull()
    const again = await must(enter)
    expect(again.status).toBe(404)
    expect(grantOf(again)).toBeNull()
  })

  it('cannot be redeemed twice concurrently: exactly one of two racing redemptions wins', async () => {
    for (let round = 0; round < 5; round++) {
      const enter = await code()
      const [a, b] = await Promise.all([must(enter), must(enter)])
      const won = [a, b].filter((res) => grantOf(res) !== null)
      expect(won).toHaveLength(1)
      expect([a.status, b.status].sort()).toEqual([302, 404])
    }
  })

  it('cannot be redeemed after sixty seconds', async () => {
    const enter = await code()
    const hash = await hashToken(new URL(enter).searchParams.get('code')!)
    await env.DB.prepare('update site_grants set expires_at = ? where code_hash = ?')
      .bind(Date.now() - 1, hash)
      .run()
    const res = await must(enter)
    expect(res.status).toBe(404)
    expect(grantOf(res)).toBeNull()
  })

  it("cannot be redeemed on another site's preview origin, and survives the attempt", async () => {
    const enter = await code()
    const onBravo = enter.replace(ALPHA, BRAVO)
    const refused = await must(onBravo)
    expect(grantOf(refused)).toBeNull()
    expect(refused.status).toBe(404)
    // Refused without spending it: alpha's own origin still redeems it.
    expect(grantOf(await must(enter))).not.toBeNull()
  })

  it('screens next again on the second hop, and on the third', async () => {
    const enter = new URL(await code())
    enter.searchParams.set('next', 'https://elsewhere.example/')
    const res = await must(enter.toString())
    expect(new URL(res.headers.get('location')!).searchParams.get('next')).toBe('/')

    const grant = grantOf(res)!
    const check = await must(
      `${ALPHA}/folio/site/enter?check=1&next=${encodeURIComponent('//elsewhere.example')}`,
      { headers: grantCookie(grant) },
    )
    expect(check.headers.get('location')).toBe('/')
  })

  it('is no route on the admin origin, or without a code', async () => {
    expect((await must(`${ADMIN}/folio/site/enter?code=${'a'.repeat(64)}`)).status).toBe(404)
    expect((await must(`${ALPHA}/folio/site/enter`)).status).toBe(404)
  })
})

/* ---------------------------------------------------- step 3: check=1 --- */

describe('step 3: check=1', () => {
  it('302s to next when the cookie came back', async () => {
    const grant = await handoff(E, 'alpha', '/about?_folio=preview')
    expect(grant).toMatch(/^[0-9a-f]{64}$/)
  })

  it('says the browser refused the cookie, and tells the admin when framed', async () => {
    const res = await must(`${ALPHA}/folio/site/enter?check=1&next=%2Fabout`)
    expect(res.status).toBe(200)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${ADMIN}`)
    const html = await res.text()
    expect(html).toContain('Your browser refused the preview cookie')
    expect(html).toContain(`data-admin="${ADMIN}"`)
    expect(html).toContain("type: 'grant-blocked'")
    expect(html).toContain('window.parent === window')
  })

  it('answers on a draft site, before any grant exists', async () => {
    expect((await must(`${GAMMA}/folio/site/enter?check=1&next=%2F`)).status).toBe(200)
  })
})

/* ------------------------------------------------------ step 4: the page --- */

describe('step 4: the page', () => {
  it("renders the draft on alpha's preview origin, framed only by the admin", async () => {
    const grant = await handoff(E, 'alpha', '/about?_folio=preview')
    const res = await pageAt(ALPHA, '/about?_folio=preview', grant)
    expect(res?.status).toBe(200)
    expect(res!.html).toContain('Alpha about draft')
    expect(res!.html).not.toContain('Alpha about published')
    expect(res!.headers.get('content-security-policy')).toBe(`frame-ancestors ${ADMIN}`)
    expect(res!.headers.get('cache-control')).toContain('no-store')
    // The preview posts only to the admin: its origin is in the bootstrap.
    expect(res!.html).toContain(`"admin":"${ADMIN}"`)
  })

  it('hands the request back with no grant, and on a live host whatever the cookie', async () => {
    const grant = await handoff(E, 'alpha', '/about?_folio=preview')
    expect(await pageAt(ALPHA, '/about?_folio=preview', null)).toBeNull()
    expect(await pageAt('https://alpha.example', '/about?_folio=preview', grant)).toBeNull()
  })

  it('gives a host route calling reader.page() the draft on the preview origin only', async () => {
    const grant = await handoff(E, 'alpha', '/about')
    const cookie = `${SECURE_GRANT_COOKIE}=${grant}; __Host-folio_draft=1`
    const onPreview = await folio
      .reader(env, new Request(`${ALPHA}/about`, { headers: { cookie } }))
      .page('about')
    expect(onPreview?.draft).toBe(true)
    expect(JSON.stringify(onPreview?.doc)).toContain('Alpha about draft')
    const onLive = await folio
      .reader(env, new Request('https://alpha.example/about', { headers: { cookie } }))
      .page('about')
    expect(onLive?.draft).toBe(false)
  })

  /**
   * **The grant alone is the ask** (decision 13, step 4): a host route on the
   * preview origin gets the chain's drafts by `pickEditing` with no draft cookie,
   * and answers them uncacheably — a draft under `cacheHeaders` is unpublished
   * content on the edge under the page's real URL.
   */
  it('gives reader.page() the draft for a grant alone, uncacheable, on the preview origin', async () => {
    const grant = await handoff(E, 'alpha', '/about')
    const page = await folio
      .reader(env, new Request(`${ALPHA}/about`, { headers: grantCookie(grant) }))
      .page('about')
    expect(page?.draft).toBe(true)
    expect(JSON.stringify(page?.doc)).toContain('Alpha about draft')
    expect(page?.headers['cache-control']).toContain('no-store')
    expect(page?.headers['cache-tag']).toBeUndefined()
  })

  /**
   * Folio's own responses pass through `framedBy`; a host's page does not, so
   * `page.headers` carries the policy itself, on the preview surface only.
   */
  it("names the admin in a published page's frame-ancestors on the preview origin only", async () => {
    const onPreview = await folio.reader(env, new Request(`${ALPHA}/about`)).page('about')
    expect(onPreview?.draft).toBe(false)
    expect(onPreview?.headers['content-security-policy']).toBe(`frame-ancestors ${ADMIN}`)
    expect(onPreview?.headers['cache-control']).toContain('s-maxage=')

    const onLive = await folio.reader(env, new Request('https://alpha.example/about')).page('about')
    expect(onLive?.story.id).toBe('sty_h_alpha_about')
    expect(onLive?.headers['content-security-policy']).toBeUndefined()
  })

  it("names the admin in a draft page's frame-ancestors on the preview origin", async () => {
    const grant = await handoff(E, 'alpha', '/about')
    const page = await folio
      .reader(env, new Request(`${ALPHA}/about`, { headers: grantCookie(grant) }))
      .page('about')
    expect(page?.draft).toBe(true)
    expect(page?.headers['content-security-policy']).toBe(`frame-ancestors ${ADMIN}`)
    expect(page?.headers['cache-control']).toContain('no-store')
  })

  it('gives reader.page() nothing but the published page for that grant on the live host', async () => {
    const grant = await handoff(E, 'alpha', '/about')
    const page = await folio
      .reader(env, new Request('https://alpha.example/about', { headers: grantCookie(grant) }))
      .page('about')
    expect(page?.draft).toBe(false)
    expect(JSON.stringify(page?.doc)).not.toContain('Alpha about draft')
  })

  it('gives reader.page() only the published page for a session whose role is on another site', async () => {
    const page = await folio
      .reader(
        env,
        new Request(`${ALPHA}/about`, { headers: await sessionFor({ bravo: 'editor' }) }),
      )
      .page('about')
    expect(page?.draft).toBe(false)
    expect(JSON.stringify(page?.doc)).not.toContain('Alpha about draft')
  })

  it('is not a grant for another site: a bravo preview with an alpha grant is no draft', async () => {
    const grant = await handoff(E, 'alpha', '/about?_folio=preview')
    expect(await pageAt(BRAVO, '/about?_folio=preview', grant)).toBeNull()
  })
})

/* --------------------------------------------------- revocation, by HTTP --- */

describe('a grant is re-checked on every request', () => {
  it('ends when the editor signs out', async () => {
    const who = await person('out@example.com', { alpha: 'editor' })
    const grant = await handoff(who, 'alpha', '/about?_folio=preview')
    expect((await pageAt(ALPHA, '/about?_folio=preview', grant))?.status).toBe(200)
    await must(`${ADMIN}/folio/api/logout`, { method: 'POST', headers: who.headers })
    expect(await pageAt(ALPHA, '/about?_folio=preview', grant)).toBeNull()
  })

  it('ends when the editor is removed', async () => {
    const who = await person('gone@example.com', { alpha: 'editor' })
    const grant = await handoff(who, 'alpha', '/about?_folio=preview')
    const res = await must(`${ADMIN}/folio/api/users/${who.userId}`, {
      method: 'DELETE',
      headers: P.headers,
    })
    expect(res.status).toBe(200)
    expect(await pageAt(ALPHA, '/about?_folio=preview', grant)).toBeNull()
  })

  it('ends when the alpha grant is removed on the Access screen while the session stays', async () => {
    const who = await person('moved@example.com', { alpha: 'editor' })
    const grant = await handoff(who, 'alpha', '/about?_folio=preview')
    // What the Access screen writes, without the session revocation it batches
    // beside it, so the session outlives the grant and only `readGrant` can refuse.
    await env.DB.batch(replaceGrantsStatements(env.DB, who.userId, { bravo: 'editor' }, null))
    const live = await env.DB.prepare('select count(*) as n from sessions where id = ?')
      .bind(who.sessionId)
      .first<{ n: number }>()
    expect(live?.n).toBe(1)
    expect(await pageAt(ALPHA, '/about?_folio=preview', grant)).toBeNull()
  })
})

/* ------------------------------------- the acceptance criteria, by name --- */

describe('Preview across origins', () => {
  it('N {shared: publisher} previews a shared draft on alpha, with alpha’s draft settings', async () => {
    // Alpha's settings layer, published, then drafted.
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                            published_doc, published_at)
       values ('sng_hSettings:alpha', 'hSettings', null, 'hSettings', null, 'a0', 'Settings', 1,
               'alpha', ?, 2)`,
    )
      .bind(
        JSON.stringify({
          root: 's0',
          bloks: {
            s0: {
              uid: 's0',
              type: 'hSettingsRoot',
              parent: null,
              slot: null,
              order: 'a0',
              data: { tagline: 'Alpha published tagline' },
            },
          },
        }),
      )
      .run()
    const layer = await folio.draft(env, 'sng_hSettings:alpha')
    await stubOf('sng_hSettings:alpha').commit(
      [{ t: 'set', uid: layer.root, field: 'tagline', value: 'Alpha draft tagline' }],
      { id: 'test', name: 'Test' },
    )

    const grant = await handoff(N, 'alpha', '/offers?_folio=preview')
    const offers = await pageAt(ALPHA, '/offers?_folio=preview', grant)
    expect(offers?.html).toContain('Shared offers draft')
    expect(offers?.html).toContain('Alpha draft tagline')
    // …and alpha's own page, drafted.
    const about = await pageAt(ALPHA, '/about?_folio=preview', grant)
    expect(about?.html).toContain('Alpha about draft')
  })

  it('refuses N every write on alpha, with the session or with the grant', async () => {
    const create = await must(`${ADMIN}/folio/~alpha/api/stories`, {
      method: 'POST',
      headers: { ...N.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Nope', type: 'hPage' }),
    })
    expect(create.status).toBe(403)
    const grant = await handoff(N, 'alpha', '/')
    for (const [method, path] of [
      ['POST', '/folio/~alpha/api/v1/documents'],
      ['PUT', '/folio/~alpha/api/v1/documents/sty_h_alpha_about'],
      ['DELETE', '/folio/~alpha/api/v1/documents/sty_h_alpha_about'],
      ['POST', '/folio/~alpha/api/stories'],
    ] as const) {
      // `handle()` answers no write on a preview origin at all.
      expect(
        await call(`${ALPHA}${path}`, { method, headers: grantCookie(grant) }),
        path,
      ).toBeNull()
    }
  })

  it('previews the shared page itself on a site that forked it, with the banner', async () => {
    const grant = await handoff(N, 'alpha', '/stores?_folio=preview&_folio_id=sty_h_stores')
    const named = await pageAt(ALPHA, '/stores?_folio=preview&_folio_id=sty_h_stores', grant)
    expect(named?.html).toContain('Shared stores draft')
    expect(named?.html).toContain('Alpha overrides this page')
    // Without the id, the path is the fork's, and there is nothing to announce.
    const nearest = await pageAt(ALPHA, '/stores?_folio=preview', grant)
    expect(nearest?.html).toContain('Alpha stores draft')
    expect(nearest?.html).not.toContain('overrides this page')
    // A named story at another path, or outside the chain, is handed back.
    expect(await pageAt(ALPHA, '/about?_folio=preview&_folio_id=sty_h_stores', grant)).toBeNull()
    expect(
      await pageAt(ALPHA, '/about?_folio=preview&_folio_id=sty_h_bravo_about', grant),
    ).toBeNull()
  })

  it("mints N's share of the shared 'offers' on alpha's preview origin, with its site", async () => {
    const res = await must(`${ADMIN}/folio/~shared/api/story/sty_h_offers/share?site=alpha`, {
      method: 'POST',
      headers: N.headers,
    })
    expect(res.status).toBe(201)
    const { url, share } = (await res.json()) as { url: string; share: { id: string } }
    expect(new URL(url).origin).toBe(ALPHA)
    expect(new URL(url).pathname).toBe('/folio/share')
    const row = await env.DB.prepare('select site_id from shares where id = ?')
      .bind(share.id)
      .first<{ site_id: string }>()
    expect(row?.site_id).toBe('alpha')
  })

  it('refuses a share render site outside sitesUnder, or with no preview origin to name', async () => {
    // Alpha's own page renders on alpha only.
    const bravo = await must(`${ADMIN}/folio/~alpha/api/story/sty_h_alpha_about/share?site=bravo`, {
      method: 'POST',
      headers: P.headers,
    })
    expect(bravo.status).toBe(400)
    // A shared page from the shared scope must name its site.
    const unnamed = await must(`${ADMIN}/folio/~shared/api/story/sty_h_offers/share`, {
      method: 'POST',
      headers: N.headers,
    })
    expect(unnamed.status).toBe(400)
  })

  it('R {north: editor} sees their alpha edit, north’s and shared drafts on alpha, and 403 on bravo', async () => {
    await stubOf('sty_h_alpha_about').commit(
      [
        {
          t: 'set',
          uid: (await folio.draft(env, 'sty_h_alpha_about')).root,
          field: 'title',
          value: 'Edited by R',
        },
      ],
      { id: R.userId, name: 'R' },
    )
    const grant = await handoff(R, 'alpha', '/about?_folio=preview')
    expect((await pageAt(ALPHA, '/about?_folio=preview', grant))?.html).toContain('Edited by R')
    expect((await pageAt(ALPHA, '/news?_folio=preview', grant))?.html).toContain('North news draft')
    expect((await pageAt(ALPHA, '/offers?_folio=preview', grant))?.html).toContain(
      'Shared offers draft',
    )
    expect((await start(R, 'bravo', '/')).status).toBe(403)
  })
})

describe('a grant cookie on alpha’s preview origin', () => {
  it('reads GET {base}/~alpha/api/v1/documents/:id?status=draft there', async () => {
    const grant = await handoff(E, 'alpha', '/')
    const res = await must(
      `${ALPHA}/folio/~alpha/api/v1/documents/sty_h_alpha_about?status=draft`,
      { headers: grantCookie(grant) },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('draft')
    // Without it, no credential at all.
    const anon = await must(`${ALPHA}/folio/~alpha/api/v1/documents/sty_h_alpha_about?status=draft`)
    expect(anon.status).toBe(401)
  })

  it('reaches no {base}/api admin route and no socket through handle()', async () => {
    const grant = await handoff(E, 'alpha', '/')
    for (const path of [
      '/folio/~alpha/api/stories',
      '/folio/~alpha/api/story/sty_h_alpha_about/socket',
      '/folio/~alpha/api/space/socket',
      '/folio/api/me',
      '/folio/~alpha/mcp',
    ]) {
      expect(await call(`${ALPHA}${path}`, { headers: grantCookie(grant) }), path).toBeNull()
    }
  })

  /**
   * The second fence, below `handle()`: the app itself, handed a request exactly as
   * `handle()` would hand one from alpha's preview origin. **A grant cookie adds
   * nothing to any route but a v1 read or draft mode's switch**: every other route
   * answers it exactly as it answers the same request with no cookie at all.
   */
  it('is no credential below handle() on any route but a v1 read or draft/enter', async () => {
    const grant = await handoff(E, 'alpha', '/')
    const app = createApp(config, createRuntime(config))
    const routes = new Map<string, { method: string; path: string }>()
    for (const r of app.routes) {
      if (r.method !== 'ALL') routes.set(`${r.method} ${r.path}`, r)
    }
    const internal = (method: string, path: string, cookie?: string) =>
      app.fetch(
        new Request(`${ALPHA}${path}`, {
          method,
          headers: {
            'x-folio-scope': 'alpha',
            'x-folio-site': 'alpha',
            'x-folio-surface': 'preview',
            ...(cookie ? { cookie } : {}),
          },
        }),
        env,
        createExecutionContext(),
      )
    const differs: string[] = []
    let reads = 0
    for (const { method, path } of routes.values()) {
      const concrete = path
        .replace(/:[A-Za-z]+\{[^}]*\}/g, 'nothing')
        .replace(/:id\b/g, 'sty_h_alpha_about')
        .replace(/:[A-Za-z]+/g, 'nothing')
        .replace(/\*$/, 'nothing')
      const allowed =
        (method === 'GET' && concrete.startsWith('/folio/api/v1/')) ||
        concrete === '/folio/draft/enter'
      if (allowed) {
        reads++
        continue
      }
      const without = await internal(method, concrete)
      const withGrant = await internal(method, concrete, `${SECURE_GRANT_COOKIE}=${grant}`)
      if (without.status !== withGrant.status) differs.push(`${method} ${concrete}`)
    }
    expect(routes.size).toBeGreaterThan(100)
    expect(reads).toBeGreaterThan(5)
    expect(differs).toEqual([])
    // And the allowed read is one: the grant is what the v1 draft read needs.
    const draft = await internal(
      'GET',
      '/folio/api/v1/documents/sty_h_alpha_about?status=draft',
      `${SECURE_GRANT_COOKIE}=${grant}`,
    )
    expect(draft.status).toBe(200)
  })
})

/* -------------------------------------- MCP's preview_document on sites --- */

async function previewDocument(headers: Record<string, string>, id: string, prefix = '') {
  const res = await must(`${ADMIN}/folio${prefix}/mcp`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'preview_document',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'preview_document', arguments: { id } },
    }),
  })
  return { status: res.status, text: await res.text() }
}

describe('preview_document on a multi-site deployment', () => {
  it('sends the browser no authorization header and no session cookie, only a code', async () => {
    const { token } = await createToken(env.DB, {
      name: 'mcp-alpha',
      scopes: ['content:read', 'content:read:draft'],
      site: 'alpha',
    })
    shots.length = 0
    // A caller presenting both: neither may reach the browser.
    const res = await previewDocument(
      { authorization: `Bearer ${token}`, cookie: E.headers.cookie! },
      'sty_h_alpha_about',
      '/~alpha',
    )
    expect(res.status).toBe(200)
    expect(res.text).toContain('image/png')
    expect(shots).toHaveLength(1)
    expect(shots[0]!.headers).toEqual({})
    const target = new URL(shots[0]!.url)
    expect(`${target.origin}${target.pathname}`).toBe(`${ALPHA}/folio/site/enter`)
    expect(target.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints a five-minute token grant the browser redeems into the draft', async () => {
    const { token, row } = await createToken(env.DB, {
      name: 'mcp-alpha-2',
      scopes: ['content:read', 'content:read:draft'],
      site: 'alpha',
    })
    shots.length = 0
    await previewDocument({ authorization: `Bearer ${token}` }, 'sty_h_alpha_about')
    const enter = await must(shots[0]!.url)
    const grant = grantOf(enter)!
    const held = await env.DB.prepare(
      'select token_id, session_id, expires_at from site_grants where token_hash = ?',
    )
      .bind(await hashToken(grant))
      .first<{ token_id: string; session_id: string | null; expires_at: number }>()
    expect(held).toMatchObject({ token_id: row.id, session_id: null })
    expect(held!.expires_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
    const check = await must(enter.headers.get('location')!, { headers: grantCookie(grant) })
    const next = check.headers.get('location')!
    expect(next).toContain('_folio=draft')
    const page = await pageAt(ALPHA, next, grant)
    expect(page?.html).toContain('Alpha about draft')
    // Revoked by update, the grant reads as nothing on the next request.
    await env.DB.prepare('update api_tokens set revoked_at = ? where id = ?')
      .bind(Date.now(), row.id)
      .run()
    expect(await pageAt(ALPHA, next, grant)).toBeNull()
  })
})

/* ---------------------------------------- the draft-site rows of Registry --- */

describe('a draft site’s preview origin', () => {
  it('is the host’s 404 without a grant, and the draft through the whole handoff with one', async () => {
    expect(await pageAt(GAMMA, '/welcome?_folio=preview', null)).toBeNull()
    const grant = await handoff(P, 'gamma', '/welcome?_folio=preview')
    const res = await pageAt(GAMMA, '/welcome?_folio=preview', grant)
    expect(res?.status).toBe(200)
    expect(res?.html).toContain('Gamma welcome draft')
    // The v1 read on a draft site, admitted by the grant.
    const v1 = await must(
      `${GAMMA}/folio/~gamma/api/v1/documents/sty_h_gamma_welcome?status=draft`,
      {
        headers: grantCookie(grant),
      },
    )
    expect(v1.status).toBe(200)
    expect(await call(`${GAMMA}/folio/~gamma/api/v1/documents/sty_h_gamma_welcome`)).toBeNull()
  })

  it('shows a share’s recipient, with no account, that one page’s draft and nothing else', async () => {
    const mint = await must(`${ADMIN}/folio/~gamma/api/story/sty_h_gamma_welcome/share`, {
      method: 'POST',
      headers: P.headers,
    })
    expect(mint.status).toBe(201)
    const { url } = (await mint.json()) as { url: string }
    expect(new URL(url).origin).toBe(GAMMA)

    const redeemed = await must(url)
    expect(redeemed.status).toBe(302)
    const cookie = /__Host-folio_share=[^;]+/.exec(redeemed.headers.get('set-cookie')!)![0]
    const target = redeemed.headers.get('location')!
    expect(new URL(target).origin).toBe(GAMMA)
    const shown = await call(target, { headers: { cookie } })
    expect(shown?.status).toBe(200)
    expect(await shown!.text()).toContain('Gamma welcome draft')
    expect(await call(`${GAMMA}/other?_folio=draft`, { headers: { cookie } })).toBeNull()
    expect(
      await call(`${GAMMA}/other?_folio=draft&_folio_id=sty_h_gamma_other`, {
        headers: { cookie },
      }),
    ).toBeNull()
  })

  it("redeems a share only on its own site's preview origin", async () => {
    const mint = await must(`${ADMIN}/folio/~alpha/api/story/sty_h_alpha_about/share`, {
      method: 'POST',
      headers: P.headers,
    })
    const { url } = (await mint.json()) as { url: string }
    const onBravo = await must(url.replace(ALPHA, BRAVO))
    expect(onBravo.status).toBe(404)
    expect(onBravo.headers.get('set-cookie')).toBeNull()
    expect((await must(url.replace(ALPHA, ADMIN))).status).toBe(404)
    expect((await must(url)).status).toBe(302)
  })

  it('sends an editor with no grant from draft/enter to site/start on the admin origin', async () => {
    const res = await must(`${GAMMA}/folio/draft/enter?next=%2Fwelcome`)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe(`${ADMIN}/folio/~gamma/site/start`)
    expect(to.searchParams.get('next')).toBe('/folio/draft/enter?next=%2Fwelcome')
    // With a grant, draft mode's flag is set there.
    const grant = await handoff(P, 'gamma', '/folio/draft/enter?next=%2Fwelcome')
    const entered = await must(`${GAMMA}/folio/draft/enter?next=%2Fwelcome`, {
      headers: grantCookie(grant),
    })
    expect(entered.status).toBe(302)
    expect(entered.headers.get('location')).toBe('/welcome')
    expect(entered.headers.get('set-cookie')).toContain('__Host-folio_draft=1')
  })

  it('previewed by a platform admin creates no layer row and no object, and deletes afterwards', async () => {
    const layers = async () =>
      (
        await env.DB.prepare(
          "select count(*) as n from stories where id like 'sng_%:hotel'",
        ).first<{
          n: number
        }>()
      )?.n
    expect(await layers()).toBe(0)
    const grant = await handoff(P, 'hotel', '/offers?_folio=preview')
    touched.length = 0
    const res = await pageAt(HOTEL, '/offers?_folio=preview', grant)
    expect(res?.html).toContain('Shared offers draft')
    expect(await layers()).toBe(0)
    // The page's own object, and no layer's: every setting reads as inherited.
    expect(touched).toContain('sty_h_offers')
    expect(touched.filter((name) => name.startsWith('sng_'))).toEqual([])
    const del = await must(`${ADMIN}/folio/api/sites/hotel`, {
      method: 'DELETE',
      headers: P.headers,
    })
    expect(del.status).toBe(200)
  })
})

/* ------------------------------ the role writers take the grants with them --- */

/** What the directory says, per address, for the SSO double's mapper. */
const directory = new Map<string, Role>()

/** The same deployment with a provider that places roles, so a sign-in changes them. */
const sso = createFolio<Cloudflare.Env>({
  ...config,
  auth: {
    providers: [
      trusted<Cloudflare.Env>({
        id: 'proxy',
        label: 'Continue with proxy',
        provision: { create: true },
        roleFrom: (identity) => directory.get(identity.email) ?? null,
        resolve: (_env, req) => {
          const email = req.headers.get('x-identity')
          return email ? { email, name: 'Proxied' } : null
        },
      }),
    ],
  },
})

async function grantRows(grant: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from site_grants where token_hash = ?')
    .bind(await hashToken(grant))
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe('a role change deletes the sessions it revokes with their grants', () => {
  it('on the Access screen', async () => {
    const who = await person('access@example.com', { alpha: 'editor' })
    const grant = await handoff(who, 'alpha', '/')
    expect(await grantRows(grant)).toBe(1)
    const res = await must(`${ADMIN}/folio/api/users/${who.userId}`, {
      method: 'PATCH',
      headers: { ...P.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ grants: { alpha: 'viewer' } }),
    })
    expect(res.status).toBe(200)
    // No foreign key names `site_grants`, so only the batch could have removed it.
    expect(await grantRows(grant)).toBe(0)
  })

  it('at an SSO sign-in that moves the role', async () => {
    directory.set('sso@example.com', 'editor')
    const signIn = async () => {
      const res = await sso.handle(
        new Request(`${ADMIN}/folio/login?next=%2Ffolio`, {
          headers: { 'x-identity': 'sso@example.com' },
        }),
        env,
        createExecutionContext(),
      )
      const cookie = /__Host-folio_session=([0-9a-f]{64})/.exec(res!.headers.get('set-cookie')!)
      return cookie![1]!
    }
    const token = await signIn()
    const who = {
      headers: { cookie: `${SECURE_COOKIE}=${token}` },
      userId: '',
      sessionId: await hashToken(token),
    }
    const grant = await handoff(who, 'alpha', '/')
    expect(await grantRows(grant)).toBe(1)
    directory.set('sso@example.com', 'publisher')
    await signIn()
    expect(await grantRows(grant)).toBe(0)
  })
})

/* ------------------------------------------------ after the phase 5 review --- */

/** A session's headers for someone holding exactly `grants` (none at all is `{}`). */
async function sessionFor(grants: Grants): Promise<Record<string, string>> {
  return (await person(`r${Math.random()}@example.com`, grants)).headers
}

async function bearerFor(
  scopes: Parameters<typeof createToken>[1]['scopes'],
  site: string | null,
): Promise<Record<string, string>> {
  const { token } = await createToken(env.DB, { name: `r${Math.random()}`, scopes, site })
  return { authorization: `Bearer ${token}` }
}

/** Whether `who` sees alpha's draft of `about` on alpha's preview origin, on each
 * render path: `?_folio=preview`, `?_folio=draft`, and `reader.page()` in draft mode. */
async function drafts(who: Record<string, string>) {
  const withDraft = {
    ...who,
    cookie: [who.cookie, '__Host-folio_draft=1'].filter(Boolean).join('; '),
  }
  const shows = async (res: Response | null) =>
    res ? (await res.text()).includes('Alpha about draft') : false
  return {
    preview: await shows(await call(`${ALPHA}/about?_folio=preview`, { headers: who })),
    draft: await shows(await call(`${ALPHA}/about?_folio=draft`, { headers: who })),
    reader:
      (await folio.reader(env, new Request(`${ALPHA}/about`, { headers: withDraft })).page('about'))
        ?.draft === true,
  }
}

const NONE = { preview: false, draft: false, reader: false }
const ALL = { preview: true, draft: true, reader: true }

describe('every credential on a preview origin is held to decision 13 for that site', () => {
  it('refuses a session with no role on the chain, including one with no grant at all', async () => {
    expect(await drafts(await sessionFor({ bravo: 'editor' }))).toEqual(NONE)
    expect(await drafts(await sessionFor({ bravo: 'viewer' }))).toEqual(NONE)
    expect(await drafts(await sessionFor({}))).toEqual(NONE)
  })

  it('refuses a token that does not reach the site, or does not hold read-draft', async () => {
    expect(await drafts(await bearerFor(['content:read:draft'], 'bravo'))).toEqual(NONE)
    expect(await drafts(await bearerFor(['content:read:draft'], 'shared'))).toEqual(NONE)
    expect(await drafts(await bearerFor(['content:read'], 'alpha'))).toEqual(NONE)
    expect(await drafts(await bearerFor(['content:read'], null))).toEqual(NONE)
  })

  it('admits exactly the credentials decision 13 admits', async () => {
    // Sessions never reach a preview origin in a deployment (host-only cookies);
    // where one does, it is held to the same rule as the grant.
    expect(await drafts(await sessionFor({ alpha: 'viewer' }))).toEqual(ALL)
    expect(await drafts(await sessionFor({ north: 'editor' }))).toEqual(ALL)
    expect(await drafts(await sessionFor({ shared: 'publisher' }))).toEqual(ALL)
    expect(await drafts(await sessionFor({ '*': 'viewer' }))).toEqual(ALL)
    expect(await drafts(await bearerFor(['content:read:draft'], 'alpha'))).toEqual(ALL)
    expect(await drafts(await bearerFor(['content:read:draft'], 'north'))).toEqual(ALL)
    expect(await drafts(await bearerFor(['publish'], null))).toEqual(ALL)
    expect(await drafts(grantCookie(await handoff(E, 'alpha', '/')))).toEqual(ALL)
  })

  it('agrees with v1 ?status=draft on every credential kind', async () => {
    const v1 = async (who: Record<string, string>) =>
      (
        await must(`${ALPHA}/folio/~alpha/api/v1/documents/sty_h_alpha_about?status=draft`, {
          headers: who,
        })
      ).status === 200
    for (const [who, expected] of [
      [await sessionFor({ bravo: 'editor' }), false],
      [await sessionFor({}), false],
      [await bearerFor(['content:read:draft'], 'bravo'), false],
      [await bearerFor(['content:read'], 'alpha'), false],
      [await sessionFor({ north: 'editor' }), true],
      [await bearerFor(['content:read:draft'], 'alpha'), true],
      [grantCookie(await handoff(E, 'alpha', '/')), true],
    ] as const) {
      expect(await v1(who), JSON.stringify(who)).toBe(expected)
      expect((await drafts(who)).preview, JSON.stringify(who)).toBe(expected)
    }
  })

  it('sends draft/enter a session that may not preview the site to site/start', async () => {
    const res = await must(`${ALPHA}/folio/draft/enter?next=%2Fabout`, {
      headers: await sessionFor({ bravo: 'editor' }),
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/folio/~alpha/site/start')
  })

  it('tries the grant when a session cookie that confers nothing is also present', async () => {
    const grant = await handoff(E, 'alpha', '/')
    for (const session of [
      `${SECURE_COOKIE}=${'d'.repeat(64)}`,
      (await sessionFor({ bravo: 'editor' })).cookie!,
    ]) {
      const both = await call(`${ALPHA}/about?_folio=preview`, {
        headers: { cookie: `${session}; ${SECURE_GRANT_COOKIE}=${grant}` },
      })
      expect(await both?.text()).toContain('Alpha about draft')
    }
  })
})

describe('an asset on a preview origin', () => {
  it('keeps its sandbox policy exactly, so an uploaded SVG cannot run script there', async () => {
    const key = 'ast_0123456789ab-x.svg'
    await env.MEDIA.put(
      key,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      { httpMetadata: { contentType: 'image/svg+xml' } },
    )
    const live = await must(`https://alpha.example/folio/asset/${key}`)
    const policy = live.headers.get('content-security-policy')
    expect(policy).toContain('sandbox')
    expect(policy).toContain("default-src 'none'")
    for (const origin of [ALPHA, GAMMA]) {
      const res = await must(`${origin}/folio/asset/${key}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy'), origin).toBe(policy)
    }
  })
})

describe('a share on a draft site admits its one story', () => {
  it('reads nothing else on the site through a host route, published or draft', async () => {
    const mint = await must(`${ADMIN}/folio/~gamma/api/story/sty_h_gamma_welcome/share`, {
      method: 'POST',
      headers: P.headers,
    })
    const { url } = (await mint.json()) as { url: string }
    const redeemed = await must(url)
    const cookie = /__Host-folio_share=[^;]+/.exec(redeemed.headers.get('set-cookie')!)![0]
    const at = (path: string) =>
      folio.reader(env, new Request(`${GAMMA}/${path}`, { headers: { cookie } }))
    expect(await at('other').page('other')).toBeNull()
    expect(await at('other').published('other')).toBeNull()
    expect(await at('other').storyAt('other')).toBeNull()
    expect(await at('other').stories()).toEqual([])
    // Another path read off a reader the share did admit.
    expect(await at('welcome').page('other')).toBeNull()
    expect(await at('welcome').published('other')).toBeNull()
    const own = await at('welcome').page('welcome')
    expect(own?.draft).toBe(true)
    expect(JSON.stringify(own?.doc)).toContain('Gamma welcome draft')
  })
})

describe('MCP’s grant is five minutes whoever calls', () => {
  it('caps a session caller’s grant at five minutes', async () => {
    shots.length = 0
    await previewDocument(E.headers, 'sty_h_alpha_about', '/~alpha')
    expect(shots).toHaveLength(1)
    const grant = grantOf(await must(shots[0]!.url))!
    const row = await env.DB.prepare(
      'select session_id, expires_at from site_grants where token_hash = ?',
    )
      .bind(await hashToken(grant))
      .first<{ session_id: string; expires_at: number }>()
    expect(row?.session_id).toBe(E.sessionId)
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
  })
})

describe('with draftMode, a share lands on its own story', () => {
  const drafting = createFolio<Cloudflare.Env>({ ...config, draftMode: true })

  it('lands on the host page when the site serves that story there, and on it by id when shadowed', async () => {
    const mint = async (id: string, scope: string) => {
      const res = await drafting.handle(
        new Request(`${ADMIN}/folio/~${scope}/api/story/${id}/share?site=alpha`, {
          method: 'POST',
          headers: P.headers,
        }),
        env,
        createExecutionContext(),
      )
      const { url } = (await res!.json()) as { url: string }
      const redeemed = await drafting.handle(new Request(url), env, createExecutionContext())
      return redeemed!.headers.get('location')!
    }
    expect(await mint('sty_h_offers', 'shared')).toBe(`${ALPHA}/offers`)
    const shadowed = new URL(await mint('sty_h_stores', 'shared'))
    expect(`${shadowed.origin}${shadowed.pathname}`).toBe(`${ALPHA}/stores`)
    expect(shadowed.searchParams.get('_folio')).toBe('draft')
    expect(shadowed.searchParams.get('_folio_id')).toBe('sty_h_stores')
  })
})

describe('a share-admitted reader on a draft site', () => {
  it('reads the published global over the full chain, never a draft layer, and lists nothing', async () => {
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                            published_doc, published_at)
       values ('sng_hSettings:gamma', 'hSettings', null, 'hSettings', null, 'a0', 'Settings', 1,
               'gamma', ?, 2)`,
    )
      .bind(
        JSON.stringify({
          root: 'g0',
          bloks: {
            g0: {
              uid: 'g0',
              type: 'hSettingsRoot',
              parent: null,
              slot: null,
              order: 'a0',
              data: { tagline: 'Gamma published tagline' },
            },
          },
        }),
      )
      .run()
    const layer = await folio.draft(env, 'sng_hSettings:gamma')
    await stubOf('sng_hSettings:gamma').commit(
      [{ t: 'set', uid: layer.root, field: 'tagline', value: 'Gamma draft tagline' }],
      { id: 'test', name: 'Test' },
    )

    const mint = await must(`${ADMIN}/folio/~gamma/api/story/sty_h_gamma_welcome/share`, {
      method: 'POST',
      headers: P.headers,
    })
    const { url } = (await mint.json()) as { url: string }
    const cookie = /__Host-folio_share=[^;]+/.exec((await must(url)).headers.get('set-cookie')!)![0]
    const reader = folio.reader(env, new Request(`${GAMMA}/welcome`, { headers: { cookie } }))

    expect((await reader.site())?.id).toBe('gamma')
    const settings = await reader.global('hSettings')
    expect(JSON.stringify(settings)).toContain('Gamma published tagline')
    expect(JSON.stringify(settings)).not.toContain('Gamma draft tagline')
    expect(await reader.tree()).toEqual([])
    expect(await reader.stories()).toEqual([])
    expect((await reader.page('welcome'))?.draft).toBe(true)
  })
})
