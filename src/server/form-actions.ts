/**
 * Form actions, the server half (`docs/specs/content-model/form-actions.md`, phase 2):
 * what a host registers under `forms.actions`, `formAction()` to define one with its
 * inputs and settings inferred, `actionInfoOf` to take the JSON half of a definition
 * for the builder, and `validateActions` to refuse a bad registry at construction.
 *
 * Nothing here runs an action. The submit route (phase 4) calls `check`, and the
 * delivery pass calls `deliver`; this file only says what they are given and what
 * comes back.
 */

import {
  ACTION_CODE,
  ACTION_ID,
  ACTION_INPUT_NAME,
  type ActionCodeInfo,
  type ActionInputInfo,
  type ActionInputKind,
  type ActionSettingDef,
  DEFAULT_ERROR_MESSAGE,
  type FormActionInfo,
  RESERVED_CODE,
} from "../core/form-actions";
import type { ValueOf } from "../core/fields";
import type { FormFieldKind } from "../core/forms";
import type { FormResponse, SubmittedFile } from "./form-responses";
import type { FormMeta } from "./forms";
import type { FolioLogger } from "./types";

/* ------------------------------------------------------------- definitions --- */

/** One input an action declares (decision 5). */
export interface ActionInputDef {
  kind: ActionInputKind;
  label: string;
  help?: string;
  required?: boolean;
}

/** One refusal an action's `check` may give (decision 3). */
export interface ActionCodeDef {
  /** What the editor reads in the builder. */
  label: string;
  /** The source-locale default, shown as the placeholder. */
  message: string;
}

/** A question as an action sees it. */
export interface ActionQuestion {
  name: string;
  kind: FormFieldKind;
  label: string;
  options?: Readonly<Record<string, string>>;
}

type InputValue<K> = K extends "text" | "email"
  ? string
  : K extends "number"
    ? number
    : K extends "boolean"
      ? boolean
      : K extends "list"
        ? readonly string[]
        : K extends "file"
          ? SubmittedFile
          : never;

/** Required inputs arrive as a value, optional ones as a value or `undefined`. */
export type InputsOf<I extends Record<string, ActionInputDef>> = {
  [K in keyof I as I[K] extends { required: true } ? K : never]: InputValue<I[K]["kind"]>;
} & {
  [K in keyof I as I[K] extends { required: true } ? never : K]?: InputValue<I[K]["kind"]>;
};

/** `ValueOf` per setting definition, `undefined` where the editor left it unset. */
export type SettingsOf<S extends Record<string, ActionSettingDef>> = {
  [K in keyof S]: ValueOf<S[K]> | undefined;
};

interface ActionContextBase<
  I extends Record<string, ActionInputDef>,
  S extends Record<string, ActionSettingDef>,
> {
  form: FormMeta;
  inputs: InputsOf<I>;
  settings: SettingsOf<S>;
  questions: readonly ActionQuestion[];
  /** The submitting site; `'default'` without sites. */
  site: string;
  brand: string | null;
  /** The hostname that received the submission (decision 14). */
  host: string;
  /** The stored locale code, `''` for the source. */
  locale: string;
  page: string;
  /** Aborts at the phase's deadline (decision 16). */
  signal: AbortSignal;
}

export interface CheckContext<
  I extends Record<string, ActionInputDef>,
  S extends Record<string, ActionSettingDef>,
> extends ActionContextBase<I, S> {
  req: Request;
  /** The raw body, before undeclared keys are dropped: `verify`'s reason. */
  raw: Readonly<Record<string, string>>;
}

export type CheckResult<C extends string> =
  | { ok: true; reply?: Readonly<Record<string, string | number>> }
  | { ok: false; code: C };

export interface DeliverContext<
  I extends Record<string, ActionInputDef>,
  S extends Record<string, ActionSettingDef>,
> extends ActionContextBase<I, S> {
  response: FormResponse;
  files: readonly SubmittedFile[];
  /** `${responseId}:${actionId}`, stable across retries (decision 10). */
  key: string;
  /** 1-based. */
  attempt: number;
}

// `void` so an `async` deliver with no return value is assignable; `undefined` is not.
export type DeliverResult =
  // biome-ignore lint/suspicious/noConfusingVoidType: see above
  void | { reference?: string } | { skipped: string } | { failed: string };

/**
 * A host-defined submission action. `check` and `deliver` are declared as methods,
 * for `FolioGate`'s bivariance reason: a `FormAction<Env, …>` has to stay assignable
 * to the `FormAction<unknown>` the runtime widens it to.
 */
export interface FormAction<
  Env,
  I extends Record<string, ActionInputDef> = Record<string, ActionInputDef>,
  S extends Record<string, ActionSettingDef> = Record<string, ActionSettingDef>,
  C extends string = string,
> {
  id: string;
  label: string;
  description?: string;
  inputs?: I;
  settings?: S;
  codes?: Record<C, ActionCodeDef>;
  /**
   * Runs before the response is stored, and **is a read**: it validates, looks up and
   * answers. Anything that creates or changes state outside Folio belongs in
   * `deliver` (decision 24), because a check runs before Folio knows whether the
   * submission will be stored. Fails closed on a throw, a timeout or a malformed
   * answer (decision 2).
   *
   * A declared code's verdict is visible to anyone who can post the form (decision
   * 23). A code that reveals something about a person belongs on a brand that
   * configures `verify`.
   */
  check?(ctx: CheckContext<I, S>, env: Env): CheckResult<C> | Promise<CheckResult<C>>;
  /** Runs after the response has committed, at least once, with an idempotency key. */
  deliver?(ctx: DeliverContext<I, S>, env: Env): DeliverResult | Promise<DeliverResult>;
}

/** Identity, for inference: `inputs`, `settings` and `codes` keep their literal types. */
export function formAction<
  Env,
  const I extends Record<string, ActionInputDef> = Record<string, ActionInputDef>,
  const S extends Record<string, ActionSettingDef> = Record<string, ActionSettingDef>,
  const C extends string = string,
>(def: FormAction<Env, I, S, C>): FormAction<Env, I, S, C> {
  return def;
}

/* -------------------------------------------------------------- deliveries --- */

export type DeliveryStatus = "pending" | "delivered" | "skipped" | "failed" | "cancelled";

/**
 * Why a delivery is not delivered (decision 15). **A category, never a thrown
 * message**: the editor's screen shows these and the action's own `detail`.
 */
export type DeliveryFailureCategory =
  | "threw"
  | "timeout"
  | "malformed"
  | "refused"
  | "not_registered"
  | "incomplete"
  | "predates_mapping"
  | "no_brand"
  | "gave_up";

/** One `form_deliveries` row as the admin reads it. */
export interface DeliveryRow {
  action: string;
  status: DeliveryStatus;
  attempts: number;
  nextAt: number | null;
  reference: string | null;
  failure: DeliveryFailureCategory | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryFailure {
  responseId: string;
  formId: string;
  action: string;
  attempts: number;
  failure: DeliveryFailureCategory;
  /** True once the row is `failed`: nothing will attempt it again until a Retry. */
  givenUp: boolean;
}

export interface DeliveryRunReport {
  /** Rows selected as due by this pass (not those left behind by the budget). */
  due: number;
  delivered: number;
  skipped: number;
  /** Every attempt that did not end delivered or skipped, retryable or not. */
  failed: DeliveryFailure[];
  /** Rows whose response was already gone, deleted. */
  dropped: number;
}

export const MAX_DELIVERY_ATTEMPTS = 8;
/**
 * Wait after a failed attempt, by attempt number (decision 12). Exactly
 * `MAX_DELIVERY_ATTEMPTS - 1` entries: the last attempt gives up, so the table is
 * never indexed past its end.
 */
export const DELIVERY_BACKOFF_MS: readonly number[] = [
  60_000, // after attempt 1: 1 minute
  300_000, // 2: 5 minutes
  900_000, // 3: 15 minutes
  3_600_000, // 4: 1 hour
  10_800_000, // 5: 3 hours
  21_600_000, // 6: 6 hours
  43_200_000, // 7: 12 hours
];
export const DELIVERY_LEASE_MS = 120_000;
export const DELIVERY_BUDGET_MS = 30_000;
export const CHECK_TIMEOUT_MS = 10_000;
export const DELIVER_TIMEOUT_MS = 20_000;
export const DEFAULT_DELIVERY_BATCH = 25;

/* ---------------------------------------------------------------- the info --- */

/**
 * The JSON half of a definition: what `GET {base}/api/forms/registry` sends the
 * builder. **Never functions** (decision 4): the settings definitions are round-tripped
 * through JSON, which drops anything callable a host hung off one, and `check` and
 * `deliver` are reduced to two booleans. Declared codes come first, then `error` when
 * the action has a check.
 */
export function actionInfoOf(def: FormAction<unknown, never, never, string>): FormActionInfo {
  const inputs: ActionInputInfo[] = Object.entries(
    (def.inputs ?? {}) as Record<string, ActionInputDef>,
  ).map(([name, input]) => ({
    name,
    kind: input.kind,
    label: input.label,
    ...(input.help !== undefined ? { help: input.help } : {}),
    required: input.required === true,
  }));
  const check = typeof def.check === "function";
  const codes: ActionCodeInfo[] = Object.entries(
    (def.codes ?? {}) as Record<string, ActionCodeDef>,
  ).map(([code, c]) => ({ code, label: c.label, message: c.message }));
  if (check) {
    codes.push({ code: RESERVED_CODE, label: "Could not process", message: DEFAULT_ERROR_MESSAGE });
  }
  return {
    id: def.id,
    label: def.label,
    ...(def.description !== undefined ? { description: def.description } : {}),
    inputs,
    settings: JSON.parse(JSON.stringify(def.settings ?? {})) as Record<string, ActionSettingDef>,
    codes,
    check,
    deliver: typeof def.deliver === "function",
  };
}

/* -------------------------------------------------------------- validation --- */

const INPUT_KINDS: readonly string[] = ["text", "email", "number", "boolean", "list", "file"];
const SETTING_KINDS: readonly string[] = [
  "text",
  "textarea",
  "number",
  "boolean",
  "date",
  "select",
];
const SETTING_FLAGS = ["translatable", "indexed", "searchable", "unique"] as const;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** A brand's actions, validated: the definitions by id, and their builder-facing info. */
export interface ResolvedActions {
  actions: ReadonlyMap<string, FormAction<unknown>>;
  infos: ReadonlyMap<string, FormActionInfo>;
}

/**
 * `forms.actions`, refused at construction for the same reason `verify` and `sources`
 * are: the request that would otherwise discover a malformed action is an anonymous
 * POST, or an editor's first save. Each message names the action by id once it has one.
 */
export function validateActions(actions: unknown): ResolvedActions {
  const out = new Map<string, FormAction<unknown>>();
  const infos = new Map<string, FormActionInfo>();
  if (actions === undefined) return { actions: out, infos };
  if (!Array.isArray(actions)) {
    throw new Error("folio: `forms.actions` must be an array of form actions");
  }
  for (const [index, raw] of actions.entries()) {
    if (!isRecord(raw)) throw new Error(`folio: \`forms.actions[${index}]\` must be an object`);
    const def = raw as unknown as FormAction<unknown>;
    if (typeof def.id !== "string" || !ACTION_ID.test(def.id)) {
      throw new Error(
        `folio: \`forms.actions[${index}].id\` ${JSON.stringify(def.id)} is not a valid action id (${ACTION_ID})`,
      );
    }
    const where = `\`forms.actions\` "${def.id}"`;
    if (out.has(def.id)) throw new Error(`folio: ${where} is registered twice`);
    if (!nonEmpty(def.label)) throw new Error(`folio: ${where} needs a non-empty label`);
    if (def.description !== undefined && typeof def.description !== "string") {
      throw new Error(`folio: ${where}.description must be a string`);
    }
    for (const phase of ["check", "deliver"] as const) {
      if (def[phase] !== undefined && typeof def[phase] !== "function") {
        throw new Error(`folio: ${where}.${phase} must be a function`);
      }
    }
    if (typeof def.check !== "function" && typeof def.deliver !== "function") {
      throw new Error(`folio: ${where} needs a check, a deliver, or both`);
    }

    if (def.inputs !== undefined) {
      if (!isRecord(def.inputs)) throw new Error(`folio: ${where}.inputs must be an object`);
      for (const [name, input] of Object.entries(def.inputs)) {
        if (!ACTION_INPUT_NAME.test(name)) {
          throw new Error(`folio: ${where} input "${name}" is not a valid input name`);
        }
        if (!isRecord(input) || !INPUT_KINDS.includes(input.kind as string)) {
          throw new Error(
            `folio: ${where} input "${name}" needs a kind of ${INPUT_KINDS.join(", ")}`,
          );
        }
        if (!nonEmpty(input.label)) {
          throw new Error(`folio: ${where} input "${name}" needs a non-empty label`);
        }
        if (input.required !== undefined && typeof input.required !== "boolean") {
          throw new Error(`folio: ${where} input "${name}".required must be a boolean`);
        }
      }
    }

    if (def.settings !== undefined) {
      if (!isRecord(def.settings)) throw new Error(`folio: ${where}.settings must be an object`);
      for (const [name, field] of Object.entries(def.settings)) {
        if (!ACTION_INPUT_NAME.test(name)) {
          throw new Error(`folio: ${where} setting "${name}" is not a valid setting name`);
        }
        if (!isRecord(field) || !SETTING_KINDS.includes(field.kind as string)) {
          throw new Error(
            `folio: ${where} setting "${name}" must be a ${SETTING_KINDS.join(", ")} field`,
          );
        }
        for (const flag of SETTING_FLAGS) {
          if (field[flag] !== undefined) {
            throw new Error(`folio: ${where} setting "${name}" cannot set \`${flag}\``);
          }
        }
        if (field.kind === "select") {
          const options = field.options;
          if (!Array.isArray(options) || options.length === 0) {
            throw new Error(`folio: ${where} setting "${name}" needs at least one option`);
          }
          const seen = new Set<string>();
          for (const option of options) {
            if (!isRecord(option) || typeof option.value !== "string") {
              throw new Error(`folio: ${where} setting "${name}" has an option with no value`);
            }
            if (seen.has(option.value)) {
              throw new Error(
                `folio: ${where} setting "${name}" repeats the option "${option.value}"`,
              );
            }
            seen.add(option.value);
          }
        }
      }
    }

    if (def.codes !== undefined) {
      if (!isRecord(def.codes)) throw new Error(`folio: ${where}.codes must be an object`);
      if (typeof def.check !== "function") {
        throw new Error(
          `folio: ${where} declares codes but has no check, so nothing could refuse with one`,
        );
      }
      for (const [code, c] of Object.entries(def.codes)) {
        if (!ACTION_CODE.test(code)) {
          throw new Error(`folio: ${where} code "${code}" is not a valid code (${ACTION_CODE})`);
        }
        if (code === RESERVED_CODE) {
          throw new Error(
            `folio: ${where} cannot declare "${RESERVED_CODE}": it is the implicit fail-closed refusal`,
          );
        }
        if (!isRecord(c) || !nonEmpty(c.label) || !nonEmpty(c.message)) {
          throw new Error(`folio: ${where} code "${code}" needs a label and a message`);
        }
      }
    }

    out.set(def.id, {
      ...def,
      check: def.check?.bind(def),
      deliver: def.deliver?.bind(def),
    } as FormAction<unknown>);
    infos.set(def.id, actionInfoOf(def as FormAction<unknown, never, never, string>));
  }
  return { actions: out, infos };
}

/**
 * The construction-time warning of decision 23, as text: a brand that registers a
 * check with declared codes and has no `verify`, so each probe of a person-revealing
 * code costs one POST rather than a solved captcha. Pure, so the runtime logs it once
 * it has a logger and a test can read it.
 */
export function actionWarnings(
  infos: ReadonlyMap<string, FormActionInfo>,
  hasVerify: boolean,
  brand: string | null,
): string[] {
  if (hasVerify) return [];
  const where = brand === null ? "" : ` on brand '${brand}'`;
  const out: string[] = [];
  for (const info of infos.values()) {
    if (info.check && info.codes.some((c) => c.code !== RESERVED_CODE)) {
      out.push(
        `folio: form action "${info.id}" has a check with declared codes${where} but \`forms.verify\` is not configured: anyone can probe its verdicts at the cost of one POST`,
      );
    }
  }
  return out;
}

/** Logs `actionWarnings` for each brand's forms. */
export function logActionWarnings(
  brands: readonly {
    id: string | null;
    forms: { infos: ReadonlyMap<string, FormActionInfo>; config: { verify?: unknown } } | null;
  }[],
  logger: FolioLogger,
): void {
  for (const b of brands) {
    if (!b.forms) continue;
    for (const line of actionWarnings(b.forms.infos, b.forms.config.verify !== undefined, b.id)) {
      logger.warn(line);
    }
  }
}
