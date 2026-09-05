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
import { clampLimit, decodeCursor, type Page, paginate } from '../../core/pagination'
import { keysetWhere, OLDEST_FIRST, orderBy, whereOf } from '../keyset'
import type { FolioDb } from '../db'

export interface UserRow {
  id: string
  email: string
  name: string
  /** Null in the database; `userColour` derives one deterministically. */
  colour: string | null
  role: Role
  /** How they last signed in: a provider id, or null for an invited user who
   * never has. Stamped inside `completeSignIn`'s batch, by every kind. */
  provider: string | null
  /**
   * Who decided their role: null for Folio — an admin invited or edited them —
   * or the id of the provider whose claims placed it
   * (`../../../docs/specs/foundation/auth-providers.md` decision 5).
   */
  roleFrom: string | null
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
  role_from: string | null
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
    roleFrom: row.role_from,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

const COLUMNS = 'id, email, name, colour, role, provider, role_from, created_at, last_seen_at'

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

export async function userById(db: FolioDb, id: string): Promise<UserRow | null> {
  const row = await db
    .prepare(`select ${COLUMNS} from users where id = ?`)
    .bind(id)
    .first<RawUser>()
  return row ? toUser(row) : null
}

export async function userByEmail(db: FolioDb, email: string): Promise<UserRow | null> {
  const row = await db
    .prepare(`select ${COLUMNS} from users where email = ?`)
    .bind(normaliseEmail(email))
    .first<RawUser>()
  return row ? toUser(row) : null
}

/**
 * Editors, in the order they joined, paged over `(created_at, id)` — which
 * `users_created` indexes, added by the schema collapse because this reader had
 * been ordering by an unindexed column
 * (`../../../docs/specs/foundation/pagination.md`).
 *
 * Oldest first, unlike every other paged list here: an editors table is read as a
 * roster rather than as a feed, and the person who set the site up belongs at the
 * top.
 */
export async function listUsers(
  db: FolioDb,
  opts: { limit?: number; cursor?: string; count?: boolean } = {},
): Promise<Page<UserRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const resume = keysetWhere(OLDEST_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLUMNS} from users ${whereOf(resume.sql)} ${orderBy(OLDEST_FIRST)} limit ?`,
      )
      .bind(...resume.binds, limit + 1)
      .all<RawUser>(),
    opts.count ? db.prepare('select count(*) as n from users').first<{ n: number }>() : null,
  ])
  const page = paginate(rows.results.map(toUser), limit, (row) => [row.createdAt, row.id])
  return total ? { ...page, total: total.n } : page
}

export interface UserInput {
  email: string
  name?: string
  role?: Role
  colour?: string | null
  provider?: string | null
  /** The provider whose claims placed `role`, when one did. */
  roleFrom?: string | null
}

/**
 * Creates an editor. The name defaults to the local part of the address, so
 * inviting someone is one field: they can be renamed, and an OIDC sign-in
 * overwrites it with the name the provider asserts.
 */
export async function createUser(db: FolioDb, input: UserInput): Promise<UserRow> {
  const { user, statement } = createUserStatement(db, input)
  await statement.run()
  return user
}

/**
 * The same insert, unrun, plus the row it will produce.
 *
 * `completeSignIn` provisions a user and mints their session in **one** batch
 * (`../../../docs/specs/foundation/auth-providers.md` decision 3), so it needs
 * the id before the write happens — which it does, because the id is minted here
 * rather than by the database. `createUser` above is the same thing for a caller
 * with nothing to batch it with.
 */
export function createUserStatement(
  db: FolioDb,
  input: UserInput,
  at = Date.now(),
): { user: UserRow; statement: D1PreparedStatement } {
  const email = normaliseEmail(input.email)
  const user: UserRow = {
    id: mintId('usr'),
    email,
    name: input.name?.trim() || email.split('@')[0] || email,
    colour: input.colour ?? null,
    role: input.role ?? 'editor',
    provider: input.provider ?? null,
    roleFrom: input.roleFrom ?? null,
    createdAt: at,
    lastSeenAt: null,
  }
  const statement = db
    .prepare(
      `insert into users (id, email, name, colour, role, provider, role_from, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.email,
      user.name,
      user.colour,
      user.role,
      user.provider,
      user.roleFrom,
      user.createdAt,
    )
  return { user, statement }
}

/**
 * Renames a user or changes their role. Absent keys are left alone rather than
 * nulled, so a role change is one field and cannot silently rename anyone.
 */
export async function updateUser(
  db: FolioDb,
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
export async function deleteUser(db: FolioDb, id: string): Promise<boolean> {
  const existing = await userById(db, id)
  if (!existing) return false
  await db.batch([
    db.prepare('delete from sessions where user_id = ?').bind(id),
    db.prepare('delete from users where id = ?').bind(id),
  ])
  return true
}

/**
 * Stamped on sign-in: `last_seen_at`, which answers "is this account still in
 * use" for whoever is pruning the list, and `provider`, which answers "how did
 * they last get in".
 *
 * **The provider stamp lives here and not at a call site**, which is the point.
 * It used to be written by `createUser` on the OIDC callback and nowhere else,
 * so every magic-link user read "—" in the Access screen's "Signs in with"
 * column for as long as the column existed. Folding it into the one statement
 * every sign-in batches makes forgetting it impossible.
 *
 * An absent `provider` leaves the column alone rather than nulling it: a caller
 * with no provider in hand is touching the row, not re-answering the question.
 */
export function touchUserStatement(
  db: FolioDb,
  id: string,
  at = Date.now(),
  provider?: string | null,
): D1PreparedStatement {
  if (provider === undefined) {
    return db.prepare('update users set last_seen_at = ? where id = ?').bind(at, id)
  }
  return db
    .prepare('update users set last_seen_at = ?, provider = ? where id = ?')
    .bind(at, provider, id)
}
