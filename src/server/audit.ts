/**
 * The drift report (`../../docs/specs/foundation/schema-migrations.md`
 * decision 7): what state the content actually is in, as against what the code
 * now says it should be.
 *
 * Read-only, and deliberately **not** part of the migrate path: an audit that
 * runs as a side effect of a write is an audit nobody reads. It costs one D1
 * query per batch (`publishedDocsAfter`) and no Durable Object, because it
 * reports on what the site is *serving* — the copy an operator can see is wrong.
 *
 * **Batched and resumable by `continueFrom`**, the same shape `runMigrations` and
 * `reindex` take (`../../docs/specs/foundation/pagination.md`'s route table
 * and its audit edge case). One call reads up to `batch` published documents and
 * answers a cursor; the caller re-calls until it is null and merges the reports.
 * It read the whole table in one query until the Model screen was built on it,
 * which is the one thing on this route that could not scale: every published
 * document, JSON-parsed, in one request whose CPU limit is the same one
 * `runMigrations` is batched to stay under.
 *
 * ## Adding a check
 *
 * There are three arrays and that is the whole extension point. They differ in
 * *what one call sees*, which is what decides which one a new check belongs in.
 *
 *   - `DOCUMENT_CHECKS` — a function called once per blok of every published
 *     document. Return a `Finding` per problem; the walker tallies distinct
 *     `(check, type, field)` triples across documents and bloks for you. Use
 *     this for anything that depends on stored *values*.
 *   - `STORY_CHECKS` — a function called once with every published document at
 *     once. Use this for anything true of a *document as a whole* rather than
 *     of a value inside one: a finding here names a single story, is not
 *     tallied, and the check owns its own ordering (which is how
 *     `document-size` can report the heaviest page first).
 *   - `SCHEMA_CHECKS` — a function called once with the whole `SchemaIndex`.
 *     No document is involved, so a finding here is a *code* mistake rather
 *     than a content one. Use this for anything that is a property of the
 *     declarations alone.
 *
 * All three take an `AuditContext` as their last argument: the parts of the
 * *config* a check needs and cannot read off the schema. Today that is
 * `locales`, and it is why the translatable checks below can stay silent on a
 * single-locale site instead of filling the report with advice nobody asked for.
 *
 * Every finding carries its own `check` name and travels in `content` /
 * `stories` / `schema`, so a new check needs no route change, no
 * response-shape change and no admin change to be visible. `orphanKeys` /
 * `unknownTypes` / `missingFields` are named projections of `content`, kept
 * because the spec's own route example names them.
 */
import type { Blok, Doc } from '../core/doc'
import { isIndexableKind } from '../core/index-projection'
import { isTranslatable, type LocaleConfig } from '../core/locales'
import { docBytes, MAX_DOC_BYTES, utf8Bytes } from '../core/protocol'
import { type BlockSchema, type DocumentType, type SchemaIndex, slotsOf } from '../core/schema'
import { publishedDocsAfter } from './stories'

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
  /**
   * The first `FINDING_SAMPLE` documents carrying it, in the order the walk met
   * them, so a count can still be *opened*.
   *
   * A count and a sample rather than one or the other, and the tension is real:
   * the comment above says a site with 400 heroes carrying an orphan key needs
   * the number, not 400 rows — and that stands, which is why the list is capped
   * at five rather than complete. But a number nobody can act on is a report,
   * and the admin's audit panel exists to be a tool
   * (`../../docs/ui-architecture.md`, Model): "each finding links to the
   * document it is about". Five links plus "and 395 more" answers both.
   *
   * Empty when the caller passed documents with no id — `auditDocuments` is
   * callable with a bare `{ doc }` literal from a test, which the file header
   * treats as worth keeping.
   */
  sample: string[]
}

/**
 * How many documents a `ContentFinding` names. Five, because the sample is a way
 * *in* rather than a listing: enough that a spot check is not the same document
 * twice, few enough that a row stays one line.
 */
export const FINDING_SAMPLE = 5

/**
 * A finding that explains itself in prose — and the short form a UI shows instead.
 *
 * The reason the second field exists is a fault the admin's audit panel made visible
 * the first time it drew nine rows.
 *
 * Every `detail` here is a **varying head and a boilerplate tail**: `not-translatable`
 * says "`'role'` is a text field with no `translatable: true` — a translator never
 * sees it, and nothing in the editor says why", and the clause after the dash is
 * identical on all nine rows. A panel is *scanned*, so nine copies of one sentence
 * are nine lines of noise competing with the one token that differs, and the screen
 * already states the shared half once, above the family.
 *
 * So there are two fields for two audiences and neither is derived from the other:
 *
 *   - **`detail` stays whole**, because its audience is a developer reading JSON out
 *     of `curl` with no family prose anywhere near it. It is documented as "not for
 *     a UI to parse" and that stands — this is the alternative to parsing it.
 *   - **`note` is what differs**, in a few words, or **absent when nothing does**.
 *     Absent is a real answer and the useful one: it tells a UI that this family's
 *     rows are distinguished by their identifier alone, which is a property of the
 *     *check* rather than something a screen should special-case per family.
 *
 * Rejected: splitting `detail` into two fields and asking a caller to join them.
 * That changes what an existing consumer reads for the benefit of one that has not
 * shipped, and the joined sentence is better prose than a mechanical concatenation
 * — `document-size`'s reads as one thought and would not survive being cut in half.
 */
interface Explained {
  /** Written for a developer reading a report, not for a UI to parse. */
  detail: string
  /**
   * The part of `detail` that differs from its siblings', short enough to sit
   * beside an identifier. Absent when the identifier is the whole difference.
   */
  note?: string
}

/**
 * A finding about one whole published document, named by its story.
 *
 * Not tallied, unlike `ContentFinding`: "some type of block has this problem in
 * 40 documents" is the useful summary of a value-level fault, and *"this page"*
 * is the only useful summary of a document-level one. Which is also why this
 * carries a story id where the others carry a block type — a report that said
 * "one document is nearly too big" without saying which is not actionable.
 */
export interface StoryFinding extends Explained {
  check: string
  /** The story whose published document this is about. */
  story: string
  /** Its document type, as `stories.type` records it. */
  type: string
}

/**
 * `document-size`'s finding: a `StoryFinding` plus the numbers its `detail`
 * spells out in prose, so a caller that wants to sort or draw a bar does not
 * have to parse the sentence. Extends rather than widens `StoryFinding` for the
 * same reason `ContentFinding` extends `Finding`: the base is what every check
 * in the family promises, not what this one happens to measure.
 */
export interface DocumentSizeFinding extends StoryFinding {
  /** Serialised size of the published document, in UTF-8 bytes. */
  bytes: number
  /**
   * What each locale's translations weigh inside that total, heaviest first.
   * Empty on an untranslated document. Measured over `i18n` alone, so the parts
   * sum to slightly under the whole — the source-locale `data`, and the
   * structure holding all of it, are the rest.
   */
  locales: { code: string; bytes: number }[]
}

/** A finding about the declarations alone: no document is involved. */
export interface SchemaFinding extends Explained {
  check: string
  /** Block type whose declaration is at fault. */
  block: string
  field: string | null
}

export interface AuditReport {
  /** Published documents examined **by this call**, not by the whole walk. */
  documents: number
  /**
   * Every content check's tally, most documents first. The extensible surface:
   * a check added to `DOCUMENT_CHECKS` appears here with nothing else changed.
   */
  content: ContentFinding[]
  /**
   * Every story check's findings: one per affected document, in each check's
   * own order. Same extensible surface, for `STORY_CHECKS`.
   */
  stories: StoryFinding[]
  /** Every schema check's findings. Same, for `SCHEMA_CHECKS`. */
  schema: SchemaFinding[]
  /* The three the spec's route example names, projected out of `content`. */
  orphanKeys: { type: string; field: string; documents: number }[]
  unknownTypes: { type: string; documents: number }[]
  missingFields: { type: string; field: string; documents: number }[]
  /**
   * The story id to resume after, or null when the sweep reached the end — the
   * same contract `MigrateReport.continueFrom` carries, deliberately, because it
   * is the same job shape and a second convention would be one more thing for a
   * client to get subtly wrong.
   *
   * A caller that stops at the first batch has audited a *prefix* of the site, so
   * `documents` and every tally are that prefix's. The admin's Model screen says
   * so out loud rather than presenting one batch as the whole answer.
   */
  continueFrom: string | null
}

/** How many published documents one call reads. */
export const DEFAULT_AUDIT_BATCH = 100

/** Ceiling on `batch`, so a caller cannot ask for a read that outlives the request. */
export const MAX_AUDIT_BATCH = 500

export interface AuditOptions {
  /** Resume after this story id — the `continueFrom` of the previous call. */
  continueFrom?: string | null
  batch?: number
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

/* --------------------------------------------------------- story checks --- */

/** One published document, exactly as `publishedDocsAll` hands it over. */
export interface AuditedStory {
  id: string
  type: string
  doc: Doc
}

/**
 * A check over the whole published set at once. See "Adding a check": it gets
 * every document rather than one, so that a finding can be ordered against the
 * others — `document-size` reports the heaviest page first, which a per-document
 * call could not do.
 */
export type StoryCheck = (
  stories: readonly AuditedStory[],
  ctx: AuditContext,
) => readonly StoryFinding[]

/**
 * The share of `MAX_DOC_BYTES` at which a published document counts as
 * *approaching* it. A judgement call, so here is the argument.
 *
 * The cap is enforced at the door and nowhere else: `docCapError` runs on the
 * document a transaction has **already** been applied to, so the tx that carries
 * a document past 8 MB is refused whole and the edit that did it is lost
 * (`core/protocol.ts`, `StoryDO.commit`). There is no soft landing and no
 * degraded mode, which means a warning is only worth having if it arrives with
 * room left to act in — to split the page, retire a locale, or move a block off
 * it.
 *
 * How much room is enough is set by the thing that made 8 MB reachable at all:
 * a locale. Adding one is not a keystroke, it is another whole copy of every
 * translatable value in the document, arriving over an afternoon of
 * translation rather than in one tx. The tightest case that matters is a fifth
 * locale on a four-locale document — about a quarter more translated weight,
 * committed steadily, with nothing to stop it partway. Three quarters is the
 * threshold that still fires *before* a jump of that size instead of during it.
 *
 * Higher (90%) reports documents already too far gone to fix calmly; much lower
 * (50%) reports every large page on any real site, and a report that is always
 * red is the same as no report.
 */
export const DOC_BYTES_WARN_SHARE = 0.75

/** `DOC_BYTES_WARN_SHARE` of `MAX_DOC_BYTES`, floored to whole bytes — 6 MB of the 8 MB cap. */
export const WARN_DOC_BYTES = Math.floor(MAX_DOC_BYTES * DOC_BYTES_WARN_SHARE)

/** Bytes as an operator reads them. The cap is quoted in MB everywhere else too. */
const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * What each locale's translations weigh inside one document, heaviest first.
 *
 * Attribution, not a second measurement: `i18n` is a sibling of `data` on every
 * blok (`core/locales.ts`), so a locale's map is a real subtree of the very JSON
 * the cap is enforced against, and measuring it with the same `utf8Bytes` gives
 * the share of the total that locale is responsible for. It is a slight
 * under-count by construction — the `"fr":` keys and the punctuation between
 * them belong to no one locale — and that is the right direction to be wrong in
 * for a number an operator is about to act on.
 *
 * Undeclared locale codes are counted like any other. Weight is weight; that the
 * config no longer names the code is `unknown-locale`'s finding, not this one's.
 */
function localeWeights(doc: Doc): { code: string; bytes: number }[] {
  const per = new Map<string, number>()
  for (const blok of Object.values(doc.bloks)) {
    if (!blok.i18n) continue
    for (const [code, map] of Object.entries(blok.i18n)) {
      per.set(code, (per.get(code) ?? 0) + utf8Bytes(JSON.stringify(map)))
    }
  }
  return [...per]
    .map(([code, bytes]) => ({ code, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.code.localeCompare(b.code))
}

/**
 * The numbers, and nothing else — `Explained.note` for this check.
 *
 * This is the family that argues *against* dropping a detail from a UI: every figure
 * in it differs per row and the figures are the entire point of the check, so a row
 * showing only a story id would be a size warning with no size in it. So the note
 * carries the whole varying half, including the per-locale attribution, and only the
 * standing advice about what happens at the cap is left to `sizeDetail`.
 */
function sizeNote(bytes: number, locales: { code: string; bytes: number }[]): string {
  const translated = locales.reduce((n, l) => n + l.bytes, 0)
  const named = locales.slice(0, 3).map((l) => `${l.code} ${mb(l.bytes)}`)
  if (locales.length > named.length) named.push(`${locales.length - named.length} more`)
  const where =
    translated > 0 ? `, of which ${mb(translated)} is translations (${named.join(', ')})` : ''
  return (
    `${mb(bytes)} serialised, ${Math.round((bytes / MAX_DOC_BYTES) * 100)}% of the ` +
    `${mb(MAX_DOC_BYTES)} document cap${where}`
  )
}

/**
 * The sentence: the note plus the standing consequence.
 *
 * Composed rather than written twice, which makes the relationship between the two
 * fields visible in the one family where it decomposes cleanly — `detail` is `note`
 * plus the advice a family heading states once. It does not decompose for every
 * check, so this is not generalised into the walker; see `Explained`.
 */
function sizeDetail(bytes: number, locales: { code: string; bytes: number }[]): string {
  return (
    `${sizeNote(bytes, locales)} — the transaction that crosses the cap is ` +
    `refused whole, so the edit that does it is the one that is lost`
  )
}

/**
 * A published document whose bytes are closing on `MAX_DOC_BYTES`.
 *
 * The blok ceiling is the one anybody watches, and it is not the one
 * localisation moves: eight languages of long richtext is eight times the
 * payload at the same block count (`../content-model/localisation.md`
 * checkpoint 2). So a document can be nowhere near `MAX_DOC_BLOKS` and still be
 * one translation pass away from a wall — with no symptom at all until an
 * editor's save is refused, because a document under the cap behaves perfectly.
 *
 * Measured with `docBytes`, the same function `docCapError` caps, over the same
 * serialisation: a report that counted bytes its own way would disagree with the
 * door at precisely the size where the answer matters.
 *
 * Reported on the *published* document, because that is the only copy this
 * report reads (`publishedDocsAll`, no Durable Object). The cap is enforced on
 * the **draft**, so this is a lower bound: a page that has grown since it was
 * last published is already heavier than the number here. A warning that
 * under-states is the right way round for one whose whole job is arriving early.
 */
const documentSize: StoryCheck = (stories) => {
  const out: DocumentSizeFinding[] = []
  for (const { id, type, doc } of stories) {
    const bytes = docBytes(doc)
    if (bytes < WARN_DOC_BYTES) continue
    const locales = localeWeights(doc)
    out.push({
      check: 'document-size',
      story: id,
      type,
      bytes,
      locales,
      note: sizeNote(bytes, locales),
      detail: sizeDetail(bytes, locales),
    })
  }
  return out.sort((a, b) => b.bytes - a.bytes || a.story.localeCompare(b.story))
}

/**
 * A published document whose **document type** nothing declares any more.
 *
 * Not the same finding as `unknownType` above, and the difference is the whole
 * reason this exists: that one is about a `blok.type` inside a document, this one
 * is about `stories.type` — the document's own kind. A site can have a perfectly
 * valid tree of bloks in a document of a type that was renamed in code.
 *
 * **This is where `DataList.tsx`'s "Unknown type" heading went**
 * (`../../docs/ui-architecture.md` port phase 3, and `ROADMAP.md`'s "a row
 * whose document type is no longer declared has no screen"). The admin's nav is
 * generated from the manifest, so an undeclared type has no `/documents/:type`
 * to list its rows on — which made a code change able to hide content with no
 * way back to it. A finding that names the story is the way back, so the audit
 * panel's link is not a nicety here: it is the only route to the document.
 *
 * `ROADMAP.md` claimed the audit "already reports `unknown types` in full" and
 * that was wrong — it reported *block* types. This check is what makes the claim
 * true.
 *
 * Two honest limits, both narrower than what `DataList.tsx` could see:
 *
 *   - **Published documents only**, because that is the only copy this report
 *     reads. An unrouted draft of an undeclared type is still unreachable, and
 *     fixing that needs a `stories` read this report deliberately does not make.
 *   - **Silent without `ctx.types`**, matching `unusableIndex`: no declared types
 *     means "cannot judge", not "every type is undeclared". `auditSchema` and its
 *     neighbours stay callable from a test with a bare literal.
 */
const undeclaredDocumentType: StoryCheck = (stories, ctx) => {
  const declared = new Set((ctx.types ?? []).map((t) => t.name))
  if (declared.size === 0) return []
  return stories
    .filter((s) => !declared.has(s.type))
    .map(({ id, type }) => ({
      check: 'unknown-document-type',
      story: id,
      // The orphaned type name is the varying fact, and it is on the finding as
      // `type` as well — but a UI reading it off there would be a screen deciding
      // per family which structured field to draw, which is the thing `note` exists
      // to stop.
      type,
      note: `type '${type}'`,
      // Worded to match `runMigrations`' failure for the same drift, which
      // reports it from the other direction: a migration cannot run over a
      // document whose type it has no `MigrationContext.type` for.
      detail:
        `document type '${type}' is not declared any more — nothing lists this document, ` +
        `and a migration cannot run over it until a type by that name exists again`,
    }))
}

/**
 * See "Adding a check" in the file header.
 *
 * `undeclaredDocumentType` first, and the order is the panel's reading order: a
 * document nothing can reach is a worse problem than one that is merely getting
 * heavy, and the admin renders families in the order their findings appear.
 */
export const STORY_CHECKS: readonly StoryCheck[] = [undeclaredDocumentType, documentSize]

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
          // The missing name is the one fact not already in `block` and `field`, so
          // it is the note. A row reading only `broken.caption` would be a finding
          // whose subject is invisible.
          note: `showIf names '${c.field}'`,
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
        // No note: `block` and `field` are the entire finding, and every row of this
        // family says the same thing about a different pair. See `Explained.note` —
        // absent is the answer, not an omission.
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
        // Which of the two ways it is hidden, which is the only thing that varies.
        note: why,
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
        // The kind, which is the only varying word in a sentence that is otherwise
        // identical on every row — this is the family the note exists for.
        note: field.kind,
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
          note: field.kind,
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
          // No note: the block and the field are the whole finding, exactly as in
          // `unknown-summary-field`.
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

/**
 * The whole-document checks, over documents a caller already has. No tally and
 * no re-sort: each check has already ordered its own findings by whatever makes
 * that check readable.
 */
export function auditStories(
  stories: readonly AuditedStory[],
  ctx: AuditContext = NO_CONTEXT,
): StoryFinding[] {
  return STORY_CHECKS.flatMap((check) => [...check(stories, ctx)])
}

/**
 * The content half on its own, over documents a caller already has.
 *
 * `id` is optional so a test can pass a bare `{ doc }` literal, which the file
 * header treats as worth keeping; a caller that has one gets it back in each
 * finding's `sample`, which is what lets a tally still be opened.
 */
export function auditDocuments(
  docs: readonly { id?: string; doc: { bloks: Record<string, Blok> } }[],
  schema: SchemaIndex,
  ctx: AuditContext = NO_CONTEXT,
): ContentFinding[] {
  const tally = new Map<string, ContentFinding>()

  for (const { id, doc } of docs) {
    const seenInDoc = new Set<string>()
    for (const blok of Object.values(doc.bloks)) {
      const def = schema[blok.type]
      for (const check of DOCUMENT_CHECKS) {
        for (const finding of check(blok, def, ctx)) {
          const key = `${finding.check} ${finding.type} ${finding.field ?? ''}`
          const row = tally.get(key) ?? { ...finding, documents: 0, bloks: 0, sample: [] }
          row.bloks++
          if (!seenInDoc.has(key)) {
            seenInDoc.add(key)
            row.documents++
            // Under the cap only: `documents` is already the answer to "how
            // many". Sampled per *document* rather than per blok, because two
            // faulty bloks on one page are one thing to go and look at.
            if (id !== undefined && row.sample.length < FINDING_SAMPLE) row.sample.push(id)
          }
          tally.set(key, row)
        }
      }
    }
  }

  return [...tally.values()].sort(compareContentFindings)
}

/**
 * The report's reading order: the widest drift first, then a stable tiebreak.
 *
 * Named rather than inlined because a client walking the batches has to **re-sort
 * the merged tally** — two batches each sorted by their own counts are not sorted
 * by the sum — so there is a second implementation of this ordering, in
 * `admin/ui/screens/model-model.ts`. It is restated there rather than imported
 * from here, because importing it would drag this module's `./stories` dependency
 * and the whole D1 layer into a browser bundle; that file's comment carries the
 * argument, and a unit test pins the two together.
 */
function compareContentFindings(a: ContentFinding, b: ContentFinding): number {
  return (
    b.documents - a.documents ||
    a.check.localeCompare(b.check) ||
    a.type.localeCompare(b.type) ||
    (a.field ?? '').localeCompare(b.field ?? '')
  )
}

/**
 * One batch of the walk. See the file header: up to `batch` published documents,
 * in `id` order, resumed after `continueFrom`.
 *
 * The schema half runs on **every** batch even though no document is involved, so
 * that a single response is self-describing — a caller reading one batch gets the
 * whole code-level answer with it, and a caller merging several can simply keep
 * the last one. Recomputing a pure walk over the `SchemaIndex` costs nothing next
 * to parsing a hundred documents.
 */
export async function audit(
  db: D1Database,
  schema: SchemaIndex,
  ctx: AuditContext = NO_CONTEXT,
  opts: AuditOptions = {},
): Promise<AuditReport> {
  const size = Math.min(Math.max(opts.batch ?? DEFAULT_AUDIT_BATCH, 1), MAX_AUDIT_BATCH)
  const docs = await publishedDocsAfter(db, opts.continueFrom ?? null, size)
  const content = auditDocuments(docs, schema, ctx)
  const named = (check: string) => content.filter((f) => f.check === check)

  return {
    documents: docs.length,
    // A short batch means the sweep reached the end of the table — the same test
    // `runMigrations` makes, and it costs one comparison rather than a count.
    continueFrom: docs.length === size ? (docs[docs.length - 1]?.id ?? null) : null,
    content,
    stories: auditStories(docs, ctx),
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
