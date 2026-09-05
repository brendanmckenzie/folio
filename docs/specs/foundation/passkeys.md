# Feature: Passkeys — one gesture to sign in, enrolled by somebody who already has

> **Group:** foundation
> **Build order:** 29
> **Size:** M–L
> **Status:** done
> **Wire version:** none
> **Migration:** `0007_passkeys.sql` — **landed** (phase 1, 2026-09-05). The body
> claimed `0006`; on the decided order 30 took `0005` and 28 took `0006`, so this
> took the next free number and every mention below was restamped with it.
> Spec 32 takes `0008` and spec 23 `0009`, behind all of them.
> **Build sequence:** 4 of 4 — 31 → 30 → 28 → 29 (owner, 2026-09-05). The **Build order** above is this spec's identity, not its place in the queue.
> **Last updated:** 2026-09-05

## Summary

Signing in to Folio today means a round trip through a mailbox or an identity
provider, every time, on every device. A passkey replaces that with one gesture
— a fingerprint, a face, a PIN — against a credential the browser keeps, and the
browser can offer it from the email field's own autofill before the person has
typed anything. `docs/specs/foundation/identity-and-access.md:602` rejected
passkeys ("a password store is a liability nobody asked for"); the owner has
asked, and a passkey is not a password store — nothing secret is stored, only a
public key. `src/server/pages.tsx:329-387` is the file that proves the gap: the
login page renders a mail form and a button per redirect provider, and there is
no third thing it could render.

This spec adds a `passkeys` table, a WebAuthn verifier written against WebCrypto
(attestation is requested as `none` and never evaluated), a `passkeys()` provider
kind that is opt-in per deployment, six routes, and a **Your account** screen where
a signed-in person enrols, names and removes their passkeys and sees their open
sessions. The login page keeps working with JavaScript disabled: the passkey
button and the autofill hook are one inline script's progressive enhancement over
the same form that posts today, which is decision 7 of spec 10 kept in spirit
rather than to the letter.

## Ground truth

**Assumed from spec 28 (`foundation/auth-providers.md`), phases 1–2.** This spec
is written against that spec's post-phase-2 tree and does not restate its work:

- `AuthProvider` is a discriminated union on `kind` — `'mail' | 'redirect' |
  'trusted' | 'passkey'` — and `resolveAuth` validates per kind and exposes
  `passkey: PasskeyProvider | null` on `ResolvedAuth`. The `passkey` arm's shape is
  declared there and constructed only here.
- `completeSignIn(db, auth, provider, identity, ctx)` in `src/server/auth/sign-in.ts`
  is the one path from a `VerifiedIdentity` to a session row and cookie. It applies
  enforced-domain rules, stamps `sessions.provider` and `users.provider`, and writes
  the `auth_events` row. A passkey sign-in calls it and nothing else.
- `sessions.provider` exists (`0006_auth.sql` — spec 28 claimed `0005` and landed
  as `0006`), which is what makes the account
  screen's sessions list able to say "signed in with a passkey".
- `src/server/auth/jwt.ts` holds `fromBase64url` and `algorithmFor`, extracted from
  `oidc.ts` (today at `src/server/auth/oidc.ts:100-145`). The verifier here reuses
  them rather than owning a second base64url decoder.
- `GET {base}/api/me/events` exists and answers the caller's own recent auth events.

If spec 28 lands in a different shape, the sections below that name these are the
ones to re-read: decision 1, decision 3's `completeSignIn` call, and the account
screen's sessions section.

**core (`src/core/`):**

- Nothing in `core/` changes. A passkey is a server-side credential; no `Doc`,
  `Field`, `Mutation` or `Resolution` type is touched, and `PROTOCOL_VERSION`
  stays where spec 16 left it.

**server (`src/server/`):**

- `auth/config.ts:34-55` — today's `AuthProvider`, a bag of optional functions
  switched on `redirect: boolean`. Its header comment says "the shape is open so a
  host can add its own without Folio growing a branch for it" — and a passkey needs
  a branch that is neither `send` nor `start`/`callback`, which is why spec 28's
  union precedes this spec rather than this spec adding a sixth optional function.
- `auth/config.ts:160-248` — `AuthPolicyProvider` and `authPolicy()`: the
  projection `GET {base}/api/me` hands the Settings screen, named field by field
  "so the day somebody writes `{ id, label, redirect, start, clientSecret }` the
  secret does not ship". Spec 28 turns `redirect: boolean` into `kind`; this spec
  adds nothing to the projection because a passkey provider has no secret and no
  provisioning to describe.
- `auth/cookie.ts:13-48` — four cookie families, each a `__Host-` name and a plain
  one: session (`:13,17`), OIDC state (`:20-21`), share (`:32-33`), draft (`:47-48`).
  `serialiseCookie` (`:190-201`) writes `Path=/; HttpOnly; SameSite=Lax`, `Secure`
  only on HTTPS. `clearCookies` (`:209-213`) expires **both** names. The OIDC state
  cookie is the precedent for "a short-lived value only this host set, unreadable
  to script, consumed by the response that reads it" — the exact property a
  WebAuthn challenge needs.
- `auth/session.ts:40-59` — `createSession` mints 32 bytes, stores the SHA-256,
  batches `touchUserStatement`. `readSession` (`:85-139`) is one join, hard-codes
  `provider: null` on the `UserRow` it builds (`:126`) — spec 28 fixes that; this
  spec's sessions list reads the column spec 28 adds.
- `auth/secrets.ts` — `mintSecret()` (32 bytes → 64 hex), `hashToken()`, `mintId()`.
  A WebAuthn challenge is 32 random bytes too, so `mintSecret()` is reused as-is.
- `auth/users.ts:187-196` — `deleteUser` batches `delete from sessions where
  user_id = ?` with the user row's delete **explicitly**, rather than resting on
  the `on delete cascade` that `sessions.user_id` declares. The comment there gives
  the reason (whether D1 enforces foreign keys is a property of the database); the
  new table follows it.
- `routes/auth.ts:97-110` — the `signIn` closure: one place mints the cookie "so
  the name rule and the attributes cannot differ between the magic-link and the
  OIDC paths". Spec 28 folds it into `completeSignIn`; the passkey route is a third
  caller of the same thing.
- `routes/auth.ts:112-137` — `GET /login` renders `loginPage`. `:318-331` —
  `POST /api/logout` revokes and clears both cookie names. `:350-380` — `GET /api/me`
  answers `{ mode, actor, loginUrl, policy }` with the actor redacted.
- `routes/access.ts:58-61` — every `/users*` and `/tokens*` route is behind
  `requireAuthConfigured` + `requireAccess(ADMIN)`. `:63-76` — `GET /users` answers
  `{ users, cursor, total }` through `toJson`; `:152` — `DELETE /users/:id`.
- `middleware.ts:187-192` — `requireAuthConfigured` 404s a surface that only means
  something with real accounts. Every route in this spec sits behind it.
- `pages.tsx:305-387` — `loginPage`. The doc comment at `:316` cites decision 7:
  "deliberately ships **no JavaScript**". The email input carries
  `autoComplete="email"` (`:361`); the trailing `[]` at `:382` is the empty client
  entry list ("No client entry: that is the point"). Styling is the inline
  `LOGIN_STYLE` literal (`:284`) injected with a `biome-ignore` comment (`:340-341`);
  `.folio-login__notice--bad` (`:301`) is the red banner an error renders in.
- `app.ts:195` — `authRoutes` mounts at the bare `{base}` **before** everything
  else so `/login/verify` is not read as `/login/:provider`. `/login/passkey/*`
  gets the same treatment for the same reason. `:122-123` — `sessionRoutes` and
  `accessRoutes` mount at `/api`.

**admin (`src/admin/`):**

- `me.ts:28-58` — `Me { mode, actor, loginUrl, policy? }`. `policy` is "the answer to
  what is this site configured as, which is a different question from what may I
  do". This spec adds `passkeys?` beside it, with the same reading.
- `ui/route.ts:22-36` — the closed `Screen` union; `:55-64` — `FLAT`, the
  single-segment screens; `:200-210` — `TITLES`. Adding a screen is those three
  edits plus a `case` in `Prototype.tsx`'s `screenFor` and a component.
  `ui-route.test.ts` pins parse and round-trip for each.
- `ui/Prototype.tsx:313-327` — the user menu, now one item (Sign out); its comment
  says the kitchen sink "used to be here too". `ui/TopBar.tsx:70-74` renders it
  through `Menu` when there is an actor, "Not signed in" otherwise.
- `ui/Dialog.tsx` — the one dialog, on `useFocusTrap` (`hooks/useFocusTrap.ts`),
  portalled to `document.body` with `scoped()`. Its comment forbids `autoFocus`
  inside. Every admin dialog uses it; the passkey enrolment dialog is one more.
- `ui/screens/Access.tsx:263-273` — the "Signs in with" column reads
  `user.provider`; blank "is not an error: an invited account has no provider
  until the first" sign-in. `access-model.ts:46` — `provider: string | null` on the
  row type. This spec adds a `passkeys` count column beside it and a row action.
- `ui/screens/settings-model.ts:557-567` — `providerRows(policy)` renders one row
  per provider with a `flow` string derived from `redirect` (spec 28 → `kind`); a
  passkey provider needs a third `flow` text.
- `docs/ui-architecture.md:467` — decision 6, "Settings mirrors code and cannot
  edit it". The reason enrolment cannot live on Settings.

**tests:**

- `test/workers/wrangler.jsonc:11-12` — `compatibility_date: "2026-07-27"`,
  `compatibility_flags: ["nodejs_compat"]`. WebCrypto is available in workerd
  regardless; nothing here needs the Node shim.
- `test/workers/migrations.test.ts:407-478` — asserts the exact column lists and
  index names of `users`, `sessions`, `login_challenges`, `api_tokens`. The new
  table gets the same treatment, including its own asserted *absences*.
- `test/workers/auth-login.test.ts` — `GET /login` "ships no bundle" is pinned
  there; the assertion must change shape (below), not vanish.
- `scripts/auth-test.mjs:63` — `check('and ships no JavaScript at all',
  !loginHtml.includes('<script'))`. Becomes two checks (decision 4).
- `test/unit/admin/api.test.ts`, `me.test.ts`, `ui-route.test.ts`, `ui-nav.test.ts`
  — the admin's pure-function suites, Node-only, mount nothing.
- There is no `test/fixtures/` directory and no `test/lib/` today. Both are
  introduced here.

## Owner decision checkpoints

1. **Hand-rolled WebAuthn verification over `@simplewebauthn/server`
   (recommended).** The verifier is ~400 lines of pure WebCrypto: a CBOR decoder
   for the subset an attestation object uses, `authData` parsing, COSE-to-JWK for
   ES256 and RS256, DER-to-raw for ECDSA, and `crypto.subtle.verify`. The repo has
   no auth dependency and `oidc.ts` already verifies JWS this way. The library is
   "periodically tested but unofficially supported" on Workers, had an ESM/CJS
   history that bit bundlers, and pulls ASN.1 and x509 code whose only job is
   attestation formats this spec never evaluates. **The gate:**
   `test/workers/passkey-verify.test.ts` runs registration and assertion through the
   verifier inside workerd against a synthetic authenticator *and* against
   real-device fixtures captured once from Chrome and Safari into
   `test/fixtures/webauthn/`. If the real-device fixtures cannot be made to pass,
   the **fallback** is `@simplewebauthn/server`, gated by
   `test/workers/webauthn-lib-smoke.test.ts` importing `verifyRegistrationResponse`
   inside workerd against the same fixtures. Write the first; name both in the
   phase plan so the switch is a phase, not a rewrite.
2. **User verification `required` at both ceremonies (recommended).** A passkey is
   the *only* factor in this sign-in — there is no password beside it — so the
   local PIN or biometric is what makes it two factors by construction. Cost: a
   bare security key with no PIN cannot enrol. The alternative, `preferred`, admits
   touch-only keys as single-factor possession, which is weaker than a magic link
   (which at least proves the inbox).
3. **Passkeys are a provider kind, `passkeys()`, opt-in (recommended).** Argued in
   decision 1. Alternative: always-on for every session-mode deployment.
4. **Admins get a passkey count per user and a "remove all passkeys" action on the
   Access screen; no per-passkey admin management and no "require passkeys"
   policy (recommended).** One route, one column, one menu item. The use case is a
   lost or compromised device, and magic link or SSO remains the way back in.
5. **"Your account" is a screen at `{base}/account`, reached from the user menu,
   holding passkeys, sessions and recent sign-ins (recommended)** over a section on
   Settings, which `ui-architecture.md` decision 6 defines as read-only config.

## User stories

### An editor signs in with one gesture
**As** an editor **I want to** sign in with my fingerprint or face **so that** I do
not wait for an email on every device I use.

### The email field offers the passkey before I type
**As** an editor **I want** the browser to offer my passkey from the email field's
autofill **so that** signing in is the same gesture on every site that supports it.

### An editor enrols and names a passkey from their account
**As** a signed-in editor **I want to** add a passkey for this laptop and call it
"Work laptop" **so that** I can recognise and remove it later.

### An editor sees their open sessions and signs the others out
**As** an editor **I want to** see every browser I am signed in on and sign out the
ones that are not this one **so that** a device I lent or lost is not still me.

### An admin revokes a lost device
**As** an admin **I want to** remove all of a person's passkeys **so that** a stolen
laptop cannot sign in as them, while they can still get back in by magic link.

### A deployment that does not want passkeys never sees them
**As** a host with strictly enforced SSO **I want** the login page to remain exactly
what it is today, with no script and no button, **so that** the only door is the
one I chose.

## Architecture decisions

### 1. Passkeys are a provider kind, constructed only by `passkeys()`, and opt-in

```ts
// src/server/auth/passkeys-provider.ts
export function passkeys(opts: { label?: string; rpName?: string } = {}): PasskeyProvider {
  return {
    kind: 'passkey',
    id: 'passkey',
    label: opts.label ?? 'Sign in with a passkey',
    ...(opts.rpName ? { rpName: opts.rpName } : {}),
  }
}
```

Listing it in `auth.providers` is what renders the button and the script on the
login page, mounts `/login/passkey/*` and `/api/me/passkeys*`, and lists it on
Settings. `rpName` is the human-readable relying-party name a browser shows during
enrolment; it defaults to the request host. `resolveAuth` (spec 28) additionally
throws when a passkey provider is the *only* provider: nobody could ever enrol,
because the first sign-in needs another door.

**Rejected: always-on.** Every session-mode deployment would ship a script and six
routes it may not want, and the "works without JavaScript" property is easier to
hold when the JavaScript is something a host chose to add. A host with
strictly enforced SSO (spec 28 decision 6) has *already* said passkeys are not a
door for `@client.com`; making them appear anyway is a second place to say no.
**Rejected: `AuthConfig.passkeys: true` beside `providers`.** It is a sign-in
method: it renders in the provider list, it stamps `sessions.provider = 'passkey'`,
Settings describes it in the providers table. A flag would be a fifth kind hiding
as a boolean, and every place that switches on `kind` would grow an `|| passkeys`.

### 2. Challenges ride in a short-lived cookie, not a table

```
__Host-folio_webauthn / folio_webauthn
HttpOnly; SameSite=Lax; Path=/; Secure (https); Max-Age=600
value: base64url(JSON { c: <32-byte hex, mintSecret()>, k: 'create' | 'get', u?: users.id })
```

The two `options` routes mint the challenge and set the cookie; the two verify
routes require it, compare `clientDataJSON.challenge` (base64url of the same bytes)
against `c`, check `k` matches the ceremony, check `u` matches the signed-in user
on registration, and clear the cookie in their response whatever the outcome.

The decisive reason is that **`POST /login/passkey/options` is unauthenticated,
and conditional UI calls it on every login-page load** (decision 4). A table
means an anonymous D1 write per page view — a storage-DoS vector that would then
need its own rate limit and its own sweep. A cookie costs nothing server-side and
expires itself. The security property is the one the OIDC state cookie already
relies on (`routes/auth.ts:209-211`, `cookie.ts:20-21`): a value only this host
set, unreadable to script, single-use because the response that consumes it also
clears it. Binding `u` on registration is what stops a challenge minted for one
session from verifying a credential onto another user: the cookie says who was
signed in when the challenge was made, and the verify route refuses if that is not
who is signed in now.

**Rejected: reuse `login_challenges` with a `kind` column.** Wrong shape in every
column — `email` is the key, the id is a hash of a mailed token, `consumeChallenge`
answers an email — plus the anonymous write. **Rejected: a `webauthn_challenges`
table.** The write, plus a sweep, plus a row per page view. **Rejected: a stateless
HMAC-signed challenge.** Folio has no HMAC secret to configure and spec 10
decision 1 chose opaque tokens over signatures precisely to avoid one; a cookie
gets the same "only this host could have set it" property from the browser.

### 3. WebCrypto verification, attestation never evaluated, one workerd test gates it

`src/server/auth/webauthn.ts` is pure — no D1, no Hono, no Request — and exports:

```ts
export function creationOptions(input: {
  rpId: string; rpName: string; challenge: Uint8Array
  user: { id: string; name: string; displayName: string }
  exclude: readonly { id: string; transports?: readonly string[] }[]
}): PublicKeyCredentialCreationOptionsJSON

export function requestOptions(input: { rpId: string; challenge: Uint8Array }): PublicKeyCredentialRequestOptionsJSON

export async function verifyRegistration(input: {
  credential: RegistrationResponseJSON
  expected: { challenge: string; origin: string; rpId: string }
}): Promise<RegisteredCredential>            // { id, publicKey (COSE bytes), alg, counter, transports, aaguid, backedUp }

export async function verifyAssertion(input: {
  credential: AuthenticationResponseJSON
  stored: { publicKey: Uint8Array; alg: number; counter: number; userId: string }
  expected: { challenge: string; origin: string; rpId: string }
}): Promise<{ counter: number; backedUp: boolean }>

// Exported for unit tests; not part of the contract.
export function decodeCbor(bytes: Uint8Array): unknown
export function parseAuthData(bytes: Uint8Array): AuthData
export function coseToJwk(key: Map<number, unknown>): { jwk: JsonWebKey; alg: number }
export function derToRaw(sig: Uint8Array, size: 32): Uint8Array
```

The checks, in order, for **registration**: `credential.type === 'public-key'`;
`clientDataJSON.type === 'webauthn.create'`; `clientDataJSON.challenge` equals the
cookie's; `clientDataJSON.origin` equals the request origin (decision 5); decode
`attestationObject` (CBOR map with `fmt`, `attStmt`, `authData`); parse `authData`
(32-byte `rpIdHash`, 1 flag byte, 4-byte counter, then `aaguid` 16, credential-id
length 2, credential id, COSE key); `rpIdHash === sha256(rpId)`; flags UP and UV
set, AT set; COSE key is EC2 P-256 (`kty 2, alg -7, crv 1`) or RSA (`kty 3,
alg -257`); import it via `coseToJwk` to prove it is a key WebCrypto can hold. The
**attestation statement is not evaluated**: the options request `attestation:
'none'`, and an authenticator that answers `fmt: 'packed'` anyway (some do,
Windows Hello among them) is accepted with its statement ignored, provided
`authData` parses. Refusing a non-`none` `fmt` would lock those users out for a
check this spec does not perform.

For **assertion**: `type === 'public-key'`; `clientDataJSON.type ===
'webauthn.get'`; challenge and origin as above; parse `authData` (no AT section);
`rpIdHash`; UP and UV set; if `userHandle` is present it must equal
`base64url(users.id)`; signature over `authData || sha256(clientDataJSON)` with
`crypto.subtle.verify` — ES256 signatures arrive DER-encoded and WebCrypto
verifies raw `r || s`, so `derToRaw` runs first; RS256 is `RSASSA-PKCS1-v1_5`
over SHA-256 and needs no conversion. Counter: refused when `stored.counter > 0 ||
new > 0` and `new <= stored.counter` (synced passkeys report 0 forever, so 0 → 0
is not a regression).

**Why not the library.** The repo has no auth dependency and `oidc.ts:90-215`
already hand-verifies JWS with WebCrypto; the only new primitives are CBOR (a
subset: unsigned and negative ints, byte strings, text strings, arrays, maps —
about eighty lines) and DER-to-raw. `@simplewebauthn/server` is "periodically
tested but unofficially supported" on Workers, spent a major version CJS-only in a
way that broke ESM bundlers, and carries `@peculiar/asn1-*` and x509 dependencies
whose whole purpose is verifying attestation chains this spec declines to verify.
A dependency whose largest part does something you have decided not to do is a
dependency for its smallest part.

**The gate that decides it.** `test/workers/passkey-verify.test.ts` runs in
workerd — not Node, because the point is that *this* runtime's WebCrypto verifies
*these* signatures — with two inputs: `test/lib/synthetic-authenticator.ts`, which
generates a P-256 and an RSA key pair with WebCrypto, emits `attestationObject`s
with `fmt: 'none'`, and signs assertions with DER-encoded ECDSA; and
`test/fixtures/webauthn/*.json`, real registration and assertion responses captured
once from Chrome (platform authenticator and a security key) and Safari (iCloud
Keychain) during development via a `console.log` in the login script, with the
matching `rpId`, `origin` and challenge recorded beside them. The synthetic
authenticator proves the *logic*; the fixtures prove the *parsing* against
authenticators that pad, omit `userHandle`, send `packed`, or report counter 0. If
the fixtures cannot be made to pass, the fallback is the library, gated by
`test/workers/webauthn-lib-smoke.test.ts` — which imports
`verifyRegistrationResponse` inside workerd and verifies the same fixtures — and
`webauthn.ts` becomes a thin adapter over it with the same exports. What is *not*
asserted anywhere in this spec: the library's current dependency set and whether
it runs clean under `nodejs_compat` today. That is what the smoke test exists to
answer if it is ever needed.

### 4. Conditional UI and a button, from one inline script, degrading to nothing

The server renders, when `rt.auth.passkey` is set:

- `autoComplete="username webauthn"` on the email input (today `"email"`,
  `pages.tsx:361`). The `webauthn` token is what lets the browser offer a passkey
  in the field's autofill dropdown.
- `<button type="button" id="folio-passkey" class="folio-login__provider" hidden
  data-base="{base}" data-next="{next}">{provider.label}</button>`. `hidden`
  until the script proves the browser can use it; `base` and `next` travel as
  attributes so the script is a **static literal with no interpolation**, the same
  property `LOGIN_STYLE` has and the same `biome-ignore` justification.
- One `<script>` with no `src`: `LOGIN_PASSKEY_SCRIPT`, a string constant in
  `pages.tsx`.

The script:

1. `if (!('PublicKeyCredential' in window)) return;` — nothing changes for a
   browser without WebAuthn.
2. Un-hide the button.
3. `arm(mediation)`: `POST {base}/login/passkey/options` with an empty JSON body;
   convert `challenge` and each `allowCredentials[].id` from base64url to
   `ArrayBuffer`; `navigator.credentials.get({ publicKey, mediation, signal })`;
   serialise the assertion by hand (`id`, `rawId`, `type`, `response.{
   clientDataJSON, authenticatorData, signature, userHandle }` as base64url —
   not `toJSON()`, which is too new to rely on); `POST {base}/login/passkey` with
   `{ credential, next }`; on `ok` → `location.assign(body.next)`; on any failure
   → write the server's message into a `.folio-login__notice--bad` paragraph
   inserted above the form (or leave the page as it was if the request was
   aborted).
4. On load: if `PublicKeyCredential.isConditionalMediationAvailable?.()` resolves
   true, `arm('conditional')`. If the server answers 401 with the challenge-expired
   reason, re-arm **once**, then stop — an idle tab must not loop.
5. Button click: abort the pending conditional request via its `AbortController`
   (two concurrent `get()` calls reject each other, so the abort is required, not
   defensive), then `arm('optional')`.

Without JavaScript: the button stays `hidden`, the email form posts exactly as it
does today, the `autocomplete` token is inert. The page is byte-for-byte today's
page plus one hidden button, one attribute and one inert script. **With
`passkeys()` absent from `providers`** none of the three is rendered, so a host
that did not opt in ships no script at all — which is the property
`scripts/auth-test.mjs:63` asserts today and continues to assert, now stated as
"no script when the provider is absent" beside "no external script ever".

**CSP.** Folio sets no Content-Security-Policy and the admin shell already depends
on an inline bootstrap script, so this adds no new posture. A host that applies a
CSP to `{base}/login` needs to allow this one inline script by hash:
`LOGIN_PASSKEY_SCRIPT_HASH` (the `sha256-…` of the literal, computed at build time
in `pages.tsx` and exported from `folio/server`) is what they put in
`script-src`. A test pins that the exported hash matches the literal, so a
one-character edit to the script cannot silently break a host's CSP.

**Rejected: a bundled login entry.** Decision 7 of spec 10, whose reasoning this
spec accepts: the login page is what you look at when the bundle is broken.
**Rejected: the button only, no conditional UI.** The autofill path is what makes a
passkey feel native — the email field you were going to type into offers it — and
its cost is one cookie-only request per page view. **Rejected: interpolating
`base` and `next` into the script.** `next` is user-controlled (screened by
`safeNext`, but still) and a literal script cannot carry an injection.

### 5. `rpId` is the request host and `origin` the request origin, never configured

Both are taken from `c.req.url` at options time and again at verify time. So
`http://localhost` under `wrangler dev` (a secure context for WebAuthn), a
`workers.dev` preview and the production domain each bind passkeys to their own
host with no configuration key. A passkey enrolled on a preview host is invisible
on production, which is right: spec 23 (multi-site) decision 5 already forces the
admin onto one origin because `__Host-` cookies do, and a passkey has the same
per-host scope by design. **Rejected: `passkeys({ rpId })`.** A configurable
relying-party id is how a passkey enrolled on `admin.example.com` is made to work
on `example.com` too — a real feature, and a footgun when misconfigured (the
browser refuses an `rpId` that is not a registrable suffix of the origin, so the
error is "it does not work" with no server-side symptom). Nothing here needs it.

### 6. "Your account" is a screen, and enrolment lives there

`{ name: 'account' }` joins `Screen`, `FLAT` and `TITLES` ("Your account") in
`route.ts`, is *not* in `nav()`, and is reached from the user menu — which becomes
two items again, "Your account" above "Sign out". Sections, top to bottom:

- **Identity** — name, email, role; "role set by *provider*" when spec 28's
  `role_from` is set, since that is why the admin cannot change it.
- **Passkeys** — a `Table` of name, added, last used, a "synced" badge from
  `backed_up`, with rename and remove per row; an **Add a passkey** button that
  opens `AccountPasskeyDialog` (a `Dialog`, so on `useFocusTrap`, no `autoFocus`),
  which posts to `/options`, runs `navigator.credentials.create()`, asks for a
  name (defaulting to `Passkey · <host>`), posts the credential, and closes. When
  `me.passkeys.allowed` is false the button is **absent** and the reason is a
  sentence in its place, per the admin's "absent, not disabled" rule for a
  permission the person cannot change.
- **Sessions** — `GET /api/me/sessions`: created, expires, provider, user agent,
  a "this browser" badge; **Sign out other browsers** → `DELETE
  /api/me/sessions/others`. `last_seen_at` is per user not per session, so the
  list does not claim a per-browser "last active".
- **Recent sign-ins** — `GET /api/me/events` (spec 28), the last twenty.

**Rejected: a section on Settings.** `ui-architecture.md:467` decision 6 makes
Settings the one screen that cannot write; a dialog that enrols a credential is a
write. **Rejected: enrolment from the login page.** An unauthenticated page
cannot know whose passkey it is registering; the owner's rule is that the first
sign-in is always another door.

## Wire & schema changes

### D1 migration `0007_passkeys.sql`

```sql
-- Passkeys: a WebAuthn credential per row, enrolled by a signed-in person.
--
-- `docs/specs/foundation/passkeys.md` is the spec. The groundwork is spec 28's:
-- `completeSignIn` is the one path from a verified identity to a session, and
-- `sessions.provider` is what lets a session say it was minted by a passkey. This
-- table is the credential store that path did not have.
--
-- **Nothing secret is stored.** `public_key` is the authenticator's *public* key; a
-- leaked database lets nobody sign in, which is the property every other credential
-- table here has by hashing and this one has by construction. It is also why spec
-- 10's "a password store is a liability" does not apply: there is no password.
--
-- **`user_id` cascades in the DDL and is deleted explicitly anyway.** `deleteUser`
-- (`server/auth/users.ts`) batches `delete from sessions` beside the user's own
-- delete rather than resting on the cascade pragma, and this table joins that batch
-- for the same reason: whether D1 enforces foreign keys is a property of the
-- database, not the schema.

create table passkeys (
  -- The credential id exactly as the authenticator returned it, base64url. The
  -- primary key because an assertion names it and nothing else: lookup on sign-in
  -- is one probe by this value. Not a hash — it is not a secret, the browser sends
  -- it in the clear on every assertion.
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  -- COSE_Key bytes, base64url. Text rather than blob so every column in this schema
  -- stays text or integer and a D1 blob's shape across drivers is nobody's problem;
  -- decoded once per sign-in, which is the only time it is read.
  public_key    text not null,
  -- COSE algorithm: -7 is ES256, -257 is RS256. The two `pubKeyCredParams` the
  -- options ask for, and the two the verifier imports. Stored so the verifier does
  -- not re-derive it from the key on every sign-in.
  alg           integer not null,
  -- The authenticator's signature counter, last seen. Synced passkeys (iCloud
  -- Keychain, Google Password Manager) report 0 forever, so 0 → 0 is not a
  -- regression; anything else going backwards is refused and logged.
  counter       integer not null default 0,
  -- JSON array from `getTransports()` — 'internal', 'hybrid', 'usb' … — or null
  -- when the browser did not say. Handed back as `allowCredentials[].transports` so
  -- a browser can skip prompting for a USB key that was never one.
  transports    text,
  -- 32 hex characters identifying the authenticator model, or null for `fmt: none`
  -- where the authenticator zeroed it. Labels the vendor on the account screen
  -- ("iCloud Keychain", "Windows Hello"); never a security input.
  aaguid        text,
  -- What the person called it: "Work laptop". Bounded at 60 by the route; defaults
  -- to "Passkey · <host>" so a row enrolled on a preview host says so.
  name          text not null,
  -- The BS flag from the last authenticator data: 1 when the credential is synced
  -- to a cloud keychain. Shown as a badge; explains why `counter` is 0.
  backed_up     integer not null default 0,
  created_at    integer not null,
  last_used_at  integer
);

-- The account screen's list, and the `excludeCredentials` read at enrolment: every
-- passkey for one user, oldest first. `MAX_PASSKEYS_PER_USER` bounds the set, so
-- the index is a convenience rather than a rescue.
create index passkeys_user on passkeys (user_id, created_at);

-- **Deliberately no index on `last_used_at`, `aaguid` or `created_at` alone.** No
-- route orders by any of them across users; `test/workers/migrations.test.ts`
-- asserts the index list is exactly the one above, so adding one is a decision with
-- a measurement behind it, as `shares_story`'s absence is.
--
-- **And no CHECK on `alg`.** A third algorithm (Ed25519 is in the WebAuthn
-- registry) is a new `pubKeyCredParams` entry and a new `coseToJwk` branch, and
-- SQLite cannot widen a CHECK without a table rebuild — the lesson `versions.kind`
-- taught and `content_refs.kind` learned.
```

`deleteUser` (`src/server/auth/users.ts:187-196`) adds
`db.prepare('delete from passkeys where user_id = ?').bind(id)` to its batch,
before the user row's delete.

### Core types

None. `Doc`, `Blok`, `Field`, `Mutation`, `Resolution` and the protocol are
untouched; `PROTOCOL_VERSION` stays at 4.

### Server modules

- `src/server/auth/webauthn.ts` — pure. Exports in decision 3. Owns minimal JSON
  types for the four WebAuthn response shapes (`RegistrationResponseJSON`,
  `AuthenticationResponseJSON`, `PublicKeyCredentialCreationOptionsJSON`,
  `PublicKeyCredentialRequestOptionsJSON`) rather than depending on `@types`.
  Imports `fromBase64url` and `algorithmFor` from `auth/jwt.ts` (spec 28).
- `src/server/auth/passkeys.ts` — D1, `FolioDb`-typed. `listPasskeys(db,
  userId)`, `createPasskey(db, userId, registered, name)`, `renamePasskey(db,
  userId, id, name)`, `deletePasskey(db, userId, id)` (own only — `user_id` is in
  the `where`), `deleteUserPasskeys(db, userId)`, `passkeyForAssertion(db,
  credentialId)` (one join to `users`, answers `{ passkey, user } | null`),
  `usePasskeyStatement(db, id, counter, backedUp, at)` (an unrun statement,
  batched into `completeSignIn`), `countPasskeysByUser(db, userIds)` for the Access
  list. `MAX_PASSKEYS_PER_USER = 10`.
- `src/server/auth/passkeys-provider.ts` — `passkeys()` (decision 1).
- `src/server/auth/cookie.ts` — fifth family: `SECURE_WEBAUTHN_COOKIE`,
  `PLAIN_WEBAUTHN_COOKIE`, `webauthnCookieName`, `readWebauthnCookie`,
  `clearWebauthnCookies`, plus `encodeChallenge`/`decodeChallenge` for the payload
  in decision 2 (pure; `decodeChallenge` answers `null` for anything malformed).
- `src/server/routes/passkeys.ts` — the `/api/me/passkeys*` and `/api/me/sessions*`
  routes and the admin `DELETE /api/users/:id/passkeys`. Mounted at `/api`
  (`app.ts:122-123`'s block). Gated `requireAuthConfigured` + `requirePasskeys(rt)`
  (a new one-liner in `middleware.ts`: 404 unless `rt.auth.mode === 'session' &&
  rt.auth.passkey`) + a user-actor check (a token actor → 403 `forbidden`, "a token
  has no passkeys"). The sessions routes need only `requireAuthConfigured` — they
  are useful without passkeys — and are placed here because the account screen is
  what reads them.
- `src/server/routes/auth.ts` — `POST /login/passkey/options` and `POST
  /login/passkey`, 404 unless `rt.auth.passkey`, mounted at the bare base before
  `/login/:provider` (`app.ts:195`'s reason).
- `src/server/pages.tsx` — the button, the `autocomplete` change, `LOGIN_PASSKEY_SCRIPT`,
  `LOGIN_PASSKEY_SCRIPT_HASH`.
- `src/server/index.tsx` — exports `passkeys`, `LOGIN_PASSKEY_SCRIPT_HASH` and the
  `PasskeyProvider` type beside `magicLink`/`oidc`.

### Admin types

```ts
// src/admin/me.ts
export interface Me {
  …
  /**
   * Present when the deployment lists `passkeys()`. `allowed: false` with a
   * `reason` when this person cannot enrol one — today only under an enforced
   * domain (spec 28), where a passkey would be a second door around SSO.
   */
  passkeys?: { allowed: boolean; reason?: string }
}
```

`GET {base}/api/me` fills it from `rt.auth.passkey` and, for a user actor, from
`auth.domains.get(domainOf(user.email))`.

### New or changed routes

| Method | Path | Gate | Request → response |
| --- | --- | --- | --- |
| POST | `{base}/login/passkey/options` | none; 404 unless configured | `{}` → `200 { publicKey: { challenge, rpId, userVerification: 'required', allowCredentials: [], timeout: 300000 } }` + challenge cookie `k: 'get'` |
| POST | `{base}/login/passkey` | none; needs challenge cookie | `{ credential, next? }` → `200 { ok: true, next }` + session cookie, challenge cookie cleared. **Every** failure → `401 { error: { code: 'unauthorized', message: 'That passkey was not accepted.' } }`, byte-identical, challenge cookie cleared |
| POST | `{base}/api/me/passkeys/options` | user | `{}` → `200 { publicKey: PublicKeyCredentialCreationOptionsJSON }` — `rp: { id: host, name: rpName ?? host }`, `user: { id: base64url(users.id), name: email, displayName: name }`, `pubKeyCredParams: [{ alg: -7 }, { alg: -257 }]`, `authenticatorSelection: { residentKey: 'required', userVerification: 'required' }`, `excludeCredentials: [existing ids]`, `attestation: 'none'`, `timeout: 300000` + challenge cookie `k: 'create', u`. `403 forbidden` under an enforced domain; `409 conflict` at the cap |
| POST | `{base}/api/me/passkeys` | user; needs challenge cookie | `{ credential, name? }` → `201 { passkey: PasskeyRow }`; `400 bad_request` with one generic message for any verification failure; `409 conflict` for a duplicate id |
| GET | `{base}/api/me/passkeys` | user | `200 { passkeys: PasskeyRow[] }` — `{ id, name, alg, transports, aaguid, backedUp, createdAt, lastUsedAt }`, never `public_key` |
| PATCH | `{base}/api/me/passkeys/:id` | user | `{ name }` (1–60 chars) → `200 { passkey }`; 404 for another user's id |
| DELETE | `{base}/api/me/passkeys/:id` | user | own only → `200 { deleted: true }`; 404 otherwise; `passkey_removed` event |
| GET | `{base}/api/me/sessions` | user | `200 { sessions: [{ id (first 12 hex of the hash), current, provider, createdAt, expiresAt, userAgent }] }` |
| DELETE | `{base}/api/me/sessions/others` | user | revokes every session of this user except the one presenting → `200 { revoked: n }`; `sessions_revoked` event |
| DELETE | `{base}/api/users/:id/passkeys` | admin | removes all → `200 { removed: n }`; `passkeys_removed` event with the admin as actor |
| GET | `{base}/api/users` | admin | each row gains `passkeys: number` |
| GET | `{base}/api/me` | session | gains `passkeys?: { allowed, reason? }` |

**The assertion route, step by step.** Challenge cookie present, decodes, and
`k === 'get'` — else 401, and this is the cheap gate that runs before any D1 read,
so a cross-site POST (no `SameSite=Lax` cookie) or a scanner costs nothing. Parse
the body against a valibot schema; malformed → 401. `passkeyForAssertion(id)` →
null → 401. `verifyAssertion` with `stored` from the row and `expected` from the
cookie and request → throws → 401, and a counter regression additionally logs
`passkey_rejected` with the ids. `completeSignIn(db, auth, rt.auth.passkey, {
email: user.email }, ctx)` — which applies domain enforcement and stamps
`provider = 'passkey'` — with `usePasskeyStatement` added to its batch; `refused`
→ 401. Success → cookie, `{ ok: true, next: safeNext(body.next) }`. One message
for every refusal is the same non-enumeration discipline `POST /login/email`
keeps with its byte-identical `SENT`: an attacker with a credential id learns
nothing about whether it exists.

## Acceptance criteria

### The round trip

```
GIVEN a deployment with magicLink() and passkeys() and a signed-in editor
WHEN they POST /api/me/passkeys/options, run the synthetic authenticator's create
     against the answer, and POST the credential to /api/me/passkeys with name "Test"
THEN the response is 201, GET /api/me/passkeys lists one row named "Test" with
     backedUp false and no public_key field
AND the passkeys table holds the credential id, the COSE key and alg -7

GIVEN that editor has signed out
WHEN a browser POSTs /login/passkey/options, signs the challenge with the same
     authenticator, and POSTs the assertion to /login/passkey with next=/folio/content
THEN the response is 200 { ok: true, next: '/folio/content' } with a session cookie
AND sessions.provider is 'passkey' and users.provider is 'passkey'
AND passkeys.last_used_at is set and counter is the asserted value
AND one auth_events row of kind sign_in names provider 'passkey'
AND the same holds for an RS256 credential
```

### Every assertion refusal looks the same

```
GIVEN an enrolled passkey
WHEN /login/passkey is POSTed with: an unknown credential id; a signature over the
     wrong challenge; clientDataJSON.origin of another host; an rpIdHash of another
     host; a valid signature with the UV flag clear; a counter equal to or below the
     stored one where the stored one is > 0; a credential whose user was deleted; a
     credential whose user's email is under an enforced domain owned by oidc; no
     challenge cookie; an expired cookie; a cookie with k: 'create'
THEN every response is 401 with the byte-identical body
     { error: { code: 'unauthorized', message: 'That passkey was not accepted.' } }
AND no sessions row exists in any case
AND the counter-regression case alone adds a passkey_rejected event
```

### Registration refuses what it should

```
GIVEN a signed-in editor with a fresh k: 'create' cookie
WHEN /api/me/passkeys is POSTed with: a challenge that does not match; a cookie whose
     u is another user; an origin of another host; an unsupported alg (-8); an
     attestationObject that does not decode
THEN the response is 400 with one generic message and no row is written

GIVEN the same editor
WHEN they register the same credential id twice
THEN the second is 409

GIVEN an editor with ten passkeys
WHEN they POST /api/me/passkeys/options
THEN the response is 409 and no cookie is set

GIVEN a token actor
WHEN it POSTs /api/me/passkeys/options
THEN the response is 403

GIVEN an editor whose email domain is enforced to oidc
WHEN they POST /api/me/passkeys/options
THEN the response is 403 and GET /api/me answers passkeys: { allowed: false, reason }

GIVEN an authenticator that answers fmt: 'packed' with a well-formed authData
WHEN the credential is POSTed
THEN it is accepted (201) — the statement is ignored, not refused
```

### The login page still works without JavaScript

```
GIVEN passkeys() is configured
WHEN GET /login is fetched
THEN the HTML contains exactly one <script> element, with no src attribute
AND a button#folio-passkey carrying the hidden attribute
AND the email input's autocomplete is "username webauthn"
AND the email form's method and action are unchanged
AND LOGIN_PASSKEY_SCRIPT_HASH equals sha256 of that script's text

GIVEN passkeys() is not configured
WHEN GET /login is fetched
THEN the HTML contains no <script> at all and no button#folio-passkey
AND the email input's autocomplete is "email"
```

### Nothing exists where auth does not

```
GIVEN auth: 'open'
WHEN any of /login/passkey/options, /login/passkey, /api/me/passkeys*, /api/me/sessions*
     or DELETE /api/users/:id/passkeys is requested
THEN every response is 404

GIVEN session auth with no passkeys() provider
WHEN /login/passkey/options, /login/passkey or /api/me/passkeys* is requested
THEN every response is 404
AND /api/me/sessions still answers 200 for a signed-in user
```

### Removal

```
GIVEN an editor with two passkeys
WHEN an admin DELETEs /api/users/:id/passkeys
THEN the response is { removed: 2 }, the table holds none for that user, and an
     auth_events row names the admin as actor
AND an assertion with either credential afterwards is 401

GIVEN an editor with a passkey
WHEN an admin DELETEs /api/users/:id
THEN the passkeys row is gone (explicit batch, asserted with foreign keys off)

GIVEN an editor with a passkey
WHEN they DELETE /api/me/passkeys/:id for another user's passkey
THEN the response is 404 and the row survives
```

### The account screen

```
GIVEN a signed-in editor
WHEN they open the user menu
THEN it offers "Your account" above "Sign out", and choosing it lands on {base}/account

GIVEN me.passkeys.allowed is false
WHEN the account screen renders
THEN there is no Add button and the reason is rendered as a sentence in its place

GIVEN two sessions for one user
WHEN the account screen's sessions list renders
THEN the one presenting the cookie is badged "this browser"
AND "Sign out other browsers" leaves that one live and revokes the other
```

## Implementation plan

### Phase 1 — the verifier and the table, no routes

1. `src/server/auth/webauthn.ts` — decision 3's exports, on `auth/jwt.ts`'s
   primitives.
2. `test/lib/synthetic-authenticator.ts` — `createAuthenticator({ alg })` →
   `{ create(options, { origin }), get(options, { origin, counter }) }` producing
   the JSON shapes a browser would, with `fmt: 'none'` and DER-encoded ECDSA.
3. `test/fixtures/webauthn/` — captured Chrome and Safari registration and
   assertion pairs with their `rpId`, `origin` and challenge, plus a `README.md`
   saying how they were captured and that they contain no secret.
4. `test/workers/passkey-verify.test.ts` — **the gate.** Synthetic ES256 and RS256
   round trips; every refusal in decision 3 individually; every fixture verifies.
5. `test/unit/server/webauthn.test.ts` — `decodeCbor` (ints, negatives, byte
   strings, text, arrays, maps, and refusal of indefinite-length and tags),
   `parseAuthData` (with and without AT, flag bits), `coseToJwk` (EC2 and RSA,
   refusal of other `kty`), `derToRaw` (leading-zero padding both ways).
6. `src/server/auth/passkeys.ts`; `migrations/0007_passkeys.sql`;
   `test/workers/migrations.test.ts` block (columns in order, `passkeys_user` the
   only index, `id` is the pk, `alg` has no CHECK); `deleteUser` batch +
   `auth-session.test.ts` case.

Tree green: nothing mounts a route yet. If step 4's fixtures fail and cannot be
made to pass, this is where the fallback branches: add `@simplewebauthn/server`,
write `test/workers/webauthn-lib-smoke.test.ts`, and make `webauthn.ts` an adapter
with the same exports. Phases 2–5 are unchanged either way.

### Phase 2 — the provider kind and the routes

1. `src/server/auth/passkeys-provider.ts` — `passkeys()`; spec 28's `resolveAuth`
   already knows the kind; add the "not the only provider" rule and its test.
2. `src/server/auth/cookie.ts` — the fifth family and the challenge codec;
   `test/unit/server/auth.test.ts` cases (both names, `Max-Age=600`, malformed
   payload → null, `k` and `u` round-trip).
3. `src/server/middleware.ts` — `requirePasskeys`.
4. `src/server/routes/passkeys.ts` and the two routes in `routes/auth.ts`; the
   `completeSignIn` call with `usePasskeyStatement`; `GET /api/me`'s `passkeys`
   block; `GET /api/users`' count.
5. `test/workers/auth-passkeys.test.ts` — every acceptance criterion above except
   the login page's and the account screen's.

### Phase 3 — the login page

1. `src/server/pages.tsx` — button, `autocomplete`, `LOGIN_PASSKEY_SCRIPT`,
   `LOGIN_PASSKEY_SCRIPT_HASH`; export from `src/server/index.tsx`.
2. `test/workers/auth-login.test.ts` — the "ships no bundle" case becomes the two
   cases in the acceptance criteria; a case pins the hash against the literal.
3. `scripts/auth-test.mjs:63` — "ships no JavaScript" becomes "ships no external
   script" (`<script src`) and, because the demo does not yet list `passkeys()`,
   keeps "and no script at all".
4. `scripts/passkey-test.mjs` — the demo gains `passkeys()` in
   `examples/demo/src/index.tsx`; the script signs in by magic link
   (`scripts/lib/auth.mjs`), imports the synthetic authenticator through
   `scripts/lib/ts-resolve.mjs`, enrols via `/api/me/passkeys`, signs out, signs
   in with the passkey, hits `GET /api/me`, and asserts the login HTML invariants.
   Then `auth-test.mjs`'s "no script at all" check flips to "one inline script".

### Phase 4 — the account screen and the admin

1. `src/admin/ui/route.ts` — `account` in `Screen`, `FLAT`, `TITLES`;
   `test/unit/admin/ui-route.test.ts` parse and round-trip cases.
2. `src/admin/ui/screens/account-model.ts` — pure: row labels, `since()`, a small
   `aaguid → vendor` map for the common half-dozen, `canEnrol(me)`;
   `test/unit/admin/account-screen.test.ts`.
3. `src/admin/ui/screens/useAccount.ts`, `Account.tsx`, `Account.module.css`,
   `AccountPasskeyDialog.tsx` (on `Dialog`; the WebAuthn call lives in the dialog,
   the fetches in the hook).
4. `src/admin/ui/Prototype.tsx` — "Your account" menu item above "Sign out";
   `case 'account'` in `screenFor`. `test/unit/admin/ui-nav.test.ts` — `account`
   is not in the nav.
5. `src/admin/me.ts` — `Me.passkeys`; `test/unit/admin/me.test.ts`.
6. `src/admin/ui/screens/Access.tsx` and `access-model.ts` — `passkeys` column
   (a count, "—" for zero), "Remove all passkeys" row action behind a `Dialog`
   confirm; `test/unit/admin/access-screen.test.ts`.
7. `src/admin/ui/screens/settings-model.ts` — `flow` text for `kind: 'passkey'`
   ("A passkey on this device"); `settings-screen.test.ts`.

### Phase 5 — the prose

1. `README.md` `## Auth` — a "Passkeys" subsection: opt-in, enrol from Your
   account, the login page still posts without JavaScript, `LOGIN_PASSKEY_SCRIPT_HASH`
   for a CSP, an admin removes all from Access.
2. `docs/specs/README.md` — row 29, migration ledger, status sentence.
3. `docs/specs/foundation/identity-and-access.md:602` — the passkeys line points
   here.
4. Restamp this spec `done` with `## Implementation notes`.

## Edge cases

- **Synced passkey reports counter 0 forever** → both stored and new are 0, so the
  regression check is skipped; enforced the moment either is non-zero. A regression
  is refused and logged, never deletes the credential: a cloned authenticator is
  the person's to resolve by removing it from their account.
- **Conditional `get()` pending past the cookie's 600 s** → the eventual assertion
  carries a challenge the server no longer holds → generic 401; the script re-arms
  once with a fresh challenge and then stops, so an idle tab does not loop on
  `/options`.
- **Two tabs each arm conditional UI** → each minted its own cookie value and the
  later `Set-Cookie` wins for both; the earlier tab's assertion → 401 → re-arm
  once. Acceptable and rare.
- **Cross-site POST to `/login/passkey`** → no `SameSite=Lax` challenge cookie →
  401 before any D1 read.
- **`userHandle` absent from the assertion** (some security keys omit it for
  non-discoverable use) → the cross-check is skipped; the credential-id lookup is
  the authority, and the key it names belongs to exactly one user.
- **Enrolled on `localhost`, tried on the deployed host** → `rpIdHash` mismatch →
  401. The account screen's default name `Passkey · <host>` is the only hint, which
  is why the default name carries the host.
- **The person's role changes** → irrelevant to passkeys; a passkey proves
  identity, `completeSignIn` reads the role from the row.
- **A passkey provider with no mail or redirect provider** → `resolveAuth` throws
  at construction: nobody could ever enrol.
- **`excludeCredentials` lists the person's existing ids** → the browser refuses to
  re-enrol the same authenticator and shows its own message; the server never sees
  the attempt.
- **Authenticator sends `fmt: 'packed'` despite `attestation: 'none'`** → accepted,
  statement ignored (decision 3). Refusing would lock out Windows Hello.
- **The user is deleted while their browser holds a session** → the session row
  cascades (and is deleted explicitly), and the next assertion with their
  credential id finds no row → 401.
- **Enforced domain added after a passkey was enrolled** → the passkey row survives,
  the assertion reaches `completeSignIn`, which refuses under the domain rule →
  401; the account screen's Add button disappears with the reason. An admin who
  wants the row gone uses "Remove all passkeys".
- **Body over the size valibot allows** → 401 on the login route (generic),
  400 on the registration route; neither is a 500.
- **`PublicKeyCredential` exists but `isConditionalMediationAvailable` does not**
  (older browsers) → the button is shown and conditional UI is skipped.

## Testing requirements

**Unit (`test/unit/`):**
- `server/webauthn.test.ts` — `decodeCbor`, `parseAuthData`, `coseToJwk`, `derToRaw`
  as in phase 1; `creationOptions`/`requestOptions` shapes.
- `server/auth.test.ts` — the webauthn cookie family (name by scheme, both names
  cleared, `Max-Age=600`), `encodeChallenge`/`decodeChallenge` round trip and
  refusal of malformed payloads, `resolveAuth` refusing a passkey-only provider list.
- `admin/account-screen.test.ts` — `canEnrol`, row labels, vendor names, `since`.
- `admin/ui-route.test.ts`, `admin/ui-nav.test.ts` — `account` parses, round-trips
  and is absent from the nav.
- `admin/me.test.ts` — `passkeys.allowed` reading.
- `admin/access-screen.test.ts` — the count column's zero rendering.
- `admin/settings-screen.test.ts` — the passkey `flow` text.

**Workers (`test/workers/`, real workerd):**
- `passkey-verify.test.ts` — the gate (phase 1, step 4).
- `auth-passkeys.test.ts` — every route criterion: round trips for ES256 and RS256;
  the byte-identical refusal table (one `it` per row, asserting the body against
  one constant); registration refusals; cap; token actor; enforced domain; `packed`
  accepted; 404s under `auth: 'open'` and without the provider; admin remove-all;
  own-only delete; sessions list and "others" revoke; `GET /api/me` `passkeys` block.
- `auth-login.test.ts` — the login page's one-script / no-script invariants and
  the hash pin.
- `auth-session.test.ts` — `deleteUser` removes passkeys with foreign keys off.
- `migrations.test.ts` — `passkeys` columns in order, `passkeys_user` the only
  index, no CHECK on `alg`.

**End to end (`scripts/passkey-test.mjs` against a live dev server on port 5199):**
- Sign in by magic link; enrol through `/api/me/passkeys` with the synthetic
  authenticator; list; rename; sign out; sign in with the passkey; `GET /api/me`
  shows the user; login HTML has one inline script and the hidden button; remove
  the passkey; the assertion afterwards is 401 with the exact body.

## Dependencies

- **Spec 28 (`foundation/auth-providers.md`) phases 1–2** — the provider union
  with a `passkey` arm, `completeSignIn`, `sessions.provider`, `auth/jwt.ts`, and
  `GET /api/me/events`. This spec cannot start before those land.
- **Spec 10** — sessions, cookies, `secrets.ts`, `requireAuthConfigured`, the
  Access screen.
- No Cloudflare resources and no host config change beyond listing `passkeys()`.
  WebCrypto is in workerd; `nodejs_compat` is not needed for anything here.

## Out of scope

- **Attestation evaluation and any trust store.** Requested `none`, never
  verified (decision 3). A deployment that must know *which* authenticator model
  enrolled is an enterprise policy Folio has no other half of.
- **Passkey-only self-registration.** The owner's rule: the first sign-in is
  another door, so the account list stays something an admin maintains.
- **A "require passkeys" policy.** Checkpoint 4; the way back in after a lost
  device is the point of not having one.
- **Per-passkey admin management.** Remove-all covers the incident; naming and
  pruning is the owner's own business on their account screen.
- **A configurable `rpId`.** Decision 5.
- **`PublicKeyCredential.toJSON()` and `parseCreationOptionsFromJSON()`.** Too new
  for the browsers a client's reviewer may be on; manual conversion is thirty lines.
- **The Signal API** (`signalUnknownCredential`, `signalAllAcceptedCredentials`),
  which tells a browser to forget a passkey Folio removed. Nice, later; the browser's
  own "this passkey was not accepted" already covers the visible case.
- **Ed25519 (`-8`).** In the WebAuthn registry, not in WebCrypto everywhere yet. The
  schema has no CHECK on `alg` so adding it is a code change only.

## Open questions

None. **All five checkpoints answered by the owner on 2026-09-05**, each to its
recommendation. Two carry commitments worth restating outside the checkpoint list,
because both are things that block a phase rather than shape one:

- **Checkpoint 1 — hand-rolled WebCrypto verification, with the library as the
  documented fallback.** The library-first inversion was offered and declined. This
  means `test/fixtures/webauthn/*.json` is on the critical path: **real registration
  and assertion responses have to be captured by hand, once, from Chrome (platform
  authenticator and a security key) and Safari (iCloud Keychain)**, with the matching
  `rpId`, `origin` and challenge recorded beside them. Nobody but the owner can do
  that, it needs the login script working locally to produce the `console.log` it is
  captured from, and phase 1's gate does not pass without it. Plan the phase so the
  synthetic authenticator lands first and the fixtures are a second, owner-blocked
  step — not so the whole phase stalls waiting on a device.
- **Checkpoint 2 — user verification `required` at both ceremonies.** `preferred` was
  offered and declined. The consequence to state in the README: **a bare security key
  with no PIN cannot enrol at all**, and the error the person sees comes from their
  browser, not from Folio, so there is no server-side symptom to debug. That is the
  price of a passkey being the only factor in this sign-in.

**Build order: this spec is last of the four**, after 31, 30 and 28. Its dependency on
28 phases 1–2 is unchanged and is the hard one; the move of 30 and 31 ahead of both
does not touch it.

## Implementation notes

All five phases landed as designed. `passkeys()` is a fifth provider kind, opt-in;
`src/server/auth/webauthn.ts` verifies registration and assertion against pure
WebCrypto with no auth dependency; the `passkeys` table, six routes and the
"Your account" screen are all in the tree, exercised by
`test/workers/passkey-verify.test.ts`, `test/workers/auth-passkeys.test.ts`,
`test/workers/auth-login.test.ts` and the admin's own unit suites.

**The most important thing recorded here: the real-device fixtures were never
captured, and the gate is therefore half proven.** `test/fixtures/webauthn/`
holds a `README.md` with the capture procedure, the file format and the reasoning
that these contain no secret (a registration response carries the authenticator's
*public* key; an assertion signs a challenge already consumed) — but it holds no
fixtures, because capturing one needs a browser and a device, and nobody here has
either. `passkey-verify.test.ts` proves the verifier's *logic* in full against
`test/lib/synthetic-authenticator.ts` — ES256 and RS256 round trips, every
refusal in decision 3 individually, the counter rule's five cases, `packed`
accepted — and that half is genuinely green. It does not prove the *parsing* of
what Chrome and Safari actually send: padding a synthetic authenticator chooses
to suit the decoder, an omitted `userHandle`, `fmt: 'packed'` with a populated
`attStmt`, a counter that reports 0 forever. The suite refuses to let a green run
imply otherwise: when the fixtures directory is empty it emits a `todo` (which
the default reporter counts in its summary line even piped to a file), a passing
test whose name states the gap, and a `console.warn`. All three disappear on
their own the moment a fixture lands, and none of them are a failing test to
"fix" — deleting or skipping the `todo` would be deleting the one thing standing
between a green suite and an unverified assumption about real devices. **The
documented fallback if the fixtures ever fail to pass is `@simplewebauthn/server`
behind the same exports** (`src/server/auth/webauthn.ts`'s five functions and
`WebAuthnError`) — a phase, not a rewrite — and it is neither taken nor ruled out
until a real pair is captured and run.

**Four smaller things this spec's Ground truth or plan got wrong, worth
recording because each would otherwise look like a design decision made here
rather than a fact discovered while building:**

- **`GET {base}/api/me/events` did not exist when phase 2 needed it.** Ground
  truth assumed it shipped with spec 28's phases 1–2; it is spec 28's *phase 4*,
  and it landed concurrently with this spec's own build. Harmless in the end —
  the account screen (phase 4 here) is its only reader, and phase 4 landed after
  spec 28 was done — but the premise was false while phase 2 was reading it.
- **Decision 6's Identity section needed the person's email and "role set by
  `<provider>`", and `GET {base}/api/me` projected neither at the time.** The
  route answered a user actor as exactly `{ kind, id, name, colour, role }`.
  Both were added afterwards: `email` and `roleFrom` on `UserActor`
  (`src/server/auth/roles.ts`) and on that route's projection
  (`src/server/routes/auth.ts`), riding the join `readSession` already runs, so
  neither costs an extra query and neither is a new disclosure — it is the
  caller's own row, answered to the caller. `Account.tsx`'s own doc comment
  records the sequence in place rather than presenting the final shape as
  though it were there from the start.
- **`sign_in_refused` landed in spec 28's phase 3, not its phase 4.** This
  spec's Ground truth and acceptance criteria were written assuming the refusal
  event table existed in the shape spec 28's plan described; by the time this
  spec's routes were built, the write already lived in `completeSignIn`
  (batched beside the refusal it records), so the four event kinds this spec
  adds — `passkey_rejected`, `passkey_removed`, `passkeys_removed`,
  `sessions_revoked` — slotted into a table and a writer that already existed
  rather than being built alongside them.
- **`LOGIN_PASSKEY_SCRIPT_HASH` is a top-level `await`.** "Computed at build
  time" reads two ways — a build-step script, or computed once when the module
  itself loads — and the second is what landed: `scriptHash()` in
  `src/server/pages.tsx` calls `crypto.subtle.digest`, and the export is
  `await scriptHash(LOGIN_PASSKEY_SCRIPT)` at module scope. It builds clean
  under both toolchains this ships through (`tsc` with `module: "ESNext"`,
  `esbuild --format=esm --target=es2022`) and survives into `dist/`, but a
  top-level await makes *every* module that imports `pages.tsx` — directly or
  transitively — async to load, which is worth naming because hosts construct
  their Folio instance at module scope, and a host importing `folio/server`
  now has one module in the graph that suspends on load. No unit test caught
  this: `vitest.config.ts`'s Node `unit` project never imports `server/pages.tsx`
  or `server/index.tsx`, only the workerd `workers` project does, so the cost
  is paid once per isolate there and never observed from Node.

The rest of what diverged from the plan, none of it a design change:

- **`WebAuthnError` with a `code`** is exported beside `webauthn.ts`'s four
  functions, unnamed in decision 3. Load-bearing, not decoration: the
  acceptance criteria require a counter regression alone to log
  `passkey_rejected` while every other refusal reads byte-identical to the
  person, and a route cannot tell those apart from a thrown message alone. The
  codes are `malformed | type | challenge | origin | rp_id | user_presence |
  user_verification | attested_credential | algorithm | user_handle | signature
  | counter`; the assertion route switches on `'counter'` and treats every
  other code identically.
- **`decodeCbor` also reads `false`, `true` and `null`** (major 7, simple
  values 20–22) beyond the six major types decision 3 lists, and
  **`coseToJwk` normalises coordinate width in both directions** — left-pads a
  short EC coordinate to 32 bytes, strips a leading zero an encoder added, and
  trims RSA's `n`. Both are load-bearing rather than decorative: a P-256
  coordinate whose top byte is zero occurs about once in 256 credentials, and
  an unpadded JWK import fails for exactly those; an `attStmt` some
  authenticator's `fmt: 'packed'` carries may hold a simple value this file
  never reads but must still decode past.
- **`createPasskey` answers `null` for a duplicate id** via
  `on conflict(id) do nothing` rather than throwing a D1 constraint error —
  the `409` in the route table, decided in the round trip a pre-read would
  otherwise have spent.
- **`completeSignIn` gained `ctx.extra?: readonly D1PreparedStatement[]`**,
  unnamed in the spec's module list. It is appended **last** in the batch,
  after the session row and the `sign_in` event, and **only on the success
  path** — a refused assertion is not a use, so nothing stamps
  `last_used_at`. This is how `usePasskeyStatement` reaches the same batch
  `completeSignIn` writes without a second round trip.
- **The acceptance criterion "asserted with foreign keys off" is not
  achievable, and was replaced with a stronger substitute.** D1 in workerd
  pins `PRAGMA foreign_keys` at 1 always: the pragma statement is accepted,
  changes nothing, and a later read still answers 1. `auth-session.test.ts`
  instead asserts the `deleteUser` batch in two halves — the
  `delete from passkeys` statement **is in the batch**, recorded off a
  `prepare`-watching proxy no pragma can influence, ordered before the user
  row's own delete — and the row **is gone** against real D1. Verified by
  breaking it: an unknown-credential refusal message changed to something
  other than the byte-identical constant turned three tests red at once (the
  message diff, the deleted-user case, and the admin remove-all case), which
  is the same discipline applied to this substitute assertion.
- **The "not the only provider" rule landed with spec 28**, not here —
  `resolveAuth` already threw for a passkey-only provider list before this
  spec added `passkeys()` itself to exercise the rule from this side.
- **Three files outside the spec's own module list had to change**:
  `auth/events.ts` (the four new event kinds, predicted by that union's own
  comment), `auth/session.ts` (`listUserSessions`, `revokeOtherSessions`,
  `SessionRow` — "sessions SQL lives in this file and nowhere else" is that
  file's stated rule), and `validate.ts` (`PasskeyRegisterBody`,
  `PasskeyAssertionBody`, `PasskeyPatchBody`, a `b64url(max)` primitive —
  "valibot here and only here").
- **`PASSKEY_REFUSED` and three shared helpers live in `routes/passkeys.ts`**
  and `routes/auth.ts` imports them, so the refusal message stays one literal
  and the challenge-minting rule stays one function across both ceremonies.
- **`DELETE {base}/api/users/:id/passkeys` is deliberately not behind
  `requirePasskeys`** — a host that takes `passkeys()` back out must still be
  able to clear the rows it left behind, so this route sits behind
  `requireAuthConfigured` + `requireAccess(ADMIN)` only.
- **"An expired cookie" has no server-side representation.** `Max-Age=600` is
  enforced by the browser alone; the payload carries no timestamp, so an
  expired challenge reaches the route as no cookie at all or as one that fails
  to decode — both already rows in the refusal table, rather than a state a
  test could age into existence.
- **The enforced-domain refusal row is reachable only for a credential
  enrolled before the domain was enforced** — with the domain already claimed,
  enrolment itself is a 403 and there is nothing to enrol, so the test enrols
  on a deployment without enforcement and asserts against one with it, over
  the same database.
- **`usePasskeyStatement` trips biome's `useHookAtTopLevel`** (the linter reads
  any `useX()` call as a React hook); one `biome-ignore` at the call site in
  `auth.ts`, with the statement hoisted to its own `const`.
- **`GET {base}/api/users`' passkey count query is skipped entirely when no
  passkey provider is configured**, while the `passkeys` key stays present on
  every row so the Access column always has one shape to render. **`GET
  {base}/api/me`'s passkey block is one extra read, paid only where passkeys
  are on** — `Actor` carries no email otherwise, and an enforced domain is a
  fact about the address.
- **The button and inline script are unconditional on `rt.auth.passkey`, not
  on `opts.signedOut`** — unlike the `trusted` buttons — so the ordinary
  login page never advertises a door the signed-out page does not also show.
- **`react-dom/server.edge` renders `autoComplete` verbatim, not lowercased to
  `autocomplete`.** Harmless in a real browser, which parses attribute names
  case-insensitively, but every assertion here matches the actual casing.
- **`scripts/passkey-test.mjs` hardcodes `PASSKEY_REFUSED`'s literal** rather
  than importing `routes/passkeys.ts` under Node, which would pull in `hono`
  and the whole auth surface for one string already pinned against drift by
  the workerd suites. It runs the full round trip once against a live dev
  server instead — 24/24 checks, alongside `scripts/auth-test.mjs` at 58/58.
- **`account-model.ts` adds an `AccountGate`**, the same four-case shape
  `access-model.ts`'s `AccessGate` uses, unnamed in the spec's plan — without
  it the account screen had no honest thing to render for `auth: 'open'` or
  an anonymous visit.
- **The `aaguid → vendor` map's six entries are the community-documented
  ones**, not values captured from a real device — that capture is the same
  open item as the fixtures above, not a separate gap, and the migration's own
  comment already insists `aaguid` is "never a security input", so an
  imprecise or missing entry degrades to the row's own name only.
- **Access's "one menu item" (decision 4) is a second `Button` beside the
  existing `Remove`, not a dropdown menu** — the Actions column was already
  two adjacent buttons elsewhere on that screen, so a kebab menu for one more
  action would have been the odd one out.
- **`settings-model.ts`'s passkey `flow` text already existed**, added by
  spec 28 phase 1 to keep a `Record` exhaustive; this spec's own suggested
  wording says the same thing, so the shipped, tested string was left alone.
- **No pagination in `useAccount.ts`**, unlike every other list hook in this
  admin — deliberate, since `MAX_PASSKEYS_PER_USER` bounds passkeys at ten,
  `GET {base}/api/me/events` answers a fixed last twenty with no cursor at
  all, and a person's own open sessions are never more than a handful.
