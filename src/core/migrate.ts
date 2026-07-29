/**
 * Content migrations: moving stored documents when the model changes
 * (`../../../docs/specs/foundation/schema-migrations.md`).
 *
 * A migration is a **pure function from a document to a list of mutations**, and
 * everything below exists to make that one shape convenient. It is what lets the
 * same function drive three call sites that have nothing else in common: a live
 * draft (as an ordinary logged transaction, so it syncs, lands in the activity
 * trail and is undoable), a `stories.published_doc` snapshot (as a plain
 * `applyAll` and one D1 write), and a `versions.doc` row (migrated *on read*, so
 * history is never rewritten).
 *
 * **Idempotence is the correctness mechanism** (checkpoint 2), not a nicety. A
 * migration applied to an already-migrated document must produce *zero*
 * mutations. That is what makes the runner re-runnable after a partial failure,
 * makes the ledger an optimisation rather than a guarantee, and makes "did that
 * actually work" answerable by running it again and seeing nothing happen. Every
 * helper here implements it, so it is implemented once instead of in every
 * migration a host writes.
 *
 * No I/O, no clock, no `env`. A migration that depends on either is not
 * re-runnable, and re-runnability is the whole mechanism.
 */
import { deepEqual } from './diff'
import { type Blok, type Doc, type Json, newUid } from './doc'
import { applyAll, type Mutation } from './mutations'
import type { DocumentType, SchemaIndex } from './schema'

/**
 * What a migration is handed alongside the document: the schema it is migrating
 * *to*, the document's own type, and the walker.
 *
 * Deliberately no network and no clock. See the file header.
 */
export interface MigrationContext {
  /** The block schemas as the code declares them now — the target shape. */
  schema: SchemaIndex
  /** The document type this document belongs to (`document-types.md`). */
  type: DocumentType
  /**
   * Every blok of one block type, in uid order, with whatever `fn` returns
   * flattened. The escape hatch is `fn` itself: anything the helpers below do
   * not cover is written by hand against `Blok` and `Mutation`, which is exactly
   * what `folio/engine` exists for.
   */
  each: (blockType: string, fn: (blok: Blok) => Mutation[]) => Mutation[]
}

export interface Migration {
  /**
   * Sorts as the run order, so ids must be zero-padded —
   * `validateMigrations` checks that rather than assuming it. Also what
   * `stories.schema_id` and `schema_migrations.id` store.
   */
  id: string
  /** Shown to an editor in the "this page is behind" banner. Write it for them. */
  description: string
  up: (doc: Doc, ctx: MigrationContext) => Mutation[]
}

/**
 * Identity, for the types. A host writes `export default defineMigration({…})`
 * and gets `up`'s parameters inferred rather than annotating them.
 */
export function defineMigration(m: Migration): Migration {
  return m
}

/** The `MigrationContext` for one document. */
export function migrationContext(
  doc: Doc,
  schema: SchemaIndex,
  type: DocumentType,
): MigrationContext {
  return {
    schema,
    type,
    each: (blockType, fn) =>
      Object.values(doc.bloks)
        .filter((b) => b.type === blockType)
        // Sorted, so the mutation list a dry run computes and the one the real
        // run commits are in the same order for the same document. An unstable
        // order would make the two reports disagree for no reason.
        .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
        .flatMap(fn),
  }
}

/**
 * Every mutation a set of migrations produces for one document, and the document
 * they leave behind.
 *
 * Each migration sees the document as the one before it left it, which is what
 * makes a chain of them meaningful: a rename followed by a retype operates on
 * the renamed fields.
 */
export function migrateDoc(
  doc: Doc,
  migrations: readonly Migration[],
  schema: SchemaIndex,
  type: DocumentType,
): { mutations: Mutation[]; doc: Doc } {
  let cursor = doc
  const mutations: Mutation[] = []
  for (const m of migrations) {
    const produced = m.up(cursor, migrationContext(cursor, schema, type))
    if (produced.length === 0) continue
    mutations.push(...produced)
    cursor = applyAll(cursor, produced)
  }
  return { mutations, doc: cursor }
}

/**
 * The migrations a document at `schemaId` has not had yet.
 *
 * `null` means "before the first migration", so every migration is pending —
 * the correct reading for a row written before `stories.schema_id` existed.
 * Comparison is lexicographic on the id, which is why `validateMigrations`
 * insists the ids sort in run order.
 */
export function pendingFor(
  schemaId: string | null | undefined,
  migrations: readonly Migration[],
): Migration[] {
  if (schemaId === null || schemaId === undefined) return [...migrations]
  return migrations.filter((m) => m.id > schemaId)
}

/** The id a fully-migrated document carries, or null when there are none. */
export function latestMigrationId(migrations: readonly Migration[]): string | null {
  return migrations.length > 0 ? migrations[migrations.length - 1]!.id : null
}

/**
 * Construction-time checks for `FolioConfig.migrations`, alongside
 * `validatePresets` / `validateTypes` / `validateGlobals` / `validateHooks`: a
 * configuration mistake in a CMS should throw once, before a request is served.
 *
 * The order these are declared in *is* the run order, and `stories.schema_id`
 * compares lexicographically, so a set of ids whose declared order and sort
 * order disagree would migrate documents in an order that depends on which
 * comparison happened to be used. Checked, not assumed.
 */
export function validateMigrations(migrations: readonly Migration[] | undefined): void {
  const seen = new Set<string>()
  let previous: string | null = null
  const widths = new Set<number>()

  for (const m of migrations ?? []) {
    if (!m.id || m.id !== m.id.trim()) {
      throw new Error(`folio: migration id '${m.id}' must be non-empty and untrimmed of spaces`)
    }
    if (!m.description) {
      throw new Error(`folio: migration '${m.id}' has no description — an editor reads it`)
    }
    if (seen.has(m.id)) throw new Error(`folio: duplicate migration id '${m.id}'`)
    seen.add(m.id)
    if (previous !== null && m.id <= previous) {
      throw new Error(
        `folio: migration '${m.id}' is declared after '${previous}' but sorts before it — ` +
          'ids must be in lexicographic order, which is the run order',
      )
    }
    previous = m.id
    widths.add(/^\d*/.exec(m.id)![0].length)
  }

  // Either every id carries a numeric run number of the same width, or none
  // does. A mixture ('0001-a' then '2-b') sorts in an order nobody intends, and
  // naming the cause here is far kinder than the "declared after but sorts
  // before" message above, which only describes the symptom.
  if (widths.size > 1) {
    throw new Error(
      'folio: migration ids must all carry a numeric prefix of the same width ' +
        `(zero-padded), or none at all; saw prefixes of ${[...widths].sort((a, b) => a - b).join(' and ')} digits`,
    )
  }
}

/* ---------------------------------------------------------------- helpers --- */

/**
 * True when a field carries something.
 *
 * `null` counts as nothing, and that is load-bearing. The mutation vocabulary
 * has no "delete a key": `set` writes one, and the only way to clear a field is
 * `set` it to `null` — which every reader already treats as the empty value
 * (`resolveValue`), and which `diff` already conflates with an absent key. So a
 * cleared field is `null`, "already migrated" means `null`, and that is what
 * makes `rename` and `remove` produce nothing on a second run.
 */
const isSet = (value: Json | undefined): boolean => value !== undefined && value !== null

/**
 * Field-level migrations. Every one returns `[]` when the document is already in
 * the target shape — that is where idempotence actually lives.
 */
export const field = {
  /**
   * Moves a value from one field name to another: the canonical case, and the
   * one that makes a rename a refactor rather than a data-loss event.
   *
   * `from` wins when both hold a value: a rename means the old field's value
   * *is* the new field's value, and the alternative (refuse, or keep `to`) makes
   * the migration's outcome depend on whether an editor happened to touch the
   * new input first.
   */
  rename(blok: Blok, from: string, to: string): Mutation[] {
    if (from === to) return []
    if (!isSet(blok.data[from])) return []
    return [
      { t: 'set', uid: blok.uid, field: to, value: blok.data[from]! },
      { t: 'set', uid: blok.uid, field: from, value: null },
    ]
  },

  /** Clears a field the schema no longer declares. */
  remove(blok: Blok, name: string): Mutation[] {
    if (!isSet(blok.data[name])) return []
    return [{ t: 'set', uid: blok.uid, field: name, value: null }]
  },

  /**
   * The retroactive half of `Field.default`, which
   * `field-defaults-and-presets.md` deliberately deferred here: that key is
   * consulted at *creation* only, so a field added to a schema never appears in
   * a document written before it. This fills those in.
   *
   * Strictly "only when absent" — `undefined`, not `null`. A `null` is a value
   * an editor could have chosen (a cleared asset, an emptied reference), and
   * overwriting it would be this tool changing content rather than filling a
   * hole. A field the schema has always declared is never absent, so this is a
   * no-op on every document created since it existed.
   */
  default(blok: Blok, name: string, value: Json): Mutation[] {
    if (blok.data[name] !== undefined) return []
    return [{ t: 'set', uid: blok.uid, field: name, value }]
  },

  /**
   * Transforms a value in place — lowercasing a topic, reshaping an object.
   *
   * Idempotent by *comparison* rather than by a marker: a transform that has
   * already been applied produces the value that is already there, and a
   * `deepEqual` value emits nothing. Which means `map` is only safe with an
   * idempotent transform (`toLowerCase`, yes; `+ 1`, no), and that is the
   * honest constraint rather than a hidden one.
   */
  map(blok: Blok, name: string, fn: (value: Json) => Json): Mutation[] {
    const current = blok.data[name]
    if (!isSet(current)) return []
    const next = fn(current!)
    if (deepEqual(next, current!)) return []
    return [{ t: 'set', uid: blok.uid, field: name, value: next }]
  },

  /**
   * Splits one field into several, clearing the source. Each part is a function
   * of the source value, so `name` → `{ firstName, lastName }` is one call.
   *
   * Idempotent because the source ends up `null`, so a second run finds nothing
   * to split. The parts are written before the source is cleared, in one
   * transaction, so a refused chunk loses neither.
   */
  split(blok: Blok, name: string, parts: Record<string, (value: Json) => Json>): Mutation[] {
    const current = blok.data[name]
    if (!isSet(current)) return []
    const out: Mutation[] = Object.entries(parts).map(([to, fn]) => ({
      t: 'set' as const,
      uid: blok.uid,
      field: to,
      value: fn(current!),
    }))
    // A `split` with no parts would clear the source and lose the value: that is
    // `field.remove`, said badly, so it is refused rather than performed.
    if (out.length === 0) return []
    out.push({ t: 'set', uid: blok.uid, field: name, value: null })
    return out
  },
}

/** Block-level migrations: the shapes that need `retype`, or a new blok. */
export const block = {
  /**
   * Turns a blok into another type, seeding fields the new type introduces.
   *
   * The uid, the position and the children all survive — that is the whole
   * reason `retype` exists rather than a remove-and-reinsert, which the
   * vocabulary cannot express anyway.
   *
   * `data` is seeded the way `field.default` fills: only where the key is
   * absent, so re-running does not stomp a value an editor has since changed.
   * Idempotent because the type check short-circuits once the type matches and
   * every seed key exists.
   *
   * Retyping a document's *root* is refused by `mutationError`, so a migration
   * that tries it has its whole chunk rejected with a named reason and the story
   * recorded in the run's `failed` list. That is deliberate: a root's type is its
   * *document* type, which needs a `stories.type` update in the same breath and
   * is out of this spec's scope.
   */
  retype(blok: Blok, type: string, data?: Record<string, Json>): Mutation[] {
    const out: Mutation[] = []
    if (blok.type !== type) out.push({ t: 'retype', uid: blok.uid, type })
    for (const [name, value] of Object.entries(data ?? {})) {
      if (blok.data[name] === undefined) out.push({ t: 'set', uid: blok.uid, field: name, value })
    }
    return out
  },

  /**
   * Inserts a parent above a blok and moves the blok into one of its slots — the
   * "everything needs to be inside a container now" migration.
   *
   * The wrapper takes the blok's own parent, slot and order, so the document's
   * rendered order is unchanged; the blok lands first in the wrapper's `slot`.
   *
   * Idempotent by *shape*: it produces nothing once the blok's parent is already
   * a blok of `type`. Not by uid — the wrapper's uid is fresh on every call, so
   * a dry run and the real run allocate different ones. That is fine and is why
   * idempotence is defined as "produces zero mutations against an already
   * migrated document" rather than "produces identical mutations".
   *
   * The root cannot be wrapped: it has no parent to hang a wrapper off.
   */
  wrap(
    doc: Doc,
    blok: Blok,
    type: string,
    slot: string,
    data: Record<string, Json> = {},
  ): Mutation[] {
    if (blok.uid === doc.root || blok.parent === null || blok.slot === null) return []
    if (doc.bloks[blok.parent]?.type === type) return []
    const wrapper: Blok = {
      uid: newUid(),
      type,
      parent: blok.parent,
      slot: blok.slot,
      order: blok.order,
      data,
    }
    return [
      { t: 'insert', blok: wrapper },
      { t: 'move', uid: blok.uid, parent: wrapper.uid, slot, order: 'a0' },
    ]
  },
}
