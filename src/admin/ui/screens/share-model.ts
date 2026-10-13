import type { StoryMeta } from '../../../core/story'
import type { ShareRow } from '../../../server/auth/shares'
import { type Me, whyNot } from '../../me'

/**
 * The editor's "Share a preview" dialog: what it asks, and how it reads the rows
 * back (`platform/draft-sharing.md`'s "No admin UI" note, built 2026-10-13).
 *
 * Pure, like every `*-model.ts` here: the dialog is the part that cannot be unit
 * tested in the Node project, so the decisions are kept out of it.
 */

/** The bounds `ShareCreateBody` enforces, mirrored so the form refuses before the
 * route does. The route stays the authority; this is about not sending a 400. */
export const MIN_SHARE_DAYS = 1
export const MAX_SHARE_DAYS = 90
export const DEFAULT_SHARE_DAYS = 7
/** `ShareCreateBody`'s `note` bound. */
export const MAX_NOTE = 200

/**
 * Why "Share a preview" is refused, or undefined when it is not.
 *
 * Two independent reasons, and the role comes first because it is the one the
 * editor cannot fix by opening a different document. `story.path === null` is a
 * record or a singleton: it has no page, so there is no URL to preview and the
 * route answers 400.
 */
export function shareRefusal(owner: Me, story: Pick<StoryMeta, 'path'>): string | undefined {
  return (
    whyNot(owner, 'share') ??
    (story.path === null ? 'This document has no page, so there is nothing to preview' : undefined)
  )
}

/** The day count as the route will read it, or why it will not: an empty field is
 * the default, anything else must be a whole number in range. */
export function shareDays(
  value: string,
): { ok: true; days: number } | { ok: false; reason: string } {
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, days: DEFAULT_SHARE_DAYS }
  const days = Number(trimmed)
  if (!Number.isInteger(days)) return { ok: false, reason: 'Use a whole number of days' }
  if (days < MIN_SHARE_DAYS || days > MAX_SHARE_DAYS) {
    return { ok: false, reason: `Between ${MIN_SHARE_DAYS} and ${MAX_SHARE_DAYS} days` }
  }
  return { ok: true, days }
}

/** The body for `POST {base}/api/story/:id/share`: a blank note is an absent key. */
export function shareBody(note: string, days: number): { expiresInDays: number; note?: string } {
  const trimmed = note.trim()
  return { expiresInDays: days, ...(trimmed === '' ? {} : { note: trimmed }) }
}

const DAY = 86_400_000

/** Whole calendar days from `at` to `now`, in the viewer's time zone: "yesterday"
 * means the day before, not 24 hours ago. */
function daysBetween(at: number, now: number): number {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  return Math.round((start(now) - start(at)) / DAY)
}

/** "today", "yesterday", "5 days ago", then a date: the coarse past of a view. */
function dayPhrase(at: number, now: number): string {
  const days = daysBetween(at, now)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `on ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

/**
 * "opened 3 times, last yesterday" — the answer to "did they look?". `views` counts
 * renders through the link, so it is described as opens and not as people.
 */
export function openedPhrase(
  share: Pick<ShareRow, 'views' | 'lastViewedAt'>,
  now: number = Date.now(),
): string {
  if (share.views === 0 || share.lastViewedAt === null) return 'not opened yet'
  const times = share.views === 1 ? 'once' : `${share.views} times`
  return `opened ${times}, last ${dayPhrase(share.lastViewedAt, now)}`
}

/** "expires today", "expires tomorrow", "expires in 5 days". Rows are `state=live`,
 * so `expiresAt` is ahead of `now`; a clock skew that says otherwise reads "today". */
export function expiresPhrase(
  share: Pick<ShareRow, 'expiresAt'>,
  now: number = Date.now(),
): string {
  const days = daysBetween(now, share.expiresAt)
  if (days <= 0) return 'expires today'
  if (days === 1) return 'expires tomorrow'
  return `expires in ${days} days`
}

/**
 * Who made a link. `createdBy` is a user id, `token:<name>` or null, and
 * `createdByName` is the display name the list route looks up for a user (null for a
 * token, or an account since deleted). "You" for the caller's own; otherwise the real
 * name, then the token's name, and "A removed account" when the user is gone.
 */
export function sharedBy(
  share: Pick<ShareRow, 'createdBy' | 'createdByName'>,
  selfId: string | null,
): string {
  const { createdBy, createdByName } = share
  if (createdBy === null) return 'Unknown'
  if (createdBy === selfId) return 'You'
  if (createdBy.startsWith('token:')) return createdBy
  return createdByName ?? 'A removed account'
}
