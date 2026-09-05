// Exercises `docs/specs/foundation/passkeys.md` end to end against a live dev
// server: sign in by magic link, enrol a passkey, list and rename it, sign out,
// sign in again with *only* the passkey, confirm the login page's script
// invariants, remove the passkey, and confirm the door it opened is now shut.
//
// Runs against examples/demo, which now lists `passkeys()` beside `magicLink`
// (`examples/demo/src/index.tsx`) — the one line that is this deployment's whole
// opt-in (decision 1).
//
// There is no browser here, so nothing exercises `LOGIN_PASSKEY_SCRIPT` itself —
// that is `test/workers/auth-login.test.ts`'s job, in workerd, against the
// rendered HTML. What a synthetic authenticator stands in for is the *other*
// end of the wire: a `navigator.credentials.create()`/`.get()` response, built
// with WebCrypto exactly as `test/workers/passkey-verify.test.ts` builds one,
// imported here through `scripts/lib/ts-resolve.mjs` so this script can reach
// library source with no build step.
import './lib/ts-resolve.mjs'
import { DEMO_ADMIN, sessionCookieFrom, signInGlobally } from './lib/auth.mjs'
import { createAuthenticator, ES256 } from '../test/lib/synthetic-authenticator.ts'

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

/** The webauthn challenge cookie out of a `Set-Cookie` list, under either name
 * (`auth/cookie.ts`'s `SECURE_WEBAUTHN_COOKIE` / `PLAIN_WEBAUTHN_COOKIE`) —
 * `sessionCookieFrom` in lib/auth.mjs is the same idea for the session cookie. */
function webauthnCookieFrom(res) {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]
  for (const value of values) {
    const match = /(^|[;,]\s*)(__Host-folio_webauthn|folio_webauthn)=([^;]+)/.exec(value ?? '')
    if (match) return `${match[2]}=${match[3]}`
  }
  return null
}

/* --- sign in by magic link, the way an editor gets a first door at all ---- */

const { cookie: magicCookie } = await signInGlobally(HTTP, DEMO_ADMIN)

const meBefore = await (await fetch(`${API}/me`, { headers: { cookie: magicCookie } })).json()
check(
  'signed in by magic link before any passkey exists',
  meBefore?.actor?.name === 'Demo Admin' && meBefore?.session?.provider === 'magic',
  JSON.stringify(meBefore?.session),
)
check(
  'GET /api/me already carries the passkeys block, since the demo lists passkeys()',
  meBefore?.passkeys?.allowed === true,
  JSON.stringify(meBefore?.passkeys),
)

/* --- enrolling a passkey -------------------------------------------------- */

const optionsRes = await fetch(`${API}/me/passkeys/options`, {
  method: 'POST',
  headers: { cookie: magicCookie, 'content-type': 'application/json' },
  body: '{}',
})
check(
  'enrolment options answers 200 with a create challenge',
  optionsRes.status === 200,
  `status=${optionsRes.status}`,
)
const createChallengeCookie = webauthnCookieFrom(optionsRes)
check('and sets the webauthn challenge cookie', Boolean(createChallengeCookie))
const { publicKey: creationOptions } = await optionsRes.json()
check(
  'the creation options ask for ES256 and RS256, discoverable, UV required',
  creationOptions?.pubKeyCredParams?.some((p) => p.alg === -7) &&
    creationOptions?.pubKeyCredParams?.some((p) => p.alg === -257) &&
    creationOptions?.authenticatorSelection?.userVerification === 'required',
  JSON.stringify(creationOptions?.authenticatorSelection),
)

const authenticator = await createAuthenticator({ alg: ES256 })
const registration = await authenticator.create(creationOptions, { origin: HTTP })

const enrolRes = await fetch(`${API}/me/passkeys`, {
  method: 'POST',
  headers: {
    cookie: `${magicCookie}; ${createChallengeCookie}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ credential: registration, name: 'Synthetic security key' }),
})
const enrolBody = await enrolRes.json()
check('the credential is accepted', enrolRes.status === 201, `status=${enrolRes.status}`)
check(
  'and the row names it, with no public key on the wire',
  enrolBody?.passkey?.name === 'Synthetic security key' &&
    enrolBody?.passkey?.alg === -7 &&
    enrolBody?.passkey?.backedUp === false &&
    !('publicKey' in (enrolBody?.passkey ?? {})) &&
    !('public_key' in (enrolBody?.passkey ?? {})),
  JSON.stringify(enrolBody?.passkey),
)
const passkeyId = enrolBody?.passkey?.id

const reenrolRes = await fetch(`${API}/me/passkeys/options`, {
  method: 'POST',
  headers: { cookie: magicCookie, 'content-type': 'application/json' },
  body: '{}',
})
check(
  'a second options call excludes the credential just enrolled',
  (await reenrolRes.json()).publicKey?.excludeCredentials?.some((c) => c.id === registration.id),
)

/* --- listing and renaming ------------------------------------------------- */

const listed = await (
  await fetch(`${API}/me/passkeys`, { headers: { cookie: magicCookie } })
).json()
check(
  'the list shows exactly the one passkey',
  listed?.passkeys?.length === 1 && listed.passkeys[0]?.id === passkeyId,
  JSON.stringify(listed),
)

const renamed = await (
  await fetch(`${API}/me/passkeys/${passkeyId}`, {
    method: 'PATCH',
    headers: { cookie: magicCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed key' }),
  })
).json()
check(
  'renaming answers the updated row',
  renamed?.passkey?.name === 'Renamed key',
  JSON.stringify(renamed),
)

/* --- signing out, then back in with *only* the passkey -------------------- */

const signedOut = await fetch(`${API}/logout`, { method: 'POST', headers: { cookie: magicCookie } })
check('signing out of the magic-link session succeeds', signedOut.status === 200)

const noSession = await fetch(`${API}/stories`, { headers: { cookie: magicCookie } })
check('the old session cookie is dead', noSession.status === 401, `status=${noSession.status}`)

const getOptionsRes = await fetch(`${BASE}/login/passkey/options`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
check(
  // The demo's wrapped `fetch` still tags a dead session cookie onto this
  // request — `signInGlobally` cannot know it was revoked — which is fine:
  // decision 2 is that this route reads no binding at all, so it answers
  // identically whether or not a stale cookie rides along.
  'the login route mints a get challenge (an unauthenticated route)',
  getOptionsRes.status === 200,
  `status=${getOptionsRes.status}`,
)
const getChallengeCookie = webauthnCookieFrom(getOptionsRes)
const { publicKey: requestOptions } = await getOptionsRes.json()
check(
  'allowCredentials is empty — a discoverable credential needs no list',
  Array.isArray(requestOptions?.allowCredentials) && requestOptions.allowCredentials.length === 0,
)

const assertion = await authenticator.get(requestOptions, { origin: HTTP })
const signInRes = await fetch(`${BASE}/login/passkey`, {
  method: 'POST',
  headers: { cookie: getChallengeCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ credential: assertion, next: '/folio/edit' }),
})
const signInBody = await signInRes.json()
check(
  'the passkey alone signs the browser back in',
  signInRes.status === 200 && signInBody?.ok === true && signInBody?.next === '/folio/edit',
  JSON.stringify(signInBody),
)
const passkeyCookie = sessionCookieFrom(signInRes)
check('and sets a fresh session cookie', Boolean(passkeyCookie))

const meAfter = await (await fetch(`${API}/me`, { headers: { cookie: passkeyCookie } })).json()
check(
  'GET /api/me shows the same person, this time via the passkey door',
  meAfter?.actor?.name === 'Demo Admin' && meAfter?.session?.provider === 'passkey',
  JSON.stringify(meAfter?.session),
)

/* --- the login page's one inline script ----------------------------------- */

const loginHtml = await (await fetch(`${BASE}/login`)).text()
const loginScriptTags = [...loginHtml.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
check(
  'the login page ships exactly one inline script, no src',
  loginScriptTags.length === 1 && loginScriptTags.every((tag) => !tag.includes(' src=')),
  loginScriptTags.join(' | '),
)
check(
  'and a hidden #folio-passkey button',
  /<button[^>]*id="folio-passkey"[^>]*hidden/.test(loginHtml),
)
check(
  'and the email field offers the webauthn autofill token',
  loginHtml.includes('autoComplete="username webauthn"') ||
    loginHtml.includes('autocomplete="username webauthn"'),
)

/* --- removing the passkey shuts the door it opened ------------------------ */

const removed = await (
  await fetch(`${API}/me/passkeys/${passkeyId}`, {
    method: 'DELETE',
    headers: { cookie: passkeyCookie },
  })
).json()
check('the passkey can be removed', removed?.deleted === true, JSON.stringify(removed))

const listedAfterRemoval = await (
  await fetch(`${API}/me/passkeys`, { headers: { cookie: passkeyCookie } })
).json()
check('and the list is empty afterwards', listedAfterRemoval?.passkeys?.length === 0)

const secondOptionsRes = await fetch(`${BASE}/login/passkey/options`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
const secondChallengeCookie = webauthnCookieFrom(secondOptionsRes)
const { publicKey: secondRequestOptions } = await secondOptionsRes.json()
const secondAssertion = await authenticator.get(secondRequestOptions, { origin: HTTP })
const refusedRes = await fetch(`${BASE}/login/passkey`, {
  method: 'POST',
  headers: { cookie: secondChallengeCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ credential: secondAssertion, next: '/folio/edit' }),
})
const refusedBody = await refusedRes.json()
check(
  'the same assertion is refused once the credential is gone',
  refusedRes.status === 401,
  `status=${refusedRes.status}`,
)
check(
  'with the exact byte-identical refusal body every refusal shares',
  JSON.stringify(refusedBody) ===
    JSON.stringify({ error: { code: 'unauthorized', message: 'That passkey was not accepted.' } }),
  JSON.stringify(refusedBody),
)

/* --- report ---------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.label} ${f.detail}`)
  process.exitCode = 1
}
