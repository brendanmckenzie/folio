import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { SINGLE_SITE_CHAIN } from '../../src/core/sites'
import {
  createFolder,
  folderByPath,
  listFolders,
  updateFolder,
} from '../../src/server/asset-folders'
import {
  ensureTag,
  listTags,
  renameTag,
  setAssetTags,
  tagBySlug,
} from '../../src/server/asset-tags'
import {
  assetsFor,
  assetsMatching,
  countAssets,
  listAssets,
  listAssetsByPage,
  updateAsset,
} from '../../src/server/assets'
import { countResponses, listResponses } from '../../src/server/form-responses'
import { createForm, formByName, formsByIds, listForms, updateForm } from '../../src/server/forms'
import {
  deleteRedirect,
  listRedirects,
  lookupRedirect,
  redirectStatements,
  upsertRedirect,
} from '../../src/server/redirects'
import { listSchedules } from '../../src/server/schedules'
import {
  countStories,
  listDocumentPage,
  listInherited,
  listRecentlyEdited,
  listStoriesFlat,
  listStoryLevel,
  pageAt,
  pathMiss,
  publishedDoc,
  publishedDocsByIds,
  searchStories,
  storiesFor,
  storiesMatching,
  storyByPath,
  storyStatus,
} from '../../src/server/stories'
import { contentSql } from '../../src/server/query'
import { listRecentPublishes } from '../../src/server/versions'

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
    ['sty_qp_e', 'alpha', null, 'e', 'e'],
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

/**
 * **Phase 7's readers bind the scope too.** The media library, forms, redirects and the
 * story lists each had a reader that left `site_id` out after `0011` put it first in
 * their indexes, and each of those is a full-table scan that returns the right rows.
 * Asked both ways — the single-site chain and a site in a group — for every list and
 * every scope-bound write, and none may `SCAN` (the schedules walk and the version
 * history read `schedules` and `versions` by their own indexes, named below).
 */
describe('the library, forms, redirects and list readers bind the scope', () => {
  beforeAll(async () => {
    const at = (n: number) => `qp${n}`
    await env.DB.batch([
      ...['default', 'alpha', 'shared'].flatMap((site, i) => [
        env.DB.prepare(
          `insert into assets (id, key, filename, content_type, size, alt, created_at, site_id)
           values (?, ?, ?, 'image/png', ?, '', ?, ?)`,
        ).bind(`ast_${at(i)}`, `ast_${at(i)}-x.png`, `x${i}.png`, 10 + i, 100 + i, site),
        env.DB.prepare(
          `insert into asset_folders (id, parent_id, name, path, created_at, site_id)
           values (?, null, ?, ?, 1, ?)`,
        ).bind(`fld_${at(i)}`, `f${i}`, `f${i}`, site),
        env.DB.prepare(
          `insert into asset_tags (id, name, slug, created_at, site_id) values (?, ?, ?, 1, ?)`,
        ).bind(`tag_${at(i)}`, `t${i}`, `t${i}`, site),
        env.DB.prepare(
          `insert into forms (id, name, label, fields, created_at, updated_at, site_id)
           values (?, ?, ?, '[]', 1, ?, ?)`,
        ).bind(`frm_${at(i)}`, `n${i}`, `n${i}`, 10 + i, site),
        env.DB.prepare(
          `insert into form_responses (id, form_id, version, created_at, data, body_hash, site_id)
           values (?, ?, 1, ?, '{}', ?, ?)`,
        ).bind(`res_${at(i)}`, `frm_${at(i)}`, 5 + i, `h${i}`, site),
      ]),
    ])
  })

  for (const [label, chain] of CHAINS) {
    describe(label, () => {
      const scope = chain[0]!
      const cases: [string, (db: D1Database) => Promise<unknown>][] = [
        ['listAssets, newest first', (db) => listAssets(db, { chain, count: true })],
        [
          'listAssets, by filename with a search',
          (db) => listAssets(db, { chain, sort: 'filename', q: 'x' }),
        ],
        ['listAssets, by size', (db) => listAssets(db, { chain, sort: 'size' })],
        [
          'listAssets, in a folder with tags',
          (db) => listAssets(db, { chain, folder: 'f0', tags: ['t0'] }),
        ],
        ['listAssetsByPage', (db) => listAssetsByPage(db, { page: 1, perPage: 10, chain })],
        ['countAssets', (db) => countAssets(db, {}, chain)],
        ['assetsFor', (db) => assetsFor(db, ['ast_qp0', 'ast_qp1'], chain)],
        [
          'assetsMatching',
          (db) => assetsMatching(db, { undescribed: true }, { limit: 10, scope: chain }),
        ],
        ['updateAsset', (db) => updateAsset(db, 'ast_qp0', { alt: 'x' }, scope)],
        ['listFolders', (db) => listFolders(db, { site: scope, count: true })],
        ['folderByPath', (db) => folderByPath(db, 'f0', scope)],
        [
          'createFolder (its collision check)',
          (db) => createFolder(db, { name: `p-${label}` }, scope),
        ],
        [
          'updateFolder (the subtree rewrite)',
          (db) => updateFolder(db, 'fld_qp0', { name: 'f0' }, scope),
        ],
        ['listTags', (db) => listTags(db, { site: scope })],
        ['listTags, counted', (db) => listTags(db, { site: scope, counts: true })],
        ['tagBySlug', (db) => tagBySlug(db, 't0', scope)],
        ['ensureTag', (db) => ensureTag(db, `e-${label}`, scope)],
        ['renameTag', (db) => renameTag(db, 'tag_qp0', 'renamed', scope)],
        ['setAssetTags', (db) => setAssetTags(db, 'ast_qp0', [], scope)],
        ['listForms', (db) => listForms(db, { chain, count: true, counts: true })],
        ['formByName', (db) => formByName(db, 'n0', scope)],
        ['formsByIds', (db) => formsByIds(db, ['frm_qp0', 'frm_qp1'], console, chain)],
        ['createForm (its name check)', (db) => createForm(db, { label: `Form ${label}` }, scope)],
        ['updateForm', (db) => updateForm(db, 'frm_qp0', { expectedUpdatedAt: 10 }, scope)],
        ['listRedirects', (db) => listRedirects(db, { scope, count: true })],
        ['deleteRedirect', (db) => deleteRedirect(db, 'qp-old', scope)],
        ['upsertRedirect', (db) => upsertRedirect(db, { from: `u-${label}`, to: 'qp' }, scope)],
        [
          'redirectStatements (delete, collapse, insert)',
          async (db) =>
            void redirectStatements(db, { site: scope, from: 'qp', to: 'qq', storyId: null }),
        ],
        ['listStoriesFlat', (db) => listStoriesFlat(db, 'edited', { scope, count: true })],
        ['listRecentlyEdited', (db) => listRecentlyEdited(db, { scope, count: true })],
        ['listDocumentPage', (db) => listDocumentPage(db, 'page', 'title', { scope, count: true })],
        ['countStories', (db) => countStories(db, { routed: true }, scope)],
        ['storiesMatching', (db) => storiesMatching(db, {}, { limit: 10, scope })],
        ['searchStories (the chain)', (db) => searchStories(db, { chain, count: true })],
        ['listResponses', (db) => listResponses(db, 'frm_qp0', { count: true })],
        [
          'listResponses, of some sites',
          (db) => listResponses(db, 'frm_qp0', { sites: chain, count: true }),
        ],
        ['countResponses', (db) => countResponses(db, 'frm_qp0', {}, chain)],
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

  it('the inherited list', async () => {
    const { db, seen } = recording(env.DB)
    await listInherited(db, ['alpha', 'north', 'shared'])
    expect(seen.length).toBeGreaterThan(0)
    for (const stmt of seen)
      expect({ sql: stmt.sql, scans: await scans(stmt) }).toEqual({ sql: stmt.sql, scans: [] })
  })

  it('a scope’s schedules and publishes reach stories by primary key, not by scan', async () => {
    const { db, seen } = recording(env.DB)
    await listSchedules(db, { scope: 'alpha', status: 'pending' })
    await listRecentPublishes(db, { scope: 'alpha' })
    expect(seen.length).toBeGreaterThan(0)
    for (const stmt of seen) {
      const { results } = await env.DB.prepare(`explain query plan ${stmt.sql}`)
        .bind(...stmt.binds)
        .all<{ detail: string }>()
      // `stories` (and `assets`, forms, …) are never scanned: the correlated `exists`
      // is a probe of the primary key. The version and schedule tables are read by their
      // own keys, which is theirs to prove elsewhere.
      expect(results.map((r) => r.detail).filter((d) => /^SCAN (stories|s)\b/.test(d))).toEqual([])
    }
  })
})
