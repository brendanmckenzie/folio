/**
 * Verifying a compact JWS, and the base64url and algorithm primitives around it.
 *
 * Extracted from `oidc.ts` because it is not OIDC's
 * (`../../../docs/specs/foundation/auth-providers.md` decision 4): a Cloudflare
 * Access assertion is a JWT with no nonce and a different issuer check, and
 * `verifyIdToken` could not verify one because it *requires* a nonce. The split
 * is signature-and-shape here, claims at the caller.
 *
 * **The signature is the whole point.** A JWT that arrived over TLS from a
 * token endpoint is *nearly* safe to decode without checking; a JWT that arrived
 * in a request header is not safe at all, because anything that reaches the
 * Worker without going through the edge can write that header. One verifier,
 * used by both, is how the second case cannot be forgotten.
 */

export interface JwtHeader {
  alg?: string
  kid?: string
}

export interface JwsOptions {
  /** The keys the issuer publishes. `kid` narrows to one when the token names it. */
  jwks: { keys: JsonWebKey[] }
  /** Prefixes every message, so a failure names the provider that produced it. */
  source?: string
  /** What the token is called in a message: `id token`, `assertion`. */
  noun?: string
}

/** Backed by a plain `ArrayBuffer` explicitly, so the result is a `BufferSource`
 * `crypto.subtle.verify` accepts without a cast. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Which `crypto.subtle` algorithm a JOSE `alg` names, or null if unsupported. */
export function algorithmFor(
  alg: string,
): { importAlg: EcKeyImportParams | RsaHashedImportParams } | null {
  switch (alg) {
    case 'RS256':
      return { importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } }
    case 'ES256':
      return { importAlg: { name: 'ECDSA', namedCurve: 'P-256' } }
    default:
      // `none` and every HMAC alg included. A token like this is signed with the
      // issuer's *private* key; anything symmetric here means the "key" is a
      // value the client also holds, which is not a signature.
      return null
  }
}

function verifyParams(alg: string): AlgorithmIdentifier | EcdsaParams {
  return alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
}

/**
 * The header and payload of a JWS whose signature verifies against `jwks`, or a
 * throw. **No claim is checked here** — issuer, audience, nonce and expiry are
 * per-protocol and belong to the caller.
 */
export async function verifyJws<Payload>(
  token: string,
  opts: JwsOptions,
): Promise<{ header: JwtHeader; payload: Payload }> {
  const source = opts.source ?? 'jwt'
  const noun = opts.noun ?? 'token'

  const parts = token.split('.')
  if (parts.length !== 3) throw new Error(`${source}: ${noun} is not a JWS`)
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const decoder = new TextDecoder()
  const header = JSON.parse(decoder.decode(fromBase64url(headerPart))) as JwtHeader
  const alg = header.alg ?? ''
  const chosen = algorithmFor(alg)
  if (!chosen) throw new Error(`${source}: unsupported ${noun} algorithm '${alg || 'none'}'`)

  // `kid` narrows to one key when the issuer sends one, which is what makes a
  // rotation window work; without it every candidate of the right type is tried.
  const candidates = opts.jwks.keys.filter(
    (k) => header.kid === undefined || (k as { kid?: string }).kid === header.kid,
  )
  if (candidates.length === 0) {
    throw new Error(`${source}: ${noun} names a key the JWKS does not have`)
  }

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
  if (!ok) throw new Error(`${source}: ${noun} signature does not verify`)

  return {
    header,
    payload: JSON.parse(decoder.decode(fromBase64url(payloadPart))) as Payload,
  }
}
