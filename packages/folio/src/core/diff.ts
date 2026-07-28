import type { Blok, Doc, Json } from './doc'
import type { Mutation } from './mutations'

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]!))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => k in b && deepEqual(a[k]!, (b as Record<string, Json>)[k]!))
}

/**
 * Mutations that turn `from` into `to`.
 *
 * This is what makes restoring a version an ordinary transaction rather than an
 * overwrite: the result goes through the same sync engine as a keystroke, so it
 * reaches other editors, and it is itself undoable.
 *
 * Both documents must share a root uid. They always do for a given story, since
 * the root block is created once and never replaced.
 */
export function diff(from: Doc, to: Doc): Mutation[] {
  if (from.root !== to.root) {
    throw new Error('Cannot diff documents with different roots')
  }

  const inserts: Mutation[] = []
  const moves: Mutation[] = []
  const sets: Mutation[] = []
  const removes: Mutation[] = []

  // 1. Insertions, parents before children so a child never lands on a missing
  //    parent. Inserted bloks carry their own parent/slot/order, so they need no
  //    follow-up move.
  const added = Object.values(to.bloks).filter((b) => !from.bloks[b.uid])
  const addedIds = new Set(added.map((b) => b.uid))
  const emitted = new Set<string>()
  const emitInsert = (blok: Blok) => {
    if (emitted.has(blok.uid)) return
    emitted.add(blok.uid)
    if (blok.parent && addedIds.has(blok.parent)) emitInsert(to.bloks[blok.parent]!)
    inserts.push({ t: 'insert', blok })
  }
  for (const blok of added) emitInsert(blok)

  // 2. Surviving bloks: reposition, then field values.
  for (const blok of Object.values(to.bloks)) {
    const prev = from.bloks[blok.uid]
    if (!prev) continue

    const moved =
      prev.parent !== blok.parent || prev.slot !== blok.slot || prev.order !== blok.order
    // The root has no parent and never moves.
    if (moved && blok.parent !== null && blok.slot !== null) {
      moves.push({
        t: 'move',
        uid: blok.uid,
        parent: blok.parent,
        slot: blok.slot,
        order: blok.order,
      })
    }

    for (const field of new Set([...Object.keys(prev.data), ...Object.keys(blok.data)])) {
      const before = prev.data[field] ?? null
      const after = blok.data[field] ?? null
      if (!deepEqual(before, after)) {
        sets.push({ t: 'set', uid: blok.uid, field, value: after })
      }
    }
  }

  // Shallowest target first. Two bloks swapping parents can only be expressed as
  // two moves, and taking them in any other order asks `apply` for a transient
  // cycle, which it refuses. By the time a blok moves, every ancestor it will
  // have is already in its final place, so the moved blok cannot be among them.
  const depth = depthsIn(to)
  const depthOf = (m: Mutation) => depth.get(uidOf(m)) ?? Number.MAX_SAFE_INTEGER
  moves.sort((a, b) => depthOf(a) - depthOf(b))

  // 3. Removals last. `remove` cascades over the *live* subtree, so anything the
  //    diff meant to rescue has to have moved out already; only the topmost of
  //    each removed subtree is emitted, the cascade covers the rest.
  const removed = new Set(Object.keys(from.bloks).filter((uid) => !to.bloks[uid]))
  for (const uid of removed) {
    const parent = from.bloks[uid]!.parent
    if (parent && removed.has(parent)) continue
    removes.push({ t: 'remove', uid })
  }

  return [...inserts, ...moves, ...sets, ...removes]
}

const uidOf = (m: Mutation): string => (m.t === 'insert' ? m.blok.uid : m.uid)

/** Distance from the root, for every blok that reaches it. Unrooted uids are absent. */
function depthsIn(doc: Doc): Map<string, number> {
  const out = new Map<string, number>([[doc.root, 0]])
  const walk = (uid: string, seen: Set<string>): number | null => {
    const cached = out.get(uid)
    if (cached !== undefined) return cached
    const parent = doc.bloks[uid]?.parent
    if (!parent || seen.has(uid)) return null
    seen.add(uid)
    const above = walk(parent, seen)
    if (above === null) return null
    out.set(uid, above + 1)
    return above + 1
  }
  for (const uid of Object.keys(doc.bloks)) walk(uid, new Set())
  return out
}

/** Rough shape of a change set, for "this will change 3 blocks" style summaries. */
export function summariseDiff(mutations: readonly Mutation[]) {
  return {
    added: mutations.filter((m) => m.t === 'insert').length,
    removed: mutations.filter((m) => m.t === 'remove').length,
    moved: mutations.filter((m) => m.t === 'move').length,
    edited: new Set(mutations.filter((m) => m.t === 'set').map((m) => m.uid)).size,
    total: mutations.length,
  }
}
