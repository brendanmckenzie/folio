import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DocumentType } from '../../src/core/schema'
import { countStories, createStory, listRecentlyEdited } from '../../src/server/stories'
import { listRecentPublishes } from '../../src/server/versions'
import { applySeedFixture } from './seed-fixture'

/**
 * The site-wide recency reads — `docs/ui-architecture.md` dependency 5, which the
 * Home screen's *Latest changes* and *Latest published* blocks are, plus the count
 * its quick-access cards are.
 *
 * All three exist because the obvious existing reader is subtly the wrong one:
 * `listStoriesFlat` filters `path is not null`, so it answers every routed *page*
 * rather than every document, and a card asking the list route for
 * `?limit=1&count=1` pays for a row nobody draws. The assertions below are about
 * exactly those differences.
 */

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }
const PERSON: DocumentType = { name: 'person', label: 'Person', kind: 'record', root: 'page' }
const TYPES = [PAGE, PERSON]

async function reset(): Promise<void> {
  await env.DB.prepare('delete from versions').run()
  await env.DB.prepare('delete from stories').run()
  await env.DB.prepare('delete from redirects').run()
  await env.DB.prepare('delete from api_tokens').run()
  await env.DB.prepare('delete from users').run()
  await applySeedFixture(env.DB)
}

/** Stamps a row's `edited` watermark directly. `POST /stories` cannot produce a
 * chosen timestamp, and these tests are about the ordering. */
async function edited(id: string, at: number): Promise<void> {
  await env.DB.prepare('update stories set draft_updated_at = ? where id = ?').bind(at, id).run()
}

beforeEach(async () => {
  await reset()
})

describe('listRecentlyEdited', () => {
  /**
   * The whole reason this is not `listStoriesFlat`. A site whose editors spent the
   * afternoon on People has to see People in "what changed lately", and flat mode
   * cannot show it — `path is not null` is what makes flat mode the page tree's twin.
   */
  it('includes an unrouted document, which flat mode by construction cannot', async () => {
    const ada = await createStory(env.DB, { title: 'Ada', type: PERSON }, TYPES)
    await edited(ada.id, Date.now())
    await edited('sty_about', Date.now() - 60_000)

    const page = await listRecentlyEdited(env.DB, { limit: 10 })
    expect(page.rows[0]?.id).toBe(ada.id)
    expect(page.rows.map((r) => r.id)).toContain('sty_about')
  })

  /**
   * The `coalesce`, which is the same rule `ORDERS.edited` states in SQL and
   * `content-rows.ts`'s `when()` states in TypeScript. `draft_updated_at` is null
   * until a document's first debounced write and SQLite sorts nulls last under
   * `desc`, so the bare column would sink a document created five minutes ago below
   * one last edited years ago.
   */
  it('sorts a never-opened document by its own updated_at, not last', async () => {
    const fresh = await createStory(env.DB, { title: 'Never Opened', type: PAGE }, TYPES)
    // Explicitly null: created now, never written to.
    await env.DB.prepare('update stories set draft_updated_at = null where id = ?')
      .bind(fresh.id)
      .run()
    await edited('sty_about', Date.now() - 5 * 365 * 24 * 3600 * 1000)

    const page = await listRecentlyEdited(env.DB, { limit: 10 })
    const ids = page.rows.map((r) => r.id)
    expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf('sty_about'))
  })

  it('pages over a cursor with no row on two pages, and counts only when asked', async () => {
    for (const title of ['A', 'B', 'C', 'D']) {
      await createStory(env.DB, { title, type: PERSON }, TYPES)
    }

    const first = await listRecentlyEdited(env.DB, { limit: 2, count: true })
    expect(first.rows).toHaveLength(2)
    expect(first.total).toBeGreaterThanOrEqual(4)

    const second = await listRecentlyEdited(env.DB, {
      limit: 2,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    })
    expect(second).not.toHaveProperty('total')
    const seen = new Set(first.rows.map((r) => r.id))
    expect(second.rows.some((r) => seen.has(r.id))).toBe(false)
  })
})

describe('countStories', () => {
  it('separates routed pages from a type’s documents', async () => {
    await createStory(env.DB, { title: 'Ada', type: PERSON }, TYPES)
    await createStory(env.DB, { title: 'Grace', type: PERSON }, TYPES)

    // A card labelled "Pages" means the tree, not the sum of the page kinds — a
    // second page type's records are in the tree too, so the two are different
    // questions and `routed` is the one filter key that tells them apart.
    expect(await countStories(env.DB, { type: 'person' })).toBe(2)
    expect(await countStories(env.DB, { routed: false })).toBe(2)
    expect(await countStories(env.DB, { routed: true })).toBe(3) // the seeded three
  })

  it('answers 0 rather than throwing for a type with nothing in it', async () => {
    expect(await countStories(env.DB, { type: 'nothing-declared' })).toBe(0)
  })

  /** The same `storyFilters` the list routes use, so a card's number and a header's
   * `Showing n of N` cannot disagree — `pagination.md` decision 5's requirement that
   * one count implementation serves both. */
  it('honours the same filters a list does', async () => {
    const ada = await createStory(env.DB, { title: 'Ada', type: PERSON }, TYPES)
    await env.DB.prepare('update stories set published_at = ? where id = ?')
      .bind(Date.now(), ada.id)
      .run()

    expect(await countStories(env.DB, { type: 'person', state: 'live' })).toBe(1)
    expect(await countStories(env.DB, { type: 'person', state: 'draft' })).toBe(0)
  })
})

describe('listRecentPublishes', () => {
  const publish = async (storyId: string, at: number, kind = 'publish') => {
    await env.DB.prepare(
      `insert into versions (id, story_id, kind, label, title, actor, created_at, doc)
       values (?, ?, ?, null, ?, 'usr_test', ?, '{}')`,
    )
      .bind(`ver_${storyId}_${at}`, storyId, kind, `Title at ${at}`, at)
      .run()
  }

  it('answers the version and its story as two halves, newest first', async () => {
    await publish('sty_about', 1000)
    await publish('sty_team', 2000)

    const page = await listRecentPublishes(env.DB, { limit: 10 })
    expect(page.rows.map((r) => r.version.storyId)).toEqual(['sty_team', 'sty_about'])
    // The version's title is the title *at publish time*, which is the right label
    // for "what went live" — a page renamed since is not what was published.
    expect(page.rows[0]?.version.title).toBe('Title at 2000')
    // The story is a whole `StoryMeta`, which is what lets the route decorate it
    // with the host's own URL rather than faking one from a path.
    expect(page.rows[0]?.story.id).toBe('sty_team')
    expect(page.rows[0]?.story.state).toBeDefined()
  })

  it('counts a publish and not a checkpoint', async () => {
    await publish('sty_about', 3000, 'checkpoint')
    await publish('sty_team', 1000)

    const page = await listRecentPublishes(env.DB, { limit: 10 })
    // The checkpoint is newer and is absent: a list called "latest published" that
    // counted an editor's private save point as a release would be worse than none.
    expect(page.rows.map((r) => r.version.storyId)).toEqual(['sty_team'])
  })

  it('drops a publish whose story is gone rather than linking to nothing', async () => {
    await publish('sty_about', 1000)
    await publish('sty_vanished', 2000)

    const page = await listRecentPublishes(env.DB, { limit: 10 })
    expect(page.rows.map((r) => r.version.storyId)).toEqual(['sty_about'])
  })

  it('pages over a cursor', async () => {
    for (const at of [1000, 2000, 3000, 4000]) await publish('sty_about', at)

    const first = await listRecentPublishes(env.DB, { limit: 2 })
    expect(first.rows).toHaveLength(2)
    expect(first.cursor).not.toBeNull()

    const second = await listRecentPublishes(env.DB, {
      limit: 2,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    })
    const seen = new Set(first.rows.map((r) => r.version.id))
    expect(second.rows.some((r) => seen.has(r.version.id))).toBe(false)
    // Newest first across the boundary, not only within a page.
    expect(Math.min(...first.rows.map((r) => r.version.createdAt))).toBeGreaterThan(
      Math.max(...second.rows.map((r) => r.version.createdAt)),
    )
  })
})
