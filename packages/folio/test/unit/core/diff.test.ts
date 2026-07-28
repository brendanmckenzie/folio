import { describe, expect, it } from 'vitest'
import { deepEqual, diff, summariseDiff } from '../../../src/core/diff'
import { type Blok, type Doc, type Json, subtree } from '../../../src/core/doc'
import { applyAll } from '../../../src/core/mutations'

// ---------------------------------------------------------------------------
// Doc builders
// ---------------------------------------------------------------------------

const ROOT = 'root'

function blk(uid: string, over: Partial<Blok> = {}): Blok {
  return { uid, type: 'text', parent: ROOT, slot: 'body', order: 'a0', data: {}, ...over }
}

function rootBlk(data: Record<string, Json> = {}): Blok {
  return { uid: ROOT, type: 'page', parent: null, slot: null, order: 'a0', data }
}

/** Doc from an explicit blok list. The first entry is expected to be the root. */
function mkDoc(bloks: Blok[]): Doc {
  const map: Record<string, Blok> = {}
  for (const b of bloks) map[b.uid] = b
  return { root: ROOT, bloks: map }
}

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------

describe('deepEqual', () => {
  it('compares primitives by identity', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(true, true)).toBe(true)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual(1, '1')).toBe(false)
    expect(deepEqual(0, false)).toBe(false)
  })

  it('treats null as unequal to any object or array', () => {
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({}, null)).toBe(false)
    expect(deepEqual(null, [])).toBe(false)
    expect(deepEqual([], null)).toBe(false)
  })

  it('compares arrays element-wise, order and length sensitive', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual([1, 2, 3], [1, 3, 2])).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([], [])).toBe(true)
  })

  it('never equates an array with a plain object', () => {
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual({}, [])).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
  })

  it('recurses through nested arrays and objects', () => {
    expect(deepEqual({ a: [1, { b: [null, 'x'] }] }, { a: [1, { b: [null, 'x'] }] })).toBe(true)
    expect(deepEqual({ a: [1, { b: [null, 'x'] }] }, { a: [1, { b: [null, 'y'] }] })).toBe(false)
    expect(deepEqual([{ a: { b: 1 } }], [{ a: { b: 1 } }])).toBe(true)
  })

  it('distinguishes an explicit null value from an absent key', () => {
    expect(deepEqual({ a: null }, {})).toBe(false)
    expect(deepEqual({}, { a: null })).toBe(false)
    expect(deepEqual({ a: 1, b: null }, { a: 1 })).toBe(false)
    expect(deepEqual({ a: null }, { a: null })).toBe(true)
  })

  it('is key-count sensitive, so a superset is never equal', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false)
  })

  it('ignores key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it('uses === semantics for numeric edge cases', () => {
    // Pins the current (identity-based) behaviour: NaN is not equal to itself,
    // and -0 is equal to 0.
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false)
    expect(deepEqual(0, -0)).toBe(true)
    expect(deepEqual([Number.NaN], [Number.NaN])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// diff — example pins
// ---------------------------------------------------------------------------

describe('diff', () => {
  it('returns nothing for identical documents', () => {
    const doc = mkDoc([
      rootBlk({ title: 'home' }),
      blk('a', { order: 'a1', data: { text: 'hello', meta: { x: [1, 2] } } }),
      blk('b', { order: 'a2', data: { text: 'world' } }),
    ])
    expect(diff(doc, doc)).toEqual([])
    expect(diff(doc, structuredClone(doc))).toEqual([])
  })

  it('refuses to diff documents with different roots', () => {
    const a = mkDoc([rootBlk()])
    const b: Doc = { root: 'other', bloks: { other: { ...rootBlk(), uid: 'other' } } }
    expect(() => diff(a, b)).toThrow(/different roots/)
  })

  it('emits one set per changed field and nothing else for a field-only change', () => {
    const from = mkDoc([
      rootBlk({ title: 'A' }),
      blk('a', { order: 'a1', data: { title: 'one', count: 1 } }),
      blk('b', { order: 'a2', data: { title: 'two' } }),
    ])
    const to = mkDoc([
      rootBlk({ title: 'A' }),
      blk('a', { order: 'a1', data: { title: 'one', count: 2 } }),
      blk('b', { order: 'a2', data: { title: 'two', flag: true } }),
    ])

    const ms = diff(from, to)
    expect(ms).toHaveLength(2)
    expect(ms).toEqual([
      { t: 'set', uid: 'a', field: 'count', value: 2 },
      { t: 'set', uid: 'b', field: 'flag', value: true },
    ])
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('does not emit a set for a deep value that is structurally unchanged', () => {
    const value: Json = { list: [1, { deep: 'x' }], flag: false }
    const from = mkDoc([rootBlk(), blk('a', { data: { meta: value } })])
    const to = mkDoc([rootBlk(), blk('a', { data: { meta: structuredClone(value) } })])
    expect(diff(from, to)).toEqual([])
  })

  it('clears a removed field with an explicit null set', () => {
    // There is no "unset" mutation, so a dropped key round trips as null.
    const from = mkDoc([rootBlk(), blk('a', { data: { title: 'one', count: 1 } })])
    const to = mkDoc([rootBlk(), blk('a', { data: { title: 'one' } })])

    expect(diff(from, to)).toEqual([{ t: 'set', uid: 'a', field: 'count', value: null }])
    expect(applyAll(from, diff(from, to)).bloks.a?.data).toEqual({ title: 'one', count: null })
  })

  it('produces only moves for a reorder, with no inserts', () => {
    const from = mkDoc([
      rootBlk(),
      blk('a', { order: 'a1', data: { t: 'first' } }),
      blk('b', { order: 'a2', data: { t: 'second' } }),
    ])
    const to = mkDoc([
      rootBlk(),
      blk('a', { order: 'a2', data: { t: 'first' } }),
      blk('b', { order: 'a1', data: { t: 'second' } }),
    ])

    const ms = diff(from, to)
    expect(ms).toEqual([
      { t: 'move', uid: 'a', parent: ROOT, slot: 'body', order: 'a2' },
      { t: 'move', uid: 'b', parent: ROOT, slot: 'body', order: 'a1' },
    ])
    expect(ms.some((m) => m.t === 'insert' || m.t === 'remove' || m.t === 'set')).toBe(false)
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('emits a move when only the slot changes', () => {
    const from = mkDoc([rootBlk(), blk('a', { slot: 'body' })])
    const to = mkDoc([rootBlk(), blk('a', { slot: 'aside' })])
    expect(diff(from, to)).toEqual([
      { t: 'move', uid: 'a', parent: ROOT, slot: 'aside', order: 'a0' },
    ])
  })

  it('emits a single remove for a whole removed subtree', () => {
    const from = mkDoc([
      rootBlk(),
      blk('a', { type: 'section' }),
      blk('b', { parent: 'a' }),
      blk('c', { parent: 'b' }),
    ])
    const to = mkDoc([rootBlk()])

    const ms = diff(from, to)
    expect(ms).toEqual([{ t: 'remove', uid: 'a' }])
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('inserts an added subtree parents-first and carries position on the insert', () => {
    const from = mkDoc([rootBlk()])
    const to = mkDoc([
      rootBlk(),
      blk('c', { parent: 'b', order: 'a1', data: { text: 'deep' } }),
      blk('b', { parent: 'a', slot: 'aside', order: 'a1' }),
      blk('a', { type: 'section', order: 'a1' }),
    ])

    const ms = diff(from, to)
    expect(ms.map((m) => (m.t === 'insert' ? m.blok.uid : m.t))).toEqual(['a', 'b', 'c'])
    expect(ms.every((m) => m.t === 'insert')).toBe(true)
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('cannot express a type change, so a type-only edit produces no mutations', () => {
    // Pins a real gap: there is no mutation that rewrites `type`.
    const from = mkDoc([rootBlk(), blk('a', { type: 'text' })])
    const to = mkDoc([rootBlk(), blk('a', { type: 'image' })])
    expect(diff(from, to)).toEqual([])
    expect(applyAll(from, diff(from, to)).bloks.a?.type).toBe('text')
  })

  // SPEC(diff-order): applying diff(from,to) must produce to even when a child is
  // rescued out of a removed subtree. Currently fails: removals are emitted before
  // moves, cascading over the rescued child.
  it.fails('keeps a child that is rescued out of a removed subtree', () => {
    const from = mkDoc([
      rootBlk(),
      blk('s', { type: 'section', order: 'a1' }),
      blk('t', { parent: 's', order: 'a1', data: { text: 'keep me' } }),
    ])
    const to = mkDoc([
      rootBlk(),
      blk('t', { parent: ROOT, slot: 'body', order: 'a1', data: { text: 'keep me' } }),
    ])

    expect(applyAll(from, diff(from, to))).toEqual(to)
  })
})

// ---------------------------------------------------------------------------
// summariseDiff
// ---------------------------------------------------------------------------

describe('summariseDiff', () => {
  it('counts a small mixed change by kind, with edited counted per blok', () => {
    const from = mkDoc([
      rootBlk(),
      blk('a', { order: 'a1', data: { title: 'one', count: 1 } }),
      blk('b', { type: 'section', order: 'a2' }),
      blk('c', { parent: 'b', order: 'a1' }),
    ])
    const to = mkDoc([
      rootBlk(),
      blk('a', { slot: 'aside', order: 'a1', data: { title: 'two', count: 2 } }),
      blk('d', { order: 'a3' }),
    ])

    const ms = diff(from, to)
    expect(summariseDiff(ms)).toEqual({
      added: 1,
      removed: 1,
      moved: 1,
      edited: 1,
      total: 5,
    })
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('reports all zeroes for an empty change set', () => {
    expect(summariseDiff([])).toEqual({ added: 0, removed: 0, moved: 0, edited: 0, total: 0 })
  })
})

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG so every run sees the same cases. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number

function int(rand: Rand, n: number): number {
  return Math.floor(rand() * n)
}

function pick<T>(rand: Rand, xs: readonly T[]): T {
  return xs[int(rand, xs.length)]!
}

const UIDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const FRESH_UIDS = ['n1', 'n2', 'n3'] as const
const TYPES = ['page', 'section', 'text', 'image'] as const
const SLOTS = ['body', 'aside'] as const
const ORDERS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'] as const
const FIELDS = ['title', 'count', 'flag', 'items', 'meta'] as const

/** Never top-level null: null is indistinguishable from an absent field. */
function randValue(rand: Rand): Json {
  switch (int(rand, 6)) {
    case 0:
      return pick(rand, ['alpha', 'beta', 'gamma', ''])
    case 1:
      return int(rand, 100)
    case 2:
      return int(rand, 2) === 0
    case 3:
      return [int(rand, 3), pick(rand, ['x', 'y'])]
    case 4:
      return { k: int(rand, 5), nested: { deep: pick(rand, ['p', 'q']) } }
    default:
      return { list: [1, 2, { z: null }] }
  }
}

function randData(rand: Rand): Record<string, Json> {
  const data: Record<string, Json> = {}
  const n = int(rand, 4)
  for (let i = 0; i < n; i++) data[pick(rand, FIELDS)] = randValue(rand)
  return data
}

function randomDoc(rand: Rand): Doc {
  const bloks: Record<string, Blok> = { [ROOT]: rootBlk(randData(rand)) }
  const placed: string[] = [ROOT]
  const count = int(rand, UIDS.length + 1)
  for (let i = 0; i < count; i++) {
    const uid = UIDS[i]!
    bloks[uid] = {
      uid,
      type: pick(rand, TYPES),
      parent: pick(rand, placed),
      slot: pick(rand, SLOTS),
      order: pick(rand, ORDERS),
      data: randData(rand),
    }
    placed.push(uid)
  }
  return { root: ROOT, bloks }
}

function cloneDoc(doc: Doc): Doc {
  const bloks: Record<string, Blok> = {}
  for (const [uid, b] of Object.entries(doc.bloks)) bloks[uid] = { ...b, data: { ...b.data } }
  return { root: doc.root, bloks }
}

/**
 * Derive `to` from `from` with random edits: subtree removal, subtree addition,
 * reparenting, reordering and field add/change/remove.
 *
 * Removals run first and always take a whole subtree, so no surviving blok is
 * ever left with a removed ancestor. That is the "rescue" shape the engine gets
 * wrong today (see SPEC(diff-order)); the general property has to steer clear of
 * it, and it is covered by an explicit example instead.
 */
function deriveTo(from: Doc, rand: Rand): Doc {
  const to = cloneDoc(from)

  for (let i = int(rand, 3); i > 0; i--) {
    const victims = Object.keys(to.bloks).filter((uid) => uid !== to.root)
    if (victims.length === 0) break
    for (const uid of subtree(to, pick(rand, victims))) delete to.bloks[uid]
  }

  const usable = FRESH_UIDS.filter((uid) => !from.bloks[uid])
  for (let i = int(rand, 4); i > 0; i--) {
    const uid = usable.find((u) => !to.bloks[u])
    if (!uid) break
    to.bloks[uid] = {
      uid,
      type: pick(rand, TYPES),
      parent: pick(rand, Object.keys(to.bloks)),
      slot: pick(rand, SLOTS),
      order: pick(rand, ORDERS),
      data: randData(rand),
    }
  }

  for (let i = int(rand, 4); i > 0; i--) {
    const movable = Object.keys(to.bloks).filter((uid) => uid !== to.root)
    if (movable.length === 0) break
    const uid = pick(rand, movable)
    const banned = new Set(subtree(to, uid))
    const parents = Object.keys(to.bloks).filter((u) => !banned.has(u))
    if (parents.length === 0) continue
    const b = to.bloks[uid]!
    to.bloks[uid] = {
      ...b,
      parent: pick(rand, parents),
      slot: pick(rand, SLOTS),
      order: pick(rand, ORDERS),
    }
  }

  for (let i = int(rand, 5); i > 0; i--) {
    const uid = pick(rand, Object.keys(to.bloks))
    const b = to.bloks[uid]!
    const data = { ...b.data }
    const keys = Object.keys(data)
    if (keys.length > 0 && int(rand, 3) === 0) delete data[pick(rand, keys)]
    else data[pick(rand, FIELDS)] = randValue(rand)
    to.bloks[uid] = { ...b, data }
  }

  return to
}

function isTree(doc: Doc): boolean {
  const b = doc.bloks[doc.root]
  if (!b || b.parent !== null || b.slot !== null) return false
  for (const blok of Object.values(doc.bloks)) {
    if (blok.uid === doc.root) continue
    if (blok.parent === null || blok.slot === null) return false
    if (!doc.bloks[blok.parent]) return false
    let hops = 0
    let cur: string | null = blok.parent
    while (cur !== null && hops <= Object.keys(doc.bloks).length) {
      if (cur === doc.root) break
      cur = doc.bloks[cur]?.parent ?? null
      hops++
    }
    if (cur !== doc.root) return false
  }
  return true
}

/** True when a surviving blok loses a data key, which round trips as null. */
function hasFieldRemoval(from: Doc, to: Doc): boolean {
  for (const [uid, b] of Object.entries(to.bloks)) {
    const prev = from.bloks[uid]
    if (!prev) continue
    for (const k of Object.keys(prev.data)) if (!(k in b.data)) return true
  }
  return false
}

/** Drops null-valued fields so "cleared" and "absent" compare equal. */
function normalise(doc: Doc): Doc {
  const bloks: Record<string, Blok> = {}
  for (const [uid, b] of Object.entries(doc.bloks)) {
    const data: Record<string, Json> = {}
    for (const [k, v] of Object.entries(b.data)) if (v !== null) data[k] = v
    bloks[uid] = { ...b, data }
  }
  return { root: doc.root, bloks }
}

const CASES = 200

function makeCase(seed: number): { from: Doc; to: Doc } {
  const rand = mulberry32(seed)
  const from = randomDoc(rand)
  return { from, to: deriveTo(from, rand) }
}

// ---------------------------------------------------------------------------
// Property: applyAll(from, diff(from, to)) === to
// ---------------------------------------------------------------------------

describe('diff/applyAll round trip (seeded property)', () => {
  it('reproduces `to` for 200 generated document pairs', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { from, to } = makeCase(seed)
      expect(isTree(from), `seed ${seed}: generated \`from\` is not a tree`).toBe(true)
      expect(isTree(to), `seed ${seed}: generated \`to\` is not a tree`).toBe(true)

      const result = applyAll(from, diff(from, to))
      expect(normalise(result), `seed ${seed}: round trip diverged`).toEqual(normalise(to))
      if (!hasFieldRemoval(from, to)) {
        expect(result, `seed ${seed}: round trip diverged (exact)`).toEqual(to)
      }
    }
  })

  it('leaves the source document untouched', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { from, to } = makeCase(seed)
      const before = structuredClone(from)
      applyAll(from, diff(from, to))
      expect(from, `seed ${seed}: from was mutated`).toEqual(before)
    }
  })

  it('exercises every mutation kind across the generated cases', () => {
    const totals = { added: 0, removed: 0, moved: 0, edited: 0, total: 0 }
    let empty = 0
    let fieldRemovals = 0
    for (let seed = 1; seed <= CASES; seed++) {
      const { from, to } = makeCase(seed)
      const s = summariseDiff(diff(from, to))
      totals.added += s.added
      totals.removed += s.removed
      totals.moved += s.moved
      totals.edited += s.edited
      totals.total += s.total
      if (s.total === 0) empty++
      if (hasFieldRemoval(from, to)) fieldRemovals++
    }

    expect(totals.added).toBeGreaterThan(20)
    expect(totals.removed).toBeGreaterThan(20)
    expect(totals.moved).toBeGreaterThan(20)
    expect(totals.edited).toBeGreaterThan(20)
    expect(fieldRemovals).toBeGreaterThan(5)
    expect(empty).toBeLessThan(CASES / 4)
  })
})
