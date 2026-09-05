/**
 * Sign in with an OpenID Connect provider, code flow with PKCE.
 *
 * Written against the discovery document rather than hard-coded endpoints, so
 * one configuration shape covers Entra ID, Google, Okta and anything else that
 * publishes `/.well-known/openid-configuration`.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   - **The issuer is the check, not the email domain.** A personal Microsoft
 *     account signing into a tenant-scoped app arrives with a perfectly valid
 *     verified email; what tells it apart is the `iss` claim, compared against
 *     the discovery document's own `issuer`. Filtering on `@company.com` would
 *     both admit a personal account at a vanity domain and refuse a contractor
 *     the tenant does contain.
 *   - **The id token is verified, not decoded.** Signature against the JWKS,
 *     then issuer, audience, `nonce` and `exp`. An unverified decode of a token
 *     that arrived over TLS from the token endpoint is *nearly* safe and is
 *     exactly the shortcut that turns a redirect_uri mix-up into an
 *     authentication bypass.
 */
import { CLOCK_LEEWAY_MS } from './challenges'
import type { Provisioning, RedirectProvider, RoleMapper, VerifiedIdentity } from './config'
import { base64url, verifyJws } from './jwt'
import { mintSecret } from './secrets'

/** What Folio asks for. `openid` is mandatory; the other two are what the user
 * row needs. */
const DEFAULT_SCOPES = 'openid email profile'

/** The default id. Overridable with `oidc({ id })`, so two tenants — a staff
 * directory and a client's — can be configured side by side. */
export const OIDC_ID = 'oidc'

/** A value read straight from the config, or from the env at request time — a
 * client secret belongs in a secret binding, not in a source file. */
type FromEnv<Env, T> = T | ((env: Env) => T)

function resolveFromEnv<Env, T>(value: FromEnv<Env, T>, env: Env): T {
  return typeof value === 'function' ? (value as (e: Env) => T)(env) : value
}

export interface OidcOptions<Env> {
  /** Discovery base, e.g. `https://login.microsoftonline.com/<tenant>/v2.0`. */
  issuer: string
  /**
   * Provider id, defaulting to `'oidc'`. It is the URL segment
   * (`{base}/login/<id>`), the `users.provider` stamp and what `domains` names,
   * so two tenants need two ids.
   */
  id?: string
  clientId: FromEnv<Env, string>
  clientSecret: FromEnv<Env, string>
  /** Default `'openid email profile'`. */
  scopes?: string
  /**
   * What to do with an email the provider verified but Folio has never heard of.
   * `'refuse'` by default: access is a list someone maintains, not a consequence
   * of holding an account at the identity provider.
   */
  provision?: Provisioning
  /** Maps the id token's claims to a role. `null` refuses a user this provider
   * previously placed (the spec's decision 5). */
  roleFrom?: RoleMapper
  /** Email domains this provider is the only door for. */
  domains?: readonly string[]
  /** Where "sign out" sends the browser. RP-initiated logout is the host's URL
   * to supply: it is not derivable from the discovery document. */
  signOutUrl?: string
  label?: string
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/**
 * Per-isolate discovery cache. An isolate serves many requests, and re-fetching
 * a document that changes about once a year on every sign-in is a round trip for
 * nothing. Deliberately not a `caches` entry: this is small, per-issuer, and
 * losing it on an isolate recycle costs one fetch.
 */
const discoveryCache = new Map<string, { at: number; doc: Discovery }>()
const DISCOVERY_TTL_MS = 60 * 60 * 1000

async function discover(issuer: string, doFetch: typeof fetch): Promise<Discovery> {
  const base = issuer.replace(/\/+$/, '')
  const cached = discoveryCache.get(base)
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc

  const res = await doFetch(`${base}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`oidc: discovery failed (${res.status})`)
  const doc = (await res.json()) as Partial<Discovery>
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('oidc: discovery document is missing a required endpoint')
  }
  const full = doc as Discovery
  discoveryCache.set(base, { at: Date.now(), doc: full })
  return full
}

/* -------------------------------------------------------------------- pkce --- */

/** S256 code challenge for a verifier. */
async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

interface IdTokenClaims {
  /** Everything else the tenant asserts — `groups`, `roles`, whatever a
   * `roleFrom` reads. */
  [claim: string]: unknown
  iss?: string
  aud?: string | string[]
  nonce?: string
  exp?: number
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
}

/**
 * The claims of a verified id token, or a throw.
 *
 * A caller of `verifyJws` (`./jwt.ts`) rather than a verifier of its own: the
 * signature check is protocol-agnostic and is shared with anything else that
 * receives a JWT. What is *here* is everything OIDC adds on top — the issuer,
 * the audience, the nonce that ties the token to this browser's attempt, and the
 * expiry.
 *
 * Exported for its own tests: the failure modes here (a wrong issuer, a replayed
 * nonce, an expired token, a token signed by a key that is not in the JWKS) are
 * the ones worth pinning individually, and doing that through a full HTTP
 * round trip would only ever exercise whichever one fails first.
 */
export async function verifyIdToken(
  token: string,
  expect: { issuer: string; clientId: string; nonce: string; jwks: { keys: JsonWebKey[] } },
  now = Date.now(),
): Promise<IdTokenClaims> {
  const { payload: claims } = await verifyJws<IdTokenClaims>(token, {
    jwks: expect.jwks,
    source: 'oidc',
    noun: 'id token',
  })

  // The issuer, not the email domain: see this module's own comment.
  if (claims.iss !== expect.issuer) {
    throw new Error('oidc: id token was issued by a different issuer')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!audiences.includes(expect.clientId)) {
    throw new Error('oidc: id token is for a different client')
  }
  // The nonce is what ties this token to *this* browser's sign-in attempt: a
  // token replayed from elsewhere carries someone else's.
  if (claims.nonce !== expect.nonce) throw new Error('oidc: id token nonce does not match')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + CLOCK_LEEWAY_MS <= now) {
    throw new Error('oidc: id token has expired')
  }
  return claims
}

/* ---------------------------------------------------------------- provider --- */

/**
 * The three values OIDC needs to survive the trip to the IdP, as a
 * `RedirectState` with names. Folio stores whatever a provider hands it and
 * hands the same thing back; typing it here is what keeps `start` and `callback`
 * from reading an index signature that is `string | undefined` everywhere.
 */
interface OidcRoundTrip extends Record<string, string> {
  state: string
  nonce: string
  verifier: string
}

export function oidc<Env>(options: OidcOptions<Env>): RedirectProvider<Env> {
  if (!options?.issuer) throw new Error('folio: oidc({ issuer }) is required')

  const id = options.id ?? OIDC_ID
  const doFetch: typeof fetch = (input, init) =>
    (options.fetchImpl ?? fetch)(input as RequestInfo, init)

  return {
    kind: 'redirect',
    id,
    label: options.label ?? 'Sign in with your work account',
    provision: options.provision ?? 'refuse',
    ...(options.roleFrom ? { roleFrom: options.roleFrom } : {}),
    ...(options.domains ? { domains: options.domains } : {}),
    ...(options.signOutUrl ? { signOutUrl: options.signOutUrl } : {}),

    // `next` is not here and never was OIDC's: Folio wraps whatever a provider
    // asks it to remember in a `{ next, state }` cookie envelope and hands back
    // only the inner half. What survives is the three things the protocol needs.
    async start(env, { redirectUri }) {
      const doc = await discover(options.issuer, doFetch)
      const state: OidcRoundTrip = {
        state: mintSecret(),
        nonce: mintSecret(),
        verifier: mintSecret(),
      }
      const url = new URL(doc.authorization_endpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', resolveFromEnv(options.clientId, env))
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', options.scopes ?? DEFAULT_SCOPES)
      url.searchParams.set('state', state.state)
      url.searchParams.set('nonce', state.nonce)
      // PKCE even though this is a confidential client with a secret: it binds
      // the code to the browser that requested it, so an intercepted code is
      // useless without the verifier that never left this worker.
      url.searchParams.set('code_challenge', await codeChallenge(state.verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      return { url: url.toString(), state }
    },

    // `params` and not the whole URL: the callback reads the query and nothing
    // else, and a provider that cannot see the request's own origin cannot
    // accidentally decide anything from it.
    async callback(env, { params, redirectUri, state }): Promise<VerifiedIdentity> {
      const error = params.get('error')
      if (error) throw new Error(`oidc: the provider refused the sign-in (${error})`)

      // Checked before anything is fetched: a mismatched state is a CSRF attempt
      // or a stale tab, and either way there is nothing to exchange.
      const returned = params.get('state')
      if (!returned || returned !== state.state) {
        throw new Error('oidc: the sign-in state did not match')
      }
      const code = params.get('code')
      if (!code) throw new Error('oidc: the provider returned no authorization code')

      const doc = await discover(options.issuer, doFetch)
      const clientId = resolveFromEnv(options.clientId, env)
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: resolveFromEnv(options.clientSecret, env),
        code_verifier: state.verifier ?? '',
      })
      const tokenRes = await doFetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (!tokenRes.ok) throw new Error(`oidc: token exchange failed (${tokenRes.status})`)
      const tokens = (await tokenRes.json()) as { id_token?: string }
      if (!tokens.id_token) throw new Error('oidc: token response carried no id_token')

      const jwksRes = await doFetch(doc.jwks_uri)
      if (!jwksRes.ok) throw new Error(`oidc: JWKS fetch failed (${jwksRes.status})`)
      const jwks = (await jwksRes.json()) as { keys: JsonWebKey[] }

      const claims = await verifyIdToken(tokens.id_token, {
        issuer: doc.issuer,
        clientId,
        nonce: state.nonce ?? '',
        jwks,
      })

      const email = claims.email
      if (!email) throw new Error('oidc: the provider asserted no email address')
      // An unverified address is not an identity: it is a string the account
      // holder typed. Absent is treated as verified, because several providers
      // omit the claim for a tenant-managed address that cannot be unverified.
      if (claims.email_verified === false) {
        throw new Error('oidc: the provider has not verified that email address')
      }
      // Every claim travels, not just the two the user row needs: `roleFrom` is
      // the reader, and what a tenant maps a role from is its own business.
      return { email, name: claims.name ?? claims.preferred_username, claims }
    },
  }
}

/** Test seam: forgets the per-isolate discovery cache. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear()
}
