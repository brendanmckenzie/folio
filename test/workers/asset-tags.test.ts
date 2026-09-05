import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  deleteTag,
  ensureTag,
  listTags,
  MAX_TAG_FILTER,
  renameTag,
  setAssetTags,
  tagsForAssets,
} from '../../src/server/asset-tags'
import { listAssets } from '../../src/server/assets'

/**
 * Media-library tags (`docs/specs/content-model/media-library.md` phase 3),
 * against real D1 and the real migrations.
 *
 * The one that matters most is **identity by slug**. `ensureTag` matches on the
 * slug, never the display name, so "Headshots", "headshots" and "  Head Shots "
 * are one tag rather than three. Get that wrong and the vocabulary silently
 * forks: the sidebar grows near-duplicates nobody chose, a filter for one misses
 * the assets carrying the other, and phase 6's enrichment — which may only pick
 * from tags that already exist — is handed a list where the constraint has
 * stopped constraining anything. Verified by breaking it: matching on `name`
 * turns the first test here red with two rows where there should be one.
 *
 * The rest pins the two rules a tag shares with a folder, and one it does not:
 *
 *  - **Deleting a tag deletes no asset** (decision 14). Metadata is not content.
 *  - **`tagsForAssets` binds a caller-sized list and must chunk it.** D1 binds at
 *    most 100 parameters per statement, and this exact shape has been a live bug
 *    in this repo twice.
 *  - **A rename refuses to merge.** Unlike a folder move, a rename onto an
 *    occupied slug would rewrite taggings for assets the editor is not looking
 *    at, with no undo.
 *
 * D1 state is isolated per *file*, not per test, so every test resets what it
 * touches.
 */

let minted = 0

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from asset_taggings'),
    env.DB.prepare('delete from asset_tags'),
    env.DB.prepare('delete from assets'),
  ])
}

/** One library row. Inserted directly: `uploadAsset` would need an R2 put per
 * row and none of this is about uploading. */
async function seedAsset(): Promise<string> {
  minted += 1
  const id = `ast_t${String(minted).padStart(9, '0')}`
  await env.DB.prepare(
    `insert into assets
       (id, key, filename, content_type, size, alt, created_at, folder_id, description, alt_auto, description_auto)
     values (?, ?, ?, 'image/png', 10, '', ?, null, '', '', '')`,
  )
    .bind(id, `${id}-file.png`, `${id}.png`, 1_700_000_000_000 + minted)
    .run()
  return id
}

const countTags = async (): Promise<number> =>
  (await env.DB.prepare('select count(*) as n from asset_tags').first<{ n: number }>())?.n ?? 0

beforeEach(reset)

/* --------------------------------------------------------- one slug, one tag --- */

describe('a tag is its slug', () => {
  it('returns the same row for every spelling of one name', async () => {
    const first = await ensureTag(env.DB, 'Headshots')
    const second = await ensureTag(env.DB, 'headshots')
    const third = await ensureTag(env.DB, '  Head Shots  ')

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(third.created).toBe(false)
    expect(second.tag.id).toBe(first.tag.id)
    expect(third.tag.id).toBe(first.tag.id)

    // The display name is whoever got there first: an existing tag is returned,
    // not relabelled by the next person who happens to type it differently.
    expect(second.tag.name).toBe('Headshots')
    expect(await countTags()).toBe(1)
  })

  it('refuses a name that slugs to nothing, and keeps punctuation that does not', async () => {
    await expect(ensureTag(env.DB, '   ')).rejects.toThrow(/blank/i)
    expect(await countTags()).toBe(0)

    // `tagSlug` lowercases and strips whitespace and nothing else, so
    // punctuation is part of a tag's identity rather than noise to be cleaned
    // off. That is what lets `C++` and `35mm` be tags at all; the cost is that
    // `!!!` is a legal tag nobody will thank you for.
    const punctuated = await ensureTag(env.DB, 'C++')
    expect(punctuated.tag.slug).toBe('c++')
    expect(await countTags()).toBe(1)
  })

  it('renames within one slug, and refuses to merge onto another', async () => {
    const head = await ensureTag(env.DB, 'head shots')
    await ensureTag(env.DB, 'Crew')

    // Same slug, different display: always allowed, because it is the same tag
    // by the only identity there is.
    const renamed = await renameTag(env.DB, head.tag.id, 'Headshots')
    expect(renamed?.slug).toBe(head.tag.slug)
    expect(renamed?.name).toBe('Headshots')

    // Onto an occupied slug: a 409 naming it, never a silent merge.
    await expect(renameTag(env.DB, head.tag.id, 'crew')).rejects.toThrow(/already occupies/i)
    expect(await countTags()).toBe(2)
    expect((await listTags(env.DB, { limit: 50 })).rows.map((t) => t.slug).sort()).toEqual([
      'crew',
      'headshots',
    ])
  })
})

/* ------------------------------------------------ metadata is not content --- */

describe('deleting a tag', () => {
  it('unfiles it from every asset and deletes no asset', async () => {
    const a = await seedAsset()
    const b = await seedAsset()
    const tag = await ensureTag(env.DB, 'Campaign')
    const keep = await ensureTag(env.DB, 'Keep')
    await setAssetTags(env.DB, a, [tag.tag.id, keep.tag.id])
    await setAssetTags(env.DB, b, [tag.tag.id])

    const removed = await deleteTag(env.DB, tag.tag.id)
    expect(removed?.removedFrom).toBe(2)

    // The assets survive, and the tag they still carry survives with them.
    const rows = await listAssets(env.DB, { limit: 50 })
    expect(rows.rows.map((r) => r.id).sort()).toEqual([a, b].sort())
    const after = await tagsForAssets(env.DB, [a, b])
    expect(after.get(a)?.map((t) => t.slug)).toEqual(['keep'])
    expect(after.get(b) ?? []).toEqual([])
  })
})

/* ----------------------------------------------------- the caller-sized list --- */

describe('tagsForAssets', () => {
  it('answers a page of assets whose id list is far past D1’s bind cap', async () => {
    // 250 ids in one call. Unchunked this is a single statement with 250 binds,
    // which D1 refuses outright at 101 — the failure this repo has already
    // shipped twice, in `indexStatements` and in `resolve()`'s `storiesFor`.
    const tag = await ensureTag(env.DB, 'Bulk')
    const ids: string[] = []
    for (let i = 0; i < 250; i += 1) ids.push(await seedAsset())
    await setAssetTags(env.DB, ids[0] as string, [tag.tag.id])
    await setAssetTags(env.DB, ids[249] as string, [tag.tag.id])

    const map = await tagsForAssets(env.DB, ids)
    expect(map.get(ids[0] as string)?.map((t) => t.slug)).toEqual(['bulk'])
    expect(map.get(ids[249] as string)?.map((t) => t.slug)).toEqual(['bulk'])
    expect(map.get(ids[1] as string) ?? []).toEqual([])
  })

  it('is empty in, empty out', async () => {
    expect((await tagsForAssets(env.DB, [])).size).toBe(0)
  })
})

/* ------------------------------------------------------------- filtering --- */

describe('filtering by tag', () => {
  it('ands several tags rather than oring them', async () => {
    const both = await seedAsset()
    const onlyOne = await seedAsset()
    const shoot = await ensureTag(env.DB, 'Shoot')
    const crew = await ensureTag(env.DB, 'Crew')
    await setAssetTags(env.DB, both, [shoot.tag.id, crew.tag.id])
    await setAssetTags(env.DB, onlyOne, [shoot.tag.id])

    // `having count(*) = n`: "shoot and crew" means both, which is what an
    // editor narrowing a library means by adding a second chip.
    const narrowed = await listAssets(env.DB, { tags: ['shoot', 'crew'], limit: 50 })
    expect(narrowed.rows.map((r) => r.id)).toEqual([both])

    const wider = await listAssets(env.DB, { tags: ['shoot'], limit: 50 })
    expect(wider.rows.map((r) => r.id).sort()).toEqual([both, onlyOne].sort())
  })

  it('finds the untagged, which is not the same as matching no tag', async () => {
    const bare = await seedAsset()
    const filed = await seedAsset()
    const tag = await ensureTag(env.DB, 'Filed')
    await setAssetTags(env.DB, filed, [tag.tag.id])

    const untagged = await listAssets(env.DB, { untagged: true, limit: 50 })
    expect(untagged.rows.map((r) => r.id)).toEqual([bare])
  })

  it('caps the tag filter at a bind budget rather than a product limit', async () => {
    // The cap exists because D1 binds at most 100 parameters per statement, not
    // because nine chips would be unreasonable. Stated here so a later change
    // that narrows something else in the same statement knows it can be raised.
    expect(MAX_TAG_FILTER).toBe(8)
    const asset = await seedAsset()
    const slugs: string[] = []
    for (let i = 0; i < MAX_TAG_FILTER; i += 1) {
      const t = await ensureTag(env.DB, `Tag ${i}`)
      slugs.push(t.tag.slug)
    }
    await setAssetTags(
      env.DB,
      asset,
      (await listTags(env.DB, { limit: 50 })).rows.map((t) => t.id),
    )
    const page = await listAssets(env.DB, { tags: slugs, limit: 50 })
    expect(page.rows.map((r) => r.id)).toEqual([asset])
  })
})

/* ------------------------------------------------------------- setAssetTags --- */

describe('setAssetTags', () => {
  it('replaces the set rather than adding to it, and dedupes its input', async () => {
    const asset = await seedAsset()
    const a = await ensureTag(env.DB, 'A')
    const b = await ensureTag(env.DB, 'B')

    await setAssetTags(env.DB, asset, [a.tag.id, a.tag.id, b.tag.id])
    expect((await tagsForAssets(env.DB, [asset])).get(asset)?.length).toBe(2)

    await setAssetTags(env.DB, asset, [b.tag.id])
    expect((await tagsForAssets(env.DB, [asset])).get(asset)?.map((t) => t.slug)).toEqual(['b'])

    await setAssetTags(env.DB, asset, [])
    expect((await tagsForAssets(env.DB, [asset])).get(asset) ?? []).toEqual([])
  })

  it('refuses an unknown tag id and writes nothing', async () => {
    const asset = await seedAsset()
    const a = await ensureTag(env.DB, 'A')
    await setAssetTags(env.DB, asset, [a.tag.id])

    await expect(setAssetTags(env.DB, asset, [a.tag.id, 'tag_nope'])).rejects.toThrow(/Unknown tag/)
    // The prior set survives: a refused write is not a partial one.
    expect((await tagsForAssets(env.DB, [asset])).get(asset)?.map((t) => t.slug)).toEqual(['a'])
  })
})
