/**
 * The drift report (`../../../docs/specs/foundation/schema-migrations.md`
 * decision 7): what state the content actually is in, as against what the code
 * now says it should be.
 *
 * Read-only, and deliberately **not** part of the migrate path: an audit that
 * runs as a side effect of a write is an audit nobody reads. It costs one D1
 * query (`publishedDocsAll`) and no Durable Object, because it reports on what
 * the site is *serving* — the copy an operator can see is wrong.
 *
 * ## Adding a check
 *
 * There are two arrays and that is the whole extension point.
 *
 *   - `DOCUMENT_CHECKS` — a function called once per blok of every published
 *     document. Return a `Finding` per problem; the walker tallies distinct
 *     `(check, type, field)` triples across documents and bloks for you. Use
 *     this for anything that depends on stored *values*.
 *   - `SCHEMA_CHECKS` — a function called once with the whole `SchemaIndex`.
 *     No document is involved, so a finding here is a *code* mistake rather
 *     than a content one. Use this for anything that is a property of the
 *     declarations alone.
 *
 * Every finding carries its own `check` name and travels in `content` /
 * `schema`, so a new check needs no route change, no response-shape change and
 * no admin change to be visible. `orphanKeys` / `unknownTypes` / `missingFields`
 * are named projections of `content`, kept because the spec's own route example
 * names them.
 *
 * `../content-model/localisation.md` adds "a text-ish field not marked
 * `translatable`" as one entry in `SCHEMA_CHECKS`.
 */
import type { Blok } from '../core/doc'
import { type BlockSchema, type SchemaIndex, slotsOf } from '../core/schema'
import { publishedDocsAll } from './stories'

/** One problem found in one blok. Counted, not listed per blok: a site with 400 heroes carrying an orphan key needs the count, not 400 rows. */
export interface Finding {
  /** Which check produced it. Kebab-ish and stable — the admin keys off it. */
  check: string
  /** Block type the finding is about. */
  type: string
  /** Field name, or null when the finding is about the block itself. */
  field: string | null
}

export interface ContentFinding extends Finding {
  /** Published documents containing at least one blok with this finding. */
  documents: number
  /** Bloks with this finding, across those documents. */
  bloks: number
}

/** A finding about the declarations alone: no document is involved. */
export interface SchemaFinding {
  check: string
  /** Block type whose declaration is at fault. */
  block: string
  field: string | null
  /** Written for a developer reading a report, not for a UI to parse. */
  detail: string
}

export interface AuditReport {
  /** Published documents examined. */
  documents: number
  /**
   * Every content check's tally, most documents first. The extensible surface:
   * a check added to `DOCUMENT_CHECKS` appears here with nothing else changed.
   */
  content: ContentFinding[]
  /** Every schema check's findings. Same, for `SCHEMA_CHECKS`. */
  schema: SchemaFinding[]
  /* The three the spec's route example names, projected out of `content`. */
  orphanKeys: { type: string; field: string; documents: number }[]
  unknownTypes: { type: string; documents: number }[]
  missingFields: { type: string; field: string; documents: number }[]
}

/* ------------------------------------------------------- content checks --- */

export type DocumentCheck = (blok: Blok, def: BlockSchema | undefined) => Finding[]

/**
 * A key the schema no longer declares, holding something.
 *
 * The *whole reason* this report exists: `RenderBlok` iterates `def.fields` and
 * reads `blok.data[name]`, so a key the schema has dropped is never read again —
 * it sits in the document indefinitely and is invisible in the editor. This is
 * what turns "something looks empty" into a migration somebody can write.
 *
 * A `null` value is not reported. Clearing a field is `set … null` (the
 * vocabulary has no delete-key), so a migrated-away field *is* a null orphan
 * key, and reporting those would mean every completed rename left permanent
 * drift behind it. An orphan key matters when it holds content nobody can see;
 * null is not content.
 */
const orphanKey: DocumentCheck = (blok, def) => {
  if (!def) return []
  return Object.entries(blok.data)
    .filter(([name, value]) => value !== null && !(name in def.fields))
    .map(([name]) => ({ check: 'orphan-key', type: blok.type, field: name }))
}

/**
 * A blok whose type nothing declares any more. Renders `Unknown block type` in
 * the editor and *nothing at all* on the live page, which is the loudest
 * possible failure and the quietest possible symptom.
 */
const unknownType: DocumentCheck = (blok, def) =>
  def ? [] : [{ check: 'unknown-type', type: blok.type, field: null }]

/**
 * A field the schema declares that this blok has no key for — a field added
 * after the document was written. It resolves to its kind's empty value, so it
 * renders as blank rather than breaking, which is why nobody notices.
 *
 * `field.default(blok, name, value)` is the migration that fills these in.
 * `blocks`-kind fields are skipped: children are separate bloks, not a value on
 * the parent, so there is no key to be missing.
 */
const missingField: DocumentCheck = (blok, def) => {
  if (!def) return []
  const slots = new Set(slotsOf(def).map(([name]) => name))
  return Object.keys(def.fields)
    .filter((name) => !slots.has(name) && blok.data[name] === undefined)
    .map((name) => ({ check: 'missing-field', type: blok.type, field: name }))
}

/** See "Adding a check" in the file header. */
export const DOCUMENT_CHECKS: readonly DocumentCheck[] = [orphanKey, unknownType, missingField]

/* -------------------------------------------------------- schema checks --- */

export type SchemaCheck = (schema: SchemaIndex) => SchemaFinding[]

/**
 * A `showIf` naming a field the block does not declare
 * (`conditional-fields.md`'s deferred debt, first half).
 *
 * `matches` is total — an unknown field name evaluates `false` and never throws
 * — which is the right runtime behaviour and exactly why this needs a report:
 * the input is simply never drawn, and nothing anywhere says why.
 */
const unknownConditionField: SchemaCheck = (schema) => {
  const out: SchemaFinding[] = []
  const walk = (block: string, field: string, condition: unknown): void => {
    if (typeof condition !== 'object' || condition === null) return
    const c = condition as Record<string, unknown>
    if (typeof c.field === 'string') {
      if (!schema[block]?.fields[c.field]) {
        out.push({
          check: 'unknown-condition-field',
          block,
          field,
          detail: `showIf names '${c.field}', which '${block}' does not declare — the input is never drawn`,
        })
      }
      return
    }
    for (const nested of [
      ...(Array.isArray(c.all) ? c.all : []),
      ...(Array.isArray(c.any) ? c.any : []),
      ...(c.not ? [c.not] : []),
    ]) {
      walk(block, field, nested)
    }
  }
  for (const def of Object.values(schema)) {
    for (const [name, f] of Object.entries(def.fields)) {
      if (f.showIf) walk(def.name, name, f.showIf)
    }
  }
  return out
}

/**
 * A `summary` naming a field the block hides
 * (`conditional-fields.md`'s deferred debt, second half).
 *
 * Not an error — the value is real and `summarise` renders it — but it labels
 * every row in the block tree with something the inspector never shows, so an
 * editor cannot work out where the label comes from, let alone change it.
 * `showIf` counts as hiding here: a summary that is present on some bloks of a
 * type and absent on others is the same confusion, intermittently.
 */
const hiddenSummaryField: SchemaCheck = (schema) => {
  const out: SchemaFinding[] = []
  for (const def of Object.values(schema)) {
    if (!def.summary) continue
    const f = def.fields[def.summary]
    if (!f) {
      out.push({
        check: 'unknown-summary-field',
        block: def.name,
        field: def.summary,
        detail: `summary names '${def.summary}', which '${def.name}' does not declare — every tree row is unlabelled`,
      })
      continue
    }
    const why = f.hidden ? 'hidden: true' : f.showIf ? 'a showIf' : null
    if (why !== null) {
      out.push({
        check: 'hidden-summary-field',
        block: def.name,
        field: def.summary,
        detail: `summary names '${def.summary}', which carries ${why} — the tree labels every row with a value the inspector never shows`,
      })
    }
  }
  return out
}

/** See "Adding a check" in the file header. */
export const SCHEMA_CHECKS: readonly SchemaCheck[] = [unknownConditionField, hiddenSummaryField]

/* ------------------------------------------------------------- the walk --- */

/** The schema half on its own: pure, and worth calling from a test directly. */
export function auditSchema(schema: SchemaIndex): SchemaFinding[] {
  return SCHEMA_CHECKS.flatMap((check) => check(schema))
}

/** The content half on its own, over documents a caller already has. */
export function auditDocuments(
  docs: readonly { doc: { bloks: Record<string, Blok> } }[],
  schema: SchemaIndex,
): ContentFinding[] {
  const tally = new Map<string, ContentFinding>()

  for (const { doc } of docs) {
    const seenInDoc = new Set<string>()
    for (const blok of Object.values(doc.bloks)) {
      const def = schema[blok.type]
      for (const check of DOCUMENT_CHECKS) {
        for (const finding of check(blok, def)) {
          const key = `${finding.check} ${finding.type} ${finding.field ?? ''}`
          const row = tally.get(key) ?? { ...finding, documents: 0, bloks: 0 }
          row.bloks++
          if (!seenInDoc.has(key)) {
            seenInDoc.add(key)
            row.documents++
          }
          tally.set(key, row)
        }
      }
    }
  }

  return [...tally.values()].sort(
    (a, b) =>
      b.documents - a.documents ||
      a.check.localeCompare(b.check) ||
      a.type.localeCompare(b.type) ||
      (a.field ?? '').localeCompare(b.field ?? ''),
  )
}

export async function audit(db: D1Database, schema: SchemaIndex): Promise<AuditReport> {
  const docs = await publishedDocsAll(db)
  const content = auditDocuments(docs, schema)
  const named = (check: string) => content.filter((f) => f.check === check)

  return {
    documents: docs.length,
    content,
    schema: auditSchema(schema),
    orphanKeys: named('orphan-key').map((f) => ({
      type: f.type,
      field: f.field ?? '',
      documents: f.documents,
    })),
    unknownTypes: named('unknown-type').map((f) => ({ type: f.type, documents: f.documents })),
    missingFields: named('missing-field').map((f) => ({
      type: f.type,
      field: f.field ?? '',
      documents: f.documents,
    })),
  }
}
