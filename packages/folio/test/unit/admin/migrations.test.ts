import { describe, expect, it } from 'vitest'
import { mergeReports } from '../../../src/admin/hooks/useMigrations'
import { behindNotice } from '../../../src/admin/Migrations'
import type { MigrateReport, MigrationStatus } from '../../../src/server/migrate'

/**
 * The two pure pieces of the admin's migration surface (`schema-migrations.md`
 * phase 4): the banner's wording, and the merge that turns a batched run into one
 * report.
 */

const status = (over: Partial<MigrationStatus['story']> = {}): MigrationStatus => ({
  migrations: [],
  pending: [],
  behind: 0,
  story: {
    id: 'sty_a',
    schemaId: null,
    behind: true,
    pending: [{ id: '0001-a', description: 'hero.heading → hero.title' }],
    ...over,
  },
})

describe('behindNotice', () => {
  it('names the pending change for a story that is behind', () => {
    expect(behindNotice(status())).toBe(
      'This page has not been updated for the latest content model: hero.heading → hero.title',
    )
  })

  it('counts and lists when several are pending', () => {
    const notice = behindNotice(
      status({
        pending: [
          { id: '0001-a', description: 'hero.heading → hero.title' },
          { id: '0002-b', description: 'hero.align defaults to left' },
        ],
      }),
    )
    expect(notice).toContain('(2 changes)')
    expect(notice).toContain('hero.align defaults to left')
  })

  /**
   * Null, not an empty string: the caller renders `{behindNotice(...)}` and must
   * not draw a wrapper around nothing.
   */
  it('is null when there is nothing to say', () => {
    expect(behindNotice(null)).toBeNull()
    expect(behindNotice(status({ behind: false, pending: [] }))).toBeNull()
    // Behind with nothing listed would be a banner an editor cannot act on.
    expect(behindNotice(status({ behind: true, pending: [] }))).toBeNull()
  })

  it('is null when the status carries no story at all', () => {
    expect(behindNotice({ migrations: [], pending: ['0001-a'], behind: 3 })).toBeNull()
  })
})

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
