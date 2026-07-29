import { describe, expect, it } from 'vitest'
import { deleteConfirmation } from '../../../src/admin/DeleteDialog'
import type { StoryMeta } from '../../../src/core/story'

function meta(overrides: Partial<StoryMeta> & { id: string }): StoryMeta {
  return {
    parentId: null,
    slug: overrides.id,
    path: overrides.id,
    ord: 'a0',
    title: overrides.id,
    updatedAt: 0,
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    ...overrides,
  }
}

// redirects.md's architecture decision 4: the delete confirmation names the
// path being removed and where a redirect would point (the deleted node's
// own parent, the nearest surviving ancestor once the whole subtree is gone).
describe('deleteConfirmation', () => {
  it('labels a top-level page and points its redirect at the root', () => {
    const about = meta({ id: 'about', path: 'about' })
    const result = deleteConfirmation(about, [about])

    expect(result.label).toBe('/about')
    expect(result.parentLabel).toBe('/')
  })

  it('points the redirect at the immediate parent for a nested page', () => {
    const about = meta({ id: 'about', path: 'about' })
    const team = meta({ id: 'team', parentId: 'about', path: 'about/team' })

    expect(deleteConfirmation(team, [about, team]).parentLabel).toBe('/about')
  })

  it('counts descendants beyond the story itself', () => {
    const about = meta({ id: 'about', path: 'about' })
    const team = meta({ id: 'team', parentId: 'about', path: 'about/team' })
    const jobs = meta({ id: 'jobs', parentId: 'team', path: 'about/team/jobs' })
    const rows = [about, team, jobs]

    expect(deleteConfirmation(about, rows).descendantCount).toBe(2)
    expect(deleteConfirmation(team, rows).descendantCount).toBe(1)
    expect(deleteConfirmation(jobs, rows).descendantCount).toBe(0)
  })
})
