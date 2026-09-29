import { createExecutionContext, env } from 'cloudflare:test'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { blocks, collection, defineBlock, multilink, reference, text } from '../../src/core'
import { toRegistry, toSchemaIndex } from '../../src/core/block'
import type { Doc, Json } from '../../src/core/doc'
import { layerStates } from '../../src/core/layers'
import { fieldValue } from '../../src/core/locales'
import type { Mutation } from '../../src/core/mutations'
import type { Resolution } from '../../src/core/resolve'
import type { DocumentType } from '../../src/core/schema'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { createToken } from '../../src/server/auth/tokens'
import { cachePurgeHooks } from '../../src/server/cache-purge'
import { rethrow } from '../../src/server/errors'
import { requireScope } from '../../src/server/middleware'
import { createRuntime, type FolioRuntime } from '../../src/server/runtime'
import { createStory, deleteStoryStatement } from '../../src/server/stories'
import type { FolioEnv } from '../../src/server/types'

/**
 * Many sites in one deployment, phase 2 (`docs/specs/foundation/multi-site.md`):
 * the registry and the status gate for anonymous requests, the `~<scope>` segment
 * and the internal headers, isolation, the fallback walk with its redirects and
 * root rules, the served set, and `folio.settings` over a hand-built resolution.
 *
 * Everything is seeded by SQL — registry rows, stories, forks — because the fork
 * route is phase 7's and layer loading is phase 4's. Nothing here needs a grant
 * (phase 5) or a purge (phase 6).
 *
 * The registry: group `north`; `alpha` (in north, live, `alpha.example`, preview
 * `https://preview.alpha.example`); `bravo` (live, `bravo.example`); `gamma` (in
 * north, draft, `gamma.example`, preview `https://preview.gamma.example`); and the
 * migration's own `default` row.
 */

const page = defineBlock({
  name: 'msPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title' }),
    featured: reference({ label: 'Featured' }),
    next: multilink({ label: 'Next' }),
    posts: collection({ type: 'msPost', defaultOrder: { field: 'title', dir: 'asc' } }),
  },
  render: () => null,
})

const post = defineBlock({
  name: 'msPost',
  label: 'Post',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

const theme = defineBlock({
  name: 'msTheme',
  label: 'Theme',
  fields: {
    primary: text({ label: 'Primary' }),
    radius: text({ label: 'Radius', default: 'rounded' }),
  },
  render: () => null,
})

const link = defineBlock({
  name: 'msLink',
  label: 'Link',
  fields: { label: text({ label: 'Label' }) },
  render: () => null,
})

const settingsRoot = defineBlock({
  name: 'msSettingsRoot',
  label: 'Site settings',
  fields: {
    tagline: text({ label: 'Tagline' }),
    theme: blocks({ label: 'Theme', allow: ['msTheme'], max: 1 }),
    nav: blocks({ label: 'Navigation', allow: ['msLink'] }),
  },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'msPage', label: 'Page', kind: 'page', root: 'msPage', default: true },
  { name: 'msPost', label: 'Post', kind: 'page', root: 'msPost' },
  { name: 'msSettings', label: 'Site settings', kind: 'singleton', root: 'msSettingsRoot' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const ADMIN = 'https://cms.example'

function build(over: Partial<FolioConfig<Cloudflare.Env>> = {}) {
  return createFolio<Cloudflare.Env>({
    blocks: [page, post, theme, link, settingsRoot],
    types,
    bindings,
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
    // Absolute on the site's first live host, as `validateSites` requires, and
    // today's relative URL when there is no site.
    route: (p, _locale, site) =>
      site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
    sites: { admin: ADMIN, settings: 'msSettings' },
    ...over,
  })
}

const folio = build()

const call = (url: string, init?: RequestInit, on = folio) =>
  on.handle(new Request(url, init), env, createExecutionContext())

const readerAt = (url: string, on = folio) => on.reader(env, new Request(url))

function rootDoc(type: string, data: Record<string, Json>): Doc {
  return {
    root: 'r0',
    bloks: { r0: { uid: 'r0', type, parent: null, slot: null, order: 'a0', data } },
  }
}

/** A story row in a scope, published unless told otherwise. */
async function row(
  id: string,
  site: string,
  path: string,
  opts: {
    type?: string
    parent?: string | null
    state?: 'live' | 'draft' | 'unpublished'
    data?: Record<string, Json>
  } = {},
) {
  const type = opts.type ?? 'msPage'
  const state = opts.state ?? 'live'
  const doc = rootDoc(type, { title: id, ...opts.data })
  const slug = path.split('/').pop() ?? ''
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at, unpublished_at)
     values (?, ?, ?, ?, ?, 'a0', ?, 1, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      opts.parent ?? null,
      slug,
      path,
      id,
      site,
      state === 'live' ? JSON.stringify(doc) : null,
      state === 'live' ? 2 : null,
      state === 'unpublished' ? 3 : null,
    )
    .run()
  return doc
}

async function redirect(site: string, from: string, to: string) {
  await env.DB.prepare(
    `insert into redirects (from_path, to_path, status, source, created_at, site_id)
     values (?, ?, 301, 'manual', 0, ?)`,
  )
    .bind(from, to, site)
    .run()
}

async function adminToken(): Promise<Record<string, string>> {
  const { token } = await createToken(env.DB, { name: 'platform', scopes: ['admin'] })
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0),
         ('gamma', 'site', 'Gamma', 'north', 'draft', 'https://preview.gamma.example', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('alpha.example', 'alpha'), ('bravo.example', 'bravo'), ('gamma.example', 'gamma')`,
    ),
  ])
  await row('sty_ms_alpha_post', 'alpha', 'alpha-post', {
    type: 'msPost',
    data: { title: 'Common alpha' },
  })
  await row('sty_ms_bravo_post', 'bravo', 'bravo-post', {
    type: 'msPost',
    data: { title: 'Common bravo' },
  })
  await row('sty_ms_shared_post', 'shared', 'shared-post', {
    type: 'msPost',
    data: { title: 'Common shared' },
  })
  await row('sty_ms_bravo_about', 'bravo', 'about', { data: { title: 'Bravo about' } })
  await row('sty_ms_alpha_about', 'alpha', 'about', {
    data: {
      title: 'Alpha about',
      // Another site's ids: both must resolve exactly like deleted ones.
      featured: 'sty_ms_bravo_post',
      next: { kind: 'story', id: 'sty_ms_bravo_about' },
    },
  })
  await row('sty_ms_gamma_welcome', 'gamma', 'welcome')
})

/* ------------------------------------------------ registry and status --- */

describe('the gate, for an anonymous request', () => {
  it('answers the admin origin, a site’s asset on its live host, and nothing else there', async () => {
    expect((await call(`${ADMIN}/folio/api/schema`))?.status).toBe(200)
    expect(await call('https://alpha.example/folio/api/schema')).toBeNull()
    expect(await call('https://alpha.example/folio/edit')).toBeNull()
    expect(await call('https://alpha.example/folio/api/v1/documents')).toBeNull()
    // The two things a live host answers: an asset's bytes, and a form submit.
    expect(await call('https://alpha.example/folio/asset/nothing.png')).not.toBeNull()
    expect(
      await call('https://alpha.example/folio/f/frm_nothing', { method: 'POST' }),
    ).not.toBeNull()
    // The host's own routes are never Folio's.
    expect(await call('https://alpha.example/about')).toBeNull()
  })

  it('answers the preview-origin surface only on a preview origin', async () => {
    expect(await call('https://preview.alpha.example/folio/share?t=nothing')).not.toBeNull()
    expect(await call('https://alpha.example/folio/share?t=nothing')).toBeNull()
    expect(await call('https://preview.alpha.example/folio/api/schema')).toBeNull()
  })

  it('makes a draft site’s hosts the host’s 404, and cacheProps {} for both', async () => {
    expect(await call('https://gamma.example/folio/asset/x.png')).toBeNull()
    expect(await readerAt('https://gamma.example/welcome').site()).toBeNull()
    expect(await readerAt('https://gamma.example/welcome').page('welcome')).toBeNull()
    expect(await readerAt('https://preview.gamma.example/welcome').page('welcome')).toBeNull()
    expect(await folio.cacheProps(new Request('https://gamma.example/welcome'), env)).toEqual({})
    expect(
      await folio.cacheProps(new Request('https://preview.gamma.example/welcome'), env),
    ).toEqual({})
    // The paths that must work before anybody holds a grant are admitted there.
    expect(await call('https://preview.gamma.example/folio/asset/x.png')).not.toBeNull()
  })

  it('answers no site for a host nobody registered', async () => {
    expect(await call('https://nobody.example/folio/asset/x.png')).toBeNull()
    expect(await readerAt('https://nobody.example/about').page('about')).toBeNull()
    expect(await folio.cacheProps(new Request('https://nobody.example/'), env)).toEqual({})
    expect(await folio.cacheProps(new Request(`${ADMIN}/folio/edit`), env)).toEqual({})
  })

  it('still gates whatever a custom resolver chooses', async () => {
    for (const answer of ['north', 'gamma', 'shared']) {
      const custom = build({ sites: { admin: ADMIN, resolve: () => answer } })
      expect(await readerAt('https://alpha.example/about', custom).site()).toBeNull()
      expect(await readerAt('https://alpha.example/about', custom).page('about')).toBeNull()
    }
    const toAlpha = build({ sites: { admin: ADMIN, resolve: () => 'alpha' } })
    expect((await readerAt('https://anything.example/about', toAlpha).site())?.id).toBe('alpha')
  })
})

describe('the admin origin comes first', () => {
  it('stays reachable when a row written by SQL claims its host', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at)
         values ('hotel', 'site', 'Hotel', null, 'live', 'https://cms.example', 0, 0)`,
      ),
      env.DB.prepare(`insert into site_hosts (host, site_id) values ('cms.example', 'hotel')`),
    ])
    try {
      // A fresh instance, so its snapshot is read after the rows landed.
      const fresh = build()
      expect((await call(`${ADMIN}/folio/api/schema`, undefined, fresh))?.status).toBe(200)
      expect(await fresh.cacheProps(new Request(`${ADMIN}/folio/edit`), env)).toEqual({})
    } finally {
      await env.DB.batch([
        env.DB.prepare(`delete from site_hosts where site_id = 'hotel'`),
        env.DB.prepare(`delete from sites where id = 'hotel'`),
      ])
    }
  })
})

describe('the scope segment and the internal headers', () => {
  it('strips ~<scope> on the admin origin', async () => {
    expect((await call(`${ADMIN}/folio/~alpha/api/schema`))?.status).toBe(200)
    expect((await call(`${ADMIN}/folio/~shared/api/schema`))?.status).toBe(200)
  })

  it('answers 404 for a scope nobody registered', async () => {
    expect((await call(`${ADMIN}/folio/~zulu/api/schema`))?.status).toBe(404)
  })

  it('deletes a client-sent internal header before anything reads it', async () => {
    // Were the header believed, `withScope` would 404 this request for naming a
    // scope nobody registered.
    const res = await call(`${ADMIN}/folio/api/schema`, {
      headers: { 'x-folio-scope': 'zulu', 'x-folio-site': 'alpha', 'x-folio-surface': 'preview' },
    })
    expect(res?.status).toBe(200)
  })

  it('answers 400 site_required for a scoped route that named no scope', async () => {
    const app = new Hono<FolioEnv<Cloudflare.Env>>()
    app.use('*', async (c, next) => {
      c.set('scope', c.req.query('scope') ?? null)
      await next()
    })
    const rt = { sites: {}, base: '/folio' } as FolioRuntime
    app.get('/x', requireScope<Cloudflare.Env>(rt), (c) => c.text('ok'))
    const refused = await app.request('/x', {}, env)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'site_required' } })
    expect((await app.request('/x?scope=alpha', {}, env)).status).toBe(200)
    // With no `sites` there is one scope, so nothing to require.
    const single = new Hono<FolioEnv<Cloudflare.Env>>()
    single.use('*', async (c, next) => {
      c.set('scope', null)
      await next()
    })
    single.get(
      '/x',
      requireScope<Cloudflare.Env>({ sites: null, base: '/folio' } as FolioRuntime),
      (c) => c.text('ok'),
    )
    expect((await single.request('/x', {}, env)).status).toBe(200)
  })
})

describe('readers need a request or a site', () => {
  const NEEDS = /folio\.reader\(env, req \| \{ site \}\)/

  it('throws for folio.reader(env) and every one-shot read', async () => {
    expect(() => folio.reader(env)).toThrow(NEEDS)
    await expect(async () => folio.published(env, 'about')).rejects.toThrow(NEEDS)
    await expect(async () => folio.stories(env)).rejects.toThrow(NEEDS)
    await expect(async () => folio.resolve(env)).rejects.toThrow(NEEDS)
  })

  it('reads a named site as its live surface', async () => {
    const alpha = folio.reader(env, { site: 'alpha' })
    expect((await alpha.site())?.id).toBe('alpha')
    expect((await alpha.page('about'))?.story.id).toBe('sty_ms_alpha_about')
    // A draft site, a group and an unknown id are no site: nothing to read.
    for (const site of ['gamma', 'north', 'zulu']) {
      const none = folio.reader(env, { site })
      expect(await none.site()).toBeNull()
      expect(await none.page('about')).toBeNull()
      expect(await none.stories()).toEqual([])
    }
  })
})

describe('status changes through the registry', () => {
  it('opens a site’s preview origin at preview and its live hosts at live, dropping the snapshot', async () => {
    const headers = await adminToken()
    const patch = (status: string) =>
      call(`${ADMIN}/folio/api/sites/gamma`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status }),
      })

    expect((await patch('preview'))?.status).toBe(200)
    // The isolate that wrote answers the new status on its next request.
    expect(
      (await readerAt('https://preview.gamma.example/welcome').page('welcome'))?.story.id,
    ).toBe('sty_ms_gamma_welcome')
    expect(await readerAt('https://gamma.example/welcome').page('welcome')).toBeNull()

    expect((await patch('live'))?.status).toBe(200)
    expect((await readerAt('https://gamma.example/welcome').page('welcome'))?.story.id).toBe(
      'sty_ms_gamma_welcome',
    )
    expect(await folio.cacheProps(new Request('https://gamma.example/welcome'), env)).toEqual({
      site: 'gamma',
      surface: 'live',
    })

    expect((await patch('draft'))?.status).toBe(200)
    expect(await readerAt('https://gamma.example/welcome').page('welcome')).toBeNull()
  })
})

describe('the registry routes', () => {
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await call(`${ADMIN}/folio/api${path}`, {
      method,
      headers: await adminToken(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res?.status, body: (await res?.json()) as Record<string, unknown> }
  }

  it('creates a site with every hostname normalised, and lists it', async () => {
    const created = await send('POST', '/sites', {
      id: 'india',
      kind: 'site',
      name: 'India',
      group: 'north',
      hosts: ['INDIA.example', 'www.india.example:443'],
      preview: 'https://Preview.India.example:443',
    })
    expect(created).toEqual({
      status: 201,
      body: {
        id: 'india',
        name: 'India',
        group: 'north',
        status: 'draft',
        hosts: ['india.example', 'www.india.example'],
        preview: 'https://preview.india.example',
      },
    })
    const listed = await send('GET', '/sites')
    expect((listed.body.sites as { id: string }[]).map((s) => s.id)).toContain('india')
  })

  it('refuses a hostname already claimed on either column, whatever its spelling', async () => {
    await send('POST', '/sites', { id: 'juliet', kind: 'site', name: 'J', hosts: ['P.EXAMPLE'] })
    const second = await send('POST', '/sites', {
      id: 'kilo',
      kind: 'site',
      name: 'K',
      preview: 'https://p.example:443',
    })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: { code: 'conflict' } })
  })

  it('refuses a preview origin on the admin origin’s host', async () => {
    const res = await send('POST', '/sites', {
      id: 'lima',
      kind: 'site',
      name: 'L',
      preview: 'https://cms.example',
    })
    expect(res.status).toBe(409)
  })

  it('refuses a reserved id, a group with hosts, and a group that does not exist', async () => {
    expect((await send('POST', '/sites', { id: 'shared', kind: 'group', name: 'S' })).status).toBe(
      400,
    )
    expect(
      (await send('POST', '/sites', { id: 'mike', kind: 'group', name: 'M', hosts: ['m.example'] }))
        .status,
    ).toBe(400)
    expect(
      (await send('POST', '/sites', { id: 'november', kind: 'site', name: 'N', group: 'south' }))
        .status,
    ).toBe(400)
  })

  it('replaces a site’s hosts, and refuses to change an id', async () => {
    const res = await send('PUT', '/sites/india/hosts', { hosts: ['India.example'] })
    expect(res.body.hosts).toEqual(['india.example'])
    expect((await send('PATCH', '/sites/india', { id: 'india-2' })).status).toBe(400)
  })

  it('refuses to delete a scope that owns content or holds sites, and deletes an empty one', async () => {
    expect((await send('DELETE', '/sites/alpha')).status).toBe(409)
    expect((await send('DELETE', '/sites/north')).status).toBe(409)
    expect((await send('DELETE', '/sites/default')).status).toBe(409)
    expect(await send('DELETE', '/sites/india')).toEqual({
      status: 200,
      body: { deleted: 'india' },
    })
    const listed = await send('GET', '/sites')
    expect((listed.body.sites as { id: string }[]).map((s) => s.id)).not.toContain('india')
  })

  it('is platform tier: unauthenticated is 401, a narrower token 403', async () => {
    expect((await call(`${ADMIN}/folio/api/sites`))?.status).toBe(401)
    const { token } = await createToken(env.DB, { name: 'reader', scopes: ['content:read'] })
    const res = await call(`${ADMIN}/folio/api/sites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'oscar', kind: 'group', name: 'O' }),
    })
    expect(res?.status).toBe(403)
  })
})

/* ---------------------------------------------------------- isolation --- */

describe('Isolation', () => {
  beforeAll(async () => {
    // content_index and content_text, for the collection's order and the search.
    await folio.reindex(env)
  })

  it('serves each site its own document at the same path', async () => {
    const alpha = await readerAt('https://alpha.example/about').page('about')
    const bravo = await readerAt('https://bravo.example/about').page('about')
    expect(alpha?.story.id).toBe('sty_ms_alpha_about')
    expect(bravo?.story.id).toBe('sty_ms_bravo_about')
    expect(alpha?.doc.bloks.r0?.data.title).toBe('Alpha about')
    expect(bravo?.doc.bloks.r0?.data.title).toBe('Bravo about')
  })

  it('resolves a reference or a link to another site’s story id as absent', async () => {
    const alpha = await readerAt('https://alpha.example/about').page('about')
    expect(alpha?.resolution.docs?.sty_ms_bravo_post).toBeUndefined()
    expect(alpha?.resolution.stories.sty_ms_bravo_post).toBeUndefined()
    expect(alpha?.resolution.stories.sty_ms_bravo_about).toBeUndefined()
  })

  it('lists no other site’s rows in a collection or a search', async () => {
    const alpha = await readerAt('https://alpha.example/about').page('about')
    const list = Object.values(alpha?.resolution.collections ?? {})[0]
    expect(list?.items.map((i) => i.id)).toEqual(['sty_ms_alpha_post', 'sty_ms_shared_post'])

    const search = await readerAt('https://alpha.example/').query({
      type: ['msPost'],
      search: 'common',
    })
    expect(search.items.map((i) => i.id).sort()).toEqual([
      'sty_ms_alpha_post',
      'sty_ms_shared_post',
    ])
    const bravo = await readerAt('https://bravo.example/').query({
      type: ['msPost'],
      search: 'common',
    })
    expect(bravo.items.map((i) => i.id).sort()).toEqual(['sty_ms_bravo_post', 'sty_ms_shared_post'])
  })

  it('carries the site on the resolution, and URLs on the site’s own host', async () => {
    const alpha = await readerAt('https://alpha.example/about').page('about')
    expect(alpha?.resolution.site).toEqual({
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      surface: 'live',
      chain: ['alpha', 'north', 'shared'],
      layered: ['msSettings'],
    })
    expect(alpha?.resolution.path).toBe('about')
    const item = Object.values(alpha?.resolution.collections ?? {})[0]?.items[0]
    expect(item?.url).toBe('https://alpha.example/alpha-post')
  })

  it('keys the preview origin and the live host apart', async () => {
    expect(await folio.cacheProps(new Request('https://preview.alpha.example/about'), env)).toEqual(
      {
        site: 'alpha',
        surface: 'preview',
      },
    )
    expect(await folio.cacheProps(new Request('https://alpha.example/about'), env)).toEqual({
      site: 'alpha',
      surface: 'live',
    })
  })
})

/* ------------------------------------------------- fallback and redirects --- */

describe('Fallback', () => {
  const at = (site: string) => readerAt(`https://${site}.example/stores`)

  it('serves the shared page in the site’s own context when the site has none', async () => {
    await row('sty_ms_shared_stores', 'shared', 'stores')
    const alpha = await at('alpha').page('stores')
    expect(alpha?.story.id).toBe('sty_ms_shared_stores')
    expect(alpha?.resolution.site?.id).toBe('alpha')
    expect((await at('bravo').page('stores'))?.story.id).toBe('sty_ms_shared_stores')
  })

  it('does not blank the inherited page while a fork is a draft', async () => {
    await row('sty_ms_alpha_stores', 'alpha', 'stores', { state: 'draft' })
    expect((await at('alpha').page('stores'))?.story.id).toBe('sty_ms_shared_stores')
    expect(await at('alpha').status('stores')).toBe('live')
  })

  it('serves the fork once it is published, and only on its own site', async () => {
    await env.DB.prepare(
      `update stories set published_doc = ?, published_at = 2 where id = 'sty_ms_alpha_stores'`,
    )
      .bind(JSON.stringify(rootDoc('msPage', { title: 'Our stores' })))
      .run()
    expect((await at('alpha').page('stores'))?.story.id).toBe('sty_ms_alpha_stores')
    expect((await at('bravo').page('stores'))?.story.id).toBe('sty_ms_shared_stores')
  })

  it('lets a site’s own redirect beat the page it would inherit', async () => {
    // The fork renamed: it lives at `our-stores`, and `stores` redirects to it.
    await env.DB.prepare(
      `update stories set slug = 'our-stores', path = 'our-stores' where id = 'sty_ms_alpha_stores'`,
    ).run()
    await redirect('alpha', 'stores', 'our-stores')

    expect(await at('alpha').page('stores')).toBeNull()
    expect(await at('alpha').published('stores')).toBeNull()
    expect(await at('alpha').miss('stores')).toEqual({
      kind: 'redirect',
      to: '/our-stores',
      status: 301,
    })
    expect(await at('alpha').redirect('stores')).toEqual({ to: '/our-stores', status: 301 })
    expect((await at('bravo').page('stores'))?.story.id).toBe('sty_ms_shared_stores')
  })

  it('lists the served set in the sitemap and in collections: our-stores, not stores', async () => {
    const sitemap = (await at('alpha').stories()).map((s) => s.path)
    expect(sitemap).toContain('our-stores')
    expect(sitemap).not.toContain('stores')
    const pages = await at('alpha').query({ type: ['msPage'] })
    expect(pages.items.map((i) => i.path)).toContain('our-stores')
    expect(pages.items.map((i) => i.path)).not.toContain('stores')
    // And bravo, which forked nothing, still lists the shared page.
    expect((await at('bravo').stories()).map((s) => s.path)).toContain('stores')
  })

  it('answers gone for an unpublished fork, and the shared page again once it is deleted', async () => {
    await env.DB.prepare(
      `update stories set published_doc = null, published_at = null, unpublished_at = 3
       where id = 'sty_ms_alpha_stores'`,
    ).run()
    expect(await at('alpha').miss('our-stores')).toEqual({ kind: 'gone' })
    expect(await at('alpha').status('our-stores')).toBe('unpublished')

    await env.DB.batch([
      env.DB.prepare(`delete from stories where id = 'sty_ms_alpha_stores'`),
      env.DB.prepare(`delete from redirects where site_id = 'alpha' and from_path = 'stores'`),
    ])
    expect((await at('alpha').page('stores'))?.story.id).toBe('sty_ms_shared_stores')
  })

  it('builds a site’s tree by path, with inherited pages under the site’s own parents', async () => {
    await row('sty_ms_shared_info', 'shared', 'info')
    await row('sty_ms_shared_parking', 'shared', 'info/parking', { parent: 'sty_ms_shared_info' })
    await row('sty_ms_alpha_info', 'alpha', 'info')
    const tree = await at('alpha').tree()
    const info = tree.find((n) => n.path === 'info')
    expect(info?.id).toBe('sty_ms_alpha_info')
    expect(info?.children.map((c) => c.id)).toEqual(['sty_ms_shared_parking'])
  })

  it('shows the site’s own parent in an inherited page’s breadcrumb', async () => {
    const alpha = await readerAt('https://alpha.example/info/parking').page('info/parking')
    expect(alpha?.story.id).toBe('sty_ms_shared_parking')
    expect(alpha?.resolution.stories.sty_ms_alpha_info?.url).toBe('https://alpha.example/info')
    expect(alpha?.resolution.stories.sty_ms_shared_info).toBeUndefined()

    const bravo = await readerAt('https://bravo.example/info/parking').page('info/parking')
    expect(bravo?.resolution.stories.sty_ms_shared_info).toBeDefined()
    expect(bravo?.resolution.stories.sty_ms_alpha_info).toBeUndefined()
  })
})

/* -------------------------------------------------------------- roots --- */

describe('roots', () => {
  const pageType = types[0]!
  const alphaChain = ['alpha', 'north', 'shared']
  const conflict = async (p: Promise<unknown>) => {
    try {
      await p
    } catch (err) {
      try {
        rethrow(err)
      } catch (mapped) {
        return (mapped as { status: number }).status
      }
    }
    return 'accepted'
  }

  it('creates a scope’s home page, once, and each scope’s slugs are its own', async () => {
    const home = await createStory(env.DB, {
      title: 'Home',
      type: pageType,
      site: 'alpha',
      root: true,
    })
    expect(home).toMatchObject({ slug: '', path: '', parentId: null, site: 'alpha' })
    expect(
      await conflict(
        createStory(env.DB, { title: 'Again', type: pageType, site: 'alpha', root: true }),
      ),
    ).toBe(409)
    // `about` exists on alpha and on bravo; a third site gets `about`, not `about-2`.
    const inGamma = await createStory(env.DB, { title: 'About', type: pageType, site: 'gamma' })
    expect(inGamma.slug).toBe('about')
    // A page under another scope's page is refused.
    expect(
      await conflict(
        createStory(env.DB, {
          title: 'Child',
          type: pageType,
          site: 'alpha',
          parentId: 'sty_ms_shared_info',
        }),
      ),
    ).toBe(409)
  })

  it('refuses to delete a root that nothing above would replace', async () => {
    const home = (await readerAt('https://alpha.example/').storyAt(''))!
    expect(home.site).toBe('alpha')
    expect(await conflict(deleteStoryStatement(env.DB, home.id, { chain: alphaChain }))).toBe(409)
  })

  it('lets a site delete its root once shared has one, and serves the shared home again', async () => {
    await row('sty_ms_shared_home', 'shared', '')
    const home = (await readerAt('https://alpha.example/').storyAt(''))!
    const found = await deleteStoryStatement(env.DB, home.id, { chain: alphaChain })
    await env.DB.batch(found!.storyStatements)
    expect((await readerAt('https://alpha.example/').storyAt(''))?.id).toBe('sty_ms_shared_home')
    expect((await readerAt('https://alpha.example/').page(''))?.story.id).toBe('sty_ms_shared_home')
  })

  it('serves a site’s own published root over the shared one', async () => {
    await row('sty_ms_alpha_home', 'alpha', '')
    expect((await readerAt('https://alpha.example/').page(''))?.story.id).toBe('sty_ms_alpha_home')
    expect((await readerAt('https://bravo.example/').page(''))?.story.id).toBe('sty_ms_shared_home')
  })

  it('never deletes the shared root', async () => {
    expect(
      await conflict(deleteStoryStatement(env.DB, 'sty_ms_shared_home', { chain: ['shared'] })),
    ).toBe(409)
  })
})

/* ----------------------------------------------------------- settings --- */

describe('folio.settings', () => {
  const settingsDoc: Doc = {
    root: 's0',
    bloks: {
      s0: {
        uid: 's0',
        type: 'msSettingsRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data: { tagline: 'Hi' },
      },
      t0: {
        uid: 't0',
        type: 'msTheme',
        parent: 's0',
        slot: 'theme',
        order: 'a0',
        data: { primary: '#e00', radius: 'rounded' },
      },
      n1: {
        uid: 'n1',
        type: 'msLink',
        parent: 's0',
        slot: 'nav',
        order: 'a1',
        data: { label: 'Two' },
      },
      n0: {
        uid: 'n0',
        type: 'msLink',
        parent: 's0',
        slot: 'nav',
        order: 'a0',
        data: { label: 'One' },
      },
    },
  }
  const resolution = (globals?: Record<string, Doc>): Resolution => ({
    stories: {},
    assetBase: '/folio/asset',
    ...(globals ? { globals } : {}),
  })

  it('answers the settings root as a plain value: max-1 as an object, many as an array', () => {
    expect(folio.settings(resolution({ msSettings: settingsDoc }))).toEqual({
      tagline: 'Hi',
      theme: { primary: '#e00', radius: 'rounded' },
      nav: [{ label: 'One' }, { label: 'Two' }],
    })
  })

  it('answers null with no settings type, or no settings on the resolution', () => {
    expect(folio.settings(resolution())).toBeNull()
    const noSettings = build({ sites: { admin: ADMIN } })
    expect(noSettings.settings(resolution({ msSettings: settingsDoc }))).toBeNull()
  })
})

/* ------------------------------------------------ layered globals (phase 4) --- */

/**
 * Decision 8: a global has one layer per scope, merged per field for the site that
 * reads it. `lsHeader` is a configured global; `lsSettings` is the settings type.
 *
 * Two kinds of fixture, on purpose. The published layers of `lsHeader` are seeded by
 * SQL, so the merge is read off exactly the documents the example names. Everything
 * an editor would do — creating a layer, overriding, resetting — goes through the v1
 * API and the Durable Object, because whether a layer starts bare is decided where
 * the object is seeded and a row inserted by SQL never passes through it.
 */
const lsTheme = defineBlock({
  name: 'lsTheme',
  label: 'Theme',
  fields: {
    primary: text({ label: 'Primary' }),
    radius: text({ label: 'Radius', default: 'rounded' }),
  },
  render: () => null,
})

const lsHeaderRoot = defineBlock({
  name: 'lsHeaderRoot',
  label: 'Header',
  fields: {
    title: text({ label: 'Title', default: 'Untitled', translatable: true }),
    cta: text({ label: 'Call to action', translatable: true }),
    theme: blocks({ label: 'Theme', allow: ['lsTheme'], max: 1 }),
  },
  presets: [
    {
      name: 'default',
      label: 'Header',
      data: { cta: 'Visit' },
      children: [{ slot: 'theme', type: 'lsTheme' }],
    },
  ],
  render: () => null,
})

const lsSettingsRoot = defineBlock({
  name: 'lsSettingsRoot',
  label: 'Settings',
  fields: {
    siteName: text({ label: 'Site name', required: true }),
    theme: blocks({ label: 'Theme', allow: ['lsTheme'], max: 1 }),
  },
  presets: [{ name: 'default', label: 'Settings', children: [{ slot: 'theme', type: 'lsTheme' }] }],
  render: () => null,
})

const lsTypes: DocumentType[] = [
  ...types,
  { name: 'lsHeader', label: 'Header', kind: 'singleton', root: 'lsHeaderRoot' },
  { name: 'lsSettings', label: 'Settings', kind: 'singleton', root: 'lsSettingsRoot' },
]

/** Every Durable Object name asked for, so "no object was created" is observable. */
const touched: string[] = []

function watchedNamespace(ns: DurableObjectNamespace): DurableObjectNamespace {
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

const layeredConfig: FolioConfig<Cloudflare.Env> = {
  blocks: [page, post, theme, link, settingsRoot, lsTheme, lsHeaderRoot, lsSettingsRoot],
  types: lsTypes,
  globals: ['lsHeader'],
  bindings: (e): FolioBindings => ({
    ...bindings(e),
    story: watchedNamespace(e.STORY as unknown as DurableObjectNamespace) as typeof e.STORY,
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
  sites: { admin: ADMIN, settings: 'lsSettings' },
}

const layered = createFolio<Cloudflare.Env>(layeredConfig)

let nextUid = 0
/** A layer document: a header or settings root, and optionally a theme child. */
function layerDoc(
  type: 'lsHeaderRoot' | 'lsSettingsRoot',
  data: Record<string, Json>,
  extra: { i18n?: Record<string, Record<string, Json>>; theme?: Record<string, Json> } = {},
): Doc {
  const root = `lr${++nextUid}`
  const doc: Doc = {
    root,
    bloks: {
      [root]: {
        uid: root,
        type,
        parent: null,
        slot: null,
        order: 'a0',
        data,
        ...(extra.i18n ? { i18n: extra.i18n } : {}),
      },
    },
  }
  if (extra.theme) {
    const child = `lc${++nextUid}`
    doc.bloks[child] = {
      uid: child,
      type: 'lsTheme',
      parent: root,
      slot: 'theme',
      order: 'a0',
      data: extra.theme,
    }
  }
  return doc
}

/** A published layer row, the way an editor's first publish leaves it. */
async function publishedLayer(type: string, scope: string, id: string, doc: Doc) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, null, ?, null, 'a0', ?, 1, ?, ?, 2)`,
  )
    .bind(id, type, type, type, scope, JSON.stringify(doc))
    .run()
}

const rootOf = (doc: Doc | undefined) => doc?.bloks[doc.root]
const childOf = (doc: Doc, slot: string) =>
  Object.values(doc.bloks).find((b) => b.parent === doc.root && b.slot === slot)

/** A resolution as `site` sees it, published. */
const resolveOn = async (host: string, doc: Doc = rootDoc('msPage', { title: 'x' })) =>
  layered.reader(env, new Request(`https://${host}/`)).resolve(doc)

const countRows = async (like: string) =>
  (
    await env.DB.prepare('select count(*) as n from stories where id like ?')
      .bind(like)
      .first<{ n: number }>()
  )?.n

async function tokenFor(site: string): Promise<Record<string, string>> {
  const { token } = await createToken(env.DB, {
    name: `ls-${site}`,
    scopes: ['content:read', 'content:read:draft', 'content:write', 'publish'],
    site,
  })
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

const api = (path: string, who: Record<string, string>, init: RequestInit = {}) =>
  layered.handle(
    new Request(`${ADMIN}/folio${path}`, { ...init, headers: { ...who, ...init.headers } }),
    env,
    createExecutionContext(),
  ) as Promise<Response>

const stubOf = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as {
    commit: (
      m: Mutation[],
      actor: { id: string; name: string },
      txId?: string,
    ) => Promise<{ syncId: number } | { rejected: string }>
  }

describe('a render on a multi-site deployment never writes a layer into existence', () => {
  // First in the section, before any editor has made a `lsSettings` layer: the
  // settings type is loaded on every render, so this reads all of them absent.
  it('creates no row and no Durable Object for a layer nobody has written', async () => {
    touched.length = 0
    const reader = layered.reader(env, new Request('https://alpha.example/'))
    const draft = await reader.resolve(rootDoc('msPage', { title: 'x' }), { draft: true })
    expect(draft.globals?.lsSettings).toBeUndefined()
    expect(await countRows('sng_lsSettings%')).toBe(0)
    expect(touched.filter((name) => name.startsWith('sng_lsSettings'))).toEqual([])
    // A layer with no row reads as absent: the published render agrees.
    const published = await resolveOn('alpha.example')
    expect(published.globals?.lsSettings).toBeUndefined()
  })

  it('answers /preview/global/:name from an existing layer only, and never makes one', async () => {
    const platform = await adminToken()
    const before = await countRows('sng_lsSettings%')
    const missing = await api('/~alpha/preview/global/lsSettings', platform)
    expect(missing.status).toBe(404)
    expect(await countRows('sng_lsSettings%')).toBe(before)
    expect(touched.filter((name) => name.startsWith('sng_lsSettings'))).toEqual([])
    // No scope names no layer either.
    expect((await api('/preview/global/lsSettings', platform)).status).toBe(404)
  })
})

describe('Layered globals', () => {
  beforeAll(async () => {
    await publishedLayer(
      'lsHeader',
      'shared',
      'sng_lsHeader:shared',
      layerDoc(
        'lsHeaderRoot',
        { title: 'A', cta: 'Visit' },
        { i18n: { fr: { cta: 'Visitez', title: 'Le A' } } },
      ),
    )
    await publishedLayer(
      'lsHeader',
      'north',
      'sng_lsHeader:north',
      layerDoc('lsHeaderRoot', { cta: 'Hello' }),
    )
    await publishedLayer(
      'lsHeader',
      'alpha',
      'sng_lsHeader:alpha',
      layerDoc('lsHeaderRoot', { title: null }, { i18n: { fr: { cta: null } } }),
    )
  })

  it('reads header on alpha as cta Hello and no title, and on bravo as the shared layer', async () => {
    const alpha = rootOf((await resolveOn('alpha.example')).globals?.lsHeader)
    expect(alpha?.data).toEqual({ cta: 'Hello' })
    expect('title' in alpha!.data).toBe(false)
    const bravo = rootOf((await resolveOn('bravo.example')).globals?.lsHeader)
    expect(bravo?.data).toEqual({ title: 'A', cta: 'Visit' })
  })

  it('reads a bare chain member exactly as its one layer, byte for byte', async () => {
    const shared = JSON.parse(
      (
        await env.DB.prepare('select published_doc from stories where id = ?')
          .bind('sng_lsHeader:shared')
          .first<{ published_doc: string }>()
      )?.published_doc ?? 'null',
    ) as Doc
    expect((await resolveOn('bravo.example')).globals?.lsHeader).toEqual(shared)
  })

  it('serves the same merge through reader.global', async () => {
    const alpha = await layered.reader(env, { site: 'alpha' }).global('lsHeader')
    expect(rootOf(alpha ?? undefined)?.data).toEqual({ cta: 'Hello' })
    const bravo = await layered.reader(env, { site: 'bravo' }).global('lsHeader')
    expect(rootOf(bravo ?? undefined)?.data).toEqual({ title: 'A', cta: 'Visit' })
    expect(await layered.reader(env, { site: 'alpha' }).global('msPage')).toBeNull()
  })

  it('keeps null as untranslated in a translation: French cta falls back to the merged source', async () => {
    const alpha = rootOf((await resolveOn('alpha.example')).globals?.lsHeader)!
    const fr = { code: 'fr', fallbacks: [] }
    // Shared translated it and alpha untranslated it: north's source value, not
    // shared's French, and not removed.
    expect(fieldValue(alpha, 'cta', fr)).toBe('Hello')
    expect(alpha.data.cta).toBe('Hello')
    const bravo = rootOf((await resolveOn('bravo.example')).globals?.lsHeader)!
    expect(fieldValue(bravo, 'cta', fr)).toBe('Visitez')
    // Alpha removed the source title, and its French translation goes with it.
    expect(fieldValue(alpha, 'title', fr)).toBeUndefined()
  })

  it('labels alpha: title removed here, cta inherited from north', async () => {
    const docs = await Promise.all(
      ['shared', 'north', 'alpha'].map(async (scope) =>
        JSON.parse(
          (await env.DB.prepare('select published_doc from stories where id = ?')
            .bind(`sng_lsHeader:${scope}`)
            .first<{ published_doc: string }>())!.published_doc,
        ),
      ),
    )
    const states = layerStates(
      docs,
      ['shared', 'north', 'alpha'],
      toSchemaIndex(toRegistry(layeredConfig.blocks)),
    )
    expect(states.title).toEqual({ state: 'removed', from: 'alpha' })
    expect(states.cta).toEqual({ state: 'inherited', from: 'north' })
  })

  describe('a layer an editor creates', () => {
    const bravo = () => tokenFor('bravo')

    it('starts bare, in the admin or by a v1 create: root data is {} and every field reads inherited', async () => {
      const who = await bravo()
      const res = await api('/api/v1/documents/sng_lsHeader:bravo?status=draft', who)
      expect(res.status).toBe(200)
      const doc = await layered.draft(env, 'sng_lsHeader:bravo')
      expect(Object.keys(doc.bloks)).toHaveLength(1)
      expect(rootOf(doc)?.data).toEqual({})
      // The nested read shows no scalar at all, and no defaulted theme.
      const body = (await res.json()) as { content: { fields: Record<string, unknown> } }
      expect(Object.keys(body.content.fields)).toEqual(['theme'])
      expect(body.content.fields.theme).toEqual([])
    })

    it('writes no defaults on a v1 write, and takes null as removed', async () => {
      const who = await bravo()
      const put = await api('/api/v1/documents/sng_lsHeader:bravo/content', who, {
        method: 'PUT',
        body: JSON.stringify({ content: { fields: { cta: 'Bravo cta', title: null } } }),
      })
      expect(put.status).toBe(200)
      const doc = await layered.draft(env, 'sng_lsHeader:bravo')
      expect(rootOf(doc)?.data).toEqual({ cta: 'Bravo cta', title: null })
      expect(Object.keys(doc.bloks)).toHaveLength(1)
    })

    it('takes null for a blocks field only in a layer that has something below it', async () => {
      const who = await bravo()
      const removed = await api('/api/v1/documents/sng_lsHeader:bravo/content', who, {
        method: 'PUT',
        body: JSON.stringify({ content: { fields: { theme: null } } }),
      })
      expect(removed.status).toBe(200)
      expect(rootOf(await layered.draft(env, 'sng_lsHeader:bravo'))?.data.theme).toBeNull()
      // Read back, the removal survives a read-modify-write.
      const read = (await (
        await api('/api/v1/documents/sng_lsHeader:bravo?status=draft', who)
      ).json()) as { content: { fields: Record<string, unknown> } }
      expect(read.content.fields.theme).toBeNull()
      // An array clears it again: children, or none, and inherited.
      await api('/api/v1/documents/sng_lsHeader:bravo/content', who, {
        method: 'PUT',
        body: JSON.stringify({ content: { fields: { theme: [] } } }),
      })
      expect('theme' in rootOf(await layered.draft(env, 'sng_lsHeader:bravo'))!.data).toBe(false)
      // The shared layer is an ordinary document: no null for a blocks field.
      const shared = await tokenFor('shared')
      const refused = await api('/api/v1/documents/sng_lsHeader:shared/content', shared, {
        method: 'PUT',
        body: JSON.stringify({ content: { fields: { theme: null } } }),
      })
      expect(refused.status).toBe(400)
    })

    it('resets a field with an unset, and the published render then reads it inherited', async () => {
      const who = await bravo()
      const doc = await layered.draft(env, 'sng_lsHeader:bravo')
      const root = doc.root
      const actor = { id: 'ls', name: 'Layers' }
      // Removed here: title null in the layer, published.
      await stubOf('sng_lsHeader:bravo').commit(
        [{ t: 'set', uid: root, field: 'title', value: null }],
        actor,
        'ls-remove',
      )
      expect(
        (await api('/api/v1/documents/sng_lsHeader:bravo/publish', who, { method: 'POST' })).status,
      ).toBe(200)
      const removed = rootOf((await resolveOn('bravo.example')).globals?.lsHeader)
      expect(removed?.data).toEqual({ cta: 'Bravo cta' })
      // Reset: an unset is written, and title reads 'A' again.
      const committed = await stubOf('sng_lsHeader:bravo').commit(
        [{ t: 'unset', uid: root, field: 'title' }],
        actor,
        'ls-reset',
      )
      expect(committed).toMatchObject({ syncId: expect.any(Number) })
      const after = await layered.draft(env, 'sng_lsHeader:bravo')
      expect('title' in rootOf(after)!.data).toBe(false)
      expect(
        (await api('/api/v1/documents/sng_lsHeader:bravo/publish', who, { method: 'POST' })).status,
      ).toBe(200)
      const reset = rootOf((await resolveOn('bravo.example')).globals?.lsHeader)
      expect(reset?.data).toEqual({ title: 'A', cta: 'Bravo cta' })
    })
  })

  it('carries the type’s defaults and preset when the shared layer is first created', async () => {
    const who = await tokenFor('shared')
    const res = await api('/~shared/api/v1/documents/sng_lsHeader:shared?status=draft', who)
    expect(res.status).toBe(200)
    // Shared already had a row from the seed above, so it is asked into a draft
    // that was never opened: the Durable Object seeds from `seedFor`.
    const doc = await layered.draft(env, 'sng_lsHeader:shared')
    // The seed writes the row's title into the type's title field.
    expect(rootOf(doc)?.data).toEqual({ title: 'lsHeader', cta: 'Visit' })
    expect(childOf(doc, 'theme')?.data).toEqual({ primary: '', radius: 'rounded' })
  })
})

describe('Site settings', () => {
  const settings = async (host: string, opts?: { draft?: boolean }) => {
    const reader = layered.reader(env, new Request(`https://${host}/`))
    const resolution = await reader.resolve(rootDoc('msPage', { title: 'x' }), opts)
    return { resolution, value: layered.settings(resolution) as Record<string, unknown> | null }
  }

  it('merges the theme child over the shared one and answers it through folio.settings', async () => {
    const shared = await tokenFor('shared')
    const alpha = await tokenFor('alpha')

    // The shared layer, created on a multi-site deployment: defaults and preset.
    expect((await api('/api/v1/documents/sng_lsSettings:shared?status=draft', shared)).status).toBe(
      200,
    )
    const sharedDoc = await layered.draft(env, 'sng_lsSettings:shared')
    expect(rootOf(sharedDoc)?.data).toEqual({ siteName: '' })
    expect(childOf(sharedDoc, 'theme')?.data).toEqual({ primary: '', radius: 'rounded' })
    await api('/api/v1/documents/sng_lsSettings:shared/publish', shared, { method: 'POST' })

    // Alpha's layer starts bare, and overrides the theme child: primary only.
    expect((await api('/api/v1/documents/sng_lsSettings:alpha?status=draft', alpha)).status).toBe(
      200,
    )
    expect(rootOf(await layered.draft(env, 'sng_lsSettings:alpha'))?.data).toEqual({})
    const put = await api('/api/v1/documents/sng_lsSettings:alpha/content', alpha, {
      method: 'PUT',
      body: JSON.stringify({
        content: { fields: { theme: [{ type: 'lsTheme', fields: { primary: '#e00' } }] } },
      }),
    })
    expect(put.status).toBe(200)
    const alphaDoc = await layered.draft(env, 'sng_lsSettings:alpha')
    // A child written into a bare layer carries no defaults of its own.
    expect(childOf(alphaDoc, 'theme')?.data).toEqual({ primary: '#e00' })
    await api('/api/v1/documents/sng_lsSettings:alpha/publish', alpha, { method: 'POST' })

    const { value } = await settings('alpha.example')
    expect(value?.theme).toEqual({ primary: '#e00', radius: 'rounded' })
  })

  it('reads a changed shared value through, while the site keeps what it overrode', async () => {
    const shared = await tokenFor('shared')
    const doc = await layered.draft(env, 'sng_lsSettings:shared')
    const theme = childOf(doc, 'theme')!
    const patch = await api('/api/v1/documents/sng_lsSettings:shared/fields', shared, {
      method: 'PATCH',
      body: JSON.stringify({ bloks: [{ uid: theme.uid, fields: { radius: 'square' } }] }),
    })
    expect(patch.status).toBe(200)
    // Not published yet: alpha still reads the published shared value.
    expect((await settings('alpha.example')).value?.theme).toEqual({
      primary: '#e00',
      radius: 'rounded',
    })
    await api('/api/v1/documents/sng_lsSettings:shared/publish', shared, { method: 'POST' })
    expect((await settings('alpha.example')).value?.theme).toEqual({
      primary: '#e00',
      radius: 'square',
    })
    // Bravo has no layer of its own and reads shared's.
    expect((await settings('bravo.example')).value?.theme).toEqual({
      primary: '',
      radius: 'square',
    })
  })

  it('reads a draft the same way, from the layers’ drafts', async () => {
    const alpha = await tokenFor('alpha')
    const doc = await layered.draft(env, 'sng_lsSettings:alpha')
    const theme = childOf(doc, 'theme')!
    await api('/api/v1/documents/sng_lsSettings:alpha/fields', alpha, {
      method: 'PATCH',
      body: JSON.stringify({ bloks: [{ uid: theme.uid, fields: { primary: '#0f0' } }] }),
    })
    const draft = await settings('alpha.example', { draft: true })
    expect(draft.value?.theme).toEqual({ primary: '#0f0', radius: 'square' })
    expect((await settings('alpha.example')).value?.theme).toEqual({
      primary: '#e00',
      radius: 'square',
    })
  })

  it('previews an existing layer on its own scope, and only that one', async () => {
    const platform = await adminToken()
    const res = await api('/~alpha/preview/global/lsSettings?mode=draft', platform)
    expect(res.status).toBe(200)
    const before = await countRows('sng_lsSettings%')
    // Bravo has no layer: a preview does not make one.
    expect((await api('/~bravo/preview/global/lsSettings', platform)).status).toBe(404)
    expect(await countRows('sng_lsSettings%')).toBe(before)
  })

  it('puts a layer tag for every chain scope on a page, whether or not the layer exists', async () => {
    const found = await layered
      .reader(env, new Request('https://alpha.example/about'))
      .page('about')
    const tags = Object.entries(found!.headers)
      .find(([key]) => key.toLowerCase() === 'cache-tag')?.[1]
      .split(',')
    // North has never published a settings layer, and its tag is on the page anyway.
    expect(tags).toEqual(
      expect.arrayContaining([
        'global:lsSettings',
        'global:lsSettings@north',
        'global:lsSettings@alpha',
      ]),
    )
    // A host calling cacheHeaders directly gets the same set.
    const direct = layered.cacheHeaders(found!.resolution, { story: found!.story.id })
    expect(direct['cache-tag']?.split(',')).toEqual(expect.arrayContaining(tags!))
  })

  it('purges the layer tag of the layer that published, through the settings type', async () => {
    const rt = createRuntime(layeredConfig)
    const calls: CachePurgeOptions[] = []
    const hooks = cachePurgeHooks<Cloudflare.Env>(
      rt.globals,
      async () => async (options) => {
        calls.push(options)
        return { success: true, errors: [] }
      },
      undefined,
      { registry: rt.sites!.registry, layered: rt.sites!.layered },
    )
    const published = (scope: string) =>
      hooks.published!({
        env,
        waitUntil: () => {},
        actor: null,
        story: {
          id: scope === 'default' ? 'sng_lsSettings' : `sng_lsSettings:${scope}`,
          type: 'lsSettings',
          site: scope,
          path: null,
        } as never,
        doc: { root: 'r', bloks: {} },
        version: { id: 'v' } as never,
        publishedAt: 1,
      })
    await published('shared')
    await published('north')
    await published('alpha')
    expect(calls.map((c) => c.tags)).toEqual([
      expect.arrayContaining(['global:lsSettings']),
      expect.arrayContaining(['global:lsSettings@north']),
      expect.arrayContaining(['global:lsSettings@alpha']),
    ])
  })

  it('reports a required field with no value in a site’s merged settings, per site', async () => {
    const report = await layered.audit(env)
    // `siteName` is required and empty in shared, which every site inherits.
    const findings = report.settings ?? []
    expect(findings.filter((f) => f.field === 'siteName').map((f) => f.site)).toEqual(
      expect.arrayContaining(['alpha', 'bravo', 'default', 'gamma']),
    )
    // Give alpha a name in its own layer: only alpha stops being reported.
    const alpha = await tokenFor('alpha')
    await api('/api/v1/documents/sng_lsSettings:alpha/content', alpha, {
      method: 'PUT',
      body: JSON.stringify({ content: { fields: { siteName: 'Alpha' } } }),
    })
    await api('/api/v1/documents/sng_lsSettings:alpha/publish', alpha, { method: 'POST' })
    const after = await layered.audit(env)
    expect(
      (after.settings ?? []).filter((f) => f.field === 'siteName').map((f) => f.site),
    ).not.toContain('alpha')
    expect(
      (after.settings ?? []).filter((f) => f.field === 'siteName').map((f) => f.site),
    ).toContain('bravo')
    // A bare layer is not reported as missing every field it leaves inherited.
    expect(
      after.missingFields.filter((f) => f.type === 'lsSettingsRoot' && f.field === 'siteName'),
    ).toEqual([])
  })

  it('reports nothing about settings on a deployment with no sites', async () => {
    const single = createFolio<Cloudflare.Env>({
      blocks: [page, post, theme, link, settingsRoot],
      types,
      bindings,
      basePath: '/folio',
      assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
      auth: 'open',
      route: (p) => (p ? `/${p}` : '/'),
    })
    expect(await single.audit(env)).not.toHaveProperty('settings')
  })
})

/* ------------------------------------------------ nothing changes single-site --- */

describe('a deployment with no sites', () => {
  /** The SQL every statement said, wherever it was prepared. */
  function spy(real: D1Database) {
    const said: string[] = []
    const wrap = <T extends object>(t: T): T =>
      new Proxy(t, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop === 'prepare') {
            return (sql: string) => {
              said.push(sql)
              return (value as (s: string) => unknown).call(target, sql)
            }
          }
          if (prop === 'withSession') {
            return (...args: unknown[]) =>
              wrap((value as (...a: unknown[]) => object).apply(target, args))
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    return { db: wrap(real), said }
  }

  it('answers ~default with a 404 and never reads the registry', async () => {
    const watched = spy(env.DB)
    const single = createFolio<Cloudflare.Env>({
      blocks: [page, post, theme, link, settingsRoot],
      types,
      bindings: (e) => ({ ...bindings(e), db: watched.db }),
      basePath: '/folio',
      assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
      auth: 'open',
      route: (p) => (p ? `/${p}` : '/'),
    })
    const res = await single.handle(
      new Request('https://example.com/folio/~default/api/stories'),
      env,
      createExecutionContext(),
    )
    expect(res?.status).toBe(404)
    expect(await res?.json()).toMatchObject({ error: { code: 'not_found' } })

    await single.handle(
      new Request('https://example.com/folio/api/stories'),
      env,
      createExecutionContext(),
    )
    await single.reader(env, new Request('https://example.com/about')).page('about')
    expect(await single.cacheProps(new Request('https://example.com/about'), env)).toEqual({})
    expect(watched.said.length).toBeGreaterThan(0)
    expect(watched.said.filter((sql) => /\b(sites|site_hosts)\b/.test(sql))).toEqual([])
  })
})
