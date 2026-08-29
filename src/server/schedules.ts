/**
 * Scheduled publish and unpublish, as rows — see `migrations/0003_schedules.sql`
 * and `../../docs/specs/platform/scheduled-publishing.md`.
 *
 * This file is the SQL half only: reading a schedule, writing one, clearing one,
 * and the batch read the sweep walks. The sweep itself is `scheduler.ts`, and the
 * split is the same one `stories.ts` and `migrate.ts` have — a runner imports
 * `publish.ts`, and `stories.ts` has to be able to import the *cleanup* statements
 * from here without dragging the publish workflow in behind them.
 *
 * Two writers, and they stay distinct for the reason `redirects.ts`' two do:
 *
 * - `setScheduleStatements` is an editor asking for something. Delete-then-insert,
 *   because at most one *pending* schedule exists per document per action
 *   (`schedules_story_action`), so rescheduling replaces rather than queues — and
 *   the delete also clears a retained failure for the same pair, which is what
 *   makes "try again" a reschedule rather than a second row.
 * - `clearSchedulesStatements` is a document going away. Unrun, so
 *   `deleteStoryStatement` batches it with the story delete: an instruction to
 *   publish a document that no longer exists is not an instruction, and unlike a
 *   redirect a schedule must not outlive its story.
 */
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import type { Schedule, ScheduleAction, ScheduleStatus } from '../core/story'
import { FolioError } from './errors'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'

const COLS = `id, story_id as storyId, action, at, status, actor,
              created_at as createdAt, attempts, last_error as lastError`

/**
 * Soonest first, paged over `(at, id)` — exactly what `schedules_due` indexes, and
 * exactly the order the sweep runs in.
 *
 * Ascending, unlike every other list in this codebase: `NEWEST_FIRST` answers "what
 * happened", and a schedule list answers "what is about to happen", where the next
 * thing is the interesting one. `id` is the tiebreak because two schedules can name
 * the same instant and a keyset boundary has to be total (see `Schedule.id`'s own
 * comment for why the key is synthetic at all).
 */
const SOONEST_FIRST: Keyset = { columns: ['at', 'id'], direction: 'asc' }

function newScheduleId(): string {
  return `sch_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * How far ahead a schedule may be set: ten years, matching the ceiling
 * `TokenCreateBody.expiresInDays` puts on an API token's life.
 *
 * A bound rather than none, because the common client bug this catches is a
 * timezone or unit mistake — seconds sent where milliseconds were meant reads as
 * 1970, and milliseconds sent where seconds were meant reads as the year 56,000.
 * The first is caught by the past check below; this catches the second.
 */
export const MAX_SCHEDULE_HORIZON_MS = 10 * 365 * 24 * 60 * 60 * 1000

/**
 * Refuses a time that is not a schedule.
 *
 * **A time in the past is a 400, not "fire on the next sweep".** The two are
 * observationally similar and mean different things: a caller asking to publish
 * something at a moment that has already gone has a bug — almost always a date
 * assembled in the wrong unit or the wrong timezone — and `POST /story/:id/publish`
 * is the route that means "now". Silently accepting it would publish immediately
 * under a UI that says "scheduled", which is the worst of both answers.
 */
export function checkScheduleTime(at: number, now: number): void {
  if (at <= now) {
    throw new FolioError(
      'bad_request',
      'A schedule must be in the future. Publish now instead of scheduling.',
    )
  }
  if (at > now + MAX_SCHEDULE_HORIZON_MS) {
    throw new FolioError('bad_request', 'A schedule cannot be more than ten years ahead.')
  }
}

export interface ScheduleWrite {
  storyId: string
  action: ScheduleAction
  /** Epoch milliseconds. Already checked with `checkScheduleTime`. */
  at: number
  actor: string | null
}

/**
 * The row an editor just asked for, plus the two statements that install it,
 * unrun.
 *
 * Unrun so the caller batches them: the delete and the insert must land together
 * or a crash between them leaves the document with *no* schedule where it had one
 * a moment ago — a silent cancellation, which is exactly the failure this feature
 * cannot have. `schedules_story_action` is what turns a concurrent second call
 * into a `conflict` envelope (`errors.ts` maps any UNIQUE violation) rather than
 * two contradictory pending rows.
 */
export function setScheduleStatements(
  db: D1Database,
  input: ScheduleWrite,
): { schedule: Schedule; statements: D1PreparedStatement[] } {
  const schedule: Schedule = {
    id: newScheduleId(),
    storyId: input.storyId,
    action: input.action,
    at: input.at,
    status: 'pending',
    actor: input.actor,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  }
  return {
    schedule,
    statements: [
      // Any status, not only 'pending': rescheduling is also how an editor clears
      // a retained failure for the same document and action.
      db
        .prepare('delete from schedules where story_id = ? and action = ?')
        .bind(input.storyId, input.action),
      db
        .prepare(
          `insert into schedules (id, story_id, action, at, status, actor, created_at, attempts, last_error)
           values (?, ?, ?, ?, 'pending', ?, ?, 0, null)`,
        )
        .bind(
          schedule.id,
          schedule.storyId,
          schedule.action,
          schedule.at,
          schedule.actor,
          schedule.createdAt,
        ),
    ],
  }
}

/**
 * Cancels a document's schedule for one action, whatever state it is in. Answers
 * how many rows went, so a cancel for something that was never scheduled is `0`
 * rather than a 404 — the same shape `DELETE /redirects/:from` uses, and for the
 * same reason: the caller asked for a state of the world and got it.
 */
export async function clearSchedule(
  db: D1Database,
  storyId: string,
  action: ScheduleAction,
): Promise<number> {
  const result = await db
    .prepare('delete from schedules where story_id = ? and action = ?')
    .bind(storyId, action)
    .run()
  return result.meta.changes ?? 0
}

/**
 * Every schedule for a set of documents, unrun — for `deleteStoryStatement`'s
 * batch. Empty in, empty out: `in ()` is not valid SQL.
 */
export function clearSchedulesStatements(
  db: D1Database,
  storyIds: readonly string[],
): D1PreparedStatement[] {
  if (storyIds.length === 0) return []
  const placeholders = storyIds.map(() => '?').join(', ')
  return [db.prepare(`delete from schedules where story_id in (${placeholders})`).bind(...storyIds)]
}

/** Deletes one schedule by id — what the sweep runs after the publish it fired. */
export function completeScheduleStatement(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('delete from schedules where id = ?').bind(id)
}

/**
 * Records an attempt that did not work: the reason, the count, and — once the
 * count reaches the ceiling — the flip to `failed` that stops the retrying.
 *
 * `status` is passed in rather than computed here from `attempts`, so the one
 * place that decides "give up now" is the runner (`MAX_SCHEDULE_ATTEMPTS`) and not
 * two expressions that could disagree about the boundary.
 */
export function failScheduleStatement(
  db: D1Database,
  id: string,
  attempts: number,
  status: ScheduleStatus,
  reason: string,
): D1PreparedStatement {
  return (
    db
      .prepare('update schedules set attempts = ?, status = ?, last_error = ? where id = ?')
      // Bounded before it reaches the column: the reason is an error message, and
      // one from a platform failure can be long.
      .bind(attempts, status, reason.slice(0, 500), id)
  )
}

export interface ListSchedulesOptions {
  limit?: number
  cursor?: string
  /** One document's schedules — the editor's own read. */
  storyId?: string
  status?: ScheduleStatus
  action?: ScheduleAction
  /** Adds `total` for the same filter — one extra `count(*)`, only when asked
   * (`../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
}

/**
 * Schedules, soonest first, paged.
 *
 * Paged even though the pending set is bounded by what editors typed, because the
 * *failed* set is not bounded by anything: a broken cron over a site with 2,000
 * documents can retain one row per document. `pagination.md`'s rule is that no
 * admin list route reads a whole table, and a list nobody paged is how the five
 * unbounded reads it opened with got there.
 */
export async function listSchedules(
  db: D1Database,
  opts: ListSchedulesOptions = {},
): Promise<Page<Schedule>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(SOONEST_FIRST, cursor)

  // `narrow` is the filter, and `narrow` alone is what the count counts: a
  // `count(*)` carrying the cursor clause would answer "how many are left" where
  // the header reads `n of N`. The same split every other paged reader makes.
  const narrow: string[] = []
  const narrowBinds: unknown[] = []
  if (opts.storyId) {
    narrow.push('story_id = ?')
    narrowBinds.push(opts.storyId)
  }
  if (opts.status) {
    narrow.push('status = ?')
    narrowBinds.push(opts.status)
  }
  if (opts.action) {
    narrow.push('action = ?')
    narrowBinds.push(opts.action)
  }

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from schedules
         ${whereOf(...narrow, resume.sql)} ${orderBy(SOONEST_FIRST)} limit ?`,
      )
      .bind(...narrowBinds, ...resume.binds, limit + 1)
      .all<Schedule>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from schedules ${whereOf(...narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  // Keyed component for component with `SOONEST_FIRST` — the correspondence
  // `paginate` cannot check for its caller.
  const page = paginate(rows.results, limit, (row) => [row.at, row.id])
  return total ? { ...page, total: total.n } : page
}

/**
 * One batch of schedules that are due: pending, at or before `now`, in the order
 * they were meant to happen, resuming after `cursor`.
 *
 * **Due order rather than `id` order**, unlike `storiesBehind` and
 * `publishedDocsAfter`. Those walk a table by primary key because any order will
 * do; here the batch limit can truncate a backlog, and the row that should be
 * fired first is the one that was due longest ago. That is also why the cursor is
 * the opaque `(at, id)` keyset rather than a bare id: the resume key is a pair.
 *
 * A cursor is needed at all only because of retries. A schedule that fires is
 * *deleted*, so the due set shrinks as the sweep walks it and re-reading the first
 * batch would be correct — except that a row which failed transiently stays
 * pending and stays due, so a cursorless sweep would retry it forever inside one
 * run and never reach the rows behind it.
 */
export async function dueSchedules(
  db: D1Database,
  now: number,
  cursor: string | null,
  limit: number,
): Promise<{ rows: Schedule[]; next: string | null }> {
  const resume = keysetWhere(SOONEST_FIRST, cursor ? decodeCursor(cursor) : null)
  const { results } = await db
    .prepare(
      `select ${COLS} from schedules
       ${whereOf("status = 'pending'", 'at <= ?', resume.sql)} ${orderBy(SOONEST_FIRST)} limit ?`,
    )
    .bind(now, ...resume.binds, limit + 1)
    .all<Schedule>()

  const page = paginate(results, limit, (row) => [row.at, row.id])
  return { rows: page.rows, next: page.cursor }
}

/**
 * How many schedules are still pending and due at `now`.
 *
 * Asked directly rather than accumulated across batches, the same way
 * `countBehind` is: it is right however many calls a run took, and right across
 * two runs that overlapped. **A diagnostic, not a loop condition** — see
 * `ScheduleRunReport.remaining`.
 */
export async function countDue(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare("select count(*) as n from schedules where status = 'pending' and at <= ?")
    .bind(now)
    .first<{ n: number }>()
  return row?.n ?? 0
}
