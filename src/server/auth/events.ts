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
 * it records, or the thing without its event. The read routes
 * (`GET {base}/api/auth-events`, `GET {base}/api/me/events`) and the retention
 * sweep are the spec's phase 4; they are deliberately absent rather than stubbed,
 * because a surface nothing reads is a surface nobody maintains.
 */
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
