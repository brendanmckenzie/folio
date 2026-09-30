import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { fallbackColour } from '../../src/core/protocol'
import type { Registry } from '../../src/core/sites'
import {
  consumeGrantCode,
  mintGrantCode,
  readGrant,
  sweepGrants,
} from '../../src/server/auth/grants'
import {
  createSession,
  deleteExpiredSessions,
  readSession,
  revokeOtherSessions,
  revokeSession,
  revokeUserSessions,
  sessionExpiry,
  userSessionsDelete,
} from '../../src/server/auth/session'
import {
  type AuthEventInput,
  listEvents,
  oldestEventAt,
  recordEventStatement,
  sweepEvents,
} from '../../src/server/auth/events'
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
 * The session store against real D1 and the real `sessions` schema: what the
 * database actually holds, when a credential stops working, and what revocation
 * costs.
 *
 * Real workerd because `crypto.subtle.digest` and D1's own batch semantics are
 * exactly what is under test — a Node fake of either would pin the fake.
 */

const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from site_grants'),
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from login_challenges'),
    env.DB.prepare('delete from auth_events'),
    // Before `users`, and explicitly rather than by cascade, for the same reason
    // `deleteUser` batches it: this file must not depend on a pragma to be clean.
    env.DB.prepare('delete from passkeys'),
    env.DB.prepare('delete from site_roles'),
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
    // `site_roles.role`'s CHECK (0011) is the outer defence; `isRole`'s fall back
    // to `viewer` inside `toUser` is the inner one, for a database written by a
    // deploy that knew a role this build does not. Neither may fail *open*, and
    // this is the one of the two that is observable from here.
    await expect(
      env.DB.prepare("update site_roles set role = ? where user_id = ? and scope_id = '*'")
        .bind('owner', user.id)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
    expect((await userById(env.DB, user.id))?.role).toBe('editor')
  })

  it('keeps the role in the `*` grant, and a user with no grant reads as viewer', async () => {
    const user = await seedUser()
    const grants = () =>
      env.DB.prepare('select scope_id, role, role_from from site_roles where user_id = ?')
        .bind(user.id)
        .all<{ scope_id: string; role: string; role_from: string | null }>()
        .then((r) => r.results)
    expect(await grants()).toEqual([{ scope_id: '*', role: 'editor', role_from: null }])

    await updateUser(env.DB, user.id, { role: 'publisher' })
    expect(await grants()).toEqual([{ scope_id: '*', role: 'publisher', role_from: null }])

    // A rename writes no grant at all: the old `users.role` write on every patch
    // is what made a mirroring trigger unsafe (multi-site.md decision 18).
    await env.DB.prepare('delete from site_roles where user_id = ?').bind(user.id).run()
    await updateUser(env.DB, user.id, { name: 'Annabel' })
    expect(await grants()).toEqual([])
    // Fails closed, like an unknown role: no grant is the weakest role, not a 500.
    expect((await userById(env.DB, user.id))?.role).toBe('viewer')
    const { token } = await createSession(env.DB, user.id)
    expect(((await readSession(env.DB, token)) as UserActor).role).toBe('viewer')
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
    expect((await listUsers(env.DB)).rows).toEqual([])
    expect(await deleteUser(env.DB, user.id)).toBe(false)
  })

  /**
   * `foundation/passkeys.md`: a credential must not outlive the account it
   * signs in to.
   *
   * **The spec asks for this "asserted with foreign keys off", and that is not
   * available here.** D1 in workerd pins `PRAGMA foreign_keys` at 1: the
   * statement is accepted, changes nothing, and a later read still answers 1 —
   * so a test that turned it off and watched the row vanish would be watching
   * the cascade and calling it the batch. Verified by probe, September 2026.
   *
   * The substitute is stronger in the direction that matters and is stated in
   * two halves: the statement is **in the batch** (recorded off a proxy, which
   * no pragma can influence) and the row **is gone** (against real D1, whatever
   * removed it). Together they say what the pragma trick was meant to say.
   */
  it('deleting a user removes their passkeys from the batch, not from a cascade', async () => {
    const user = await seedUser()
    await env.DB.prepare(
      `insert into passkeys (id, user_id, public_key, alg, name, created_at)
       values (?, ?, 'AQIDBA', -7, 'Work laptop', 1)`,
    )
      .bind('cred_one', user.id)
      .run()
    await env.DB.prepare(
      `insert into passkeys (id, user_id, public_key, alg, name, created_at)
       values (?, ?, 'BAUGBw', -257, 'Security key', 2)`,
    )
      .bind('cred_two', user.id)
      .run()

    // Records every statement `deleteUser` prepares. `bind` answers a *new*
    // statement object, so the proxy follows it — the trap `read-session.test.ts`
    // and `globals.test.ts` both carry a note about, where watching only
    // `prepare` records nothing and every count silently reads zero.
    const prepared: string[] = []
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value
        return (sql: string) => {
          prepared.push(sql)
          return (value as D1Database['prepare']).call(target, sql)
        }
      },
    })

    expect(await deleteUser(db, user.id)).toBe(true)

    // Half one: the delete is a statement this library issued.
    expect(prepared.some((sql) => /delete from passkeys where user_id = \?/.test(sql))).toBe(true)
    // And it comes before the user row's own delete, so the child never
    // outlives the parent even for the width of one batch.
    const passkeysAt = prepared.findIndex((sql) => sql.includes('delete from passkeys'))
    const usersAt = prepared.findIndex((sql) => sql.includes('delete from users'))
    expect(passkeysAt).toBeGreaterThan(-1)
    expect(passkeysAt).toBeLessThan(usersAt)

    // Half two: nothing is left behind.
    const left = await env.DB.prepare('select count(*) as n from passkeys').first<{ n: number }>()
    expect(left?.n).toBe(0)
  })

  /**
   * The same two halves for `site_roles` (`0011_sites.sql`), whose `user_id`
   * declares `on delete cascade` — which, as above, fires here whatever the batch
   * does, so the recorded statement is the only thing that says the batch did it.
   * Grants on two scopes, so a delete narrowed to `*` would leave one behind.
   */
  it('deleting a user removes every grant they hold from the batch, not from a cascade', async () => {
    const user = await seedUser()
    await env.DB.prepare(
      `insert into site_roles (user_id, scope_id, role, created_at) values (?, 'alpha', 'publisher', 1)`,
    )
      .bind(user.id)
      .run()

    const prepared: string[] = []
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value
        return (sql: string) => {
          prepared.push(sql)
          return (value as D1Database['prepare']).call(target, sql)
        }
      },
    })

    expect(await deleteUser(db, user.id)).toBe(true)

    // Half one: the delete is in the batch, unnarrowed by scope, before the row's.
    const grantsAt = prepared.findIndex((sql) =>
      /^delete from site_roles where user_id = \?$/.test(sql),
    )
    const usersAt = prepared.findIndex((sql) => sql.includes('delete from users'))
    expect(grantsAt).toBeGreaterThan(-1)
    expect(grantsAt).toBeLessThan(usersAt)

    // Half two: nothing is left behind, on either scope.
    const left = await env.DB.prepare('select count(*) as n from site_roles where user_id = ?')
      .bind(user.id)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)
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
      // Bound to no scope: today's token (`multi-site.md` decision 14).
      site: null,
    })
  })

  it('stamps last_used_at whether or not the caller turns out to be allowed', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['content:read'] })
    await readToken(env.DB, token)
    // The question the column answers is "is this credential in use", not "did
    // it succeed" — so the stamp happens in the read, before any scope check.
    const [after] = (await listTokens(env.DB)).rows
    expect(after?.lastUsedAt).toBeTypeOf('number')
    expect(after?.id).toBe(row.id)
  })

  it('refuses a revoked token as a credential, not as a missing scope', async () => {
    const { row, token } = await createToken(env.DB, { name: 'importer', scopes: ['admin'] })
    expect(await revokeToken(env.DB, row.id)).toBe(true)
    expect(await readToken(env.DB, token)).toBeNull()
    // Revoked, not deleted: the name stays answerable, and the hash can never
    // be minted again by chance.
    expect((await listTokens(env.DB)).rows[0]?.revokedAt).toBeTypeOf('number')
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

describe('auth_events', () => {
  /**
   * Every event a real sign-in batches shares one `at` (phase 3's own note on
   * this file), so a `(at, id)` keyset cannot be exercised honestly from a
   * single batch. These rows are inserted directly, with **distinct** `at`
   * values, for exactly that reason.
   */
  const insert = (input: AuthEventInput) => recordEventStatement(env.DB, input).run()

  it("pages newest first over (at, id), not within one row's tie", async () => {
    const user = await seedUser()
    await insert({ kind: 'sign_in', at: 1000, userId: user.id, actor: user.id })
    await insert({ kind: 'sign_in', at: 2000, userId: user.id, actor: user.id })
    await insert({ kind: 'sign_out', at: 3000, userId: user.id, actor: user.id })

    const first = await listEvents(env.DB, { limit: 2 })
    expect(first.rows.map((r) => r.at)).toEqual([3000, 2000])
    expect(first.cursor).not.toBeNull()

    const second = await listEvents(env.DB, { cursor: first.cursor ?? undefined, limit: 2 })
    expect(second.rows.map((r) => r.at)).toEqual([1000])
    expect(second.cursor).toBeNull()
  })

  it('narrows to one user without paging over rows that are not theirs', async () => {
    const ann = await seedUser()
    const bo = await createUser(env.DB, { email: 'bo@example.com' })
    await insert({ kind: 'sign_in', at: 1000, userId: ann.id, actor: ann.id })
    await insert({ kind: 'sign_in', at: 2000, userId: bo.id, actor: bo.id })
    await insert({ kind: 'sign_out', at: 3000, userId: ann.id, actor: ann.id })

    const mine = await listEvents(env.DB, { user: ann.id })
    expect(mine.rows.map((r) => r.at)).toEqual([3000, 1000])
  })

  it('round-trips detail as an object, and answers null when there is none', async () => {
    await insert({
      kind: 'role_changed',
      at: 1000,
      userId: null,
      detail: { from: 'editor', to: 'admin' },
    })
    await insert({ kind: 'sign_in', at: 2000, userId: null })

    const rows = await listEvents(env.DB)
    expect(rows.rows.find((r) => r.kind === 'role_changed')?.detail).toEqual({
      from: 'editor',
      to: 'admin',
    })
    expect(rows.rows.find((r) => r.kind === 'sign_in')?.detail).toBeNull()
  })

  /**
   * `kind` carries no CHECK constraint, deliberately (`docs/specs/foundation/
   * auth-providers.md` decision 8): a kind a later migration adds and this
   * build has not been taught yet must read back as data, not fail the
   * request. Inserted with raw SQL, since `AuthEventKind` would refuse it at
   * the type level — exactly the point.
   */
  it('reads an unrecognised kind back as a plain string rather than refusing it', async () => {
    await env.DB.prepare(
      "insert into auth_events (id, at, kind) values ('evt_future', 1000, 'a_kind_this_build_never_declared')",
    ).run()
    const rows = await listEvents(env.DB)
    expect(rows.rows[0]?.kind).toBe('a_kind_this_build_never_declared')
  })

  it('answers null for the oldest row of an empty table, and the epoch otherwise — unaffected by ?user=', async () => {
    expect(await oldestEventAt(env.DB)).toBeNull()

    const ann = await seedUser()
    const bo = await createUser(env.DB, { email: 'bo@example.com' })
    await insert({ kind: 'sign_in', at: 5000, userId: bo.id, actor: bo.id })
    await insert({ kind: 'sign_in', at: 1000, userId: ann.id, actor: ann.id })

    // A fact about the table, not the page: filtering to `bo` (whose own
    // earliest row is 5000) must not make the table look younger than it is.
    expect(await oldestEventAt(env.DB)).toBe(1000)
    expect((await listEvents(env.DB, { user: bo.id })).rows.map((r) => r.at)).toEqual([5000])
  })

  it('sweeps events past the retention window and leaves newer ones', async () => {
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    await insert({ kind: 'sign_in', at: now - 91 * DAY, userId: null })
    await insert({ kind: 'sign_in', at: now - 89 * DAY, userId: null })

    expect(await sweepEvents(env.DB, now)).toBe(1)
    const remaining = await listEvents(env.DB)
    expect(remaining.rows).toHaveLength(1)
    expect(remaining.rows[0]?.at).toBe(now - 89 * DAY)
  })
})

/* ------------------------------------------------------- preview grants --- */

/**
 * Preview grants (`multi-site.md` decision 13, `src/server/auth/grants.ts`):
 * `readGrant` re-checks, in one statement, the session or token behind the grant
 * and the holder's current roles.
 *
 * **Every revocation here is an `update`, never a `delete`** (owner, 2026-09-29).
 * D1 in workerd pins foreign keys on, so a deleted session or grant row could be
 * removed by a cascade and the test would be watching that rather than the join.
 * An expired session, a revoked token or a grant moved to another scope leaves
 * every row in place, so the only thing that can refuse is `readGrant` itself.
 */

/** Alpha in group north, and bravo in none: enough chain for every case. */
const REGISTRY: Registry = {
  sites: [
    {
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      hosts: [],
      preview: null,
      brand: null,
    },
    {
      id: 'bravo',
      name: 'Bravo',
      group: null,
      status: 'live',
      hosts: [],
      preview: null,
      brand: null,
    },
  ],
  groups: [{ id: 'north', name: 'North', brand: null }],
  shared: true,
}
const ALPHA = { id: 'alpha', registry: REGISTRY }

async function sessionGrant(grants: Record<string, 'viewer' | 'editor' | 'publisher' | 'admin'>) {
  const user = await createUser(env.DB, { email: `g${Math.random()}@example.com`, grants })
  const session = await createSession(env.DB, user.id)
  const code = await mintGrantCode(env.DB, { sessionId: session.id }, 'alpha')
  const redeemed = await consumeGrantCode(env.DB, code.code, 'alpha')
  if (!redeemed) throw new Error('the code did not redeem')
  return { user, session, grant: redeemed.token }
}

async function tokenGrant(
  scopes: Parameters<typeof createToken>[1]['scopes'],
  site: string | null,
) {
  const minted = await createToken(env.DB, { name: `t${Math.random()}`, scopes, site })
  const code = await mintGrantCode(env.DB, { tokenId: minted.row.id }, 'alpha')
  const redeemed = await consumeGrantCode(env.DB, code.code, 'alpha')
  if (!redeemed) throw new Error('the code did not redeem')
  return { token: minted.row, grant: redeemed.token }
}

describe('readGrant', () => {
  it("answers a GrantActor for a session's grant, for its site and no other", async () => {
    const { user, grant } = await sessionGrant({ alpha: 'editor' })
    const actor = await readGrant(env.DB, grant, ALPHA)
    expect(actor).toMatchObject({ kind: 'grant', userId: user.id, tokenId: null, site: 'alpha' })
    expect(await readGrant(env.DB, grant, { id: 'bravo', registry: REGISTRY })).toBeNull()
    expect(await readGrant(env.DB, 'f'.repeat(64), ALPHA)).toBeNull()
    expect(await readGrant(env.DB, 'not hex', ALPHA)).toBeNull()
  })

  it('accepts a grant on any scope of the chain, or *, and nothing outside it', async () => {
    for (const scope of ['alpha', 'north', 'shared', '*']) {
      const { grant } = await sessionGrant({ [scope]: 'viewer' })
      expect(await readGrant(env.DB, grant, ALPHA), scope).not.toBeNull()
    }
    const { grant } = await sessionGrant({ bravo: 'admin' })
    expect(await readGrant(env.DB, grant, ALPHA)).toBeNull()
  })

  it('refuses once the session has expired, by update: the join, not a cascade', async () => {
    const { session, grant } = await sessionGrant({ alpha: 'editor' })
    expect(await readGrant(env.DB, grant, ALPHA)).not.toBeNull()
    await env.DB.prepare('update sessions set expires_at = ? where id = ?')
      .bind(Date.now() - 1, session.id)
      .run()
    // Every row is still there; only the join can refuse.
    const rows = await env.DB.prepare(
      `select (select count(*) from sessions where id = ?) as s,
              (select count(*) from site_grants where session_id = ?) as g`,
    )
      .bind(session.id, session.id)
      .first<{ s: number; g: number }>()
    expect(rows).toEqual({ s: 1, g: 1 })
    expect(await readGrant(env.DB, grant, ALPHA)).toBeNull()
  })

  it('refuses once the alpha grant is moved off the chain on the Access screen, session kept', async () => {
    const { user, session, grant } = await sessionGrant({ alpha: 'editor' })
    await env.DB.prepare(
      "update site_roles set scope_id = 'bravo' where user_id = ? and scope_id = 'alpha'",
    )
      .bind(user.id)
      .run()
    expect(await sessionExpiry(env.DB, session.id)).not.toBeNull()
    expect(await readGrant(env.DB, grant, ALPHA)).toBeNull()
  })

  it('refuses a grant past its own expiry, and an unredeemed code presented as a grant', async () => {
    const { grant } = await sessionGrant({ alpha: 'editor' })
    await env.DB.prepare('update site_grants set expires_at = ? where token_hash = ?')
      .bind(Date.now() - 1, await hashToken(grant))
      .run()
    expect(await readGrant(env.DB, grant, ALPHA)).toBeNull()

    const user = await createUser(env.DB, {
      email: 'code@example.com',
      grants: { alpha: 'editor' },
    })
    const session = await createSession(env.DB, user.id)
    const { code } = await mintGrantCode(env.DB, { sessionId: session.id }, 'alpha')
    expect(await readGrant(env.DB, code, ALPHA)).toBeNull()
  })

  it("reads a token's grant while it is unrevoked, reaches the site and holds read-draft", async () => {
    for (const site of [null, 'alpha', 'north']) {
      const { grant } = await tokenGrant(['content:read:draft'], site)
      expect(await readGrant(env.DB, grant, ALPHA), String(site)).toMatchObject({ kind: 'grant' })
    }
    // Bound somewhere that does not reach alpha, or without the scope: nothing.
    expect(
      await readGrant(env.DB, (await tokenGrant(['content:read:draft'], 'bravo')).grant, ALPHA),
    ).toBeNull()
    expect(
      await readGrant(env.DB, (await tokenGrant(['content:read:draft'], 'shared')).grant, ALPHA),
    ).toBeNull()
    expect(
      await readGrant(env.DB, (await tokenGrant(['content:read'], null)).grant, ALPHA),
    ).toBeNull()
    // `publish` implies `content:read:draft` (`roles.ts`' IMPLIES).
    expect(
      await readGrant(env.DB, (await tokenGrant(['publish'], null)).grant, ALPHA),
    ).not.toBeNull()
  })

  it("refuses a token's grant once the token is revoked, rebound or narrowed, each by update", async () => {
    const revoked = await tokenGrant(['content:read:draft'], 'alpha')
    await revokeToken(env.DB, revoked.token.id)
    expect(await readGrant(env.DB, revoked.grant, ALPHA)).toBeNull()

    const rebound = await tokenGrant(['content:read:draft'], 'alpha')
    await env.DB.prepare("update api_tokens set site_id = 'bravo' where id = ?")
      .bind(rebound.token.id)
      .run()
    expect(await readGrant(env.DB, rebound.grant, ALPHA)).toBeNull()

    const narrowed = await tokenGrant(['content:read:draft'], 'alpha')
    await env.DB.prepare(`update api_tokens set scopes = '["content:read"]' where id = ?`)
      .bind(narrowed.token.id)
      .run()
    expect(await readGrant(env.DB, narrowed.grant, ALPHA)).toBeNull()

    const expired = await tokenGrant(['content:read:draft'], 'alpha')
    await env.DB.prepare('update api_tokens set expires_at = ? where id = ?')
      .bind(Date.now() - 1, expired.token.id)
      .run()
    expect(await readGrant(env.DB, expired.grant, ALPHA)).toBeNull()
  })

  it('sweeps expired grants and grants whose session or token is gone', async () => {
    const kept = await sessionGrant({ alpha: 'editor' })
    const stale = await sessionGrant({ alpha: 'editor' })
    await env.DB.prepare('update site_grants set expires_at = ? where token_hash = ?')
      .bind(Date.now() - 1, await hashToken(stale.grant))
      .run()
    const orphan = await tokenGrant(['content:read:draft'], null)
    await revokeToken(env.DB, orphan.token.id)
    expect(await sweepGrants(env.DB)).toBe(2)
    expect(await readGrant(env.DB, kept.grant, ALPHA)).not.toBeNull()
  })
})

/**
 * Every `delete from sessions` batches that session's grants
 * (`multi-site.md` decision 13: "sessions are still deleted with their grants in
 * the same batch"). `site_grants` declares no foreign key, so nothing else could
 * remove them; the proxy records each `batch` call's statements, as SQL, so the
 * assertion is that the two deletes went **in one batch**, grants first, and the
 * rows are then gone.
 */
function recording(db: D1Database) {
  const sqlOf = new WeakMap<object, string>()
  const batches: string[][] = []
  const statement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    sqlOf.set(stmt, sql)
    const bind = stmt.bind.bind(stmt)
    return Object.assign(stmt, {
      bind: (...values: unknown[]) => statement(bind(...values), sql),
    })
  }
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => statement(target.prepare(sql), sql)
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          batches.push(stmts.map((s) => sqlOf.get(s) ?? '(unrecorded)'))
          return target.batch(stmts)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  /** Whether one batch deleted grants and then sessions. */
  const together = () =>
    batches.some((sqls) => {
      const grants = sqls.findIndex((sql) => /delete from site_grants/.test(sql))
      const sessions = sqls.findIndex((sql) => /delete from sessions/.test(sql))
      return grants !== -1 && sessions !== -1 && grants < sessions
    })
  return { db: proxy, batches, together }
}

const grantsLeft = async () =>
  (await env.DB.prepare('select count(*) as n from site_grants').first<{ n: number }>())?.n

describe('sessions are deleted with their grants in the same batch', () => {
  it('when a read finds the session expired', async () => {
    const { session, grant } = await sessionGrant({ alpha: 'editor' })
    await env.DB.prepare('update sessions set expires_at = ? where id = ?')
      .bind(Date.now() - 1, session.id)
      .run()
    const r = recording(env.DB)
    expect(await readSession(r.db, session.token)).toBeNull()
    expect(r.together()).toBe(true)
    expect(await grantsLeft()).toBe(0)
    expect(await readGrant(env.DB, grant, ALPHA)).toBeNull()
  })

  it('when a browser signs out', async () => {
    const user = await createUser(env.DB, { email: 'out@example.com', grants: { alpha: 'editor' } })
    const session = await createSession(env.DB, user.id)
    const code = await mintGrantCode(env.DB, { sessionId: session.id }, 'alpha')
    await consumeGrantCode(env.DB, code.code, 'alpha')
    const r = recording(env.DB)
    await revokeSession(r.db, session.token)
    expect(r.together()).toBe(true)
    expect(await grantsLeft()).toBe(0)
  })

  it('when every other browser is signed out, keeping this one’s grants', async () => {
    const user = await createUser(env.DB, {
      email: 'others@example.com',
      grants: { alpha: 'editor' },
    })
    const keep = await createSession(env.DB, user.id)
    const other = await createSession(env.DB, user.id)
    for (const s of [keep, other]) {
      await consumeGrantCode(
        env.DB,
        (await mintGrantCode(env.DB, { sessionId: s.id }, 'alpha')).code,
        'alpha',
      )
    }
    const r = recording(env.DB)
    expect(await revokeOtherSessions(r.db, user.id, keep.id)).toBe(1)
    expect(r.together()).toBe(true)
    const left = await env.DB.prepare('select session_id from site_grants').all<{
      session_id: string
    }>()
    expect(left.results.map((row) => row.session_id)).toEqual([keep.id])
  })

  it('when every browser a user holds is signed out, and in the statements a role change batches', async () => {
    for (const run of [
      (db: D1Database, id: string) => revokeUserSessions(db, id),
      async (db: D1Database, id: string) => {
        await db.batch(userSessionsDelete(db, id))
      },
    ]) {
      const { user } = await sessionGrant({ alpha: 'editor' })
      const r = recording(env.DB)
      await run(r.db, user.id)
      expect(r.together()).toBe(true)
      expect(await grantsLeft()).toBe(0)
    }
  })

  it('when the sweep deletes expired sessions', async () => {
    const { session } = await sessionGrant({ alpha: 'editor' })
    await env.DB.prepare('update sessions set expires_at = ? where id = ?')
      .bind(Date.now() - 1, session.id)
      .run()
    const r = recording(env.DB)
    expect(await deleteExpiredSessions(r.db)).toBe(1)
    expect(r.together()).toBe(true)
    expect(await grantsLeft()).toBe(0)
  })

  it('when a user is removed', async () => {
    const { user } = await sessionGrant({ alpha: 'editor' })
    const r = recording(env.DB)
    expect(await deleteUser(r.db, user.id)).toBe(true)
    expect(r.together()).toBe(true)
    expect(await grantsLeft()).toBe(0)
  })
})
