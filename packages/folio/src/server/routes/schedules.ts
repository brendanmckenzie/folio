/**
 * Scheduled publish and unpublish over HTTP
 * (`../../../../docs/specs/platform/scheduled-publishing.md`).
 *
 * Four routes, and the fourth is the one worth defending: **a schedule nobody can
 * list is a schedule nobody trusts.** An editor who sets a publish for Tuesday and
 * cannot then see it, or cannot see that it failed at 3am, has not been given a
 * feature — they have been given a promise with no receipt. `GET /schedules` is
 * that receipt, and it is why the failed rows are retained at all
 * (`core/story.ts`'s `ScheduleStatus`).
 *
 * The write routes are gated on `PUBLISH`, matching `POST /story/:id/publish`
 * exactly: scheduling a publish *is* publishing, with a delay, and the ability to
 * take the site down on Friday is the same privilege as taking it down now. The
 * read is `READ`, matching every other list route — a schedule is metadata about a
 * row `GET /stories` already returns to a viewer, and knowing that a draft is due
 * to go live discloses nothing the state chip beside it does not.
 */
import { Hono } from 'hono'
import { actorString, PUBLISH, READ } from '../auth/roles'
import { hookCtx, loadStory, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import {
  checkScheduleTime,
  clearSchedule,
  listSchedules,
  setScheduleStatements,
} from '../schedules'
import { runSchedules } from '../scheduler'
import type { FolioEnv } from '../types'
import {
  idParam,
  limitParam,
  parseBody,
  parseOptionalBody,
  requireCursor,
  RunSchedulesBody,
  ScheduleBody,
  scheduleActionFilter,
  scheduleActionQuery,
  scheduleStatusQuery,
} from '../validate'

export function scheduleRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * What is scheduled: soonest first, paged, filterable by document, status and
   * action.
   *
   * One route rather than a site-wide list plus a per-document one, because
   * `?story=` is the only difference between them and the shape is identical —
   * the same instinct that gave `GET {base}/api/search` one route for the palette
   * and both pickers.
   *
   * Rows carry **no title and no path**, deliberately: resolving a batch of ids to
   * rows is `GET {base}/api/stories?ids=`'s job
   * (`../../../../docs/specs/foundation/pagination.md` decision 7), and joining
   * `stories` here would denormalise two columns into a reader with no other use
   * for them. A screen drawing a schedule is drawing a document it can already
   * name. See `core/story.ts`'s `Schedule`.
   */
  app.get('/schedules', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const story = c.req.query('story')
    const status = scheduleStatusQuery(c.req.query('status'))
    const action = scheduleActionFilter(c.req.query('action'))
    // Spread rather than assigned, so an absent filter is an absent key rather
    // than `undefined` — `listSchedules` reads presence, and the same discipline
    // `storyFilterQuery` follows.
    return c.json(
      await listSchedules(c.var.bindings().db, {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        ...(story ? { storyId: idParam('story', story) } : {}),
        ...(status ? { status } : {}),
        ...(action ? { action } : {}),
        count: c.req.query('count') === '1',
      }),
    )
  })

  /**
   * Schedule a publish or an unpublish, replacing whatever was pending for the
   * same document and action.
   *
   * `loadStory` first, so an unknown id 404s before anything is written — and
   * because a schedule for a document that does not exist is the one input this
   * route can refuse outright rather than discovering at 3am.
   *
   * **Nothing about the document's current state is checked**, and that is not an
   * omission. Scheduling an unpublish for a draft is exactly the campaign case (it
   * will be published on Tuesday and must come down on Friday), and refusing it
   * would break the main use for the feature. Scheduling a publish for something
   * already live is the ordinary case too: an editor is saying "publish the edits I
   * make between now and Tuesday".
   */
  app.post('/story/:id/schedule', requireAccess<Env>(rt, PUBLISH), loadStory<Env>(), async (c) => {
    const body = await parseBody(c.req, ScheduleBody)
    const bindings = c.var.bindings()
    // Checked before the write and before the row is built: the past/horizon rule
    // needs the current time, which a valibot schema does not have.
    checkScheduleTime(body.at, Date.now())

    const { schedule, statements } = setScheduleStatements(bindings.db, {
      storyId: c.var.story.id,
      action: body.action,
      at: body.at,
      // Off the session, never the body. The sweep passes this straight to
      // `publish(deps, story, actor)`, so the version row and the `published`
      // hook name the person who asked rather than the cron that ran.
      actor: actorString(c.var.actor),
    })
    // One batch: the delete and the insert must land together, or a crash between
    // them leaves the document with no schedule where it had one — a silent
    // cancellation, which is the failure this feature cannot have.
    await bindings.db.batch(statements)

    return c.json(schedule, 201)
  })

  /**
   * Cancel a document's schedule for one action.
   *
   * `?action=` is **required** rather than defaulting to `publish`: a campaign
   * window has two schedules, and guessing which one "cancel" meant is how an
   * embargo silently stops ending.
   *
   * Answers `{ deleted: n }` rather than 404ing when nothing was scheduled, the
   * same shape `DELETE /redirects/:from` uses and for the same reason: the caller
   * asked for a state of the world and got it. No `loadStory` either — cancelling a
   * schedule for a document that has since been deleted should succeed, not 404 on
   * the way to doing nothing.
   */
  app.delete('/story/:id/schedule', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const id = idParam('id', c.req.param('id'))
    const action = scheduleActionQuery(c.req.query('action'))
    return c.json({ deleted: await clearSchedule(c.var.bindings().db, id, action) })
  })

  /**
   * Fire one batch of whatever is due, and answer a report with a `continueFrom`
   * cursor; the caller re-calls until it is null.
   *
   * **A cron trigger is the mechanism and this route is not it.** It exists for
   * three narrower reasons: an operator whose cron did not fire wants to catch up
   * without waiting for the next tick; a host that has adopted the routes but not
   * yet added `triggers.crons` to its `wrangler.jsonc` is otherwise stuck with a
   * table of schedules nothing reads; and `scripts/scheduled-test.mjs` needs a
   * deterministic trigger, because a live server cannot be asked to wait a minute
   * per assertion. It is exactly the `POST {base}/api/migrate` precedent.
   *
   * `PUBLISH`, not `ADMIN`: everything it can do, it does by calling the same
   * `publish` and `unpublish` a `publisher` can already call directly. It fires
   * only what is *already due*, and there is no way to ask it to bring the future
   * forward — `ScheduleRunOptions.now` is not readable off the body, which
   * `RunSchedulesBody` says why.
   */
  app.post('/schedules/run', requireAccess<Env>(rt, PUBLISH), async (c) => {
    const body = await parseOptionalBody(c.req, RunSchedulesBody)
    requireCursor(body.continueFrom ?? undefined)
    return c.json(
      // `batch` is bounded twice and neither is redundant: `RunSchedulesBody`
      // bounds what reaches the D1 `limit`, and `runSchedules` clamps what one
      // call will actually attempt — the same pairing `POST /migrate` uses.
      await runSchedules(rt.publishDeps(c.var.bindings(), hookCtx(c)), {
        dryRun: body.dryRun,
        continueFrom: body.continueFrom,
        batch: body.batch,
      }),
    )
  })

  return app
}
