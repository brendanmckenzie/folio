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
import { clampLimit, decodeCursor, type Page, paginate } from '../../core/pagination'
import { keysetWhere, NEWEST_FIRST, orderBy, whereOf } from '../keyset'
import type { FolioDb } from '../db'

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
  db: FolioDb,
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

/**
 * Newest first, paged over `(created_at, id)` — `api_tokens_created` indexes the
 * first component and `id` is the primary key.
 *
 * Revoked rows stay in the list, which is why this needs paging at all: nothing is
 * ever deleted here, so the list only grows.
 */
export async function listTokens(
  db: FolioDb,
  opts: { limit?: number; cursor?: string; count?: boolean } = {},
): Promise<Page<TokenRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const resume = keysetWhere(NEWEST_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLUMNS} from api_tokens ${whereOf(resume.sql)} ${orderBy(NEWEST_FIRST)} limit ?`,
      )
      .bind(...resume.binds, limit + 1)
      .all<RawToken>(),
    opts.count ? db.prepare('select count(*) as n from api_tokens').first<{ n: number }>() : null,
  ])
  const page = paginate(rows.results.map(toToken), limit, (row) => [row.createdAt, row.id])
  return total ? { ...page, total: total.n } : page
}

/**
 * Revokes rather than deletes: `revoked_at` keeps the name in the list so
 * "which token was that, and when did we turn it off" is still answerable, and
 * the row keeps the hash so a token that leaked can never be resurrected by
 * chance.
 */
export async function revokeToken(db: FolioDb, id: string): Promise<boolean> {
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
  db: FolioDb,
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
