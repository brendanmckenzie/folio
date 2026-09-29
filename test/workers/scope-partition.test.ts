import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import { EMPTY_REGISTRY, type Registry } from '../../src/core/sites'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { createApp } from '../../src/server/app'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { decodeIdentity, IDENTITY_HEADER } from '../../src/server/auth/identity'
import {
  ADMIN,
  allows,
  EDIT,
  effectiveRole,
  type GrantActor,
  type Grants,
  previewEligible,
  READ,
  READ_DRAFT,
  SCOPE_ADMIN,
  type TokenActor,
  tokenScopesOn,
  type UserActor,
} from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createShare } from '../../src/server/auth/shares'
import { MCP_PROTOCOL_VERSION } from '../../src/server/mcp/rpc'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import { PREVIEW_REACH, routeScope } from '../../src/server/middleware'
import { createRuntime } from '../../src/server/runtime'

/**
 * Many sites in one deployment, phase 3 (`docs/specs/foundation/multi-site.md`
 * decisions 10, 11, 14 and 17): which role a request has on which scope, and the
 * fence every id loader draws around it.
 *
 * **The route walks at the top read the mounted app itself** (`app.routes`), so a
 * route added later is walked without anybody listing it here. Three claims hold
 * across every one of them:
 *
 * - a platform-tier route refuses a site admin and a site-bound token — even one
 *   holding `admin` — and nothing else refuses them for that reason;
 * - a scoped `{base}/api` route named with no scope is `400 site_required`, and the
 *   unscoped ones are exactly the spec's list;
 * - a caller whose grants do not reach the URL's scope is a 403 naming it, on
 *   every scoped route, and on no unscoped one.
 *
 * The registry: group `north`; `alpha` (in north); `bravo` (no group); an empty
 * `echo`; and the migration's own `default`. Stories are seeded by SQL in
 * `alpha`, `bravo`, `north` and `shared`.
 */

const page = defineBlock({
  name: 'spPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

const settingsRoot = defineBlock({
  name: 'spSettingsRoot',
  label: 'Settings',
  fields: { tagline: text({ label: 'Tagline' }) },
  render: () => null,
})

const ADMIN_ORIGIN = 'https://cms.example'
const BASE = `${ADMIN_ORIGIN}/folio`

/** Every identity the story socket forwards to its object, decoded. */
const forwarded: ReturnType<typeof decodeIdentity>[] = []

/**
 * The story namespace, watched: the socket route hands the object its verified
 * identity in a header on `fetch`, and that is the only place the role it chose is
 * visible from outside. Everything else goes to the real stub untouched.
 */
function watchedStories(ns: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (id: DurableObjectId) => {
          const stub = target.get(id)
          return new Proxy(stub, {
            get(s, p) {
              if (p === 'fetch') {
                return (req: Request) => {
                  forwarded.push(decodeIdentity(req.headers.get(IDENTITY_HEADER)))
                  return s.fetch(req)
                }
              }
              // An RPC stub's methods are not ordinary functions (no `bind`), and
              // need no receiver: hand them over as they are.
              return Reflect.get(s, p)
            },
          })
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
    { name: 'spPage', label: 'Page', kind: 'page', root: 'spPage', default: true },
    { name: 'spSettings', label: 'Settings', kind: 'singleton', root: 'spSettingsRoot' },
  ],
  bindings: (e): FolioBindings => ({
    db: e.DB,
    story: watchedStories(e.STORY as unknown as DurableObjectNamespace) as typeof e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
  }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  locales: {
    default: 'en',
    available: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'French' },
    ],
  },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN_ORIGIN, settings: 'spSettings' },
}

const folio = createFolio<Cloudflare.Env>(config)

async function call(path: string, auth: Record<string, string>, init: RequestInit = {}) {
  const res = await folio.handle(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: { ...auth, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    }),
    env,
    createExecutionContext(),
  )
  if (!res) throw new Error(`handle() answered null for ${path}`)
  return res
}

async function errorOf(res: Response): Promise<{ code?: string; message?: string }> {
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return {}
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string }
  }
  return body.error ?? {}
}

function rootDoc(title: string): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: { uid: 'r0', type: 'spPage', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

async function story(id: string, site: string, path: string) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, 'spPage', null, ?, ?, 'a0', ?, 1, ?, ?, 2)`,
  )
    .bind(id, path, path, id, site, JSON.stringify(rootDoc(id) as unknown as Json))
    .run()
}

/** A signed-in person holding exactly these grants, as request headers. */
async function person(email: string, grants: Grants): Promise<Record<string, string>> {
  const user = await createUser(env.DB, { email, grants })
  const { token } = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${token}` }
}

/** A token, bound or not, as request headers. Minted directly, so a binding the
 * route would refuse (`admin` on a bound token) can still be presented. */
async function token(
  name: string,
  scopes: Parameters<typeof createToken>[1]['scopes'],
  site: string | null,
): Promise<Record<string, string>> {
  const minted = await createToken(env.DB, { name, scopes, site })
  return { authorization: `Bearer ${minted.token}` }
}

const EVERY_SCOPE = [
  'content:read',
  'content:read:draft',
  'content:write',
  'publish',
  'assets:write',
  'forms:read',
] as const

let U: Record<string, string> // {alpha: publisher}
let R: Record<string, string> // {north: editor}
let N: Record<string, string> // {shared: publisher}
let P: Record<string, string> // {'*': admin}
let A: Record<string, string> // {alpha: admin}, a site admin
let tAlpha: Record<string, string> // bound to alpha, every scope but admin
let tAlphaAdmin: Record<string, string> // bound to alpha *with* admin, by SQL-free mint
let tNorth: Record<string, string> // bound to north
let tPlatform: Record<string, string> // unbound admin

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0),
         ('echo', 'site', 'Echo', null, 'draft', null, 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
    ),
  ])
  await story('sty_sp_alpha', 'alpha', 'sp-alpha')
  await story('sty_sp_bravo', 'bravo', 'sp-bravo')
  await story('sty_sp_north', 'north', 'sp-north')
  await story('sty_sp_shared', 'shared', 'sp-shared')

  U = await person('u@example.com', { alpha: 'publisher' })
  R = await person('r@example.com', { north: 'editor' })
  N = await person('n@example.com', { shared: 'publisher' })
  P = await person('p@example.com', { '*': 'admin' })
  A = await person('a@example.com', { alpha: 'admin' })
  tAlpha = await token('alpha-all', [...EVERY_SCOPE], 'alpha')
  tAlphaAdmin = await token('alpha-admin', [...EVERY_SCOPE, 'admin'], 'alpha')
  tNorth = await token('north', ['content:read', 'content:write'], 'north')
  tPlatform = await token('platform', ['admin'], null)

  const db = env.DB
  await db.batch([
    ...(['alpha', 'bravo', 'shared'] as const).flatMap((owner) => [
      db
        .prepare(
          `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
           values (?, ?, ?, '[]', 0, 0, ?)`,
        )
        .bind(ROWS.form[owner], `${owner}-enquiry`, `${owner} enquiry`, owner),
      db
        .prepare(
          `insert into form_responses (id, form_id, version, created_at, data, body_hash, site_id)
           values (?, ?, 1, 1, ?, 'h', ?)`,
        )
        .bind(
          RESPONSES[owner],
          ROWS.form[owner],
          JSON.stringify({ email: `x@${owner}.example` }),
          owner,
        ),
      db
        .prepare(
          `insert into versions (id, story_id, kind, title, doc, created_at)
           values (?, ?, 'checkpoint', ?, ?, 1)`,
        )
        .bind(ROWS.version[owner], ROWS.story[owner], owner, JSON.stringify(rootDoc(owner))),
    ]),
  ])
  for (const owner of ['alpha', 'bravo', 'shared'] as const) {
    const { row } = await createShare(db, {
      storyId: ROWS.story[owner],
      expiresAt: Date.now() + 86_400_000,
    })
    ROWS.share[owner] = row.id
  }
})

/* ------------------------------------------------------------ the walks --- */

/**
 * The mounted routes, off Hono itself: every `method path` a request can reach,
 * with `app.use` middleware and the `/api/*` terminator (`ALL`) left out. Built on
 * the same config, so it is the app `folio` serves.
 */
const MOUNTED = (() => {
  const app = createApp(config, createRuntime(config))
  const seen = new Set<string>()
  const out: { method: string; path: string }[] = []
  for (const route of app.routes) {
    if (route.method === 'ALL') continue
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: route.method, path: route.path })
  }
  return out
})()

/** A route's pattern with every parameter filled by a value that names nothing, so
 * a request that gets past the gates finds no row to act on. */
function concrete(pattern: string): string {
  const below = pattern.slice('/folio'.length) || '/'
  return below
    .replace(/:[A-Za-z]+\{[^}]*\}/g, 'nothing')
    .replace(/:id\b/g, 'sty_sp_nothing')
    .replace(/:versionId\b/g, 'ver_nothing')
    .replace(/:[A-Za-z]+/g, 'nothing')
    .replace(/\*$/, 'nothing')
}

/**
 * The walks skip `POST /logout`, which would end the very session the walk is
 * signed in with, and nothing else.
 */
const WALKED = MOUNTED.filter((r) => !(r.method === 'POST' && r.path === '/folio/api/logout'))

/**
 * The platform tier as the spec lists it (decision 10): the registry, users (their
 * passkeys included), tokens, auth events, reindex, migrate, audit, bulk describe.
 * Written out here rather than read from the code, so the walk checks the code
 * against the spec rather than against itself.
 */
function platform(method: string, below: string): boolean {
  if (/^\/api\/(users|tokens|sites)(\/|$)/.test(below)) return true
  if (['/api/auth-events', '/api/reindex', '/api/migrate', '/api/audit'].includes(below)) {
    return true
  }
  return method === 'POST' && below === '/api/assets/describe'
}

/**
 * The unscoped `{base}/api` routes as decision 11 lists them: sign-in and the
 * caller's own account, the platform tier, `/schema`, the migration status that
 * reads code metadata, and the describe configuration beside bulk describe.
 */
function unscopedApi(below: string): boolean {
  const rest = below.slice('/api'.length)
  return (
    /^\/(schema|v1\/schema|logout|auth-events|reindex|migrate|audit|migrations|assets\/describe)$/.test(
      rest,
    ) || /^\/(me|users|tokens|sites|v1\/sites)(\/|$)/.test(rest)
  )
}

const PLATFORM_REFUSAL = /only an unbound token may do that|role on every site/

describe('every mounted route', () => {
  it('walks a real route list', () => {
    // A guard on the walks themselves: a list read off the wrong app would pass
    // everything below vacuously.
    expect(WALKED.length).toBeGreaterThan(100)
    expect(WALKED.some((r) => platform(r.method, concrete(r.path)))).toBe(true)
  })

  it('refuses a site admin every platform route, and only those, for that reason', async () => {
    const wrong: string[] = []
    for (const { method, path } of WALKED) {
      const below = concrete(path)
      const res = await call(`/~alpha${below}`, A, { method })
      const refused =
        res.status === 403 && PLATFORM_REFUSAL.test((await errorOf(res)).message ?? '')
      if (refused !== platform(method, below)) wrong.push(`${method} ${below} → ${res.status}`)
    }
    expect(wrong).toEqual([])
  })

  it('refuses a bound token every platform route, even holding admin, and only those', async () => {
    const wrong: string[] = []
    for (const { method, path } of WALKED) {
      const below = concrete(path)
      for (const at of [`/~alpha${below}`, below]) {
        const res = await call(at, tAlphaAdmin, { method })
        const refused =
          res.status === 403 && PLATFORM_REFUSAL.test((await errorOf(res)).message ?? '')
        if (refused !== platform(method, below)) wrong.push(`${method} ${at} → ${res.status}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('lets the platform admin and an unbound admin token through every platform route', async () => {
    const wrong: string[] = []
    for (const { method, path } of WALKED) {
      const below = concrete(path)
      if (!platform(method, below)) continue
      for (const who of [P, tPlatform]) {
        const res = await call(below, who, { method })
        if (res.status === 403 || res.status === 401)
          wrong.push(`${method} ${below} → ${res.status}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('answers site_required for a scoped /api route or /mcp with no scope, and for no other', async () => {
    const wrong: string[] = []
    for (const { method, path } of WALKED) {
      const below = concrete(path)
      const res = await call(below, U, { method })
      const required = res.status === 400 && (await errorOf(res)).code === 'site_required'
      // `{base}/mcp` is scoped too (decision 11): with no scope its tools would run
      // on every site at once.
      const expected = (below.startsWith('/api/') && !unscopedApi(below)) || below === '/mcp'
      if (required !== expected) wrong.push(`${method} ${below} → ${res.status}`)
    }
    expect(wrong).toEqual([])
  })

  it('is a 403 naming the scope on every scoped route the caller cannot reach, and on no other', async () => {
    const wrong: string[] = []
    for (const { method, path } of WALKED) {
      const below = concrete(path)
      const res = await call(`/~bravo${below}`, U, { method })
      const named = res.status === 403 && /'bravo'/.test((await errorOf(res)).message ?? '')
      if (named !== (routeScope(below) === 'scoped'))
        wrong.push(`${method} ${below} → ${res.status}`)
    }
    expect(wrong).toEqual([])
    // …and the classification the walk leans on agrees with the spec's list.
    for (const { path } of WALKED) {
      const below = concrete(path)
      if (below.startsWith('/api/')) {
        expect([below, routeScope(below)]).toEqual([
          below,
          unscopedApi(below) ? 'unscoped' : 'scoped',
        ])
      }
    }
  })

  it('scopes a bound token by its binding when the URL names none', async () => {
    const res = await call('/api/v1/documents/sty_sp_alpha', tAlpha)
    expect(res.status).toBe(200)
    expect((await call('/api/v1/documents/sty_sp_bravo', tAlpha)).status).toBe(404)
  })
})

describe("reach: 'preview'", () => {
  it('is site/start and nothing else', () => {
    expect(PREVIEW_REACH).toEqual(['/site/start'])
    expect(routeScope('/site/start')).toBe('preview')
    // The second hop is on a preview origin and names no scope at all.
    expect(routeScope('/site/enter')).toBe('unscoped')
  })

  it('does not refuse a shared-only or group-only editor at site/start, and refuses them elsewhere', async () => {
    for (const who of [N, R]) {
      // `site/start` itself is phase 5's; until then the shell's wildcard answers,
      // and what matters here is that `withActor` let the request reach a route.
      const start = await call('/~bravo/site/start?next=/', who)
      expect(start.status).not.toBe(403)
      const edit = await call('/~bravo/edit', who)
      expect(edit.status).toBe(403)
      expect((await errorOf(edit)).message).toContain("'bravo'")
    }
  })
})

/* ------------------------------------------------------- the permissions --- */

const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) })
const put = (value: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(value) })
const CONTENT = { content: { title: 'Changed' } }

describe('Permissions', () => {
  it('U {alpha: publisher} publishes alpha pages, not shared ones, reads shared under ~alpha, and is 403 under ~bravo and on users', async () => {
    expect(
      (await call('/~alpha/api/story/sty_sp_alpha/publish', U, { method: 'POST' })).status,
    ).toBe(200)
    // A shared row is outside alpha's scope for a write: it is not there.
    expect(
      (await call('/~alpha/api/story/sty_sp_shared/publish', U, { method: 'POST' })).status,
    ).toBe(404)
    // In shared's own scope U reads, and a read is not a publish.
    expect(
      (await call('/~shared/api/story/sty_sp_shared/publish', U, { method: 'POST' })).status,
    ).toBe(403)
    expect((await call('/~alpha/api/story/sty_sp_shared/document', U)).status).toBe(200)
    expect((await call('/~alpha/api/v1/documents/sty_sp_shared', U)).status).toBe(200)
    expect((await call('/~bravo/api/v1/documents/sty_sp_bravo', U)).status).toBe(403)
    expect((await call('/api/users', U)).status).toBe(403)
  })

  it('R {north: editor} edits alpha and north content, not bravo or shared', async () => {
    expect(
      (await call('/~alpha/api/v1/documents/sty_sp_alpha/content', R, put(CONTENT))).status,
    ).toBe(200)
    expect(
      (await call('/~north/api/v1/documents/sty_sp_north/content', R, put(CONTENT))).status,
    ).toBe(200)
    expect(
      (await call('/~bravo/api/v1/documents/sty_sp_bravo/content', R, put(CONTENT))).status,
    ).toBe(403)
    expect(
      (await call('/~shared/api/v1/documents/sty_sp_shared/content', R, put(CONTENT))).status,
    ).toBe(403)
    expect(
      (await call('/~alpha/api/v1/documents/sty_sp_shared/content', R, put(CONTENT))).status,
    ).toBe(404)
    // North's own row read from alpha, up the chain; written from alpha, not there.
    expect((await call('/~alpha/api/v1/documents/sty_sp_north', R)).status).toBe(200)
    expect(
      (await call('/~alpha/api/v1/documents/sty_sp_north/content', R, put(CONTENT))).status,
    ).toBe(404)
  })

  it('N {shared: publisher} publishes shared content, cannot edit alpha or list users', async () => {
    expect(
      (await call('/~shared/api/story/sty_sp_shared/publish', N, { method: 'POST' })).status,
    ).toBe(200)
    const alpha = await call('/~alpha/api/v1/documents/sty_sp_alpha/content', N, put(CONTENT))
    expect(alpha.status).toBe(403)
    expect((await errorOf(alpha)).message).toContain("'alpha'")
    expect((await call('/api/users', N)).status).toBe(403)
  })

  it("P {'*': admin} does everything", async () => {
    expect(
      (await call('/~bravo/api/v1/documents/sty_sp_bravo/content', P, put(CONTENT))).status,
    ).toBe(200)
    expect(
      (await call('/~shared/api/story/sty_sp_shared/publish', P, { method: 'POST' })).status,
    ).toBe(200)
    expect((await call('/api/users', P)).status).toBe(200)
  })

  it('a token bound to alpha creates in alpha, is 403 in bravo, reads shared, and reaches no platform route', async () => {
    const scoped = await call('/~alpha/api/v1/documents', tAlpha, body({ title: 'Scoped' }))
    expect(scoped.status).toBe(201)
    const implied = await call('/api/v1/documents', tAlpha, body({ title: 'Implied' }))
    expect(implied.status).toBe(201)
    for (const res of [scoped, implied]) {
      const { id } = (await res.json()) as { id: string }
      const row = await env.DB.prepare('select site_id from stories where id = ?').bind(id).first()
      expect(row).toEqual({ site_id: 'alpha' })
    }
    expect((await call('/~bravo/api/v1/documents', tAlpha, body({ title: 'No' }))).status).toBe(403)
    expect((await call('/~shared/api/v1/documents/sty_sp_shared', tAlpha)).status).toBe(200)
    // Up the chain is a read, never a write.
    expect((await call('/~shared/api/v1/documents', tAlpha, body({ title: 'No' }))).status).toBe(
      403,
    )
    for (const path of ['/api/tokens', '/api/users', '/api/sites']) {
      expect([path, (await call(path, tAlpha)).status]).toEqual([path, 403])
    }
    const sites = await call('/api/sites', tAlpha, body({ id: 'zulu', kind: 'site', name: 'Zulu' }))
    expect(sites.status).toBe(403)
  })

  it('refuses to mint a bound token with the admin scope', async () => {
    const res = await call(
      '/api/tokens',
      tPlatform,
      body({ name: 'x', scopes: ['admin'], site: 'alpha' }),
    )
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toMatch(/admin scope/)
    // Bound and without it is fine, and the binding is what it said.
    const ok = await call(
      '/api/tokens',
      tPlatform,
      body({ name: 'y', scopes: ['content:read'], site: 'alpha' }),
    )
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { row: { site: string } }).row.site).toBe('alpha')
    // A binding to nothing the registry holds is a typo, refused.
    const typo = await call(
      '/api/tokens',
      tPlatform,
      body({ name: 'z', scopes: ['content:read'], site: 'zulu' }),
    )
    expect(typo.status).toBe(400)
  })

  it('a token bound to north writes alpha, not bravo', async () => {
    expect(
      (await call('/~alpha/api/v1/documents/sty_sp_alpha/content', tNorth, put(CONTENT))).status,
    ).toBe(200)
    expect(
      (await call('/~bravo/api/v1/documents/sty_sp_bravo/content', tNorth, put(CONTENT))).status,
    ).toBe(403)
  })
})

/* -------------------------------------------------------- the registry --- */

describe('the registry is platform tier', () => {
  it('refuses a site admin of alpha, a shared publisher and a token bound to alpha with every scope', async () => {
    for (const who of [A, N, tAlpha, tAlphaAdmin]) {
      const res = await call('/api/sites', who, body({ id: 'zulu', kind: 'site', name: 'Zulu' }))
      expect(res.status).toBe(403)
    }
  })

  it('refuses to delete a site that owns stories', async () => {
    expect((await call('/api/sites/bravo', P, { method: 'DELETE' })).status).toBe(409)
  })

  it('deletes an empty site on which provider-set grants exist, and the grants go with it', async () => {
    const user = await createUser(env.DB, { email: 'sso@example.com', grants: { alpha: 'editor' } })
    await env.DB.prepare(
      `insert into site_roles (user_id, scope_id, role, role_from, created_at) values (?, 'echo', 'editor', 'oidc', 0)`,
    )
      .bind(user.id)
      .run()
    const res = await call('/api/sites/echo', P, { method: 'DELETE' })
    expect(res.status).toBe(200)
    // No foreign key names `scope_id`, so no cascade could have done this: the
    // delete's own batch did.
    const left = await env.DB.prepare(
      `select count(*) as n from site_roles where scope_id = 'echo'`,
    ).first()
    expect(left).toEqual({ n: 0 })
    // The rest of the person's grants are untouched.
    const kept = await env.DB.prepare('select scope_id from site_roles where user_id = ?')
      .bind(user.id)
      .all()
    expect(kept.results).toEqual([{ scope_id: 'alpha' }])
  })
})

/* ------------------------------------------------------------ the fence --- */

type Kind = 'story' | 'form' | 'share' | 'version'

/** The seeded row of each kind, per owning scope. */
const ROWS: Record<Kind, Record<'alpha' | 'bravo' | 'shared', string>> = {
  story: { alpha: 'sty_sp_alpha', bravo: 'sty_sp_bravo', shared: 'sty_sp_shared' },
  form: { alpha: 'frm_a1a1a1a1a1a1', bravo: 'frm_b0b0b0b0b0b0', shared: 'frm_5a5a5a5a5a5a' },
  // Filled in `beforeAll`: share ids are minted.
  share: { alpha: '', bravo: '', shared: '' },
  version: { alpha: 'ver_sp_alpha', bravo: 'ver_sp_bravo', shared: 'ver_sp_shared' },
}
const RESPONSES = {
  alpha: 'res_a1a1a1a1a1a1',
  bravo: 'res_b0b0b0b0b0b0',
  shared: 'res_5a5a5a5a5a5a',
}

/**
 * Mounted routes with an id parameter that are **not a content fence by design**:
 * the platform tier (users, tokens, the registry) and the caller's own account,
 * which name no scope; the public asset bytes (by key, "served, as today" on any
 * host, edge cases); sign-in's provider; the path-addressed v1 read, which is
 * `storyByPath` on the request's chain.
 */
const UNSCOPED_IDS = [
  'PATCH /api/users/:id',
  'DELETE /api/users/:id',
  'DELETE /api/users/:id/passkeys',
  'DELETE /api/tokens/:id',
  'PATCH /api/sites/:id',
  'PUT /api/sites/:id/hosts',
  'DELETE /api/sites/:id',
  'PATCH /api/me/passkeys/:id',
  'DELETE /api/me/passkeys/:id',
  'GET /asset/:key',
  'GET /login/:provider',
  'GET /login/:provider/callback',
  'GET /api/v1/documents/by-path/:path{.*}',
]

/**
 * **Deferred, and asserted exactly so the owning phase must empty it.** Spec 23's
 * phase 7 fences these (review finding 4): their rows' readers (`assets.ts`,
 * `asset-folders.ts`, `asset-tags.ts`, `redirects.ts`) do not yet select
 * `site_id`, and the public form submit is "a form in the submitting site's chain",
 * which needs the live host's site.
 */
const DEFERRED_IDS = [
  'GET /api/assets/:id',
  'PATCH /api/assets/:id',
  'DELETE /api/assets/:id',
  'GET /api/assets/:id/usage',
  'POST /api/assets/:id/describe',
  'PATCH /api/assets/folders/:id',
  'DELETE /api/assets/folders/:id',
  'PATCH /api/assets/tags/:id',
  'DELETE /api/assets/tags/:id',
  'DELETE /api/redirects/:from{.+}',
  'POST /f/:id',
]

/** Fenced, and tested by their own cases below rather than by the status walk:
 * the socket refuses with a close code, the editor page with a 404 page, and a
 * global's bare preview has no id in its path at all — the layer it shows is the
 * request's own scope's, so there is no other row for a URL to name. */
const FENCED_ELSEWHERE = ['GET /api/story/:id/socket', 'GET /edit/:id', 'GET /preview/global/:name']

describe('every id loader is a fence', () => {
  /**
   * `[method, path, reach, kind]` for each route that turns an id into a row. A
   * `read` route answers a row up the chain and 404s one outside it; a `write`
   * route 404s both. `kind` says which seeded row fills the path.
   *
   * **A form's responses are `write` even to read** (`routes/forms.ts`' `fenceForm`):
   * up the chain they would be every site's submissions to a shared form, which
   * spec 23's phase 7 scopes by submitting site.
   */
  const LOADERS: [string, string, 'read' | 'write', Kind][] = [
    ['GET', '/api/story/:id/document', 'read', 'story'],
    ['GET', '/api/story/:id/translation?locale=fr', 'read', 'story'],
    ['GET', '/api/story/:id/activity', 'read', 'story'],
    ['GET', '/api/story/:id/versions', 'read', 'story'],
    ['GET', '/api/documents/:id/usage', 'read', 'story'],
    ['GET', '/api/v1/documents/:id', 'read', 'story'],
    ['GET', '/api/v1/documents/:id/versions', 'read', 'story'],
    ['GET', '/api/versions/:versionId', 'read', 'version'],
    ['PATCH', '/api/stories/:id', 'write', 'story'],
    ['DELETE', '/api/stories/:id', 'write', 'story'],
    ['POST', '/api/stories/:id/duplicate', 'write', 'story'],
    ['POST', '/api/story/:id/publish', 'write', 'story'],
    ['POST', '/api/story/:id/unpublish', 'write', 'story'],
    ['POST', '/api/story/:id/versions', 'write', 'story'],
    ['POST', '/api/story/:id/schedule', 'write', 'story'],
    ['DELETE', '/api/story/:id/schedule?action=publish', 'write', 'story'],
    ['POST', '/api/story/:id/share', 'write', 'story'],
    ['PUT', '/api/v1/documents/:id/content', 'write', 'story'],
    ['PATCH', '/api/v1/documents/:id/fields', 'write', 'story'],
    ['PATCH', '/api/v1/documents/:id', 'write', 'story'],
    ['DELETE', '/api/v1/documents/:id', 'write', 'story'],
    ['POST', '/api/v1/documents/:id/publish', 'write', 'story'],
    ['POST', '/api/v1/documents/:id/versions', 'write', 'story'],
    ['POST', '/api/v1/documents/:id/unpublish', 'write', 'story'],
    ['POST', '/api/v1/documents/:id/duplicate', 'write', 'story'],
    ['POST', '/api/v1/documents/:id/restore', 'write', 'story'],
    ['DELETE', '/api/shares/:id', 'write', 'share'],
    ['GET', '/api/forms/:id', 'read', 'form'],
    ['GET', '/api/forms/:id/usage', 'read', 'form'],
    ['PATCH', '/api/forms/:id', 'write', 'form'],
    ['DELETE', '/api/forms/:id', 'write', 'form'],
    ['GET', '/api/forms/:id/responses', 'write', 'form'],
    ['GET', '/api/forms/:id/responses.csv', 'write', 'form'],
    ['GET', '/api/forms/:id/responses/:rid', 'write', 'form'],
    ['DELETE', '/api/forms/:id/responses/:rid', 'write', 'form'],
    ['POST', '/api/forms/:id/responses/delete', 'write', 'form'],
    ['GET', '/api/forms/:id/responses/:rid/file/:name', 'write', 'form'],
  ]

  const at = (path: string, kind: Kind, owner: 'bravo' | 'shared') => {
    const row = ROWS[kind][owner]
    return path
      .replace(':versionId', row)
      .replace(':id', row)
      .replace(':rid', RESPONSES[owner])
      .replace(':name', 'cv')
  }
  /** A body each route accepts, so what answers is the fence and not the validator. */
  const BODIES: Record<string, unknown> = {
    '/api/v1/documents/:id/content': { content: {} },
    '/api/v1/documents/:id/restore': { versionId: 'ver_nothing' },
    '/api/story/:id/schedule': { action: 'publish', at: Date.now() + 3_600_000 },
    '/api/forms/:id': { label: 'Changed' },
    '/api/forms/:id/responses/delete': { ids: [RESPONSES.bravo] },
  }
  const init = (method: string, path = ''): RequestInit =>
    method === 'GET' || method === 'DELETE'
      ? { method }
      : { method, body: JSON.stringify(BODIES[path] ?? {}) }

  it("404s another site's row on every loader, and a row above the scope on every write", async () => {
    const wrong: string[] = []
    for (const [method, path, reach, kind] of LOADERS) {
      const bravo = await call(`/~alpha${at(path, kind, 'bravo')}`, P, init(method, path))
      if (bravo.status !== 404) wrong.push(`${method} ${path} bravo → ${bravo.status}`)
      // Only a read may reach up the chain; a write above the scope is not there.
      if (reach === 'write') {
        const shared = await call(`/~alpha${at(path, kind, 'shared')}`, P, init(method, path))
        if (shared.status !== 404) wrong.push(`${method} ${path} shared → ${shared.status}`)
      }
    }
    expect(wrong).toEqual([])
    // Nothing the walk refused was acted on.
    const left = await env.DB.prepare(
      `select (select count(*) from forms where id = ?) as forms,
              (select count(*) from form_responses where id = ?) as responses,
              (select revoked_at from shares where id = ?) as revoked`,
    )
      .bind(ROWS.form.bravo, RESPONSES.bravo, ROWS.share.bravo)
      .first()
    expect(left).toEqual({ forms: 1, responses: 1, revoked: null })
  })

  it('reads a shared row up the chain on every read loader', async () => {
    const wrong: string[] = []
    for (const [method, path, reach, kind] of LOADERS) {
      if (reach !== 'read') continue
      const res = await call(`/~alpha${at(path, kind, 'shared')}`, U, init(method))
      if (res.status !== 200) wrong.push(`${method} ${path} → ${res.status}`)
    }
    expect(wrong).toEqual([])
  })

  it('reads and writes its own form and its responses', async () => {
    const own = `/~alpha/api/forms/${ROWS.form.alpha}`
    expect((await call(own, A)).status).toBe(200)
    expect((await call(`${own}/responses`, A)).status).toBe(200)
    expect((await call(`${own}/responses.csv`, A)).status).toBe(200)
  })

  /**
   * **Every mounted route that takes a row id is accounted for** (review finding 6):
   * fence-tested above, unscoped by design, or on the deferred list — and the
   * deferred list is asserted exactly, so the phase that fences one of them has to
   * move it into `LOADERS` for this to stay green.
   */
  it('accounts for every mounted route that takes an id', () => {
    const fenced = new Set(LOADERS.map(([method, path]) => `${method} ${path.split('?')[0]}`))
    const withId = WALKED.map(
      ({ method, path }) => `${method} ${path.slice('/folio'.length)}`,
    ).filter((key) => /\/:/.test(key))
    const unaccounted = withId.filter(
      (key) =>
        !fenced.has(key) &&
        !FENCED_ELSEWHERE.includes(key) &&
        !UNSCOPED_IDS.includes(key) &&
        !DEFERRED_IDS.includes(key),
    )
    expect(unaccounted).toEqual([])
    // Nothing is listed twice, and nothing listed is gone from the app.
    for (const key of [...UNSCOPED_IDS, ...DEFERRED_IDS, ...FENCED_ELSEWHERE]) {
      expect([key, withId.includes(key), fenced.has(key)]).toEqual([key, true, false])
    }
    expect(DEFERRED_IDS.filter((key) => UNSCOPED_IDS.includes(key))).toEqual([])
    // That is what makes the deferred list exact: an entry fenced into `LOADERS`
    // fails the line above until it leaves the list, and an unfenced route missing
    // from it fails `unaccounted`.
  })

  it('answers a batch by id within the chain only', async () => {
    const res = await call('/~alpha/api/stories?ids=sty_sp_alpha,sty_sp_bravo,sty_sp_shared', U)
    const { rows } = (await res.json()) as { rows: { id: string }[] }
    expect(rows.map((r) => r.id).sort()).toEqual(['sty_sp_alpha', 'sty_sp_shared'])
  })

  it('refuses a bulk selection naming a row outside the scope, whole', async () => {
    const res = await call(
      '/~alpha/api/bulk/publish',
      P,
      body({ selection: { ids: ['sty_sp_alpha', 'sty_sp_bravo'] } }),
    )
    expect(res.status).toBe(404)
  })

  it('404s the editor page for a row outside the chain', async () => {
    expect((await call('/~alpha/edit/sty_sp_bravo', P)).status).toBe(404)
    expect((await call('/~alpha/edit/sty_sp_shared', P)).status).toBe(200)
  })

  it("checks a layer's scope is in the chain before ensureSingleton creates it", async () => {
    const count = async (id: string) =>
      (
        await env.DB.prepare('select count(*) as n from stories where id = ?')
          .bind(id)
          .first<{ n: number }>()
      )?.n
    expect(
      (await call('/~alpha/api/v1/documents/sng_spSettings:bravo?status=draft', U)).status,
    ).toBe(404)
    expect(await count('sng_spSettings:bravo')).toBe(0)
    // A write to a layer above the scope is refused before any row exists.
    const shared = await call(
      '/~alpha/api/v1/documents/sng_spSettings:shared/content',
      U,
      put({ content: {} }),
    )
    expect(shared.status).toBe(404)
    expect(await count('sng_spSettings:shared')).toBe(0)
    // Its own layer is asked into existence, as a singleton always has been.
    expect(
      (await call('/~alpha/api/v1/documents/sng_spSettings:alpha?status=draft', U)).status,
    ).toBe(200)
    expect(await count('sng_spSettings:alpha')).toBe(1)
  })
})

describe("a global's bare preview", () => {
  const count = async (id: string) =>
    (
      await env.DB.prepare('select count(*) as n from stories where id = ?')
        .bind(id)
        .first<{ n: number }>()
    )?.n

  it("shows the request's own layer, and makes no layer that does not exist", async () => {
    // Alpha's layer was asked into existence above; bravo's never was.
    expect((await call('/~alpha/preview/global/spSettings', U)).status).toBe(200)
    expect((await call('/~alpha/preview/global/spSettings?mode=draft', U)).status).toBe(200)
    const missing = await call('/~bravo/preview/global/spSettings', P)
    expect(missing.status).toBe(404)
    expect(await count('sng_spSettings:bravo')).toBe(0)
    // No scope names no layer, and `default` is not conjured for anyone.
    expect((await call('/preview/global/spSettings', P)).status).toBe(404)
    expect(await count('sng_spSettings')).toBe(0)
  })

  it('is refused to a caller with no role on the scope, as any scoped route is', async () => {
    expect((await call('/~bravo/preview/global/spSettings', U)).status).toBe(403)
    expect(await count('sng_spSettings:bravo')).toBe(0)
  })
})

/* ------------------------------------------------------------ the socket --- */

describe('the story socket', () => {
  const open = (path: string, who: Record<string, string>) =>
    call(path, { ...who, upgrade: 'websocket' })

  it("carries the role on the story's own scope, so a site editor on a shared page is a viewer", async () => {
    forwarded.length = 0
    const own = await open('/~alpha/api/story/sty_sp_alpha/socket', U)
    expect(own.status).toBe(101)
    const shared = await open('/~alpha/api/story/sty_sp_shared/socket', U)
    expect(shared.status).toBe(101)
    expect(forwarded.map((identity) => identity?.role)).toEqual(['publisher', 'viewer'])
    own.webSocket?.accept()
    own.webSocket?.close()
    shared.webSocket?.accept()
    shared.webSocket?.close()
  })
})

/* ------------------------------------------------------- the pure rules --- */

describe('effective roles', () => {
  const registry: Registry = {
    sites: [
      { id: 'alpha', name: 'Alpha', group: 'north', status: 'live', hosts: [], preview: null },
      { id: 'bravo', name: 'Bravo', group: null, status: 'live', hosts: [], preview: null },
    ],
    groups: [{ id: 'north', name: 'North' }],
  }

  it('takes the highest of the scope, its group and *, and at least viewer up any chain', () => {
    expect(effectiveRole({ alpha: 'publisher' }, registry, 'alpha')).toBe('publisher')
    expect(effectiveRole({ alpha: 'publisher' }, registry, 'shared')).toBe('viewer')
    expect(effectiveRole({ alpha: 'publisher' }, registry, 'north')).toBe('viewer')
    expect(effectiveRole({ alpha: 'publisher' }, registry, 'bravo')).toBeNull()
    expect(effectiveRole({ north: 'editor' }, registry, 'alpha')).toBe('editor')
    expect(effectiveRole({ north: 'editor', alpha: 'viewer' }, registry, 'alpha')).toBe('editor')
    expect(effectiveRole({ shared: 'publisher' }, registry, 'shared')).toBe('publisher')
    // Nothing flows down for editing: a shared role is nothing on a site.
    expect(effectiveRole({ shared: 'publisher' }, registry, 'alpha')).toBeNull()
    expect(effectiveRole({ '*': 'viewer', alpha: 'admin' }, registry, 'bravo')).toBe('viewer')
    expect(effectiveRole({ '*': 'admin' }, EMPTY_REGISTRY, 'default')).toBe('admin')
  })

  it('may preview a site with READ_DRAFT on any scope of its chain', () => {
    expect(previewEligible({ shared: 'viewer' }, ['alpha', 'north', 'shared'])).toBe(true)
    expect(previewEligible({ north: 'editor' }, ['alpha', 'north', 'shared'])).toBe(true)
    expect(previewEligible({ bravo: 'admin' }, ['alpha', 'north', 'shared'])).toBe(false)
    expect(previewEligible({ '*': 'viewer' }, ['bravo', 'shared'])).toBe(true)
  })

  it('narrows a bound token to its reads up the chain, and to nothing beyond it', () => {
    const all = [...EVERY_SCOPE]
    expect(tokenScopesOn(all, null, registry, 'bravo')).toEqual(all)
    expect(tokenScopesOn(all, 'alpha', registry, 'alpha')).toEqual(all)
    expect(tokenScopesOn(all, 'north', registry, 'alpha')).toEqual(all)
    expect(tokenScopesOn(all, 'alpha', registry, 'shared')).toEqual([
      'content:read',
      'content:read:draft',
    ])
    expect(tokenScopesOn(['content:write'], 'alpha', registry, 'north')).toEqual([
      'content:read',
      'content:read:draft',
    ])
    expect(tokenScopesOn(all, 'alpha', registry, 'bravo')).toBeNull()
    expect(tokenScopesOn(all, 'shared', registry, 'alpha')).toBeNull()
  })
})

describe('allows() and the tiers', () => {
  const person = (role: UserActor['role'], grants?: Grants): UserActor => ({
    kind: 'user',
    id: 'usr_x',
    name: 'X',
    colour: '#000',
    role,
    session: 's',
    expiresAt: 0,
    ...(grants ? { grants } : {}),
  })
  const tokenOf = (site: string | null): TokenActor => ({
    kind: 'token',
    id: 't',
    name: 't',
    scopes: ['admin'],
    site,
  })

  it('answers exactly as before for an actor with one * grant, which is every actor with no sites', () => {
    for (const role of ['viewer', 'editor', 'publisher', 'admin'] as const) {
      for (const access of [READ, READ_DRAFT, EDIT, ADMIN, SCOPE_ADMIN]) {
        expect(allows(person(role, { '*': role }), access)).toBe(allows(person(role), access))
      }
    }
  })

  it('reads the * grant for the platform tier, never the effective role', () => {
    // A site admin under `~alpha`: effective admin, no `*` grant.
    expect(allows(person('admin', { alpha: 'admin' }), ADMIN)).toBe(false)
    expect(allows(person('admin', { alpha: 'admin' }), SCOPE_ADMIN)).toBe(true)
    expect(allows(person('viewer', { '*': 'admin' }), ADMIN)).toBe(true)
    expect(allows(tokenOf('alpha'), ADMIN)).toBe(false)
    expect(allows(tokenOf(null), ADMIN)).toBe(true)
    expect(allows(tokenOf('alpha'), SCOPE_ADMIN)).toBe(true)
  })

  it('lets a preview grant read and do nothing else', () => {
    const grant: GrantActor = {
      kind: 'grant',
      id: 'g',
      userId: 'usr_x',
      tokenId: null,
      name: 'X',
      site: 'alpha',
      expiresAt: 0,
    }
    expect(allows(grant, READ)).toBe(true)
    expect(allows(grant, READ_DRAFT)).toBe(true)
    expect(allows(grant, EDIT)).toBe(false)
    expect(allows(grant, ADMIN)).toBe(false)
    expect(allows(grant, SCOPE_ADMIN)).toBe(false)
  })
})

/* ------------------------------------------------------ review findings --- */

async function mcp(prefix: string, who: Record<string, string>, name: string, args: object) {
  const res = await folio.handle(
    new Request(`${BASE}${prefix}/mcp`, {
      method: 'POST',
      headers: {
        ...who,
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    env,
    createExecutionContext(),
  )
  if (!res) throw new Error('handle() answered null for /mcp')
  return { status: res.status, text: await res.text() }
}

describe('MCP is scoped', () => {
  it('answers site_required on a bare /mcp for a person, whatever their grants', async () => {
    for (const who of [U, P]) {
      const res = await mcp('', who, 'preview_document', { id: 'sty_sp_bravo' })
      expect(res.status).toBe(400)
      expect(JSON.parse(res.text).error.code).toBe('site_required')
    }
  })

  it('previews nothing outside the chain, on the scope or on a bound token', async () => {
    for (const [prefix, who] of [
      ['/~alpha', U],
      ['', tAlpha],
    ] as const) {
      const res = await mcp(prefix, who, 'preview_document', { id: 'sty_sp_bravo' })
      expect(res.text).toContain('Unknown document')
      expect(res.text).not.toContain('sp-bravo')
    }
    // Up the chain is a read, as everywhere.
    const shared = await mcp('/~alpha', U, 'preview_document', { id: 'sty_sp_shared' })
    expect(shared.text).toContain('sp-shared')
  })

  it("dispatches its tools on the request's scope", async () => {
    const own = await mcp('/~alpha', U, 'get_document', { id: 'sty_sp_alpha' })
    expect(own.text).toContain('sty_sp_alpha')
    expect(own.text).not.toContain('site_required')
    const other = await mcp('/~alpha', U, 'get_document', { id: 'sty_sp_bravo' })
    expect(other.text).toContain('Unknown document')
  })
})

describe('shares are scoped', () => {
  it("lists only the scope's own links", async () => {
    const res = await call('/~alpha/api/shares', U)
    const { shares } = (await res.json()) as { shares: { id: string }[] }
    expect(shares.map((s) => s.id)).toContain(ROWS.share.alpha)
    expect(shares.map((s) => s.id)).not.toContain(ROWS.share.bravo)
    expect(shares.map((s) => s.id)).not.toContain(ROWS.share.shared)
  })
})

describe('a parent outside the chain', () => {
  it('is a plain 404, never a 409 that names it; a parent up the chain keeps the 409', async () => {
    const bravo = await call(
      '/~alpha/api/stories',
      U,
      body({ title: 'x', parentId: 'sty_sp_bravo' }),
    )
    expect(bravo.status).toBe(404)
    expect(await bravo.text()).not.toContain('sty_sp_bravo')
    const move = await call('/~alpha/api/stories/sty_sp_alpha', P, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: 'sty_sp_bravo' }),
    })
    expect(move.status).toBe(404)
    const v1 = await call(
      '/~alpha/api/v1/documents',
      tAlpha,
      body({ title: 'x', parentId: 'sty_sp_bravo' }),
    )
    expect(v1.status).toBe(404)
    // Readable from alpha, so naming it tells the caller nothing new.
    const shared = await call(
      '/~alpha/api/stories',
      U,
      body({ title: 'x', parentId: 'sty_sp_shared' }),
    )
    expect(shared.status).toBe(409)
  })
})

describe('inviting on a multi-site deployment', () => {
  it('refuses an invitation that names neither role nor grants', async () => {
    const res = await call('/api/users', P, body({ email: 'nobody-yet@example.com' }))
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toContain('grants')
    const ok = await call(
      '/api/users',
      P,
      body({ email: 'site-editor@example.com', grants: { alpha: 'editor' } }),
    )
    expect(ok.status).toBe(201)
  })
})
