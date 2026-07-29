import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import { envelope, FolioError, rethrow } from '../../src/server/errors'
import type { PublishDeps } from '../../src/server/publish'
import { unpublish } from '../../src/server/publish'
import { lookupRedirect } from '../../src/server/redirects'
import {
  createStory,
  deleteStory,
  deleteStoryStatement,
  duplicateStory,
  listStories,
  publishedDocsByIds,
  publishStoryStatement,
  storyById,
  storyByPath,
  storyStatus,
  unpublishStoryStatement,
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
  // redirects.md rows are keyed on paths this fixture's own reset does not
  // otherwise touch: cleared here too so a redirect written by one test can
  // never leak into the next (see the file-level comment on why writes here
  // are not rolled back per test).
  await env.DB.prepare('delete from redirects').run()
  await applySeedFixture(env.DB)
}

interface RedirectRow {
  from: string
  to: string
  status: number
  source: string
  storyId: string | null
}

async function redirectFor(from: string): Promise<RedirectRow | null> {
  return env.DB.prepare(
    'select from_path as "from", to_path as "to", status, source, story_id as storyId from redirects where from_path = ?',
  )
    .bind(from)
    .first<RedirectRow>()
}

async function allRedirects(): Promise<RedirectRow[]> {
  const { results } = await env.DB.prepare(
    'select from_path as "from", to_path as "to", status, source, story_id as storyId from redirects order by from_path',
  ).all<RedirectRow>()
  return results
}

beforeEach(async () => {
  await resetStories()
})

/** A minimal one-block document, titled, for publish/unpublish tests below. */
function pageDoc(title: string): Doc {
  return {
    root: 'r1',
    bloks: {
      r1: { uid: 'r1', type: 'page', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

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

// duplicate-and-paste.md's architecture decision 5: passing the *source's own
// slug* through to `createStory` is what makes both cases fall out of
// existing code — an ordinary page collides with its still-live original and
// gets bumped to '-2', the root's slug ('') is falsy and falls through to
// deriving one from the title instead.
describe('duplicateStory', () => {
  it('defaults the title to "{source title} (copy)"', async () => {
    const dup = await duplicateStory(env.DB, 'sty_about', {})
    expect(dup.title).toBe('About (copy)')
  })

  it('prefers an explicit title over the default', async () => {
    const dup = await duplicateStory(env.DB, 'sty_about', { title: 'A whole new page' })
    expect(dup.title).toBe('A whole new page')
  })

  it('collides with the still-live source slug and lands on the next suffix', async () => {
    const dup = await duplicateStory(env.DB, 'sty_about', {})
    expect(dup.slug).toBe('about-2')
    expect(dup.path).toBe('about-2')
    // The source is untouched: still at its own path, still there.
    expect(await storyByPath(env.DB, 'about')).not.toBeNull()
  })

  it('defaults to the source’s own parent, landing as a sibling', async () => {
    const dup = await duplicateStory(env.DB, 'sty_team', {})
    expect(dup.parentId).toBe('sty_about')
    expect(dup.path).toBe('about/team-2')
  })

  it('accepts an explicit parentId override', async () => {
    const dest = await createStory(env.DB, { title: 'Elsewhere' })
    const dup = await duplicateStory(env.DB, 'sty_about', { parentId: dest.id })
    expect(dup.parentId).toBe(dest.id)
    expect(dup.path).toBe(`${dest.slug}/about`)
  })

  it('the root’s duplicate is an ordinary top-level page, slug derived from the title', async () => {
    const dup = await duplicateStory(env.DB, 'sty_home', {})
    expect(dup.parentId).toBeNull()
    expect(dup.slug).toBe('home-copy')
    expect(dup.path).toBe('home-copy')
    // The root itself still owns '' — untouched by its own duplicate.
    expect((await storyById(env.DB, 'sty_home'))?.path).toBe('')
  })

  it('the duplicate starts unpublished, with no version history of its own', async () => {
    const dup = await duplicateStory(env.DB, 'sty_about', {})
    expect(dup.publishedAt).toBeNull()
    expect(dup.state).toBe('draft')
  })

  it('rejects duplicating an unknown story', async () => {
    await expect(duplicateStory(env.DB, 'sty_nope', {})).rejects.toThrow('Unknown story')
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

describe('redirects (redirects.md): captured inside updateStory/createStory', () => {
  it('a rename records a redirect from the old path to the path actually written', async () => {
    const updated = await updateStory(env.DB, 'sty_about', { slug: 'about-us' })
    expect(updated.path).toBe('about-us')

    const row = await redirectFor('about')
    expect(row).toMatchObject({
      from: 'about',
      to: 'about-us',
      status: 301,
      source: 'auto',
      storyId: 'sty_about',
    })
  })

  it('a move records one redirect per descendant, all pointing at the new path', async () => {
    const dest = await createStory(env.DB, { title: 'What We Do' })
    await updateStory(env.DB, 'sty_about', { parentId: dest.id })

    expect((await redirectFor('about'))?.to).toBe(`${dest.slug}/about`)
    expect((await redirectFor('about/team'))?.to).toBe(`${dest.slug}/about/team`)
  })

  it('renaming back cannot produce a self-redirect or a loop', async () => {
    await updateStory(env.DB, 'sty_about', { slug: 'about-us' })
    await updateStory(env.DB, 'sty_about', { slug: 'about' })

    // The a -> b row (about -> about-us) is gone: the page occupies 'about' again.
    expect(await redirectFor('about')).toBeNull()
    // Exactly the reverse row remains, for the path just vacated.
    expect((await redirectFor('about-us'))?.to).toBe('about')
    // No row anywhere points at itself.
    for (const row of await allRedirects()) expect(row.from).not.toBe(row.to)
  })

  it('chains collapse: renaming b to c repoints both the a->b and the new b->c row at c', async () => {
    await updateStory(env.DB, 'sty_about', { slug: 'about-us' }) // a (about) -> b (about-us)
    await updateStory(env.DB, 'sty_about', { slug: 'about-final' }) // b (about-us) -> c (about-final)

    expect((await redirectFor('about'))?.to).toBe('about-final')
    expect((await redirectFor('about-us'))?.to).toBe('about-final')
  })

  it('a collision-adjusted slug is recorded as the path actually written, not the one requested', async () => {
    const created = await createStory(env.DB, { title: 'Contact' })
    expect(created.path).toBe('contact')

    // 'about' is already taken at the root, so this lands on 'about-2'.
    const updated = await updateStory(env.DB, created.id, { title: 'About' })
    expect(updated.slug).toBe('about-2')

    expect((await redirectFor('contact'))?.to).toBe('about-2')
  })

  it('creating a story over a redirected path deletes the redirect: live pages always win', async () => {
    await updateStory(env.DB, 'sty_about', { slug: 'about-us' })
    expect(await redirectFor('about')).not.toBeNull()

    await createStory(env.DB, { title: 'About', slug: 'about', parentId: null })

    expect(await redirectFor('about')).toBeNull()
  })

  it('a rejected rename writes no redirect: the batch never runs', async () => {
    await expect(updateStory(env.DB, 'sty_about', { parentId: 'sty_team' })).rejects.toThrow()
    expect(await redirectFor('about')).toBeNull()
  })

  it('lookupRedirect refuses an unsafe target rather than handing it to the host', async () => {
    await env.DB.prepare(
      `insert into redirects (from_path, to_path, status, source, story_id, created_at)
       values (?, ?, ?, 'manual', null, ?)`,
    )
      .bind('bad', 'javascript:alert(1)', 301, Date.now())
      .run()

    expect(await lookupRedirect(env.DB, 'bad')).toBeNull()
  })

  it('lookupRedirect normalises case, slashes and query strings on the way in', async () => {
    await updateStory(env.DB, 'sty_about', { slug: 'about-us' })

    expect(await lookupRedirect(env.DB, '/About/')).toEqual({ to: 'about-us', status: 301 })
    expect(await lookupRedirect(env.DB, 'about?utm_source=x')).toEqual({
      to: 'about-us',
      status: 301,
    })
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
      7,
    )
    expect(title).toBe('Batched Publish')

    // Nothing has run yet: the point is that a caller can batch this with
    // another write before executing either.
    expect((await storyById(env.DB, 'sty_about'))?.publishedAt).toBeNull()

    await statement.run()

    const row = await storyById(env.DB, 'sty_about')
    expect(row?.publishedAt).toBe(publishedAt)
    expect(row?.title).toBe('Batched Publish')
    // The watermark lands in the same statement as the snapshot, so a reader
    // can never see one without the other (unpublished-changes.md).
    expect(row?.publishedSyncId).toBe(7)
  })

  it('clears a stale unpublished_at/unpublished_by on republish', async () => {
    const doc = pageDoc('Republished')
    await unpublishStoryStatement(env.DB, 'sty_about', 'alice').statement.run()
    expect((await storyById(env.DB, 'sty_about'))?.unpublishedAt).not.toBeNull()

    await publishStoryStatement(env.DB, 'sty_about', doc, 'About', 0).statement.run()

    const row = await storyById(env.DB, 'sty_about')
    expect(row?.unpublishedAt).toBeNull()
    expect(row?.state).toBe('live')
  })
})

describe('unpublishStoryStatement', () => {
  it('returns an unrun statement that clears published_doc/published_at and stamps unpublished_at/by', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Up'), 'About', 0).statement.run()

    const { statement, unpublishedAt } = unpublishStoryStatement(env.DB, 'sty_about', 'alice')

    // Nothing has run yet.
    expect((await storyById(env.DB, 'sty_about'))?.publishedAt).not.toBeNull()

    await statement.run()

    const row = await storyById(env.DB, 'sty_about')
    expect(row?.publishedAt).toBeNull()
    expect(row?.unpublishedAt).toBe(unpublishedAt)
    expect(row?.state).toBe('unpublished')

    const raw = await env.DB.prepare('select unpublished_by from stories where id = ?')
      .bind('sty_about')
      .first<{ unpublished_by: string | null }>()
    expect(raw?.unpublished_by).toBe('alice')
  })
})

describe('storyStatus', () => {
  it('is "unknown" for a path with no story at all', async () => {
    expect(await storyStatus(env.DB, 'does-not-exist')).toBe('unknown')
  })

  it('is "unknown" for a story that has never been published', async () => {
    expect(await storyStatus(env.DB, 'about')).toBe('unknown')
  })

  it('is "live" once published', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Live'), 'About', 0).statement.run()
    expect(await storyStatus(env.DB, 'about')).toBe('live')
  })

  it('is "unpublished" once taken down, so a host can answer 410 instead of 404', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Live'), 'About', 0).statement.run()
    await unpublishStoryStatement(env.DB, 'sty_about', 'alice').statement.run()
    expect(await storyStatus(env.DB, 'about')).toBe('unpublished')
  })
})

describe('unpublish (server/publish.ts)', () => {
  function deps(): PublishDeps & { calls: number } {
    const d = {
      db: env.DB,
      calls: 0,
      draft: async () => {
        d.calls++
        throw new Error('unpublish must never read the draft')
      },
      draftWithSyncId: async () => {
        d.calls++
        throw new Error('unpublish must never read the draft')
      },
    }
    return d
  }

  it('clears published_doc/published_at without ever touching the draft', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Up'), 'About', 0).statement.run()

    const d = deps()
    const { unpublishedAt } = await unpublish(d, 'sty_about', 'alice')

    expect(d.calls).toBe(0)
    const row = await storyById(env.DB, 'sty_about')
    expect(row?.publishedAt).toBeNull()
    expect(row?.unpublishedAt).toBe(unpublishedAt)
  })

  it('is idempotent: a second call on an already-unpublished story reports the same timestamp and writes nothing', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Up'), 'About', 0).statement.run()
    const d = deps()
    const first = await unpublish(d, 'sty_about', 'alice')

    await new Promise((r) => setTimeout(r, 5))
    const second = await unpublish(d, 'sty_about', 'bob')

    expect(second.unpublishedAt).toBe(first.unpublishedAt)
    const raw = await env.DB.prepare('select unpublished_by from stories where id = ?')
      .bind('sty_about')
      .first<{ unpublished_by: string | null }>()
    // The second call's actor never landed: idempotent means no write happened.
    expect(raw?.unpublished_by).toBe('alice')
  })

  it('allows unpublishing the root story', async () => {
    await publishStoryStatement(env.DB, 'sty_home', pageDoc('Root'), 'Home', 0).statement.run()

    const { unpublishedAt } = await unpublish(deps(), 'sty_home', 'alice')

    expect(unpublishedAt).toBeGreaterThan(0)
    expect((await storyById(env.DB, 'sty_home'))?.publishedAt).toBeNull()
    // Delete is still refused, as today — unpublish is not delete.
    await expect(deleteStoryStatement(env.DB, 'sty_home')).rejects.toThrow(
      'Cannot delete the root story',
    )
  })

  it('rejects unpublishing an unknown story', async () => {
    await expect(unpublish(deps(), 'sty_nope', null)).rejects.toThrow('Unknown story')
  })
})

describe('publishedDocsByIds and unpublish: references degrade, they do not break', () => {
  it('an unpublished story stops resolving as a reference; publishedDocsByIds simply omits it', async () => {
    const doc = pageDoc('Referenced')
    await publishStoryStatement(env.DB, 'sty_about', doc, 'About', 0).statement.run()
    expect(await publishedDocsByIds(env.DB, ['sty_about'])).toEqual({ sty_about: doc })

    await unpublish(
      { db: env.DB, draft: async () => doc, draftWithSyncId: async () => ({ doc, syncId: 0 }) },
      'sty_about',
      'alice',
    )

    expect(await publishedDocsByIds(env.DB, ['sty_about'])).toEqual({})
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

  it('defaults to no redirect statements when no options are given', async () => {
    const found = await deleteStoryStatement(env.DB, 'sty_about')
    expect(found?.redirectStatements).toEqual([])
  })

  describe('with { redirect: true } (redirects.md architecture decision 4)', () => {
    it('redirects the deleted node and every descendant to its parent, in the same batch', async () => {
      const found = await deleteStoryStatement(env.DB, 'sty_about', { redirect: true })
      expect(found?.redirectStatements.length).toBeGreaterThan(0)

      await env.DB.batch([found!.statement, ...found!.redirectStatements])

      // sty_about's parent is the root, path ''. Both it and its descendant
      // 'about/team' redirect there — the nearest surviving ancestor, since the
      // whole subtree goes together.
      expect((await redirectFor('about'))?.to).toBe('')
      expect((await redirectFor('about/team'))?.to).toBe('')

      expect(await storyByPath(env.DB, 'about')).toBeNull()
    })

    it("redirects to the deleted node's own parent, not the root, when it is nested", async () => {
      const found = await deleteStoryStatement(env.DB, 'sty_team', { redirect: true })
      await env.DB.batch([found!.statement, ...found!.redirectStatements])

      expect((await redirectFor('about/team'))?.to).toBe('about')
    })
  })

  describe('with { redirect: false } (the escape hatch)', () => {
    it('writes no redirect: the path simply 404s', async () => {
      const found = await deleteStoryStatement(env.DB, 'sty_about', { redirect: false })
      await env.DB.batch([found!.statement, ...found!.redirectStatements])

      expect(await redirectFor('about')).toBeNull()
      expect(await redirectFor('about/team')).toBeNull()
    })
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

  // unpublished-changes.md: the tree-wide badge is a watermark comparison, not
  // a diff, and it must reach every reader of a story row — including the ones
  // `listStories` itself serves, since `storyTree` and `folio.stories(env)`
  // both go through it.
  it('derives "changed" and hasUnpublishedChanges once the draft watermark moves past the published one', async () => {
    await publishStoryStatement(env.DB, 'sty_about', pageDoc('Live'), 'About', 3).statement.run()
    await env.DB.prepare('update stories set draft_sync_id = ? where id = ?')
      .bind(5, 'sty_about')
      .run()

    const rows = await listStories(env.DB)
    const about = rows.find((r) => r.id === 'sty_about')
    expect(about?.state).toBe('changed')
    expect(about?.hasUnpublishedChanges).toBe(true)
    expect(about?.draftSyncId).toBe(5)
    expect(about?.publishedSyncId).toBe(3)

    // A never-published story reads clean, not "everything changed": both
    // watermarks default to 0 (migrations/0005_draft_watermark.sql).
    const home = rows.find((r) => r.id === 'sty_home')
    expect(home?.state).toBe('draft')
    expect(home?.hasUnpublishedChanges).toBe(false)
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
