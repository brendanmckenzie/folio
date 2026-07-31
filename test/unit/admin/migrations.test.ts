import { describe, expect, it } from 'vitest'
import { mergeReports } from '../../../src/admin/hooks/useMigrations'
import type { MigrateReport } from '../../../src/server/migrate'

/**
 * The merge that turns a batched migration run into one report
 * (`schema-migrations.md` phase 4).
 *
 * The banner's wording used to be tested here beside it, against `Migrations.tsx`'s
 * `behindNotice`. That function moved to `admin/ui/screens/editor-model.ts` when port
 * phase 8 deleted the old admin, and its tests went with it — see
 * `editor-shell.test.ts`.
 */

const report = (over: Partial<MigrateReport> = {}): MigrateReport => ({
  pending: ['0001-a'],
  stories: 2,
  changed: 1,
  unchanged: 1,
  mutations: 4,
  publishedMutations: 2,
  transactions: 1,
  oversized: [],
  failed: [],
  dryRun: false,
  continueFrom: 'sty_b',
  behind: 5,
  complete: false,
  ...over,
})

/**
 * The client half of the resolved open question: `POST /migrate` answers one
 * batch and a cursor, and the caller re-calls. The screen has to report the whole
 * run, not whichever batch happened to be last.
 */
describe('mergeReports', () => {
  it('adds up everything that counts', () => {
    const merged = mergeReports(report(), report({ stories: 3, changed: 2, mutations: 6 }))
    expect(merged).toMatchObject({
      stories: 5,
      changed: 3,
      unchanged: 2,
      mutations: 10,
      publishedMutations: 4,
      transactions: 2,
    })
  })

  it('takes the later batch for everything that says where the run got to', () => {
    const merged = mergeReports(
      report({ continueFrom: 'sty_b', behind: 5, complete: false }),
      report({ continueFrom: null, behind: 0, complete: true }),
    )
    expect(merged.continueFrom).toBeNull()
    expect(merged.behind).toBe(0)
    expect(merged.complete).toBe(true)
  })

  /** What was pending when the run *started*; a later batch sees the same set. */
  it('keeps the first batch’s pending list', () => {
    const merged = mergeReports(report({ pending: ['0001-a', '0002-b'] }), report({ pending: [] }))
    expect(merged.pending).toEqual(['0001-a', '0002-b'])
  })

  it('concatenates the oversized and failed lists', () => {
    const merged = mergeReports(
      report({ oversized: [{ storyId: 'sty_a', mutations: 400, transactions: 2 }] }),
      report({ failed: [{ storyId: 'sty_c', reason: 'nope' }] }),
    )
    expect(merged.oversized).toHaveLength(1)
    expect(merged.failed).toEqual([{ storyId: 'sty_c', reason: 'nope' }])
  })
})
