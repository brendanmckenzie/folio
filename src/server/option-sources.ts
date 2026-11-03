/**
 * Form option sources, the store (`../../docs/specs/content-model/form-option-sources.md`
 * decisions 6, 7, 8 and 16).
 *
 * A host source's list is kept in `option_lists`, one row per `(brand, source, key)`,
 * and **this is the only file that calls a host's `load`**. A render reads rows and
 * never calls it (decision 6): a page's latency must not depend on a vendor, and a
 * preview must not write.
 *
 * Every helper takes `FolioDb`, never `D1Database`, so a request's session can be
 * threaded through it. The one exception is `readListOnPrimary`, which has to open a
 * session of its own and says so.
 */
import type { Json } from "../core/doc";
import { indexedFields } from "../core/index-projection";
import type { FormField, FormFieldOption } from "../core/forms";
import {
  CONTENT_SOURCE,
  contentOptionSettings,
  MAX_SOURCED_OPTIONS,
  optionListKey,
  screenOptionLabel,
} from "../core/option-sources";
import { BUILT_IN_ORDERS } from "../core/query";
import type { DocumentType, SchemaIndex } from "../core/schema";
import { bindChunks, type FolioDb, PRIMARY_FIRST } from "./db";
import { FolioError } from "./errors";
import { type PurgeCapability, purgeOptionSource } from "./cache-purge";
import type { ResolvedForms, ResolvedOptionSource } from "./form-responses";
import type { BrandRef, FolioLogger } from "./types";

/** One load per key per this long, across every isolate (decision 7). */
export const LEASE_MS = 30_000;

/** The longest a stored value may be, and what `FORM_FIELD` allows an option. */
export const MAX_OPTION_VALUE = 120;

/** Why a load failed: a category and never the thrown message (decision 16). */
export type OptionFailure = "timeout" | "threw" | "malformed" | "empty";

/** `option_lists`, as a row reads. */
export interface OptionListRow {
  brand: string;
  source: string;
  key: string;
  /** Null until the first good load. */
  options: FormFieldOption[] | null;
  digest: string | null;
  loadedAt: number | null;
  attemptedAt: number;
  failures: number;
  failure: OptionFailure | null;
}

/** Where a list lives inside one brand: `key` is `optionListKey(settings, locale)`. */
export interface ListRef {
  source: string;
  key: string;
}

/** `option_lists.brand`: `''` on a deployment with no brands. */
export const brandKey = (brand: BrandRef | null): string => brand?.id ?? "";

/** A map key for a row or a ref within one brand. */
export const listId = (ref: ListRef): string => `${ref.source}\u0000${ref.key}`;

interface RawRow {
  brand: string;
  source: string;
  key: string;
  options: string | null;
  digest: string | null;
  loaded_at: number | null;
  attempted_at: number;
  failures: number;
  failure: string | null;
}

const COLS = "brand, source, key, options, digest, loaded_at, attempted_at, failures, failure";

function toRow(raw: RawRow): OptionListRow {
  let options: FormFieldOption[] | null = null;
  if (raw.options !== null) {
    try {
      const parsed: unknown = JSON.parse(raw.options);
      if (Array.isArray(parsed)) options = parsed as FormFieldOption[];
    } catch {
      // A row Folio wrote is JSON. One that is not reads as never loaded, and the
      // next refresh replaces it.
    }
  }
  return {
    brand: raw.brand,
    source: raw.source,
    key: raw.key,
    options,
    digest: raw.digest,
    loadedAt: raw.loaded_at,
    attemptedAt: raw.attempted_at,
    failures: raw.failures,
    failure: raw.failure as OptionFailure | null,
  };
}

/**
 * The rows for `refs` within `brand`, by `listId`. A ref with no row is absent.
 *
 * **Chunked**, because the list is question-sized (up to a form's field cap times
 * locales) and a statement binds at most 100 parameters. Each ref is two binds and
 * the brand one more, which `bindChunks`' margin absorbs. Every read is by primary
 * key, so each is a handful of point lookups.
 */
export async function readLists(
  db: FolioDb,
  brand: string,
  refs: readonly ListRef[],
): Promise<Map<string, OptionListRow>> {
  const out = new Map<string, OptionListRow>();
  const unique = [...new Map(refs.map((r) => [listId(r), r])).values()];
  const pages = await Promise.all(
    bindChunks(unique, 2).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select ${COLS} from option_lists
           where brand = ? and (${chunk.map(() => "(source = ? and key = ?)").join(" or ")})`,
        )
        .bind(brand, ...chunk.flatMap((r) => [r.source, r.key]))
        .all<RawRow>();
      return results;
    }),
  );
  for (const raw of pages.flat()) out.set(listId(raw), toRow(raw));
  return out;
}

/**
 * The one row, read on the primary. For the submit route's lost lease (decision 7): the
 * row it read on its session may be a replica that has not seen the load that holds
 * the lease. **Takes the D1 binding rather than `FolioDb`**, because opening a session
 * is the point.
 */
export async function readListOnPrimary(
  d1: Pick<D1Database, "withSession">,
  brand: string,
  ref: ListRef,
): Promise<OptionListRow | null> {
  const rows = await readLists(d1.withSession(PRIMARY_FIRST), brand, [ref]);
  return rows.get(listId(ref)) ?? null;
}

export type ListStatus = "fresh" | "stale" | "never-loaded";

/** `never-loaded` is "holds no options", whatever else the row says. */
export function listStatus(
  row: OptionListRow | null | undefined,
  ttl: number,
  now: number,
): ListStatus {
  if (!row || row.options === null || row.loadedAt === null) return "never-loaded";
  return row.loadedAt + ttl * 1000 <= now ? "stale" : "fresh";
}

/* --------------------------------------------------------------- screening --- */

export type Screened =
  | { ok: true; options: FormFieldOption[]; truncated: boolean }
  | { ok: false; failure: "malformed" | "empty" };

/**
 * A host's answer, screened (decision 7 step 3). It must be an array. An entry needs
 * a string `value` of 1 to `MAX_OPTION_VALUE` characters that is already trimmed and
 * printable, and a label that is trimmed, printable and truncated to 200 characters
 * (the value stands in for an absent or unusable one). The first occurrence of a
 * value wins and at most `MAX_SOURCED_OPTIONS` are kept.
 *
 * **An empty list is a failure, not an answer**: a source that answers `[]` because
 * the vendor broke would otherwise replace the last good list with nothing, and every
 * submission would then be refused.
 */
export function screenItems(raw: unknown): Screened {
  if (!Array.isArray(raw)) return { ok: false, failure: "malformed" };
  if (raw.length === 0) return { ok: false, failure: "empty" };
  const seen = new Set<string>();
  const options: FormFieldOption[] = [];
  let truncated = false;
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { value, label } = item as { value?: unknown; label?: unknown };
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_OPTION_VALUE) continue;
    if (screenOptionLabel(value) !== value) continue;
    if (seen.has(value)) continue;
    if (options.length >= MAX_SOURCED_OPTIONS) {
      truncated = true;
      break;
    }
    seen.add(value);
    options.push({ value, label: screenOptionLabel(label) ?? value });
  }
  return options.length === 0
    ? { ok: false, failure: "malformed" }
    : { ok: true, options, truncated };
}

const HEX = "0123456789abcdef";

/** SHA-256 of the canonical JSON of a list: fixed key order, so two spellings agree. */
export async function digestOptions(options: readonly FormFieldOption[]): Promise<string> {
  const canonical = JSON.stringify(options.map((o) => ({ value: o.value, label: o.label })));
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

/* ----------------------------------------------------------------- refresh --- */

export interface RefreshDeps {
  db: FolioDb;
  /** The host's `env`, handed to `load`. */
  env: unknown;
  /** The brand the list belongs to, or null on a deployment with none. */
  brand: BrandRef | null;
  source: ResolvedOptionSource;
  logger: FolioLogger;
  /** Injectable, as `purgeFormLayout`'s is. Undefined for every real host. */
  purgeCapability?: PurgeCapability;
  /** Enables the delayed second purge (`purgeSite`'s reason). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Injectable so a test does not wait 25 real seconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** One list to load: `settings` as stored, and `locale` `''` for the source locale. */
export interface RefreshTarget {
  settings: Readonly<Record<string, Json>> | undefined;
  locale: string;
}

export type RefreshResult =
  | { status: "leased" }
  | { status: "loaded"; options: FormFieldOption[]; changed: boolean }
  | { status: "failed"; failure: OptionFailure };

const TIMED_OUT = Symbol("option source timed out");

/**
 * Loads one list under the lease and stores it (decision 7).
 *
 * 1. **Claims the lease** in one statement. The upsert only updates a row whose
 *    `attempted_at` is older than `LEASE_MS`, and `returning` answers the row as it
 *    was stored, which is also how it learns whether a list was there before.
 *    No row back means another request holds it.
 * 2. **Calls `load`** with a signal that aborts at `timeoutMs`, and races the call
 *    against the same timer, so a `load` that ignores the signal is abandoned.
 * 3. **Screens** the answer (`screenItems`).
 * 4. **Writes** on success and purges `sourceTag` when the digest differs or no list
 *    was stored before. On failure it keeps the stored options, counts the failure
 *    and logs the thrown value. The row holds a category.
 */
export async function refreshList(
  deps: RefreshDeps,
  target: RefreshTarget,
  timeoutMs: number,
): Promise<RefreshResult> {
  const { db, source, logger } = deps;
  const now = deps.now ?? Date.now;
  const brand = brandKey(deps.brand);
  const id = source.id;
  const key = optionListKey(target.settings, target.locale);
  const at = now();

  const { results } = await db
    .prepare(
      `insert into option_lists (brand, source, key, attempted_at) values (?, ?, ?, ?)
       on conflict (brand, source, key) do update set attempted_at = ?
       where option_lists.attempted_at <= ?
       returning digest, options is not null as had`,
    )
    .bind(brand, id, key, at, at, at - LEASE_MS)
    .all<{ digest: string | null; had: number }>();
  const prior = results[0];
  if (!prior) return { status: "leased" };

  const where = [brand, id, key] as const;
  const fail = async (failure: OptionFailure, thrown?: unknown): Promise<RefreshResult> => {
    logger.error(
      `folio: option source "${id}" failed to load (${failure})`,
      ...(thrown === undefined ? [] : [thrown]),
    );
    await db
      .prepare(
        `update option_lists set failures = failures + 1, failure = ?
         where brand = ? and source = ? and key = ?`,
      )
      .bind(failure, ...where)
      .run();
    return { status: "failed", failure };
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: unknown;
  try {
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    const loading = Promise.resolve().then(() =>
      source.load(
        {
          settings: (target.settings ?? {}) as Readonly<Record<string, string | number | boolean>>,
          locale: target.locale === "" ? null : target.locale,
          brand: deps.brand,
          signal: controller.signal,
        },
        deps.env,
      ),
    );
    // A `load` abandoned at the timeout may still reject later: say nothing of it.
    loading.catch(() => {});
    const raced = await Promise.race([loading, timedOut]);
    if (raced === TIMED_OUT) return await fail("timeout");
    answer = raced;
  } catch (err) {
    return await fail("threw", err);
  } finally {
    clearTimeout(timer);
  }

  const screened = screenItems(answer);
  if (!screened.ok) return await fail(screened.failure);
  if (screened.truncated) {
    logger.warn(
      `folio: option source "${id}" returned more than ${MAX_SOURCED_OPTIONS} options; the rest are dropped`,
    );
  }

  const digest = await digestOptions(screened.options);
  await db
    .prepare(
      `update option_lists
       set options = ?, digest = ?, loaded_at = ?, failures = 0, failure = null
       where brand = ? and source = ? and key = ?`,
    )
    .bind(JSON.stringify(screened.options), digest, now(), ...where)
    .run();

  const changed = prior.had === 0 || prior.digest !== digest;
  if (changed) {
    await purgeOptionSource(id, deps.brand?.id ?? null, {
      ...(deps.purgeCapability ? { capability: deps.purgeCapability } : {}),
      logger,
      ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  }
  return { status: "loaded", options: screened.options, changed };
}

/**
 * Runs `refresh` over `targets`, at most `concurrency` in flight, all sharing one
 * deadline that is also each load's timeout (decision 7). A target not started by the
 * deadline is returned unattempted, to be left for the cron, the next submission or
 * the next save.
 */
export async function refreshKeys<T>(
  targets: readonly T[],
  refresh: (target: T, timeoutMs: number) => Promise<RefreshResult>,
  opts: { concurrency?: number; deadlineMs: number; now?: () => number },
): Promise<{ results: Array<{ target: T; result: RefreshResult }>; unattempted: T[] }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.deadlineMs;
  const results: Array<{ target: T; result: RefreshResult }> = [];
  const unattempted: T[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const at = next++;
      if (at >= targets.length) return;
      const target = targets[at]!;
      const remaining = deadline - now();
      if (remaining <= 0) {
        unattempted.push(target);
        continue;
      }
      let result: RefreshResult;
      try {
        result = await refresh(target, remaining);
      } catch {
        // `refreshList` records its own failures. A throw from outside it (the
        // database) must not take its neighbours down with it.
        result = { status: "failed", failure: "threw" };
      }
      results.push({ target, result });
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, targets.length)) }, worker),
  );
  return { results, unattempted };
}

/* ------------------------------------------------------------- save checks --- */

/** What `checkOptionSources` needs of a brand. */
export interface OptionSourceBrand {
  forms: ResolvedForms | null;
  types: readonly DocumentType[];
  schema: SchemaIndex;
}

/**
 * Refuses a saved question whose `optionsFrom` the brand cannot honour, naming the
 * question by label and slug (`PATCH {base}/api/forms/:id`): a `source` the brand does
 * not register, host settings with an undeclared key, a value of the wrong kind, a
 * `select` value outside its options or a missing required one (`default` fills an
 * absent one), a content `type` that is not a `page` or `record` type of the brand,
 * and a `where` or `order` field not indexed on that type's root block.
 *
 * Shape is `validateFormFields`'; whether the source exists is this. The list is not
 * checked, because it changes without a save (decision 12).
 */
export function checkOptionSources(fields: readonly FormField[], brand: OptionSourceBrand): void {
  for (const field of fields) {
    const from = field.optionsFrom;
    if (!from) continue;
    const name = `question "${field.label}" (${field.name})`;
    const refuse: (why: string) => never = (why) => {
      throw new FolioError("bad_request", `${name}: ${why}`);
    };
    if (from.source === CONTENT_SOURCE) {
      const settings = contentOptionSettings(from.settings);
      if (!settings) refuse("the content source needs a document type");
      const type = brand.types.find((t) => t.name === settings.type);
      if (!type || (type.kind !== "page" && type.kind !== "record")) {
        refuse(`"${settings.type}" is not a page or record type`);
      }
      const indexed = new Set(indexedFields(brand.schema, type.root).map(([n]) => n));
      for (const w of settings.where ?? []) {
        if (!indexed.has(w.field)) refuse(`"${w.field}" is not an indexed field of ${type.name}`);
      }
      const order = settings.order?.field;
      if (order !== undefined && !indexed.has(order) && !(order in BUILT_IN_ORDERS)) {
        refuse(`"${order}" is not an indexed field of ${type.name}`);
      }
      if (order === "relevance") refuse("a list cannot be ordered by relevance");
      continue;
    }

    const source = brand.forms?.sources.get(from.source);
    if (!source) refuse(`there is no option source "${from.source}"`);
    const declared = source.settings ?? {};
    const given = from.settings ?? {};
    for (const key of Object.keys(given)) {
      if (!(key in declared)) refuse(`"${key}" is not a setting of ${from.source}`);
    }
    for (const [key, def] of Object.entries(declared)) {
      const value = given[key] ?? def.default;
      if (value === undefined || value === null || value === "") {
        if (def.required) refuse(`${from.source} needs the setting "${key}"`);
        continue;
      }
      switch (def.kind) {
        case "text":
          if (typeof value !== "string") refuse(`"${key}" must be text`);
          break;
        case "number":
          if (typeof value !== "number" || !Number.isFinite(value))
            refuse(`"${key}" must be a number`);
          else if (
            (def.min !== undefined && value < def.min) ||
            (def.max !== undefined && value > def.max)
          ) {
            refuse(`"${key}" is out of range`);
          }
          break;
        case "boolean":
          if (typeof value !== "boolean") refuse(`"${key}" must be true or false`);
          break;
        case "select":
          if (typeof value !== "string" || !def.options.some((o) => o.value === value)) {
            refuse(`"${key}" is not one of its options`);
          }
          break;
      }
    }
  }
}
