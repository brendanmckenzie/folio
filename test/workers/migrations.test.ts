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

/**
 * `schedules` (`0003_schedules.sql`) — scheduled publish and unpublish.
 *
 * Three things here are decisions rather than mechanics, and all three are pinned:
 * the two partial indexes, the *absence* of a third, and the absence of a CHECK on
 * `action` and `status`.
 */
describe('schedules', () => {
  const insert = (id: string, storyId: string, action: string, at: number, status = 'pending') =>
    env.DB.prepare(
      `insert into schedules (id, story_id, action, at, status, created_at) values (?, ?, ?, ?, ?, 1)`,
    )
      .bind(id, storyId, action, at, status)
      .run()

  beforeEach(async () => {
    await env.DB.prepare('delete from schedules').run()
  })

  it('has every column, in order, with the defaults a fresh row relies on', async () => {
    expect((await columnsOf('schedules')).map((c) => c.name)).toEqual([
      'id',
      'story_id',
      'action',
      'at',
      'status',
      'actor',
      'created_at',
      'attempts',
      'last_error',
    ])
    const byName = new Map((await columnsOf('schedules')).map((c) => [c.name, c]))
    expect(byName.get('id')?.pk).toBe(1)
    expect(byName.get('status')?.dflt_value).toBe("'pending'")
    expect(byName.get('attempts')?.dflt_value).toBe('0')
    expect(byName.get('actor')?.notnull).toBe(0)
    expect(byName.get('last_error')?.notnull).toBe(0)

    // Proven rather than read off the schema: an insert naming none of the three.
    await insert('sch_defaults', 'sty_home', 'publish', 5000)
    const row = await env.DB.prepare(
      'select status, attempts, last_error, actor from schedules where id = ?',
    )
      .bind('sch_defaults')
      .first<{ status: string; attempts: number; last_error: null; actor: null }>()
    expect(row).toEqual({ status: 'pending', attempts: 0, last_error: null, actor: null })
  })

  it('has exactly two indexes, both partial on status', async () => {
    // The third one somebody will reach for is `(story_id)`, and it is deliberately
    // absent — see the last test in this block.
    expect(await indexesOf('schedules')).toEqual(['schedules_due', 'schedules_story_action'])
    for (const name of ['schedules_due', 'schedules_story_action']) {
      expect([name, await indexSql(name)]).toEqual([
        name,
        expect.stringMatching(/where status = 'pending'/i),
      ])
    }
    // `(at, id)` is the sweep's order and the list route's keyset, in that order.
    expect(await indexSql('schedules_due')).toMatch(/\(\s*at\s*,\s*id\s*\)/i)
  })

  it('is what makes a site with nothing scheduled pay nothing', async () => {
    // The partial condition is the whole of that claim: with no pending row, the
    // index the sweep probes is an empty B-tree. Asserted as a query plan rather
    // than as prose, because "the sweep uses `schedules_due`" is the property, and
    // an index added later without the `where` would silently stop it being true.
    const { results } = await env.DB.prepare(
      `explain query plan
       select id from schedules where status = 'pending' and at <= 1 order by at, id limit 2`,
    ).all<{ detail: string }>()
    expect(results.map((r) => r.detail).join(' ')).toContain('schedules_due')
  })

  it('allows one pending schedule per document per action, and a window of two', async () => {
    await insert('sch_a', 'sty_home', 'publish', 1000)
    // The other half of a campaign window: same document, different action.
    await insert('sch_b', 'sty_home', 'unpublish', 2000)
    // A second pending publish for the same document is what the unique index is
    // for: a queue of contradictory instructions has no answer to "when does this
    // go live".
    await expect(insert('sch_c', 'sty_home', 'publish', 3000)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    )
  })

  it('lets a retained failure sit beside a fresh pending schedule', async () => {
    // The reason both indexes are partial. A failed row is kept so somebody can see
    // it (`ScheduleStatus`), and it must not block rescheduling the same thing.
    await insert('sch_old', 'sty_home', 'publish', 1000, 'failed')
    await insert('sch_new', 'sty_home', 'publish', 9000)
    const row = await env.DB.prepare('select count(*) as n from schedules').first<{ n: number }>()
    expect(row?.n).toBe(2)
  })

  it('constrains neither `action` nor `status`, so widening either costs no DDL', async () => {
    // The lesson `versions.kind` taught and `content_refs.kind` acted on: SQLite
    // cannot widen a CHECK without rebuilding the table, and an unpublish is not
    // representable in `versions` to this day because of it. A third action — a
    // scheduled checkpoint — is one enum value here and no migration.
    await insert('sch_future', 'sty_home', 'checkpoint', 1)
    await insert('sch_state', 'sty_about', 'publish', 1, 'whatever')
    const rows = await env.DB.prepare('select action, status from schedules order by id').all<{
      action: string
      status: string
    }>()
    expect(rows.results).toEqual([
      { action: 'checkpoint', status: 'pending' },
      { action: 'publish', status: 'whatever' },
    ])
  })

  it('does NOT have `schedules_story`, for a query that is a scan over a tiny table', async () => {
    // `?story=` without a status cannot use the partial unique index, so it scans —
    // over a table bounded by "pending plus broken". `stories_draft_updated` was an
    // index created for a query nobody had written and it cost every story write for
    // ten migrations; `assets` records the same refusal for its two new sorts.
    //
    // Asserted as an absence so adding one is a deliberate act with a measurement
    // behind it, which means this assertion failing is the conversation.
    expect(await indexesOf('schedules')).not.toContain('schedules_story')
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

/**
 * `shares` (`0004_shares.sql`) — draft preview links.
 *
 * Four things here are decisions rather than mechanics: the **absence** of any role
 * or scope column (which is what stops a share becoming an `Actor`), `expires_at`
 * being `not null` where `api_tokens.expires_at` is nullable, the named unique index
 * on `token_hash` rather than a column constraint, and the absence of
 * `shares_story`. All four are pinned.
 */
describe('shares', () => {
  const insert = (
    id: string,
    hash: string,
    storyId: string,
    expiresAt: number,
    revokedAt: number | null = null,
  ) =>
    env.DB.prepare(
      `insert into shares (id, token_hash, story_id, created_at, expires_at, revoked_at)
       values (?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, hash, storyId, expiresAt, revokedAt)
      .run()

  beforeEach(async () => {
    await env.DB.prepare('delete from shares').run()
  })

  it('has every column, in order, with the defaults a fresh row relies on', async () => {
    expect((await columnsOf('shares')).map((c) => c.name)).toEqual([
      'id',
      'token_hash',
      'story_id',
      'created_by',
      'created_at',
      'expires_at',
      'revoked_at',
      'last_viewed_at',
      'views',
      'note',
    ])
    const byName = new Map((await columnsOf('shares')).map((c) => [c.name, c]))
    expect(byName.get('id')?.pk).toBe(1)
    expect(byName.get('views')?.dflt_value).toBe('0')
    expect(byName.get('revoked_at')?.notnull).toBe(0)
    expect(byName.get('last_viewed_at')?.notnull).toBe(0)
    expect(byName.get('note')?.notnull).toBe(0)

    await insert('shr_defaults', 'hash_defaults', 'sty_home', 9_000_000)
    const row = await env.DB.prepare(
      'select views, revoked_at, last_viewed_at, note, created_by from shares where id = ?',
    )
      .bind('shr_defaults')
      .first<Record<string, unknown>>()
    expect(row).toEqual({
      views: 0,
      revoked_at: null,
      last_viewed_at: null,
      note: null,
      created_by: null,
    })
  })

  it('carries no role and no scope column, which is what keeps a share out of the actor model', async () => {
    // The load-bearing absence of the whole feature. `users` has `role`,
    // `api_tokens` has `scopes`, and both resolve into the `Actor` every route gate
    // reads. A column here of either shape is the change that would quietly turn a
    // review link into a credential, so it is asserted rather than remembered.
    const names = (await columnsOf('shares')).map((c) => c.name)
    expect(names).not.toContain('role')
    expect(names).not.toContain('scopes')
    expect(names).not.toContain('user_id')
  })

  it('requires an expiry, unlike `api_tokens`', async () => {
    // A token with no expiry is a legitimate shape (a CI job that outlives every
    // person who set it up). A preview link with no expiry is a permanent public URL
    // for unpublished content, which is the one thing this feature must not become —
    // so the column insists, and the ceiling is MAX_SHARE_DAYS in auth/shares.ts.
    expect((await columnsOf('shares')).find((c) => c.name === 'expires_at')?.notnull).toBe(1)
    expect((await columnsOf('api_tokens')).find((c) => c.name === 'expires_at')?.notnull).toBe(0)
    await expect(
      env.DB.prepare(
        'insert into shares (id, token_hash, story_id, created_at) values (?, ?, ?, 1)',
      )
        .bind('shr_forever', 'hash_forever', 'sty_home')
        .run(),
    ).rejects.toThrow(/NOT NULL constraint failed/i)
  })

  it('has exactly two indexes, and the token lookup is a *named* unique one', async () => {
    // Named rather than left to a `unique` column constraint, which SQLite would call
    // `sqlite_autoindex_shares_1` — filtered out by `indexesOf`, so the uniqueness of
    // the feature's whole lookup path would be the one property no test could see.
    expect(await indexesOf('shares')).toEqual(['shares_created', 'shares_token'])
    expect(await indexSql('shares_token')).toMatch(/unique/i)
    expect(await indexSql('shares_token')).toMatch(/\(\s*token_hash\s*\)/i)
    expect(await indexSql('shares_created')).toMatch(/\(\s*created_at\s+desc\s*\)/i)
  })

  it('refuses two rows sharing a token hash, so one secret is one grant', async () => {
    await insert('shr_a', 'hash_same', 'sty_home', 9_000_000)
    await expect(insert('shr_b', 'hash_same', 'sty_about', 9_000_000)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    )
  })

  it('lets one document carry several links at once', async () => {
    // Three reviewers, three individually revocable links. There is deliberately no
    // unique index on `story_id` — contrast `schedules_story_action`, where a queue of
    // contradictory instructions has no answer to "when does this go live".
    await insert('shr_1', 'hash_1', 'sty_home', 9_000_000)
    await insert('shr_2', 'hash_2', 'sty_home', 9_000_000)
    await insert('shr_3', 'hash_3', 'sty_home', 9_000_000, 5)
    const row = await env.DB.prepare('select count(*) as n from shares').first<{ n: number }>()
    expect(row?.n).toBe(3)
  })

  it('computes live/lapsed from two columns and the clock, with no status column', async () => {
    // `revoked_at is null and expires_at > now` is the whole state machine, which is
    // why there is no enum to widen here and therefore no CHECK to rebuild the table
    // over — the lesson `versions.kind` taught, answered by not having the column.
    await insert('shr_live', 'hash_live', 'sty_home', 9_000_000)
    await insert('shr_expired', 'hash_expired', 'sty_home', 100)
    await insert('shr_revoked', 'hash_revoked', 'sty_about', 9_000_000, 50)
    const { results } = await env.DB.prepare(
      'select id from shares where revoked_at is null and expires_at > ? order by id',
    )
      .bind(1000)
      .all<{ id: string }>()
    expect(results.map((r) => r.id)).toEqual(['shr_live'])
  })

  it('does NOT have `shares_story`, for a query that is a scan over a tiny table', async () => {
    // `?story=` scans, over a table bounded by links somebody typed by hand — the
    // identical measurement `schedules_story` refused on and `assets.filename`/`size`
    // before it. `stories_draft_updated` is the standing example of the other choice.
    //
    // Asserted as an absence so adding one is a deliberate act with a measurement
    // behind it, which means this assertion failing is the conversation.
    expect(await indexesOf('shares')).not.toContain('shares_story')
  })

  // That 0004 leaves `stories` alone needs no test of its own: every assertion in
  // this file runs against the schema the whole directory produced, so `stories`'
  // own "has exactly these seven indexes" above is already the check.
})
