import { describe, expect, it } from 'vitest'
import { badgeLabel } from '../../../src/admin/StoryTree'

// unpublish.md: the tree distinguishes never-published, unpublished and live.
// 'changed' (unpublished-changes.md) is not reachable yet, but already maps to
// no badge — the same as 'live' — so this spec does not have to revisit
// StoryTree when that field starts arriving.
describe('badgeLabel', () => {
  it('reads "draft" for a story that has never been published', () => {
    expect(badgeLabel('draft')).toBe('draft')
  })

  it('reads "not live" for a story that was published and has been taken down', () => {
    expect(badgeLabel('unpublished')).toBe('not live')
  })

  it('shows no badge for a live story', () => {
    expect(badgeLabel('live')).toBeNull()
  })

  it('shows no badge for "changed" either, pending unpublished-changes.md', () => {
    expect(badgeLabel('changed')).toBeNull()
  })
})
