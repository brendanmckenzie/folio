/**
 * Sign in as whoever Cloudflare Access let through.
 *
 * A deployment behind Access already made everyone authenticate; without this
 * they then meet Folio's login page and do it again, and Folio learns nothing
 * about who they are. This provider reads the assertion the edge injects,
 * **verifies its signature**, and hands the identity to `completeSignIn`, which
 * turns it into an ordinary Folio session with an ordinary Folio role.
 *
 * `foundation/identity-and-access.md` rejected Access as an auth mechanism, and
 * that judgement stands for what it judged: putting Access in front of an
 * `auth: 'open'` deployment gates the route and carries no per-user role into
 * the editor, so everybody who gets in is an anonymous editor. Listing this
 * provider is the other shape — Access decides who reaches the origin, Folio
 * decides what they may do once there — and the two are worth keeping apart in
 * a host's head.
 *
 * **Verifying the signature is the entire point, and it is easy to talk
 * yourself out of.** `Cf-Access-Jwt-Assertion` looks like a header only the edge
 * can set, and on the *intended* route it is. But a Worker is reachable at its
 * `workers.dev` subdomain, at a preview URL, and at any route somebody forgets
 * to put the Access application in front of — and on every one of those a
 * request can carry whatever headers it likes. Trusting the header on its face
 * therefore turns one missed route into "anyone may claim to be the CEO". So the
 * token is verified against the team's published keys, its issuer and audience
 * are checked, and its expiry is checked, before an email is read out of it.
 *
 * Two facts here are **assumptions, unverified against a live Access tenant** at
 * the time of writing, and both are called out again where they are used: that
 * the certs document carries a `keys` array of JWKs beside its `public_certs`,
 * and that `iss` is the bare team URL with no path. If either turns out to be
 * wrong, the failure is loud — a throw, `?error=provider`, and a log line —
 * rather than a bypass, which is the property that made it safe to build on them.
 */
import { CLOCK_LEEWAY_MS } from './challenges'
import type { Provisioning, RoleMapper, TrustedProvider } from './config'
import { verifyJws } from './jwt'
import { trusted } from './trusted'

/** The default id: the URL segment, the `users.provider` stamp, and what
 * `sessions.provider` records. Overridable for a second Access tenant. */
export const CLOUDFLARE_ACCESS_ID = 'cloudflare-access'

/** The header the edge injects on a request it has authenticated. Read as the
 * canonical carrier; the `CF_Authorization` cookie holds the same token and is
 * deliberately ignored — a cookie is the shape `readSessionCookie` does not look
 * at, and one credential per surface is the rule this file keeps. */
const ASSERTION_HEADER = 'cf-access-jwt-assertion'

/** A value from the config, or from the env at request time — an AUD tag is not
 * a secret, but a host may prefer to keep it in a binding beside the rest. */
type FromEnv<Env, T> = T | ((env: Env) => T)

function resolveFromEnv<Env, T>(value: FromEnv<Env, T>, env: Env): T {
  return typeof value === 'function' ? (value as (e: Env) => T)(env) : value
}

export interface CloudflareAccessOptions<Env> {
  /** `acme` or `acme.cloudflareaccess.com` — both spellings work. */
  teamDomain: string
  /** The application's AUD tag, from the Access dashboard or a secret binding. */
  aud: FromEnv<Env, string>
  /** Default `'cloudflare-access'`. Two Access applications need two ids. */
  id?: string
  label?: string
  /** Default `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`, which
   * really does end the upstream session — unlike a proxy header. */
  signOutUrl?: string
  provision?: Provisioning
  roleFrom?: RoleMapper
  domains?: readonly string[]
  /** Injected in tests, as `oidc()` takes one. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** What Access publishes at `/cdn-cgi/access/certs`. `public_certs` is the older
 * PEM-shaped half and Folio does not read it. */
interface AccessCerts {
  keys?: JsonWebKey[]
  public_certs?: unknown
}

interface AccessClaims {
  [claim: string]: unknown
  iss?: string
  aud?: string | string[]
  exp?: number
  email?: string
}

/**
 * Per-isolate certs cache, the same shape and for the same reason as `oidc.ts`'s
 * discovery cache: an isolate serves many requests and the document rotates on
 * the order of weeks, so re-fetching it per sign-in is a round trip on the one
 * request a person is waiting on. Losing it on a recycle costs one fetch.
 */
const certsCache = new Map<string, { at: number; certs: { keys: JsonWebKey[] } }>()
const CERTS_TTL_MS = 60 * 60 * 1000

/** Test seam: forgets the per-isolate certs cache. */
export function resetAccessCertsCache(): void {
  certsCache.clear()
}

/** `acme`, `acme.cloudflareaccess.com` and `https://acme.cloudflareaccess.com/`
 * all name the same team. One spelling out. */
export function accessTeamUrl(teamDomain: string): string {
  const bare = teamDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  if (bare === '') throw new Error('folio: cloudflareAccess({ teamDomain }) is required')
  return bare.includes('.') ? `https://${bare}` : `https://${bare}.cloudflareaccess.com`
}

async function accessCerts(
  teamUrl: string,
  doFetch: typeof fetch,
): Promise<{ keys: JsonWebKey[] }> {
  const cached = certsCache.get(teamUrl)
  if (cached && Date.now() - cached.at < CERTS_TTL_MS) return cached.certs

  const res = await doFetch(`${teamUrl}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`cloudflare-access: certs fetch failed (${res.status})`)
  const doc = (await res.json()) as AccessCerts
  // **Assumption, unverified against a live tenant:** the document carries a
  // `keys` array of JWKs. If it ever carries only `public_certs`, this throws
  // and every sign-in says `error=provider` — visibly wrong, rather than a
  // verification that quietly stops happening.
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new Error('cloudflare-access: the certs document carried no `keys`')
  }
  const certs = { keys: doc.keys }
  certsCache.set(teamUrl, { at: Date.now(), certs })
  return certs
}

export function cloudflareAccess<Env>(options: CloudflareAccessOptions<Env>): TrustedProvider<Env> {
  if (!options?.teamDomain) throw new Error('folio: cloudflareAccess({ teamDomain }) is required')
  if (options.aud === undefined || options.aud === '') {
    throw new Error('folio: cloudflareAccess({ aud }) is required — it is what scopes the token')
  }
  const teamUrl = accessTeamUrl(options.teamDomain)
  const doFetch: typeof fetch = (input, init) =>
    (options.fetchImpl ?? fetch)(input as RequestInfo, init)

  return trusted<Env>({
    id: options.id ?? CLOUDFLARE_ACCESS_ID,
    label: options.label ?? 'Continue with Cloudflare Access',
    signOutUrl: options.signOutUrl ?? `${teamUrl}/cdn-cgi/access/logout`,
    ...(options.provision ? { provision: options.provision } : {}),
    ...(options.roleFrom ? { roleFrom: options.roleFrom } : {}),
    ...(options.domains ? { domains: options.domains } : {}),

    async resolve(env, req) {
      const token = req.headers.get(ASSERTION_HEADER)
      // No assertion is "nobody", not a failure: this is what a request that
      // did not come through Access looks like, and the ordinary login page is
      // the right answer to it. Nothing is fetched on this path.
      if (!token) return null

      const certs = await accessCerts(teamUrl, doFetch)
      const { payload } = await verifyJws<AccessClaims>(token, {
        jwks: certs,
        source: 'cloudflare-access',
        noun: 'assertion',
      })

      // **Assumption, unverified against a live tenant:** `iss` is the bare team
      // URL, no path. A mismatch throws, so a wrong assumption is a refused
      // sign-in rather than an accepted foreign token.
      if (payload.iss !== teamUrl) {
        throw new Error('cloudflare-access: the assertion names a different team')
      }
      // The AUD tag is per *application*. Without this check an assertion minted
      // for any other application on the same team — a staging site, a Grafana
      // instance — would sign its holder into this CMS.
      const aud = resolveFromEnv(options.aud, env)
      const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
      if (!audiences.includes(aud)) {
        throw new Error('cloudflare-access: the assertion is for a different application')
      }
      if (typeof payload.exp !== 'number' || payload.exp * 1000 + CLOCK_LEEWAY_MS <= Date.now()) {
        throw new Error('cloudflare-access: the assertion has expired')
      }
      const email = typeof payload.email === 'string' ? payload.email : ''
      if (email === '') throw new Error('cloudflare-access: the assertion asserted no email')

      // Every claim travels, not just the address: `roleFrom` is the reader, and
      // what an Access policy puts in a token — groups, a custom claim, the
      // identity provider that vouched — is the tenant's business.
      return { email, claims: payload }
    },
  })
}
