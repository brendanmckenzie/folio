// Draft preview sharing (docs/specs/platform/draft-sharing.md) end to end against a
// live dev server: an editor mints a link, and a browser with **no account and no
// cookie** opens it and sees the unpublished draft — while the same browser is refused
// everywhere else in the CMS.
//
// This one genuinely needs a live server rather than a workers test, and the reason is
// the anonymous half. `test/workers/shares.test.ts` builds its own `createFolio` and
// hands it Requests, so "unauthenticated" there is a fact about a header it chose not
// to set. Here it is a fact about a real HTTP client that never had a credential: a
// separate `fetch` that carries no cookie jar, following a real 302 and a real
// `Set-Cookie` through a real Worker.
//
// **The cookie discipline is the whole point of this file, so read it before editing.**
// `signInGlobally()` replaces the process's `fetch` so every later call carries the
// admin's session — which is exactly right for the six other scripts and exactly wrong
// for this one, because a test that accidentally sends the admin's cookie to the share
// URL proves nothing at all. So:
//
//   - `signInGlobally()` returns `realFetch`, the *unwrapped* function it saved. Every
//     request made as the reviewer goes through `anon()`, which wraps `realFetch` and
//     manages its own one-cookie jar.
//   - Nothing in this file calls the global `fetch` for a reviewer request. `editor()`
//     is the only helper that uses the wrapped one, and it is named so the difference
//     is visible at every call site.
//   - `anon()` asserts it is not carrying a session cookie on every call, so a future
//     edit that leaks one fails loudly rather than passing for the wrong reason.
import { signInGlobally } from './lib/auth.mjs'

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

/** The two seeded pages this script uses (examples/demo/seed.sql). */
const ABOUT = 'sty_about'
const TEAM = 'sty_team'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

const { realFetch, RealWebSocket } = await signInGlobally()

/** A request as the signed-in admin: the global, wrapped `fetch`. */
const editor = (path, init) => fetch(`${HTTP}${path}`, init)

/**
 * A browser with no account.
 *
 * One cookie jar, holding whatever the server set, and nothing else — no session
 * cookie ever enters it, which is asserted rather than assumed on every call.
 */
let jar = null
async function anon(path, init = {}) {
  const headers = new Headers(init.headers)
  if (jar) headers.set('cookie', jar)
  if (/folio_session/.test(headers.get('cookie') ?? '')) {
    throw new Error('the anonymous client picked up a session cookie — the test is void')
  }
  const res = await realFetch(`${HTTP}${path}`, { ...init, headers, redirect: 'manual' })
  const set = res.headers.getSetCookie?.() ?? []
  for (const value of set) {
    const match = /(^|[;,]\s*)(__Host-folio_share|folio_share)=([^;]+)/.exec(value)
    if (match) jar = `${match[2]}=${match[3]}`
  }
  return res
}

const json = async (res) => {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/* --- the seeded link, which is what `wrangler dev` demonstrates ----------- */
//
// examples/demo/seed.sql ships one link for sty_home with a fixed, unmistakable token,
// exactly as it ships a fixed API token — so the feature is one paste away after
// `pnpm db:seed` rather than three API calls away. Checked first, and checked here
// rather than in a workers test, because the thing being verified is that the
// precomputed SHA-256 in that file matches the plaintext in its own comment.

const SEEDED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const seededEntry = await anon(`/folio/share?t=${SEEDED}`)
check(
  'the seeded demo link works straight out of seed.sql',
  seededEntry.status === 302 && seededEntry.headers.get('location') === '/?_folio=preview',
  `status=${seededEntry.status} location=${seededEntry.headers.get('location')}`,
)
const seededPreview = await anon('/?_folio=preview')
const seededHtml = await seededPreview.text()
check(
  'and renders the home page’s draft to a browser with nothing else',
  seededPreview.status === 200 && seededHtml.includes('Home'),
  `status=${seededPreview.status}`,
)
// Fresh jar for the rest of the run, so nothing below can pass on the seed's grant.
jar = null

/* --- set the scene: a published page whose draft has moved on -------------- */

const published = await editor(`/folio/api/story/${ABOUT}/publish`, { method: 'POST' })
check('the editor publishes /about', published.status === 200, `status=${published.status}`)

const DRAFT_ONLY = 'Under review, not for the public'
const patched = await editor(`/folio/api/v1/documents/${ABOUT}/fields`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fields: { title: DRAFT_ONLY } }),
})
check(
  'and then edits the draft, so draft and published differ',
  patched.status === 200,
  `status=${patched.status}`,
)

const live = await anon('/about')
const liveHtml = await live.text()
check('the public page serves', live.status === 200, `status=${live.status}`)
check(
  'and shows the published title, not the draft',
  !liveHtml.includes(DRAFT_ONLY),
  liveHtml.includes(DRAFT_ONLY) ? 'the draft leaked to the public page' : '',
)

// The control that makes everything below mean something: the preview flag on its own
// is worth nothing. `handle()` hands the request back and the host serves its page.
const flagAlone = await anon('/about?_folio=preview')
const flagAloneHtml = await flagAlone.text()
check(
  'the preview flag alone shows a stranger the published page, never the draft',
  flagAlone.status === 200 && !flagAloneHtml.includes(DRAFT_ONLY),
  `status=${flagAlone.status}`,
)

/* --- minting a link ------------------------------------------------------- */

const minted = await editor(`/folio/api/story/${ABOUT}/share`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ note: 'e2e review', expiresInDays: 3 }),
})
const mintedBody = await json(minted)
check('minting a link answers 201', minted.status === 201, `status=${minted.status}`)
check(
  'with an absolute URL on this origin, carrying the token in the query',
  typeof mintedBody?.url === 'string' && mintedBody.url.startsWith(`${BASE}/share?t=`),
  String(mintedBody?.url),
)
const token = mintedBody?.url ? new URL(mintedBody.url).searchParams.get('t') : null
check('and the token is 32 bytes of hex', /^[0-9a-f]{64}$/.test(token ?? ''), String(token))
check(
  'and the row it answers carries no token and no hash',
  !JSON.stringify(mintedBody?.share ?? {}).includes(token ?? 'x'),
)
check(
  'and three days, because the editor asked for three',
  Math.round((mintedBody.share.expiresAt - mintedBody.share.createdAt) / 86_400_000) === 3,
)

/* --- the reviewer, who has no account ------------------------------------- */

const entry = await anon(`/folio/share?t=${token}`)
check('opening the link redirects', entry.status === 302, `status=${entry.status}`)
check(
  'to the document’s own preview URL, built by the host’s route()',
  entry.headers.get('location') === '/about?_folio=preview',
  entry.headers.get('location') ?? '',
)
check(
  'and never stores the response that carried the token',
  (entry.headers.get('cache-control') ?? '').includes('no-store'),
  entry.headers.get('cache-control') ?? '',
)
const entryCookie = (entry.headers.getSetCookie?.() ?? []).join(' | ')
check('setting a share cookie', /folio_share=/.test(entryCookie), entryCookie)
check('HttpOnly, so no script can read it', /HttpOnly/.test(entryCookie))
check(
  'and not a session cookie: the token can satisfy no route gate',
  !/folio_session=/.test(entryCookie),
)

const preview = await anon(entry.headers.get('location'))
const previewHtml = await preview.text()
check('following the redirect renders', preview.status === 200, `status=${preview.status}`)
check(
  'the DRAFT, which the public page does not show',
  previewHtml.includes(DRAFT_ONLY),
  previewHtml.includes(DRAFT_ONLY) ? '' : 'the shared preview showed published content',
)
check(
  'and says no-store, so an unpublished draft cannot be cached at a public URL',
  (preview.headers.get('cache-control') ?? '').includes('no-store'),
  preview.headers.get('cache-control') ?? '',
)

/* --- and nothing else ----------------------------------------------------- */
//
// The enumeration. A preview token holder must reach the shared document and nothing
// whatsoever besides. Written as a table so a route family added later without a gate
// is a row somebody has to deliberately not add.

const closed = [
  ['the admin shell', BASE, undefined, 302],
  ['a deep link into the shell', `${BASE}/content`, undefined, 302],
  ['the editor', `${BASE}/edit/${ABOUT}`, undefined, 302],
  ['the story list', `${API}/stories`, undefined, 401],
  ['this document’s draft as JSON', `${API}/story/${ABOUT}/document`, undefined, 401],
  ['the document list', `${API}/documents`, undefined, 401],
  ['the type counts', `${API}/counts`, undefined, 401],
  ['site search', `${API}/search?q=about`, undefined, 401],
  ['content_index over published content', `${API}/content?type=page`, undefined, 401],
  ['the media library', `${API}/assets`, undefined, 401],
  ['the version list', `${API}/story/${ABOUT}/versions`, undefined, 401],
  ['the activity trail', `${API}/story/${ABOUT}/activity`, undefined, 401],
  ['who am I', `${API}/me`, undefined, 401],
  ['the editor list', `${API}/users`, undefined, 401],
  ['the token list', `${API}/tokens`, undefined, 401],
  ['the share list itself', `${API}/shares`, undefined, 401],
  ['schedules', `${API}/schedules`, undefined, 401],
  ['redirects', `${API}/redirects`, undefined, 401],
  ['the v1 document read', `${API}/v1/documents/${ABOUT}`, undefined, 401],
  ['the v1 draft read', `${API}/v1/documents/${ABOUT}?status=draft`, undefined, 401],
  ['the v1 by-path read', `${API}/v1/documents/by-path/about`, undefined, 401],
  ['publishing', `${API}/story/${ABOUT}/publish`, { method: 'POST' }, 401],
  ['unpublishing', `${API}/story/${ABOUT}/unpublish`, { method: 'POST' }, 401],
  ['deleting', `${API}/stories/${ABOUT}`, { method: 'DELETE' }, 401],
  ['renaming or moving', `${API}/stories/${ABOUT}`, { method: 'PATCH' }, 401],
  ['creating', `${API}/stories`, { method: 'POST' }, 401],
  ['bulk publishing', `${API}/bulk/publish`, { method: 'POST' }, 401],
  ['writing a field', `${API}/v1/documents/${ABOUT}/fields`, { method: 'PATCH' }, 401],
  ['minting another link', `${API}/story/${TEAM}/share`, { method: 'POST' }, 401],
  ['revoking a link', `${API}/shares/${mintedBody.share.id}`, { method: 'DELETE' }, 401],
  ['migrating', `${API}/migrate`, { method: 'POST' }, 401],
  ['reindexing', `${API}/reindex`, { method: 'POST' }, 401],
  ['running schedules', `${API}/schedules/run`, { method: 'POST' }, 401],
]

const wrong = []
for (const [what, url, init, expected] of closed) {
  const res = await anon(url.replace(HTTP, ''), init)
  // Read and discard, so a body never sits unread on a keep-alive socket.
  await res.arrayBuffer()
  if (res.status !== expected) wrong.push(`${what}: ${res.status} not ${expected}`)
}
check(
  `a preview token reaches none of the other ${closed.length} route families`,
  wrong.length === 0,
  wrong.join('; '),
)

// Another document's preview, which is the refusal that matters most: a grant names one
// story id, so a sibling page's URL is handed back to the host exactly as it would be
// for a stranger.
const sibling = await anon('/about/team?_folio=preview')
const siblingHtml = await sibling.text()
check(
  'and cannot walk to another document’s draft',
  // /about/team is unpublished, so the host answers its own 404 rather than a preview.
  sibling.status === 404,
  `status=${sibling.status}`,
)
check(
  'with no draft content in the body',
  !siblingHtml.includes('Our team'),
  siblingHtml.slice(0, 80),
)

// `?as=` swaps the editable document for a *global's* draft — the site header, site
// settings — which the grant does not cover.
const asGlobal = await anon('/about?_folio=preview&as=header')
const asGlobalHtml = await asGlobal.text()
check(
  'and cannot ask for a global in the page’s context with ?as=',
  asGlobal.status === 200 && !asGlobalHtml.includes(DRAFT_ONLY),
  `status=${asGlobal.status}`,
)

// Folio's own bare preview for a singleton is an HTML route gated on READ_DRAFT.
const globalPreview = await anon('/folio/preview/global/header')
check(
  'and cannot reach Folio’s own singleton preview',
  globalPreview.status === 302,
  `status=${globalPreview.status}`,
)

// The socket, through a real WebSocket rather than `fetch` — undici refuses an
// `Upgrade` header outright, and the refusal being tested is an *application close
// code* rather than a status anyway. `RealWebSocket` is the unwrapped constructor
// `signInGlobally` saved; the wrapped one would attach the admin's session.
const socketClose = await new Promise((resolve) => {
  const ws = new RealWebSocket(`ws://localhost:5199/folio/api/story/${ABOUT}/socket`, {
    headers: { cookie: jar },
  })
  const done = setTimeout(() => resolve('timed out'), 5000)
  ws.addEventListener('close', (e) => {
    clearTimeout(done)
    resolve(e.code)
  })
  ws.addEventListener('error', () => {
    clearTimeout(done)
    resolve('refused')
  })
})
check(
  'and cannot upgrade the sync socket to an editing session',
  // 4003 is "not signed in", the terminal close an unauthenticated socket gets: a
  // share cookie is not a session, so there is no identity to hand the object.
  socketClose === 4003,
  `close=${socketClose}`,
)

/* --- two links at once ---------------------------------------------------- */

const second = await editor(`/folio/api/story/${TEAM}/share`, { method: 'POST' })
const secondBody = await json(second)
check('a second link for a second document', second.status === 201, `status=${second.status}`)

const secondEntry = await anon(`/folio/share?t=${new URL(secondBody.url).searchParams.get('t')}`)
check(
  'lands on that document’s URL',
  secondEntry.headers.get('location') === '/about/team?_folio=preview',
  secondEntry.headers.get('location') ?? '',
)

const teamPreview = await anon('/about/team?_folio=preview')
check('and renders it', teamPreview.status === 200, `status=${teamPreview.status}`)
await teamPreview.arrayBuffer()

// The reason the cookie holds a list: the second click must not unseat the first.
const stillAbout = await anon('/about?_folio=preview')
const stillAboutHtml = await stillAbout.text()
check(
  'while the first link still works from the same browser',
  stillAbout.status === 200 && stillAboutHtml.includes(DRAFT_ONLY),
  `status=${stillAbout.status}`,
)

/* --- the receipt ---------------------------------------------------------- */

const listed = await json(await editor('/folio/api/shares?count=1'))
check(
  'the editor can list what is outstanding',
  Array.isArray(listed?.shares),
  JSON.stringify(listed).slice(0, 80),
)
// Newest first, so the two this script made lead — the demo also seeds one for
// sty_home (examples/demo/seed.sql), which is why this is a prefix rather than a
// count: a test coupled to the seed's contents breaks every time the seed grows.
check(
  'newest first, both of this run’s links leading',
  listed?.shares?.[0]?.storyId === TEAM &&
    listed?.shares?.[1]?.storyId === ABOUT &&
    listed?.total === listed?.shares?.length,
  JSON.stringify(listed?.shares?.map((s) => s.storyId)),
)
check(
  'with the views the reviewer actually made',
  (listed?.shares?.find((s) => s.storyId === ABOUT)?.views ?? 0) >= 2,
  JSON.stringify(listed?.shares?.map((s) => [s.storyId, s.views])),
)
check('and never a token anywhere in the list', !JSON.stringify(listed).includes(token))
check(
  'attributed to the person who made it',
  listed?.shares?.every((s) => typeof s.createdBy === 'string' && s.createdBy.startsWith('usr_')),
)

const oneDocument = await json(await editor(`/folio/api/shares?story=${TEAM}`))
check(
  'filterable by document',
  oneDocument?.shares?.length === 1,
  JSON.stringify(oneDocument?.shares?.length),
)
const liveOnly = await json(await editor('/folio/api/shares?state=live'))
check(
  'and by whether they still work: nothing has lapsed yet',
  liveOnly?.shares?.length === listed?.shares?.length &&
    (await json(await editor('/folio/api/shares?state=lapsed')))?.shares?.length === 0,
  JSON.stringify(liveOnly?.shares?.length),
)

/* --- revoking ------------------------------------------------------------- */

const revoked = await editor(`/folio/api/shares/${mintedBody.share.id}`, { method: 'DELETE' })
check('revoking answers 200', revoked.status === 200, `status=${revoked.status}`)
check('and says so', (await json(revoked))?.revoked === true)

const afterRevoke = await anon('/about?_folio=preview')
const afterRevokeHtml = await afterRevoke.text()
check(
  'the shared preview stops showing the draft immediately',
  !afterRevokeHtml.includes(DRAFT_ONLY),
  afterRevoke.status === 200
    ? 'served the published page, which is the refusal'
    : `status=${afterRevoke.status}`,
)

const reopened = await anon(`/folio/share?t=${token}`)
const reopenedHtml = await reopened.text()
check(
  'and reopening the original link explains itself rather than 404ing blankly',
  reopened.status === 404 && reopenedHtml.includes('no longer works'),
  `status=${reopened.status}`,
)
check('with no JavaScript on that page', !reopenedHtml.includes('<script'))
check(
  'and without naming the document it was for',
  !reopenedHtml.includes('About') && !reopenedHtml.includes(DRAFT_ONLY),
)

// An unknown token is byte-identical to a revoked one: telling them apart would make
// this route an oracle for "was this string ever one of our tokens", and the reader's
// next action is the same either way.
const unknown = await anon(`/folio/share?t=${'f'.repeat(64)}`)
const unknownHtml = await unknown.text()
check(
  'an unknown token answers the identical page',
  unknown.status === 404 && unknownHtml === reopenedHtml,
)

// The other link is untouched: revocation is per link, which is the whole reason a
// grant covers one document rather than a subtree.
const teamStillWorks = await anon('/about/team?_folio=preview')
check(
  'the other link is untouched',
  teamStillWorks.status === 200,
  `status=${teamStillWorks.status}`,
)
await teamStillWorks.arrayBuffer()

const lapsedList = await json(await editor('/folio/api/shares?state=lapsed'))
check(
  'and the revoked one is still in the list, as the receipt it is',
  lapsedList?.shares?.length === 1 && lapsedList.shares[0].revokedAt > 0,
  JSON.stringify(lapsedList?.shares?.map((s) => [s.id, s.revokedAt])),
)

/* --- report --------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.label} ${f.detail}`)
  process.exitCode = 1
}
