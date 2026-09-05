import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AssetFilter } from '../../src/core/assets'
import type { BulkSelection } from '../../src/core/bulk'
import { wasRefused } from '../../src/core/bulk'
import { createFolder } from '../../src/server/asset-folders'
import { type AssetBulkReport, runAssetBulk } from '../../src/server/asset-bulk'
import { ensureTag } from '../../src/server/asset-tags'
import { countAssets } from '../../src/server/assets'
import type { FolioDb } from '../../src/server/db'

/**
 * Bulk writes over the media library
 * (`docs/specs/content-model/media-library.md` phase 5), against real D1, real
 * R2 and the real migrations.
 *
 * **This is the destructive phase**, so the tests that matter most are the ones
 * about not doing more than was asked:
 *
 *  - **The count guard.** The number a person read is the number the server
 *    re-checks, once, and it is also the job's ceiling — "delete all 12
 *    matching" can never delete 13 however many files arrive while it runs.
 *  - **`usedOnPublished`.** A delete of four hundred files must be able to say
 *    "twelve of these are on published pages" *before* it acts, from one
 *    aggregate rather than four hundred round trips (decision 15). Verified by
 *    breaking it: stop consulting the count and `the delete warns before it acts`
 *    goes red.
 *  - **The per-row `try`.** One bad row must not abandon the rest of a batch
 *    halfway, leaving the operation neither done nor undone — and a batch in
 *    which *every* row failed still has to advance the cursor, or a client
 *    looping on `continueFrom` spins forever.
 *  - **The bind cap.** D1 binds at most 100 parameters per statement and every
 *    part of a selection is caller-sized: 500 ids, 500 exclusions. This exact
 *    shape has been a live bug in this repo twice.
 *
 * D1 state is isolated per *file*, not per test, so every test resets what it
 * touches.
 */

const ORIGIN = 'https://asset-bulk.test'
const API = `${ORIGIN}/folio/api`

let minted = 0

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from asset_taggings'),
    env.DB.prepare('delete from asset_tags'),
    env.DB.prepare('delete from asset_folders'),
    env.DB.prepare('delete from content_refs'),
    env.DB.prepare('delete from assets'),
  ])
}

beforeEach(reset)

/**
 * One library row, and its object in R2.
 *
 * Inserted directly rather than through `uploadAsset`: none of this is about
 * uploading, and a deterministic id is what lets a test name the row it expects
 * a failure on. The object is real because `deleteAsset` deletes it and one test
 * asserts that a *move* does not.
 */
async function seedAsset(over: { filename?: string; folderId?: string | null } = {}): Promise<{
  id: string
  key: string
}> {
  minted += 1
  const id = `ast_b${String(minted).padStart(9, '0')}`
  const key = `${id}-file.png`
  await env.DB.prepare(
    `insert into assets
       (id, key, filename, content_type, size, alt, created_at, folder_id,
        description, alt_auto, description_auto)
     values (?, ?, ?, 'image/png', 10, '', ?, ?, '', '', '')`,
  )
    .bind(id, key, over.filename ?? `${id}.png`, 1_700_000_000_000 + minted, over.folderId ?? null)
    .run()
  await env.MEDIA.put(key, new Uint8Array([1, 2, 3]))
  return { id, key }
}

async function seedAssets(n: number): Promise<{ id: string; key: string }[]> {
  const out: { id: string; key: string }[] = []
  for (let at = 0; at < n; at += 1) out.push(await seedAsset())
  return out
}

/** A published document using an asset, as `content-index.ts` writes it: the
 * edge holds the R2 **key**, not the id. */
async function useOnPublished(key: string, from = 'sty_about'): Promise<void> {
  await env.DB.prepare(
    `insert or ignore into content_refs (from_story, to_id, kind) values (?, ?, 'asset')`,
  )
    .bind(from, key)
    .run()
}

const deps = () => ({ db: env.DB as FolioDb, media: env.MEDIA })

function reported(outcome: Awaited<ReturnType<typeof runAssetBulk>>): AssetBulkReport {
  if (wasRefused(outcome)) throw new Error(`refused: expected ${outcome.expected}`)
  return outcome
}

const tagsOf = async (id: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `select t.slug as slug from asset_taggings g join asset_tags t on t.id = g.tag_id
      where g.asset_id = ? order by t.slug`,
  )
    .bind(id)
    .all<{ slug: string }>()
  return results.map((row) => row.slug)
}

const folderOf = async (id: string): Promise<string | null> =>
  (
    await env.DB.prepare('select folder_id as folderId from assets where id = ?')
      .bind(id)
      .first<{ folderId: string | null }>()
  )?.folderId ?? null

/* ----------------------------------------------------------------- the guard --- */

describe('the count guard', () => {
  it('refuses a selection whose set has moved, and runs when it is re-confirmed', async () => {
    const seeded = await seedAssets(3)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 3 }

    await seedAsset() // somebody uploads while the number is being read

    const refusal = await runAssetBulk(deps(), 'tag', selection, { tagIds: [tag.id] })
    expect(wasRefused(refusal)).toBe(true)
    if (!wasRefused(refusal)) return
    expect(refusal).toEqual({ refused: 'count', expected: 3, actual: 4 })
    // Nothing written, which is the half of the guard that matters.
    expect(await tagsOf(seeded[0]!.id)).toEqual([])

    const report = reported(
      await runAssetBulk(
        deps(),
        'tag',
        { all: true, filter: {}, expected: 4 },
        {
          tagIds: [tag.id],
        },
      ),
    )
    expect(report.done).toBe(4)
  })

  it('is the ceiling as well as the guard: a job never acts on more than was agreed', async () => {
    const seeded = await seedAssets(2)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    // Two agreed, two more arrive, and the filter now matches four.
    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 2 }
    const report = reported(
      await runAssetBulk(deps(), 'tag', selection, { tagIds: [tag.id], batch: 50 }),
    )
    // `expected` is re-checked first, so the arrivals have to happen *after* the
    // guard — which is what a resumed call is. Here the ceiling shows up as
    // `total`, and the batch is clamped to it.
    expect(report.total).toBe(2)
    expect(report.done).toBe(2)
    expect(report.continueFrom).toBeNull()
    expect(await tagsOf(seeded[0]!.id)).toEqual(['headshot'])
  })

  it('refuses a resumed call whose id list has changed under it', async () => {
    const seeded = await seedAssets(3)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    const ids = seeded.map((row) => row.id)
    const first = reported(
      await runAssetBulk(deps(), 'tag', { ids }, { tagIds: [tag.id], batch: 1 }),
    )
    await expect(
      runAssetBulk(
        deps(),
        'tag',
        { ids: [...ids].reverse() },
        { tagIds: [tag.id], batch: 1, continueFrom: first.continueFrom },
      ),
    ).rejects.toThrow(/selection changed/i)
  })
})

/* ------------------------------------------------------------------ batching --- */

describe('a run is the single write, N times', () => {
  it('walks a selection to completion through continueFrom', async () => {
    const seeded = await seedAssets(30)
    const tag = (await ensureTag(env.DB, '2024')).tag
    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 30 }

    let cursor: string | null = null
    let calls = 0
    let done = 0
    let last: AssetBulkReport
    do {
      last = reported(
        await runAssetBulk(deps(), 'tag', selection, {
          tagIds: [tag.id],
          batch: 10,
          ...(cursor === null ? {} : { continueFrom: cursor }),
        }),
      )
      cursor = last.continueFrom
      done += last.done
      calls += 1
    } while (cursor !== null && calls < 10)

    expect(calls).toBe(3)
    expect(done).toBe(30)
    expect(last.seen).toBe(30)
    expect(last.continueFrom).toBeNull()
    // Each row ends where one PATCH would have left it.
    for (const row of seeded) expect(await tagsOf(row.id)).toEqual(['2024'])
  })

  it('advances the cursor even when every row in a batch failed', async () => {
    const seeded = await seedAssets(4)
    const folder = await createFolder(env.DB, { name: 'Shoots' })
    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 4 }

    const first = reported(
      await runAssetBulk({ db: failingDb('every'), media: env.MEDIA }, 'move', selection, {
        folderId: folder.id,
        batch: 2,
      }),
    )
    expect(first.done).toBe(0)
    expect(first.failed).toHaveLength(2)
    // The cursor moved. A client looping on `continueFrom` therefore makes
    // progress instead of re-reading the same two rows forever.
    expect(first.seen).toBe(2)
    expect(first.continueFrom).not.toBeNull()

    const second = reported(
      await runAssetBulk(deps(), 'move', selection, {
        folderId: folder.id,
        batch: 2,
        continueFrom: first.continueFrom,
      }),
    )
    expect(second.done).toBe(2)
    expect(second.continueFrom).toBeNull()
    // The two the failing run walked past are untouched, and the two after them
    // are filed: the run was partial and the report says exactly which half.
    expect(await folderOf(seeded[0]!.id)).toBeNull()
    expect(await folderOf(seeded[3]!.id)).toBe(folder.id)
  })

  it('carries on past one bad row and names it', async () => {
    const seeded = await seedAssets(3)
    const folder = await createFolder(env.DB, { name: 'Shoots' })
    const report = reported(
      await runAssetBulk(
        { db: failingDb(seeded[1]!.id), media: env.MEDIA },
        'move',
        { ids: seeded.map((row) => row.id) },
        { folderId: folder.id },
      ),
    )
    expect(report.done).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]!.id).toBe(seeded[1]!.id)
    // Named by filename, which is what a toast can show.
    expect(report.failed[0]!.title).toBe(`${seeded[1]!.id}.png`)
    // The rows either side of the failure were written. A run that abandoned the
    // batch would leave the third one unfiled.
    expect(await folderOf(seeded[0]!.id)).toBe(folder.id)
    expect(await folderOf(seeded[2]!.id)).toBe(folder.id)
  })

  it('reports an id with no row behind it per action', async () => {
    const seeded = await seedAsset()
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    const ids = [seeded.id, 'ast_bgone00001']

    const tagged = reported(await runAssetBulk(deps(), 'tag', { ids }, { tagIds: [tag.id] }))
    expect(tagged.done).toBe(1)
    expect(tagged.failed).toEqual([{ id: 'ast_bgone00001', title: '', message: 'No such file' }])

    // A delete has already got what it asked for, so a missing row is a success.
    const deleted = reported(await runAssetBulk(deps(), 'delete', { ids }))
    expect(deleted.done).toBe(2)
    expect(deleted.failed).toEqual([])
  })
})

/* -------------------------------------------------------------------- delete --- */

describe('the delete warns before it acts', () => {
  it('reports usedOnPublished from one aggregate and writes nothing on a dry run', async () => {
    const seeded = await seedAssets(5)
    await useOnPublished(seeded[0]!.key)
    await useOnPublished(seeded[1]!.key)
    // Two documents using one file is still **one file** in use: the count is of
    // assets, not of usages.
    await useOnPublished(seeded[1]!.key, 'sty_team')

    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 5 }
    const dry = reported(await runAssetBulk(deps(), 'delete', selection, { dryRun: true }))
    expect(dry.usedOnPublished).toBe(2)
    expect(dry.done).toBe(5)
    expect(await countAssets(env.DB)).toBe(5)

    const real = reported(await runAssetBulk(deps(), 'delete', selection))
    expect(real.usedOnPublished).toBe(2)
    expect(real.done).toBe(5)
    expect(await countAssets(env.DB)).toBe(0)
    // The objects went with the rows, and so did the edges that named them.
    expect(await env.MEDIA.get(seeded[0]!.key)).toBeNull()
    expect(
      (await env.DB.prepare('select count(*) as n from content_refs').first<{ n: number }>())?.n,
    ).toBe(0)
  })

  it('counts an explicit id selection the same way, chunked', async () => {
    const seeded = await seedAssets(3)
    await useOnPublished(seeded[2]!.key)
    const report = reported(
      await runAssetBulk(deps(), 'delete', { ids: seeded.map((row) => row.id) }, { dryRun: true }),
    )
    expect(report.usedOnPublished).toBe(1)
  })

  it('warns and proceeds rather than gating', async () => {
    const seeded = await seedAsset()
    await useOnPublished(seeded.key)
    const report = reported(await runAssetBulk(deps(), 'delete', { ids: [seeded.id] }))
    // The one file in the selection was in use on a published page, and it is
    // gone: a delete that refused would leave an editor unable to remove a file
    // at all (`assetUsage`'s own rule, one level up).
    expect(report.done).toBe(1)
    expect(await countAssets(env.DB)).toBe(0)
  })

  it('leaves usedOnPublished off a resumed call rather than answering a stale number', async () => {
    const seeded = await seedAssets(4)
    await useOnPublished(seeded[0]!.key)
    const selection: BulkSelection<AssetFilter> = { all: true, filter: {}, expected: 4 }
    const first = reported(await runAssetBulk(deps(), 'delete', selection, { batch: 2 }))
    expect(first.usedOnPublished).toBe(1)
    const second = reported(
      await runAssetBulk(deps(), 'delete', selection, {
        batch: 2,
        continueFrom: first.continueFrom,
      }),
    )
    expect('usedOnPublished' in second).toBe(false)
  })
})

/* ------------------------------------------------------------- the bind cap --- */

describe('a selection is caller-sized', () => {
  it('walks an id list past D1_BIND_CAP', async () => {
    const seeded = await seedAssets(120)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    const report = reported(
      await runAssetBulk(
        deps(),
        'tag',
        { ids: seeded.map((row) => row.id) },
        {
          tagIds: [tag.id],
          batch: 200,
        },
      ),
    )
    expect(report.done).toBe(120)
    expect(await tagsOf(seeded[119]!.id)).toEqual(['headshot'])
  })

  it('honours an exclude list past D1_BIND_CAP without binding it', async () => {
    const seeded = await seedAssets(120)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    // Everything but the last three is ticked off — 117 exclusions, which is
    // more than a statement may bind. They are applied to the batch after the
    // read, so nothing here approaches the cap.
    const exclude = seeded.slice(0, 117).map((row) => row.id)
    const selection: BulkSelection<AssetFilter> = {
      all: true,
      filter: {},
      expected: 120,
      exclude,
    }
    let cursor: string | null = null
    let done = 0
    let calls = 0
    do {
      const report: AssetBulkReport = reported(
        await runAssetBulk(deps(), 'tag', selection, {
          tagIds: [tag.id],
          batch: 25,
          ...(cursor === null ? {} : { continueFrom: cursor }),
        }),
      )
      expect(report.total).toBe(3)
      cursor = report.continueFrom
      done += report.done
      calls += 1
    } while (cursor !== null && calls < 20)

    expect(done).toBe(3)
    // The excluded rows are untouched, including the ones the walk read and
    // dropped before it ever reached the three it was allowed to touch — which
    // is the case a short-read cursor rule gets wrong.
    expect(await tagsOf(seeded[0]!.id)).toEqual([])
    expect(await tagsOf(seeded[116]!.id)).toEqual([])
    expect(await tagsOf(seeded[117]!.id)).toEqual(['headshot'])
    expect(await tagsOf(seeded[119]!.id)).toEqual(['headshot'])
  })
})

/* ------------------------------------------------------------- the four acts --- */

describe('the four actions', () => {
  it('adds tags without replacing the ones an asset already carries', async () => {
    const one = await seedAsset()
    const headshot = (await ensureTag(env.DB, 'Headshot')).tag
    const year = (await ensureTag(env.DB, '2024')).tag
    await env.DB.prepare('insert into asset_taggings (asset_id, tag_id) values (?, ?)')
      .bind(one.id, headshot.id)
      .run()

    reported(await runAssetBulk(deps(), 'tag', { ids: [one.id] }, { tagIds: [year.id] }))
    expect(await tagsOf(one.id)).toEqual(['2024', 'headshot'])

    // And re-running is a no-op rather than a constraint failure.
    const again = reported(
      await runAssetBulk(deps(), 'tag', { ids: [one.id] }, { tagIds: [year.id] }),
    )
    expect(again.failed).toEqual([])
    expect(await tagsOf(one.id)).toEqual(['2024', 'headshot'])
  })

  it('removes only the tags an untag names', async () => {
    const one = await seedAsset()
    const headshot = (await ensureTag(env.DB, 'Headshot')).tag
    const year = (await ensureTag(env.DB, '2024')).tag
    await env.DB.batch([
      env.DB.prepare('insert into asset_taggings (asset_id, tag_id) values (?, ?)').bind(
        one.id,
        headshot.id,
      ),
      env.DB.prepare('insert into asset_taggings (asset_id, tag_id) values (?, ?)').bind(
        one.id,
        year.id,
      ),
    ])
    reported(await runAssetBulk(deps(), 'untag', { ids: [one.id] }, { tagIds: [year.id] }))
    expect(await tagsOf(one.id)).toEqual(['headshot'])
  })

  it('refuses an unknown tag before it touches a row', async () => {
    const one = await seedAsset()
    await expect(
      runAssetBulk(deps(), 'tag', { ids: [one.id] }, { tagIds: ['tag_nope'] }),
    ).rejects.toThrow(/Unknown tag/)
    expect(await tagsOf(one.id)).toEqual([])
  })

  it('refuses a tag run that names no tags', async () => {
    const one = await seedAsset()
    await expect(runAssetBulk(deps(), 'tag', { ids: [one.id] }, {})).rejects.toThrow(
      /at least one tag/,
    )
  })

  it('files and unfiles without touching an object', async () => {
    const one = await seedAsset()
    const folder = await createFolder(env.DB, { name: 'Shoots' })

    reported(await runAssetBulk(deps(), 'move', { ids: [one.id] }, { folderId: folder.id }))
    expect(await folderOf(one.id)).toBe(folder.id)
    // Decision 1: filing is metadata. The key is unchanged and the object is
    // still there — a move that reached R2 would fail this.
    const stored = await env.MEDIA.get(one.key)
    expect(stored).not.toBeNull()

    reported(await runAssetBulk(deps(), 'move', { ids: [one.id] }, { folderId: null }))
    expect(await folderOf(one.id)).toBeNull()
  })

  it('refuses an unknown folder, and a move with no destination at all', async () => {
    const one = await seedAsset()
    await expect(
      runAssetBulk(deps(), 'move', { ids: [one.id] }, { folderId: 'fld_nope' }),
    ).rejects.toThrow(/Unknown folder/)
    await expect(runAssetBulk(deps(), 'move', { ids: [one.id] }, {})).rejects.toThrow(
      /destination folder/,
    )
  })

  it('narrows by the captured filter rather than by everything', async () => {
    const filed = await seedAsset()
    await seedAsset()
    const folder = await createFolder(env.DB, { name: 'Shoots' })
    await env.DB.prepare('update assets set folder_id = ? where id = ?')
      .bind(folder.id, filed.id)
      .run()
    const tag = (await ensureTag(env.DB, 'Headshot')).tag

    const report = reported(
      await runAssetBulk(
        deps(),
        'tag',
        { all: true, filter: { folder: folder.path }, expected: 1 },
        { tagIds: [tag.id] },
      ),
    )
    expect(report.done).toBe(1)
    expect(await tagsOf(filed.id)).toEqual(['headshot'])
  })
})

/* ----------------------------------------------------------------- the routes --- */

describe('the routes', () => {
  const post = (path: string, body: unknown): Promise<Response> =>
    SELF.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('answers a report for each of the four', async () => {
    const seeded = await seedAssets(4)
    const tag = (await ensureTag(env.DB, 'Headshot')).tag
    const folder = await createFolder(env.DB, { name: 'Shoots' })
    const cases: [string, unknown][] = [
      ['/assets/bulk/tag', { selection: { ids: [seeded[0]!.id] }, tagIds: [tag.id] }],
      ['/assets/bulk/untag', { selection: { ids: [seeded[0]!.id] }, tagIds: [tag.id] }],
      ['/assets/bulk/move', { selection: { ids: [seeded[1]!.id] }, folderId: folder.id }],
      ['/assets/bulk/delete', { selection: { ids: [seeded[2]!.id] } }],
    ]
    for (const [path, body] of cases) {
      const res = await post(path, body)
      expect([path, res.status]).toEqual([path, 200])
      const report = await res.json<AssetBulkReport>()
      expect([path, report.done, report.failed]).toEqual([path, 1, []])
    }
  })

  it('answers a count mismatch with 409, the one error envelope, and the new count', async () => {
    await seedAssets(2)
    const res = await post('/assets/bulk/delete', {
      selection: { all: true, filter: {}, expected: 99 },
    })
    expect(res.status).toBe(409)
    const body = await res.json<{
      error: { code: string; message: string }
      refused: string
      expected: number
      actual: number
    }>()
    expect(body.error.code).toBe('conflict')
    expect(body.refused).toBe('count')
    expect([body.expected, body.actual]).toEqual([99, 2])
    expect(await countAssets(env.DB)).toBe(2)
  })

  it('carries usedOnPublished through the delete route on a dry run', async () => {
    const seeded = await seedAssets(2)
    await useOnPublished(seeded[0]!.key)
    const res = await post('/assets/bulk/delete', {
      selection: { ids: seeded.map((row) => row.id) },
      dryRun: true,
    })
    expect(res.status).toBe(200)
    expect((await res.json<AssetBulkReport>()).usedOnPublished).toBe(1)
    expect(await countAssets(env.DB)).toBe(2)
  })

  it('refuses a body naming both an id list and a filter', async () => {
    const res = await post('/assets/bulk/delete', {
      selection: { ids: ['ast_b000000001'], all: true, filter: {}, expected: 1 },
    })
    expect(res.status).toBe(400)
  })

  it('refuses a tag run with no tags', async () => {
    const res = await post('/assets/bulk/tag', {
      selection: { ids: ['ast_b000000001'] },
      tagIds: [],
    })
    expect(res.status).toBe(400)
  })
})

/**
 * A `FolioDb` whose one `update assets set folder_id` statement throws — for the
 * doomed id, or for every row when handed `'every'`.
 *
 * Failure injection at the statement rather than a mock of the runner: what these
 * two tests are about is that *a real write failing* leaves the rest of the batch
 * done and the cursor moved, and a stubbed `one()` would assert that away.
 */
function failingDb(doomed: string): FolioDb {
  return {
    prepare(sql: string) {
      const real = env.DB.prepare(sql)
      if (!sql.startsWith('update assets set folder_id')) return real
      return {
        bind(...binds: unknown[]) {
          if (doomed !== 'every' && !binds.includes(doomed)) return real.bind(...binds)
          return {
            run: () => {
              throw new Error('D1_ERROR: no such column: folder_id')
            },
          } as unknown as D1PreparedStatement
        },
      } as unknown as D1PreparedStatement
    },
    batch: (statements) => env.DB.batch(statements),
  }
}
