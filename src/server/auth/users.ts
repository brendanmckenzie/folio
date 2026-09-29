/**
 * The `users` table: editors, their global role, and their presence colour.
 *
 * **The role lives in `site_roles`, not on the row** (`0011_sites.sql`,
 * `../../../docs/specs/foundation/multi-site.md` decision 18). Every read here
 * takes it from the `*` grant and every write puts it there; `users.role` and
 * `users.role_from` are still columns until `0012` drops them, and nothing in
 * this file names either. `test/workers/users-contract.test.ts` runs this module
 * against a database with those columns gone, which is the only proof a column
 * is unread: a grep for `users.role` matches neither `u.role` nor a `COLUMNS`
 * string.
 *
 * Pure over a `D1Database`, with no Request anywhere — the same discipline
 * stories.ts and versions.ts already keep, and for the same reason: the routes
 * are a translation layer, and a scheduled job or a Durable Object alarm has no
 * request to derive anything from.
 */
import { fallbackColour } from '../../core/protocol'
import { userGrantsDelete } from './grants'
import { type Grants, type Role, isRole } from './roles'
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
  /**
   * Every grant they hold, `*` included, each with who set it
   * (`../../../docs/specs/foundation/multi-site.md` decision 10). `role` and
   * `roleFrom` above are the `*` entry's, which is all there is with no `sites`.
   * Ordered by scope id, so a list of them compares by value.
   */
  grants: readonly UserGrant[]
  createdAt: number
  lastSeenAt: number | null
}

/** One `site_roles` row, as the Access screen shows it. */
export interface UserGrant {
  scope: string
  role: Role
  /** Null for a grant Folio placed; a provider id for one a sign-in's claims set. */
  roleFrom: string | null
}

interface RawUser {
  id: string
  email: string
  name: string
  colour: string | null
  /** Null when the user holds no `*` grant. */
  role: string | null
  provider: string | null
  role_from: string | null
  /** `json_group_array` of `{ scope, role, from }`. */
  grants: string | null
  created_at: number
  last_seen_at: number | null
}

/**
 * A row whose `role` is not one this build declares reads as `viewer`, the
 * weakest: a database written by a newer deploy must not fail *open*. So does a
 * row with no `*` grant at all.
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
    grants: parseGrantRows(row.grants),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

/** The grant rows `COLUMNS` aggregates, screened like `role`: an undeclared role
 * is dropped. Sorted by scope, `*` first, so two sets compare by value. */
function parseGrantRows(json: string | null): UserGrant[] {
  let value: unknown
  try {
    value = JSON.parse(json ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const out: UserGrant[] = []
  for (const entry of value) {
    const { scope, role, from } = (entry ?? {}) as {
      scope?: unknown
      role?: unknown
      from?: unknown
    }
    if (typeof scope !== 'string' || !isRole(role)) continue
    out.push({ scope, role, roleFrom: typeof from === 'string' ? from : null })
  }
  return out.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
}

/**
 * The row, with the role and who decided it read off the `*` grant.
 *
 * Correlated subqueries rather than a join: `listUsers` resumes a keyset over
 * bare `created_at` and `id`, and `site_roles` has a `created_at` of its own, so
 * a join would make the cursor's column ambiguous. Each subquery is one probe of
 * `site_roles`' primary key. A user with no `*` grant reads a null role, which
 * `toUser` answers as `viewer` — the same fail-closed reading an unknown role gets.
 */
const COLUMNS = `id, email, name, colour, provider, created_at, last_seen_at,
  (select role from site_roles where user_id = users.id and scope_id = '*') as role,
  (select role_from from site_roles where user_id = users.id and scope_id = '*') as role_from,
  (select json_group_array(json_object('scope', scope_id, 'role', role, 'from', role_from))
     from site_roles where user_id = users.id) as grants`

/**
 * A user's whole grant set, replaced: every row goes, then one per entry, each
 * stamped `roleFrom` (`multi-site.md` decision 17's "the mapper's answer replaces
 * the whole set"; the Access screen's edit is the same replacement by hand).
 * Unrun, for a caller to batch with what the change owes — a session purge, an
 * `auth_events` row.
 */
export function replaceGrantsStatements(
  db: FolioDb,
  userId: string,
  grants: Grants,
  roleFrom: string | null,
  at = Date.now(),
): D1PreparedStatement[] {
  return [
    db.prepare('delete from site_roles where user_id = ?').bind(userId),
    ...Object.entries(grants).map(([scope, role]) =>
      db
        .prepare(
          `insert into site_roles (user_id, scope_id, role, role_from, created_at)
           values (?, ?, ?, ?, ?)`,
        )
        .bind(userId, scope, role, roleFrom, at),
    ),
  ]
}

/** The set as a plain `Grants` map, for comparing and for `effectiveRole`. */
export function grantMap(grants: readonly UserGrant[]): Grants {
  return Object.fromEntries(grants.map((g) => [g.scope, g.role]))
}

/**
 * The `*` grant, written or replaced. `role_from` is set by whoever decided the
 * role: null for Folio, a provider id for claims.
 */
export function grantStatement(
  db: FolioDb,
  userId: string,
  role: Role,
  roleFrom: string | null,
  at = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `insert into site_roles (user_id, scope_id, role, role_from, created_at)
       values (?, '*', ?, ?, ?)
       on conflict (user_id, scope_id) do update set role = excluded.role, role_from = excluded.role_from`,
    )
    .bind(userId, role, roleFrom, at)
}

/**
 * A `json_group_object(scope_id, role)` read back as `Grants`. A role this build
 * does not declare is dropped rather than read, so a database written by a newer
 * deploy narrows a person's reach instead of failing open; malformed JSON is no
 * grants at all.
 */
export function parseGrantMap(json: string | null): Grants {
  if (!json) return {}
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, Role> = {}
  for (const [scope, role] of Object.entries(value)) if (isRole(role)) out[scope] = role
  return out
}

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
  /**
   * A whole grant set in place of `role` (`multi-site.md` decisions 10 and 17):
   * the invitation of a site editor, or a sign-in whose mapper placed scopes. Every
   * entry is stamped `roleFrom`. Absent, the user gets the one `*` grant at `role`.
   */
  grants?: Grants
}

/**
 * Creates an editor. The name defaults to the local part of the address, so
 * inviting someone is one field: they can be renamed, and an OIDC sign-in
 * overwrites it with the name the provider asserts.
 */
export async function createUser(db: FolioDb, input: UserInput): Promise<UserRow> {
  const { user, statements } = createUserStatement(db, input)
  await db.batch(statements)
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
 *
 * **The row first, then its grants**, which name the row: the one `*` grant at
 * `role`, or one row per entry of `grants`. The insert does not name `role`, so the column's default fills it while it
 * exists and nothing breaks when `0012` drops it.
 */
export function createUserStatement(
  db: FolioDb,
  input: UserInput,
  at = Date.now(),
): { user: UserRow; statements: D1PreparedStatement[] } {
  const email = normaliseEmail(input.email)
  const roleFrom = input.roleFrom ?? null
  const set: Grants = input.grants ?? { '*': input.role ?? 'editor' }
  const star = set['*']
  const user: UserRow = {
    id: mintId('usr'),
    email,
    name: input.name?.trim() || email.split('@')[0] || email,
    colour: input.colour ?? null,
    // A set with no `*` entry reads `viewer` there, as `toUser` answers it.
    role: star ?? 'viewer',
    provider: input.provider ?? null,
    roleFrom: star === undefined ? null : roleFrom,
    grants: Object.entries(set)
      .map(([scope, role]) => ({ scope, role, roleFrom }))
      .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)),
    createdAt: at,
    lastSeenAt: null,
  }
  const statements = [
    db
      .prepare(
        `insert into users (id, email, name, colour, provider, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(user.id, user.email, user.name, user.colour, user.provider, user.createdAt),
    ...(input.grants
      ? replaceGrantsStatements(db, user.id, set, roleFrom, at).slice(1)
      : [grantStatement(db, user.id, star ?? 'editor', roleFrom, at)]),
  ]
  return { user, statements }
}

/**
 * Renames a user or changes their role. Absent keys are left alone rather than
 * nulled, so a role change is one field and cannot silently rename anyone.
 *
 * The grant is written only when `role` is in the patch, carrying `role_from`
 * through unchanged, as the old `update users set role = ?` did
 * (`PATCH /api/users/:id` refuses a role a provider placed before it gets this
 * far, so through the route it is null). The old column write on every patch is
 * what made a mirroring trigger unsafe (decision 18).
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
    grants:
      patch.role === undefined
        ? current.grants
        : [
            { scope: '*', role: patch.role, roleFrom: current.roleFrom },
            ...current.grants.filter((g) => g.scope !== '*'),
          ],
  }
  const row = db
    .prepare('update users set name = ?, colour = ? where id = ?')
    .bind(next.name, next.colour, id)
  if (patch.role === undefined) {
    await row.run()
    return next
  }
  await db.batch([row, grantStatement(db, id, next.role, next.roleFrom)])
  return next
}

/**
 * Removes an editor, every session they hold and the preview grants on them, every
 * passkey they enrolled and every grant they hold, in one batch.
 *
 * All three deletes are explicit rather than left to the `on delete cascade`
 * their columns declare: whether D1 enforces foreign keys is a property of the
 * database, and "removing someone's access takes effect immediately" is the
 * entire point of this feature — too load-bearing to rest on a pragma.
 * `test/workers/auth-session.test.ts` records the batch's statements through a
 * proxy and asserts the passkeys and grants deletes are in it, ahead of the
 * row's own, and that nothing is left behind. It cannot turn foreign keys off to watch the batch
 * alone: D1 in workerd pins `PRAGMA foreign_keys` at 1, so the cascade would
 * fire either way, and only the recorded statement says the batch did it.
 *
 * Their *history* is not touched: `versions.actor` and `auth_events.user_id`
 * store strings, not foreign keys, so an access change never rewrites the record
 * of who changed what.
 */
export async function deleteUser(db: FolioDb, id: string): Promise<boolean> {
  const existing = await userById(db, id)
  if (!existing) return false
  await db.batch([
    // Every preview grant their sessions held (`grants.ts`), ahead of the sessions
    // its subquery finds them through. Spelled out rather than `session.ts`'s
    // `userSessionsDelete`, which would make the two files import each other.
    userGrantsDelete(db, id),
    db.prepare('delete from sessions where user_id = ?').bind(id),
    // `foundation/passkeys.md`: a credential that outlived its account would be
    // an orphan row whose `user_id` no longer resolves, and `passkeyForAssertion`
    // would spend a round trip on it at every sign-in attempt.
    db.prepare('delete from passkeys where user_id = ?').bind(id),
    // Every scope, not only `*`: a grant naming a removed user is an orphan the
    // Access screen would list against nobody.
    db.prepare('delete from site_roles where user_id = ?').bind(id),
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
