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
import type { Blok, Doc, Json } from "./doc";
import type { Field } from "./fields";
import { fieldValue, type LocaleConfig, localeChain } from "./locales";
import type { DocumentType, SchemaIndex } from "./schema";

/** One `content_index` row, minus the story id the caller already has. */
export interface IndexRow {
  /** `''` for the source locale. */
  locale: string;
  field: string;
  text: string | null;
  num: number | null;
}

/**
 * Whether this field kind can be projected at all. The field builders make
 * `indexed` unrepresentable on anything else, so this only ever refuses a
 * hand-written or imported schema — which is exactly the case `/folio/audit`
 * reports (`indexed-unsupported`).
 */
export function isIndexableKind(field: Field): field is IndexableField {
  switch (field.kind) {
    case "text":
    case "textarea":
    case "number":
    case "boolean":
    case "select":
    case "date":
      return true;
    default:
      return false;
  }
}

/** The six kinds that can carry `indexed`, narrowed off `Field`. */
export type IndexableField = Extract<
  Field,
  { kind: "text" | "textarea" | "number" | "boolean" | "select" | "date" }
>;

/** True when this field is declared queryable. Total over every field kind, so a
 * hand-written schema marking a richtext field `indexed` reads as "not indexed"
 * rather than as a type error at a call site — the audit is what reports it. */
export function isIndexed(field: Field): boolean {
  return isIndexableKind(field) && field.indexed === true;
}

/** A block's `indexed` fields, in declaration order. */
export function indexedFields(schema: SchemaIndex, blockType: string): [string, Field][] {
  const def = schema[blockType];
  if (!def) return [];
  return Object.entries(def.fields).filter(([, field]) => isIndexed(field));
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
  const out = new Set<string>();
  for (const type of types) {
    for (const [name] of indexedFields(schema, type.root)) out.add(name);
  }
  return out;
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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

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
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return { text: value ? "true" : "false", num: value ? 1 : 0 };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { text: String(value), num: value } : null;
  }
  if (typeof value === "string") {
    if (value === "") return null;
    if (!ISO_DATE.test(value)) return { text: value, num: null };
    const parsed = Date.parse(value);
    return { text: value, num: Number.isNaN(parsed) ? null : parsed };
  }
  // An object or an array. Unrepresentable as a scalar, so no row — and the
  // audit reports the declaration that made it reachable.
  return null;
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
  const root: Blok | undefined = doc.bloks[doc.root];
  if (!root) return [];
  // The document's **own** root block type in preference to the type's declared
  // `root`: a document written before the config was changed still indexes what
  // it actually holds rather than what the config now wishes it held. They agree
  // for every document Folio itself created; `type.root` is the fallback for a
  // malformed root blok carrying no type at all.
  const fields = indexedFields(schema, root.type || (type?.root ?? ""));
  if (fields.length === 0) return [];

  const out: IndexRow[] = [];
  const push = (locale: string, field: string, value: Json | undefined) => {
    const projected = projectValue(value);
    if (projected) out.push({ locale, field, text: projected.text, num: projected.num });
  };

  for (const [name] of fields) push("", name, root.data[name]);

  for (const locale of locales?.available ?? []) {
    if (locale.code === locales?.default) continue;
    const ctx = { code: locale.code, fallbacks: localeChain(locales, locale.code) };
    for (const [name] of fields) push(locale.code, name, fieldValue(root, name, ctx));
  }

  return out;
}

/* ------------------------------------------------------------ draft values --- */

/**
 * What `stories.draft_data` holds (migration `0015`, issue #82): the root block's
 * scalar values in the draft, `data` for the source locale and `i18n` by locale
 * code, JSON-encoded.
 *
 * Schema-blind on purpose. The Durable Object that writes it knows no block
 * schemas (`story-do.ts`), so it cannot ask which fields are `indexed`; it keeps
 * every scalar of the root and `draftIndexedValues` picks the indexed ones at read
 * time. That is also why a field newly marked `indexed` needs no backfill of this
 * column, only the ordinary one for `content_index`.
 */
export interface DraftData {
  data: Record<string, string | number | boolean>;
  i18n?: Record<string, Record<string, string | number | boolean>>;
}

/** A string longer than this is cut, not dropped: a table cell shows the start of
 * a long value, and dropping it would read as "the draft cleared this field". */
export const DRAFT_STRING_MAX = 512;

/** The whole mirror's ceiling, in characters. A root block with this much scalar
 * data is not a record anybody lists in a table; values past it are left out. */
const DRAFT_DATA_MAX = 32_768;

/**
 * The root block's scalar values, bounded: strings up to `DRAFT_STRING_MAX`
 * characters, finite numbers and booleans. Objects, arrays, null and `undefined`
 * are omitted, which is also what makes this safe to run over any block: a
 * richtext or `blocks()` field never reaches the column.
 *
 * Null when there is nothing to mirror (no root, or no scalar) rather than `'{}'`,
 * so an empty mirror and a never-written one read the same.
 */
export function draftDataOf(doc: Doc): string | null {
  const root: Blok | undefined = doc.bloks[doc.root];
  if (!root) return null;
  let budget = DRAFT_DATA_MAX;
  const scalars = (source: Record<string, Json> | undefined) => {
    const out: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(source ?? {})) {
      let kept: string | number | boolean | undefined;
      if (typeof value === "string") kept = value.slice(0, DRAFT_STRING_MAX);
      else if (typeof value === "number" && Number.isFinite(value)) kept = value;
      else if (typeof value === "boolean") kept = value;
      if (kept === undefined) continue;
      budget -= name.length + String(kept).length + 6;
      if (budget < 0) break;
      out[name] = kept;
    }
    return out;
  };
  const data = scalars(root.data);
  const i18n: Record<string, Record<string, string | number | boolean>> = {};
  for (const [locale, values] of Object.entries(root.i18n ?? {})) {
    const kept = scalars(values);
    if (Object.keys(kept).length > 0) i18n[locale] = kept;
  }
  const hasI18n = Object.keys(i18n).length > 0;
  if (Object.keys(data).length === 0 && !hasI18n) return null;
  return JSON.stringify(hasI18n ? { data, i18n } : { data });
}

/** One cell of the Data table: the two index columns, and whether it came from a
 * draft that says something the published copy does not. */
export interface IndexedCell {
  text: string;
  num: number | null;
  /** Set only when the value is the draft's and differs from what is published. */
  draft?: true;
}

/**
 * The indexed fields' values as the draft says them, projected exactly as a
 * publish would (`projectValue`), for the source locale (`''`) or a declared one.
 * A field the draft has no scalar for is simply absent: a cleared field is blank
 * in the draft, and the published value is not borrowed to fill it.
 *
 * Null for absent or malformed JSON, which reads as "no mirror" rather than
 * throwing inside a list read.
 */
export function draftIndexedValues(
  draftData: string | null,
  names: Iterable<string>,
  locale = "",
): Record<string, { text: string; num: number | null }> | null {
  if (draftData === null) return null;
  let parsed: DraftData;
  try {
    parsed = JSON.parse(draftData) as DraftData;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const source = locale === "" ? parsed.data : parsed.i18n?.[locale];
  const out: Record<string, { text: string; num: number | null }> = {};
  for (const name of names) {
    const projected = projectValue(source?.[name]);
    if (projected) out[name] = projected;
  }
  return out;
}
