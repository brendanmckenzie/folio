// Exercises foundation/pagination.md end to end against a live dev server: the
// tree pages one level at a time, a cursor walked to exhaustion sees every row
// exactly once, the count is opt-in, flat mode's three sorts each partition the
// set, and a batch by id answers the breadcrumb's whole requirement in one
// request.
//
// The property no unit test can give: this runs against **real D1**, so the
// `order by` and the `where` fragment that resumes after a cursor are checked
// against SQLite's own comparison rather than against a mock. The tie on `ord` and
// the null draft watermark are both cases where a wrong operator produces a list
// that is quietly missing something instead of an error.
//
// Imported directly: Node strips types natively and this module has only a runtime
// const with no value imports of its own, so there is nothing to resolve at
// runtime.
// The demo configures a real sign-in provider (identity-and-access.md), so every
// route here needs a session. This signs in as the seeded admin and makes this
// process's `fetch` carry the cookie, exactly as a browser does — see
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
const post = (path, body) =>
  json(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Walks a cursor to exhaustion, returning every row in the order seen. */
async function walk(path, limit) {
  const seen = []
  let cursor = null
  for (let guard = 0; guard < 200; guard++) {
    const sep = path.includes('?') ? '&' : '?'
    const url = cursor
      ? `${path}${sep}limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${path}${sep}limit=${limit}`
    const page = await get(url)
    if (!page.rows) throw new Error(`no rows in ${url}: ${JSON.stringify(page).slice(0, 200)}`)
    if (page.rows.length > limit) throw new Error(`${url} returned more than ${limit} rows`)
    seen.push(...page.rows)
    cursor = page.cursor
    if (!cursor) return seen
  }
  throw new Error(`cursor never exhausted for ${path}`)
}

/* --- enough rows to need three pages --------------------------------------- */

// Seven top-level pages and five children, so a limit of 3 needs three pages of
// the top level and two of the child level. Deliberately more than one page and
// not a round multiple of the limit: a walk that is exactly `n * limit` long hides
// an off-by-one in the last-page condition, because the final page comes back
// empty either way.
const TOP = 7
const KIDS = 5

const parent = await post('/stories', { title: 'Paging E2E Parent' })
for (let i = 1; i < TOP; i++) {
  await post('/stories', { title: `Paging E2E Top ${String(i).padStart(2, '0')}` })
}
for (let i = 0; i < KIDS; i++) {
  await post('/stories', {
    title: `Paging E2E Kid ${String(i).padStart(2, '0')}`,
    parentId: parent.id,
  })
}

/* --- the tree pages one level at a time ------------------------------------ */

const firstLevel = await get('/stories?limit=3&count=1')
check(
  'the top level answers at most `limit` rows and a cursor',
  firstLevel.rows.length === 3 && firstLevel.cursor !== null,
  `rows=${firstLevel.rows.length} cursor=${firstLevel.cursor === null ? 'null' : 'set'}`,
)
check(
  'a count is answered when asked for, over the whole level',
  firstLevel.total >= TOP,
  `total=${firstLevel.total}`,
)
check(
  'no count key at all when it was not asked for',
  (await get('/stories?limit=3')).total === undefined,
)

const topWalk = await walk('/stories', 3)
const topIds = topWalk.map((r) => r.id)
check(
  'walking the top level sees every row exactly once',
  new Set(topIds).size === topIds.length && topIds.length === firstLevel.total,
  `seen=${topIds.length} distinct=${new Set(topIds).size} total=${firstLevel.total}`,
)
check(
  'every row of the page tree is routed — records are not in it',
  topWalk.every((r) => r.path !== null),
)

const kidWalk = await walk(`/stories?parentId=${parent.id}`, 2)
check(
  'expanding a node requests only that node’s children',
  kidWalk.length === KIDS && kidWalk.every((r) => r.parentId === parent.id),
  `rows=${kidWalk.length}`,
)
check(
  'a child count comes with the row, so a twisty needs no extra request',
  topWalk.find((r) => r.id === parent.id)?.childCount === KIDS,
  `childCount=${topWalk.find((r) => r.id === parent.id)?.childCount}`,
)
check(
  'a leaf reports no children rather than being indistinguishable from a parent',
  kidWalk.every((r) => r.childCount === 0),
)

const empty = await get(`/stories?parentId=${kidWalk[0].id}`)
check(
  'a parent with no children is an empty page, not a 404',
  Array.isArray(empty.rows) && empty.rows.length === 0 && empty.cursor === null,
)

/* --- paging is stable under a concurrent write ----------------------------- */

// The reason keyset rather than offset, and the one assertion that needs a live
// server: with `offset`, a row inserted above the cursor shifts everything down
// and page two repeats page one's last row.
const before = await get('/stories?limit=3')
await post('/stories', { title: 'Paging E2E Intruder' })
const after = await get(`/stories?limit=3&cursor=${encodeURIComponent(before.cursor)}`)
check(
  'a row inserted mid-walk repeats nothing from the previous page',
  after.rows.every((r) => !before.rows.some((b) => b.id === r.id)),
  `overlap=${after.rows.filter((r) => before.rows.some((b) => b.id === r.id)).length}`,
)

/* --- flat mode's three sorts ----------------------------------------------- */

for (const sort of ['edited', 'title', 'path']) {
  const rows = await walk(`/stories?flat=1&sort=${sort}`, 3)
  const ids = rows.map((r) => r.id)
  check(
    `flat mode’s sort=${sort} partitions the set, every row exactly once`,
    new Set(ids).size === ids.length && ids.length >= TOP + KIDS,
    `seen=${ids.length} distinct=${new Set(ids).size}`,
  )
}

// The whole reason `sort=edited` is a `coalesce`. A page created seconds ago has a
// **null** `draft_updated_at` — the watermark is written by the first debounced
// edit, and nobody has opened this one — and SQLite sorts nulls last under `desc`,
// so ordering by the bare column would sink the newest page to the bottom of a
// list called "last edited".
const newest = await post('/stories', { title: 'Paging E2E Newest' })
const edited = await get('/stories?flat=1&sort=edited&limit=5')
check(
  'a never-opened page created now sorts above one edited long ago',
  edited.rows[0]?.id === newest.id,
  `first=${edited.rows[0]?.title} draftUpdatedAt=${edited.rows[0]?.draftUpdatedAt}`,
)
check(
  'flat mode carries no child count, having no structure to disclose',
  edited.rows[0]?.childCount === undefined,
)

/* --- filters are answered by the server ------------------------------------ */

await post(`/story/${kidWalk[0].id}/publish`, {})
const live = await get('/stories?flat=1&state=live&count=1&limit=100')
check(
  'a state filter is answered server-side and agrees with the row it returns',
  live.rows.every((r) => r.state === 'live') && live.rows.some((r) => r.id === kidWalk[0].id),
  `rows=${live.rows.length} total=${live.total}`,
)
const searched = await get('/stories?flat=1&q=Paging%20E2E%20Kid&count=1&limit=100')
check(
  'a substring search matches title, and counts the filter rather than the table',
  searched.total === KIDS,
  `total=${searched.total} expected=${KIDS}`,
)

/* --- a batch by id, which is what replaced the whole-tree fetch ------------- */

const batch = await get(`/stories?ids=${kidWalk[0].id}&ancestors=1`)
check(
  'a batch by id answers the row and its ancestor chain in one request',
  batch.rows.some((r) => r.id === kidWalk[0].id) &&
    batch.rows.some((r) => r.id === parent.id) &&
    batch.rows.some((r) => r.path === ''),
  `ids=${batch.rows.map((r) => r.id).join(',')}`,
)
check(
  'a batch is not a page: no cursor on it',
  batch.cursor === undefined,
  `cursor=${JSON.stringify(batch.cursor)}`,
)
check(
  'an unknown id is absent rather than an error, the way a dangling link degrades',
  (await get('/stories?ids=sty_definitely_not_a_real_id')).rows.length === 0,
)

/* --- the two refusals ------------------------------------------------------ */

const badCursor = await fetch(`${API}/stories?cursor=nonsense`)
check(
  'a malformed cursor is a 400, never a silent first page',
  badCursor.status === 400,
  `status=${badCursor.status}`,
)
const badSort = await fetch(`${API}/stories?flat=1&sort=colour`)
check('an unknown sort is a 400 rather than quietly serving the default', badSort.status === 400)
const clamped = await get('/stories?limit=5000')
check(
  'an out-of-range limit clamps instead, because a stale bookmark has a right answer',
  clamped.rows.length <= 200,
  `rows=${clamped.rows.length}`,
)

/* --- the screen and its JSON twin own different URLs ----------------------- */

const screen = await fetch(`${BASE}/content`)
const screenType = screen.headers.get('content-type') ?? ''
const apiType = (await fetch(`${API}/stories`)).headers.get('content-type') ?? ''
check(
  'a screen path serves HTML and its JSON twin serves JSON, and no path serves both',
  screenType.includes('text/html') && apiType.includes('application/json'),
  `screen=${screenType} api=${apiType}`,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
