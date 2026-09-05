// Exercises visitor access (docs/specs/platform/visitor-access.md) against a
// live dev server: an ordinary host page gated by one root-block field, with
// the demo's own fake `demo_member=1` cookie standing in for a real
// membership check (src/index.tsx's `gate`).
//
// The properties no unit or workers test can see, because they only exist
// once a real HTTP response leaves the Worker:
//
//  1. The *headers* a stranger and a member each actually receive for the
//     same URL — `private, no-store` for both, `s-maxage` for an ungated
//     page — which is the whole security property (decision 5): Folio has no
//     request-side opinion on a host's own route, so this header is the only
//     thing keeping a members-only page out of a shared cache.
//  2. The *body* each one receives: a stranger's HTML never contains the
//     prose a member's does, because `redactDoc` ran before the render, not
//     as a rendering choice the host promises to honour.
//  3. `/archive` — a list, and therefore never gated (checkpoint 6) — still
//     hides a members-only insight, because the host's own `where` filter on
//     the same `access` field does the work Folio deliberately does not.
//
// Uses plain REST throughout (`PATCH /fields`, `PUT /content`,
// `POST /story/:id/publish`) — no socket needed, because nothing here reads a
// live editing session.

import { signInGlobally } from './lib/auth.mjs'

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
// Unversioned, internal: story lifecycle (`/stories`, `/story/:id/publish`).
const API = `${BASE}/api`
// `{base}/api/v1`: the documented content surface `PATCH`/`PUT` write through.
const V1 = `${API}/v1`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

/** A signed-in write. `fetch` already carries the session cookie
 * (`signInGlobally` below), so every call here is the admin seeded by
 * `seed.sql`. Throws on a FolioError envelope rather than failing silently
 * three checks later with no clue why. */
async function call(path, init) {
  const res = await fetch(path, init)
  const json = await res.json().catch(() => null)
  if (json?.error) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${json.error.code}: ${json.error.message}`)
  }
  return json
}

const patchFields = (id, fields) =>
  call(`${V1}/documents/${id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  })

const putContent = (id, content) =>
  call(`${V1}/documents/${id}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })

const publish = (id) => call(`${API}/story/${id}/publish`, { method: 'POST' })

const createStory = (body) =>
  call(`${API}/stories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

await signInGlobally()

/* --- '/' — the seeded home page, published and ungated ------------------ */

await patchFields('sty_home', { title: 'Home' })
await publish('sty_home')

// A bare fetch with no cookie jar at all, so nothing this process has signed
// into leaks into "what a stranger sees" — same discipline as
// draft-mode-test.mjs's own stranger check.
const home = await fetch(`${HTTP}/`, { headers: { cookie: '' } })
check(
  '/ is public with s-maxage',
  (home.headers.get('cache-control') ?? '').includes('s-maxage'),
  home.headers.get('cache-control') ?? '(none)',
)

/* --- 'about' gets real content, published public, then gated ------------ */

const SECRET = 'GATE_TEST_SECRET_BODY'
const richBody = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

await putContent('sty_about', {
  fields: {
    title: 'About',
    description: 'About this site',
    access: 'public',
    // A slot's children are nested *inside* `fields`, alongside the scalars —
    // the same shape `POST /documents` takes for starting content.
    body: [{ type: 'prose', fields: { heading: 'About us', body: richBody(SECRET) } }],
  },
})
await publish('sty_about')

const beforeGating = await fetch(`${HTTP}/about`, { headers: { cookie: '' } })
const beforeHtml = await beforeGating.text()
check(
  'before gating, a stranger reads the body and the page is cacheable',
  beforeHtml.includes(SECRET) &&
    (beforeGating.headers.get('cache-control') ?? '').includes('s-maxage'),
  beforeGating.headers.get('cache-control') ?? '(none)',
)

// The one field an editor ticks under "Page settings" — no developer, no
// second place to remember (user story 3).
await patchFields('sty_about', { access: 'members' })
await publish('sty_about')

/* --- a stranger gets the teaser, not the body ---------------------------- */

const anon = await fetch(`${HTTP}/about`, { headers: { cookie: '' } })
const anonHtml = await anon.text()
check('a stranger sees the paywall marker', anonHtml.includes('data-testid="paywall"'))
check('and never sees the body text', !anonHtml.includes(SECRET))
check(
  'and the response is private, no-store',
  anon.headers.get('cache-control') === 'private, no-store',
  anon.headers.get('cache-control') ?? '(none)',
)
check(
  'and carries no cache-tag, so nothing can key it at the edge',
  anon.headers.get('cache-tag') === null,
)

/* --- the fake membership cookie is granted the full page ----------------- */

// No session cookie here either — `demo_member=1` alone is the whole
// credential this fake `visitor` reads (src/index.tsx).
const member = await fetch(`${HTTP}/about`, { headers: { cookie: 'demo_member=1' } })
const memberHtml = await member.text()
check('a member reads the body text', memberHtml.includes(SECRET))
check('and sees no paywall marker', !memberHtml.includes('data-testid="paywall"'))
check(
  'and the response is private, no-store too — granted is not cacheable either',
  member.headers.get('cache-control') === 'private, no-store',
  member.headers.get('cache-control') ?? '(none)',
)

/* --- lists are not gated; the host's `where` filter is the whole remedy -- */

// Two insights: one left public (the default — `defaultValue(select)` seeds
// `options[0]`), one gated. `/archive` (src/index.tsx) filters on the same
// `access` field the gate reads, which is only a real filter — rather than a
// clause that matches nothing — because `insightPage` declares the field too.
const openInsight = await createStory({
  title: 'Gate Test Open Insight',
  type: 'insight',
  parentId: 'sty_about',
})
const gatedInsight = await createStory({
  title: 'Gate Test Gated Insight',
  type: 'insight',
  parentId: 'sty_about',
})
await patchFields(openInsight.id, { published: '2026-01-01' })
await patchFields(gatedInsight.id, { published: '2026-01-02', access: 'members' })
await publish(openInsight.id)
await publish(gatedInsight.id)

const archive = await fetch(`${HTTP}/archive`).then((r) => r.json())
const archiveIds = archive.items.map((i) => i.id)
check(
  '/archive includes the public insight',
  archiveIds.includes(openInsight.id),
  JSON.stringify(archiveIds),
)
check(
  '/archive omits the gated insight — the where filter, not Folio, is doing this',
  !archiveIds.includes(gatedInsight.id),
  JSON.stringify(archiveIds),
)
check(
  "/archive omits 'about' — it is never an insight, gated or not",
  !archiveIds.includes('sty_about'),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
