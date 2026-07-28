import { type Blok, type Doc, type Json, subtree } from './doc'

/**
 * Every edit in the system is one of these. Nothing writes to a document
 * directly, which is what makes undo, sync and multiplayer the same machinery.
 */
export type Mutation =
  | { t: 'set'; uid: string; field: string; value: Json }
  | { t: 'insert'; blok: Blok }
  | { t: 'move'; uid: string; parent: string; slot: string; order: string }
  | { t: 'remove'; uid: string }

export function apply(doc: Doc, m: Mutation): Doc {
  switch (m.t) {
    case 'set': {
      const b = doc.bloks[m.uid]
      if (!b) return doc
      return {
        ...doc,
        bloks: { ...doc.bloks, [m.uid]: { ...b, data: { ...b.data, [m.field]: m.value } } },
      }
    }
    case 'insert': {
      return { ...doc, bloks: { ...doc.bloks, [m.blok.uid]: m.blok } }
    }
    case 'move': {
      const b = doc.bloks[m.uid]
      if (!b) return doc
      return {
        ...doc,
        bloks: { ...doc.bloks, [m.uid]: { ...b, parent: m.parent, slot: m.slot, order: m.order } },
      }
    }
    case 'remove': {
      if (!doc.bloks[m.uid] || m.uid === doc.root) return doc
      const doomed = new Set(subtree(doc, m.uid))
      const bloks: Record<string, Blok> = {}
      for (const [uid, b] of Object.entries(doc.bloks)) {
        if (!doomed.has(uid)) bloks[uid] = b
      }
      return { ...doc, bloks }
    }
  }
}

export function applyAll(doc: Doc, ms: readonly Mutation[]): Doc {
  return ms.reduce(apply, doc)
}

/**
 * The mutations that undo `m`. Must be computed against the document as it was
 * *before* `m` was applied.
 */
export function invert(doc: Doc, m: Mutation): Mutation[] {
  switch (m.t) {
    case 'set': {
      const b = doc.bloks[m.uid]
      if (!b) return []
      return [{ t: 'set', uid: m.uid, field: m.field, value: b.data[m.field] ?? null }]
    }
    case 'insert':
      return [{ t: 'remove', uid: m.blok.uid }]
    case 'move': {
      const b = doc.bloks[m.uid]
      if (!b || b.parent === null || b.slot === null) return []
      return [{ t: 'move', uid: m.uid, parent: b.parent, slot: b.slot, order: b.order }]
    }
    case 'remove': {
      const b = doc.bloks[m.uid]
      if (!b) return []
      // Re-insert the whole subtree, parents first so children always land on
      // an existing parent.
      return subtree(doc, m.uid).map((uid) => ({ t: 'insert', blok: doc.bloks[uid]! }))
    }
  }
}

/** Inverse of a transaction: invert each mutation against the state it saw, then reverse. */
export function invertAll(doc: Doc, ms: readonly Mutation[]): Mutation[] {
  const inverses: Mutation[][] = []
  let cursor = doc
  for (const m of ms) {
    inverses.push(invert(cursor, m))
    cursor = apply(cursor, m)
  }
  return inverses.reverse().flat()
}
