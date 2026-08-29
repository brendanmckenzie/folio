import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { draftState, type StoryState } from '../../src/core/story'
import { STATE_EXPR } from '../../src/server/stories'

/**
 * `STATE_EXPR` and `draftState` are the same rule written twice — once in SQL so a
 * paged list can filter by state server-side, once in TypeScript so a row already
 * in hand can be labelled without a query
 * (`docs/specs/foundation/pagination.md` decision 4).
 *
 * Two implementations of one rule is the actual risk that decision creates, so
 * this file is the answer to it: every combination of the four inputs, run through
 * both, asserted equal. Not a sample — the whole cross product, because it is
 * small enough to enumerate and a sample would leave exactly the corner somebody
 * later gets wrong.
 */

interface Row {
  publishedAt: number | null
  unpublishedAt: number | null
  draftSyncId: number
  publishedSyncId: number
}

const CASES: { name: string; row: Row }[] = []
for (const publishedAt of [null, 5000]) {
  for (const unpublishedAt of [null, 3000]) {
    for (const [draftSyncId, publishedSyncId] of [
      [0, 0],
      [7, 7],
      [8, 7],
      [7, 8],
    ] as const) {
      CASES.push({
        name: `published=${publishedAt} unpublished=${unpublishedAt} draft=${draftSyncId} pub=${publishedSyncId}`,
        row: { publishedAt, unpublishedAt, draftSyncId, publishedSyncId },
      })
    }
  }
}

const insert = (id: string, row: Row) =>
  env.DB.prepare(
    `insert into stories
       (id, type, parent_id, slug, path, ord, title,
        published_at, unpublished_at, draft_sync_id, published_sync_id)
     values (?, 'page', null, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(id, id, id, id, row.publishedAt, row.unpublishedAt, row.draftSyncId, row.publishedSyncId)
    .run()

const stateFromSql = async (id: string): Promise<string | undefined> => {
  const got = await env.DB.prepare(`select ${STATE_EXPR} as state from stories where id = ?`)
    .bind(id)
    .first<{ state: string }>()
  return got?.state
}

beforeEach(async () => {
  await env.DB.prepare('delete from stories').run()
})

describe('STATE_EXPR agrees with draftState', () => {
  it.each(CASES)('$name', async ({ row }) => {
    await insert('sty_case', row)
    const sql = await stateFromSql('sty_case')
    const ts = draftState(row.publishedAt, row.unpublishedAt, row.draftSyncId, row.publishedSyncId)
    expect(sql).toBe(ts)
  })

  it('covers all four states across the cross product, so agreement means something', async () => {
    const produced = new Set<StoryState>()
    for (const { row } of CASES) {
      produced.add(
        draftState(row.publishedAt, row.unpublishedAt, row.draftSyncId, row.publishedSyncId),
      )
    }
    // Agreement on a set of cases that only ever produced 'draft' would prove
    // nothing at all.
    expect([...produced].sort()).toEqual(['changed', 'draft', 'live', 'unpublished'])
  })
})

describe('STATE_EXPR as a filter', () => {
  beforeEach(async () => {
    await insert('live_clean', {
      publishedAt: 5000,
      unpublishedAt: null,
      draftSyncId: 7,
      publishedSyncId: 7,
    })
    await insert('live_edited', {
      publishedAt: 5000,
      unpublishedAt: null,
      draftSyncId: 9,
      publishedSyncId: 7,
    })
    await insert('never', {
      publishedAt: null,
      unpublishedAt: null,
      draftSyncId: 0,
      publishedSyncId: 0,
    })
    await insert('taken_down', {
      publishedAt: null,
      unpublishedAt: 3000,
      draftSyncId: 4,
      publishedSyncId: 4,
    })
  })

  const idsWhere = async (state: string): Promise<string[]> => {
    const { results } = await env.DB.prepare(
      `select id from stories where ${STATE_EXPR} = ? order by id`,
    )
      .bind(state)
      .all<{ id: string }>()
    return results.map((r) => r.id)
  }

  it('narrows to one state each, which is what a filter chip sends', async () => {
    expect(await idsWhere('live')).toEqual(['live_clean'])
    expect(await idsWhere('changed')).toEqual(['live_edited'])
    expect(await idsWhere('draft')).toEqual(['never'])
    expect(await idsWhere('unpublished')).toEqual(['taken_down'])
  })

  it('partitions the table: every row lands in exactly one state', async () => {
    const counted = (
      await Promise.all(['live', 'changed', 'draft', 'unpublished'].map((s) => idsWhere(s)))
    ).flat()
    expect(counted).toHaveLength(4)
    expect(new Set(counted).size).toBe(4)
  })

  it('reads `changed` for a live row whose watermark moved, per unpublished-changes.md', async () => {
    // Coarser than a diff on purpose: an edit that cancels itself out still
    // advances the watermark, so this can read `changed` with nothing left to
    // publish. The open document's own diff overrides it in the editor.
    expect(await stateFromSql('live_edited')).toBe('changed')
  })

  it('prefers `live` over `unpublished` when a row carries both stamps', async () => {
    // A republish sets `published_at` and leaves `unpublished_at` behind. The
    // liveness switch wins, and `storyState` orders its branches the same way.
    await insert('republished', {
      publishedAt: 9000,
      unpublishedAt: 3000,
      draftSyncId: 4,
      publishedSyncId: 4,
    })
    expect(await stateFromSql('republished')).toBe('live')
  })
})
