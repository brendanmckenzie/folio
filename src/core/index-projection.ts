/**
 * The publish-time projection: which scalars of a published document land in
 * `content_index`, per locale (`../../../docs/specs/content-model/
 * collections.md` architecture decision 1).
 *
 * Pure, and deliberately so — every rule about what gets indexed is testable
 * without a database, and `POST /folio/reindex` rebuilds rows by running exactly
 * this function over `published_doc` rather than by restating the rules in SQL.
 *
 * Two invariants hold everything together:
 *
 *   - **Root block only.** The index is a *fixed* projection of a document: the
 *     set of rows a publish writes depends on the schema and the locales, never
 *     on which blocks happen to be inside the document. A field marked `indexed`
 *     on a nested block is reported by the audit, not silently indexed.
 *   - **One row per (locale, field), holding the value that locale renders.** The
 *     source locale is `''`. A declared non-source locale gets the translation
 *     when there is one and the fallback when there is not — read through
 *     `fieldValue`, the same call `RenderBlok` makes — so filtering a French
 *     index page matches what a French visitor actually reads.
 */
import type { Blok, Doc, Json } from './doc'
import type { Field } from './fields'
import { fieldValue, type LocaleConfig, localeChain } from './locales'
import type { DocumentType, SchemaIndex } from './schema'

/** One `content_index` row, minus the story id the caller already has. */
export interface IndexRow {
  /** `''` for the source locale. */
  locale: string
  field: string
  text: string | null
  num: number | null
}

/**
 * Whether this field kind can be projected at all. The field builders make
 * `indexed` unrepresentable on anything else, so this only ever refuses a
 * hand-written or imported schema — which is exactly the case `/folio/audit`
 * reports (`indexed-unsupported`).
 */
export function isIndexableKind(field: Field): field is IndexableField {
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'number':
    case 'boolean':
    case 'select':
      return true
    default:
      return false
  }
}

/** The five kinds that can carry `indexed`, narrowed off `Field`. */
export type IndexableField = Extract<
  Field,
  { kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' }
>

/** True when this field is declared queryable. Total over every field kind, so a
 * hand-written schema marking a richtext field `indexed` reads as "not indexed"
 * rather than as a type error at a call site — the audit is what reports it. */
export function isIndexed(field: Field): boolean {
  return isIndexableKind(field) && field.indexed === true
}

/** A block's `indexed` fields, in declaration order. */
export function indexedFields(schema: SchemaIndex, blockType: string): [string, Field][] {
  const def = schema[blockType]
  if (!def) return []
  return Object.entries(def.fields).filter(([, field]) => isIndexed(field))
}

/**
 * Every field name that is `indexed` on the root block of some declared document
 * type — the set a `where` or an `order` is checked against before it reaches
 * SQL.
 *
 * Names rather than (type, field) pairs, because a query may name several types
 * (or none) and the index is keyed on the field name alone. The consequence is
 * mild and deliberate: filtering `insight` on a field only `page` declares
 * matches nothing rather than 400ing. A field no root block declares at all is a
 * `bad_request` naming it — never a silent empty result, which is the failure
 * mode that costs an afternoon.
 */
export function indexedFieldNames(
  schema: SchemaIndex,
  types: readonly DocumentType[],
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const type of types) {
    for (const [name] of indexedFields(schema, type.root)) out.add(name)
  }
  return out
}

/**
 * ISO 8601, near enough: a date, optionally a time, optionally a zone. Anchored
 * so a sentence that happens to start with four digits is not a date.
 *
 * Deliberately narrow. The point of `num_value` is that `order by` and range
 * filters on a publish-date field are numeric rather than lexicographic; a
 * generic `Number(value)` coercion would also make a slug of `'2'` numeric,
 * which sorts a handful of rows ahead of every other row in the collection for
 * no reason anybody could find.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * One stored value as the two index columns, or null when there is nothing to
 * index.
 *
 * `text` is filled for every scalar, so the string operators (`eq`, `in`,
 * `contains`, `startsWith`) work uniformly on a number and a boolean too. `num`
 * is filled only where a number is genuinely meant: the value of a `number`
 * field, 0/1 for a `boolean`, and the epoch milliseconds of an ISO date string.
 *
 * Null for an object or an array (an `asset` value in a hand-written schema that
 * marked itself indexed), and null for an absent value — a document with no
 * value for an indexed field gets **no row**, so `eq` does not match it and
 * `order` sorts it last.
 */
export function projectValue(value: Json | undefined): { text: string; num: number | null } | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', num: value ? 1 : 0 }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { text: String(value), num: value } : null
  }
  if (typeof value === 'string') {
    if (value === '') return null
    if (!ISO_DATE.test(value)) return { text: value, num: null }
    const parsed = Date.parse(value)
    return { text: value, num: Number.isNaN(parsed) ? null : parsed }
  }
  // An object or an array. Unrepresentable as a scalar, so no row — and the
  // audit reports the declaration that made it reachable.
  return null
}

/**
 * The `content_index` rows for one published document.
 *
 * `type` says which block is the root, which is the only block read. `locales`
 * says which languages get rows of their own; absent (a single-locale site)
 * produces exactly the `''` rows and not a byte more.
 *
 * Returns rows in a stable order — source locale first, then each declared
 * non-source locale in declaration order, fields in declaration order — so a
 * reindex writes byte-identical SQL to a publish and two runs cannot disagree.
 */
export function indexRowsFor(
  doc: Doc,
  type: DocumentType | undefined,
  schema: SchemaIndex,
  locales?: LocaleConfig,
): IndexRow[] {
  const root: Blok | undefined = doc.bloks[doc.root]
  if (!root) return []
  // The document's **own** root block type in preference to the type's declared
  // `root`: a document written before the config was changed still indexes what
  // it actually holds rather than what the config now wishes it held. They agree
  // for every document Folio itself created; `type.root` is the fallback for a
  // malformed root blok carrying no type at all.
  const fields = indexedFields(schema, root.type || (type?.root ?? ''))
  if (fields.length === 0) return []

  const out: IndexRow[] = []
  const push = (locale: string, field: string, value: Json | undefined) => {
    const projected = projectValue(value)
    if (projected) out.push({ locale, field, text: projected.text, num: projected.num })
  }

  for (const [name] of fields) push('', name, root.data[name])

  for (const locale of locales?.available ?? []) {
    if (locale.code === locales?.default) continue
    const ctx = { code: locale.code, fallbacks: localeChain(locales, locale.code) }
    for (const [name] of fields) push(locale.code, name, fieldValue(root, name, ctx))
  }

  return out
}
