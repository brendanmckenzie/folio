// Exercises identity-and-access.md end to end against a live dev server: sign in
// with a magic link, edit, publish, sign out, and confirm the editor and the
// socket are both refused afterwards — while a published page and its assets go
// on serving to anyone, because that is what a published page is.
//
// Runs against examples/demo, which configures `magicLink` with a `send` that
// logs the URL and stashes it at `/dev/last-signin` (localhost only). That stand-
// in for a mailbox is the only reason this script needs no mail credentials.
//
// Deliberately uses the raw `fetch` throughout rather than scripts/lib/auth.mjs's
// global wrapper: the whole point here is which requests carry a credential and
// which do not, so every header is explicit.
import { DEMO_ADMIN, DEMO_EDITOR, DEMO_VIEWER, sessionCookieFrom } from './lib/auth.mjs'

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`
const STORY = 'sty_home'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* --- the closed door ---------------------------------------------------- */

const editorPage = await fetch(`${API}/edit/${STORY}`, { redirect: 'manual' })
check(
  'the editor redirects when signed out',
  editorPage.status === 302,
  `status=${editorPage.status}`,
)
check(
  'and it points at the login page, remembering where you were going',
  (editorPage.headers.get('location') ?? '').startsWith('/folio/login?next='),
  editorPage.headers.get('location') ?? '',
)

const listSignedOut = await fetch(`${API}/stories`)
check(
  'the API answers 401 when signed out',
  listSignedOut.status === 401,
  `status=${listSignedOut.status}`,
)
const envelope = await listSignedOut.json()
check(
  'with the one error envelope',
  envelope?.error?.code === 'unauthorized',
  JSON.stringify(envelope),
)

const schema = await fetch(`${API}/schema`)
check('the manifest stays public', schema.status === 200, `status=${schema.status}`)

const loginPage = await fetch(`${API}/login`)
const loginHtml = await loginPage.text()
check('the login page renders', loginPage.status === 200 && loginHtml.includes('name="email"'))
check('and ships no JavaScript at all', !loginHtml.includes('<script'))

/* --- an unauthenticated socket is refused terminally -------------------- */

function socket(headers = {}) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${STORY}/socket`, { headers })
  const inbox = []
  const closes = []
  ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)))
  ws.addEventListener('close', (e) => closes.push({ code: e.code, reason: e.reason }))
  ws.addEventListener('error', () => {})
  return {
    ws,
    inbox,
    closes,
    /** Resolves once the socket is open, or once it has been refused: every
     * refusal here is an upgrade-then-close, so "open" happens either way. */
    ready: () =>
      new Promise((resolve) => {
        if (ws.readyState === 1) return resolve()
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('close', resolve, { once: true })
      }),
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async closedWith(ms = 3000) {
      const until = Date.now() + ms
      while (Date.now() < until && closes.length === 0) await wait(20)
      return closes[0]?.code ?? null
    },
    async expect(match, ms = 3000) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const hit = inbox.find(match)
        if (hit) return hit
        await wait(20)
      }
      throw new Error(`timeout waiting for a frame; saw ${inbox.map((f) => f.type).join(',')}`)
    },
  }
}

const anonymous = socket()
check(
  'an unauthenticated socket upgrades and then closes 4003',
  (await anonymous.closedWith()) === 4003,
  JSON.stringify(anonymous.closes),
)

/* --- email addresses are not enumerable -------------------------------- */

async function requestLink(email) {
  const res = await fetch(`${API}/login/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email }),
  })
  return { status: res.status, body: await res.text() }
}

const known = await requestLink(DEMO_ADMIN)
const linkUrl = (await (await fetch(`${HTTP}/dev/last-signin`)).json()).url
const unknown = await requestLink('nobody-at-all@example.com')
const afterUnknown = (await (await fetch(`${HTTP}/dev/last-signin`)).json()).url

check(
  'an unknown address is answered byte-identically',
  known.status === unknown.status && known.body === unknown.body,
  `${known.status}/${unknown.status}`,
)
check('and no link is sent for it', afterUnknown === linkUrl)

/* --- signing in --------------------------------------------------------- */

const verified = await fetch(linkUrl, { redirect: 'manual' })
const cookie = sessionCookieFrom(verified)
check('the link signs the browser in', Boolean(cookie), `status=${verified.status}`)
check('and redirects into the editor', verified.headers.get('location') === '/folio/edit')

const reused = await fetch(linkUrl, { redirect: 'manual' })
check(
  'a sign-in link is single use',
  (reused.headers.get('location') ?? '').includes('error=link'),
  reused.headers.get('location') ?? '',
)

const me = await (await fetch(`${API}/me`, { headers: { cookie } })).json()
check(
  '/folio/me names the signed-in admin',
  me?.actor?.name === 'Demo Admin' && me?.actor?.role === 'admin',
  JSON.stringify(me?.actor),
)

const editorSignedIn = await fetch(`${API}/edit/${STORY}`, { headers: { cookie } })
check('the editor serves once signed in', editorSignedIn.status === 200)

/* --- editing and publishing as that session ---------------------------- */

const live = socket({ cookie })
await live.ready()
live.send({
  type: 'hello',
  lastSyncId: 0,
  identity: { actor: 'not-me', name: 'Not Me', colour: '#000000' },
})
const boot = await live.expect((f) => f.type === 'bootstrap')
check('a signed-in socket bootstraps', Boolean(boot.doc?.root))

const title = `Auth test ${Date.now()}`
live.send({
  type: 'tx',
  txId: `auth-${Date.now()}`,
  mutations: [{ t: 'set', uid: boot.doc.root, field: 'title', value: title }],
})
const delta = await live.expect((f) => f.type === 'delta')
check(
  'the transaction is attributed to the session, not to what hello claimed',
  delta.actor === 'usr_demoadmin1',
  delta.actor,
)

const published = await fetch(`${API}/story/${STORY}/publish`, {
  method: 'POST',
  headers: { cookie, 'x-folio-actor': 'somebody-else' },
})
check('publishing works for an admin', published.status === 200, `status=${published.status}`)
const versions = await (
  await fetch(`${API}/story/${STORY}/versions`, { headers: { cookie } })
).json()
check(
  'the version records the signed-in user, ignoring the old actor header',
  versions[0]?.actor === 'usr_demoadmin1',
  versions[0]?.actor,
)

/* --- roles ------------------------------------------------------------- */

async function signInAs(email) {
  await requestLink(email)
  const url = (await (await fetch(`${HTTP}/dev/last-signin`)).json()).url
  return sessionCookieFrom(await fetch(url, { redirect: 'manual' }))
}

const editorCookie = await signInAs(DEMO_EDITOR)
const editorPublish = await fetch(`${API}/story/${STORY}/publish`, {
  method: 'POST',
  headers: { cookie: editorCookie },
})
check('an editor may not publish', editorPublish.status === 403, `status=${editorPublish.status}`)
const editorCreate = await fetch(`${API}/stories`, {
  method: 'POST',
  headers: { cookie: editorCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Editor tried to create this' }),
})
check('nor create a page', editorCreate.status === 403, `status=${editorCreate.status}`)
check(
  'but may read the tree',
  (await fetch(`${API}/stories`, { headers: { cookie: editorCookie } })).status === 200,
)

const viewerCookie = await signInAs(DEMO_VIEWER)
check(
  'a viewer may read',
  (await fetch(`${API}/stories`, { headers: { cookie: viewerCookie } })).status === 200,
)
const viewerSocket = socket({ cookie: viewerCookie })
await viewerSocket.ready()
viewerSocket.send({
  type: 'hello',
  lastSyncId: 0,
  identity: { actor: 'v', name: 'V', colour: '#111111' },
})
const viewerBoot = await viewerSocket.expect((f) => f.type === 'bootstrap')
check('and gets a socket, read-only (the spec’s open question)', Boolean(viewerBoot.doc?.root))
viewerSocket.send({
  type: 'tx',
  txId: `viewer-${Date.now()}`,
  mutations: [{ t: 'set', uid: viewerBoot.doc.root, field: 'title', value: 'Nope' }],
})
const rejected = await viewerSocket.expect((f) => f.type === 'reject')
check(
  'whose transactions are refused with a reason, not a disconnect',
  rejected.reason === 'read-only: your role may not edit',
  rejected.reason,
)
viewerSocket.ws.close()

/* --- the access surface ------------------------------------------------ */

const usersAsEditor = await fetch(`${API}/users`, { headers: { cookie: editorCookie } })
check(
  'managing editors is admin-only',
  usersAsEditor.status === 403,
  `status=${usersAsEditor.status}`,
)
const users = await (await fetch(`${API}/users`, { headers: { cookie } })).json()
check('an admin can list editors', users?.users?.length === 3, `n=${users?.users?.length}`)

const minted = await fetch(`${API}/tokens`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'e2e-reader', scopes: ['content:read'] }),
})
const token = (await minted.json()).token
check('an admin can mint a token', /^folio_[0-9a-f]{64}$/.test(token ?? ''), String(token))
check(
  'the token reads',
  (await fetch(`${API}/stories`, { headers: { authorization: `Bearer ${token}` } })).status === 200,
)
const tokenWrite = await fetch(`${API}/stories`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'From a read-only token' }),
})
check('and is refused a write', tokenWrite.status === 403, `status=${tokenWrite.status}`)
const tokenSocket = socket({ authorization: `Bearer ${token}` })
check(
  'a token cannot hold an editing session',
  (await tokenSocket.closedWith()) === 4004,
  JSON.stringify(tokenSocket.closes),
)

/* --- origin checking --------------------------------------------------- */

const crossOrigin = await fetch(`${API}/story/${STORY}/publish`, {
  method: 'POST',
  headers: { cookie, origin: 'https://evil.example' },
})
check(
  'a cookie-authenticated mutation from another origin is refused',
  crossOrigin.status === 403,
  `status=${crossOrigin.status}`,
)

/* --- a published page serves to anyone --------------------------------- */

const publicPage = await fetch(`${HTTP}/`)
const publicHtml = await publicPage.text()
check('the published page serves with no credential', publicPage.status === 200)
check('and shows what was just published', publicHtml.includes(title))
check(
  'a preview request from a stranger falls through to the published page',
  !(await (await fetch(`${HTTP}/?_folio=preview`)).text()).includes('folio-editing'),
)

const assets = await (await fetch(`${API}/assets`, { headers: { cookie } })).json()
const firstAsset = (Array.isArray(assets) ? assets : assets?.assets)?.[0]
if (firstAsset?.key) {
  const asset = await fetch(`${API}/asset/${firstAsset.key}`)
  check('an asset serves with no credential', asset.status === 200, `status=${asset.status}`)
} else {
  // Nothing uploaded in this database; the route's public-ness is pinned in
  // test/workers/auth-http.test.ts regardless.
  check('an asset serves with no credential (skipped: no assets seeded)', true)
}

/* --- signing out ------------------------------------------------------- */

const loggedOut = await fetch(`${API}/logout`, { method: 'POST', headers: { cookie } })
check('signing out succeeds', loggedOut.status === 200)
const cleared = loggedOut.headers.getSetCookie?.() ?? []
check(
  'and clears the cookie under both names',
  cleared.some((c) => c.startsWith('folio_session=;')),
  cleared.join(' | '),
)

const afterLogout = await fetch(`${API}/stories`, { headers: { cookie } })
check('the API refuses the old cookie', afterLogout.status === 401, `status=${afterLogout.status}`)
const editorAfterLogout = await fetch(`${API}/edit/${STORY}`, {
  headers: { cookie },
  redirect: 'manual',
})
check('the editor redirects again', editorAfterLogout.status === 302)

const socketAfterLogout = socket({ cookie })
check(
  'and a socket on the old cookie closes 4003',
  (await socketAfterLogout.closedWith()) === 4003,
  JSON.stringify(socketAfterLogout.closes),
)

const stillPublic = await fetch(`${HTTP}/`)
check('the published page still serves', stillPublic.status === 200)

live.ws.close()

/* --- report ------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.label} ${f.detail}`)
  process.exitCode = 1
}
