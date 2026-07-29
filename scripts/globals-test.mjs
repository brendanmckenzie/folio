// Exercises globals end to end (docs/specs/content-model/globals.md) against
// the demo's `header` singleton, which the demo's <Page> renders on every
// page via `folio.renderGlobal(resolution, 'header')` — see
// examples/demo/src/index.tsx and examples/demo/src/blocks/header.tsx.
//
// The load-bearing checks: a header published once appears on two unrelated
// pages from the same D1 read (never a per-page copy); a page's *preview*
// shows the header's draft while its *live* render still shows the last
// published one; publishing the header updates every live page at once; and
// restoring an old header version lands as one ordinary transaction, exactly
// like restoring a page does (history-test.mjs).

import './lib/ts-resolve.mjs'

const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))
const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())

function client(name, storyId) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${storyId}/socket`)
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
      ws.send(
        JSON.stringify({
          type: 'hello',
          actor: name,
          name,
          colour: '#0090ff',
          lastSyncId: 0,
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
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
        setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), ms)
      })
    },
  }
}

/* --- two ordinary pages, published, so there is something to check twice - */

const pageA = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Globals Page A' }),
})
const pageB = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Globals Page B' }),
})
await fetch(`${API}/story/${pageA.id}/publish`, { method: 'POST' })
await fetch(`${API}/story/${pageB.id}/publish`, { method: 'POST' })

const liveUrl = (page) => `${HTTP}/${page.path}`
const previewUrl = (page) => `${HTTP}/${page.path}?_folio=preview`

/* --- before anything is published for the header, neither page shows one - */

const beforeA = await fetch(liveUrl(pageA)).then((r) => r.text())
const beforeB = await fetch(liveUrl(pageB)).then((r) => r.text())
check(
  'before the header is published, neither live page carries its wrapper',
  !beforeA.includes('data-folio-global="header"') &&
    !beforeB.includes('data-folio-global="header"'),
)
check(
  'a published page ships no <script> — globals do not change the zero-JS rule',
  !beforeA.includes('<script') && !beforeB.includes('<script'),
)

/* --- the header singleton: created by asking, same as document-types.md -- */

const headerDocs = await json(`${API}/documents?type=header`)
const header = headerDocs.documents?.[0]
check('the header singleton exists under its derived id', header?.id === 'sng_header', header?.id)

const ed = client('globals-editor', header.id)
const doc0 = await ed.hello()
const root = doc0.root

await ed.tx('g1', [{ t: 'set', uid: root, field: 'logoText', value: 'Acme Draft One' }])

/* --- draft: both previews show it, both live pages still do not --------- */

const previewA1 = await fetch(previewUrl(pageA)).then((r) => r.text())
const previewB1 = await fetch(previewUrl(pageB)).then((r) => r.text())
check(
  'both page previews show the header draft',
  previewA1.includes('Acme Draft One') && previewB1.includes('Acme Draft One'),
)
check(
  'both page previews carry the stable data-folio-global wrapper',
  previewA1.includes('data-folio-global="header"') &&
    previewB1.includes('data-folio-global="header"'),
)

const liveA1 = await fetch(liveUrl(pageA)).then((r) => r.text())
const liveB1 = await fetch(liveUrl(pageB)).then((r) => r.text())
check(
  'neither live page shows the unpublished draft',
  !liveA1.includes('Acme Draft One') && !liveB1.includes('Acme Draft One'),
)

/* --- publish: both live pages update from the one write ------------------ */

const pub1 = await json(`${API}/story/${header.id}/publish`, { method: 'POST' })
check('publishing the header writes a version', pub1.version?.kind === 'publish')

const liveA2 = await fetch(liveUrl(pageA)).then((r) => r.text())
const liveB2 = await fetch(liveUrl(pageB)).then((r) => r.text())
check(
  'both live pages now show the published header',
  liveA2.includes('Acme Draft One') && liveB2.includes('Acme Draft One'),
)
check(
  'still no <script> on either live page',
  !liveA2.includes('<script') && !liveB2.includes('<script'),
)

/* --- a second draft edit repeats the same draft/live split --------------- */

await ed.tx('g2', [{ t: 'set', uid: root, field: 'logoText', value: 'Acme Draft Two' }])

const previewA2 = await fetch(previewUrl(pageA)).then((r) => r.text())
check('the second draft reaches both previews', previewA2.includes('Acme Draft Two'))

const liveA3 = await fetch(liveUrl(pageA)).then((r) => r.text())
check(
  'the live page still shows the first publish, not the new draft',
  liveA3.includes('Acme Draft One') && !liveA3.includes('Acme Draft Two'),
)

await fetch(`${API}/story/${header.id}/publish`, { method: 'POST' })
const liveA4 = await fetch(liveUrl(pageA)).then((r) => r.text())
check(
  'publishing again updates the live page to the newest draft',
  liveA4.includes('Acme Draft Two'),
)

/* --- restoring an old header version is one ordinary transaction --------- */

const versions = await json(`${API}/story/${header.id}/versions`)
const firstPublish = versions.find((v) => v.id === pub1.version.id)
check('the first publish is still in the header’s own history', Boolean(firstPublish))

const { doc: target } = await json(`${API}/versions/${firstPublish.id}`)
const { doc: liveHeaderDoc } = await json(`${API}/story/${header.id}/document`)
const mutations = diff(liveHeaderDoc, target)
check(
  'restoring is a minimal diff, not a document overwrite',
  mutations.length === 1 && mutations[0].t === 'set' && mutations[0].value === 'Acme Draft One',
  JSON.stringify(mutations),
)

await ed.tx('g3', mutations)

const previewA3 = await fetch(previewUrl(pageA)).then((r) => r.text())
check(
  'the restore lands as one transaction, reflected immediately in preview',
  previewA3.includes('Acme Draft One') && !previewA3.includes('Acme Draft Two'),
)
check(
  'restoring the header did not touch the live page (still unpublished)',
  liveA4.includes('Acme Draft Two'),
)

ed.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
