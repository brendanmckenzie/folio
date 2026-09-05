import { describe, expect, it } from 'vitest'
import {
  coseToJwk,
  creationOptions,
  decodeCbor,
  derToRaw,
  ES256,
  parseAuthData,
  PASSKEY_TIMEOUT_MS,
  requestOptions,
  RS256,
  WebAuthnError,
} from '../../../src/server/auth/webauthn'
import { encodeCbor, rawToDer } from '../../lib/synthetic-authenticator'

/**
 * The four primitives under `webauthn.ts`'s two ceremonies, and the two options
 * builders — all pure, all synchronous, so they run in Node.
 *
 * The ceremonies themselves are **not** here: `test/workers/passkey-verify.test.ts`
 * runs those in workerd, because the claim being tested there is that *that*
 * runtime's WebCrypto verifies these signatures. What is here is the parsing and
 * the conversions, where a Node run and a workerd run cannot differ.
 *
 * Bytes are hand-written wherever the encoding is the thing under test. Round
 * -tripping everything through `encodeCbor` would be testing the decoder against
 * its own conventions, which is the failure mode this file exists to avoid.
 */

const bytes = (...values: number[]) => new Uint8Array(values)

const codeOf = (run: () => unknown): string => {
  try {
    run()
  } catch (err) {
    if (err instanceof WebAuthnError) return err.code
    throw err
  }
  throw new Error('expected a WebAuthnError')
}

describe('decodeCbor', () => {
  it('reads unsigned integers across every argument width', () => {
    expect(decodeCbor(bytes(0x00))).toBe(0)
    expect(decodeCbor(bytes(0x17))).toBe(23)
    expect(decodeCbor(bytes(0x18, 0x18))).toBe(24)
    expect(decodeCbor(bytes(0x18, 0xff))).toBe(255)
    expect(decodeCbor(bytes(0x19, 0x01, 0x00))).toBe(256)
    expect(decodeCbor(bytes(0x1a, 0x00, 0x01, 0x00, 0x00))).toBe(65536)
  })

  it('reads negative integers, which is how COSE spells alg and its key labels', () => {
    expect(decodeCbor(bytes(0x20))).toBe(-1)
    // -7 is ES256: the single most-read value in this whole format.
    expect(decodeCbor(bytes(0x26))).toBe(-7)
    // -257 is RS256, and needs the two-byte argument.
    expect(decodeCbor(bytes(0x39, 0x01, 0x00))).toBe(-257)
  })

  it('reads byte strings as Uint8Array and text strings as string', () => {
    expect(decodeCbor(bytes(0x43, 1, 2, 3))).toEqual(bytes(1, 2, 3))
    expect(decodeCbor(bytes(0x44, 0, 0, 0, 0))).toEqual(bytes(0, 0, 0, 0))
    expect(decodeCbor(bytes(0x64, 0x6e, 0x6f, 0x6e, 0x65))).toBe('none')
    expect(decodeCbor(bytes(0x60))).toBe('')
  })

  it('reads arrays and maps, and a map answers a Map so integer keys survive', () => {
    expect(decodeCbor(bytes(0x83, 0x01, 0x02, 0x03))).toEqual([1, 2, 3])
    expect(decodeCbor(bytes(0x80))).toEqual([])

    // `{ 1: 2, 3: -7 }` — a COSE key's first two labels. An object would have
    // stringified them and lost the negatives entirely.
    const map = decodeCbor(bytes(0xa2, 0x01, 0x02, 0x03, 0x26))
    expect(map).toBeInstanceOf(Map)
    expect((map as Map<unknown, unknown>).get(1)).toBe(2)
    expect((map as Map<unknown, unknown>).get(3)).toBe(-7)
  })

  it('reads nested containers, which is what an attestation object is', () => {
    // { "fmt": "none", "attStmt": {} }
    const decoded = decodeCbor(
      bytes(
        0xa2,
        0x63,
        0x66,
        0x6d,
        0x74,
        0x64,
        0x6e,
        0x6f,
        0x6e,
        0x65,
        0x67,
        0x61,
        0x74,
        0x74,
        0x53,
        0x74,
        0x6d,
        0x74,
        0xa0,
      ),
    ) as Map<unknown, unknown>
    expect(decoded.get('fmt')).toBe('none')
    expect(decoded.get('attStmt')).toBeInstanceOf(Map)
  })

  it('reads false, true and null — some authenticators put one in attStmt', () => {
    expect(decodeCbor(bytes(0xf4))).toBe(false)
    expect(decodeCbor(bytes(0xf5))).toBe(true)
    expect(decodeCbor(bytes(0xf6))).toBeNull()
  })

  it('refuses indefinite-length containers', () => {
    // CTAP2 mandates canonical CBOR, so a conformant authenticator never emits
    // the streaming form; accepting it would mean a second, unexercised path
    // through every container type.
    expect(codeOf(() => decodeCbor(bytes(0x9f, 0x01, 0xff)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0xbf, 0x01, 0x02, 0xff)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0x5f, 0x41, 0x01, 0xff)))).toBe('malformed')
  })

  it('refuses tags', () => {
    // Nothing in WebAuthn is tagged, and a decoder that skips a tag silently
    // changes what the byte string underneath it means to its caller.
    expect(codeOf(() => decodeCbor(bytes(0xc0, 0x01)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0xd8, 0x18, 0x01)))).toBe('malformed')
  })

  it('refuses floats and the reserved simple values', () => {
    expect(codeOf(() => decodeCbor(bytes(0xfb, 0, 0, 0, 0, 0, 0, 0, 0)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0xfa, 0, 0, 0, 0)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0xf9, 0, 0)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0xf7)))).toBe('malformed')
  })

  it('refuses an item that ends early, and one with trailing bytes', () => {
    expect(codeOf(() => decodeCbor(bytes(0x43, 1, 2)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes(0x83, 0x01)))).toBe('malformed')
    expect(codeOf(() => decodeCbor(bytes()))).toBe('malformed')
    // Trailing bytes matter because `decodeCbor` is handed a whole
    // attestationObject: silently ignoring a tail would hide a truncation.
    expect(codeOf(() => decodeCbor(bytes(0x01, 0x02)))).toBe('malformed')
  })

  it('round-trips what the synthetic authenticator encodes', () => {
    const key = new Map<number, unknown>([
      [1, 2],
      [3, ES256],
      [-1, 1],
      [-2, new Uint8Array(32).fill(7)],
      [-3, new Uint8Array(32).fill(8)],
    ])
    const decoded = decodeCbor(encodeCbor(key)) as Map<unknown, unknown>
    expect(decoded.get(3)).toBe(ES256)
    expect(decoded.get(-2)).toEqual(new Uint8Array(32).fill(7))
  })
})

describe('parseAuthData', () => {
  /** 32-byte rpIdHash, one flag byte, a four-byte big-endian counter. */
  const withoutAttestation = (flags: number, counter: number) => {
    const out = new Uint8Array(37)
    out.fill(0xaa, 0, 32)
    out[32] = flags
    out[33] = (counter >>> 24) & 0xff
    out[34] = (counter >> 16) & 0xff
    out[35] = (counter >> 8) & 0xff
    out[36] = counter & 0xff
    return out
  }

  it('reads an assertion’s authenticator data, which has no AT section', () => {
    const parsed = parseAuthData(withoutAttestation(0x01 | 0x04, 42))
    expect(parsed.rpIdHash).toEqual(new Uint8Array(32).fill(0xaa))
    expect(parsed.counter).toBe(42)
    expect(parsed.flags).toEqual({ up: true, uv: true, be: false, bs: false, at: false, ed: false })
    expect(parsed.credentialId).toBeNull()
    expect(parsed.publicKey).toBeNull()
    expect(parsed.publicKeyBytes).toBeNull()
  })

  it('reads every flag bit at its own position', () => {
    expect(parseAuthData(withoutAttestation(0x00, 0)).flags).toEqual({
      up: false,
      uv: false,
      be: false,
      bs: false,
      at: false,
      ed: false,
    })
    // 0x02 and 0x20 are reserved and must not turn any of the six on.
    expect(parseAuthData(withoutAttestation(0x02 | 0x20, 0)).flags).toEqual({
      up: false,
      uv: false,
      be: false,
      bs: false,
      at: false,
      ed: false,
    })
    expect(parseAuthData(withoutAttestation(0x08 | 0x10, 0)).flags).toMatchObject({
      be: true,
      bs: true,
    })
    expect(parseAuthData(withoutAttestation(0x80, 0)).flags.ed).toBe(true)
  })

  it('reads a counter that uses the full 32 bits without going negative', () => {
    expect(parseAuthData(withoutAttestation(0x01, 0xffffffff)).counter).toBe(4294967295)
    // A `<<` on the top byte would have wrapped this to -1, which then reads as
    // a regression against every stored counter there is.
    expect(parseAuthData(withoutAttestation(0x01, 0x80000000)).counter).toBe(2147483648)
  })

  const withAttestation = (aaguid: Uint8Array, key: Map<number, unknown>, trailing = 0) => {
    const keyBytes = encodeCbor(key)
    const credentialId = new Uint8Array(16).fill(5)
    const out = new Uint8Array(55 + credentialId.length + keyBytes.length + trailing)
    out.fill(0xaa, 0, 32)
    out[32] = 0x01 | 0x04 | 0x40 | (trailing > 0 ? 0x80 : 0)
    out[36] = 3
    out.set(aaguid, 37)
    out[53] = 0
    out[54] = credentialId.length
    out.set(credentialId, 55)
    out.set(keyBytes, 55 + credentialId.length)
    return { authData: out, keyBytes, credentialId }
  }

  const p256Key = new Map<number, unknown>([
    [1, 2],
    [3, ES256],
    [-1, 1],
    [-2, new Uint8Array(32).fill(1)],
    [-3, new Uint8Array(32).fill(2)],
  ])

  it('reads a registration’s AAGUID, credential id and COSE key', () => {
    const { authData, keyBytes, credentialId } = withAttestation(
      new Uint8Array(16).fill(0xfb),
      p256Key,
    )
    const parsed = parseAuthData(authData)
    expect(parsed.flags.at).toBe(true)
    expect(parsed.counter).toBe(3)
    expect(parsed.aaguid).toBe('fb'.repeat(16))
    expect(parsed.credentialId).toEqual(credentialId)
    expect(parsed.publicKey?.get(3)).toBe(ES256)
    // The stored key is the authenticator's own encoding, byte for byte: a
    // re-encode could never disagree with what was signed.
    expect(parsed.publicKeyBytes).toEqual(new Uint8Array(keyBytes))
  })

  it('reads an all-zero AAGUID as absent, not as a vendor', () => {
    const { authData } = withAttestation(new Uint8Array(16), p256Key)
    expect(parseAuthData(authData).aaguid).toBeNull()
  })

  it('stops the COSE key at its own end when extension data follows', () => {
    // The ED flag means bytes follow the key. Reading "the rest of authData" as
    // the key would store the extensions with it and break every later import.
    const { authData, keyBytes } = withAttestation(new Uint8Array(16), p256Key, 6)
    expect(parseAuthData(authData).publicKeyBytes).toEqual(new Uint8Array(keyBytes))
  })

  it('refuses data too short to hold the fixed header', () => {
    expect(codeOf(() => parseAuthData(new Uint8Array(36)))).toBe('malformed')
  })

  it('refuses a truncated attested-credential section', () => {
    const short = new Uint8Array(40)
    short[32] = 0x40
    expect(codeOf(() => parseAuthData(short))).toBe('malformed')
  })

  it('refuses a credential id that runs past the end', () => {
    const out = new Uint8Array(60)
    out[32] = 0x40
    out[53] = 0xff
    out[54] = 0xff
    expect(codeOf(() => parseAuthData(out))).toBe('malformed')
  })
})

describe('coseToJwk', () => {
  const ec2 = (over: Partial<Record<number, unknown>> = {}) =>
    new Map<number, unknown>(
      Object.entries({
        1: 2,
        3: ES256,
        [-1]: 1,
        [-2]: new Uint8Array(32).fill(1),
        [-3]: new Uint8Array(32).fill(2),
        ...over,
      }).map(([k, v]) => [Number(k), v]),
    )

  it('converts an EC2 P-256 key', () => {
    const { jwk, alg } = coseToJwk(ec2())
    expect(alg).toBe(ES256)
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    // 32 bytes → 43 base64url characters, unpadded.
    expect(jwk.x).toHaveLength(43)
    expect(jwk.y).toHaveLength(43)
  })

  it('left-pads a short coordinate back to the curve’s width', () => {
    // A coordinate whose leading bytes happened to be zero, emitted trimmed.
    // JWK requires exactly 32 bytes for P-256, so an unpadded import fails —
    // and it fails for one credential in 256, which is a bug you find in
    // production if this is not handled here.
    const { jwk } = coseToJwk(ec2({ [-2]: new Uint8Array(30).fill(7) }))
    expect(jwk.x).toHaveLength(43)
    expect(jwk.x?.startsWith('AAA')).toBe(true)
  })

  it('strips a leading zero an encoder added to a coordinate', () => {
    const padded = new Uint8Array(33)
    padded.set(new Uint8Array(32).fill(9), 1)
    expect(coseToJwk(ec2({ [-2]: padded })).jwk.x).toHaveLength(43)
  })

  it('refuses a coordinate longer than the curve', () => {
    expect(codeOf(() => coseToJwk(ec2({ [-2]: new Uint8Array(40).fill(9) })))).toBe('malformed')
  })

  it('converts an RSA key and trims the leading zero from n', () => {
    const n = new Uint8Array(257)
    n.set(new Uint8Array(256).fill(0xcd), 1)
    const key = new Map<number, unknown>([
      [1, 3],
      [3, RS256],
      [-1, n],
      [-2, new Uint8Array([0x01, 0x00, 0x01])],
    ])
    const { jwk, alg } = coseToJwk(key)
    expect(alg).toBe(RS256)
    expect(jwk).toMatchObject({ kty: 'RSA', e: 'AQAB' })
    // 256 bytes, not 257: a JWK integer is unsigned and carries no sign byte.
    expect(jwk.n).toHaveLength(342)
  })

  it('refuses a key type that is neither EC2 nor RSA', () => {
    // OKP (1) is Ed25519's, deliberately out of scope: it is not in WebCrypto
    // everywhere yet, and `passkeys.alg` has no CHECK so adding it later is a
    // branch here rather than a table rebuild.
    expect(codeOf(() => coseToJwk(new Map<number, unknown>([[1, 1]])))).toBe('algorithm')
    expect(codeOf(() => coseToJwk(new Map<number, unknown>([[1, 4]])))).toBe('algorithm')
    expect(codeOf(() => coseToJwk(new Map()))).toBe('algorithm')
  })

  it('refuses an algorithm the key type does not declare', () => {
    expect(codeOf(() => coseToJwk(ec2({ 3: -257 })))).toBe('algorithm')
    expect(codeOf(() => coseToJwk(ec2({ 3: -8 })))).toBe('algorithm')
  })

  it('refuses an EC2 key on a curve that is not P-256', () => {
    expect(codeOf(() => coseToJwk(ec2({ [-1]: 2 })))).toBe('algorithm')
  })

  it('refuses a key whose coordinate is not a byte string', () => {
    expect(codeOf(() => coseToJwk(ec2({ [-3]: 'not bytes' })))).toBe('malformed')
  })
})

describe('derToRaw', () => {
  it('converts a plain 32/32 pair', () => {
    const r = new Uint8Array(32).fill(0x11)
    const s = new Uint8Array(32).fill(0x22)
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s])
    expect(derToRaw(der)).toEqual(new Uint8Array([...r, ...s]))
  })

  it('strips the leading zero DER adds when the top bit is set', () => {
    // DER INTEGER is signed, so 0x80… is written as 00 80…. Passing that
    // through unchanged gives WebCrypto a 33-byte r and it refuses the lot.
    const r = new Uint8Array(32).fill(0x80)
    const s = new Uint8Array(32).fill(0x01)
    const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, 0x00, ...r, 0x02, 0x20, ...s])
    expect(derToRaw(der)).toEqual(new Uint8Array([...r, ...s]))
  })

  it('left-pads a short member back to the curve’s width', () => {
    // r happened to be small, so DER wrote fewer bytes. Concatenating them
    // as-is misaligns s and every signature after it fails to verify.
    const r = new Uint8Array(30).fill(0x07)
    const s = new Uint8Array(32).fill(0x09)
    const der = new Uint8Array([0x30, 0x42, 0x02, 0x1e, ...r, 0x02, 0x20, ...s])
    const raw = derToRaw(der)
    expect(raw).toHaveLength(64)
    expect(raw.slice(0, 2)).toEqual(new Uint8Array([0, 0]))
    expect(raw.slice(2, 32)).toEqual(r)
    expect(raw.slice(32)).toEqual(s)
  })

  it('handles a single-byte member', () => {
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x06])
    const raw = derToRaw(der)
    expect(raw[31]).toBe(5)
    expect(raw[63]).toBe(6)
    expect(raw.slice(0, 31)).toEqual(new Uint8Array(31))
  })

  it('round-trips whatever the synthetic authenticator DER-encodes', () => {
    // Both directions implement the leading-zero rule from the spec rather than
    // from each other, so this agreeing is evidence rather than a tautology.
    for (const [r, s] of [
      [new Uint8Array(32).fill(0x80), new Uint8Array(32).fill(0x80)],
      [new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0xff)],
      [
        (() => {
          const v = new Uint8Array(32)
          v[31] = 1
          return v
        })(),
        new Uint8Array(32).fill(3),
      ],
    ]) {
      const raw = new Uint8Array([...(r as Uint8Array), ...(s as Uint8Array)])
      expect(derToRaw(rawToDer(raw))).toEqual(raw)
    }
  })

  it('refuses something that is not a DER sequence', () => {
    expect(codeOf(() => derToRaw(new Uint8Array(64).fill(1)))).toBe('signature')
    expect(codeOf(() => derToRaw(new Uint8Array(4)))).toBe('signature')
  })

  it('refuses a member that is not an INTEGER, and a truncated one', () => {
    expect(
      codeOf(() => derToRaw(new Uint8Array([0x30, 0x06, 0x04, 0x01, 0x05, 0x02, 0x01, 0x06]))),
    ).toBe('signature')
    expect(codeOf(() => derToRaw(new Uint8Array([0x30, 0x44, 0x02, 0x20, 1, 2, 3, 4])))).toBe(
      'signature',
    )
  })
})

describe('the options a browser is handed', () => {
  const challenge = new Uint8Array(32).fill(0x2a)

  it('asks for user verification and a discoverable credential at registration', () => {
    const options = creationOptions({
      rpId: 'folio.example',
      rpName: 'Folio',
      challenge,
      user: { id: 'usr_abc', name: 'ann@example.com', displayName: 'Ann' },
      exclude: [{ id: 'aWQx', transports: ['internal'] }, { id: 'aWQy' }],
    })

    // Checkpoint 2: a passkey is the only factor in this sign-in, so the local
    // PIN or biometric is what makes it two.
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required',
    })
    // Never evaluated, and asking for `none` is what stops most authenticators
    // producing a statement at all (decision 3).
    expect(options.attestation).toBe('none')
    expect(options.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: ES256 },
      { type: 'public-key', alg: RS256 },
    ])
    expect(options.timeout).toBe(PASSKEY_TIMEOUT_MS)
    expect(options.rp).toEqual({ id: 'folio.example', name: 'Folio' })
    // base64url of the account id's UTF-8 bytes, which is what an assertion's
    // `userHandle` is cross-checked against.
    expect(options.user.id).toBe('dXNyX2FiYw')
    expect(options.challenge).toBe('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio')
    // The browser refuses to re-enrol something in this list and shows its own
    // message, so the server never sees the attempt.
    expect(options.excludeCredentials).toEqual([
      { id: 'aWQx', type: 'public-key', transports: ['internal'] },
      { id: 'aWQy', type: 'public-key' },
    ])
  })

  it('omits an empty transports list rather than sending one', () => {
    const options = creationOptions({
      rpId: 'folio.example',
      rpName: 'Folio',
      challenge,
      user: { id: 'usr_abc', name: 'a@b.com', displayName: 'A' },
      exclude: [
        { id: 'aWQx', transports: [] },
        { id: 'aWQy', transports: null },
      ],
    })
    expect(options.excludeCredentials).toEqual([
      { id: 'aWQx', type: 'public-key' },
      { id: 'aWQy', type: 'public-key' },
    ])
  })

  it('asks for user verification and lists no credentials at sign-in', () => {
    const options = requestOptions({ rpId: 'folio.example', challenge })
    expect(options.userVerification).toBe('required')
    expect(options.rpId).toBe('folio.example')
    expect(options.timeout).toBe(PASSKEY_TIMEOUT_MS)
    // Empty, and it stays empty: the sign-in route is unauthenticated, so it
    // does not know whose passkeys to name and naming them would be an
    // enumeration oracle. A discoverable credential needs no list.
    expect(options.allowCredentials).toEqual([])
  })
})
