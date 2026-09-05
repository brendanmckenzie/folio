/**
 * The Your account screen's pure arithmetic: whether this person may add a
 * passkey and why not, what a row's timestamps and badges say, and how a
 * device's authenticator model reads as a name a person recognises rather than
 * sixteen hex characters.
 *
 * `docs/specs/foundation/passkeys.md` decision 6 is the design; `Account.tsx`
 * only draws what this file decides, following `content-model.ts` and
 * `access-model.ts`'s convention — no admin test mounts a component
 * (`vitest.config.ts` runs the unit project under `environment: 'node'`), so a
 * screen's decisions have to live somewhere a Node test can reach them.
 */
import type { Me, MeUser } from '../../me'
import { when } from './content-rows'

/* ------------------------------------------------------------------ gate --- */

/**
 * Whether this screen has a subject at all, as four cases rather than a
 * boolean — the same shape `access-model.ts`'s `AccessGate` uses and the same
 * reason: `auth: 'open'` has no accounts to have one of, an anonymous visitor
 * has nobody to be, and a token — which never drives the admin at all
 * (`admin/me.ts`'s own comment: "a token is not a person with a cursor") —
 * would otherwise fall through to a branch built for a person.
 *
 * Unlike `AccessGate` there is no role check: anyone signed in may look at
 * their own passkeys, sessions and sign-in history, so `ok` is reached by
 * every role.
 */
export type AccountGate =
  | { kind: 'ok'; self: MeUser }
  | { kind: 'open' }
  | { kind: 'anonymous'; loginUrl: string }
  | { kind: 'token' }

export function accountGate(me: Me): AccountGate {
  if (me.mode === 'open') return { kind: 'open' }
  if (me.actor === null) return { kind: 'anonymous', loginUrl: me.loginUrl }
  if (me.actor.kind === 'token') return { kind: 'token' }
  return { kind: 'ok', self: me.actor }
}

/* -------------------------------------------------------------- passkeys --- */

/** A passkey as `GET {base}/api/me/passkeys` answers one — `routes/passkeys.ts`'s
 * own `toJson`, which never carries `publicKey` or the raw `counter`. */
export interface PasskeyRow {
  id: string
  name: string
  alg: number
  transports: string[] | null
  aaguid: string | null
  backedUp: boolean
  createdAt: number
  lastUsedAt: number | null
}

/**
 * Why this person may or may not add a passkey — three states, not a boolean.
 *
 * `me.passkeys` is **absent** on a deployment that never listed `passkeys()` at
 * all: there is nothing to add and nothing to explain, so the screen should not
 * render a refusal for a feature that does not exist here. `allowed: false` is a
 * *specific* refusal — today only an enforced domain (spec 28) — with a reason
 * worth a sentence. Telling the two apart is the whole point of `Me.passkeys`
 * being optional rather than a bare boolean.
 */
export type PasskeyAvailability =
  | { kind: 'unavailable' }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'available' }

export function passkeyAvailability(me: Me): PasskeyAvailability {
  if (!me.passkeys) return { kind: 'unavailable' }
  if (!me.passkeys.allowed) {
    return { kind: 'forbidden', reason: me.passkeys.reason ?? 'You may not add a passkey.' }
  }
  return { kind: 'available' }
}

/**
 * The Add button's one gate.
 *
 * **Absent, not disabled** — this admin's rule for a permission the person
 * cannot change (`docs/specs/foundation/passkeys.md` decision 6, and
 * `access-model.ts`'s `roleFromReason` is the same rule applied to a role
 * instead of a button). `Account.tsx` never renders a disabled Add button; it
 * renders this check, and the reason from `passkeyAvailability` in its place.
 */
export function canEnrol(me: Me): boolean {
  return passkeyAvailability(me).kind === 'available'
}

/**
 * The common half-dozen authenticator models, by `aaguid` — publicly documented
 * identifiers authenticators themselves report, never a secret and never a
 * security input (the migration's own comment: "labels the vendor on the
 * account screen; never a security input"). Lower-cased, because an
 * authenticator's own casing is not something this file should have to agree
 * with.
 */
const AAGUID_VENDORS: Readonly<Record<string, string>> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain (managed Apple ID)',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
}

/**
 * The vendor name a `passkeys.aaguid` implies, or null.
 *
 * Null covers two things the screen treats alike: no `aaguid` at all (an
 * authenticator that answered `fmt: 'none'` and zeroed it) and one this map does
 * not recognise — which is the ordinary case for anything but the handful
 * above. Either way the row falls back to its own name, which is the thing a
 * person actually typed.
 */
export function aaguidVendor(aaguid: string | null): string | null {
  if (!aaguid) return null
  return AAGUID_VENDORS[aaguid.toLowerCase()] ?? null
}

/** "ES256" / "RS256" from the COSE `alg` every passkey stores — the only two
 * `pubKeyCredParams` the options route ever asks for (decision 3). A third
 * algorithm is a code change away (no `CHECK` on the column), so this falls
 * back to the raw number rather than pretending to know its name. */
export function algLabel(alg: number): string {
  switch (alg) {
    case -7:
      return 'ES256'
    case -257:
      return 'RS256'
    default:
      return `alg ${alg}`
  }
}

/** Why "Add a passkey" is refused at the cap, or undefined when it is not.
 * `MAX_PASSKEYS_PER_USER` is the server's own limit (`auth/passkeys.ts`) — the
 * route answers `409` for the same reason, and this is what lets the screen say
 * so before the click rather than after. */
export function passkeyCapReason(count: number, max: number): string | undefined {
  return count >= max ? `That is the limit (${max}). Remove one before adding another.` : undefined
}

/* -------------------------------------------------------------- sessions --- */

/** A browser as `GET {base}/api/me/sessions` answers one. No "last active" —
 * `users.last_seen_at` is per person, not per session, so there is no honest
 * per-browser answer to it (`routes/passkeys.ts`'s own comment). */
export interface SessionRow {
  id: string
  current: boolean
  provider: string | null
  createdAt: number
  expiresAt: number
  userAgent: string | null
}

/**
 * How a session says what signed it in.
 *
 * Deliberately its own function rather than `settings-model.ts`'s `FLOWS`:
 * that one describes a *method of signing in*, in the words of somebody
 * configuring a deployment ("Redirect to the provider"); this one names *what
 * signed this particular session in*, in the words of somebody looking at
 * their own device — and the two have already drifted once, because `FLOWS`
 * has no entry for `null`, which every session minted before spec 28 answers.
 */
export function providerLabel(provider: string | null): string {
  if (provider === null) return 'Unknown'
  if (provider === 'passkey') return 'Passkey'
  if (provider === 'mail') return 'Emailed link'
  // Redirect and trusted providers are named by the id the host chose
  // (`passkeys()`'s own `id: 'passkey'` is the pattern), so the identifier
  // itself is the closest thing to a label this file can give without
  // depending on `AuthPolicy`, which a session row does not carry.
  return provider
}

export function userAgentLabel(userAgent: string | null): string {
  return userAgent ?? 'Unknown browser'
}

/* --------------------------------------------------------- recent sign-ins --- */

/** A row as `GET {base}/api/me/events` answers one — `auth/events.ts`'s own
 * `AuthEventRow`, read back rather than re-declared: `kind` is a plain string
 * with no `CHECK` in the schema, so a kind this build has not been taught yet
 * must still read as data. */
export interface EventRow {
  id: string
  at: number
  kind: string
  provider: string | null
  detail: Record<string, unknown> | null
}

/**
 * One line per event kind, in the words a person reads about their own
 * account — never the table's or the route's vocabulary.
 *
 * Falls back to the raw `kind` for anything this list does not know, the same
 * screening `AuthEventRow`'s own comment argues for: a kind a later migration
 * adds must read as *something*, not vanish or throw.
 */
export function eventLabel(row: Pick<EventRow, 'kind' | 'provider'>): string {
  switch (row.kind) {
    case 'sign_in':
      return row.provider ? `Signed in with ${providerLabel(row.provider)}` : 'Signed in'
    case 'sign_in_refused':
      return 'A sign-in attempt was refused'
    case 'sign_out':
      return 'Signed out'
    case 'role_changed':
      return 'Role changed'
    case 'passkey_removed':
      return 'Removed a passkey'
    case 'passkeys_removed':
      return 'An admin removed every passkey on this account'
    case 'sessions_revoked':
      return 'Signed out other browsers'
    case 'passkey_rejected':
      return 'A passkey sign-in was refused'
    case 'user_invited':
      return 'Invited'
    case 'user_removed':
      return 'Access removed'
    default:
      return row.kind
  }
}

/* --------------------------------------------------------------- stamps --- */

/**
 * A timestamp, coarsened the way every other list in this admin does
 * (`content-rows.ts`'s `when`, `access-model.ts`'s own `since`). `null` is the
 * one case this screen actually reaches it for: a passkey that has never been
 * used to sign in.
 */
export function since(at: number | null, now?: number): string {
  return at === null ? 'never' : when({ updatedAt: at, draftUpdatedAt: null }, now)
}
