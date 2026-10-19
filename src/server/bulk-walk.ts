/**
 * The batch walk `runAssetBulk` and `runDescribe` share: one batch of a captured
 * filter, one batch of an explicit id list, the cursor read, and the text a
 * failure travels as.
 *
 * Written twice until #36, and the two had drifted only in their scope argument
 * (a site id in one, a chain or `null` for "every scope" in the other) and in the
 * words of one log line. Both are parameters here: `scope` is the chain, `null`
 * meaning every scope, and a caller with a single site passes `[site]`.
 */
import type { AssetFilter } from "../core/assets";
import { type FilterSelection, readBulkCursor } from "../core/bulk";
import { type AssetRow, assetsFor, assetsMatching } from "./assets";
import type { FolioDb } from "./db";
import { FolioError, rethrow } from "./errors";
import type { FolioLogger } from "./types";

/**
 * One batch's worth of rows, and the three numbers the cursor needs.
 *
 * `null` in `rows` is an id an explicit selection named and D1 no longer has; a
 * filter batch produces none, because it reads what it found.
 */
export interface Batch {
  rows: (AssetRow | null)[];
  /** How much of the ceiling this batch used. Not `rows.length` for an explicit
   * list — see `idBatch` — and not the number of rows read, for a filter batch
   * that dropped exclusions. */
  consumed: number;
  /**
   * Whether the walk has reached the end of what it can read.
   *
   * Reported by the batch rather than inferred by the caller from
   * `consumed < limit`, because the two branches are asked for different limits
   * and only they know what they asked for.
   */
  exhausted: boolean;
  /** The id to resume after, or null when there is nothing left. */
  last: string | null;
}

/**
 * One batch of a captured filter.
 *
 * **The exclusions are applied here, in JavaScript, and not in the `where`.**
 * `storiesMatching` binds them into an `id not in (…)`; a selection's `exclude`
 * is up to 500 ids, which is five times `D1_BIND_CAP`, and no chunking rescues a
 * single statement. Dropping them from the batch after the read costs one
 * `Set.has` per row and cannot overrun anything.
 *
 * The price is that `consumed` and `read` come apart — a batch that read 25 rows
 * and dropped 3 acted on 22 — and the caller therefore ends the walk on a
 * short *read*. `last` is the last row **read**, not the last one kept, so the
 * cursor steps past an excluded row rather than reading it again forever.
 */
export async function filterBatch(
  db: FolioDb,
  selection: FilterSelection<AssetFilter>,
  after: string | null,
  limit: number,
  allowance: number,
  scope: readonly string[] | null,
): Promise<Batch> {
  const rows = await assetsMatching(db, selection.filter, { limit, after, scope });
  const excluded = new Set(selection.exclude ?? []);
  const kept = excluded.size === 0 ? rows : rows.filter((row) => !excluded.has(row.id));
  // Trimmed to the ceiling *after* the exclusions, which is the only order that
  // can be right: a batch that read 25 rows, dropped 20 and is allowed 3 acts on
  // 3. Trimming past the allowance loses nothing, because consuming the last of
  // it ends the job — `seen >= total` on the very next line of the caller.
  const acting = kept.length > allowance ? kept.slice(0, allowance) : kept;
  return {
    rows: acting,
    consumed: acting.length,
    exhausted: rows.length < limit,
    last: rows.at(-1)?.id ?? null,
  };
}

/**
 * One batch of an explicit id list.
 *
 * The client re-posts the same `ids` on every call, so the slice offset *is* the
 * cursor's counter — and the caller has already checked the id the cursor
 * stopped on against the list, because the two ways of absorbing a changed list
 * are skipping rows and doing some of them twice, and `delete` tolerates neither.
 *
 * `consumed` is the *slice* length rather than the row count: `assetsFor` omits
 * an id with no row behind it, so counting rows would read a stale id as the end
 * of the list. The gap is filled with `null`, which the loop reports per action.
 */
export async function idBatch(
  db: FolioDb,
  ids: readonly string[],
  seen: number,
  limit: number,
  scope: readonly string[] | null,
): Promise<Batch> {
  const slice = ids.slice(seen, seen + limit);
  const found = new Map((await assetsFor(db, slice, scope)).map((row) => [row.id, row]));
  return {
    rows: slice.map((id) => found.get(id) ?? null),
    consumed: slice.length,
    exhausted: slice.length < limit,
    last: slice.at(-1) ?? null,
  };
}

/** `core/bulk.ts`'s codec, with a refusal for a cursor that is not one of ours. */
export function readCursor(raw: string): { after: string; seen: number } {
  const at = readBulkCursor(raw);
  if (!at) throw new FolioError("bad_request", "Malformed pagination cursor");
  return at;
}

/**
 * Why one file could not be acted on, as text that may travel: a report is prose
 * rendered straight into a toast or panel, and anything `rethrow` declines to
 * translate is a bug or a platform failure that gets the generic message here and
 * the real one in the log, under `logged`.
 */
export function reasonOf(err: unknown, logged: string, logger: FolioLogger = console): string {
  try {
    rethrow(err);
  } catch (translated) {
    if (translated instanceof FolioError) return translated.message;
  }
  logger.error(logged, err);
  return "Something went wrong.";
}
