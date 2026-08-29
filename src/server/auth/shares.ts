/**
 * Draft preview links: the row behind a URL you can send to somebody with no
 * account (`../../../docs/specs/platform/draft-sharing.md`).
 *
 * Same storage discipline as `tokens.ts` and `challenges.ts` — 32 bytes from
 * `crypto.getRandomValues`, handed out once, kept only as a SHA-256 — and
 * deliberately **not** the same resolution discipline.
 *
 * ## A grant is not an actor, and that is the whole design
 *
 * `readSession` and `readToken` both answer an `Actor`, which `allows()` weighs
 * against an `Access` and every route gate in the server reads. Nothing here
 * answers an `Actor`. `readShareByToken` and `claimShare` answer a `ShareGrant`:
 * an id, one story id, and an expiry. It has no `kind`, no `role` and no
 * `scopes`, so `allows(grant, …)` does not type-check and `requireAccess` cannot
 * be satisfied by one however the middleware is later rearranged.
 *
 * That is why this file is not wired into `resolve.ts`. `credentialOf` reads a
 * session cookie and a bearer header and neither will ever see the share cookie
 * (a different name — `cookie.ts`), so the *only* place in the server that can
 * act on a share is `handle()`'s preview branch, which asks `claimShare` for one
 * specific story id. There is no second caller and no way to make one useful.
 *
 * ## What it does not do
 *
 * No listing, no walking, no tree. `claimShare` takes the story id it is being
 * asked about and answers yes or no; it cannot be asked "which documents does
 * this link cover" because the question has one answer by construction.
 */
import { clampLimit, decodeCursor, type Page, paginate } from '../../core/pagination'
import { FolioError } from '../errors'
import { type Keyset, keysetWhere, orderBy, whereOf } from '../keyset'
import { hashToken, mintId, mintSecret } from './secrets'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a link lasts when the editor does not say. A week: a client review is
 * a week's business, and the default has to be the answer for somebody who never
 * thinks about it.
 */
export const DEFAULT_SHARE_DAYS = 7

/**
 * The ceiling. Ninety days, and unlike `TokenCreateBody.expiresInDays`' ten years
 * this is a *product* bound rather than a unit-mistake backstop: a link nobody
 * has revoked is a link nobody is thinking about, and the failure mode of this
 * feature is an unpublished page reachable by a URL in a two-year-old email
 * thread. Renewing is one click; a decade is not a review cycle.
 */
export const MAX_SHARE_DAYS = 90

/**
 * `(created_at, id)` newest first — what `shares_created` indexes and what
 * `api_tokens`, `assets` and `versions` all page by. The link you just made is
 * the one you are looking for.
 */
const NEWEST_FIRST: Keyset = { columns: ['created_at', 'id'], direction: 'desc' }

/**
 * One share, as a list route answers it. **Carries no token and no hash** — the
 * secret exists once, in `POST`'s response, and the hash has no reader outside
 * this file.
 */
export interface ShareRow {
  id: string
  /** The one document this link shows. */
  storyId: string
  /** `users.id`, `token:<name>`, or null. */
  createdBy: string | null
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  lastViewedAt: number | null
  /** How many times the document has been rendered through this link. */
  views: number
  note: string | null
}

interface RawShare {
  id: string
  story_id: string
  created_by: string | null
  created_at: number
  expires_at: number
  revoked_at: number | null
  last_viewed_at: number | null
  views: number
  note: string | null
}

const COLUMNS = `id, story_id, created_by, created_at, expires_at,
                 revoked_at, last_viewed_at, views, note`

function toShare(row: RawShare): ShareRow {
  return {
    id: row.id,
    storyId: row.story_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastViewedAt: row.last_viewed_at,
    views: row.views,
    note: row.note,
  }
}

/**
 * What a live link authorises. **Everything a share can ever mean is in these
 * three fields**, and none of them is a role or a scope — see this file's header.
 */
export interface ShareGrant {
  /** `shares.id`. The row, never the secret. */
  id: string
  /** The one document. */
  storyId: string
  expiresAt: number
}

export interface MintedShare {
  row: ShareRow
  /**
   * The token, in the clear. `POST {base}/api/story/:id/share` is the only
   * response that ever carries it, and it is never recoverable afterwards.
   */
  token: string
}

/**
 * Turns "how many days" into an expiry, refusing anything outside the bounds.
 *
 * A refusal rather than a clamp, matching `checkScheduleTime`: a caller asking
 * for a two-year link has a different intent from one asking for ninety days, and
 * silently giving them ninety while their UI says two years is the worst of both
 * answers. `ShareCreateBody` also bounds the number, so this is the second of two
 * — the schema bounds what may reach the column, this states the product rule and
 * is the one a programmatic caller hits.
 */
export function shareExpiry(days: number | undefined, now = Date.now()): number {
  const requested = days ?? DEFAULT_SHARE_DAYS
  if (!Number.isFinite(requested) || requested < 1) {
    throw new FolioError('bad_request', 'A preview link must last at least a day.')
  }
  if (requested > MAX_SHARE_DAYS) {
    throw new FolioError(
      'bad_request',
      `A preview link cannot last more than ${MAX_SHARE_DAYS} days. Make a new one when it runs out.`,
    )
  }
  return now + requested * DAY_MS
}

/**
 * Mints a link for one document.
 *
 * The token is returned to the caller, which puts it in exactly one URL and
 * forgets it; only its hash is written. `expiresAt` is required rather than
 * defaulted here so that the *route* is the one place a default is chosen — a
 * writer that quietly invented seven days would make the bound impossible to see
 * from the surface that enforces it.
 */
export async function createShare(
  db: D1Database,
  input: {
    storyId: string
    expiresAt: number
    createdBy?: string | null
    note?: string | null
  },
): Promise<MintedShare> {
  const token = mintSecret()
  const row: ShareRow = {
    id: mintId('shr'),
    storyId: input.storyId,
    createdBy: input.createdBy ?? null,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    revokedAt: null,
    lastViewedAt: null,
    views: 0,
    note: input.note?.trim() ? input.note.trim() : null,
  }
  await db
    .prepare(
      `insert into shares
         (id, token_hash, story_id, created_by, created_at, expires_at, note)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      await hashToken(token),
      row.storyId,
      row.createdBy,
      row.createdAt,
      row.expiresAt,
      row.note,
    )
    .run()
  return { row, token }
}

/** `live` is not revoked and not yet expired; `lapsed` is everything else. A
 * projection of two columns and the clock, never a stored value — see
 * `migrations/0004_shares.sql`. */
export type ShareState = 'live' | 'lapsed'

export interface ListSharesOptions {
  limit?: number
  cursor?: string
  /** One document's links — the editor's own read, off a document's own screen. */
  storyId?: string
  state?: ShareState
  /** Adds `total` for the same filter (`../../../docs/specs/foundation/pagination.md`
   * decision 5). */
  count?: boolean
  /** For the `state` comparison. Injectable so a test can age a row rather than sleep. */
  now?: number
}

/**
 * Links, newest first, paged.
 *
 * **A share nobody can list is a share nobody can revoke**, which is the whole
 * reason this exists and the reason nothing is ever deleted here — the same
 * argument `routes/schedules.ts` makes for `GET /schedules`. Paged for the reason
 * `listTokens` is: nothing is removed, so the list only grows, and
 * `pagination.md`'s rule is that no admin list route reads a whole table.
 */
export async function listShares(
  db: D1Database,
  opts: ListSharesOptions = {},
): Promise<Page<ShareRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const resume = keysetWhere(NEWEST_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const now = opts.now ?? Date.now()

  // `narrow` is the filter and `narrow` alone is what the count counts: a
  // `count(*)` carrying the cursor clause would answer "how many are left" where
  // a header reads `n of N`. The split every other paged reader here makes.
  const narrow: string[] = []
  const narrowBinds: unknown[] = []
  if (opts.storyId) {
    narrow.push('story_id = ?')
    narrowBinds.push(opts.storyId)
  }
  if (opts.state === 'live') {
    narrow.push('revoked_at is null and expires_at > ?')
    narrowBinds.push(now)
  } else if (opts.state === 'lapsed') {
    narrow.push('(revoked_at is not null or expires_at <= ?)')
    narrowBinds.push(now)
  }

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLUMNS} from shares
         ${whereOf(...narrow, resume.sql)} ${orderBy(NEWEST_FIRST)} limit ?`,
      )
      .bind(...narrowBinds, ...resume.binds, limit + 1)
      .all<RawShare>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from shares ${whereOf(...narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  // Keyed component for component with `NEWEST_FIRST` — the correspondence
  // `paginate` cannot check for its caller.
  const page = paginate(rows.results.map(toShare), limit, (row) => [row.createdAt, row.id])
  return total ? { ...page, total: total.n } : page
}

/**
 * Turns a link off. Revokes rather than deletes, exactly as `revokeToken` does:
 * the row keeps the hash so a leaked link can never be resurrected by chance, and
 * keeps the document and the date so "which link was that, and when did we turn it
 * off" stays answerable.
 */
export async function revokeShare(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare('update shares set revoked_at = ? where id = ? and revoked_at is null')
    .bind(Date.now(), id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * The grant behind a presented token, or null — what the **entry route** asks,
 * before it knows or cares which document is involved.
 *
 * Does **not** stamp `views`: this hop only exchanges the token in the URL for the
 * cookie and a redirect, and counting it as a view would double-count every visit
 * (the redirect target then goes through `claimShare`, which does stamp). One
 * indexed read on `shares_token`.
 *
 * A revoked or expired row answers null, indistinguishably from a token that was
 * never issued. The route answers the same page for all three, deliberately: the
 * reader's next action is identical, and telling them apart would confirm whether
 * a given string was ever a token.
 */
export async function readShareByToken(
  db: D1Database,
  presented: string,
  now = Date.now(),
): Promise<ShareGrant | null> {
  const row = await db
    .prepare(
      `select id, story_id, expires_at from shares
        where token_hash = ? and revoked_at is null and expires_at > ?`,
    )
    .bind(await hashToken(presented), now)
    .first<{ id: string; story_id: string; expires_at: number }>()
  return row ? { id: row.id, storyId: row.story_id, expiresAt: row.expires_at } : null
}

/**
 * Whether any of these tokens is a live grant **for this document**, and the
 * grant if so — what the shared preview asks on every render.
 *
 * Story-first, which is the shape that makes this safe to reason about: the caller
 * has already resolved the requested URL to exactly one story and asks about that
 * one id. There is no version of this call that answers "and what else?".
 *
 * A list of tokens rather than one because the cookie holds up to
 * `MAX_SHARE_COOKIE_TOKENS` of them (`cookie.ts`): an editor who sends three links
 * for three pages must not have the second one silently unseat the first in the
 * reviewer's browser. Screened and capped by `shareCookieTokens` before it gets
 * here, so the `in (…)` list is bounded by construction.
 *
 * **The read and the stamp go out as one batch, with the identical `where`**, so a
 * view costs one D1 round trip and the stamp can only ever land on the row that
 * was actually served. That is `readToken`'s discipline for `last_used_at`; the one
 * difference is that this stamps *nothing* when no grant matches, because a
 * visitor merely carrying a cookie past an unrelated page has not used the link.
 */
export async function claimShare(
  db: D1Database,
  presented: readonly string[],
  storyId: string,
  now = Date.now(),
): Promise<ShareGrant | null> {
  if (presented.length === 0) return null
  const hashes = await Promise.all(presented.map(hashToken))
  const holes = hashes.map(() => '?').join(', ')
  const where = `token_hash in (${holes}) and story_id = ? and revoked_at is null and expires_at > ?`
  const binds = [...hashes, storyId, now]

  const [read] = await db.batch<{ id: string; story_id: string; expires_at: number }>([
    db.prepare(`select id, story_id, expires_at from shares where ${where}`).bind(...binds),
    db
      .prepare(`update shares set views = views + 1, last_viewed_at = ? where ${where}`)
      .bind(now, ...binds),
  ])
  const row = read?.results?.[0]
  return row ? { id: row.id, storyId: row.story_id, expiresAt: row.expires_at } : null
}

/**
 * Housekeeping, on no request path: links that have run out and links that were
 * turned off long ago. The same shape and the same standing as
 * `deleteExpiredSessions` and `deleteStaleChallenges` — a lapsed link is dead
 * weight once nobody is asking about it any more, and `keep` is how long "any
 * more" is.
 */
export async function deleteLapsedShares(
  db: D1Database,
  opts: { now?: number; keepDays?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now()
  const cutoff = now - (opts.keepDays ?? 30) * DAY_MS
  const result = await db
    .prepare(
      `delete from shares
        where (expires_at <= ? or revoked_at is not null) and created_at <= ?`,
    )
    .bind(now, cutoff)
    .run()
  return result.meta.changes ?? 0
}
