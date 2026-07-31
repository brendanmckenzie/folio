// Exercises the Content API end to end (docs/specs/platform/content-api.md)
// against a live dev server, over real HTTP with a real bearer token.
//
// This is the script that matters most for this spec, because an API is exactly
// the thing that can pass every unit test and still be unusable: the workers suite
// drives `folio.handle()` in-process with a hand-built `Request`, and everything
// between that and `curl` — the mount path, the header parsing, the JSON going out
// and coming back, the token actually resolving off a D1 row — only exists here.
//
// The load-bearing checks, in order of how much they would cost to get wrong:
//
//  1. A write lands as MUTATIONS: an editor with the page open receives the delta
//     while the request is still in flight, attributed to `token:<name>`, and can
//     undo it. That is the whole decision this spec turns on; a write that went
//     around the log would pass every other check here.
//  2. A read-modify-write preserves every uid, so `diff` emits one `set` for one
//     changed field rather than replacing the document.
//  3. A retry with the same `Idempotency-Key` writes once and says so, and the log
//     holds exactly one transaction for it.
//  4. Publishing through the API makes the page live, and the HTML that comes back
//     is what the API wrote — the round trip through a real render, which no unit
//     test covers.
//  5. Reading in a locale resolves the translations, and writing one back through
//     `PATCH /fields` puts it in `i18n` rather than in `data`.
//  6. Scopes: 401 with no token, 403 with the wrong one, per route.
//  7. `sng_*` ids are addressable — a global read and written like any document.
//  8. `folio.write` in the host's own Worker (`POST /dev/sync`), with no HTTP to
//     itself.
//
// The seeded token (examples/demo/seed.sql) is deliberately not used for the scope
// checks: it holds `admin`, so it would pass everything. Narrow tokens are minted
// through `POST /folio/api/tokens` as an admin, which is what a person would do.

import './lib/ts-resolve.mjs'

import { signInGlobally } from './lib/auth.mjs'

const { PROTOCOL_VERSION } = await import(
  new URL('../packages/folio/src/core/protocol.ts', import.meta.url)
)

const HTTP = 'http://localhost:5199'
// The admin's **internal** JSON, which is what `asAdmin` below reaches for: the
// activity trail and the token list are not part of the v1 contract. Unversioned on
// purpose — a version segment is a promise, and this surface makes none
// (`docs/specs/foundation/pagination.md` decision 3).
const ADMIN = `${HTTP}/folio/api`
const API = `${HTTP}/folio/api/v1`

/** The fixed local-dev token seeded by examples/demo/seed.sql. */
const SEEDED = `folio_${'de70c0de'.repeat(8)}`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The raw fetch, captured before `signInGlobally` wraps it: a token request must
// NOT carry the session cookie, or a 401 test would pass on the cookie instead.
const rawFetch = globalThis.fetch

/** A token-authenticated call. `token: null` sends no credential at all. */
async function api(path, { token = SEEDED, method = 'GET', body, key, headers = {} } = {}) {
  const res = await rawFetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // A response with no body (there are none here, but a failure could produce one).
  }
  return { status: res.status, json }
}

const { cookie } = await signInGlobally()

/** Signed in as the seeded admin, for the routes only the admin has. */
const asAdmin = (path, init) => fetch(`${ADMIN}${path}`, init).then((r) => r.json())
const post = (path, body) =>
  asAdmin(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A freshly minted token with exactly these scopes. */
async function mint(name, scopes) {
  const made = await post('/tokens', { name, scopes })
  if (!made.token) throw new Error(`could not mint '${name}': ${JSON.stringify(made)}`)
  return made.token
}

/* --- the seeded token works, straight out of the box --------------------- */

const seededSchema = await api('/schema')
check(
  'the seeded local-dev token authenticates against /api/v1/schema',
  seededSchema.status === 200 && Array.isArray(seededSchema.json?.blocks),
  `status ${seededSchema.status}`,
)

check(
  'no credential at all is 401, not 403',
  (await api('/schema', { token: null })).status === 401,
)

/* --- create ------------------------------------------------------------- */

const created = await api('/documents', {
  method: 'POST',
  body: {
    type: 'page',
    title: 'API created',
    slug: 'api-created',
    content: {
      fields: {
        description: 'Written by a script',
        body: [
          {
            type: 'hero',
            fields: { heading: 'Hello from a script', align: 'center' },
            i18n: { fr: { heading: 'Bonjour depuis un script' } },
          },
          { type: 'prose', fields: {} },
        ],
      },
    },
  },
})
check(
  'POST /documents creates a routed page and answers 201 with the nested shape',
  created.status === 201 && created.json?.path === 'api-created',
  `status ${created.status} path ${created.json?.path}`,
)

const id = created.json?.id
if (!id) {
  console.log(`\nFAIL  create returned no id: ${JSON.stringify(created.json)}`)
  process.exit(1)
}

const heroOf = (doc) => (doc?.fields?.body ?? []).find((b) => b.type === 'hero')

check(
  'the created document already holds the content it was given',
  heroOf(created.json.content)?.fields?.heading === 'Hello from a script',
  heroOf(created.json.content)?.fields?.heading,
)
check(
  'and the title landed in the root block, not only in the story row',
  created.json.content?.fields?.title === 'API created',
  created.json.content?.fields?.title,
)

const heroUid = heroOf(created.json.content)?.uid
check(
  'every block came back with a uid',
  typeof heroUid === 'string' && heroUid.length > 0,
  heroUid,
)

/* --- a write reaches an open editor ------------------------------------- */

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
    inbox,
    async hello() {
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      // Every frame carries the wire version, not only `hello`: the Durable
      // Object refuses a frame that omits it, and a refused frame looks like a
      // hang rather than an error.
      ws.send(
        JSON.stringify({
          type: 'hello',
          lastSyncId: 0,
          identity: { actor: name, name, colour: '#0090ff' },
          v: PROTOCOL_VERSION,
        }),
      )
      return (await this.expect((m) => m.type === 'bootstrap')).doc
    },
    expect(match, ms = 4000) {
      const found = this.inbox.find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms)
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          },
        })
      })
    },
  }
}

const editor = client('editor', id)
await editor.hello()

// Fired without awaiting, so the socket assertion below is genuinely about a
// write that was in flight rather than one that had already finished.
const inFlight = api(`/documents/${id}/fields`, {
  method: 'PATCH',
  body: { bloks: [{ uid: heroUid, fields: { heading: 'Changed by a script' } }] },
})

const delta = await editor.expect((m) => m.type === 'delta').catch(() => null)
check('a write in flight reaches an open editor as a delta', delta !== null)
check(
  'attributed to the token, not to a person who was not there',
  delta?.actor === 'token:local dev',
  delta?.actor,
)
check(
  'and carries the mutation, so the editor re-renders without a reload',
  delta?.mutations?.[0]?.value === 'Changed by a script',
  JSON.stringify(delta?.mutations?.[0]),
)

const patched = await inFlight
check(
  'PATCH /fields reports one mutation in one transaction',
  patched.json?.changed === 1 && patched.json?.transactions === 1,
  JSON.stringify(patched.json),
)

/* --- the activity trail, and undo --------------------------------------- */

await wait(200)
const { rows: trail } = await asAdmin(`/story/${id}/activity`)
check(
  'the activity trail records the script by name',
  trail.some((e) => e.actor === 'token:local dev'),
  JSON.stringify(trail.map((e) => e.actor)),
)

// Undo is an ordinary inverse transaction over the socket — which is only true
// because the API's write went through the log at all.
const undoTx = `tx_${'a1b2c3d4e5'.repeat(2)}`
editor.ws.send(
  JSON.stringify({
    type: 'tx',
    txId: undoTx,
    mutations: [{ t: 'set', uid: heroUid, field: 'heading', value: 'Hello from a script' }],
    v: PROTOCOL_VERSION,
  }),
)
await editor.expect((m) => m.type === 'delta' && m.txId === undoTx)
const afterUndo = await api(`/documents/${id}?status=draft`)
check(
  "an editor's own inverse transaction reverts the script's write",
  heroOf(afterUndo.json?.content)?.fields?.heading === 'Hello from a script',
  heroOf(afterUndo.json?.content)?.fields?.heading,
)

/* --- read, modify, write ------------------------------------------------ */

const read = await api(`/documents/${id}?status=draft`)
check('GET ?status=draft answers the draft', read.json?.source === 'draft', read.json?.source)

const modified = structuredClone(read.json.content)
heroOf(modified).fields.heading = 'Read, modified, written'
const written = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: modified },
})
check(
  'a read-modify-write of one field emits exactly one mutation',
  written.json?.changed === 1,
  JSON.stringify(written.json),
)

const reread = await api(`/documents/${id}?status=draft`)
check(
  'and every uid survived, so nothing was replaced',
  heroOf(reread.json.content)?.uid === heroUid,
  `${heroOf(reread.json.content)?.uid} vs ${heroUid}`,
)

const noop = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: reread.json.content },
})
check(
  'putting the same content back writes nothing at all',
  noop.json?.changed === 0 && noop.json?.transactions === 0,
  JSON.stringify(noop.json),
)

/* --- merge is the default ----------------------------------------------- */

const merged = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: { uid: reread.json.content.uid, fields: { description: 'Merged in' } } },
})
check('a partial payload is one mutation, not a replace', merged.json?.changed === 1)

const afterMerge = await api(`/documents/${id}?status=draft`)
check(
  'merge left the body alone: the hero is still there',
  heroOf(afterMerge.json.content)?.uid === heroUid,
)
check(
  'and left the translations alone too',
  heroOf(afterMerge.json.content)?.i18n?.fr?.heading === 'Bonjour depuis un script',
  JSON.stringify(heroOf(afterMerge.json.content)?.i18n),
)

/* --- replace has to be told about translations -------------------------- */

const stripped = structuredClone(afterMerge.json.content)
delete heroOf(stripped).i18n
const refusedReplace = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: stripped, mode: 'replace' },
})
check(
  'a replace that would discard translations is refused, with the locale named',
  refusedReplace.status === 400 &&
    /discard the translations.*fr/.test(refusedReplace.json?.error?.message ?? ''),
  `${refusedReplace.status} ${refusedReplace.json?.error?.message}`,
)

const stillThere = await api(`/documents/${id}?status=draft`)
check(
  'and nothing was written by the attempt',
  heroOf(stillThere.json.content)?.i18n?.fr?.heading === 'Bonjour depuis un script',
)

/* --- structure: a new block and a reorder ------------------------------- */

const restructured = structuredClone(stillThere.json.content)
const body = restructured.fields.body
restructured.fields.body = [body[1], body[0], { type: 'prose', fields: {} }]
const structural = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: restructured },
})
check(
  'adding a block and swapping two is a handful of mutations, not a rewrite',
  structural.json?.changed > 0 && structural.json?.changed <= 4,
  JSON.stringify(structural.json),
)

const afterStructure = await api(`/documents/${id}?status=draft`)
check(
  'the new order is what came back, and the hero kept its uid',
  afterStructure.json.content.fields.body.length === 3 &&
    afterStructure.json.content.fields.body[1]?.uid === heroUid,
  afterStructure.json.content.fields.body.map((b) => b.uid).join(','),
)

/* --- idempotency -------------------------------------------------------- */

const KEY = 'import-42'
const first = await api(`/documents/${id}/fields`, {
  method: 'PATCH',
  key: KEY,
  body: { fields: { description: 'Idempotent' } },
})
check(
  'a keyed write is an ordinary write the first time',
  first.json?.changed === 1 && first.json?.replayed === undefined,
  JSON.stringify(first.json),
)

const retry = await api(`/documents/${id}/fields`, {
  method: 'PATCH',
  key: KEY,
  body: { fields: { description: 'Idempotent' } },
})
check(
  'the identical retry answers replayed: true with the original syncId',
  retry.json?.replayed === true && retry.json?.syncId === first.json?.syncId,
  JSON.stringify(retry.json),
)

await wait(200)
const { rows: keyedTrail } = await asAdmin(`/story/${id}/activity`)
const descriptionWrites = keyedTrail.filter((e) =>
  (e.mutations ?? []).some((m) => m.field === 'description' && m.value === 'Idempotent'),
)
check(
  'and the log holds exactly one transaction for it',
  descriptionWrites.length === 1,
  `${descriptionWrites.length} transactions`,
)

const differentBody = await api(`/documents/${id}/fields`, {
  method: 'PATCH',
  key: KEY,
  body: { fields: { description: 'Something else entirely' } },
})
check(
  'the same key with a different body is answered by the first write, as documented',
  differentBody.json?.replayed === true,
  JSON.stringify(differentBody.json),
)
const unchanged = await api(`/documents/${id}?status=draft`)
check(
  'so the second body was ignored rather than applied',
  unchanged.json.content.fields.description === 'Idempotent',
  unchanged.json.content.fields.description,
)

/* --- schema validation names what it refused ---------------------------- */

const badField = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: { fields: { body: [{ type: 'hero', fields: { headng: 'oops' } }] } } },
})
check(
  'a misspelled field is 400 naming its exact path',
  badField.status === 400 && badField.json?.error?.message?.includes('body[0].fields.headng'),
  `${badField.status} ${badField.json?.error?.message}`,
)

const badType = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: { fields: { body: [{ type: 'nonesuch', fields: {} }] } } },
})
check(
  'an unknown block type is 400 naming the type',
  badType.status === 400 && badType.json?.error?.message?.includes('nonesuch'),
  badType.json?.error?.message,
)

const disallowed = await api(`/documents/${id}/content`, {
  method: 'PUT',
  body: { content: { fields: { body: [{ type: 'button', fields: {} }] } } },
})
check(
  "a block a slot's allow forbids is refused, naming the slot",
  disallowed.status === 400 && /does not allow/.test(disallowed.json?.error?.message ?? ''),
  disallowed.json?.error?.message,
)

const afterRefusals = await api(`/documents/${id}?status=draft`)
check(
  'and none of the three refusals wrote anything',
  afterRefusals.json.content.fields.body.length === 3,
  `${afterRefusals.json.content.fields.body.length} blocks`,
)

/* --- publish, and the HTML that comes out ------------------------------- */

await api(`/documents/${id}/fields`, {
  method: 'PATCH',
  body: { bloks: [{ uid: heroUid, fields: { heading: 'Published by a script' } }] },
})

const published = await api(`/documents/${id}/publish`, { method: 'POST' })
check(
  'POST /publish writes a version and reports it',
  published.status === 200 && published.json?.version?.kind === 'publish',
  `${published.status} ${JSON.stringify(published.json?.version?.kind)}`,
)

const html = await rawFetch(`${HTTP}/api-created`).then((r) => r.text())
check(
  'the live page renders exactly what the API wrote',
  html.includes('Published by a script'),
  html.slice(0, 120),
)
check('and ships no JavaScript, as every published page does', !html.includes('<script'))

const publicRead = await api('/documents/by-path/api-created')
check(
  'and by-path now answers the published snapshot with no ?status=draft',
  publicRead.json?.source === 'published' &&
    heroOf(publicRead.json.content)?.fields?.heading === 'Published by a script',
  publicRead.json?.source,
)

/* --- locales ------------------------------------------------------------ */

const french = await api(`/documents/${id}?status=draft&locale=fr`)
check(
  'a locale read resolves the translation into fields',
  heroOf(french.json.content)?.fields?.heading === 'Bonjour depuis un script',
  heroOf(french.json.content)?.fields?.heading,
)
check(
  'and drops i18n, because the values are already resolved',
  heroOf(french.json.content)?.i18n === undefined,
)

const wroteFrench = await api(`/documents/${id}/fields`, {
  method: 'PATCH',
  body: { bloks: [{ uid: heroUid, fields: { heading: 'Publié par un script' } }], locale: 'fr' },
})
check('a locale-scoped PATCH is one mutation', wroteFrench.json?.changed === 1)

const bothLocales = await api(`/documents/${id}?status=draft`)
check(
  'it went into i18n, leaving the source locale alone',
  heroOf(bothLocales.json.content)?.i18n?.fr?.heading === 'Publié par un script' &&
    heroOf(bothLocales.json.content)?.fields?.heading === 'Published by a script',
  JSON.stringify(heroOf(bothLocales.json.content)?.i18n),
)

check(
  'an undeclared locale is 501, not a silently English answer',
  (await api(`/documents/${id}?locale=xx`)).status === 501,
)

/* --- query -------------------------------------------------------------- */

const queried = await api('/documents?type=page&perPage=2&page=1')
check(
  'GET /documents pages published content',
  queried.status === 200 && queried.json?.perPage === 2 && queried.json?.items?.length <= 2,
  JSON.stringify({ total: queried.json?.total, pages: queried.json?.pages }),
)
check(
  'and refuses ?status=draft as unsupported rather than ignoring it',
  (await api('/documents?status=draft')).status === 501,
)

/* --- scopes ------------------------------------------------------------- */

const readOnly = await mint('e2e read only', ['content:read'])
const draftReader = await mint('e2e draft reader', ['content:read:draft'])
const writer = await mint('e2e writer', ['content:write'])
const uploader = await mint('e2e uploader', ['assets:write'])

check(
  'content:read reads published content',
  (await api('/documents/by-path/api-created', { token: readOnly })).status === 200,
)
check(
  'content:read alone cannot read a draft',
  (await api(`/documents/${id}?status=draft`, { token: readOnly })).status === 403,
)
check(
  'content:read:draft can',
  (await api(`/documents/${id}?status=draft`, { token: draftReader })).status === 200,
)
check(
  'content:read cannot write',
  (
    await api(`/documents/${id}/fields`, {
      token: readOnly,
      method: 'PATCH',
      body: { fields: { description: 'nope' } },
    })
  ).status === 403,
)
check(
  'content:write can',
  (
    await api(`/documents/${id}/fields`, {
      token: writer,
      method: 'PATCH',
      body: { fields: { description: 'from the writer token' } },
    })
  ).status === 200,
)
check(
  'content:write cannot publish',
  (await api(`/documents/${id}/publish`, { token: writer, method: 'POST' })).status === 403,
)
check(
  'assets:write implies nothing about content',
  (await api('/documents/by-path/api-created', { token: uploader })).status === 403,
)
check(
  'and content:write implies nothing about assets',
  (
    await rawFetch(`${API}/assets?filename=nope.png`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    })
  ).status === 403,
)

const uploaded = await rawFetch(`${API}/assets?filename=api.png`, {
  method: 'POST',
  headers: { authorization: `Bearer ${uploader}`, 'content-type': 'image/png' },
  body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
})
check('assets:write uploads', uploaded.status === 201, `status ${uploaded.status}`)

/* --- globals are ordinary documents ------------------------------------- */

const global = await api('/documents/sng_header?status=draft')
check(
  'a sng_* id is addressable, and reading one creates its row',
  global.status === 200 && global.json?.id === 'sng_header' && global.json?.path === null,
  `${global.status} ${global.json?.id}`,
)

const globalRoot = global.json?.content?.uid
const wroteGlobal = await api('/documents/sng_header/fields', {
  method: 'PATCH',
  body: { bloks: [{ uid: globalRoot, fields: { logoText: 'Set over the API' } }] },
})
check(
  'and writes through the ordinary content routes',
  wroteGlobal.json?.changed === 1,
  JSON.stringify(wroteGlobal.json),
)

check(
  'an sng_ id naming no declared singleton is a 404, not a created row',
  (await api('/documents/sng_invented')).status === 404,
)

check(
  'creating a singleton is refused, pointing at its derived id',
  (
    await api('/documents', {
      method: 'POST',
      body: { type: 'header', title: 'Another header' },
    })
  ).status === 409,
)

/* --- folio.write in the host's own Worker -------------------------------- */

const synced = await rawFetch(`${HTTP}/dev/sync`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, fields: { description: 'Synced in process' } }),
}).then((r) => r.json())
check(
  'folio.write commits from the host Worker with no HTTP to itself',
  synced?.changed === 1 && synced?.transactions === 1,
  JSON.stringify(synced),
)

const afterSync = await api(`/documents/${id}?status=draft`)
check(
  'and the document holds what it wrote',
  afterSync.json.content.fields.description === 'Synced in process',
  afterSync.json.content.fields.description,
)

const syncedAgain = await rawFetch(`${HTTP}/dev/sync`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, fields: { description: 'Twice' }, txId: 'nightly-run-1' }),
}).then((r) => r.json())
const syncedRetry = await rawFetch(`${HTTP}/dev/sync`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, fields: { description: 'Twice' }, txId: 'nightly-run-1' }),
}).then((r) => r.json())
check(
  'a retried scheduled run with the same txId writes once',
  syncedRetry?.replayed === true && syncedRetry?.syncId === syncedAgain?.syncId,
  JSON.stringify(syncedRetry),
)

/* --- metadata, and delete ----------------------------------------------- */

const renamed = await api(`/documents/${id}`, {
  method: 'PATCH',
  body: { slug: 'api-renamed' },
})
check(
  'PATCH /documents/:id moves the URL',
  renamed.status === 200 && renamed.json?.path === 'api-renamed',
  `${renamed.status} ${renamed.json?.path}`,
)
check(
  'and the old path now redirects, as any rename does',
  (await rawFetch(`${HTTP}/api-created`, { redirect: 'manual' })).status === 301,
)

const versioned = await api(`/documents/${id}/versions`, {
  method: 'POST',
  body: { label: 'before the delete' },
})
check(
  'POST /versions checkpoints, attributed to the token',
  versioned.status === 201 && versioned.json?.actor === 'token:local dev',
  `${versioned.status} ${versioned.json?.actor}`,
)

const versions = await api(`/documents/${id}/versions`)
check(
  'GET /versions lists both the publish and the checkpoint',
  (versions.json?.versions ?? []).length >= 2,
  `${(versions.json?.versions ?? []).length} versions`,
)

const deleted = await api(`/documents/${id}`, { method: 'DELETE' })
check(
  'DELETE removes the document',
  deleted.status === 200 && deleted.json?.deleted?.includes(id),
  JSON.stringify(deleted.json),
)
check(
  'a write to a deleted document is 404, not a resurrection',
  (
    await api(`/documents/${id}/fields`, {
      method: 'PATCH',
      body: { fields: { description: 'ghost' } },
    })
  ).status === 404,
)

/* --- token lifecycle ---------------------------------------------------- */

const tokens = await asAdmin('/tokens')
const readOnlyRow = tokens.tokens?.find((t) => t.name === 'e2e read only')
check(
  'a token that has been used records last_used_at',
  typeof readOnlyRow?.lastUsedAt === 'number',
  JSON.stringify(readOnlyRow?.lastUsedAt),
)

await fetch(`${ADMIN}/tokens/${readOnlyRow.id}`, { method: 'DELETE' })
check(
  'a revoked token is 401 — a credential that no longer exists, not one lacking a scope',
  (await api('/documents/by-path/api-renamed', { token: readOnly })).status === 401,
)

check('the session cookie was carried, so the admin routes answered', typeof cookie === 'string')

editor.ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
