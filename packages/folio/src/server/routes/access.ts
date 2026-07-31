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
import { ADMIN } from '../auth/roles'
import { createToken, listTokens, revokeToken } from '../auth/tokens'
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  userByEmail,
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

  app.get('/users', async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const page = await listUsers(c.var.bindings().db, {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      count: c.req.query('count') === '1',
    })
    // The `users` key stays, so the shape is `{ users, cursor }` rather than
    // `{ rows, cursor }`: this route names its own collection and the admin's
    // Access screen reads it by name.
    return c.json({ users: page.rows.map(toJson), cursor: page.cursor, total: page.total })
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
    return c.json({ user: toJson(await createUser(db, body)) }, 201)
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
    const updated = await updateUser(db, id, body)
    if (!updated) throw new FolioError('not_found', 'Unknown user')
    if (body.role !== undefined) await revokeUserSessions(db, id)
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
    if (!(await deleteUser(c.var.bindings().db, id))) {
      throw new FolioError('not_found', 'Unknown user')
    }
    return c.json({ deleted: true })
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
