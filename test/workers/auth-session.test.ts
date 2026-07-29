import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { fallbackColour } from '../../src/core/protocol'
import {
  createSession,
  deleteExpiredSessions,
  readSession,
  revokeSession,
  revokeUserSessions,
  sessionExpiry,
} from '../../src/server/auth/session'
import { hashToken } from '../../src/server/auth/secrets'
import { createToken, listTokens, readToken, revokeToken } from '../../src/server/auth/tokens'
import type { UserActor } from '../../src/server/auth/roles'
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  userByEmail,
  userById,
} from '../../src/server/auth/users'

/**
 * The session store against real D1 and the real `0007_identity.sql`: what the
 * database actually holds, when a credential stops working, and what revocation
 * costs.
 *
 * Real workerd because `crypto.subtle.digest` and D1's own batch semantics are
 * exactly what is under test — a Node fake of either would pin the fake.
 */

const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from login_challenges'),
    env.DB.prepare('delete from users'),
  ])
})

const seedUser = () => createUser(env.DB, { email: 'Ann@Example.COM', name: 'Ann', role: 'editor' })

describe('users', () => {
  it('lowercases the address on write, so one account means one address', async () => {
    const user = await seedUser()
    expect(user.email).toBe('ann@example.com')
    // And the lookup normalises the other way too, so a differently-typed
    // address at sign-in still finds the account.
    expect((await userByEmail(env.DB, ' ANN@example.com '))?.id).toBe(user.id)
  })

  it('defaults the name to the local part and the role to editor', async () => {
    const user = await createUser(env.DB, { email: 'bo@example.com' })
    expect(user.name).toBe('bo')
    expect(user.role).toBe('editor')
    expect(user.colour).toBeNull()
  })

  it('refuses an unknown role at the column, so it can never be stored at all', async () => {
    const user = await seedUser()
    // 0007's CHECK constraint is the outer defence; `isRole`'s fall back to
    // `viewer` inside `toUser` is the inner one, for a database written by a
    // deploy that knew a role this build does not. Neither may fail *open*, and
    // this is the one of the two that is observable from here.
    await expect(
      env.DB.prepare('update users set role = ? where id = ?').bind('owner', user.id).run(),
    ).rejects.toThrow(/CHECK constraint failed/)
    expect((await userById(env.DB, user.id))?.role).toBe('editor')
  })

  it('changes a role without touching the name, and the other way round', async () => {
    const user = await seedUser()
    expect((await updateUser(env.DB, user.id, { role: 'publisher' }))?.name).toBe('Ann')
    expect((await updateUser(env.DB, user.id, { name: 'Annabel' }))?.role).toBe('publisher')
    expect(await updateUser(env.DB, 'usr_nope', { role: 'admin' })).toBeNull()
  })

  it('deleting a user takes every session they hold with it', async () => {
    const user = await seedUser()
    const a = await createSession(env.DB, user.id)
    const b = await createSession(env.DB, user.id)

    expect(await deleteUser(env.DB, user.id)).toBe(true)
    // Explicit, not left to the `on delete cascade`: whether D1 enforces
    // foreign keys is a property of the database, and "remove that person's
    // access now" is the whole point of the feature.
    expect(await readSession(env.DB, a.token)).toBeNull()
    expect(await readSession(env.DB, b.token)).toBeNull()
    expect(await listUsers(env.DB)).toEqual([])
    expect(await deleteUser(env.DB, user.id)).toBe(false)
  })
})

describe('sessions', () => {
  it('stores only the hash, never the token that was handed out', async () => {
    const user = await seedUser()
    const { token, id } = await createSession(env.DB, user.id)

    expect(id).toBe(await hashToken(token))
    const rows = await env.DB.prepare('select id from sessions').all<{ id: string }>()
    expect(rows.results.map((r) => r.id)).toEqual([id])
    // The whole point of decision 1: a dumped database yields no usable cookie.
    expect(rows.results.some((r) => r.id === token)).toBe(false)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves the cookie to a user actor carrying the role and a colour', async () => {
    const user = await seedUser()
    const { token } = await createSession(env.DB, user.id)

    const actor = (await readSession(env.DB, token)) as UserActor
    expect(actor).toMatchObject({ kind: 'user', id: user.id, name: 'Ann', role: 'editor' })
    // No colour on the row, so the wire protocol's own deterministic fallback
    // fills in — the same value a socket with a malformed colour lands on.
    expect(actor.colour).toBe(fallbackColour(user.id))
    expect(actor.session).toBe(await hashToken(token))
  })

  it('prefers the row colour when there is one', async () => {
    const user = await createUser(env.DB, { email: 'bo@example.com', colour: '#00ffcc' })
    const { token } = await createSession(env.DB, user.id)
    expect((await readSession(env.DB, token)) as UserActor).toMatchObject({ colour: '#00ffcc' })
  })

  it('answers null for a token nobody minted', async () => {
    await seedUser()
    expect(await readSession(env.DB, 'a'.repeat(64))).toBeNull()
  })

  it('answers null past the expiry, and prunes the row it just refused', async () => {
    const user = await seedUser()
    const { token, id } = await createSession(env.DB, user.id, { days: 1 })

    expect(await readSession(env.DB, token, { now: Date.now() + 2 * DAY })).toBeNull()
    // The request that discovers a dead session cleans it up; the sweep below
    // exists for the ones nobody ever comes back to.
    expect(await sessionExpiry(env.DB, id)).toBeNull()
  })

  it('renews past the halfway mark and leaves a fresh session alone', async () => {
    const user = await seedUser()
    const { token, id } = await createSession(env.DB, user.id, { days: 30 })
    const original = await sessionExpiry(env.DB, id)

    // Well inside the first half: renewing here would be a D1 write per request.
    await readSession(env.DB, token, { days: 30, now: Date.now() + 3 * DAY })
    expect(await sessionExpiry(env.DB, id)).toBe(original)

    // Past halfway: slid forward, so a browser in daily use is not logged out
    // on the one day it is idle.
    const later = Date.now() + 20 * DAY
    await readSession(env.DB, token, { days: 30, now: later })
    const renewed = await sessionExpiry(env.DB, id)
    expect(renewed).toBeGreaterThan(original ?? 0)
    expect(renewed).toBe(later + 30 * DAY)
  })

  it('revocation is a delete, and takes effect on the next read', async () => {
    const user = await seedUser()
    const { token } = await createSession(env.DB, user.id)
    expect(await readSession(env.DB, token)).not.toBeNull()

    await revokeSession(env.DB, token)
    expect(await readSession(env.DB, token)).toBeNull()
  })

  it('signs out every browser a user holds', async () => {
    const user = await seedUser()
    const a = await createSession(env.DB, user.id)
    const b = await createSession(env.DB, user.id)

    await revokeUserSessions(env.DB, user.id)
    expect(await readSession(env.DB, a.token)).toBeNull()
    expect(await readSession(env.DB, b.token)).toBeNull()
  })

  it('sweeps expired sessions and keeps live ones', async () => {
    const user = await seedUser()
    await createSession(env.DB, user.id, { days: 1 })
    const live = await createSession(env.DB, user.id, { days: 30 })

    expect(await deleteExpiredSessions(env.DB, Date.now() + 2 * DAY)).toBe(1)
    expect(await readSession(env.DB, live.token)).not.toBeNull()
  })

  it('stamps last_seen_at on the user when a session is created', async () => {
    const user = await seedUser()
    expect(user.lastSeenAt).toBeNull()
    await createSession(env.DB, user.id)
    expect((await userById(env.DB, user.id))?.lastSeenAt).toBeTypeOf('number')
  })

  it('bounds the user-agent it keeps for diagnostics', async () => {
    const user = await seedUser()
    await createSession(env.DB, user.id, { userAgent: 'x'.repeat(1000) })
    const row = await env.DB.prepare('select user_agent from sessions').first<{
      user_agent: string
    }>()
    expect(row?.user_agent).toHaveLength(300)
  })
})

describe('api tokens', () => {
  it('hands the raw token back once and stores only its hash', async () => {
    const { row, token } = await createToken(env.DB, {
      name: 'import-script',
      scopes: ['content:read'],
    })
    expect(token).toMatch(/^folio_[0-9a-f]{64}$/)
    expect(row.id).toBe(await hashToken(token))
    const stored = await env.DB.prepare('select id, scopes from api_tokens').first<{
      id: string
      scopes: string
    }>()
    expect(stored?.id).toBe(row.id)
    expect(stored?.scopes).toBe('["content:read"]')
  })

  it('resolves a presented token to a token actor with its scopes', async () => {
    const { token } = await createToken(env.DB, { name: 'importer', scopes: ['content:write'] })
    expect(await readToken(env.DB, token)).toEqual({
      kind: 'token',
      id: await hashToken(token),
      name: 'importer',
      scopes: ['content:write'],
    })
  })

  it('stamps last_used_at whether or not the caller turns out to be allowed', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['content:read'] })
    await readToken(env.DB, token)
    // The question the column answers is "is this credential in use", not "did
    // it succeed" — so the stamp happens in the read, before any scope check.
    const [after] = await listTokens(env.DB)
    expect(after?.lastUsedAt).toBeTypeOf('number')
    expect(after?.id).toBe(row.id)
  })

  it('refuses a revoked token as a credential, not as a missing scope', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['admin'] })
    expect(await revokeToken(env.DB, row.id)).toBe(true)
    expect(await readToken(env.DB, token)).toBeNull()
    // Revoked, not deleted: the name stays answerable, and the hash can never
    // be minted again by chance.
    expect((await listTokens(env.DB))[0]?.revokedAt).toBeTypeOf('number')
    expect(await revokeToken(env.DB, row.id)).toBe(false)
  })

  it('refuses an expired token', async () => {
    const { token } = await createToken(env.DB, {
      name: 'importer',
      scopes: ['content:read'],
      expiresAt: Date.now() - 1,
    })
    expect(await readToken(env.DB, token)).toBeNull()
  })

  it('answers null for a token nobody minted', async () => {
    expect(await readToken(env.DB, 'folio_deadbeef')).toBeNull()
  })
})
