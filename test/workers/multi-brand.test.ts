import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { chain, layerSeed, type SiteRef } from '../../src/core/sites'
import type { FolioBindings, FolioBrand, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { createToken } from '../../src/server/auth/tokens'
import { envelope, FolioError } from '../../src/server/errors'
import { withActor, withBindings, withScope } from '../../src/server/middleware'
import { accessRoutes } from '../../src/server/routes/access'
import { siteRoutes } from '../../src/server/routes/sites'
import { createRuntime, type FolioRuntime } from '../../src/server/runtime'
import { SCOPE_HEADER, SITE_HEADER, SURFACE_HEADER, updateSite } from '../../src/server/sites'
import type { FolioEnv } from '../../src/server/types'

/**
 * Many brands in one deployment, phase 3 (`docs/specs/foundation/multi-brand.md`):
 * the brand core over one real D1 — the registry routes' brand rules (decision 4),
 * the chain that never leaves a brand and has no `shared` (decision 5), the fence
 * that keeps a row of no configured brand out of the snapshot, and construction
 * (decision 3). The routes that read a registry through `c.var.brand` are phase 4's,
 * and so is everything that renders; this file mounts the middleware and the
 * registry routes on their own for that reason.
 *
 * The brands collide on the block names `pageRoot` and `prose` and the type `page`,
 * as allaboutafrica and takeoffgo do. The registry: brand `allaboutafrica` has group
 * `east` holding `kenya`, and `default` (set by SQL, as `UPGRADING.md` says a host
 * does after `0013`); brand `takeoffgo` has `takeoffgo`, which holds a story; and
 * `orphan` is a row with no brand, `ghost` one of a brand nobody configured.
 */

const aaaRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: { title: text(), strap: text() },
  render: () => null,
})
const aaaProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { body: text() },
  render: () => null,
})
const aaaHeader = defineBlock({
  name: 'header',
  label: 'Header',
  fields: { tagline: text({ default: 'Karibu' }) },
  render: () => null,
})
const tgoRoot = defineBlock({
  name: 'pageRoot',
  label: 'Page',
  fields: { heading: text() },
  render: () => null,
})
const tgoProse = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { copy: text() },
  render: () => null,
})

const aaaTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
  { name: 'header', label: 'Header', kind: 'singleton', root: 'header' },
]
const tgoTypes: DocumentType[] = [
  { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
]

const brands: Record<string, FolioBrand<Cloudflare.Env>> = {
  allaboutafrica: {
    label: 'All About Africa',
    blocks: [aaaRoot, aaaProse, aaaHeader],
    types: aaaTypes,
    globals: ['header'],
  },
  takeoffgo: { label: 'Take Off Go', blocks: [tgoRoot, tgoProse], types: tgoTypes },
}

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const ADMIN = 'https://cms.example'

const config: FolioConfig<Cloudflare.Env> = {
  brands,
  sites: { admin: ADMIN },
  bindings,
  basePath: '/folio',
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
}

const rt: FolioRuntime = createRuntime(config)

/**
 * The middleware every Folio request passes, and the registry routes, in the order
 * `app.ts` mounts them, plus one probe that reports what `withScope` set. The
 * internal headers are written here the way `handle()` writes them.
 */
function mount(on: FolioRuntime, cfg: FolioConfig<Cloudflare.Env> = config) {
  const app = new Hono<FolioEnv<Cloudflare.Env>>().basePath('/folio')
  app.onError((err, c) =>
    err instanceof FolioError
      ? c.json(envelope(err), err.status)
      : c.json({ err: String(err) }, 500),
  )
  app.use('*', withBindings(cfg))
  app.use('*', withScope(on))
  app.use('*', withActor(on))
  app.get('/probe', (c) =>
    c.json({ scope: c.var.scope, brand: c.var.brand?.brand ?? null, has: c.var.brand !== null }),
  )
  app.route('/api', siteRoutes(on))
  app.route('/api', accessRoutes(on))
  return app
}

const app = mount(rt)

async function call(
  path: string,
  init: { method?: string; body?: unknown; scope?: string; site?: string } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json', ...(await auth()) })
  if (init.scope) headers.set(SCOPE_HEADER, init.scope)
  if (init.site) {
    headers.set(SITE_HEADER, init.site)
    headers.set(SURFACE_HEADER, 'live')
  }
  const res = await app.request(
    `${ADMIN}/folio${path}`,
    {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

let token: string | undefined
async function auth(): Promise<Record<string, string>> {
  token ??= (await createToken(env.DB, { name: 'platform', scopes: ['admin'] })).token
  return { authorization: `Bearer ${token}` }
}

const errorOf = (body: Record<string, unknown>) =>
  (body as { error?: { code: string; message: string } }).error

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("update sites set brand = 'allaboutafrica' where id = 'default'"),
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values
         ('east', 'group', 'East', null, null, null, 'allaboutafrica', 0, 0),
         ('kenya', 'site', 'Kenya', 'east', 'live', null, 'allaboutafrica', 0, 0),
         ('takeoffgo', 'site', 'Take Off Go', null, 'live', null, 'takeoffgo', 0, 0),
         ('orphan', 'site', 'Orphan', null, 'live', null, null, 0, 0),
         ('ghost', 'site', 'Ghost', null, 'live', null, 'retired', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('kenya.example', 'kenya'), ('takeoffgo.example', 'takeoffgo'),
         ('orphan.example', 'orphan')`,
    ),
    env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
       values ('sty_tgo_home', 'page', null, 'home', 'home', 'a0', 'Home', 1, 'takeoffgo')`,
    ),
  ])
  rt.sites?.drop()
})

/* ------------------------------------------------------------ construction --- */

describe('construction', () => {
  it('refuses through createFolio exactly as through the runtime', () => {
    const { sites: _sites, ...noSites } = config
    expect(() => createFolio(noSites as FolioConfig<Cloudflare.Env>)).toThrow(
      /'brands' needs 'sites'/,
    )
    expect(() =>
      createFolio({ ...config, blocks: [aaaRoot] } as unknown as FolioConfig<Cloudflare.Env>),
    ).toThrow(/'blocks' belongs to a brand beside 'brands'/)
    expect(() =>
      createFolio({
        ...config,
        brands: {
          ...brands,
          takeoffgo: {
            ...brands.takeoffgo!,
            migrations: [{ id: '0001-x', description: 'x', up: () => [] }],
          },
        },
      }),
    ).toThrow(/brand 'takeoffgo': migration id '0001-x' must start with its brand/)
    expect(() =>
      createFolio({
        ...config,
        assets: { admin: '/a.js', brands: { allaboutafrica: { preview: '/p.js' } } },
      }),
    ).toThrow(/'assets.brands' must name exactly the brands/)
  })

  it('builds one brand runtime per brand, each with its own pageRoot and prose', () => {
    expect([...rt.brands.keys()]).toEqual(['allaboutafrica', 'takeoffgo'])
    expect(Object.keys(rt.brands.get('allaboutafrica')!.schema.pageRoot!.fields)).toEqual([
      'title',
      'strap',
    ])
    expect(Object.keys(rt.brands.get('takeoffgo')!.schema.pageRoot!.fields)).toEqual(['heading'])
  })
})

/* ---------------------------------------------------------------- registry --- */

describe('the registry routes under brands (decision 4)', () => {
  it('lists every row with its brand, the ones that serve nothing included', async () => {
    const listed = await call('/api/sites')
    const sites = listed.body.sites as SiteRef[]
    const brandOf = (id: string) => sites.find((s) => s.id === id)?.brand
    expect(brandOf('kenya')).toBe('allaboutafrica')
    expect(brandOf('orphan')).toBeNull()
    expect(brandOf('ghost')).toBe('retired')
    expect(listed.body.shared).toBe(false)
  })

  it('requires a brand on create, for a site and for a group', async () => {
    const site = await call('/api/sites', {
      method: 'POST',
      body: { id: 'uganda', kind: 'site', name: 'Uganda' },
    })
    expect(site.status).toBe(400)
    expect(errorOf(site.body)?.message).toMatch(/brand is required/)
    const group = await call('/api/sites', {
      method: 'POST',
      body: { id: 'west', kind: 'group', name: 'West' },
    })
    expect(group.status).toBe(400)
  })

  it('refuses a brand nobody configured, on create and on edit', async () => {
    const created = await call('/api/sites', {
      method: 'POST',
      body: { id: 'uganda', kind: 'site', name: 'Uganda', brand: 'retired' },
    })
    expect(created.status).toBe(400)
    expect(errorOf(created.body)?.message).toMatch(/No brand 'retired'/)
    const edited = await call('/api/sites/kenya', { method: 'PATCH', body: { brand: 'nobody' } })
    expect(edited.status).toBe(400)
  })

  it('creates a site and a group with a configured brand', async () => {
    const group = await call('/api/sites', {
      method: 'POST',
      body: { id: 'tgo-group', kind: 'group', name: 'TG', brand: 'takeoffgo' },
    })
    expect(group).toEqual({
      status: 201,
      body: { id: 'tgo-group', name: 'TG', brand: 'takeoffgo' },
    })
    const site = await call('/api/sites', {
      method: 'POST',
      body: { id: 'tgo-au', kind: 'site', name: 'TG AU', group: 'tgo-group', brand: 'takeoffgo' },
    })
    expect(site.status).toBe(201)
    expect(site.body.brand).toBe('takeoffgo')
    const row = await env.DB.prepare("select brand from sites where id = 'tgo-au'").first()
    expect(row).toEqual({ brand: 'takeoffgo' })
  })

  it('refuses a site joining a group of another brand: 400, on create and on edit', async () => {
    const created = await call('/api/sites', {
      method: 'POST',
      body: { id: 'rwanda', kind: 'site', name: 'Rwanda', group: 'east', brand: 'takeoffgo' },
    })
    expect(created.status).toBe(400)
    expect(errorOf(created.body)?.message).toMatch(/Group 'east' is brand 'allaboutafrica'/)
    const joined = await call('/api/sites/takeoffgo', { method: 'PATCH', body: { group: 'east' } })
    expect(joined.status).toBe(400)
    // Nothing was written.
    const row = await env.DB.prepare("select group_id from sites where id = 'takeoffgo'").first()
    expect(row).toEqual({ group_id: null })
  })

  it('refuses a brand change on a scope that holds a story: 409', async () => {
    const res = await call('/api/sites/takeoffgo', {
      method: 'PATCH',
      body: { brand: 'allaboutafrica' },
    })
    expect(res.status).toBe(409)
    expect(errorOf(res.body)).toMatchObject({ code: 'conflict' })
    expect(errorOf(res.body)?.message).toMatch(/still owns stories/)
    const row = await env.DB.prepare("select brand from sites where id = 'takeoffgo'").first()
    expect(row).toEqual({ brand: 'takeoffgo' })
  })

  it('refuses a brand change on a group that has sites: 409', async () => {
    const res = await call('/api/sites/east', { method: 'PATCH', body: { brand: 'takeoffgo' } })
    expect(res.status).toBe(409)
    expect(errorOf(res.body)?.message).toMatch(/still has sites/)
  })

  it('refuses a brand change when a story lands between any probe and the write', async () => {
    // A concurrent create, simulated: a story is inserted just before the batch
    // that carries the brand's \`update\` runs. A probe made before it saw an empty
    // scope; only a check inside the update itself sees the story.
    const created = await call('/api/sites', {
      method: 'POST',
      body: { id: 'zambia', kind: 'site', name: 'Zambia', brand: 'allaboutafrica' },
    })
    expect(created.status).toBe(201)
    let pending: string[] = []
    const racing = {
      prepare: (sql: string) => {
        pending.push(sql)
        return env.DB.prepare(sql)
      },
      batch: async (statements: D1PreparedStatement[]) => {
        if (pending.some((sql) => sql.trim().startsWith('update sites set'))) {
          await env.DB.prepare(
            `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
             values ('sty_zm_race', 'page', null, 'race', 'race', 'a0', 'Race', 1, 'zambia')`,
          ).run()
        }
        pending = []
        return env.DB.batch(statements)
      },
    }
    const registry = await rt.sites!.fresh(env)
    await expect(
      updateSite(
        racing as unknown as Parameters<typeof updateSite>[0],
        registry,
        'zambia',
        { brand: 'takeoffgo' },
        {
          sites: rt.sites!,
          route: rt.route,
          brands: rt.sites!.brands,
        },
      ),
    ).rejects.toMatchObject({ status: 409 })
    const row = await env.DB.prepare("select brand from sites where id = 'zambia'").first()
    expect(row).toEqual({ brand: 'allaboutafrica' })
  })

  it('changes the brand of an empty site, which then leaves its old chain', async () => {
    const created = await call('/api/sites', {
      method: 'POST',
      body: { id: 'tanzania', kind: 'site', name: 'Tanzania', brand: 'allaboutafrica' },
    })
    expect(created.status).toBe(201)
    const moved = await call('/api/sites/tanzania', {
      method: 'PATCH',
      body: { brand: 'takeoffgo', group: 'tgo-group' },
    })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ brand: 'takeoffgo', group: 'tgo-group' })
    expect((await call('/probe', { scope: 'tanzania' })).body.brand).toEqual({
      id: 'takeoffgo',
      label: 'Take Off Go',
    })
  })
})

/* ------------------------------------------------------------------ chain --- */

describe('a chain never crosses a brand, and there is no shared (decision 5)', () => {
  it('answers ~shared with 404 No site or group', async () => {
    const res = await call('/probe', { scope: 'shared' })
    expect(res.status).toBe(404)
    expect(errorOf(res.body)?.message).toBe("No site or group 'shared'")
  })

  it('still answers ~shared on a single-brand multi-site deployment', async () => {
    const single: FolioConfig<Cloudflare.Env> = {
      blocks: [aaaRoot, aaaProse, aaaHeader],
      types: aaaTypes,
      sites: { admin: ADMIN },
      bindings,
      basePath: '/folio',
      auth: config.auth,
      route: config.route,
    }
    const res = await mount(createRuntime(single), single).request(
      `${ADMIN}/folio/probe`,
      { headers: { [SCOPE_HEADER]: 'shared' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scope: 'shared', brand: null, has: true })
  })

  it('stops a site’s chain at its group, and a group’s at itself', async () => {
    const registry = await rt.sites!.registry(env)
    expect(registry.shared).toBe(false)
    expect(chain(registry, 'kenya')).toEqual(['kenya', 'east'])
    expect(chain(registry, 'east')).toEqual(['east'])
    expect(chain(registry, 'default')).toEqual(['default'])
  })

  it('skips a group of another brand for a row SQL wrote', async () => {
    await env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at)
       values ('sneaky', 'site', 'Sneaky', 'east', 'live', null, 'takeoffgo', 0, 0)`,
    ).run()
    rt.sites!.drop()
    const registry = await rt.sites!.registry(env)
    expect(chain(registry, 'sneaky')).toEqual(['sneaky'])
    await env.DB.prepare("delete from sites where id = 'sneaky'").run()
    rt.sites!.drop()
  })

  it('seeds a global layer on a site with no group, and on a group, in full', async () => {
    const registry = await rt.sites!.registry(env)
    expect(layerSeed(registry, 'default')).toBe('full')
    expect(layerSeed(registry, 'east')).toBe('full')
    expect(layerSeed(registry, 'kenya')).toBe('bare')

    const aaa = rt.brands.get('allaboutafrica')!
    const story = (scope: string) => ({ id: `sng_header:${scope}`, type: 'header', title: 'H' })
    const rootData = (doc: Doc) => doc.bloks[doc.root]?.data
    // The default of the brand's declared field is what a bottom layer starts from.
    expect(rootData(aaa.seedFor(story('default'), registry))).toEqual({ tagline: 'Karibu' })
    expect(rootData(aaa.seedFor(story('east'), registry))).toEqual({ tagline: 'Karibu' })
    expect(rootData(aaa.seedFor(story('kenya'), registry))).toEqual({})
    // Without the registry a layer's seed is not guessed.
    expect(() => aaa.seedFor(story('kenya'))).toThrow(/seeds by its chain/)
    // Not a layer: the id alone answers.
    expect(rootData(aaa.seedFor({ id: 'sty_x', type: 'page', title: 'X' }))).toMatchObject({
      title: 'X',
    })
  })
})

/* ------------------------------------------------------------------ fence --- */

describe('the fence: a row of no configured brand serves nothing', () => {
  it('leaves null-brand and unconfigured-brand rows out of the snapshot', async () => {
    const registry = await rt.sites!.registry(env)
    const ids = registry.sites.map((s) => s.id)
    expect(ids).toContain('kenya')
    expect(ids).toContain('takeoffgo')
    expect(ids).not.toContain('orphan')
    expect(ids).not.toContain('ghost')
    expect(registry.sites.every((s) => s.brand !== null)).toBe(true)
  })

  it('answers ~<scope> of such a row with 404, as an unknown scope', async () => {
    for (const scope of ['orphan', 'ghost', 'zulu']) {
      const res = await call('/probe', { scope })
      expect(res.status, scope).toBe(404)
      expect(errorOf(res.body)?.message).toBe(`No site or group '${scope}'`)
    }
  })

  it('sets c.var.brand from the scope, else the gated site, and never a default', async () => {
    expect((await call('/probe', { scope: 'kenya' })).body).toEqual({
      scope: 'kenya',
      brand: { id: 'allaboutafrica', label: 'All About Africa' },
      has: true,
    })
    expect((await call('/probe', { site: 'takeoffgo' })).body.brand).toEqual({
      id: 'takeoffgo',
      label: 'Take Off Go',
    })
    // No scope and no site: no brand at all, not the first one.
    expect((await call('/probe')).body).toEqual({ scope: null, brand: null, has: false })
    // A site header naming a row the snapshot left out is no brand either.
    expect((await call('/probe', { site: 'orphan' })).body.has).toBe(false)
  })

  it('refuses a brand’s render or query for another brand’s site, or for none', async () => {
    const registry = await rt.sites!.registry(env)
    const tango = registry.sites.find((s) => s.id === 'takeoffgo')!
    const aaa = rt.brands.get('allaboutafrica')!
    const b = { ...bindings(env), db: env.DB }
    await expect(
      aaa.resolve(b, undefined, {
        site: { site: tango, surface: 'live', chain: chain(registry, 'takeoffgo') },
      }),
    ).rejects.toThrow(/brand 'allaboutafrica' cannot resolve site 'takeoffgo'/)
    await expect(aaa.resolve(b)).rejects.toThrow(/cannot resolve with no site/)
    await expect(aaa.query(b, { type: 'page' }, ['takeoffgo'], tango)).rejects.toThrow(
      /cannot query site 'takeoffgo'/,
    )
  })
})

/* ----------------------------------------------------------- credentials --- */

describe('a grant or a token binding names only a scope the snapshot serves', () => {
  it('refuses to bind a token to shared, or to a row of no configured brand', async () => {
    for (const site of ['shared', 'orphan', 'ghost']) {
      const res = await call('/api/tokens', {
        method: 'POST',
        body: { name: `t-${site}`, scopes: ['content:read'], site },
      })
      expect(res.status, site).toBe(400)
      expect(errorOf(res.body)?.message).toBe(`site names '${site}', which is not a site or group`)
    }
    const ok = await call('/api/tokens', {
      method: 'POST',
      body: { name: 't-kenya', scopes: ['content:read'], site: 'kenya' },
    })
    expect(ok.status).toBe(201)
  })

  it('refuses a grant on shared, or on a row of no configured brand', async () => {
    for (const scope of ['shared', 'orphan', 'ghost']) {
      const res = await call('/api/users', {
        method: 'POST',
        body: { email: `${scope}@x.example`, grants: { [scope]: 'editor' } },
      })
      expect(res.status, scope).toBe(400)
      expect(errorOf(res.body)?.message).toBe(
        `grants names '${scope}', which is not a site or group`,
      )
    }
    const ok = await call('/api/users', {
      method: 'POST',
      body: { email: 'kenya@x.example', grants: { kenya: 'editor' } },
    })
    expect(ok.status).toBe(201)
  })
})
