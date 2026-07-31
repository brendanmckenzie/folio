import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * What `migrations/` actually produced, asserted against the live database the
 * pool built by applying the real directory (see apply-schema.ts).
 *
 * **Organised by table, not by migration.** It used to be by migration number,
 * because there were ten of them and the load-bearing one rebuilt `stories` — so
 * "did 0007 accidentally rebuild it again" was a real question with a real answer.
 * `0001_init.sql` collapsed the series (`docs/specs/foundation/pagination.md`
 * decision 10), so that question is gone and the tests that asked it went with
 * it. What survives is everything about the *shape*, which is what any future
 * migration has to keep passing.
 *
 * Deliberately reads `sqlite_master` and `pragma table_info` rather than
 * exercising the server: the point is the structure, not any code path over it.
 */

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const columnsOf = async (table: string): Promise<ColumnInfo[]> => {
  const { results } = await env.DB.prepare('select * from pragma_table_info(?)')
    .bind(table)
    .all<ColumnInfo>()
  return results
}

const indexesOf = async (table: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `select name from sqlite_master
     where type = 'index' and tbl_name = ? and name not like 'sqlite_%'
     order by name`,
  )
    .bind(table)
    .all<{ name: string }>()
  return results.map((r) => r.name)
}

const indexSql = async (name: string): Promise<string> => {
  const row = await env.DB.prepare('select sql from sqlite_master where name = ?')
    .bind(name)
    .first<{ sql: string }>()
  return row?.sql ?? ''
}

const columns = () => columnsOf('stories')
const indexNames = () => indexesOf('stories')

beforeEach(async () => {
  await env.DB.prepare('delete from stories').run()
})

describe('stories', () => {
  it('has every column, in order', async () => {
    expect((await columns()).map((c) => c.name)).toEqual([
      'id',
      'type',
      'parent_id',
      'slug',
      'path',
      'ord',
      'title',
      'published_doc',
      'published_at',
      'created_at',
      'updated_at',
      'unpublished_at',
      'unpublished_by',
      'draft_sync_id',
      'draft_updated_at',
      'published_sync_id',
      'schema_id',
      'title_i18n',
    ])
  })

  it('keeps `path` nullable, which is what takes an unrouted document out of the URL namespace', async () => {
    const byName = new Map((await columns()).map((c) => [c.name, c]))

    expect(byName.get('path')?.notnull).toBe(0)
    expect(byName.get('slug')?.notnull).toBe(1)
    expect(byName.get('ord')?.notnull).toBe(1)
    expect(byName.get('title')?.notnull).toBe(1)
    expect(byName.get('id')?.pk).toBe(1)
    expect(byName.get('unpublished_at')?.notnull).toBe(0)
    expect(byName.get('unpublished_by')?.notnull).toBe(0)
  })

  it('defaults both watermarks to 0, so an untouched row reads "nothing changed"', async () => {
    const byName = new Map((await columns()).map((c) => [c.name, c]))
    expect(byName.get('draft_sync_id')?.dflt_value).toBe('0')
    expect(byName.get('published_sync_id')?.dflt_value).toBe('0')
    expect(byName.get('draft_updated_at')?.dflt_value).toBeNull()

    // Proven, not just read off the schema: an insert naming none of the three.
    await env.DB.prepare(
      `insert into stories (id, parent_id, slug, path, ord, title) values (?, null, ?, ?, ?, ?)`,
    )
      .bind('sty_defaults', 'd', 'd', 'a0', 'Defaults')
      .run()
    const row = await env.DB.prepare(
      'select type, draft_sync_id, published_sync_id, draft_updated_at from stories where id = ?',
    )
      .bind('sty_defaults')
      .first<{
        type: string
        draft_sync_id: number
        published_sync_id: number
        draft_updated_at: number | null
      }>()
    expect(row).toEqual({
      // `type` defaults to 'page', which is what `root: 'page'` sugar expands to.
      type: 'page',
      draft_sync_id: 0,
      published_sync_id: 0,
      draft_updated_at: null,
    })
  })

  it('keeps `schema_id` nullable with no default, because null means "before the first migration"', async () => {
    // A `default ''` would make every row read as having had a migration whose id
    // sorts before everything, so `pendingFor` would hand back nothing and the
    // whole feature would no-op on exactly the rows it exists for.
    const col = (await columns()).find((c) => c.name === 'schema_id')
    expect(col?.notnull).toBe(0)
    expect(col?.dflt_value).toBeNull()

    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title)
       values ('sty_nomig', 'page', null, 'pre', 'pre', 'a0', 'Pre')`,
    ).run()
    const row = await env.DB.prepare('select schema_id from stories where id = ?')
      .bind('sty_nomig')
      .first<{ schema_id: string | null }>()
    expect(row?.schema_id).toBeNull()
  })

  it('has exactly these seven indexes', async () => {
    expect(await indexNames()).toEqual([
      'stories_edited',
      'stories_parent_ord',
      'stories_parent_slug',
      'stories_path',
      'stories_title',
      'stories_type',
      'stories_type_slug',
    ])
  })

  it('does NOT have `stories_draft_updated`, which nothing ever read', async () => {
    // Added by the old `0005`, carried through `0006`'s rebuild, and never once
    // ordered by: the only references to that column in `src/` are a write in
    // `story-do.ts` and a projection in `stories.ts`. It cost every story write
    // for nothing, and it indexes the wrong expression for the query that now
    // wants it — `stories_edited` below is the right one.
    //
    // Asserted as an absence so nobody restores it by copying an old migration.
    expect(await indexNames()).not.toContain('stories_draft_updated')
  })

  it('makes the two page-namespace indexes partial on `path is not null`', async () => {
    expect(await indexSql('stories_path')).toMatch(/where path is not null/i)
    expect(await indexSql('stories_parent_slug')).toMatch(/where path is not null/i)
    // The coalesce is load-bearing: SQLite treats every NULL in a unique index as
    // distinct, so top-level siblings would never collide without it.
    expect(await indexSql('stories_parent_slug')).toMatch(/coalesce\(parent_id, ''\)/i)
  })
})

/**
 * `stories_edited` and the reason it is an expression index.
 *
 * "Last edited" is `coalesce(draft_updated_at, updated_at)`, because
 * `draft_updated_at` is null until a document's first debounced write. The two
 * tests below are the same query ordered two ways, and the second one is the bug
 * this index exists to make impossible to reach for.
 */
describe('stories_edited', () => {
  beforeEach(async () => {
    const insert = (id: string, draftUpdated: number | null, updated: number) =>
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at, draft_updated_at)
         values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, ?)`,
      )
        .bind(id, id, id, id, updated, updated, draftUpdated)
        .run()

    // Created just now, never opened, so its draft watermark is null.
    await insert('fresh', null, 5000)
    // Edited long ago, so it has one.
    await insert('stale', 1000, 1000)
  })

  it('indexes the coalesce, not the bare column', async () => {
    const sql = await indexSql('stories_edited')
    expect(sql).toMatch(/coalesce\(draft_updated_at,\s*updated_at\)/i)
    // `id` is the tiebreak a keyset cursor over this order needs.
    expect(sql).toMatch(/id desc/i)
  })

  it('sorts a never-opened new page above one edited long ago', async () => {
    const { results } = await env.DB.prepare(
      `select id from stories order by coalesce(draft_updated_at, updated_at) desc, id desc`,
    ).all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['fresh', 'stale'])
  })

  it('gets it exactly backwards when ordered by the bare column — the bug, pinned', async () => {
    // SQLite sorts NULLs last under `desc`, so a page created five minutes ago
    // lands at the bottom of a list called "last edited". Kept as a test rather
    // than a comment because it is the whole justification for the index above,
    // and it would otherwise look like a needless complication to a later reader.
    const { results } = await env.DB.prepare(
      `select id from stories order by draft_updated_at desc, id desc`,
    ).all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['stale', 'fresh'])
  })
})

/**
 * The three slug namespaces the partial indexes create. Written with raw
 * statements on purpose: `createStory`'s `uniqueSlug` bumps a colliding slug
 * before it ever reaches D1, so the only way to observe what the *database*
 * refuses is to go around it — which is also exactly what an importer or a
 * hand-written fixup query does.
 */
describe('the three slug namespaces', () => {
  const insert = (
    id: string,
    type: string,
    parent: string | null,
    slug: string,
    path: string | null,
  ) =>
    env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title) values (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, type, parent, slug, path, 'a0', id)
      .run()

  it('refuses two routed rows at the same path', async () => {
    await insert('a', 'page', null, 'x', 'x')
    await expect(insert('b', 'page', null, 'y', 'x')).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('refuses two top-level routed siblings sharing a slug, even at different paths', async () => {
    await insert('a', 'page', null, 'dup', 'dup')
    // Only `stories_parent_slug`'s coalesce catches this: the paths differ.
    await expect(insert('b', 'page', null, 'dup', 'elsewhere')).rejects.toThrow(
      /UNIQUE constraint failed/i,
    )
  })

  it('lets a page and a record share a slug: different namespaces entirely', async () => {
    await insert('page1', 'page', null, 'contact', 'contact')
    await insert('rec1', 'person', null, 'contact', null)

    const { results } = await env.DB.prepare(
      "select id from stories where slug = 'contact' order by id",
    ).all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['page1', 'rec1'])
  })

  it('refuses two unrouted rows of the same type sharing a slug', async () => {
    await insert('rec1', 'person', null, 'ada', null)
    await expect(insert('rec2', 'person', null, 'ada', null)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    )
  })

  it('lets two unrouted rows of different types share a slug', async () => {
    await insert('rec1', 'person', null, 'ada', null)
    await insert('rec2', 'office', null, 'ada', null)

    const { results } = await env.DB.prepare(
      "select id from stories where slug = 'ada' order by id",
    ).all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['rec1', 'rec2'])
  })

  it('lets many unrouted rows coexist with a null path, which a plain unique index would not', async () => {
    await insert('r1', 'person', null, 'one', null)
    await insert('r2', 'person', null, 'two', null)
    await insert('r3', 'person', null, 'three', null)

    const row = await env.DB.prepare('select count(*) as n from stories where path is null').first<{
      n: number
    }>()
    expect(row?.n).toBe(3)
  })
})

describe('versions', () => {
  it('has every column, and `schema_id` nullable with no default', async () => {
    expect((await columnsOf('versions')).map((c) => c.name)).toEqual([
      'id',
      'story_id',
      'kind',
      'label',
      'title',
      'actor',
      'doc',
      'created_at',
      'schema_id',
    ])
    const col = (await columnsOf('versions')).find((c) => c.name === 'schema_id')
    expect(col?.notnull).toBe(0)
    expect(col?.dflt_value).toBeNull()
  })

  it('constrains `kind` to publish or checkpoint', async () => {
    await expect(
      env.DB.prepare(
        `insert into versions (id, story_id, kind, title, doc, created_at)
         values ('ver_x', 'sty_x', 'unpublish', 'T', '{}', 1)`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i)
  })

  it('indexes by story and recency, which is what the history panel reads', async () => {
    expect(await indexesOf('versions')).toEqual(['versions_story'])
  })
})

describe('assets', () => {
  it('has exactly one index, and the two new sorts deliberately have none', async () => {
    // The Assets screen sorts by filename and by size as well as by date
    // (`core/story.ts`'s `AssetSort`), and neither got an index. An asset table is
    // bounded by what somebody uploaded by hand, so the scan-and-sort is over
    // hundreds of rows while an index is a write cost on every upload forever.
    //
    // Asserted as an absence for the same reason `stories_draft_updated` is: that
    // index was created for a query nobody had written and cost every story write
    // for ten migrations. Adding one here should be a deliberate act with a
    // measurement behind it, not a reflex — which means this assertion failing is
    // the conversation, not an obstacle to it.
    expect(await indexesOf('assets')).toEqual(['assets_created'])
  })

  it('has every column and a unique R2 key', async () => {
    expect((await columnsOf('assets')).map((c) => c.name)).toEqual([
      'id',
      'key',
      'filename',
      'content_type',
      'size',
      'width',
      'height',
      'alt',
      'created_at',
    ])
    expect(await indexesOf('assets')).toContain('assets_created')

    await env.DB.prepare(
      `insert into assets (id, key, filename, content_type, size, created_at)
       values ('ast_a', 'k/one.png', 'one.png', 'image/png', 1, 1)`,
    ).run()
    await expect(
      env.DB.prepare(
        `insert into assets (id, key, filename, content_type, size, created_at)
         values ('ast_b', 'k/one.png', 'one.png', 'image/png', 1, 1)`,
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
    await env.DB.prepare('delete from assets').run()
  })
})

describe('redirects', () => {
  it('has every column and constrains status and source', async () => {
    expect((await columnsOf('redirects')).map((c) => c.name)).toEqual([
      'from_path',
      'to_path',
      'status',
      'source',
      'story_id',
      'created_at',
    ])
    expect(await indexesOf('redirects')).toEqual(['redirects_to'])

    await expect(
      env.DB.prepare(
        `insert into redirects (from_path, to_path, status, created_at) values ('a', 'b', 418, 1)`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i)
    await expect(
      env.DB.prepare(
        `insert into redirects (from_path, to_path, source, created_at) values ('a', 'b', 'guess', 1)`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i)
  })
})

/**
 * Identity. What is pinned is the shape the middleware and the Durable Object's
 * revocation check depend on: the hashed primary keys, the role constraint, and
 * the indexes that keep a per-request session lookup, the per-address link rate
 * limit and the user list from being table scans.
 */
describe('identity', () => {
  it('creates `users` with a unique email, a constrained role, and a created_at index', async () => {
    expect((await columnsOf('users')).map((c) => c.name)).toEqual([
      'id',
      'email',
      'name',
      'colour',
      'role',
      'provider',
      'created_at',
      'last_seen_at',
    ])
    const role = (await columnsOf('users')).find((c) => c.name === 'role')
    expect(role?.dflt_value).toBe("'editor'")
    expect(role?.notnull).toBe(1)

    // `listUsers` orders by created_at and had no index for it before the
    // collapse (`pagination.md`'s schema delta).
    expect(await indexesOf('users')).toEqual(['users_created'])

    await env.DB.prepare(
      "insert into users (id, email, name, role, created_at) values ('usr_a', 'a@x.com', 'A', 'admin', 1)",
    ).run()
    await expect(
      env.DB.prepare(
        "insert into users (id, email, name, role, created_at) values ('usr_b', 'a@x.com', 'B', 'editor', 1)",
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
    await expect(
      env.DB.prepare(
        "insert into users (id, email, name, role, created_at) values ('usr_c', 'c@x.com', 'C', 'owner', 1)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i)
    await env.DB.prepare('delete from users').run()
  })

  it('creates `sessions` keyed on the token hash, indexed by user and expiry', async () => {
    expect((await columnsOf('sessions')).map((c) => c.name)).toEqual([
      'id',
      'user_id',
      'created_at',
      'expires_at',
      'user_agent',
    ])
    // `id` is the SHA-256 of the cookie's token, so it must be the primary key:
    // the per-request lookup is by it and nothing else.
    expect((await columnsOf('sessions')).find((c) => c.name === 'id')?.pk).toBe(1)
    expect(await indexesOf('sessions')).toEqual(['sessions_expiry', 'sessions_user'])
  })

  it('creates `login_challenges` with the index the rate limit counts on', async () => {
    expect((await columnsOf('login_challenges')).map((c) => c.name)).toEqual([
      'id',
      'email',
      'created_at',
      'expires_at',
      'consumed_at',
    ])
    expect(await indexesOf('login_challenges')).toEqual(['login_challenges_email'])
  })

  it('creates `api_tokens` with scopes as text and a revocation stamp', async () => {
    expect((await columnsOf('api_tokens')).map((c) => c.name)).toEqual([
      'id',
      'name',
      'scopes',
      'created_by',
      'created_at',
      'expires_at',
      'last_used_at',
      'revoked_at',
    ])
    expect(await indexesOf('api_tokens')).toEqual(['api_tokens_created'])
  })
})

describe('content migrations ledger', () => {
  it('creates `schema_migrations` keyed on the migration id', async () => {
    expect((await columnsOf('schema_migrations')).map((c) => c.name)).toEqual([
      'id',
      'applied_at',
      'actor',
      'stories_seen',
      'stories_changed',
      'mutations',
      'failed',
    ])
    // One row per migration: a re-run updates it rather than appending a second
    // history of the same thing.
    expect((await columnsOf('schema_migrations')).find((c) => c.name === 'id')?.pk).toBe(1)
  })
})

describe('content index', () => {
  it('creates `content_index` keyed on (story, locale, field) with both value columns', async () => {
    expect((await columnsOf('content_index')).map((c) => c.name)).toEqual([
      'story_id',
      'locale',
      'field',
      'text_value',
      'num_value',
    ])
    // `''` is the source locale, so a single-locale site has one row per field and
    // no null handling anywhere.
    expect((await columnsOf('content_index')).find((c) => c.name === 'locale')?.dflt_value).toBe(
      "''",
    )
    expect(await indexesOf('content_index')).toEqual(['content_index_lookup', 'content_index_num'])
  })

  it('creates `content_refs` keyed on (from, to_id, kind), indexed inbound', async () => {
    // `to_id`, not `to_story`: the column holds whatever `kind` says it holds — a
    // story id for `link` and `reference`, an R2 object key for `asset`
    // (`0002_asset_refs.sql`). The rename is what keeps the column from lying about
    // what is in it now that asset usage lives in the same table.
    expect((await columnsOf('content_refs')).map((c) => c.name)).toEqual([
      'from_story',
      'to_id',
      'kind',
    ])
    // Inbound is the direction "used by N documents" reads.
    expect(await indexesOf('content_refs')).toEqual(['content_refs_to'])
  })

  it('carries the inbound index and the primary key through the rename', async () => {
    // SQLite rewrites the schema text of every index naming a renamed column, so
    // this should be automatic — and "the index quietly points at nothing now" is
    // the failure a rename has, so it is asserted rather than assumed.
    expect(await indexSql('content_refs_to')).toMatch(/\(\s*to_id\s*\)/i)

    const table = await env.DB.prepare(
      "select sql from sqlite_master where name = 'content_refs'",
    ).first<{ sql: string }>()
    expect(table?.sql).toMatch(/primary key\s*\(\s*from_story\s*,\s*to_id\s*,\s*kind\s*\)/i)
  })

  it('takes a third kind of edge, because `kind` was never CHECK-constrained', async () => {
    // The whole of what "widen `content_refs`" cost, proven: an asset edge inserts
    // with an R2 key as its target and no DDL was needed to allow it. Had `kind`
    // carried a CHECK, this would be a table rebuild instead of a rename.
    await env.DB.prepare('insert into content_refs (from_story, to_id, kind) values (?, ?, ?)')
      .bind('sty_page', 'ast_abc123abc123-logo.svg', 'asset')
      .run()
    const row = await env.DB.prepare(
      "select from_story as f, to_id as t from content_refs where kind = 'asset'",
    ).first<{ f: string; t: string }>()
    expect(row).toEqual({ f: 'sty_page', t: 'ast_abc123abc123-logo.svg' })
    await env.DB.prepare('delete from content_refs').run()
  })
})
