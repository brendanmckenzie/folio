import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

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
  /**
   * The **source locale's** field values (`localisation.md` architecture
   * decision 1). Unchanged by localisation, and deliberately not a special case
   * of `i18n` below: writing the source into `i18n[default]` as well would mean
   * two places to read a default from, and the first time they disagreed
   * nothing could say which was authoritative.
   */
  data: Record<string, Json>
  /**
   * Per-locale overrides, by locale code then field name. An **absent key means
   * untranslated** and falls back; an explicit `''` means deliberately empty and
   * does not (decision 5). `null` reads as untranslated, which is how
   * "untranslate this field" is expressible at all — the mutation vocabulary has
   * no delete-key.
   *
   * Optional, so every document written before locales existed is already valid
   * and a single-locale site never grows the field. Read it through
   * `fieldValue` (core/locales.ts), never directly.
   */
  i18n?: Record<string, Record<string, Json>>
}

export interface Doc {
  root: string
  bloks: Record<string, Blok>
}

/**
 * 16 hex chars of full entropy (64 bits). 32 bits collided at ~77k ids, and a
 * collision meant an insert replacing an unrelated blok; uuid slices were the old
 * source and waste bits on a version nibble. Uids written at 8 chars stay valid:
 * nothing parses a uid, everything compares it.
 */
export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Sibling order: fractional key first, uid as the tiebreak.
 *
 * Two clients inserting between the same neighbours can generate the same key.
 * Without the tiebreak the comparator returns 0 and the rendered sequence falls
 * back to object/array insertion order, which differs per client. Story rows
 * (ord, id) sort through here too, so the tree and the document agree.
 */
export function compareSiblings(
  aOrder: string,
  aUid: string,
  bOrder: string,
  bUid: string,
): number {
  if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1
  if (aUid === bUid) return 0
  return aUid < bUid ? -1 : 1
}

/**
 * Fractional key placing a new sibling at `index` among `keys`, which must already
 * be sorted by `compareSiblings`.
 *
 * The write half of the tie rule. `generateKeyBetween` throws when its two bounds
 * are equal, and equal keys are reachable by design — two clients inserting between
 * the same neighbours produce the same key, and the tiebreak makes that render.
 * Rendering a tie is no use if the next drop next to it throws out of a click
 * handler, so a tied run is treated as one position and the new key lands after it:
 * strictly between two equal keys is not a representable place.
 */
export function keyAtIndex(keys: readonly string[], index: number): string {
  const at = index < 0 ? 0 : index > keys.length ? keys.length : index
  const before = at > 0 ? keys[at - 1]! : null
  let after = at
  while (after < keys.length && keys[after] === before) after++
  return generateKeyBetween(before, keys[after] ?? null)
}

/**
 * `n` fractional keys strictly between `before` and `after`, in order.
 *
 * The plural of `keyAtIndex`, for a caller that already knows a whole run of new
 * siblings goes into one gap — `../../docs/specs/platform/content-api.md`'s
 * `fromNested`, which keeps the sibling keys it can and fills the gaps between
 * them. Generating them one at a time would work but would re-derive the same
 * bounds `n` times and, worse, would have to thread each new key back into the
 * sorted list to find the next gap.
 *
 * The same tie rule `keyAtIndex` documents applies: `generateNKeysBetween`
 * throws when its bounds are equal or inverted, and equal keys are reachable by
 * design, so a degenerate pair is treated as "after `before`" rather than
 * "strictly between two equal keys", which is not a representable place.
 */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  if (n <= 0) return []
  const upper = before !== null && after !== null && before >= after ? null : after
  return generateNKeysBetween(before, upper, n)
}

export function childrenOf(doc: Doc, parent: string, slot: string): Blok[] {
  const out: Blok[] = []
  for (const b of Object.values(doc.bloks)) {
    if (b.parent === parent && b.slot === slot) out.push(b)
  }
  out.sort((a, b) => compareSiblings(a.order, a.uid, b.order, b.uid))
  return out
}

/**
 * The uid plus every descendant, parents before children.
 *
 * `visited` makes the walk total over a cyclic document. Logs written before
 * `apply` refused cycles can still contain one, and a replay of such a log must
 * degrade (visit each blok once) rather than recurse forever.
 */
export function subtree(doc: Doc, root: string, visited = new Set<string>()): string[] {
  const out: string[] = []
  const walk = (uid: string) => {
    if (visited.has(uid)) return
    visited.add(uid)
    out.push(uid)
    for (const b of Object.values(doc.bloks)) {
      if (b.parent === uid) walk(b.uid)
    }
  }
  walk(root)
  return out
}

/** Immediate parent up to the root. Terminates on a cyclic document; see `subtree`. */
export function ancestorsOf(doc: Doc, uid: string, visited = new Set<string>()): string[] {
  const out: string[] = []
  visited.add(uid)
  let cur = doc.bloks[uid]?.parent
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    out.push(cur)
    cur = doc.bloks[cur]?.parent
  }
  return out
}
