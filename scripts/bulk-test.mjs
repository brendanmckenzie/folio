// Exercises platform/bulk-writes.md end to end against a live dev server: the five
// actions over both kinds of selection, the count guard, the ceiling, and the batched
// job walked to exhaustion by cursor.
//
// **The property no unit test can give is the guard racing a real write.** A workers
// test creates a row and calls the runner in the same isolate, so "the world moved"
// is something it stages. Here the number comes off a real list header
// (`?count=1`), a second real request creates a page between reading it and pressing
// the button, and the refusal comes back over HTTP with the *new* count in it — which
// is the whole of what makes a refusal a door rather than a wall.
//
// It also proves the two things that only exist once the routes are mounted: every
// action's gate is the one its single-document twin carries (so `/bulk/delete` is a
// publisher's route, not an editor's), and a batched run reaches every document
// without the caller knowing how many batches that took.
//
// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session. This signs in as the seeded admin and makes this
// process's `fetch` carry the cookie exactly as a browser does — see
// scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const API = `${BASE}/api`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

const json = (url, init) => fetch(url, init).then((r) => r.json())
const get = (path) => json(`${API}${path}`)

/** A bulk call, returning `{ status, body }` so a refusal is inspectable. */
async function bulk(action, body) {
  const res = await fetch(`${API}/bulk/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const createPage = (title, parentId = null) =>
  json(`${API}/stories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
  })

/** How many routed pages match a filter, read the way a list header reads it. */
const headerCount = async (query = '') =>
  (await get(`/stories?flat=1&count=1&limit=1${query}`)).total

/**
 * Runs a job to completion the way a host or a screen does: loop on `continueFrom`,
 * sum `done` yourself. Returns the totals plus how many calls it took.
 */
async function runToCompletion(action, body) {
  let cursor = null
  let done = 0
  let failed = 0
  let calls = 0
  for (let guard = 0; guard < 100; guard++) {
    const { status, body: report } = await bulk(action, {
      ...body,
      ...(cursor === null ? {} : { continueFrom: cursor }),
    })
    if (status !== 200)
      throw new Error(`bulk ${action} answered ${status}: ${JSON.stringify(report)}`)
    calls++
    done += report.done
    failed += report.failed.length
    cursor = report.continueFrom
    if (cursor === null) return { done, failed, calls, last: report }
  }
  throw new Error(`bulk ${action} never finished`)
}

/* --- enough rows to need several batches ----------------------------------- */

// Twelve pages, deliberately not a multiple of the batch size used below: a run
// whose length is exactly `n * batch` hides an off-by-one in the last-batch
// condition, because the final call comes back empty either way.
const MADE = []
for (let i = 0; i < 12; i++) MADE.push(await createPage(`Bulk ${String(i).padStart(2, '0')}`))
check(
  'created twelve pages to act on',
  MADE.every((row) => row.id),
  `first=${MADE[0]?.id}`,
)

const before = await headerCount()
check(
  'the list header answers a count, which is what a selection captures',
  before >= 12,
  `n=${before}`,
)

/* --- the count guard, racing a real write ---------------------------------- */

const expected = before
// The race, staged over HTTP the way it happens: somebody else creates a page
// between the number being read and the button being pressed.
const intruder = await createPage('Created while you were reading the number')
const refused = await bulk('publish', {
  selection: { all: true, filter: { routed: true }, expected },
})
check(
  'a count mismatch is refused rather than applied to a different set',
  refused.status === 409 && refused.body.refused === 'count',
  `status=${refused.status} refused=${refused.body.refused}`,
)
check(
  'the refusal carries the new count, so re-confirming is one click',
  refused.body.expected === expected && refused.body.actual === expected + 1,
  `expected=${refused.body.expected} actual=${refused.body.actual}`,
)
check(
  'and it still answers the one error envelope, so a generic client shows a sentence',
  refused.body.error?.code === 'conflict' && typeof refused.body.error?.message === 'string',
  refused.body.error?.message ?? 'no message',
)
check(
  'a refusal writes nothing at all',
  (await headerCount('&state=live')) === 0,
  `live=${await headerCount('&state=live')}`,
)

/* --- re-confirming at the new count, in batches ---------------------------- */

const now = await headerCount()
const publish = await runToCompletion('publish', {
  selection: { all: true, filter: { routed: true }, expected: now },
  batch: 5,
})
check(
  're-confirming at the new count publishes every matching document',
  publish.done === now && publish.failed === 0,
  `done=${publish.done} of ${now} in ${publish.calls} calls`,
)
check(
  'and it took several batches, which is the point of the cursor',
  publish.calls > 1,
  `calls=${publish.calls}`,
)
check(
  'every page is live afterwards, read back from the list',
  (await headerCount('&state=live')) === now,
  `live=${await headerCount('&state=live')} of ${now}`,
)
check(
  'the report tracks the job, not the call',
  publish.last.total === now && publish.last.seen === now,
  `total=${publish.last.total} seen=${publish.last.seen}`,
)

/* --- the ceiling: a job never does more than was agreed -------------------- */

const agreed = await headerCount('&state=live')
const firstBatch = await bulk('unpublish', {
  selection: { all: true, filter: { routed: true, state: 'live' }, expected: agreed },
  batch: 2,
})
check('a batched unpublish starts', firstBatch.status === 200 && firstBatch.body.done === 2)

// Two more live pages appear mid-job — pages nobody agreed to take down.
const extraOne = await createPage('Late live one')
const extraTwo = await createPage('Late live two')
for (const row of [extraOne, extraTwo]) {
  await fetch(`${API}/story/${row.id}/publish`, { method: 'POST' })
}

let cursor = firstBatch.body.continueFrom
let unpublished = firstBatch.body.done
for (let guard = 0; guard < 100 && cursor !== null; guard++) {
  const { body: report } = await bulk('unpublish', {
    selection: { all: true, filter: { routed: true, state: 'live' }, expected: agreed },
    batch: 2,
    continueFrom: cursor,
  })
  unpublished += report.done
  cursor = report.continueFrom
}
check(
  'the count is the ceiling: a set that grew mid-job does not enlarge the run',
  unpublished === agreed,
  `unpublished=${unpublished} agreed=${agreed}`,
)
// Two, and *which* two is deliberately not asserted: the run walks by id and the
// pages published mid-job have random ids, so either of them may have fallen inside
// the window. What the ceiling guarantees is the number, which is the number the
// operator agreed to.
check(
  'so exactly two pages are still live, the run having stopped at the agreed number',
  (await headerCount('&state=live')) === 2,
  `live=${await headerCount('&state=live')}`,
)

/* --- exclusions ------------------------------------------------------------ */

// Two pages of their own, narrowed by `q` so the selection is exactly them — which
// also proves a search term survives being captured in a filter and re-run
// server-side, since `countStories` and the walk both go through `storyFilters`.
const keepers = [await createPage('Excludable one'), await createPage('Excludable two')]
for (const row of keepers) await fetch(`${API}/story/${row.id}/publish`, { method: 'POST' })

const excludableLive = await headerCount('&state=live&q=Excludable')
const excluded = await bulk('unpublish', {
  selection: {
    all: true,
    filter: { routed: true, state: 'live', q: 'Excludable' },
    expected: excludableLive,
    exclude: [keepers[1].id],
  },
})
check(
  'an exclusion is subtracted from the ceiling and never read',
  excludableLive === 2 && excluded.body.total === 1 && excluded.body.done === 1,
  `matched=${excludableLive} total=${excluded.body.total} done=${excluded.body.done}`,
)
const spared = (await get(`/stories?ids=${keepers[1].id}`)).rows[0]
check(
  'and the excluded page is untouched',
  spared?.state === 'live',
  `state=${spared?.state} id=${keepers[1].id}`,
)

/* --- an explicit id list --------------------------------------------------- */

const three = MADE.slice(0, 3).map((row) => row.id)
const byId = await runToCompletion('publish', { selection: { ids: three }, batch: 2 })
check(
  'an explicit id list is the same endpoint, paged the same way',
  byId.done === 3 && byId.calls === 2,
  `done=${byId.done} calls=${byId.calls}`,
)

const stale = await bulk('publish', { selection: { ids: ['sty_does_not_exist', three[0]] } })
check(
  'an id nothing is behind is one named failure, not a failed request',
  stale.status === 200 && stale.body.done === 1 && stale.body.failed.length === 1,
  JSON.stringify(stale.body.failed),
)

/* --- move ------------------------------------------------------------------ */

const section = await createPage('Section')
const movers = MADE.slice(3, 6).map((row) => row.id)
const moved = await bulk('move', { selection: { ids: movers }, parentId: section.id })
check(
  'a bulk move reports every document',
  moved.body.done === 3,
  JSON.stringify(moved.body.failed),
)

const children = await get(`/stories?parentId=${section.id}&limit=50`)
const childIds = children.rows.map((row) => row.id)
check(
  'the set lands under the destination in the order it was walked, not reversed',
  JSON.stringify(childIds) === JSON.stringify(movers),
  `${childIds.join(',')} vs ${movers.join(',')}`,
)
check(
  'and every path was recomputed from the new parent',
  children.rows.every((row) => row.path?.startsWith('section/')),
  children.rows.map((row) => row.path).join(' '),
)

const cycle = await bulk('move', { selection: { ids: [section.id] }, parentId: movers[0] })
check(
  'a tree rule refuses one document and names it, without failing the batch',
  cycle.status === 200 && cycle.body.failed.length === 1 && cycle.body.done === 0,
  JSON.stringify(cycle.body.failed),
)
check(
  'and the refusal is prose, never D1’s own constraint text',
  !JSON.stringify(cycle.body.failed).includes('constraint'),
)

/* --- duplicate ------------------------------------------------------------- */

const dup = await bulk('duplicate', { selection: { ids: MADE.slice(6, 8).map((row) => row.id) } })
check('a bulk duplicate copies each document', dup.body.done === 2, JSON.stringify(dup.body.failed))
const copies = await get('/stories?flat=1&q=(copy)&limit=50')
check(
  'each copy exists as its own page, titled from the source',
  copies.rows.length === 2,
  copies.rows.map((row) => row.title).join(' · '),
)
const dupAll = await bulk('duplicate', {
  selection: { all: true, filter: { routed: true }, expected: await headerCount() },
})
check(
  'duplicating a select-all is refused: a copy joins the set it is walking',
  dupAll.status === 400,
  `status=${dupAll.status} ${dupAll.body.error?.message ?? ''}`,
)

/* --- delete, and the redirects it leaves ----------------------------------- */

const doomed = MADE[8]
const doomedChild = await createPage('Beneath the doomed', doomed.id)
const deleted = await bulk('delete', { selection: { ids: [doomed.id] } })
check('a bulk delete reports the documents it removed', deleted.body.done === 1)
check(
  'the whole subtree goes, exactly as a single delete does',
  (await get(`/stories?ids=${doomed.id},${doomedChild.id}`)).rows.length === 0,
)
const redirects = await get('/redirects?limit=100')
const left = redirects.rows.filter(
  (row) => row.from === doomed.path || row.from === doomedChild.path,
)
check(
  'and it leaves the redirects a single delete would (redirect defaults to true)',
  left.length === 2,
  left.map((row) => `${row.from}→${row.to}`).join(' '),
)

const noRedirect = MADE[9]
await bulk('delete', { selection: { ids: [noRedirect.id] }, redirect: false })
const after = await get('/redirects?limit=100')
check(
  'and `redirect: false` is the escape hatch for a page that should genuinely 404',
  after.rows.every((row) => row.from !== noRedirect.path),
)

const root = await bulk('delete', { selection: { ids: ['sty_home'] } })
check(
  'the root is refused per document rather than 500ing the run',
  root.status === 200 && root.body.failed[0]?.message?.includes('root'),
  JSON.stringify(root.body.failed),
)

/* --- dry run and input refusals -------------------------------------------- */

const liveBefore = await headerCount('&state=live')
const dry = await bulk('publish', {
  selection: { all: true, filter: { routed: true }, expected: await headerCount() },
  dryRun: true,
})
check(
  'a dry run tallies the intent and writes nothing',
  dry.body.dryRun === true &&
    dry.body.done > 0 &&
    (await headerCount('&state=live')) === liveBefore,
  `done=${dry.body.done} live=${await headerCount('&state=live')}`,
)

const mixed = await bulk('publish', {
  selection: { ids: [MADE[0].id], all: true, filter: {}, expected: 1 },
})
check(
  'a selection that is both an id list and a filter is refused, not reconciled',
  mixed.status === 400,
  `status=${mixed.status}`,
)
const noDestination = await bulk('move', { selection: { ids: [MADE[0].id] } })
check('a move with no destination is a 400', noDestination.status === 400)
const badCursor = await bulk('publish', {
  selection: { ids: [MADE[0].id] },
  continueFrom: 'not-a-cursor',
})
check('a malformed cursor is a 400, never a silent restart', badCursor.status === 400)
const empty = await bulk('publish', { selection: { ids: [] } })
check('an empty selection is a 400', empty.status === 400)

/* --- the surface ----------------------------------------------------------- */

const versioned = await fetch(`${API}/v1/bulk/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ selection: { ids: [MADE[0].id] } }),
})
check(
  'nothing lands under /api/v1: a version segment is a promise',
  versioned.status === 404,
  `status=${versioned.status}`,
)
const bare = await fetch(`${BASE}/bulk/publish`, { method: 'POST' })
check(
  'and the bare path is not a second door onto it',
  bare.status !== 200,
  `status=${bare.status}`,
)

// The intruder page is left behind on purpose: e2e.sh wipes the database anyway,
// and asserting a clean-up here would be asserting this script rather than Folio.
check('the intruder page still exists, having never been in any selection', Boolean(intruder.id))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
