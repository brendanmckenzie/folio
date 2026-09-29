import { createExecutionContext, env } from 'cloudflare:test'
import { createElement } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import type { Grants } from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'

/**
 * `GET {base}/api/me` on a deployment with `sites`
 * (`docs/specs/foundation/multi-site.md`, phase 8): the scopes a caller reaches, the
 * sites they may preview, and whether they are the platform — through `handle()`, as
 * the admin asks it.
 *
 * The pure answers are `test/unit/server/me-sites.test.ts`; what is asserted here is
 * only what a unit test cannot see: that the route sends them, that they come from
 * the caller's real grants in D1, and that a deployment with **no** `sites` sends
 * none of it — the key's absence is how the admin knows which kind it is talking to.
 */

const ADMIN = 'https://cms.example'

const page = defineBlock({
  name: 'meSitesPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: ({ title }) => createElement('main', null, createElement('h1', null, title)),
})

const base: FolioConfig<Cloudflare.Env> = {
  blocks: [page],
  types: [{ name: 'meSitesPage', label: 'Page', kind: 'page', root: 'meSitesPage', default: true }],
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
}

const multi = createFolio<Cloudflare.Env>({
  ...base,
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN },
})
const solo = createFolio<Cloudflare.Env>(base)

async function me(folio: typeof multi, origin: string, cookie: string | null) {
  const res = await folio.handle(
    new Request(`${origin}/folio/api/me`, { headers: cookie ? { cookie } : {} }),
    env,
    createExecutionContext(),
  )
  if (!res) throw new Error('handle() answered null')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function person(email: string, grants: Grants) {
  const user = await createUser(env.DB, { email, grants })
  const session = await createSession(env.DB, user.id)
  return `${SECURE_COOKIE}=${session.token}`
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', 'https://preview.alpha.example', 0, 0),
         ('bravo', 'site', 'Bravo', null, 'draft', null, 0, 0)`,
    ),
  ])
})

describe('GET /api/me with sites', () => {
  it('sends a platform admin every scope, as admin, and the platform flag', async () => {
    const { status, body } = await me(multi, ADMIN, await person('p@example.com', { '*': 'admin' }))
    expect(status).toBe(200)
    const sites = body.sites as {
      platform: boolean
      scopes: { id: string; role: string }[]
      previewable: { id: string }[]
    }
    expect(sites.platform).toBe(true)
    // `default` is the migration's own row.
    expect(sites.scopes.map((s) => s.id)).toEqual(['shared', 'north', 'alpha', 'bravo', 'default'])
    expect(sites.scopes.every((s) => s.role === 'admin')).toBe(true)
    expect(sites.previewable.map((s) => s.id)).toEqual(['alpha', 'bravo', 'default'])
  })

  it('sends a site admin their site, its chain read-only, and not the platform', async () => {
    const { body } = await me(multi, ADMIN, await person('a@example.com', { alpha: 'admin' }))
    const sites = body.sites as {
      platform: boolean
      scopes: { id: string; role: string }[]
      grants: object
    }
    expect(sites.platform).toBe(false)
    expect(sites.scopes.map((s) => [s.id, s.role])).toEqual([
      ['shared', 'viewer'],
      ['north', 'viewer'],
      ['alpha', 'admin'],
    ])
    expect(sites.grants).toEqual({ alpha: 'admin' })
    // `role` is the `*` grant, which this person does not hold.
    expect((body.actor as { role: string }).role).toBe('viewer')
  })

  it('sends a national publisher shared alone, and every site to preview', async () => {
    const { body } = await me(multi, ADMIN, await person('n@example.com', { shared: 'publisher' }))
    const sites = body.sites as {
      scopes: { id: string }[]
      previewable: { id: string; chain: string[] }[]
    }
    expect(sites.scopes.map((s) => s.id)).toEqual(['shared'])
    expect(sites.previewable.find((s) => s.id === 'alpha')?.chain).toEqual([
      'alpha',
      'north',
      'shared',
    ])
  })

  it('carries the site’s preview origin and status', async () => {
    const { body } = await me(multi, ADMIN, await person('o@example.com', { '*': 'viewer' }))
    const sites = body.sites as {
      scopes: { id: string; preview: string | null; status: string | null }[]
    }
    expect(sites.scopes.find((s) => s.id === 'alpha')).toMatchObject({
      preview: 'https://preview.alpha.example',
      status: 'live',
    })
    expect(sites.scopes.find((s) => s.id === 'bravo')?.preview).toBeNull()
  })

  it('refuses a caller with no session, as it always has', async () => {
    expect((await me(multi, ADMIN, null)).status).toBe(401)
  })
})

describe('GET /api/me with no sites', () => {
  it('sends no `sites` key at all, which is how the admin knows it is single-site', async () => {
    const { status, body } = await me(
      solo,
      'https://single.example',
      await person('s@example.com', { '*': 'admin' }),
    )
    expect(status).toBe(200)
    expect('sites' in body).toBe(false)
    expect((body.actor as { role: string }).role).toBe('admin')
  })
})
