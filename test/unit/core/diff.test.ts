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

  /**
   * This test used to pin the *gap* — "there is no mutation that rewrites
   * `type`, so a type-only edit produces nothing". `schema-migrations.md`
   * closes it, and the reason it had to be closed here rather than only in
   * `mutations.ts` is version restore: a restore is `diff(live, target)`, so a
   * diff that could not see a type change would restore the fields and leave
   * the old type behind.
   */
  it('emits a retype for a surviving uid whose type changed', () => {
    const from = mkDoc([rootBlk(), blk('a', { type: 'text' })])
    const to = mkDoc([rootBlk(), blk('a', { type: 'image' })])
    expect(diff(from, to)).toEqual([{ t: 'retype', uid: 'a', type: 'image' }])
    expect(applyAll(from, diff(from, to))).toEqual(to)
  })

  it('orders a retype after the moves and before the removes, alongside the sets', () => {
    const from = mkDoc([
      rootBlk(),
      blk('a', { type: 'text', order: 'a1', data: { body: 'one' } }),
      blk('gone', { order: 'a2' }),
    ])
    const to = mkDoc([
      rootBlk(),
      blk('a', { type: 'image', slot: 'aside', order: 'a1', data: { body: 'two' } }),
      blk('new', { order: 'a3' }),
    ])

    expect(diff(from, to).map((m) => m.t)).toEqual(['insert', 'move', 'retype', 'set', 'remove'])
    expect(applyAll(from, diff(from, to))).toEqual(to)
  })

  /**
   * `mutationError` refuses retyping the root, so emitting one would put a
   * guaranteed rejection into a transaction the caller has no way to fix. A
   * document's root type is its *document* type; changing it is a `stories.type`
   * update in the same breath, which `schema-migrations.md` puts out of scope.
   */
  it('never emits a retype for the root, even when the root type differs', () => {
    const from = mkDoc([rootBlk()])
    const to: typeof from = {
      ...from,
      bloks: { ...from.bloks, [ROOT]: { ...from.bloks[ROOT]!, type: 'insightPage' } },
    }
    expect(diff(from, to)).toEqual([])
  })

  // SPEC(diff-order): applying diff(from,to) produces to even when a child is rescued out
  // of a removed subtree — removals are emitted last, after the moves that carry the
  // survivors out of them.
  it('keeps a child that is rescued out of a removed subtree', () => {
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
      retyped: 0,
      edited: 1,
      translated: 0,
      locales: [],
      total: 5,
    })
    expect(applyAll(from, ms)).toEqual(to)
  })

  it('counts retypes separately from the field edits that accompany them', () => {
    const from = mkDoc([rootBlk(), blk('a', { type: 'bigQuote', data: { text: 'hi' } })])
    const to = mkDoc([rootBlk(), blk('a', { type: 'quote', data: { text: 'hi', size: 'large' } })])
    expect(summariseDiff(diff(from, to))).toEqual({
      added: 0,
      removed: 0,
      moved: 0,
      retyped: 1,
      edited: 1,
      translated: 0,
      locales: [],
      total: 2,
    })
  })

  it('reports all zeroes for an empty change set', () => {
    expect(summariseDiff([])).toEqual({
      added: 0,
      removed: 0,
      moved: 0,
      retyped: 0,
      edited: 0,
      translated: 0,
      locales: [],
      total: 0,
    })
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
 * A removal may rescue descendants out of the doomed subtree instead of taking
 * them with it, which is the shape `diff(live, target)` hits whenever a restore
 * keeps a block its old parent no longer holds. It is the whole reason removals
 * are emitted last, so the property has to generate it.
 */
function deriveTo(from: Doc, rand: Rand): Doc {
  const to = cloneDoc(from)

  for (let i = int(rand, 3); i > 0; i--) {
    const victims = Object.keys(to.bloks).filter((uid) => uid !== to.root)
    if (victims.length === 0) break
    const condemned = subtree(to, pick(rand, victims))
    const doomed = new Set(condemned)
    // Top-down, so rescuing a node takes its own descendants out of the doomed
    // set with it and they are not offered again.
    for (const uid of condemned.slice(1)) {
      if (!doomed.has(uid) || int(rand, 3) !== 0) continue
      const kin = new Set(subtree(to, uid))
      const hosts = Object.keys(to.bloks).filter((u) => !doomed.has(u) && !kin.has(u))
      if (hosts.length === 0) continue
      for (const k of kin) doomed.delete(k)
      to.bloks[uid] = {
        ...to.bloks[uid]!,
        parent: pick(rand, hosts),
        slot: pick(rand, SLOTS),
        order: pick(rand, ORDERS),
      }
    }
    for (const uid of doomed) delete to.bloks[uid]
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

  // Type changes on surviving bloks — `retype`'s shape, and the reason it had
  // to reach `diff` at all rather than only `mutations.ts`. Never the root:
  // `mutationError` refuses retyping it, so `diff` must not emit one.
  for (let i = int(rand, 3); i > 0; i--) {
    const changeable = Object.keys(to.bloks).filter((uid) => uid !== to.root)
    if (changeable.length === 0) break
    const uid = pick(rand, changeable)
    to.bloks[uid] = { ...to.bloks[uid]!, type: pick(rand, TYPES) }
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

/**
 * True when a blok survives into `to` out of a subtree `from` no longer has: the
 * rescue shape, which only lands if the diff moves it before the cascade.
 */
function hasRescue(from: Doc, to: Doc): boolean {
  for (const uid of Object.keys(to.bloks)) {
    if (!from.bloks[uid]) continue
    let cur = from.bloks[uid]!.parent
    while (cur) {
      if (!to.bloks[cur]) return true
      cur = from.bloks[cur]?.parent ?? null
    }
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

const CASES = 300

function makeCase(seed: number): { from: Doc; to: Doc } {
  const rand = mulberry32(seed)
  const from = randomDoc(rand)
  return { from, to: deriveTo(from, rand) }
}

// ---------------------------------------------------------------------------
// Property: applyAll(from, diff(from, to)) === to
// ---------------------------------------------------------------------------

describe('diff/applyAll round trip (seeded property)', () => {
  it('reproduces `to` for 300 generated document pairs', () => {
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
    const totals = { added: 0, removed: 0, moved: 0, retyped: 0, edited: 0, total: 0 }
    let empty = 0
    let fieldRemovals = 0
    let rescues = 0
    for (let seed = 1; seed <= CASES; seed++) {
      const { from, to } = makeCase(seed)
      const s = summariseDiff(diff(from, to))
      totals.added += s.added
      totals.removed += s.removed
      totals.moved += s.moved
      totals.retyped += s.retyped
      totals.edited += s.edited
      totals.total += s.total
      if (s.total === 0) empty++
      if (hasFieldRemoval(from, to)) fieldRemovals++
      if (hasRescue(from, to)) rescues++
    }

    expect(totals.added).toBeGreaterThan(20)
    expect(totals.removed).toBeGreaterThan(20)
    expect(totals.moved).toBeGreaterThan(20)
    expect(totals.retyped).toBeGreaterThan(20)
    expect(totals.edited).toBeGreaterThan(20)
    expect(fieldRemovals).toBeGreaterThan(5)
    // Rescues are the shape the emission order exists for; without them the
    // property would pass on a diff that emits removals first.
    expect(rescues).toBeGreaterThan(5)
    expect(empty).toBeLessThan(CASES / 4)
  })
})

// ---------------------------------------------------------------------------
// Locale maps (`localisation.md` architecture decision 2)
// ---------------------------------------------------------------------------

/**
 * Without this walk a version restore would silently drop the translations the
 * target version had, or leave behind ones it never did — the document would come
 * back in the right language and the wrong content. Every case below is a restore
 * that used to be wrong.
 */
describe('diff over locale maps', () => {
  const withI18n = (uid: string, data: Record<string, Json>, i18n?: Blok['i18n']): Blok => ({
    ...blk(uid, { data }),
    ...(i18n ? { i18n } : {}),
  })

  it('emits a locale-scoped set for a changed translation', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: 'Salut' } })])
    const to = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: 'Bonjour' } })])
    expect(diff(from, to)).toEqual([
      { t: 'set', uid: 'a', field: 't', value: 'Bonjour', locale: 'fr' },
    ])
    expect(applyAll(from, diff(from, to))).toEqual(to)
  })

  it('emits nothing when only the source changed', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: 'Bonjour' } })])
    const to = mkDoc([rootBlk(), withI18n('a', { t: 'Hi' }, { fr: { t: 'Bonjour' } })])
    expect(diff(from, to)).toEqual([{ t: 'set', uid: 'a', field: 't', value: 'Hi' }])
  })

  it('emits a whole map for a locale that appears', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello', u: 'World' })])
    const to = mkDoc([
      rootBlk(),
      withI18n('a', { t: 'Hello', u: 'World' }, { fr: { t: 'Bonjour', u: 'Monde' } }),
    ])
    expect(diff(from, to)).toEqual([
      { t: 'set', uid: 'a', field: 't', value: 'Bonjour', locale: 'fr' },
      { t: 'set', uid: 'a', field: 'u', value: 'Monde', locale: 'fr' },
    ])
    expect(applyAll(from, diff(from, to))).toEqual(to)
  })

  /**
   * Clearing rather than deleting: the vocabulary has no delete-key mutation, so
   * a locale the target version did not have is nulled out. `fieldValue` reads null
   * and absent identically, so the restored document renders as the target did.
   */
  it('clears a locale that disappears, to null rather than to empty string', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: 'Bonjour' } })])
    const to = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' })])
    expect(diff(from, to)).toEqual([{ t: 'set', uid: 'a', field: 't', value: null, locale: 'fr' }])
  })

  it('touches only the locale that changed', () => {
    const from = mkDoc([
      rootBlk(),
      withI18n('a', { t: 'Hello' }, { fr: { t: 'Salut' }, de: { t: 'Hallo' } }),
    ])
    const to = mkDoc([
      rootBlk(),
      withI18n('a', { t: 'Hello' }, { fr: { t: 'Bonjour' }, de: { t: 'Hallo' } }),
    ])
    expect(diff(from, to)).toEqual([
      { t: 'set', uid: 'a', field: 't', value: 'Bonjour', locale: 'fr' },
    ])
  })

  it('reads a null translation and an absent one as the same thing', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' })])
    const to = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: null } })])
    expect(diff(from, to)).toEqual([])
    expect(diff(to, from)).toEqual([])
  })

  it('distinguishes an empty translation from an absent one', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' })])
    const to = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: '' } })])
    expect(diff(from, to)).toEqual([{ t: 'set', uid: 'a', field: 't', value: '', locale: 'fr' }])
  })

  it('carries translations on an inserted blok rather than as follow-up sets', () => {
    const from = mkDoc([rootBlk()])
    const added = withI18n('a', { t: 'Hello' }, { fr: { t: 'Bonjour' } })
    const to = mkDoc([rootBlk(), added])
    expect(diff(from, to)).toEqual([{ t: 'insert', blok: added }])
    expect(applyAll(from, diff(from, to))).toEqual(to)
  })

  it('counts locale sets separately from source edits, and names the locales', () => {
    const from = mkDoc([rootBlk(), withI18n('a', { t: 'Hello' }, { fr: { t: 'Salut' } })])
    const to = mkDoc([
      rootBlk(),
      withI18n('a', { t: 'Hi' }, { fr: { t: 'Bonjour' }, de: { t: 'Hallo' } }),
    ])
    const s = summariseDiff(diff(from, to))
    expect(s.edited).toBe(1)
    expect(s.translated).toBe(2)
    expect(s.locales).toEqual(['de', 'fr'])
  })

  it('reports no translations for a diff that touches none', () => {
    const from = mkDoc([rootBlk({ title: 'a' })])
    const to = mkDoc([rootBlk({ title: 'b' })])
    expect(summariseDiff(diff(from, to))).toMatchObject({ translated: 0, locales: [] })
  })
})
