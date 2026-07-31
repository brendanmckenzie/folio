// Exercises data documents end to end
// (docs/specs/content-model/data-documents.md) against the demo's `person` and
// `office` record types, its `leadership` block (a `references()` field) and its
// `officeCard` block (a reference to a record with no renderer). See
// examples/demo/src/blocks/person.tsx.
//
// The load-bearing checks, in order of how much they would cost to get wrong:
//
//  1. A published page renders two hand-picked people IN THE CHOSEN ORDER, with
//     no `<script>` — the whole promise of resolving a `references()` field
//     server-side.
//  2. Reordering the field reorders the rendered page.
//  3. A record with NO renderer gives `content: null`, so the referencing block's
//     own fallback runs — the pattern checkpoint 2 promises works. Asserted by
//     rendering an office through `officeCard`.
//  4. `GET /documents/:id/usage` counts and names the published pages that point
//     at a record, counting a `references()` member as a usage. This is the
//     warning the delete confirmation shows.
//  5. Deleting a referenced person WARNS and PROCEEDS: the survivor still renders,
//     the deleted one leaves no hole, and the page is still live.
//  6. No path resolves to a record, and the page tree contains none of them, while
//     `GET /documents` lists them all with the `indexed` values the Data list
//     view's columns need.
//  7. An unpublished person appears in the Data list (the admin lists documents,
//     not published content) — the resolved open question.

import './lib/ts-resolve.mjs'

// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session. See scripts/lib/auth.mjs.
import { signInGlobally } from './lib/auth.mjs'

await signInGlobally()

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

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
const text = (url) => fetch(url).then((r) => r.text())

function client(name, storyId) {
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
      ws.send(
        JSON.stringify({
          type: 'hello',
          lastSyncId: 0,
          identity: { actor: name, name, colour: '#0090ff' },
          // Every frame carries the wire version, not only `hello`: the object
          // refuses a frame that omits it, and a refused frame looks like a hang.
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

const post = (path, body) =>
  json(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
const del = (path) => fetch(`${API}${path}`, { method: 'DELETE' })

const liveUrl = (story) => `${HTTP}/${story.path}`

/* --- two people and an office, as records -------------------------------- */

const ada = await post('/stories', { title: 'Ada Lovelace', type: 'person' })
const grace = await post('/stories', { title: 'Grace Hopper', type: 'person' })
const katherine = await post('/stories', { title: 'Katherine Johnson', type: 'person' })
const sydney = await post('/stories', { title: 'Sydney', type: 'office' })

check(
  'four records were created',
  Boolean(ada.id && grace.id && katherine.id && sydney.id),
  `${ada.id}, ${grace.id}, ${katherine.id}, ${sydney.id}`,
)
check(
  'a record has no path at all — that is what makes it a record',
  ada.path === null && sydney.path === null,
  `ada.path=${JSON.stringify(ada.path)}`,
)
check('and therefore no url', ada.url === undefined, `url=${JSON.stringify(ada.url)}`)

/** Fills a person's root fields and publishes them. */
async function fillPerson(story, { fullName, role, since, publish = true }) {
  const c = client(`p:${fullName}`, story.id)
  const doc = await c.hello()
  await c.tx(`rp${story.id}`, [
    { t: 'set', uid: doc.root, field: 'fullName', value: fullName },
    { t: 'set', uid: doc.root, field: 'role', value: role },
    { t: 'set', uid: doc.root, field: 'since', value: since },
  ])
  c.ws.close()
  if (publish) await post(`/story/${story.id}/publish`)
}

await fillPerson(ada, { fullName: 'Ada Lovelace', role: 'Analyst', since: '1843-01-01' })
await fillPerson(grace, { fullName: 'Grace Hopper', role: 'Rear Admiral', since: '1944-07-01' })
// Never published: the resolved open question says the Data list still shows her.
await fillPerson(katherine, {
  fullName: 'Katherine Johnson',
  role: 'Mathematician',
  since: '1953-06-01',
  publish: false,
})

const oc = client('office', sydney.id)
const officeDoc = await oc.hello()
await oc.tx('roffice', [
  { t: 'set', uid: officeDoc.root, field: 'city', value: 'Sydney' },
  { t: 'set', uid: officeDoc.root, field: 'address', value: '1 Macquarie Street' },
  { t: 'set', uid: officeDoc.root, field: 'phone', value: '02 9000 0000' },
  { t: 'set', uid: officeDoc.root, field: 'hours', value: 'Mon–Fri, 9–5' },
])
oc.ws.close()
await post(`/story/${sydney.id}/publish`)

/* --- no path resolves to a record --------------------------------------- */

const notFound = await fetch(`${HTTP}/ada-lovelace`)
check('no path resolves to a person', notFound.status === 404, `status ${notFound.status}`)

const tree = await json(`${API}/stories`)
const treeJson = JSON.stringify(tree)
check(
  'the page tree contains no records at all',
  !treeJson.includes(ada.id) && !treeJson.includes(sydney.id),
)

/* --- the Data list view's data ------------------------------------------- */

const people = await json(`${API}/documents?type=person&count=1`)
const personRow = (id) => people.rows.find((d) => d.id === id)
check(
  'GET /documents?type=person lists every person',
  people.rows.length === 3,
  `${people.rows.length} people`,
)
check(
  'and answers an exact total when asked, which is the list header\u2019s `Showing n of N`',
  people.total === 3,
  String(people.total),
)
check(
  'including the one nobody has published — the admin lists documents, not published content',
  Boolean(personRow(katherine.id)),
)
check(
  "and marks her state 'draft', which is the list view's Status column",
  personRow(katherine.id)?.state === 'draft',
  personRow(katherine.id)?.state,
)
// On the row rather than in a sibling map keyed by id: paging is what turned that
// from a preference into a rule, since a map covering one page's ids is a
// structure the client has to zip against `rows` (`DocumentRow`).
check(
  'the indexed values the columns read come back on the row itself',
  personRow(ada.id)?.indexed?.fullName?.text === 'Ada Lovelace' &&
    personRow(ada.id)?.indexed?.role?.text === 'Analyst',
  JSON.stringify(personRow(ada.id)?.indexed ?? null),
)
check(
  'a published record with nothing indexed yet has an empty object, so its cells read blank',
  Object.keys(personRow(katherine.id)?.indexed ?? { x: 1 }).length === 0,
)
check(
  'an ISO date field carries num as well as text, which is what `content_index` has two columns for',
  typeof personRow(ada.id)?.indexed?.since?.num === 'number',
  String(personRow(ada.id)?.indexed?.since?.num),
)
// The search box reaches `content_index`, which is what `filterRows` did
// client-side and what would have been silently lost when the search moved to the
// server: nothing in Ada's title contains "Analyst".
const byRole = await json(`${API}/documents?type=person&q=analyst`)
check(
  'the search box matches an indexed value the title does not contain',
  byRole.rows.length === 1 && byRole.rows[0].id === ada.id,
  JSON.stringify(byRole.rows.map((d) => d.id)),
)
// Sorting is the server's now, over `stories` columns only — `core/story.ts`'s
// `DocumentSort` argues why an `indexed` column is not one of them, and this is
// the refusal a client written against the old client-side sort meets.
const badSort = await fetch(`${API}/documents?type=person&sort=role`)
check('a sort naming an indexed field is refused, not silently ignored', badSort.status === 400)
const byTitle = await json(`${API}/documents?type=person&sort=title&dir=desc`)
check(
  'and `?dir=` reverses one that is supported',
  byTitle.rows[0].title >= byTitle.rows[byTitle.rows.length - 1].title,
  byTitle.rows.map((d) => d.title).join(' | '),
)

const offices = await json(`${API}/documents?type=office`)
check(
  'a second record type lists separately',
  offices.rows.length === 1 && offices.rows[0].id === sydney.id,
)

/* --- a page with a references() field ------------------------------------ */

const teamPage = await post('/stories', { title: 'Leadership' })
const tp = client('team', teamPage.id)
const teamDoc = await tp.hello()
await tp.tx('rteam1', [
  { t: 'set', uid: teamDoc.root, field: 'title', value: 'Leadership' },
  {
    t: 'insert',
    blok: {
      uid: 'rlead0001',
      type: 'leadership',
      parent: teamDoc.root,
      slot: 'body',
      order: 'a0',
      // Grace first, deliberately: the stored order is the rendered order, and
      // it is NOT alphabetical, so a page that happened to sort would fail here.
      data: { heading: 'Who we are', team: [grace.id, ada.id] },
    },
  },
  {
    t: 'insert',
    blok: {
      uid: 'roff00001',
      type: 'officeCard',
      parent: teamDoc.root,
      slot: 'body',
      order: 'a1',
      data: { office: sydney.id },
    },
  },
])
tp.ws.close()
await post(`/story/${teamPage.id}/publish`)

const page1 = await text(liveUrl(teamPage))
check(
  'the published page renders both hand-picked people',
  page1.includes('Ada Lovelace') && page1.includes('Grace Hopper'),
)
check(
  'in the editor’s chosen order, not alphabetically',
  page1.indexOf('Grace Hopper') < page1.indexOf('Ada Lovelace'),
)
check('and does not render the person nobody picked', !page1.includes('Katherine Johnson'))
check('with no client JavaScript at all', !page1.includes('<script'))
check(
  'each entry rendered through the record’s OWN renderer, so the card markup is not restated',
  (page1.match(/class="person"/g) ?? []).length === 2,
  `${(page1.match(/class="person"/g) ?? []).length} person figures`,
)
check(
  'a record with NO renderer gives content: null, so the block’s own fallback ran',
  page1.includes('1 Macquarie Street') && page1.includes('Mon–Fri, 9–5'),
)
check(
  'and the office is drawn by officeCard, not by a record renderer',
  page1.includes('class="office"'),
)

/* --- reordering ---------------------------------------------------------- */

const tp2 = client('team2', teamPage.id)
await tp2.hello()
// One `set` with the whole array — one mutation, and therefore one undo step.
await tp2.tx('rteam2', [{ t: 'set', uid: 'rlead0001', field: 'team', value: [ada.id, grace.id] }])
tp2.ws.close()
await post(`/story/${teamPage.id}/publish`)

const page2 = await text(liveUrl(teamPage))
check(
  'reordering the field reorders the published page',
  page2.indexOf('Ada Lovelace') < page2.indexOf('Grace Hopper'),
)

/* --- usage counts -------------------------------------------------------- */

const adaUsage = await json(`${API}/documents/${ada.id}/usage`)
check(
  'a references() member counts as a usage of the record',
  adaUsage.total === 1 && adaUsage.published[0]?.id === teamPage.id,
  JSON.stringify(adaUsage),
)
check(
  'and the usage names the page by its URL, decorated through the host’s own route()',
  adaUsage.published[0]?.url === `/${teamPage.path}`,
  adaUsage.published[0]?.url,
)
check('the kind is a reference, not a link', adaUsage.published[0]?.kind === 'reference')

const officeUsage = await json(`${API}/documents/${sydney.id}/usage`)
check('a plain reference() counts too', officeUsage.total === 1, JSON.stringify(officeUsage))

const katherineUsage = await json(`${API}/documents/${katherine.id}/usage`)
check(
  'a record nobody points at reports zero rather than erroring',
  katherineUsage.total === 0 && katherineUsage.published.length === 0,
)

// A second page referencing Ada, left UNPUBLISHED: the count must not move,
// which is the honesty caveat the dialog states out loud.
const draftPage = await post('/stories', { title: 'Draft Team' })
const dp = client('draft', draftPage.id)
const draftDoc = await dp.hello()
await dp.tx('rdraft1', [
  {
    t: 'insert',
    blok: {
      uid: 'rlead0002',
      type: 'leadership',
      parent: draftDoc.root,
      slot: 'body',
      order: 'a0',
      data: { team: [ada.id] },
    },
  },
])
dp.ws.close()

const adaUsage2 = await json(`${API}/documents/${ada.id}/usage`)
check(
  'an UNPUBLISHED reference does not count — published references only',
  adaUsage2.total === 1,
  `total ${adaUsage2.total}`,
)

/* --- delete warns, and proceeds ------------------------------------------ */

const deleted = await del(`/stories/${grace.id}`)
check('deleting a referenced record is allowed, not blocked', deleted.status === 200)

const page3 = await text(liveUrl(teamPage))
check('the referencing page is still live', page3.includes('Leadership'))
check('the survivor still renders', page3.includes('Ada Lovelace'))
check('the deleted person is gone', !page3.includes('Grace Hopper'))
check(
  'and leaves no hole: one person figure, not two with an empty one',
  (page3.match(/class="person"/g) ?? []).length === 1,
  `${(page3.match(/class="person"/g) ?? []).length} person figures`,
)
check('with still no client JavaScript', !page3.includes('<script'))

const afterDelete = await json(`${API}/documents?type=person`)
check(
  'and the Documents list is one shorter',
  afterDelete.rows.length === 2,
  `${afterDelete.rows.length} people`,
)

/* --- records publish and version like pages ------------------------------ */

// `.rows`: `GET /story/:id/versions` answers a `Page` since
// `foundation/pagination.md` phase 4 paged it.
const adaVersions = (await json(`${API}/story/${ada.id}/versions`)).rows
check(
  'a record has ordinary version history',
  Array.isArray(adaVersions) && adaVersions.some((v) => v.kind === 'publish'),
  `${adaVersions.length} versions`,
)

// A second publish, so there are two to list — the acceptance criterion about a
// record's History tab.
const ap = client('ada2', ada.id)
const adaDoc = await ap.hello()
await ap.tx('rada2', [{ t: 'set', uid: adaDoc.root, field: 'role', value: 'First programmer' }])
ap.ws.close()
await post(`/story/${ada.id}/publish`)

const adaVersions2 = (await json(`${API}/story/${ada.id}/versions`)).rows
check(
  'publishing twice retains two publish versions',
  adaVersions2.filter((v) => v.kind === 'publish').length >= 2,
  `${adaVersions2.filter((v) => v.kind === 'publish').length} publish versions`,
)

const page4 = await text(liveUrl(teamPage))
check(
  'republishing the RECORD updates the page that references it, with no page publish',
  page4.includes('First programmer'),
)

const adaIndexed = (await json(`${API}/documents?type=person`)).rows.find(
  (d) => d.id === ada.id,
)?.indexed
check(
  'and the Documents list column follows the same publish',
  adaIndexed?.role?.text === 'First programmer',
  adaIndexed?.role?.text,
)

/* --- duplicate ----------------------------------------------------------- */

const copy = await post(`/stories/${ada.id}/duplicate`, { title: 'Ada Lovelace (copy)' })
check(
  'a record duplicates like any document, still unrouted',
  copy.story?.id !== undefined && copy.story.path === null,
  JSON.stringify(copy.story?.path),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
