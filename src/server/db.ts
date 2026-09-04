/**
 * The database handle every query in this library takes, and how one request
 * gets a single D1 session to run them all on.
 *
 * **Why the internals stopped taking `D1Database`.** With read replication
 * enabled, a query reaches a replica only if it is issued on a *session*
 * (`db.withSession(…)`). Everything else is served by the primary, wherever in
 * the world that happens to be — Cloudflare's own docs are explicit that
 * without the Sessions API "all queries will continue to be executed only by
 * the primary database". So a host whose readers are not beside its primary
 * pays a full network round trip per query. Measured on the first real host in
 * September 2026: ~280ms Melbourne to a London primary, three of them in
 * sequence per page render, which was 97% of that site's server time and dwarfed
 * both SSR and the queries themselves (`sql_duration_ms` was 0.17–0.42).
 *
 * `D1DatabaseSession` is not a `D1Database` — it has no `withSession`, no
 * `exec`, no `dump` — but it has the two methods every query in this library
 * actually uses. Narrowing the internals to that intersection is what lets one
 * session be threaded through a whole request without a parallel set of query
 * functions. The rejected alternative was a `db` plus an optional `session`
 * argument on every query helper, which is the same threading with a way to
 * forget it.
 *
 * **Nothing here turns replication on.** That is a per-database setting (the
 * dashboard, or `read_replication.mode: auto` over the REST API). With it off a
 * session is an ordinary connection to the primary, so this is inert until a
 * host opts in and correct either way — which is also why converting a call
 * site is safe one at a time, and why the Durable Objects deliberately were not
 * converted: `StoryDO` reads what it just wrote, and staying off sessions keeps
 * it on the primary by construction rather than by argument.
 */
import { isSecure, readCookie, serialiseCookie } from './auth/cookie'

/**
 * What a query needs of D1. Satisfied by both `D1Database` and
 * `D1DatabaseSession`, which is the whole point.
 *
 * `Pick` rather than a hand-written interface so it tracks the platform types:
 * if `prepare` ever changes shape this fails to compile instead of drifting.
 */
export type FolioDb = Pick<D1Database, 'prepare' | 'batch'>

/**
 * Start anywhere — the nearest replica, or the primary if that is nearer.
 *
 * The right constraint for a public page render, which reads published content
 * that was already a cache's worth of seconds stale by the time a visitor asked
 * for it. Subsequent queries in the same session are sequentially consistent
 * with the first, so a render never sees a document newer than the references it
 * resolves.
 */
export const REPLICA_FIRST = 'first-unconstrained'

/**
 * Start at the primary.
 *
 * For a request that is going to write. Writes route to the primary whatever
 * the constraint, but a request that writes and then reads back — publish, then
 * reindex, then answer with the row — must not have opened on a replica that is
 * behind its own write.
 */
export const PRIMARY_FIRST = 'first-primary'

/** A `D1DatabaseSession`, named for what it is used for. */
export type DbSession = ReturnType<D1Database['withSession']>

export const SECURE_BOOKMARK_COOKIE = '__Host-folio_bookmark'
export const PLAIN_BOOKMARK_COOKIE = 'folio_bookmark'

/**
 * How long a bookmark stays useful. Ten minutes: long enough to cover an
 * editing session's worth of save-then-reload, short enough that a browser
 * parked overnight does not open tomorrow's first read against a bookmark from
 * a database that has since been restored from a backup.
 */
export const BOOKMARK_MAX_AGE = 600

/**
 * A conservative screen on a value that came off a request.
 *
 * Deliberately *not* the observed shape of a D1 bookmark (`8-8-8-32` hex). A
 * pattern that tight would silently start rejecting every bookmark the day
 * Cloudflare changed the format, and the symptom — read-your-writes quietly
 * stops working, nothing errors — is the worst kind. This only rules out what
 * could not be a bookmark under any format: control characters, separators, and
 * anything long enough to be an attack on the header.
 */
const BOOKMARK = /^[0-9A-Za-z_-]{1,128}$/

/** The bookmark this request carries, or null if it carries nothing usable. */
export function readBookmark(header: string | null | undefined): string | null {
  const raw =
    readCookie(header, SECURE_BOOKMARK_COOKIE) ?? readCookie(header, PLAIN_BOOKMARK_COOKIE)
  return raw && BOOKMARK.test(raw) ? raw : null
}

/** The `Set-Cookie` value carrying `bookmark` forward to this browser's next request. */
export function bookmarkCookie(url: URL | string, bookmark: string): string {
  const name = isSecure(url) ? SECURE_BOOKMARK_COOKIE : PLAIN_BOOKMARK_COOKIE
  return serialiseCookie(url, name, bookmark, { maxAge: BOOKMARK_MAX_AGE })
}

/**
 * The session a request's queries should run on.
 *
 * `bookmark` wins when there is one, because it is strictly stronger than
 * `REPLICA_FIRST`: it says "any instance at least this up to date", which is
 * both a replica read *and* read-your-writes. `PRIMARY_FIRST` is asked for
 * explicitly by a request that is about to write, and overrides a bookmark
 * because it is the stronger claim of the two.
 */
export function sessionFor(
  db: D1Database,
  opts: { bookmark?: string | null; write?: boolean } = {},
): DbSession {
  if (opts.write) return db.withSession(PRIMARY_FIRST)
  return db.withSession(opts.bookmark ?? REPLICA_FIRST)
}
