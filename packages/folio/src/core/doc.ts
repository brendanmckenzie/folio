export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * A single block instance. Documents are stored normalized (flat map keyed by
 * uid) rather than as a nested tree, so every mutation touches exactly one
 * entry and structural sharing stays cheap.
 *
 * Position is a fractional index within (parent, slot), not an array index, so
 * two people reordering concurrently never conflict.
 */
export interface Blok {
  uid: string
  type: string
  parent: string | null
  /** Which `blocks()` field of the parent this lives in. */
  slot: string | null
  order: string
  data: Record<string, Json>
}

export interface Doc {
  root: string
  bloks: Record<string, Blok>
}

export function newUid(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function childrenOf(doc: Doc, parent: string, slot: string): Blok[] {
  const out: Blok[] = []
  for (const b of Object.values(doc.bloks)) {
    if (b.parent === parent && b.slot === slot) out.push(b)
  }
  out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return out
}

/** The uid plus every descendant, parents before children. */
export function subtree(doc: Doc, root: string): string[] {
  const out: string[] = []
  const walk = (uid: string) => {
    out.push(uid)
    for (const b of Object.values(doc.bloks)) {
      if (b.parent === uid) walk(b.uid)
    }
  }
  walk(root)
  return out
}

export function ancestorsOf(doc: Doc, uid: string): string[] {
  const out: string[] = []
  let cur = doc.bloks[uid]?.parent
  while (cur) {
    out.push(cur)
    cur = doc.bloks[cur]?.parent
  }
  return out
}
