// Exercises versioning end to end, including that a restore is expressed as a
// minimal set of mutations rather than a document overwrite.
//
// Imports diff.ts and protocol.ts directly: Node strips types natively and
// both modules have only type-only imports, so there is nothing to compile.
const { diff } = await import(new URL('../packages/folio/src/core/diff.ts', import.meta.url))
const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

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
      ws.send(
        JSON.stringify({
          type: 'hello',
          actor: name.toLowerCase(),
          name,
          colour,
          lastSyncId: 0,
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    // Every frame carries the wire version, not only `hello` — the object
    // refuses any frame that omits it (test/workers/story-do.test.ts).
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
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
  alice.send({
    type: 'tx',
    txId: 't0',
    mutations: leftovers.map((b) => ({ t: 'remove', uid: b.uid })),
  })
  await alice.expect((m) => m.type === 'delta' && m.txId === 't0')
  await wait(100)
}

/* --- known state, then a named checkpoint ------------------------------- */

alice.send({
  type: 'tx',
  txId: 't1',
  mutations: [{ t: 'set', uid: root, field: 'title', value: 'Version One' }],
})
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
check(
  'publish version has the current title',
  pub.version?.title === 'Version Two',
  pub.version?.title,
)

const list = await json(`${API}/story/${STORY}/versions`)
check('versions listed newest first', list[0]?.id === pub.version.id, list[0]?.kind)
check('both versions present', list.length >= 2, `n=${list.length}`)
check(
  'list omits the doc payload',
  list.every((v) => v.doc === undefined),
)

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
check(
  'reverse diff restores the block',
  back.some((m) => m.t === 'insert' && m.blok.uid === HERO),
)
check('diff of identical docs is empty', diff(target, target).length === 0)

/* --- activity trail ---------------------------------------------------- */

const activity = await json(`${API}/story/${STORY}/activity`)
check('activity records transactions', activity.length >= 3, `n=${activity.length}`)
check('activity is newest first', activity[0].syncId > activity.at(-1).syncId)
check(
  'activity carries the editor name',
  activity.some((e) => e.actorName === 'Alice'),
)

/* --- unpublish takes the page down; the draft and history survive ------- */

const stillLive = await fetch(`${HTTP}/`)
check('the page serves before unpublish', stillLive.status !== 404, `status=${stillLive.status}`)

const beforeVersions = await json(`${API}/story/${STORY}/versions`)

const unpub = await json(`${API}/story/${STORY}/unpublish`, { method: 'POST' })
check('unpublish reports ok and a timestamp', unpub.ok === true && unpub.unpublishedAt > 0)

// 410, not 404: the demo consults folio.status in its miss branch, so a page
// taken down on purpose is Gone rather than merely absent. A path that never
// existed still answers 404 — that is the distinction folio.status buys.
const down = await fetch(`${HTTP}/`)
check('the unpublished page answers 410 Gone', down.status === 410, `status=${down.status}`)

const neverExisted = await fetch(`${HTTP}/no-such-page-ever`)
check(
  'a path that never existed still answers 404',
  neverExisted.status === 404,
  `status=${neverExisted.status}`,
)

const afterUnpublishVersions = await json(`${API}/story/${STORY}/versions`)
check(
  'unpublish writes no version: it is not a document snapshot',
  afterUnpublishVersions.length === beforeVersions.length,
  `before=${beforeVersions.length} after=${afterUnpublishVersions.length}`,
)

const draftAfterUnpublish = await fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())
check(
  'the draft survives unpublish, still previewable with the restored title',
  draftAfterUnpublish.includes('Version One'),
)

const secondUnpub = await json(`${API}/story/${STORY}/unpublish`, { method: 'POST' })
check(
  'unpublish is idempotent: a second call reports the same timestamp',
  secondUnpub.unpublishedAt === unpub.unpublishedAt,
)

/* --- publishing again is an ordinary publish ----------------------------- */

const pub3 = await json(`${API}/story/${STORY}/publish`, { method: 'POST' })
check(
  'republishing after unpublish writes a version like any other',
  pub3.version?.kind === 'publish',
)

const backUp = await fetch(`${HTTP}/`)
check('the page serves again once republished', backUp.status !== 404, `status=${backUp.status}`)

const finalVersions = await json(`${API}/story/${STORY}/versions`)
check(
  'republishing retained a further version',
  finalVersions.length === afterUnpublishVersions.length + 1,
  `n=${finalVersions.length}`,
)

/* --- unpublished-changes.md: the tree finds unpublished changes ---------- */

const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])

const bob = client('Bob', '#30a46c')
const bobDoc = await bob.hello()
check(
  'a second editor sees the same republished draft',
  bobDoc.bloks[root]?.data.title === 'Version One',
)

alice.send({
  type: 'tx',
  txId: 't4',
  mutations: [{ t: 'set', uid: root, field: 'title', value: 'Changed After Republish' }],
})
await alice.expect((m) => m.type === 'delta' && m.txId === 't4')
await bob.expect((m) => m.type === 'delta' && m.txId === 't4')

// The debounced watermark alarm (unpublished-changes.md's architecture
// decision 4) fires ~2s after the last logged transaction; give it a margin
// against a real dev server rather than a fake clock.
await wait(2500)

const treeAfterEdit = await json(`${API}/stories`)
const rowAfterEdit = flatten(treeAfterEdit).find((n) => n.id === STORY)
check(
  'the tree marks the story "changed" once the watermark catches up',
  rowAfterEdit?.state === 'changed',
  rowAfterEdit?.state,
)
check('hasUnpublishedChanges agrees', rowAfterEdit?.hasUnpublishedChanges === true)
check(
  'draftSyncId has moved past publishedSyncId',
  rowAfterEdit?.draftSyncId > rowAfterEdit?.publishedSyncId,
  `draft=${rowAfterEdit?.draftSyncId} published=${rowAfterEdit?.publishedSyncId}`,
)

/* --- compare: the draft against the newest publish version --------------- */

const versionsBeforeDiscard = await json(`${API}/story/${STORY}/versions`)
const newestPublish = versionsBeforeDiscard.find((v) => v.kind === 'publish')
check(
  'the newest publish version is the republish from earlier',
  newestPublish?.id === pub3.version.id,
)

const { doc: publishedDoc } = await json(`${API}/versions/${newestPublish.id}`)
const { doc: draftBeforeDiscard } = await json(`${API}/story/${STORY}/document`)
const compareMutations = diff(publishedDoc, draftBeforeDiscard)
check(
  'the comparison finds exactly the one title edit since publish',
  compareMutations.length === 1 &&
    compareMutations[0].t === 'set' &&
    compareMutations[0].value === 'Changed After Republish',
  JSON.stringify(compareMutations),
)

/* --- discard: diff(draft, published) applied as one ordinary transaction - */

const discardMutations = diff(draftBeforeDiscard, publishedDoc)
alice.send({ type: 'tx', txId: 't5', mutations: discardMutations })
await alice.expect((m) => m.type === 'delta' && m.txId === 't5')
await bob.expect((m) => m.type === 'delta' && m.txId === 't5')

const draftAfterDiscard = await fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())
check('the draft reads the published title again after discarding', draftAfterDiscard.includes('Version One'))
check(
  'the discarded edit is gone from the draft',
  !draftAfterDiscard.includes('Changed After Republish'),
)

const liveDuringDiscard = await fetch(`${HTTP}/`).then((r) => r.text())
check(
  'the live page never changed: discarding never published anything',
  liveDuringDiscard.includes('Version One'),
)

const activityAfterDiscard = await json(`${API}/story/${STORY}/activity`)
check(
  'the discard lands in the activity trail like any other transaction',
  activityAfterDiscard[0]?.mutations?.some((m) => m.t === 'set' && m.value === 'Version One'),
)

/* --- discard is undoable: it is an ordinary, invertible transaction ------ */

const { doc: docAfterDiscard } = await json(`${API}/story/${STORY}/document`)
const undoMutations = diff(docAfterDiscard, draftBeforeDiscard)
alice.send({ type: 'tx', txId: 't6', mutations: undoMutations })
await alice.expect((m) => m.type === 'delta' && m.txId === 't6')

const draftAfterUndo = await fetch(`${HTTP}/?_folio=preview`).then((r) => r.text())
check(
  'undoing the discard brings the edit back, as Cmd+Z would',
  draftAfterUndo.includes('Changed After Republish'),
)

await wait(2500)
const treeAfterUndo = await json(`${API}/stories`)
const rowAfterUndo = flatten(treeAfterUndo).find((n) => n.id === STORY)
check(
  'the tree marks it "changed" again once the undo is mirrored',
  rowAfterUndo?.state === 'changed',
  rowAfterUndo?.state,
)

bob.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
