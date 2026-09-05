/**
 * WebAuthn registration and assertion, verified against WebCrypto and nothing else.
 *
 * Pure: no D1, no Hono, no `Request`. Everything here takes bytes and JSON that a
 * browser produced and answers a decision — which is what makes the whole of it
 * testable inside workerd against a synthetic authenticator
 * (`test/lib/synthetic-authenticator.ts`) with no HTTP anywhere.
 *
 * **Why this is hand-rolled** (`../../../docs/specs/foundation/passkeys.md`
 * decision 3, checkpoint 1). The repo has no auth dependency and `oidc.ts`
 * already hand-verifies JWS with WebCrypto through `jwt.ts`, whose
 * `fromBase64url`, `base64url` and `algorithmFor` this file reuses rather than
 * owning a second copy of. The only genuinely new primitives are a CBOR decoder
 * over the subset an attestation object uses and a DER-to-raw converter for
 * ECDSA. `@simplewebauthn/server` is "periodically tested but unofficially
 * supported" on Workers and carries ASN.1 and x509 code whose whole purpose is
 * verifying attestation chains this spec declines to verify: a dependency whose
 * largest part does something you have decided not to do.
 *
 * **Attestation is requested as `none` and never evaluated.** An authenticator
 * that answers `fmt: 'packed'` anyway — Windows Hello does — is *accepted*, with
 * its statement ignored, provided `authData` parses. Refusing a non-`none` `fmt`
 * would lock those users out for a check this file does not perform. There is
 * deliberately no trust store and no metadata service here.
 *
 * **User verification is `required` at both ceremonies** (checkpoint 2), and the
 * UV flag is *checked*, not merely requested: a passkey is the only factor in
 * this sign-in, so the local PIN or biometric is what makes it two factors by
 * construction. The cost, stated in the README, is that a bare security key with
 * no PIN cannot enrol at all.
 */
import { algorithmFor, base64url, fromBase64url } from './jwt'

/**
 * Why a ceremony was refused.
 *
 * Every route above this file answers one byte-identical message whatever the
 * code says — an attacker with a credential id must learn nothing — so this is
 * not a vocabulary for users. It exists because exactly one refusal is different
 * *to the host*: `'counter'` is a cloned authenticator and gets a
 * `passkey_rejected` event, and a route cannot tell that from a bad signature
 * without something to switch on.
 */
export type WebAuthnFailure =
  | 'malformed'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'rp_id'
  | 'user_presence'
  | 'user_verification'
  | 'attested_credential'
  | 'algorithm'
  | 'user_handle'
  | 'signature'
  | 'counter'

export class WebAuthnError extends Error {
  readonly code: WebAuthnFailure
  constructor(code: WebAuthnFailure, message: string) {
    super(message)
    this.name = 'WebAuthnError'
    this.code = code
  }
}

/** A `function` declaration rather than a `const` arrow on purpose: TypeScript
 * only narrows control flow past a `never`-returning call when the target is a
 * declaration or a name with an explicit annotation, and every guard below leans
 * on that narrowing instead of a redundant `throw` after it. */
function fail(code: WebAuthnFailure, message: string): never {
  throw new WebAuthnError(code, message)
}

/** COSE algorithm identifiers, and the two `pubKeyCredParams` ask for. */
export const ES256 = -7
export const RS256 = -257

/**
 * Five minutes at both ceremonies. Long enough that a person who went looking
 * for their security key does not come back to an expired prompt, short enough
 * that a challenge cookie parked in an idle tab is not a standing invitation.
 * The cookie's own `Max-Age` is longer (600s) so the *server* is never the half
 * that expires first — an assertion the browser was still willing to produce
 * must not fail on a race with our own clock.
 */
export const PASSKEY_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------------------
// The JSON shapes a browser produces.
//
// Declared here rather than pulled from `@types/webauthn` or the DOM lib: these
// are *wire* shapes — what `JSON.stringify` of a serialised credential looks
// like — not the `PublicKeyCredential` object, whose `ArrayBuffer` fields none
// of this ever sees. `PublicKeyCredential.toJSON()` would produce them, and is
// too new to rely on (the login script serialises by hand, thirty lines).
// ---------------------------------------------------------------------------

export interface PublicKeyCredentialDescriptorJSON {
  id: string
  type: 'public-key'
  transports?: readonly string[]
}

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: readonly { type: 'public-key'; alg: number }[]
  timeout: number
  attestation: 'none'
  excludeCredentials: readonly PublicKeyCredentialDescriptorJSON[]
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' }
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string
  rpId: string
  userVerification: 'required'
  allowCredentials: readonly PublicKeyCredentialDescriptorJSON[]
  timeout: number
}

export interface RegistrationResponseJSON {
  id: string
  rawId: string
  type: string
  response: {
    clientDataJSON: string
    attestationObject: string
    transports?: readonly string[]
  }
}

export interface AuthenticationResponseJSON {
  id: string
  rawId: string
  type: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string | null
  }
}

/** What `verifyRegistration` answers, and what `createPasskey` stores. */
export interface RegisteredCredential {
  /** The credential id from `authData`, base64url. `passkeys.id`. */
  id: string
  /** COSE_Key bytes, exactly as the authenticator encoded them. */
  publicKey: Uint8Array<ArrayBuffer>
  alg: number
  counter: number
  transports: string[] | null
  /** 32 hex characters, or null when the authenticator zeroed it (`fmt: none`). */
  aaguid: string | null
  backedUp: boolean
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The creation options a browser is handed. `rpId` and `rpName` come from the
 * request host, never from configuration (decision 5): a passkey enrolled on a
 * preview host is invisible on production, which is right, and there is no key
 * to misconfigure.
 */
export function creationOptions(input: {
  rpId: string
  rpName: string
  challenge: Uint8Array
  user: { id: string; name: string; displayName: string }
  exclude: readonly { id: string; transports?: readonly string[] | null }[]
}): PublicKeyCredentialCreationOptionsJSON {
  return {
    rp: { id: input.rpId, name: input.rpName },
    // The user handle is the account's own id, base64url of its UTF-8 bytes — so
    // an assertion's `userHandle` cross-check is a string comparison and never a
    // second lookup.
    user: {
      id: base64url(new TextEncoder().encode(input.user.id)),
      name: input.user.name,
      displayName: input.user.displayName,
    },
    challenge: base64url(input.challenge),
    pubKeyCredParams: [
      { type: 'public-key', alg: ES256 },
      { type: 'public-key', alg: RS256 },
    ],
    timeout: PASSKEY_TIMEOUT_MS,
    // Never evaluated. Asking for `none` is what stops most authenticators from
    // producing a statement at all; the ones that produce one anyway are
    // accepted with it ignored.
    attestation: 'none',
    // The browser refuses to re-enrol an authenticator already in this list and
    // shows its own message, so the server never sees the attempt.
    excludeCredentials: input.exclude.map((c) => ({
      id: c.id,
      type: 'public-key' as const,
      ...(c.transports && c.transports.length > 0 ? { transports: c.transports } : {}),
    })),
    // `residentKey: 'required'` is what makes the credential discoverable, which
    // is what makes conditional UI — the passkey offered from the email field's
    // own autofill — possible at all.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  }
}

/**
 * The request options a browser is handed at sign-in.
 *
 * `allowCredentials` is empty and stays empty: the sign-in route is
 * unauthenticated, so it does not know whose passkeys to list, and naming them
 * would be an enumeration oracle. A discoverable credential needs no list.
 */
export function requestOptions(input: {
  rpId: string
  challenge: Uint8Array
}): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: base64url(input.challenge),
    rpId: input.rpId,
    userVerification: 'required',
    allowCredentials: [],
    timeout: PASSKEY_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// CBOR — the subset an attestation object and a COSE key use
// ---------------------------------------------------------------------------

/**
 * Major types 0–5 (unsigned int, negative int, byte string, text string, array,
 * map) plus the three simple values 20–22 (`false`, `true`, `null`).
 *
 * Everything else throws, and the exclusions are the decisions:
 *
 * - **Indefinite length** (additional info 31) is refused wherever it appears.
 *   CTAP2 mandates canonical CBOR, so a definite length is what a conformant
 *   authenticator emits; accepting the streaming form would mean a decoder with
 *   a second, unexercised path through every container type.
 * - **Tags** (major 6) are refused. Nothing in WebAuthn is tagged, and a decoder
 *   that skips tags silently changes what a byte string *means* to its caller.
 * - **Floats** (27, 26, 25) are refused; no field in this format is a float.
 *
 * `false`/`true`/`null` are admitted, unlike the rest of major 7, for the same
 * reason `fmt: 'packed'` is accepted: some authenticator's `attStmt` may carry
 * one, and refusing would lock a person out over a field this file never reads.
 *
 * Maps answer a `Map`, not an object: a COSE key is keyed by *negative
 * integers*, which an object cannot hold without stringifying them.
 */
export function decodeCbor(bytes: Uint8Array): unknown {
  const { value, next } = readItem(bytes, 0)
  if (next !== bytes.length) {
    fail('malformed', `webauthn: ${bytes.length - next} trailing bytes after the CBOR item`)
  }
  return value
}

interface Read {
  value: unknown
  next: number
}

function need(bytes: Uint8Array, at: number, count: number): void {
  if (at + count > bytes.length) fail('malformed', 'webauthn: CBOR ended mid-item')
}

/** The argument of a head byte: its value and where the item's payload starts. */
function readHead(bytes: Uint8Array, at: number): { info: number; arg: number; next: number } {
  need(bytes, at, 1)
  const head = bytes[at] as number
  const info = head & 31
  if (info < 24) return { info, arg: info, next: at + 1 }
  if (info === 24) {
    need(bytes, at + 1, 1)
    return { info, arg: bytes[at + 1] as number, next: at + 2 }
  }
  if (info === 25) {
    need(bytes, at + 1, 2)
    return { info, arg: ((bytes[at + 1] as number) << 8) | (bytes[at + 2] as number), next: at + 3 }
  }
  if (info === 26) {
    need(bytes, at + 1, 4)
    const arg =
      (bytes[at + 1] as number) * 0x1000000 +
      ((bytes[at + 2] as number) << 16) +
      ((bytes[at + 3] as number) << 8) +
      (bytes[at + 4] as number)
    return { info, arg, next: at + 5 }
  }
  // 27 is a 64-bit argument and 28–30 are reserved; 31 is indefinite length.
  // None of the three can appear in a conformant attestation object, and each
  // would need its own path through every container below.
  return fail('malformed', `webauthn: unsupported CBOR additional info ${info}`)
}

function readItem(bytes: Uint8Array, at: number): Read {
  need(bytes, at, 1)
  const major = (bytes[at] as number) >> 5

  if (major === 7) {
    const head = bytes[at] as number
    const info = head & 31
    if (info === 20) return { value: false, next: at + 1 }
    if (info === 21) return { value: true, next: at + 1 }
    if (info === 22) return { value: null, next: at + 1 }
    return fail('malformed', `webauthn: unsupported CBOR simple value ${info}`)
  }
  if (major === 6) {
    return fail('malformed', 'webauthn: CBOR tags are refused')
  }

  const { arg, next } = readHead(bytes, at)

  switch (major) {
    case 0:
      return { value: arg, next }
    case 1:
      // -1 - n, which is how COSE spells alg -7 and the key labels -1…-3.
      return { value: -1 - arg, next }
    case 2: {
      need(bytes, next, arg)
      return { value: bytes.slice(next, next + arg), next: next + arg }
    }
    case 3: {
      need(bytes, next, arg)
      return { value: new TextDecoder().decode(bytes.subarray(next, next + arg)), next: next + arg }
    }
    case 4: {
      const out: unknown[] = []
      let cursor = next
      for (let i = 0; i < arg; i++) {
        const item = readItem(bytes, cursor)
        out.push(item.value)
        cursor = item.next
      }
      return { value: out, next: cursor }
    }
    default: {
      const out = new Map<unknown, unknown>()
      let cursor = next
      for (let i = 0; i < arg; i++) {
        const key = readItem(bytes, cursor)
        const value = readItem(bytes, key.next)
        out.set(key.value, value.value)
        cursor = value.next
      }
      return { value: out, next: cursor }
    }
  }
}

// ---------------------------------------------------------------------------
// Authenticator data
// ---------------------------------------------------------------------------

export interface AuthDataFlags {
  /** User present: somebody touched the authenticator. */
  up: boolean
  /** User verified: a PIN or a biometric. Checkpoint 2 requires it. */
  uv: boolean
  /** Backup eligible: the credential *may* sync. */
  be: boolean
  /** Backup state: the credential *is* synced. `passkeys.backed_up`. */
  bs: boolean
  /** Attested credential data present — the registration half only. */
  at: boolean
  /** Extension data present, which this file skips over rather than reads. */
  ed: boolean
}

export interface AuthData {
  rpIdHash: Uint8Array
  flags: AuthDataFlags
  counter: number
  /** 32 hex characters, or null when every byte was zero. Only with `at`. */
  aaguid: string | null
  credentialId: Uint8Array | null
  /** The decoded COSE key, and the exact bytes it occupied. Only with `at`. */
  publicKey: Map<unknown, unknown> | null
  publicKeyBytes: Uint8Array<ArrayBuffer> | null
}

const HEX = '0123456789abcdef'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += (HEX[b >> 4] as string) + (HEX[b & 15] as string)
  return out
}

/**
 * 32-byte `rpIdHash`, one flag byte, a 4-byte big-endian counter, and — when the
 * AT flag is set — a 16-byte AAGUID, a 2-byte credential-id length, the
 * credential id, and a COSE key.
 *
 * The COSE key is a CBOR item of unknown length followed by optional extension
 * data, which is why this reads it with the incremental reader and keeps the
 * byte range: `passkeys.public_key` stores the authenticator's own encoding, so
 * a re-encode can never disagree with what was signed.
 */
export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) fail('malformed', 'webauthn: authenticator data is too short')
  const flagsByte = bytes[32] as number
  const flags: AuthDataFlags = {
    up: (flagsByte & 0x01) !== 0,
    uv: (flagsByte & 0x04) !== 0,
    be: (flagsByte & 0x08) !== 0,
    bs: (flagsByte & 0x10) !== 0,
    at: (flagsByte & 0x40) !== 0,
    ed: (flagsByte & 0x80) !== 0,
  }
  const counter =
    (bytes[33] as number) * 0x1000000 +
    ((bytes[34] as number) << 16) +
    ((bytes[35] as number) << 8) +
    (bytes[36] as number)

  const base: AuthData = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    counter,
    aaguid: null,
    credentialId: null,
    publicKey: null,
    publicKeyBytes: null,
  }
  if (!flags.at) return base

  if (bytes.length < 55) fail('malformed', 'webauthn: attested credential data is truncated')
  const aaguidBytes = bytes.subarray(37, 53)
  const idLength = ((bytes[53] as number) << 8) | (bytes[54] as number)
  if (bytes.length < 55 + idLength) {
    fail('malformed', 'webauthn: the credential id runs past the authenticator data')
  }
  const credentialId = bytes.slice(55, 55 + idLength)
  const key = readItem(bytes, 55 + idLength)
  if (!(key.value instanceof Map)) fail('malformed', 'webauthn: the COSE key is not a CBOR map')

  return {
    ...base,
    // All-zero is what an authenticator emits under `attestation: 'none'`; it is
    // an absence, not a vendor, and the account screen must not label it.
    aaguid: aaguidBytes.some((b) => b !== 0) ? toHex(aaguidBytes) : null,
    credentialId,
    publicKey: key.value,
    publicKeyBytes: new Uint8Array(bytes.slice(55 + idLength, key.next)),
  }
}

// ---------------------------------------------------------------------------
// COSE → JWK
// ---------------------------------------------------------------------------

/** JWK integers are unsigned big-endian with no leading zero, fixed-width where
 * the curve says so. Authenticators are not uniformly careful about either. */
function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let at = 0
  while (at < bytes.length - 1 && bytes[at] === 0) at++
  return bytes.subarray(at)
}

function fixedWidth(bytes: Uint8Array, width: number, label: string): Uint8Array {
  const trimmed = trimLeadingZeros(bytes)
  if (trimmed.length > width) fail('malformed', `webauthn: COSE ${label} is longer than ${width}`)
  if (trimmed.length === width) return trimmed
  const out = new Uint8Array(width)
  out.set(trimmed, width - trimmed.length)
  return out
}

function coseBytes(key: Map<unknown, unknown>, label: number, name: string): Uint8Array {
  const value = key.get(label)
  if (!(value instanceof Uint8Array)) {
    fail('malformed', `webauthn: COSE key has no ${name} byte string`)
  }
  return value
}

/**
 * The two key types `pubKeyCredParams` asks for, and nothing else.
 *
 * Ed25519 (`-8`) is in the WebAuthn registry and deliberately absent: it is not
 * in WebCrypto everywhere yet. `passkeys.alg` has no CHECK constraint precisely
 * so adding it later is a branch here and a `pubKeyCredParams` entry above,
 * with no table rebuild.
 */
export function coseToJwk(key: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = key.get(1)
  const alg = key.get(3)

  if (kty === 2) {
    if (alg !== ES256) fail('algorithm', `webauthn: EC2 key declares alg ${String(alg)}, not -7`)
    if (key.get(-1) !== 1) {
      fail('algorithm', `webauthn: EC2 key is on curve ${String(key.get(-1))}, not P-256`)
    }
    return {
      alg: ES256,
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: base64url(fixedWidth(coseBytes(key, -2, 'x'), 32, 'x')),
        y: base64url(fixedWidth(coseBytes(key, -3, 'y'), 32, 'y')),
        ext: true,
      },
    }
  }

  if (kty === 3) {
    if (alg !== RS256) fail('algorithm', `webauthn: RSA key declares alg ${String(alg)}, not -257`)
    return {
      alg: RS256,
      jwk: {
        kty: 'RSA',
        n: base64url(trimLeadingZeros(coseBytes(key, -1, 'n'))),
        e: base64url(trimLeadingZeros(coseBytes(key, -2, 'e'))),
        ext: true,
      },
    }
  }

  return fail('algorithm', `webauthn: unsupported COSE key type ${String(kty)}`)
}

// ---------------------------------------------------------------------------
// DER → raw
// ---------------------------------------------------------------------------

/**
 * `SEQUENCE { INTEGER r, INTEGER s }` → fixed-width `r || s`.
 *
 * An authenticator signs ECDSA and hands back DER; `crypto.subtle.verify` on a
 * P-256 key wants the raw pair. Both directions of padding matter and both are
 * pinned by the unit tests: DER INTEGER is *signed*, so a value whose top bit is
 * set carries a leading `0x00` that must come off, and a value shorter than the
 * curve must be left-padded back up to it.
 *
 * RS256 needs none of this — `RSASSA-PKCS1-v1_5` signatures are already the raw
 * form WebCrypto expects.
 */
export function derToRaw(sig: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  if (sig.length < 8 || sig[0] !== 0x30) {
    fail('signature', 'webauthn: ECDSA signature is not a DER sequence')
  }
  // Short form for anything under 128 bytes, which every P-256 signature is;
  // `0x81` (one length byte) is accepted so a larger curve would not silently
  // mis-parse if one is ever added.
  let at = sig[1] === 0x81 ? 3 : 2

  const readInt = (): Uint8Array => {
    if (sig[at] !== 0x02) fail('signature', 'webauthn: ECDSA signature member is not an INTEGER')
    const length = sig[at + 1] as number
    if (at + 2 + length > sig.length) fail('signature', 'webauthn: ECDSA signature is truncated')
    const value = sig.subarray(at + 2, at + 2 + length)
    at += 2 + length
    return value
  }

  const r = fixedWidth(readInt(), size, 'r')
  const s = fixedWidth(readInt(), size, 's')
  const out = new Uint8Array(new ArrayBuffer(size * 2))
  out.set(r, 0)
  out.set(s, size)
  return out
}

// ---------------------------------------------------------------------------
// The two ceremonies
// ---------------------------------------------------------------------------

interface ClientData {
  type?: unknown
  challenge?: unknown
  origin?: unknown
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function decodeBase64url(value: unknown, what: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0) {
    fail('malformed', `webauthn: ${what} is missing`)
  }
  try {
    return fromBase64url(value)
  } catch {
    return fail('malformed', `webauthn: ${what} is not base64url`)
  }
}

/**
 * `clientDataJSON`, checked against what this host minted.
 *
 * The origin comparison is exact and against the *request* origin (decision 5),
 * never a configured list: a passkey is bound to the host it was enrolled on,
 * and a scheme or port that does not match is a different host.
 */
function checkClientData(
  raw: Uint8Array,
  expected: { type: string; challenge: string; origin: string },
): void {
  let parsed: ClientData
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as ClientData
  } catch {
    fail('malformed', 'webauthn: clientDataJSON is not JSON')
  }
  if (parsed.type !== expected.type) {
    fail('type', `webauthn: clientDataJSON.type is '${String(parsed.type)}'`)
  }
  if (parsed.challenge !== expected.challenge) fail('challenge', 'webauthn: wrong challenge')
  if (parsed.origin !== expected.origin) {
    fail('origin', `webauthn: clientDataJSON.origin is '${String(parsed.origin)}'`)
  }
}

async function checkRpIdHash(authData: AuthData, rpId: string): Promise<void> {
  const expected = await sha256(new TextEncoder().encode(rpId))
  if (!sameBytes(authData.rpIdHash, expected)) {
    fail('rp_id', 'webauthn: authenticator data was signed for another relying party')
  }
}

/**
 * A registration response, verified. Answers what `createPasskey` stores.
 *
 * The credential id, the public key and the AAGUID all come from `authData` —
 * the half the authenticator signed over — rather than from the outer JSON,
 * which is whatever the page chose to send.
 */
export async function verifyRegistration(input: {
  credential: RegistrationResponseJSON
  expected: { challenge: string; origin: string; rpId: string }
}): Promise<RegisteredCredential> {
  const { credential, expected } = input
  if (credential.type !== 'public-key') {
    fail('type', `webauthn: credential.type is '${String(credential.type)}'`)
  }

  checkClientData(decodeBase64url(credential.response?.clientDataJSON, 'clientDataJSON'), {
    type: 'webauthn.create',
    challenge: expected.challenge,
    origin: expected.origin,
  })

  const attestation = decodeCbor(
    decodeBase64url(credential.response?.attestationObject, 'attestationObject'),
  )
  if (!(attestation instanceof Map)) {
    fail('malformed', 'webauthn: the attestation object is not a CBOR map')
  }
  const rawAuthData = attestation.get('authData')
  if (!(rawAuthData instanceof Uint8Array)) {
    fail('malformed', 'webauthn: the attestation object has no authData')
  }
  // `fmt` and `attStmt` are read for nothing. Deliberately: see the header.

  const authData = parseAuthData(rawAuthData)
  await checkRpIdHash(authData, expected.rpId)
  if (!authData.flags.up) fail('user_presence', 'webauthn: the user-present flag is clear')
  if (!authData.flags.uv) fail('user_verification', 'webauthn: the user-verified flag is clear')
  const { credentialId, publicKey, publicKeyBytes } = authData
  if (!authData.flags.at || !credentialId || !publicKey || !publicKeyBytes) {
    fail('attested_credential', 'webauthn: the registration carries no attested credential data')
  }

  const { jwk, alg } = coseToJwk(publicKey)
  // Imported here and thrown away: the point is to refuse now, at enrolment, a
  // key this runtime could never verify with — rather than at the person's first
  // sign-in, where the only message they get is the generic one.
  await importKey(jwk, alg)

  return {
    id: base64url(credentialId),
    publicKey: publicKeyBytes,
    alg,
    counter: authData.counter,
    transports: normaliseTransports(credential.response?.transports),
    aaguid: authData.aaguid,
    backedUp: authData.flags.bs,
  }
}

/** `getTransports()` is advisory and browser-shaped; anything that is not a
 * short string is dropped rather than stored for a later `allowCredentials`. */
function normaliseTransports(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out = value.filter(
    (t): t is string => typeof t === 'string' && t.length > 0 && t.length < 32,
  )
  return out.length > 0 ? out : null
}

/** `algorithmFor` is `jwt.ts`'s, so ES256 and RS256 mean here exactly what they
 * mean to the OIDC verifier — one table, not two that can drift. */
async function importKey(jwk: JsonWebKey, alg: number): Promise<CryptoKey> {
  const chosen = algorithmFor(alg === ES256 ? 'ES256' : 'RS256')
  if (!chosen) fail('algorithm', `webauthn: no WebCrypto algorithm for COSE alg ${alg}`)
  try {
    return await crypto.subtle.importKey('jwk', jwk, chosen.importAlg, false, ['verify'])
  } catch (err) {
    return fail('algorithm', `webauthn: WebCrypto refused the public key (${String(err)})`)
  }
}

/**
 * An assertion, verified against a stored credential.
 *
 * The signature is over `authenticatorData || sha256(clientDataJSON)` — the
 * concatenation, not either half — which is what binds the challenge, the origin
 * and the flags together into one thing the authenticator vouched for.
 */
export async function verifyAssertion(input: {
  credential: AuthenticationResponseJSON
  stored: { publicKey: Uint8Array; alg: number; counter: number; userId: string }
  expected: { challenge: string; origin: string; rpId: string }
}): Promise<{ counter: number; backedUp: boolean }> {
  const { credential, stored, expected } = input
  if (credential.type !== 'public-key') {
    fail('type', `webauthn: credential.type is '${String(credential.type)}'`)
  }

  const clientDataJSON = decodeBase64url(credential.response?.clientDataJSON, 'clientDataJSON')
  checkClientData(clientDataJSON, {
    type: 'webauthn.get',
    challenge: expected.challenge,
    origin: expected.origin,
  })

  const rawAuthData = decodeBase64url(credential.response?.authenticatorData, 'authenticatorData')
  const authData = parseAuthData(rawAuthData)
  await checkRpIdHash(authData, expected.rpId)
  if (!authData.flags.up) fail('user_presence', 'webauthn: the user-present flag is clear')
  if (!authData.flags.uv) fail('user_verification', 'webauthn: the user-verified flag is clear')

  // Some security keys omit `userHandle` for non-discoverable use, so its
  // absence is not a refusal: the credential-id lookup that produced `stored` is
  // the authority, and the key it named belongs to exactly one user. When it *is*
  // present it must agree, or the browser signed in as somebody else.
  const handle = credential.response?.userHandle
  if (typeof handle === 'string' && handle.length > 0) {
    if (handle !== base64url(new TextEncoder().encode(stored.userId))) {
      fail('user_handle', 'webauthn: the assertion names another user')
    }
  }

  const key = await importKey(coseToJwk(asCoseMap(stored.publicKey)).jwk, stored.alg)
  const signed = new Uint8Array(new ArrayBuffer(rawAuthData.length + 32))
  signed.set(rawAuthData, 0)
  signed.set(await sha256(clientDataJSON), rawAuthData.length)

  const rawSignature = decodeBase64url(credential.response?.signature, 'signature')
  const signature = stored.alg === ES256 ? derToRaw(rawSignature) : rawSignature
  const params: AlgorithmIdentifier | EcdsaParams =
    stored.alg === ES256 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
  if (!(await crypto.subtle.verify(params, key, signature, signed))) {
    fail('signature', 'webauthn: the assertion signature does not verify')
  }

  // **The counter rule.** A synced passkey (iCloud Keychain, Google Password
  // Manager) reports 0 forever, so 0 → 0 is not a regression and must not be
  // read as one; the check turns on the moment either side is non-zero. A
  // regression means two authenticators hold the same private key, which is the
  // one thing this counter exists to detect — and it is refused and logged,
  // never made to delete the credential: a clone is the person's to resolve.
  if ((stored.counter > 0 || authData.counter > 0) && authData.counter <= stored.counter) {
    fail(
      'counter',
      `webauthn: signature counter went backwards (${authData.counter} <= ${stored.counter})`,
    )
  }

  return { counter: authData.counter, backedUp: authData.flags.bs }
}

function asCoseMap(publicKey: Uint8Array): Map<unknown, unknown> {
  const decoded = decodeCbor(publicKey)
  if (!(decoded instanceof Map)) {
    fail('malformed', 'webauthn: the stored public key is not a COSE map')
  }
  return decoded
}
