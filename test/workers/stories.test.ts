import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createStory,
  deleteStory,
  listStories,
  storyByPath,
  updateStory,
} from '../../src/server/stories'

/**
 * Mirrors the seed rows inserted by schema.sql. The pool's storage is
 * isolated per test *file* but not per test (see apply-schema.ts / the
 * vitest.config.ts sharp-edges note and smoke.test.ts, which pins that writes
 * persist from one test to the next in the same file), so every test here
 * restores this exact seed itself instead of relying on rollback.
 */
const SEED = [
  { id: 'sty_home', parentId: null as string | null, slug: '', path: '', ord: 'a0', title: 'Home' },
  {
    id: 'sty_about',
    parentId: null as string | null,
    slug: 'about',
    path: 'about',
    ord: 'a1',
    title: 'About',
  },
  {
    id: 'sty_team',
    parentId: 'sty_about' as string | null,
    slug: 'team',
    path: 'about/team',
    ord: 'a0',
    title: 'Our team',
  },
]

async function resetStories(): Promise<void> {
  await env.DB.prepare('delete from stories').run()
  for (const row of SEED) {
    await env.DB.prepare(
      `insert into stories (id, parent_id, slug, path, ord, title) values (?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.id, row.parentId, row.slug, row.path, row.ord, row.title)
      .run()
  }
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
