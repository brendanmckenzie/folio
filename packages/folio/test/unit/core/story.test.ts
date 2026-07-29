import { describe, expect, it } from 'vitest'
import {
  buildTree,
  derivePaths,
  descendants,
  draftState,
  liveDescendants,
  slugify,
  storyState,
} from '../../../src/core/story'
import type { StoryMeta } from '../../../src/core/story'

function meta(overrides: Partial<StoryMeta> & { id: string }): StoryMeta {
  const publishedAt = overrides.publishedAt ?? null
  const unpublishedAt = overrides.unpublishedAt ?? null
  const draftSyncId = overrides.draftSyncId ?? 0
  const publishedSyncId = overrides.publishedSyncId ?? 0
  const state = draftState(publishedAt, unpublishedAt, draftSyncId, publishedSyncId)
  return {
    parentId: null,
    slug: overrides.id,
    path: overrides.id,
    ord: 'a0',
    title: overrides.id,
    updatedAt: 0,
    publishedAt,
    unpublishedAt,
    draftSyncId,
    draftUpdatedAt: null,
    publishedSyncId,
    state,
    hasUnpublishedChanges: state === 'changed',
    ...overrides,
  }
}

describe('buildTree', () => {
  it('orders root siblings ascending by ord, not input order', () => {
    const rows = [
      meta({ id: 'c', ord: 'a2' }),
      meta({ id: 'a', ord: 'a0' }),
      meta({ id: 'b', ord: 'a1' }),
    ]
    expect(buildTree(rows).map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('nests rows under their parent and sorts each children array by ord', () => {
    const rows = [
      meta({ id: 'root', ord: 'a0' }),
      meta({ id: 'child2', parentId: 'root', ord: 'a1' }),
      meta({ id: 'child1', parentId: 'root', ord: 'a0' }),
    ]
    const tree = buildTree(rows)
    expect(tree).toHaveLength(1)
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['child1', 'child2'])
  })

  it('sorts recursively at every depth', () => {
    const rows = [
      meta({ id: 'root', ord: 'a0' }),
      meta({ id: 'mid', parentId: 'root', ord: 'a0' }),
      meta({ id: 'leaf2', parentId: 'mid', ord: 'a1' }),
      meta({ id: 'leaf1', parentId: 'mid', ord: 'a0' }),
    ]
    const tree = buildTree(rows)
    expect(tree[0]?.children[0]?.children.map((n) => n.id)).toEqual(['leaf1', 'leaf2'])
  })

  it('treats a row whose parentId points nowhere as a root', () => {
    const rows = [meta({ id: 'orphan', parentId: 'ghost-parent' })]
    expect(buildTree(rows).map((n) => n.id)).toEqual(['orphan'])
  })

  // SPEC(tree-tiebreak): siblings with an identical `ord` sort in a deterministic sequence (id
  // tiebreak) regardless of the order the rows were passed in — the same comparator the document
  // uses for (order, uid).
  it('breaks ord ties deterministically regardless of row insertion order', () => {
    const a = meta({ id: 'a', ord: 'tie' })
    const b = meta({ id: 'b', ord: 'tie' })
    const forward = buildTree([a, b]).map((n) => n.id)
    const reversed = buildTree([b, a]).map((n) => n.id)
    expect(forward).toEqual(reversed)
  })
})

describe('derivePaths', () => {
  it('joins a child path onto its parent path with a slash', () => {
    const rows = [
      meta({ id: 'root', slug: 'blog' }),
      meta({ id: 'child', parentId: 'root', slug: 'post' }),
    ]
    const paths = derivePaths(rows)
    expect(paths.get('root')).toBe('blog')
    expect(paths.get('child')).toBe('blog/post')
  })

  it('gives an empty-slug root the empty path, and its children plain (unprefixed) slugs', () => {
    const rows = [
      meta({ id: 'root', slug: '' }),
      meta({ id: 'child', parentId: 'root', slug: 'about' }),
    ]
    const paths = derivePaths(rows)
    expect(paths.get('root')).toBe('')
    expect(paths.get('child')).toBe('about')
  })

  it('recomputes every descendant path when an ancestor slug is renamed (whole subtree repathed)', () => {
    const rows = [
      meta({ id: 'root', slug: 'blog' }),
      meta({ id: 'child', parentId: 'root', slug: 'post' }),
      meta({ id: 'grandchild', parentId: 'child', slug: 'comment' }),
    ]
    const before = derivePaths(rows)
    expect(before.get('grandchild')).toBe('blog/post/comment')

    const renamed = rows.map((r) => (r.id === 'root' ? { ...r, slug: 'articles' } : r))
    const after = derivePaths(renamed)
    expect(after.get('root')).toBe('articles')
    expect(after.get('child')).toBe('articles/post')
    expect(after.get('grandchild')).toBe('articles/post/comment')
  })

  // Pin, not a fix target: a parentId cycle does not infinite-loop, but the guard only stops a
  // row recursing into itself *while already on the current call stack* — it returns that row's
  // bare slug for that one re-entrant call rather than a fully-resolved path. The result below is
  // whatever falls out of that shortcut for this exact row order; it is odd (note the repeated
  // "alpha" segment) but this test exists to freeze it, not endorse it.
  it('cycle guard as written: breaks recursion but yields a path with a duplicated segment', () => {
    const rows = [
      meta({ id: 'a', parentId: 'b', slug: 'alpha' }),
      meta({ id: 'b', parentId: 'a', slug: 'beta' }),
    ]
    const paths = derivePaths(rows)
    expect(paths.get('a')).toBe('alpha/beta/alpha')
    expect(paths.get('b')).toBe('alpha/beta')
  })
})

describe('descendants', () => {
  it('returns the id plus every descendant, pre-order', () => {
    const rows = [
      meta({ id: 'root' }),
      meta({ id: 'a', parentId: 'root' }),
      meta({ id: 'b', parentId: 'root' }),
      meta({ id: 'a1', parentId: 'a' }),
    ]
    expect(descendants(rows, 'root')).toEqual(['root', 'a', 'a1', 'b'])
  })

  it('returns just the id for a leaf with no children', () => {
    const rows = [meta({ id: 'root' }), meta({ id: 'lonely', parentId: 'root' })]
    expect(descendants(rows, 'lonely')).toEqual(['lonely'])
  })

  // Story-tree writes in D1 are last-write-wins, so a parent_id cycle is reachable, and
  // updateStory/deleteStory — the only ways to clear one — both walk through here.
  it('visits each row once on a parent_id cycle rather than overflowing the stack', () => {
    const rows = [meta({ id: 'a', parentId: 'b' }), meta({ id: 'b', parentId: 'a' })]
    expect(descendants(rows, 'a')).toEqual(['a', 'b'])
  })
})

// unpublish.md's architecture decision 2: the tree's three (of four) states
// this spec derives, from `publishedAt`/`unpublishedAt` alone.
describe('storyState', () => {
  it('is "draft" when never published', () => {
    expect(storyState(null, null)).toBe('draft')
  })

  it('is "live" when published_at is set, whatever unpublished_at says', () => {
    expect(storyState(1000, null)).toBe('live')
    // publishStoryStatement clears unpublished_at on every publish, so this
    // combination should not arise in practice — but "live" wins regardless,
    // since `published_at` is the liveness signal.
    expect(storyState(1000, 500)).toBe('live')
  })

  it('is "unpublished" when taken down: published_at null, unpublished_at set', () => {
    expect(storyState(null, 1000)).toBe('unpublished')
  })
})

// unpublished-changes.md's architecture decision 3: the fourth state, from the
// watermark pair alone — coarser than a diff, correct enough for a tree.
describe('draftState', () => {
  it('is "live" when the draft watermark has not moved past what was published', () => {
    expect(draftState(1000, null, 0, 0)).toBe('live')
    expect(draftState(1000, null, 5, 5)).toBe('live')
  })

  it('is "changed" when the draft watermark has moved past the published one', () => {
    expect(draftState(1000, null, 6, 5)).toBe('changed')
  })

  it('never reports "changed" for a story that is not live', () => {
    expect(draftState(null, null, 6, 5)).toBe('draft')
    expect(draftState(null, 1000, 6, 5)).toBe('unpublished')
  })

  it('falls back to storyState for a published_sync_id ahead of draft (should not arise, but not "changed")', () => {
    expect(draftState(1000, null, 5, 6)).toBe('live')
  })
})

describe('liveDescendants', () => {
  it('names only the live descendants, excluding the story itself', () => {
    const rows = [
      meta({ id: 'about', publishedAt: 1 }),
      meta({ id: 'team', parentId: 'about', publishedAt: 2 }),
      meta({ id: 'history', parentId: 'about', unpublishedAt: 5 }),
      meta({ id: 'jobs', parentId: 'about' }),
    ]
    expect(liveDescendants(rows, 'about').map((s) => s.id)).toEqual(['team'])
  })

  it('is empty for a story with no live descendants', () => {
    const rows = [meta({ id: 'about', publishedAt: 1 }), meta({ id: 'team', parentId: 'about' })]
    expect(liveDescendants(rows, 'about')).toEqual([])
  })

  it('walks the whole subtree, not just direct children', () => {
    const rows = [
      meta({ id: 'about' }),
      meta({ id: 'mid', parentId: 'about' }),
      meta({ id: 'leaf', parentId: 'mid', publishedAt: 3 }),
    ]
    expect(liveDescendants(rows, 'about').map((s) => s.id)).toEqual(['leaf'])
  })

  it('counts a "changed" descendant as still live: it is serving the public mid-edit', () => {
    const rows = [
      meta({ id: 'about', publishedAt: 1 }),
      meta({ id: 'team', parentId: 'about', publishedAt: 2, draftSyncId: 3, publishedSyncId: 1 }),
    ]
    expect(liveDescendants(rows, 'about').map((s) => s.id)).toEqual(['team'])
  })
})

describe('slugify', () => {
  it('lowercases plain ascii input', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('collapses runs of whitespace into a single hyphen', () => {
    expect(slugify('Hello   World')).toBe('hello-world')
  })

  it('collapses repeated punctuation/hyphen runs into a single hyphen', () => {
    expect(slugify('Hello---World  Foo')).toBe('hello-world-foo')
  })

  it('trims leading and trailing separators', () => {
    expect(slugify('  --Hello World--  ')).toBe('hello-world')
  })

  it('keeps unicode letters and numbers that have no case or diacritic to strip', () => {
    expect(slugify('日本語123')).toBe('日本語123')
  })

  // NFKD-decomposed combining marks (e.g. the diaeresis on "ü") are not \p{Letter}, so they are
  // replaced with a hyphen just like any other separator -- accented words get split, they are not
  // cleanly stripped to their base letter. Surprising, but this is current behaviour.
  it('splits words on decomposed diacritics rather than stripping them cleanly', () => {
    expect(slugify('Café Münchner')).toBe('cafe-mu-nchner')
  })

  it('falls back to "untitled" when nothing letter/number-like survives', () => {
    expect(slugify('!!! ??? ---')).toBe('untitled')
  })

  it('falls back to "untitled" for blank input', () => {
    expect(slugify('   ')).toBe('untitled')
  })

  it('truncates to 64 characters', () => {
    expect(slugify('a'.repeat(100))).toBe('a'.repeat(64))
  })
})
