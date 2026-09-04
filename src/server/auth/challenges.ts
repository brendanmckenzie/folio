/**
 * Sign-in challenges: the row behind a link in an email.
 *
 * Same hashing rule as sessions — the token exists in the mail and nowhere else
 * — plus two properties the spec is explicit about: single use, and short lived.
 * Both are enforced in the `update` that claims the row, not in a read-then-write
 * pair, so two clicks on the same link race each other into the database rather
 * than into a JavaScript branch.
 */
import { hashToken, mintSecret } from './secrets'
import { normaliseEmail } from './users'
import type { FolioDb } from '../db'

/** How long a sign-in link works for. */
export const CHALLENGE_TTL_MS = 15 * 60 * 1000

/**
 * Slack on every expiry comparison in this feature, including the OIDC
 * id-token's `exp`. A minute: enough to absorb ordinary clock skew between a
 * mail server, a browser and an edge location, and short enough that it is not
 * a meaningful extension of a 15-minute link.
 */
export const CLOCK_LEEWAY_MS = 60 * 1000

/** The window the per-address rate limit counts over. */
const RATE_WINDOW_MS = 60 * 60 * 1000

export interface NewChallenge {
  /** Goes in the emailed URL. Not stored. */
  token: string
  expiresAt: number
}

export async function createChallenge(
  db: FolioDb,
  email: string,
  now = Date.now(),
): Promise<NewChallenge> {
  const token = mintSecret()
  const expiresAt = now + CHALLENGE_TTL_MS
  await db
    .prepare(`insert into login_challenges (id, email, created_at, expires_at) values (?, ?, ?, ?)`)
    .bind(await hashToken(token), normaliseEmail(email), now, expiresAt)
    .run()
  return { token, expiresAt }
}

/**
 * Claims a challenge and returns the address it was issued to, or null.
 *
 * The `where` clause carries both rules — `consumed_at is null` and not past
 * expiry — so the claim is atomic: a second click, or a click after fifteen
 * minutes, changes no rows and gets the same null the first branch of a
 * read-then-check would have produced only by luck. `changes` is the answer;
 * the follow-up select only fetches the address, and is in the same batch so a
 * consume costs one D1 round trip.
 */
export async function consumeChallenge(
  db: FolioDb,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const id = await hashToken(token)
  const [claim, read] = await db.batch<{ email: string }>([
    db
      .prepare(
        `update login_challenges set consumed_at = ?
          where id = ? and consumed_at is null and expires_at > ?`,
      )
      .bind(now, id, now - CLOCK_LEEWAY_MS),
    db.prepare('select email from login_challenges where id = ?').bind(id),
  ])
  if ((claim?.meta.changes ?? 0) === 0) return null
  return read?.results?.[0]?.email ?? null
}

/**
 * How many links have been requested for this address in the last hour.
 *
 * The rate limit this feeds is deliberately named as a *partial* answer in the
 * spec rather than pretended complete: it bounds how much mail one address can
 * be made to receive, which is the abuse a public sign-in form actually invites,
 * but the IP dimension needs a counter Folio has no binding for and belongs in a
 * zone rate-limiting rule.
 */
export async function recentChallengeCount(
  db: FolioDb,
  email: string,
  now = Date.now(),
): Promise<number> {
  const row = await db
    .prepare('select count(*) as n from login_challenges where email = ? and created_at > ?')
    .bind(normaliseEmail(email), now - RATE_WINDOW_MS)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Housekeeping. Consumed and expired challenges are dead weight, not history. */
export async function deleteStaleChallenges(db: FolioDb, now = Date.now()): Promise<number> {
  const result = await db
    .prepare('delete from login_challenges where expires_at <= ? or consumed_at is not null')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}
