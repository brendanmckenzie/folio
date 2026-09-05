import { describe, expect, it } from 'vitest'
import type { AssetFilter } from '../../../src/core/assets'
import type { BulkOutcome, BulkSelection, FilterSelection } from '../../../src/core/bulk'
import { readBulkCursor, wasRefused, writeBulkCursor } from '../../../src/core/bulk'
import type { StoryFilter } from '../../../src/core/story'

/**
 * The shared bulk vocabulary (`docs/specs/content-model/media-library.md`
 * decision 6): the selection shapes generic over the filter, the report shapes
 * generic over the action, and the cursor codec both runners walk.
 *
 * Most of what matters here is **compile-time**, which is the whole point of the
 * generic parameter having no default: a `BulkSelection<AssetFilter>` holding a
 * `StoryFilter` has to be a type error rather than a runner that quietly counts
 * the wrong table. Those cases are `@ts-expect-error` assertions — they fail
 * `pnpm typecheck` if the type ever stops refusing them, because `tsconfig.json`
 * includes `test`.
 */

describe('a selection is generic over its filter', () => {
  it('accepts the filter it was instantiated with', () => {
    const stories: FilterSelection<StoryFilter> = {
      all: true,
      filter: { state: 'draft', type: 'page' },
      expected: 12,
    }
    const assets: FilterSelection<AssetFilter> = {
      all: true,
      filter: { folder: 'clients/acme', tags: ['headshot'] },
      expected: 40,
    }
    expect([stories.expected, assets.expected]).toEqual([12, 40])
  })

  it('refuses the other one', () => {
    const wrong: FilterSelection<AssetFilter> = {
      all: true,
      // @ts-expect-error `state` is a StoryFilter key; an asset selection may not
      // carry one. This is the failure decision 6 rejects a default type
      // parameter to prevent: with `BulkSelection<F = StoryFilter>` the asset
      // runner would hold a story filter and compile.
      filter: { state: 'draft' },
      expected: 1,
    }
    expect(wrong.expected).toBe(1)
  })

  it('keeps the two shapes exclusive', () => {
    // `ids?: never` and `all?: never` are what make the union discriminate on
    // either key, so a body naming both is a type error before it is a 400.
    const ticked: BulkSelection<AssetFilter> = { ids: ['ast_a', 'ast_b'] }
    expect(ticked.all).toBeUndefined()

    // @ts-expect-error a selection is one shape or the other, never both
    const both: BulkSelection<AssetFilter> = { ids: ['ast_a'], all: true, filter: {}, expected: 1 }
    expect(both.ids).toEqual(['ast_a'])
  })
})

describe('an outcome is generic over its action', () => {
  it('narrows a refusal away from a report', () => {
    const refusal: BulkOutcome<'delete'> = { refused: 'count', expected: 400, actual: 403 }
    expect(wasRefused(refusal)).toBe(true)

    const report: BulkOutcome<'tag'> = {
      action: 'tag',
      done: 3,
      failed: [],
      total: 3,
      seen: 3,
      continueFrom: null,
      dryRun: false,
    }
    expect(wasRefused(report)).toBe(false)
    // The narrowing is what lets a route answer two shapes from one value
    // without duck-typing, and it survives the generic.
    if (!wasRefused(report)) expect(report.action).toBe('tag')

    // @ts-expect-error 'publish' is not one of the library's four actions
    const wrong: BulkOutcome<'tag' | 'untag'> = { ...report, action: 'publish' }
    expect(wrong).toBeTruthy()
  })
})

describe('the cursor', () => {
  it('round-trips the id and the counter', () => {
    const raw = writeBulkCursor('ast_x', 25)
    expect(readBulkCursor(raw)).toEqual({ after: 'ast_x', seen: 25 })
  })

  it('truncates a fractional counter rather than carrying one', () => {
    // The counter is a count of rows. A cursor claiming 25.5 is fabricated, and
    // the arithmetic downstream (`total - seen`) has to stay integral.
    const raw = writeBulkCursor('ast_x', 25.5)
    expect(readBulkCursor(raw)).toEqual({ after: 'ast_x', seen: 25 })
  })

  it('answers null for anything that is not one of ours', () => {
    // Null rather than a throw, because `core/` has no error type: each runner
    // turns this into its own `bad_request`, which is what makes a malformed
    // cursor a 400 rather than a 500.
    expect(readBulkCursor('not-a-cursor')).toBeNull()
    expect(readBulkCursor(writeBulkCursor('ast_x', -1))).toBeNull()
  })
})
