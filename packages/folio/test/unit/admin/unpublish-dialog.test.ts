import { describe, expect, it } from 'vitest'
import { unpublishConfirmation } from '../../../src/admin/UnpublishDialog'
import type { StoryMeta } from '../../../src/core/story'

function meta(overrides: Partial<StoryMeta> & { id: string }): StoryMeta {
  const publishedAt = overrides.publishedAt ?? null
  const unpublishedAt = overrides.unpublishedAt ?? null
  return {
    parentId: null,
    slug: overrides.id,
    path: overrides.id,
    ord: 'a0',
    title: overrides.id,
    updatedAt: 0,
    publishedAt,
    unpublishedAt,
    state: publishedAt !== null ? 'live' : unpublishedAt !== null ? 'unpublished' : 'draft',
    ...overrides,
  }
}

// unpublish.md's architecture decisions 3 and 4: name the live descendants
// rather than cascade, and the root story gets its own wording.
describe('unpublishConfirmation', () => {
  it('labels an ordinary page by its path', () => {
    const about = meta({ id: 'about', path: 'about', publishedAt: 1 })
    expect(unpublishConfirmation(about, [about]).isRoot).toBe(false)
    expect(unpublishConfirmation(about, [about]).label).toBe('/about')
  })

  it('labels the root story as "/" and flags it as root', () => {
    const root = meta({ id: 'home', path: '', publishedAt: 1 })
    const result = unpublishConfirmation(root, [root])
    expect(result.isRoot).toBe(true)
    expect(result.label).toBe('/')
  })

  it('names only the live descendants, in tree order, over the whole subtree', () => {
    const about = meta({ id: 'about', path: 'about', publishedAt: 1 })
    const team = meta({ id: 'team', parentId: 'about', path: 'about/team', publishedAt: 2 })
    const history = meta({ id: 'history', parentId: 'about', path: 'about/history' })
    const jobs = meta({
      id: 'jobs',
      parentId: 'team',
      path: 'about/team/jobs',
      publishedAt: 3,
    })
    const rows = [about, team, history, jobs]

    expect(unpublishConfirmation(about, rows).descendantPaths).toEqual([
      '/about/team',
      '/about/team/jobs',
    ])
  })

  it('is empty when nothing beneath it is live', () => {
    const about = meta({ id: 'about', path: 'about', publishedAt: 1 })
    const draft = meta({ id: 'draft-child', parentId: 'about', path: 'about/draft-child' })
    expect(unpublishConfirmation(about, [about, draft]).descendantPaths).toEqual([])
  })

  it('never includes the story itself, even if it were (incorrectly) live in the rows given', () => {
    const about = meta({ id: 'about', path: 'about', publishedAt: 1 })
    expect(unpublishConfirmation(about, [about]).descendantPaths).toEqual([])
  })
})
