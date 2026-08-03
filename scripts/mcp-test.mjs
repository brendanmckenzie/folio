// Drives {base}/mcp end to end (docs/specs/platform/mcp-server.md phase 5)
// against a live dev server, over real HTTP with a real bearer token — the
// same reason api-test.mjs exists for /api/v1: a unit test drives
// `folio.handle()` in-process with a hand-built Request, and everything
// between that and a real MCP client — the mount path, JSON-RPC actually
// travelling over HTTP, a token resolving off a real D1 row — only exists
// here.
//
// The load-bearing checks, in order:
//
//  1. `initialize` succeeds with no credential, and the tools/list that
//     follows is empty — the honest answer to a client that has not
//     configured a token yet.
//  2. A minted token's tools/list offers exactly what its scopes grant.
//  3. create_document -> write_content -> preview_document -> publish_document,
//     the same round trip a person makes with the editor open, driven by an
//     agent instead.
//  4. preview_document takes the no-binding path and says so — the *only*
//     path this script, or `pnpm dev`, can ever reach: Cloudflare's browser is
//     remote and cannot reach localhost (decision 5a). It still has to answer
//     the draft URL and the rendered HTML, and it still has to not fail.
//  5. The published page renders what the tool calls wrote, and the activity
//     trail names the token — `token:<name>`, not the person who minted it.
//
// **This script does not import the tool table from source, unlike every
// other e2e script's `core/diff.ts`/`core/doc.ts` import.** `mcp/tools.ts`
// imports `mcp/shot.ts`, which imports `server/pages.tsx` — a `.tsx` file.
// Node's native TypeScript support strips *types*; it does not transform
// JSX, so `import('.../pages.tsx')` fails with `ERR_UNKNOWN_FILE_EXTENSION`
// even after `ts-resolve.mjs` is taught to look for `.tsx` (tried, and it is
// exactly where it breaks). Every prior script's source import stays inside
// `core/`, which has no JSX in its closure — this is the first one whose
// tool table reaches into `server/`, and that closure is not Node-importable
// today. So the tool names and scopes below are literals, the same way
// api-test.mjs hardcodes its route paths rather than importing `apiRoutes`.

import './lib/ts-resolve.mjs'

import { signInGlobally } from './lib/auth.mjs'

const HTTP = 'http://localhost:5199'
// The admin's own internal JSON — unversioned on purpose
// (docs/specs/foundation/pagination.md decision 3) — is what mints a token
// and reads the activity trail, neither of which is part of the v1 contract.
const ADMIN = `${HTTP}/folio/api`
const MCP = `${HTTP}/folio/mcp`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

// `realFetch` is the pre-wrap global: `signInGlobally` makes the *ordinary*
// `fetch` carry the session cookie on every call, the way a browser would, so
// that the admin calls below (`asAdmin`/`post`) need no cookie plumbing of
// their own. But that means the ordinary `fetch` can no longer make a
// genuinely uncredentialed request — every MCP call below goes through
// `realFetch` instead and states its own credential explicitly, or none at
// all, so "no credential" in a check below is not quietly the admin's
// session cookie riding along for free.
const { cookie, realFetch } = await signInGlobally()

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

let nextId = 0

/**
 * One JSON-RPC request over plain POST — no upgrade, no stream, no session.
 * **Deliberately stamps no wire version anywhere**, unlike every socket frame
 * in this codebase: MCP negotiates its own version inside `initialize`, and
 * this is not `PROTOCOL_VERSION`'s wire. Worth driving once with a completely
 * bare envelope rather than assuming it, since a socket frame missing `v` is
 * refused outright and this is the one caller in the whole test surface that
 * has no reason to ever send one.
 *
 * Over `realFetch`, deliberately: the ordinary `fetch` in this process always
 * carries the signed-in admin's session cookie, which would make every "no
 * credential" check below pass for the wrong reason.
 */
async function rpc(method, params = {}, token) {
  const res = await realFetch(MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // A notification (`tools/list` never is one) or an empty body.
  }
  return { status: res.status, json }
}

/** A tool call, with its JSON content already unwrapped when it succeeded. */
async function callTool(name, args, token) {
  const answer = await rpc('tools/call', { name, arguments: args }, token)
  if (answer.json?.error) return { error: answer.json.error }
  return { value: JSON.parse(answer.json.result.content[0].text) }
}

/* --- initialize, with no credential -------------------------------------- */

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  clientInfo: { name: 'mcp-test.mjs' },
})
check(
  'initialize succeeds with no credential at all',
  init.status === 200 && init.json?.result?.serverInfo?.name === 'folio',
  JSON.stringify(init.json),
)
check(
  'a frame carrying no wire version at all is still answered normally',
  init.json?.error === undefined,
)

const anonList = await rpc('tools/list')
check(
  'an unauthenticated tools/list answers no tools at all',
  Array.isArray(anonList.json?.result?.tools) && anonList.json.result.tools.length === 0,
  JSON.stringify(anonList.json?.result),
)

const notified = await realFetch(MCP, {
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})
check('a notification gets 202 and no body', notified.status === 202)

/* --- a scoped token sees exactly what its scopes grant -------------------- */

const token = await mint('e2e mcp', ['content:write', 'publish'])

const list = await rpc('tools/list', {}, token)
const names = (list.json?.result?.tools ?? []).map((t) => t.name)
check(
  'tools/list offers create_document, write_content, preview_document and publish_document',
  ['create_document', 'write_content', 'preview_document', 'publish_document'].every((n) =>
    names.includes(n),
  ),
  names.join(', '),
)
check(
  'and does not offer delete_document — content:write plus publish is not admin',
  !names.includes('delete_document'),
)

/* --- create, write, preview, publish -------------------------------------- */

const created = await callTool(
  'create_document',
  { title: 'MCP e2e', type: 'page', content: { fields: { body: [] } } },
  token,
)
const id = created.value?.id
// `url` (`/mcp-e2e`), not `path` (`mcp-e2e`) — `ApiDocumentMeta`'s two path
// fields, and only one of them is fetchable as-is against `${HTTP}`.
const url = created.value?.url
if (!id) {
  console.log(`\nFAIL  create_document returned no id: ${JSON.stringify(created)}`)
  process.exit(1)
}
check(
  'create_document creates a routed page',
  typeof id === 'string' && typeof url === 'string',
  JSON.stringify(created.value),
)

const wrote = await callTool(
  'write_content',
  { id, content: { fields: { body: [{ type: 'hero', fields: { heading: 'Written by MCP' } }] } } },
  token,
)
check(
  'write_content reports a mutation, the same shape PUT /content answers',
  typeof wrote.value?.changed === 'number' && wrote.value.changed > 0,
  JSON.stringify(wrote.value),
)

/**
 * **The no-binding path — the only one this script, or `pnpm dev`, can ever
 * reach.** Cloudflare's browser is remote and cannot reach `localhost`
 * (decision 5a), and the demo declares no `browser` binding at all. So this
 * answers the draft URL and the rendered HTML instead of an image, and has to
 * say so plainly rather than failing — the acceptance criterion this script
 * exists to drive against a real deployment shape, not a workerd fixture.
 */
const preview = await rpc('tools/call', { name: 'preview_document', arguments: { id } }, token)
check(
  'preview_document does not fail with no browser binding',
  preview.json?.error === undefined,
  JSON.stringify(preview.json?.error),
)
const previewContent = preview.json?.result?.content ?? []
check(
  'it names the draft URL and gives the rendered HTML, saying plainly why there is no image',
  previewContent.length === 2 &&
    previewContent[0]?.type === 'text' &&
    previewContent[0]?.text?.includes('No `browser` binding is configured') &&
    previewContent[0]?.text?.includes('_folio=draft') &&
    previewContent[1]?.type === 'text' &&
    previewContent[1]?.text?.includes('Written by MCP'),
  JSON.stringify(previewContent[0]?.text ?? previewContent),
)

const published = await callTool('publish_document', { id }, token)
check(
  'publish_document publishes with no error',
  published.error === undefined,
  JSON.stringify(published.error),
)

const live = await realFetch(`${HTTP}${url}`).then((r) => r.text())
check(
  'the published page renders exactly what the tool calls wrote',
  live.includes('Written by MCP'),
  live.slice(0, 160),
)

/* --- the activity trail names the token, not the person who minted it ---- */

const { rows: trail } = await asAdmin(`/story/${id}/activity`)
check(
  'the activity trail names token:e2e mcp',
  trail.some((e) => e.actor === 'token:e2e mcp'),
  JSON.stringify(trail.map((e) => e.actor)),
)

check('the session cookie was carried, so the admin routes answered', typeof cookie === 'string')

/* --- the partition: {base}/mcp is outside /api, {base}/api/mcp is not ---- */

check('GET {base}/mcp is 405 with Allow: POST', (await realFetch(MCP)).status === 405)
check(
  '{base}/api/mcp and {base}/api/v1/mcp both 404, unlike {base}/mcp',
  (await realFetch(`${HTTP}/folio/api/mcp`)).status === 404 &&
    (await realFetch(`${HTTP}/folio/api/v1/mcp`)).status === 404,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
