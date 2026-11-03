/**
 * Form deliveries (`../../docs/specs/content-model/form-actions.md` decisions 9 to 16
 * and 20): the second phase of a form action, after the response has committed.
 *
 * A delivery is a row in `form_deliveries`, written in the response's own batch and
 * attempted at least once. Every attempt, whether from the submit route's `waitUntil`,
 * the cron's pass or a Retry, **claims** its row with a fresh random token first, and
 * **every result write is fenced by that token**: a runner whose lease lapsed and whose
 * row has since been claimed by somebody else writes nothing, so a late timeout can
 * never put a `delivered` row back to `pending` and a late success can never overwrite
 * a newer attempt's answer.
 *
 * Three rules are easy to break and silent when broken:
 *
 *  - **The token fence.** `settle` is the only writer of a result and its `where`
 *    carries `claim = ?`.
 *  - **The snapshot.** Inputs are read through `form_deliveries.inputs_map`, the
 *    mapping as it stood at submit, never the form's current one; settings are the
 *    current attachment's, so Retry means "I fixed the setting, send it again".
 *  - **`detail` never holds a thrown value.** A thrown message goes to the logger with
 *    the response id, the action and the attempt number; `detail` holds only text an
 *    action deliberately returned in `{ skipped }` or `{ failed }`, bounded.
 */

import {
  type ActionSettingDef,
  attachmentProblems,
  type FormActionAttachment,
} from "../core/form-actions";
import { RATE_WINDOW_MS, responseForDelivery, deliveryOf } from "./form-responses";
import type { FormResponse, SubmittedFile } from "./form-responses";
import type { ActionQuestion } from "./form-actions";
import {
  DEFAULT_DELIVERY_BATCH,
  DELIVER_TIMEOUT_MS,
  DELIVERY_BACKOFF_MS,
  DELIVERY_BUDGET_MS,
  DELIVERY_LEASE_MS,
  type DeliveryFailure,
  type DeliveryFailureCategory,
  type DeliveryRow,
  type DeliveryRunReport,
  type DeliveryStatus,
  MAX_DELIVERY_ATTEMPTS,
} from "./form-actions";
import type { FolioDb } from "./db";
import { type Form, formById, formMeta } from "./forms";
import type { BrandRuntime, FolioRuntime } from "./runtime";

/** What `detail` and `reference` are bounded to (decision 15). */
export const MAX_DELIVERY_TEXT = 500;

/* ---------------------------------------------------------------- deadlines --- */

export type Settled<T> =
  | { kind: "value"; value: T }
  | { kind: "threw"; error: unknown }
  | { kind: "timeout" };

/**
 * Runs `run` with a deadline (decision 16): an `AbortSignal` on the context for the
 * action to pass to `fetch`, **and** a race Folio enforces, so a host that ignores the
 * signal is still cut off. A promise that settles after its deadline has its answer
 * ignored (its rejection is caught inside, so it is never unhandled).
 */
export async function runWithDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<Settled<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, ms);
  });
  const work = (async (): Promise<Settled<T>> => {
    try {
      return { kind: "value", value: await run(controller.signal) };
    } catch (error) {
      return { kind: "threw", error };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- inputs --- */

/** The form's questions as an action sees them: in order, source-locale labels, and a
 *  value-to-label map for the static options of an option kind. `statement` stores
 *  nothing and is left out. */
export function questionsOf(form: Form): ActionQuestion[] {
  return form.fields
    .filter((field) => field.kind !== "statement")
    .map((field) => {
      const options =
        field.options && field.options.length > 0
          ? Object.fromEntries(field.options.map((o) => [o.value, o.label]))
          : undefined;
      return {
        name: field.name,
        kind: field.kind,
        label: field.label,
        ...(options ? { options } : {}),
      };
    });
}

/**
 * Resolves each declared input through `map` against a response's answers and files.
 * `missing` names the **required** inputs with no answer of the input's value type;
 * an optional input that is unmapped, unanswered or of the wrong type is left out.
 */
export function resolveInputs(
  inputs: readonly { name: string; kind: string; required: boolean }[],
  map: Readonly<Record<string, string>>,
  data: Readonly<Record<string, unknown>>,
  files: readonly SubmittedFile[],
): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const input of inputs) {
    const question = map[input.name];
    let value: unknown;
    if (question !== undefined && question !== "") {
      const raw = data[question];
      switch (input.kind) {
        case "text":
        case "email":
          if (typeof raw === "string" && raw !== "") value = raw;
          break;
        case "number":
          if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
          break;
        case "boolean":
          if (typeof raw === "boolean") value = raw;
          break;
        case "list":
          if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) value = raw;
          break;
        case "file":
          value = files.find((file) => file.field === question);
          break;
      }
    }
    if (value === undefined) {
      if (input.required) missing.push(input.name);
    } else {
      values[input.name] = value;
    }
  }
  return { values, missing };
}

/** The settings values an attachment carries, for the context. */
export const settingsOf = (a: FormActionAttachment): Record<string, string | number | boolean> => ({
  ...(a.settings ?? {}),
});

/**
 * Whether the attachment's **settings** satisfy the action's definitions (a required
 * setting set, a value its definition accepts). The mapping is deliberately not asked
 * here: a delivery reads it through the submit-time snapshot, and the form's current
 * questions may have been renamed since.
 */
export function settingsProblems(
  attachment: FormActionAttachment,
  settings: Record<string, ActionSettingDef>,
): string[] {
  return attachmentProblems(
    {
      action: attachment.action,
      ...(attachment.settings ? { settings: attachment.settings } : {}),
    },
    {
      id: attachment.action,
      label: attachment.action,
      inputs: [],
      settings,
      codes: [],
      check: false,
      deliver: true,
    },
    [],
    {},
  );
}

/** The mapping restricted to a snapshot's own shape: names only. */
export function mappingSnapshot(
  attachment: FormActionAttachment,
  inputNames: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of inputNames) {
    const question = attachment.map?.[name];
    if (question !== undefined && question !== "") out[name] = question;
  }
  return out;
}

function readMap(raw: string | null): Record<string, string> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the results --- */

/** What `deliver` answered, in the five shapes decision 15 allows. */
export type Classified =
  | { kind: "delivered"; reference: string | null }
  | { kind: "skipped"; detail: string }
  | { kind: "refused"; detail: string }
  | { kind: "malformed" };

const bounded = (text: string): string => text.slice(0, MAX_DELIVERY_TEXT);

/**
 * Reads a `deliver` result strictly: nothing or `{ reference? }` is delivered,
 * `{ skipped }` and `{ failed }` carry the action's own text, and anything else is
 * `malformed` (retried like a throw).
 */
export function classify(result: unknown): Classified {
  if (result === undefined) return { kind: "delivered", reference: null };
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { kind: "malformed" };
  }
  const keys = Object.keys(result);
  const r = result as Record<string, unknown>;
  if (keys.length === 1 && typeof r.skipped === "string") {
    return { kind: "skipped", detail: bounded(r.skipped) };
  }
  if (keys.length === 1 && typeof r.failed === "string") {
    return { kind: "refused", detail: bounded(r.failed) };
  }
  if (
    keys.every((k) => k === "reference") &&
    (r.reference === undefined || typeof r.reference === "string")
  ) {
    return {
      kind: "delivered",
      reference:
        typeof r.reference === "string" && r.reference !== "" ? bounded(r.reference) : null,
    };
  }
  return { kind: "malformed" };
}

/* ------------------------------------------------------------------ attempt --- */

export interface DeliveryDeps {
  rt: FolioRuntime;
  env: unknown;
  db: FolioDb;
  /** The brand of the site that received a response, memoised by the caller's scope. */
  brandFor: (site: string) => Promise<BrandRuntime | null>;
  /** The clock: the pass's `now` when one was injected, else `Date.now()`. */
  clock: () => number;
  /** Test seam: the per-attempt deadline. */
  deliverMs?: number;
}

export type AttemptOutcome =
  /** Not due, not pending, or another runner holds the lease: nothing happened. */
  | { kind: "unclaimed" }
  /** The response (or form) was gone; the row was deleted. */
  | { kind: "dropped" }
  /** The attempt ran but its result write matched nothing: a newer claim owns the row. */
  | { kind: "stale"; action: string }
  | {
      kind: "done";
      responseId: string;
      formId: string;
      action: string;
      status: DeliveryStatus;
      failure: DeliveryFailureCategory | null;
      attempts: number;
      timedOut: boolean;
    };

interface Result {
  status: DeliveryStatus;
  nextAt: number | null;
  failure: DeliveryFailureCategory | null;
  detail: string | null;
  reference: string | null;
  /** The mapping to record; null leaves `inputs_map` as it was. */
  inputsMap: Record<string, string> | null;
}

const failed = (failure: DeliveryFailureCategory): Result => ({
  status: "failed",
  nextAt: null,
  failure,
  detail: null,
  reference: null,
  inputsMap: null,
});

/** Preloaded rows a caller already holds, so the first attempt re-reads nothing. */
export interface AttemptHint {
  form?: Form;
}

/**
 * One attempt at one delivery (decisions 10, 11, 15 and 16).
 *
 * Claim, load, resolve, call, settle. The claim is one conditional `update … returning`
 * that moves `attempts` and pushes `next_at` out by the lease, so a runner that dies
 * mid-attempt leaves a row the next sweep picks up and still counts the attempt. The
 * result write is `settle`, fenced by the token.
 */
export async function attemptDelivery(
  deps: DeliveryDeps,
  responseId: string,
  action: string,
  hint: AttemptHint = {},
): Promise<AttemptOutcome> {
  const { db, rt } = deps;
  const logger = rt.logger;
  const now = deps.clock();
  const token = crypto.randomUUID();

  const { results: claimedRows } = await db
    .prepare(
      `update form_deliveries
          set attempts = attempts + 1, next_at = ?, claim = ?, updated_at = ?
        where response_id = ? and action = ? and status = 'pending' and next_at <= ?
        returning attempts, form_id as formId, host, inputs_map as inputsMap`,
    )
    .bind(now + DELIVERY_LEASE_MS, token, now, responseId, action, now)
    .all<{ attempts: number; formId: string; host: string; inputsMap: string | null }>();
  const claimed = claimedRows[0];
  if (!claimed) return { kind: "unclaimed" };

  /** The fenced result write. False means somebody else holds the row now. */
  const settle = async (result: Result): Promise<boolean> => {
    const written = await db
      .prepare(
        `update form_deliveries
            set status = ?, next_at = ?, failure = ?, detail = ?, reference = ?,
                inputs_map = coalesce(?, inputs_map), claim = null, updated_at = ?
          where response_id = ? and action = ? and claim = ?`,
      )
      .bind(
        result.status,
        result.nextAt,
        result.failure,
        result.detail,
        result.reference,
        result.inputsMap === null ? null : JSON.stringify(result.inputsMap),
        deps.clock(),
        responseId,
        action,
        token,
      )
      .run();
    return (written.meta.changes ?? 0) > 0;
  };
  const done = async (result: Result, timedOut = false): Promise<AttemptOutcome> => {
    if (!(await settle(result))) return { kind: "stale", action };
    return {
      kind: "done",
      responseId,
      formId: claimed.formId,
      action,
      status: result.status,
      failure: result.failure,
      attempts: claimed.attempts,
      timedOut,
    };
  };
  const drop = async (): Promise<AttemptOutcome> => {
    await db
      .prepare("delete from form_deliveries where response_id = ? and action = ? and claim = ?")
      .bind(responseId, action, token)
      .run();
    return { kind: "dropped" };
  };

  const loaded = await responseForDelivery(db, responseId);
  if (!loaded) return drop();
  const form = hint.form ?? (await formById(db, claimed.formId, logger));
  if (!form) return drop();

  const brand = await deps.brandFor(loaded.site);
  if (!brand) return done(failed("no_brand"));

  const attachment = form.actions.find((a) => a.action === action);
  if (!attachment) {
    return done({ ...failed("gave_up"), status: "cancelled", failure: null, nextAt: null });
  }
  const def = brand.forms?.actions.get(action);
  const info = brand.forms?.infos.get(action);
  if (!def || !info || typeof def.deliver !== "function") return done(failed("not_registered"));
  if (settingsProblems(attachment, info.settings).length > 0) return done(failed("incomplete"));

  // The snapshot, else (a row created `failed`, being retried) the current mapping.
  const snapshot = readMap(claimed.inputsMap);
  const map =
    snapshot ??
    mappingSnapshot(
      attachment,
      info.inputs.map((i) => i.name),
    );
  const { values, missing } = resolveInputs(info.inputs, map, loaded.response.data, loaded.files);
  if (missing.length > 0) return done(failed("predates_mapping"));
  // A mapping that came from the current attachment (the row had no snapshot) is
  // recorded with the attempt, so later retries read the same one (decision 11).
  const recorded = snapshot === null ? map : null;

  const ctx = (signal: AbortSignal) => ({
    form: formMeta(form),
    inputs: values,
    settings: settingsOf(attachment),
    questions: questionsOf(form),
    site: loaded.site,
    brand: brand.brand?.id ?? null,
    host: claimed.host,
    locale: loaded.response.locale,
    page: loaded.response.page,
    signal,
    response: loaded.response,
    files: loaded.files,
    key: `${responseId}:${action}`,
    attempt: claimed.attempts,
  });

  const settled = await runWithDeadline(deps.deliverMs ?? DELIVER_TIMEOUT_MS, (signal) =>
    (def.deliver as (c: unknown, env: unknown) => unknown)(ctx(signal), deps.env),
  );

  let category: DeliveryFailureCategory;
  if (settled.kind === "timeout") {
    category = "timeout";
  } else if (settled.kind === "threw") {
    // The thrown value goes to the log and nowhere else: a `fetch` error can quote a URL
    // with a key in its query string (decision 15).
    logger.error(
      `folio: form action "${action}" delivery threw (response ${responseId}, attempt ${claimed.attempts})`,
      settled.error,
    );
    category = "threw";
  } else {
    const result = classify(settled.value);
    if (result.kind === "delivered") {
      return done({
        status: "delivered",
        nextAt: null,
        failure: null,
        detail: null,
        reference: result.reference,
        inputsMap: recorded,
      });
    }
    if (result.kind === "skipped") {
      return done({
        status: "skipped",
        nextAt: null,
        failure: null,
        detail: result.detail,
        reference: null,
        inputsMap: recorded,
      });
    }
    if (result.kind === "refused") {
      return done({
        status: "failed",
        nextAt: null,
        failure: "refused",
        detail: result.detail,
        reference: null,
        inputsMap: recorded,
      });
    }
    logger.error(
      `folio: form action "${action}" delivery answered an unexpected shape (response ${responseId}, attempt ${claimed.attempts})`,
    );
    category = "malformed";
  }

  // Retryable (decision 12): back off, or give up at the cap. The backoff is read at
  // index `attempts - 1` of a table with `MAX_DELIVERY_ATTEMPTS - 1` entries.
  if (claimed.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return done({ ...failed("gave_up"), inputsMap: recorded }, settled.kind === "timeout");
  }
  const wait = DELIVERY_BACKOFF_MS[claimed.attempts - 1] ?? DELIVERY_BACKOFF_MS.at(-1)!;
  return done(
    {
      status: "pending",
      nextAt: deps.clock() + wait,
      failure: category,
      detail: null,
      reference: null,
      inputsMap: recorded,
    },
    settled.kind === "timeout",
  );
}

/**
 * The first attempts of a just-stored response, concurrently (decision 10): the rows
 * are independent, so they all fit inside `waitUntil`'s budget. The visitor never
 * waits. Never throws: a failure here is logged, and the row is picked up by the cron
 * once its lease lapses.
 */
export async function attemptNew(
  deps: DeliveryDeps,
  responseId: string,
  actions: readonly string[],
  hint: AttemptHint = {},
): Promise<void> {
  await Promise.all(
    actions.map(async (action) => {
      try {
        await attemptDelivery(deps, responseId, action, hint);
      } catch (err) {
        deps.rt.logger.error(
          `folio: form action "${action}" delivery could not be attempted (response ${responseId})`,
          err,
        );
      }
    }),
  );
}

/* ---------------------------------------------------------------- the pass --- */

/** A brand per site for one pass, memoised: `scheduleDeps`' pattern (decision 12). */
export function brandResolver(
  rt: FolioRuntime,
  env: unknown,
): (site: string) => Promise<BrandRuntime | null> {
  const only = rt.brands.get(null);
  if (only) return async () => only;
  let registry: ReturnType<NonNullable<FolioRuntime["sites"]>["registry"]> | null = null;
  const memo = new Map<string, Promise<BrandRuntime | null>>();
  return (site) => {
    let found = memo.get(site);
    if (!found) {
      found = (async () => {
        if (!rt.sites) return null;
        registry ??= rt.sites.registry(env);
        return rt.forScope(await registry, site);
      })();
      memo.set(site, found);
    }
    return found;
  };
}

export interface RunDeliveriesOptions {
  /** The instant to compare against and to back off from. Defaults to `Date.now()`. */
  now?: number;
  /** Rows per pass. Default `DEFAULT_DELIVERY_BATCH`. */
  batch?: number;
  /** Reports how many are due and attempts none, deleting nothing. */
  dryRun?: boolean;
  /** Test seams: the wall-clock budget and the per-attempt deadline. */
  budgetMs?: number;
  deliverMs?: number;
}

/**
 * One delivery pass (decision 12): at most `batch` due rows, oldest `next_at` first,
 * attempted **sequentially** within a wall-clock budget, each with its brand resolved
 * from the response's own site. An action whose attempt timed out is not attempted
 * again in the same pass, so one brand's hung vendor costs at most one deadline per tick.
 * The same pass deletes `form_refusals` older than two rate windows (decision 23).
 */
export async function runDeliveries(
  rt: FolioRuntime,
  env: unknown,
  db: FolioDb,
  opts: RunDeliveriesOptions = {},
): Promise<DeliveryRunReport> {
  const now = opts.now ?? Date.now();
  const clock = () => opts.now ?? Date.now();
  const batch = Math.max(1, Math.trunc(opts.batch ?? DEFAULT_DELIVERY_BATCH));
  const budget = opts.budgetMs ?? DELIVERY_BUDGET_MS;
  const report: DeliveryRunReport = { due: 0, delivered: 0, skipped: 0, failed: [], dropped: 0 };

  if (opts.dryRun === true) {
    const row = await db
      .prepare(
        "select count(*) as n from form_deliveries where status = 'pending' and next_at <= ?",
      )
      .bind(now)
      .first<{ n: number }>();
    report.due = row?.n ?? 0;
    return report;
  }

  await db
    .prepare("delete from form_refusals where created_at < ?")
    .bind(now - 2 * RATE_WINDOW_MS)
    .run();

  const { results: due } = await db
    .prepare(
      `select response_id as responseId, action from form_deliveries
        where status = 'pending' and next_at <= ?
        order by next_at, response_id limit ?`,
    )
    .bind(now, batch)
    .all<{ responseId: string; action: string }>();
  report.due = due.length;

  const deps: DeliveryDeps = {
    rt,
    env,
    db,
    brandFor: brandResolver(rt, env),
    clock,
    ...(opts.deliverMs === undefined ? {} : { deliverMs: opts.deliverMs }),
  };
  const started = Date.now();
  const hung = new Set<string>();
  for (const row of due) {
    if (Date.now() - started >= budget) break;
    if (hung.has(row.action)) continue;
    let outcome: AttemptOutcome;
    try {
      outcome = await attemptDelivery(deps, row.responseId, row.action);
    } catch (err) {
      rt.logger.error(
        `folio: form action "${row.action}" delivery could not be attempted (response ${row.responseId})`,
        err,
      );
      continue;
    }
    if (outcome.kind === "dropped") report.dropped++;
    if (outcome.kind !== "done") continue;
    if (outcome.timedOut) hung.add(row.action);
    if (outcome.status === "delivered") report.delivered++;
    else if (outcome.status === "skipped") report.skipped++;
    else if (outcome.failure !== null) report.failed.push(failureOf(outcome));
  }
  return report;
}

function failureOf(outcome: Extract<AttemptOutcome, { kind: "done" }>): DeliveryFailure {
  return {
    responseId: outcome.responseId,
    formId: outcome.formId,
    action: outcome.action,
    attempts: outcome.attempts,
    failure: outcome.failure as DeliveryFailureCategory,
    givenUp: outcome.status === "failed",
  };
}

/* -------------------------------------------------------------------- retry --- */

export type RetryResult =
  | { kind: "ok"; delivery: DeliveryRow }
  | { kind: "missing" }
  | { kind: "conflict"; message: string };

/**
 * Retry (decision 15): one conditional reset that revives a `failed`, `skipped` or
 * `pending` row whose lease is not held, then one attempt **inline**, so the person pressing the
 * button sees whether it worked. `changes = 0` is a 409 with the reason read back. A
 * `delivered` row is refused (resending a lead the third party holds is a duplicate,
 * not a fix), and so is one that `predates_mapping`.
 *
 * **A held lease is `claim` set and `next_at` in the future.** A result write clears
 * `claim`, so a `pending` row waiting out its backoff has none and may be retried (the
 * publisher who fixed a setting after a failure does not have to wait for the next
 * step), while a row some runner is mid-attempt on is refused. The reset also clears
 * `claim`: a runner whose lease lapsed still holds the old token, and between the reset
 * and this retry's own claim nothing may match it.
 */
export async function retryDelivery(
  deps: DeliveryDeps,
  form: Form,
  responseId: string,
  action: string,
): Promise<RetryResult> {
  const { db } = deps;
  const existing = await deliveryOf(db, responseId, action);
  if (!existing) return { kind: "missing" };

  if (!form.actions.some((a) => a.action === action)) {
    return { kind: "conflict", message: "The action is no longer attached" };
  }
  const loaded = await responseForDelivery(db, responseId);
  if (!loaded) return { kind: "missing" };
  const brand = await deps.brandFor(loaded.site);
  if (!brand?.forms?.actions.has(action)) {
    return { kind: "conflict", message: "The action is no longer registered" };
  }

  const now = deps.clock();
  const reset = await db
    .prepare(
      `update form_deliveries
          set attempts = 0, status = 'pending', next_at = ?, failure = null, detail = null,
              claim = null, updated_at = ?
        where response_id = ? and action = ?
          and status in ('pending', 'failed', 'skipped')
          and (claim is null or next_at is null or next_at <= ?)
          and failure is not 'predates_mapping'`,
    )
    .bind(now, now, responseId, action, now)
    .run();
  if ((reset.meta.changes ?? 0) === 0) {
    const current = await deliveryOf(db, responseId, action);
    if (!current) return { kind: "missing" };
    return { kind: "conflict", message: whyNot(current) };
  }

  await attemptDelivery(deps, responseId, action, { form });
  const after = await deliveryOf(db, responseId, action);
  return after ? { kind: "ok", delivery: after } : { kind: "missing" };
}

function whyNot(row: DeliveryRow): string {
  if (row.status === "delivered") return "Already delivered";
  if (row.status === "pending") return "An attempt is in progress";
  if (row.status === "cancelled") return "The action is no longer attached";
  if (row.failure === "predates_mapping") {
    return "This response was submitted before the current mapping, so it has no answer for what the action needs";
  }
  return "That delivery cannot be retried";
}

export type { FormResponse };
