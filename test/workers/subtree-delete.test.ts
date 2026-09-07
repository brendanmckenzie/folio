import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { BIND_BUDGET, bindChunks, D1_BIND_CAP } from '../../src/server/db'
import { deleteDocument, type DocumentDeps } from '../../src/server/documents'
import { deleteStoryStatement } from '../../src/server/stories'
import { deleteVersionsStatement } from '../../src/server/versions'

/**
 * Deleting a document subtree **wider than D1's bound-parameter cap**.
 *
 * `deleteDocument` batches five statement groups and every one of them binds the
 * whole subtree at one parameter per id: the `delete from stories` itself,
 * `clearIndexStatements` (four statements — `content_index`, `content_refs`
 * outbound, the FTS5 `'delete'` and `content_text`), `clearInboundRefStatements`,
 * `clearSchedulesStatements` and `deleteVersionsStatement`. D1 refuses the 101st
 * parameter on a statement (`fts-smoke.test.ts` measures that, and that there is
 * no degradation and no truncation), so before all five chunked, deleting a
 * section of a real site failed outright — atomically, so nothing corrupted, but
 * the editor simply could not do it.
 *
 * **The point of this file is the *batch*, not any one group.** A test that ran
 * only the `delete from stories` statement would pass with four of the five
 * unchunked, which is exactly the half-fix `ROADMAP.md` refused to make. Verified
 * by breaking it, one group at a time: un-chunk any one of the five and the batch
 * is refused, which reds every test here that runs a delete — *and* reds the last
 * one, which counts the statements each group produced and is the assertion that
 * would still catch it if D1 ever raised the ceiling.
 *
 * Rows are seeded for **every** id rather than a sample, because a refused batch
 * is only one of the two ways this breaks. The other is a chunker that emits its
 * first chunk and drops the rest: nothing errors, the ids past `BIND_BUDGET`
 * simply stay. That is what the per-table counts below are for — with
 * `clearIndexStatements` truncated to one chunk, `content_index` comes back with
 * 42 rows where 1 is expected, and the delete otherwise reports success.
 *
 * Each count names the group it fails for, since two of the five clear the same
 * table from opposite ends.
 */

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }
const INSIGHT: DocumentType = {
  name: 'insight',
  label: 'Insight',
  kind: 'page',
  root: 'page',
  under: ['page'],
}

/**
 * How wide the subtree is: past the cap *and* past the budget, derived from both
 * rather than written as a number, so raising either carries this test instead of
 * leaving it asserting something that no longer overruns anything.
 *
 * `+ 30` puts the tail well inside a second chunk rather than one id into it, so
 * a count that comes back wrong is obviously wrong.
 */
const CHILDREN = Math.max(D1_BIND_CAP, BIND_BUDGET) + 30

/** Every id the delete of `sty_wide` cascades over — the parent and its children. */
const WIDE_IDS = ['sty_wide', ...Array.from({ length: CHILDREN }, (_, i) => `sty_w${i}`)]

/** A page outside the subtree, with a row of its own in each of the five tables. */
const KEEP = 'sty_keep'

/**
 * A multi-row insert, chunked.
 *
 * The fixture would overrun the same cap the delete does — seven binds a row over
 * a hundred and thirty rows — so it uses `bindChunks` itself. That is not
 * incidental: a fixture that could not be written without chunking is the
 * shortest available demonstration of why the delete cannot be either.
 */
async function insertAll(table: string, columns: string, rows: unknown[][]): Promise<void> {
  const perRow = rows[0]?.length
  if (perRow === undefined) return
  const holes = `(${Array.from({ length: perRow }, () => '?').join(', ')})`
  await env.DB.batch(
    bindChunks(rows, perRow).map((chunk) =>
      env.DB.prepare(
        `insert into ${table} (${columns}) values ${chunk.map(() => holes).join(', ')}`,
      ).bind(...chunk.flat()),
    ),
  )
}

/**
 * The tree, and one row per id in every table the delete clears.
 *
 * The three `content_refs` kinds are deliberately distinct, because two different
 * groups clear that one table and a single count could not tell which of them
 * failed:
 *
 *  - `link` is **outbound** from a subtree id — `clearIndexStatements`' job.
 *  - `reference` is **inbound** to a subtree id, from the surviving page —
 *    `clearInboundRefStatements`' job, and the half an unpublish deliberately
 *    keeps.
 *  - `asset` is the control: neither end is in the subtree, so it must survive.
 */
async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_fts(content_fts, rowid, title, body)
       select 'delete', id, title, body from content_text`,
    ),
    env.DB.prepare('delete from content_text'),
  ])
  await env.DB.batch([
    env.DB.prepare('delete from schedules'),
    env.DB.prepare('delete from versions'),
    env.DB.prepare('delete from redirects'),
    env.DB.prepare('delete from content_index'),
    env.DB.prepare('delete from content_refs'),
    env.DB.prepare('delete from stories'),
  ])

  const now = Date.now()

  await insertAll('stories', 'id, type, parent_id, slug, path, ord, title', [
    ['sty_root', 'page', null, '', '', 'a0', 'Home'],
    [KEEP, 'page', 'sty_root', 'keep', 'keep', 'a1', 'Keep'],
    ['sty_wide', 'page', 'sty_root', 'wide', 'wide', 'a2', 'Wide'],
    ...Array.from({ length: CHILDREN }, (_, i) => [
      `sty_w${i}`,
      // Every third child carries a different type, so `types` coming back in
      // `ids` order is an assertion about the id → row map rather than about a
      // constant.
      i % 3 === 0 ? 'insight' : 'page',
      'sty_wide',
      `w${i}`,
      `wide/w${i}`,
      `a${i}`,
      `Child ${i}`,
    ]),
  ])

  const indexed = [KEEP, ...WIDE_IDS]
  await insertAll(
    'content_index',
    'story_id, locale, field, text_value, num_value',
    indexed.map((id) => [id, '', 'headline', `headline of ${id}`, null]),
  )

  await insertAll('content_refs', 'from_story, to_id, kind', [
    // Outbound from the subtree, cleared by `clearIndexStatements`.
    ...WIDE_IDS.map((id) => [id, KEEP, 'link']),
    // Inbound to the subtree, cleared by `clearInboundRefStatements`.
    ...WIDE_IDS.map((id) => [KEEP, id, 'reference']),
    // Neither end in the subtree: the control.
    [KEEP, 'assets/keep.jpg', 'asset'],
  ])

  await insertAll(
    'content_text',
    'story_id, locale, title, body',
    indexed.map((id) => [
      id,
      '',
      id === KEEP ? 'Keep' : 'Wide',
      // One token per side, so the FTS index can be asked what it still holds
      // without joining back to `content_text` — which would answer an empty set
      // for orphaned tokens too.
      id === KEEP ? 'the keepword survives' : 'the wideword goes',
    ]),
  )
  await env.DB.prepare(
    `insert into content_fts(rowid, title, body) select id, title, body from content_text`,
  ).run()

  await insertAll(
    'schedules',
    'id, story_id, action, at, status, created_at',
    indexed.map((id, i) => [`sch_${i}`, id, 'publish', now + 60_000, 'pending', now]),
  )

  await insertAll(
    'versions',
    'id, story_id, kind, title, doc, created_at',
    indexed.map((id, i) => [`ver_${i}`, id, 'publish', id, '{}', now]),
  )
}

beforeEach(seed)

function pageDoc(title: string): Doc {
  return {
    root: 'r1',
    bloks: {
      r1: { uid: 'r1', type: 'page', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

/** `DocumentDeps` with the Durable Object stubbed, as `bulk.test.ts` does. */
function deps(): DocumentDeps & { purged: string[] } {
  const d = {
    db: env.DB,
    types: [PAGE, INSIGHT],
    purged: [] as string[],
    draft: async (story: { title: string }) => pageDoc(story.title),
    stub: (id: string) => ({
      purge: async () => {
        d.purged.push(id)
      },
    }),
  }
  return d as unknown as DocumentDeps & { purged: string[] }
}

const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0

/** What the FTS index still holds, asked on its own terms rather than by join. */
const stillIndexed = (query: string): Promise<number> =>
  count('select count(*) as n from content_fts where content_fts match ?', query)

describe('deleting a subtree wider than D1 binds', () => {
  it('is wider than the cap, or this file proves nothing', () => {
    expect(WIDE_IDS.length).toBeGreaterThan(D1_BIND_CAP)
    expect(WIDE_IDS.length).toBeGreaterThan(BIND_BUDGET)
  })

  it('deletes every row in all five groups, in one batch', async () => {
    const result = await deleteDocument(deps(), 'sty_wide', { redirect: false }, 'alice')

    expect(result?.deleted.length).toBe(WIDE_IDS.length)
    expect([...(result?.deleted ?? [])].sort()).toEqual([...WIDE_IDS].sort())

    // Group 1 — `delete from stories`. Only the root and the sibling are left.
    expect(await count('select count(*) as n from stories')).toBe(2)

    // Group 2 — `clearIndexStatements`, all four of its statements.
    expect(await count('select count(*) as n from content_index')).toBe(1)
    expect(await count("select count(*) as n from content_refs where kind = 'link'")).toBe(0)
    expect(await count('select count(*) as n from content_text')).toBe(1)
    expect(await stillIndexed('wideword')).toBe(0)
    // The de-index is the one that can half-succeed invisibly: `content_text` is
    // external content, so a row dropped without being de-indexed leaves tokens
    // matching prose that is gone. Ask FTS5 itself.
    await expect(
      env.DB.prepare("insert into content_fts(content_fts) values('integrity-check')").run(),
    ).resolves.toBeTruthy()

    // Group 3 — `clearInboundRefStatements`, and the control row it must not touch.
    expect(await count("select count(*) as n from content_refs where kind = 'reference'")).toBe(0)
    expect(await count("select count(*) as n from content_refs where kind = 'asset'")).toBe(1)

    // Group 4 — `clearSchedulesStatements`.
    expect(await count('select count(*) as n from schedules')).toBe(1)

    // Group 5 — `deleteVersionsStatement`.
    expect(await count('select count(*) as n from versions')).toBe(1)

    // The surviving page kept its own row in every one of them.
    expect(await count('select count(*) as n from content_index where story_id = ?', KEEP)).toBe(1)
    expect(await stillIndexed('keepword')).toBe(1)
    expect(await count('select count(*) as n from schedules where story_id = ?', KEEP)).toBe(1)
    expect(await count('select count(*) as n from versions where story_id = ?', KEEP)).toBe(1)
  })

  it('purges a Durable Object per id, not per chunk', async () => {
    const d = deps()
    await deleteDocument(d, 'sty_wide', { redirect: false }, null)
    expect([...d.purged].sort()).toEqual([...WIDE_IDS].sort())
  })

  it('writes a redirect per vacated path in the same batch', async () => {
    // `redirect: true` is what both routes default to, so this is the shape of a
    // real delete: three redirect statements per descendant on top of the five
    // chunked groups, all in one transaction.
    const result = await deleteDocument(deps(), 'sty_wide', { redirect: true }, 'alice')

    expect(result?.deleted.length).toBe(WIDE_IDS.length)
    expect(await count('select count(*) as n from redirects')).toBe(WIDE_IDS.length)
    // Every path in the subtree redirects to the *deleted node's* parent, which
    // is the nearest surviving ancestor — the root's `''` here, for the deepest
    // child exactly as for the parent, since the whole subtree goes together.
    expect(
      await count(
        'select count(*) as n from redirects where to_path = ? and from_path in (?, ?)',
        '',
        'wide',
        `wide/w${CHILDREN - 1}`,
      ),
    ).toBe(2)
  })

  it("reports every id's own path and type, which is what the `deleted` hook fires with", async () => {
    const found = await deleteStoryStatement(env.DB, 'sty_wide', {}, [PAGE, INSIGHT])

    // Same order, all three arrays — the one property the id → row map has to
    // keep. Every third child is an `insight`, so a map keyed wrongly reads as a
    // type in the wrong slot rather than as a crash.
    expect(found?.paths.length).toBe(WIDE_IDS.length)
    expect(found?.types.length).toBe(WIDE_IDS.length)
    for (const [at, id] of (found?.ids ?? []).entries()) {
      const row = await env.DB.prepare('select path, type from stories where id = ?')
        .bind(id)
        .first<{ path: string | null; type: string }>()
      expect(found?.paths[at]).toBe(row?.path ?? null)
      expect(found?.types[at]).toBe(row?.type)
    }
  })

  it('chunks each group rather than emitting one statement per id', async () => {
    const found = await deleteStoryStatement(env.DB, 'sty_wide', {}, [PAGE, INSIGHT])
    const chunks = Math.ceil(WIDE_IDS.length / BIND_BUDGET)

    // The fix is chunks, not a statement per id: single-id deletes would also
    // stay under the cap, and would cost one round trip per document inside the
    // transaction rather than one per ninety.
    expect(found?.storyStatements.length).toBe(chunks)
    // Four statements per chunk from `clearIndexStatements`, one from
    // `clearInboundRefStatements`.
    expect(found?.indexStatements.length).toBe(chunks * 5)
    expect(found?.scheduleStatements.length).toBe(chunks)
    // The fifth group is the caller's to fetch, which is the whole reason
    // `deleteDocument` exists as the one place that batches all five.
    expect(deleteVersionsStatement(env.DB, found?.ids ?? []).length).toBe(chunks)
    expect(chunks).toBeGreaterThan(1)
  })
})
