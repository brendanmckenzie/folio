# Real-device WebAuthn fixtures

**This directory is empty of fixtures, and that is the open half of phase 1.**

`test/workers/passkey-verify.test.ts` proves the verifier's *logic* against
`test/lib/synthetic-authenticator.ts`. It cannot prove the verifier's *parsing*,
because the synthetic authenticator encodes CBOR the way `webauthn.ts` decodes
it and pads the way `webauthn.ts` unpads. The two halves agree with each other by
construction, which is exactly the agreement a real device does not owe us.

What only a real device can show:

- an AAGUID that is **not** sixteen zero bytes (a security key), and one that is
  (a platform authenticator under `attestation: 'none'`)
- `fmt: 'packed'` with a populated `attStmt` despite the options asking for
  `none` — Windows Hello does this, and decision 3 requires it be **accepted**
  with the statement ignored
- an assertion with **no `userHandle`** at all, which some security keys omit for
  non-discoverable use
- an ECDSA signature whose `r` or `s` is short, or carries the DER leading zero,
  so `derToRaw`'s padding is exercised in both directions by something that did
  not choose the padding to suit us
- a synced passkey reporting **counter 0** on every assertion forever (iCloud
  Keychain, Google Password Manager), against a security key whose counter
  actually increments

Until a pair is captured, `passkey-verify.test.ts` prints a warning naming this
gap on every run and its fixture suite reports a single test that says so. **A
green suite is not evidence that Folio parses what Chrome and Safari send.**

## Capturing a pair

Needs a browser and a device, and cannot be done by an agent. Phase 3 lands the
login script that produces the `console.log` this is captured from; until then,
capture it from the account screen's enrolment dialog or from a scratch page
against a local `wrangler dev`.

1. `pnpm --filter demo db:local && pnpm --filter demo db:seed`, then `pnpm dev`
   (the demo serves on **5199**). Sign in as `demo@example.com` — see the repo
   root `CLAUDE.md`, "Local login". `http://localhost` is a secure context for
   WebAuthn, so no TLS is needed.
2. `POST /folio/api/me/passkeys/options` and keep the response. **Record the
   `challenge` it answered**: it is in the response body's `publicKey.challenge`
   and nowhere else afterwards, because the server holds it only in a cookie the
   verify route clears.
3. Run `navigator.credentials.create({ publicKey })` and serialise the result by
   hand — `id`, `rawId`, `type`, and `response.{ clientDataJSON,
   attestationObject, transports }`, each `ArrayBuffer` as base64url. Do **not**
   use `PublicKeyCredential.toJSON()`: it is not on every browser this has to
   cover, and the point is to capture what the hand-written path produces.
4. Repeat for the assertion: `POST /folio/login/passkey/options`, record that
   challenge, run `navigator.credentials.get({ publicKey })`, serialise `id`,
   `rawId`, `type`, `response.{ clientDataJSON, authenticatorData, signature,
   userHandle }`.
5. Write both into one file here, named for the device
   (`chrome-macos-platform.json`, `chrome-security-key.json`,
   `safari-icloud-keychain.json`).

Repeat on: **Chrome** with the platform authenticator, **Chrome** with a physical
security key, and **Safari** with iCloud Keychain. Three files is the set the
spec's checkpoint 1 names.

## The file format

Every field the verifier needs at both ceremonies, beside the responses, because
none of it can be recovered from them afterwards.

```json
{
  "label": "Chrome 141 / macOS 26 platform authenticator",
  "captured": "2026-09-05",
  "rpId": "localhost",
  "origin": "http://localhost:5199",
  "userId": "usr_0a1b2c3d4e5f",
  "registration": {
    "challenge": "<base64url, exactly as publicKey.challenge was sent>",
    "credential": {
      "id": "…",
      "rawId": "…",
      "type": "public-key",
      "response": {
        "clientDataJSON": "…",
        "attestationObject": "…",
        "transports": ["internal", "hybrid"]
      }
    }
  },
  "assertion": {
    "challenge": "<base64url, the second ceremony's own>",
    "storedCounter": 0,
    "credential": {
      "id": "…",
      "rawId": "…",
      "type": "public-key",
      "response": {
        "clientDataJSON": "…",
        "authenticatorData": "…",
        "signature": "…",
        "userHandle": "…"
      }
    }
  }
}
```

- **`rpId` / `origin`** are the request host and origin the browser saw. They are
  not configuration (decision 5), so a fixture captured on `localhost:5199`
  verifies only against `"http://localhost:5199"`.
- **`userId`** is the `users.id` whose base64url the browser echoes as
  `userHandle`. Needed even when `userHandle` is absent: the verifier is handed
  it as `stored.userId` either way.
- **`storedCounter`** is what `passkeys.counter` held *before* this assertion —
  `0` for a freshly enrolled credential. The test feeds it in so the counter rule
  is exercised against a real device's numbering.
- **`assertion.credential.response.userHandle`** — omit the key entirely if the
  authenticator omitted it. `null` and absent both read as absent; a real
  omission is the interesting case, so prefer leaving the key out.

## These contain no secret

Worth saying plainly, because "captured WebAuthn responses" reads like a
credential dump and is the opposite of one.

A registration response carries the authenticator's **public** key. An assertion
carries a signature over a challenge that was consumed the moment it was used —
the challenge cookie is single-use and cleared by the response that reads it, so
replaying a fixture against a live deployment gets a generic 401. Nothing here
signs anything new: the private key never left the device and was never sent.

The one judgement call is the *account*: capture against a throwaway seeded
account (`demo@example.com` from `examples/demo/seed.sql`), not a real one, so
the `userId` and the email inside `clientDataJSON` are demo data. Nothing else in
these files identifies a person. They are checked in on purpose — a fixture that
lives on somebody's laptop is a fixture the gate cannot run.
