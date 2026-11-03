/**
 * The answer validator, in core so the browser can run the very function the submit
 * route does (`../../docs/specs/content-model/form-steps.md` decision 3). Moved
 * whole from `server/form-responses.ts` and `server/validate.ts`: pure, with no
 * dependency on either.
 */
import {
  answersFrom,
  DATE_ANSWER,
  formState,
  NUMBER_ANSWER,
  SCALAR_ANSWER_CHARS,
} from "./form-logic";
import type { FormState, LogicField, LogicForm } from "./form-logic";

/**
 * The ceiling on one answer's characters, whatever `max` the builder set on the
 * question.
 *
 * Two caps rather than one, deliberately: the question's own `max` is what an
 * editor promised a visitor, and this is what the column will take from a
 * stranger. A question with no `max` is bounded by this; a question whose `max`
 * is larger does not raise it.
 */
export const MAX_ANSWER_CHARS = 10_000;

/**
 * Everything except the characters that make a stored string misleading: `Cc` is the
 * C0/C1 controls, `Cs` a lone surrogate (a well-formed pair is a single non-Cs code
 * point under `/u`, so astral characters pass and a broken half does not), and the
 * two explicit ranges are the bidi overrides and isolates, which can reorder a
 * rendered title away from what was stored.
 *
 * `\p{C}` as a whole would be wrong: it includes `Cf`, and U+200D ZERO WIDTH
 * JOINER is what holds together every multi-codepoint emoji, plus `Cn`, which
 * would make the screen tighten with each Unicode release.
 */
export const PRINTABLE = /^[^\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]*$/u;

/**
 * The three whitespace controls a `textarea` carries legitimately. A multiline answer
 * is screened by removing them and testing the rest against `PRINTABLE`, rather than
 * by an alternation of two disjoint classes under `*`, which is equivalent but reads
 * to a ReDoS scanner as exponential backtracking.
 */
const MULTILINE_WHITESPACE = /[\n\r\t]/g;

/**
 * Whether one submitted answer holds only characters a stored string may hold.
 *
 * The same screen every other typed value in the server gets, with one difference
 * that has to be made per question rather than per file: a `textarea` answer with
 * newlines in it is a paragraph, and the identical string under a `text` question
 * is somebody trying to make one stored value look like two.
 */
export function isPrintableAnswer(raw: string, multiline: boolean): boolean {
  return PRINTABLE.test(multiline ? raw.replace(MULTILINE_WHITESPACE, "") : raw);
}

/** What one answer is stored as. */
export type ResponseValue = string | number | boolean | readonly string[];

/**
 * Why one answer was refused. A token rather than a sentence: it rides in a JSON
 * body a script reads and, in the native transport, only the *names* travel at
 * all (decision 6) — so the prose a visitor sees is the host's, in the host's own
 * language, from its own markup.
 */
export type AnswerRefusal = "required" | "invalid" | "too_long" | "out_of_range";

/** What `checkSubmission` needs of a question: the engine's view plus the bounds the
 *  validator enforces. A stored `FormField` and a compiled `ResolvedFormField` both fit. */
export interface CheckField extends LogicField {
  max?: number;
  min?: number;
  pattern?: string;
}

export interface SubmissionCheck {
  /** What the engine decided over the normalised body. */
  state: FormState;
  /** Declared questions only, keyed by field name. */
  values: Record<string, ResponseValue>;
  /** Field name → why. Empty means the submission is good. */
  errors: Record<string, AnswerRefusal>;
  /** Value-bearing questions the engine did not ask (`statement` never appears):
   *  the third state beside answered and no answer (spec 35 decision 9). */
  unasked: string[];
}

/** Loose on purpose: the strict test is a delivery attempt, and a form that
 *  refuses `a@b` refuses a real address somebody has. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The kinds whose answer may legitimately contain a line break. */
const MULTILINE: ReadonlySet<LogicField["kind"]> = new Set(["textarea"]);

interface Answer {
  value?: ResponseValue;
  error?: AnswerRefusal;
}

/**
 * One text answer: bounded, screened, and checked against the question's own
 * `max` and `pattern`.
 *
 * The cap is the question's `max` **and** `MAX_ANSWER_CHARS`, never one of them:
 * a question with no `max` still may not carry ten thousand characters into a
 * column, and one whose `max` is larger than the backstop does not raise it.
 */
function textAnswer(field: CheckField, raw: string): Answer {
  const value = MULTILINE.has(field.kind) ? raw.replace(/\r\n/g, "\n").trim() : raw.trim();
  if (value === "") return field.required ? { error: "required" } : {};
  if (!isPrintableAnswer(value, MULTILINE.has(field.kind))) return { error: "invalid" };

  const max = Math.min(field.max ?? MAX_ANSWER_CHARS, MAX_ANSWER_CHARS);
  // By code point, matching the cap `validate.ts` applies to everything else a
  // person types: `.length` counts a surrogate pair twice.
  if ([...value].length > max) return { error: "too_long" };

  if (field.pattern !== undefined) {
    let re: RegExp | null = null;
    // Compiled at save time by `validateFormFields`, so a throw here is
    // unreachable; a pattern that cannot compile screens nothing rather than
    // turning every submission into a 500.
    try {
      re = new RegExp(`^(?:${field.pattern})$`);
    } catch {
      re = null;
    }
    if (re && !re.test(value)) return { error: "invalid" };
  }
  return { value };
}

function optionValues(field: CheckField): ReadonlySet<string> {
  return new Set((field.options ?? []).map((o) => o.value));
}

/**
 * One question against what arrived for it.
 *
 * **The switch is exhaustive**, the rule `resolveValue` sets in `core/resolve.ts`:
 * the default branch assigns to `never`, so a fourteenth field kind fails to
 * compile here rather than being silently unvalidated on a public endpoint —
 * which is the one place in this codebase where "handled by falling through" is a
 * security bug rather than a missing feature.
 */
function checkAnswer(field: CheckField, raw: readonly string[], uploaded: boolean): Answer {
  const first = raw[0] ?? "";

  switch (field.kind) {
    // Renders no input and stores no answer. A key matching one is dropped
    // exactly like any other undeclared key (decision 13).
    case "statement":
      return {};

    /**
     * **No value, and `required` is the whole of what this decides.** An upload
     * is not an answer in `data`: the bytes are an R2 object and the metadata is
     * the `files` column, so what reaches here is only the question "did an
     * acceptable file arrive for this field" — already answered by
     * `prepareUploads`, which is the async half and the one that knows about
     * bytes.
     *
     * The two have to arrive together. `required` without the upload would be
     * unenforceable, and the upload without `required` would make a compulsory
     * CV optional on a route where nobody is watching.
     */
    case "file":
      return uploaded || !field.required ? {} : { error: "required" };

    case "checkbox": {
      // A browser sends the key only when the box is ticked, so presence is the
      // answer and `required` on one means "must be ticked".
      const ticked = raw.length > 0 && first !== "" && first !== "false";
      if (field.required && !ticked) return { error: "required" };
      return { value: ticked };
    }

    case "checkboxes": {
      const allowed = optionValues(field);
      const ticked = raw.filter((v) => v !== "");
      if (ticked.some((v) => !allowed.has(v))) return { error: "invalid" };
      // Nothing ticked sends no key at all, so `[]` is the honest answer and
      // `required` can only mean "at least one".
      if (ticked.length === 0) return field.required ? { error: "required" } : { value: [] };
      return { value: [...new Set(ticked)] };
    }

    case "select":
    case "radio": {
      if (first === "") return field.required ? { error: "required" } : {};
      return optionValues(field).has(first) ? { value: first } : { error: "invalid" };
    }

    case "number": {
      const text = first.trim();
      if (text === "") return field.required ? { error: "required" } : {};
      if (text.length > SCALAR_ANSWER_CHARS || !NUMBER_ANSWER.test(text))
        return { error: "invalid" };
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: "invalid" };
      if (field.min !== undefined && value < field.min) return { error: "out_of_range" };
      if (field.max !== undefined && value > field.max) return { error: "out_of_range" };
      return { value };
    }

    case "date": {
      const text = first.trim();
      if (text === "") return field.required ? { error: "required" } : {};
      if (!DATE_ANSWER.test(text)) return { error: "invalid" };
      // `2026-02-31` matches the shape and is not a day. `Date.parse` of an
      // ISO date is UTC midnight, so the round trip is exact.
      const parsed = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        return { error: "invalid" };
      }
      return { value: text };
    }

    case "email": {
      const answer = textAnswer(field, first);
      if (answer.error || answer.value === undefined) return answer;
      return EMAIL.test(String(answer.value)) ? answer : { error: "invalid" };
    }

    case "url": {
      const answer = textAnswer(field, first);
      if (answer.error || answer.value === undefined) return answer;
      try {
        const url = new URL(String(answer.value));
        // http(s) only: a stored `javascript:` or `data:` answer is a link a
        // host's markup would happily render.
        if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "invalid" };
      } catch {
        return { error: "invalid" };
      }
      return answer;
    }

    // A `hidden` question stores what the markup emitted rather than the value
    // the builder typed: that is the whole of decision 13's "a host that wants to
    // pass its own value declares a hidden field for it", and it is validated,
    // bounded and exported like any other answer.
    case "hidden":
    case "text":
    case "textarea":
    case "tel":
      return textAnswer(field, first);

    default: {
      const never: never = field.kind;
      throw new Error(`forms: unhandled field kind ${String(never)}`);
    }
  }
}

/**
 * Every declared question against what arrived, and nothing else
 * (decision 13).
 *
 * Pure — a field list and a source in, values and per-field refusals out — so the
 * hardest-to-reason-about half of a public write path is unit-tested in Node
 * rather than only through workerd.
 *
 * Two rules run before any question is looked at, and both are screens rather
 * than validations:
 *
 * - **Only declared names are read.** The submit button's `name`, the honeypot,
 *   whatever a password manager injected and whatever a captcha widget called
 *   its own input are all simply not asked for. A 422 on an undeclared key was
 *   rejected: it breaks the first time a `<button name="submit">` appears.
 * - **A `_`-prefixed name is Folio's** and can never be an answer. It cannot
 *   collide with a declared name either, because `validateFormFields` refuses a
 *   field slug in that namespace — so this is the second of two locks on the same
 *   door, and the one that holds if a stored row ever predates the first.
 *
 * `uploaded` is the set of field names `prepareUploads` accepted a file for, and
 * it is the only thing this function knows about bytes. Defaulted to empty so
 * every text-only caller — and every test of one — reads unchanged.
 *
 * **The engine decides what was asked** (`form-logic.ts`, spec 35 decisions 2,
 * 5 and 10): `formState` runs over the *normalised* body, not over the values
 * validated below, so a readable-but-invalid answer drives conditions exactly as it
 * does in the browser. A question that was not asked is skipped: no value, no
 * refusal, its name in `unasked`. A question that was is validated with the
 * engine's `required`, which is the stored flag or its `requireIf`.
 */
export function checkSubmission(
  form: {
    fields: readonly CheckField[];
    sections?: LogicForm["sections"];
    steps?: LogicForm["steps"];
  },
  source: { getAll(name: string): readonly unknown[] },
  uploaded: ReadonlySet<string> = new Set(),
): SubmissionCheck {
  const values: Record<string, ResponseValue> = {};
  const errors: Record<string, AnswerRefusal> = {};
  const unasked: string[] = [];

  const state = formState(form, answersFrom(form, source));

  for (const field of form.fields) {
    if (field.name.startsWith("_")) continue;
    if (!state.asked.has(field.name)) {
      if (field.kind !== "statement") unasked.push(field.name);
      continue;
    }
    const { value, error } = checkAnswer(
      { ...field, required: state.required.has(field.name) },
      source.getAll(field.name).filter((v): v is string => typeof v === "string"),
      uploaded.has(field.name),
    );
    if (error) errors[field.name] = error;
    else if (value !== undefined) values[field.name] = value;
  }

  return { state, values, errors, unasked };
}

/** One step's standing against a check (spec 38 decision 3). */
export interface StepStatus {
  name: string;
  /** The engine reached it: its own `showIf`, and every earlier answer, allow it. */
  reachable: boolean;
  /** Reachable, and none of its questions was refused by the validator. */
  complete: boolean;
  /** Every question on the step, in form order, asked or not. */
  questions: readonly string[];
}

/**
 * Where each step stands, in step order, judged by the same validator the server
 * runs: a step is complete when it is reachable and none of its questions is in
 * `check.errors`. So a step with a malformed phone number is incomplete, not merely
 * "required fields answered". A reachable step whose questions are all unasked has no
 * errors and is complete. A form without steps answers `[]`.
 */
export function stepStatus(form: LogicForm, check: SubmissionCheck): StepStatus[] {
  return (form.steps ?? []).map((step) => {
    const questions = form.fields.filter((f) => f.step === step.name).map((f) => f.name);
    const reachable = check.state.steps.has(step.name);
    return {
      name: step.name,
      reachable,
      complete: reachable && !questions.some((name) => Object.hasOwn(check.errors, name)),
      questions,
    };
  });
}
