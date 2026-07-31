/**
 * The two halves of a story's history, deliberately not conflated: versions in
 * D1 (coarse, restorable) and the activity trail from the Durable Object's
 * mutation log (fine-grained, not restorable).
 */
import { Hono } from 'hono'
import { actorString, PUBLISH, READ, READ_DRAFT } from '../auth/roles'
import { FolioError } from '../errors'
import { hookCtx, loadStory, requireAccess } from '../middleware'
import { checkpoint } from '../publish'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { CheckpointBody, idParam, limitParam, parseOptionalBody, requireCursor } from '../validate'
import { getVersion, listVersions } from '../versions'

export function historyRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  // Deliberately no existence check: a story with no versions and a story that
  // never existed both have an empty history.
  app.get('/story/:id/versions', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listVersions(c.var.bindings().db, idParam('id', c.req.param('id')), {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
      }),
    )
  })

  /**
   * `loadStory` ahead of the body, not after it: an id that names nothing is a
   * 404 whatever the body turns out to be, and validating first would answer a
   * bad body on a story that does not exist with a 400 instead — a different
   * answer to the same request than this route has ever given. It also means an
   * unknown story is refused before its request body is read at all.
   *
   * The row that middleware found is handed to the workflow, which would
   * otherwise look the same row up again: `checkpoint` takes an id when the
   * caller only has one (a scheduled checkpoint has no route to have loaded it)
   * and the row when the caller already does.
   */
  app.post('/story/:id/versions', requireAccess<Env>(rt, PUBLISH), loadStory<Env>(), async (c) => {
    const body = await parseOptionalBody(c.req, CheckpointBody)
    const deps = rt.publishDeps(c.var.bindings(), hookCtx(c))
    // `actor` comes off the session, never off the body: the client used to
    // send its own display name here, which made "who checkpointed this" a
    // field anybody could type into.
    return c.json(
      await checkpoint(deps, c.var.story, { label: body.label, actor: actorString(c.var.actor) }),
    )
  })

  /**
   * Returns the version's document. Restoring happens on the client: it diffs
   * the live document against this one and applies the result as a single
   * transaction, so a restore syncs to other editors and can be undone.
   *
   * The document is **migrated on read** (`schema-migrations.md` checkpoint 3):
   * the stored row is never rewritten, so history stays byte-true, and the
   * restore's `diff(live, target)` is computed between two documents in the same
   * shape. Without it a restore across a migration would reintroduce
   * pre-migration keys — the subtle bug that decision exists to avoid.
   */
  app.get('/versions/:versionId', requireAccess<Env>(rt, READ_DRAFT), async (c) => {
    const found = await getVersion(
      c.var.bindings().db,
      idParam('versionId', c.req.param('versionId')),
      { migrations: rt.migrations, schema: rt.schema, typeOf: rt.typeOf },
    )
    if (!found) throw new FolioError('not_found', 'Unknown version')
    return c.json(found)
  })

  /**
   * The activity trail, paged — the same `Page<T>` envelope as the versions route
   * above it, which is the whole of this change.
   *
   * `foundation/pagination.md` phase 4 named both and converted only versions, so
   * for one commit the two routes beside each other on the same panel answered
   * different shapes: `versions.rows` and `activity` as a bare array. That reads as
   * an oversight in whoever consumes them and was a real difference in the routes.
   */
  app.get('/story/:id/activity', requireAccess<Env>(rt, READ), loadStory<Env>(), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await rt
        .stub(c.var.bindings(), c.var.story.id)
        .recent(limitParam(c.req.query('limit'), 60, 200), cursor),
    )
  })

  return app
}
