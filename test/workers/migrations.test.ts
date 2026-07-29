import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * What `migrations/` actually produced, asserted against the live database the
 * pool built by applying the real directory (see apply-schema.ts).
 *
 * This file exists because of `0006_document_types.sql`, the one migration in
 * the series that *rebuilds* `stories` rather than altering it: `path` has to
 * become nullable and SQLite cannot drop a NOT NULL in place. A rebuild that
 * forgets a column is silent data loss, and a rebuild drops every index on the
 * old table, so both the column list and the index list are pinned here rather
 * than left to a reading of the SQL. Every future migration that touches
 * `stories` has to keep these passing.
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

async function columns(): Promise<ColumnInfo[]> {
  const { results } = await env.DB.prepare('select * from pragma_table_info(?)')
    .bind('stories')
    .all<ColumnInfo>()
  return results
}

async function indexNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `select name from sqlite_master
     where type = 'index' and tbl_name = 'stories' and name not like 'sqlite_%'
     order by name`,
  ).all<{ name: string }>()
  return results.map((r) => r.name)
}

async function indexSql(name: string): Promise<string> {
  const row = await env.DB.prepare('select sql from sqlite_master where name = ?')
    .bind(name)
    .first<{ sql: string }>()
  return row?.sql ?? ''
}

beforeEach(async () => {
  await env.DB.prepare('delete from stories').run()
})

describe('0006: the rebuilt `stories` table', () => {
  it('carries every column forward, in order', async () => {
    // 0001's ten, then 0003's pair, then 0005's trio, plus 0006's own `type`
    // sitting straight after `id`. A column missing here is data 0006 dropped.
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
      // 0003_unpublish.sql
      'unpublished_at',
      'unpublished_by',
      // 0005_draft_watermark.sql
      'draft_sync_id',
      'draft_updated_at',
      'published_sync_id',
    ])
  })

  it('keeps `path` nullable and every other constraint as it was', async () => {
    const byName = new Map((await columns()).map((c) => [c.name, c]))

    // The whole reason for the rebuild.
    expect(byName.get('path')?.notnull).toBe(0)
    // Unchanged from 0001: these three are still required.
    expect(byName.get('slug')?.notnull).toBe(1)
    expect(byName.get('ord')?.notnull).toBe(1)
    expect(byName.get('title')?.notnull).toBe(1)
    expect(byName.get('id')?.pk).toBe(1)
    // Still nullable, still no default: 0003's pair, untouched.
    expect(byName.get('unpublished_at')?.notnull).toBe(0)
    expect(byName.get('unpublished_by')?.notnull).toBe(0)
  })

  it('keeps 0005’s watermark defaults, so a pre-existing row reads "nothing changed"', async () => {
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
      // 0006's own default: a row written by anything that predates `types`
      // resolves against the type `root: 'page'` expands to.
      type: 'page',
      draft_sync_id: 0,
      published_sync_id: 0,
      draft_updated_at: null,
    })
  })

  it('recreated every index the rebuild dropped, and added its own two', async () => {
    expect(await indexNames()).toEqual([
      // 0005, recreated.
      'stories_draft_updated',
      // 0001, unchanged.
      'stories_parent_ord',
      // 0002, narrowed to routed rows.
      'stories_parent_slug',
      // 0001's implicit `path ... unique`, now named and partial.
      'stories_path',
      // 0006's own.
      'stories_type',
      'stories_type_slug',
    ])
  })

  it('makes the two page-namespace indexes partial on `path is not null`', async () => {
    expect(await indexSql('stories_path')).toMatch(/where path is not null/i)
    expect(await indexSql('stories_parent_slug')).toMatch(/where path is not null/i)
    // 0002's coalesce is still there: SQLite treats every NULL in a unique index
    // as distinct, so top-level siblings would never collide without it.
    expect(await indexSql('stories_parent_slug')).toMatch(/coalesce\(parent_id, ''\)/i)
  })
})

/**
 * The three slug namespaces the partial indexes create. Written with raw
 * statements on purpose: `createStory`'s `uniqueSlug` bumps a colliding slug
 * before it ever reaches D1, so the only way to observe what the *database*
 * refuses is to go around it — which is also exactly what an importer or a
 * hand-written fixup query does.
 */
describe('0006: the three slug namespaces', () => {
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

/**
 * `0007_identity.sql`. Additive — four new tables, `stories` untouched — so
 * unlike 0006 there is no rebuild to lose a column. What is pinned here is the
 * shape the middleware and the Durable Object's revocation check depend on: the
 * hashed primary keys, the role constraint, and the two indexes that keep a
 * per-request session lookup and the per-address link rate limit from being
 * table scans.
 */
describe('0007: identity', () => {
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

  it('creates `users` with a unique email and a constrained role', async () => {
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
    // `default 'editor'` is what an invited user gets without a role named.
    expect(role?.dflt_value).toBe("'editor'")
    expect(role?.notnull).toBe(1)

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

  it('leaves `stories` exactly as 0006 left it', async () => {
    // The regression 0007 could have been: a second rebuild. It is not one.
    expect((await columns()).map((c) => c.name)).toContain('published_sync_id')
    expect(await indexNames()).toEqual([
      'stories_draft_updated',
      'stories_parent_ord',
      'stories_parent_slug',
      'stories_path',
      'stories_type',
      'stories_type_slug',
    ])
  })
})
