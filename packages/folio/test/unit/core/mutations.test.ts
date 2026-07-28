import { describe, expect, it } from 'vitest'
import { type Blok, type Doc, type Json, newUid } from '../../../src/core/doc'
import {
  type Mutation,
  apply,
  applyAll,
  invert,
  invertAll,
  mutationError,
} from '../../../src/core/mutations'

const b = (
  uid: string,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
  data: Record<string, Json> = {},
): Blok => ({ uid, type, parent, slot, order, data })

/**
 * root (page)
 *   hero                     body/a0
 *   section                  body/a1
 *     text                   children/a0
 *     col                    children/a1
 *       img                  children/a0
 */
function makeDoc(): Doc {
  return {
    root: 'root',
    bloks: {
      root: b('root', 'page', null, null, 'a0', { title: 'Home' }),
      hero: b('hero', 'hero', 'root', 'body', 'a0', { heading: 'Hello' }),
      section: b('section', 'section', 'root', 'body', 'a1'),
      text: b('text', 'text', 'section', 'children', 'a0', { body: 'one' }),
      col: b('col', 'column', 'section', 'children', 'a1'),
      img: b('img', 'image', 'col', 'children', 'a0', { src: '/a.png' }),
    },
  }
}

/** Structure-only view, safe to build for a cyclic document (never walks the tree). */
const parents = (d: Doc): Record<string, string | null> =>
  Object.fromEntries(Object.values(d.bloks).map((x) => [x.uid, x.parent]))

const uids = (d: Doc): string[] => Object.keys(d.bloks).sort()

const roundTrip = (d: Doc, ms: readonly Mutation[]): Doc =>
  applyAll(applyAll(d, ms), invertAll(d, ms))

describe('apply — set', () => {
  it('writes a new field without touching the rest of the blok', () => {
    const doc = makeDoc()
    const out = apply(doc, { t: 'set', uid: 'text', field: 'align', value: 'left' })
    expect(out.bloks.text!.data).toEqual({ body: 'one', align: 'left' })
    expect(out.bloks.text!.type).toBe('text')
    expect(out.bloks.text!.parent).toBe('section')
    expect(out.bloks.img).toEqual(doc.bloks.img)
  })

  it('overwrites an existing field value', () => {
    const out = apply(makeDoc(), { t: 'set', uid: 'text', field: 'body', value: 'two' })
    expect(out.bloks.text!.data).toEqual({ body: 'two' })
  })

  it('accepts nested json values', () => {
    const value: Json = { a: [1, { b: null }] }
    const out = apply(makeDoc(), { t: 'set', uid: 'section', field: 'cfg', value })
    expect(out.bloks.section!.data.cfg).toEqual({ a: [1, { b: null }] })
  })

  it('is a no-op for an unknown uid', () => {
    const doc = makeDoc()
    expect(apply(doc, { t: 'set', uid: 'nope', field: 'x', value: 1 })).toBe(doc)
  })

  it('does not mutate the input doc', () => {
    const doc = makeDoc()
    apply(doc, { t: 'set', uid: 'text', field: 'body', value: 'two' })
    expect(doc).toEqual(makeDoc())
  })
})

describe('apply — insert', () => {
  it('adds the blok and leaves every other blok untouched', () => {
    const doc = makeDoc()
    const card = b('card', 'card', 'section', 'children', 'a2', { tone: 'dark' })
    const out = apply(doc, { t: 'insert', blok: card })
    expect(out.bloks.card).toEqual(card)
    expect(uids(out)).toEqual(['card', 'col', 'hero', 'img', 'root', 'section', 'text'])
    expect(out.bloks.section).toEqual(doc.bloks.section)
  })

  it('does not mutate the input doc', () => {
    const doc = makeDoc()
    apply(doc, { t: 'insert', blok: b('card', 'card', 'section', 'children', 'a2') })
    expect(doc).toEqual(makeDoc())
  })

  // SPEC(insert-collision): inserting a blok whose uid already exists is a no-op — the
  // incoming blok never replaces the one that is already there.
  it('refuses to insert over an existing uid', () => {
    const doc = makeDoc()
    const collide = b('text', 'quote', 'root', 'body', 'a9', { body: 'clobbered' })
    expect(apply(doc, { t: 'insert', blok: collide })).toEqual(makeDoc())
  })
})

describe('apply — move', () => {
  it('reparents with a new slot and order', () => {
    const out = apply(makeDoc(), {
      t: 'move',
      uid: 'img',
      parent: 'root',
      slot: 'body',
      order: 'a2',
    })
    expect(out.bloks.img).toEqual(b('img', 'image', 'root', 'body', 'a2', { src: '/a.png' }))
  })

  it('reorders within the same parent and slot', () => {
    const out = apply(makeDoc(), {
      t: 'move',
      uid: 'text',
      parent: 'section',
      slot: 'children',
      order: 'a2',
    })
    expect(out.bloks.text!.order).toBe('a2')
    expect(out.bloks.text!.parent).toBe('section')
    expect(out.bloks.col!.order).toBe('a1')
  })

  it('is a no-op for an unknown uid', () => {
    const doc = makeDoc()
    expect(apply(doc, { t: 'move', uid: 'nope', parent: 'root', slot: 'body', order: 'a0' })).toBe(
      doc,
    )
  })

  // SPEC(move-self): a move whose parent is the moved uid itself is a no-op.
  it('refuses to make a blok its own parent', () => {
    const doc = makeDoc()
    const m: Mutation = {
      t: 'move',
      uid: 'section',
      parent: 'section',
      slot: 'children',
      order: 'a0',
    }
    expect(parents(apply(doc, m))).toEqual(parents(doc))
    expect(apply(doc, m)).toEqual(makeDoc())
  })

  // SPEC(move-cycle): moving a node under one of its own descendants is a no-op, so no
  // replay can put a cycle into a document.
  it('refuses to move a node under its own descendant', () => {
    const doc = makeDoc()
    // Deliberately no subtree()/childrenOf() call in here: once the cycle lands they never
    // terminate, so this test asserts on the parents map only and fails cleanly.
    const cycleMove: Mutation = {
      t: 'move',
      uid: 'section',
      parent: 'img',
      slot: 'children',
      order: 'a0',
    }
    expect(parents(applyAll(doc, [cycleMove]))).toEqual(parents(doc))
    expect(applyAll(doc, [cycleMove])).toEqual(makeDoc())
  })

  // SPEC(move-root): giving doc.root a parent is a no-op; the tree always stays anchored.
  it('refuses to give doc.root a parent', () => {
    const doc = makeDoc()
    const m: Mutation = { t: 'move', uid: 'root', parent: 'section', slot: 'children', order: 'a0' }
    expect(parents(apply(doc, m))).toEqual(parents(doc))
    expect(apply(doc, m)).toEqual(makeDoc())
  })

  // SPEC(move-orphan): moving a blok under a parent uid that does not exist is a no-op, so
  // no blok (or subtree) can leak out of the tree as an orphan.
  it('refuses to move a blok under a nonexistent parent', () => {
    const doc = makeDoc()
    const m: Mutation = { t: 'move', uid: 'text', parent: 'ghost', slot: 'children', order: 'a0' }
    expect(apply(doc, m)).toEqual(makeDoc())
  })
})

describe('apply — remove', () => {
  it('removes a leaf blok', () => {
    const out = apply(makeDoc(), { t: 'remove', uid: 'img' })
    expect(uids(out)).toEqual(['col', 'hero', 'root', 'section', 'text'])
  })

  it('cascades over the whole subtree', () => {
    const out = apply(makeDoc(), { t: 'remove', uid: 'section' })
    expect(uids(out)).toEqual(['hero', 'root'])
    expect(out.root).toBe('root')
  })

  it('refuses to remove doc.root', () => {
    const doc = makeDoc()
    expect(apply(doc, { t: 'remove', uid: 'root' })).toBe(doc)
  })

  it('is a no-op for an unknown uid', () => {
    const doc = makeDoc()
    expect(apply(doc, { t: 'remove', uid: 'nope' })).toBe(doc)
  })

  it('does not mutate the input doc', () => {
    const doc = makeDoc()
    apply(doc, { t: 'remove', uid: 'section' })
    expect(doc).toEqual(makeDoc())
  })
})

describe('applyAll', () => {
  it('applies mutations in order, last write winning', () => {
    const out = applyAll(makeDoc(), [
      { t: 'set', uid: 'text', field: 'body', value: 'two' },
      { t: 'set', uid: 'text', field: 'body', value: 'three' },
    ])
    expect(out.bloks.text!.data.body).toBe('three')
  })

  it('inserts then moves the same blok within one transaction', () => {
    const out = applyAll(makeDoc(), [
      { t: 'insert', blok: b('card', 'card', 'section', 'children', 'a2') },
      { t: 'move', uid: 'card', parent: 'col', slot: 'children', order: 'a1' },
    ])
    expect(out.bloks.card).toEqual(b('card', 'card', 'col', 'children', 'a1'))
  })

  it('returns the same doc for an empty transaction', () => {
    const doc = makeDoc()
    expect(applyAll(doc, [])).toBe(doc)
  })
})

describe('invert', () => {
  it('inverts insert to a remove of the same uid', () => {
    const doc = makeDoc()
    const card = b('card', 'card', 'section', 'children', 'a2')
    expect(invert(doc, { t: 'insert', blok: card })).toEqual([{ t: 'remove', uid: 'card' }])
  })

  it('inverts remove into inserts of the whole subtree, parents before children', () => {
    const doc = makeDoc()
    const inv = invert(doc, { t: 'remove', uid: 'section' })
    expect(inv.map((m) => (m.t === 'insert' ? m.blok.uid : m.t))).toEqual([
      'section',
      'text',
      'col',
      'img',
    ])
    expect(inv[0]).toEqual({ t: 'insert', blok: doc.bloks.section })
  })

  it('inverts remove of an unknown uid to nothing', () => {
    expect(invert(makeDoc(), { t: 'remove', uid: 'nope' })).toEqual([])
  })

  it('inverts set to a set of the previous value', () => {
    const doc = makeDoc()
    expect(invert(doc, { t: 'set', uid: 'text', field: 'body', value: 'two' })).toEqual([
      { t: 'set', uid: 'text', field: 'body', value: 'one' },
    ])
  })

  // PIN: a set on a field that was absent inverts to an explicit null rather than to a
  // "delete the field" mutation. That normalisation is deliberate — the mutation vocabulary
  // has no delete-field, and null is the schema's empty value.
  it('inverts a set on an absent field to null', () => {
    const doc = makeDoc()
    expect(invert(doc, { t: 'set', uid: 'text', field: 'align', value: 'left' })).toEqual([
      { t: 'set', uid: 'text', field: 'align', value: null },
    ])
  })

  it('inverts set on an unknown uid to nothing', () => {
    expect(invert(makeDoc(), { t: 'set', uid: 'nope', field: 'x', value: 1 })).toEqual([])
  })

  it('inverts move to a move back to the previous parent, slot and order', () => {
    const doc = makeDoc()
    const m: Mutation = { t: 'move', uid: 'img', parent: 'root', slot: 'body', order: 'a2' }
    expect(invert(doc, m)).toEqual([
      { t: 'move', uid: 'img', parent: 'col', slot: 'children', order: 'a0' },
    ])
  })

  it('inverts move on an unknown uid to nothing', () => {
    const m: Mutation = { t: 'move', uid: 'nope', parent: 'root', slot: 'body', order: 'a0' }
    expect(invert(makeDoc(), m)).toEqual([])
  })

  it('inverts a move of the root to nothing, since it has no parent or slot to restore', () => {
    const m: Mutation = { t: 'move', uid: 'root', parent: 'section', slot: 'children', order: 'a0' }
    expect(invert(makeDoc(), m)).toEqual([])
  })

  it('returns an empty inverse for an empty transaction', () => {
    expect(invertAll(makeDoc(), [])).toEqual([])
  })

  it('inverts a transaction in reverse order', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'set', uid: 'text', field: 'body', value: 'two' },
      { t: 'insert', blok: b('card', 'card', 'section', 'children', 'a2') },
    ]
    expect(invertAll(doc, ms)).toEqual([
      { t: 'remove', uid: 'card' },
      { t: 'set', uid: 'text', field: 'body', value: 'one' },
    ])
  })
})

describe('invertAll round trip', () => {
  it('round trips a transaction of inserts', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'insert', blok: b('card', 'card', 'section', 'children', 'a2') },
      { t: 'insert', blok: b('badge', 'badge', 'card', 'children', 'a0', { label: 'new' }) },
    ]
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  it('round trips a transaction of sets over existing fields', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'set', uid: 'root', field: 'title', value: 'Away' },
      { t: 'set', uid: 'text', field: 'body', value: 'two' },
      { t: 'set', uid: 'hero', field: 'heading', value: 'Goodbye' },
      { t: 'set', uid: 'text', field: 'body', value: 'three' },
    ]
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  it('round trips a transaction of moves', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'move', uid: 'img', parent: 'root', slot: 'body', order: 'a2' },
      { t: 'move', uid: 'text', parent: 'col', slot: 'children', order: 'a0' },
      { t: 'move', uid: 'img', parent: 'section', slot: 'children', order: 'a0V' },
    ]
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  it('round trips a remove of a nested subtree', () => {
    const doc = makeDoc()
    expect(roundTrip(doc, [{ t: 'remove', uid: 'section' }])).toEqual(makeDoc())
  })

  it('round trips a move followed by a remove of the old parent', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'move', uid: 'img', parent: 'root', slot: 'body', order: 'a2' },
      { t: 'remove', uid: 'col' },
    ]
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  it('round trips a mixed insert, set, move and remove transaction', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'insert', blok: b('quote', 'quote', 'col', 'children', 'a1') },
      { t: 'set', uid: 'quote', field: 'text', value: 'hi' },
      { t: 'move', uid: 'hero', parent: 'section', slot: 'children', order: 'a0V' },
      { t: 'remove', uid: 'text' },
    ]
    const applied = applyAll(doc, ms)
    expect(uids(applied)).toEqual(['col', 'hero', 'img', 'quote', 'root', 'section'])
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  it('round trips a transaction containing a refused remove of the root', () => {
    const doc = makeDoc()
    const ms: Mutation[] = [
      { t: 'remove', uid: 'root' },
      { t: 'remove', uid: 'hero' },
      { t: 'set', uid: 'root', field: 'title', value: 'Away' },
    ]
    expect(roundTrip(doc, ms)).toEqual(makeDoc())
  })

  // PIN: the one asymmetry in the round trip. A set that creates a field inverts to
  // `null` rather than removing it, so the field survives the undo holding null.
  it('leaves a field it created as null after a round trip', () => {
    const doc = makeDoc()
    const out = roundTrip(doc, [{ t: 'set', uid: 'text', field: 'align', value: 'left' }])
    expect(out.bloks.text!.data).toEqual({ body: 'one', align: null })
    expect(out).not.toEqual(makeDoc())
  })
})

/**
 * The reason strings are the DO's `reject { txId, reason }` payload, so each
 * violation has to be nameable. Matched loosely: the wording is not the contract.
 */
describe('mutationError', () => {
  const doc = makeDoc()

  it('names each structural violation', () => {
    expect(
      mutationError(doc, { t: 'insert', blok: b('text', 'quote', 'root', 'body', 'a9') }),
    ).toMatch(/duplicate uid/)
    expect(
      mutationError(doc, {
        t: 'move',
        uid: 'root',
        parent: 'section',
        slot: 'children',
        order: 'a0',
      }),
    ).toMatch(/root move/)
    expect(
      mutationError(doc, {
        t: 'move',
        uid: 'section',
        parent: 'section',
        slot: 'children',
        order: 'a0',
      }),
    ).toMatch(/self-parent/)
    expect(
      mutationError(doc, {
        t: 'move',
        uid: 'text',
        parent: 'ghost',
        slot: 'children',
        order: 'a0',
      }),
    ).toMatch(/missing parent/)
    expect(
      mutationError(doc, {
        t: 'move',
        uid: 'section',
        parent: 'img',
        slot: 'children',
        order: 'a0',
      }),
    ).toMatch(/cycle/)
    expect(mutationError(doc, { t: 'remove', uid: 'root' })).toMatch(/root remove/)
    expect(mutationError(doc, { t: 'nonsense' } as unknown as Mutation)).toMatch(/unknown kind/)
  })

  it('accepts every mutation that applies, and every plain no-op', () => {
    const ok: Mutation[] = [
      { t: 'set', uid: 'text', field: 'body', value: 'two' },
      { t: 'insert', blok: b('card', 'card', 'section', 'children', 'a2') },
      { t: 'move', uid: 'img', parent: 'root', slot: 'body', order: 'a2' },
      { t: 'remove', uid: 'section' },
    ]
    for (const m of ok) expect(mutationError(doc, m)).toBeNull()

    // A mutation aimed at a uid this document does not have is an ordinary no-op,
    // not a violation: rejecting a whole tx over one would make a peer's remove
    // start refusing everybody's edits.
    const absent: Mutation[] = [
      { t: 'set', uid: 'nope', field: 'x', value: 1 },
      { t: 'move', uid: 'nope', parent: 'root', slot: 'body', order: 'a0' },
      { t: 'remove', uid: 'nope' },
    ]
    for (const m of absent) expect(mutationError(doc, m)).toBeNull()
  })
})

describe('newUid', () => {
  // PIN: 16 hex chars (64 bits). 8 chars collided at ~77k ids, which insert-collision turns
  // from a silent overwrite into a refusal; the width is what stops it happening at all.
  it('returns 16 lowercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(newUid()).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  // Uids written at 8 chars stay valid: nothing parses a uid, everything compares it.
  it('keeps accepting an 8-char uid everywhere a uid is used', () => {
    const doc: Doc = {
      root: 'root',
      bloks: {
        root: b('root', 'page', null, null, 'a0'),
        deadbeef: b('deadbeef', 'text', 'root', 'body', 'a0'),
      },
    }
    const out = apply(doc, {
      t: 'move',
      uid: 'deadbeef',
      parent: 'root',
      slot: 'body',
      order: 'a1',
    })
    expect(out.bloks.deadbeef!.order).toBe('a1')
  })

  it('does not repeat across a small sample', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newUid()))
    expect(seen.size).toBe(200)
  })
})
