/**
 * Sessions: create one, read the actor behind a cookie, revoke, prune.
 *
 * Pure over a `D1Database` — no Request, no Hono — so the middleware, the login
 * routes and the Durable Object's revocation re-check all reach the same three
 * functions rather than each writing their own SQL against the same two tables.
 */
import type { Actor, Role } from './roles'
import { isRole } from './roles'
import { hashToken, mintSecret } from './secrets'
import { type UserRow, touchUserStatement, userColour } from './users'
import type { FolioDb } from '../db'

/** Default session length. Overridable with `AuthConfig.sessionDays`. */
export const DEFAULT_SESSION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How much of a session's life must elapse before a read renews it. Half:
 * renewing on every request would be a D1 write per request, and renewing only
 * near the end means a browser that is used daily still gets logged out on the
 * one day it is not.
 */
const RENEW_AFTER = 0.5

export interface NewSession {
  /** The raw token. Goes in the cookie and nowhere else — it is not stored. */
  token: string
  /** `sessions.id`: the SHA-256 of `token`. */
  id: string
  expiresAt: number
}

/**
 * Mints a session for a user. The raw token is returned to the caller (which
 * puts it in a `Set-Cookie` and forgets it); only its hash is written, so a
 * leaked database yields no usable cookies.
 */
export async function createSession(
  db: FolioDb,
  userId: string,
  opts: { days?: number; userAgent?: string | null; provider?: string | null } = {},
): Promise<NewSession> {
  const session = await newSession(opts)
  await db.batch(sessionStatements(db, userId, session, opts))
  return session
}

/**
 * The token, its hash and its expiry, with nothing written yet.
 *
 * Split from `createSession` for `completeSignIn`, which provisions a user,
 * mints a session, stamps the provider and appends an event in **one** batch
 * (`../../../docs/specs/foundation/auth-providers.md` decision 3) and therefore
 * cannot use a function that runs its own.
 */
export async function newSession(opts: { days?: number; now?: number } = {}): Promise<NewSession> {
  const token = mintSecret()
  const id = await hashToken(token)
  const now = opts.now ?? Date.now()
  return { token, id, expiresAt: now + (opts.days ?? DEFAULT_SESSION_DAYS) * DAY_MS }
}

/**
 * The two statements a fresh session always writes: the row itself, and the
 * `users` touch that stamps `last_seen_at` and the provider that minted it.
 *
 * `provider` is threaded through both, so `sessions.provider` (which logout
 * reads to decide where the browser goes next) and `users.provider` (which the
 * Access screen draws) cannot disagree.
 */
export function sessionStatements(
  db: FolioDb,
  userId: string,
  session: NewSession,
  opts: { userAgent?: string | null; provider?: string | null; now?: number } = {},
): D1PreparedStatement[] {
  const now = opts.now ?? Date.now()
  return [
    db
      .prepare(
        `insert into sessions (id, user_id, created_at, expires_at, user_agent, provider)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        userId,
        now,
        session.expiresAt,
        opts.userAgent?.slice(0, 300) ?? null,
        opts.provider ?? null,
      ),
    touchUserStatement(db, userId, now, opts.provider ?? undefined),
  ]
}

interface SessionJoin {
  session_id: string
  expires_at: number
  created_at: number
  user_id: string
  email: string
  name: string
  colour: string | null
  role: string
  provider: string | null
  role_from: string | null
}

/**
 * The actor behind a raw cookie token, or null.
 *
 * One indexed read joining `sessions` to `users`: the middleware needs the role
 * and the display name on every request, and two queries for one credential
 * would double the per-request D1 cost of being signed in at all.
 *
 * An expired row answers null *and* is deleted, so an abandoned tab prunes its
 * own session on the request that discovers it — the periodic sweep
 * (`deleteExpiredSessions`) exists for the sessions nobody ever comes back to.
 * A row whose user has been removed answers null for free: the join finds
 * nothing.
 */
export async function readSession(
  db: FolioDb,
  token: string,
  opts: { days?: number; now?: number } = {},
): Promise<Actor | null> {
  const id = await hashToken(token)
  const row = await db
    .prepare(
      `select s.id as session_id, s.expires_at, s.created_at,
              u.id as user_id, u.email, u.name, u.colour, u.role, u.provider, u.role_from
         from sessions s join users u on u.id = s.user_id
        where s.id = ?`,
    )
    .bind(id)
    .first<SessionJoin>()
  if (!row) return null

  const now = opts.now ?? Date.now()
  if (row.expires_at <= now) {
    await db.prepare('delete from sessions where id = ?').bind(id).run()
    return null
  }

  // Sliding renewal, past the halfway mark only: see RENEW_AFTER.
  const days = opts.days ?? DEFAULT_SESSION_DAYS
  const life = days * DAY_MS
  let expiresAt = row.expires_at
  if (now - row.created_at > life * RENEW_AFTER) {
    expiresAt = now + life
    await db
      .prepare('update sessions set created_at = ?, expires_at = ? where id = ?')
      .bind(now, expiresAt, id)
      .run()
  }

  const user: UserRow = {
    id: row.user_id,
    email: row.email,
    name: row.name,
    colour: row.colour,
    role: isRole(row.role) ? row.role : 'viewer',
    // From the join, not a hard-coded null. It read `null` here for as long as
    // the column existed, which cost nothing until `completeSignIn` made the
    // column true and `/me` had a reader for it.
    provider: row.provider,
    roleFrom: row.role_from,
    createdAt: row.created_at,
    lastSeenAt: null,
  }
  return {
    kind: 'user',
    id: user.id,
    name: user.name,
    colour: userColour(user),
    role: user.role as Role,
    session: id,
    expiresAt,
  }
}

/** Whether a session id is still live, without loading the user. What the
 * Durable Object's periodic re-check asks (checkpoint 5). */
export async function sessionExpiry(db: FolioDb, sessionId: string): Promise<number | null> {
  const row = await db
    .prepare('select expires_at from sessions where id = ?')
    .bind(sessionId)
    .first<{ expires_at: number }>()
  return row?.expires_at ?? null
}

/** Signs out one browser. Takes the raw cookie token, since that is what the
 * logout route has. */
export async function revokeSession(db: FolioDb, token: string): Promise<void> {
  await db
    .prepare('delete from sessions where id = ?')
    .bind(await hashToken(token))
    .run()
}

/** Signs out every browser a user holds — what a role downgrade or a "sign out
 * everywhere" acts on. */
export async function revokeUserSessions(db: FolioDb, userId: string): Promise<void> {
  await db.prepare('delete from sessions where user_id = ?').bind(userId).run()
}

/** Housekeeping for sessions nobody returns to. Not on any request path. */
export async function deleteExpiredSessions(db: FolioDb, now = Date.now()): Promise<number> {
  const result = await db.prepare('delete from sessions where expires_at <= ?').bind(now).run()
  return result.meta.changes ?? 0
}
