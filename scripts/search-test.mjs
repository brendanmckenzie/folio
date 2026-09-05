// Exercises full-text search end to end
// (docs/specs/content-model/full-text-search.md) against the demo's `insight`
// type, its `prose` block and the `searchResults` block
// (examples/demo/src/blocks/search.tsx) — a live dev server, real HTTP, a real
// FTS5 index, no browser.
//
// The load-bearing checks, in order of how much they would cost to get wrong:
//
//  1. Editing an insight's prose over the socket and publishing writes the
//     full-text index in the same batch — `folio.query`'s own compiler finds
//     the word.
//  2. The **same** term, sent through `GET {base}/api/content`,
//     `GET /api/v1/documents` and MCP `query_documents`, answers the same item
//     with a snippet — "one compiler, four surfaces" (the fourth being
//     `folio.query`, exercised inside the demo's `/search` route below rather
//     than called directly, since a script has no in-process access to it).
//  3. The demo's `/search?q=` route — "a search page is a page holding a
//     collection block" (decision 10) — renders the same item, with the
//     matched word wrapped in `<mark>`, through nothing but
//     `folio.resolve(doc, { search })` and a `collection({ searchable: true })`
//     field. No story is seeded for this page; `searchPage()` in
//     examples/demo/src/index.tsx builds the `Doc` in memory.
//  4. A French translation of the body is found under `locale=fr` and not
//     under the source locale, and the reverse.
//  5. Unpublishing takes the document out of every one of those surfaces at
//     once, in the same publish-batch guarantee `content_index` already has.
//  6. Every malformed `search` value answers 200 with a well-formed
//     `ContentPage` — `ftsQuery` tokenises before anything reaches FTS5 as
//     syntax — and `order=relevance` with no `search` is the one refusal.

import './lib/ts-resolve.mjs'

import { signInGlobally } from './lib/auth.mjs'

const { PROTOCOL_VERSION } = await import(new URL('../src/core/protocol.ts', import.meta.url))

const HTTP = 'http://localhost:5199'
const BASE = `${HTTP}/folio`
const ADMIN = `${BASE}/api`
const V1 = `${BASE}/api/v1`
const MCP = `${BASE}/mcp`
const MCP_VERSION = '2026-07-28'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (url, init) => fetch(url, init).then((r) => r.json())
const text = (url) => fetch(url).then((r) => r.text())

// `signInGlobally` wraps the process's own `fetch` and `WebSocket` to carry the
// session cookie, the way a browser does — so every plain `fetch`/`WebSocket`
// call below is already authenticated. `realFetch` is the pre-wrap escape hatch
// for the two calls that must present a *bearer token* instead of the cookie
// (`GET /api/v1/documents`, MCP `query_documents`) — a wrapped fetch would let
// the ambient session answer for the wrong reason.
const { realFetch } = await signInGlobally()

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
  json(`${ADMIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

/** A freshly minted admin token with exactly these scopes. */
async function mint(name, scopes) {
  const made = await post('/tokens', { name, scopes })
  if (!made.token) throw new Error(`could not mint '${name}': ${JSON.stringify(made)}`)
  return made.token
}

const rootOf = (doc) => doc.root

/* --- an insight with a nonce word in its prose, over the socket ---------- */

const index = await post('/stories', { title: 'Search E2E Index' })
check('an index page exists', Boolean(index.id))

const insight = await post('/stories', {
  title: 'Search E2E Insight',
  parentId: index.id,
  type: 'insight',
})
check('an insight exists under it', Boolean(insight.id))

// Nonce words, so this run cannot collide with another file's fixtures or a
// stray match from seed.sql — the convention `test/workers/search.test.ts`
// already uses.
const TERM_EN = 'zqxharbour'
const TERM_FR = 'zqxcoucher'

const bodyDoc = (word) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: `The sunset over the ${word} today.` }] },
  ],
})

const c = client('search-e2e', insight.id)
const doc = await c.hello()
const root = rootOf(doc)
const PROSE = 'zqxprose01'

await c.tx('cs1', [
  { t: 'set', uid: root, field: 'title', value: 'Search E2E Insight' },
  { t: 'set', uid: root, field: 'topic', value: 'practice' },
  { t: 'set', uid: root, field: 'published', value: '2026-03-01' },
  {
    t: 'insert',
    blok: {
      uid: PROSE,
      type: 'prose',
      parent: root,
      slot: 'body',
      order: 'a0',
      data: { body: bodyDoc(TERM_EN) },
    },
  },
])
// The French translation lives on the SAME blok's `body`, under `locale: 'fr'`
// (`content-model/localisation.md` decision 3) — a second ProseMirror tree
// alongside the source one, not a second block.
await c.tx('cs2', [{ t: 'set', uid: PROSE, field: 'body', value: bodyDoc(TERM_FR), locale: 'fr' }])
c.ws.close()

const published = await post(`/story/${insight.id}/publish`)
check('the insight publishes', published?.version?.kind === 'publish', JSON.stringify(published))

/* --- the same term, through three HTTP surfaces --------------------------- */

const contentAnswer = await json(`${ADMIN}/content?type=insight&search=${TERM_EN}`)
check(
  'GET {base}/api/content finds it by body text',
  contentAnswer.items?.some((i) => i.id === insight.id),
  JSON.stringify(contentAnswer.items?.map((i) => i.id)),
)
const contentItem = contentAnswer.items?.find((i) => i.id === insight.id)
check(
  'and hands back a snippet whose matched part is the term',
  Array.isArray(contentItem?.snippet) &&
    contentItem.snippet.some((p) => p.match && p.text.toLowerCase().includes(TERM_EN)),
  JSON.stringify(contentItem?.snippet),
)
check('and a positive score', typeof contentItem?.score === 'number' && contentItem.score > 0)

const v1Token = await mint('e2e search v1', ['content:read'])
const v1Res = await realFetch(`${V1}/documents?type=insight&search=${TERM_EN}`, {
  headers: { authorization: `Bearer ${v1Token}` },
})
const v1Answer = await v1Res.json()
check(
  'GET /api/v1/documents answers the same item',
  v1Res.status === 200 && v1Answer.items?.some((i) => i.id === insight.id),
  `status ${v1Res.status}`,
)

const mcpToken = await mint('e2e search mcp', ['content:read'])
let mcpRpcId = 0
const mcpRes = await realFetch(MCP, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': 'query_documents',
    authorization: `Bearer ${mcpToken}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: ++mcpRpcId,
    method: 'tools/call',
    params: {
      name: 'query_documents',
      arguments: { type: 'insight', search: TERM_EN },
      _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION },
    },
  }),
})
const mcpBody = await mcpRes.json()
const mcpAnswer = mcpBody?.result?.content?.[0]?.text
  ? JSON.parse(mcpBody.result.content[0].text)
  : null
check(
  'MCP query_documents answers the same item',
  mcpRes.status === 200 && mcpAnswer?.items?.some((i) => i.id === insight.id),
  JSON.stringify(mcpBody?.error ?? mcpAnswer?.items?.map((i) => i.id)),
)

/* --- the demo's /search?q= route: a page holding a collection block ------ */

const searchPageHtml = await text(`${HTTP}/search?q=${TERM_EN}`)
check(
  'the /search page renders the item’s title and link',
  searchPageHtml.includes('Search E2E Insight') && searchPageHtml.includes(`href="${insight.url}"`),
  insight.url,
)
check(
  'and wraps the matched word in <mark>, not a trusted string',
  new RegExp(`<mark>[^<]*${TERM_EN}[^<]*</mark>`, 'i').test(searchPageHtml),
  searchPageHtml.match(/<mark>.*?<\/mark>/i)?.[0],
)
check('the search page ships no JavaScript', !searchPageHtml.includes('<script'))

const noMatchHtml = await text(`${HTTP}/search?q=zqxnothingmatchesthis`)
check('a term with no matches renders the empty state', noMatchHtml.includes('No matches.'))

/* --- locale: the French body under fr, the source under no locale -------- */

const frHit = await json(`${ADMIN}/content?type=insight&search=${TERM_FR}&locale=fr`)
check(
  'the French translation is found under locale=fr',
  frHit.items?.some((i) => i.id === insight.id),
  JSON.stringify(frHit.items?.map((i) => i.id)),
)
const frUnderSource = await json(`${ADMIN}/content?type=insight&search=${TERM_FR}`)
check('and NOT under the source locale', !frUnderSource.items?.some((i) => i.id === insight.id))
const enUnderFr = await json(`${ADMIN}/content?type=insight&search=${TERM_EN}&locale=fr`)
check(
  'and the English word does not match the French row either — each locale holds its own text',
  !enUnderFr.items?.some((i) => i.id === insight.id),
)

/* --- malformed input is never an error ------------------------------------ */

const malformed = ['"', '-x', 'foo:bar', 'NOT', '(x', '*', '^', '🎉🎉🎉', 'x'.repeat(10_000)]
for (const value of malformed) {
  const res = await fetch(`${ADMIN}/content?type=insight&search=${encodeURIComponent(value)}`)
  const body = await res.json().catch(() => null)
  check(
    `search=${JSON.stringify(value).slice(0, 24)} answers 200 with a well-formed page`,
    res.status === 200 && Array.isArray(body?.items) && typeof body?.total === 'number',
    `status ${res.status}`,
  )
}

const emojiOnly = await json(`${ADMIN}/content?type=insight&search=${encodeURIComponent('🎉🎉🎉')}`)
check(
  'an emoji-only term answers zero items, not an error and not everything',
  emojiOnly.total === 0,
)

const relevanceRefused = await fetch(`${ADMIN}/content?type=insight&order=relevance`)
const relevanceBody = await relevanceRefused.json().catch(() => null)
check(
  'order=relevance with no search is the one refusal, naming relevance',
  relevanceRefused.status === 400 &&
    String(relevanceBody?.error?.message ?? '').includes('relevance'),
  JSON.stringify(relevanceBody?.error),
)

/* --- unpublish takes it out of every surface at once ---------------------- */

await post(`/story/${insight.id}/unpublish`)

const afterContent = await json(`${ADMIN}/content?type=insight&search=${TERM_EN}`)
check(
  'GET {base}/api/content no longer finds it',
  !afterContent.items?.some((i) => i.id === insight.id),
)

const afterV1Res = await realFetch(`${V1}/documents?type=insight&search=${TERM_EN}`, {
  headers: { authorization: `Bearer ${v1Token}` },
})
const afterV1 = await afterV1Res.json()
check('GET /api/v1/documents no longer finds it', !afterV1.items?.some((i) => i.id === insight.id))

const afterSearchPage = await text(`${HTTP}/search?q=${TERM_EN}`)
check('and neither does the /search page', afterSearchPage.includes('No matches.'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
