import { beforeAll, describe, expect, it } from 'vitest'
import { algorithmFor, base64url, fromBase64url, verifyJws } from '../../../src/server/auth/jwt'

/**
 * The JWS verifier, on its own.
 *
 * `verifyJws` was extracted from `oidc.ts` by
 * `docs/specs/foundation/auth-providers.md` decision 4 so a Cloudflare Access
 * assertion — a JWT with no nonce and a different issuer check — could be
 * verified by the same code that verifies an id token. Two things follow, and
 * both are pinned here rather than through either caller:
 *
 *   - **The failures are the interesting part.** A verifier that accepts a good
 *     token and nothing else is worth very little; what matters is that a
 *     tampered signature, a `kid` naming a key the issuer never published, and
 *     `alg: none` are each refused *before* any claim is read. Exercising those
 *     through a full sign-in round trip only ever reaches whichever one fails
 *     first.
 *   - **The messages are a contract with the caller.** `source` and `noun` exist
 *     so `verifyIdToken`'s wording survived the extraction byte for byte — the
 *     workers suite asserts strings like `unsupported id token algorithm`
 *     against the OIDC route — and a default of `jwt: token …` covers a caller
 *     that names neither.
 *
 * Runs in Node rather than workerd because nothing here touches a binding:
 * `crypto.subtle` is the only dependency and it is a platform global in both.
 */

interface Keys {
  privateKey: CryptoKey
  jwks: { keys: JsonWebKey[] }
}

let rsa: Keys
let otherRsa: Keys
let ec: Keys

async function rsaKeys(kid: string): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' } as JsonWebKey] },
  }
}

async function ecKeys(kid: string): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' } as JsonWebKey] },
  }
}

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))

async function sign(
  keys: Keys,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const head = encodeJson(header)
  const body = encodeJson(payload)
  const alg =
    header.alg === 'ES256'
      ? ({ name: 'ECDSA', hash: 'SHA-256' } as const)
      : ({ name: 'RSASSA-PKCS1-v1_5' } as const)
  const signature = await crypto.subtle.sign(
    alg,
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  )
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`
}

beforeAll(async () => {
  rsa = await rsaKeys('k1')
  otherRsa = await rsaKeys('k1')
  ec = await ecKeys('e1')
})

const claims = { sub: 'ann', email: 'ann@example.com' }

describe('verifyJws', () => {
  it('returns the header and payload of a token it verifies', async () => {
    const token = await sign(rsa, { alg: 'RS256', kid: 'k1', typ: 'JWT' }, claims)
    const { header, payload } = await verifyJws<typeof claims>(token, { jwks: rsa.jwks })

    expect(header).toMatchObject({ alg: 'RS256', kid: 'k1' })
    expect(payload).toEqual(claims)
  })

  it('verifies ES256 as well as RS256', async () => {
    const token = await sign(ec, { alg: 'ES256', kid: 'e1', typ: 'JWT' }, claims)
    const { payload } = await verifyJws<typeof claims>(token, { jwks: ec.jwks })
    expect(payload.email).toBe('ann@example.com')
  })

  it('checks no claim at all — that is the caller’s half of the split', async () => {
    // Expired, wrong issuer, wrong audience, no nonce: every one of those is a
    // claim, and this function is deliberately blind to all of them. The point
    // of the split is that two protocols with different claim rules share one
    // signature check.
    const token = await sign(rsa, { alg: 'RS256', kid: 'k1' }, { iss: 'nobody', exp: 1 })
    await expect(verifyJws(token, { jwks: rsa.jwks })).resolves.toBeTruthy()
  })

  it('refuses a token naming a kid the JWKS does not hold', async () => {
    const token = await sign(rsa, { alg: 'RS256', kid: 'rotated' }, claims)
    await expect(verifyJws(token, { jwks: rsa.jwks })).rejects.toThrow(
      'jwt: token names a key the JWKS does not have',
    )
  })

  it('tries every key of the right type when the token names no kid', async () => {
    // A rotation window publishes two keys; a token without a `kid` has to be
    // checked against both rather than against the first.
    const token = await sign(rsa, { alg: 'RS256' }, claims)
    const both = { keys: [...otherRsa.jwks.keys, ...rsa.jwks.keys] }
    await expect(verifyJws(token, { jwks: both })).resolves.toBeTruthy()
  })

  it('refuses a signature made by a different key', async () => {
    // Same `kid`, same algorithm, different private key: the shape of a token
    // minted by somebody who read the JWKS and guessed at the rest.
    const token = await sign(otherRsa, { alg: 'RS256', kid: 'k1' }, claims)
    await expect(verifyJws(token, { jwks: rsa.jwks })).rejects.toThrow(
      'jwt: token signature does not verify',
    )
  })

  it('refuses a tampered payload', async () => {
    const token = await sign(rsa, { alg: 'RS256', kid: 'k1' }, claims)
    const [head, , signature] = token.split('.') as [string, string, string]
    const forged = `${head}.${encodeJson({ ...claims, email: 'attacker@example.com' })}.${signature}`
    await expect(verifyJws(forged, { jwks: rsa.jwks })).rejects.toThrow('does not verify')
  })

  it("refuses alg 'none' and every symmetric alg outright", async () => {
    // Not "unsupported" in the sense of "we could add it": a token like this is
    // signed with the issuer's *private* key, so anything symmetric means the
    // key is a value the presenter also holds, which is not a signature.
    const payload = encodeJson(claims)
    await expect(
      verifyJws(`${encodeJson({ alg: 'none' })}.${payload}.`, { jwks: rsa.jwks }),
    ).rejects.toThrow("jwt: unsupported token algorithm 'none'")
    await expect(
      verifyJws(`${encodeJson({ alg: 'HS256' })}.${payload}.AAAA`, { jwks: rsa.jwks }),
    ).rejects.toThrow("jwt: unsupported token algorithm 'HS256'")
    // A header with no `alg` at all reads as `none` rather than as a crash.
    await expect(
      verifyJws(`${encodeJson({ typ: 'JWT' })}.${payload}.AAAA`, { jwks: rsa.jwks }),
    ).rejects.toThrow("jwt: unsupported token algorithm 'none'")
  })

  it('refuses something that is not a JWS at all', async () => {
    await expect(verifyJws('nonsense', { jwks: rsa.jwks })).rejects.toThrow(
      'jwt: token is not a JWS',
    )
    await expect(verifyJws('a.b', { jwks: rsa.jwks })).rejects.toThrow('is not a JWS')
    await expect(verifyJws('a.b.c.d', { jwks: rsa.jwks })).rejects.toThrow('is not a JWS')
  })

  it('refuses an empty JWKS rather than treating it as "nothing to check against"', async () => {
    const token = await sign(rsa, { alg: 'RS256', kid: 'k1' }, claims)
    await expect(verifyJws(token, { jwks: { keys: [] } })).rejects.toThrow(/does not have/)
  })

  /**
   * `source` and `noun` are why `verifyIdToken`'s messages survived the
   * extraction unchanged — `test/workers/auth-login.test.ts` still asserts
   * `unsupported id token algorithm` and `not a JWS` against the OIDC route — and
   * why a Cloudflare Access failure says `assertion` instead of guessing.
   */
  describe('source and noun', () => {
    it("reproduce oidc's wording exactly", async () => {
      const opts = { jwks: rsa.jwks, source: 'oidc', noun: 'id token' }
      await expect(verifyJws('nonsense', opts)).rejects.toThrow('oidc: id token is not a JWS')
      await expect(
        verifyJws(`${encodeJson({ alg: 'none' })}.${encodeJson(claims)}.`, opts),
      ).rejects.toThrow("oidc: unsupported id token algorithm 'none'")
      await expect(
        verifyJws(await sign(rsa, { alg: 'RS256', kid: 'gone' }, claims), opts),
      ).rejects.toThrow('oidc: id token names a key the JWKS does not have')
      await expect(
        verifyJws(await sign(otherRsa, { alg: 'RS256', kid: 'k1' }, claims), opts),
      ).rejects.toThrow('oidc: id token signature does not verify')
    })

    it('name the Access assertion for its own provider', async () => {
      const opts = { jwks: rsa.jwks, source: 'cloudflare-access', noun: 'assertion' }
      await expect(verifyJws('nonsense', opts)).rejects.toThrow(
        'cloudflare-access: assertion is not a JWS',
      )
    })
  })
})

describe('the primitives around it', () => {
  it('round-trips base64url without padding or URL-unsafe characters', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02, 0x7f])
    const encoded = base64url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect([...fromBase64url(encoded)]).toEqual([...bytes])
  })

  it('decodes a value that was padded on the way in', () => {
    // A JWS part never carries `=`, but a JWK component pasted from elsewhere
    // might; the decoder re-adds padding rather than refusing either spelling.
    expect(new TextDecoder().decode(fromBase64url('aGk'))).toBe('hi')
    expect(new TextDecoder().decode(fromBase64url('aGk='))).toBe('hi')
  })

  it('answers null for every algorithm that is not an asymmetric signature', () => {
    expect(algorithmFor('RS256')).not.toBeNull()
    expect(algorithmFor('ES256')).not.toBeNull()
    for (const alg of ['none', 'HS256', 'HS512', 'RS384', 'PS256', 'EdDSA', '']) {
      expect(algorithmFor(alg), alg).toBeNull()
    }
  })
})
