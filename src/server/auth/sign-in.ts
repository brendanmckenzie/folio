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
 * that must not be skipped — domain enforcement, claim-driven roles,
 * provisioning by kind, the provider stamp and the audit row — live inside it
 * rather than at five call sites. What a route keeps is what a route is for:
 * reading the request, and turning the answer into a `Response`.
 *
 * **Provisioning is a property of the kind, not of a flag.** `mail` and
 * `passkey` cannot carry `provision` at all (`config.ts` refuses it at
 * construction), because a link proves an address and a passkey proves a device,
 * and neither is an identity provider's assertion about a person. That is
 * exactly the difference the two old call sites encoded by hand.
 *
 * The order is decision 3's, and each step depends on the one before it:
 * **domain, user, role, provisioning, one batch.**
 */
import type { AuthProvider, Provisioning, ResolvedAuth, VerifiedIdentity } from './config'
import { recordEventStatement } from './events'
import { type Role, isRole } from './roles'
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
 * The domain of an address, lowercased, or `''` for something with no `@`.
 *
 * Exact match is the whole of the enforcement (decision 6): `*.client.com` is
 * out of scope, because a wildcard is a policy language and the agency case the
 * feature exists for names its domains.
 */
export function domainOf(email: string): string {
  const normalised = normaliseEmail(email)
  const at = normalised.lastIndexOf('@')
  return at === -1 ? '' : normalised.slice(at + 1)
}

/**
 * Why a refusal happened, for the `auth_events` row. Short machine words rather
 * than prose: the login page's `?error=` vocabulary is deliberately two values
 * wide and says nothing about which account, and this is the other half — the
 * admin's cue, on a surface only an admin can read.
 */
type RefusalDetail = 'domain' | 'not_invited' | 'role_removed' | 'mapper'

/**
 * Signs a verified identity in, or refuses.
 *
 * The write is **one `db.batch`**: an optional `insert into users` when the
 * provider provisions, an optional role update and session purge when the
 * provider's claims moved the role, the session row, the `users` touch that
 * stamps `last_seen_at` and `provider`, and the `auth_events` rows. One round
 * trip, and an event that cannot exist without the change it records.
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

  /** A refusal, recorded. Batched even when it is the only statement: an event
   * nobody wrote is a refusal nobody can explain afterwards, and this is the
   * one path where the person being refused is told nothing specific. */
  const refuse = async (
    reason: SignInRefusal,
    why: RefusalDetail,
    userId: string | null,
  ): Promise<SignInResult> => {
    await db.batch([
      recordEventStatement(db, {
        kind: 'sign_in_refused',
        // The row when Folio has one, null when it does not. The address is in
        // `detail` either way, because "somebody at this address tried and was
        // turned away" is the fact an admin acts on and half of these refusals
        // are for an address with no row at all.
        userId,
        actor: userId,
        provider: provider.id,
        detail: { email, reason: why },
        at: now,
      }),
    ])
    return { ok: false, reason }
  }

  // (1) Domain enforcement, for **every kind** (decision 6). An enforced domain
  // is exactly one door: the point is that the client's directory controls
  // revocation, so a magic link, a second SSO tenant, a trusted header or a
  // passkey for that domain is a way around it. `POST /login/email` consults the
  // same map before it reads D1; this is the defensive re-check, and it is what
  // covers the four paths that route does not.
  const enforced = auth.domains.get(domainOf(email))
  if (enforced !== undefined && enforced !== provider.id) {
    return refuse('refused', 'domain', null)
  }

  // (2) The user row, if there is one.
  const existing = await userByEmail(db, email)

  // (3) The role the provider's claims place, if it places one. `undefined` is
  // "this provider has no opinion" and is not the same as `null`, which is "this
  // identity holds no role here" — the interaction table below turns on exactly
  // that difference.
  let mapped: Role | null | undefined
  if ('roleFrom' in provider && typeof provider.roleFrom === 'function') {
    let answer: unknown
    try {
      answer = provider.roleFrom(identity)
    } catch (err) {
      // A configuration bug, never a silent default (decision 5). The person
      // sees `error=provider` and the host sees this line; what must not happen
      // is a role appearing from nowhere because a mapper threw.
      console.error(`folio: ${provider.id}'s roleFrom threw`, err)
      return refuse('provider', 'mapper', existing?.id ?? null)
    }
    if (answer !== null && !isRole(answer)) {
      console.error(
        `folio: ${provider.id}'s roleFrom answered '${String(answer)}', which is not a role`,
      )
      return refuse('provider', 'mapper', existing?.id ?? null)
    }
    mapped = answer
  }

  const writes: D1PreparedStatement[] = []
  let user = existing
  let roleChanged = false

  if (!user) {
    // (4) Provisioning, for an identity that matches no row. Three of the
    // interaction table's seven rows, and they differ in what role a created
    // user gets rather than in whether one is created.
    const provision = provisioningOf(provider)
    // Access is a list someone maintains, not a consequence of holding an
    // account at the provider — and for `mail` and `passkey` there is no
    // configuration that could say otherwise.
    if (provision === 'refuse') return refuse('refused', 'not_invited', null)

    let role: Role
    let roleFrom: string | null
    if (mapped === undefined) {
      // No mapper: as before this spec.
      role = provision.role ?? 'editor'
      roleFrom = null
    } else if (mapped === null) {
      // A mapper that placed no role. `provision.role` is the host saying in as
      // many words what an unmapped person gets; the implicit `'editor'` above
      // is not, and falling back to it here is exactly the "in no group silently
      // means editor" failure checkpoint 3 refuses.
      if (!provision.role) return refuse('refused', 'not_invited', null)
      role = provision.role
      roleFrom = null
    } else {
      role = mapped
      roleFrom = provider.id
    }

    const created = createUserStatement(
      db,
      { email, name: identity.name, role, provider: provider.id, roleFrom },
      now,
    )
    user = created.user
    writes.push(created.statement)
  } else if (mapped === null) {
    // Their group was removed. Refusing is checkpoint 3: this provider placed
    // the role, so keeping it would be stale privilege granted by a directory
    // that has since changed its mind. A role Folio placed is left alone —
    // the provider was never the authority on it.
    if (user.roleFrom === provider.id) return refuse('refused', 'role_removed', user.id)
  } else if (mapped !== undefined && mapped !== user.role) {
    // The one write nobody clicked, which is why `auth_events` exists at all.
    roleChanged = true
    const from = user.role
    user = { ...user, role: mapped, roleFrom: provider.id }
    writes.push(
      db
        .prepare('update users set role = ?, role_from = ? where id = ?')
        .bind(mapped, provider.id, user.id),
      // Every *other* browser, mirroring what `PATCH /users/:id` does for an
      // admin's edit: a downgrade must not sit in an open socket's attachment
      // for the window a revocation may. Before the insert below, so the session
      // this sign-in is minting survives it.
      db.prepare('delete from sessions where user_id = ?').bind(user.id),
      recordEventStatement(db, {
        kind: 'role_changed',
        userId: user.id,
        // Nobody clicked. `provider:<id>` is the actor vocabulary for exactly
        // this, and it is the case the table was argued for.
        actor: `provider:${provider.id}`,
        provider: provider.id,
        detail: { from, to: mapped },
        at: now,
      }),
    )
  }
  // The two remaining rows — a provider with no mapper, and a mapper answering
  // the role already stored — write nothing and say nothing. A no-op is not an
  // event.

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
  return { ok: true, user, session, roleChanged }
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
