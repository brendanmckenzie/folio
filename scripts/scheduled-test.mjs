// Exercises scheduled publish and unpublish end to end against a live dev server
// (docs/specs/platform/scheduled-publishing.md).
//
// **This is the script the feature exists for.** Everything else about scheduling
// can be asserted in workers tests with an injected clock; what only a live server
// proves is the part where nobody's browser is open — a real `Date.now()`, a real
// `POST /folio/api/schedules/run` standing in for the cron tick, the real
// `publish()` workflow behind it, and the host's own fetch handler serving the page
// afterwards.
//
// It waits on the wall clock in a few places, deliberately and briefly (~2s each).
// The route refuses to read `now` off a body — that would let a publisher bring
// every future schedule on the site forward — so a live test has to let time pass.
// The due-instant boundary itself is pinned with an injected `now` in
// packages/folio/test/workers/schedules.test.ts.
//
// The demo configures a real sign-in provider, so every route here needs a session:
// this signs in as the seeded admin and makes this process's `fetch` and
// `WebSocket` carry the cookie exactly as a browser does (scripts/lib/auth.mjs).
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`
const STORY = 'sty_home'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())

const postJson = (path, body) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** Schedule an action, returning `{ status, body }` so a refusal is inspectable. */
async function schedule(storyId, action, at) {
  const res = await postJson(`/story/${storyId}/schedule`, { action, at })
  return { status: res.status, body: await res.json() }
}

const cancel = (storyId, action) =>
  fetch(`${API}/story/${storyId}/schedule?action=${action}`, { method: 'DELETE' })

/** One sweep, which is what the host's `scheduled()` handler calls per cron tick. */
const sweep = (body) => postJson('/schedules/run', body).then((r) => r.json())

const listSchedules = (query = '') => json(`${API}/schedules${query}`)

function client(name, colour) {
  const ws = new WebSocket(`ws://localhost:5199/folio/api/story/${STORY}/socket`)
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
          lastSyncId: 0,
          identity: { actor: name.toLowerCase(), name, colour },
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    // Every frame carries the wire version, not only `hello` — the Durable Object
    // refuses a frame that omits it, and a refused frame looks like a hang.
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

// The preview touch is what creates the root story's Durable Object, exactly as
// history-test.mjs does.
await fetch(`${HTTP}/?_folio=preview`)

const alice = client('Alice', '#e5484d')
const doc0 = await alice.hello()
const root = doc0.root

// Durable Object state outlives a D1 reseed, so start from a known-empty page.
const leftovers = Object.values(doc0.bloks).filter((b) => b.parent === root)
if (leftovers.length) {
  alice.send({
    type: 'tx',
    txId: 's0',
    mutations: leftovers.map((b) => ({ t: 'remove', uid: b.uid })),
  })
  await alice.expect((m) => m.type === 'delta' && m.txId === 's0')
  await wait(100)
}

/** Sets the root block's title through the real transaction path. */
async function setTitle(txId, title) {
  alice.send({
    type: 'tx',
    txId,
    mutations: [{ t: 'set', uid: root, field: 'title', value: title }],
  })
  await alice.expect((m) => m.type === 'delta' && m.txId === txId)
}

/* --- input validation, before anything is written ------------------------ */

const past = await schedule(STORY, 'publish', Date.now() - 1000)
check(
  'a schedule in the past is a 400, not "publish immediately"',
  past.status === 400 && /Publish now instead/.test(past.body.error?.message ?? ''),
  `${past.status} ${past.body.error?.message ?? ''}`,
)

const silly = await schedule(STORY, 'archive', Date.now() + 60_000)
check(
  'an action nothing declares is a 400 naming the two that exist',
  silly.status === 400 && /publish, unpublish/.test(silly.body.error?.message ?? ''),
  `${silly.status}`,
)

const nowhere = await schedule('sty_nope', 'publish', Date.now() + 60_000)
check(
  'a schedule for a document that does not exist is a 404',
  nowhere.status === 404,
  `${nowhere.status}`,
)

const empty = await listSchedules()
check('nothing is scheduled yet', empty.rows.length === 0)

/* --- schedule, see it, replace it, cancel it ----------------------------- */

const soon = Date.now() + 600_000
const made = await schedule(STORY, 'publish', soon)
check(
  'scheduling a publish answers 201 with the row',
  made.status === 201 &&
    made.body.storyId === STORY &&
    made.body.action === 'publish' &&
    made.body.at === soon &&
    made.body.status === 'pending' &&
    /^sch_[0-9a-f]{12}$/.test(made.body.id ?? ''),
  JSON.stringify(made.body),
)

check(
  'the schedule records who asked, off the session',
  made.body.actor === 'usr_demoadmin1',
  String(made.body.actor),
)

const listed = await listSchedules('?count=1')
check(
  'the schedule is listable, which is what makes it trustworthy',
  listed.rows.length === 1 && listed.rows[0].id === made.body.id && listed.total === 1,
  JSON.stringify(listed.rows.map((r) => r.id)),
)

const byStory = await listSchedules(`?story=${STORY}`)
check('and filterable by document', byStory.rows.length === 1)
const other = await listSchedules('?story=sty_about')
check('a document with nothing scheduled lists nothing', other.rows.length === 0)

// Half a campaign window: same document, the other action.
const window = await schedule(STORY, 'unpublish', soon + 1000)
const both = await listSchedules()
check(
  'a publish and an unpublish coexist: that is a campaign window',
  window.status === 201 &&
    both.rows.length === 2 &&
    both.rows.map((r) => r.action).join(',') === 'publish,unpublish',
  JSON.stringify(both.rows.map((r) => r.action)),
)

const replaced = await schedule(STORY, 'publish', soon + 5000)
const afterReplace = await listSchedules('?action=publish')
check(
  'rescheduling replaces rather than queues, so "when" has one answer',
  replaced.status === 201 &&
    afterReplace.rows.length === 1 &&
    afterReplace.rows[0].id === replaced.body.id &&
    afterReplace.rows[0].at === soon + 5000,
  JSON.stringify(afterReplace.rows),
)

const vague = await fetch(`${API}/story/${STORY}/schedule`, { method: 'DELETE' })
check(
  'cancelling without naming an action is a 400, because a window has two',
  vague.status === 400,
  String(vague.status),
)

check(
  'cancelling one action leaves the other standing',
  (await (await cancel(STORY, 'unpublish')).json()).deleted === 1 &&
    (await listSchedules()).rows.length === 1,
)
check(
  'cancelling something never scheduled is 0, not a 404',
  (await (await cancel(STORY, 'unpublish')).json()).deleted === 0,
)
await cancel(STORY, 'publish')
check('the list is empty again', (await listSchedules()).rows.length === 0)

/* --- a sweep with nothing due ------------------------------------------- */

await schedule(STORY, 'publish', Date.now() + 600_000)
const notYet = await sweep()
check(
  'a sweep fires nothing that is not due yet',
  notYet.due === 0 && notYet.published.length === 0 && notYet.remaining === 0,
  JSON.stringify(notYet),
)
check(
  'and the page is still not live',
  (await fetch(`${HTTP}/`)).status === 404,
  String((await fetch(`${HTTP}/`)).status),
)
await cancel(STORY, 'publish')

/* --- the whole point: it happens with nobody watching -------------------- */

await setTitle('s1', 'Scheduled A')
await wait(100)

const due = await schedule(STORY, 'publish', Date.now() + 2000)
check('a publish is scheduled two seconds out', due.status === 201)

const early = await sweep()
check('a sweep a moment before is still a no-op', early.due === 0, JSON.stringify(early))

// The one real wait in this script: the schedule has to actually come due.
await wait(2500)

const fired = await sweep()
check(
  'the sweep fires it, reports the document, and clears the row',
  fired.published.length === 1 &&
    fired.published[0] === STORY &&
    fired.failed.length === 0 &&
    fired.remaining === 0,
  JSON.stringify(fired),
)
check('the row is gone rather than marked done', (await listSchedules()).rows.length === 0)

const live = await fetch(`${HTTP}/`)
const liveHtml = await live.text()
check(
  'the page is live and serves the scheduled content, with no browser involved',
  live.status === 200 && liveHtml.includes('Scheduled A'),
  `${live.status}`,
)

const versions = await json(`${API}/story/${STORY}/versions`)
const scheduledVersion = versions.rows[0]
check(
  'it retained a version attributed to whoever scheduled it, not to the cron',
  scheduledVersion?.kind === 'publish' && scheduledVersion?.actor === 'usr_demoadmin1',
  JSON.stringify({ kind: scheduledVersion?.kind, actor: scheduledVersion?.actor }),
)

/* --- a schedule survives a manual publish, and snapshots the draft late --- */

await setTitle('s2', 'Scheduled B')
await wait(100)
const standing = await schedule(STORY, 'publish', Date.now() + 2000)
check('a second publish is scheduled', standing.status === 201)

// Publish by hand, the way an editor who could not wait would.
await postJson(`/story/${STORY}/publish`)
const manual = await fetch(`${HTTP}/`)
check(
  'a manual publish goes live immediately',
  (await manual.text()).includes('Scheduled B'),
  String(manual.status),
)
check(
  'and leaves the schedule standing: a schedule is an instruction about the future',
  (await listSchedules()).rows.length === 1,
)

// Now edit again. The scheduled publish must snapshot the draft as it stands *when
// it fires*, which is the whole reason cancelling on the editor's behalf would be
// wrong — these edits would silently never have gone live.
await setTitle('s3', 'Scheduled C')
await wait(2500)

const late = await sweep()
check('the standing schedule fires on time', late.published[0] === STORY, JSON.stringify(late))
const afterLate = await fetch(`${HTTP}/`)
check(
  'and publishes the draft as it stood when it fired, not when it was scheduled',
  (await afterLate.text()).includes('Scheduled C'),
)

/* --- scheduled unpublish: an embargo ending ------------------------------ */

const embargo = await schedule(STORY, 'unpublish', Date.now() + 2000)
check('an unpublish is scheduled two seconds out', embargo.status === 201)
await wait(2500)

const down = await sweep()
check(
  'the sweep takes the page down and names it',
  down.unpublished.length === 1 && down.unpublished[0] === STORY && down.published.length === 0,
  JSON.stringify(down),
)
const gone = await fetch(`${HTTP}/`)
check(
  'the host answers 410 for a page deliberately taken down, not 404',
  gone.status === 410,
  String(gone.status),
)
check('and the row is cleared', (await listSchedules()).rows.length === 0)

const stillEditable = await json(`${API}/story/${STORY}/document`)
check(
  'the draft is untouched, so a scheduled unpublish loses no work',
  stillEditable.doc?.bloks?.[root]?.data?.title === 'Scheduled C',
)

/* --- dry run ------------------------------------------------------------- */

await schedule(STORY, 'publish', Date.now() + 1500)
await wait(2000)
const dry = await sweep({ dryRun: true })
check(
  'a dry run reports the intent and writes nothing',
  dry.dryRun === true && dry.published[0] === STORY,
  JSON.stringify(dry),
)
check('the row is still pending after a dry run', (await listSchedules()).rows.length === 1)
check('and the page is still down', (await fetch(`${HTTP}/`)).status === 410)
await cancel(STORY, 'publish')

/* --- a schedule does not outlive its story ------------------------------- */

const created = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Doomed Campaign' }),
})
await schedule(created.id, 'publish', Date.now() + 600_000)
check(
  'a new document can be scheduled',
  (await listSchedules(`?story=${created.id}`)).rows.length === 1,
)

await fetch(`${API}/stories/${created.id}`, { method: 'DELETE' })
check(
  'deleting the document takes its schedule with it, unlike a redirect',
  (await listSchedules()).rows.length === 0,
)

/* --- batching ------------------------------------------------------------ */

const a = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Batch One' }),
})
const b = await json(`${API}/stories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Batch Two' }),
})
const at = Date.now() + 1500
await schedule(a.id, 'publish', at)
await schedule(b.id, 'publish', at + 100)
await wait(2000)

const firstBatch = await sweep({ batch: 1 })
check(
  'one call fires one schedule and answers a cursor',
  firstBatch.published.length === 1 && firstBatch.continueFrom !== null,
  JSON.stringify(firstBatch),
)
const secondBatch = await sweep({ batch: 1, continueFrom: firstBatch.continueFrom })
check(
  'and the next call finishes the backlog, which is what a `scheduled()` loop does',
  secondBatch.published.length === 1 && secondBatch.continueFrom === null,
  JSON.stringify(secondBatch),
)
check('both documents are live', (await listSchedules()).rows.length === 0)

const badCursor = await fetch(`${API}/schedules?cursor=not-a-cursor`)
check(
  'a malformed cursor is a 400, never a silent first page',
  badCursor.status === 400,
  String(badCursor.status),
)

alice.ws.close()

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
if (passed !== results.length) process.exitCode = 1
