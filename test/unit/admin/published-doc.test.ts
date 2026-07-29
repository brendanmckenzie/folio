import { describe, expect, it } from 'vitest'
import { publishedDelta } from '../../../src/admin/hooks/usePublishedDoc'
import type { Doc } from '../../../src/core/doc'

function doc(title: string): Doc {
  return {
    root: 'root0000',
    bloks: {
      root0000: {
        uid: 'root0000',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title },
      },
    },
  }
}

// unpublished-changes.md's phase 1: the top bar's four states, built on the
// pure half of usePublishedDoc so they need no React runtime to pin.
describe('publishedDelta', () => {
  it('is null when the story has never been published (no published doc to compare against)', () => {
    expect(publishedDelta(null, doc('Home'))).toBeNull()
  })

  it('is null while the live draft has not loaded yet', () => {
    expect(publishedDelta(doc('Home'), null)).toBeNull()
  })

  it('is a zero-total delta when the draft matches what was published ("Up to date")', () => {
    const delta = publishedDelta(doc('Home'), doc('Home'))
    expect(delta?.total).toBe(0)
  })

  it('reports edited/added/removed/moved counts once the draft has diverged ("N unpublished changes")', () => {
    const published = doc('Home')
    const draft: Doc = {
      root: 'root0000',
      bloks: {
        ...published.bloks,
        root0000: { ...published.bloks.root0000!, data: { title: 'Changed' } },
        hero0001: {
          uid: 'hero0001',
          type: 'hero',
          parent: 'root0000',
          slot: 'body',
          order: 'a0',
          data: {},
        },
      },
    }
    const delta = publishedDelta(published, draft)
    expect(delta).toEqual({ added: 1, removed: 0, moved: 0, edited: 1, total: 2 })
  })

  it('returns to a zero-total delta once a changed value is edited back to its published state', () => {
    const published = doc('Home')
    const changed = doc('Changed')
    expect(publishedDelta(published, changed)?.total).toBeGreaterThan(0)

    const editedBack = doc('Home')
    expect(publishedDelta(published, editedBack)?.total).toBe(0)
  })
})
