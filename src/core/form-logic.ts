/**
 * The one engine that decides what a form asks and what it requires
 * (`../../docs/specs/content-model/form-logic.md`, decision 1).
 *
 * Pure, React-free and DOM-free, so the same function runs in three places: the
 * submit route (`server/form-responses.ts`'s `validateSubmission`) on the posted
 * body, `formLayout` when a host hands it answers, and a host's client-side code on
 * every change. A browser is therefore never the enforcement, and the page and the
 * endpoint cannot disagree about which question applied.
 *
 * It takes a structural type (`LogicForm`) that both the stored
 * `FormField[]` + `FormSection[]` and the compiled `ResolvedForm` satisfy, so the
 * server evaluates the row it already read and a host evaluates the descriptor it
 * was handed, with no conversion in between.
 *
 * **Answers are normalised by `answerOf`, never taken as validated values**
 * (decision 5): a readable-but-invalid answer must drive conditions exactly as it
 * does in the browser, and the submission is refused for it anyway.
 */
import { type FieldCondition, matches } from "./conditions";
import type { Json } from "./doc";
import type { FormFieldKind, ResolvedForm } from "./forms";

/** A calendar date as `<input type="date">` submits one. */
export const DATE_ANSWER = /^\d{4}-\d{2}-\d{2}$/;
/** A number as a person types one. `Number('12abc')` is `NaN` and `parseInt` is
 *  `12`; neither is what the visitor meant, so the shape is screened first. */
export const NUMBER_ANSWER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The longest text `answerOf` will read as a number; the server's own cap. */
const SCALAR_ANSWER_CHARS = 64;

export interface LogicField {
  name: string;
  kind: FormFieldKind;
  section?: string;
  showIf?: FieldCondition;
  required?: boolean;
  requireIf?: FieldCondition;
  options?: readonly { value: string }[];
}

export interface LogicForm {
  fields: readonly LogicField[];
  sections?: readonly { name: string; showIf?: FieldCondition }[];
}

export interface FormState {
  asked: ReadonlySet<string>;
  required: ReadonlySet<string>;
  /** Sections shown. */
  sections: ReadonlySet<string>;
  /** Normalised answers of asked questions only. */
  answers: Record<string, Json>;
}

/**
 * What a browser would have posted for one question, as the value a condition
 * sees. `undefined` for blank or unreadable. The two tick-box kinds answer `false`
 * and `[]` rather than `undefined`, as the validator stores them.
 */
export function answerOf(
  field: { kind: FormFieldKind; options?: readonly { value: string }[] },
  raw: readonly string[],
): Json | undefined {
  const first = raw[0] ?? "";
  switch (field.kind) {
    case "statement":
    case "file":
      return undefined;
    case "checkbox":
      return raw.length > 0 && first !== "" && first !== "false";
    case "checkboxes": {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      return [...new Set(raw.filter((v) => v !== "" && allowed.has(v)))];
    }
    case "select":
    case "radio":
      return (field.options ?? []).some((o) => o.value === first) ? first : undefined;
    case "number": {
      const text = first.trim();
      if (text === "" || text.length > SCALAR_ANSWER_CHARS || !NUMBER_ANSWER.test(text)) {
        return undefined;
      }
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    case "date": {
      const text = first.trim();
      if (!DATE_ANSWER.test(text)) return undefined;
      // `2026-02-31` matches the shape and is not a day.
      const parsed = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        return undefined;
      }
      return text;
    }
    case "textarea": {
      const text = first.replace(/\r\n/g, "\n").trim();
      return text === "" ? undefined : text;
    }
    case "text":
    case "email":
    case "tel":
    case "url":
    case "hidden": {
      const text = first.trim();
      return text === "" ? undefined : text;
    }
    default: {
      const never: never = field.kind;
      throw new Error(`forms: unhandled field kind ${String(never)}`);
    }
  }
}

const isStringArray = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((v) => typeof v === "string");

/** One host-supplied value, normalised: strings and string arrays through
 *  `answerOf`, booleans and numbers as they are, everything else absent. */
function normalise(field: LogicField, value: unknown): Json | undefined {
  if (typeof value === "string") return answerOf(field, [value]);
  if (isStringArray(value)) return answerOf(field, value);
  if (typeof value === "boolean") return field.kind === "checkbox" ? value : String(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Which questions are asked, which are required and which sections are shown.
 *
 * Walked in array order (decision 2): a question is asked when its section's
 * `showIf` (evaluated where the section begins) and its own both hold, against the
 * answers of earlier, asked questions only. `requireIf` is a second pass over every
 * asked question's answer, so it may name any other question.
 */
export function formState(form: LogicForm, answers: Record<string, unknown>): FormState {
  const sectionRules = new Map((form.sections ?? []).map((s) => [s.name, s.showIf]));
  const asked = new Set<string>();
  const shown = new Set<string>();
  const decided = new Set<string>();
  const live: Record<string, Json> = {};

  for (const field of form.fields) {
    let sectionOk = true;
    if (field.section !== undefined && sectionRules.has(field.section)) {
      if (!decided.has(field.section)) {
        decided.add(field.section);
        const rule = sectionRules.get(field.section);
        if (!rule || matches(rule, live)) shown.add(field.section);
      }
      sectionOk = shown.has(field.section);
    }
    if (!sectionOk || (field.showIf && !matches(field.showIf, live))) continue;
    asked.add(field.name);
    const value = normalise(field, answers[field.name]);
    if (value !== undefined) live[field.name] = value;
  }

  // A section none of whose members came up is judged against the whole form.
  for (const [name, rule] of sectionRules) {
    if (!decided.has(name) && (!rule || matches(rule, live))) shown.add(name);
  }

  const required = new Set<string>();
  for (const field of form.fields) {
    if (!asked.has(field.name) || field.kind === "statement") continue;
    if (field.required || (field.requireIf && matches(field.requireIf, live))) {
      required.add(field.name);
    }
  }

  return { asked, required, sections: shown, answers: live };
}

/**
 * The answers a body carries, normalised, for every declared question. The server
 * adapts its `SubmissionBody` map to `{ getAll }`; a host passes a `FormData`.
 * `File` entries are ignored, and so is any `_`-prefixed name, which is Folio's.
 */
export function answersFrom(
  form: { fields: readonly LogicField[] },
  source: { getAll(name: string): readonly unknown[] },
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const field of form.fields) {
    if (field.name.startsWith("_")) continue;
    const raw = source.getAll(field.name).filter((v): v is string => typeof v === "string");
    const value = answerOf(field, raw);
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}

/**
 * Answers to seed a form's inputs with. A question opts in to the page's query
 * string (`prefill: 'query'`); `values` is the host's own map (a signed-in
 * member's email) and wins over the query, and applies to any question because the
 * host chose it. A value that is not a declared option, not a number, not a day, is
 * dropped. `file` and `statement` are never prefilled.
 */
export function prefillAnswers(
  form: ResolvedForm,
  opts: { query?: URLSearchParams | string; values?: Record<string, unknown> },
): Record<string, Json> {
  const query =
    typeof opts.query === "string"
      ? new URLSearchParams(opts.query)
      : (opts.query ?? new URLSearchParams());
  const out: Record<string, Json> = {};
  for (const field of form.fields) {
    if (field.kind === "file" || field.kind === "statement") continue;
    const supplied = opts.values?.[field.name];
    let value: Json | undefined;
    if (supplied !== undefined) {
      value = normalise(field, supplied);
    } else if (field.prefill === "query") {
      const raw = query.getAll(field.name);
      if (raw.length > 0) value = answerOf(field, raw);
    }
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    out[field.name] = value;
  }
  return out;
}
