/**
 * Forms and their questions, the pure vocabulary
 * (`../../docs/specs/content-model/forms.md`).
 *
 * A form is a row, not a document (architecture decision 1): `forms.fields` is
 * one validated JSON column rather than a table per question (decision 2), so
 * `validateFormFields` is the one place a stored array becomes a typed one —
 * called by the PATCH route before it writes, the admin builder before it lets
 * you save, and the submit route when it compiles a `ResolvedForm`. One
 * implementation, one test, and no way for the admin to permit a shape the
 * server refuses.
 *
 * **Screened on read, like `parseScopes` (`server/auth/roles.ts`).** A field
 * whose `kind` this build does not recognise is dropped rather than thrown on,
 * so removing a field kind from the code narrows every stored form instead of
 * breaking it. Everything else about a *recognised* kind — a missing label, a
 * reserved name, an empty option list — is a genuine validation failure and
 * throws, because a legitimate write should never produce one and a stored row
 * should never have passed through this function without already satisfying it.
 *
 * This file knows nothing about D1, Hono or React: `server/forms.ts` and the
 * admin builder both import it, and the descriptor types below travel from
 * `resolve()` (`core/resolve.ts`) to a host's `render` with no server import in
 * between.
 */
import { conditionRefusal, type FieldCondition, readCondition } from "./conditions";
import type { Json } from "./doc";
import { formState } from "./form-logic";

/** The thirteen kinds a question on a form can be. */
export type FormFieldKind =
  | "text"
  | "textarea"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "select"
  | "radio"
  | "checkbox"
  | "checkboxes"
  | "file"
  | "hidden"
  | "statement";

const FORM_FIELD_KINDS: readonly FormFieldKind[] = [
  "text",
  "textarea",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "checkboxes",
  "file",
  "hidden",
  "statement",
];

const isFormFieldKind = (x: unknown): x is FormFieldKind =>
  typeof x === "string" && (FORM_FIELD_KINDS as readonly string[]).includes(x);

/**
 * What a `file` question will take. A fixed menu, not a free content-type list:
 * an editor should not be able to invite `application/x-msdownload`.
 */
export type FileAccept = "documents" | "images" | "both";

const DOCUMENT_TYPES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
];

const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export const FILE_ACCEPT: Record<FileAccept, readonly string[]> = {
  documents: DOCUMENT_TYPES,
  images: IMAGE_TYPES,
  both: [...DOCUMENT_TYPES, ...IMAGE_TYPES],
};

export interface FormFieldOption {
  value: string;
  label: string;
}

/** Per-locale overrides. `Blok.i18n`'s shape one level down (decision 12). */
export interface FormFieldI18n {
  label?: string;
  help?: string;
  placeholder?: string;
  /** Keyed by option `value`. */
  options?: Record<string, string>;
}

export interface FormField {
  /** Slug, unique within the form. **This is the HTML input's `name`**, so it is
   *  what a submission's keys are and what a CSV column is headed. Renaming one
   *  splits a column; the builder says so. */
  name: string;
  kind: FormFieldKind;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** `maxlength` for text kinds; `max` for `number`. */
  max?: number;
  min?: number;
  /** An HTML `pattern` the host may put on the input, and which the server
   *  re-checks. Bounded, and compiled once at validation so a pathological
   *  expression is refused at save time rather than at submit time. */
  pattern?: string;
  options?: readonly FormFieldOption[];
  accept?: FileAccept;
  maxBytes?: number;
  /** `hidden` only: the value the host's markup emits. */
  value?: string;
  /** `statement` only: prose between questions. Renders no input and stores
   *  nothing. */
  text?: string;
  /**
   * Joins the row the *previous* question is in, rather than starting a new
   * one — layout, not shape (`docs/form-layout-approach.md` decision 2): it never
   * touches `shapeOf`, never bumps `version`, and a save that changes only
   * this still purges `form:<id>` (`server/forms.ts`'s `updateForm`).
   * Narrowed rather than refused when it cannot apply — the form's first
   * question, and the one right after a `statement` — see `rowsOf`.
   */
  beside?: boolean;
  /**
   * This question's share of its row, relative to its row-mates — an `fr`
   * unit, not a percentage, so a hidden neighbour never leaves a gap that has
   * to be recomputed (owner decision: relative shares, 1–4). Absent means 1,
   * which is why the type excludes it: a stored `1` and no key at all would
   * be the same fact recorded two ways.
   */
  grow?: 2 | 3 | 4;
  /**
   * Asked only while this holds (`docs/specs/content-model/form-logic.md`
   * decision 2). Evaluated against the answers of earlier, asked questions only.
   */
  showIf?: FieldCondition;
  /**
   * Required whenever asked *and* this holds. Evaluated against every asked
   * question's answer, so it may name a later one: that is what lets "email or
   * phone, at least one" be written without a cycle.
   */
  requireIf?: FieldCondition;
  /** The `FormSection` this question belongs to. Members are contiguous. */
  section?: string;
  /** Keeps a not-asked question's cell as `shown: false` so its row-mates do not
   *  widen. Layout. */
  hold?: true;
  /** Seeds this question from the page's query parameter of the same name.
   *  Presentation: the server validates what is posted. */
  prefill?: "query";
  i18n?: Record<string, FormFieldI18n>;
}

/** A group of questions under one heading, which can carry its own `showIf`. */
export interface FormSection {
  /** Slug, unique among sections. */
  name: string;
  label: string;
  help?: string;
  showIf?: FieldCondition;
  i18n?: Record<string, { label?: string; help?: string }>;
}

/** What `forms.layout` stores. The home for slice 3's `steps` too. */
export interface FormLayout {
  sections?: readonly FormSection[];
}

export const MAX_FORM_SECTIONS = 20;

export const MAX_FORM_FIELDS = 60;
/** Names beginning with this are Folio's (decision 13). The builder refuses one. */
export const RESERVED_PREFIX = "_";

/** A `pattern`'s own length cap, so a save-time compile check cannot itself be
 *  the pathological input. Generous for any legitimate HTML `pattern`. */
const MAX_PATTERN_LENGTH = 200;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const OPTION_KINDS: ReadonlySet<FormFieldKind> = new Set(["select", "radio", "checkboxes"]);

/**
 * The slug `forms.name` is minted from. Same shape as `story.ts`'s `slugify` —
 * lowercase, one word joined by hyphens, bounded — with its own fallback,
 * because "a form with no name yet" is not "an untitled page".
 */
export function formSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "form"
  );
}

function validateOption(raw: unknown, fieldName: string, seen: Set<string>): FormFieldOption {
  if (!raw || typeof raw !== "object") {
    throw new Error(`forms: field "${fieldName}" has a malformed option`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== "string" || o.value === "") {
    throw new Error(`forms: field "${fieldName}" has an option with no value`);
  }
  if (seen.has(o.value)) {
    throw new Error(`forms: field "${fieldName}" has a duplicate option value "${o.value}"`);
  }
  seen.add(o.value);
  return { value: o.value, label: typeof o.label === "string" ? o.label : o.value };
}

function validateOptions(raw: unknown, fieldName: string): readonly FormFieldOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`forms: field "${fieldName}" needs at least one option`);
  }
  const seen = new Set<string>();
  return raw.map((item) => validateOption(item, fieldName, seen));
}

/**
 * Best-effort, unlike the rest of this function: a translation that arrived
 * malformed is dropped rather than failing the whole save, the same posture
 * `localeChain` takes toward a missing translation — a hole, not an error.
 */
function validateFieldI18n(raw: unknown): Record<string, FormFieldI18n> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, FormFieldI18n> = {};
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const entry: FormFieldI18n = {};
    if (typeof v.label === "string") entry.label = v.label;
    if (typeof v.help === "string") entry.help = v.help;
    if (typeof v.placeholder === "string") entry.placeholder = v.placeholder;
    if (v.options && typeof v.options === "object") {
      const options: Record<string, string> = {};
      for (const [key, optionLabel] of Object.entries(v.options as Record<string, unknown>)) {
        if (typeof optionLabel === "string") options[key] = optionLabel;
      }
      if (Object.keys(options).length > 0) entry.options = options;
    }
    if (Object.keys(entry).length > 0) out[locale] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateOneField(raw: Record<string, unknown>, kind: FormFieldKind): FormField {
  const name = raw.name;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`forms: invalid field name ${JSON.stringify(name)}`);
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `forms: field name "${name}" starts with the reserved prefix "${RESERVED_PREFIX}"`,
    );
  }

  const label = raw.label;
  if (typeof label !== "string" || label === "") {
    throw new Error(`forms: field "${name}" needs a label`);
  }

  const field: FormField = { name, kind, label };

  if (typeof raw.help === "string") field.help = raw.help;
  if (typeof raw.placeholder === "string") field.placeholder = raw.placeholder;
  if (typeof raw.required === "boolean") field.required = raw.required;
  if (typeof raw.max === "number" && Number.isFinite(raw.max)) field.max = raw.max;
  if (typeof raw.min === "number" && Number.isFinite(raw.min)) field.min = raw.min;

  if (typeof raw.pattern === "string") {
    if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`forms: field "${name}"'s pattern is too long`);
    }
    try {
      new RegExp(raw.pattern);
    } catch {
      throw new Error(`forms: field "${name}" has an invalid pattern`);
    }
    field.pattern = raw.pattern;
  }

  if (OPTION_KINDS.has(kind)) {
    field.options = validateOptions(raw.options, name);
  }

  if (kind === "file") {
    if (raw.accept !== "documents" && raw.accept !== "images" && raw.accept !== "both") {
      throw new Error(`forms: field "${name}" needs a valid accept`);
    }
    field.accept = raw.accept;
    if (raw.maxBytes !== undefined) {
      if (typeof raw.maxBytes !== "number" || !Number.isFinite(raw.maxBytes) || raw.maxBytes <= 0) {
        throw new Error(`forms: field "${name}" has an invalid maxBytes`);
      }
      field.maxBytes = raw.maxBytes;
    }
  }

  if (kind === "hidden") {
    field.value = typeof raw.value === "string" ? raw.value : "";
  }

  if (kind === "statement") {
    if (typeof raw.text !== "string" || raw.text === "") {
      throw new Error(`forms: field "${name}" needs statement text`);
    }
    field.text = raw.text;
  }

  // Layout, not shape: a bad value is dropped rather than thrown on, the same
  // posture every other presentational key here takes — `readFields` calls
  // this too, and a layout mistake must never turn into `[]` (narrow on read;
  // the builder's own controls are what refuse on write).
  if (typeof raw.beside === "boolean") field.beside = raw.beside;
  if (raw.grow === 2 || raw.grow === 3 || raw.grow === 4) field.grow = raw.grow;

  // Logic, narrowed the same way (spec 35 decision 3): nothing here throws, because
  // `readFields` calls this and a throw is a live form with no questions. The
  // strict checks are `checkFormLogic`'s, on write only. A `showIf` that is not an
  // object becomes a never-true node (the question is never asked, so it can
  // neither block a submission nor store an answer); a `requireIf` that is
  // malformed is dropped.
  if (raw.showIf !== undefined) field.showIf = readCondition(raw.showIf) ?? { any: [] };
  if (kind !== "statement" && raw.requireIf !== undefined) {
    const requireIf = readCondition(raw.requireIf);
    if (requireIf) field.requireIf = requireIf;
  }
  if (typeof raw.section === "string" && NAME.test(raw.section)) field.section = raw.section;
  if (raw.hold === true) field.hold = true;
  if (raw.prefill === "query" && kind !== "file" && kind !== "statement") field.prefill = "query";

  if (raw.i18n !== undefined) {
    const i18n = validateFieldI18n(raw.i18n);
    if (i18n) field.i18n = i18n;
  }

  return field;
}

/**
 * The one validator, called by the PATCH route, the builder and the compiler
 * (decision 2). `input` is already-parsed JSON — a caller reading `forms.fields`
 * back from D1 does its own `JSON.parse` first, the same convention
 * `parseScopes` uses for `api_tokens.scopes`.
 *
 * Bounded at `MAX_FORM_FIELDS`, and every `name` unique and outside
 * `RESERVED_PREFIX` — both are save-time failures, not narrowing, because a
 * legitimate write can never produce either.
 */
export function validateFormFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) {
    throw new Error("forms: fields must be an array");
  }
  if (input.length > MAX_FORM_FIELDS) {
    throw new Error(`forms: at most ${MAX_FORM_FIELDS} fields, got ${input.length}`);
  }

  const out: FormField[] = [];
  const seenNames = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new Error("forms: a field must be an object");
    }
    const candidate = raw as Record<string, unknown>;

    // Screened on read: a kind this build does not know is dropped rather than
    // thrown on, so removing a field kind from the code narrows every stored
    // form instead of breaking it (parseScopes' rule, roles.ts:83).
    if (!isFormFieldKind(candidate.kind)) continue;

    const field = validateOneField(candidate, candidate.kind);
    if (seenNames.has(field.name)) {
      throw new Error(`forms: duplicate field name "${field.name}"`);
    }
    seenNames.add(field.name);
    out.push(field);
  }

  return out;
}

/* ------------------------------------------------------------ layout & logic --- */

function validateSectionI18n(raw: unknown): FormSection["i18n"] {
  if (!raw || typeof raw !== "object") return undefined;
  const out: NonNullable<FormSection["i18n"]> = {};
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const entry: { label?: string; help?: string } = {};
    if (typeof v.label === "string") entry.label = v.label;
    if (typeof v.help === "string") entry.help = v.help;
    if (Object.keys(entry).length > 0) out[locale] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The strict half for `forms.layout` (spec 35 decision 8): names unique and
 * well-formed, every section labelled, conditions well formed, at most
 * `MAX_FORM_SECTIONS`. Throws, so the PATCH route and the builder refuse a bad
 * layout. Which questions belong to which section, and whether that makes sense, is
 * `checkFormLogic`'s.
 */
export function validateFormLayout(input: unknown, _fields: readonly FormField[]): FormLayout {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("forms: layout must be an object");
  }
  const raw = (input as Record<string, unknown>).sections;
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) throw new Error("forms: layout sections must be an array");
  if (raw.length > MAX_FORM_SECTIONS) {
    throw new Error(`forms: at most ${MAX_FORM_SECTIONS} sections, got ${raw.length}`);
  }
  const seen = new Set<string>();
  const sections: FormSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("forms: a section must be an object");
    const s = item as Record<string, unknown>;
    if (typeof s.name !== "string" || !NAME.test(s.name)) {
      throw new Error(`forms: invalid section name ${JSON.stringify(s.name)}`);
    }
    if (seen.has(s.name)) throw new Error(`forms: duplicate section name "${s.name}"`);
    seen.add(s.name);
    if (typeof s.label !== "string" || s.label === "") {
      throw new Error(`forms: section "${s.name}" needs a label`);
    }
    const section: FormSection = { name: s.name, label: s.label };
    if (typeof s.help === "string") section.help = s.help;
    if (s.showIf !== undefined) {
      const refusal = conditionRefusal(s.showIf);
      if (refusal) throw new Error(`forms: section "${s.name}": ${refusal}`);
      const showIf = readCondition(s.showIf);
      if (showIf) section.showIf = showIf;
    }
    const i18n = validateSectionI18n(s.i18n);
    if (i18n) section.i18n = i18n;
    sections.push(section);
  }
  return sections.length > 0 ? { sections } : {};
}

/**
 * The narrowing half, for the read path: never throws, and never empties a form. A
 * section that is malformed or unnamed is dropped; a `showIf` that is not a usable
 * condition becomes never-true (like a question's, so what it held is never asked);
 * a member whose section is unknown, or that has already closed (membership is
 * contiguous), loses its membership; a section left with no members is dropped.
 * Returns the fields too, since clearing a membership changes them.
 */
export function readFormLayout(
  input: unknown,
  fields: readonly FormField[],
): { layout: FormLayout; fields: FormField[] } {
  const known = new Map<string, FormSection>();
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).sections
      : undefined;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (known.size >= MAX_FORM_SECTIONS) break;
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;
      if (typeof s.name !== "string" || !NAME.test(s.name) || known.has(s.name)) continue;
      if (typeof s.label !== "string" || s.label === "") continue;
      const section: FormSection = { name: s.name, label: s.label };
      if (typeof s.help === "string") section.help = s.help;
      if (s.showIf !== undefined) section.showIf = readCondition(s.showIf) ?? { any: [] };
      const i18n = validateSectionI18n(s.i18n);
      if (i18n) section.i18n = i18n;
      known.set(s.name, section);
    }
  }

  const closed = new Set<string>();
  const used = new Set<string>();
  let open: string | undefined;
  const out = fields.map((f): FormField => {
    const name = f.section;
    if (name === open) {
      if (name !== undefined) used.add(name);
      return f;
    }
    if (open !== undefined) closed.add(open);
    if (name === undefined || !known.has(name) || closed.has(name)) {
      open = undefined;
      if (name === undefined) return f;
      const { section: _dropped, ...rest } = f;
      return rest;
    }
    open = name;
    used.add(name);
    return f;
  });

  const sections = [...known.values()].filter((s) => used.has(s.name));
  // A section dropped for having no members can have none to clear; one dropped
  // for being unknown was cleared above.
  return { layout: sections.length > 0 ? { sections } : {}, fields: out };
}

const VALUE_BEARING = (kind: FormFieldKind) => kind !== "file" && kind !== "statement";

type Leaf = Extract<FieldCondition, { field: string }>;

function leavesOf(condition: FieldCondition): Leaf[] {
  if ("all" in condition) return condition.all.flatMap(leavesOf);
  if ("any" in condition) return condition.any.flatMap(leavesOf);
  if ("not" in condition) return leavesOf(condition.not);
  return "field" in condition ? [condition] : [];
}

const TEXT_ANSWER_KINDS: ReadonlySet<FormFieldKind> = new Set([
  "text",
  "textarea",
  "email",
  "tel",
  "url",
  "date",
  "hidden",
]);

/** Why `leaf` cannot be asked of `source`, or `null`. The table in spec 35's
 *  Core types, one operator list and one value rule per kind. */
function leafRefusal(leaf: Leaf, source: FormField): string | null {
  const op = (["eq", "ne", "in", "isSet", "includes"] as const).find((o) => o in leaf);
  if (!op) return "has no operator";
  const values: readonly Json[] =
    op === "in"
      ? (leaf as { in: readonly Json[] }).in
      : op === "isSet"
        ? []
        : [(leaf as unknown as Record<string, Json>)[op] as Json];
  const declared = new Set((source.options ?? []).map((o) => o.value));

  switch (source.kind) {
    case "select":
    case "radio":
      if (op === "includes") return `compares with "${op}", which it cannot answer`;
      return values.every((v) => typeof v === "string" && declared.has(v))
        ? null
        : "compares with an option it does not have";
    case "checkboxes":
      if (op !== "includes" && op !== "isSet")
        return `compares with "${op}", which it cannot answer`;
      return values.every((v) => typeof v === "string" && declared.has(v))
        ? null
        : "compares with an option it does not have";
    case "checkbox":
      if (op !== "eq") return `compares with "${op}", which it cannot answer`;
      return typeof values[0] === "boolean"
        ? null
        : "compares with something other than ticked or not";
    case "number":
      if (op === "includes") return `compares with "${op}", which it cannot answer`;
      return values.every((v) => typeof v === "number" && Number.isFinite(v))
        ? null
        : "compares with something that is not a number";
    default:
      if (!TEXT_ANSWER_KINDS.has(source.kind) || op === "includes") {
        return `compares with "${op}", which it cannot answer`;
      }
      return values.every((v) => typeof v === "string" && v.length <= 120)
        ? null
        : "compares with text longer than 120 characters";
  }
}

/**
 * The write-time refusals for conditions and sections (spec 35 decision 3), thrown
 * as a plain `Error` naming the questions by label and slug for an editor. Run on
 * every save, and by the builder before it enables Save. **Never on read**: a
 * dangling reference reads as absent there.
 */
export function checkFormLogic(fields: readonly FormField[], layout: FormLayout = {}): void {
  const indexOf = new Map(fields.map((f, i) => [f.name, i]));
  const tag = (f: FormField) => `"${f.label}" (${f.name})`;

  const check = (
    owner: string,
    condition: FieldCondition,
    verb: "shown" | "required",
    ownIndex: number | null,
    limit: number,
  ) => {
    for (const leaf of leavesOf(condition)) {
      const at = indexOf.get(leaf.field);
      const source = at === undefined ? undefined : fields[at];
      if (at === undefined || !source) {
        throw new Error(
          `${owner} depends on "${leaf.field}", which is not a question on this form`,
        );
      }
      if (at === ownIndex) throw new Error(`${owner} cannot depend on itself`);
      if (verb === "shown" && at >= limit) {
        throw new Error(
          `${owner} can only be shown based on a question above it, but ${tag(source)} is below it`,
        );
      }
      if (!VALUE_BEARING(source.kind)) {
        throw new Error(`${owner} cannot depend on ${tag(source)}, which has no answer to compare`);
      }
      const reason = leafRefusal(leaf, source);
      if (reason) throw new Error(`${owner} ${reason} for ${tag(source)}`);
    }
  };

  fields.forEach((f, i) => {
    if (f.showIf) check(`${tag(f)}'s show rule`, f.showIf, "shown", i, i);
    if (f.requireIf) {
      if (f.kind === "statement")
        throw new Error(`${tag(f)} asks nothing, so it cannot be required`);
      if (f.required) {
        throw new Error(`${tag(f)} cannot be both always required and required only sometimes`);
      }
      check(`${tag(f)}'s required rule`, f.requireIf, "required", i, fields.length);
    }
  });

  const sections = layout.sections ?? [];
  const names = new Set(sections.map((s) => s.name));
  for (const f of fields) {
    if (f.section !== undefined && !names.has(f.section)) {
      throw new Error(`${tag(f)} is in section "${f.section}", which does not exist`);
    }
  }
  for (const section of sections) {
    const members = fields.flatMap((f, i) => (f.section === section.name ? [i] : []));
    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error(`Section "${section.label}" has no questions`);
    }
    if (last - first + 1 !== members.length) {
      throw new Error(`Section "${section.label}" has questions that are not together`);
    }
    if (section.showIf) {
      check(`Section "${section.label}"'s show rule`, section.showIf, "shown", null, first);
    }
  }
}

/**
 * Which `FormField` keys the server's rules read (`'shape'`) and which only a page
 * draws (`'presentation'`). Typed over `keyof FormField`, so adding a key is a
 * type error until somebody classifies it, and a unit test drives `shapeOf` from
 * this record: it must move for every `'shape'` key and for no `'presentation'`
 * one. `section` is presentation because membership matters only through the
 * section's own condition, which `shapeOf` folds into the question's visibility.
 */
export const FORM_FIELD_KEYS: Record<keyof FormField, "shape" | "presentation"> = {
  name: "shape",
  kind: "shape",
  label: "presentation",
  help: "presentation",
  placeholder: "presentation",
  required: "shape",
  max: "shape",
  min: "shape",
  pattern: "shape",
  options: "shape",
  accept: "shape",
  maxBytes: "shape",
  value: "presentation",
  text: "presentation",
  beside: "presentation",
  grow: "presentation",
  showIf: "shape",
  requireIf: "shape",
  section: "presentation",
  hold: "presentation",
  prefill: "presentation",
  i18n: "presentation",
};

/**
 * The projection `forms.version` is bumped from: everything the server enforces
 * (decision 11). Per question: name, kind, `required`, `requireIf`, effective
 * visibility (its own `showIf` and its section's, as a pair), option values, `min`,
 * `max`, `pattern`, `accept` and `maxBytes`. Nothing a label, help, placeholder,
 * translation, layout or prefill edit would touch. Pure, and comparable by simple
 * string equality against what is stored; never stored itself.
 */
export function shapeOf(fields: readonly FormField[], layout: FormLayout = {}): string {
  const sectionShowIf = new Map((layout.sections ?? []).map((s) => [s.name, s.showIf]));
  return JSON.stringify(
    fields.map((f) => ({
      name: f.name,
      kind: f.kind,
      required: !!f.required,
      requireIf: f.requireIf,
      showIf: f.showIf,
      sectionShowIf: f.section === undefined ? undefined : sectionShowIf.get(f.section),
      options: f.options?.map((o) => o.value),
      min: f.min,
      max: f.max,
      pattern: f.pattern,
      accept: f.accept,
      maxBytes: f.maxBytes,
    })),
  );
}

/** At most this many questions share one row (`docs/form-layout-approach.md`'s
 *  Candidate C: "Name with a title field is four; HubSpot caps at three"). A
 *  fifth `beside` question narrows into a row of its own rather than refusing
 *  the save — `rowsOf` never throws. */
export const MAX_ROW_CELLS = 4;

/**
 * Which row each question falls in, in `fields`' own order — the one
 * algorithm behind both `compileField`'s `row` and the admin builder's own
 * grouping (`form-model.ts`'s `fieldRows`, which must agree with this on
 * where a row starts; it disagrees on purpose about `hidden` fields, which
 * this reuses the previous row number for and that function shows as their
 * own line).
 *
 * A row is the first question plus every following question with `beside`.
 * The start of the form, a `statement` and a row already at `MAX_ROW_CELLS`
 * all start a fresh one — a `statement` starts a row of one and forces the
 * *next* question into a fresh row too, whatever its own `beside` says.
 * A change of `section` between consecutive questions starts a fresh row too.
 * `hidden` questions are layout-transparent: they neither join nor break a
 * row and are not counted against the cap, so this narrows a form that has
 * one wedged between two halves of what is visually one row.
 *
 * Returns one row number per field, same length and order as `fields` — a
 * `hidden` question's number is borrowed from whichever row is open when it
 * is reached (or `0` before the first one opens), because nothing groups by
 * it; `formLayout` filters `hidden` out before grouping by row number at all.
 */
export function rowsOf(fields: readonly FormField[]): number[] {
  const rows: number[] = [];
  let row = -1;
  let cellsInRow = 0;
  let breaksNext = true; // the start of the form breaks a row
  let prevSection: string | undefined;
  for (const field of fields) {
    if (field.kind === "hidden") {
      rows.push(Math.max(row, 0));
      continue;
    }
    const isStatement = field.kind === "statement";
    if (
      isStatement ||
      breaksNext ||
      !field.beside ||
      cellsInRow >= MAX_ROW_CELLS ||
      field.section !== prevSection
    ) {
      row += 1;
      cellsInRow = 0;
    }
    rows.push(row);
    cellsInRow += 1;
    breaksNext = isStatement;
    prevSection = field.section;
  }
  return rows;
}

/**
 * A fixed pool of plausible-looking decoy field names (decision 9) — a
 * reserved-looking name like `_hp` is a name a competent bot skips, so the
 * honeypot instead looks like an ordinary, boring input a form might have.
 */
const HONEYPOT_POOL: readonly string[] = [
  "company_website",
  "fax",
  "url_confirm",
  "middle_name",
  "company_name",
  "phone_extension",
  "address_2",
  "department",
  "reference_code",
  "home_page",
  "contact_id",
  "account_number",
];

/** A small, stable string hash — deterministic across runs and platforms,
 *  which `Array.prototype.sort`'s relative order and `Math.random` are not. */
function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Deterministic per form, from `HONEYPOT_POOL`, avoiding the form's own slugs
 * (decision 9). Stable per form id, so a cached page and the live route always
 * agree on which input is the decoy — the builder refuses a field slug that
 * collides with it.
 */
export function honeypotName(formId: string, taken: readonly string[]): string {
  const takenNames = new Set(taken);
  const available = HONEYPOT_POOL.filter((name) => !takenNames.has(name));
  const pool = available.length > 0 ? available : HONEYPOT_POOL;
  const index = ((stableHash(formId) % pool.length) + pool.length) % pool.length;
  // `index` is derived from `pool.length` itself, so it is always in bounds —
  // `noUncheckedIndexedAccess` cannot see that from a computed index.
  return pool[index]!;
}

/* --------------------------------------------------------------- descriptor --- */

/** What a `render` receives for one question, already resolved through the
 *  locale chain (decision 12) — a host writes no locale code at all. */
export interface ResolvedFormField {
  name: string;
  kind: FormFieldKind;
  /** Already resolved through the locale chain. */
  label: string;
  help?: string;
  placeholder?: string;
  /** **Unconditionally** required: the stored flag, and neither the question nor
   *  its section has a `showIf`, and it has no `requireIf`. A host that renders
   *  `required={field.required}` with no engine can therefore never put a browser
   *  `required` on a question that might not apply (spec 35 decision 6). A
   *  conditionally asked question stored as required compiles to `false` plus
   *  `requireIf: { all: [] }`, which `formState` reads as required whenever asked. */
  required: boolean;
  max?: number;
  min?: number;
  pattern?: string;
  options?: readonly FormFieldOption[];
  accept?: readonly string[];
  maxBytes?: number;
  value?: string;
  text?: string;
  /** Which row this question is in, in `fields`' own order — consecutive
   *  fields sharing a number form one row (`rowsOf`). Always present, unlike
   *  everything else optional above, so a host can group `fields` itself
   *  without reaching for `formLayout` when all it wants is the numbers. */
  row: number;
  /** This question's share of its row, relative to its row-mates. Always
   *  present and `1` when the stored `FormField` left `grow` unset — a host
   *  writes `` `${grow}fr` `` straight onto a grid track with no fallback of
   *  its own to remember. */
  grow: number;
  /** The section this question is in, by `ResolvedFormSection.name`. */
  section?: string;
  /** Asked only while this holds. Emitted only when set. */
  showIf?: FieldCondition;
  /** Required whenever asked and this holds. Emitted only when set. */
  requireIf?: FieldCondition;
  hold?: true;
  /** `'query'`: seed this question from the page's query string
   *  (`prefillAnswers`). */
  prefill?: "query";
}

/**
 * What a `form` field resolves to (`core/resolve.ts`'s `resolveValue`,
 * architecture decision 4): everything a host needs to render a working form
 * and nothing it has to derive — the action URL, the encoding, the honeypot's
 * name, and every question already localised.
 */
export interface ResolvedForm {
  id: string;
  /** The slug, for a page carrying two forms. */
  name: string;
  /** `{base}/f/<id>`. Computed at render, never stored — remounting Folio under a
   *  different base path must not invalidate anything, the rule `assetBase`
   *  already follows. */
  action: string;
  method: "post";
  enctype: "application/x-www-form-urlencoded" | "multipart/form-data";
  version: number;
  /** `open` and the clock, together. */
  open: boolean;
  fields: readonly ResolvedFormField[];
  /** Always present, `[]` with none. Questions name theirs in `section`. */
  sections: readonly ResolvedFormSection[];
  /** `_folio_page` when the render knows its path; empty otherwise. */
  hidden: readonly { name: string; value: string }[];
  honeypot: string;
  submitLabel: string;
  successMessage: string;
  closedMessage: string;
  redirectTo: string | null;
}

/* ------------------------------------------------------------- formLayout --- */

/** One section: its legend, and the condition that shows it. */
export interface ResolvedFormSection {
  name: string;
  label: string;
  help?: string;
  showIf?: FieldCondition;
}

/** One cell of a row. `shown` is `false` only for a `hold`ing question that is not
 *  asked; a host renders `!shown` as an empty, `aria-hidden` slot rather than
 *  omitting it, which is what lets a `hold`ing neighbour keep its place.
 *  `required` is the effective requiredness: the engine's with answers, the
 *  descriptor's static flag without. */
export interface LayoutCell {
  field: ResolvedFormField;
  grow: number;
  shown: boolean;
  required: boolean;
}

/** One row: a stable `key` (the row's first field's name, unique across the
 *  form) and its cells, left to right in `fields`' own order. */
export interface LayoutRow {
  key: string;
  cells: readonly LayoutCell[];
}

/** A section's own rows. `section` is `null` for the questions outside any. */
export interface LayoutSection {
  section: ResolvedFormSection | null;
  rows: readonly LayoutRow[];
}

/** What `formLayout` hands a host: rows to render in order, grouped into
 *  sections, plus the `hidden`-kind questions rows have no room for. */
export interface FormLayoutView {
  sections: readonly LayoutSection[];
  /** `hidden`-kind questions: position-free, rendered anywhere inside the
   *  `<form>` — a host emits each as `<input type="hidden">` and moves on. */
  inputs: readonly ResolvedFormField[];
}

/**
 * Groups a compiled form's `fields` into the rows and sections a host draws —
 * the one function so no host reimplements the grouping `rowsOf` already
 * computed server-side (`docs/form-layout-approach.md` Candidate C). Pure: no
 * fetch, no DOM, safe to call from a server render and from a preview bundle
 * alike.
 *
 * **With no `answers`, everything is present** (spec 35 decision 7): every
 * question and section, every cell `shown`, `cell.required` the descriptor's static
 * flag. That is what a visitor with no script needs: they see every question, the
 * server works out which applied, and nothing they cannot see is required.
 *
 * **With `answers`, it evaluates** (`formState`): a cell whose question is not
 * asked is removed unless it `hold`s, in which case it stays with `shown: false`; a
 * row with no shown cell is removed; a section whose `showIf` fails, or that has no
 * rows left, is removed; and `inputs` keeps only asked questions, so an unasked
 * hidden input does not post. A section with no rows is dropped in both modes.
 */
export function formLayout(form: ResolvedForm, answers?: Record<string, Json>): FormLayoutView {
  const state = answers === undefined ? null : formState(form, answers);
  // A descriptor a host cached across a deploy can predate `sections`.
  const defs = new Map((form.sections ?? []).map((s) => [s.name, s]));
  const inputs: ResolvedFormField[] = [];
  const rows: { cells: LayoutCell[]; section: ResolvedFormSection | null }[] = [];
  let openRow: number | null = null;

  for (const field of form.fields) {
    const asked = state === null || state.asked.has(field.name);
    if (field.kind === "hidden") {
      if (asked) inputs.push(field);
      continue;
    }
    // `row`/`grow` are typed as always present, but a descriptor a host cached
    // across a deploy (KV, its own `caches.default`) can be one an older
    // `compileField` built, before either existed — narrowed here rather than
    // trusted, the same posture `readFields` takes toward a stored row. A
    // missing `row` falls back to a row of its own, never one row holding the
    // whole form (`null` never equals `null` below, only a **present**
    // `openRow` joins), and a missing `grow` falls back to the 1 default.
    const row = typeof field.row === "number" ? field.row : null;
    const grow = typeof field.grow === "number" ? field.grow : 1;
    const cell: LayoutCell | null =
      asked || field.hold
        ? {
            field,
            grow,
            shown: asked,
            required: state === null ? field.required : state.required.has(field.name),
          }
        : null;
    const section = (field.section !== undefined && defs.get(field.section)) || null;
    const last = rows[rows.length - 1];
    if (row !== null && row === openRow && last) {
      if (cell) last.cells.push(cell);
    } else {
      rows.push({ cells: cell ? [cell] : [], section });
      openRow = row;
    }
  }

  const groups: { section: ResolvedFormSection | null; rows: LayoutRow[] }[] = [];
  for (const row of rows) {
    if (!row.cells.some((c) => c.shown)) continue;
    if (row.section && state && !state.sections.has(row.section.name)) continue;
    const layoutRow: LayoutRow = { key: row.cells[0]!.field.name, cells: row.cells };
    const group = groups[groups.length - 1];
    if (group && group.section?.name === row.section?.name) group.rows.push(layoutRow);
    else groups.push({ section: row.section, rows: [layoutRow] });
  }

  return { sections: groups.length > 0 ? groups : [{ section: null, rows: [] }], inputs };
}
