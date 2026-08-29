// Exercises redirects.md end to end against a live dev server: a rename or a
// move records a redirect the host answers with a real 301, an internal link
// to the renamed page needs none of that (it resolves directly — the link
// stores an id, not a path), a delete offers one to the parent, and an editor
// can add one by hand.
//
// Imported directly: Node strips types natively and this module has only a
// runtime const with no value imports of its own, so there is nothing to
// resolve at runtime.
// The demo now configures a real sign-in provider (identity-and-access.md), so
// every route here needs a session. This signs in as the seeded admin and makes
// this process's `fetch` and `WebSocket` carry the cookie, exactly as a browser
// does — see scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

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
const patch = (path, body) =>
  json(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * A real WebSocket to a story's sync endpoint — the one path a mutation can
 * arrive by (`story-do.ts` exposes nothing over RPC that applies one).
 * Mirrors `scripts/fields-test.mjs`'s client, trimmed to what this file needs.
 */
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
    // Every frame carries the wire version, not only `hello` — the object
    // refuses any frame that omits it (see story-do.ts).
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: 'tx', txId, mutations })
      await this.expect((m) => m.type === 'delta' && m.txId === txId)
      await wait(120)
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

/* --- a rename records a redirect, and the host answers a real 301 -------- */

const parent = await post('/stories', { title: 'Redirect E2E Parent' })
const child = await post('/stories', { title: 'Redirect E2E Child', parentId: parent.id })
await post(`/story/${parent.id}/publish`, {})
await post(`/story/${child.id}/publish`, {})

const oldChildPath = child.path

const renamedParent = await patch(`/stories/${parent.id}`, { slug: 'redirect-e2e-parent-2' })
check(
  'reparenting/renaming the parent recomputes the whole subtree',
  renamedParent.slug === 'redirect-e2e-parent-2',
  renamedParent.slug,
)

const redirected = await fetch(`${HTTP}/${oldChildPath}`, { redirect: 'manual' })
check('the old descendant URL 301s', redirected.status === 301, `status=${redirected.status}`)
check(
  'it points at the new path',
  redirected.headers.get('location') === `${HTTP}/${renamedParent.slug}/${child.slug}`,
  redirected.headers.get('location'),
)

const withQuery = await fetch(`${HTTP}/${oldChildPath}?utm_source=e2e`, { redirect: 'manual' })
check(
  'the query string survives the redirect',
  withQuery.headers.get('location') ===
    `${HTTP}/${renamedParent.slug}/${child.slug}?utm_source=e2e`,
  withQuery.headers.get('location'),
)

/* --- an internal link needs none of this: it resolves directly ----------- */

const linker = await post('/stories', { title: 'Redirect E2E Linker' })
const conn = client(linker.id)
const doc = await conn.hello()
// demo's registry has no bare "link" block: a button's `href` is the
// multilink field, and a button only ever lives inside a `cta`'s `actions`
// slot (examples/demo/src/blocks/cta.tsx), so both land in one transaction.
await conn.tx('link1', [
  {
    t: 'insert',
    blok: {
      uid: 'ctalink1',
      type: 'cta',
      parent: doc.root,
      slot: 'body',
      order: 'a0',
      data: { heading: 'Links', body: '' },
    },
  },
  {
    t: 'insert',
    blok: {
      uid: 'linkblok1',
      type: 'button',
      parent: 'ctalink1',
      slot: 'actions',
      order: 'a0',
      data: { label: 'Go', href: { kind: 'story', id: child.id }, variant: 'primary' },
    },
  },
])

const preview = await fetch(`${HTTP}/${linker.path}?_folio=preview`).then((r) => r.text())
const newChildUrl = `/${renamedParent.slug}/${child.slug}`
check(
  'the internal link on another page points at the new path directly, no redirect',
  preview.includes(`href="${newChildUrl}"`),
  preview.match(/href="[^"]*"/g)?.join(', '),
)
conn.close()

/* --- deleting a page offers a redirect to its parent ---------------------- */

const delParent = await post('/stories', { title: 'Redirect E2E Delete Parent' })
const delChild = await post('/stories', {
  title: 'Redirect E2E Delete Child',
  parentId: delParent.id,
})

await fetch(`${API}/stories/${delChild.id}`, { method: 'DELETE' }) // redirect defaults to on

const afterDelete = await fetch(`${HTTP}/${delChild.path}`, { redirect: 'manual' })
check(
  'deleting with the redirect option left checked 301s the old path to its parent',
  afterDelete.status === 301 && afterDelete.headers.get('location') === `${HTTP}/${delParent.path}`,
  `status=${afterDelete.status} location=${afterDelete.headers.get('location')}`,
)

const noRedirectParent = await post('/stories', { title: 'Redirect E2E No-Redirect Parent' })
const noRedirectChild = await post('/stories', {
  title: 'Redirect E2E No-Redirect Child',
  parentId: noRedirectParent.id,
})
await fetch(`${API}/stories/${noRedirectChild.id}?redirect=false`, { method: 'DELETE' })
const afterUncheckedDelete = await fetch(`${HTTP}/${noRedirectChild.path}`, { redirect: 'manual' })
check(
  'unchecking the option writes no redirect: the path just 404s',
  afterUncheckedDelete.status === 404,
  `status=${afterUncheckedDelete.status}`,
)

/* --- a manual redirect, added by hand -------------------------------------- */

await post('/redirects', { from: 'redirect-e2e-summer-sale', to: 'redirect-e2e-offers' })
const manual = await fetch(`${HTTP}/redirect-e2e-summer-sale`, { redirect: 'manual' })
check(
  'a manual redirect fires',
  manual.status === 301 && manual.headers.get('location') === `${HTTP}/redirect-e2e-offers`,
  `status=${manual.status} location=${manual.headers.get('location')}`,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
