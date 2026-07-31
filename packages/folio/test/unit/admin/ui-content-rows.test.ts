import { describe, expect, it } from 'vitest'
import { stateTone, when } from '../../../src/admin/ui/screens/content-rows'

/**
 * What is left of the Content prototype's arithmetic once the tree was paged.
 *
 * The `flatten` tests that used to be here are gone with the function, and the
 * property they pinned hardest — "a filtered tree keeps the ancestors of its
 * matches" — is the one per-level paging cannot express at all. It became a
 * *product* decision instead of a client-side walk, and it is pinned as one in
 * `ui-content-model.test.ts`: a filter moves you to flat mode, because a tree
 * loaded one level at a time can only show matches whose whole ancestor chain also
 * matches. See `content-model.ts`'s `withFilter`.
 */

describe('stateTone', () => {
  it('gives a draft the neutral tone, which is the review’s one palette change', () => {
    expect(stateTone('draft')).toBe('neutral')
  })

  it('reserves danger for the state that is genuinely a warning', () => {
    expect(stateTone('unpublished')).toBe('danger')
    expect(stateTone('live')).toBe('ok')
    expect(stateTone('changed')).toBe('accent')
  })
})

describe('when', () => {
  const now = Date.UTC(2026, 6, 30, 12, 0, 0)

  it('prefers the draft watermark, because that is what an editor means by "edited"', () => {
    // The row was touched an hour ago by a move; the document changed a minute
    // ago. "1m ago" is the true answer to the question the column asks.
    expect(when({ updatedAt: now - 3_600_000, draftUpdatedAt: now - 60_000 }, now)).toBe('1m ago')
  })

  it('falls back to the row when the document has never been edited', () => {
    expect(when({ updatedAt: now - 7_200_000, draftUpdatedAt: null }, now)).toBe('2h ago')
  })

  it('coarsens as it goes back', () => {
    expect(when({ updatedAt: now - 5_000, draftUpdatedAt: null }, now)).toBe('just now')
    expect(when({ updatedAt: now - 120_000, draftUpdatedAt: null }, now)).toBe('2m ago')
    expect(when({ updatedAt: now - 3 * 86_400_000, draftUpdatedAt: null }, now)).toBe('3d ago')
  })

  it('switches to a date past a month, since nobody counts in 40 days', () => {
    const stamp = when({ updatedAt: now - 90 * 86_400_000, draftUpdatedAt: null }, now)
    expect(stamp).not.toMatch(/ago/)
    expect(stamp).toMatch(/\d/)
  })
})
