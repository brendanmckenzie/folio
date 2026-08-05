import { describe, expect, it } from 'vitest'
import type { Schedule } from '../../../src/core/story'
import {
  ACTIONS,
  actionLabel,
  cancelPath,
  cancelWarning,
  health,
  isNarrowed,
  isUnnamed,
  MAX_ATTEMPTS,
  outcomeLabel,
  outcomeOf,
  outcomeTone,
  OVERDUE_GRACE_MS,
  parseSchedulesUrl,
  relativeLabel,
  schedulesParams,
  schedulesQuery,
  showing,
  STATUSES,
  titleOf,
  whenLabel,
} from '../../../src/admin/ui/screens/schedules-model'

/**
 * The Schedules screen's judgement, in Node with no DOM.
 *
 * `outcomeOf` and `health` are the two functions the screen exists for — they are
 * what turns a table of the `schedules` columns into an answer to "is this going to
 * happen" — so they are what is pinned here. The component only arranges them.
 */

const NOW = 1_800_000_000_000

const row = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'sch_1',
  storyId: 'sty_about',
  action: 'publish',
  at: NOW + 3_600_000,
  status: 'pending',
  actor: 'user:1',
  createdAt: NOW - 86_400_000,
  attempts: 0,
  lastError: null,
  ...over,
})

describe('the URL', () => {
  it('reads status and action, and drops anything it does not recognise', () => {
    expect(parseSchedulesUrl({ status: 'failed', action: 'unpublish' })).toEqual({
      status: 'failed',
      action: 'unpublish',
    })
    // A hand-edited or stale URL shows an unfiltered list rather than an error.
    expect(parseSchedulesUrl({ status: 'done', action: 'archive' })).toEqual({
      status: '',
      action: '',
    })
    expect(parseSchedulesUrl({})).toEqual({ status: '', action: '' })
  })

  it('round-trips through the query it writes', () => {
    const url = { status: 'pending', action: 'publish' }
    expect(parseSchedulesUrl(schedulesQuery(url) as Record<string, string>)).toEqual(url)
  })

  it('drops empty filters from the query rather than writing ?status=', () => {
    expect(schedulesQuery({ status: '', action: '' })).toEqual({
      status: undefined,
      action: undefined,
    })
  })

  it('puts only the set filters on the wire', () => {
    expect(schedulesParams({ status: '', action: '' }, { limit: 50 }).toString()).toBe('limit=50')
    expect(
      schedulesParams(
        { status: 'failed', action: 'publish' },
        {
          limit: 50,
          cursor: 'abc',
          count: true,
        },
      ).toString(),
    ).toBe('limit=50&status=failed&action=publish&cursor=abc&count=1')
  })

  /**
   * The cursor-reset key is the request minus the cursor, and this is what makes
   * that derivation safe: a third filter added to `schedulesParams` lands in both
   * strings automatically, so it cannot be added without resetting paging.
   */
  it('produces an identity string that changes with a filter and not with a cursor', () => {
    const base = { status: '', action: '' }
    const identity = (url: typeof base) =>
      schedulesParams(url, { limit: 50, count: true }).toString()
    expect(identity(base)).toBe(identity(base))
    expect(identity({ ...base, status: 'failed' })).not.toBe(identity(base))
    expect(schedulesParams(base, { limit: 50, count: true, cursor: 'x' }).toString()).not.toBe(
      identity(base),
    )
  })

  it('knows when it is narrowed', () => {
    expect(isNarrowed({ status: '', action: '' })).toBe(false)
    expect(isNarrowed({ status: 'failed', action: '' })).toBe(true)
    expect(isNarrowed({ status: '', action: 'publish' })).toBe(true)
  })
})

describe('the picklists', () => {
  /**
   * Two statuses and no `done`, because a fired schedule is **deleted** rather than
   * marked. Pinned because offering a `done` filter would be a filter that always
   * returns nothing, which reads as a broken screen rather than an empty state.
   */
  it('offers exactly the statuses the column can hold', () => {
    expect([...STATUSES]).toEqual(['pending', 'failed'])
    expect([...ACTIONS]).toEqual(['publish', 'unpublish'])
  })

  it('labels the actions as sentences rather than column values', () => {
    expect(actionLabel('publish')).toBe('Publish')
    expect(actionLabel('unpublish')).toBe('Unpublish')
  })
})

describe('outcomeOf', () => {
  /**
   * The four cases the `status` column conflates. This is the screen's whole reason
   * to exist, so each one is asserted separately rather than through a table.
   */
  it('is waiting for a pending row in the future', () => {
    expect(outcomeOf(row(), NOW)).toBe('waiting')
  })

  it('is retrying when it has failed but has attempts left', () => {
    expect(outcomeOf(row({ status: 'failed', attempts: 1 }), NOW)).toBe('retrying')
    expect(outcomeOf(row({ status: 'failed', attempts: MAX_ATTEMPTS - 1 }), NOW)).toBe('retrying')
  })

  it('is stuck once it has used every attempt', () => {
    expect(outcomeOf(row({ status: 'failed', attempts: MAX_ATTEMPTS }), NOW)).toBe('stuck')
  })

  /**
   * The one state the server structurally cannot report: to D1 the row is simply
   * pending, and only a clock can see that its due time has passed.
   */
  it('is overdue for a pending row well past due with no attempts', () => {
    expect(outcomeOf(row({ at: NOW - 600_000 }), NOW)).toBe('overdue')
  })

  /**
   * The grace period, and why it is not zero: the cron's granularity is a minute
   * and a schedule fires on the first sweep at or after its due time, so a row a few
   * seconds past due is on time. Without this the banner would fire once a minute on
   * a perfectly healthy site.
   */
  it('is still waiting inside the grace period, and overdue just outside it', () => {
    expect(outcomeOf(row({ at: NOW - OVERDUE_GRACE_MS + 1000 }), NOW)).toBe('waiting')
    expect(outcomeOf(row({ at: NOW - OVERDUE_GRACE_MS - 1000 }), NOW)).toBe('overdue')
  })

  /** An overdue row that *has* been attempted is retrying, not overdue: the sweep
   * plainly ran, so the diagnosis "nothing is running the sweep" would be false. */
  it('prefers retrying over overdue when the sweep has evidently run', () => {
    expect(outcomeOf(row({ at: NOW - 600_000, status: 'failed', attempts: 1 }), NOW)).toBe(
      'retrying',
    )
  })

  it('labels and tones each outcome, with only the actionable two in a loud tone', () => {
    expect(outcomeLabel('waiting')).toBe('Scheduled')
    expect(outcomeLabel('overdue')).toBe('Overdue')
    expect(outcomeTone('waiting')).toBe('neutral')
    expect(outcomeTone('retrying')).toBe('warn')
    expect(outcomeTone('overdue')).toBe('danger')
    expect(outcomeTone('stuck')).toBe('danger')
  })
})

describe('health', () => {
  it('says nothing when everything is merely waiting', () => {
    expect(health([row(), row({ id: 'sch_2' })], NOW)).toBeNull()
  })

  /**
   * **Overdue is diagnosed as a configuration problem, not a per-row fault**, so the
   * message names the cron rather than the count of affected rows: if the sweep is
   * not running then every pending row is equally affected and fixing three of them
   * fixes nothing.
   */
  it('names the cron when anything is past due and unattempted', () => {
    const warning = health([row({ at: NOW - 600_000 })], NOW)
    expect(warning?.tone).toBe('danger')
    expect(warning?.message).toContain('cron')
    expect(warning?.message).toContain('runSchedules')
  })

  it('reports stuck rows separately, because those really are individual failures', () => {
    const warning = health([row({ status: 'failed', attempts: MAX_ATTEMPTS })], NOW)
    expect(warning?.tone).toBe('warn')
    expect(warning?.message).toContain('will not be retried')
  })

  /** Overdue outranks stuck: a sweep that is not running is the cause of which the
   * other is at most a symptom, and two banners would bury the actionable one. */
  it('prefers the overdue diagnosis when both are present', () => {
    const warning = health(
      [row({ at: NOW - 600_000 }), row({ id: 'sch_2', status: 'failed', attempts: MAX_ATTEMPTS })],
      NOW,
    )
    expect(warning?.message).toContain('cron')
  })

  it('agrees with itself about singular and plural', () => {
    expect(health([row({ at: NOW - 600_000 })], NOW)?.message).toContain('1 schedule is')
    expect(
      health([row({ at: NOW - 600_000 }), row({ id: 'b', at: NOW - 600_000 })], NOW)?.message,
    ).toContain('2 schedules are')
  })
})

describe('cancellation', () => {
  /**
   * The route cancels **one action for one document**, so a campaign window survives
   * halfway. The confirmation has to say that: cancelling the publish and leaving the
   * unpublish means a page comes down having never gone up.
   */
  it('says what cancelling does not do', () => {
    expect(cancelWarning({ ...row(), title: 'About' })).toContain('scheduled unpublish')
    expect(cancelWarning({ ...row({ action: 'unpublish' }), title: 'About' })).toContain(
      'scheduled publish',
    )
  })

  it('names the document', () => {
    expect(cancelWarning({ ...row(), title: 'About' })).toContain('About')
  })

  it('narrows the delete by action, and encodes the id', () => {
    expect(cancelPath(row())).toBe('/story/sty_about/schedule?action=publish')
    expect(cancelPath(row({ storyId: 'sty a/b' }))).toBe(
      '/story/sty%20a%2Fb/schedule?action=publish',
    )
  })
})

describe('titleOf', () => {
  /**
   * Three branches, because two absences are two facts. The first version had one
   * optional field for both and a *failed* title lookup therefore rendered every row
   * as "Deleted document" — confidently, and in italics. These three cases are what
   * stops that coming back.
   */
  it('shows a real title when there is one', () => {
    expect(titleOf({ ...row(), title: 'About' })).toBe('About')
    expect(isUnnamed({ ...row(), title: 'About' })).toBe(false)
  })

  it('says the document is gone only when the lookup answered and it was absent', () => {
    expect(titleOf({ ...row(), missing: true })).toBe('Deleted document')
  })

  it('falls back to the story id while the lookup is unresolved or failed', () => {
    // Not a dash and not a spinner: the id is what the row actually contains, it is
    // enough to act on, and it does not claim the document has no name.
    expect(titleOf(row())).toBe('sty_about')
    expect(isUnnamed(row())).toBe(true)
  })
})

describe('the labels a clock produces', () => {
  /**
   * Asserted loosely on purpose. The exact string is `Intl`'s and varies with the
   * runtime's locale data, which is the whole reason the formatting is delegated
   * rather than hand-rolled — pinning "Tue 12 Aug, 09:00" would pin Node's ICU build.
   * What matters is that both formatters run and produce something.
   */
  it('formats an instant and its distance', () => {
    expect(whenLabel(NOW, 'en-GB')).toMatch(/\d/)
    expect(relativeLabel(NOW + 3_600_000, NOW, 'en-GB')).toContain('hour')
    expect(relativeLabel(NOW - 172_800_000, NOW, 'en-GB')).toContain('day')
  })

  it('picks the largest unit that fits, so a week is not 7 days', () => {
    expect(relativeLabel(NOW + 604_800_000, NOW, 'en-GB')).toContain('week')
    expect(relativeLabel(NOW + 45_000, NOW, 'en-GB')).toContain('second')
  })
})

describe('showing', () => {
  it('matches the redirects footer word for word, minus the noun', () => {
    expect(showing(3, undefined)).toBe('3 shown')
    expect(showing(3, 40)).toBe('3 of 40 schedules')
    expect(showing(1, 1)).toBe('1 of 1 schedule')
  })
})
