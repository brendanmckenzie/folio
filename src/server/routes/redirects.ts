/**
 * Manual redirects: list, add, remove. Automatic ones (a rename, a move, a
 * delete with the option checked) are written by stories.ts and never come
 * through here — see redirects.ts's module comment for why the two paths
 * stay distinct.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { decodeCursor } from '../../core/pagination'
import { DEFAULT_SITE } from '../../core/sites'
import { actorString, MANAGE, READ } from '../auth/roles'
import { FolioError } from '../errors'
import { brandIdOf, hookCtx, requestChain, requestScope, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import {
  deleteRedirect,
  listRedirects,
  lookupRedirect,
  normalisePath,
  normaliseTarget,
  type Redirect,
  upsertRedirect,
} from '../redirects'
import { storyByPath } from '../stories'
import type { FolioEnv } from '../types'
import { limitParam, parseBody, RedirectCreateBody } from '../validate'
import type { FolioDb } from '../db'

/** True when `to` already redirects straight back to `from` — the one loop a
 * manual add can create that decision 3's write-time collapse never sees,
 * because there is no path being vacated here for that collapse to run on.
 * Asked along the scope's chain, because that is the walk a visitor's request
 * takes (`multi-site.md` decision 5). */
async function pointsBackAt(
  db: FolioDb,
  chain: readonly string[],
  to: string,
  from: string,
): Promise<Redirect['to'] | null> {
  const back = await lookupRedirect(db, chain, to)
  return back && normalisePath(back.to) === from ? back.to : null
}

export function redirectRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  // The scope whose own redirects these are (`multi-site.md`: "scope's own rows"),
  // and `default` with no `sites`. A redirect is one scope's routing: it is listed,
  // added and removed there, and never touches another's.
  const scopeOf = (c: Context<FolioEnv<Env>>): string => requestScope(c, rt) ?? DEFAULT_SITE

  app.get('/redirects', requireAccess<Env>(rt, READ), async (c) => {
    const db = c.var.bindings().db
    const limit = limitParam(c.req.query('limit'), 50, 200)
    const cursor = c.req.query('cursor')
    const source = c.req.query('source')
    const q = c.req.query('q')
    // A malformed cursor is a 400, not a silent first page
    // (`../../../docs/specs/foundation/pagination.md`, edge cases). The cursor is
    // opaque, so a client that sent a bad one has a bug, and quietly restarting
    // surfaces as a list that jumped — which nobody can act on.
    //
    // Note the asymmetry with `limit`, which clamps instead of refusing: an
    // out-of-range limit is a stale bookmark and still has an obvious right
    // answer, whereas "resume after ???" has none.
    if (cursor !== undefined && decodeCursor(cursor) === null) {
      throw new FolioError('bad_request', 'Malformed pagination cursor')
    }
    return c.json(
      await listRedirects(db, {
        scope: scopeOf(c),
        limit,
        cursor,
        source: source === 'auto' || source === 'manual' ? source : undefined,
        // Trimmed and bounded rather than refused, on the `limit` side of the
        // asymmetry above: a 300-character search term is a paste accident with an
        // obvious right answer, and there is no state a client can be left in by
        // truncating one. 200 is `validate.ts`'s `SEARCH_Q` bound, restated here
        // because that schema is private to the module that owns story filters and
        // a redirect is not a story.
        q: q?.trim().slice(0, 200) || undefined,
        // `Showing n of N` is the paging control for every list screen
        // (`../../../docs/specs/foundation/pagination.md` decision 5), and this
        // route is the one that predates it — hence opt-in, so a cursor walk that
        // only wants rows does not drag an aggregate behind every page.
        count: c.req.query('count') === '1',
      }),
    )
  })

  /**
   * A redirect that can never fire is a trap, not a row, so three things are
   * checked before anything is written: `from` must not be the same path as `to`,
   * `from` must not be a path a story currently occupies (of any state — a draft
   * sitting there is still a trap, not only a published page), and `to` must not
   * already redirect straight back to `from`, which is the one *two-row* loop a
   * manual add can create (auto rows cannot loop by construction — decision 3).
   *
   * **The self-redirect check was missing**, and it is the one trap this route
   * could create in a single row: `redirectStatements` guards `from === to`
   * because a title-only edit reaches it constantly, and `upsertRedirect` never
   * did — so `POST { from: 'a', to: 'a' }` wrote `a → a`, which a browser follows
   * until it gives up. Same class as the two checks below, same answer.
   *
   * What none of the three catch, and what the screen therefore says rather than
   * promises: a **longer** manual chain or cycle. `a → b` plus `b → c` is two hops
   * a browser follows, and `a → b`, `b → c`, `c → a` is a cycle no pairwise check
   * sees. Refusing those needs a bounded walk at write time, which is a design
   * call for `redirects.md` rather than something to slip in here.
   */
  app.post('/redirects', requireAccess<Env>(rt, MANAGE), async (c) => {
    const db = c.var.bindings().db
    const body = await parseBody(c.req, RedirectCreateBody)
    const from = normalisePath(body.from)

    if (from === normaliseTarget(body.to)) {
      throw new FolioError(
        'conflict',
        `/${from || ''} cannot redirect to itself; a browser would follow it forever.`,
      )
    }

    // Only the scope's **own** page is a trap: a page it merely inherits is exactly
    // what a redirect here is for overriding (decision 5: a site's own redirect beats
    // an inherited page).
    const scope = scopeOf(c)
    const occupied = await storyByPath(db, [scope], from)
    if (occupied) {
      throw new FolioError(
        'conflict',
        `"${occupied.title}" already lives at /${from}. Rename or move it first.`,
      )
    }

    const loopsBackTo = await pointsBackAt(db, await requestChain(c, rt), body.to, from)
    if (loopsBackTo !== null) {
      throw new FolioError(
        'conflict',
        `That target already redirects back to /${from || '/'}; adding this row would loop.`,
      )
    }

    const redirect = await upsertRedirect(
      db,
      { from: body.from, to: body.to, status: body.status },
      scope,
    )
    // A path that used to answer the host's own 404 now answers a redirect
    // (`../../../docs/specs/platform/caching.md`). Folio's own purge hook has
    // nothing to do with this — its tags describe rendered pages, not paths —
    // but a host that caches its 404s has to hear about it, and this is the
    // only moment that knows which path changed meaning.
    await rt
      .hookRunner(hookCtx(c), brandIdOf(c))
      .run('redirectsChanged', { from: [from], actor: actorString(c.var.actor), site: scope })
    return c.json(redirect, 201)
  })

  // `{.+}` so a multi-segment path (`services/strategy`) arrives whole rather
  // than being cut at the first slash, the way a bare `:from` would.
  app.delete('/redirects/:from{.+}', requireAccess<Env>(rt, MANAGE), async (c) => {
    const from = c.req.param('from')
    const removed = await deleteRedirect(c.var.bindings().db, from, scopeOf(c))
    // Only when a row actually went: deleting a redirect that was never there
    // changes nothing, and an event for it would be a purge for nothing.
    if (removed) {
      await rt.hookRunner(hookCtx(c), brandIdOf(c)).run('redirectsChanged', {
        from: [normalisePath(from)],
        actor: actorString(c.var.actor),
        site: scopeOf(c),
      })
    }
    return c.json({ deleted: removed })
  })

  return app
}
