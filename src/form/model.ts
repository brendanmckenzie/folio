/**
 * The pure half of `useFolioForm` (`../../docs/specs/content-model/form-steps.md`,
 * Implementation plan phase 4): everything the hook decides that needs no React, so
 * it is unit-tested in Node the way the admin tests `form-model.ts` beside its screen.
 *
 * Imports individual core modules rather than the `folio/core` barrel, so a host's
 * client bundle does not pull in the block and resolve machinery.
 */
import type { Json } from "../core/doc";
import { checkSubmission } from "../core/form-answers";
import type { AnswerRefusal, SubmissionCheck } from "../core/form-answers";
import { answersFrom } from "../core/form-logic";
import { DEFAULT_STATUS_MESSAGES } from "../core/form-status";
import type { SubmitStatus } from "../core/form-status";
import type {
  FormFieldOption,
  FormLayoutView,
  LayoutStep,
  ResolvedForm,
  ResolvedFormField,
} from "../core/forms";

/* ------------------------------------------------------------------ steps --- */

/** The steps `formLayout` still renders, in order. `step: null` is the unstepped group. */
export function renderedSteps(layout: FormLayoutView): LayoutStep[] {
  return layout.steps.filter((s) => s.step !== null);
}

/**
 * The current step (decision 7). Always a step the layout still renders, or `null`
 * when it renders none.
 *
 * 1. With `pull` (a round trip read at mount, or a refusal), the first rendered step
 *    holding one of those questions.
 * 2. Otherwise `current`, if it is still rendered.
 * 3. Otherwise the nearest earlier rendered step in `order` (the descriptor's own step
 *    order, which the layout cannot give for a step it dropped), else the first.
 */
export function initialStep(
  layout: FormLayoutView,
  input: { order: readonly string[]; current: string | null; pull?: readonly string[] },
): string | null {
  const rendered = renderedSteps(layout);
  if (rendered.length === 0) return null;
  const names = new Set(rendered.map((s) => s.step?.name));
  if (input.pull && input.pull.length > 0) {
    const wanted = new Set(input.pull);
    const hit = rendered.find((s) =>
      s.sections.some((sec) => sec.rows.some((r) => r.cells.some((c) => wanted.has(c.field.name)))),
    );
    if (hit?.step) return hit.step.name;
  }
  if (input.current !== null && names.has(input.current)) return input.current;
  const at = input.current === null ? -1 : input.order.indexOf(input.current);
  for (let i = at - 1; i >= 0; i--) {
    const earlier = input.order[i];
    if (earlier !== undefined && names.has(earlier)) return earlier;
  }
  return rendered[0]?.step?.name ?? null;
}

export interface StepNav {
  name: string;
  label: string;
  /** Position among the available steps, from 0; `-1` for a step that is not available. */
  index: number;
  /** How many steps are available. */
  total: number;
  reachable: boolean;
  complete: boolean;
  /** The layout renders it: reachable, and it holds at least one asked question. */
  available: boolean;
  current: boolean;
}

/** Every descriptor step with where it stands. A step the layout dropped (unreachable,
 *  or every question unasked) is unavailable, so navigation skips it. A step is
 *  `complete` when it is reachable and none of its questions is in `errors`, the same
 *  rule as core's `stepStatus` over the errors the client actually holds. */
export function navigation(
  form: Pick<ResolvedForm, "steps" | "fields">,
  layout: FormLayoutView,
  reachableSteps: ReadonlySet<string> | null,
  errors: Readonly<Record<string, AnswerRefusal>>,
  current: string | null,
): StepNav[] {
  const steps = form.steps ?? [];
  const rendered = new Set(renderedSteps(layout).map((s) => s.step?.name));
  const total = steps.filter((s) => rendered.has(s.name)).length;
  const stepOfQuestion = new Map(form.fields.map((f) => [f.name, f.step]));
  let seen = 0;
  return steps.map((s) => {
    const available = rendered.has(s.name);
    const reachable = reachableSteps ? reachableSteps.has(s.name) : available;
    return {
      name: s.name,
      label: s.label,
      index: available ? seen++ : -1,
      total,
      reachable,
      complete:
        reachable && !Object.keys(errors).some((name) => stepOfQuestion.get(name) === s.name),
      available,
      current: s.name === current,
    };
  });
}

/** The nearest available step either side of `current`. */
export function neighbour(
  nav: readonly StepNav[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  const at = nav.findIndex((s) => s.name === current);
  if (at < 0) return null;
  for (let i = at + dir; i >= 0 && i < nav.length; i += dir) {
    const step = nav[i];
    if (step?.available) return step.name;
  }
  return null;
}

/* -------------------------------------------------------------------- keys --- */

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "file",
  "submit",
  "reset",
  "image",
]);

/**
 * Decision 16's key rule: Enter in a text-like `input` advances while stepped and not
 * on the last step. Never in a `textarea`, a button, a checkbox, a radio or a file
 * input, and never while an IME is composing. On the last step it does nothing and the
 * browser's implicit submission runs as usual.
 */
export function enterAction(
  event: { key: string; tag: string; type?: string; isComposing?: boolean },
  state: { stepped: boolean; isLast: boolean },
): "next" | null {
  if (event.key !== "Enter" || event.isComposing) return null;
  if (!state.stepped || state.isLast) return null;
  if (event.tag.toUpperCase() !== "INPUT") return null;
  if (NON_TEXT_INPUTS.has((event.type ?? "text").toLowerCase())) return null;
  return "next";
}

/* ---------------------------------------------------------------- problems --- */

export const DEFAULT_FIELD_MESSAGES: Readonly<Record<AnswerRefusal, string>> = {
  required: "Answer this question.",
  invalid: "Check this answer.",
  too_long: "This answer is too long.",
  out_of_range: "This answer is out of range.",
};

export interface HookMessages {
  invalid?: string;
  closed?: string;
  rate?: string;
  verify?: string;
  error?: string;
  refused?: string;
  fields?: Partial<Record<AnswerRefusal, string>>;
}

export interface Problem {
  name: string;
  label: string;
  /** The rendered step holding the question, or `null` when it is on none. */
  step: string | null;
  token: AnswerRefusal;
  message: string;
}

export function fieldMessage(token: AnswerRefusal, messages: HookMessages | undefined): string {
  return messages?.fields?.[token] ?? DEFAULT_FIELD_MESSAGES[token];
}

/** Question name -> the rendered step that holds it. */
function renderedStepOf(layout: FormLayoutView): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of layout.steps) {
    if (!s.step) continue;
    for (const sec of s.sections) {
      for (const row of sec.rows)
        for (const cell of row.cells) out.set(cell.field.name, s.step.name);
    }
  }
  return out;
}

/** The refusals as the summary lists them: form order, each with the rendered step it
 *  is on (`null` when none, so a question on a dropped step still appears). */
export function problemsOf(
  form: Pick<ResolvedForm, "fields">,
  layout: FormLayoutView,
  refusals: Readonly<Record<string, AnswerRefusal>>,
  messages?: HookMessages,
): Problem[] {
  const where = renderedStepOf(layout);
  const out: Problem[] = [];
  for (const field of form.fields) {
    const token = Object.hasOwn(refusals, field.name) ? refusals[field.name] : undefined;
    if (!token) continue;
    out.push({
      name: field.name,
      label: field.label,
      step: where.get(field.name) ?? null,
      token,
      message: fieldMessage(token, messages),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ status --- */

export interface StatusView {
  kind: SubmitStatus;
  message: string;
  invalid: readonly string[];
  reason: string | null;
  code: string | null;
  fields: Readonly<Record<string, AnswerRefusal>> | null;
}

/**
 * The status a visitor reads (decision 10). `ok` is the form's success message;
 * `closed` is its closed message, then the host's, then the default; `refused` is the
 * reply's message when the hook made the request, then the editor's text for the
 * reason, then for `<action>.error`, then the host's, then the default; everything
 * else is the host's message, then the reply's, then the default: the reply always
 * carries Folio's own default sentence and would otherwise hide the host's.
 */
export function statusView(
  form: Pick<ResolvedForm, "successMessage" | "closedMessage" | "refusals">,
  input: {
    kind: SubmitStatus;
    invalid?: readonly string[];
    reason?: string | null;
    code?: string | null;
    fields?: Readonly<Record<string, AnswerRefusal>> | null;
    reply?: string | null;
  },
  messages?: HookMessages,
): StatusView {
  const { kind } = input;
  const reason = input.reason ?? null;
  let message: string;
  if (kind === "ok") message = form.successMessage;
  else if (kind === "closed") {
    message = form.closedMessage || messages?.closed || DEFAULT_STATUS_MESSAGES.closed;
  } else if (kind === "refused") {
    const action = reason?.split(".")[0];
    message =
      input.reply ||
      (reason !== null ? form.refusals?.[reason] : undefined) ||
      (action ? form.refusals?.[`${action}.error`] : undefined) ||
      messages?.refused ||
      DEFAULT_STATUS_MESSAGES.refused;
  } else {
    message = messages?.[kind] || input.reply || DEFAULT_STATUS_MESSAGES[kind];
  }
  return {
    kind,
    message,
    invalid: input.invalid ?? [],
    reason,
    code: input.code ?? null,
    fields: input.fields ?? null,
  };
}

/* ------------------------------------------------------------------- check --- */

/** What the client knows after reading the DOM form. */
export interface DomCheck {
  answers: Record<string, Json>;
  check: SubmissionCheck;
  /** `check.errors` plus the client's file approximations, minus any question whose
   *  list was unavailable: the server decides those (spec 37). */
  errors: Record<string, AnswerRefusal>;
}

const isFile = (v: unknown): v is File => typeof File !== "undefined" && v instanceof File;

/** Client approximation for a chosen file: over `maxBytes` is `too_long`. The type is
 *  left to the server: it sniffs bytes and never reads the declared type, so any client
 *  check against `accept` could refuse a file the server takes. */
export function fileRefusal(
  field: Pick<ResolvedFormField, "accept" | "maxBytes">,
  file: { size: number; type: string },
): AnswerRefusal | null {
  if (field.maxBytes !== undefined && file.size > field.maxBytes) return "too_long";
  return null;
}

/** Reads a `FormData` the way the server reads the posted body and judges it with the
 *  server's own validator (decision 3). */
export function checkDom(form: ResolvedForm, data: FormData): DomCheck {
  const uploaded = new Set<string>();
  const fileErrors: Record<string, AnswerRefusal> = {};
  for (const field of form.fields) {
    if (field.kind !== "file") continue;
    const entry = data.get(field.name);
    if (isFile(entry) && entry.size > 0) {
      uploaded.add(field.name);
      const refusal = fileRefusal(field, entry);
      if (refusal) fileErrors[field.name] = refusal;
    }
  }
  const check = checkSubmission(form, data, uploaded);
  const unavailable = new Set(
    form.fields.filter((f) => f.optionsFrom?.unavailable).map((f) => f.name),
  );
  const errors: Record<string, AnswerRefusal> = {};
  for (const [name, token] of Object.entries({ ...check.errors, ...fileErrors })) {
    if (!unavailable.has(name) && check.state.asked.has(name)) errors[name] = token;
  }
  return { answers: answersFrom(form, data), check, errors };
}

/* --------------------------------------------------------------- transport --- */

/** The body the server would have received natively: a `FormData` for multipart,
 *  `URLSearchParams` built from it otherwise. */
export function transportBody(
  enctype: ResolvedForm["enctype"],
  data: FormData,
): FormData | URLSearchParams {
  if (enctype === "multipart/form-data") return data;
  const params = new URLSearchParams();
  for (const [name, value] of data.entries()) {
    if (typeof value === "string") params.append(name, value);
  }
  return params;
}

/* --------------------------------------------------------------------- ids --- */

/** `useId` yields `:r0:` or `«r0»` depending on the React version; ids here are
 *  `[A-Za-z0-9_-]` only, so a selector or a `for` attribute never needs escaping. */
export function sanitiseId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "");
}

const slug = (raw: string) => raw.replace(/[^A-Za-z0-9_-]/g, "_");

export function controlId(prefix: string, name: string, option?: FormFieldOption): string {
  return option ? `${prefix}-${name}-${slug(option.value)}` : `${prefix}-${name}`;
}

/** The id of the first control of a question: its first option for a group. */
export function firstControlId(prefix: string, field: ResolvedFormField): string {
  const first =
    field.kind === "radio" || field.kind === "checkboxes" ? field.options?.[0] : undefined;
  return controlId(prefix, field.name, first);
}

export const errorId = (prefix: string, name: string) => `${prefix}-${name}-error`;
export const labelId = (prefix: string, name: string, option?: FormFieldOption) =>
  option ? `${controlId(prefix, name, option)}-label` : `${prefix}-${name}-label`;

/* ------------------------------------------------------------ prop getters --- */

export interface ControlContext {
  prefix: string;
  /** The effective requiredness: the engine's after mount, the descriptor's before. */
  required: boolean;
  /** The prefilled or host-supplied answer. */
  answer: Json | undefined;
  /** The refusal to show on this question, if any. */
  invalid: boolean;
}

const TEXT_TYPES: Partial<Record<ResolvedFormField["kind"], string>> = {
  text: "text",
  email: "email",
  tel: "tel",
  url: "url",
  number: "number",
  date: "date",
};

const asText = (answer: Json | undefined): string =>
  typeof answer === "string" || typeof answer === "number" ? String(answer) : "";

/**
 * What a control needs, per kind (the spec's `controlProps` list). Uncontrolled:
 * `defaultValue` / `defaultChecked`, never `value` (decision 6), except where `value`
 * is the option or the tick box's own. **`required` is never put on a `checkboxes`
 * option**: HTML reads it as "this box must be ticked", the server's rule is "at least
 * one", and the group's requiredness travels as `aria-required` on `groupPropsOf`.
 */
export function controlPropsOf(
  field: ResolvedFormField,
  option: FormFieldOption | undefined,
  ctx: ControlContext,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    id: controlId(ctx.prefix, field.name, option),
    name: field.name,
  };
  const grouped = field.kind === "radio" || field.kind === "checkboxes";

  switch (field.kind) {
    case "text":
    case "email":
    case "tel":
    case "url":
      props.type = TEXT_TYPES[field.kind];
      if (field.pattern !== undefined) props.pattern = field.pattern;
      if (field.placeholder !== undefined) props.placeholder = field.placeholder;
      props.defaultValue = asText(ctx.answer);
      break;
    case "number":
    case "date":
      props.type = TEXT_TYPES[field.kind];
      if (field.kind === "number") {
        props.step = "any";
        if (field.min !== undefined) props.min = field.min;
        if (field.max !== undefined) props.max = field.max;
      }
      if (field.placeholder !== undefined) props.placeholder = field.placeholder;
      props.defaultValue = asText(ctx.answer);
      break;
    case "textarea":
      if (field.placeholder !== undefined) props.placeholder = field.placeholder;
      props.defaultValue = asText(ctx.answer);
      break;
    case "select":
      props.defaultValue = asText(ctx.answer);
      break;
    case "radio":
      props.type = "radio";
      if (option) {
        props.value = option.value;
        props.defaultChecked = ctx.answer === option.value;
      }
      break;
    case "checkboxes":
      props.type = "checkbox";
      if (option) {
        props.value = option.value;
        props.defaultChecked = Array.isArray(ctx.answer) && ctx.answer.includes(option.value);
      }
      break;
    case "checkbox":
      props.type = "checkbox";
      props.value = "yes";
      props.defaultChecked = ctx.answer === true;
      break;
    case "file":
      props.type = "file";
      if (field.accept && field.accept.length > 0) props.accept = field.accept.join(",");
      break;
    case "hidden":
      props.type = "hidden";
      props.defaultValue = ctx.answer !== undefined ? asText(ctx.answer) : (field.value ?? "");
      break;
    case "statement":
      return {};
    default: {
      const never: never = field.kind;
      throw new Error(`folio/form: unhandled field kind ${String(never)}`);
    }
  }

  // HTML makes a whole radio group required from one member; putting it on each is noise.
  const first = field.kind === "radio" ? field.options?.[0]?.value === option?.value : true;
  if (ctx.required && field.kind !== "checkboxes" && first) props.required = true;

  if (ctx.invalid && !grouped) {
    props["aria-invalid"] = true;
    props["aria-describedby"] = errorId(ctx.prefix, field.name);
  }
  return props;
}

/** The container of a `radio` or `checkboxes` question's options. */
export function groupPropsOf(
  field: ResolvedFormField,
  ctx: Pick<ControlContext, "prefix" | "required" | "invalid">,
): {
  role: "group" | "radiogroup";
  "aria-labelledby": string;
  "aria-required"?: true;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
} {
  return {
    role: field.kind === "radio" ? "radiogroup" : "group",
    "aria-labelledby": labelId(ctx.prefix, field.name),
    ...(ctx.required ? { "aria-required": true as const } : {}),
    ...(ctx.invalid
      ? { "aria-invalid": true as const, "aria-describedby": errorId(ctx.prefix, field.name) }
      : {}),
  };
}
