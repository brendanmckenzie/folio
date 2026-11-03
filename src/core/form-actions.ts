/**
 * Form actions: the vocabulary (`docs/specs/content-model/form-actions.md`, phase 1).
 *
 * Core rather than server for the same reason `forms.ts` is: the builder, the PATCH
 * route and the submit route all need one reading of what an attachment is and what is
 * wrong with one. Nothing here does I/O, and nothing here holds a function; a
 * `FormActionInfo` is the JSON half of an action definition.
 */

import { matches } from "./conditions";
import type { Json } from "./doc";
import type { Field } from "./fields";
import type { FormField, FormFieldKind, FormLayout } from "./forms";
import type { LocaleContext } from "./locales";
import { dateError } from "./nested";

/* ------------------------------------------------------------------- inputs --- */

export type ActionInputKind = "text" | "email" | "number" | "boolean" | "list" | "file";

/**
 * Which questions may feed an input of each kind (decision 5's table). `statement`
 * feeds nothing, so it appears in no row.
 */
export const INPUT_ACCEPTS: Record<ActionInputKind, readonly FormFieldKind[]> = {
  text: ["text", "textarea", "email", "tel", "url", "date", "select", "radio", "hidden"],
  email: ["email"],
  number: ["number"],
  boolean: ["checkbox"],
  list: ["checkboxes"],
  file: ["file"],
};

export interface ActionInputInfo {
  name: string;
  kind: ActionInputKind;
  label: string;
  help?: string;
  required: boolean;
}

export interface ActionCodeInfo {
  code: string;
  label: string;
  message: string;
}

/** `Field` narrowed to the six scalar kinds a setting may be (decision 6). */
export type ActionSettingDef = Extract<
  Field,
  { kind: "text" | "textarea" | "number" | "boolean" | "date" | "select" }
>;

/** One entry of `actions` on `GET {base}/api/forms/registry`. JSON; never functions. */
export interface FormActionInfo {
  id: string;
  label: string;
  description?: string;
  /** Declaration order. */
  inputs: ActionInputInfo[];
  /** Declaration order. */
  settings: Record<string, ActionSettingDef>;
  /** Declared codes, then `error` when `check` is true. */
  codes: ActionCodeInfo[];
  check: boolean;
  deliver: boolean;
}

export type ActionSettingValue = string | number | boolean;

export interface FormActionAttachment {
  /** A registered id. */
  action: string;
  /** Input name -> question name. */
  map?: Record<string, string>;
  settings?: Record<string, ActionSettingValue>;
  /** Code -> source-locale text. */
  messages?: Record<string, string>;
  i18n?: Record<string, { messages?: Record<string, string> }>;
  /** Written by the server on every save from the registry; never trusted from the
   *  client. Whether the action delivers, so an attachment whose action is later
   *  unregistered still knows whether a submission owes a delivery (decision 13). */
  delivers?: true;
}

export const MAX_FORM_ACTIONS = 8;
/** The implicit fail-closed refusal on every action that has a `check`. */
export const RESERVED_CODE = "error";
export const ACTION_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const ACTION_CODE = /^[a-z][a-z0-9_]{0,31}$/;
/** Input and setting names are the host's TypeScript property names, so camel case. */
export const ACTION_INPUT_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** A question's name (`forms.ts`'s own charset). */
const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LOCALE_CODE = /^[A-Za-z][A-Za-z0-9-]{0,34}$/;

/** Folio's text for the fail-closed refusal when the editor has written none. */
export const DEFAULT_ERROR_MESSAGE =
  "We could not process that submission. Please try again later.";
/** An editor-written refusal message's bound. */
export const MAX_REFUSAL_MESSAGE = 500;
const MAX_SETTING_STRING = 2000;

/* ---------------------------------------------------------------- validation --- */

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

function stringMap(
  raw: unknown,
  where: string,
  keyRe: RegExp,
  valueRe: RegExp | null,
  max: number,
): Record<string, string> {
  if (!isRecord(raw)) throw new Error(`forms: ${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keyRe.test(key))
      throw new Error(`forms: ${where} has an invalid key ${JSON.stringify(key)}`);
    if (typeof value !== "string" || value.length > max || (valueRe && !valueRe.test(value))) {
      throw new Error(`forms: ${where}.${key} is not a valid value`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Structural validation of the `forms.actions` column: shapes, charsets, bounds, one
 * attachment per action. It knows nothing of the registry (that is
 * `attachmentProblems`) and keeps only the keys it understands. Throws.
 */
export function validateFormActions(input: unknown): FormActionAttachment[] {
  if (!Array.isArray(input)) throw new Error("forms: actions must be an array");
  if (input.length > MAX_FORM_ACTIONS) {
    throw new Error(`forms: at most ${MAX_FORM_ACTIONS} actions, got ${input.length}`);
  }
  const seen = new Set<string>();
  const out: FormActionAttachment[] = [];
  for (const item of input) {
    if (!isRecord(item)) throw new Error("forms: an action must be an object");
    const id = item.action;
    if (typeof id !== "string" || !ACTION_ID.test(id)) {
      throw new Error(`forms: invalid action id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new Error(`forms: action "${id}" is attached twice`);
    seen.add(id);
    const attachment: FormActionAttachment = { action: id };
    if (item.map !== undefined) {
      attachment.map = stringMap(
        item.map,
        `action "${id}" map`,
        ACTION_INPUT_NAME,
        QUESTION_NAME,
        64,
      );
    }
    if (item.settings !== undefined) {
      if (!isRecord(item.settings))
        throw new Error(`forms: action "${id}" settings must be an object`);
      const settings: Record<string, ActionSettingValue> = {};
      for (const [key, value] of Object.entries(item.settings)) {
        if (!ACTION_INPUT_NAME.test(key)) {
          throw new Error(
            `forms: action "${id}" has an invalid setting name ${JSON.stringify(key)}`,
          );
        }
        const ok =
          (typeof value === "string" && value.length <= MAX_SETTING_STRING) ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value));
        if (!ok)
          throw new Error(
            `forms: action "${id}" setting "${key}" must be a string, number or boolean`,
          );
        settings[key] = value as ActionSettingValue;
      }
      attachment.settings = settings;
    }
    if (item.messages !== undefined) {
      attachment.messages = stringMap(
        item.messages,
        `action "${id}" messages`,
        ACTION_CODE,
        null,
        MAX_REFUSAL_MESSAGE,
      );
    }
    if (item.i18n !== undefined) {
      if (!isRecord(item.i18n)) throw new Error(`forms: action "${id}" i18n must be an object`);
      const i18n: NonNullable<FormActionAttachment["i18n"]> = {};
      for (const [code, entry] of Object.entries(item.i18n)) {
        if (!LOCALE_CODE.test(code))
          throw new Error(`forms: action "${id}" has an invalid locale ${JSON.stringify(code)}`);
        if (!isRecord(entry))
          throw new Error(`forms: action "${id}" i18n.${code} must be an object`);
        const own: { messages?: Record<string, string> } = {};
        if (entry.messages !== undefined) {
          own.messages = stringMap(
            entry.messages,
            `action "${id}" i18n.${code}.messages`,
            ACTION_CODE,
            null,
            MAX_REFUSAL_MESSAGE,
          );
        }
        i18n[code] = own;
      }
      attachment.i18n = i18n;
    }
    if (item.delivers !== undefined) {
      if (item.delivers !== true)
        throw new Error(`forms: action "${id}" delivers must be true when present`);
      attachment.delivers = true;
    }
    out.push(attachment);
  }
  return out;
}

/* ----------------------------------------------------------------- settings --- */

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "";

/** Whether a setting is currently shown, `showIf` read against the settings so far. */
function shown(def: ActionSettingDef, values: Record<string, Json>): boolean {
  return def.showIf === undefined || matches(def.showIf, values);
}

function settingError(def: ActionSettingDef, value: unknown): string | null {
  switch (def.kind) {
    case "text":
    case "textarea":
      return typeof value === "string" && value.length <= MAX_SETTING_STRING
        ? null
        : "must be text";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (def.min !== undefined && value < def.min) return `must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be at most ${def.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "date":
      return dateError(def.time, value);
    case "select":
      return typeof value === "string" && def.options.some((o) => o.value === value)
        ? null
        : "must be one of the listed options";
    default:
      return "is not a kind a setting can be";
  }
}

/**
 * Settings values validated against the definitions (decision 6): a `select` is one
 * of its options, a `number` is within `min`/`max`, a `date` is in the field's exact
 * form, a shown `required` setting is non-empty. Undeclared keys are dropped; an
 * unset optional setting is omitted. Throws, naming the setting.
 */
export function validateSettings(
  values: unknown,
  defs: Record<string, ActionSettingDef>,
): Record<string, ActionSettingValue> {
  if (values !== undefined && values !== null && !isRecord(values)) {
    throw new Error("forms: settings must be an object");
  }
  const given = (values ?? {}) as Record<string, unknown>;
  const out: Record<string, ActionSettingValue> = {};
  for (const [name, def] of Object.entries(defs)) {
    const value = given[name];
    if (isEmpty(value)) continue;
    const problem = settingError(def, value);
    if (problem) throw new Error(`forms: setting "${name}" ${problem}`);
    out[name] = value as ActionSettingValue;
  }
  for (const [name, def] of Object.entries(defs)) {
    if (def.required === true && isEmpty(out[name]) && shown(def, out as Record<string, Json>)) {
      throw new Error(`forms: setting "${name}" is required`);
    }
  }
  return out;
}

/* ------------------------------------------------------------ normalisation --- */

function pick<T>(
  source: Record<string, T> | undefined,
  keys: readonly string[],
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!source) return out;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = source[key] as T;
  }
  return out;
}

function cleanMessages(
  source: Record<string, string> | undefined,
  codes: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, text] of Object.entries(pick(source, codes))) {
    if (text !== "") out[code] = text;
  }
  return out;
}

const hasKeys = (o: object): boolean => Object.keys(o).length > 0;

/** The codes an action can be given text for: declared, plus `error` on a check. */
function codesOf(info: FormActionInfo): string[] {
  const codes = info.codes.map((c) => c.code);
  if (info.check && !codes.includes(RESERVED_CODE)) codes.push(RESERVED_CODE);
  return codes;
}

/**
 * The attachments normalised against the registry (decision 8): undeclared mapping
 * keys, settings and messages dropped, empty texts dropped, `delivers` recomputed,
 * keys in a canonical order, so two attachments that mean the same compare equal as
 * JSON. Defaults are filled only for an id in `added`. An attachment whose action is
 * not in `infos` is passed through exactly as stored. Run order is preserved.
 */
export function normaliseFormActions(
  a: readonly FormActionAttachment[],
  infos: ReadonlyMap<string, FormActionInfo>,
  added: ReadonlySet<string>,
): FormActionAttachment[] {
  return a.map((attachment) => {
    const info = infos.get(attachment.action);
    if (!info) return attachment;
    const out: FormActionAttachment = { action: attachment.action };

    const map = pick(
      attachment.map,
      info.inputs.map((i) => i.name),
    );
    if (hasKeys(map)) out.map = map;

    const settings = pick(attachment.settings, Object.keys(info.settings));
    if (added.has(attachment.action)) {
      for (const [name, def] of Object.entries(info.settings)) {
        const fallback = def.default;
        if (
          settings[name] === undefined &&
          (typeof fallback === "string" ||
            typeof fallback === "number" ||
            typeof fallback === "boolean")
        ) {
          settings[name] = fallback;
        }
      }
    }
    const orderedSettings: Record<string, ActionSettingValue> = {};
    for (const name of Object.keys(info.settings)) {
      if (settings[name] !== undefined) orderedSettings[name] = settings[name];
    }
    if (hasKeys(orderedSettings)) out.settings = orderedSettings;

    const codes = codesOf(info);
    const messages = cleanMessages(attachment.messages, codes);
    const orderedMessages: Record<string, string> = {};
    for (const code of codes)
      if (messages[code] !== undefined) orderedMessages[code] = messages[code];
    if (hasKeys(orderedMessages)) out.messages = orderedMessages;

    const i18n: NonNullable<FormActionAttachment["i18n"]> = {};
    for (const locale of Object.keys(attachment.i18n ?? {}).sort()) {
      const own = cleanMessages(attachment.i18n?.[locale]?.messages, codes);
      const ordered: Record<string, string> = {};
      for (const code of codes) if (own[code] !== undefined) ordered[code] = own[code];
      if (hasKeys(ordered)) i18n[locale] = { messages: ordered };
    }
    if (hasKeys(i18n)) out.i18n = i18n;

    if (info.deliver) out.delivers = true;
    return out;
  });
}

/* ----------------------------------------------------------------- problems --- */

/**
 * Whether a question is answered on every submission (decision 5): asked
 * unconditionally (no `showIf` on it, its section or its step) and either stored required with
 * no `requireIf`, or a tick-box kind, which stores `false` / `[]` when untouched.
 * `server/forms.ts`'s `compileField` computes `always` the same way; restated here
 * because `server/` may import `core/` and not the reverse.
 */
function alwaysAnswered(field: FormField, layout: FormLayout): boolean {
  const section = field.section
    ? layout.sections?.find((s) => s.name === field.section)
    : undefined;
  const step = field.step ? layout.steps?.find((s) => s.name === field.step) : undefined;
  if (field.showIf !== undefined || section?.showIf !== undefined || step?.showIf !== undefined) {
    return false;
  }
  if (field.kind === "checkbox" || field.kind === "checkboxes") return true;
  return field.required === true && field.requireIf === undefined;
}

/**
 * Every problem with this attachment against this action and these questions
 * (decision 5), as a list of sentences. A set, so a caller can ask whether a save
 * adds one (decision 13).
 */
export function attachmentProblems(
  a: FormActionAttachment,
  info: FormActionInfo,
  fields: readonly FormField[],
  layout: FormLayout,
): string[] {
  const problems: string[] = [];
  for (const input of info.inputs) {
    const target = a.map?.[input.name];
    if (target === undefined || target === "") {
      if (input.required) problems.push(`${input.label} needs a question`);
      continue;
    }
    const field = fields.find((f) => f.name === target);
    if (!field) {
      problems.push(`${input.label} reads "${target}", which is not a question on this form`);
    } else if (!INPUT_ACCEPTS[input.kind]?.includes(field.kind)) {
      problems.push(
        `${input.label} cannot read "${target}": a ${field.kind} question does not fit`,
      );
    } else if (input.required && !alwaysAnswered(field, layout)) {
      problems.push(`${input.label} reads "${target}", which is not always answered`);
    }
  }
  const values = a.settings ?? {};
  for (const [name, def] of Object.entries(info.settings)) {
    const value = values[name];
    const label = def.label ?? name;
    if (isEmpty(value)) {
      if (def.required === true && shown(def, values as Record<string, Json>)) {
        problems.push(`${label} is required`);
      }
      continue;
    }
    const problem = settingError(def, value);
    if (problem) problems.push(`${label} ${problem}`);
  }
  return problems;
}

/* ----------------------------------------------------------------- refusals --- */

/**
 * The visitor-facing text for every `<action>.<code>` of this form's checking
 * attachments, in `locale` (decision 3). Per code: the editor's text in the active
 * locale, then each fallback, then the editor's source text, then the code's declared
 * `message` (for `error`, Folio's own). An empty text counts as unwritten. An
 * attachment whose action is unregistered, or has no `check`, contributes nothing.
 */
export function refusalsOf(
  attachments: readonly FormActionAttachment[],
  infos: ReadonlyMap<string, FormActionInfo>,
  locale?: LocaleContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  const chain = locale ? [locale.code, ...locale.fallbacks] : [];
  for (const attachment of attachments) {
    const info = infos.get(attachment.action);
    if (!info?.check) continue;
    const declared = new Map(info.codes.map((c) => [c.code, c.message]));
    if (!declared.has(RESERVED_CODE)) declared.set(RESERVED_CODE, DEFAULT_ERROR_MESSAGE);
    for (const [code, fallback] of declared) {
      let text: string | undefined;
      for (const loc of chain) {
        const candidate = attachment.i18n?.[loc]?.messages?.[code];
        if (candidate !== undefined && candidate !== "") {
          text = candidate;
          break;
        }
      }
      const source = attachment.messages?.[code];
      if (text === undefined && source !== undefined && source !== "") text = source;
      out[`${attachment.action}.${code}`] = text ?? fallback;
    }
  }
  return out;
}
