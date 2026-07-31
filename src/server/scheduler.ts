/**
 * The sweep that fires due schedules
 * (`../../../docs/specs/platform/scheduled-publishing.md`).
 *
 * **A cron trigger on the host's Worker, not a Durable Object alarm per story.**
 * `ROADMAP.md` predicted the alarm and it is wrong, for a reason that is only
 * visible from `story-do.ts`: a Durable Object has exactly **one** alarm, and
 * `StoryDO` already spends it on the debounced draft watermark — 2s after the last
 * logged transaction, guarded by `getAlarm() === null` meaning "already scheduled"
 * (`story-do.ts`'s `applyTransaction`). The two uses cannot coexist:
 *
 *   - A publish alarm set for Tuesday makes `getAlarm()` non-null for days, so no
 *     watermark is ever written and the whole tree stops reporting unpublished
 *     changes.
 *   - Let the watermark win instead and any keystroke on Monday resets the alarm
 *     to `now + 2s`, at which point the handler has to decide which job it is —
 *     and the honest version of that is a due-time table inside every object,
 *     which is `where at <= ?` reimplemented per document in SQLite.
 *
 * A cron also answers a question an alarm structurally cannot: **"what is scheduled
 * across this site"** is one indexed D1 read here, and waking every Durable Object
 * there. A schedule nobody can list is a schedule nobody trusts.
 *
 * What is given up is exactness. Cloudflare cron granularity is a minute at best
 * and is best-effort within it, so a schedule fires on the first sweep *at or
 * after* its due time: lateness is bounded by the cron's period, earliness is
 * impossible, and "9:00" means "9:00, give or take the minute". For a CMS
 * publishing a press release that is the right trade; nothing here is a market
 * open.
 *
 * Shaped like `runMigrations` and `reindex` — batched, resumable, explicit, one
 * report — because it has their problem: it walks an unbounded set of documents
 * inside a Worker invocation that has a CPU limit. One call fires up to
 * `opts.batch` schedules and answers `continueFrom`; the caller re-calls until it
 * is null.
 *
 * Its dependency is `PublishDeps` and nothing else, which is the whole payoff of
 * `publish.ts` taking no Request: the sweep calls the same `publish()` an editor's
 * button calls, so it gets the retained version, the `content_index` write, the
 * `published` hook and Folio's own cache purge without restating any of them.
 */
import type { Schedule, ScheduleAction, ScheduleStatus } from '../core/story'
import { FolioError } from './errors'
import { publish, type PublishDeps, unpublish } from './publish'
import {
  completeScheduleStatement,
  countDue,
  dueSchedules,
  failScheduleStatement,
} from './schedules'

/** How many schedules one call fires before handing back a cursor. */
export const DEFAULT_SCHEDULE_BATCH = 25

/** Ceiling on `batch`, so a caller cannot ask for a run that outlives the request. */
export const MAX_SCHEDULE_BATCH = 200

/**
 * How many times a schedule is retried before it is marked `failed` and left
 * alone.
 *
 * Bounded rather than infinite, and retried rather than failed on the first
 * stumble, because the two failure modes want opposite answers: a transiently
 * unreachable Durable Object is fixed by trying again a minute later, and a
 * document whose publish genuinely cannot succeed would otherwise be retried every
 * minute forever, filling a log with the same line and burning a batch slot that
 * other schedules need. Three attempts is roughly three minutes on a
 * once-a-minute cron, which is long enough to outlast a blip and short enough that
 * an editor watching for their page notices.
 */
export const MAX_SCHEDULE_ATTEMPTS = 3

export interface ScheduleFailure {
  /** The schedule row, so a caller can cancel or reschedule it. */
  id: string
  storyId: string
  action: ScheduleAction
  reason: string
  attempts: number
  /** True once `attempts` reached `MAX_SCHEDULE_ATTEMPTS`: this will not be
   * retried, and an editor has to reschedule it. */
  givenUp: boolean
}

export interface ScheduleRunReport {
  /** Schedules that were due and examined in this call. */
  due: number
  /** Story ids published by this call. */
  published: string[]
  /** Story ids unpublished by this call. */
  unpublished: string[]
  /**
   * Schedules dropped because the document they name no longer exists — not a
   * failure. An instruction to publish something that has been deleted is not an
   * instruction, so the row goes rather than being retried three times and
   * retained as a broken schedule for a document nothing can show.
   */
  dropped: string[]
  failed: ScheduleFailure[]
  dryRun: boolean
  /** Pass back as `continueFrom` to sweep the next batch. Null when this call
   * reached the end of what was due. */
  continueFrom: string | null
  /**
   * How many schedules are still pending and due, asked directly after the run.
   *
   * **A diagnostic, never a loop condition.** Loop on `continueFrom`. A schedule
   * that failed transiently in this very call is still pending and still due, so
   * `while (remaining > 0)` spins on it — which is why there is no `complete` flag
   * here, unlike `MigrateReport`. That flag would be an invitation to write
   * exactly that loop.
   */
  remaining: number
}

const EMPTY = (dryRun: boolean): ScheduleRunReport => ({
  due: 0,
  published: [],
  unpublished: [],
  dropped: [],
  failed: [],
  dryRun,
  continueFrom: null,
  remaining: 0,
})

export interface ScheduleRunOptions {
  /**
   * The instant to compare against. Defaults to `Date.now()`.
   *
   * Injected rather than read, so a test — and `scripts/scheduled-test.mjs` — can
   * fire a schedule set for next Tuesday without waiting until Tuesday. Nothing in
   * production passes it, and it is deliberately not readable off the HTTP route:
   * see `routes/schedules.ts`.
   */
  now?: number
  batch?: number
  /** The previous call's `continueFrom`. An opaque `(at, id)` cursor, not an id. */
  continueFrom?: string | null
  /** Reports what would fire and writes nothing — no publish, no row cleared. */
  dryRun?: boolean
}

/**
 * One batch of the sweep.
 *
 * The order inside the loop is **publish, then clear the row**, and it is the one
 * ordering decision in this file that matters. Clearing first would be at-most-once:
 * a failure between the two loses the publish silently and forever, which is the
 * failure this feature cannot have. Publishing first is at-least-once — a crash
 * between them leaves the row pending and the next sweep publishes again, costing a
 * second `versions` row for byte-identical content. One redundant version beats one
 * page that never went live.
 *
 * Every schedule is attempted inside its own `try`. A sweep that died on one story
 * and skipped the rest is the bug to avoid, and it is the same discipline
 * `runMigrations` applies per document.
 */
export async function runSchedules(
  deps: PublishDeps,
  opts: ScheduleRunOptions = {},
): Promise<ScheduleRunReport> {
  const now = opts.now ?? Date.now()
  const dryRun = opts.dryRun === true
  const batch = Math.min(
    Math.max(Math.trunc(opts.batch ?? DEFAULT_SCHEDULE_BATCH), 1),
    MAX_SCHEDULE_BATCH,
  )

  const resuming = (opts.continueFrom ?? null) !== null
  const { rows, next } = await dueSchedules(deps.db, now, opts.continueFrom ?? null, batch)
  if (rows.length === 0) {
    // **One read, and this branch is where that claim is paid.** The ordinary cron
    // tick on a site with nothing scheduled lands here, and `remaining` is 0 by
    // construction: an unresumed read of "pending and due" that finds nothing is
    // itself the answer, so asking `countDue` would be a second query for a fact
    // already in hand (`0003_schedules.sql`'s note on the partial index).
    //
    // A *resumed* call is different and has to ask. Empty then means "nothing due
    // after the cursor", and a row that failed transiently earlier in this run is
    // behind the cursor, still pending and still due.
    return { ...EMPTY(dryRun), remaining: resuming ? await countDue(deps.db, now) : 0 }
  }

  const report: ScheduleRunReport = { ...EMPTY(dryRun), due: rows.length, continueFrom: next }

  for (const row of rows) {
    if (dryRun) {
      // Tallied as if it had worked: a dry run reports the *intent*, and asking
      // whether each publish would have succeeded means performing it.
      const bucket = row.action === 'publish' ? report.published : report.unpublished
      bucket.push(row.storyId)
      continue
    }

    try {
      if (row.action === 'publish') {
        await publish(deps, row.storyId, row.actor)
        report.published.push(row.storyId)
      } else if (row.action === 'unpublish') {
        await unpublish(deps, row.storyId, row.actor)
        report.unpublished.push(row.storyId)
      } else {
        // An action nothing declares. Reachable only from a hand-written row or a
        // future value written by a newer deploy: `schedules.action` carries no
        // CHECK constraint on purpose (`0003_schedules.sql`), so the guard is
        // here. Failed rather than dropped — the row is somebody's instruction and
        // deleting one this code does not understand is not this code's call.
        throw new FolioError('unsupported', `Unknown schedule action '${String(row.action)}'`)
      }
    } catch (err) {
      if (err instanceof FolioError && err.code === 'not_found') {
        // The document has been deleted. `deleteStoryStatement` batches the
        // schedule cleanup so this is normally unreachable; it is still handled,
        // because a delete racing this sweep and a schedule written by a script for
        // an id that never existed both land here.
        await clearRow(deps.db, row)
        report.dropped.push(row.id)
        continue
      }
      report.failed.push(await recordFailure(deps.db, row, reasonOf(err)))
      continue
    }

    // The publish has committed, so this row's work is done. See the at-least-once
    // note in this function's own doc comment for why the clear comes second.
    await clearRow(deps.db, row)
  }

  report.remaining = await countDue(deps.db, now)
  return report
}

/**
 * Deletes a row whose work is finished, swallowing a failure to do so.
 *
 * Swallowed rather than thrown, and this is the second half of the at-least-once
 * choice. The publish has already committed by the time this runs, so a throw here
 * would abort the whole sweep and skip every schedule behind this one — the exact
 * bug the per-schedule `try` exists to prevent, arriving through the back door. The
 * row instead stays pending and the next sweep republishes: a redundant `versions`
 * row for byte-identical content, which is the cost the ordering already accepted.
 *
 * **Not** counted as a failure. `attempts` is deliberately left alone: the publish
 * worked, so incrementing it would march a perfectly healthy schedule toward
 * `status: 'failed'` three sweeps from now.
 */
async function clearRow(db: D1Database, row: Schedule): Promise<void> {
  try {
    await completeScheduleStatement(db, row.id).run()
  } catch (err) {
    console.error(
      `folio: fired the schedule for ${row.storyId} but could not clear it; the next sweep will repeat it`,
      err,
    )
  }
}

/** One failed attempt, written to the row and described for the report. */
async function recordFailure(
  db: D1Database,
  row: Schedule,
  reason: string,
): Promise<ScheduleFailure> {
  const attempts = row.attempts + 1
  const givenUp = attempts >= MAX_SCHEDULE_ATTEMPTS
  const status: ScheduleStatus = givenUp ? 'failed' : 'pending'
  // Best-effort: a failure to record a failure must not abort the rest of the
  // sweep. The report still names it, and the row stays pending, so the next sweep
  // retries — with `attempts` unchanged, which is the safe direction to be wrong in
  // (a retry too many, never a schedule abandoned without a trace).
  try {
    await failScheduleStatement(db, row.id, attempts, status, reason).run()
  } catch (err) {
    console.error(`folio: could not record a failed schedule for ${row.storyId}`, err)
  }
  return { id: row.id, storyId: row.storyId, action: row.action, reason, attempts, givenUp }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
