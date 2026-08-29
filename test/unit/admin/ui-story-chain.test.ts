import { describe, expect, it } from 'vitest'
import { chainOf } from '../../../src/admin/ui/useStory'
import type { StoryMeta } from '../../../src/core/story'

/**
 * The breadcrumb's chain, ordered **by path** rather than by walking `parentId`.
 *
 * That change is what per-level paging forced. The old version walked the parent
 * chain through a flat list of every story on the site; the rows here are only the
 * document and its ancestors, straight out of
 * `GET {base}/api/stories?ids=&ancestors=1`. A path *is* the ancestor chain, which
 * is why the server can fetch the whole set in one query and why this needs no
 * walk at all.
 */

const row = (id: string, path: string | null, title = id): StoryMeta =>
  ({
    id,
    type: 'page',
    parentId: null,
    slug: id,
    path,
    ord: 'a0',
    title,
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 1,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    titleI18n: null,
    state: 'draft',
    hasUnpublishedChanges: false,
  }) as StoryMeta

describe('chainOf', () => {
  const HOME = row('home', '', 'Home')
  const ABOUT = row('about', 'about', 'About')
  const TEAM = row('team', 'about/team', 'Our team')

  it('is root first, the document itself last', () => {
    expect(chainOf([TEAM, HOME, ABOUT], TEAM)).toEqual([
      { id: 'home', title: 'Home' },
      { id: 'about', title: 'About' },
      { id: 'team', title: 'Our team' },
    ])
  })

  it('does not depend on the order the rows arrived in', () => {
    // A batch by id is not a page, so the route answers in no particular order —
    // which is fine precisely because the ordering comes from the paths.
    expect(chainOf([ABOUT, TEAM, HOME], TEAM).map((c) => c.id)).toEqual(['home', 'about', 'team'])
  })

  it('is one crumb for the root itself, which has no ancestors', () => {
    expect(chainOf([HOME], HOME)).toEqual([{ id: 'home', title: 'Home' }])
  })

  it('is one crumb for an unrouted document, which is not in the tree at all', () => {
    // A record's way back is its type's list and a global has nothing above it.
    // Both are the breadcrumb's `root`, decided by the caller that knows the
    // content model — never invented here.
    const ada = row('per_ada', null, 'Ada')
    expect(chainOf([ada, HOME], ada)).toEqual([{ id: 'per_ada', title: 'Ada' }])
  })

  it('skips an ancestor that is missing rather than breaking the trail', () => {
    // Should not happen — the server resolves every `ancestorPaths` entry — but a
    // breadcrumb with a hole in it is still navigable and a crash is not.
    expect(chainOf([TEAM, HOME], TEAM).map((c) => c.id)).toEqual(['home', 'team'])
  })

  it('falls back to the slug, then the id, for a document with no title', () => {
    const untitled = { ...row('sty_x', 'thing', ''), slug: 'thing' }
    expect(chainOf([untitled, HOME], untitled).at(-1)).toEqual({ id: 'sty_x', title: 'thing' })
    const bare = { ...row('sty_y', 'y', ''), slug: '' }
    expect(chainOf([bare, HOME], bare).at(-1)).toEqual({ id: 'sty_y', title: 'sty_y' })
  })
})
