/**
 * `auth_events`: the record of things that happen to an account, including the
 * ones nobody clicked.
 *
 * `../../../docs/specs/foundation/auth-providers.md` decision 8 is the argument
 * for the table's existence: a trusted sign-in, a role rewritten from an identity
 * provider's claims, and a refusal because a group vanished all happen with no
 * person at a keyboard, and `versions` plus the activity trail record none of
 * them. "It quietly changed" is the failure this codebase refuses everywhere else.
 *
 * **A statement builder, and in this phase nothing else.** Nothing here runs its
 * own SQL — the same rule `server/content-index.ts` states for the search index,
 * and for the same reason: an event is appended in the *same batch* as the
 * session or the change it describes, so an event cannot exist without the thing
 * it records, or the thing without its event.
 *
 * **Phase 4 adds the read side**: `listEvents` (`GET {base}/api/auth-events`,
 * `GET {base}/api/me/events`) and `sweepEvents` (`folio.sweepAuth`). Nothing
 * here writes a second time what `completeSignIn` and the routes that call
 * `recordEventStatement` directly already write once.
 */
import { clampLimit, decodeCursor, type Page, paginate } from '../../core/pagination'
import { keysetWhere, orderBy, type Keyset, whereOf } from '../keyset'
import { mintId } from './secrets'
import type { FolioDb } from '../db'

/**
 * What happened. **Text with no CHECK constraint in the schema**, for the reason
 * `content_refs.kind` and `schedules.action` record: SQLite cannot widen a CHECK
 * without rebuilding the table, and `foundation/passkeys.md` adds kinds. The
 * union here is this build's vocabulary, screened on read rather than on write.
 */
export type AuthEventKind =
  | 'sign_in'
  | 'sign_in_refused'
  | 'sign_out'
  | 'role_changed'
  | 'user_invited'
  | 'user_removed'
  /**
   * The four `foundation/passkeys.md` adds, which is the widening this union's
   * comment predicted.
   *
   * `passkey_rejected` is the load-bearing one: every refusal of
   * `POST {base}/login/passkey` is byte-identical to the person, so a counter
   * regression — two authenticators holding one private key — would otherwise
   * be invisible to everybody. It is the only refusal that writes a row, and
   * that asymmetry is deliberate: an event per failed assertion would let a
   * stranger with a credential id fill the table.
   */
  | 'passkey_rejected'
  | 'passkey_removed'
  | 'passkeys_removed'
  | 'sessions_revoked'

export interface AuthEventInput {
  kind: AuthEventKind
  /** The account it is about. Null for an identity Folio has no row for. */
  userId?: string | null
  /**
   * Who caused it: a user's own id for a sign-in, an admin's id for an edit,
   * `token:<name>` for a script, `provider:<id>` when claims changed a role with
   * nobody clicking.
   */
  actor?: string | null
  /** The provider involved, when one was. */
  provider?: string | null
  /** Shaped by `kind`: `{ from, to }`, `{ email, reason }`, or nothing. */
  detail?: Record<string, unknown> | null
  at?: number
}

/**
 * One unrun `insert`, for a caller to put in the batch that carries the change
 * itself. Six binds, so a batch of them is nowhere near `D1_BIND_CAP`.
 */
export function recordEventStatement(db: FolioDb, event: AuthEventInput): D1PreparedStatement {
  const detail = event.detail === undefined || event.detail === null ? null : event.detail
  return db
    .prepare(
      `insert into auth_events (id, at, kind, user_id, actor, provider, detail)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      mintId('evt'),
      event.at ?? Date.now(),
      event.kind,
      event.userId ?? null,
      event.actor ?? null,
      event.provider ?? null,
      detail === null ? null : JSON.stringify(detail),
    )
}

/** A row as `listEvents` reads it back. */
export interface AuthEventRow {
  id: string
  at: number
  /**
   * Returned as a plain string, not narrowed to `AuthEventKind`. The schema
   * carries no CHECK on this column on purpose (decision 8), so a kind a later
   * migration adds and this build has not been taught yet must read back as
   * data, not fail the request — the same screening `parseScopes` gives
   * `api_tokens.scopes`.
   */
  kind: string
  userId: string | null
  actor: string | null
  provider: string | null
  detail: Record<string, unknown> | null
}

interface RawEvent {
  id: string
  at: number
  kind: string
  user_id: string | null
  actor: string | null
  provider: string | null
  detail: string | null
}

function toEvent(row: RawEvent): AuthEventRow {
  let detail: Record<string, unknown> | null = null
  if (row.detail) {
    try {
      const parsed: unknown = JSON.parse(row.detail)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>
      }
    } catch {
      detail = null
    }
  }
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    userId: row.user_id,
    actor: row.actor,
    provider: row.provider,
    detail,
  }
}

/** Newest first, over `(at, id)` — `auth_events_at` indexes the unfiltered
 * order and `auth_events_user` indexes it again per `user_id`, so `?user=`
 * costs the same single indexed walk as the unfiltered page. */
const NEWEST_EVENT_FIRST: Keyset = { columns: ['at', 'id'], direction: 'desc' }

/**
 * A page of `auth_events`, newest first — `GET {base}/api/auth-events` and
 * `GET {base}/api/me/events` are both this, the second with `user` fixed to
 * the caller.
 */
export async function listEvents(
  db: FolioDb,
  opts: { user?: string; cursor?: string | null; limit?: number } = {},
): Promise<Page<AuthEventRow>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const resume = keysetWhere(NEWEST_EVENT_FIRST, opts.cursor ? decodeCursor(opts.cursor) : null)
  const { results } = await db
    .prepare(
      `select id, at, kind, user_id, actor, provider, detail from auth_events
       ${whereOf(opts.user ? 'user_id = ?' : null, resume.sql)}
       ${orderBy(NEWEST_EVENT_FIRST)} limit ?`,
    )
    .bind(...(opts.user ? [opts.user] : []), ...resume.binds, limit + 1)
    .all<RawEvent>()
  return paginate(results.map(toEvent), limit, (row) => [row.at, row.id])
}

/**
 * The epoch of the oldest row in the whole table, or null when it is empty.
 *
 * **Unaffected by `?user=` on purpose** (`GET {base}/api/auth-events`'s
 * `oldestAt`): it is a fact about the table, not about the page a caller
 * happened to filter to, and it is the one place a deployment that never wired
 * `sweepAuth` into a cron can see that it never did.
 */
export async function oldestEventAt(db: FolioDb): Promise<number | null> {
  const row = await db
    .prepare('select min(at) as at from auth_events')
    .first<{ at: number | null }>()
  return row?.at ?? null
}

/** How long an event survives before `sweepEvents` reaps it. */
export const AUTH_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Housekeeping. Not on any request path — `folio.sweepAuth` is the only caller. */
export async function sweepEvents(db: FolioDb, now = Date.now()): Promise<number> {
  const result = await db
    .prepare('delete from auth_events where at <= ?')
    .bind(now - AUTH_EVENT_RETENTION_MS)
    .run()
  return result.meta.changes ?? 0
}
