/**
 * Bulk writes over a selection (`../../docs/specs/platform/bulk-writes.md`, and
 * `../../docs/ui-architecture.md` decision 7a, which specified this in full a day
 * before it existed).
 *
 * Five actions — publish, unpublish, duplicate, move, delete — over a selection that
 * comes in two shapes: the ids somebody ticked, or **a flag plus a captured filter
 * plus the count they were shown**. The second is why this module exists at all: with
 * server-side paging, "select all 51,420 matching" must not mean fetching 51,420 rows
 * to loop over them, so no ids are materialised anywhere and the whole selection is
 * four small JSON fields.
 *
 * Three properties carry the design, and none of them is a detail:
 *
 * **The count is the guard, checked once at the start.** The server re-runs the
 * captured filter, compares it to `expected`, and refuses on a mismatch — optimistic
 * concurrency with the count as the version. Once, not per batch: re-checking every
 * batch would make a long job un-completable on any site with live editors, and the
 * guard's purpose is to confirm *intent*, not to freeze the database. A refusal is
 * answered as a **value**, not thrown, the way `StoryDO.commit` answers a rejection,
 * because "the set moved" is an outcome of the request rather than an error in it.
 *
 * **The count is also the ceiling.** A run touches at most `expected - exclude.length`
 * documents however many batches it takes, which is what makes the guard mean
 * something despite being checked once: "delete all 12 matching" can never delete 13,
 * even if somebody creates nine drafts while the job walks. That is carried in the
 * cursor, so it survives the caller re-calling.
 *
 * **Execution is a batched job, not a request** — the shape `runMigrations`, `reindex`
 * and `runSchedules` already have, and for the identical reason: a Worker
 * invocation has a CPU limit and this walks an unbounded set of documents. One call
 * does up to `opts.batch` documents and answers `continueFrom`; the caller re-calls
 * until it is null. There is deliberately no server-side job record — see the spec's
 * decision 2 for what that would cost and what it would buy.
 *
 * Nothing here is atomic and the report is written so a UI cannot imply that it is.
 * Each document is its own write, individually refusable by a tree rule, and the
 * report counts the successes and *names* the failures.
 */
import { type CursorPart, decodeCursor, encodeCursor } from '../core/pagination'
import type { BulkAction, BulkSelection, FilterSelection, StoryMeta } from '../core/story'
import { deleteDocument, type DocumentDeps, duplicateDocument, moveDocument } from './documents'
import { FolioError, rethrow } from './errors'
import { publish, type PublishDeps, unpublish } from './publish'
import { countStories, storiesForChunked, storiesMatching } from './stories'
import type { FolioDb } from './db'

/** How many documents one call acts on before handing back a cursor. */
export const DEFAULT_BULK_BATCH = 25

/**
 * Ceiling on `batch`, so a caller cannot ask for a run that outlives the request.
 *
 * The same 200 `migrate`, `reindex` and the schedule sweep use, and it is generous
 * rather than safe: three of these five actions call `updateStoryStatement`,
 * `createStory` or `deleteStoryStatement`, each of which reads **every story row** to
 * derive paths and fractional indices. On a large site 200 of those in one invocation
 * will not finish, which is why the *default* is 25 and why the spec names that read
 * as the next thing worth narrowing.
 */
export const MAX_BULK_BATCH = 200

/**
 * A document the job could not act on, and why.
 *
 * `message` rather than the `reason` `MigrateFailure` and `ScheduleFailure` carry,
 * and the difference is the audience: those two are diagnostics for whoever reads a
 * report, and this is prose that goes straight into a toast — the admin's
 * `reportOf(action, done, failures)` takes `{ title, message }[]`, so this shape
 * feeds it with no mapping step in between. `id` rides along for a screen that wants
 * to leave the refused rows selected.
 */
export interface BulkFailure {
  id: string
  title: string
  message: string
}

export interface BulkReport {
  action: BulkAction
  /**
   * Documents this **call** acted on successfully. Per call, not cumulative: the
   * server cannot know what earlier calls did, so a client that batches sums these
   * itself and calls `reportOf` once at the end.
   */
  done: number
  /** The same, refused — one entry each, named. Per call, like `done`. */
  failed: BulkFailure[]
  /**
   * How many documents this selection agreed to act on: `ids.length`, or
   * `expected - exclude.length`. About the **job**, not this call, and it is what a
   * progress display divides by.
   */
  total: number
  /**
   * How many the job has consumed, this call included — the cursor's own counter,
   * so it is cumulative even though `done` is not. `seen === total` and
   * `continueFrom === null` are the same fact from either end.
   */
  seen: number
  /**
   * Pass back as `continueFrom` to do the next batch. Null when the job is
   * finished. **Loop on this**, not on `seen < total`: a batch whose documents were
   * all refused still advances the cursor, and a comparison of counts would spin.
   */
  continueFrom: string | null
  /** Reports what it would do and writes nothing. */
  dryRun: boolean
}

/**
 * The set moved between the number a person read and the button they pressed.
 *
 * **A door, not a wall**: it carries the *new* count, so re-confirming is one click
 * rather than a mystery. `refused` is a literal so a client can tell this apart from
 * a report without duck-typing, and there is deliberately only one value for it — the
 * count is the only thing this can refuse over.
 */
export interface BulkRefusal {
  refused: 'count'
  expected: number
  actual: number
}

/** A run either happened or was refused before it started. */
export type BulkOutcome = BulkReport | BulkRefusal

export function wasRefused(outcome: BulkOutcome): outcome is BulkRefusal {
  return 'refused' in outcome
}

export interface BulkOptions {
  batch?: number
  /** The previous call's `continueFrom`. An opaque `(id, seen)` pair, not an id. */
  continueFrom?: string | null
  /** Computes everything, writes nothing, and answers the same shape. */
  dryRun?: boolean
  /** Who asked, for every version row and hook the run fires. Off the session,
   * never the body. */
  actor?: string | null
  /**
   * `move`'s destination, and required for it. `parentId: null` is the top level.
   *
   * `index` is where the **first** document lands among the destination's children;
   * each one after it goes immediately below, so a set lands in the order the job
   * walked it. The admin's per-item client loop passed `index: 0` for every
   * document, which silently *reversed* the set.
   */
  destination?: { parentId: string | null; index?: number }
  /**
   * `delete`'s redirect switch, defaulting to **true** exactly as
   * `DELETE {base}/api/stories/:id` does (`../platform/redirects.md` decision 4): a
   * bulk delete has to leave the redirects a hundred single deletes would.
   */
  redirect?: boolean
}

/**
 * `DocumentDeps` and `PublishDeps` together, because one job does all five actions.
 *
 * Nothing new: `publish`/`unpublish` need the draft-plus-syncId read and the title
 * resolvers, and duplicate/move/delete need the declared types and the Durable Object
 * stub. Assembled in one place, `routes/bulk.ts`, from `rt.publishDeps` plus two
 * fields.
 */
export interface BulkDeps<Env = unknown> extends PublishDeps<Env>, DocumentDeps<Env> {}

/**
 * One batch of a bulk write.
 *
 * The per-document `try` is the same discipline `runMigrations` and `runSchedules`
 * apply: a run that died on one story and skipped the rest is the bug to avoid, and
 * "each of N writes can be individually refused" is the honest description of what
 * this is.
 *
 * Sequential rather than `Promise.all`, and deliberately. Every one of these writes
 * reads the story table and derives paths or fractional indices from it, so firing 25
 * in parallel is 25 readers racing over the same rows — two moves into the same
 * parent would compute the same `ord` from the same snapshot. The order also makes
 * the failure report deterministic, which is what lets a test assert it.
 */
export async function runBulk<Env>(
  deps: BulkDeps<Env>,
  action: BulkAction,
  selection: BulkSelection,
  opts: BulkOptions = {},
): Promise<BulkOutcome> {
  const dryRun = opts.dryRun === true
  const actor = opts.actor ?? null
  const batch = Math.min(Math.max(Math.trunc(opts.batch ?? DEFAULT_BULK_BATCH), 1), MAX_BULK_BATCH)
  const resume = opts.continueFrom ? readCursor(opts.continueFrom) : null

  if (action === 'move' && !opts.destination) {
    throw new FolioError('bad_request', 'A bulk move needs a destination')
  }
  // Refused here rather than at the route, so a direct caller cannot route around
  // it — the same placement `duplicateStory`'s singleton refusal has. A duplicate
  // *adds a document to the very set it is walking*, and the copy of a draft is
  // itself a draft, so "duplicate everything matching `state: draft`" is a question
  // whose answer changes while it is being answered. Excluding what the job created
  // would mean remembering the ids it created, which is materialising the id list
  // this whole shape exists to avoid.
  if (action === 'duplicate' && selection.all) {
    throw new FolioError(
      'bad_request',
      'Duplicate needs an explicit list of documents: duplicating everything matching a filter would add to that filter as it ran.',
    )
  }
  // Before the ceiling check below, deliberately: a cursor that disagrees with the
  // list it was issued against is a client bug whatever the arithmetic says, and an
  // exhausted allowance would otherwise report a placid "nothing left to do" for it.
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

  // The guard, once, at the start of the job — never on a resumed call. See the
  // module header; the spec's decision 3 records what re-checking would cost.
  if (selection.all && resume === null) {
    const actual = await countStories(deps.db, selection.filter)
    if (actual !== selection.expected) {
      return { refused: 'count', expected: selection.expected, actual }
    }
  }

  const report: BulkReport = {
    action,
    done: 0,
    failed: [],
    total,
    seen,
    continueFrom: null,
    dryRun,
  }
  // The ceiling. A job that has consumed everything it agreed to is finished, even
  // if the filter still matches rows — those are documents nobody agreed to touch.
  const allowance = total - seen
  if (allowance <= 0) return report

  const limit = Math.min(batch, allowance)
  const { rows, consumed, last } = selection.all
    ? await filterBatch(deps.db, selection, resume?.after ?? null, limit)
    : await idBatch(deps.db, selection.ids, seen, limit)

  for (const [at, row] of rows.entries()) {
    if (row === null) {
      // An id in an explicit selection with no row behind it. A delete has already
      // got what it asked for; anything else genuinely cannot happen.
      if (action === 'delete') report.done++
      else {
        report.failed.push({
          id: idAt(selection, seen + at),
          title: '',
          message: 'No such document',
        })
      }
      continue
    }
    if (dryRun) {
      // Tallied as if it had worked, like `runSchedules`' dry run: reporting
      // whether each write *would* succeed means performing it.
      report.done++
      continue
    }
    try {
      await one(deps, action, row, { ...opts, actor, index: indexFor(opts, seen + at) })
      report.done++
    } catch (err) {
      report.failed.push({ id: row.id, title: row.title, message: reasonOf(err) })
    }
  }

  report.seen = seen + consumed
  // A short read means the walk reached the end of what matches; reaching the
  // ceiling means the end of what was agreed. Either way there is nothing to
  // resume, and a null cursor is what says so — a non-null one on a finished job
  // costs the caller one more request to discover an empty batch.
  report.continueFrom =
    consumed < limit || report.seen >= total || last === null
      ? null
      : writeCursor(last, report.seen)
  return report
}

/** One document, one action. Every branch is the same call the single-document
 * route makes, which is the point of `documents.ts` and `publish.ts` existing. */
async function one<Env>(
  deps: BulkDeps<Env>,
  action: BulkAction,
  story: StoryMeta,
  opts: BulkOptions & { actor: string | null; index: number },
): Promise<void> {
  switch (action) {
    case 'publish':
      // The row rather than the id: the reader has just loaded it, and `publish`
      // takes a `StorySelector` precisely so a caller that already has the row is
      // not charged a second lookup for it.
      await publish(deps, story, opts.actor)
      return
    case 'unpublish':
      await unpublish(deps, story, opts.actor)
      return
    case 'duplicate':
      await duplicateDocument(deps, story, {}, opts.actor)
      return
    case 'move':
      await moveDocument(
        deps,
        story.id,
        { parentId: opts.destination?.parentId ?? null, index: opts.index },
        opts.actor,
      )
      return
    case 'delete':
      // `null` is a document that is already gone, and for a delete that is
      // success: the ordinary way it happens is a selection holding both a page and
      // one of its own descendants, where deleting the ancestor took the descendant
      // with it. Reporting it as a failure would make correct behaviour look broken.
      await deleteDocument(deps, story.id, { redirect: opts.redirect ?? true }, opts.actor)
      return
  }
}

/** Where the document at `position` in the job lands among its new siblings. See
 * `BulkOptions.destination`. */
function indexFor(opts: BulkOptions, position: number): number {
  return (opts.destination?.index ?? 0) + position
}

/**
 * One batch's worth of documents, and the two numbers the cursor needs.
 *
 * `null` in `rows` is an id an explicit selection named and D1 no longer has; a
 * filter batch produces none, because it reads what it found.
 */
interface Batch {
  rows: (StoryMeta | null)[]
  /** How much of the ceiling this batch used, which is **not** `rows.length` for an
   * explicit list — see `idBatch`. */
  consumed: number
  /** The id to resume after, or null when there is nothing left. */
  last: string | null
}

/**
 * One batch of a captured filter, plus how much of the ceiling it used.
 *
 * `consumed` is the row count, because a filter batch reads exactly what it will act
 * on — the exclusions are already applied in SQL.
 */
async function filterBatch(
  db: FolioDb,
  selection: FilterSelection,
  after: string | null,
  limit: number,
): Promise<Batch> {
  const rows = await storiesMatching(db, selection.filter, {
    limit,
    after,
    ...(selection.exclude ? { exclude: selection.exclude } : {}),
  })
  return { rows, consumed: rows.length, last: rows.at(-1)?.id ?? null }
}

/**
 * One batch of an explicit id list.
 *
 * The client re-posts the same `ids` on every call, so the slice offset *is* the
 * cursor's counter — and `runBulk` has already checked the id the cursor stopped on
 * against the list, because the two ways of absorbing a changed list are skipping
 * documents and doing some of them twice, and one of the five actions is not
 * idempotent.
 *
 * `consumed` is the *slice* length rather than the row count: `storiesForChunked`
 * omits an id with no row behind it, so counting rows would read a stale id as the
 * end of the list. The gap is filled with `null`, which the loop reports per action.
 */
async function idBatch(
  db: FolioDb,
  ids: readonly string[],
  seen: number,
  limit: number,
): Promise<Batch> {
  const slice = ids.slice(seen, seen + limit)
  const found = new Map((await storiesForChunked(db, slice)).map((row) => [row.id, row]))
  return {
    rows: slice.map((id) => found.get(id) ?? null),
    consumed: slice.length,
    last: slice.at(-1) ?? null,
  }
}

/** The id at a job position, for a failure that has no row to name itself with. */
function idAt(selection: BulkSelection, position: number): string {
  return selection.all ? '' : (selection.ids[position] ?? '')
}

/**
 * The job's cursor: the id it stopped on, and how many documents it has consumed.
 *
 * Two components, and only the first is a sort key — which is why this is
 * `encodeCursor` directly rather than a `Page<T>`. The counter is what enforces the
 * ceiling across calls, and putting it in the opaque cursor rather than in the body
 * means the caller cannot advance the job's allowance by editing a number.
 *
 * A client *can* still fabricate a whole cursor and skip the count guard with it,
 * which is worth naming: it buys nothing. The guard confirms intent; the role check
 * is the security boundary, and a caller authorised to post this could equally post
 * the ids.
 */
function writeCursor(after: string, seen: number): string {
  return encodeCursor([after, seen])
}

function readCursor(raw: string): { after: string; seen: number } {
  const parts: CursorPart[] | null = decodeCursor(raw)
  const [after, seen] = parts ?? []
  if (typeof after !== 'string' || typeof seen !== 'number' || seen < 0) {
    throw new FolioError('bad_request', 'Malformed pagination cursor')
  }
  return { after, seen: Math.trunc(seen) }
}

/**
 * Why one document could not be acted on, as text that may travel.
 *
 * Through `rethrow`, which is the one table that decides what a client may be told:
 * a bulk report is prose rendered straight into a toast, and the messages
 * `stories.ts` throws include D1's own `UNIQUE constraint failed` text, which names
 * a table and a column. Anything `rethrow` declines to translate is a bug or a
 * platform failure, so it gets the generic message here and the real one in the log —
 * exactly what `app.onError` does for a request, applied per document.
 */
function reasonOf(err: unknown): string {
  try {
    rethrow(err)
  } catch (translated) {
    if (translated instanceof FolioError) return translated.message
  }
  console.error('folio: unreportable failure during a bulk write', err)
  return 'Something went wrong.'
}
