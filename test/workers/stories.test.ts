import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import { envelope, FolioError, rethrow } from '../../src/server/errors'
import {
  createStory,
  deleteStory,
  deleteStoryStatement,
  listStories,
  publishStoryStatement,
  storyById,
  storyByPath,
  updateStory,
} from '../../src/server/stories'
import { applySeedFixture } from './seed-fixture'

/**
 * Migrations (packages/folio/migrations/**) are structure only, so this file
 * seeds its own fixture rather than inheriting one, by re-running the actual
 * examples/demo/seed.sql each time (see seed-fixture.ts) instead of a hand-
 * typed insert that could drift from it and from the same three rows in
 * smoke.test.ts / http.test.ts. The pool's storage is isolated per test *file*
 * but not per test (see apply-schema.ts / the vitest.config.ts sharp-edges
 * note and smoke.test.ts, which pins that writes persist from one test to the
 * next in the same file), so every test here restores this exact seed itself
 * instead of relying on rollback. Tests below still refer to its rows by the
 * ids seed.sql assigns them: sty_home (path ''), sty_about (path 'about') and
 * sty_team (path 'about/team').
 */
async function resetStories(): Promise<void> {
  await env.DB.prepare('delete from stories').run()
  await applySeedFixture(env.DB)
}

beforeEach(async () => {
  await resetStories()
})

describe('createStory', () => {
  it('derives the slug and path from the title, at the root', async () => {
    const story = await createStory(env.DB, { title: 'Contact Us' })

    expect(story.slug).toBe('contact-us')
    expect(story.path).toBe('contact-us')
    expect(story.parentId).toBeNull()
  })

  it('derives the slug and path from the title, under a parent', async () => {
    const story = await createStory(env.DB, { title: 'Contact', parentId: 'sty_about' })

    expect(story.parentId).toBe('sty_about')
    expect(story.slug).toBe('contact')
    expect(story.path).toBe('about/contact')
  })

  it('prefers an explicit slug over one derived from the title', async () => {
    const story = await createStory(env.DB, { title: 'Some Title', slug: 'custom-slug' })

    expect(story.slug).toBe('custom-slug')
    expect(story.path).toBe('custom-slug')
  })

  it('falls back to "Untitled" when the title is blank', async () => {
    const story = await createStory(env.DB, { title: '   ' })

    expect(story.title).toBe('Untitled')
  })

  it('assigns an ord that sorts after existing siblings at the same level', async () => {
    const created = await createStory(env.DB, { title: 'Contact' })

    const rows = await listStories(env.DB)
    const topLevel = rows
      .filter((r) => r.parentId === null)
      .sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0))

    expect(topLevel.at(-1)?.id).toBe(created.id)
  })

  it('suffixes the slug on collision with a sibling at the same level', async () => {
    const dup = await createStory(env.DB, { title: 'About' })

    expect(dup.slug).toBe('about-2')
    expect(dup.path).toBe('about-2')
  })

  it('does not treat a same-named story under a different parent as a collision', async () => {
    const story = await createStory(env.DB, { title: 'Team', parentId: null })

    // sty_team already exists with slug 'team', but under sty_about.
    expect(story.slug).toBe('team')
    expect(story.path).toBe('team')
  })

  it('rejects creating a story under an unknown parent', async () => {
    await expect(createStory(env.DB, { title: 'Orphan', parentId: 'sty_nope' })).rejects.toThrow(
      'Unknown parent',
    )
  })
})

describe('updateStory', () => {
  it('recomputes the whole subtree of paths when a parent is renamed', async () => {
    const updated = await updateStory(env.DB, 'sty_about', { title: 'About Us' })

    expect(updated.slug).toBe('about-us')
    expect(updated.path).toBe('about-us')

    const team = await storyByPath(env.DB, 'about-us/team')
    expect(team?.id).toBe('sty_team')
    expect(await storyByPath(env.DB, 'about/team')).toBeNull()
  })

  it('reparents a story, recomputing its path under the new parent', async () => {
    const dest = await createStory(env.DB, { title: 'Team Home' })
    const moved = await updateStory(env.DB, 'sty_team', { parentId: dest.id })

    expect(moved.parentId).toBe(dest.id)
    expect(moved.path).toBe(`${dest.slug}/team`)
  })

  it('reparents to the root level, recomputing the path from the slug alone', async () => {
    const moved = await updateStory(env.DB, 'sty_team', { parentId: null })

    expect(moved.parentId).toBeNull()
    expect(moved.path).toBe('team')
  })

  it('rejects reparenting a story into its own subtree', async () => {
    await expect(updateStory(env.DB, 'sty_about', { parentId: 'sty_team' })).rejects.toThrow(
      'Cannot move a story into its own subtree',
    )
  })

  it('rejects reparenting a story under itself', async () => {
    await expect(updateStory(env.DB, 'sty_about', { parentId: 'sty_about' })).rejects.toThrow(
      'Cannot move a story into its own subtree',
    )
  })

  it('rejects reparenting under an unknown parent', async () => {
    await expect(updateStory(env.DB, 'sty_about', { parentId: 'sty_nope' })).rejects.toThrow(
      'Unknown parent',
    )
  })

  it('does not reslug or reparent the root story', async () => {
    const result = await updateStory(env.DB, 'sty_home', {
      title: 'Homepage',
      slug: 'home',
      parentId: 'sty_about',
    })

    expect(result.title).toBe('Homepage')
    expect(result.slug).toBe('')
    expect(result.path).toBe('')
    expect(result.parentId).toBeNull()
  })

  it('suffixes the slug on collision when renaming into a taken slug', async () => {
    const created = await createStory(env.DB, { title: 'Contact' })
    const updated = await updateStory(env.DB, created.id, { title: 'About' })

    expect(updated.slug).toBe('about-2')
  })

  it('rejects updating an unknown story', async () => {
    await expect(updateStory(env.DB, 'sty_nope', { title: 'X' })).rejects.toThrow('Unknown story')
  })
})

describe('deleteStory', () => {
  it('cascades delete to children', async () => {
    const deletedIds = await deleteStory(env.DB, 'sty_about')

    expect([...deletedIds].sort()).toEqual(['sty_about', 'sty_team'])

    const rows = await listStories(env.DB)
    expect(rows.find((r) => r.id === 'sty_about')).toBeUndefined()
    expect(rows.find((r) => r.id === 'sty_team')).toBeUndefined()
    expect(rows.find((r) => r.id === 'sty_home')).toBeDefined()
  })

  it('rejects deleting the root story', async () => {
    await expect(deleteStory(env.DB, 'sty_home')).rejects.toThrow('Cannot delete the root story')
  })

  it('returns an empty array deleting an unknown id', async () => {
    expect(await deleteStory(env.DB, 'sty_nope')).toEqual([])
  })
})

describe('publishStoryStatement', () => {
  it('returns an unrun statement; publish batches it alongside the version insert', async () => {
    const doc: Doc = {
      root: 'r1',
      bloks: {
        r1: {
          uid: 'r1',
          type: 'page',
          parent: null,
          slot: null,
          order: 'a0',
          data: { title: 'Batched Publish' },
        },
      },
    }
    const { statement, publishedAt, title } = publishStoryStatement(
      env.DB,
      'sty_about',
      doc,
      'About',
    )
    expect(title).toBe('Batched Publish')

    // Nothing has run yet: the point is that a caller can batch this with
    // another write before executing either.
    expect((await storyById(env.DB, 'sty_about'))?.publishedAt).toBeNull()

    await statement.run()

    const row = await storyById(env.DB, 'sty_about')
    expect(row?.publishedAt).toBe(publishedAt)
    expect(row?.title).toBe('Batched Publish')
  })
})

describe('deleteStoryStatement', () => {
  it('returns the affected ids and an unrun statement', async () => {
    const found = await deleteStoryStatement(env.DB, 'sty_about')

    expect([...(found?.ids ?? [])].sort()).toEqual(['sty_about', 'sty_team'])

    // Still there: the statement has not been executed yet.
    expect(await storyByPath(env.DB, 'about')).not.toBeNull()

    await found?.statement.run()
    expect(await storyByPath(env.DB, 'about')).toBeNull()
  })

  it('returns null for an unknown id, without preparing a statement', async () => {
    expect(await deleteStoryStatement(env.DB, 'sty_nope')).toBeNull()
  })

  it('rejects deleting the root story', async () => {
    await expect(deleteStoryStatement(env.DB, 'sty_home')).rejects.toThrow(
      'Cannot delete the root story',
    )
  })
})

describe('storyByPath', () => {
  it('resolves the root story at the empty-string path', async () => {
    expect((await storyByPath(env.DB, ''))?.id).toBe('sty_home')
  })

  it('resolves nested stories by their full path', async () => {
    expect((await storyByPath(env.DB, 'about'))?.id).toBe('sty_about')
    expect((await storyByPath(env.DB, 'about/team'))?.id).toBe('sty_team')
  })

  it('returns null for an unknown path', async () => {
    expect(await storyByPath(env.DB, 'nope')).toBeNull()
  })
})

describe('listStories', () => {
  it('returns every story with camelCased fields matching StoryMeta', async () => {
    const rows = await listStories(env.DB)

    expect(rows).toHaveLength(3)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sty_home',
          parentId: null,
          slug: '',
          path: '',
          ord: 'a0',
          title: 'Home',
          publishedAt: null,
        }),
        expect.objectContaining({
          id: 'sty_about',
          parentId: null,
          slug: 'about',
          path: 'about',
          ord: 'a1',
          title: 'About',
        }),
        expect.objectContaining({
          id: 'sty_team',
          parentId: 'sty_about',
          slug: 'team',
          path: 'about/team',
          ord: 'a0',
          title: 'Our team',
        }),
      ]),
    )
    for (const row of rows) expect(typeof row.updatedAt).toBe('number')
  })
})

describe('concurrent creates and the conflict envelope', () => {
  it('surfaces a same-tick duplicate slug as a conflict envelope, not a 500', async () => {
    // `createStory` snapshots `listStories` before it picks a slug, so two
    // calls that both read that snapshot before either has inserted can both
    // land on the same (parentId, slug) pair — `uniqueSlug`'s in-memory check
    // never sees the other's write. Firing both with `Promise.all`, rather
    // than awaiting one before starting the next, is what makes both read the
    // pre-insert snapshot.
    //
    // `createStory` always derives `path` as `${parentPath}/${slug}` (or bare
    // `slug` at the root), so two calls racing to the same (parentId, slug)
    // also race to the same `path` — the pre-existing `path text not null
    // unique` already refuses the loser here, and would with or without
    // `stories_parent_slug` (migrations/0002_slug_unique.sql) existing. What
    // this test actually pins down is the translation: whichever index D1
    // reports, `rethrow` maps a raw UNIQUE violation to the same conflict
    // envelope. See the next describe block for a case only 0002 catches.
    const results = await Promise.allSettled([
      createStory(env.DB, { title: 'Race', parentId: null }),
      createStory(env.DB, { title: 'Race', parentId: null }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // `rethrow` is the same translation the /folio/stories route applies to
    // whatever `createStory` throws (routes/stories.ts): the point of this
    // test is that D1's raw constraint violation lands on the client as the
    // ordinary conflict envelope, never as an unhandled 500.
    let caught: unknown
    try {
      rethrow((rejected[0] as PromiseRejectedResult).reason)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FolioError)
    const err = caught as FolioError
    expect(err.code).toBe('conflict')
    expect(err.status).toBe(409)
    expect(envelope(err)).toEqual({ error: { code: 'conflict', message: err.message } })
    // Nothing about the index or the raw SQLite message travels to the client.
    expect(err.message).not.toMatch(/UNIQUE|constraint|SQLITE|stories_parent_slug/i)
  })
})

describe('migrations/0002_slug_unique.sql: stories_parent_slug', () => {
  it('refuses two rows sharing (parent_id, slug) even when their paths differ', async () => {
    // Every write this codebase makes (createStory/updateStory,
    // src/server/stories.ts) derives `path` as `${parentPath}/${slug}`, so a
    // (parent_id, slug) collision reached through the API always collides on
    // `path` too — the pre-existing `path text not null unique` already
    // catches every one of those, with or without this index. The only way to
    // reach the state 0002 alone refuses is to write a row the way nothing in
    // src/ ever does: matching (parent_id, slug) with a *different* path,
    // which only a hand-written statement (a fixup query, an import, a bug in
    // a future write path) can produce.
    await env.DB.prepare(
      `insert into stories (id, parent_id, slug, path, ord, title) values (?, ?, ?, ?, ?, ?)`,
    )
      .bind('sty_raw1', null, 'raw-dup', 'raw-dup', 'a9', 'Raw dup one')
      .run()

    await expect(
      env.DB.prepare(
        `insert into stories (id, parent_id, slug, path, ord, title) values (?, ?, ?, ?, ?, ?)`,
      )
        // Same (parent_id, slug) as above; `path` deliberately does not match,
        // so the pre-existing unique index on `path` cannot be what refuses this.
        .bind('sty_raw2', null, 'raw-dup', 'somewhere-else', 'aa', 'Raw dup two')
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i)

    // Confirms it was actually refused, not merely that a promise rejected.
    const row = await env.DB.prepare('select id from stories where id = ?').bind('sty_raw2').first()
    expect(row).toBeNull()
  })
})
