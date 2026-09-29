/**
 * Preview grants: the one-time, site-bound handoff that carries a person's (or a
 * token's) right to see drafts from the admin origin to a site's preview origin
 * (`../../../docs/specs/foundation/multi-site.md` decision 13).
 *
 * One `site_grants` row lives two lives. **As a code** — minted at
 * `{base}/~<site>/site/start` on the admin origin, sixty seconds, hashed — it is
 * the credential in one redirect's URL and nothing else. **As a grant** — the code
 * consumed at `{base}/site/enter` on the preview origin, in the one statement
 * `consumeGrantCode` issues — it is the `__Host-folio_grant` cookie's value, for the
 * earlier of a day and the session's own expiry.
 *
 * ## Why every read re-checks everything
 *
 * `readGrant` requires, **in the one statement**, the grant row and: its session
 * live and unexpired, and a current `site_roles` row for the holder whose scope is
 * `*` or in the site's chain and whose role gives `READ_DRAFT` — or, for a token
 * grant, the token unrevoked, its binding still reaching the site and its scopes
 * still holding `content:read:draft`. So signing out, being removed, having a grant
 * edited on the Access screen or losing it to an SSO change ends every preview it
 * admitted on the next request, with no revocation step anybody has to remember.
 * **Beat deleting preview grants on every role change**: four writers change roles,
 * and a fifth added later would forget.
 *
 * Sessions are still deleted with their grants in the same batch
 * (`sessionGrantsDelete` and friends below, called from every `delete from
 * sessions`), which keeps this table small rather than keeping it correct. Nothing
 * here depends on a foreign key: `site_grants` declares none.
 *
 * ## Not a share, and not a session
 *
 * A grant is an actor (`GrantActor`), unlike a share (`shares.ts`): it reads a whole
 * site's chain, published and draft. What stops it doing anything else is
 * `allows()` (read and read-draft only), `withActor` (resolved only for a read on a
 * preview origin's v1 routes and draft mode's switch) and `handle()`'s host
 * confinement (a preview origin answers no admin route at all).
 */
import { ALL_SCOPES, chain, type Registry } from '../../core/sites'
import type { FolioDb } from '../db'
import {
  atLeast,
  type GrantActor,
  hasScope,
  READ_DRAFT,
  ROLES,
  SCOPES,
  tokenScopesOn,
} from './roles'
import { hashToken, mintId, mintSecret } from './secrets'

/** How long a code lives between `site/start` and `site/enter`: one redirect. */
export const GRANT_CODE_TTL_MS = 60_000

/** The longest a session's grant lives once redeemed: a day, or the session's own
 * expiry if that is sooner. */
export const GRANT_TTL_MS = 24 * 60 * 60 * 1000

/** A token grant, and any grant MCP's `preview_document` mints, lives five minutes
 * once redeemed: one screenshot's worth. */
export const TOKEN_GRANT_TTL_MS = 5 * 60 * 1000

/**
 * The id prefix of a **short** grant — five minutes whatever holds it, the one a
 * screenshot mints (decision 13: MCP's grant is five minutes). A token's grant is
 * always short; a session's is short only when minted so. Carried in the id rather
 * than a column because the consume statement is the only reader and `0011` is
 * landed: `sgs_` short, `sgr_` a session's ordinary day-long grant.
 */
const SHORT_PREFIX = 'sgs'

/** A code or a grant token, as `mintSecret()` produces it. Screened before either
 * reaches `hashToken` or a D1 bind. */
export const GRANT_SECRET = /^[0-9a-f]{64}$/

/** The roles that give `READ_DRAFT`: every one, today. Derived rather than written
 * out, so a weaker role added later is not silently a previewer. */
const DRAFT_ROLES: readonly string[] = ROLES.filter((r) => atLeast(r, READ_DRAFT.role))

/** The token scopes that imply `content:read:draft`, by `hasScope`'s own table. */
const DRAFT_SCOPES: readonly string[] = SCOPES.filter((s) => hasScope([s], READ_DRAFT.scope))

const holes = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/* ------------------------------------------------------------------ mint --- */

export interface MintedCode {
  /** The code in the clear: it goes into one redirect URL and nowhere else. */
  code: string
  id: string
  expiresAt: number
}

/**
 * A fresh code for `site`, held by a session or a token (exactly one: the table's
 * `check` says so). What `site/start` inserts, and what MCP's `preview_document`
 * mints for its token. Only the code's SHA-256 is stored.
 */
export async function mintGrantCode(
  db: FolioDb,
  holder: { sessionId: string } | { tokenId: string },
  site: string,
  now = Date.now(),
  opts: { short?: boolean } = {},
): Promise<MintedCode> {
  const code = mintSecret()
  const id = mintId(opts.short || 'tokenId' in holder ? SHORT_PREFIX : 'sgr')
  const expiresAt = now + GRANT_CODE_TTL_MS
  await db
    .prepare(
      `insert into site_grants (id, session_id, token_id, site_id, code_hash, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      'sessionId' in holder ? holder.sessionId : null,
      'tokenId' in holder ? holder.tokenId : null,
      site,
      await hashToken(code),
      now,
      expiresAt,
    )
    .run()
  return { code, id, expiresAt }
}

/* --------------------------------------------------------------- consume --- */

export interface RedeemedGrant {
  /** The grant token in the clear: the cookie's value. Only its hash is stored. */
  token: string
  expiresAt: number
}

/**
 * Turns a code into a grant, **in one statement** (decision 13 step 2): the code is
 * cleared and the grant's token hash written by the same `update … where code_hash
 * = ? and site_id = ? and expires_at > ?`, so two redemptions of one code cannot both
 * win — the second finds no row — and a code minted for one site cannot be
 * redeemed on another's preview origin.
 *
 * The grant's expiry is written by the same statement: a session's grant lives the
 * earlier of a day and the session's own expiry, read by a subquery; a token's, or
 * a short one's (`mintGrantCode`'s `short`), five minutes. Null for a code that is unknown, spent, expired or another site's.
 */
export async function consumeGrantCode(
  db: FolioDb,
  code: string,
  site: string,
  now = Date.now(),
): Promise<RedeemedGrant | null> {
  if (!GRANT_SECRET.test(code)) return null
  const token = mintSecret()
  const day = now + GRANT_TTL_MS
  const row = await db
    .prepare(
      `update site_grants
          set code_hash = null, token_hash = ?,
              expires_at = case when token_id is not null or id like '${SHORT_PREFIX}\\_%' escape '\\' then ?
                           else min(?, coalesce((select s.expires_at from sessions s
                                                  where s.id = site_grants.session_id), ?)) end
        where code_hash = ? and site_id = ? and expires_at > ?
        returning session_id, token_id, expires_at`,
    )
    .bind(
      await hashToken(token),
      now + TOKEN_GRANT_TTL_MS,
      day,
      day,
      await hashToken(code),
      site,
      now,
    )
    .first<{ session_id: string | null; token_id: string | null; expires_at: number }>()
  return row ? { token, expiresAt: row.expires_at } : null
}

/* ------------------------------------------------------------------ read --- */

/**
 * The bindings a token may be bound to and still read `site` (decision 14's reach,
 * `tokenScopesOn`): the site itself and its group. Asked of the rule rather than
 * written out, so the preview reach cannot drift from the scope reach.
 */
function reachingBindings(registry: Registry, site: string): string[] {
  return chain(registry, site).filter(
    (binding) => tokenScopesOn([READ_DRAFT.scope], binding, registry, site) !== null,
  )
}

/**
 * The actor behind a presented grant token on `site`'s preview origin, or null.
 *
 * **One statement**, and every condition in it is load-bearing (this file's
 * header): the grant row, redeemed and unexpired, for this site; its session live
 * and unexpired **and** a current `site_roles` row for its user on `*` or a scope of
 * the chain with a role that gives `READ_DRAFT`; or its token unrevoked and
 * unexpired, bound to nothing or to a scope that reaches the site, and holding a
 * scope that implies `content:read:draft`.
 */
export async function readGrant(
  db: FolioDb,
  presented: string,
  site: { id: string; registry: Registry },
  now = Date.now(),
): Promise<GrantActor | null> {
  if (!GRANT_SECRET.test(presented)) return null
  const scopes = [ALL_SCOPES, ...chain(site.registry, site.id)]
  const bindings = reachingBindings(site.registry, site.id)
  const row = await db
    .prepare(
      `select g.id, g.session_id, g.token_id, g.expires_at, s.user_id,
              coalesce(u.name, t.name) as name
         from site_grants g
         left join sessions s on s.id = g.session_id and s.expires_at > ?
         left join users u on u.id = s.user_id
         left join api_tokens t on t.id = g.token_id and t.revoked_at is null
                               and (t.expires_at is null or t.expires_at > ?)
        where g.token_hash = ? and g.site_id = ? and g.code_hash is null and g.expires_at > ?
          and ((u.id is not null
                and exists (select 1 from site_roles r
                             where r.user_id = u.id
                               and r.scope_id in (${holes(scopes.length)})
                               and r.role in (${holes(DRAFT_ROLES.length)})))
            or (t.id is not null
                and (t.site_id is null or t.site_id in (${holes(Math.max(bindings.length, 1))}))
                and exists (select 1 from json_each(t.scopes) j
                             where j.value in (${holes(DRAFT_SCOPES.length)}))))`,
    )
    .bind(
      now,
      now,
      await hashToken(presented),
      site.id,
      now,
      ...scopes,
      ...DRAFT_ROLES,
      // An empty `in ()` is a syntax error; a binding no scope id can equal stands in.
      ...(bindings.length ? bindings : ['']),
      ...DRAFT_SCOPES,
    )
    .first<{
      id: string
      session_id: string | null
      token_id: string | null
      expires_at: number
      user_id: string | null
      name: string | null
    }>()
  if (!row) return null
  return {
    kind: 'grant',
    id: row.id,
    userId: row.user_id,
    tokenId: row.token_id,
    name: row.name ?? 'Preview',
    site: site.id,
    expiresAt: row.expires_at,
  }
}

/* --------------------------------------------------- deleting with sessions --- */

/**
 * The grants a session held, as a statement to batch **before** that session's own
 * delete. Every `delete from sessions` in the library batches one of these four, so
 * the table stays small; `readGrant`'s join is what keeps it correct either way.
 */
export function sessionGrantsDelete(db: FolioDb, sessionId: string): D1PreparedStatement {
  return db.prepare('delete from site_grants where session_id = ?').bind(sessionId)
}

/** Every grant held by any session of `userId` — ahead of `delete from sessions
 * where user_id = ?`, since the subquery reads the sessions it is about to lose. */
export function userGrantsDelete(db: FolioDb, userId: string): D1PreparedStatement {
  return db
    .prepare(
      'delete from site_grants where session_id in (select id from sessions where user_id = ?)',
    )
    .bind(userId)
}

/** The grants of every session `userId` holds except `keepId`. */
export function otherGrantsDelete(
  db: FolioDb,
  userId: string,
  keepId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `delete from site_grants
        where session_id in (select id from sessions where user_id = ? and id != ?)`,
    )
    .bind(userId, keepId)
}

/** The grants of every session past its expiry, ahead of the sweep's own delete. */
export function expiredSessionGrantsDelete(db: FolioDb, now: number): D1PreparedStatement {
  return db
    .prepare(
      'delete from site_grants where session_id in (select id from sessions where expires_at <= ?)',
    )
    .bind(now)
}

/* ----------------------------------------------------------------- sweep --- */

/**
 * Housekeeping, on no request path (`folio.sweepAuth`): codes and grants past
 * their expiry, and any grant whose session or token is gone or revoked. The last
 * clause catches what a session delete outside this library left behind; every
 * such row already reads as nothing (`readGrant`), so this is size, not safety.
 */
export async function sweepGrants(db: FolioDb, now = Date.now()): Promise<number> {
  const result = await db
    .prepare(
      `delete from site_grants
        where expires_at <= ?
           or (session_id is not null and session_id not in (select id from sessions))
           or (token_id is not null
               and token_id not in (select id from api_tokens where revoked_at is null))`,
    )
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}
