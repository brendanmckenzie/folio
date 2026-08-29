/**
 * What a host configures, and the check that makes forgetting impossible.
 *
 * `auth` is a **required** key on `FolioConfig` (architecture checkpoint 2).
 * Folio is a library: a host that forgets to configure auth was, until this
 * spec, getting a publicly editable CMS silently, and the failure mode of that
 * mistake is a defaced site. So the mistake is not representable — either the
 * config names providers, or it says `auth: 'open'` in as many words.
 */
import type { Role, Scope } from './roles'
import { isRole, isScope } from './roles'

/** Deliberately open: anyone who reaches the editor may edit. Written out in
 * full, never a default. */
export type OpenAuth = 'open'

export interface MagicLinkMail {
  email: string
  /** The link to put in the mail. Absolute, on the request's own origin. */
  url: string
  /** When the link stops working, epoch ms. */
  expiresAt: number
}

/**
 * A sign-in provider. Two ship (`magicLink`, `oidc`); the shape is open so a
 * host can add its own without Folio growing a branch for it.
 *
 * `id` is what the login page's button posts back and what `users.provider`
 * records. `start`/`callback` are only implemented by redirect-flow providers
 * (OIDC); the magic-link provider has neither and is driven by its own two
 * routes instead.
 */
export interface AuthProvider<Env = unknown> {
  id: string
  /** Button label on the login page. */
  label: string
  /** True for a provider driven by `GET /login/<id>` → IdP → callback. */
  redirect: boolean
  /** Sends a sign-in link. Only the magic-link provider implements this. */
  send?: (env: Env, mail: MagicLinkMail) => unknown
  /** Where to send the browser to start a redirect flow, plus the state to
   * remember. Only a redirect provider implements this. */
  start?: (
    env: Env,
    ctx: { redirectUri: string; next: string },
  ) => Promise<{ url: string; state: OidcState }>
  /** Exchanges the callback's code for a verified email and name. */
  callback?: (
    env: Env,
    ctx: { url: URL; redirectUri: string; state: OidcState },
  ) => Promise<VerifiedIdentity>
  /** What to do with a verified email that matches no user row. */
  provision?: Provisioning
}

/** What the OIDC state cookie carries between the two halves of the flow. */
export interface OidcState {
  state: string
  nonce: string
  verifier: string
  next: string
}

export interface VerifiedIdentity {
  email: string
  name?: string
}

/**
 * `'refuse'` (the default) means an email the IdP verified but Folio has never
 * heard of is turned away: access is a list someone maintains, not a
 * consequence of holding an account at the provider. `'auto'` creates the user
 * on first sign-in with `role`, for a tenant where employment *is* the list.
 */
export type Provisioning = 'refuse' | { create: true; role?: Role }

export interface AuthConfig<Env = unknown> {
  providers: readonly AuthProvider<Env>[]
  /** Session length. Default 30 (`DEFAULT_SESSION_DAYS`). */
  sessionDays?: number
  /**
   * Sign-in links requested per address per hour before further requests are
   * quietly dropped. Default 5. A partial answer by design: the IP dimension
   * needs a zone rate-limiting rule, which is not Folio's to configure (see the
   * spec's edge cases).
   */
  linksPerHour?: number
}

/** `FolioConfig.auth`, resolved: the two shapes the runtime branches on. */
export type ResolvedAuth<Env = unknown> =
  | { mode: 'open' }
  | { mode: 'session'; config: AuthConfig<Env>; sessionDays: number; linksPerHour: number }

const OPEN_HINT =
  "folio: `auth` must be configured — pass `auth: { providers: [...] }`, or `auth: 'open'` " +
  'deliberately to leave the editor open to anyone who reaches it'

/**
 * Turns the config key into the shape the runtime uses, throwing at
 * construction for anything ambiguous. Construction-time and not per-request,
 * the same discipline `validatePresets` / `validateTypes` / `validateGlobals`
 * already keep: a configuration mistake in a CMS should not become a runtime
 * 500 on whichever route reaches it first.
 */
export function resolveAuth<Env>(auth: AuthConfig<Env> | OpenAuth | undefined): ResolvedAuth<Env> {
  if (auth === undefined) throw new Error(OPEN_HINT)
  if (auth === 'open') return { mode: 'open' }
  if (typeof auth !== 'object' || auth === null) throw new Error(OPEN_HINT)

  if (!Array.isArray(auth.providers) || auth.providers.length === 0) {
    throw new Error("folio: `auth.providers` must list at least one provider (or set auth: 'open')")
  }
  const seen = new Set<string>()
  for (const provider of auth.providers) {
    if (!provider || typeof provider.id !== 'string' || provider.id === '') {
      throw new Error('folio: every auth provider needs an `id`')
    }
    if (seen.has(provider.id)) {
      throw new Error(`folio: two auth providers share the id '${provider.id}'`)
    }
    seen.add(provider.id)
    if (!provider.redirect && typeof provider.send !== 'function') {
      throw new Error(
        `folio: auth provider '${provider.id}' must either be a redirect flow or supply \`send\``,
      )
    }
    if (provider.redirect && typeof provider.start !== 'function') {
      throw new Error(
        `folio: auth provider '${provider.id}' is a redirect flow but has no \`start\``,
      )
    }
    if (provider.provision !== undefined && provider.provision !== 'refuse') {
      const role = provider.provision.role
      if (role !== undefined && !isRole(role)) {
        throw new Error(
          `folio: auth provider '${provider.id}' provisions with an unknown role '${String(role)}'`,
        )
      }
    }
  }
  const sessionDays = auth.sessionDays ?? 30
  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new Error('folio: `auth.sessionDays` must be a positive number of days')
  }
  const linksPerHour = auth.linksPerHour ?? 5
  if (!Number.isFinite(linksPerHour) || linksPerHour <= 0) {
    throw new Error('folio: `auth.linksPerHour` must be a positive number')
  }
  return { mode: 'session', config: auth, sessionDays, linksPerHour }
}

/** Screens a scope list arriving from a request body. */
export function screenScopes(value: unknown): Scope[] {
  return Array.isArray(value) ? value.filter(isScope) : []
}

/* -------------------------------------------------- describing it to a client --- */

/**
 * One sign-in provider, **projected** — the four facts that describe it, and
 * deliberately not the provider object.
 *
 * `AuthProvider` carries `send`, `start` and `callback`. Those are the host's own
 * functions and they are where every credential in an auth configuration lives: a
 * `send` closes over a mail API key, a `start` over an OIDC client secret. A
 * spread would *look* safe — `JSON.stringify` drops a function silently — while
 * carrying every other key a host happened to hang off the object, so the day
 * somebody writes `{ id, label, redirect, start, clientSecret }` for their own
 * convenience the secret ships. Naming the fields makes that impossible rather
 * than unlikely, which is the same rule `presenceOf()` follows for a socket
 * attachment.
 */
export interface AuthPolicyProvider {
  id: string
  label: string
  /** A redirect flow (OIDC) rather than an emailed link. */
  redirect: boolean
  /** What happens to an identity the provider verified that matches no user row. */
  provision: 'refuse' | 'create'
  /** Role a provisioned user is created with, when `provision` is `'create'`. */
  provisionRole?: Role
}

/**
 * The sign-in providers and session policy, as `GET {base}/api/me` answers them
 * for the Settings screen (`../../../docs/ui-architecture.md` decision 6).
 *
 * **This lived on the manifest for one commit and that was a security mistake.**
 * `GET {base}/api/schema` is ungated on purpose, and the licence for that is
 * narrow: it describes *declarations a client needs before it can authenticate*.
 * None of this qualifies. `provision` answers "does signing in with any account at
 * that IdP get me an editor, and at what role" for an unauthenticated stranger,
 * and `linksPerHour` publishes the exact throttle — neither makes the site more
 * exploitable (an attacker learns both by trying, and the try succeeds either
 * way), but both turn something you had to attempt into something you can read,
 * which is the difference between a posture and a disclosure. `sessionDays` is the
 * mildest of the three and travels with them rather than splitting a coherent
 * block across two routes over a judgement call.
 *
 * `/me` is the right home for the whole block for one reason: it is the route that
 * already knows who is asking, and it already refuses an unauthenticated caller in
 * session mode. The auth **mode** is on the same response for the same reason.
 */
export interface AuthPolicy {
  providers: AuthPolicyProvider[]
  /** `AuthConfig.sessionDays`, resolved — the default is 30, never absent here. */
  sessionDays: number
  /** `AuthConfig.linksPerHour`, resolved. Default 5. */
  linksPerHour: number
}

/**
 * `ResolvedAuth` as a client may see it, or undefined under `auth: 'open'` —
 * where there are no providers, no session length and no throttle, so absence is
 * the honest answer rather than a block of zeroes.
 *
 * Pure and config-only: no bindings, no actor, no I/O. The *caller* decides who
 * may see the result, which is why this sits beside `resolveAuth` rather than in
 * the route — one place builds it, and `routes/auth.ts` is the only place allowed
 * to hand it out.
 */
export function authPolicy(auth: ResolvedAuth<unknown>): AuthPolicy | undefined {
  if (auth.mode === 'open') return undefined
  return {
    providers: auth.config.providers.map((p) => ({
      id: p.id,
      label: p.label,
      redirect: Boolean(p.redirect),
      provision: provisions(p.provision) ? 'create' : 'refuse',
      // Only when it would mean something. `provision: 'refuse'` with a role
      // beside it is a contradiction to read past, not a fact.
      ...(provisions(p.provision) && p.provision.role ? { provisionRole: p.provision.role } : {}),
    })),
    // The *resolved* numbers, not `config.sessionDays` — a screen saying "not set"
    // where the answer is "30 days" has answered nothing.
    sessionDays: auth.sessionDays,
    linksPerHour: auth.linksPerHour,
  }
}

/** Narrows `Provisioning` to its object arm, so the two reads above agree. */
function provisions(
  provision: Provisioning | undefined,
): provision is { create: true; role?: Role } {
  return provision !== undefined && provision !== 'refuse'
}
