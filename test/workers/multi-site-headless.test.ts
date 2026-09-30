import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { collection, defineBlock, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink, oidc, roleFromClaim } from '../../src/server'
import { SECURE_COOKIE, SECURE_GRANT_COOKIE } from '../../src/server/auth/cookie'
import type { Grants } from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import type { HookEvent } from '../../src/server/hooks'

/**
 * Many sites in one deployment, phase 7: the headless surfaces (decision 16), the
 * registry's hook and purge (decision 4), and the cache criterion that a publish in one
 * site purges no tag another site's page carries (decision 15).
 *
 * The registry: group `north`; `alpha` (in north, live, `alpha.example`, preview
 * `https://preview.alpha.example`); `bravo` (live, `bravo.example`); `gamma` (in north,
 * **draft**, `gamma.example`, preview `https://preview.gamma.example`); `delta`
 * (**preview** status, `delta.example`, preview `https://preview.delta.example`).
 */

const ADMIN_ORIGIN = 'https://cms.example'
const BASE = `${ADMIN_ORIGIN}/folio`
const GAMMA = 'https://preview.gamma.example'

const page = defineBlock({
  name: 'hlPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title' }),
    posts: collection({ type: 'hlPost', defaultOrder: { field: 'title', dir: 'asc' } }),
  },
  render: () => null,
})

const post = defineBlock({
  name: 'hlPost',
  label: 'Post',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

const fired: [HookEvent, Record<string, unknown>][] = []
const ALL: HookEvent[] = ['published', 'siteChanged']
const hooks = Object.fromEntries(
  ALL.map((name) => [
    name,
    (payload: Record<string, unknown>) => {
      fired.push([name, payload])
    },
  ]),
)

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const base = {
  blocks: [page, post],
  types: [
    { name: 'hlPage', label: 'Page', kind: 'page', root: 'hlPage', default: true },
    { name: 'hlPost', label: 'Post', kind: 'page', root: 'hlPost' },
  ],
  bindings,
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  route: (
    p: string,
    _locale: string | undefined,
    site?: { hosts: readonly string[]; id: string },
  ) => (site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/'),
} satisfies Partial<FolioConfig<Cloudflare.Env>>

const folio = createFolio<Cloudflare.Env>({
  ...base,
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  sites: { admin: ADMIN_ORIGIN },
  hooks: { ...hooks, await: ALL },
} as FolioConfig<Cloudflare.Env>)

const call = (url: string, init: RequestInit = {}) =>
  folio.handle(new Request(url, init), env, createExecutionContext())

async function admin(path: string, who: Record<string, string>, init: RequestInit = {}) {
  const res = await call(`${BASE}${path}`, {
    ...init,
    headers: {
      ...who,
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!res) throw new Error(`handle() answered null for ${path}`)
  return res
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads a response by its shape
const json = async <T = Record<string, any>>(res: Response): Promise<T> => (await res.json()) as T
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) })

function doc(title: string): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: { uid: 'r0', type: 'hlPage', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

async function row(
  id: string,
  site: string,
  path: string,
  opts: { type?: string; title?: string } = {},
) {
  const type = opts.type ?? 'hlPage'
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, 1, ?, ?, 2)`,
  )
    .bind(
      id,
      type,
      path,
      path,
      `${opts.title ?? id} draft`,
      site,
      JSON.stringify({
        ...doc(`${opts.title ?? id} published`),
        bloks: {
          r0: {
            uid: 'r0',
            type,
            parent: null,
            slot: null,
            order: 'a0',
            data: { title: `${opts.title ?? id} published` },
          },
        },
      } as unknown as Json),
    )
    .run()
}

async function person(email: string, grants: Grants): Promise<Record<string, string>> {
  const user = await createUser(env.DB, { email, grants })
  const { token } = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${token}` }
}

async function bearer(
  name: string,
  scopes: Parameters<typeof createToken>[1]['scopes'],
  site: string | null = null,
): Promise<Record<string, string>> {
  const { token } = await createToken(env.DB, { name, scopes, site })
  return { authorization: `Bearer ${token}` }
}

let tRead: Record<string, string> // unbound content:read
let tDraft: Record<string, string> // unbound content:read + content:read:draft
let tAlpha: Record<string, string> // bound to alpha, content:read
let P: Record<string, string> // {'*': admin}
let R: Record<string, string> // {north: editor}
let U: Record<string, string> // {alpha: publisher}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0),
         ('gamma', 'site', 'Gamma', 'north', 'draft', '${GAMMA}', 0, 0),
         ('delta', 'site', 'Delta', null, 'preview', 'https://preview.delta.example', 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values
         ('alpha.example', 'alpha'), ('bravo.example', 'bravo'),
         ('gamma.example', 'gamma'), ('delta.example', 'delta')`,
    ),
  ])
  await row('sty_hl_alpha', 'alpha', 'about', { title: 'Alpha about' })
  await row('sty_hl_bravo', 'bravo', 'about', { title: 'Bravo about' })
  await row('sty_hl_gamma', 'gamma', 'about', { title: 'Gamma about' })
  await row('sty_hl_delta', 'delta', 'about', { title: 'Delta about' })
  await row('sty_hl_shared', 'shared', 'stores', { title: 'Shared stores' })
  await row('sty_hl_post_shared', 'shared', 'posts/shared', {
    type: 'hlPost',
    title: 'Shared post',
  })
  await row('sty_hl_post_alpha', 'alpha', 'posts/alpha', { type: 'hlPost', title: 'Alpha post' })
  await row('sty_hl_post_bravo', 'bravo', 'posts/bravo', { type: 'hlPost', title: 'Bravo post' })

  tRead = await bearer('read', ['content:read'])
  tDraft = await bearer('draft', ['content:read', 'content:read:draft'])
  tAlpha = await bearer('alpha', ['content:read'], 'alpha')
  P = await person('p@hl.example', { '*': 'admin' })
  R = await person('r@hl.example', { north: 'editor' })
  U = await person('u@hl.example', { alpha: 'publisher' })
})

/* ----------------------------------------------------------- documents --- */

describe('documents over v1 on a multi-site deployment', () => {
  it('names the scope that owns each one, and only there', async () => {
    const shared = await json(await admin('/~alpha/api/v1/documents/sty_hl_shared', tRead))
    expect(shared.site).toBe('shared')
    expect(shared.url).toBe('https://alpha.example/stores')
    const own = await json(await admin('/~alpha/api/v1/documents/sty_hl_alpha', tRead))
    expect(own.site).toBe('alpha')
    expect(own.previewUrl).toMatch(/^https:\/\/preview\.alpha\.example\/about\?_folio=preview/)
  })

  it('leaves the key off a single-site deployment, whose payload is what it was', async () => {
    const single = createFolio<Cloudflare.Env>({
      ...base,
      auth: 'open',
    } as FolioConfig<Cloudflare.Env>)
    await env.DB.prepare(
      `insert into stories (id, type, slug, path, ord, title, updated_at, published_doc, published_at)
       values ('sty_hl_single', 'hlPage', 'solo', 'solo', 'a0', 'Solo', 1, ?, 2)`,
    )
      .bind(JSON.stringify(doc('Solo') as unknown as Json))
      .run()
    const res = await single.handle(
      new Request('https://example.com/folio/api/v1/documents/sty_hl_single'),
      env,
      createExecutionContext(),
    )
    const meta = await json(res!)
    expect(meta.id).toBe('sty_hl_single')
    expect('site' in meta).toBe(false)
  })

  it('queries the chain’s served set: a site’s own and what it inherits, never a sibling’s', async () => {
    const v1 = await json(await admin('/~alpha/api/v1/documents?type=hlPost', tRead))
    const paths = v1.items.map((i: { path: string }) => i.path)
    expect(paths.sort()).toEqual(['posts/alpha', 'posts/shared'])
    const internal = await json(await admin('/~alpha/api/content?type=hlPost', P))
    expect(internal.items.map((i: { path: string }) => i.path).sort()).toEqual([
      'posts/alpha',
      'posts/shared',
    ])
    const bravo = await json(await admin('/~bravo/api/v1/documents?type=hlPost', tRead))
    expect(bravo.items.map((i: { path: string }) => i.path).sort()).toEqual([
      'posts/bravo',
      'posts/shared',
    ])
  })
})

/* -------------------------------------------------------- host to site --- */

describe('resolving a host without an admin token', () => {
  const resolve = (host: string, who = tRead) =>
    admin(`/api/v1/sites/resolve?host=${encodeURIComponent(host)}`, who)

  it('answers the gate’s result for a live host', async () => {
    const res = await resolve('alpha.example')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      site: { id: 'alpha', name: 'Alpha', group: 'north', status: 'live' },
      surface: 'live',
    })
    // A preview-status site serves its preview origin, and not yet its live host.
    expect(await json(await resolve('preview.alpha.example'))).toMatchObject({
      site: { id: 'alpha' },
      surface: 'preview',
    })
    expect(await json(await resolve('preview.delta.example'))).toMatchObject({
      site: { id: 'delta', status: 'preview' },
      surface: 'preview',
    })
  })

  it('404s a draft site’s live host, a group, the admin and a host nobody has', async () => {
    for (const host of [
      'gamma.example',
      'north',
      'cms.example',
      'nobody.example',
      'delta.example',
    ]) {
      expect([host, (await resolve(host)).status]).toEqual([host, 404])
    }
  })

  it('says a draft site’s preview origin needs a grant', async () => {
    const res = await resolve('preview.gamma.example')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      site: { id: 'gamma', name: 'Gamma', group: 'north', status: 'draft' },
      surface: 'preview',
      grantRequired: true,
    })
  })

  it('shows a token bound to a site that site’s hosts and no other', async () => {
    expect((await resolve('alpha.example', tAlpha)).status).toBe(200)
    expect((await resolve('bravo.example', tAlpha)).status).toBe(404)
    expect((await resolve('preview.gamma.example', tAlpha)).status).toBe(404)
  })

  it('needs content:read', async () => {
    const noScope = await bearer('assets-only', ['assets:write'])
    expect((await resolve('alpha.example', noScope)).status).toBe(403)
    expect((await admin('/api/v1/sites/resolve?host=alpha.example', {})).status).toBe(401)
  })

  it('lists every preview and live site with its hosts, and a bound token its own', async () => {
    const all = await json(await admin('/api/v1/sites', tRead))
    // `default` is an ordinary live site row on a multi-site deployment (0011 inserts it).
    expect(all.sites.map((s: { id: string }) => s.id)).toEqual([
      'alpha',
      'bravo',
      'default',
      'delta',
    ])
    expect(all.sites[0]).toEqual({
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      hosts: ['alpha.example'],
      preview: 'https://preview.alpha.example',
    })
    const bound = await json(await admin('/api/v1/sites', tAlpha))
    expect(bound.sites.map((s: { id: string }) => s.id)).toEqual(['alpha'])
  })
})

/* ----------------------------------------------------------------- pages --- */

describe('a page over HTTP', () => {
  it('answers reader.page(): the story, its document, the resolution and the tags', async () => {
    const res = await admin('/~alpha/api/v1/pages/about', tRead)
    expect(res.status).toBe(200)
    const page = await json(res)
    expect(page.story).toMatchObject({ id: 'sty_hl_alpha', site: 'alpha' })
    expect(page.story.url).toBe('https://alpha.example/about')
    expect(page.document.bloks.r0.data.title).toBe('Alpha about published')
    expect(page.draft).toBe(false)
    expect(page.access).toBe('public')
    expect(page.resolution.site).toMatchObject({ id: 'alpha', surface: 'live' })

    const tags = (res.headers.get('folio-cache-tags') ?? '').split(',')
    expect(tags).toEqual(
      expect.arrayContaining(['site:alpha', 'path:alpha:about', 'story:sty_hl_alpha']),
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('walks the fallback: a shared page in the site’s own context', async () => {
    const page = await json(await admin('/~alpha/api/v1/pages/stores', tRead))
    expect(page.story.id).toBe('sty_hl_shared')
    expect(page.resolution.site.id).toBe('alpha')
    expect((await admin('/~bravo/api/v1/pages/stores', tRead)).status).toBe(200)
    expect((await admin('/~alpha/api/v1/pages/nothing-here', tRead)).status).toBe(404)
  })

  it('is a 404 for a draft site, with or without surface=preview', async () => {
    for (const path of [
      '/~gamma/api/v1/pages/about',
      '/~gamma/api/v1/pages/about?surface=preview',
      '/~gamma/api/v1/pages/about?surface=live',
    ]) {
      expect([path, (await admin(path, tRead)).status]).toEqual([path, 404])
    }
    // A preview-status site serves published pages on its preview surface, not live.
    expect((await admin('/~delta/api/v1/pages/about', tRead)).status).toBe(404)
    expect((await admin('/~delta/api/v1/pages/about?surface=preview', tRead)).status).toBe(200)
  })

  it('is a 404 for a group or shared, which no host serves', async () => {
    expect((await admin('/~north/api/v1/pages/about', tRead)).status).toBe(404)
    expect((await admin('/~shared/api/v1/pages/stores', tRead)).status).toBe(404)
  })

  it('reads a draft site’s pages, and its drafts, for a caller who may see drafts', async () => {
    expect((await admin('/~gamma/api/v1/pages/about?surface=preview', tDraft)).status).toBe(200)
    // Not `content:read:draft`: refused, not silently published.
    expect((await admin('/~alpha/api/v1/pages/about?status=draft', tRead)).status).toBe(403)

    const draft = await admin('/~gamma/api/v1/pages/about?status=draft&surface=preview', tDraft)
    expect(draft.status).toBe(200)
    const read = await json(draft)
    expect(read.draft).toBe(true)
    // The draft is seeded from the row: `<title> draft`.
    expect(read.document.bloks[read.document.root].data.title).toBe('Gamma about draft')
    // A draft has no purge path, so it carries no tags and must not be cached.
    expect(draft.headers.get('folio-cache-tags')).toBeNull()
  })

  it('reads a draft with the editor’s grant cookie forwarded to the preview origin', async () => {
    // The whole handoff, as the admin's pane runs it: start, enter, check.
    const first = await admin('/~gamma/site/start?next=%2Fabout', R)
    expect(first.status).toBe(302)
    const second = await call(first.headers.get('location')!)
    expect(second?.status).toBe(302)
    const grant = /__Host-folio_grant=([0-9a-f]{64})/.exec(
      second!.headers.get('set-cookie') ?? '',
    )?.[1]
    expect(grant).toBeTruthy()

    const url = `${GAMMA}/folio/~gamma/api/v1/pages/about`
    const withGrant = { headers: { cookie: `${SECURE_GRANT_COOKIE}=${grant}` } }
    const draft = await call(`${url}?status=draft`, withGrant)
    expect(draft?.status).toBe(200)
    const read = await json(draft!)
    expect(read.draft).toBe(true)
    expect(read.document.bloks[read.document.root].data.title).toBe('Gamma about draft')

    // The published page too, since the grant may see the site; and without the
    // grant, nothing answers on the draft site's preview origin at all.
    expect((await call(url, withGrant))?.status).toBe(200)
    expect(await call(`${url}?status=draft`)).toBeNull()
    // A grant for gamma is no credential on another site's route.
    const other = await call(`${GAMMA}/folio/~bravo/api/v1/pages/about`, withGrant)
    expect(other === null || other.status >= 400).toBe(true)
  })

  it('applies the same gate to a document by path', async () => {
    for (const path of ['/~gamma/api/v1/documents/by-path/about']) {
      expect([path, (await admin(path, tRead)).status]).toEqual([path, 404])
      expect((await admin(`${path}?surface=preview`, tRead)).status).toBe(404)
    }
    expect(
      (await admin('/~gamma/api/v1/documents/by-path/about?surface=preview', tDraft)).status,
    ).toBe(200)
    const alpha = await json(await admin('/~alpha/api/v1/documents/by-path/about', tRead))
    expect(alpha.id).toBe('sty_hl_alpha')
    expect(alpha.site).toBe('alpha')
  })
})

/* ------------------------------------------------------------- a miss --- */

describe('a miss over HTTP', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into redirects (from_path, to_path, status, source, created_at, site_id) values
           ('old', 'about', 301, 'manual', 0, 'alpha')`,
      ),
      env.DB.prepare(
        `insert into stories (id, type, slug, path, ord, title, updated_at, site_id,
                              published_at, unpublished_at)
         values ('sty_hl_retired', 'hlPage', 'retired', 'retired', 'a0', 'Retired', 1, 'alpha', null, 3)`,
      ),
    ])
  })

  const miss = async (path: string) => {
    const res = await admin(path, tRead)
    expect(res.status).toBe(404)
    const envelope = await json(res)
    expect(envelope.error.code).toBe('not_found')
    return envelope.error.miss
  }

  it('says redirect, gone or not-found from /pages/{path}, each tagged for a later publish', async () => {
    const tags = (path: string) => [`path:alpha:${path}`, 'site:alpha'].join(',')
    const control = 'public, max-age=0, s-maxage=604800, must-revalidate'

    expect(await miss('/~alpha/api/v1/pages/old')).toEqual({
      kind: 'redirect',
      to: '/about',
      status: 301,
      headers: { 'cache-control': control, 'cache-tag': tags('old') },
    })
    expect(await miss('/~alpha/api/v1/pages/retired')).toEqual({
      kind: 'gone',
      headers: { 'cache-control': control, 'cache-tag': tags('retired') },
    })
    expect(await miss('/~alpha/api/v1/pages/never')).toEqual({
      kind: 'not-found',
      headers: { 'cache-control': control, 'cache-tag': tags('never') },
    })
  })

  it('answers the same from /documents/by-path/{path}', async () => {
    expect(await miss('/~alpha/api/v1/documents/by-path/old')).toMatchObject({
      kind: 'redirect',
      to: '/about',
      headers: { 'cache-tag': 'path:alpha:old,site:alpha' },
    })
    expect(await miss('/~alpha/api/v1/documents/by-path/never')).toMatchObject({
      kind: 'not-found',
      headers: { 'cache-tag': 'path:alpha:never,site:alpha' },
    })
  })

  it('leaves a redirect in another site alone', async () => {
    expect(await miss('/~bravo/api/v1/pages/old')).toMatchObject({ kind: 'not-found' })
  })

  it('tags a single-site miss with the tags a single-site publish purges', async () => {
    const single = createFolio<Cloudflare.Env>({
      ...base,
      auth: 'open',
    } as FolioConfig<Cloudflare.Env>)
    const miss = await single.miss(env, 'no-such-page')
    expect(miss.kind).toBe('not-found')
    expect(miss.headers['cache-tag']).toBe('site,type:*')
  })
})

/* ------------------------------------------------------------ the cache --- */

describe('the cache', () => {
  it('purges no tag another site’s page carries when a post is published in bravo', async () => {
    const alpha = await folio.reader(env, new Request('https://alpha.example/about')).page('about')
    const carried = new Set((alpha?.headers['cache-tag'] ?? '').split(','))
    expect(carried.has('site:alpha')).toBe(true)

    const before = fired.length
    // Bravo's post is live already; publishing it again is what an editor does.
    const bravo = await person('bp@hl.example', { bravo: 'publisher' })
    const res = await admin('/~bravo/api/story/sty_hl_post_bravo/publish', bravo, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const purge = fired.slice(before).find(([name]) => name === 'published')![1] as {
      purge: { tags: string[] }
      site: string
    }
    expect(purge.site).toBe('bravo')
    expect(purge.purge.tags).toContain('type:hlPost@bravo')
    expect(purge.purge.tags.filter((tag) => carried.has(tag))).toEqual([])
  })
})

/* ------------------------------------------------------------- registry --- */

describe('a registry edit purges the site and says so', () => {
  const change = () =>
    fired.filter(([name]) => name === 'siteChanged').at(-1)![1] as {
      site: string
      kind: string
      change: string
      row: Record<string, unknown> | null
      purge: { tags: string[] }
    }

  it('fires siteChanged with the row and the purge issued, on every write', async () => {
    const created = await admin(
      '/api/sites',
      P,
      body({ id: 'zulu', kind: 'site', name: 'Zulu', hosts: ['zulu.example'] }),
    )
    expect(created.status).toBe(201)
    expect(change()).toMatchObject({ site: 'zulu', kind: 'site', change: 'created' })
    expect(change().row).toMatchObject({ id: 'zulu', status: 'draft', hosts: ['zulu.example'] })
    expect(change().purge).toEqual({ tags: ['site:zulu'] })

    const live = await admin('/api/sites/zulu', P, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'live' }),
    })
    expect(live.status).toBe(200)
    expect(change()).toMatchObject({ site: 'zulu', change: 'updated' })
    expect(change().row).toMatchObject({ status: 'live' })
    expect(change().purge).toEqual({ tags: ['site:zulu'] })

    const hosts = await admin('/api/sites/zulu/hosts', P, {
      method: 'PUT',
      body: JSON.stringify({ hosts: ['zulu.example', 'www.zulu.example'] }),
    })
    expect(hosts.status).toBe(200)
    expect(change()).toMatchObject({ site: 'zulu', change: 'updated' })
    expect((change().row as { hosts: string[] }).hosts).toEqual([
      'zulu.example',
      'www.zulu.example',
    ])

    const group = await admin('/api/sites', P, body({ id: 'south', kind: 'group', name: 'South' }))
    expect(group.status).toBe(201)
    expect(change()).toMatchObject({ site: 'south', kind: 'group', change: 'created' })
  })

  it('deletes a site with its grants and share links, and says it is gone', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `insert into site_grants (id, session_id, token_id, site_id, code_hash, token_hash, created_at, expires_at)
         values ('sgr_zulu', null, 'tok_zulu', 'zulu', 'cc', 'tt', 0, 9999999999999)`,
      ),
      env.DB.prepare(
        `insert into shares (id, token_hash, story_id, created_at, expires_at, site_id)
         values ('shr_zulu', 'zz', 'sty_hl_shared', 0, 9999999999999, 'zulu')`,
      ),
    ])
    const bound = await createToken(env.DB, {
      name: 'zulu-bot',
      scopes: ['content:read'],
      site: 'zulu',
    })
    await env.DB.batch([
      env.DB.prepare(
        `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
         values ('frm_zulu0000001', 'zulu-shared', 'Shared', '[]', 0, 0, 'shared')`,
      ),
      env.DB.prepare(
        `insert into form_responses (id, form_id, version, created_at, data, body_hash, site_id)
         values ('res_zulu0000001', 'frm_zulu0000001', 1, 1, '{}', 'h', 'zulu')`,
      ),
    ])
    // Answers it received are content: the delete is refused, naming them.
    const refused = await admin('/api/sites/zulu', P, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect((await json(refused)).error.message).toMatch(/form_responses/)
    await env.DB.prepare(`delete from form_responses where id = 'res_zulu0000001'`).run()

    const gone = await admin('/api/sites/zulu', P, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    // The token bound to it is gone, so the id cannot be registered again to revive it.
    expect(
      await env.DB.prepare('select count(*) as n from api_tokens where site_id = ?')
        .bind('zulu')
        .first(),
    ).toEqual({ n: 0 })
    expect(bound.token).toBeTruthy()
    expect(change()).toMatchObject({ site: 'zulu', kind: 'site', change: 'deleted', row: null })
    expect(change().purge).toEqual({ tags: ['site:zulu'] })
    const left = await env.DB.prepare(
      `select (select count(*) from site_grants where site_id = 'zulu') as grants,
              (select count(*) from shares where site_id = 'zulu') as shares,
              (select count(*) from sites where id = 'zulu') as sites,
              (select count(*) from site_hosts where site_id = 'zulu') as hosts`,
    ).first()
    expect(left).toEqual({ grants: 0, shares: 0, sites: 0, hosts: 0 })

    const group = await admin('/api/sites/south', P, { method: 'DELETE' })
    expect(group.status).toBe(200)
    expect(change()).toMatchObject({ site: 'south', kind: 'group', change: 'deleted' })
  })

  it('is refused to a site admin, and fires nothing', async () => {
    const before = fired.length
    const res = await admin('/api/sites', U, body({ id: 'yankee', kind: 'site', name: 'Y' }))
    expect(res.status).toBe(403)
    expect(fired.length).toBe(before)
  })
})

/* -------------------------------------------------------- sign-in mapping --- */

describe('roleFromClaim’s default on a deployment with sites', () => {
  const withMapper = (roleFrom: ReturnType<typeof roleFromClaim>, sites = true) =>
    createFolio<Cloudflare.Env>({
      ...base,
      auth: {
        providers: [
          oidc<Cloudflare.Env>({
            issuer: 'https://idp.example',
            clientId: 'folio',
            clientSecret: () => 'shh',
            provision: 'refuse',
            roleFrom,
          }),
        ],
      },
      ...(sites ? { sites: { admin: ADMIN_ORIGIN } } : {}),
    } as FolioConfig<Cloudflare.Env>)

  it('is refused at construction: it would be a role on every site for anybody the directory admits', () => {
    const mapper = roleFromClaim({
      claim: 'groups',
      map: { 'g-alpha': { scope: 'alpha', role: 'editor' } },
      default: 'viewer',
    })
    expect(() => withMapper(mapper)).toThrow(/default role \('viewer'\).*every site/)
  })

  it('still constructs without one, and on a deployment with one site', () => {
    expect(() =>
      withMapper(
        roleFromClaim({ claim: 'groups', map: { 'g-alpha': { scope: 'alpha', role: 'editor' } } }),
      ),
    ).not.toThrow()
    expect(() =>
      withMapper(
        roleFromClaim({ claim: 'groups', map: { staff: 'editor' }, default: 'viewer' }),
        false,
      ),
    ).not.toThrow()
  })
})
