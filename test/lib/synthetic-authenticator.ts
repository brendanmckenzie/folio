/**
 * An authenticator made of WebCrypto, producing exactly the JSON a browser hands
 * a server after `navigator.credentials.create()` / `.get()`.
 *
 * Phase 1 of `docs/specs/foundation/passkeys.md`, step 2. It exists because the
 * verifier is hand-rolled (decision 3), so the *logic* needs a counterparty that
 * can be driven into every refusal on purpose — a wrong challenge, a cleared UV
 * flag, an rpIdHash for another host, a counter that goes backwards — none of
 * which a real device will do on request.
 *
 * **What it does not prove.** It encodes CBOR the way this file encodes CBOR and
 * pads the way this file pads, so the two halves of every convention here agree
 * with each other by construction. Real authenticators pad differently, omit
 * `userHandle`, answer `fmt: 'packed'` despite `attestation: 'none'`, zero the
 * AAGUID, and report counter 0 forever. That half is
 * `test/fixtures/webauthn/`'s job and is **captured by hand, once, from a real
 * device** — see that directory's README. Read a green
 * `passkey-verify.test.ts` as "the logic is right", never as "this parses what
 * Chrome and Safari actually send".
 *
 * Lives in `test/lib/` rather than `test/workers/` because `vitest.config.ts`
 * globs `*.test.ts` under the two project roots: a helper next to the tests
 * would be collected as a suite with no tests in it. `scripts/passkey-test.mjs`
 * (phase 3) imports it too, through `scripts/lib/ts-resolve.mjs`.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '../../src/server/auth/webauthn'

// ---------------------------------------------------------------------------
// base64url and CBOR, the encoding direction
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(new ArrayBuffer(total))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Head byte plus the shortest argument encoding, which is what CTAP2's
 * canonical CBOR requires and therefore what the decoder is fed in practice. */
function head(major: number, arg: number): Uint8Array<ArrayBuffer> {
  if (arg < 24) return new Uint8Array([(major << 5) | arg])
  if (arg < 0x100) return new Uint8Array([(major << 5) | 24, arg])
  if (arg < 0x10000) return new Uint8Array([(major << 5) | 25, arg >> 8, arg & 0xff])
  return new Uint8Array([
    (major << 5) | 26,
    (arg >>> 24) & 0xff,
    (arg >> 16) & 0xff,
    (arg >> 8) & 0xff,
    arg & 0xff,
  ])
}

/**
 * The encoding side of the same subset `decodeCbor` reads: unsigned and negative
 * integers, byte strings, text strings, arrays and maps.
 *
 * Exported because the unit tests build malformed and well-formed items with it
 * — a decoder tested only against bytes the same file produced is a decoder
 * tested against itself, so the tests that matter hand-write their bytes and
 * this is only for the bulk.
 */
export function encodeCbor(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return concat([head(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) {
    return concat([head(4, value.length), ...value.map((v) => encodeCbor(v))])
  }
  if (value instanceof Map) {
    const parts: Uint8Array[] = [head(5, value.size)]
    for (const [k, v] of value) {
      parts.push(encodeCbor(k), encodeCbor(v))
    }
    return concat(parts)
  }
  if (value === false) return new Uint8Array([0xf4])
  if (value === true) return new Uint8Array([0xf5])
  if (value === null) return new Uint8Array([0xf6])
  throw new Error(`synthetic authenticator: cannot encode ${String(value)}`)
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/**
 * `r || s` → `SEQUENCE { INTEGER r, INTEGER s }`.
 *
 * WebCrypto signs ECDSA into the raw pair; an authenticator hands back DER. This
 * is the inverse of the verifier's `derToRaw`, and it is deliberately *not*
 * written by calling that function backwards: the leading-zero rule is the thing
 * under test, so both sides implement it from the spec rather than from each
 * other.
 */
export function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const half = raw.length / 2
  const encodeInt = (value: Uint8Array): Uint8Array => {
    let at = 0
    while (at < value.length - 1 && value[at] === 0) at++
    const trimmed = value.subarray(at)
    // DER INTEGER is signed, so a top bit that is set needs a leading zero or
    // the value reads as negative. This is the padding the verifier strips.
    const body = (trimmed[0] as number) & 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed
    return concat([new Uint8Array([0x02, body.length]), body])
  }
  const body = concat([encodeInt(raw.subarray(0, half)), encodeInt(raw.subarray(half))])
  return concat([new Uint8Array([0x30, body.length]), body])
}

// ---------------------------------------------------------------------------
// The authenticator
// ---------------------------------------------------------------------------

export const ES256 = -7
export const RS256 = -257

/** Every deviation a test needs, and nothing a real browser would ever do by
 * accident. Each field is one row of the refusal table in the spec's acceptance
 * criteria; leaving them all unset produces a ceremony that verifies. */
export interface CeremonyOverrides {
  /** What goes in `clientDataJSON.origin`. Required: the verifier compares it to
   * the request origin, which the caller alone knows. */
  origin: string
  /** The rpId hashed into `authData`. Defaults to what the options asked for, so
   * setting it is how "an rpIdHash of another host" is produced. */
  rpId?: string
  /** `clientDataJSON.challenge`. Defaults to the options' own, so setting it is
   * how "a signature over the wrong challenge" is produced — the signature stays
   * valid, which is the point. */
  challenge?: string
  /** `clientDataJSON.type`. Defaults to the ceremony's own. */
  type?: string
  /** User present. Default true. */
  up?: boolean
  /** User verified. Default true — checkpoint 2 requires it and the verifier
   * checks it, so `uv: false` is the "valid signature, UV clear" row. */
  uv?: boolean
  /** Backup eligible / backup state, the pair a synced passkey sets. */
  backedUp?: boolean
  /** The counter written into `authData`. Defaults to 0, which is what a synced
   * passkey reports forever. */
  counter?: number
  /** The attestation `fmt`. Defaults to `'none'`; `'packed'` is the Windows
   * Hello case decision 3 requires be *accepted*, statement ignored. */
  fmt?: string
  /** The attestation statement, encoded but never read by the verifier. */
  attStmt?: Map<unknown, unknown>
  /** Flips a bit in the signature, for the "does not verify" row. */
  corruptSignature?: boolean
  /** Assertion only. Absent omits it, which is what some security keys do for
   * non-discoverable use; a string sends it, and a *wrong* string is the "names
   * another user" row. */
  userHandle?: string
}

export interface Authenticator {
  readonly alg: number
  /** The credential id this authenticator will answer with, base64url. */
  readonly credentialId: string
  create(
    options: PublicKeyCredentialCreationOptionsJSON,
    over: CeremonyOverrides,
  ): Promise<RegistrationResponseJSON>
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    over: CeremonyOverrides,
  ): Promise<AuthenticationResponseJSON>
}

function clientData(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
  // `crossOrigin` is what a real browser writes and the verifier ignores; it is
  // here so the fixture and the synthetic shapes differ in as little as possible.
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}

function flagsByte(over: CeremonyOverrides, attested: boolean): number {
  let flags = 0
  if (over.up !== false) flags |= 0x01
  if (over.uv !== false) flags |= 0x04
  if (over.backedUp) flags |= 0x08 | 0x10
  if (attested) flags |= 0x40
  return flags
}

function counterBytes(counter: number): Uint8Array {
  return new Uint8Array([
    (counter >>> 24) & 0xff,
    (counter >> 16) & 0xff,
    (counter >> 8) & 0xff,
    counter & 0xff,
  ])
}

/**
 * A fresh authenticator holding one credential.
 *
 * `alg` picks the key type — ES256 (`-7`) or RS256 (`-257`), the two
 * `pubKeyCredParams` the options ask for and the two `coseToJwk` imports.
 */
export async function createAuthenticator(
  opts: { alg?: number; aaguid?: Uint8Array } = {},
): Promise<Authenticator> {
  const alg = opts.alg ?? ES256
  const aaguid = opts.aaguid ?? new Uint8Array(16)

  const keyParams: EcKeyGenParams | RsaHashedKeyGenParams =
    alg === ES256
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        }
  const pair = (await crypto.subtle.generateKey(keyParams, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair

  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const cose = new Map<number, unknown>()
  if (alg === ES256) {
    cose.set(1, 2)
    cose.set(3, ES256)
    cose.set(-1, 1)
    cose.set(-2, fromBase64url(jwk.x as string))
    cose.set(-3, fromBase64url(jwk.y as string))
  } else {
    cose.set(1, 3)
    cose.set(3, RS256)
    cose.set(-1, fromBase64url(jwk.n as string))
    cose.set(-2, fromBase64url(jwk.e as string))
  }
  const coseBytes = encodeCbor(cose)

  const rawCredentialId = crypto.getRandomValues(new Uint8Array(32))
  const credentialId = base64url(rawCredentialId)

  const authenticatorData = async (
    rpId: string,
    over: CeremonyOverrides,
    attested: boolean,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const parts: Uint8Array[] = [
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([flagsByte(over, attested)]),
      counterBytes(over.counter ?? 0),
    ]
    if (attested) {
      parts.push(
        aaguid,
        new Uint8Array([(rawCredentialId.length >> 8) & 0xff, rawCredentialId.length & 0xff]),
        rawCredentialId,
        coseBytes,
      )
    }
    return concat(parts)
  }

  const sign = async (payload: Uint8Array, corrupt: boolean): Promise<Uint8Array<ArrayBuffer>> => {
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        alg === ES256 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
        pair.privateKey,
        payload as BufferSource,
      ),
    )
    // Flip a byte in the middle rather than the first: a corrupted DER header
    // would be refused by the parser, and the row under test is a *signature*
    // that does not verify.
    if (corrupt) {
      const at = Math.floor(raw.length / 2)
      raw[at] = (raw[at] as number) ^ 0xff
    }
    return alg === ES256 ? rawToDer(raw) : raw
  }

  return {
    alg,
    credentialId,

    async create(options, over) {
      const rpId = over.rpId ?? options.rp.id
      const authData = await authenticatorData(rpId, over, true)
      const attestationObject = encodeCbor(
        new Map<unknown, unknown>([
          // `fmt: 'none'` is what `attestation: 'none'` asks for; a test that
          // passes `'packed'` is asserting decision 3's "accepted, ignored".
          ['fmt', over.fmt ?? 'none'],
          ['attStmt', over.attStmt ?? new Map()],
          ['authData', authData],
        ]),
      )
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: base64url(
            clientData(
              over.type ?? 'webauthn.create',
              over.challenge ?? options.challenge,
              over.origin,
            ),
          ),
          attestationObject: base64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
      }
    },

    async get(options, over) {
      const rpId = over.rpId ?? options.rpId
      const authData = await authenticatorData(rpId, over, false)
      const raw = clientData(
        over.type ?? 'webauthn.get',
        over.challenge ?? options.challenge,
        over.origin,
      )
      const signature = await sign(
        concat([authData, await sha256(raw)]),
        over.corruptSignature === true,
      )
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: base64url(raw),
          authenticatorData: base64url(authData),
          signature: base64url(signature),
          // Present only when the test names one. A real security key omits it
          // for non-discoverable use, which is the edge case the verifier
          // deliberately tolerates.
          ...(typeof over.userHandle === 'string' ? { userHandle: over.userHandle } : {}),
        },
      }
    },
  }
}

/** The user handle a browser sends back: base64url of the account id's UTF-8
 * bytes, which is what `creationOptions` puts in `user.id`. */
export function userHandleFor(userId: string): string {
  return base64url(new TextEncoder().encode(userId))
}
