import { ancestorsOf, type Blok, type Doc, type Json, subtree } from './doc'

/**
 * Every edit in the system is one of these. Nothing writes to a document
 * directly, which is what makes undo, sync and multiplayer the same machinery.
 */
export type Mutation =
  /**
   * Writes one field value. **An absent `locale` is a source-locale write, and
   * it means that permanently** (`localisation.md` architecture decision 2): the
   * log outlives every deploy, so every `set` written before locales existed has
   * to keep meaning what it meant, which is why the locale is an optional
   * addition rather than a required field with a default spelled somewhere.
   *
   * With a locale it writes `blok.i18n[locale][field]`, creating the maps as
   * needed. Setting a locale value to `undefined` is not expressible (`isMutation`
   * requires `value` to be *present*), so "untranslate this" is an explicit
   * `{ locale, value: null }` — and `fieldValue` reads null as untranslated while
   * `''` stays deliberately empty.
   */
  | { t: 'set'; uid: string; field: string; value: Json; locale?: string }
  | { t: 'insert'; blok: Blok }
  | { t: 'move'; uid: string; parent: string; slot: string; order: string }
  | { t: 'remove'; uid: string }
  /**
   * Changes a blok's *type*, keeping its uid, its position and its children
   * (`schema-migrations.md` architecture decision 3). The only edit the
   * vocabulary could not express: `insert` refuses a duplicate uid and `remove`
   * cascades over the subtree, so "remove and re-insert as another type" is not
   * a transaction that can be written.
   *
   * Field data is deliberately untouched. A retype that needs fields added or
   * dropped emits `set` mutations alongside it, which is why `block.retype`
   * (core/migrate.ts) returns several mutations rather than one.
   */
  | { t: 'retype'; uid: string; type: string }

/**
 * Why `m` cannot be applied to `doc`, or null when it can. Naming the violation
 * is what lets the Durable Object answer an invalid transaction with a reason
 * instead of silently dropping it.
 *
 * A mutation that targets a uid the document does not have is not a violation:
 * it is an ordinary no-op, and rejecting a whole transaction over one is how a
 * legitimate concurrent remove would start refusing everyone's edits.
 *
 * Cost matters — this runs per mutation over a whole log replay — so the cycle
 * check walks ancestors (O(depth)) rather than the moved subtree (O(n)).
 */
export function mutationError(doc: Doc, m: Mutation): string | null {
  switch (m.t) {
    case 'set':
      return null
    case 'insert':
      return doc.bloks[m.blok.uid] ? `duplicate uid: ${m.blok.uid} already exists` : null
    case 'move': {
      if (!doc.bloks[m.uid]) return null
      if (m.uid === doc.root) return 'root move: the root cannot be given a parent'
      if (m.uid === m.parent) return 'self-parent: a blok cannot be its own parent'
      if (!doc.bloks[m.parent]) return `missing parent: ${m.parent} does not exist`
      if (ancestorsOf(doc, m.parent).includes(m.uid)) {
        return `cycle: ${m.parent} is a descendant of ${m.uid}`
      }
      return null
    }
    case 'remove':
      return m.uid === doc.root ? 'root remove: the root cannot be removed' : null
    case 'retype':
      // A missing uid is a no-op, exactly as for set/move/remove. Retyping the
      // *root* is refused: a document's root type is its document type, and
      // changing that is a `document-types.md` concern (a `stories.type` update
      // in the same breath), not a block edit.
      if (!doc.bloks[m.uid]) return null
      return m.uid === doc.root
        ? 'root retype: the root type is the document type, not a block edit'
        : null
    default:
      return `unknown kind: ${(m as { t: string }).t}`
  }
}

export function apply(doc: Doc, m: Mutation): Doc {
  // Applying an invalid mutation is a structural no-op, independently of the
  // server's validation: client and server replay the same log through here, and
  // logs written before these guards existed must still land on a sane document.
  if (mutationError(doc, m)) return doc

  switch (m.t) {
    case 'set': {
      const b = doc.bloks[m.uid]
      if (!b) return doc
      return { ...doc, bloks: { ...doc.bloks, [m.uid]: written(b, m.field, m.value, m.locale) } }
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
    case 'retype': {
      const b = doc.bloks[m.uid]
      if (!b) return doc
      // Type only. Position, children and every field value survive, which is
      // what makes "consolidate two blocks" a migration rather than an editor
      // re-creating content by hand.
      return { ...doc, bloks: { ...doc.bloks, [m.uid]: { ...b, type: m.type } } }
    }
  }
}

/**
 * `blok` with one field written, in `data` or in one locale's map.
 *
 * The source-locale branch is byte-for-byte what `apply` did before locales
 * existed, and it is the branch an old logged `set` takes — which is the whole
 * compatibility guarantee, expressed as a default rather than as a migration.
 *
 * A locale write never touches `data`, so two translators in different languages
 * write different keys of the same blok and cannot overwrite each other.
 */
function written(blok: Blok, field: string, value: Json, locale?: string): Blok {
  if (locale === undefined) return { ...blok, data: { ...blok.data, [field]: value } }
  return {
    ...blok,
    i18n: {
      ...blok.i18n,
      [locale]: { ...blok.i18n?.[locale], [field]: value },
    },
  }
}

/**
 * A `set` for the same field and locale, carrying `value`. The locale key is
 * *omitted* rather than set to undefined when there is none, so a source-locale
 * inverse serialises exactly as a pre-v3 mutation did — `deepEqual` and the
 * log's own bytes both notice the difference.
 */
function setMutation(uid: string, field: string, value: Json, locale?: string): Mutation {
  return locale === undefined
    ? { t: 'set', uid, field, value }
    : { t: 'set', uid, field, value, locale }
}

export function applyAll(doc: Doc, ms: readonly Mutation[]): Doc {
  return ms.reduce(apply, doc)
}

/**
 * The mutations that undo `m`. Must be computed against the document as it was
 * *before* `m` was applied.
 */
export function invert(doc: Doc, m: Mutation): Mutation[] {
  // A refused mutation changed nothing, so it undoes to nothing. The server
  // never logs one, but an undo stack built over an older log can still see it.
  if (mutationError(doc, m)) return []

  switch (m.t) {
    case 'set': {
      const b = doc.bloks[m.uid]
      if (!b) return []
      // Read the prior value from wherever this `set` is about to write, so a
      // translator's Cmd+Z reverts their own language and nobody else's.
      const prior = m.locale === undefined ? b.data[m.field] : b.i18n?.[m.locale]?.[m.field]
      return [setMutation(m.uid, m.field, prior ?? null, m.locale)]
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
    case 'retype': {
      const b = doc.bloks[m.uid]
      if (!b) return []
      // So a migration is undoable like every other transaction, which is the
      // point of routing one through the log at all.
      return [{ t: 'retype', uid: m.uid, type: b.type }]
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
