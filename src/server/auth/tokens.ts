/**
 * API tokens: the same hashing rule as sessions, with scopes instead of a role.
 *
 * Defined alongside sessions because they share the storage discipline and the
 * middleware that resolves them; *used* by `../../../docs/specs/platform/
 * content-api.md`, which is why the scope list is broader than anything the
 * routes in this build gate on.
 */
import { type Actor, type Scope, parseScopes } from './roles'
import { hashToken, mintApiToken } from './secrets'

export interface TokenRow {
  id: string
  name: string
  scopes: Scope[]
  createdBy: string | null
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
}

interface RawToken {
  id: string
  name: string
  scopes: string
  created_by: string | null
  created_at: number
  expires_at: number | null
  last_used_at: number | null
  revoked_at: number | null
}

const COLUMNS = 'id, name, scopes, created_by, created_at, expires_at, last_used_at, revoked_at'

function toToken(row: RawToken): TokenRow {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

export interface MintedToken {
  row: TokenRow
  /** The only time this value exists. `POST /folio/tokens` is the only response
   * that ever carries it. */
  token: string
}

export async function createToken(
  db: D1Database,
  input: {
    name: string
    scopes: readonly Scope[]
    createdBy?: string | null
    expiresAt?: number | null
  },
): Promise<MintedToken> {
  const token = mintApiToken()
  const row: TokenRow = {
    id: await hashToken(token),
    name: input.name.trim(),
    scopes: [...input.scopes],
    createdBy: input.createdBy ?? null,
    createdAt: Date.now(),
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    revokedAt: null,
  }
  await db
    .prepare(
      `insert into api_tokens (id, name, scopes, created_by, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.name, JSON.stringify(row.scopes), row.createdBy, row.createdAt, row.expiresAt)
    .run()
  return { row, token }
}

export async function listTokens(db: D1Database): Promise<TokenRow[]> {
  const { results } = await db
    .prepare(`select ${COLUMNS} from api_tokens order by created_at desc`)
    .all<RawToken>()
  return results.map(toToken)
}

/**
 * Revokes rather than deletes: `revoked_at` keeps the name in the list so
 * "which token was that, and when did we turn it off" is still answerable, and
 * the row keeps the hash so a token that leaked can never be resurrected by
 * chance.
 */
export async function revokeToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare('update api_tokens set revoked_at = ? where id = ? and revoked_at is null')
    .bind(Date.now(), id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * The actor behind a presented bearer token, or null.
 *
 * `last_used_at` is stamped either way — for a token that is about to be
 * refused for a missing scope as much as for one that is allowed — because the
 * question it answers is "is this credential in use", not "did it succeed". The
 * read and the stamp go out as one batch, so being token-authenticated costs one
 * D1 round trip, the same as being cookie-authenticated.
 *
 * A revoked or expired token answers null, which the middleware turns into 401:
 * it is a credential that no longer exists, not a credential lacking a scope.
 */
export async function readToken(
  db: D1Database,
  presented: string,
  now = Date.now(),
): Promise<Actor | null> {
  const id = await hashToken(presented)
  const [read] = await db.batch<RawToken>([
    db.prepare(`select ${COLUMNS} from api_tokens where id = ?`).bind(id),
    db.prepare('update api_tokens set last_used_at = ? where id = ?').bind(now, id),
  ])
  const raw = read?.results?.[0]
  if (!raw) return null
  const row = toToken(raw)
  if (row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt <= now) return null
  return { kind: 'token', id: row.id, name: row.name, scopes: row.scopes }
}

/** `Authorization: Bearer folio_…` → the presented token, or null. Case-
 * insensitive on the scheme, which is what RFC 7235 requires. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
