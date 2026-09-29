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
import type {
  AuthProvider,
  Provisioning,
  ResolvedAuth,
  RoleGrants,
  VerifiedIdentity,
} from './config'
import { recordEventStatement } from './events'
import { type Role, isRole } from './roles'
import { type NewSession, newSession, sessionStatements, userSessionsDelete } from './session'
import {
  createUserStatement,
  grantMap,
  grantStatement,
  normaliseEmail,
  replaceGrantsStatements,
  type UserRow,
  userByEmail,
} from './users'
import type { FolioDb } from '../db'
import type { FolioLogger } from '../types'

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
 * The write is **one `db.batch`**: an optional `insert into users` and its `*`
 * grant when the provider provisions, an optional grant update and session purge
 * when the provider's claims moved the role, the session row, the `users` touch
 * that stamps `last_seen_at` and `provider`, and the `auth_events` rows. One round
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
  ctx: {
    userAgent: string | null
    now?: number
    /**
     * Statements the *caller* wants in the same batch, run only when the
     * sign-in actually happens.
     *
     * One caller today and one reason: `POST {base}/login/passkey` stamps
     * `passkeys.counter`, `backed_up` and `last_used_at` with what the
     * authenticator just reported (`usePasskeyStatement`), and a second round
     * trip for three columns on the hot path of a sign-in is a round trip the
     * batch was already making. The alternative — a `passkey` branch inside this
     * function — would put a credential table's SQL in the one place that is
     * deliberately provider-agnostic.
     *
     * **Not run on a refusal.** A refused assertion is not a use, so nothing
     * stamps `last_used_at`; the refusal's own event is the only write.
     */
    extra?: readonly D1PreparedStatement[]
  } = { userAgent: null },
  logger: FolioLogger = console,
): Promise<SignInResult> {
  const now = ctx.now ?? Date.now()
  const email = normaliseEmail(identity.email)

  /** A refusal, recorded. Batched even when it is the only statement: an event
   * nobody wrote is a refusal nobody can explain afterwards, and this is the
   * one path where the person being refused is told nothing specific. */
  /** Scopes a mapper named that the registry does not hold, for the event rows. */
  let dropped: string[] = []
  const note = (): { dropped: string[] } | Record<string, never> =>
    dropped.length > 0 ? { dropped } : {}

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
        detail: { email, reason: why, ...note() },
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
  //
  // Read as **a grant set** (`multi-site.md` decision 17): a bare role is
  // `{ '*': role }`, which is all a deployment with no `sites` ever sees.
  let mapped: RoleGrants | null | undefined
  if ('roleFrom' in provider && typeof provider.roleFrom === 'function') {
    let answer: unknown
    try {
      answer = provider.roleFrom(identity)
    } catch (err) {
      // A configuration bug, never a silent default (decision 5). The person
      // sees `error=provider` and the host sees this line; what must not happen
      // is a role appearing from nowhere because a mapper threw.
      logger.error(`folio: ${provider.id}'s roleFrom threw`, err)
      return refuse('provider', 'mapper', existing?.id ?? null)
    }
    const set = grantSetOf(answer)
    if (set === undefined) {
      logger.error(
        `folio: ${provider.id}'s roleFrom answered '${String(answer)}', which is not a role`,
      )
      return refuse('provider', 'mapper', existing?.id ?? null)
    }
    mapped = set
    // A scope the registry does not hold is dropped, not refused: a directory group
    // still mapped to a retired site must not lock its members out of the others.
    // If nothing remains, the mapper placed nothing (decision 17).
    if (mapped !== null) {
      const known = await knownScopes(db, Object.keys(mapped))
      dropped = Object.keys(mapped).filter((scope) => !known.has(scope))
      if (dropped.length > 0) {
        logger.warn(
          `folio: ${provider.id}'s roleFrom named ${dropped.map((d) => `'${d}'`).join(', ')}, which is not a site or group; ignored`,
        )
        const kept = Object.entries(mapped).filter(([scope]) => known.has(scope))
        mapped = kept.length > 0 ? Object.fromEntries(kept) : null
      }
    }
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
    let grants: RoleGrants | undefined
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
      // A lone `*` grant is written exactly as a role always was; anything else
      // is the set.
      const star = starOnly(mapped)
      role = star ?? 'viewer'
      grants = star === null ? mapped : undefined
      roleFrom = provider.id
    }

    const created = createUserStatement(
      db,
      {
        email,
        name: identity.name,
        role,
        provider: provider.id,
        roleFrom,
        ...(grants ? { grants } : {}),
      },
      now,
    )
    user = created.user
    writes.push(...created.statements)
  } else if (mapped === null) {
    // Their group was removed. Refusing is checkpoint 3: this provider placed
    // the role, so keeping it would be stale privilege granted by a directory
    // that has since changed its mind. A role Folio placed is left alone —
    // the provider was never the authority on it. Any grant it placed counts,
    // not only `*` (decision 17).
    if (user.grants.some((g) => g.roleFrom === provider.id) || user.roleFrom === provider.id) {
      return refuse('refused', 'role_removed', user.id)
    }
  } else if (mapped !== undefined && !sameGrants(grantMap(user.grants), mapped, user.role)) {
    // The one write nobody clicked, which is why `auth_events` exists at all.
    roleChanged = true
    const before = grantMap(user.grants)
    const star = starOnly(mapped)
    // A change of one role on `*` keeps the event's shape a role always had; a
    // change of sets records both sets.
    const detail =
      star !== null && starOnly(before) !== null
        ? { from: user.role, to: star }
        : { from: before, to: mapped }
    user = {
      ...user,
      role: mapped['*'] ?? 'viewer',
      roleFrom: mapped['*'] === undefined ? null : provider.id,
      grants: Object.entries(mapped).map(([scope, role]) => ({
        scope,
        role,
        roleFrom: provider.id,
      })),
    }
    writes.push(
      // The grant set, never `users.role` (`0011_sites.sql`). A lone `*` is an
      // upsert, so a user created by old code in the migrate-to-deploy window, who
      // holds no grant yet, gets one here rather than an update that matches
      // nothing; a set replaces every row the user holds (decision 17).
      ...(star !== null && Object.keys(before).every((scope) => scope === '*')
        ? [grantStatement(db, user.id, star, provider.id, now)]
        : replaceGrantsStatements(db, user.id, mapped, provider.id, now)),
      // Every *other* browser, mirroring what `PATCH /users/:id` does for an
      // admin's edit: a downgrade must not sit in an open socket's attachment
      // for the window a revocation may. Before the insert below, so the session
      // this sign-in is minting survives it.
      // Their preview grants go with them (`grants.ts`), in the same batch.
      ...userSessionsDelete(db, user.id),
      recordEventStatement(db, {
        kind: 'role_changed',
        userId: user.id,
        // Nobody clicked. `provider:<id>` is the actor vocabulary for exactly
        // this, and it is the case the table was argued for.
        actor: `provider:${provider.id}`,
        provider: provider.id,
        detail,
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
      // The note decision 17 owes for a mapped scope that was dropped; nothing
      // otherwise, so an ordinary sign-in's row is what it always was.
      ...(dropped.length > 0 ? { detail: note() } : {}),
      at: now,
    }),
    // Last, after the session row exists: the caller's statements are about the
    // credential that was just used, and an event ordered before the thing it
    // describes is the ordering `events.ts` refuses everywhere else.
    ...(ctx.extra ?? []),
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

/**
 * A mapper's answer as a grant set: `null` stays null, a bare role is `{ '*': role }`,
 * a record whose every value is a role is itself, and `{}` placed nothing (null).
 * `undefined` for anything else, which the caller treats as a configuration bug.
 */
function grantSetOf(answer: unknown): RoleGrants | null | undefined {
  if (answer === null) return null
  if (isRole(answer)) return { '*': answer }
  if (typeof answer !== 'object' || Array.isArray(answer)) return undefined
  const entries = Object.entries(answer as Record<string, unknown>)
  if (!entries.every(([scope, role]) => scope !== '' && isRole(role))) return undefined
  return entries.length > 0 ? (Object.fromEntries(entries) as RoleGrants) : null
}

/** The role when a set is exactly one `*` grant, else null. */
function starOnly(set: RoleGrants): Role | null {
  const keys = Object.keys(set)
  return keys.length === 1 && keys[0] === '*' ? (set['*'] ?? null) : null
}

/**
 * Whether the stored set already is the mapped one. Compared by role, never by
 * who set it: a mapper agreeing with the role an admin chose writes nothing, as it
 * always has. A user holding no grant at all reads as `viewer` on `*` (`toUser`),
 * and a mapper answering exactly that is no change either.
 */
function sameGrants(held: RoleGrants, mapped: RoleGrants, role: Role): boolean {
  const current = Object.keys(held).length === 0 ? { '*': role } : held
  const a = Object.keys(current)
  return a.length === Object.keys(mapped).length && a.every((s) => current[s] === mapped[s])
}

/**
 * Which of these scope ids a grant may name: `*` and `shared` always, and every id
 * the registry holds. One read, only when a mapper named a scope other than `*` —
 * so a deployment with no `sites`, whose mappers answer a bare role, pays nothing.
 */
async function knownScopes(db: FolioDb, scopes: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>(scopes.filter((scope) => scope === '*' || scope === 'shared'))
  const rest = scopes.filter((scope) => !known.has(scope))
  if (rest.length === 0) return known
  const { results } = await db
    .prepare(`select id from sites where id in (${rest.map(() => '?').join(', ')})`)
    .bind(...rest)
    .all<{ id: string }>()
  for (const row of results) known.add(row.id)
  return known
}
