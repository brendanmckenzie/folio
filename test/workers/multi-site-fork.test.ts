import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import type { Grants } from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'
import type { HookEvent } from '../../src/server/hooks'

/**
 * Many sites in one deployment, phase 7 (`docs/specs/foundation/multi-site.md`):
 * the fork route and its rules (decision 5), the routes that list and write a scope's
 * own rows, and what the after-commit hooks carry — `site`, and the `purge` Folio
 * issued (decision 16) — for the events a route fires.
 *
 * Everything goes through `handle()` and the real routes, as a person with a session,
 * because the point of this phase is that each route binds the request's scope.
 *
 * The registry: group `north`; `alpha` (in north, live, `alpha.example`); `bravo`
 * (live, `bravo.example`); and the migration's own `default`. `shared` owns a home
 * page, `stores`, and `info` with `info/parking`.
 */

const ADMIN_ORIGIN = 'https://cms.example'
const BASE = `${ADMIN_ORIGIN}/folio`

const page = defineBlock({
  name: 'sfPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }) },
  render: () => null,
})

/** Every hook payload a host hook saw, in order: `[event, payload]`. */
const fired: [HookEvent, Record<string, unknown>][] = []
const ALL: HookEvent[] = [
  'published',
  'unpublished',
  'pathsChanged',
  'created',
  'deleted',
  'updated',
  'redirectsChanged',
  'siteChanged',
]
const hooks = Object.fromEntries(
  ALL.map((name) => [
    name,
    (payload: Record<string, unknown>) => {
      fired.push([name, payload])
    },
  ]),
)

/** The Durable Object names the space namespace was asked for. */
const spaceNames: string[] = []
function watchedSpace(ns: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (prop === 'idFromName') {
        return (name: string) => {
          spaceNames.push(name)
          return target.idFromName(name)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const config: FolioConfig<Cloudflare.Env> = {
  blocks: [page],
  types: [
    { name: 'sfPage', label: 'Page', kind: 'page', root: 'sfPage', default: true },
    { name: 'sfRecord', label: 'Record', kind: 'record', root: 'sfPage' },
  ],
  bindings: (e): FolioBindings => ({
    db: e.DB,
    story: e.STORY,
    media: e.MEDIA,
    images: e.IMAGES,
    space: watchedSpace(e.SPACE as unknown as DurableObjectNamespace) as typeof e.SPACE,
  }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN_ORIGIN },
  // Awaited, so a payload is in `fired` by the time the response is.
  hooks: { ...hooks, await: ALL },
}

const folio = createFolio<Cloudflare.Env>(config)

async function call(path: string, who: Record<string, string>, init: RequestInit = {}) {
  const res = await folio.handle(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: { ...who, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    }),
    env,
    createExecutionContext(),
  )
  if (!res) throw new Error(`handle() answered null for ${path}`)
  return res
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads a response by its shape
const json = async <T = Record<string, any>>(res: Response): Promise<T> => (await res.json()) as T
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) })
const patch = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) })

function doc(uid: string, title: string): Doc {
  return {
    root: uid,
    bloks: {
      [uid]: { uid, type: 'sfPage', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

async function row(
  id: string,
  site: string,
  path: string,
  opts: { type?: string; parent?: string | null; published?: number | null; title?: string } = {},
) {
  const published = opts.published === undefined ? 2 : opts.published
  const slug = path.split('/').pop() ?? ''
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, 'a0', ?, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type ?? 'sfPage',
      opts.parent ?? null,
      slug,
      path === '' ? null : path,
      opts.title ?? id,
      site,
      published === null ? null : JSON.stringify(doc('r0', opts.title ?? id) as unknown as Json),
      published,
    )
    .run()
  // A root's path is '' (not null), which the insert above cannot say for a `null` path.
  if (path === '') {
    await env.DB.prepare(`update stories set path = '', slug = '' where id = ?`).bind(id).run()
  }
}

async function person(email: string, grants: Grants): Promise<Record<string, string>> {
  const user = await createUser(env.DB, { email, grants })
  const { token } = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${token}` }
}

const paths = async (site: string) =>
  (
    await env.DB.prepare('select path from stories where site_id = ? and path is not null')
      .bind(site)
      .all<{ path: string }>()
  ).results.map((r) => r.path)

let V: Record<string, string> // {alpha: viewer}
let E: Record<string, string> // {alpha: editor}
let U: Record<string, string> // {alpha: publisher}
let A: Record<string, string> // {alpha: admin}
let B: Record<string, string> // {bravo: publisher}
let S: Record<string, string> // {shared: publisher}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at) values
         ('north', 'group', 'North', null, null, null, 0, 0),
         ('alpha', 'site', 'Alpha', 'north', 'live', null, 0, 0),
         ('bravo', 'site', 'Bravo', null, 'live', null, 0, 0)`,
    ),
    env.DB.prepare(
      `insert into site_hosts (host, site_id) values ('alpha.example', 'alpha'), ('bravo.example', 'bravo')`,
    ),
  ])
  await row('sty_sf_shared_home', 'shared', '', { title: 'Shared home' })
  await row('sty_sf_shared_stores', 'shared', 'stores', { title: 'Shared stores' })
  await row('sty_sf_shared_info', 'shared', 'info', { title: 'Info' })
  await row('sty_sf_shared_parking', 'shared', 'info/parking', {
    parent: 'sty_sf_shared_info',
    title: 'Parking',
  })
  await row('sty_sf_shared_record', 'shared', 'rec', { type: 'sfRecord', title: 'A record' })
  // A record is unrouted: its path is null.
  await env.DB.prepare(`update stories set path = null where id = 'sty_sf_shared_record'`).run()
  await row('sty_sf_alpha_about', 'alpha', 'about', { title: 'Alpha about' })
  await row('sty_sf_bravo_about', 'bravo', 'about', { title: 'Bravo about' })

  V = await person('v@sf.example', { alpha: 'viewer' })
  E = await person('e@sf.example', { alpha: 'editor' })
  U = await person('u@sf.example', { alpha: 'publisher' })
  A = await person('a@sf.example', { alpha: 'admin' })
  B = await person('b@sf.example', { bravo: 'publisher' })
  S = await person('s@sf.example', { shared: 'publisher' })
})

const readerAt = (site: string, path: string) =>
  folio.reader(env, new Request(`https://${site}.example/${path}`))

/* -------------------------------------------------------------- the fork --- */

describe('the fork route', () => {
  let forkId = ''

  it('copies an inherited page into the site as a draft, from its published document, with fresh uids', async () => {
    const res = await call('/~alpha/api/stories/sty_sf_shared_stores/fork', E, { method: 'POST' })
    expect(res.status).toBe(201)
    const { story } = await json(res)
    forkId = story.id
    expect(story).toMatchObject({
      site: 'alpha',
      forkedFrom: 'sty_sf_shared_stores',
      slug: 'stores',
      path: 'stores',
      state: 'draft',
    })
    // The URL is the site's own, not a path on the admin origin.
    expect(story.url).toBe('https://alpha.example/stores')

    const { doc: draft } = await json<{ doc: Doc }>(
      await call(`/~alpha/api/story/${forkId}/document`, E),
    )
    expect(draft.bloks[draft.root]?.data.title).toBe('Shared stores')
    // A fresh uid: nothing in the copy names the source's blocks.
    expect(draft.root).not.toBe('r0')

    const created = fired.filter(([name]) => name === 'created').at(-1)
    expect(created?.[1]).toMatchObject({ site: 'alpha' })
  })

  it('does not blank the page visitors see while the fork is a draft', async () => {
    expect((await readerAt('alpha', 'stores').page('stores'))?.story.id).toBe(
      'sty_sf_shared_stores',
    )
  })

  it('reports nothing changed until the source is published again', async () => {
    const before = await json(await call(`/~alpha/api/story/${forkId}/fork`, V))
    expect(before.fork).toMatchObject({ changed: false, source: { id: 'sty_sf_shared_stores' } })

    const listed = await json(await call('/~alpha/api/inherited', V))
    const stores = listed.rows.find((r: { id: string }) => r.id === 'sty_sf_shared_stores')
    expect(stores).toMatchObject({ shadowedBy: forkId, forkedSince: false })
    // Bravo's page is not on offer, and neither is anything alpha owns.
    expect(listed.rows.map((r: { id: string }) => r.id)).not.toContain('sty_sf_bravo_about')
    expect(listed.rows.map((r: { id: string }) => r.id)).not.toContain('sty_sf_alpha_about')
  })

  it('publishes: the fork shadows the shared page on alpha alone, and the purge names the path', async () => {
    const res = await call(`/~alpha/api/story/${forkId}/publish`, U, { method: 'POST' })
    expect(res.status).toBe(200)

    const published = fired.filter(([name]) => name === 'published').at(-1)![1] as {
      site: string
      purge: { tags: string[] }
    }
    expect(published.site).toBe('alpha')
    expect(published.purge.tags).toContain('path:alpha:stores')
    expect(published.purge.tags).toContain(`story:${forkId}`)
    expect(published.purge.tags).toContain('type:sfPage@alpha')
    // Nothing a bravo render carries.
    expect(published.purge.tags.filter((t) => /bravo/.test(t))).toEqual([])

    expect((await readerAt('alpha', 'stores').page('stores'))?.story.id).toBe(forkId)
    expect((await readerAt('bravo', 'stores').page('stores'))?.story.id).toBe(
      'sty_sf_shared_stores',
    )
  })

  it('says the shared version has changed once the source is published after the fork', async () => {
    await env.DB.prepare(`update stories set published_at = ? where id = 'sty_sf_shared_stores'`)
      .bind(Date.now() + 10_000)
      .run()
    const status = await json(await call(`/~alpha/api/story/${forkId}/fork`, V))
    expect(status.fork).toMatchObject({ changed: true, source: { id: 'sty_sf_shared_stores' } })

    const listed = await json(await call('/~alpha/api/inherited', V))
    expect(listed.rows.find((r: { id: string }) => r.id === 'sty_sf_shared_stores')).toMatchObject({
      shadowedBy: forkId,
      forkedSince: true,
    })
    // A page that is not a fork says so.
    expect((await json(await call('/~alpha/api/story/sty_sf_alpha_about/fork', V))).fork).toBeNull()
  })

  it('renames the fork: the redirect is alpha’s, bravo’s redirects are untouched, and both paths are purged', async () => {
    // Two redirects that point at `stores`, one per site. Renaming alpha's fork
    // must collapse alpha's and leave bravo's alone (`redirectStatements` binds the
    // scope).
    await env.DB.batch([
      env.DB.prepare(
        `insert into redirects (from_path, to_path, status, source, created_at, site_id) values
           ('alpha-old', 'stores', 301, 'manual', 0, 'alpha'),
           ('bravo-old', 'stores', 301, 'manual', 0, 'bravo'),
           ('our-stores', 'nowhere', 301, 'manual', 0, 'bravo')`,
      ),
    ])
    const res = await call(`/~alpha/api/stories/${forkId}`, U, patch({ slug: 'our-stores' }))
    expect(res.status).toBe(200)

    const rows = (
      await env.DB.prepare('select site_id, from_path, to_path from redirects order by 1, 2').all<{
        site_id: string
        from_path: string
        to_path: string
      }>()
    ).results
    expect(rows).toContainEqual({ site_id: 'alpha', from_path: 'stores', to_path: 'our-stores' })
    expect(rows).toContainEqual({ site_id: 'alpha', from_path: 'alpha-old', to_path: 'our-stores' })
    // Bravo: its redirect to `stores` still says `stores`, and its own `our-stores`
    // redirect survived alpha's rename onto that path.
    expect(rows).toContainEqual({ site_id: 'bravo', from_path: 'bravo-old', to_path: 'stores' })
    expect(rows).toContainEqual({ site_id: 'bravo', from_path: 'our-stores', to_path: 'nowhere' })

    const moved = fired.filter(([name]) => name === 'pathsChanged').at(-1)![1] as {
      site: string
      purge: { tags: string[] }
    }
    expect(moved.site).toBe('alpha')
    expect(moved.purge.tags).toEqual(
      expect.arrayContaining([`story:${forkId}`, 'path:alpha:stores', 'path:alpha:our-stores']),
    )

    expect(await readerAt('alpha', 'stores').miss('stores')).toMatchObject({
      kind: 'redirect',
      to: '/our-stores',
    })
    expect((await readerAt('bravo', 'stores').page('stores'))?.story.id).toBe(
      'sty_sf_shared_stores',
    )
  })

  it('answers gone once unpublished, and the shared page again once the fork and its redirect are removed', async () => {
    expect(
      (await call(`/~alpha/api/story/${forkId}/unpublish`, U, { method: 'POST' })).status,
    ).toBe(200)
    expect(await readerAt('alpha', 'our-stores').miss('our-stores')).toMatchObject({ kind: 'gone' })

    const removed = await call(`/~alpha/api/stories/${forkId}`, U, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    const deleted = fired.filter(([name]) => name === 'deleted').at(-1)![1] as {
      site: string
      purge: { tags: string[] }
    }
    expect(deleted.site).toBe('alpha')
    expect(deleted.purge.tags).toEqual(
      expect.arrayContaining([`story:${forkId}`, 'path:alpha:our-stores']),
    )

    // The rename's redirect (collapsed by the delete onto the parent) still beats the
    // inherited page until it is removed; the delete itself wrote none at `our-stores`'s
    // old path that a scope above serves, but that path is not served above.
    expect(await readerAt('alpha', 'stores').page('stores')).toBeNull()
    const unrouted = await call('/~alpha/api/redirects/stores', U, { method: 'DELETE' })
    expect(await json(unrouted)).toEqual({ deleted: true })
    expect((await readerAt('alpha', 'stores').page('stores'))?.story.id).toBe(
      'sty_sf_shared_stores',
    )
  })
})

describe('the fork rules', () => {
  it('forks the root into a home page of the site’s own, and lets it go once one is above', async () => {
    const res = await call('/~alpha/api/stories/sty_sf_shared_home/fork', E, { method: 'POST' })
    expect(res.status).toBe(201)
    const { story } = await json(res)
    expect(story).toMatchObject({ path: '', slug: '', parentId: null, site: 'alpha' })

    // A second is refused, and the scope has one.
    expect(
      (await call('/~alpha/api/stories/sty_sf_shared_home/fork', E, { method: 'POST' })).status,
    ).toBe(409)
    // Shared has a root, so alpha's is deletable and its home is shared's again.
    const gone = await call(`/~alpha/api/stories/${story.id}`, A, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect((await json(gone)).deleted).toEqual([story.id])
  })

  it('never deletes the shared root, nor a root with nothing above it', async () => {
    const shared = await call('/~shared/api/stories/sty_sf_shared_home', S, { method: 'DELETE' })
    expect(shared.status).toBe(409)
  })

  it('creates a scope’s home page once, by root: true', async () => {
    const made = await call('/~bravo/api/stories', B, body({ title: 'Home', root: true }))
    expect(made.status).toBe(200)
    expect(await json(made)).toMatchObject({ path: '', site: 'bravo', parentId: null })
    const again = await call('/~bravo/api/stories', B, body({ title: 'Home 2', root: true }))
    expect(again.status).toBe(409)
    // Alpha is not bravo: it has no home of its own, so it may create one.
    const alpha = await call('/~alpha/api/stories', U, body({ title: 'Home', root: true }))
    expect(alpha.status).toBe(200)
    expect(await json(alpha)).toMatchObject({ path: '', site: 'alpha' })
  })

  it('refuses a fork under a parent the site does not own, naming it: fork Info first', async () => {
    const before = await paths('alpha')
    const res = await call('/~alpha/api/stories/sty_sf_shared_parking/fork', E, { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await json(res)).error.message).toMatch(/Fork Info first/)
    // Nothing landed under a shared parent.
    expect(await paths('alpha')).toEqual(before)
  })

  it('lands the fork under the site’s own parent once that is forked', async () => {
    const info = await call('/~alpha/api/stories/sty_sf_shared_info/fork', E, { method: 'POST' })
    expect(info.status).toBe(201)
    const infoId = (await json(info)).story.id
    const parking = await call('/~alpha/api/stories/sty_sf_shared_parking/fork', E, {
      method: 'POST',
    })
    expect(parking.status).toBe(201)
    expect((await json(parking)).story).toMatchObject({
      path: 'info/parking',
      parentId: infoId,
      site: 'alpha',
    })
  })

  it('falls back to the inherited page when a fork is deleted with the default redirect, top level and nested', async () => {
    // Publish both forks so they are live, then delete each the way the admin's Delete
    // button does, redirect checked. The path is still served by shared, so no redirect
    // may be written at it: it would beat the page the delete brings back.
    const forks = (
      await env.DB.prepare(
        `select id, path from stories where site_id = 'alpha' and path in ('info', 'info/parking')`,
      ).all<{ id: string; path: string }>()
    ).results
    const byPath = Object.fromEntries(forks.map((f) => [f.path, f.id]))
    for (const id of Object.values(byPath)) {
      expect((await call(`/~alpha/api/story/${id}/publish`, U, { method: 'POST' })).status).toBe(
        200,
      )
    }
    expect((await readerAt('alpha', 'info/parking').page('info/parking'))?.story.id).toBe(
      byPath['info/parking'],
    )

    // Nested first.
    const nested = await call(`/~alpha/api/stories/${byPath['info/parking']}`, U, {
      method: 'DELETE',
    })
    expect(nested.status).toBe(200)
    const redirectsAt = async (path: string) =>
      (
        await env.DB.prepare(
          `select count(*) as n from redirects where site_id = 'alpha' and from_path = ?`,
        )
          .bind(path)
          .first<{ n: number }>()
      )?.n
    expect(await redirectsAt('info/parking')).toBe(0)
    expect((await readerAt('alpha', 'info/parking').page('info/parking'))?.story.id).toBe(
      'sty_sf_shared_parking',
    )

    // Then the top-level fork.
    const top = await call(`/~alpha/api/stories/${byPath.info}`, U, { method: 'DELETE' })
    expect(top.status).toBe(200)
    expect(await redirectsAt('info')).toBe(0)
    expect((await readerAt('alpha', 'info').page('info'))?.story.id).toBe('sty_sf_shared_info')
  })

  it('still leaves the redirect for a page nothing above serves', async () => {
    const made = await json(await call('/~alpha/api/stories', U, body({ title: 'Solo page' })))
    const gone = await call(`/~alpha/api/stories/${made.id}`, U, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    const row = await env.DB.prepare(
      `select count(*) as n from redirects where site_id = 'alpha' and from_path = 'solo-page'`,
    ).first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('refuses what is not there to fork', async () => {
    // Another site's page is not in the chain: absent, never a 403 that confirms it.
    expect(
      (await call('/~alpha/api/stories/sty_sf_bravo_about/fork', E, { method: 'POST' })).status,
    ).toBe(404)
    // The site's own page has nothing above it.
    expect(
      (await call('/~alpha/api/stories/sty_sf_alpha_about/fork', E, { method: 'POST' })).status,
    ).toBe(409)
    // A record has no path, so it is not a page.
    expect(
      (await call('/~alpha/api/stories/sty_sf_shared_record/fork', E, { method: 'POST' })).status,
    ).toBe(400)
    // A site that already has a page at the path keeps it.
    await row('sty_sf_shared_about', 'shared', 'about', { title: 'Shared about' })
    const taken = await call('/~alpha/api/stories/sty_sf_shared_about/fork', E, { method: 'POST' })
    expect(taken.status).toBe(409)
    expect((await json(taken)).error.message).toMatch(/already lives at \/about/)
  })

  it('needs CREATE on the scope', async () => {
    expect(
      (await call('/~alpha/api/stories/sty_sf_shared_stores/fork', V, { method: 'POST' })).status,
    ).toBe(403)
  })
})

/* ------------------------------------------------- duplicate, in scope --- */

describe('duplicating an inherited page', () => {
  it('reads the source up the chain and lands the copy in the request’s scope', async () => {
    const res = await call('/~alpha/api/stories/sty_sf_shared_info/duplicate', E, body({}))
    expect(res.status).toBe(201)
    const { story } = await json(res)
    expect(story.site).toBe('alpha')
    // A shared page's parent is shared's, which is not this scope's: the copy is at the top.
    expect(story.parentId).toBeNull()
    const created = fired.filter(([name]) => name === 'created').at(-1)![1] as { site: string }
    expect(created.site).toBe('alpha')
  })

  it('still cannot copy another site’s page', async () => {
    const res = await call('/~alpha/api/stories/sty_sf_bravo_about/duplicate', E, body({}))
    expect(res.status).toBe(404)
  })

  it('does the same over v1', async () => {
    const res = await call('/~alpha/api/v1/documents/sty_sf_shared_stores/duplicate', E, body({}))
    expect(res.status).toBe(201)
    expect((await json(res)).document.site).toBe('alpha')
  })
})

/* ------------------------------------------------------- scoped redirects --- */

describe('redirects are one scope’s routing', () => {
  it('lists, adds and removes only the request’s own', async () => {
    await env.DB.prepare(
      `insert into redirects (from_path, to_path, status, source, created_at, site_id) values
         ('r-alpha', 'about', 301, 'manual', 5, 'alpha'),
         ('r-bravo', 'about', 301, 'manual', 6, 'bravo')`,
    ).run()

    const alpha = await json(await call('/~alpha/api/redirects', V))
    const from = alpha.rows.map((r: { from: string }) => r.from)
    expect(from).toContain('r-alpha')
    expect(from).not.toContain('r-bravo')

    // Removing a path the scope has no redirect at removes nothing anywhere.
    const foreign = await call('/~alpha/api/redirects/r-bravo', U, { method: 'DELETE' })
    expect(await json(foreign)).toEqual({ deleted: false })
    const kept = await env.DB.prepare(
      `select count(*) as n from redirects where from_path = 'r-bravo'`,
    ).first()
    expect(kept).toEqual({ n: 1 })
    expect(fired.filter(([name]) => name === 'redirectsChanged').at(-1)?.[1]).not.toMatchObject({
      from: ['r-bravo'],
    })

    const own = await call('/~alpha/api/redirects/r-alpha', U, { method: 'DELETE' })
    expect(await json(own)).toEqual({ deleted: true })
    const event = fired.filter(([name]) => name === 'redirectsChanged').at(-1)![1] as {
      site: string
      from: string[]
      purge: { tags: string[] }
    }
    expect(event).toMatchObject({ site: 'alpha', from: ['r-alpha'] })
    expect(event.purge.tags).toEqual(['path:alpha:r-alpha'])
  })

  it('adds a redirect in the request’s scope, over a page it merely inherits', async () => {
    // `news` is shared's and alpha has none of its own, so a redirect from it is the
    // site overriding what it inherits, not a trap.
    await row('sty_sf_shared_news', 'shared', 'news', { title: 'Shared news' })
    const res = await call(
      '/~alpha/api/redirects',
      U,
      body({ from: 'news', to: 'about', status: 302 }),
    )
    expect(res.status).toBe(201)
    const stored = await env.DB.prepare(
      `select site_id from redirects where from_path = 'news' and status = 302`,
    ).first()
    expect(stored).toEqual({ site_id: 'alpha' })
    expect((await readerAt('alpha', 'news').miss('news')).kind).toBe('redirect')
    // Bravo, which added nothing, still serves the shared page.
    expect((await readerAt('bravo', 'news').page('news'))?.story.id).toBe('sty_sf_shared_news')
    // A scope's own page is a trap, as before.
    const trap = await call('/~alpha/api/redirects', U, body({ from: 'about', to: 'news' }))
    expect(trap.status).toBe(409)
  })
})

/* ---------------------------------------------------------- scoped lists --- */

describe('the list readers answer the request’s scope', () => {
  it('lists a scope’s own pages, flat and by level, and counts them', async () => {
    const flat = await json(await call('/~alpha/api/stories?flat=1', V))
    const ids = flat.rows.map((r: { id: string }) => r.id)
    expect(ids).toContain('sty_sf_alpha_about')
    expect(ids).not.toContain('sty_sf_bravo_about')
    expect(ids).not.toContain('sty_sf_shared_stores')

    const level = await json(await call('/~bravo/api/stories', B))
    expect(level.rows.map((r: { id: string }) => r.id)).toContain('sty_sf_bravo_about')
    expect(level.rows.map((r: { id: string }) => r.id)).not.toContain('sty_sf_alpha_about')

    const recent = await json(await call('/~alpha/api/stories?recent=1', V))
    expect(recent.rows.map((r: { id: string }) => r.id)).not.toContain('sty_sf_bravo_about')

    const counts = await json(await call('/~bravo/api/counts', B))
    const bravoPages = (
      await env.DB.prepare(
        `select count(*) as n from stories where site_id = 'bravo' and path is not null`,
      ).first<{ n: number }>()
    )?.n
    expect(counts.pages).toBe(bravoPages)
  })

  it('lists documents of one scope, and creates in it', async () => {
    const docs = await json(await call('/~alpha/api/documents?type=sfRecord', V))
    // The shared record is shared's: not in alpha's own list.
    expect(docs.rows.map((r: { id: string }) => r.id)).not.toContain('sty_sf_shared_record')
    const shared = await json(await call('/~shared/api/documents?type=sfRecord', S))
    expect(shared.rows.map((r: { id: string }) => r.id)).toContain('sty_sf_shared_record')
  })

  it('searches the chain, each hit carrying its site, and never another site', async () => {
    const res = await json(await call('/~alpha/api/search?q=about', V))
    const hits = res.rows as { id: string; site: string }[]
    expect(hits.find((h) => h.id === 'sty_sf_alpha_about')?.site).toBe('alpha')
    expect(hits.find((h) => h.id === 'sty_sf_shared_about')?.site).toBe('shared')
    expect(hits.map((h) => h.id)).not.toContain('sty_sf_bravo_about')

    // And the v1 twin, whose rows carry `site` too.
    const v1 = await json(await call('/~alpha/api/v1/search?q=about', V))
    expect(v1.rows.map((h: { id: string }) => h.id)).not.toContain('sty_sf_bravo_about')
    expect(v1.rows.find((h: { id: string }) => h.id === 'sty_sf_shared_about')?.site).toBe('shared')
  })

  it('lists a scope’s schedules and publishes, not another’s', async () => {
    const at = Date.now() + 3_600_000
    for (const [scope, who, id] of [
      ['alpha', U, 'sty_sf_alpha_about'],
      ['bravo', B, 'sty_sf_bravo_about'],
    ] as const) {
      const scheduled = await call(
        `/~${scope}/api/story/${id}/schedule`,
        who,
        body({ action: 'publish', at }),
      )
      expect(scheduled.status).toBe(201)
      expect(
        (await call(`/~${scope}/api/story/${id}/publish`, who, { method: 'POST' })).status,
      ).toBe(200)
    }

    const schedules = await json(await call('/~alpha/api/schedules', V))
    expect(schedules.rows.map((s: { storyId: string }) => s.storyId)).toEqual([
      'sty_sf_alpha_about',
    ])

    const published = await json(await call('/~alpha/api/published', V))
    const ids = published.rows.map((r: { story: { id: string } }) => r.story.id)
    expect(ids).toContain('sty_sf_alpha_about')
    expect(ids).not.toContain('sty_sf_bravo_about')
  })

  it('counts what other sites use a document for, without naming it', async () => {
    // A shared page linked from a page on each of alpha and bravo.
    await env.DB.batch([
      env.DB.prepare(
        `insert into content_refs (from_story, to_id, kind) values
           ('sty_sf_alpha_about', 'sty_sf_shared_info', 'link'),
           ('sty_sf_bravo_about', 'sty_sf_shared_info', 'link')`,
      ),
    ])
    const usage = await json(await call('/~alpha/api/documents/sty_sf_shared_info/usage', E))
    expect(usage.published.map((p: { id: string }) => p.id)).toEqual(['sty_sf_alpha_about'])
    expect(usage.elsewhere).toBe(1)
    expect(JSON.stringify(usage)).not.toContain('sty_sf_bravo_about')

    // On `~shared`, a caller who can also read alpha (but not bravo) is told which alpha
    // pages use it; bravo's stay a count.
    const both = await person('sa@sf.example', { shared: 'publisher', alpha: 'editor' })
    const shared = await json(await call('/~shared/api/documents/sty_sf_shared_info/usage', both))
    expect(shared.published.map((p: { id: string }) => p.id)).toEqual(['sty_sf_alpha_about'])
    expect(shared.elsewhere).toBe(1)
    // A platform admin reads everything, so nothing is left to count.
    const platform = await person('pa@sf.example', { '*': 'admin' })
    const all = await json(await call('/~shared/api/documents/sty_sf_shared_info/usage', platform))
    expect(all.published.map((p: { id: string }) => p.id).sort()).toEqual([
      'sty_sf_alpha_about',
      'sty_sf_bravo_about',
    ])
    expect(all.elsewhere).toBe(0)
  })
})

/* ------------------------------------------------------------- hooks --- */

describe('hook payloads', () => {
  it('carry the story’s site, whichever door the write came through', async () => {
    const before = fired.length
    const made = await call('/~bravo/api/v1/documents', B, body({ title: 'Via v1' }))
    expect(made.status).toBe(201)
    const created = fired.slice(before).find(([name]) => name === 'created')
    expect(created?.[1]).toMatchObject({ site: 'bravo' })
    // A create publishes nothing, so it purged nothing.
    expect(created?.[1]?.purge).toBeUndefined()
  })
})

describe('the space channel is one per scope', () => {
  it('broadcasts an event to the story’s own scope, not to a channel every site shares', async () => {
    spaceNames.length = 0
    const alpha = await call('/~alpha/api/stories', E, body({ title: 'Space alpha' }))
    expect(alpha.status).toBe(200)
    await call('/~bravo/api/stories', B, body({ title: 'Space bravo' }))
    await call('/~shared/api/stories', S, body({ title: 'Space shared' }))
    expect(spaceNames).toContain('space:alpha')
    expect(spaceNames).toContain('space:bravo')
    expect(spaceNames).toContain('space:shared')
    expect(spaceNames).not.toContain('space')
  })

  it('opens a scope’s socket on that scope’s channel', async () => {
    spaceNames.length = 0
    const socket = await call('/~alpha/api/space/socket', { ...E, upgrade: 'websocket' })
    expect(socket.status).toBe(101)
    socket.webSocket?.accept()
    socket.webSocket?.close()
    expect(spaceNames).toEqual(['space:alpha'])
  })
})
