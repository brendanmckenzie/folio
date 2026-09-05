/**
 * Managing editors and API tokens. `admin` role only.
 *
 * Split from `auth.ts` deliberately: everything in that file is reachable
 * without a credential by definition, and everything here requires the strongest
 * role there is. Keeping them apart means the rule is a property of the file
 * rather than something to check per handler.
 *
 * There is no bootstrap route, and that is on purpose: an endpoint that creates
 * the first admin is an endpoint that creates an admin, and no check it could
 * make would be worth more than `wrangler d1 execute`. Seeding the first row is
 * a deploy step (see README).
 */
import { Hono } from 'hono'
import type { Scope } from '../auth/roles'
import { ADMIN, actorString } from '../auth/roles'
import { roleSetByReason } from '../auth/roles-from'
import { countPasskeysByUser } from '../auth/passkeys'
import { listEvents, oldestEventAt, recordEventStatement } from '../auth/events'
import { createToken, listTokens, revokeToken } from '../auth/tokens'
import {
  createUserStatement,
  deleteUser,
  listUsers,
  updateUser,
  userByEmail,
  userById,
  type UserRow,
} from '../auth/users'
import { revokeUserSessions } from '../auth/session'
import { FolioError } from '../errors'
import { requireAccess, requireAuthConfigured } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { idParam, parseBody, TokenCreateBody, UserCreateBody, UserPatchBody } from '../validate'
import { limitParam, requireCursor } from '../validate'

const DAY_MS = 24 * 60 * 60 * 1000

/** What a user looks like over the wire. `email` is included — an admin managing
 * access needs it — and nothing else is hidden, because a user row holds no
 * secret: the credentials are in `sessions`, hashed. */
function toJson(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    colour: user.colour,
    provider: user.provider,
    /** Which provider's claims placed `role`, or null for a role Folio owns.
     * The Access screen disables its `<select>` on this and says why, which is
     * the client half of the `409` below. */
    roleFrom: user.roleFrom,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
  }
}

export function accessRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  // Both guards on every route in the file, in this order: "there is no such
  // thing here" comes before "you may not", so an `auth: 'open'` deployment
  // never answers 401 for a surface it does not have.
  app.use('/users', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/users/*', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/tokens', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/tokens/*', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/auth-events', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))

  app.get('/users', async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const db = c.var.bindings().db
    const page = await listUsers(db, {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      count: c.req.query('count') === '1',
    })
    /**
     * The passkey count per row (`../../../docs/specs/foundation/passkeys.md`
     * checkpoint 4), for the Access screen's column and its "Remove all
     * passkeys" action.
     *
     * **One grouped statement over the page's ids**, not a count per row: the
     * page is 50 wide, so the alternative is fifty round trips for one column.
     * And skipped entirely on a deployment with no passkey provider, where every
     * answer would be zero — the column reads "—" for a missing entry either way,
     * so the query buys nothing.
     */
    const counts =
      rt.auth.mode === 'session' && rt.auth.passkey
        ? await countPasskeysByUser(
            db,
            page.rows.map((u) => u.id),
          )
        : new Map<string, number>()
    // The `users` key stays, so the shape is `{ users, cursor }` rather than
    // `{ rows, cursor }`: this route names its own collection and the admin's
    // Access screen reads it by name.
    return c.json({
      users: page.rows.map((user) => ({ ...toJson(user), passkeys: counts.get(user.id) ?? 0 })),
      cursor: page.cursor,
      total: page.total,
    })
  })

  /**
   * Invites an editor. There is no mail here and deliberately so: the row *is*
   * the invitation, and the person signs in through whichever provider the site
   * has configured. A library that mailed an invitation would be back to owning
   * a from-address (see magic-link.ts).
   */
  app.post('/users', async (c) => {
    const body = await parseBody(c.req, UserCreateBody)
    const db = c.var.bindings().db
    if (await userByEmail(db, body.email)) {
      throw new FolioError('conflict', 'Someone with that address already has access.')
    }
    // The insert and its `auth_events` row in one batch, `createUserStatement`
    // rather than `createUser` for exactly the reason `completeSignIn` uses it:
    // the id has to exist before the write happens, which it does because it is
    // minted here rather than by the database.
    const { user, statement } = createUserStatement(db, body)
    await db.batch([
      statement,
      recordEventStatement(db, {
        kind: 'user_invited',
        userId: user.id,
        actor: actorString(c.var.actor),
      }),
    ])
    return c.json({ user: toJson(user) }, 201)
  })

  /**
   * Renames someone or changes their role.
   *
   * A role change revokes their sessions. Without that, a demotion from
   * `publisher` to `viewer` would leave the old role in every open socket's
   * attachment until it expired — the bounded window checkpoint 5 accepts for a
   * *revocation* is not a window worth accepting for a downgrade that an admin
   * has just deliberately made. Signing back in is cheap; publishing something
   * after being told you no longer can is not.
   */
  app.patch('/users/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, UserPatchBody)
    const db = c.var.bindings().db
    const self = c.var.actor

    /**
     * **You cannot change your own role.** Found while building the Access screen:
     * the delete below has guarded self-removal since it was written, on the grounds
     * that it is "the one delete that can leave a site with no way to manage access
     * at all" — and a self-*demotion* reaches the identical state through a control
     * that looks reversible. Worse, the session revoke immediately above makes it
     * instant: an admin who picks `viewer` from their own row is signed out and comes
     * back unable to reach this route, and the recovery is a `wrangler d1 execute`
     * against production.
     *
     * `conflict`, matching the delete's own refusal, and worded the same way. The
     * screen disables the control with a reason as well — the rule the whole admin
     * follows is that a refusal explains itself before the click — but the guard
     * belongs here, because a control that is only disabled in one client is not a
     * guard at all.
     *
     * Not "unless you are the last admin". Counting admins to decide makes the answer
     * depend on a race with whoever else is being demoted in another tab, and "you
     * may demote yourself only while a colleague still outranks you" is a rule nobody
     * can hold in their head. Somebody else changes your role; that is what having
     * more than one admin is for.
     */
    if (body.role !== undefined && self?.kind === 'user' && self.id === id) {
      throw new FolioError(
        'conflict',
        'You cannot change your own role. Ask another admin to change it for you.',
      )
    }

    /**
     * **A role an identity provider placed is not Folio's to edit**
     * (`../../../docs/specs/foundation/auth-providers.md` decision 5,
     * checkpoint 2). `users.role_from` records who decided it, and when a
     * provider did, the remedy for a group change is in the directory — which is
     * where a tenant that delegated roles to it expects to find it.
     *
     * The alternative was to allow the edit and let the next sign-in overwrite
     * it, which is the "it quietly changed" failure this codebase refuses
     * everywhere else: an admin would set `viewer`, watch the row say `viewer`,
     * and find `admin` again after the person's next sign-in with no event
     * between the two that anybody was looking at.
     *
     * One extra read, and only when `role` is in the body: `updateUser` reads
     * the row itself, but it reads it to build the patch, and the answer has to
     * be known before the write rather than after it. A rename pays nothing.
     *
     * `DELETE` below is deliberately not guarded this way. Removing someone is
     * not a role, and a provider that decides what somebody may do has no
     * opinion on whether they have access at all.
     */
    let previousRole: UserRow['role'] | undefined
    if (body.role !== undefined) {
      const target = await userById(db, id)
      if (!target) throw new FolioError('not_found', 'Unknown user')
      if (target.roleFrom) throw new FolioError('conflict', roleSetByReason(target.roleFrom))
      previousRole = target.role
    }

    const updated = await updateUser(db, id, body)
    if (!updated) throw new FolioError('not_found', 'Unknown user')
    if (body.role !== undefined) {
      await revokeUserSessions(db, id)
      // A no-op is not an event — an admin re-selecting the role already
      // stored says nothing happened, and `completeSignIn`'s own interaction
      // table draws the identical line for the provider-driven case.
      if (previousRole !== undefined && previousRole !== body.role) {
        await db.batch([
          recordEventStatement(db, {
            kind: 'role_changed',
            userId: id,
            // The admin's own id, not the subject's: this is the one
            // `role_changed` row somebody else caused, which is the pair to
            // `completeSignIn`'s `provider:<id>` actor for the claims-driven one.
            actor: actorString(self),
            detail: { from: previousRole, to: body.role },
          }),
        ])
      }
    }
    return c.json({ user: toJson(updated) })
  })

  /**
   * Removes an editor. Their history is untouched: `versions.actor` stores a
   * string, not a foreign key, so an access change never rewrites the record of
   * who changed what.
   *
   * An admin cannot remove themselves. Not paternalism — it is the one delete
   * that can leave a site with no way to manage access at all, and the recovery
   * is a `wrangler d1 execute` against production.
   */
  app.delete('/users/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const self = c.var.actor
    if (self?.kind === 'user' && self.id === id) {
      throw new FolioError('conflict', 'You cannot remove your own account.')
    }
    const db = c.var.bindings().db
    if (!(await deleteUser(db, id))) {
      throw new FolioError('not_found', 'Unknown user')
    }
    // After the delete, not in its batch: `deleteUser` runs its own (sessions,
    // passkeys, the row), and `userId` here is informational rather than a
    // foreign key — this row is meant to outlive the account it is about, the
    // same as every other `auth_events` row naming a user who is later removed.
    await db.batch([
      recordEventStatement(db, { kind: 'user_removed', userId: id, actor: actorString(self) }),
    ])
    return c.json({ deleted: true })
  })

  /**
   * The sign-in record (`../../../docs/specs/foundation/auth-providers.md`
   * decision 8): every sign-in, refusal, sign-out, invitation, removal and role
   * change, newest first. No admin screen reads this yet — the Access screen
   * has no per-user detail view to hang one on — so this is the whole of the
   * surface for now.
   *
   * `oldestAt` is the point of the route as much as `events` is. It is the
   * epoch of the oldest row in the **whole table**, unaffected by `?user=`: a
   * deployment that never wired `folio.sweepAuth` into a cron has no other
   * signal that it didn't, and this is where an admin looking at the surface
   * the symptom would show up on can see it.
   */
  app.get('/auth-events', async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const db = c.var.bindings().db
    const [page, oldestAt] = await Promise.all([
      listEvents(db, {
        user: c.req.query('user'),
        cursor,
        limit: limitParam(c.req.query('limit'), 50, 200),
      }),
      oldestEventAt(db),
    ])
    return c.json({ events: page.rows, cursor: page.cursor, oldestAt })
  })

  /** Never carries a token value: the hash is all that exists after creation. */
  app.get('/tokens', async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const page = await listTokens(c.var.bindings().db, {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      count: c.req.query('count') === '1',
    })
    return c.json({ tokens: page.rows, cursor: page.cursor, total: page.total })
  })

  /**
   * Mints a token. **The only response in the whole server that contains a
   * credential in the clear** — there is no way to read it back, because only its
   * SHA-256 is stored.
   */
  app.post('/tokens', async (c) => {
    const body = await parseBody(c.req, TokenCreateBody)
    const self = c.var.actor
    const minted = await createToken(c.var.bindings().db, {
      name: body.name,
      scopes: body.scopes as Scope[],
      createdBy: self?.kind === 'user' ? self.id : null,
      expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * DAY_MS : null,
    })
    return c.json({ token: minted.token, row: minted.row }, 201)
  })

  /** Revoked, not deleted: the name stays answerable and the hash can never be
   * minted again by chance. */
  app.delete('/tokens/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    if (!(await revokeToken(c.var.bindings().db, id))) {
      throw new FolioError('not_found', 'Unknown or already-revoked token')
    }
    return c.json({ revoked: true })
  })

  return app
}
