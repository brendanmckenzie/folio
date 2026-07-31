import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Page } from '../../src/core/pagination'
import { listTokens } from '../../src/server/auth/tokens'
import { listUsers } from '../../src/server/auth/users'

/**
 * Route-level paging: the boundary, the walk, and the two refusals.
 *
 * One file for every paged route rather than one per resource, because what is
 * being asserted is the same four properties each time and the value is in seeing
 * them stated identically. `foundation/pagination.md` phase 4 adds routes here as
 * it converts them.
 *
 * The property that matters, and the one offset paging cannot give: **walking a
 * cursor to exhaustion sees every row exactly once**, even while rows are being
 * inserted above the cursor.
 */

const ORIGIN = 'https://paging.test'
const API = `${ORIGIN}/folio/api`

const json = async <T>(path: string): Promise<T> => {
  const res = await SELF.fetch(`${API}${path}`)
  expect([path, res.status]).toEqual([path, 200])
  return res.json<T>()
}

/** Walks a cursor to exhaustion, returning every row in the order seen. */
async function walk<T>(path: string, limit: number): Promise<T[]> {
  const seen: T[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const sep = path.includes('?') ? '&' : '?'
    const q: string = cursor
      ? `${path}${sep}limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${path}${sep}limit=${limit}`
    const page = await json<Page<T>>(q)
    expect(page.rows.length).toBeLessThanOrEqual(limit)
    seen.push(...page.rows)
    cursor = page.cursor
    if (!cursor) return seen
  }
  throw new Error(`cursor never exhausted for ${path}`)
}

const upload = (filename: string, byte: number) =>
  SELF.fetch(`${API}/assets?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    // A minimal PNG signature so the type sniffer is satisfied.
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, byte]),
  })

describe('GET /api/assets', () => {
  beforeAll(async () => {
    for (let i = 0; i < 7; i++) {
      const res = await upload(`paged-${i}.png`, i)
      expect(res.status).toBe(201)
    }
  })

  it('walks to exhaustion, every row exactly once', async () => {
    const rows = await walk<{ id: string; filename: string }>('/assets', 2)
    const ours = rows.filter((r) => r.filename.startsWith('paged-'))
    expect(ours).toHaveLength(7)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  it('has a null cursor on the last page', async () => {
    const page = await json<Page<unknown>>('/assets?limit=200')
    expect(page.cursor).toBeNull()
  })

  it('omits `total` unless asked, and counts the filter when asked', async () => {
    const quiet = await json<Page<unknown>>('/assets?limit=2')
    expect(quiet.total).toBeUndefined()

    const counted = await json<Page<unknown>>('/assets?limit=2&count=1')
    // The whole filter, not the page — which is what a list header means by
    // "showing 2 of 7" and what a bulk guard would compare against.
    expect(counted.rows).toHaveLength(2)
    expect(counted.total).toBeGreaterThanOrEqual(7)
  })

  it('searches the filename, which is what made asset 201 reachable at all', async () => {
    const found = await json<Page<{ filename: string }>>('/assets?q=paged-3')
    expect(found.rows.map((r) => r.filename)).toEqual(['paged-3.png'])
  })

  it('filters by kind on a content-type prefix', async () => {
    const images = await json<Page<{ filename: string }>>('/assets?kind=image&limit=200')
    expect(images.rows.length).toBeGreaterThanOrEqual(7)
    expect(await json<Page<unknown>>('/assets?kind=video')).toMatchObject({ rows: [] })
  })

  it('counts the filter, not the table', async () => {
    const counted = await json<Page<unknown>>('/assets?q=paged-&count=1&limit=2')
    expect(counted.total).toBe(7)
  })

  it('clamps a silly limit and refuses a malformed cursor', async () => {
    // Asymmetric on purpose: a stale bookmark's `limit=5000` has an obvious right
    // answer, and "resume after ???" has none.
    const clamped = await json<Page<unknown>>('/assets?limit=5000')
    expect(clamped.rows.length).toBeLessThanOrEqual(200)

    const bad = await SELF.fetch(`${API}/assets?cursor=nonsense`)
    expect(bad.status).toBe(400)
    expect((await bad.json<{ error: { code: string } }>()).error.code).toBe('bad_request')
  })

  it('does not repeat a row when one is inserted above the cursor mid-walk', async () => {
    // The reason keyset rather than offset. With `offset`, inserting a newer row
    // between two requests shifts everything down and page two repeats page one's
    // last row.
    const first = await json<Page<{ id: string }>>('/assets?limit=3')
    expect(first.cursor).not.toBeNull()
    await upload('paged-intruder.png', 99)

    const second = await json<Page<{ id: string }>>(
      `/assets?limit=3&cursor=${encodeURIComponent(first.cursor ?? '')}`,
    )
    const overlap = second.rows.filter((r) => first.rows.some((f) => f.id === r.id))
    expect(overlap).toEqual([])
  })
})

/**
 * One story row, inserted directly.
 *
 * Direct inserts rather than `applySeedFixture` or `POST /stories`, and both
 * alternatives were tried. The seed file also writes users and an API token, which
 * silently changed what the roster tests at the bottom of this file saw — the kind
 * of coupling that reads as a paging bug. And `POST` picks `ord` itself, so the
 * boundary cases below (a tie on `ord`, a null draft watermark) would be
 * unreachable.
 */
const insert = (
  id: string,
  parentId: string | null,
  ord: string,
  path: string | null,
  extra: { type?: string; title?: string; publishedAt?: number; draftSyncId?: number } = {},
) =>
  env.DB.prepare(
    `insert into stories
         (id, type, parent_id, slug, path, ord, title, updated_at,
          published_at, draft_sync_id, published_sync_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      id,
      extra.type ?? 'page',
      parentId,
      id,
      path,
      ord,
      extra.title ?? id,
      1000,
      extra.publishedAt ?? null,
      extra.draftSyncId ?? 0,
    )
    .run()

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

/**
 * The tree, which is the one route with a **structural** answer rather than a
 * mechanical one (`foundation/pagination.md` decision 2): it pages one parent's
 * children over `(ord, id)`, which is exactly `compareSiblings`' order and exactly
 * what `stories_parent_ord` already indexed.
 *
 * Rows are inserted directly rather than through `POST /stories`, so `ord` is
 * chosen by the test and the boundary can be aimed at — including the tie two
 * clients inserting between the same neighbours produce, which is the case a
 * one-column cursor gets wrong and no amount of realistic seeding would reach.
 */
describe('GET /api/stories, per level', () => {
  beforeAll(async () => {
    await env.DB.prepare('delete from stories').run()
    await insert('sty_root', null, 'a0', '')
    // Six top-level pages, two of them sharing an `ord` — the tie.
    await insert('sty_t1', null, 'a1', 't1')
    await insert('sty_t2', null, 'a2', 't2')
    await insert('sty_t3', null, 'a2', 't3')
    await insert('sty_t4', null, 'a3', 't4', { type: 'insight' })
    await insert('sty_t5', null, 'a4', 't5', { publishedAt: 5000 })
    // Live *and* edited since the publish, which is `changed`.
    await insert('sty_t6', null, 'a5', 't6', { publishedAt: 5000, draftSyncId: 9 })
    // Children of t1, plus a record that must never appear in the tree.
    await insert('sty_c1', 'sty_t1', 'a0', 't1/c1')
    await insert('sty_c2', 'sty_t1', 'a1', 't1/c2')
    await insert('per_ada', null, 'a0', null, { type: 'person', title: 'Ada' })
  })

  it('answers the top level with no `parentId`, and leaves records out of it', async () => {
    const page = await json<Page<{ id: string }>>('/stories?limit=100&count=1')
    // `per_ada` carries `parent_id = null` like every unrouted row, so without
    // `path is not null` the top level of the page tree would list every record on
    // the site.
    expect(ids(page.rows)).not.toContain('per_ada')
    expect(page.total).toBe(7)
    expect(page.cursor).toBeNull()
  })

  it('answers one parent’s children, and only that parent’s', async () => {
    const page = await json<Page<{ id: string }>>('/stories?parentId=sty_t1')
    expect(ids(page.rows)).toEqual(['sty_c1', 'sty_c2'])
  })

  it('treats `parentId=` as the top level, so a client needs no conditional', async () => {
    const bare = await json<Page<{ id: string }>>('/stories?limit=100')
    const empty = await json<Page<{ id: string }>>('/stories?parentId=&limit=100')
    expect(ids(empty.rows)).toEqual(ids(bare.rows))
  })

  it('walks a level to exhaustion, every row exactly once', async () => {
    const rows = await walk<{ id: string }>('/stories', 2)
    expect(ids(rows)).toEqual([
      'sty_root',
      'sty_t1',
      'sty_t2',
      'sty_t3',
      'sty_t4',
      'sty_t5',
      'sty_t6',
    ])
  })

  it('breaks a tie on `ord` with the id, so the boundary is total', async () => {
    // `sty_t2` and `sty_t3` share `ord = 'a2'`. A cursor on the first of them must
    // resume *after* it and not skip the second — which a cursor of `ord` alone
    // cannot express, and which is why the second component is `id`.
    const page = await json<Page<{ id: string }>>('/stories?limit=3')
    expect(ids(page.rows)).toEqual(['sty_root', 'sty_t1', 'sty_t2'])
    const next = await json<Page<{ id: string }>>(
      `/stories?limit=3&cursor=${encodeURIComponent(page.cursor ?? '')}`,
    )
    expect(ids(next.rows)).toEqual(['sty_t3', 'sty_t4', 'sty_t5'])
  })

  it('reports a child count, which is what tells the tree where a twisty goes', async () => {
    const page = await json<Page<{ id: string; childCount: number }>>('/stories?limit=100')
    const counts = Object.fromEntries(page.rows.map((r) => [r.id, r.childCount]))
    expect(counts.sty_t1).toBe(2)
    expect(counts.sty_t2).toBe(0)
  })

  it('answers a level whose parent has no children with an empty page, not a 404', async () => {
    // The list exists, it is empty, and the screen draws an `EmptyState`.
    const page = await json<Page<unknown>>('/stories?parentId=sty_c1')
    expect(page).toMatchObject({ rows: [], cursor: null })
  })

  it('filters by state server-side, agreeing with `draftState`', async () => {
    const live = await json<Page<{ id: string }>>('/stories?state=live&limit=100')
    expect(ids(live.rows)).toEqual(['sty_t5'])
    const changed = await json<Page<{ id: string }>>('/stories?state=changed&limit=100&count=1')
    expect(ids(changed.rows)).toEqual(['sty_t6'])
    expect(changed.total).toBe(1)
  })

  it('filters by type and by substring', async () => {
    expect(ids((await json<Page<{ id: string }>>('/stories?type=insight')).rows)).toEqual([
      'sty_t4',
    ])
    // Title, slug and path, which are the three things a person types.
    expect(ids((await json<Page<{ id: string }>>('/stories?q=t1/c')).rows)).toEqual([])
    const flat = await json<Page<{ id: string }>>('/stories?flat=1&q=t1/c&limit=100')
    expect(ids(flat.rows).sort()).toEqual(['sty_c1', 'sty_c2'])
  })

  it('omits `total` unless asked, and refuses a malformed cursor', async () => {
    expect((await json<Page<unknown>>('/stories')).total).toBeUndefined()
    const bad = await SELF.fetch(`${API}/stories?cursor=nonsense`)
    expect(bad.status).toBe(400)
    expect((await bad.json<{ error: { code: string } }>()).error.code).toBe('bad_request')
  })

  it('refuses a state or sort it does not know, rather than quietly ignoring it', async () => {
    // A stale bookmark's `state=archived` must not answer a page that silently
    // means something else.
    expect((await SELF.fetch(`${API}/stories?state=archived`)).status).toBe(400)
    expect((await SELF.fetch(`${API}/stories?flat=1&sort=colour`)).status).toBe(400)
  })
})

/**
 * Flat mode's three sorts (decision 2a), and the null case that is the whole reason
 * `sort=edited` is a `coalesce`.
 */
describe('GET /api/stories?flat=1', () => {
  beforeAll(async () => {
    await env.DB.prepare('delete from stories').run()
    const insert = (
      id: string,
      path: string,
      title: string,
      updated: number,
      draft: number | null,
    ) =>
      env.DB.prepare(
        `insert into stories
           (id, type, parent_id, slug, path, ord, title, updated_at, draft_updated_at,
            draft_sync_id, published_sync_id)
         values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, 0, 0)`,
      )
        .bind(id, id, path, title, updated, draft)
        .run()

    // The case a plain `draft_updated_at desc` gets exactly backwards: `fresh` was
    // created a moment ago and never opened, so its draft watermark is null, while
    // `ancient` was last edited years back. SQLite sorts nulls last under `desc`,
    // which would sink the newest page to the bottom of a list called "last edited".
    await insert('sty_ancient', 'ancient', 'Ancient', 1_000_000, 1_000_000)
    await insert('sty_fresh', 'fresh', 'Beta', 9_000_000, null)
    await insert('sty_mid', 'mid', 'Alpha', 2_000_000, 5_000_000)
  })

  it('sorts by last edited, with a never-opened page in its true place', async () => {
    const page = await json<Page<{ id: string }>>('/stories?flat=1&limit=100')
    expect(ids(page.rows)).toEqual(['sty_fresh', 'sty_mid', 'sty_ancient'])
  })

  it('defaults to `edited`, because that is the question flat mode exists for', async () => {
    const explicit = await json<Page<{ id: string }>>('/stories?flat=1&sort=edited&limit=100')
    const implied = await json<Page<{ id: string }>>('/stories?flat=1&limit=100')
    expect(ids(implied.rows)).toEqual(ids(explicit.rows))
  })

  it('sorts by title and by path', async () => {
    expect(
      ids((await json<Page<{ id: string }>>('/stories?flat=1&sort=title&limit=100')).rows),
    ).toEqual(['sty_mid', 'sty_ancient', 'sty_fresh'])
    expect(
      ids((await json<Page<{ id: string }>>('/stories?flat=1&sort=path&limit=100')).rows),
    ).toEqual(['sty_ancient', 'sty_fresh', 'sty_mid'])
  })

  it('pages every sort to exhaustion, each row exactly once', async () => {
    for (const sort of ['edited', 'title', 'path']) {
      const rows = await walk<{ id: string }>(`/stories?flat=1&sort=${sort}`, 1)
      expect([sort, ids(rows).sort()]).toEqual([sort, ['sty_ancient', 'sty_fresh', 'sty_mid']])
    }
  })

  it('has no structure to disclose, so no child count', async () => {
    const page = await json<Page<Record<string, unknown>>>('/stories?flat=1&limit=1')
    expect(page.rows[0]).not.toHaveProperty('childCount')
  })
})

/**
 * The batch by identity (decision 7) — what replaced the admin's whole-tree fetch.
 * Uncursored on purpose: a batch by id is not a page, and its consumer looks rows
 * up by id rather than reading them in order.
 */
describe('GET /api/stories?ids= and ?paths=', () => {
  beforeAll(async () => {
    await env.DB.prepare('delete from stories').run()
    await insert('sty_home', null, 'a0', '', { title: 'Home' })
    await insert('sty_about', null, 'a1', 'about', { title: 'About' })
    await insert('sty_team', 'sty_about', 'a0', 'about/team', { title: 'Our team' })
  })

  const found = (body: { rows: { id: string }[] }) => body.rows.map((r) => r.id).sort()

  it('answers the ids it was given and nothing else', async () => {
    expect(found(await json<{ rows: { id: string }[] }>('/stories?ids=sty_team'))).toEqual([
      'sty_team',
    ])
  })

  it('adds the ancestor chain when asked, in one request', async () => {
    // The breadcrumb's whole requirement, and the reason `?ancestors=1` exists
    // rather than a second round trip: the caller cannot compute `ancestorPaths`
    // until it knows the row's own path.
    expect(
      found(await json<{ rows: { id: string }[] }>('/stories?ids=sty_team&ancestors=1')),
    ).toEqual(['sty_about', 'sty_home', 'sty_team'])
  })

  it('resolves by path, which is how a global finds its preview host', async () => {
    const body = await json<{ rows: { id: string; path: string }[] }>('/stories?paths=about')
    expect(body.rows.map((r) => r.path)).toEqual(['about'])
  })

  it('reads an empty *segment* as the root, and an empty parameter as absent', async () => {
    // Two different things that look alike, and both matter. `''` is the root
    // story's real stored path, so `?paths=,about` legitimately means the root and
    // `/about` — which is exactly what `ancestorPaths` returns for a top-level page.
    expect(found(await json<{ rows: { id: string }[] }>('/stories?paths=,about'))).toEqual([
      'sty_about',
      'sty_home',
    ])
    // A bare `?paths=` names nothing, so it is not a batch at all and the route
    // falls through to the level walk. That is what lets a client build the URL
    // without a conditional around an empty list.
    const bare = await json<Page<{ id: string }>>('/stories?paths=&limit=100')
    expect(bare).toHaveProperty('cursor')
    expect(ids(bare.rows)).toEqual(['sty_home', 'sty_about'])
  })

  it('is silent about an id nothing is behind, rather than 404ing the batch', async () => {
    // A dangling link already degrades safely — `resolveReference` returns null and
    // the block renders its empty state — so one missing target must not cost the
    // caller the rows it asked for alongside it.
    expect(found(await json<{ rows: { id: string }[] }>('/stories?ids=sty_home,sty_nope'))).toEqual(
      ['sty_home'],
    )
  })

  it('chunks past the bind limit instead of failing', async () => {
    // A document with three hundred internal links is legitimate; the chunk size is
    // D1's constraint, not the caller's.
    const many = [...Array(250)].map((_, i) => `sty_x${i}`).join(',')
    const body = await json<{ rows: unknown[] }>(`/stories?ids=sty_home,${many}`)
    expect(body.rows).toHaveLength(1)
  })

  it('refuses a batch larger than one request should ask for', async () => {
    const absurd = [...Array(600)].map((_, i) => `sty_y${i}`).join(',')
    const res = await SELF.fetch(`${API}/stories?ids=${absurd}`)
    expect(res.status).toBe(400)
  })

  it('screens each id, so a malformed one is a refusal rather than a short list', async () => {
    // Dropping it silently would leave the caller unable to tell a missing row from
    // a rejected id.
    expect((await SELF.fetch(`${API}/stories?ids=sty_home,../etc`)).status).toBe(400)
    expect((await SELF.fetch(`${API}/stories?paths=/about`)).status).toBe(400)
  })
})

/**
 * `users` and `tokens` are the two that were **whole-table reads with no cap at
 * all** — not truncated, unbounded. Both are administered lists that only grow
 * (a token is revoked, never deleted), so paging them is the difference between a
 * roster and a table scan.
 *
 * Under this worker's `auth: 'open'` the routes 404, so these exercise the
 * readers directly. `auth-http.test.ts` covers the routes under a session.
 */
describe('listUsers and listTokens', () => {
  it('pages users oldest first, which is roster order not feed order', async () => {
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        'insert into users (id, email, name, role, created_at) values (?, ?, ?, ?, ?)',
      )
        .bind(`usr_p${i}`, `p${i}@x.test`, `P${i}`, 'editor', 1000 + i)
        .run()
    }

    const first = await listUsers(env.DB, { limit: 2 })
    expect(first.rows.map((u) => u.id)).toEqual(['usr_p0', 'usr_p1'])
    expect(first.cursor).not.toBeNull()

    const seen: string[] = [...first.rows.map((u) => u.id)]
    let cursor = first.cursor
    while (cursor) {
      const next = await listUsers(env.DB, { limit: 2, cursor })
      seen.push(...next.rows.map((u) => u.id))
      cursor = next.cursor
    }
    expect(seen).toEqual(['usr_p0', 'usr_p1', 'usr_p2', 'usr_p3', 'usr_p4'])

    expect((await listUsers(env.DB, { limit: 2 })).total).toBeUndefined()
    expect((await listUsers(env.DB, { limit: 2, count: true })).total).toBe(5)
    await env.DB.prepare('delete from users').run()
  })

  it('pages tokens newest first, revoked ones included', async () => {
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare(
        'insert into api_tokens (id, name, scopes, created_at, revoked_at) values (?, ?, ?, ?, ?)',
      )
        .bind(`tok_p${i}`, `t${i}`, '["admin"]', 2000 + i, i === 0 ? 3000 : null)
        .run()
    }
    const first = await listTokens(env.DB, { limit: 3 })
    // Newest first, and the revoked one is still listed: revoking keeps the name
    // answerable, which is exactly why this list only ever grows.
    expect(first.rows.map((t) => t.id)).toEqual(['tok_p3', 'tok_p2', 'tok_p1'])
    const rest = await listTokens(env.DB, { limit: 3, cursor: first.cursor ?? '' })
    expect(rest.rows.map((t) => t.id)).toEqual(['tok_p0'])
    expect(rest.rows[0]?.revokedAt).toBe(3000)
    expect(rest.cursor).toBeNull()
    await env.DB.prepare('delete from api_tokens').run()
  })
})
