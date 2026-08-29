import { describe, expect, it } from 'vitest'
import { ancestorsOf, childrenOf, keyAtIndex, subtree } from '../../../src/core/doc'
import type { Blok, Doc } from '../../../src/core/doc'
import { boolean, multiasset, number, richtext, select, text } from '../../../src/core/fields'
import { blankBlok } from '../../../src/core/schema'
import type { SchemaIndex } from '../../../src/core/schema'

function blok(overrides: Partial<Blok> & { uid: string }): Blok {
  return {
    type: 'test',
    parent: null,
    slot: null,
    order: 'a0',
    data: {},
    ...overrides,
  }
}

describe('childrenOf', () => {
  it('returns only direct children of the given (parent, slot), ordered by their fractional key', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        c: blok({ uid: 'c', parent: 'root', slot: 'body', order: 'a2' }),
        a: blok({ uid: 'a', parent: 'root', slot: 'body', order: 'a0' }),
        b: blok({ uid: 'b', parent: 'root', slot: 'body', order: 'a1' }),
        sibling: blok({ uid: 'sibling', parent: 'root', slot: 'sidebar', order: 'a0' }),
        grandchild: blok({ uid: 'grandchild', parent: 'a', slot: 'body', order: 'a0' }),
      },
    }
    expect(childrenOf(doc, 'root', 'body').map((b) => b.uid)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array when nothing matches the (parent, slot)', () => {
    const doc: Doc = { root: 'root', bloks: { root: blok({ uid: 'root' }) } }
    expect(childrenOf(doc, 'root', 'body')).toEqual([])
  })

  // SPEC(order-tiebreak): siblings with an identical `order` key sort deterministically (uid
  // tiebreak), independent of the order their bloks happen to appear in `doc.bloks`.
  it('breaks order ties deterministically regardless of blok insertion order', () => {
    const docA: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        x: blok({ uid: 'x', parent: 'root', slot: 'body', order: 'tie' }),
        y: blok({ uid: 'y', parent: 'root', slot: 'body', order: 'tie' }),
      },
    }
    const docB: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        y: blok({ uid: 'y', parent: 'root', slot: 'body', order: 'tie' }),
        x: blok({ uid: 'x', parent: 'root', slot: 'body', order: 'tie' }),
      },
    }
    const seqA = childrenOf(docA, 'root', 'body').map((b) => b.uid)
    const seqB = childrenOf(docB, 'root', 'body').map((b) => b.uid)
    expect(seqA).toEqual(seqB)
  })
})

describe('keyAtIndex', () => {
  it('places a key at the front, in the middle, and at the end of a sibling list', () => {
    const keys = ['a0', 'a1', 'a2']
    expect(keyAtIndex(keys, 0) < 'a0').toBe(true)
    const middle = keyAtIndex(keys, 1)
    expect(middle > 'a0' && middle < 'a1').toBe(true)
    expect(keyAtIndex(keys, 3) > 'a2').toBe(true)
  })

  it('produces a key for an empty sibling list', () => {
    expect(typeof keyAtIndex([], 0)).toBe('string')
  })

  it('clamps an index past either end rather than producing a stray key', () => {
    const keys = ['a0', 'a1']
    expect(keyAtIndex(keys, 99) > 'a1').toBe(true)
    expect(keyAtIndex(keys, -1) < 'a0').toBe(true)
  })

  // Tied keys are reachable by design (see compareSiblings), and generateKeyBetween throws
  // on equal bounds, so every drop position around a tied run has to stay writable.
  it('lands after a tied run instead of throwing on equal bounds', () => {
    const keys = ['a0', 'a2', 'a2', 'a4']
    for (let i = 0; i <= keys.length; i++) {
      expect(() => keyAtIndex(keys, i)).not.toThrow()
    }
    const inside = keyAtIndex(keys, 2)
    expect(inside > 'a2' && inside < 'a4').toBe(true)
  })

  it('stays writable when every sibling is tied', () => {
    const keys = ['a2', 'a2', 'a2']
    expect(keyAtIndex(keys, 1) > 'a2').toBe(true)
    expect(keyAtIndex(keys, 0) < 'a2').toBe(true)
  })
})

describe('subtree', () => {
  it('returns the root uid followed by every descendant, parents before children', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        a: blok({ uid: 'a', parent: 'root' }),
        b: blok({ uid: 'b', parent: 'root' }),
        a1: blok({ uid: 'a1', parent: 'a' }),
      },
    }
    expect(subtree(doc, 'root')).toEqual(['root', 'a', 'a1', 'b'])
  })

  it('returns just the uid for a node with no children', () => {
    const doc: Doc = {
      root: 'root',
      bloks: { root: blok({ uid: 'root' }), leaf: blok({ uid: 'leaf', parent: 'root' }) },
    }
    expect(subtree(doc, 'leaf')).toEqual(['leaf'])
  })

  // `apply` refuses cycles now, but a log written before it did can still replay one.
  it('visits each blok once on a cyclic document rather than recursing forever', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        a: blok({ uid: 'a', parent: 'b' }),
        b: blok({ uid: 'b', parent: 'a' }),
      },
    }
    expect(subtree(doc, 'a')).toEqual(['a', 'b'])
  })
})

describe('ancestorsOf', () => {
  it('walks from the immediate parent up to the root, excluding the uid itself', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        a: blok({ uid: 'a', parent: 'root' }),
        b: blok({ uid: 'b', parent: 'a' }),
      },
    }
    expect(ancestorsOf(doc, 'b')).toEqual(['a', 'root'])
  })

  it('returns an empty array for a uid with no parent', () => {
    const doc: Doc = { root: 'root', bloks: { root: blok({ uid: 'root' }) } }
    expect(ancestorsOf(doc, 'root')).toEqual([])
  })

  it('returns an empty array for a uid that is not in the doc', () => {
    const doc: Doc = { root: 'root', bloks: { root: blok({ uid: 'root' }) } }
    expect(ancestorsOf(doc, 'ghost')).toEqual([])
  })

  it('stops on a cyclic document rather than walking forever', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        a: blok({ uid: 'a', parent: 'b' }),
        b: blok({ uid: 'b', parent: 'a' }),
      },
    }
    expect(ancestorsOf(doc, 'a')).toEqual(['b'])
  })
})

describe('blankBlok / defaultValue integration', () => {
  const schema: SchemaIndex = {
    card: {
      name: 'card',
      label: 'Card',
      fields: {
        title: text(),
        featured: boolean(),
        rating: number(),
        variant: select({
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
        }),
        body: richtext(),
        gallery: multiasset(),
      },
    },
  }

  it('fills every non-blocks field with its kind default', () => {
    const b = blankBlok(schema, 'card', 'root', 'body', 'a0')
    expect(b.data).toEqual({
      title: '',
      featured: false,
      rating: 0,
      variant: 'a',
      body: null,
      gallery: [],
    })
  })

  it('stamps the given type, parent, slot and order onto the Blok', () => {
    const b = blankBlok(schema, 'card', 'root', 'body', 'a3')
    expect(b.type).toBe('card')
    expect(b.parent).toBe('root')
    expect(b.slot).toBe('body')
    expect(b.order).toBe('a3')
  })

  it('gives every blok a fresh, distinct uid', () => {
    const a = blankBlok(schema, 'card', null, null, 'a0')
    const b = blankBlok(schema, 'card', null, null, 'a0')
    expect(a.uid).not.toBe(b.uid)
  })

  it('produces Bloks that plug straight into a Doc for childrenOf/subtree/ancestorsOf', () => {
    const root = blankBlok(schema, 'card', null, null, 'a0')
    const card1 = blankBlok(schema, 'card', root.uid, 'body', 'a0')
    const card2 = blankBlok(schema, 'card', root.uid, 'body', 'a1')
    const doc: Doc = {
      root: root.uid,
      bloks: { [root.uid]: root, [card1.uid]: card1, [card2.uid]: card2 },
    }
    expect(childrenOf(doc, root.uid, 'body').map((b) => b.uid)).toEqual([card1.uid, card2.uid])
    expect(subtree(doc, root.uid)).toEqual([root.uid, card1.uid, card2.uid])
    expect(ancestorsOf(doc, card1.uid)).toEqual([root.uid])
  })

  it('throws for an unknown block type', () => {
    expect(() => blankBlok(schema, 'nope', null, null, 'a0')).toThrow('Unknown block type: nope')
  })
})
