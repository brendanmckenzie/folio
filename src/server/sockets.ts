/**
 * What the two socket-bearing Durable Objects genuinely share.
 *
 * `StoryDO` and `SpaceDO` are different objects with different jobs — one holds
 * the authoritative draft and an append-only log, the other holds nothing at all
 * — but the *door* is identical: the same application close codes, the same
 * frame-size ceiling checked before `JSON.parse`, and the same bounded
 * session re-check (`identity-and-access.md` checkpoint 5).
 *
 * Extracted rather than copied (`live-collaboration.md` phase 2, step 1),
 * because two copies of a security check drift and the untested copy is the one
 * that drifts. Everything *not* identical stays in each object: the story's
 * catchup and quarantine reasoning, the space object's per-story presence.
 */
import { MAX_FRAME_BYTES } from '../core/protocol'
import { sessionExpiry } from './auth/session'
import type { FolioDb } from './db'

/** Application close code: the peer speaks a wire version we do not implement. */
export const CLOSE_VERSION = 4001

/** Application close code: the story this object backs has been deleted. */
export const CLOSE_PURGED = 4002

/** Application close code: no session, or one that has ended since the upgrade. */
export const CLOSE_UNAUTHENTICATED = 4003

/**
 * Application close code: a valid credential that may not hold an editing
 * session. A token is a script; an editing session is a person with a cursor.
 * Decided in the route, never in the object, which is why it is here and not
 * used below.
 */
export const CLOSE_FORBIDDEN = 4004

/**
 * How often, at most, one socket's session is re-checked against D1
 * (`identity-and-access.md` checkpoint 5). The attachment's own `expiresAt` is
 * checked on every frame and costs nothing; this bounds how long an *explicit*
 * revocation — an admin deleting a user, or that user signing out elsewhere —
 * can go unnoticed on an already-open socket.
 *
 * A minute, not per frame: a D1 read in the keystroke path is the thing this
 * design exists to avoid, and the alternative the spec rejected.
 */
export const SESSION_RECHECK_MS = 60_000

/**
 * Why a raw frame is too large to admit, or null when it is within cap.
 *
 * Checked ahead of parsing: a frame this large would cost a `JSON.parse` over
 * attacker-controlled input before anything else got a chance to refuse it, and
 * it stays a bounded, nameable error rather than an unreadable frame.
 *
 * Measured in UTF-8 bytes, not `.length`: a string's `.length` counts UTF-16
 * code units, so a frame padded with 3-byte-in-UTF-8 characters can be three
 * times `MAX_FRAME_BYTES` on the wire while reading well under the cap — exactly
 * the value size (`set.value` at 64KB) this cap stands in for.
 */
export function frameSizeError(raw: string | ArrayBuffer): string | null {
  const size = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
  return size > MAX_FRAME_BYTES ? `frame too large: ${size} exceeds ${MAX_FRAME_BYTES} bytes` : null
}

/**
 * The session bookkeeping a socket attachment carries, whichever object holds
 * it. Both attachments extend this; nothing else about them is shared.
 */
export interface SocketSession {
  /** True when the Worker handed this socket an identity on the upgrade. */
  verified: boolean
  /** `sessions.id`, for the bounded re-check below. Null without a session. */
  session: string | null
  /** Session expiry, epoch ms. 0 means "nothing to expire". */
  expiresAt: number
  /** When this socket's session was last re-checked against D1. */
  checkedAt: number
}

/**
 * Whether this socket's session is still live, and the attachment to carry on
 * with — or null, having closed the socket.
 *
 * Two checks, deliberately unequal in cost. The attachment's own `expiresAt` is
 * free and runs on every frame. The D1 read that catches an *explicit*
 * revocation runs at most once a minute per socket (`SESSION_RECHECK_MS`),
 * because the alternative — a query per frame — puts a database round trip in
 * the keystroke path, which is the design the spec rejected.
 *
 * A transient D1 failure is not treated as a revocation. Signing an editor out
 * mid-sentence because the database blinked is worse than the bounded window
 * this feature already accepts, and `expiresAt` still bounds it.
 *
 * `label` only names the object in the one log line this can emit.
 */
export async function liveSession<A extends SocketSession>(
  db: FolioDb,
  ws: WebSocket,
  a: A,
  label: string,
): Promise<A | null> {
  if (!a.verified || a.session === null) return a
  const now = Date.now()
  if (a.expiresAt <= now) {
    ws.close(CLOSE_UNAUTHENTICATED, 'session expired')
    return null
  }
  if (now - a.checkedAt < SESSION_RECHECK_MS) return a

  let expiresAt: number | null
  try {
    expiresAt = await sessionExpiry(db, a.session)
  } catch (err) {
    console.error(`${label}: could not re-check a session; keeping the socket open`, err)
    const kept: A = { ...a, checkedAt: now }
    ws.serializeAttachment(kept)
    return kept
  }
  if (expiresAt === null || expiresAt <= now) {
    ws.close(CLOSE_UNAUTHENTICATED, 'your session has ended')
    return null
  }
  // The renewal a sliding session performs on the HTTP side lands here too, so a
  // socket held open for weeks is not closed by a stale copy of an expiry that
  // has since moved.
  const next: A = { ...a, expiresAt, checkedAt: now }
  ws.serializeAttachment(next)
  return next
}
