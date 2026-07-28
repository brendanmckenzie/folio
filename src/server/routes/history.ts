/**
 * The two halves of a story's history, deliberately not conflated: versions in
 * D1 (coarse, restorable) and the activity trail from the Durable Object's
 * mutation log (fine-grained, not restorable).
 */
import { Hono } from 'hono'
import { FolioError } from '../errors'
import { loadStory } from '../middleware'
import { checkpoint } from '../publish'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { CheckpointBody, idParam, limitParam, parseOptionalBody } from '../validate'
import { getVersion, listVersions } from '../versions'

export function historyRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  // Deliberately no existence check: a story with no versions and a story that
  // never existed both have an empty history.
  app.get('/story/:id/versions', async (c) =>
    c.json(await listVersions(c.var.bindings().db, idParam('id', c.req.param('id')))),
  )

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
  app.post('/story/:id/versions', loadStory<Env>(), async (c) => {
    const body = await parseOptionalBody(c.req, CheckpointBody)
    return c.json(await checkpoint(rt.publishDeps(c.var.bindings()), c.var.story, body))
  })

  /**
   * Returns the version's document. Restoring happens on the client: it diffs
   * the live document against this one and applies the result as a single
   * transaction, so a restore syncs to other editors and can be undone.
   */
  app.get('/versions/:versionId', async (c) => {
    const found = await getVersion(
      c.var.bindings().db,
      idParam('versionId', c.req.param('versionId')),
    )
    if (!found) throw new FolioError('not_found', 'Unknown version')
    return c.json(found)
  })

  app.get('/story/:id/activity', loadStory<Env>(), async (c) =>
    c.json(
      await rt
        .stub(c.var.bindings(), c.var.story.id)
        .recent(limitParam(c.req.query('limit'), 60, 200)),
    ),
  )

  return app
}
