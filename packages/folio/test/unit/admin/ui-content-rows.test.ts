import { describe, expect, it } from 'vitest'
import { flatten, stateTone, when } from '../../../src/admin/ui/screens/content-rows'
import type { StoryNode } from '../../../src/core/story'

/**
 * The Content screen's arithmetic. The rule worth pinning hardest is that a
 * filtered tree **keeps the ancestors of its matches** — without it the indent
 * stops meaning anything the moment somebody types, which is the difference
 * between a filter and a broken tree.
 */

const node = (id: string, extra: Partial<StoryNode> = {}): StoryNode =>
  ({
    id,
    type: 'page',
    parentId: null,
    slug: id,
    path: `/${id}`,
    ord: 'a0',
    title: id,
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 1000,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    children: [],
    ...extra,
  }) as StoryNode

const NONE = new Set<string>()
const ids = (rows: ReturnType<typeof flatten>) => rows.map((r) => `${r.depth}:${r.node.id}`)

const TREE: StoryNode[] = [
  node('about', {
    title: 'About',
    state: 'live',
    children: [
      node('team', { title: 'Our team', state: 'changed', path: '/about/team' }),
      node('history', { title: 'History', state: 'live', path: '/about/history' }),
    ],
  }),
  node('contact', { title: 'Contact', state: 'draft' }),
]

describe('flatten', () => {
  it('walks depth-first with a depth per row', () => {
    expect(ids(flatten(TREE, { closed: NONE, state: 'all', search: '' }))).toEqual([
      '0:about',
      '1:team',
      '1:history',
      '0:contact',
    ])
  })

  it('is fully expanded by default: collapse is the exception that is stored', () => {
    const all = flatten(TREE, { closed: NONE, state: 'all', search: '' })
    expect(all).toHaveLength(4)
  })

  it('hides the children of a closed node but keeps the node', () => {
    expect(ids(flatten(TREE, { closed: new Set(['about']), state: 'all', search: '' }))).toEqual([
      '0:about',
      '0:contact',
    ])
  })

  it('keeps a match and drops everything else', () => {
    expect(ids(flatten(TREE, { closed: NONE, state: 'all', search: 'contact' }))).toEqual([
      '0:contact',
    ])
  })

  it('keeps the ancestors of a match, so the indent still means depth', () => {
    expect(ids(flatten(TREE, { closed: NONE, state: 'all', search: 'our team' }))).toEqual([
      '0:about',
      '1:team',
    ])
  })

  it('searches title, slug and path', () => {
    const bySlug = flatten(TREE, { closed: NONE, state: 'all', search: 'history' })
    const byPath = flatten(TREE, { closed: NONE, state: 'all', search: '/about/' })
    expect(bySlug.map((r) => r.node.id)).toEqual(['about', 'history'])
    expect(byPath.map((r) => r.node.id)).toEqual(['about', 'team', 'history'])
  })

  it('ignores case and surrounding whitespace', () => {
    expect(flatten(TREE, { closed: NONE, state: 'all', search: '  CONTACT ' })).toHaveLength(1)
  })

  it('filters by state, and keeps an ancestor whose state does not match', () => {
    const changed = flatten(TREE, { closed: NONE, state: 'changed', search: '' })
    expect(ids(changed)).toEqual(['0:about', '1:team'])
    // `about` is live, not changed: it is here as the parent of a match, and it is
    // still a real row somebody may want to click.
    expect(changed[0]?.node.state).toBe('live')
  })

  it('combines a state filter and a search as an AND', () => {
    expect(flatten(TREE, { closed: NONE, state: 'live', search: 'contact' })).toHaveLength(0)
    expect(ids(flatten(TREE, { closed: NONE, state: 'live', search: 'history' }))).toEqual([
      '0:about',
      '1:history',
    ])
  })

  it('still hides a closed node’s matching children, because the person closed it', () => {
    expect(
      flatten(TREE, { closed: new Set(['about']), state: 'all', search: 'our team' }),
    ).toHaveLength(0)
  })

  it('returns nothing for an empty tree rather than throwing', () => {
    expect(flatten([], { closed: NONE, state: 'all', search: 'x' })).toEqual([])
  })
})

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
