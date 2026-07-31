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
