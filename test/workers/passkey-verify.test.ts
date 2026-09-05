import { describe, expect, it } from 'vitest'
import {
  type CeremonyOverrides,
  createAuthenticator,
  encodeCbor,
  ES256,
  RS256,
  userHandleFor,
} from '../lib/synthetic-authenticator'
import {
  creationOptions,
  requestOptions,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type RegisteredCredential,
} from '../../src/server/auth/webauthn'

/**
 * **The gate for `docs/specs/foundation/passkeys.md` decision 3**, phase 1 step 4.
 *
 * In workerd rather than Node, and that is the whole point: the claim being
 * tested is that *this* runtime's WebCrypto verifies *these* signatures, so a
 * Node run would pin Node's crypto and prove nothing about the deployment.
 *
 * ## Read this before reading a green run as "verified"
 *
 * Two halves, and only one of them exists today.
 *
 * 1. **The logic**, below, against `test/lib/synthetic-authenticator.ts`. Every
 *    refusal in decision 3 is driven individually, ES256 and RS256 both round
 *    trip, and this half is genuinely green.
 * 2. **The parsing**, against real registration and assertion pairs captured by
 *    hand from Chrome and Safari into `test/fixtures/webauthn/`. **That
 *    directory holds no fixtures yet** — capturing them needs a browser and a
 *    device and nobody in an agent session can do it. The suite at the bottom
 *    iterates whatever is there and, when there is nothing, reports one test
 *    that says so and prints a warning. It does **not** pass silently.
 *
 * So: the synthetic authenticator proves the logic; the fixtures prove the
 * parsing against authenticators that pad, omit `userHandle`, send `packed`, or
 * report counter 0. The second half is unproven until this directory is filled.
 */

const RP_ID = 'folio.example'
const ORIGIN = 'https://folio.example'
const USER = { id: 'usr_000000000001', name: 'ann@example.com', displayName: 'Ann' }

const challengeBytes = () => crypto.getRandomValues(new Uint8Array(32))

/** The two options builders are what the routes will hand a browser, so the
 * ceremonies below are driven through them rather than through hand-written
 * option objects: an options bug is then a test failure here, not in phase 2. */
const createOptions = (challenge = challengeBytes()) =>
  creationOptions({ rpId: RP_ID, rpName: 'Folio', challenge, user: USER, exclude: [] })

const getOptions = (challenge = challengeBytes()) => requestOptions({ rpId: RP_ID, challenge })

/** Enrol once, and answer everything a later assertion is verified against. */
async function enrol(alg: number) {
  const authenticator = await createAuthenticator({ alg })
  const options = createOptions()
  const credential = await authenticator.create(options, { origin: ORIGIN })
  const registered = await verifyRegistration({
    credential,
    expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
  })
  return { authenticator, registered, options }
}

const storedFrom = (registered: RegisteredCredential, counter = registered.counter) => ({
  publicKey: registered.publicKey,
  alg: registered.alg,
  counter,
  userId: USER.id,
})

/** Every refusal below asserts the *code*, not the message: the code is what
 * phase 2's route switches on to tell a cloned authenticator from a bad
 * signature, and it is the only difference between two refusals a person is told
 * nothing about. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    if (err instanceof WebAuthnError) return err.code
    throw err
  }
  throw new Error('expected the ceremony to be refused, and it was accepted')
}

describe('registration and assertion round trip', () => {
  it('enrols and signs in with an ES256 credential', async () => {
    const { authenticator, registered } = await enrol(ES256)
    expect(registered.alg).toBe(ES256)
    expect(registered.id).toBe(authenticator.credentialId)
    expect(registered.counter).toBe(0)
    expect(registered.backedUp).toBe(false)
    expect(registered.transports).toEqual(['internal', 'hybrid'])
    // All-zero under `fmt: none` is an absence, not a vendor, and the account
    // screen must not label it.
    expect(registered.aaguid).toBeNull()

    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      userHandle: userHandleFor(USER.id),
    })
    const result = await verifyAssertion({
      credential: assertion,
      stored: storedFrom(registered),
      expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
    })
    expect(result).toEqual({ counter: 0, backedUp: false })
  })

  it('enrols and signs in with an RS256 credential', async () => {
    const { authenticator, registered } = await enrol(RS256)
    expect(registered.alg).toBe(RS256)

    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      counter: 7,
      userHandle: userHandleFor(USER.id),
    })
    // RS256 needs no DER conversion — `RSASSA-PKCS1-v1_5` signatures are already
    // the raw form WebCrypto expects, which is the branch this covers.
    expect(
      await verifyAssertion({
        credential: assertion,
        stored: storedFrom(registered),
        expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
      }),
    ).toEqual({ counter: 7, backedUp: false })
  })

  it('carries a synced credential’s backup state through both ceremonies', async () => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const created = createOptions()
    const registered = await verifyRegistration({
      credential: await authenticator.create(created, { origin: ORIGIN, backedUp: true }),
      expected: { challenge: created.challenge, origin: ORIGIN, rpId: RP_ID },
    })
    // The BS flag is what the account screen badges as "synced", and it is also
    // the explanation for a counter that stays at 0 forever.
    expect(registered.backedUp).toBe(true)

    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN, backedUp: true })
    expect(
      (
        await verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        })
      ).backedUp,
    ).toBe(true)
  })

  it('reports a non-zero AAGUID as 32 hex characters', async () => {
    const aaguid = new Uint8Array(16).fill(0xab)
    const authenticator = await createAuthenticator({ alg: ES256, aaguid })
    const options = createOptions()
    const registered = await verifyRegistration({
      credential: await authenticator.create(options, { origin: ORIGIN }),
      expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
    })
    expect(registered.aaguid).toBe('ab'.repeat(16))
  })
})

/**
 * Decision 3's registration checks, one `it` per refusal.
 *
 * The route above these answers one generic message for the lot; these are the
 * only place the difference between them is visible at all.
 */
describe('registration refuses', () => {
  const enrolWith = async (over: CeremonyOverrides) => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = createOptions()
    const credential = await authenticator.create(options, over)
    return refusal(() =>
      verifyRegistration({
        credential,
        expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
      }),
    )
  }

  it('a challenge that does not match the one this host minted', async () => {
    expect(await enrolWith({ origin: ORIGIN, challenge: 'c29tZXRoaW5nLWVsc2U' })).toBe('challenge')
  })

  it('an origin of another host', async () => {
    expect(await enrolWith({ origin: 'https://evil.example' })).toBe('origin')
  })

  it('an rpIdHash for another relying party', async () => {
    expect(await enrolWith({ origin: ORIGIN, rpId: 'evil.example' })).toBe('rp_id')
  })

  it('a cleared user-verified flag — checkpoint 2, checked and not merely asked for', async () => {
    expect(await enrolWith({ origin: ORIGIN, uv: false })).toBe('user_verification')
  })

  it('a cleared user-present flag', async () => {
    expect(await enrolWith({ origin: ORIGIN, up: false })).toBe('user_presence')
  })

  it('a clientDataJSON.type from the other ceremony', async () => {
    expect(await enrolWith({ origin: ORIGIN, type: 'webauthn.get' })).toBe('type')
  })

  it('a credential.type that is not public-key', async () => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = createOptions()
    const credential = await authenticator.create(options, { origin: ORIGIN })
    expect(
      await refusal(() =>
        verifyRegistration({
          credential: { ...credential, type: 'password' },
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('type')
  })

  it('an attestationObject that does not decode', async () => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = createOptions()
    const credential = await authenticator.create(options, { origin: ORIGIN })
    expect(
      await refusal(() =>
        verifyRegistration({
          credential: {
            ...credential,
            response: { ...credential.response, attestationObject: 'bm90LWNib3I' },
          },
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('malformed')
  })

  it('an unsupported algorithm — Ed25519 is in the registry and out of scope', async () => {
    // A COSE key claiming OKP/-8. `pubKeyCredParams` never asks for it, so an
    // authenticator answering one is either broken or lying; either way there is
    // no `coseToJwk` branch and there deliberately is no CHECK on `passkeys.alg`
    // so adding one later is a code change only.
    const key = new Map<number, unknown>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, new Uint8Array(32).fill(3)],
    ])
    expect(await refusalForKey(key)).toBe('algorithm')
  })

  it('an EC2 key on a curve that is not P-256', async () => {
    const key = new Map<number, unknown>([
      [1, 2],
      [3, ES256],
      [-1, 2],
      [-2, new Uint8Array(32).fill(1)],
      [-3, new Uint8Array(32).fill(2)],
    ])
    expect(await refusalForKey(key)).toBe('algorithm')
  })
})

/**
 * A registration whose attested credential data carries `key` instead of a real
 * COSE key. Hand-assembled rather than driven through the authenticator, because
 * the authenticator will only ever emit a key it can sign with.
 */
async function refusalForKey(key: Map<number, unknown>): Promise<string> {
  const options = createOptions()
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
  )
  const credentialId = new Uint8Array(32).fill(9)
  const keyBytes = encodeCbor(key)
  const authData = new Uint8Array(37 + 16 + 2 + credentialId.length + keyBytes.length)
  authData.set(rpIdHash, 0)
  // UP | UV | AT. The four counter bytes at 33..37 and the AAGUID at 37..53 stay
  // zero, which is exactly what a platform authenticator emits under `none`.
  authData[32] = 0x01 | 0x04 | 0x40
  authData[53] = (credentialId.length >> 8) & 0xff
  authData[54] = credentialId.length & 0xff
  authData.set(credentialId, 55)
  authData.set(keyBytes, 55 + credentialId.length)

  const attestationObject = encodeCbor(
    new Map<unknown, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  )
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN }),
  )
  const b64 = (bytes: Uint8Array) => {
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return refusal(() =>
    verifyRegistration({
      credential: {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64(clientDataJSON),
          attestationObject: b64(attestationObject),
        },
      },
      expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
    }),
  )
}

/**
 * **Attestation is never evaluated** (decision 3). An authenticator that answers
 * `fmt: 'packed'` despite `attestation: 'none'` — Windows Hello does — is
 * accepted with its statement ignored, provided `authData` parses. Refusing it
 * would lock those users out for a check this spec does not perform.
 */
describe('attestation is requested as none and never evaluated', () => {
  it('accepts fmt: packed with a populated statement', async () => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = createOptions()
    const credential = await authenticator.create(options, {
      origin: ORIGIN,
      fmt: 'packed',
      attStmt: new Map<unknown, unknown>([
        ['alg', ES256],
        ['sig', new Uint8Array(70).fill(0x5a)],
        ['x5c', [new Uint8Array(120).fill(0x30)]],
      ]),
    })
    const registered = await verifyRegistration({
      credential,
      expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
    })
    // Accepted, and the statement contributed nothing: the key is the one from
    // `authData`, which is the half the authenticator signed over.
    expect(registered.id).toBe(authenticator.credentialId)
    expect(registered.alg).toBe(ES256)
  })

  it('accepts an unrecognised fmt with an empty statement', async () => {
    const authenticator = await createAuthenticator({ alg: ES256 })
    const options = createOptions()
    const registered = await verifyRegistration({
      credential: await authenticator.create(options, { origin: ORIGIN, fmt: 'tpm' }),
      expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
    })
    expect(registered.alg).toBe(ES256)
  })
})

describe('assertion refuses', () => {
  it('a challenge the signature covers but this host did not mint', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      challenge: 'YW5vdGhlci1jaGFsbGVuZ2U',
    })
    // The signature is valid over what the browser signed; the challenge is the
    // thing that does not match, which is exactly the replay this check stops.
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('challenge')
  })

  it('an origin of another host', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: 'https://evil.example' })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('origin')
  })

  it('an rpIdHash for another host — the "enrolled on localhost" case', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN, rpId: 'localhost' })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('rp_id')
  })

  it('a valid signature with the UV flag clear', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN, uv: false })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('user_verification')
  })

  it('a valid signature with the UP flag clear', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN, up: false })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('user_presence')
  })

  it('a clientDataJSON.type from the other ceremony', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      type: 'webauthn.create',
    })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('type')
  })

  it('a signature that does not verify', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      corruptSignature: true,
    })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('signature')
  })

  it('a signature made by another credential’s key', async () => {
    const { registered } = await enrol(ES256)
    const other = await createAuthenticator({ alg: ES256 })
    const options = getOptions()
    const assertion = await other.get(options, { origin: ORIGIN })
    // The route looks a credential up by id and verifies against *that* row's
    // key, so this is what a substituted assertion looks like from here.
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('signature')
  })

  it('a userHandle naming another user', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, {
      origin: ORIGIN,
      userHandle: userHandleFor('usr_somebody_else'),
    })
    expect(
      await refusal(() =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
      ),
    ).toBe('user_handle')
  })
})

/**
 * The counter rule, stated exactly: refuse when `stored.counter > 0 || new > 0`
 * and `new <= stored.counter`.
 *
 * The `0 → 0` row is the one that matters most and is the easiest to get wrong:
 * every synced passkey reports 0 forever, so a naive `new <= stored` would
 * refuse every iCloud Keychain sign-in after the first.
 */
describe('the signature counter', () => {
  const assertWithCounter = async (storedCounter: number, newCounter: number) => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN, counter: newCounter })
    return {
      run: () =>
        verifyAssertion({
          credential: assertion,
          stored: storedFrom(registered, storedCounter),
          expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
        }),
    }
  }

  it('accepts 0 → 0, because a synced passkey reports 0 forever', async () => {
    const { run } = await assertWithCounter(0, 0)
    expect((await run()).counter).toBe(0)
  })

  it('accepts an increment', async () => {
    const { run } = await assertWithCounter(4, 5)
    expect((await run()).counter).toBe(5)
  })

  it('refuses a repeat once the stored counter is non-zero', async () => {
    const { run } = await assertWithCounter(5, 5)
    expect(await refusal(run)).toBe('counter')
  })

  it('refuses a decrement', async () => {
    const { run } = await assertWithCounter(9, 3)
    expect(await refusal(run)).toBe('counter')
  })

  it('refuses a new counter of 0 against a stored non-zero one', async () => {
    const { run } = await assertWithCounter(2, 0)
    expect(await refusal(run)).toBe('counter')
  })

  it('accepts a first non-zero counter against a stored 0', async () => {
    const { run } = await assertWithCounter(0, 1)
    expect((await run()).counter).toBe(1)
  })
})

/**
 * `userHandle` is optional, deliberately.
 *
 * Some security keys omit it for non-discoverable use. The credential-id lookup
 * that produced `stored` is the authority — the key it named belongs to exactly
 * one user — so an absent handle skips the cross-check rather than refusing.
 */
describe('an assertion with no userHandle', () => {
  it('is accepted, because the credential id already named the account', async () => {
    const { authenticator, registered } = await enrol(ES256)
    const options = getOptions()
    const assertion = await authenticator.get(options, { origin: ORIGIN })
    expect('userHandle' in assertion.response).toBe(false)
    expect(
      await verifyAssertion({
        credential: assertion,
        stored: storedFrom(registered),
        expected: { challenge: options.challenge, origin: ORIGIN, rpId: RP_ID },
      }),
    ).toEqual({ counter: 0, backedUp: false })
  })
})

// ---------------------------------------------------------------------------
// The real-device half
// ---------------------------------------------------------------------------

interface Fixture {
  label?: string
  rpId: string
  origin: string
  userId: string
  registration: { challenge: string; credential: unknown }
  assertion?: { challenge: string; storedCounter?: number; credential: unknown }
}

/**
 * Whatever `test/fixtures/webauthn/` holds. `import.meta.glob` is eager, so an
 * empty directory is an empty object at build time rather than a runtime read —
 * the same mechanism `apply-schema.ts` uses for the migrations.
 */
const fixtures = import.meta.glob('../fixtures/webauthn/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Fixture>

const GAP =
  'test/fixtures/webauthn/ holds no real-device fixtures: the verifier is proven ' +
  'against the synthetic authenticator only. Nothing here shows that Folio parses ' +
  'what Chrome and Safari actually send — padding, an omitted userHandle, ' +
  "fmt: 'packed', a zeroed AAGUID, a counter that stays at 0. See that " +
  "directory's README.md for how to capture a pair; it needs a browser and a device."

describe('real-device fixtures', () => {
  const entries = Object.entries(fixtures)

  if (entries.length === 0) {
    // **Not a skip and not a silent pass.** A `.skip` reads as "someone turned
    // this off"; a bare pass reads as "verified against real devices", which is
    // the false conclusion this whole block exists to prevent.
    //
    // Three signals, because no one of them survives every way this suite is
    // read:
    //
    //  - a **todo**, which the default reporter counts in its summary line even
    //    when the run is piped to a file (`Tests  N passed | 1 todo`). This is
    //    the only one that shows up in a plain `pnpm test` whose output nobody
    //    scrolls, and it is why the count differs from the run before this
    //    phase by one;
    //  - a **passing test whose name is the gap**, for a verbose or TTY run;
    //  - a **`console.warn`** naming the directory and what is missing, which
    //    vitest prints on a TTY and whenever anything in the file fails.
    //
    // All three disappear on their own the moment a fixture lands here.
    it.todo(
      'capture Chrome and Safari pairs into test/fixtures/webauthn/ — until then the ' +
        'verifier is unproven against real authenticators (see that README)',
    )

    it('are absent — the parsing half of decision 3 is UNPROVEN (see the warning)', () => {
      console.warn(`\n⚠ folio: ${GAP}\n`)
      expect(entries).toEqual([])
    })
  }

  for (const [path, fixture] of entries) {
    const name = fixture.label ?? path.split('/').at(-1) ?? path

    it(`verifies the registration captured from ${name}`, async () => {
      const registered = await verifyRegistration({
        // Cast at the boundary: a fixture is JSON somebody pasted, and the
        // verifier's job is to refuse the ones that are wrong.
        credential: fixture.registration.credential as never,
        expected: {
          challenge: fixture.registration.challenge,
          origin: fixture.origin,
          rpId: fixture.rpId,
        },
      })
      expect(registered.id).toBeTruthy()
      expect([ES256, RS256]).toContain(registered.alg)
      expect(registered.publicKey.length).toBeGreaterThan(0)
    })

    const assertion = fixture.assertion
    if (!assertion) continue

    it(`verifies the assertion captured from ${name}`, async () => {
      const registered = await verifyRegistration({
        credential: fixture.registration.credential as never,
        expected: {
          challenge: fixture.registration.challenge,
          origin: fixture.origin,
          rpId: fixture.rpId,
        },
      })
      const result = await verifyAssertion({
        credential: assertion.credential as never,
        stored: {
          publicKey: registered.publicKey,
          alg: registered.alg,
          counter: assertion.storedCounter ?? 0,
          userId: fixture.userId,
        },
        expected: {
          challenge: assertion.challenge,
          origin: fixture.origin,
          rpId: fixture.rpId,
        },
      })
      expect(typeof result.counter).toBe('number')
    })
  }
})
