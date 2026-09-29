import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineBlock, form, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { FolioBindings, FolioConfig } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import type { Grants } from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import { describeAsset, validateDescribe } from '../../src/server/describe'
import type { HookEvent } from '../../src/server/hooks'

/**
 * Many sites in one deployment, phase 7 (`docs/specs/foundation/multi-site.md`
 * decision 3 and the route table): the media library, forms and responses are each
 * one scope's, read by scope (a picker by chain), written by scope, and fenced by id.
 *
 * "Tagging across scopes refused", "a form in the submitting site's chain", and
 * "`form_responses.site_id` = submitting site" are the three rules with no other test.
 *
 * The registry: group `north`; `alpha` (in north, `alpha.example`); `bravo`
 * (`bravo.example`); and the migration's own `default`.
 */

const ADMIN_ORIGIN = 'https://cms.example'
const BASE = `${ADMIN_ORIGIN}/folio`

const page = defineBlock({
  name: 'slPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ label: 'Title' }), contact: form({ label: 'Contact' }) },
  render: () => null,
})

const fired: [HookEvent, Record<string, unknown>][] = []

const config: FolioConfig<Cloudflare.Env> = {
  blocks: [page],
  types: [{ name: 'slPage', label: 'Page', kind: 'page', root: 'slPage', default: true }],
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: '/folio',
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  auth: { providers: [magicLink<Cloudflare.Env>({ send: () => {} })] },
  route: (p, _locale, site) =>
    site ? `https://${site.hosts[0] ?? `${site.id}.invalid`}/${p}` : p ? `/${p}` : '/',
  sites: { admin: ADMIN_ORIGIN },
  hooks: {
    submitted: (e) => {
      fired.push(['submitted', e as unknown as Record<string, unknown>])
    },
    await: ['submitted'],
  },
}

const folio = createFolio<Cloudflare.Env>(config)

async function call(path: string, who: Record<string, string>, init: RequestInit = {}) {
  const res = await folio.handle(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        ...who,
        ...(init.body && typeof init.body === 'string'
          ? { 'content-type': 'application/json' }
          : {}),
      },
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

/** 1×1 transparent PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

async function person(email: string, grants: Grants): Promise<Record<string, string>> {
  const user = await createUser(env.DB, { email, grants })
  const { token } = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${token}` }
}

let E: Record<string, string> // {alpha: editor}
let U: Record<string, string> // {alpha: publisher}
let A: Record<string, string> // {alpha: admin}
let B: Record<string, string> // {bravo: admin}
let S: Record<string, string> // {shared: admin}

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
  E = await person('e@sl.example', { alpha: 'editor' })
  U = await person('u@sl.example', { alpha: 'publisher' })
  A = await person('a@sl.example', { alpha: 'admin' })
  B = await person('b@sl.example', { bravo: 'admin' })
  S = await person('s@sl.example', { shared: 'admin' })
})

const upload = (scope: string, who: Record<string, string>, filename: string) =>
  call(`/~${scope}/api/assets?filename=${filename}`, who, { method: 'POST', body: PNG })

const siteOf = async (table: string, id: string) =>
  (
    await env.DB.prepare(`select site_id as site from ${table} where id = ?`)
      .bind(id)
      .first<{ site: string }>()
  )?.site

/* ------------------------------------------------------------- the library --- */

describe('the media library is one scope’s', () => {
  const ids: Record<string, string> = {}

  it('uploads into the request’s scope, over the admin API and v1', async () => {
    for (const [scope, who] of [
      ['alpha', E],
      ['bravo', B],
      ['shared', S],
    ] as const) {
      const res = await upload(scope, who, `${scope}.png`)
      expect(res.status).toBe(201)
      ids[scope] = (await json(res)).asset.id
      expect(await siteOf('assets', ids[scope]!)).toBe(scope)
    }
    const { token } = await createToken(env.DB, {
      name: 'alpha-push',
      scopes: ['assets:write', 'content:read'],
      site: 'alpha',
    })
    const v1 = await call(
      '/api/v1/assets?filename=v1.png',
      { authorization: `Bearer ${token}` },
      {
        method: 'POST',
        body: PNG,
      },
    )
    expect(v1.status).toBe(201)
    expect(await siteOf('assets', (await json(v1)).asset.id)).toBe('alpha')
    const listed = await json(await call('/api/v1/assets', { authorization: `Bearer ${token}` }))
    expect(listed.assets.map((a: { id: string }) => a.id)).toContain(ids.alpha)
    expect(listed.assets.map((a: { id: string }) => a.id)).not.toContain(ids.bravo)
    expect(listed.assets.map((a: { id: string }) => a.id)).not.toContain(ids.shared)
  })

  it('lists its own, and — for a picker, with ?chain=1 — the scopes above it, never a sibling', async () => {
    const own = await json(await call('/~alpha/api/assets', E))
    const ownIds = own.rows.map((r: { id: string }) => r.id)
    expect(ownIds).toContain(ids.alpha)
    expect(ownIds).not.toContain(ids.shared)
    expect(ownIds).not.toContain(ids.bravo)

    const picker = await json(await call('/~alpha/api/assets?chain=1&count=1', E))
    const pickIds = picker.rows.map((r: { id: string }) => r.id)
    expect(pickIds).toEqual(expect.arrayContaining([ids.alpha, ids.shared]))
    expect(pickIds).not.toContain(ids.bravo)
    expect(picker.total).toBe(pickIds.length)
  })

  it('reads a shared file up the chain and writes only its own', async () => {
    expect((await call(`/~alpha/api/assets/${ids.shared}`, E)).status).toBe(200)
    expect(
      (await call(`/~alpha/api/assets/${ids.shared}`, E, patch({ alt: 'mine now' }))).status,
    ).toBe(404)
    expect((await call(`/~alpha/api/assets/${ids.bravo}`, E, { method: 'DELETE' })).status).toBe(
      404,
    )
    expect(await siteOf('assets', ids.bravo!)).toBe('bravo')
    expect(
      (await env.DB.prepare('select alt from assets where id = ?').bind(ids.shared).first()) as {
        alt: string
      },
    ).toEqual({ alt: '' })
  })

  it('keeps folders and tags per scope: one name, two scopes, and filing across them refused', async () => {
    const folders: Record<string, string> = {}
    const tags: Record<string, string> = {}
    for (const [scope, who] of [
      ['alpha', E],
      ['bravo', B],
    ] as const) {
      const folder = await call(`/~${scope}/api/assets/folders`, who, body({ name: 'Press' }))
      expect(folder.status).toBe(201)
      folders[scope] = (await json(folder)).id
      const tag = await call(`/~${scope}/api/assets/tags`, who, body({ name: 'Headshots' }))
      expect(tag.status).toBe(201)
      tags[scope] = (await json(tag)).id
      expect(await siteOf('asset_folders', folders[scope]!)).toBe(scope)
      expect(await siteOf('asset_tags', tags[scope]!)).toBe(scope)
    }
    // Asked again in the same scope, it is the same tag; in another, a different one.
    const again = await call('/~alpha/api/assets/tags', E, body({ name: 'headshots' }))
    expect(again.status).toBe(200)
    expect((await json(again)).id).toBe(tags.alpha)

    // Each list is its own scope's.
    const alphaFolders = await json(await call('/~alpha/api/assets/folders', E))
    expect(alphaFolders.rows.map((r: { id: string }) => r.id)).toEqual([folders.alpha])
    const bravoTags = await json(await call('/~bravo/api/assets/tags', B))
    expect(bravoTags.rows.map((r: { id: string }) => r.id)).toEqual([tags.bravo])

    // Filing and tagging across scopes: an unknown folder, an unknown tag.
    const cross = await call(
      `/~alpha/api/assets/${ids.alpha}`,
      E,
      patch({ folderId: folders.bravo }),
    )
    expect(cross.status).toBe(400)
    const crossTag = await call(`/~alpha/api/assets/${ids.alpha}`, E, patch({ tags: [tags.bravo] }))
    expect(crossTag.status).toBe(400)
    const own = await call(
      `/~alpha/api/assets/${ids.alpha}`,
      E,
      patch({ folderId: folders.alpha, tags: [tags.alpha] }),
    )
    expect(own.status).toBe(200)
    expect((await json(own)).tags.map((t: { id: string }) => t.id)).toEqual([tags.alpha])

    // A rename in one scope rewrites that scope's subtree alone.
    const child = await call(
      '/~alpha/api/assets/folders',
      E,
      body({ name: '2024', parentId: folders.alpha }),
    )
    const bravoChild = await call(
      '/~bravo/api/assets/folders',
      B,
      body({ name: '2024', parentId: folders.bravo }),
    )
    expect(child.status).toBe(201)
    expect(bravoChild.status).toBe(201)
    const renamed = await call(
      `/~alpha/api/assets/folders/${folders.alpha}`,
      E,
      patch({ name: 'Media' }),
    )
    expect(renamed.status).toBe(200)
    const rows = (
      await env.DB.prepare('select site_id, path from asset_folders order by 1, 2').all<{
        site_id: string
        path: string
      }>()
    ).results
    expect(rows).toContainEqual({ site_id: 'alpha', path: 'media' })
    expect(rows).toContainEqual({ site_id: 'alpha', path: 'media/2024' })
    expect(rows).toContainEqual({ site_id: 'bravo', path: 'press' })
    expect(rows).toContainEqual({ site_id: 'bravo', path: 'press/2024' })

    // Deleting one scope's tag removes none of the other's taggings.
    const gone = await call(`/~alpha/api/assets/tags/${tags.alpha}`, E, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(await siteOf('asset_tags', tags.bravo!)).toBe('bravo')
  })

  it('acts on a bulk selection of its own files only, whole or not at all', async () => {
    const bravoFile = ids.bravo!
    const refused = await call(
      '/~alpha/api/assets/bulk/delete',
      E,
      body({ selection: { ids: [ids.alpha, bravoFile] } }),
    )
    expect(refused.status).toBe(404)
    expect(await siteOf('assets', bravoFile)).toBe('bravo')
    expect(await siteOf('assets', ids.alpha!)).toBe('alpha')

    // A captured filter is read against the scope: the count guard counts alpha's
    // files, and the walk deletes alpha's and nobody else's.
    const alphaCount = (
      await env.DB.prepare(`select count(*) as n from assets where site_id = 'alpha'`).first<{
        n: number
      }>()
    )?.n
    const run = await call(
      '/~alpha/api/assets/bulk/delete',
      E,
      body({ selection: { all: true, filter: {}, expected: alphaCount } }),
    )
    expect(run.status).toBe(200)
    expect((await json(run)).done).toBe(alphaCount)
    const left = await env.DB.prepare(
      `select site_id, count(*) as n from assets group by 1 order by 1`,
    ).all<{ site_id: string; n: number }>()
    expect(left.results).toEqual([
      { site_id: 'bravo', n: 1 },
      { site_id: 'shared', n: 1 },
    ])

    // And a guard that counted every scope would have refused this one.
    const wrong = await call(
      '/~bravo/api/assets/bulk/delete',
      B,
      body({ selection: { all: true, filter: {}, expected: 2 } }),
    )
    expect(wrong.status).toBe(409)
  })

  it('counts what other sites use a shared file for, without naming it', async () => {
    const key = (
      await env.DB.prepare('select key from assets where id = ?').bind(ids.shared).first<{
        key: string
      }>()
    )?.key
    await env.DB.batch([
      env.DB.prepare(
        `insert into stories (id, type, slug, path, ord, title, updated_at, site_id, published_doc, published_at)
         values ('sty_sl_a', 'slPage', 'a', 'a', 'a0', 'A', 1, 'alpha', '{}', 1),
                ('sty_sl_b', 'slPage', 'b', 'b', 'a0', 'B', 1, 'bravo', '{}', 1)`,
      ),
      env.DB.prepare(
        `insert into content_refs (from_story, to_id, kind) values ('sty_sl_a', ?, 'asset'), ('sty_sl_b', ?, 'asset')`,
      ).bind(key, key),
    ])
    const usage = await json(await call(`/~alpha/api/assets/${ids.shared}/usage`, E))
    expect(usage.published.map((p: { id: string }) => p.id)).toEqual(['sty_sl_a'])
    expect(usage.elsewhere).toBe(1)
    expect(JSON.stringify(usage)).not.toContain('sty_sl_b')
  })

  it('offers a model the asset’s own scope’s tags, and never applies another’s', async () => {
    // Two files in alpha and bravo, and one tag named `hero` in each.
    const a = await json(await upload('alpha', E, 'desc-a.png'))
    const b = await json(await upload('bravo', B, 'desc-b.png'))
    const tagA = (await json(await call('/~alpha/api/assets/tags', E, body({ name: 'hero' })))).id
    const tagB = (await json(await call('/~bravo/api/assets/tags', B, body({ name: 'hero' })))).id

    const offered: string[][] = []
    const describe = validateDescribe<unknown>({
      fn: async (input) => {
        offered.push(input.tags.map((t) => t.id))
        return { alt: 'an image', description: 'a picture', tags: ['hero'] }
      },
    })!
    const deps = {
      db: env.DB,
      media: env.MEDIA,
      assetBase: `${BASE}/asset`,
      describe,
      env: {},
      scoped: true,
    }
    await describeAsset(deps, a.asset)
    await describeAsset(deps, b.asset)
    expect(offered[0]).toContain(tagA)
    expect(offered[0]).not.toContain(tagB)
    expect(offered[1]).toContain(tagB)
    expect(offered[1]).not.toContain(tagA)

    // Even handed the other scope's vocabulary, the write joins an asset only to a tag of
    // its own scope.
    await env.DB.prepare('delete from asset_taggings').run()
    await describeAsset(deps, a.asset, [{ id: tagB, name: 'hero', slug: 'hero' }])
    const taggings = await env.DB.prepare('select asset_id, tag_id from asset_taggings').all()
    expect(taggings.results).toEqual([])
    await describeAsset(deps, a.asset, [{ id: tagA, name: 'hero', slug: 'hero' }])
    expect((await env.DB.prepare('select tag_id from asset_taggings').all()).results).toEqual([
      { tag_id: tagA },
    ])
  })
})

/* ----------------------------------------------------------------- forms --- */

describe('forms are one scope’s', () => {
  const ids: Record<string, string> = {}

  it('creates in the request’s scope, and one name serves two scopes', async () => {
    for (const [scope, who] of [
      ['alpha', E],
      ['bravo', B],
      ['shared', S],
    ] as const) {
      const res = await call(`/~${scope}/api/forms`, who, body({ label: 'Contact' }))
      expect(res.status).toBe(201)
      ids[scope] = (await json(res)).id
      expect(await siteOf('forms', ids[scope]!)).toBe(scope)
    }
    // The same scope refuses a second `contact`, naming the first.
    const clash = await call('/~alpha/api/forms', E, body({ label: 'Contact' }))
    expect(clash.status).toBe(409)
  })

  it('lists its own, and a picker (?chain=1) the scopes above it', async () => {
    const own = await json(await call('/~alpha/api/forms', E))
    expect(own.rows.map((r: { id: string }) => r.id)).toEqual([ids.alpha])
    const picker = await json(await call('/~alpha/api/forms?chain=1&count=1', E))
    expect(picker.rows.map((r: { id: string }) => r.id).sort()).toEqual(
      [ids.alpha, ids.shared].sort(),
    )
    expect(picker.total).toBe(2)
  })

  it('renames within its scope, and a form in another scope is not there to rename', async () => {
    const other = await call(
      `/~alpha/api/forms/${ids.bravo}`,
      E,
      patch({ label: 'x', expectedUpdatedAt: 0 }),
    )
    expect(other.status).toBe(404)
    const own = await json(await call(`/~alpha/api/forms/${ids.alpha}`, E))
    const renamed = await call(
      `/~alpha/api/forms/${ids.alpha}`,
      E,
      patch({ name: 'enquiry', expectedUpdatedAt: own.updatedAt }),
    )
    expect(renamed.status).toBe(200)
    // `contact` is bravo's and shared's; alpha taking `enquiry` collides with nobody.
    const sibling = await call('/~bravo/api/forms', B, body({ label: 'Enquiry' }))
    expect(sibling.status).toBe(201)
  })

  it('resolves a form only within the chain, in /forms/resolved and in a page render', async () => {
    const resolved = await json(
      await call(`/~alpha/api/forms/resolved?ids=${ids.shared},${ids.bravo},${ids.alpha}`, E),
    )
    expect(Object.keys(resolved).sort()).toEqual([ids.alpha, ids.shared].sort())

    // A page on alpha embedding bravo's form renders it as a deleted one.
    const doc = (formId: string): Doc => ({
      root: 'r0',
      bloks: {
        r0: {
          uid: 'r0',
          type: 'slPage',
          parent: null,
          slot: null,
          order: 'a0',
          data: { title: 'T', contact: formId },
        },
      },
    })
    const embed = async (id: string, formId: string) => {
      await env.DB.prepare(
        `insert into stories (id, type, slug, path, ord, title, updated_at, site_id, published_doc, published_at)
         values (?, 'slPage', ?, ?, 'a0', ?, 1, 'alpha', ?, 1)`,
      )
        .bind(id, id, id, id, JSON.stringify(doc(formId) as unknown as Json))
        .run()
      return folio.reader(env, new Request(`https://alpha.example/${id}`)).page(id)
    }
    const foreign = await embed('embed-bravo', ids.bravo!)
    expect(foreign?.resolution.forms?.[ids.bravo!]).toBeFalsy()
    const inherited = await embed('embed-shared', ids.shared!)
    expect(inherited?.resolution.forms?.[ids.shared!]).toBeTruthy()
    const own = await embed('embed-own', ids.alpha!)
    expect(own?.resolution.forms?.[ids.alpha!]).toBeTruthy()
  })
})

/* -------------------------------------------------- responses, by site --- */

describe('responses belong to the site that received them', () => {
  let shared = ''
  let bravoOnly = ''

  const submit = (host: string, id: string, note: string) =>
    folio.handle(
      new Request(`https://${host}/folio/f/${id}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ note }).toString(),
      }),
      env,
      createExecutionContext(),
    )

  beforeAll(async () => {
    const fields = JSON.stringify([{ name: 'note', kind: 'text', label: 'Note' }])
    shared = 'frm_5a5a5a5a5a5a'
    bravoOnly = 'frm_b0b0b0b0b0b0'
    await env.DB.batch([
      env.DB.prepare(
        `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
         values (?, 'shared-response', 'Shared', ?, 0, 0, 'shared'),
                (?, 'bravo-response', 'Bravo', ?, 0, 0, 'bravo')`,
      ).bind(shared, fields, bravoOnly, fields),
    ])
  })

  it('records the submitting site, and only a form in that site’s chain is there to be posted to', async () => {
    const onAlpha = await submit('alpha.example', shared, 'from alpha')
    expect(onAlpha?.status).toBe(200)
    const onBravo = await submit('bravo.example', shared, 'from bravo')
    expect(onBravo?.status).toBe(200)
    const rows = await env.DB.prepare(
      `select site_id, data from form_responses where form_id = ? order by created_at, id`,
    )
      .bind(shared)
      .all<{ site_id: string; data: string }>()
    expect(rows.results.map((r) => r.site_id).sort()).toEqual(['alpha', 'bravo'])

    // Bravo's own form is not in alpha's chain, and nothing is in the admin origin's.
    expect((await submit('alpha.example', bravoOnly, 'nope'))?.status).toBe(404)
    expect((await submit('cms.example', shared, 'nope'))?.status).toBe(404)
    expect(
      (await env.DB.prepare('select count(*) as n from form_responses where form_id = ?')
        .bind(bravoOnly)
        .first()) as {
        n: number
      },
    ).toEqual({ n: 0 })

    const event = fired.filter(([name]) => name === 'submitted')
    expect(event.map(([, payload]) => payload.site).sort()).toEqual(['alpha', 'bravo'])
  })

  it('collapses a double-click on one site without dropping the same answer on another', async () => {
    await submit('alpha.example', shared, 'same words')
    await submit('alpha.example', shared, 'same words')
    await submit('bravo.example', shared, 'same words')
    const n = await env.DB.prepare(
      `select site_id, count(*) as n from form_responses where form_id = ? and data like '%same words%' group by 1 order by 1`,
    )
      .bind(shared)
      .all()
    expect(n.results).toEqual([
      { site_id: 'alpha', n: 1 },
      { site_id: 'bravo', n: 1 },
    ])
  })

  it('shows a site its own answers to a shared form, and the form’s scope all of them', async () => {
    const alpha = await json(await call(`/~alpha/api/forms/${shared}/responses?count=1`, U))
    expect(alpha.rows.length).toBe(alpha.total)
    expect(new Set(alpha.rows.map((r: { data: { note: string } }) => r.data.note))).toEqual(
      new Set(['from alpha', 'same words']),
    )
    const bravo = await json(await call(`/~bravo/api/forms/${shared}/responses`, B))
    expect(bravo.rows.map((r: { data: { note: string } }) => r.data.note)).not.toContain(
      'from alpha',
    )

    const all = await json(await call(`/~shared/api/forms/${shared}/responses?count=1`, S))
    expect(all.total).toBe(4)
  })

  it('exports, reads and deletes only what the site received', async () => {
    const csv = await (await call(`/~alpha/api/forms/${shared}/responses.csv`, A)).text()
    expect(csv).toContain('from alpha')
    expect(csv).not.toContain('from bravo')

    const bravoRow = (await env.DB.prepare(
      `select id from form_responses where form_id = ? and site_id = 'bravo' limit 1`,
    )
      .bind(shared)
      .first<{ id: string }>())!.id
    expect((await call(`/~alpha/api/forms/${shared}/responses/${bravoRow}`, U)).status).toBe(404)
    expect(
      (await call(`/~alpha/api/forms/${shared}/responses/${bravoRow}`, A, { method: 'DELETE' }))
        .status,
    ).toBe(404)
    expect(
      (await env.DB.prepare('select count(*) as n from form_responses where id = ?')
        .bind(bravoRow)
        .first()) as {
        n: number
      },
    ).toEqual({ n: 1 })

    // A bulk delete over a filter is the site's own: its count guard is its own count.
    const ownCount = (await env.DB.prepare(
      `select count(*) as n from form_responses where form_id = ? and site_id = 'alpha'`,
    )
      .bind(shared)
      .first<{ n: number }>())!.n
    const del = await call(
      `/~alpha/api/forms/${shared}/responses/delete`,
      A,
      body({ selection: { all: true, filter: {}, expected: ownCount } }),
    )
    expect(del.status).toBe(200)
    expect((await json(del)).done).toBe(ownCount)
    const left = await env.DB.prepare(
      `select site_id, count(*) as n from form_responses where form_id = ? group by 1`,
    )
      .bind(shared)
      .all()
    expect(left.results).toEqual([{ site_id: 'bravo', n: 2 }])
  })

  it('counts what other sites use a shared form for, and the responses it hides', async () => {
    const usage = await json(await call(`/~alpha/api/forms/${shared}/usage`, E))
    expect(usage.elsewhere).toBe(0)
    // The alpha site received none that remain; bravo's two are not the caller's to count.
    expect(usage.responses).toBe(0)
    const owner = await json(await call(`/~shared/api/forms/${shared}/usage`, S))
    expect(owner.responses).toBe(2)
  })

  it('removes a form and its responses only from the scope that owns it', async () => {
    expect((await call(`/~alpha/api/forms/${shared}`, A, { method: 'DELETE' })).status).toBe(404)
    expect((await call(`/~shared/api/forms/${shared}`, S, { method: 'DELETE' })).status).toBe(200)
  })
})
