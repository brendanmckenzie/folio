// Exercises versioning end to end, including that a restore is expressed as a
// minimal set of mutations rather than a document overwrite.
//
// Imports diff.ts directly: Node strips types natively and that module has only
// type-only imports, so there is nothing to compile.
const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))

const HTTP = 'http://localhost:5199'
const API = `${HTTP}/folio`
const STORY = 'sty_home'
const HERO = 'hero0001'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())

function client(name, colour) {
  const ws = new WebSocket(`ws://localhost:5199/folio/story/${STORY}/socket`)
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
      ws.send(JSON.stringify({ type: 'hello', actor: name.toLowerCase(), name, colour, lastSyncId: 0 }))
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    send: (m) => ws.send(JSON.stringify(m)),
    expect(match, ms = 4000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error('timeout')), ms)
      })
    },
  }
}

await fetch(`${HTTP}/?_folio=preview`)

const alice = client('Alice', '#e5484d')
const doc0 = await alice.hello()
const root = doc0.root

// Durable Object state outlives a D1 reseed, so start from a known-empty page.
const leftovers = Object.values(doc0.bloks).filter((b) => b.parent === root)
if (leftovers.length) {
  alice.send({ type: 'tx', txId: 't0', mutations: leftovers.map((b) => ({ t: 'remove', uid: b.uid })) })
  await alice.expect((m) => m.type === 'delta' && m.txId === 't0')
  await wait(100)
}

/* --- known state, then a named checkpoint ------------------------------- */

alice.send({ type: 'tx', txId: 't1', mutations: [{ t: 'set', uid: root, field: 'title', value: 'Version One' }] })
await alice.expect((m) => m.type === 'delta' && m.txId === 't1')
await wait(120)

const cp = await json(`${API}/story/${STORY}/versions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'before rewrite', actor: 'Alice' }),
})
check('checkpoint created', cp.kind === 'checkpoint' && cp.label === 'before rewrite')
check('checkpoint captured the title', cp.title === 'Version One', cp.title)

/* --- change the title and add a block ----------------------------------- */

alice.send({
  type: 'tx',
  txId: 't2',
  mutations: [
    { t: 'set', uid: root, field: 'title', value: 'Version Two' },
    {
      t: 'insert',
      blok: {
        uid: HERO,
        type: 'hero',
        parent: root,
        slot: 'body',
        order: 'a0',
        data: { heading: 'Added later', align: 'left', eyebrow: '', body: '', image: '' },
      },
    },
  ],
})
await alice.expect((m) => m.type === 'delta' && m.txId === 't2')
await wait(120)

/* --- publishing writes a version automatically -------------------------- */

const pub = await json(`${API}/story/${STORY}/publish`, { method: 'POST' })
check('publish writes a version', pub.version?.kind === 'publish')
check('publish version has the current title', pub.version?.title === 'Version Two', pub.version?.title)

const list = await json(`${API}/story/${STORY}/versions`)
check('versions listed newest first', list[0]?.id === pub.version.id, list[0]?.kind)
check('both versions present', list.length >= 2, `n=${list.length}`)
check('list omits the doc payload', list.every((v) => v.doc === undefined))

/* --- restore, the way the admin does it --------------------------------- */

const { doc: target } = await json(`${API}/versions/${cp.id}`)
check('version doc fetchable', target?.root === root)
check('checkpoint predates the added block', target.bloks[HERO] === undefined)

const live = await client('Bob', '#0090ff').hello()
check('live doc contains the added block', live.bloks[HERO] !== undefined)

const mutations = diff(live, target)
check(
  'diff is minimal: one remove, one set',
  mutations.length === 2 &&
    mutations.some((m) => m.t === 'remove' && m.uid === HERO) &&
    mutations.some((m) => m.t === 'set' && m.field === 'title' && m.value === 'Version One'),
  JSON.stringify(mutations.map((m) => m.t)),
)

alice.send({ type: 'tx', txId: 't3', mutations })
await alice.expect((m) => m.type === 'delta' && m.txId === 't3')
await wait(150)

const draftHtml = await fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())
check('restore removed the later block', !draftHtml.includes('Added later'))
check('restore reverted the title', draftHtml.includes('Version One'))

/* --- restore is a normal edit: the published page is untouched ---------- */

const liveHtml = await fetch(`${HTTP}/`).then((r) => r.text())
check('published page unaffected until re-published', liveHtml.includes('Added later'))

/* --- diff round-trips -------------------------------------------------- */

const back = diff(target, live)
check('reverse diff restores the block', back.some((m) => m.t === 'insert' && m.blok.uid === HERO))
check('diff of identical docs is empty', diff(target, target).length === 0)

/* --- activity trail ---------------------------------------------------- */

const activity = await json(`${API}/story/${STORY}/activity`)
check('activity records transactions', activity.length >= 3, `n=${activity.length}`)
check('activity is newest first', activity[0].syncId > activity.at(-1).syncId)
check('activity carries the editor name', activity.some((e) => e.actorName === 'Alice'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
