import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import { encodeCursor, type Page } from '../../src/core/pagination'
import type { Schedule } from '../../src/core/story'
import { FolioError } from '../../src/server/errors'
import type { PublishDeps } from '../../src/server/publish'
import { publish } from '../../src/server/publish'
import {
  checkScheduleTime,
  clearSchedule,
  listSchedules,
  MAX_SCHEDULE_HORIZON_MS,
  setScheduleStatements,
} from '../../src/server/schedules'
import { MAX_SCHEDULE_ATTEMPTS, runSchedules } from '../../src/server/scheduler'
import { deleteStory, storyById } from '../../src/server/stories'
import { applySeedFixture } from './seed-fixture'

/**
 * Scheduled publish and unpublish
 * (`../../../docs/specs/platform/scheduled-publishing.md`): the rows, the sweep,
 * and the four routes over both.
 *
 * The sweep is exercised against the real `publish`/`unpublish` workflows with a
 * stubbed draft, rather than against a stub of the workflows: the whole argument
 * for a cron over a Durable Object alarm is that a scheduled publish reaches the
 * *identical* code an editor's button reaches, so a test that mocked `publish` would
 * be asserting the one thing this design is about away.
 *
 * `now` is injected everywhere (`ScheduleRunOptions.now`) so nothing here waits for
 * a clock. The HTTP block at the bottom cannot do that — the route deliberately
 * refuses to read `now` off a body — so it schedules a few milliseconds out and
 * waits for those.
 */

const ORIGIN = 'https://example.com'
const API = `${ORIGIN}/folio/api`

/** The seed's three demo stories: sty_home (''), sty_about ('about'), sty_team. */
async function reset(): Promise<void> {
  await env.DB.prepare('delete from schedules').run()
  await env.DB.prepare('delete from versions').run()
  await env.DB.prepare('delete from stories').run()
  await env.DB.prepare('delete from redirects').run()
  await env.DB.prepare('delete from api_tokens').run()
  await env.DB.prepare('delete from users').run()
  await applySeedFixture(env.DB)
}

beforeEach(async () => {
  await reset()
})

function pageDoc(title: string): Doc {
  return {
    root: 'r1',
    bloks: {
      r1: { uid: 'r1', type: 'page', parent: null, slot: null, order: 'a0', data: { title } },
    },
  }
}

/**
 * `PublishDeps` with a stubbed draft and nothing else stubbed.
 *
 * `draws` counts draft reads, which is what pins the asymmetry the workflows have:
 * a scheduled publish snapshots the draft, and a scheduled unpublish must not read
 * it at all (`unpublish.md` decision 3).
 */
function deps(): PublishDeps & { draws: number } {
  const d = {
    db: env.DB,
    draws: 0,
    draft: async (story: { title: string }) => {
      d.draws++
      return pageDoc(story.title)
    },
    draftWithSyncId: async (story: { title: string }) => {
      d.draws++
      return { doc: pageDoc(story.title), syncId: 7 }
    },
    titleFor: (_story: unknown, doc: Doc) => String(doc.bloks[doc.root]?.data.title ?? ''),
  }
  return d as unknown as PublishDeps & { draws: number }
}

/** A pending schedule, written the way the route writes one. */
async function schedule(input: {
  storyId: string
  action: 'publish' | 'unpublish'
  at: number
  actor?: string | null
}): Promise<Schedule> {
  const { schedule: row, statements } = setScheduleStatements(env.DB, {
    storyId: input.storyId,
    action: input.action,
    at: input.at,
    actor: input.actor ?? null,
  })
  await env.DB.batch(statements)
  return row
}

async function rowsOf(): Promise<Schedule[]> {
  return (await listSchedules(env.DB, { limit: 200 })).rows
}

async function versionCount(storyId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from versions where story_id = ?')
    .bind(storyId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/* ------------------------------------------------------------ the row --- */

describe('checkScheduleTime', () => {
  it('refuses a time that has already passed, rather than firing on the next sweep', async () => {
    // The two are observationally similar and mean different things: a caller
    // asking for a moment that has gone has a bug (a date assembled in the wrong
    // unit or timezone), and `POST /story/:id/publish` is what "now" is for.
    expect(() => checkScheduleTime(1000, 1000)).toThrow(/must be in the future/)
    expect(() => checkScheduleTime(999, 1000)).toThrow(/must be in the future/)
    // Seconds sent where milliseconds were meant reads as 1970 and lands here.
    expect(() => checkScheduleTime(1_800_000_000, Date.now())).toThrow(/must be in the future/)
  })

  it('refuses a time absurdly far ahead, which is the other unit mistake', async () => {
    const now = Date.now()
    expect(() => checkScheduleTime(now + MAX_SCHEDULE_HORIZON_MS + 1, now)).toThrow(
      /ten years ahead/,
    )
    expect(() => checkScheduleTime(now + MAX_SCHEDULE_HORIZON_MS, now)).not.toThrow()
  })

  it('answers with the one error envelope, so a route needs no translation', async () => {
    try {
      checkScheduleTime(1, 2)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(FolioError)
      expect((err as FolioError).code).toBe('bad_request')
    }
  })
})

describe('setScheduleStatements', () => {
  it('replaces a pending schedule for the same document and action', async () => {
    const first = await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    const second = await schedule({ storyId: 'sty_about', action: 'publish', at: 2000 })

    const rows = await rowsOf()
    expect(rows.map((r) => r.id)).toEqual([second.id])
    expect(rows[0]?.at).toBe(2000)
    expect(first.id).not.toBe(second.id)
  })

  it('keeps a publish and an unpublish side by side: that is a campaign window', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_about', action: 'unpublish', at: 5000 })

    expect((await rowsOf()).map((r) => `${r.action}@${r.at}`)).toEqual([
      'publish@1000',
      'unpublish@5000',
    ])
  })

  it('clears a retained failure for the same pair, so rescheduling is how you retry', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await env.DB.prepare(
      "update schedules set status = 'failed', attempts = 3, last_error = 'boom'",
    ).run()

    await schedule({ storyId: 'sty_about', action: 'publish', at: 2000 })

    const rows = await rowsOf()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.attempts).toBe(0)
    expect(rows[0]?.lastError).toBeNull()
  })

  it('records who asked, off the session and never the body', async () => {
    const row = await schedule({
      storyId: 'sty_about',
      action: 'publish',
      at: 1000,
      actor: 'usr_alice',
    })
    expect(row.actor).toBe('usr_alice')
    expect((await rowsOf())[0]?.actor).toBe('usr_alice')
  })
})

describe('clearSchedule', () => {
  it('cancels one action and leaves the other half of the window standing', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_about', action: 'unpublish', at: 5000 })

    expect(await clearSchedule(env.DB, 'sty_about', 'publish')).toBe(1)
    expect((await rowsOf()).map((r) => r.action)).toEqual(['unpublish'])
  })

  it('answers 0 for something that was never scheduled, rather than failing', async () => {
    expect(await clearSchedule(env.DB, 'sty_about', 'publish')).toBe(0)
  })

  it('also dismisses a retained failure', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await env.DB.prepare("update schedules set status = 'failed'").run()
    expect(await clearSchedule(env.DB, 'sty_about', 'publish')).toBe(1)
    expect(await rowsOf()).toEqual([])
  })
})

describe('listSchedules', () => {
  beforeEach(async () => {
    await schedule({ storyId: 'sty_home', action: 'publish', at: 3000 })
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_team', action: 'unpublish', at: 2000 })
  })

  it('is soonest first, because the next thing is the interesting one', async () => {
    expect((await rowsOf()).map((r) => r.at)).toEqual([1000, 2000, 3000])
  })

  it('pages by keyset over (at, id) and stops with a null cursor', async () => {
    const first = await listSchedules(env.DB, { limit: 2 })
    expect(first.rows.map((r) => r.at)).toEqual([1000, 2000])
    expect(first.cursor).not.toBeNull()

    const second = await listSchedules(env.DB, { limit: 2, cursor: first.cursor! })
    expect(second.rows.map((r) => r.at)).toEqual([3000])
    expect(second.cursor).toBeNull()
  })

  it('filters by document, action and status; `total` counts the filter, not the page', async () => {
    expect((await listSchedules(env.DB, { storyId: 'sty_about' })).rows).toHaveLength(1)
    expect(
      (await listSchedules(env.DB, { action: 'unpublish' })).rows.map((r) => r.storyId),
    ).toEqual(['sty_team'])
    expect((await listSchedules(env.DB, { status: 'failed' })).rows).toEqual([])

    const counted = await listSchedules(env.DB, { limit: 1, count: true })
    expect(counted.rows).toHaveLength(1)
    expect(counted.total).toBe(3)
  })

  it('omits `total` unless asked, so a cursor walk drags no aggregate', async () => {
    expect(await listSchedules(env.DB, { limit: 1 })).not.toHaveProperty('total')
  })
})

/* --------------------------------------------------------- the sweep --- */

describe('runSchedules', () => {
  it('fires a due publish through the real workflow, then deletes the row', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000, actor: 'usr_alice' })

    const report = await runSchedules(deps(), { now: 2000 })

    expect(report.due).toBe(1)
    expect(report.published).toEqual(['sty_about'])
    expect(report.failed).toEqual([])
    expect(report.remaining).toBe(0)

    const story = await storyById(env.DB, 'sty_about')
    expect(story?.state).toBe('live')
    // The published watermark is the syncId the draft was read at, not a guess:
    // this is the same `publish()` the editor's button calls.
    expect(story?.publishedSyncId).toBe(7)
    // A retained version, attributed to whoever scheduled it rather than to the
    // cron that ran. That attribution is why there is no 'done' status: the
    // version row *is* the record of what happened.
    const version = await env.DB.prepare(
      'select kind, actor, title from versions where story_id = ?',
    )
      .bind('sty_about')
      .first<{ kind: string; actor: string; title: string }>()
    expect(version).toEqual({ kind: 'publish', actor: 'usr_alice', title: 'About' })

    // The row is gone rather than marked done.
    expect(await rowsOf()).toEqual([])
  })

  it('leaves a schedule that is not yet due completely alone', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 9000 })

    const report = await runSchedules(deps(), { now: 8999 })

    expect(report).toMatchObject({ due: 0, published: [], remaining: 0, continueFrom: null })
    expect((await rowsOf()).map((r) => r.status)).toEqual(['pending'])
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('draft')
  })

  it('fires exactly at the due instant, so a schedule is never early', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 5000 })
    expect((await runSchedules(deps(), { now: 4999 })).due).toBe(0)
    expect((await runSchedules(deps(), { now: 5000 })).due).toBe(1)
  })

  it('fires a due unpublish without ever reading the draft', async () => {
    await publish(deps(), 'sty_about', 'usr_alice')
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('live')

    await schedule({ storyId: 'sty_about', action: 'unpublish', at: 1000, actor: 'usr_bob' })
    const d = deps()
    const report = await runSchedules(d, { now: 2000 })

    expect(report.unpublished).toEqual(['sty_about'])
    // `unpublish` is the one workflow that touches no Durable Object, and a
    // scheduled one inherits that.
    expect(d.draws).toBe(0)
    const story = await storyById(env.DB, 'sty_about')
    expect(story?.state).toBe('unpublished')
    const raw = await env.DB.prepare('select unpublished_by from stories where id = ?')
      .bind('sty_about')
      .first<{ unpublished_by: string }>()
    expect(raw?.unpublished_by).toBe('usr_bob')
    expect(await rowsOf()).toEqual([])
  })

  it('publishes a campaign window in due order: up on Tuesday, down on Friday', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_about', action: 'unpublish', at: 5000 })

    expect((await runSchedules(deps(), { now: 1000 })).published).toEqual(['sty_about'])
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('live')
    // Still one pending row, and it is the one that has not come due.
    expect((await rowsOf()).map((r) => r.action)).toEqual(['unpublish'])

    expect((await runSchedules(deps(), { now: 5000 })).unpublished).toEqual(['sty_about'])
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('unpublished')
    expect(await rowsOf()).toEqual([])
  })

  /**
   * Architecture decision 4. Publishing by hand on Monday says "make it live now";
   * it does not say "and never publish again on Tuesday" — and Tuesday's publish
   * snapshots whatever the draft is *then*, which is a different document if anybody
   * edited in between. Cancelling on the editor's behalf would mean those edits
   * silently never went live.
   */
  it('leaves a schedule standing when somebody publishes by hand first', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 5000 })
    await publish(deps(), 'sty_about', 'usr_alice')
    expect(await versionCount('sty_about')).toBe(1)
    // The manual publish did not touch the schedule.
    expect((await rowsOf()).map((r) => r.status)).toEqual(['pending'])

    const report = await runSchedules(deps(), { now: 5000 })
    expect(report.published).toEqual(['sty_about'])
    // A second retained version, which is the honest record: two publishes happened.
    expect(await versionCount('sty_about')).toBe(2)
  })

  it('drops a schedule whose document has been deleted, rather than failing it three times', async () => {
    await schedule({ storyId: 'sty_team', action: 'publish', at: 1000 })
    // Around the normal path on purpose: `deleteStoryStatement` batches the schedule
    // cleanup, so this is the *race* — a delete that lands between the sweep's read
    // and its publish — plus a schedule written by a script for an id that never
    // existed.
    await env.DB.prepare('delete from stories where id = ?').bind('sty_team').run()

    const report = await runSchedules(deps(), { now: 2000 })

    expect(report.dropped).toHaveLength(1)
    expect(report.failed).toEqual([])
    expect(report.published).toEqual([])
    expect(await rowsOf()).toEqual([])
  })

  it('retries a transient failure, then gives up and says why', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    const broken: PublishDeps = {
      ...deps(),
      draftWithSyncId: async () => {
        throw new Error('the object is unreachable')
      },
    }

    for (let attempt = 1; attempt < MAX_SCHEDULE_ATTEMPTS; attempt++) {
      const report = await runSchedules(broken, { now: 2000 })
      expect(report.failed).toHaveLength(1)
      expect(report.failed[0]).toMatchObject({ attempts: attempt, givenUp: false })
      // Still pending, so the next sweep tries again — which is what a blip wants.
      const rows = await rowsOf()
      expect(rows[0]?.status).toBe('pending')
      expect(rows[0]?.attempts).toBe(attempt)
      expect(rows[0]?.lastError).toBe('the object is unreachable')
    }

    const final = await runSchedules(broken, { now: 2000 })
    expect(final.failed[0]).toMatchObject({ attempts: MAX_SCHEDULE_ATTEMPTS, givenUp: true })
    // Retained rather than deleted: a failure is recorded nowhere else, and a
    // schedule nobody can see fail is the bug this feature has.
    const rows = await rowsOf()
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.lastError).toBe('the object is unreachable')

    // And it stops: the next sweep does not see it at all.
    expect((await runSchedules(broken, { now: 2000 })).due).toBe(0)
  })

  it('does not let one failing document skip the rest of the batch', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_home', action: 'publish', at: 2000 })

    const flaky: PublishDeps = {
      ...deps(),
      draftWithSyncId: async (story) => {
        if (story.id === 'sty_about') throw new Error('this one is broken')
        return { doc: pageDoc(story.title), syncId: 3 }
      },
    }

    const report = await runSchedules(flaky, { now: 3000 })

    expect(report.due).toBe(2)
    expect(report.failed.map((f) => f.storyId)).toEqual(['sty_about'])
    // The story *after* the broken one still went live, which is the whole point.
    expect(report.published).toEqual(['sty_home'])
    expect((await storyById(env.DB, 'sty_home'))?.state).toBe('live')
  })

  it('refuses an action nothing declares, and keeps the row rather than deleting it', async () => {
    // `schedules.action` carries no CHECK constraint on purpose, so the guard is in
    // the runner. Failed rather than dropped: the row is somebody's instruction, and
    // deleting one this code does not understand is not this code's call.
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await env.DB.prepare("update schedules set action = 'archive'").run()

    const report = await runSchedules(deps(), { now: 2000 })

    expect(report.failed[0]?.reason).toMatch(/Unknown schedule action/)
    expect(report.dropped).toEqual([])
    expect(await rowsOf()).toHaveLength(1)
  })

  it('dry-runs: reports the intent and writes nothing at all', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })

    const report = await runSchedules(deps(), { now: 2000, dryRun: true })

    expect(report).toMatchObject({ due: 1, published: ['sty_about'], dryRun: true })
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('draft')
    expect(await versionCount('sty_about')).toBe(0)
    expect((await rowsOf()).map((r) => r.status)).toEqual(['pending'])
  })

  it('batches and resumes: one call answers a cursor, the next finishes the backlog', async () => {
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_home', action: 'publish', at: 2000 })
    await schedule({ storyId: 'sty_team', action: 'publish', at: 3000 })

    const first = await runSchedules(deps(), { now: 4000, batch: 2 })
    expect(first.published).toEqual(['sty_about', 'sty_home'])
    expect(first.continueFrom).not.toBeNull()
    // `remaining` is asked directly after the run, so it is right across batches.
    expect(first.remaining).toBe(1)

    const second = await runSchedules(deps(), {
      now: 4000,
      batch: 2,
      continueFrom: first.continueFrom,
    })
    expect(second.published).toEqual(['sty_team'])
    expect(second.continueFrom).toBeNull()
    expect(second.remaining).toBe(0)
    expect(await rowsOf()).toEqual([])
  })

  it('makes progress past a row that keeps failing, which is why the cursor exists at all', async () => {
    // A schedule that fires is deleted, so the due set shrinks as the sweep walks it
    // and a cursorless sweep would be correct — except that a transient failure
    // leaves a row pending and still due, so it would be retried forever inside one
    // run and the rows behind it never reached.
    await schedule({ storyId: 'sty_about', action: 'publish', at: 1000 })
    await schedule({ storyId: 'sty_home', action: 'publish', at: 2000 })
    const flaky: PublishDeps = {
      ...deps(),
      draftWithSyncId: async (story) => {
        if (story.id === 'sty_about') throw new Error('stuck')
        return { doc: pageDoc(story.title), syncId: 1 }
      },
    }

    const first = await runSchedules(flaky, { now: 3000, batch: 1 })
    expect(first.failed).toHaveLength(1)
    expect(first.continueFrom).not.toBeNull()

    const second = await runSchedules(flaky, {
      now: 3000,
      batch: 1,
      continueFrom: first.continueFrom,
    })
    expect(second.published).toEqual(['sty_home'])

    // A *resumed* call that finds nothing after its cursor must still ask how much
    // is left, which is the one case the empty-read shortcut cannot take: the stuck
    // row is *behind* the cursor, pending and still due. The cursor is built by hand
    // because reaching this state through the loop is impossible — the sweep answers
    // a null cursor on its last page, and a null cursor means "start again".
    const past = encodeCursor([99_999, 'sch_zzzzzzzzzzzz'])
    const third = await runSchedules(flaky, { now: 3000, batch: 1, continueFrom: past })
    expect(third).toMatchObject({ due: 0, continueFrom: null, remaining: 1 })
    // And the shortcut is still a shortcut: unresumed, it answers 0 reads later.
    expect((await runSchedules(deps(), { now: 0 })).remaining).toBe(0)
  })

  it('costs one indexed read on a site with nothing scheduled', async () => {
    // The claim `0003_schedules.sql` makes about the partial index, from the other
    // side: no rows, no cursor, no work, and a report that says so.
    expect(await runSchedules(deps(), { now: Date.now() })).toEqual({
      due: 0,
      published: [],
      unpublished: [],
      dropped: [],
      failed: [],
      dryRun: false,
      continueFrom: null,
      remaining: 0,
    })
  })
})

/* ------------------------------------------------------- the cleanup --- */

describe('a schedule does not outlive its story', () => {
  it('goes in the same batch as the delete, unlike a redirect', async () => {
    await schedule({ storyId: 'sty_team', action: 'publish', at: 9000 })
    await schedule({ storyId: 'sty_about', action: 'publish', at: 9000 })

    // `sty_team` is a child of `sty_about`, so this deletes both.
    expect(await deleteStory(env.DB, 'sty_about')).toEqual(
      expect.arrayContaining(['sty_about', 'sty_team']),
    )
    expect(await rowsOf()).toEqual([])
  })

  it('leaves other documents’ schedules alone', async () => {
    await schedule({ storyId: 'sty_team', action: 'publish', at: 9000 })
    await schedule({ storyId: 'sty_home', action: 'publish', at: 9000 })

    await deleteStory(env.DB, 'sty_team')

    expect((await rowsOf()).map((r) => r.storyId)).toEqual(['sty_home'])
  })
})

/* ---------------------------------------------------------- the routes --- */

describe('the schedule routes', () => {
  const post = (path: string, body?: unknown) =>
    SELF.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('schedules a publish and answers 201 with the row', async () => {
    const at = Date.now() + 60_000
    const res = await post('/story/sty_about/schedule', { action: 'publish', at })

    expect(res.status).toBe(201)
    const row = await res.json<Schedule>()
    expect(row).toMatchObject({ storyId: 'sty_about', action: 'publish', at, status: 'pending' })
    expect(row.id).toMatch(/^sch_[0-9a-f]{12}$/)
    // `auth: 'open'` in this fixture, so there is genuinely nobody to attribute to.
    expect(row.actor).toBeNull()
  })

  it('404s for a document that does not exist, before writing anything', async () => {
    const res = await post('/story/sty_nope/schedule', { action: 'publish', at: Date.now() + 1000 })
    expect(res.status).toBe(404)
    expect(await rowsOf()).toEqual([])
  })

  it('400s a time in the past, naming what to do instead', async () => {
    const res = await post('/story/sty_about/schedule', { action: 'publish', at: 1000 })
    expect(res.status).toBe(400)
    const body = await res.json<{ error: { code: string; message: string } }>()
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toMatch(/Publish now instead/)
  })

  it('400s an action nothing declares, naming the two that exist', async () => {
    const res = await post('/story/sty_about/schedule', {
      action: 'archive',
      at: Date.now() + 1000,
    })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: { message: string } }>()).error.message).toMatch(
      /publish, unpublish/,
    )
  })

  it('lists what is scheduled, soonest first, and filters by document', async () => {
    const soon = Date.now() + 60_000
    await post('/story/sty_about/schedule', { action: 'publish', at: soon + 1000 })
    await post('/story/sty_home/schedule', { action: 'publish', at: soon })

    const all = await (await SELF.fetch(`${API}/schedules?count=1`)).json<Page<Schedule>>()
    expect(all.rows.map((r) => r.storyId)).toEqual(['sty_home', 'sty_about'])
    expect(all.total).toBe(2)

    const one = await (await SELF.fetch(`${API}/schedules?story=sty_about`)).json<Page<Schedule>>()
    expect(one.rows.map((r) => r.storyId)).toEqual(['sty_about'])
  })

  it('refuses a malformed cursor with a 400 rather than a silent first page', async () => {
    const res = await SELF.fetch(`${API}/schedules?cursor=not-a-cursor`)
    expect(res.status).toBe(400)
  })

  it('cancels one action, and requires the caller to say which', async () => {
    const at = Date.now() + 60_000
    await post('/story/sty_about/schedule', { action: 'publish', at })
    await post('/story/sty_about/schedule', { action: 'unpublish', at: at + 1000 })

    // A campaign window has two schedules, so guessing which one "cancel" meant is
    // how an embargo silently stops ending.
    const vague = await SELF.fetch(`${API}/story/sty_about/schedule`, { method: 'DELETE' })
    expect(vague.status).toBe(400)

    const res = await SELF.fetch(`${API}/story/sty_about/schedule?action=publish`, {
      method: 'DELETE',
    })
    expect(await res.json()).toEqual({ deleted: 1 })
    expect((await rowsOf()).map((r) => r.action)).toEqual(['unpublish'])

    // Idempotent: asking again is `0`, not a 404.
    const again = await SELF.fetch(`${API}/story/sty_about/schedule?action=publish`, {
      method: 'DELETE',
    })
    expect(await again.json()).toEqual({ deleted: 0 })
  })

  /**
   * Backdating the row in D1 rather than sleeping, and the reason is workerd's
   * clock: `Date.now()` inside a Worker only advances at I/O boundaries, so a
   * schedule set a few milliseconds ahead and then slept past is *not* reliably due
   * from inside the next invocation — it passed alone and failed under the full
   * suite, twice, before this. The route deliberately will not read `now` off the
   * body (that would let a publisher bring every future schedule on the site
   * forward), so the fixture moves the row instead of the clock. The due-instant
   * boundary itself is pinned with an injected `now` in the sweep block above.
   */
  const backdate = () => env.DB.prepare('update schedules set at = 1').run()

  it('fires what is due over the run route, and the page goes live', async () => {
    await post('/story/sty_about/schedule', { action: 'publish', at: Date.now() + 60_000 })
    await backdate()

    const report = await (await post('/schedules/run')).json<{
      published: string[]
      remaining: number
    }>()
    expect(report.published).toEqual(['sty_about'])
    expect(report.remaining).toBe(0)

    // The published page serves, through the host's own fetch handler.
    const page = await SELF.fetch(`${ORIGIN}/about`)
    expect(page.status).toBe(200)
    expect(await rowsOf()).toEqual([])
  })

  it('answers an empty body as "sweep the first batch", which is what a curl writes', async () => {
    const report = await (await post('/schedules/run')).json<{ due: number; dryRun: boolean }>()
    expect(report).toMatchObject({ due: 0, dryRun: false })
  })

  it('dry-runs from the route too', async () => {
    await post('/story/sty_about/schedule', { action: 'publish', at: Date.now() + 60_000 })
    await backdate()

    const report = await (await post('/schedules/run', { dryRun: true })).json<{
      published: string[]
      dryRun: boolean
    }>()
    expect(report).toMatchObject({ published: ['sty_about'], dryRun: true })
    expect((await storyById(env.DB, 'sty_about'))?.state).toBe('draft')
  })

  it('clears a document’s schedules when it is deleted through the API', async () => {
    await post('/story/sty_team/schedule', { action: 'publish', at: Date.now() + 60_000 })
    const res = await SELF.fetch(`${API}/stories/sty_team`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await rowsOf()).toEqual([])
  })
})
