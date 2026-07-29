/**
 * The `users` table: editors, their global role, and their presence colour.
 *
 * Pure over a `D1Database`, with no Request anywhere — the same discipline
 * stories.ts and versions.ts already keep, and for the same reason: the routes
 * are a translation layer, and a scheduled job or a Durable Object alarm has no
 * request to derive anything from.
 */
import { fallbackColour } from '../../core/protocol'
import { type Role, isRole } from './roles'
import { mintId } from './secrets'

export interface UserRow {
  id: string
  email: string
  name: string
  /** Null in the database; `userColour` derives one deterministically. */
  colour: string | null
  role: Role
  provider: string | null
  createdAt: number
  lastSeenAt: number | null
}

interface RawUser {
  id: string
  email: string
  name: string
  colour: string | null
  role: string
  provider: string | null
  created_at: number
  last_seen_at: number | null
}

/**
 * A row whose `role` is not one this build declares reads as `viewer`, the
 * weakest: a database written by a newer deploy must not fail *open*.
 */
function toUser(row: RawUser): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    colour: row.colour,
    role: isRole(row.role) ? row.role : 'viewer',
    provider: row.provider,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

const COLUMNS = 'id, email, name, colour, role, provider, created_at, last_seen_at'

/**
 * The colour presence shows for a user. `fallbackColour` is the same derivation
 * the wire protocol already uses for a client that asserted a malformed one, so
 * a user row with no colour and a socket with no colour land on the same value.
 */
export function userColour(user: UserRow): string {
  return user.colour ?? fallbackColour(user.id)
}

/** Addresses are compared and stored lowercased: one account per address, not
 * one per spelling of it. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function userById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db
    .prepare(`select ${COLUMNS} from users where id = ?`)
    .bind(id)
    .first<RawUser>()
  return row ? toUser(row) : null
}

export async function userByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const row = await db
    .prepare(`select ${COLUMNS} from users where email = ?`)
    .bind(normaliseEmail(email))
    .first<RawUser>()
  return row ? toUser(row) : null
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`select ${COLUMNS} from users order by created_at`)
    .all<RawUser>()
  return results.map(toUser)
}

export interface UserInput {
  email: string
  name?: string
  role?: Role
  colour?: string | null
  provider?: string | null
}

/**
 * Creates an editor. The name defaults to the local part of the address, so
 * inviting someone is one field: they can be renamed, and an OIDC sign-in
 * overwrites it with the name the provider asserts.
 */
export async function createUser(db: D1Database, input: UserInput): Promise<UserRow> {
  const email = normaliseEmail(input.email)
  const user: UserRow = {
    id: mintId('usr'),
    email,
    name: input.name?.trim() || email.split('@')[0] || email,
    colour: input.colour ?? null,
    role: input.role ?? 'editor',
    provider: input.provider ?? null,
    createdAt: Date.now(),
    lastSeenAt: null,
  }
  await db
    .prepare(
      `insert into users (id, email, name, colour, role, provider, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(user.id, user.email, user.name, user.colour, user.role, user.provider, user.createdAt)
    .run()
  return user
}

/**
 * Renames a user or changes their role. Absent keys are left alone rather than
 * nulled, so a role change is one field and cannot silently rename anyone.
 */
export async function updateUser(
  db: D1Database,
  id: string,
  patch: { name?: string; role?: Role; colour?: string | null },
): Promise<UserRow | null> {
  const current = await userById(db, id)
  if (!current) return null
  const next: UserRow = {
    ...current,
    name: patch.name?.trim() || current.name,
    role: patch.role ?? current.role,
    colour: patch.colour === undefined ? current.colour : patch.colour,
  }
  await db
    .prepare('update users set name = ?, role = ?, colour = ? where id = ?')
    .bind(next.name, next.role, next.colour, id)
    .run()
  return next
}

/**
 * Removes an editor and every session they hold, in one batch.
 *
 * The sessions delete is explicit rather than left to the `on delete cascade`
 * in 0007: whether D1 enforces foreign keys is a property of the database, and
 * "removing someone's access takes effect immediately" is the entire point of
 * this feature — too load-bearing to rest on a pragma. Their *history* is not
 * touched: `versions.actor` stores a string, not a foreign key, so an access
 * change never rewrites the record of who changed what.
 */
export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  const existing = await userById(db, id)
  if (!existing) return false
  await db.batch([
    db.prepare('delete from sessions where user_id = ?').bind(id),
    db.prepare('delete from users where id = ?').bind(id),
  ])
  return true
}

/** Stamped on sign-in, and nothing gates on it: it answers "is this account
 * still in use" for whoever is pruning the list. */
export function touchUserStatement(
  db: D1Database,
  id: string,
  at = Date.now(),
): D1PreparedStatement {
  return db.prepare('update users set last_seen_at = ? where id = ?').bind(at, id)
}
