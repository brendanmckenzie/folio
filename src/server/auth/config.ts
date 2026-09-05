/**
 * What a host configures, and the check that makes forgetting impossible.
 *
 * `auth` is a **required** key on `FolioConfig` (architecture checkpoint 2).
 * Folio is a library: a host that forgets to configure auth was, until this
 * spec, getting a publicly editable CMS silently, and the failure mode of that
 * mistake is a defaced site. So the mistake is not representable — either the
 * config names providers, or it says `auth: 'open'` in as many words.
 *
 * **A provider is one of four kinds** (`../../../docs/specs/foundation/auth-providers.md`
 * decision 1), and each kind has exactly its functions. It used to be a bag of
 * optionals switched on `redirect: boolean`, which meant the routes and the login
 * page each re-derived what a provider *was* from which functions it happened to
 * carry — and a provider with `start` and no `callback` passed construction and
 * failed at the callback. A discriminant makes the shape checkable once, here.
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

export interface VerifiedIdentity {
  email: string
  name?: string
  /**
   * Whatever else the provider verified — id-token claims, an Access JWT
   * payload — for `roleFrom`. Never stored and never projected to a client.
   */
  claims?: Readonly<Record<string, unknown>>
}

/**
 * Maps a verified identity to a role. `null` means "this identity holds no role
 * here"; the interaction table in the spec's decision 5 says what that does.
 *
 * A function rather than a declarative `{ claim, map }` because a callback
 * covers what a DSL cannot — an app-roles claim versus a groups claim, a group
 * overage that points at a directory API, a role derived from the domain.
 */
export type RoleMapper = (identity: VerifiedIdentity) => Role | null

/** Every kind carries these three. */
interface ProviderBase {
  id: string
  /** Button label on the login page. */
  label: string
  /**
   * Email domains this provider is the only door for. Lowercase, no `@`, exact
   * match — `resolveAuth` compiles every provider's list into one map and throws
   * when two providers claim the same domain.
   */
  domains?: readonly string[]
}

/**
 * Only kinds that *produce* a `VerifiedIdentity` get the identity → user knobs.
 * A link proves an address and a passkey proves a device, and neither is an
 * identity provider's assertion about a person — so neither may provision or
 * place a role.
 */
interface Provisions {
  provision?: Provisioning
  roleFrom?: RoleMapper
}

export interface MailProvider<Env = unknown> extends ProviderBase {
  kind: 'mail'
  /** Sends a sign-in link. Fire-and-forget: the route awaits it and answers the
   * same thing either way. */
  send: (env: Env, mail: MagicLinkMail) => unknown
}

/**
 * Opaque to Folio: the provider's own round-trip state, whatever it needs to
 * carry between `start` and `callback`. Folio adds `next` in the cookie envelope
 * around it and the provider never sees it.
 */
export type RedirectState = Readonly<Record<string, string>>

export interface RedirectProvider<Env = unknown> extends ProviderBase, Provisions {
  kind: 'redirect'
  start: (env: Env, ctx: { redirectUri: string }) => Promise<{ url: string; state: RedirectState }>
  callback: (
    env: Env,
    ctx: { params: URLSearchParams; redirectUri: string; state: RedirectState },
  ) => Promise<VerifiedIdentity>
  /** Where "sign out" sends the browser after Folio's own session is revoked. */
  signOutUrl?: string
}

export interface TrustedProvider<Env = unknown> extends ProviderBase, Provisions {
  kind: 'trusted'
  /**
   * Null when this request carries no identity from the host. **Throws** when it
   * carries one that does not verify — that is a provider error, not "nobody".
   */
  resolve: (env: Env, req: Request) => Promise<VerifiedIdentity | null>
  signOutUrl?: string
}

/** `foundation/passkeys.md`. Constructed only by `passkeys()`; its routes are
 * Folio's own, which is why it carries no functions of its own. */
export interface PasskeyProvider extends ProviderBase {
  kind: 'passkey'
  id: 'passkey'
  rpName?: string
}

export type AuthProvider<Env = unknown> =
  | MailProvider<Env>
  | RedirectProvider<Env>
  | TrustedProvider<Env>
  | PasskeyProvider

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

/**
 * `FolioConfig.auth`, resolved: the two shapes the runtime branches on.
 *
 * The session arm carries the providers **partitioned by kind** as well as the
 * config itself, because every reader wants one kind: the login page wants the
 * mail provider and the redirect buttons, `POST /login/email` wants the mail
 * provider, and the trusted resolution loop wants the trusted ones in
 * declaration order. Sniffing them out of `config.providers` at each call site
 * is what the kinds replaced.
 */
export type ResolvedAuth<Env = unknown> =
  | { mode: 'open' }
  | {
      mode: 'session'
      config: AuthConfig<Env>
      sessionDays: number
      linksPerHour: number
      /** At most one: the no-JavaScript login page has one address field. */
      mail: MailProvider<Env> | null
      passkey: PasskeyProvider | null
      redirects: readonly RedirectProvider<Env>[]
      trusted: readonly TrustedProvider<Env>[]
      /** domain → provider id, compiled from every provider's `domains`. */
      domains: ReadonlyMap<string, string>
    }

const OPEN_HINT =
  "folio: `auth` must be configured — pass `auth: { providers: [...] }`, or `auth: 'open'` " +
  'deliberately to leave the editor open to anyone who reaches it'

/** The four kinds, as a runtime set — `kind` arrives from a host's object
 * literal and is not trustworthy until it has been checked against this. */
const KINDS = ['mail', 'redirect', 'trusted', 'passkey'] as const

/** A domain as `domains` may spell it: labels, a dot, and a TLD of letters. No
 * `@`, no wildcard (out of scope), no trailing dot. */
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/

/**
 * Turns the config key into the shape the runtime uses, throwing at
 * construction for anything ambiguous. Construction-time and not per-request,
 * the same discipline `validatePresets` / `validateTypes` / `validateGlobals`
 * already keep: a configuration mistake in a CMS should not become a runtime
 * 500 on whichever route reaches it first.
 *
 * **Every refusal names the provider**, because the one thing a host reading a
 * construction throw needs is which of their four entries is wrong.
 */
export function resolveAuth<Env>(auth: AuthConfig<Env> | OpenAuth | undefined): ResolvedAuth<Env> {
  if (auth === undefined) throw new Error(OPEN_HINT)
  if (auth === 'open') return { mode: 'open' }
  if (typeof auth !== 'object' || auth === null) throw new Error(OPEN_HINT)

  if (!Array.isArray(auth.providers) || auth.providers.length === 0) {
    throw new Error("folio: `auth.providers` must list at least one provider (or set auth: 'open')")
  }

  const seen = new Set<string>()
  let mail: MailProvider<Env> | null = null
  let passkey: PasskeyProvider | null = null
  const redirects: RedirectProvider<Env>[] = []
  const trusted: TrustedProvider<Env>[] = []
  const domains = new Map<string, string>()

  for (const provider of auth.providers) {
    if (!provider || typeof provider.id !== 'string' || provider.id === '') {
      throw new Error('folio: every auth provider needs an `id`')
    }
    if (seen.has(provider.id)) {
      throw new Error(`folio: two auth providers share the id '${provider.id}'`)
    }
    seen.add(provider.id)
    if (typeof provider.label !== 'string' || provider.label === '') {
      throw new Error(`folio: auth provider '${provider.id}' needs a \`label\``)
    }
    if (!KINDS.includes(provider.kind)) {
      throw new Error(
        `folio: auth provider '${provider.id}' has an unknown \`kind\` '${String(provider.kind)}' —` +
          ` one of ${KINDS.join(', ')}`,
      )
    }

    switch (provider.kind) {
      case 'mail': {
        if (typeof provider.send !== 'function') {
          throw new Error(
            `folio: auth provider '${provider.id}' is a mail flow but has no \`send\``,
          )
        }
        refuseIdentityKeys(provider)
        refuseDomains(provider, 'a domain enforced to the mail provider is the default')
        if (mail) {
          throw new Error(
            `folio: auth providers '${mail.id}' and '${provider.id}' are both mail flows —` +
              ' the login page has one address field, so only one can be reached',
          )
        }
        mail = provider
        break
      }
      case 'redirect': {
        if (typeof provider.start !== 'function') {
          throw new Error(
            `folio: auth provider '${provider.id}' is a redirect flow but has no \`start\``,
          )
        }
        // Nothing checked this before the kinds, which is how a half-built
        // provider passed construction and failed at the callback instead.
        if (typeof provider.callback !== 'function') {
          throw new Error(
            `folio: auth provider '${provider.id}' is a redirect flow but has no \`callback\``,
          )
        }
        checkIdentityKeys(provider)
        redirects.push(provider)
        break
      }
      case 'trusted': {
        if (typeof provider.resolve !== 'function') {
          throw new Error(
            `folio: auth provider '${provider.id}' is a trusted flow but has no \`resolve\``,
          )
        }
        checkIdentityKeys(provider)
        trusted.push(provider)
        break
      }
      case 'passkey': {
        if (provider.id !== 'passkey') {
          throw new Error(
            `folio: auth provider '${provider.id}' is a passkey flow, whose id must be 'passkey'`,
          )
        }
        refuseIdentityKeys(provider)
        refuseDomains(provider, 'a passkey proves a device, not a domain')
        if (passkey) {
          throw new Error(`folio: two passkey auth providers are configured ('${provider.id}')`)
        }
        passkey = provider
        break
      }
    }

    for (const domain of domainsOf(provider)) {
      const claimed = domains.get(domain)
      if (claimed) {
        throw new Error(
          `folio: auth providers '${claimed}' and '${provider.id}' both claim the domain` +
            ` '${domain}' — an enforced domain is exactly one door`,
        )
      }
      domains.set(domain, provider.id)
    }
  }

  // A passkey has to be enrolled from a session, and only another provider can
  // mint the first one (`foundation/passkeys.md`).
  if (passkey && auth.providers.length === 1) {
    throw new Error(
      'folio: the passkey provider cannot be the only one — nobody could enrol a first passkey',
    )
  }

  const sessionDays = auth.sessionDays ?? 30
  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new Error('folio: `auth.sessionDays` must be a positive number of days')
  }
  const linksPerHour = auth.linksPerHour ?? 5
  if (!Number.isFinite(linksPerHour) || linksPerHour <= 0) {
    throw new Error('folio: `auth.linksPerHour` must be a positive number')
  }
  return {
    mode: 'session',
    config: auth,
    sessionDays,
    linksPerHour,
    mail,
    passkey,
    redirects,
    trusted,
    domains,
  }
}

/** `provision` and `roleFrom`, on a kind that is allowed them. */
function checkIdentityKeys(provider: {
  id: string
  provision?: Provisioning
  roleFrom?: RoleMapper
}): void {
  if (provider.provision !== undefined && provider.provision !== 'refuse') {
    const role = provider.provision.role
    if (role !== undefined && !isRole(role)) {
      throw new Error(
        `folio: auth provider '${provider.id}' provisions with an unknown role '${String(role)}'`,
      )
    }
  }
  if (provider.roleFrom !== undefined && typeof provider.roleFrom !== 'function') {
    throw new Error(`folio: auth provider '${provider.id}'s \`roleFrom\` must be a function`)
  }
}

/**
 * The same two keys, on a kind that is not an identity provider's assertion.
 *
 * Structurally typed rather than taking `MailProvider` — a `MailProvider<Env>`'s
 * `send` is contravariant in `Env`, so the wide parameter would refuse the very
 * providers this is called with.
 */
function refuseIdentityKeys(provider: { id: string; kind: string }): void {
  const bag = provider as { provision?: unknown; roleFrom?: unknown }
  for (const key of ['provision', 'roleFrom'] as const) {
    if (bag[key] !== undefined) {
      throw new Error(
        `folio: auth provider '${provider.id}' is a ${provider.kind} flow and cannot carry` +
          ` \`${key}\` — only a provider that verifies an identity may place a role`,
      )
    }
  }
}

function refuseDomains(provider: { id: string; kind: string }, why: string): void {
  if ((provider as { domains?: unknown }).domains !== undefined) {
    throw new Error(
      `folio: auth provider '${provider.id}' is a ${provider.kind} flow and cannot carry` +
        ` \`domains\` — ${why}`,
    )
  }
}

/** A provider's `domains`, lowercased and screened. Throws naming the provider
 * and the entry, because a typo here silently enforces nothing. */
function domainsOf(provider: { id: string; domains?: readonly string[] }): string[] {
  const declared = provider.domains
  if (declared === undefined) return []
  if (!Array.isArray(declared)) {
    throw new Error(`folio: auth provider '${provider.id}'s \`domains\` must be an array`)
  }
  return declared.map((raw) => {
    const domain = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\.$/, '') : ''
    if (!DOMAIN_RE.test(domain)) {
      throw new Error(
        `folio: auth provider '${provider.id}' claims '${String(raw)}', which is not a domain` +
          ' — lowercase, no `@`, no wildcard',
      )
    }
    return domain
  })
}

/** Screens a scope list arriving from a request body. */
export function screenScopes(value: unknown): Scope[] {
  return Array.isArray(value) ? value.filter(isScope) : []
}

/* -------------------------------------------------- describing it to a client --- */

/**
 * One sign-in provider, **projected** — the facts that describe it, and
 * deliberately not the provider object.
 *
 * `AuthProvider` carries `send`, `start`, `callback`, `resolve` and `roleFrom`.
 * Those are the host's own functions and they are where every credential in an
 * auth configuration lives: a `send` closes over a mail API key, a `start` over
 * an OIDC client secret. A spread would *look* safe — `JSON.stringify` drops a
 * function silently — while carrying every other key a host happened to hang off
 * the object, so the day somebody writes `{ id, label, kind, start, clientSecret }`
 * for their own convenience the secret ships. Naming the fields makes that
 * impossible rather than unlikely, which is the same rule `presenceOf()` follows
 * for a socket attachment.
 */
export interface AuthPolicyProvider {
  id: string
  label: string
  /** Which of the four kinds it is, which is how a screen knows what it does. */
  kind: AuthProvider['kind']
  /** What happens to an identity the provider verified that matches no user row. */
  provision: 'refuse' | 'create'
  /** Role a provisioned user is created with, when `provision` is `'create'`. */
  provisionRole?: Role
  /**
   * Whether this provider's claims place a role. A boolean and not the mapping:
   * a `RoleMapper` is a function, and showing one needs a DSL the spec rejected
   * (decision 5). "Roles: from Okta" is the fact an editor needs.
   */
  rolesFromProvider: boolean
  /** Email domains enforced to this provider, lowercased. Empty for most. */
  domains: string[]
  /** Whether signing out sends the browser on to the provider's own logout. */
  signOut: boolean
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
      kind: p.kind,
      provision: provisionOf(p) === 'refuse' ? ('refuse' as const) : ('create' as const),
      // Only when it would mean something. `provision: 'refuse'` with a role
      // beside it is a contradiction to read past, not a fact.
      ...roleClause(p),
      rolesFromProvider: 'roleFrom' in p && typeof p.roleFrom === 'function',
      domains: [...(p.domains ?? [])].map((d) => d.toLowerCase()),
      signOut: 'signOutUrl' in p && typeof p.signOutUrl === 'string' && p.signOutUrl !== '',
    })),
    // The *resolved* numbers, not `config.sessionDays` — a screen saying "not set"
    // where the answer is "30 days" has answered nothing.
    sessionDays: auth.sessionDays,
    linksPerHour: auth.linksPerHour,
  }
}

/** `Provisioning` for any kind: the two that cannot provision read as
 * `'refuse'`, which is what they do. */
function provisionOf(provider: AuthProvider<unknown>): Provisioning {
  return 'provision' in provider ? (provider.provision ?? 'refuse') : 'refuse'
}

function roleClause(provider: AuthProvider<unknown>): { provisionRole?: Role } {
  const provision = provisionOf(provider)
  if (provision === 'refuse' || !provision.role) return {}
  return { provisionRole: provision.role }
}
