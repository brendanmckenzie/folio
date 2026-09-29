import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { SINGLE_SITE_CHAIN } from '../../src/core/sites'
import { lookupRedirect } from '../../src/server/redirects'
import {
  listStoryLevel,
  pageAt,
  pathMiss,
  publishedDoc,
  publishedDocsByIds,
  storiesFor,
  storyByPath,
  storyStatus,
} from '../../src/server/stories'
import { contentSql } from '../../src/server/query'

/**
 * **No hot reader scans `stories` or `redirects`.**
 *
 * `0011_sites.sql` put `site_id` at the front of every index it re-keyed —
 * `stories_path (site_id, path)`, `stories_parent_ord (site_id, parent_id, ord)`,
 * `redirects`' primary key `(site_id, from_path)` — and D1 keeps no `sqlite_stat1`,
 * so there is no skip-scan: a lookup that does not bind `site_id` is no longer a
 * seek but a read of the whole table. The answers are the same rows either way,
 * so no other test can see the difference; only the plan can.
 *
 * So each reader's statements are recorded as it runs them, and each is put back
 * through `explain query plan` with the same binds. Every one of them binds the
 * chain — `['default']` on a single-site deployment, three scopes on a site in a
 * group — and none may plan a `SCAN` of either table under any alias.
 */

interface Recorded {
  sql: string
  binds: unknown[]
}

/** A binding that records every statement prepared on it (and on its sessions). */
function recording(real: D1Database): { db: D1Database; seen: Recorded[] } {
  const seen: Recorded[] = []
  const watchStatement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver)
        if (prop === 'bind') {
          return (...args: unknown[]) => {
            seen.push({ sql, binds: args })
            return (value as (...a: unknown[]) => D1PreparedStatement).apply(t, args)
          }
        }
        return typeof value === 'function' ? value.bind(t) : value
      },
    })
  const db = new Proxy(real, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver)
      if (prop === 'prepare') {
        return (sql: string) => watchStatement(real.prepare(sql), sql)
      }
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
  return { db, seen }
}

/** Every `SCAN` step of a statement's plan, as `explain query plan` details it. */
async function scans(stmt: Recorded): Promise<string[]> {
  const { results } = await env.DB.prepare(`explain query plan ${stmt.sql}`)
    .bind(...stmt.binds)
    .all<{ detail: string }>()
  return results.map((r) => r.detail).filter((detail) => /^SCAN /.test(detail))
}

const MULTI = ['alpha', 'north', 'shared']
const CHAINS: [string, readonly string[]][] = [
  ['single-site', SINGLE_SITE_CHAIN],
  ['a site in a group', MULTI],
]

beforeAll(async () => {
  // A few rows in every scope, so the planner has a table to decide about.
  const rows: [string, string, string | null, string, string | null][] = [
    ['sty_qp_a', 'default', null, 'qp', 'qp'],
    ['sty_qp_b', 'default', 'sty_qp_a', 'b', 'qp/b'],
    ['sty_qp_c', 'alpha', null, 'qp', 'qp'],
    ['sty_qp_d', 'shared', null, 'qp', 'qp'],
    ['sty_qp_r', 'default', null, 'r', null],
  ]
  await env.DB.batch(
    rows.map(([id, site, parent, slug, path]) =>
      env.DB.prepare(
        `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
         values (?, 'page', ?, ?, ?, 'a0', ?, 0, ?)`,
      ).bind(id, parent, slug, path, id, site),
    ),
  )
  await env.DB.prepare(
    `insert into redirects (from_path, to_path, status, source, created_at, site_id)
     values ('qp-old', 'qp', 301, 'auto', 0, 'default'), ('qp-old', 'qp', 301, 'auto', 0, 'alpha')`,
  ).run()
})

describe('the hot readers bind the chain, so none of them scans', () => {
  for (const [label, chain] of CHAINS) {
    describe(label, () => {
      const cases: [string, (db: D1Database) => Promise<unknown>][] = [
        ['storyByPath', (db) => storyByPath(db, chain, 'qp')],
        ['pageAt', (db) => pageAt(db, chain, 'qp')],
        ['pathMiss', (db) => pathMiss(db, chain, 'qp-old')],
        ['publishedDoc', (db) => publishedDoc(db, chain, 'qp')],
        ['storyStatus', (db) => storyStatus(db, chain, 'qp')],
        ['lookupRedirect (by from_path)', (db) => lookupRedirect(db, chain, 'qp-old')],
        [
          'storiesFor (ids and ancestor paths)',
          (db) => storiesFor(db, ['sty_qp_b'], ['', 'qp'], chain),
        ],
        ['publishedDocsByIds', (db) => publishedDocsByIds(db, ['sty_qp_a', 'sty_qp_c'], chain)],
      ]
      for (const [name, run] of cases) {
        it(name, async () => {
          const { db, seen } = recording(env.DB)
          await run(db)
          expect(seen.length).toBeGreaterThan(0)
          for (const stmt of seen)
            expect({ sql: stmt.sql, scans: await scans(stmt) }).toEqual({
              sql: stmt.sql,
              scans: [],
            })
        })
      }
    })
  }

  it('the children list (a level of the page tree, with its child counts)', async () => {
    const { db, seen } = recording(env.DB)
    await listStoryLevel(db, 'sty_qp_a', { count: true })
    await listStoryLevel(db, null)
    expect(seen.length).toBe(3)
    for (const stmt of seen)
      expect({ sql: stmt.sql, scans: await scans(stmt) }).toEqual({ sql: stmt.sql, scans: [] })
  })

  it('a collection over one type, on every chain', async () => {
    for (const [, chain] of CHAINS) {
      const { page, count } = contentSql(
        { type: ['page'], order: { field: 'title', dir: 'asc' } },
        new Set(),
        '',
        undefined,
        undefined,
        chain,
      )
      for (const stmt of [page, count]) {
        expect({
          sql: stmt.text,
          scans: await scans({ sql: stmt.text, binds: stmt.binds }),
        }).toEqual({
          sql: stmt.text,
          scans: [],
        })
      }
    }
  })
})
