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
import type { AuthProvider, OidcState, Provisioning, VerifiedIdentity } from './config'
import { mintSecret } from './secrets'

/** What Folio asks for. `openid` is mandatory; the other two are what the user
 * row needs. */
const DEFAULT_SCOPES = 'openid email profile'

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

/* -------------------------------------------------------------- jwt / pkce --- */

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Backed by a plain `ArrayBuffer` explicitly, so the result is a `BufferSource`
 * `crypto.subtle.verify` accepts without a cast. */
function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** S256 code challenge for a verifier. */
async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

interface JwtHeader {
  alg?: string
  kid?: string
}

interface IdTokenClaims {
  iss?: string
  aud?: string | string[]
  nonce?: string
  exp?: number
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
}

/** Which `crypto.subtle` algorithm a JOSE `alg` names, or null if unsupported. */
function algorithmFor(
  alg: string,
): { importAlg: EcKeyImportParams | RsaHashedImportParams } | null {
  switch (alg) {
    case 'RS256':
      return { importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } }
    case 'ES256':
      return { importAlg: { name: 'ECDSA', namedCurve: 'P-256' } }
    default:
      // `none` and every HMAC alg included. An id token is signed with the
      // provider's *private* key; anything symmetric here means the "key" is a
      // value the client also holds, which is not a signature.
      return null
  }
}

function verifyParams(alg: string): AlgorithmIdentifier | EcdsaParams {
  return alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
}

/**
 * The claims of a verified id token, or a throw.
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
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('oidc: id token is not a JWS')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const decoder = new TextDecoder()
  const header = JSON.parse(decoder.decode(fromBase64url(headerPart))) as JwtHeader
  const alg = header.alg ?? ''
  const chosen = algorithmFor(alg)
  if (!chosen) throw new Error(`oidc: unsupported id token algorithm '${alg || 'none'}'`)

  // `kid` narrows to one key when the provider sends one, which is what makes a
  // rotation window work; without it every candidate of the right type is tried.
  const candidates = expect.jwks.keys.filter(
    (k) => header.kid === undefined || (k as { kid?: string }).kid === header.kid,
  )
  if (candidates.length === 0) throw new Error('oidc: id token names a key the JWKS does not have')

  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  const signature = fromBase64url(signaturePart)
  let ok = false
  for (const jwk of candidates) {
    let key: CryptoKey
    try {
      key = await crypto.subtle.importKey('jwk', jwk, chosen.importAlg, false, ['verify'])
    } catch {
      continue
    }
    if (await crypto.subtle.verify(verifyParams(alg), key, signature, signed)) {
      ok = true
      break
    }
  }
  if (!ok) throw new Error('oidc: id token signature does not verify')

  const claims = JSON.parse(decoder.decode(fromBase64url(payloadPart))) as IdTokenClaims

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

export function oidc<Env>(options: OidcOptions<Env>): AuthProvider<Env> {
  if (!options?.issuer) throw new Error('folio: oidc({ issuer }) is required')

  const doFetch: typeof fetch = (input, init) =>
    (options.fetchImpl ?? fetch)(input as RequestInfo, init)

  return {
    id: OIDC_ID,
    label: options.label ?? 'Sign in with your work account',
    redirect: true,
    provision: options.provision ?? 'refuse',

    async start(env, { redirectUri, next }) {
      const doc = await discover(options.issuer, doFetch)
      const state: OidcState = {
        state: mintSecret(),
        nonce: mintSecret(),
        verifier: mintSecret(),
        next,
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

    async callback(env, { url, redirectUri, state }): Promise<VerifiedIdentity> {
      const error = url.searchParams.get('error')
      if (error) throw new Error(`oidc: the provider refused the sign-in (${error})`)

      // Checked before anything is fetched: a mismatched state is a CSRF attempt
      // or a stale tab, and either way there is nothing to exchange.
      const returned = url.searchParams.get('state')
      if (!returned || returned !== state.state) {
        throw new Error('oidc: the sign-in state did not match')
      }
      const code = url.searchParams.get('code')
      if (!code) throw new Error('oidc: the provider returned no authorization code')

      const doc = await discover(options.issuer, doFetch)
      const clientId = resolveFromEnv(options.clientId, env)
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: resolveFromEnv(options.clientSecret, env),
        code_verifier: state.verifier,
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
        nonce: state.nonce,
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
      return { email, name: claims.name ?? claims.preferred_username }
    },
  }
}

/** Test seam: forgets the per-isolate discovery cache. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear()
}
