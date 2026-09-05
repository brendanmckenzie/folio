import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import type { Page } from '../../src/core/pagination'
import type { ActivityEntry } from '../../src/core/protocol'
import { applySeedFixture } from './seed-fixture'

/**
 * Migrations (migrations/**) are structure only — no seed rows
 * ship with them, unlike the old drop-and-reseed schema.sql — so this file
 * seeds its own fixture by running the actual examples/demo/seed.sql (see
 * seed-fixture.ts), the same file `pnpm db:seed` runs. That is what makes the
 * next test below a real assertion rather than a tautological one: a wrong
 * column order or a typo in seed.sql fails here, instead of only being
 * catchable by hand in a browser. Runs once for the whole file, same as
 * apply-schema.ts's own `beforeAll` (registered first, since it comes from
 * `setupFiles`), so every test below still starts from this exact tree.
 */
beforeAll(async () => {
  await applySeedFixture(env.DB)
})

const seed: Doc = {
  root: 'root0000',
  bloks: {
    root0000: {
      uid: 'root0000',
      type: 'page',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title: 'Home' },
    },
  },
}

async function storyCount(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from stories').first<{ n: number }>()
  return row?.n ?? -1
}

describe('workers harness: D1', () => {
  it('applies the migrations, tables and all', async () => {
    // Miniflare keeps its own `_cf_METADATA` table in the same database.
    // `d1_migrations` is `applyD1Migrations`'s own bookkeeping table (see
    // apply-schema.ts), the same one a real `wrangler d1 migrations apply` run
    // creates in production.
    //
    // The four `content_fts_*` rows are FTS5's shadow tables, which it creates
    // for itself from the one `create virtual table` in `0005_content_fts.sql`.
    // They are listed rather than filtered out: this assertion is "what did the
    // migrations directory actually produce", and an FTS5 table quietly losing or
    // gaining a shadow table is exactly the kind of thing it should report. Note
    // which one is *not* here — `content_fts_content`, whose absence is the proof
    // that `content='content_text'` took and the prose is stored once
    // (migrations.test.ts asserts that directly).
    const { results } = await env.DB.prepare(
      `select name from sqlite_master
       where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'
       order by name`,
    ).all<{ name: string }>()

    expect(results.map((r) => r.name)).toEqual([
      'api_tokens',
      // 0008: the media library's organisation (content-model/media-library.md).
      // A folder is metadata and never part of an R2 key, so these three tables
      // are the whole of it — filing a file writes one column and touches no
      // object. Shapes are asserted in migrations.test.ts; this list only says
      // they exist.
      'asset_folders',
      'asset_taggings',
      'asset_tags',
      'assets',
      'auth_events',
      'content_fts',
      'content_fts_config',
      'content_fts_data',
      'content_fts_docsize',
      'content_fts_idx',
      'content_index',
      'content_refs',
      'content_text',
      'd1_migrations',
      'login_challenges',
      // 0007: one WebAuthn credential per row (foundation/passkeys.md). Its
      // shape is asserted in migrations.test.ts; this list only says it exists.
      'passkeys',
      'redirects',
      'schedules',
      'schema_migrations',
      'sessions',
      'shares',
      'stories',
      'users',
      'versions',
    ])
  })

  it('has the seed stories from examples/demo/seed.sql, including the root story serving /', async () => {
    const { results } = await env.DB.prepare(
      'select id, parent_id, slug, path, ord, title from stories order by path',
    ).all<{
      id: string
      parent_id: string | null
      slug: string
      path: string
      ord: string
      title: string
    }>()

    expect(results).toEqual([
      { id: 'sty_home', parent_id: null, slug: '', path: '', ord: 'a0', title: 'Home' },
      { id: 'sty_about', parent_id: null, slug: 'about', path: 'about', ord: 'a1', title: 'About' },
      {
        id: 'sty_team',
        parent_id: 'sty_about',
        slug: 'team',
        path: 'about/team',
        ord: 'a0',
        title: 'Our team',
      },
    ])
  })

  // This test and the next one are a pair, in order. Together they pin the
  // storage contract every server test in this tree inherits: each test *file*
  // gets its own D1 and Durable Object storage (verified: a row inserted by
  // another test file is not visible here), but there is no rollback between
  // tests within a file. Pool 0.18 dropped the `isolatedStorage` option and the
  // per-test stack that went with it, so a test that mutates the seed data has
  // to put it back itself.
  it('lets a test write to D1', async () => {
    await env.DB.prepare('delete from stories where id = ?').bind('sty_team').run()

    expect(await storyCount()).toBe(2)
  })

  it('keeps that write for the next test in the same file', async () => {
    expect(await storyCount()).toBe(2)

    await env.DB.prepare(
      `insert into stories (id, parent_id, slug, path, ord, title)
       values ('sty_team', 'sty_about', 'team', 'about/team', 'a0', 'Our team')`,
    ).run()

    expect(await storyCount()).toBe(3)
  })
})

/**
 * Calling `getOrInit` straight off a `DurableObjectStub<StoryDO>` fails to
 * compile with TS2589 ("type instantiation is excessively deep"): the RPC type
 * mapper cannot chew through `Doc`, whose `Json` field type is recursive.
 *
 * src/server/types.ts hits the same wall and works around it with a
 * `Pick<StoryDO, ...>` derived from the class, so tests are not inventing
 * anything here. Keep this in step with the pick over there.
 */
interface StoryStub {
  getOrInit(seed: Doc): Promise<Doc>
  recent(limit?: number, cursor?: string): Promise<Page<ActivityEntry>>
}

const storyStub = (id: string) => env.STORY.get(env.STORY.idFromName(id)) as unknown as StoryStub

describe('workers harness: StoryDO', () => {
  it('reaches the Durable Object over RPC and gets a document back', async () => {
    const stub = storyStub('sty_home')
    const doc = await stub.getOrInit(seed)

    expect(doc.root).toBe('root0000')
    expect(doc.bloks.root0000?.data.title).toBe('Home')
    // Nothing has been transacted, so the activity log is empty.
    expect((await stub.recent()).rows).toEqual([])
  })

  it('keeps the draft it created, so a later seed is ignored', async () => {
    const stub = storyStub('sty_about')
    await stub.getOrInit(seed)

    const again = await stub.getOrInit({ root: 'other000', bloks: {} })

    expect(again).toEqual(seed)
  })

  it('names objects by story id, matching how src/server derives the stub', async () => {
    const byName = env.STORY.idFromName('sty_home')

    expect(byName.toString()).toBe(env.STORY.idFromName('sty_home').toString())
    expect(byName.toString()).not.toBe(env.STORY.idFromName('sty_about').toString())
  })
})

describe('workers harness: bindings', () => {
  it('binds MEDIA but not IMAGES, the fallback configuration', async () => {
    await env.MEDIA.put('smoke.txt', 'hello')

    expect(await env.MEDIA.get('smoke.txt').then((o) => o?.text())).toBe('hello')
    // src/server/assets.ts serves originals when there is no Images binding.
    expect(env.IMAGES).toBeUndefined()
  })
})
