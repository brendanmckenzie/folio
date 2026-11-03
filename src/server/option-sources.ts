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
import { type FormField, type FormFieldOption, validateFormFields } from "../core/forms";
import type { LocaleConfig } from "../core/locales";
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
import type { BrandRuntime, FolioRuntime } from "./runtime";
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

type Loaded =
  | { ok: true; options: FormFieldOption[]; truncated: boolean }
  | { ok: false; failure: OptionFailure; thrown?: unknown };

/**
 * Calls the host's `load` for one list and screens the answer, **without touching the
 * store**: the part of `refreshList` the unsaved preview shares (decision 14). The
 * signal aborts at `timeoutMs` and the call is raced against the same timer, so a
 * `load` that ignores the signal is abandoned.
 */
async function loadScreened(
  deps: Pick<RefreshDeps, "env" | "brand" | "source">,
  target: RefreshTarget,
  timeoutMs: number,
): Promise<Loaded> {
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
      deps.source.load(
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
    if (raced === TIMED_OUT) return { ok: false, failure: "timeout" };
    answer = raced;
  } catch (err) {
    return { ok: false, failure: "threw", thrown: err };
  } finally {
    clearTimeout(timer);
  }
  const screened = screenItems(answer);
  return screened.ok ? screened : { ok: false, failure: screened.failure };
}

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
  const loaded = await loadScreened(deps, target, timeoutMs);
  if (!loaded.ok) {
    logger.error(
      `folio: option source "${id}" failed to load (${loaded.failure})`,
      ...(loaded.thrown === undefined ? [] : [loaded.thrown]),
    );
    await db
      .prepare(
        `update option_lists set failures = failures + 1, failure = ?
         where brand = ? and source = ? and key = ?`,
      )
      .bind(loaded.failure, ...where)
      .run();
    return { status: "failed", failure: loaded.failure };
  }
  const screened = loaded;
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

/* ------------------------------------------------- what forms reference --- */

/** One host list a saved form's question names: a `(brand, source, key)` row. */
export interface HostList {
  brand: BrandRuntime;
  source: ResolvedOptionSource;
  settings: Readonly<Record<string, Json>> | undefined;
  /** `''` for the source locale. */
  locale: string;
  ref: ListRef;
  /** `brand\u0000source\u0000key`: the cursor's order and the referenced set's key. */
  canonical: string;
}

/** The locale keys a source is loaded under: one, or one per declared locale when localised. */
export function hostLocales(
  source: { localised: boolean },
  locales: LocaleConfig | undefined,
): string[] {
  if (!source.localised) return [""];
  return [
    "",
    ...(locales?.available ?? []).map((l) => l.code).filter((c) => c !== locales?.default),
  ];
}

/**
 * The host-sourced lists `fields` reference within `brand`: every registered source x
 * its locales, deduplicated. `content` and an unregistered source name no row.
 */
export function hostListsOf(
  fields: readonly FormField[],
  brand: BrandRuntime,
  locales: LocaleConfig | undefined,
): HostList[] {
  const out = new Map<string, HostList>();
  for (const field of fields) {
    const from = field.optionsFrom;
    const source =
      from && from.source !== CONTENT_SOURCE ? brand.forms?.sources.get(from.source) : undefined;
    if (!from || !source) continue;
    for (const locale of hostLocales(source, locales)) {
      const ref = { source: source.id, key: optionListKey(from.settings, locale) };
      const canonical = `${brandKey(brand.brand)}\u0000${ref.source}\u0000${ref.key}`;
      out.set(canonical, { brand, source, settings: from.settings, locale, ref, canonical });
    }
  }
  return [...out.values()];
}

/**
 * **Every saved form's host lists, across every scope**: a whole-table read with no
 * chain, the cron's sanctioned exception to "every id-set read takes the chain"
 * (`form-option-sources.md` decision 7). Each form's brand is its own scope's
 * (`rt.forScope`), and a form of no brand names nothing. Sorted by `canonical`.
 *
 * It is also how the preview learns that a saved form references a key.
 */
export async function referencedLists(
  rt: FolioRuntime,
  env: unknown,
  db: FolioDb,
): Promise<HostList[]> {
  const { results } = await db
    .prepare(`select id, fields, site_id from forms where fields like '%"optionsFrom"%'`)
    .all<{ id: string; fields: string; site_id: string }>();
  if (results.length === 0) return [];
  const only = rt.brands.get(null);
  const registry = only ? undefined : await rt.sites?.registry(env);
  const out = new Map<string, HostList>();
  for (const row of results) {
    const brand = only ?? (registry ? rt.forScope(registry, row.site_id) : null);
    if (!brand) continue;
    let fields: FormField[] = [];
    try {
      fields = validateFormFields(JSON.parse(row.fields), { onInvalid: () => {} });
    } catch {
      continue;
    }
    for (const list of hostListsOf(fields, brand, rt.locales)) out.set(list.canonical, list);
  }
  return [...out.values()].sort((a, b) => (a.canonical < b.canonical ? -1 : 1));
}

/** The lists of `lists` whose row is missing, never loaded or past its ttl. */
export async function dueLists(
  db: FolioDb,
  lists: readonly HostList[],
  now: number,
): Promise<HostList[]> {
  const byBrand = new Map<string, HostList[]>();
  for (const list of lists) {
    const key = brandKey(list.brand.brand);
    byBrand.set(key, [...(byBrand.get(key) ?? []), list]);
  }
  const due: HostList[] = [];
  for (const [brand, group] of byBrand) {
    const rows = await readLists(
      db,
      brand,
      group.map((l) => l.ref),
    );
    for (const list of group) {
      if (listStatus(rows.get(listId(list.ref)), list.source.ttl, now) !== "fresh") due.push(list);
    }
  }
  return due;
}

export interface RefreshLists {
  db: FolioDb;
  env: unknown;
  logger: FolioLogger;
  purgeCapability?: PurgeCapability;
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => number;
}

/** Refreshes `lists` through `refreshKeys` (concurrency 4 unless told otherwise). */
export function refreshLists(
  deps: RefreshLists,
  lists: readonly HostList[],
  opts: { concurrency?: number; deadlineMs: number; loadMs?: number },
) {
  return refreshKeys(
    lists,
    (list, remaining) =>
      refreshList(
        {
          db: deps.db,
          env: deps.env,
          brand: list.brand.brand,
          source: list.source,
          logger: deps.logger,
          ...(deps.purgeCapability ? { purgeCapability: deps.purgeCapability } : {}),
          ...(deps.waitUntil ? { waitUntil: deps.waitUntil } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        { settings: list.settings, locale: list.locale },
        Math.min(remaining, opts.loadMs ?? remaining),
      ),
    {
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      deadlineMs: opts.deadlineMs,
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
}

/** Save time (decision 7): the saved fields' missing or stale lists, 4 in flight, one 25 s deadline. */
export async function refreshSavedSources(
  deps: RefreshLists,
  lists: readonly HostList[],
): Promise<void> {
  const due = await dueLists(deps.db, lists, (deps.now ?? Date.now)());
  if (due.length > 0) await refreshLists(deps, due, { concurrency: 4, deadlineMs: 25_000 });
}

export const DEFAULT_REFRESH_BATCH = 10;
export const MAX_REFRESH_BATCH = 50;

/** A row nobody has attempted for this long, and no form references, is pruned. */
export const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

export interface RefreshSourcesOptions {
  batch?: number;
  continueFrom?: string | null;
  now?: number;
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface RefreshSourcesReport {
  due: number;
  loaded: number;
  failed: number;
  unchanged: number;
  pruned: number;
  continueFrom: string | null;
}

/**
 * `folio.refreshOptionSources` (decision 7). The referenced set is read whole on every
 * call, so it is never one batch's: the cursor only decides which due lists *this* call
 * loads, and a prune on any call keeps every row any form still names.
 *
 * `due` counts the due lists after the cursor. A list whose lease another request held
 * counts as `unchanged`.
 */
export async function refreshOptionSources(
  rt: FolioRuntime,
  env: unknown,
  db: FolioDb,
  opts: RefreshSourcesOptions = {},
): Promise<RefreshSourcesReport> {
  const now = opts.now ?? Date.now();
  const batch = Math.max(
    1,
    Math.min(MAX_REFRESH_BATCH, Math.floor(opts.batch ?? DEFAULT_REFRESH_BATCH)),
  );
  const referenced = await referencedLists(rt, env, db);

  const after = opts.continueFrom ?? null;
  const pending = after === null ? referenced : referenced.filter((l) => l.canonical > after);
  const due = await dueLists(db, pending, now);
  const mine = due.slice(0, batch);

  let loaded = 0;
  let failed = 0;
  let unchanged = 0;
  if (mine.length > 0) {
    const { results } = await refreshLists(
      {
        db,
        env,
        logger: rt.logger,
        ...(rt.formPurgeCapability ? { purgeCapability: rt.formPurgeCapability } : {}),
        ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
        now: () => now,
      },
      mine,
      { concurrency: 4, deadlineMs: 600_000, loadMs: 10_000 },
    );
    for (const { result } of results) {
      if (result.status === "failed") failed++;
      else if (result.status === "loaded" && result.changed) loaded++;
      else unchanged++;
    }
  }

  const pruned = await pruneLists(db, new Set(referenced.map((l) => l.canonical)), now);
  return {
    due: due.length,
    loaded,
    failed,
    unchanged,
    pruned,
    continueFrom: due.length > mine.length ? mine[mine.length - 1]!.canonical : null,
  };
}

/** Deletes the rows past `PRUNE_AFTER_MS` that `referenced` (canonical keys) does not name. */
async function pruneLists(db: FolioDb, referenced: ReadonlySet<string>, now: number) {
  const { results } = await db
    .prepare(`select brand, source, key from option_lists where attempted_at < ?`)
    .bind(now - PRUNE_AFTER_MS)
    .all<{ brand: string; source: string; key: string }>();
  const stale = results.filter((r) => !referenced.has(`${r.brand}\u0000${r.source}\u0000${r.key}`));
  for (let i = 0; i < stale.length; i += 50) {
    await db.batch(
      stale
        .slice(i, i + 50)
        .map((r) =>
          db
            .prepare(`delete from option_lists where brand = ? and source = ? and key = ?`)
            .bind(r.brand, r.source, r.key),
        ),
    );
  }
  return stale.length;
}

/* ----------------------------------------------------------------- preview --- */

export interface HostPreview {
  options: FormFieldOption[] | null;
  status: ListStatus;
  loadedAt: number | null;
  failure?: OptionFailure;
  /** Whether the list was cut at `MAX_SOURCED_OPTIONS` (known only for a list just loaded). */
  truncated: boolean;
}

/**
 * The editor's preview of one host list (decision 14). A key a saved form references
 * is read and, when missing or stale, refreshed through the lease like any other, so
 * the preview warms the row the page will read. **A key nothing references is loaded
 * and stored nowhere**: it takes no lease, because the lease is a row, and a row is the
 * litter this route exists not to leave. Typing through settings therefore costs the
 * vendor one call per commit, which an `EDIT` role and the commit-only trigger bound.
 */
export async function previewHostList(
  deps: RefreshDeps,
  target: RefreshTarget,
  referenced: boolean,
  timeoutMs: number,
): Promise<HostPreview> {
  const brand = brandKey(deps.brand);
  const ref = { source: deps.source.id, key: optionListKey(target.settings, target.locale) };
  const now = (deps.now ?? Date.now)();
  const row = (await readLists(deps.db, brand, [ref])).get(listId(ref)) ?? null;
  const status = listStatus(row, deps.source.ttl, now);
  const stored = (): HostPreview => ({
    options: row?.options ?? null,
    status,
    loadedAt: row?.loadedAt ?? null,
    ...(row?.failure ? { failure: row.failure } : {}),
    truncated: false,
  });
  if (status === "fresh") return stored();

  if (referenced) {
    const result = await refreshList(deps, target, timeoutMs);
    if (result.status === "loaded") {
      return { options: result.options, status: "fresh", loadedAt: now, truncated: false };
    }
    if (result.status === "failed") return { ...stored(), failure: result.failure };
    return stored();
  }

  const loaded = await loadScreened(deps, target, timeoutMs);
  if (loaded.ok) {
    return { options: loaded.options, status: "fresh", loadedAt: now, truncated: loaded.truncated };
  }
  deps.logger.error(
    `folio: option source "${deps.source.id}" failed to load (${loaded.failure})`,
    ...(loaded.thrown === undefined ? [] : [loaded.thrown]),
  );
  return { ...stored(), failure: loaded.failure };
}
