/**
 * Form option sources, the pure vocabulary
 * (`../../docs/specs/content-model/form-option-sources.md`).
 *
 * A `select`, `radio` or `checkboxes` question may name a source in `optionsFrom`
 * instead of (or beside) a typed list. This file is the part that needs no D1, no
 * Hono and no React: reading the descriptor, turning a `content` source's settings
 * into a query, and **materialising** a resolved list onto the question so that the
 * engine (`formState`, `validateSubmission`, `compileForm`) sees an ordinary option
 * question and does not change (decision 2).
 *
 * Imports `forms.ts` for types only: `forms.ts` imports this file for the values.
 */
import type { Json } from "./doc";
import type { FormField, FormFieldOption } from "./forms";
import type { Resolution } from "./resolve";
import {
  asCollectionValue,
  BUILT_IN_ORDERS,
  type ContentOrderSpec,
  type ContentQuery,
  type ContentWhere,
} from "./query";

/** The built-in source: published documents of one type (decision 4). */
export const CONTENT_SOURCE = "content";

/** The most options a source may put on a question (decision 10). Typed extras keep
 *  `FORM_FIELD`'s cap and are not counted. */
export const MAX_SOURCED_OPTIONS = 500;

/** A label is truncated to this many characters, `…` included (decision 4, 7). */
export const MAX_OPTION_LABEL = 200;

/** `optionsFrom.settings` is bounded in bytes of JSON, so a PATCH cannot park a
 *  megabyte in a question. */
const MAX_SETTINGS_BYTES = 4096;

/** The page size of a content source's query: `clampPerPage`'s ceiling. */
const CONTENT_PER_PAGE = 100;

const SOURCE_ID = /^[a-z][a-z0-9-]{0,47}$/;

/** `validate.ts`'s `PRINTABLE`: everything except the characters that make a stored
 *  string lie about itself (controls, lone surrogates, bidi overrides). Restated
 *  here because core imports nothing from the server. */
const PRINTABLE = /^[^\p{Cc}\p{Cs}‪-‮⁦-⁩]*$/u;

/** What a question stores to say where its options come from. */
export interface OptionsFrom {
  source: string;
  settings?: Readonly<Record<string, Json>>;
}

/** The `content` source's settings (decision 4). */
export interface ContentOptionSettings {
  type: string;
  parent?: string | null;
  where?: readonly ContentWhere[];
  order?: ContentOrderSpec;
}

/** Whether `source` is a valid source id (a host's, or `content`). */
export const isSourceId = (source: unknown): source is string =>
  typeof source === "string" && SOURCE_ID.test(source);

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key] as Json);
    return out;
  }
  return value;
}

/**
 * The descriptor on a stored question, or a throw on a structural fault: a
 * non-object, a `source` that is not a valid id, or settings that are not a plain
 * object or exceed 4096 bytes of JSON. The settings come back with their keys
 * sorted, so two spellings of one source compare equal (decision 12).
 */
export function readOptionsFrom(raw: unknown, field: string): OptionsFrom {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`forms: field "${field}" has a malformed optionsFrom`);
  }
  const o = raw as Record<string, unknown>;
  if (!isSourceId(o.source)) {
    throw new Error(`forms: field "${field}" has an optionsFrom with an invalid source`);
  }
  if (o.settings === undefined) return { source: o.source };
  if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) {
    throw new Error(`forms: field "${field}" has optionsFrom settings that are not an object`);
  }
  const settings = sortKeys(o.settings as Json) as Record<string, Json>;
  if (JSON.stringify(settings).length > MAX_SETTINGS_BYTES) {
    throw new Error(
      `forms: field "${field}" has optionsFrom settings over ${MAX_SETTINGS_BYTES} bytes`,
    );
  }
  return { source: o.source, settings };
}

/**
 * A `content` source's settings, narrowed with `asCollectionValue`'s shapes, or
 * `null` when they are not usable: `type` a non-empty string, `parent` a string or
 * null, and `where` and `order` surviving that narrowing **whole**. Strict where
 * `asCollectionValue` drops, because this is the save-time check; the double
 * enforcement against what is indexed is `contentOptionQuery`'s. Keys come back
 * sorted.
 */
export function contentOptionSettings(
  raw: Readonly<Record<string, Json>> | undefined,
): ContentOptionSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.type !== "string" || raw.type === "") return null;
  const out: ContentOptionSettings = { type: raw.type };
  if (raw.parent !== undefined) {
    if (raw.parent !== null && typeof raw.parent !== "string") return null;
    out.parent = raw.parent;
  }
  const narrowed = asCollectionValue({
    ...(raw.where !== undefined ? { where: raw.where } : {}),
    ...(raw.order !== undefined ? { order: raw.order } : {}),
  });
  if (raw.where !== undefined) {
    if (!Array.isArray(raw.where) || narrowed.where?.length !== raw.where.length) return null;
    out.where = narrowed.where;
  }
  if (raw.order !== undefined) {
    const o = raw.order as Record<string, Json>;
    if (!narrowed.order || o.dir !== narrowed.order.dir) return null;
    out.order = narrowed.order;
  }
  return sortKeys(out as unknown as Json) as unknown as ContentOptionSettings;
}

/**
 * The query a content source runs, for page `page` (default 1). Keeps only the
 * `where` entries and the `order` that name a field indexed on the type's root
 * block, or a built-in order other than `relevance`: the double enforcement
 * `collectionQuery` applies, so a field that has stopped being indexed never
 * reaches `contentSql` and throws mid-render. Defaults to `title` ascending.
 */
export function contentOptionQuery(
  s: ContentOptionSettings,
  rootIndexed: ReadonlySet<string>,
  page = 1,
): ContentQuery {
  const orderable = (f: string) =>
    rootIndexed.has(f) || (f in BUILT_IN_ORDERS && f !== "relevance");
  return {
    type: s.type,
    ...(s.parent !== undefined ? { parent: s.parent } : {}),
    where: (s.where ?? []).filter((w) => rootIndexed.has(w.field)),
    order: s.order && orderable(s.order.field) ? s.order : { field: "title", dir: "asc" },
    page,
    perPage: CONTENT_PER_PAGE,
    status: "published",
  };
}

/**
 * The key a list is stored and cached under: the canonical JSON of
 * `[settings, locale]` (decision 6). Key order of `settings` does not matter. The
 * caller passes `''` for a source that is not localised.
 */
export function optionListKey(
  settings: Readonly<Record<string, Json>> | undefined,
  locale: string,
): string {
  return JSON.stringify([sortKeys((settings ?? {}) as Json), locale]);
}

/**
 * One label through the screen content and host items share (decision 4, 7):
 * trimmed, printable, at most `MAX_OPTION_LABEL` characters with a trailing `…`.
 * `null` for anything that is not a usable label, so the caller can fall back to
 * the value.
 */
export function screenOptionLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !PRINTABLE.test(trimmed)) return null;
  const chars = [...trimmed];
  return chars.length > MAX_OPTION_LABEL
    ? `${chars.slice(0, MAX_OPTION_LABEL - 1).join("")}…`
    : trimmed;
}

/**
 * The question with its options filled in: sourced entries first, then the typed
 * extras (decision 2). An extra wins a value collision, so the editor's label
 * stands. `null` (the list is unavailable) gives the extras only. Every sourced
 * label goes through `screenOptionLabel`, the value standing in for a label that
 * fails it.
 *
 * - `emptyIsNotAsked`: an empty list and no extras gives `showIf: { any: [] }`,
 *   the never-true condition (decision 18). Never for `null`, which is an outage
 *   and not an answer.
 * - `collate`: a locale, to re-sort the sourced entries by label (decision 4). The
 *   query decided membership; this decides only order.
 */
export function materialiseOptions(
  field: FormField,
  list: readonly FormFieldOption[] | null,
  opts: { emptyIsNotAsked?: boolean; collate?: string } = {},
): FormField {
  const extras = field.options ?? [];
  const taken = new Set(extras.map((o) => o.value));
  let sourced = (list ?? [])
    .filter((o) => !taken.has(o.value))
    .map((o) => ({ value: o.value, label: screenOptionLabel(o.label) ?? o.value }));
  if (opts.collate !== undefined) {
    const collator = new Intl.Collator(opts.collate);
    sourced = sourced.sort((a, b) => collator.compare(a.label, b.label));
  }
  const options = [...sourced, ...extras];
  if (opts.emptyIsNotAsked && list !== null && list.length === 0 && extras.length === 0) {
    return { ...field, options, showIf: { any: [] } };
  }
  return { ...field, options };
}

/** True when any form in the resolution has a question compiled `unavailable`: the
 *  page must not be cached (decision 6). */
export function hasUnavailableOptions(resolution: Resolution): boolean {
  for (const form of Object.values(resolution.forms ?? {})) {
    for (const field of form.fields) if (field.optionsFrom?.unavailable) return true;
  }
  return false;
}
