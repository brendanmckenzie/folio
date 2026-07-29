import { describe, expect, it } from 'vitest'
import { cloneDoc, cloneSubtree } from '../../../src/core/clone'
import type { Blok, Doc } from '../../../src/core/doc'

// duplicate-and-paste.md's architecture decision 1: `cloneSubtree`/`cloneDoc`
// are the one primitive `duplicate`, `paste` and "duplicate a document" all
// share, built on `allocateSubtree` (field-defaults-and-presets.md) rather
// than reinventing uid/order allocation.

function blok(overrides: Partial<Blok> & { uid: string }): Blok {
  return { type: 'test', parent: null, slot: null, order: 'a0', data: {}, ...overrides }
}

/**
 * A `features` block with three children, one of which (`item2`) has two
 * children of its own — the acceptance criterion's exact shape: six bloks in
 * `features`'s own subtree (itself, three items, two sub-items), and a
 * richer set of field kinds worth carrying verbatim sitting on `item2`.
 */
function fixture(): Doc {
  return {
    root: 'root',
    bloks: {
      root: blok({ uid: 'root', type: 'page' }),
      features: blok({
        uid: 'features',
        type: 'features',
        parent: 'root',
        slot: 'body',
        order: 'a0',
      }),
      item1: blok({
        uid: 'item1',
        type: 'item',
        parent: 'features',
        slot: 'items',
        order: 'a0',
        data: { label: 'One' },
      }),
      item2: blok({
        uid: 'item2',
        type: 'item',
        parent: 'features',
        slot: 'items',
        order: 'a1',
        data: {
          label: 'Two',
          asset: { key: 'ast_abc123456789-photo.jpg', filename: 'photo.jpg' },
          link: { kind: 'story', id: 'sty_target000' },
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'hello',
                    marks: [
                      { type: 'link', attrs: { link: { kind: 'story', id: 'sty_target000' } } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
      item3: blok({
        uid: 'item3',
        type: 'item',
        parent: 'features',
        slot: 'items',
        order: 'a2',
        data: { label: 'Three' },
      }),
      sub1: blok({
        uid: 'sub1',
        type: 'subitem',
        parent: 'item2',
        slot: 'children',
        order: 'a0',
        data: { label: 'Sub one' },
      }),
      sub2: blok({
        uid: 'sub2',
        type: 'subitem',
        parent: 'item2',
        slot: 'children',
        order: 'a1',
        data: { label: 'Sub two' },
      }),
    },
  }
}

describe('cloneSubtree', () => {
  it('copies the whole subtree: six bloks for a features block with three items, one nested twice', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    expect(copy).toHaveLength(6)
  })

  it('returns parents before children', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const indexOf = (type: string) => copy.findIndex((b) => b.type === type)
    expect(indexOf('features')).toBeLessThan(indexOf('item'))
    expect(indexOf('item')).toBeLessThan(indexOf('subitem'))
  })

  it('gives every blok in the copy a fresh uid, none reused from the source', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const originalUids = new Set(Object.keys(doc.bloks))
    for (const b of copy) expect(originalUids.has(b.uid)).toBe(false)
    expect(new Set(copy.map((b) => b.uid)).size).toBe(copy.length)
  })

  it('places the top blok at the given target', () => {
    const doc = fixture()
    const [top] = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    expect(top!.parent).toBe('root')
    expect(top!.slot).toBe('body')
    expect(top!.order).toBe('z0')
  })

  it('every non-top parent points inside the copy, never at an original uid', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const copyUids = new Set(copy.map((b) => b.uid))
    const [top, ...rest] = copy
    for (const b of rest) {
      expect(b.parent).not.toBeNull()
      expect(copyUids.has(b.parent!)).toBe(true)
    }
    expect(top!.parent).toBe('root') // the top's own parent is the *target*, not inside the copy
  })

  it('preserves sibling order among the three items', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const items = copy.filter((b) => b.type === 'item')
    expect(items.map((b) => b.data.label)).toEqual(['One', 'Two', 'Three'])
  })

  it('preserves sibling order among nested children too', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const subs = copy.filter((b) => b.type === 'subitem')
    expect(subs.map((b) => b.data.label)).toEqual(['Sub one', 'Sub two'])
  })

  it('parents the cloned sub-items under the cloned item2, not the original', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const clonedTwo = copy.find((b) => b.data.label === 'Two')!
    const subs = copy.filter((b) => b.type === 'subitem')
    for (const sub of subs) expect(sub.parent).toBe(clonedTwo.uid)
  })

  it('carries an asset value verbatim, including its key (same R2 object, same media row)', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const clonedTwo = copy.find((b) => b.data.label === 'Two')!
    expect(clonedTwo.data.asset).toEqual(doc.bloks.item2!.data.asset)
  })

  it('carries a story link verbatim, including its id', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const clonedTwo = copy.find((b) => b.data.label === 'Two')!
    expect(clonedTwo.data.link).toEqual({ kind: 'story', id: 'sty_target000' })
  })

  it('carries richtext verbatim, including an internal link mark, unchanged', () => {
    const doc = fixture()
    const copy = cloneSubtree(doc, 'features', { parent: 'root', slot: 'body', order: 'z0' })
    const clonedTwo = copy.find((b) => b.data.label === 'Two')!
    expect(clonedTwo.data.body).toEqual(doc.bloks.item2!.data.body)
  })

  it('terminates over a cyclic document instead of recursing forever', () => {
    // A document written before move's cycle guard existed: `a`'s parent is
    // `b`, and `b`'s parent is `a`.
    const cyclic: Doc = {
      root: 'root',
      bloks: {
        root: blok({ uid: 'root' }),
        a: blok({ uid: 'a', parent: 'b', slot: 's', order: 'a0' }),
        b: blok({ uid: 'b', parent: 'a', slot: 's', order: 'a0' }),
      },
    }
    expect(() =>
      cloneSubtree(cyclic, 'a', { parent: 'root', slot: 'body', order: 'a0' }),
    ).not.toThrow()
  })
})

describe('cloneDoc', () => {
  it('produces a document with the same root type and structure, every uid re-allocated', () => {
    const doc = fixture()
    const clone = cloneDoc(doc)
    expect(clone.bloks[clone.root]!.type).toBe('page')
    expect(Object.keys(clone.bloks)).toHaveLength(Object.keys(doc.bloks).length)
  })

  it('the clone shares no uid with the source', () => {
    const doc = fixture()
    const clone = cloneDoc(doc)
    const originalUids = new Set(Object.keys(doc.bloks))
    for (const uid of Object.keys(clone.bloks)) expect(originalUids.has(uid)).toBe(false)
  })

  it('the clone root has no parent and no slot, like every other document root', () => {
    const doc = fixture()
    const clone = cloneDoc(doc)
    const root = clone.bloks[clone.root]!
    expect(root.parent).toBeNull()
    expect(root.slot).toBeNull()
  })

  it('two clones of the same document share no uid with each other', () => {
    const doc = fixture()
    const first = cloneDoc(doc)
    const second = cloneDoc(doc)
    const firstUids = new Set(Object.keys(first.bloks))
    for (const uid of Object.keys(second.bloks)) expect(firstUids.has(uid)).toBe(false)
  })
})

/**
 * The debt `duplicate-and-paste.md` deferred to `localisation.md`.
 *
 * `i18n` is a **sibling** of `data` on `Blok`, not a key inside it (decision 1),
 * so it has to be named explicitly in the recipe: a `subtreeRecipe` that carried
 * only `data` would have let duplicate, paste and "duplicate this document" each
 * silently drop every translation on the page. These tests are the regression
 * guard for exactly that.
 */
describe('cloneSubtree — translations', () => {
  function translated(): Doc {
    return {
      root: 'root',
      bloks: {
        root: blok({
          uid: 'root',
          type: 'page',
          data: { title: 'About' },
          i18n: { fr: { title: 'À propos' } },
        }),
        hero: blok({
          uid: 'hero',
          type: 'hero',
          parent: 'root',
          slot: 'body',
          order: 'a0',
          data: { heading: 'Hello', sub: 'World' },
          i18n: { fr: { heading: 'Bonjour', sub: '' }, de: { heading: 'Hallo', sub: null } },
        }),
        child: blok({
          uid: 'child',
          type: 'item',
          parent: 'hero',
          slot: 'items',
          order: 'a0',
          data: { label: 'One' },
          i18n: { fr: { label: 'Un' } },
        }),
      },
    }
  }

  it('carries every locale of every blok in the subtree', () => {
    const doc = translated()
    const copy = cloneSubtree(doc, 'hero', { parent: 'root', slot: 'body', order: 'a1' })
    expect(copy).toHaveLength(2)
    expect(copy[0]!.i18n).toEqual({
      fr: { heading: 'Bonjour', sub: '' },
      de: { heading: 'Hallo', sub: null },
    })
    expect(copy[1]!.i18n).toEqual({ fr: { label: 'Un' } })
  })

  it('leaves i18n absent on a copy of a blok that had none', () => {
    const doc = translated()
    delete doc.bloks.hero!.i18n
    const copy = cloneSubtree(doc, 'hero', { parent: 'root', slot: 'body', order: 'a1' })
    expect(copy[0]).not.toHaveProperty('i18n')
  })

  it('carries translations through a whole-document clone, root included', () => {
    const copy = cloneDoc(translated())
    expect(copy.bloks[copy.root]!.i18n).toEqual({ fr: { title: 'À propos' } })
    const values = Object.values(copy.bloks).map((b) => b.i18n)
    expect(values.filter(Boolean)).toHaveLength(3)
  })
})
