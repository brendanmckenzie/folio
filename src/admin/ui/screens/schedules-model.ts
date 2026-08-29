import type { Schedule, ScheduleAction, ScheduleStatus } from '../../../core/story'
import type { BadgeTone } from '../Badge'

/**
 * Everything decidable about the Schedules screen, as pure functions.
 *
 * The screen exists because of the argument that chose a cron over a Durable Object
 * alarm (`docs/specs/platform/scheduled-publishing.md` decision 2): **"what is
 * scheduled across this site" is one indexed D1 read**, where an alarm-based design
 * would have to wake every object — and *"a schedule nobody can list is a schedule
 * nobody trusts"*. So the screen's job is trust, not a table dump, and the two
 * functions that carry that are `health` and `outcomeOf` below.
 *
 * `test/unit/admin/schedules-model.test.ts` runs all of this in Node with no DOM,
 * which is why the judgement is here and `Schedules.tsx` only arranges it.
 */

/** A row as `GET {base}/api/schedules` answers it. */
export type ScheduleRow = Schedule

/**
 * A row with the title resolved.
 *
 * `Schedule` deliberately carries no title and no path — the route's own comment
 * says why, and it is right: joining `stories` there would denormalise two columns
 * into a reader with no other use for them. So the screen makes a second request to
 * `GET {base}/api/stories?ids=` and joins here.
 *
 * **Two absences, and conflating them is a bug rather than a shortcut.** A title can
 * be absent because the lookup has not answered yet or failed, or because it answered
 * and this document is genuinely gone. The first version of this had one optional
 * field for both, which meant a *failed* lookup rendered every row on the screen as
 * "Deleted document" — confidently, in italics. So `missing` is set only when the
 * lookup succeeded and this id was not in it, and `titleOf` has three branches.
 */
export interface ResolvedSchedule extends ScheduleRow {
  title?: string
  /** The lookup answered and this document was not in it. */
  missing?: boolean
}

/**
 * A fired schedule is **deleted**, not marked done, so this list only ever holds
 * work that has not happened. That is the fact that makes the screen readable: every
 * row is either waiting or in trouble, and there is no completed-history noise to
 * filter out. It is also why there is no `done` status to offer as a filter.
 */
export const STATUSES: readonly ScheduleStatus[] = ['pending', 'failed']
export const ACTIONS: readonly ScheduleAction[] = ['publish', 'unpublish']

/** Matching `server/scheduler.ts`. A `failed` row at this many attempts is done
 * trying, which is the difference between "wait" and "do something". */
export const MAX_ATTEMPTS = 3

/* ------------------------------------------------------------------- the URL --- */

export interface SchedulesUrl {
  status: string
  action: string
}

/**
 * The screen's state, read off the query string.
 *
 * Unknown values are dropped rather than refused, the same posture `parseRedirectsUrl`
 * takes: a hand-edited or stale URL should show an unfiltered list, not an error page.
 */
export function parseSchedulesUrl(query: Readonly<Record<string, string>>): SchedulesUrl {
  const status = query.status ?? ''
  const action = query.action ?? ''
  return {
    status: (STATUSES as readonly string[]).includes(status) ? status : '',
    action: (ACTIONS as readonly string[]).includes(action) ? action : '',
  }
}

/** The inverse, for `href`. Empty values are dropped by `href` itself. */
export function schedulesQuery(url: SchedulesUrl): Record<string, string | undefined> {
  return { status: url.status || undefined, action: url.action || undefined }
}

/** What goes on the wire. One representation, shared by the fetch and by the
 * cursor-reset key, so a third filter cannot be added without resetting paging. */
export function schedulesParams(
  url: SchedulesUrl,
  opts: { limit: number; cursor?: string | null; count?: boolean },
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit))
  if (url.status) params.set('status', url.status)
  if (url.action) params.set('action', url.action)
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.count) params.set('count', '1')
  return params
}

export const isNarrowed = (url: SchedulesUrl): boolean => url.status !== '' || url.action !== ''

/* ------------------------------------------------------------------- labels --- */

export function actionLabel(action: ScheduleAction): string {
  return action === 'publish' ? 'Publish' : 'Unpublish'
}

/**
 * What the document column says. Three branches, one per state of the join.
 *
 * The unresolved branch falls back to the **story id** rather than to a dash or a
 * spinner: it is what the row actually contains, it is enough to act on, and it is
 * honest about not knowing the title. A dash would claim there is no name.
 */
export function titleOf(row: ResolvedSchedule): string {
  if (row.title !== undefined) return row.title
  return row.missing ? 'Deleted document' : row.storyId
}

/** Whether the document column is showing something other than a real title, which
 * is what the muted treatment keys on. */
export const isUnnamed = (row: ResolvedSchedule): boolean => row.title === undefined

/**
 * When it is due, in the reader's own timezone.
 *
 * **Folio stores no timezone anywhere** (`core/story.ts`'s `Schedule.at`), so the
 * conversion happens here and only here. `Intl` rather than a hand-rolled format,
 * because "Tue 12 Aug, 09:00" in a British browser and an Australian one are
 * different strings for the same instant and only the platform knows which.
 */
export function whenLabel(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at))
}

/**
 * "in 3 hours", "2 days ago".
 *
 * The relative form is what a person actually reads a schedule list for — an
 * absolute time answers "when" and a relative one answers "is that soon" — so both
 * are shown and this is not a hover title.
 */
export function relativeLabel(at: number, now: number, locale?: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const seconds = Math.round((at - now) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

/* ---------------------------------------------------------------- the outcome --- */

/**
 * What a row is actually going to do, which is **not** the same as its `status`.
 *
 * This is the screen's reason to exist. Four rows can all read `pending` or `failed`
 * and mean four different things, and the difference is only visible by comparing
 * `at` to the clock and `attempts` to the cap:
 *
 *   - `waiting` — pending, in the future. The ordinary case, and nothing to say.
 *   - `retrying` — has failed at least once but has attempts left, so the sweep will
 *     try again. Informational, not actionable.
 *   - `overdue` — pending, in the *past*, and never attempted. **Nothing is running
 *     the sweep.** This is the one state the server cannot report, because from D1's
 *     point of view the row is simply pending; it takes a clock to see it.
 *   - `stuck` — out of attempts. It will never fire, and only a person can resolve
 *     it.
 *
 * A one-minute grace period on `overdue`, because the cron's granularity is a minute
 * and a schedule fires on the first sweep *at or after* its due time — so a row a few
 * seconds past due is on time, and flagging it would cry wolf once a minute forever.
 */
export type Outcome = 'waiting' | 'retrying' | 'overdue' | 'stuck'

/** How late a pending row may be before the sweep is presumed not to be running.
 * One tick of the cron plus a little, per the spec's "never early, late by at most
 * one tick". */
export const OVERDUE_GRACE_MS = 90_000

export function outcomeOf(row: ScheduleRow, now: number): Outcome {
  if (row.attempts >= MAX_ATTEMPTS) return 'stuck'
  if (row.attempts > 0) return 'retrying'
  return row.at < now - OVERDUE_GRACE_MS ? 'overdue' : 'waiting'
}

export function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case 'waiting':
      return 'Scheduled'
    case 'retrying':
      return 'Retrying'
    case 'overdue':
      return 'Overdue'
    case 'stuck':
      return 'Not run'
  }
}

/** `Badge`'s tone. `overdue` and `stuck` are the two a person has to act on. */
export function outcomeTone(outcome: Outcome): BadgeTone {
  switch (outcome) {
    case 'waiting':
      return 'neutral'
    case 'retrying':
      return 'warn'
    case 'overdue':
    case 'stuck':
      return 'danger'
  }
}

/**
 * The banner above the table, or null when there is nothing wrong.
 *
 * **Overdue is diagnosed as a configuration problem, not as a per-row fault**, and
 * that is deliberate: one row past due with no attempts means the sweep did not run,
 * and if the sweep did not run then *every* pending row is equally affected. Saying
 * "3 schedules are overdue" invites fixing three rows; naming the cron is the actual
 * repair, and `examples/demo/wrangler.jsonc` is where a host copies it from.
 *
 * `stuck` is the opposite and is reported separately: the sweep ran, tried three
 * times and gave up, so the rows really are individual failures with their own
 * `lastError`.
 */
export function health(
  rows: readonly ScheduleRow[],
  now: number,
): { tone: BadgeTone; message: string } | null {
  const overdue = rows.filter((row) => outcomeOf(row, now) === 'overdue').length
  const stuck = rows.filter((row) => outcomeOf(row, now) === 'stuck').length

  if (overdue > 0) {
    return {
      tone: 'danger',
      message: `${count(overdue, 'schedule')} past due and not attempted. Nothing appears to be running the sweep — check that your Worker declares a cron trigger and calls folio.runSchedules().`,
    }
  }
  if (stuck > 0) {
    return {
      tone: 'warn',
      message: `${count(stuck, 'schedule')} failed ${MAX_ATTEMPTS} times and will not be retried. Cancel and reschedule once the cause is fixed.`,
    }
  }
  return null
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? ' is' : 's are'}`

/* -------------------------------------------------------------- cancellation --- */

/**
 * What the cancel confirmation says.
 *
 * Names the document and the action, because `DELETE
 * {base}/api/story/:id/schedule?action=` cancels **one action for one document** —
 * so a campaign window (a publish on Tuesday, an unpublish on Friday) is two rows
 * and cancelling one leaves the other. A dialog that said only "Cancel this
 * schedule?" would let somebody cancel the publish and leave a page scheduled to
 * come down that was never going up.
 */
export function cancelWarning(row: ResolvedSchedule): string {
  const other = row.action === 'publish' ? 'unpublish' : 'publish'
  return `“${titleOf(row)}” will no longer ${row.action} automatically. Any scheduled ${other} for the same document is not affected.`
}

/** The path that cancels it. One route, narrowed by action. */
export function cancelPath(row: ScheduleRow): string {
  return `/story/${encodeURIComponent(row.storyId)}/schedule?action=${row.action}`
}

/* ------------------------------------------------------------------- footer --- */

/** Matching `redirects-model.ts`'s signature and wording exactly, because two
 * footers on two list screens reading differently is the kind of drift nobody
 * notices and everybody feels. */
export function showing(shown: number, total: number | undefined): string {
  if (total === undefined) return `${shown} shown`
  return `${shown} of ${total} ${total === 1 ? 'schedule' : 'schedules'}`
}
