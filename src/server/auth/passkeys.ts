/**
 * The `passkeys` table: one WebAuthn credential per row, enrolled by somebody
 * who was already signed in.
 *
 * Pure over a `FolioDb` with no `Request` anywhere, the discipline `users.ts`
 * and `tokens.ts` already keep. The verification that decides whether a row may
 * be written at all is `webauthn.ts`'s and happens before any of this is called:
 * nothing here validates a signature, and nothing in `webauthn.ts` touches D1.
 *
 * **Nothing here is a secret.** `public_key` is the authenticator's *public*
 * key, so unlike `sessions` and `api_tokens` there is no hash-on-write rule to
 * keep — a dumped database yields nobody a sign-in. The consequence worth
 * stating is the other direction: a credential id is not a credential either, so
 * `passkeyForAssertion` is safe to call on whatever a browser sent, and the
 * route's uniform refusal is what stops the *answer* from being an oracle.
 */
import type { FolioDb } from '../db'
import { base64url, fromBase64url } from './jwt'
import type { RegisteredCredential } from './webauthn'
import { type UserRow, userById } from './users'

/**
 * Ten per person.
 *
 * A bound rather than a limit anybody will reach: a laptop, a phone, a tablet
 * and a security key is four, and the tenth is somebody who has stopped pruning.
 * It exists so `excludeCredentials` — sent to the browser on every enrolment —
 * cannot grow without limit, and so an authenticated write loop cannot fill a
 * table. `passkeys_user` indexes the read either way.
 */
export const MAX_PASSKEYS_PER_USER = 10

/** The longest name the account screen accepts. Bounded here rather than at the
 * column so the refusal is a 400 with a message rather than a D1 error. */
export const MAX_PASSKEY_NAME = 60

/**
 * A passkey as every list route answers it. **No `publicKey`** — deliberately,
 * so a route cannot hand one out by spreading the row it already has. The
 * assertion path asks for `PasskeyCredential` explicitly and is the only reader
 * of the key.
 */
export interface PasskeyRow {
  id: string
  userId: string
  alg: number
  transports: string[] | null
  aaguid: string | null
  name: string
  backedUp: boolean
  createdAt: number
  lastUsedAt: number | null
}

/** The row plus the key, for the one path that verifies a signature. */
export interface PasskeyCredential extends PasskeyRow {
  publicKey: Uint8Array<ArrayBuffer>
  counter: number
}

interface RawPasskey {
  id: string
  user_id: string
  public_key: string
  alg: number
  counter: number
  transports: string | null
  aaguid: string | null
  name: string
  backed_up: number
  created_at: number
  last_used_at: number | null
}

/** Everything but `public_key` and `counter`: the list projection, spelled out
 * field by field for the reason `authPolicy()` spells its own out — so the day
 * somebody adds a column, handing it to a screen is a decision rather than a
 * consequence of `select *`. */
const COLUMNS = 'id, user_id, alg, transports, aaguid, name, backed_up, created_at, last_used_at'

/** The list projection plus the two the assertion path needs. */
const ALL_COLUMNS =
  'id, user_id, public_key, alg, counter, transports, aaguid, name, backed_up, created_at, last_used_at'

/** `transports` is advisory and browser-written; a row that does not parse reads
 * as "the browser did not say", which is what null already means. */
function parseTransports(value: string | null): string[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const out = parsed.filter((t): t is string => typeof t === 'string')
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

function toPasskey(row: RawPasskey): PasskeyRow {
  return {
    id: row.id,
    userId: row.user_id,
    alg: row.alg,
    transports: parseTransports(row.transports),
    aaguid: row.aaguid,
    name: row.name,
    backedUp: row.backed_up !== 0,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

/** Oldest first, which is `passkeys_user`'s own order and the order the account
 * screen reads: the one you enrolled first is the one you are least likely to be
 * looking for, and a list that reorders itself on use is a list you cannot scan. */
export async function listPasskeys(db: FolioDb, userId: string): Promise<PasskeyRow[]> {
  const { results } = await db
    .prepare(`select ${COLUMNS} from passkeys where user_id = ? order by created_at, id`)
    .bind(userId)
    .all<RawPasskey>()
  return results.map(toPasskey)
}

/**
 * Stores a credential `verifyRegistration` accepted.
 *
 * Answers `null` for a credential id the table already holds — which the route
 * turns into 409 — rather than throwing a D1 constraint error, because a
 * duplicate is a *browser* re-submitting, not a bug. `on conflict do nothing`
 * decides it in the same round trip a pre-read would have spent asking.
 */
export async function createPasskey(
  db: FolioDb,
  userId: string,
  registered: RegisteredCredential,
  name: string,
  at = Date.now(),
): Promise<PasskeyRow | null> {
  const row: PasskeyRow = {
    id: registered.id,
    userId,
    alg: registered.alg,
    transports: registered.transports,
    aaguid: registered.aaguid,
    name: name.trim().slice(0, MAX_PASSKEY_NAME),
    backedUp: registered.backedUp,
    createdAt: at,
    lastUsedAt: null,
  }
  const result = await db
    .prepare(
      `insert into passkeys
         (id, user_id, public_key, alg, counter, transports, aaguid, name, backed_up, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do nothing`,
    )
    .bind(
      row.id,
      row.userId,
      // base64url rather than a blob: every column in this schema is text or
      // integer, and a D1 blob's shape across drivers is then nobody's problem.
      base64url(registered.publicKey),
      row.alg,
      registered.counter,
      row.transports ? JSON.stringify(row.transports) : null,
      row.aaguid,
      row.name,
      row.backedUp ? 1 : 0,
      row.createdAt,
    )
    .run()
  return (result.meta.changes ?? 0) > 0 ? row : null
}

/** `user_id` is in the `where`, not checked after the read: an id belonging to
 * somebody else is indistinguishable from an id that does not exist, which is
 * the 404 the route answers and the only answer that is not an oracle. */
export async function renamePasskey(
  db: FolioDb,
  userId: string,
  id: string,
  name: string,
): Promise<PasskeyRow | null> {
  const trimmed = name.trim().slice(0, MAX_PASSKEY_NAME)
  const result = await db
    .prepare('update passkeys set name = ? where id = ? and user_id = ?')
    .bind(trimmed, id, userId)
    .run()
  if ((result.meta.changes ?? 0) === 0) return null
  const row = await db
    .prepare(`select ${COLUMNS} from passkeys where id = ?`)
    .bind(id)
    .first<RawPasskey>()
  return row ? toPasskey(row) : null
}

/** Own only, for the reason `renamePasskey` gives. */
export async function deletePasskey(db: FolioDb, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('delete from passkeys where id = ? and user_id = ?')
    .bind(id, userId)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/** The admin's "remove all passkeys": one incident, one action. How many went is
 * what the route reports, so an admin can see whether there was anything to
 * remove at all. */
export async function deleteUserPasskeys(db: FolioDb, userId: string): Promise<number> {
  const result = await db.prepare('delete from passkeys where user_id = ?').bind(userId).run()
  return result.meta.changes ?? 0
}

/**
 * The credential a browser named, and whose account it belongs to.
 *
 * One statement rather than a probe and then `userById`: an assertion is the hot
 * path of a sign-in, and the row is useless without the user. A credential whose
 * user row has gone answers null, which the route turns into the same generic
 * 401 as an id that never existed.
 */
export async function passkeyForAssertion(
  db: FolioDb,
  credentialId: string,
): Promise<{ passkey: PasskeyCredential; user: UserRow } | null> {
  const row = await db
    .prepare(`select ${ALL_COLUMNS} from passkeys where id = ?`)
    .bind(credentialId)
    .first<RawPasskey>()
  if (!row) return null
  const user = await userById(db, row.user_id)
  if (!user) return null
  return {
    passkey: {
      ...toPasskey(row),
      counter: row.counter,
      publicKey: fromBase64url(row.public_key),
    },
    user,
  }
}

/**
 * The stamp a successful assertion makes: the counter the authenticator just
 * reported, the backup state it just asserted, and when.
 *
 * **Unrun**, so it joins `completeSignIn`'s batch rather than costing a second
 * round trip — the discipline `touchUserStatement` established and the reason
 * signing in with a passkey is one write, not three.
 */
export function usePasskeyStatement(
  db: FolioDb,
  id: string,
  counter: number,
  backedUp: boolean,
  at = Date.now(),
): D1PreparedStatement {
  return db
    .prepare('update passkeys set counter = ?, backed_up = ?, last_used_at = ? where id = ?')
    .bind(counter, backedUp ? 1 : 0, at, id)
}

/**
 * How many passkeys each of these users holds, for the Access screen's column.
 *
 * One grouped statement over the page of ids the list already read, rather than
 * a count per row: the list is paged at 50, so the alternative is fifty round
 * trips for one column. Users with none are absent from the map, which is the
 * "—" the screen renders.
 */
export async function countPasskeysByUser(
  db: FolioDb,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map()
  const placeholders = userIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `select user_id, count(*) as n from passkeys
       where user_id in (${placeholders}) group by user_id`,
    )
    .bind(...userIds)
    .all<{ user_id: string; n: number }>()
  return new Map(results.map((r) => [r.user_id, r.n]))
}
