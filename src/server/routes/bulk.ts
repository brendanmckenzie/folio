/**
 * The five bulk write routes (`../../../docs/specs/platform/bulk-writes.md`).
 *
 * **Five paths, not one `POST /bulk/:action`**, and the reason is the gate. Each of
 * these carries the *same* `requireAccess` its single-document twin carries —
 * `PUBLISH` for publish and unpublish, `CREATE` for duplicate, `MANAGE` for move and
 * delete — because bulk publishing forty pages is publishing, forty times, and it
 * must be neither more nor less privileged than doing it by hand. One route could
 * not: `requireAccess` is declared at the mount, so an action read out of the path or
 * the body would have to be gated after the body was parsed (hiding the gate from the
 * place `identity-and-access.md` decision 5 insists it is visible) or gated on the
 * union of all five — which for an API token means demanding both `content:write` and
 * `publish`, so a token holding only `publish` could not bulk publish while it can
 * publish each document one at a time.
 *
 * The bodies differ too, and along the same seam: move takes a destination, delete
 * takes the redirect switch, and the other three take nothing but a selection. A
 * discriminated body would express that as a variant per action, which is five schemas
 * either way — with the gate moved inside the handler as the only difference.
 *
 * What is *not* duplicated is the work: one `runBulk` behind all five, and the
 * per-document workflows are the same functions the single-document routes call.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { BulkAction } from '../../core/story'
import { type Access, actorString, CREATE, MANAGE, PUBLISH } from '../auth/roles'
import { type BulkDeps, type BulkOptions, type BulkOutcome, runBulk, wasRefused } from '../bulk'
import { hookCtx, requireAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { BulkBody, BulkDeleteBody, BulkMoveBody, parseBody, requireCursor } from '../validate'

export function bulkRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * `PublishDeps` plus the two fields the tree-shaped actions need. Assembled here
   * and nowhere else, so a bulk delete reaches the identical `deleteDocument` — with
   * the identical five-statement batch, purge ordering and `deleted` hook — that
   * `DELETE {base}/api/stories/:id` reaches.
   */
  const deps = (c: Context<FolioEnv<Env>>): BulkDeps => {
    const bindings = c.var.bindings()
    return {
      ...rt.publishDeps(bindings, hookCtx(c)),
      types: rt.types,
      stub: (id: string) => rt.stub(bindings, id),
    }
  }

  /**
   * One run, and the two shapes it can answer with.
   *
   * A **409 whose body is the error envelope plus the counts.** Not a plain
   * conflict, because "somebody else published two of these while you were reading
   * the number" has to be a door rather than a wall: the client needs the *new*
   * count to offer one-click re-confirmation, and `{ error: { code, message } }` has
   * nowhere to put it. Not a bespoke body either — `error` stays exactly where every
   * client already looks, so a generic fetch wrapper shows a readable sentence
   * without knowing this route exists, and the machine-readable numbers sit beside
   * it. `errors.ts` stays the only place a *thrown* error becomes JSON; this is a
   * refusal answered as a value (`runBulk` returns it rather than throwing, the way
   * `StoryDO.commit` answers a rejection).
   */
  const answer = (c: Context<FolioEnv<Env>>, outcome: BulkOutcome): Response => {
    if (!wasRefused(outcome)) return c.json(outcome)
    return c.json(
      {
        error: {
          code: 'conflict',
          message: `${outcome.expected} documents matched when you chose them and ${outcome.actual} match now. Check the number and try again.`,
        },
        refused: outcome.refused,
        expected: outcome.expected,
        actual: outcome.actual,
      },
      409,
    )
  }

  /** The job-control fields, off any of the three bodies. `actor` is the session's
   * and never the body's: "who published this" is not a value anybody may type. */
  const control = (
    c: Context<FolioEnv<Env>>,
    body: { dryRun?: boolean; continueFrom?: string | null; batch?: number },
  ): BulkOptions => {
    requireCursor(body.continueFrom ?? undefined)
    return {
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
      ...(body.continueFrom === undefined ? {} : { continueFrom: body.continueFrom }),
      ...(body.batch === undefined ? {} : { batch: body.batch }),
      actor: actorString(c.var.actor),
    }
  }

  /**
   * The three actions whose only argument is the selection.
   *
   * Registered from a table rather than written out three times: the handlers would
   * be character-identical apart from the action name and the access, and three
   * copies is where the fourth one forgets `requireCursor`.
   */
  const PLAIN: [BulkAction, Access][] = [
    ['publish', PUBLISH],
    ['unpublish', PUBLISH],
    // `CREATE` (editor+), matching `POST {base}/api/stories/:id/duplicate`: a copy is
    // an unpublished draft at a path nothing links to yet.
    ['duplicate', CREATE],
  ]

  for (const [action, access] of PLAIN) {
    app.post(`/bulk/${action}`, requireAccess<Env>(rt, access), async (c) => {
      const body = await parseBody(c.req, BulkBody)
      return answer(c, await runBulk(deps(c), action, body.selection, control(c, body)))
    })
  }

  /**
   * Move, which is the one action decision 7 changed its mind about — "a tree
   * operation with fractional indices and cycle checks" was our implementation's
   * problem dressed up as a product decision. `updateStoryStatement` already encodes
   * every rule that applies, so this is per-document calls with the refusals
   * reported, and a page that cannot go where it was asked (into its own subtree,
   * under a type its `under` forbids) is one named line in the report rather than a
   * failed request.
   */
  app.post('/bulk/move', requireAccess<Env>(rt, MANAGE), async (c) => {
    const body = await parseBody(c.req, BulkMoveBody)
    return answer(
      c,
      await runBulk(deps(c), 'move', body.selection, {
        ...control(c, body),
        destination: {
          parentId: body.parentId,
          ...(body.index === undefined ? {} : { index: body.index }),
        },
      }),
    )
  })

  /** Delete, with `redirect` defaulting to true so a bulk delete leaves the same
   * redirects a hundred single deletes would (`../../platform/redirects.md`). */
  app.post('/bulk/delete', requireAccess<Env>(rt, MANAGE), async (c) => {
    const body = await parseBody(c.req, BulkDeleteBody)
    return answer(
      c,
      await runBulk(deps(c), 'delete', body.selection, {
        ...control(c, body),
        ...(body.redirect === undefined ? {} : { redirect: body.redirect }),
      }),
    )
  })

  return app
}
