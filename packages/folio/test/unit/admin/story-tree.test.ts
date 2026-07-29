import { describe, expect, it } from 'vitest'
import { badgeLabel } from '../../../src/admin/StoryTree'

// unpublish.md: the tree distinguishes never-published, unpublished and live.
// unpublished-changes.md adds the fourth: live, but with unpublished edits on
// top (the watermark comparison in draftState).
describe('badgeLabel', () => {
  it('reads "draft" for a story that has never been published', () => {
    expect(badgeLabel('draft')).toBe('draft')
  })

  it('reads "not live" for a story that was published and has been taken down', () => {
    expect(badgeLabel('unpublished')).toBe('not live')
  })

  it('shows no badge for a live story that matches what was published', () => {
    expect(badgeLabel('live')).toBeNull()
  })

  it('reads "unpublished changes" for a live story with edits the last publish does not reflect', () => {
    expect(badgeLabel('changed')).toBe('unpublished changes')
  })
})
