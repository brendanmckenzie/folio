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
