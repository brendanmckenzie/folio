// Exercises draft-mode.md end to end against a live dev server: an editor enters
// draft mode and the *host's own page* renders from the draft, across a
// navigation, until they leave.
//
// The assertion that matters is not "the unpublished heading appears" — the old
// `?_folio=draft` shell would satisfy that too. It is that the heading appears
// **inside the demo's own `Shell`**, which is what "a draft rendered in the host's
// layout" means and the whole reason this feature exists. `previewPage` emits its
// own minimal document with no site header; the demo emits one carrying the
// `header` global. So every check below looks for both.
import { signInGlobally } from './lib/auth.mjs'

// The session cookie is kept rather than discarded, because this script is the
// first that needs *two* cookies at once. `signInGlobally` wraps `fetch` with a
// fixed session header and keeps no jar — it never records a `Set-Cookie` — so
// the draft flag has to be carried by hand here, composed onto the session for
// every request that should be in draft mode.
const { cookie: session } = await signInGlobally()

/** The `folio_draft` flag, once `enter` has handed it over. */
let draftFlag = null

const flagFrom = (res) => {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]
  for (const value of values) {
    const match = /(^|[;,]\s*)(__Host-folio_draft|folio_draft)=([^;]+)/.exec(value ?? '')
    if (match && match[3] !== '') return `${match[2]}=${match[3]}`
  }
  return null
}

/** A page fetch as the signed-in editor, optionally carrying the draft flag. */
const visit = (path, { draft = false } = {}) =>
  fetch(`${HTTP}/${path}`, {
    headers: { cookie: draft && draftFlag ? `${session}; ${draftFlag}` : session },
  })

const { PROTOCOL_VERSION } = await import(new URL('../src/core/protocol.ts', import.meta.url))

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())
const post = (path, body) =>
  json(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A socket, because a mutation has no other way in (`story-do.ts` exposes none). */
function client(storyId) {
  const ws = new WebSocket(`ws://localhost:5199/folio/api/story/${storyId}/socket`)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg)
    }
  })
  return {
    ws,
    async hello() {
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      this.send({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'e2e', name: 'e2e', colour: '#0090ff' },
      })
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    // Every frame carries the wire version, not only `hello`.
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: 'tx', txId, mutations })
      await this.expect((m) => m.type === 'delta' && m.txId === txId)
      await wait(150)
    },
    expect(match, ms = 4000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error('timeout waiting on socket message')), ms)
      })
    },
    close() {
      this.ws.close()
    },
  }
}

/** Retitles a story's root block through the log, leaving the published copy alone. */
async function retitle(story, heading) {
  const sock = client(story.id)
  const doc = await sock.hello()
  await sock.tx(`draft-mode-${story.id}-${Date.now()}`, [
    { t: 'set', uid: doc.root, field: 'title', value: heading },
  ])
  sock.close()
}

/* --- two published pages, then an unpublished edit on each --------------- */

const one = await post('/stories', { title: 'Draft Mode One' })
const two = await post('/stories', { title: 'Draft Mode Two' })
await post(`/story/${one.id}/publish`, {})
await post(`/story/${two.id}/publish`, {})

const HEADING_ONE = 'Draft Mode One EDITED'
const HEADING_TWO = 'Draft Mode Two EDITED'
await retitle(one, HEADING_ONE)
await retitle(two, HEADING_TWO)

/**
 * The demo's `Shell` is given `stylesheets={['/site.css']}`; `previewPage` builds
 * its own document and links Folio's preview CSS instead. So this is the
 * discriminator between "the host's own page" and "Folio's approximation of it",
 * and it is why every check below asserts two things rather than just the heading.
 *
 * Not the `header` global, which was the first guess: the demo's seed leaves that
 * singleton empty, so `renderGlobal` emits nothing and the marker is absent from a
 * perfectly ordinary published page.
 */
const isHostPage = (html) => html.includes('/site.css')

/* --- published, signed in, but not in draft mode ------------------------- */

const before = await visit(one.path)
const beforeHtml = await before.text()
check(
  'a signed-in editor who has not entered draft mode sees the published page',
  !beforeHtml.includes(HEADING_ONE) && isHostPage(beforeHtml),
  `host-page=${isHostPage(beforeHtml)}`,
)
check(
  'and it is cacheable, because it is the ordinary published response',
  (before.headers.get('cache-control') ?? '').includes('s-maxage'),
  before.headers.get('cache-control') ?? '(none)',
)

/* --- enter --------------------------------------------------------------- */

const entered = await fetch(`${BASE}/draft/enter?next=%2F${one.path}`, { redirect: 'manual' })
draftFlag = flagFrom(entered)
check(
  'entering draft mode redirects to next and sets the flag',
  entered.status === 302 && draftFlag !== null,
  `status=${entered.status} flag=${draftFlag ?? '(none)'}`,
)

const drafted = await visit(one.path, { draft: true })
const draftedHtml = await drafted.text()
check(
  'the unpublished heading renders INSIDE the host’s own layout',
  draftedHtml.includes(HEADING_ONE) && isHostPage(draftedHtml),
  `heading=${draftedHtml.includes(HEADING_ONE)} host-page=${isHostPage(draftedHtml)}`,
)
check(
  'the drafted response is private, no-store',
  (drafted.headers.get('cache-control') ?? '') === 'private, no-store',
  drafted.headers.get('cache-control') ?? '(none)',
)
check(
  'and carries no cache tag, so nothing can key it at the edge',
  drafted.headers.get('cache-tag') === null,
  drafted.headers.get('cache-tag') ?? '(none)',
)
check('the host draws its draft banner', draftedHtml.includes('Exit draft mode'))

/* --- the navigation, which is the whole point ---------------------------- */

const second = await visit(two.path, { draft: true })
const secondHtml = await second.text()
check(
  'following a link to a second page drafts that one too',
  secondHtml.includes(HEADING_TWO) && isHostPage(secondHtml),
  `heading=${secondHtml.includes(HEADING_TWO)}`,
)

/* --- exit ---------------------------------------------------------------- */

const exited = await fetch(`${BASE}/draft/exit?next=%2F${one.path}`, { redirect: 'manual' })
check(
  'exiting clears the flag',
  exited.status === 302 && (exited.headers.get('set-cookie') ?? '').includes('Max-Age=0'),
  `status=${exited.status}`,
)
// A browser would drop the cookie on that `Max-Age=0`; this process has to be told.
draftFlag = null

const after = await visit(one.path)
const afterHtml = await after.text()
check(
  'the published bytes come back',
  !afterHtml.includes(HEADING_ONE) && isHostPage(afterHtml),
  `heading-gone=${!afterHtml.includes(HEADING_ONE)}`,
)
check(
  'and the response is cacheable again',
  (after.headers.get('cache-control') ?? '').includes('s-maxage'),
  after.headers.get('cache-control') ?? '(none)',
)

/* --- a stranger is unaffected throughout --------------------------------- */

// A bare fetch with no cookie jar at all: the cookies this process now holds are
// what draft mode keys on, so dropping them is the whole of being a stranger.
const stranger = await fetch(`${HTTP}/${one.path}`, { headers: { cookie: '' } })
const strangerHtml = await stranger.text()
check(
  'a visitor with no cookies never sees a draft',
  !strangerHtml.includes(HEADING_ONE),
  `heading-absent=${!strangerHtml.includes(HEADING_ONE)}`,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
