/**
 * The forms an editor builds: list, create, read, save, delete, and what a
 * delete would break (`../../../docs/specs/content-model/forms.md` phase 2).
 *
 * **All under `{base}/api`, none under `{base}/api/v1`** (checkpoint 20). A
 * version segment is a promise to somebody's script and nobody has asked for
 * this one; the `submitted` hook is the entire programmatic surface for a host,
 * and adding a versioned route later is additive.
 * `test/workers/api-partition.test.ts` pins the split.
 *
 * The public submit route is deliberately *not* here: it lives on the bare mount
 * beside `assetFileRoutes`, because a browser navigates to it and its URL is
 * baked into published HTML (decision 3). It is phase 4's.
 *
 * Three access levels, and the ladder is checkpoint 8's: building a form is
 * `EDIT`, reading one is `READ`, and only `ADMIN` may destroy one — because a
 * form's delete takes every response with it.
 */
import { Hono } from 'hono'
import { actorString, ADMIN, EDIT, READ } from '../auth/roles'
import { FolioError } from '../errors'
import {
  createForm,
  deleteForm,
  formById,
  formMeta,
  formUsage,
  listForms,
  updateForm,
} from '../forms'
import { hookCtx, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import {
  FormCreateBody,
  FormPatchBody,
  formIdParam,
  limitParam,
  parseBody,
  requireCursor,
} from '../validate'

export function formRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Most recently changed first, keyset-paged
   * (`../../../docs/specs/foundation/pagination.md`).
   *
   * Two opt-in aggregates rather than one, because they cost different things.
   * `?count=1` is a `count(*)` over `forms`, a table bounded by what a person
   * will build; `?counts=1` is a grouped read of `form_responses`, which is
   * unbounded and grows for as long as the site is up. The list screen asks for
   * both; a client walking the cursor should ask for neither.
   */
  app.get('/forms', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    return c.json(
      await listForms(db, {
        limit: limitParam(c.req.query('limit'), 50, 200),
        cursor,
        count: c.req.query('count') === '1',
        counts: c.req.query('counts') === '1',
      }),
    )
  })

  /**
   * A new, empty form. `EDIT`, not `MANAGE`: a form with no questions is
   * reachable from nothing and breaks nothing, the same reading that put
   * `CREATE` at editor for documents.
   */
  app.post('/forms', requireAccess<Env>(rt, EDIT), async (c) => {
    const body = await parseBody(c.req, FormCreateBody)
    const form = await createForm(c.var.bindings().db, body)
    return c.json(form, 201)
  })

  app.get('/forms/:id', requireAccess<Env>(rt, READ), async (c) => {
    const form = await formById(c.var.bindings().db, formIdParam(c.req.param('id')))
    if (!form) throw new FolioError('not_found', 'Unknown form')
    return c.json(form)
  })

  /**
   * A builder save.
   *
   * **`formChanged` fires only on a structural save**, which is what makes the
   * purge honest: a page cached for a week holds the old markup, and if the form
   * gained a required field every cached visitor would submit something the live
   * form refuses and see an error they could not possibly fix. A label edit
   * changes no constraint, so it purges nothing (decision 7).
   *
   * The 409 for a stale `expectedUpdatedAt` comes out of `updateForm`, where the
   * guard is part of the `update` rather than a read in front of it.
   */
  app.patch('/forms/:id', requireAccess<Env>(rt, EDIT), async (c) => {
    const id = formIdParam(c.req.param('id'))
    const body = await parseBody(c.req, FormPatchBody)
    const result = await updateForm(c.var.bindings().db, id, body)
    if (!result) throw new FolioError('not_found', 'Unknown form')

    if (result.structural) {
      await rt.hookRunner(hookCtx(c)).run('formChanged', {
        form: formMeta(result.form),
        version: result.form.version,
        actor: actorString(c.var.actor),
      })
    }
    return c.json(result.form)
  })

  /**
   * The form, its responses and their files — all of it, and the counts of what
   * went.
   *
   * **`ADMIN`, and it cascades** (checkpoint 17). The alternative considered and
   * rejected was refusing while a count is non-zero, which leaves an editor
   * unable to remove a finished campaign at all. What makes the cascade safe is
   * that it is never a surprise: `GET /forms/:id/usage` answers all three
   * numbers the dialog names, in one call, before anything is destroyed.
   */
  app.delete('/forms/:id', requireAccess<Env>(rt, ADMIN), async (c) => {
    const id = formIdParam(c.req.param('id'))
    const result = await deleteForm(c.var.bindings().db, id)
    if (!result.deleted) throw new FolioError('not_found', 'Unknown form')
    return c.json(result)
  })

  /**
   * What a delete would break and what it would destroy: the published documents
   * that render this form, and the responses and files that go with it.
   *
   * **`EDIT`, matching `GET {base}/api/assets/:id/usage` exactly** — it reports
   * on published content an editor can already read, so the lower bar leaks
   * nothing. The delete it precedes is `ADMIN`, which is the one place the two
   * usage routes differ in consequence rather than in shape.
   *
   * It **404s an unknown id** rather than answering an empty usage, for the
   * asset route's reason: the row has to be read to answer at all, and "no such
   * form" is a more useful answer than "used by nobody" for a stale link.
   */
  app.get('/forms/:id/usage', requireAccess<Env>(rt, EDIT), async (c) => {
    const db = c.var.bindings().db
    const id = formIdParam(c.req.param('id'))
    const form = await formById(db, id)
    if (!form) throw new FolioError('not_found', 'Unknown form')

    const usage = await formUsage(db, id)
    return c.json({
      published: usage.published.map((story) => ({
        id: story.id,
        title: story.title,
        path: story.path,
        // `''` rather than absent for an unrouted document, matching both other
        // usage routes: a record embedding a form has no URL to offer.
        url: rt.withUrls(story).url ?? '',
      })),
      total: usage.total,
      responses: usage.responses,
      files: usage.files,
    })
  })

  return app
}
