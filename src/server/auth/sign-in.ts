/**
 * One function turns a verified identity into a session.
 *
 * `../../../docs/specs/foundation/auth-providers.md` decision 3 is the argument,
 * and the bug it names is the proof. The identity → user logic used to be
 * written twice — once in `GET /login/verify` and once in
 * `GET /login/:provider/callback` — with *different* rules, and the provider
 * stamp was in exactly one of them. Every magic-link user therefore read "—" in
 * the Access screen's "Signs in with" column, and nothing about that was visible
 * from either route. This spec would have added three more callers.
 *
 * So there is one: **every sign-in path calls `completeSignIn`**, and the things
 * that must not be skipped — provisioning by kind, the provider stamp, the audit
 * row, and (from the spec's later phases) domain enforcement and claim-driven
 * roles — live inside it rather than at five call sites. What a route keeps is
 * what a route is for: reading the request, and turning the answer into a
 * `Response`.
 *
 * **Provisioning is a property of the kind, not of a flag.** `mail` and
 * `passkey` cannot carry `provision` at all (`config.ts` refuses it at
 * construction), because a link proves an address and a passkey proves a device,
 * and neither is an identity provider's assertion about a person. That is
 * exactly the difference the two old call sites encoded by hand.
 */
import type { AuthProvider, Provisioning, ResolvedAuth, VerifiedIdentity } from './config'
import { recordEventStatement } from './events'
import { type NewSession, newSession, sessionStatements } from './session'
import { createUserStatement, normaliseEmail, type UserRow, userByEmail } from './users'
import type { FolioDb } from '../db'

/** Why a sign-in did not happen. The same two words the login page's `?error=`
 * vocabulary already uses, so a route translates rather than invents. */
export type SignInRefusal = 'refused' | 'provider'

export type SignInResult =
  | { ok: true; user: UserRow; session: NewSession; roleChanged: boolean }
  | { ok: false; reason: SignInRefusal }

/** The session arm of `ResolvedAuth`: the only mode a sign-in can happen in. */
export type SessionAuth = Extract<ResolvedAuth<unknown>, { mode: 'session' }>

/**
 * Signs a verified identity in, or refuses.
 *
 * The write is **one `db.batch`**: an optional `insert into users` when the
 * provider provisions, the session row, the `users` touch that stamps
 * `last_seen_at` and `provider`, and the `auth_events` row. One round trip, and
 * an event that cannot exist without the session it records.
 *
 * The raw session token comes back for the route to put in a cookie, exactly as
 * `createSession` already hands it out — it is never stored, only its hash is.
 */
export async function completeSignIn(
  db: FolioDb,
  auth: SessionAuth,
  provider: AuthProvider<unknown>,
  identity: VerifiedIdentity,
  ctx: { userAgent: string | null; now?: number } = { userAgent: null },
): Promise<SignInResult> {
  const now = ctx.now ?? Date.now()
  const email = normaliseEmail(identity.email)

  const existing = await userByEmail(db, email)

  let user = existing
  const writes: D1PreparedStatement[] = []
  if (!user) {
    const provision = provisioningOf(provider)
    // Access is a list someone maintains, not a consequence of holding an
    // account at the provider — and for `mail` and `passkey` there is no
    // configuration that could say otherwise.
    if (provision === 'refuse') return { ok: false, reason: 'refused' }
    const created = createUserStatement(
      db,
      {
        email,
        name: identity.name,
        role: provision.role ?? 'editor',
        provider: provider.id,
      },
      now,
    )
    user = created.user
    writes.push(created.statement)
  }

  const session = await newSession({ days: auth.sessionDays, now })
  writes.push(
    ...sessionStatements(db, user.id, session, {
      userAgent: ctx.userAgent,
      provider: provider.id,
      now,
    }),
    recordEventStatement(db, {
      kind: 'sign_in',
      userId: user.id,
      // Their own id: a sign-in is the one event whose actor is its subject.
      actor: user.id,
      provider: provider.id,
      at: now,
    }),
  )

  await db.batch(writes)
  // `roleChanged` is always false until the spec's phase 3 applies `roleFrom`;
  // it is on the result now so the caller that revokes other sessions is written
  // once rather than added later to five routes.
  return { ok: true, user, session, roleChanged: false }
}

/**
 * What a provider does with an identity it verified that matches no user row.
 *
 * `'refuse'` for the two kinds that cannot carry `provision`, which is not a
 * default standing in for a missing value — it is what those kinds *mean*.
 */
function provisioningOf(provider: AuthProvider<unknown>): Provisioning {
  return 'provision' in provider ? (provider.provision ?? 'refuse') : 'refuse'
}
