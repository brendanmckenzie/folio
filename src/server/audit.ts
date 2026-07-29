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
 * Both take an `AuditContext` as a second argument: the parts of the *config* a
 * check needs and cannot read off the schema. Today that is `locales`, and it is
 * why the translatable checks below can stay silent on a single-locale site
 * instead of filling the report with advice nobody asked for.
 *
 * Every finding carries its own `check` name and travels in `content` /
 * `schema`, so a new check needs no route change, no response-shape change and
 * no admin change to be visible. `orphanKeys` / `unknownTypes` / `missingFields`
 * are named projections of `content`, kept because the spec's own route example
 * names them.
 */
import type { Blok } from '../core/doc'
import { isIndexableKind } from '../core/index-projection'
import { isTranslatable, type LocaleConfig } from '../core/locales'
import { type BlockSchema, type DocumentType, type SchemaIndex, slotsOf } from '../core/schema'
import { publishedDocsAll } from './stories'

/**
 * Config a check needs beyond the schema and the blok in front of it.
 *
 * A second parameter rather than a closure over `createFolio`, so `auditSchema`
 * and `auditDocuments` stay callable from a test with a literal.
 */
export interface AuditContext {
  /** `FolioConfig.locales` (`../content-model/localisation.md`). Absent for a
   * single-locale site, and every locale check reads that as "nothing to say". */
  locales?: LocaleConfig
  /**
   * The declared document types (`../content-model/collections.md`). Needed by one
   * check and one check only: whether a block carrying an `indexed` field is any
   * type's **root**, which is a property of the config rather than of the schema.
   * Absent means "cannot judge", not "no block is a root".
   */
  types?: readonly DocumentType[]
}

const NO_CONTEXT: AuditContext = {}

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

export type DocumentCheck = (
  blok: Blok,
  def: BlockSchema | undefined,
  ctx: AuditContext,
) => Finding[]

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

/**
 * A translated value sitting in a field the schema does not mark `translatable`
 * (`../content-model/localisation.md` decision 4).
 *
 * Not a bug in the renderer — the renderer honours it deliberately, so
 * un-marking a field cannot silently hide content somebody already translated —
 * but it *is* content the editor will no longer let anybody change, since the
 * inspector refuses to write a locale value to an unmarked field. So it is
 * reported, to be migrated away on purpose rather than discovered by accident.
 *
 * Nulls are skipped for the same reason `orphanKey` skips them: clearing a
 * translation writes null, so reporting those would leave permanent drift behind
 * every completed untranslation.
 */
const translatedNotTranslatable: DocumentCheck = (blok, def, ctx) => {
  if (!def || !ctx.locales || !blok.i18n) return []
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const map of Object.values(blok.i18n)) {
    for (const [name, value] of Object.entries(map)) {
      if (value === null || seen.has(name)) continue
      const field = def.fields[name]
      if (field && !isTranslatable(field)) {
        seen.add(name)
        out.push({ check: 'translated-not-translatable', type: blok.type, field: name })
      }
    }
  }
  return out
}

/**
 * A translation under a locale code the config no longer declares
 * (`../content-model/localisation.md`'s first edge case).
 *
 * Inert — nothing reads that code, so the page renders its fallback — which is
 * exactly why it needs saying out loud. Nothing strips these automatically,
 * because a locale is at least as often removed by mistake as on purpose, and a
 * migration that deleted the French the moment somebody fat-fingered the config
 * would be unrecoverable.
 */
const unknownLocaleValues: DocumentCheck = (blok, _def, ctx) => {
  if (!ctx.locales || !blok.i18n) return []
  const declared = new Set(ctx.locales.available.map((l) => l.code))
  return Object.entries(blok.i18n)
    .filter(
      ([code, map]) => !declared.has(code) && Object.values(map).some((value) => value !== null),
    )
    .map(([code]) => ({ check: 'unknown-locale', type: blok.type, field: code }))
}

/** See "Adding a check" in the file header. */
export const DOCUMENT_CHECKS: readonly DocumentCheck[] = [
  orphanKey,
  unknownType,
  missingField,
  translatedNotTranslatable,
  unknownLocaleValues,
]

/* -------------------------------------------------------- schema checks --- */

export type SchemaCheck = (schema: SchemaIndex, ctx: AuditContext) => SchemaFinding[]

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

/**
 * A text-ish field nobody marked `translatable`
 * (`../content-model/localisation.md` checkpoint 2's stated mitigation).
 *
 * Translatable is opt-in per field, deliberately — a default of "everything is
 * translatable" turns every schema into a translation surface nobody asked for.
 * The cost of opt-in is annotating existing blocks, and the whole point of this
 * check is that the omissions are then *findable* rather than invisible: a
 * heading nobody marked simply never appears to a translator, with nothing
 * anywhere saying why.
 *
 * Only the four kinds whose value is human prose. A `select` holds a token, a
 * `number` a number, a `boolean` a flag and an `asset` a file — none of those
 * should diverge per locale by default, and reporting them would bury the four
 * that matter. `blocks` cannot be translatable at all.
 *
 * Silent without `locales` configured: on a single-locale site this would be
 * several hundred rows of advice about a feature the host is not using.
 */
const untranslatableText: SchemaCheck = (schema, ctx) => {
  if (!ctx.locales) return []
  const PROSE = new Set(['text', 'textarea', 'richtext'])
  const out: SchemaFinding[] = []
  for (const def of Object.values(schema)) {
    for (const [name, field] of Object.entries(def.fields)) {
      if (!PROSE.has(field.kind) || isTranslatable(field)) continue
      out.push({
        check: 'not-translatable',
        block: def.name,
        field: name,
        detail: `'${name}' is a ${field.kind} field with no 'translatable: true' — a translator never sees it, and nothing in the editor says why`,
      })
    }
  }
  return out
}

/**
 * An `indexed` flag that can never take effect
 * (`../content-model/collections.md` architecture decision 2).
 *
 * Two ways to write one, both silent without this check:
 *
 *   - **On a kind that has no scalar to index.** The field builders make this
 *     unrepresentable — `richtext({ indexed: true })` does not compile — so it only
 *     reaches here from a hand-written schema or an importer. The projection
 *     stores nothing, and `where` on the field 400s as if it were never declared.
 *   - **On a block that is no document type's root.** The index is a *fixed*
 *     projection of a document, so only the root block is read: a field on a
 *     nested block would make the row set depend on which blocks happen to be
 *     inside the document. This is the honest failure of that rule — the flag
 *     looks like it works and does nothing at all.
 *
 * Needs `ctx.types`, which is why `AuditContext` carries it: "is this block a
 * document root" is a property of the *config*, not of the schema.
 */
const unusableIndex: SchemaCheck = (schema, ctx) => {
  const roots = new Set((ctx.types ?? []).map((t) => t.root))
  const out: SchemaFinding[] = []
  for (const def of Object.values(schema)) {
    for (const [name, field] of Object.entries(def.fields)) {
      // `indexed` is only on the five scalar kinds, so anything else carrying one
      // arrived untyped; read it off the record rather than through `Field`.
      if ((field as { indexed?: unknown }).indexed !== true) continue
      if (!isIndexableKind(field)) {
        out.push({
          check: 'indexed-unsupported',
          block: def.name,
          field: name,
          detail: `'${name}' is a ${field.kind} field marked 'indexed' — only text, textarea, number, boolean and select project to a scalar, so nothing is indexed`,
        })
        continue
      }
      // No declared types at all means nothing can be judged, not that every
      // block is a root: `auditSchema` is callable with a bare schema in a test.
      if (roots.size > 0 && !roots.has(def.name)) {
        out.push({
          check: 'indexed-not-root',
          block: def.name,
          field: name,
          detail: `'${name}' is marked 'indexed' on '${def.name}', which is no document type's root block — only a root block is projected, so this does nothing`,
        })
      }
    }
  }
  return out
}

/** See "Adding a check" in the file header. */
export const SCHEMA_CHECKS: readonly SchemaCheck[] = [
  unknownConditionField,
  hiddenSummaryField,
  untranslatableText,
  unusableIndex,
]

/* ------------------------------------------------------------- the walk --- */

/** The schema half on its own: pure, and worth calling from a test directly. */
export function auditSchema(schema: SchemaIndex, ctx: AuditContext = NO_CONTEXT): SchemaFinding[] {
  return SCHEMA_CHECKS.flatMap((check) => check(schema, ctx))
}

/** The content half on its own, over documents a caller already has. */
export function auditDocuments(
  docs: readonly { doc: { bloks: Record<string, Blok> } }[],
  schema: SchemaIndex,
  ctx: AuditContext = NO_CONTEXT,
): ContentFinding[] {
  const tally = new Map<string, ContentFinding>()

  for (const { doc } of docs) {
    const seenInDoc = new Set<string>()
    for (const blok of Object.values(doc.bloks)) {
      const def = schema[blok.type]
      for (const check of DOCUMENT_CHECKS) {
        for (const finding of check(blok, def, ctx)) {
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

export async function audit(
  db: D1Database,
  schema: SchemaIndex,
  ctx: AuditContext = NO_CONTEXT,
): Promise<AuditReport> {
  const docs = await publishedDocsAll(db)
  const content = auditDocuments(docs, schema, ctx)
  const named = (check: string) => content.filter((f) => f.check === check)

  return {
    documents: docs.length,
    content,
    schema: auditSchema(schema, ctx),
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
