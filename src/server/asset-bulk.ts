/**
 * Bulk writes over a selection of library rows
 * (`../../docs/specs/content-model/media-library.md` decision 6 and phase 5).
 *
 * Four actions — tag, untag, move, delete — over the same two selection shapes
 * `runBulk` walks: the ids somebody ticked, or **a flag plus a captured filter
 * plus the count they were shown**. The second is why this exists at all: with
 * server-side paging, "select all 4,812 matching" must not mean fetching 4,812
 * rows to loop over them, so no ids are materialised anywhere.
 *
 * **A second runner rather than a generic one**, and that is decision 6's line.
 * `runBulk` is story-shaped to its bones — `BulkDeps extends PublishDeps,
 * DocumentDeps`, five actions that all read the story table, `countStories` as
 * the guard's reader. Generifying *it* would turn `BulkDeps` into a union of two
 * unrelated dependency bags for the sake of a `for` loop. What the two share is
 * `core/bulk.ts`: the selection shapes, the report shapes, the cursor codec and
 * the rules written on them. Nothing here re-states one.
 *
 * The four properties that carry it are `runBulk`'s, and each is load-bearing
 * here for the same reason it is there:
 *
 * **The count is the guard, checked once at the start**, and it is also the
 * job's ceiling — a run touches at most `expected - exclude.length` rows however
 * many batches it takes. A refusal is answered as a *value*, not thrown.
 *
 * **Execution is a batched job, not a request.** One call does up to
 * `opts.batch` rows and answers `continueFrom`; the caller re-calls until it is
 * null.
 *
 * **Every row is its own `try`.** A run that died on one file and skipped the
 * rest is the bug to avoid — and this is the phase where it would be worst,
 * because `delete` is not undoable and a half-finished batch is neither done nor
 * undone.
 *
 * **The delete reports what it is about to break.** `usedOnPublished` is one
 * aggregate over the whole selection (decision 15) rather than `assetUsage` per
 * row, which for four hundred files would be four hundred round trips and an
 * answer nobody can read. It **warns and proceeds**, exactly as the single-asset
 * delete does: a broken image reference degrades visibly and fixably, and a
 * delete that refuses leaves an editor unable to remove a file at all.
 */
import type { AssetBulkAction, AssetFilter, AssetTag } from '../core/assets'
import {
  type BulkFailure,
  type BulkRefusal,
  type BulkReport,
  type BulkSelection,
  type FilterSelection,
  readBulkCursor,
  writeBulkCursor,
} from '../core/bulk'
import { folderById } from './asset-folders'
import { tagsByIds } from './asset-tags'
import {
  type AssetRow,
  assetFilterSql,
  assetsFor,
  assetsMatching,
  countAssets,
  deleteAsset,
} from './assets'
import { bindChunks, type FolioDb } from './db'
import { FolioError, rethrow } from './errors'
import { whereOf } from './keyset'
import type { FolioLogger } from './types'

/** How many rows one call acts on before handing back a cursor. The same 25
 * `runBulk` defaults to, and for the same reason: `delete` issues a D1 batch and
 * an R2 delete per row. */
export const DEFAULT_ASSET_BULK_BATCH = 25

/** Ceiling on `batch`, so a caller cannot ask for a run that outlives the
 * request. `MAX_BULK_BATCH`'s 200, shared with `migrate`, `reindex` and the
 * schedule sweep. */
export const MAX_ASSET_BULK_BATCH = 200

/**
 * What a bulk run needs. Two bindings and no runtime: nothing here resolves a
 * document, fires a hook or purges a cache, because none of the four actions
 * changes what a published page renders — filing is metadata (decision 1), and a
 * delete leaves the documents alone by design (`deleteAsset`'s own header).
 *
 * `media` is optional because three of the four actions never reach a bucket. A
 * `delete` without one refuses rather than pretending, matching
 * `DELETE {base}/api/assets/:id`.
 *
 * `logger` is optional and, unlike `bulk.ts`'s `BulkDeps`, gets no free ride from
 * `rt.publishDeps`: there is no publish workflow behind any of the four actions,
 * so `routes/assets.ts` builds this object from bindings and names `rt.logger`
 * explicitly at all three call sites. Optional rather than required because
 * `reasonOf`'s `console` fallback is the pre-`logger` behaviour and a test
 * building deps by hand should not have to supply a sink to get it.
 */
export interface AssetBulkDeps {
  db: FolioDb
  media?: R2Bucket | undefined
  logger?: FolioLogger
}

export interface AssetBulkOptions {
  batch?: number
  /** The previous call's `continueFrom`. An opaque `(id, seen)` pair, not an id. */
  continueFrom?: string | null
  /** Computes everything, writes nothing, and answers the same shape — which is
   * how the delete confirmation reads `usedOnPublished` before it acts. */
  dryRun?: boolean
  /** `tag` and `untag`: which tags to add or remove. Required for both, and
   * every id is checked against a real tag before a row is touched. */
  tagIds?: readonly string[]
  /**
   * `move`'s destination. `null` is *Unfiled*, which is a real destination
   * rather than an absence — so this is read with `in` rather than for
   * truthiness, and a `move` that omits it entirely is refused.
   */
  folderId?: string | null
}

/**
 * `BulkReport` plus the one field decision 15 adds.
 *
 * `usedOnPublished` is **present on a delete's first call only** — the call that
 * a confirmation dialog makes with `dryRun: true`. It counts the selected assets
 * carrying at least one published reference *before the run starts*, so a resumed
 * batch cannot answer it honestly: by then the job has already deleted some of
 * the rows it would be counting. Absent rather than stale, and absent rather than
 * zero, because zero is a claim.
 */
export interface AssetBulkReport extends BulkReport<AssetBulkAction> {
  usedOnPublished?: number
}

export type AssetBulkOutcome = AssetBulkReport | BulkRefusal

/**
 * One batch of a bulk write over the library.
 *
 * Sequential rather than `Promise.all`, matching `runBulk`: the failure report is
 * deterministic that way, which is what lets a test assert it, and a delete fires
 * a D1 batch plus an R2 delete per row — twenty-five of those in parallel is
 * twenty-five R2 operations racing for one invocation's subrequest budget.
 */
export async function runAssetBulk(
  deps: AssetBulkDeps,
  action: AssetBulkAction,
  selection: BulkSelection<AssetFilter>,
  opts: AssetBulkOptions = {},
): Promise<AssetBulkOutcome> {
  const { db } = deps
  const dryRun = opts.dryRun === true
  const batch = Math.min(
    Math.max(Math.trunc(opts.batch ?? DEFAULT_ASSET_BULK_BATCH), 1),
    MAX_ASSET_BULK_BATCH,
  )
  const resume = opts.continueFrom ? readCursor(opts.continueFrom) : null

  // Every argument is checked **once, before the walk starts**, and refused as a
  // request error rather than as N identical per-row failures. An unknown tag id
  // in a bulk tag is a client bug, not twenty-five separate accidents, and a
  // report naming it twenty-five times is a report nobody reads.
  const tags = action === 'tag' || action === 'untag' ? await requiredTags(db, opts.tagIds) : []
  if (action === 'move') {
    if (!('folderId' in opts)) {
      throw new FolioError('bad_request', 'A bulk move needs a destination folder, or null')
    }
    if (opts.folderId && !(await folderById(db, opts.folderId))) {
      throw new FolioError('bad_request', 'Unknown folder')
    }
  }
  if (action === 'delete' && !deps.media) {
    throw new FolioError('unsupported', 'No media bucket is configured')
  }
  // Before the ceiling check below, deliberately: a cursor that disagrees with
  // the list it was issued against is a client bug whatever the arithmetic says,
  // and an exhausted allowance would otherwise report a placid "nothing left to
  // do" for it.
  if (!selection.all && resume !== null && selection.ids[resume.seen - 1] !== resume.after) {
    throw new FolioError(
      'bad_request',
      'The selection changed between batches. Start the operation again.',
    )
  }

  const total = selection.all
    ? Math.max(selection.expected - (selection.exclude?.length ?? 0), 0)
    : selection.ids.length
  const seen = resume?.seen ?? 0

  // The guard, once, at the start of the job — never on a resumed call. Decision
  // 3 of `bulk-writes.md` records what re-checking every batch would cost: a long
  // job on a site with live editors would become un-completable, and the guard
  // confirms *intent* rather than freezing the table.
  if (selection.all && resume === null) {
    const actual = await countAssets(db, selection.filter)
    if (actual !== selection.expected) {
      return { refused: 'count', expected: selection.expected, actual }
    }
  }

  const report: AssetBulkReport = {
    action,
    done: 0,
    failed: [],
    total,
    seen,
    continueFrom: null,
    dryRun,
  }
  // The one aggregate, before anything is written and only on the first call.
  // See `AssetBulkReport.usedOnPublished`.
  if (action === 'delete' && resume === null) {
    report.usedOnPublished = await countUsedOnPublished(db, selection)
  }

  // The ceiling. A job that has consumed everything it agreed to is finished even
  // if the filter still matches rows — those are files nobody agreed to touch.
  const allowance = total - seen
  if (allowance <= 0) return report

  // **The two branches are asked for different amounts, deliberately.** An
  // explicit id list consumes the ceiling one row per id, so it is clamped to the
  // allowance. A filter batch is not: its exclusions are dropped after the read
  // (see `filterBatch`), and clamping the *read* to the allowance is how "select
  // all 120, tick off 117" becomes a walk that reads three rows per request and
  // needs forty of them. It reads a full batch and acts on at most `allowance` of
  // what survives.
  const { rows, consumed, exhausted, last } = selection.all
    ? await filterBatch(db, selection, resume?.after ?? null, batch, allowance)
    : await idBatch(db, selection.ids, seen, Math.min(batch, allowance))

  for (const [at, row] of rows.entries()) {
    if (row === null) {
      // An id in an explicit selection with no row behind it. A delete has
      // already got what it asked for; the other three genuinely cannot act.
      if (action === 'delete') report.done++
      else
        report.failed.push({ id: idAt(selection, seen + at), title: '', message: 'No such file' })
      continue
    }
    if (dryRun) {
      // Tallied as if it had worked, like `runSchedules`' dry run: reporting
      // whether each write *would* succeed means performing it.
      report.done++
      continue
    }
    try {
      await one(deps, action, row, tags, opts)
      report.done++
    } catch (err) {
      report.failed.push({ id: row.id, title: row.filename, message: reasonOf(err, deps.logger) })
    }
  }

  report.seen = seen + consumed
  // **`exhausted`, not `consumed < limit`.** A filter batch drops the rows a
  // select-all ticked off *after* the read, so a batch can act on fewer rows than
  // it read and still have the whole rest of the table in front of it — ending
  // the job on a short *acted* count would silently skip everything after the
  // first excluded row. What says "the walk is over" is a short *read*, which is
  // what each batch reports for itself.
  report.continueFrom =
    exhausted || report.seen >= total || last === null ? null : writeBulkCursor(last, report.seen)
  return report
}

/** One asset, one action. Each branch is the same write the single-asset route
 * makes, which is why `deleteAsset` is called rather than reimplemented. */
async function one(
  deps: AssetBulkDeps,
  action: AssetBulkAction,
  row: AssetRow,
  tags: readonly AssetTag[],
  opts: AssetBulkOptions,
): Promise<void> {
  const { db } = deps
  switch (action) {
    case 'tag':
      // **Add, never replace** — the difference between this and
      // `setAssetTags`, and the reason the bulk route is not "PATCH each row
      // with the tag list". `or ignore` because an asset already carrying the
      // tag is a success: the editor asked for it to be tagged and it is.
      // Chunked at two binds a row, so the tag list cannot overrun the cap.
      await db.batch(
        bindChunks(tags, 2).map((chunk) =>
          db
            .prepare(
              `insert or ignore into asset_taggings (asset_id, tag_id)
                 values ${chunk.map(() => '(?, ?)').join(', ')}`,
            )
            .bind(...chunk.flatMap((tag) => [row.id, tag.id])),
        ),
      )
      return
    case 'untag':
      await db.batch(
        bindChunks(tags, 1).map((chunk) =>
          db
            .prepare(
              `delete from asset_taggings
                where asset_id = ? and tag_id in (${chunk.map(() => '?').join(', ')})`,
            )
            .bind(row.id, ...chunk.map((tag) => tag.id)),
        ),
      )
      return
    case 'move':
      // One column on one row, and **no R2 operation of any kind** — decision 1:
      // a folder is metadata, never part of the key, so filing a file that is
      // used on a published page cannot change a byte of that page.
      await db
        .prepare('update assets set folder_id = ? where id = ?')
        .bind(opts.folderId ?? null, row.id)
        .run()
      return
    case 'delete':
      // The identical call `DELETE {base}/api/assets/:id` makes: the row and its
      // inbound edges in one D1 batch, then the object. Documents are left alone
      // on purpose.
      if (!deps.media) throw new FolioError('unsupported', 'No media bucket is configured')
      await deleteAsset(db, deps.media, row.id)
      return
  }
}

/**
 * The tags a `tag`/`untag` names, resolved once and refused if any is unknown.
 *
 * **Unknown ids are refused, never dropped**, for `setAssetTags`'s reason:
 * `asset_taggings` has no foreign key, so an id nothing is behind would insert
 * rows no join ever returns — a tag the editor can see they applied and no
 * filter can find. Refusing here also means an untag naming a deleted tag says
 * so, rather than reporting a run of successes that removed nothing.
 */
async function requiredTags(db: FolioDb, ids: readonly string[] | undefined): Promise<AssetTag[]> {
  const wanted = [...new Set(ids ?? [])]
  if (wanted.length === 0) {
    throw new FolioError('bad_request', 'Name at least one tag')
  }
  const tags = await tagsByIds(db, wanted)
  if (tags.length !== wanted.length) {
    const known = new Set(tags.map((tag) => tag.id))
    throw new FolioError('bad_request', `Unknown tag '${wanted.find((id) => !known.has(id))}'`)
  }
  return tags
}

/**
 * How many of the selected assets are referenced by a published document —
 * decision 15's **one aggregate, not N queries**.
 *
 * `content_refs` holds the R2 *key* for an asset edge (`content-index.ts`'s
 * `assetReferences` says why), so this is an `exists` against `assets.key`
 * rather than a join on an id. `exists` rather than a join with `count(distinct
 * …)`: an asset used on forty pages is forty rows, and the question is "how many
 * files", not "how many uses".
 *
 * **A `FilterSelection`'s `exclude` is not subtracted**, and that is a decision
 * rather than an oversight. Subtracting it would bind a caller-sized list into a
 * single `count(*)`, which is the shape `db.ts` warns about — and the error is in
 * the safe direction: a warning that says "12 of these are in use" when one of
 * the twelve was ticked off overstates the damage, and the number is a warning
 * rather than an input to anything. Stated where the number is computed so the
 * next reader does not "fix" it into a bind list.
 */
async function countUsedOnPublished(
  db: FolioDb,
  selection: BulkSelection<AssetFilter>,
): Promise<number> {
  const used = `exists (select 1 from content_refs r where r.kind = 'asset' and r.to_id = assets.key)`
  if (selection.all) {
    const { clauses, binds } = assetFilterSql(selection.filter)
    const row = await db
      .prepare(`select count(*) as n from assets ${whereOf(...clauses, used)}`)
      .bind(...binds)
      .first<{ n: number }>()
    return row?.n ?? 0
  }
  // Chunked, because an id list is caller-sized. The chunks are disjoint by id,
  // so the counts add up exactly rather than approximately.
  const counts = await Promise.all(
    bindChunks([...new Set(selection.ids)], 1).map(async (chunk) => {
      const row = await db
        .prepare(
          `select count(*) as n from assets
            where id in (${chunk.map(() => '?').join(', ')}) and ${used}`,
        )
        .bind(...chunk)
        .first<{ n: number }>()
      return row?.n ?? 0
    }),
  )
  return counts.reduce((sum, n) => sum + n, 0)
}

/**
 * One batch's worth of rows, and the three numbers the cursor needs.
 *
 * `null` in `rows` is an id an explicit selection named and D1 no longer has; a
 * filter batch produces none, because it reads what it found.
 */
interface Batch {
  rows: (AssetRow | null)[]
  /** How much of the ceiling this batch used. Not `rows.length` for an explicit
   * list — see `idBatch` — and not the number of rows read, for a filter batch
   * that dropped exclusions. */
  consumed: number
  /**
   * Whether the walk has reached the end of what it can read.
   *
   * Reported by the batch rather than inferred by the caller from
   * `consumed < limit`, because the two branches are asked for different limits
   * and only they know what they asked for.
   */
  exhausted: boolean
  /** The id to resume after, or null when there is nothing left. */
  last: string | null
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
 * and dropped 3 acted on 22 — and `runAssetBulk` therefore ends the walk on a
 * short *read*. `last` is the last row **read**, not the last one kept, so the
 * cursor steps past an excluded row rather than reading it again forever.
 */
async function filterBatch(
  db: FolioDb,
  selection: FilterSelection<AssetFilter>,
  after: string | null,
  limit: number,
  allowance: number,
): Promise<Batch> {
  const rows = await assetsMatching(db, selection.filter, { limit, after })
  const excluded = new Set(selection.exclude ?? [])
  const kept = excluded.size === 0 ? rows : rows.filter((row) => !excluded.has(row.id))
  // Trimmed to the ceiling *after* the exclusions, which is the only order that
  // can be right: a batch that read 25 rows, dropped 20 and is allowed 3 acts on
  // 3. Trimming past the allowance loses nothing, because consuming the last of
  // it ends the job — `seen >= total` on the very next line of `runAssetBulk`.
  const acting = kept.length > allowance ? kept.slice(0, allowance) : kept
  return {
    rows: acting,
    consumed: acting.length,
    exhausted: rows.length < limit,
    last: rows.at(-1)?.id ?? null,
  }
}

/**
 * One batch of an explicit id list.
 *
 * The client re-posts the same `ids` on every call, so the slice offset *is* the
 * cursor's counter — and `runAssetBulk` has already checked the id the cursor
 * stopped on against the list, because the two ways of absorbing a changed list
 * are skipping rows and doing some of them twice, and `delete` tolerates neither.
 *
 * `consumed` is the *slice* length rather than the row count: `assetsFor` omits
 * an id with no row behind it, so counting rows would read a stale id as the end
 * of the list. The gap is filled with `null`, which the loop reports per action.
 */
async function idBatch(
  db: FolioDb,
  ids: readonly string[],
  seen: number,
  limit: number,
): Promise<Batch> {
  const slice = ids.slice(seen, seen + limit)
  const found = new Map((await assetsFor(db, slice)).map((row) => [row.id, row]))
  return {
    rows: slice.map((id) => found.get(id) ?? null),
    consumed: slice.length,
    exhausted: slice.length < limit,
    last: slice.at(-1) ?? null,
  }
}

/** The id at a job position, for a failure that has no row to name itself with. */
function idAt(selection: BulkSelection<AssetFilter>, position: number): string {
  return selection.all ? '' : (selection.ids[position] ?? '')
}

/** `core/bulk.ts`'s codec, with this module's refusal for a cursor that is not
 * one of ours. */
function readCursor(raw: string): { after: string; seen: number } {
  const at = readBulkCursor(raw)
  if (!at) throw new FolioError('bad_request', 'Malformed pagination cursor')
  return at
}

/**
 * Why one file could not be acted on, as text that may travel — `runBulk`'s
 * `reasonOf`, and the reasoning is identical: a bulk report is prose rendered
 * straight into a toast, and anything `rethrow` declines to translate is a bug or
 * a platform failure that gets the generic message here and the real one in the
 * log.
 */
function reasonOf(err: unknown, logger: FolioLogger = console): string {
  try {
    rethrow(err)
  } catch (translated) {
    if (translated instanceof FolioError) return translated.message
  }
  logger.error('folio: unreportable failure during a bulk asset write', err)
  return 'Something went wrong.'
}

/** Re-exported for the report a caller reads. `BulkFailure` is `core/bulk.ts`'s
 * and means the same thing here: an id, a name, and prose. */
export type { BulkFailure }
