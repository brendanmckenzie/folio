/**
 * Manual redirects: list, add, remove. Automatic ones (a rename, a move, a
 * delete with the option checked) are written by stories.ts and never come
 * through here — see redirects.ts's module comment for why the two paths
 * stay distinct.
 */
import { Hono } from 'hono'
import { MANAGE, READ } from '../auth/roles'
import { FolioError } from '../errors'
import { requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import {
  deleteRedirect,
  listRedirects,
  lookupRedirect,
  normalisePath,
  type Redirect,
  upsertRedirect,
} from '../redirects'
import { storyByPath } from '../stories'
import type { FolioEnv } from '../types'
import { limitParam, parseBody, RedirectCreateBody } from '../validate'

/** True when `to` already redirects straight back to `from` — the one loop a
 * manual add can create that decision 3's write-time collapse never sees,
 * because there is no path being vacated here for that collapse to run on. */
async function pointsBackAt(
  db: D1Database,
  to: string,
  from: string,
): Promise<Redirect['to'] | null> {
  const back = await lookupRedirect(db, to)
  return back && normalisePath(back.to) === from ? back.to : null
}

export function redirectRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/redirects', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db
    const limit = limitParam(c.req.query('limit'), 50, 200)
    const cursor = c.req.query('cursor')
    const source = c.req.query('source')
    return c.json(
      await listRedirects(db, {
        limit,
        cursor,
        source: source === 'auto' || source === 'manual' ? source : undefined,
      }),
    )
  })

  /**
   * A redirect that can never fire is a trap, not a row, so two things are
   * checked before anything is written: `from` must not be a path a story
   * currently occupies (of any state — a draft sitting there is still a trap,
   * not only a published page), and `to` must not already redirect straight
   * back to `from`, which is the one loop a manual add can create (auto rows
   * cannot loop by construction — decision 3).
   */
  app.post('/redirects', requireAccess<Env>(rt, MANAGE), async (c) => {
    const db = c.var.bindings().db
    const body = await parseBody(c.req, RedirectCreateBody)
    const from = normalisePath(body.from)

    const occupied = await storyByPath(db, from)
    if (occupied) {
      throw new FolioError(
        'conflict',
        `"${occupied.title}" already lives at /${from}. Rename or move it first.`,
      )
    }

    const loopsBackTo = await pointsBackAt(db, body.to, from)
    if (loopsBackTo !== null) {
      throw new FolioError(
        'conflict',
        `That target already redirects back to /${from || '/'}; adding this row would loop.`,
      )
    }

    const redirect = await upsertRedirect(db, {
      from: body.from,
      to: body.to,
      status: body.status,
    })
    return c.json(redirect, 201)
  })

  // `{.+}` so a multi-segment path (`services/strategy`) arrives whole rather
  // than being cut at the first slash, the way a bare `:from` would.
  app.delete('/redirects/:from{.+}', requireAccess<Env>(rt, MANAGE), async (c) => {
    const removed = await deleteRedirect(c.var.bindings().db, c.req.param('from'))
    return c.json({ deleted: removed })
  })

  return app
}
