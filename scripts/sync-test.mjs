const BASE = 'ws://localhost:5199/folio/story/sty_home/socket'
const HTTP = 'http://localhost:5199'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function client(name) {
  const ws = new WebSocket(BASE)
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
    name,
    ws,
    inbox,
    open: () => new Promise((r) => ws.addEventListener('open', r, { once: true })),
    send: (m) => ws.send(JSON.stringify(m)),
    expect(match, ms = 3000) {
      const hit = inbox.find(match)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error(`${name}: timeout waiting for message`)), ms)
      })
    },
  }
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

// Ensure the story exists before opening sockets.
await fetch(`${HTTP}/?_folio=preview`)

const a = client('A')
const b = client('B')
await Promise.all([a.open(), b.open()])

a.send({ type: 'hello', actor: 'aaa', name: 'A', colour: '#f00', lastSyncId: 0 })
const boot = await a.expect((m) => m.type === 'bootstrap')
check('A receives bootstrap', !!boot.doc?.root, `syncId=${boot.syncId}`)

b.send({ type: 'hello', actor: 'bbb', name: 'B', colour: '#00f', lastSyncId: 0 })
await b.expect((m) => m.type === 'bootstrap')

const peerSeen = await a.expect((m) => m.type === 'presence' && m.peer?.actor === 'bbb')
check('A sees B join', !!peerSeen)

// --- a mutation from A must reach B, and echo back to A as an ack ---
const root = boot.doc.root
const TITLE = 'Renamed by A'
a.send({ type: 'tx', txId: 'tx1', mutations: [{ t: 'set', uid: root, field: 'title', value: TITLE }] })

const deltaB = await b.expect((m) => m.type === 'delta' && m.txId === 'tx1')
check('B receives A mutation', deltaB.mutations[0].value === TITLE, `syncId=${deltaB.syncId}`)

const ackA = await a.expect((m) => m.type === 'delta' && m.txId === 'tx1')
check('A receives own tx as ack', ackA.syncId === deltaB.syncId)

// --- presence propagates ---
b.send({ type: 'presence', selection: root })
const pres = await a.expect((m) => m.type === 'presence' && m.peer?.selection === root)
check('presence selection propagates', !!pres)

// --- the DO persisted it: the SSR preview should now contain the new title ---
await wait(150)
const previewHtml = await fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())
check('draft persisted in DO', previewHtml.includes(TITLE))

// --- catchup: B disconnects, misses a tx, reconnects with its watermark ---
b.ws.close()
await wait(200)
a.send({ type: 'tx', txId: 'tx2', mutations: [{ t: 'set', uid: root, field: 'title', value: 'While B was away' }] })
const d2 = await a.expect((m) => m.type === 'delta' && m.txId === 'tx2')

const c = client('C')
await c.open()
c.send({ type: 'hello', actor: 'bbb', name: 'B', colour: '#00f', lastSyncId: deltaB.syncId })
const catchup = await c.expect((m) => m.type === 'catchup' || m.type === 'bootstrap')
check('reconnect gets catchup not bootstrap', catchup.type === 'catchup', `type=${catchup.type}`)
check(
  'catchup contains only missed deltas',
  catchup.deltas?.length === 1 && catchup.deltas[0].txId === 'tx2',
  `n=${catchup.deltas?.length}`,
)
check('catchup watermark advanced', catchup.syncId === d2.syncId)

// --- publish snapshots draft to D1 ---
const pub = await fetch(`${HTTP}/folio/story/sty_home/publish`, { method: 'POST' }).then((r) => r.json())
check('publish returns ok', pub.ok === true)
const liveHtml = await fetch(`${HTTP}/`).then((r) => r.text())
check('published page serves latest', liveHtml.includes('While B was away'))
check('published page ships no JS', !liveHtml.includes('<script'), liveHtml.match(/<script/g)?.length ?? 0)

a.ws.close()
c.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
