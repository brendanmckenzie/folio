/**
 * Visitor access for media-library files
 * (`../../docs/specs/platform/asset-access.md` decisions 2, 3, 4, 10 and 11).
 *
 * **Every write that changes a file's `folder_id` or `access`, or a folder's
 * `access` or `parent_id`, goes through the statements here.** The route reads
 * one denormalised column, `assets.effective_access`, so the cost of inheritance
 * is paid at write time and this module is the only place that pays it. A write
 * that skipped it would leave the column stale, and a stale column on a file that
 * should be gated is the file served to everyone.
 *
 * **Every statement is set-based and reads *own* values**, never another row's
 * effective value computed earlier in JavaScript, so two concurrent edits
 * converge whichever commits first (decision 3). The folder statements bind a
 * fixed number of parameters whatever the size of the subtree
 * (`asset-folders.ts`'s rule against caller-sized bind lists).
 *
 * **A value is JSON text** (decision 2), so the gate field's primitive survives
 * the round trip and `isUngated`'s strict equality is the only comparison there
 * is. Null *stored* is "inherit"; null *effective* is public.
 */
import type { Json } from "../core/doc";
import { assetTag, storyTag } from "../core/cache-tags";
import { isUngated } from "../core/gate";
import { bindChunks, type FolioDb } from "./db";
import { FolioError } from "./errors";
import { subtreeWhere } from "./asset-folders";
import {
  drainAssetPurges,
  MAX_PURGE_CALLS,
  MAX_TAGS_PER_PURGE,
  type PurgeCapability,
  type PurgeIssued,
  pendingAssetPurges,
  platformPurge,
  purgeAssetsNow,
  SITE_PURGE_DELAY_MS,
} from "./cache-purge";
import { assetReferences } from "./content-index";
import type { HookRunner } from "./hooks";
import type { AssetAccessDomain } from "./gate";
import type { FolioLogger } from "./types";

/** A text value's ceiling, so an access value cannot become a place to store prose. */
export const MAX_ACCESS_TEXT = 200;

/** How long a queued edge purge waits before it may be retired (decision 10). */
export const PURGE_SETTLE_MS = 10 * 60 * 1000;

/** The most transitions a hook payload carries (decision 11); a write reads one more to know to truncate. */
export const MAX_TRANSITIONS = 500;

/* ----------------------------------------------------------------- values --- */

export function encodeAccess(value: Json): string {
  return JSON.stringify(value);
}

/** Stored values that failed to parse, so the log line is once per isolate per value. */
const unreadable = new Set<string>();

/**
 * A stored value, decoded. `null` is "no value" (inherit, or public when it is
 * the effective column). **An unreadable value decodes as `undefined`**, which
 * every reader treats as gated (fail closed, logged once): the only way to get
 * one is a hand edit, and a hand edit that fails open serves a file somebody
 * tried to protect.
 */
export function decodeAccess(stored: string | null, logger?: FolioLogger): Json | null | undefined {
  if (stored === null) return null;
  try {
    return JSON.parse(stored) as Json;
  } catch {
    if (!unreadable.has(stored)) {
      unreadable.add(stored);
      (logger ?? console).error(
        `folio: unreadable asset access value ${JSON.stringify(stored)}; treating the file as gated`,
      );
    }
    return undefined;
  }
}

/**
 * Is a stored *effective* value public: no value at all, or the gate's own
 * public value (`isUngated`, strict). Unreadable is not public.
 */
export function isPublicEffective(
  stored: string | null,
  publicValue: string | number | boolean,
  logger?: FolioLogger,
): boolean {
  if (stored === null) return true;
  const value = decodeAccess(stored, logger);
  return value !== undefined && isUngated(value, publicValue);
}

function allowed(domain: AssetAccessDomain): string {
  return domain.options
    ? `one of ${domain.options.map((o) => JSON.stringify(o.value)).join(", ")}`
    : `a ${domain.primitive}`;
}

/**
 * A value off a request body, checked against the brand's gate field
 * (decision 11): the field's primitive, one of the options every declaring
 * `select` lists, and a text value of at most 200 characters. Answers the value
 * (unchanged) so a caller can encode what it validated.
 */
export function validateAccessValue(domain: AssetAccessDomain, raw: unknown): Json {
  if (typeof raw !== domain.primitive || (typeof raw === "number" && !Number.isFinite(raw))) {
    throw new FolioError("bad_request", `access must be ${allowed(domain)}`);
  }
  const value = raw as string | number | boolean;
  if (typeof value === "string" && value.length > MAX_ACCESS_TEXT) {
    throw new FolioError("bad_request", `access must be ${MAX_ACCESS_TEXT} characters or fewer`);
  }
  if (domain.options && !domain.options.some((o) => o.value === value)) {
    throw new FolioError("bad_request", `access must be ${allowed(domain)}`);
  }
  return value;
}

/** `?access=` is a string on the wire, typed by the gate field's primitive. */
export function parseAccessQuery(domain: AssetAccessDomain, raw: string): Json {
  if (domain.primitive === "number") {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    return validateAccessValue(domain, n);
  }
  if (domain.primitive === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new FolioError("bad_request", "access must be true or false");
    }
    return validateAccessValue(domain, raw === "true");
  }
  return validateAccessValue(domain, raw);
}

/* ----------------------------------------------------------- transitions --- */

/** One file whose effective value changed. `from` and `to` are decoded; null is public. */
export interface AccessTransition {
  id: string;
  key: string;
  scope: string;
  from: Json | null;
  to: Json | null;
}

/**
 * What a write needs to run asset gating, and where it leaves what it did.
 * **Absent means the deployment does not gate files**: the write still keeps
 * `effective_access` right (a host that removes `allowsAsset` and re-adds it must
 * not find it stale) but queues no purge and reads nothing for a hook.
 */
export interface AssetGating {
  domain: AssetAccessDomain;
  /** Filled by the write: at most `MAX_TRANSITIONS`. */
  transitions: AccessTransition[];
  /** More than `MAX_TRANSITIONS` changed; `transitions` holds the first. */
  truncated: boolean;
}

export function newGating(domain: AssetAccessDomain): AssetGating {
  return { domain, transitions: [], truncated: false };
}

interface EffectiveRow {
  id: string;
  key: string;
  site_id: string;
  effective_access: string | null;
}

/** The effective values of the assets a statement selects, at most 501 rows. */
async function readEffective(
  db: FolioDb,
  where: string,
  binds: readonly unknown[],
): Promise<EffectiveRow[]> {
  const { results } = await db
    .prepare(
      `select id, key, site_id, effective_access from assets where ${where} order by id limit ${MAX_TRANSITIONS + 1}`,
    )
    .bind(...binds)
    .all<EffectiveRow>();
  return results;
}

/** The same rows after the write, by id (at most 500, so one chunk of one bind each). */
async function readEffectiveByIds(
  db: FolioDb,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const after = new Map<string, string | null>();
  for (const chunk of bindChunks(ids, 1)) {
    const { results } = await db
      .prepare(
        `select id, effective_access from assets where id in (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...chunk)
      .all<{ id: string; effective_access: string | null }>();
    for (const row of results) after.set(row.id, row.effective_access);
  }
  return after;
}

/**
 * Runs `write` (the `db.batch` that changes the values) and records what changed
 * on `gating`: a read of the assets `where` selects before, the same ids after.
 * With no `gating` it only runs `write`, so a deployment that does not gate files
 * pays for nothing.
 */
export async function trackTransitions<T>(
  db: FolioDb,
  gating: AssetGating | null | undefined,
  selector: { where: string; binds: readonly unknown[] },
  write: () => Promise<T>,
  logger?: FolioLogger,
): Promise<T> {
  if (!gating) return write();
  const before = await readEffective(db, selector.where, selector.binds);
  const result = await write();
  const room = MAX_TRANSITIONS - gating.transitions.length;
  const watched = before.slice(0, Math.max(room, 0));
  if (before.length > watched.length) gating.truncated = true;
  const after = await readEffectiveByIds(
    db,
    watched.map((row) => row.id),
  );
  for (const row of watched) {
    const next = after.get(row.id);
    // Deleted or moved out of the watched set mid-write: not a transition.
    if (next === undefined || next === row.effective_access) continue;
    gating.transitions.push({
      id: row.id,
      key: row.key,
      scope: row.site_id,
      from: decodeAccess(row.effective_access, logger) ?? null,
      to: decodeAccess(next, logger) ?? null,
    });
  }
  return result;
}

/* ------------------------------------------------------------ statements --- */

/**
 * A folder's effective value, and so its subtree's, from the **own** values along
 * each path (decision 3). One statement over the changed or moved folder's
 * subtree, fixed binds; the correlated subquery scans the site's folders once per
 * subtree row, and folders number in the hundreds and are written by hand.
 *
 * `path` is the folder's path **as it now stands**: a rename or move runs this
 * after the rewrite of the paths it derives from.
 */
export function folderEffectiveStatement(db: FolioDb, site: string, path: string) {
  const range = subtreeWhere("path", path);
  return db
    .prepare(
      `update asset_folders
          set effective_access = (
            select a.access from asset_folders a
             where a.site_id = asset_folders.site_id and a.access is not null
               and (a.path = asset_folders.path
                    or substr(asset_folders.path, 1, length(a.path) + 1) = a.path || '/')
             order by length(a.path) desc limit 1)
        where site_id = ? and ${range.sql}`,
    )
    .bind(site, ...range.binds);
}

/**
 * The effective value an asset would have in the folder it is filed in, as SQL
 * over an alias: its own value, else its folder's.
 */
const WOULD_BE = `coalesce(a.access, (select f.effective_access from asset_folders f where f.id = a.folder_id))`;

/**
 * Queue an edge purge for every asset a selector names that is public as stored
 * and would be gated by the folder statements that ran before this one (decision
 * 10). **Read the pre-image from `assets.effective_access`, which no statement
 * has yet touched, and the post-image from the folders, which one has**: that is
 * what makes "was public, becomes gated" a single set-based statement of fixed
 * size, complete for a folder of forty thousand files where a JavaScript read
 * capped at 501 rows could not be.
 *
 * Must run **after** the statements that set the new `access` / folder and
 * **before** the asset recompute that overwrites `effective_access`.
 */
function queueStatement(
  db: FolioDb,
  publicValue: string | number | boolean,
  now: number,
  selector: { where: string; binds: readonly unknown[] },
) {
  const pub = encodeAccess(publicValue);
  return db
    .prepare(
      `insert into asset_purges (asset_id, site_id, queued_at, settle_at)
       select a.id, a.site_id, ?, ?
         from assets a
        where ${selector.where}
          and (a.effective_access is null or a.effective_access = ?)
          and ${WOULD_BE} is not null and ${WOULD_BE} <> ?
       on conflict (asset_id) do update
          set queued_at = excluded.queued_at, settle_at = excluded.settle_at, purged_at = null`,
    )
    .bind(now, now + PURGE_SETTLE_MS, ...selector.binds, pub, pub);
}

/** Selects the assets filed under a folder subtree, aliased `a`. */
function underSubtree(site: string, path: string): { where: string; binds: unknown[] } {
  const range = subtreeWhere("path", path);
  return {
    where: `a.site_id = ? and a.folder_id in (select id from asset_folders where site_id = ? and ${range.sql})`,
    binds: [site, site, ...range.binds],
  };
}

/** `trackTransitions`' selector for the same set, unaliased. */
export function subtreeSelector(site: string, path: string) {
  const range = subtreeWhere("path", path);
  return {
    where: `site_id = ? and folder_id in (select id from asset_folders where site_id = ? and ${range.sql})`,
    binds: [site, site, ...range.binds],
  };
}

/**
 * Everything a folder write owes after its own columns are written: the folder's
 * and its subtree's effective values (decision 3's first statement), the purge
 * queue for files that go from public to gated, and the effective value of every
 * asset filed under the subtree (the second statement), in that order. Queued only
 * when `publicValue` is given, which is when the deployment gates files.
 */
export function folderRecomputeStatements(
  db: FolioDb,
  site: string,
  path: string,
  gate: { public: string | number | boolean; now: number } | null = null,
) {
  const range = subtreeWhere("path", path);
  const under = underSubtree(site, path);
  return [
    folderEffectiveStatement(db, site, path),
    ...(gate ? [queueStatement(db, gate.public, gate.now, under)] : []),
    db
      .prepare(
        `update assets set effective_access = coalesce(access, (
           select f.effective_access from asset_folders f where f.id = assets.folder_id))
         where site_id = ? and folder_id in (select id from asset_folders where site_id = ? and ${range.sql})`,
      )
      .bind(site, site, ...range.binds),
  ];
}

/**
 * One asset's effective value after its own value or folder changed (decision 3's
 * third bullet): a statement **after** the one that set `folder_id`, binding the
 * destination folder id explicitly. SQLite evaluates every `set` expression
 * against the row as it was before the statement, so folding this into
 * `updateAsset`'s single `update` would read the folder the file is leaving.
 */
export function assetRecomputeStatements(
  db: FolioDb,
  id: string,
  site: string,
  folderId: string | null,
  gate: { public: string | number | boolean; now: number } | null = null,
) {
  return [
    ...(gate
      ? [
          queueStatement(db, gate.public, gate.now, {
            where: "a.id = ? and a.site_id = ?",
            binds: [id, site],
          }),
        ]
      : []),
    db
      .prepare(
        `update assets set effective_access = coalesce(access, (
           select effective_access from asset_folders where id = ?))
         where id = ? and site_id = ?`,
      )
      .bind(folderId, id, site),
  ];
}

/* ------------------------------------------------------------ the folder --- */

/**
 * `deleteFolder`'s two materialising statements (decision 4), which run before
 * the re-parent and the unfile: every file filed directly in the folder, and every
 * direct child folder, that inherits a value takes it as its own. Every effective
 * value is then unchanged by the delete by construction, and no purge is needed.
 */
export function materialiseBeforeDeleteStatements(db: FolioDb, id: string, site: string) {
  return [
    db
      .prepare(
        `update assets set access = effective_access
          where folder_id = ? and site_id = ? and access is null and effective_access is not null`,
      )
      .bind(id, site),
    db
      .prepare(
        `update asset_folders set access = effective_access
          where parent_id = ? and site_id = ? and access is null and effective_access is not null`,
      )
      .bind(id, site),
  ];
}

/* -------------------------------------------------------------- the route --- */

/** What the asset route reads for one key (decision 3): one statement, on the unique key's index. */
export interface AssetAccessRow {
  id: string;
  siteId: string;
  folderId: string | null;
  filename: string;
  contentType: string;
  size: number;
  access: string | null;
  effectiveAccess: string | null;
}

export async function assetAccessByKey(db: FolioDb, key: string): Promise<AssetAccessRow | null> {
  return db
    .prepare(
      `select id, site_id as siteId, folder_id as folderId, filename, content_type as contentType,
              size, access, effective_access as effectiveAccess
         from assets where key = ?`,
    )
    .bind(key)
    .first<AssetAccessRow>();
}

/**
 * The stored effective value of every named key that is gated (chunked), for
 * resolve, the checks and the inspector (decision 12). Absent keys, and keys
 * whose effective value is null, are simply not in the map. The caller applies
 * `isUngated`.
 */
export async function gatedValues(
  db: FolioDb,
  keys: readonly string[],
): Promise<Map<string, { site: string; value: string }>> {
  const out = new Map<string, { site: string; value: string }>();
  const wanted = [...new Set(keys)];
  const pages = await Promise.all(
    bindChunks(wanted, 1).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select key, site_id as site, effective_access as value from assets
            where key in (${chunk.map(() => "?").join(", ")}) and effective_access is not null`,
        )
        .bind(...chunk)
        .all<{ key: string; site: string; value: string }>();
      return results;
    }),
  );
  for (const row of pages.flat()) out.set(row.key, { site: row.site, value: row.value });
  return out;
}

/**
 * The scope that owns each gated file a resolution drew a lock for, kept beside the
 * resolution rather than in it (decision 12: `site_id` "is kept on the reader, not the
 * resolution"), so the serialised payload carries nothing a visitor has no use for.
 * Keyed by the resolution object `resolve()` returned, which `pageOf` hands on whole.
 */
const gatedScopes = new WeakMap<object, ReadonlyMap<string, string>>();

export function rememberGatedScopes(resolution: object, scopes: ReadonlyMap<string, string>): void {
  gatedScopes.set(resolution, scopes);
}

/** The owning scope of a gated key in this resolution, or undefined when it is not one. */
export function gatedScopeOf(resolution: object, key: string): string | undefined {
  return gatedScopes.get(resolution)?.get(key);
}

/* ------------------------------------------------------------- presenting --- */

/**
 * A row, plus the access fields a gated scope's routes answer (decision 13).
 * `COLS` does not change: a route that forgets this answers a row without them,
 * which is a missing feature on one screen rather than a changed contract
 * everywhere.
 */
export type WithAccess<T> = T & { access: Json | null; effectiveAccess: Json | null };

/**
 * `presentAssetRows`: with no `domain` the rows come back **untouched and nothing
 * is read**, which is what keeps a deployment that does not gate files byte for
 * byte what it was. With one, a single `select … where id in (…)` (chunked) and a
 * merge. `access` is the own value (null inherits), `effectiveAccess` the one the
 * route reads (null is public); an unreadable stored value is presented as the
 * raw string, so an editor can see and correct it.
 */
export async function presentAssetRows<T extends { id: string }>(
  db: FolioDb,
  rows: readonly T[],
  domain: AssetAccessDomain | null,
): Promise<readonly T[] | WithAccess<T>[]> {
  if (!domain || rows.length === 0) return rows;
  const stored = new Map<string, { access: string | null; effective: string | null }>();
  await Promise.all(
    bindChunks(
      rows.map((r) => r.id),
      1,
    ).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select id, access, effective_access as effective from assets
            where id in (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(...chunk)
        .all<{ id: string; access: string | null; effective: string | null }>();
      for (const row of results) stored.set(row.id, row);
    }),
  );
  return rows.map((row) => {
    const own = stored.get(row.id);
    return {
      ...row,
      access: present(own?.access ?? null),
      effectiveAccess: present(own?.effective ?? null),
    };
  });
}

function present(stored: string | null): Json | null {
  if (stored === null) return null;
  try {
    return JSON.parse(stored) as Json;
  } catch {
    return stored;
  }
}

/* ----------------------------------------------------------- after a write --- */

/** What `afterAccessChange` needs of the request that made the write. */
export interface AccessChangeContext<Env = unknown> {
  db: FolioDb;
  /** Absent resolves to the platform's; a test injects one (`FolioRuntime.assetPurgeCapability`). */
  capability?: PurgeCapability;
  logger: FolioLogger;
  hooks: HookRunner<Env>;
  waitUntil: (p: Promise<unknown>) => void;
  /** The scope the write was made in: whose pending count the response reports. */
  site: string;
  actor: string | null;
}

export interface AfterAccessChange {
  /** The purge the drain issued, or null when it issued none. */
  purge: PurgeIssued | null;
  /** Files in this scope whose purge is still owed. */
  pending: number;
}

/** The most `story:` tags a gating spends; above it the lock on those pages heals at its next purge. */
const MAX_STORY_TAGS = MAX_TAGS_PER_PURGE * MAX_PURGE_CALLS;

/**
 * Everything an access-changing write owes **after its batch has committed**
 * (decision 10): the drain of the purge queue (awaited, so the response reports the
 * outcome, and never throwing into the write), the same drain again
 * `SITE_PURGE_DELAY_MS` later under `waitUntil`, the best-effort `story:<id>` tags
 * for pages that link a newly gated file and `asset:<id>` for a file whose lock
 * changed without becoming gated, and the `assetAccessChanged` hook.
 *
 * `opts.final` false is a non-final bulk batch: no drain, so a forty-batch walk
 * spends the purge budget twice rather than eighty times.
 */
export async function afterAccessChange<Env>(
  ctx: AccessChangeContext<Env>,
  gating: AssetGating,
  opts: {
    final?: boolean;
    now?: number;
    /** Injectable so a test does not wait 25 real seconds. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AfterAccessChange> {
  const capability = ctx.capability ?? platformPurge;
  const now = opts.now ?? Date.now();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let purge: PurgeIssued | null = null;
  try {
    if (opts.final !== false) {
      const drained = await drainAssetPurges(ctx.db, capability, now, ctx.logger);
      purge = drained.purge;
      // Nothing issued means nothing to repeat: no capability, or an empty queue.
      if (drained.purge !== null) {
        ctx.waitUntil(
          sleep(SITE_PURGE_DELAY_MS).then(() =>
            drainAssetPurges(ctx.db, capability, Date.now(), ctx.logger, { all: true }),
          ),
        );
      }
    }
    await purgeLockTags(ctx, gating, capability);
  } catch (err) {
    ctx.logger.error("folio: asset access follow-up failed", err);
  }
  let pending = 0;
  try {
    pending = (await pendingAssetPurges(ctx.db, ctx.site)).pending;
  } catch (err) {
    ctx.logger.error("folio: could not count owed asset purges", err);
  }
  if (gating.transitions.length > 0) {
    await ctx.hooks.run("assetAccessChanged", {
      assets: gating.transitions,
      truncated: gating.truncated,
      pending,
      actor: ctx.actor,
      site: ctx.site,
      ...(purge ? { purge } : {}),
    });
  }
  return { purge, pending };
}

async function purgeLockTags<Env>(
  ctx: AccessChangeContext<Env>,
  gating: AssetGating,
  capability: PurgeCapability,
): Promise<void> {
  // Over the cap the transitions are a prefix, and walking references for each is the
  // unbounded read decision 10 declines to make; the drain's own tags still cover the files.
  if (gating.truncated || gating.transitions.length === 0) return;
  const publicValue = gating.domain.public;
  const toGated = (t: AccessTransition) => !isPublicEffective(encodeOrNull(t.to), publicValue);
  const wasPublic = (t: AccessTransition) => isPublicEffective(encodeOrNull(t.from), publicValue);

  // A gated-to-public or gated-to-gated change: no gated response was ever stored,
  // only the cosmetic lock is at stake, so one best-effort purge of the file's tag.
  const lockOnly = gating.transitions.filter((t) => !(wasPublic(t) && toGated(t)));
  // Public to gated: pages that link the file and so far drew no lock.
  const newlyGated = gating.transitions.filter((t) => wasPublic(t) && toGated(t));

  const stories = new Set<string>();
  for (const t of newlyGated) {
    for (const id of await assetReferences(ctx.db, t.key)) stories.add(id);
    if (stories.size > MAX_STORY_TAGS)
      return void ctx.logger.warn(
        "folio: too many pages link the newly gated files; their locks refresh at their next purge",
      );
  }
  const tags = [...lockOnly.map((t) => assetTag(t.id)), ...[...stories].map((id) => storyTag(id))];
  if (tags.length > MAX_STORY_TAGS) return;
  await purgeAssetsNow(capability, tags, ctx.logger);
}

function encodeOrNull(value: Json | null): string | null {
  return value === null ? null : encodeAccess(value);
}
