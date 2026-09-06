import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AssetFolder } from '../../src/core/assets'
import type { Page } from '../../src/core/pagination'
import {
  createFolder,
  deleteFolder,
  folderById,
  listFolders,
  moveFolder,
  renameFolder,
  updateFolder,
} from '../../src/server/asset-folders'
import { ensureTag } from '../../src/server/asset-tags'
import { type AssetRow, listAssets, listAssetsByPage } from '../../src/server/assets'

/**
 * Media-library folders (`docs/specs/content-model/media-library.md` phase 2),
 * against real D1 and the real migrations.
 *
 * Two of these are here because getting them wrong is *destructive and silent*,
 * and neither failure has anything to catch it downstream:
 *
 *  - **The subtree range is `[p || '/', p || '0')`, never a prefix `like`.** A
 *    `like` sweeps in every sibling whose name starts with the moved folder's —
 *    `Shoots 2024` next to `Shoots` — and rewrites its path to something derived
 *    from a folder it has nothing to do with. There is no undo and no log.
 *  - **The cycle check is "the destination's path is not inside mine".** A missed
 *    cycle detaches a subtree from the tree with no recursive query anywhere in
 *    this design to find it again.
 *
 * Both were verified by breaking them: swapping the range for `path like ?` and
 * neutering the cycle guard each turn tests in this file red.
 *
 * The rest pins decision 14 — a folder is metadata, and deleting metadata must
 * not delete content — and checkpoint 10, that filtering by a folder includes its
 * descendants.
 *
 * D1 state is isolated per *file*, not per test, so every test resets the two
 * tables it uses.
 */

const ORIGIN = 'https://example.com'
const API = `${ORIGIN}/folio/api`

let minted = 0

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from asset_folders'),
    env.DB.prepare('delete from assets'),
  ])
}

/** One library row, filed where the caller says. Inserted directly: `uploadAsset`
 * would need an R2 put per row and none of this is about uploading. */
async function seedAsset(
  folderId: string | null,
  over: { filename?: string; altAuto?: string } = {},
): Promise<string> {
  minted += 1
  const id = `ast_f${String(minted).padStart(9, '0')}`
  await env.DB.prepare(
    `insert into assets
       (id, key, filename, content_type, size, alt, created_at, folder_id, description, alt_auto, description_auto)
     values (?, ?, ?, 'image/png', 10, '', ?, ?, '', ?, '')`,
  )
    .bind(
      id,
      `${id}-file.png`,
      over.filename ?? `${id}.png`,
      1_700_000_000_000 + minted,
      folderId,
      over.altAuto ?? '',
    )
    .run()
  return id
}

async function folderIdsIn(path: string): Promise<string[]> {
  const page = await listAssets(env.DB, { folder: path, limit: 200 })
  return page.rows.map((row) => row.id).sort()
}

async function pathsByName(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('select name, path from asset_folders').all<{
    name: string
    path: string
  }>()
  return Object.fromEntries(results.map((row) => [row.name, row.path]))
}

beforeEach(reset)

/* ------------------------------------------------- the range, not a like --- */

describe('a subtree move is a range on the materialised path, never a prefix LIKE', () => {
  it('leaves a sibling whose slug is a prefix of the moved folder untouched', async () => {
    const shoots = await createFolder(env.DB, { name: 'Shoots' })
    // '-' is 0x2D and sorts *below* '/', so this sibling sits under the range's
    // lower bound. `path like 'shoots%'` matches it; the range does not.
    const dated = await createFolder(env.DB, { name: 'Shoots 2024' })
    // 'x' is 0x78 and sorts *above* '0', so this one sits over the upper bound —
    // the other side of the same mistake.
    const suffixed = await createFolder(env.DB, { name: 'Shootsx' })
    const raw = await createFolder(env.DB, { name: 'Raw', parentId: shoots.id })
    expect([shoots.path, dated.path, suffixed.path, raw.path]).toEqual([
      'shoots',
      'shoots-2024',
      'shootsx',
      'shoots/raw',
    ])

    await renameFolder(env.DB, shoots.id, 'Archive')

    expect(await pathsByName()).toEqual({
      Archive: 'archive',
      Raw: 'archive/raw',
      'Shoots 2024': 'shoots-2024',
      Shootsx: 'shootsx',
    })
    // Names too: a `like` rewrite corrupts the path and leaves the name, which is
    // how it would read as "the tree looks fine" in the sidebar.
    expect((await folderById(env.DB, dated.id))?.name).toBe('Shoots 2024')
    expect((await folderById(env.DB, suffixed.id))?.name).toBe('Shootsx')
  })

  it('does not sweep a prefix sibling into a folder filter either', async () => {
    const shoots = await createFolder(env.DB, { name: 'Shoots' })
    const dated = await createFolder(env.DB, { name: 'Shoots 2024' })
    const inside = await seedAsset(shoots.id)
    const child = await createFolder(env.DB, { name: 'Raw', parentId: shoots.id })
    const deeper = await seedAsset(child.id)
    await seedAsset(dated.id)

    expect(await folderIdsIn('shoots')).toEqual([inside, deeper].sort())
  })

  it('moves a whole subtree, at every depth, in one statement', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    const b = await createFolder(env.DB, { name: 'B', parentId: a.id })
    const c = await createFolder(env.DB, { name: 'C', parentId: b.id })
    const other = await createFolder(env.DB, { name: 'Other' })

    await moveFolder(env.DB, a.id, other.id)

    expect((await folderById(env.DB, a.id))?.path).toBe('other/a')
    expect((await folderById(env.DB, b.id))?.path).toBe('other/a/b')
    expect((await folderById(env.DB, c.id))?.path).toBe('other/a/b/c')
    // The structure follows the path: only the moved folder's parent changes.
    expect((await folderById(env.DB, a.id))?.parentId).toBe(other.id)
    expect((await folderById(env.DB, b.id))?.parentId).toBe(a.id)
  })
})

/* -------------------------------------------------------------- cycles --- */

describe('the cycle check refuses a destination inside the moving subtree', () => {
  it('refuses a move into a direct child, and writes nothing', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    const b = await createFolder(env.DB, { name: 'B', parentId: a.id })

    await expect(moveFolder(env.DB, a.id, b.id)).rejects.toThrow(/its own descendant/)
    expect(await pathsByName()).toEqual({ A: 'a', B: 'a/b' })
  })

  it('refuses a move into a grandchild', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    const b = await createFolder(env.DB, { name: 'B', parentId: a.id })
    const c = await createFolder(env.DB, { name: 'C', parentId: b.id })

    await expect(moveFolder(env.DB, a.id, c.id)).rejects.toThrow(/its own descendant/)
    // The path that made it a cycle is named, per the spec's edge case.
    await expect(moveFolder(env.DB, a.id, c.id)).rejects.toThrow(/a\/b\/c/)
    expect(await pathsByName()).toEqual({ A: 'a', B: 'a/b', C: 'a/b/c' })
  })

  it('refuses a move into itself', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    await createFolder(env.DB, { name: 'B', parentId: a.id })

    await expect(moveFolder(env.DB, a.id, a.id)).rejects.toThrow(/into itself/)
    expect(await pathsByName()).toEqual({ A: 'a', B: 'a/b' })
  })

  it('still allows a move into a sibling whose path merely starts the same way', async () => {
    // The guard is `parent.path === mine || parent.path.startsWith(mine + '/')`.
    // Dropping the separator from that test would refuse this legitimate move.
    const shoots = await createFolder(env.DB, { name: 'Shoots' })
    const dated = await createFolder(env.DB, { name: 'Shoots 2024' })

    await moveFolder(env.DB, shoots.id, dated.id)
    expect((await folderById(env.DB, shoots.id))?.path).toBe('shoots-2024/shoots')
  })

  it('answers 409 over HTTP, and 409 for a colliding rename', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    const b = await createFolder(env.DB, { name: 'B', parentId: a.id })
    await createFolder(env.DB, { name: 'Taken' })

    const cycle = await SELF.fetch(`${API}/assets/folders/${a.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: b.id }),
    })
    expect(cycle.status).toBe(409)
    expect((await cycle.json<{ error: { code: string } }>()).error.code).toBe('conflict')

    const collide = await SELF.fetch(`${API}/assets/folders/${a.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Taken' }),
    })
    expect(collide.status).toBe(409)
    expect((await collide.json<{ error: { message: string } }>()).error.message).toContain('Taken')
  })
})

/* ------------------------------------------------------- folder filters --- */

describe('filtering by a folder returns its descendants too', () => {
  it('narrows to a subtree at every level, and to unfiled', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    const year = await createFolder(env.DB, { name: '2026', parentId: acme.id })
    const top = await seedAsset(clients.id)
    const mid = await seedAsset(acme.id)
    const deep = await seedAsset(year.id)
    const loose = await seedAsset(null)

    expect(await folderIdsIn('clients')).toEqual([top, mid, deep].sort())
    expect(await folderIdsIn('clients/acme')).toEqual([mid, deep].sort())
    expect(await folderIdsIn('clients/acme/2026')).toEqual([deep])

    const unfiled = await listAssets(env.DB, { unfiled: true })
    expect(unfiled.rows.map((row) => row.id)).toEqual([loose])
  })

  it('counts the same set it lists', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    await seedAsset(clients.id)
    await seedAsset(acme.id)
    await seedAsset(null)

    const page = await listAssets(env.DB, { folder: 'clients', count: true })
    expect(page.total).toBe(2)
  })

  it('is the same composer on the versioned page-numbered reader (decision 13)', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    await seedAsset(clients.id)
    await seedAsset(acme.id)
    await seedAsset(null)

    const filtered = await listAssetsByPage(env.DB, {
      page: 1,
      perPage: 50,
      filter: { folder: 'clients' },
    })
    expect(filtered.assets).toHaveLength(2)
    expect(filtered.total).toBe(2)

    // Absent, it is the unfiltered route it has always been.
    const all = await listAssetsByPage(env.DB, { page: 1, perPage: 50 })
    expect(all.total).toBe(3)
  })

  it('is reachable on the versioned route, additively (decision 13)', async () => {
    // The reader has taken a filter since phase 2 and the *route* did not parse
    // one until phase 8, so `assetFilterSql` was shared and unreachable from
    // `{base}/api/v1`. Additive is the whole licence for touching a `v1`: the
    // envelope, the ordering and the row shape are what they were, and a caller
    // passing nothing gets exactly the page it got before.
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    const tagged = await seedAsset(acme.id, { filename: 'brick-wall.jpg' })
    await seedAsset(clients.id, { filename: 'other.png' })
    await seedAsset(null, { filename: 'loose.png' })
    const { tag } = await ensureTag(env.DB, 'Headshot')
    await env.DB.prepare('insert into asset_taggings (asset_id, tag_id) values (?, ?)')
      .bind(tagged, tag.id)
      .run()

    const page = async (query: string) =>
      (await SELF.fetch(`${ORIGIN}/folio/api/v1/assets${query}`)).json<{
        assets: { id: string }[]
        page: number
        perPage: number
        total: number
      }>()

    expect(await page('')).toMatchObject({ page: 1, perPage: 50, total: 3 })
    expect((await page('?folder=clients')).total).toBe(2)
    expect((await page('?folder=clients/acme')).assets.map((a) => a.id)).toEqual([tagged])
    // Five columns, the same widening the admin's list got (decision 12).
    expect((await page('?q=brick')).assets.map((a) => a.id)).toEqual([tagged])
    expect((await page('?tags=headshot')).assets.map((a) => a.id)).toEqual([tagged])
    expect((await page('?tags=headshot&folder=clients')).total).toBe(1)
    // A filter naming nothing is an answer, not an error.
    expect((await page('?folder=nope')).total).toBe(0)
  })

  it('returns nothing for a folder path nothing occupies', async () => {
    await createFolder(env.DB, { name: 'Clients' })
    await seedAsset(null)
    expect(await folderIdsIn('nope')).toEqual([])
  })

  it('reaches machine-written alt text through `q` (decision 12)', async () => {
    const id = await seedAsset(null, {
      filename: 'IMG_4471.jpg',
      altAuto: 'a woman cycling past a red brick wall',
    })
    await seedAsset(null, { filename: 'other.png' })

    const page = await listAssets(env.DB, { q: 'brick' })
    expect(page.rows.map((row) => row.id)).toEqual([id])
  })
})

/* -------------------------------------------------------------- rename --- */

describe('renaming a folder moves its subtree and touches no asset', () => {
  it('rewrites every descendant path and leaves every folder_id alone', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    const year = await createFolder(env.DB, { name: '2026', parentId: acme.id })
    const mid = await seedAsset(acme.id)
    const deep = await seedAsset(year.id)

    const before = await folderIdsIn('clients/acme')
    await renameFolder(env.DB, acme.id, 'Acme Group')

    expect((await folderById(env.DB, year.id))?.path).toBe('clients/acme-group/2026')
    expect(await folderIdsIn('clients/acme-group')).toEqual(before)
    expect(await folderIdsIn('clients/acme')).toEqual([])

    const rows = await env.DB.prepare('select id, folder_id as folderId from assets')
      .all<{ id: string; folderId: string | null }>()
      .then((r) => r.results)
    expect(rows.find((row) => row.id === mid)?.folderId).toBe(acme.id)
    expect(rows.find((row) => row.id === deep)?.folderId).toBe(year.id)
  })

  it('updates the displayed name even when the slug does not change', async () => {
    const a = await createFolder(env.DB, { name: 'acme' })
    const patched = await updateFolder(env.DB, a.id, { name: 'ACME' })
    expect(patched).toMatchObject({ name: 'ACME', path: 'acme' })
    expect((await folderById(env.DB, a.id))?.name).toBe('ACME')
  })
})

/* --------------------------------------------------------------- paging --- */

describe('the folder list pages in tree order', () => {
  it('gives every folder once, after its parent, siblings alphabetical, with no client sort', async () => {
    // Created in an order that is neither alphabetical nor depth-first, so the
    // ordering can only come from `path`.
    const zoo = await createFolder(env.DB, { name: 'Zoo' })
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const beta = await createFolder(env.DB, { name: 'Beta', parentId: clients.id })
    const alpha = await createFolder(env.DB, { name: 'Alpha', parentId: clients.id })
    await createFolder(env.DB, { name: 'Raw', parentId: beta.id })
    await createFolder(env.DB, { name: 'Edits', parentId: beta.id })
    await createFolder(env.DB, { name: 'Nested', parentId: alpha.id })
    await createFolder(env.DB, { name: 'Archive' })
    await createFolder(env.DB, { name: 'Old', parentId: zoo.id })

    const seen: AssetFolder[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Page<AssetFolder> = await listFolders(env.DB, {
        limit: 3,
        cursor: cursor ?? undefined,
      })
      seen.push(...page.rows)
      cursor = page.cursor
      if (!cursor) break
    }

    expect(seen).toHaveLength(9)
    expect(new Set(seen.map((row) => row.id)).size).toBe(9)
    // Exactly what `order by path` gives, and it is already tree order.
    expect(seen.map((row) => row.path)).toEqual([
      'archive',
      'clients',
      'clients/alpha',
      'clients/alpha/nested',
      'clients/beta',
      'clients/beta/edits',
      'clients/beta/raw',
      'zoo',
      'zoo/old',
    ])

    const at = new Map(seen.map((row, index) => [row.id, index]))
    for (const row of seen) {
      if (row.parentId) expect(at.get(row.parentId)!).toBeLessThan(at.get(row.id)!)
    }
  })

  it('answers a total only when asked', async () => {
    await createFolder(env.DB, { name: 'A' })
    await createFolder(env.DB, { name: 'B' })
    expect((await listFolders(env.DB)).total).toBeUndefined()
    expect((await listFolders(env.DB, { count: true })).total).toBe(2)
  })
})

/* -------------------------------------------------------------- delete --- */

describe('deleting a folder is not destructive (decision 14)', () => {
  it('deletes no asset, unfiles its own, and re-parents its children', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    const year = await createFolder(env.DB, { name: '2026', parentId: acme.id })
    const direct = [await seedAsset(acme.id), await seedAsset(acme.id), await seedAsset(acme.id)]
    const nested = await seedAsset(year.id)
    const loose = await seedAsset(null)

    const report = await deleteFolder(env.DB, acme.id)
    expect(report).toEqual({ reparented: 1, unfiled: 3 })

    const rows = await env.DB.prepare('select id, folder_id as folderId from assets')
      .all<{ id: string; folderId: string | null }>()
      .then((r) => r.results)
    // Nothing was deleted. That is the whole of decision 14.
    expect(rows.map((row) => row.id).sort()).toEqual([...direct, nested, loose].sort())
    for (const id of direct) expect(rows.find((row) => row.id === id)?.folderId).toBeNull()
    // The subfolder still exists, so its own assets stay filed in it.
    expect(rows.find((row) => row.id === nested)?.folderId).toBe(year.id)

    const survivor = await folderById(env.DB, year.id)
    expect(survivor).toMatchObject({ parentId: clients.id, path: 'clients/2026' })
    expect(await folderById(env.DB, acme.id)).toBeNull()
  })

  it('lifts a whole subtree, not only the direct children', async () => {
    const top = await createFolder(env.DB, { name: 'Top' })
    const mid = await createFolder(env.DB, { name: 'Mid', parentId: top.id })
    const leaf = await createFolder(env.DB, { name: 'Leaf', parentId: mid.id })

    await deleteFolder(env.DB, top.id)

    expect(await folderById(env.DB, mid.id)).toMatchObject({ parentId: null, path: 'mid' })
    expect(await folderById(env.DB, leaf.id)).toMatchObject({ parentId: mid.id, path: 'mid/leaf' })
  })

  it('refuses, rather than corrupting, when a lifted child would collide', async () => {
    const a = await createFolder(env.DB, { name: 'A' })
    const x = await createFolder(env.DB, { name: 'X', parentId: a.id })
    await createFolder(env.DB, { name: 'Y', parentId: x.id })
    await createFolder(env.DB, { name: 'Y', parentId: a.id })

    await expect(deleteFolder(env.DB, x.id)).rejects.toThrow(/would collide/)
    expect(await folderById(env.DB, x.id)).not.toBeNull()
  })

  it('answers the counts over HTTP', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    await createFolder(env.DB, { name: '2026', parentId: acme.id })
    await seedAsset(acme.id)
    await seedAsset(acme.id)

    const res = await SELF.fetch(`${API}/assets/folders/${acme.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, reparented: 1, unfiled: 2 })
  })
})

/* -------------------------------------------------------------- routes --- */

describe('the folder routes', () => {
  it('lists folders rather than being swallowed by /assets/:id', async () => {
    await createFolder(env.DB, { name: 'Clients' })
    const res = await SELF.fetch(`${API}/assets/folders?count=1`)
    expect(res.status).toBe(200)
    const body = await res.json<Page<AssetFolder>>()
    expect(body.total).toBe(1)
    expect(body.rows[0]).toMatchObject({ name: 'Clients', path: 'clients', parentId: null })
  })

  it('creates a folder, and 409s a sibling that slugifies onto it', async () => {
    const created = await SELF.fetch(`${API}/assets/folders`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Clients' }),
    })
    expect(created.status).toBe(201)
    const parent = await created.json<AssetFolder>()
    expect(parent.path).toBe('clients')

    const child = await SELF.fetch(`${API}/assets/folders`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme', parentId: parent.id }),
    })
    expect((await child.json<AssetFolder>()).path).toBe('clients/acme')

    const clash = await SELF.fetch(`${API}/assets/folders`, {
      method: 'POST',
      body: JSON.stringify({ name: 'clients' }),
    })
    expect(clash.status).toBe(409)
  })

  it('400s an unknown parent and 404s an unknown folder', async () => {
    const orphan = await SELF.fetch(`${API}/assets/folders`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Nope', parentId: 'fld_missing' }),
    })
    expect(orphan.status).toBe(400)

    const gone = await SELF.fetch(`${API}/assets/folders/fld_missing`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(gone.status).toBe(404)

    const deleted = await SELF.fetch(`${API}/assets/folders/fld_missing`, { method: 'DELETE' })
    expect(deleted.status).toBe(404)
  })

  it('filters the asset list by folder and by unfiled, and refuses both at once', async () => {
    const clients = await createFolder(env.DB, { name: 'Clients' })
    const acme = await createFolder(env.DB, { name: 'Acme', parentId: clients.id })
    await seedAsset(acme.id)
    await seedAsset(null)

    const filed = await SELF.fetch(`${API}/assets?folder=clients&count=1`)
    expect((await filed.json<Page<AssetRow>>()).total).toBe(1)

    const unfiled = await SELF.fetch(`${API}/assets?unfiled=1&count=1`)
    expect((await unfiled.json<Page<AssetRow>>()).total).toBe(1)

    const both = await SELF.fetch(`${API}/assets?folder=clients&unfiled=1`)
    expect(both.status).toBe(400)

    // A malformed path is a 400 rather than a filter that quietly matches nothing.
    const malformed = await SELF.fetch(`${API}/assets?folder=/clients/`)
    expect(malformed.status).toBe(400)
  })
})
