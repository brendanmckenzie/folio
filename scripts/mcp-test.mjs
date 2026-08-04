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
//  1. `server/discover` succeeds with no credential, and the tools/list that
//     follows is empty — the honest answer to a client that has not
//     configured a token yet. A Legacy `initialize` is refused with the
//     supported-version list, which is the only diagnostic such a client gets.
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
 * The MCP revision this endpoint speaks. A literal rather than an import for the
 * reason the header comment gives — `mcp/rpc.ts` is reachable from Node, but the
 * tool names beside it are not, and one import that works while the rest are
 * literals reads as if the whole file were checked against source.
 */
const MCP_VERSION = '2026-07-28'

/**
 * One JSON-RPC request over plain POST — no upgrade, no stream, no session.
 *
 * **This used to say it deliberately stamped no wire version anywhere, and that
 * is now exactly backwards.** Revision `2026-07-28` removed the `initialize`
 * handshake, so there is no negotiated session to carry a version for: every
 * request declares its own, in an `MCP-Protocol-Version` header that must agree
 * with the body's `_meta`, plus `Mcp-Method` and — for a `tools/call` —
 * `Mcp-Name`, mirrored so an intermediary can route without parsing a body. So
 * this is the one caller in the test surface that stamps *two* versions and
 * neither of them is `PROTOCOL_VERSION`: MCP's revision here, and Folio's own on
 * the socket elsewhere.
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
      'mcp-protocol-version': MCP_VERSION,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++nextId,
      method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION } },
    }),
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

/* --- discovery, with no credential --------------------------------------- */

const found = await rpc('server/discover')
check(
  'server/discover succeeds with no credential at all',
  found.status === 200 &&
    found.json?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name === 'folio',
  JSON.stringify(found.json),
)
check(
  'it advertises 2026-07-28 as a supported revision',
  Array.isArray(found.json?.result?.supportedVersions) &&
    found.json.result.supportedVersions.includes(MCP_VERSION),
  JSON.stringify(found.json?.result?.supportedVersions),
)

// A Legacy client's opening message. Refused — there is no handshake to answer —
// but the refusal has to name the versions that would work, because a Legacy
// client has no fall-forward and this is the only diagnostic its user will see.
// Sent through `realFetch` directly rather than `rpc`, because the whole point is
// a request built the old way: no version header, no `_meta`.
const legacy = await realFetch(MCP, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-test.mjs' } },
  }),
})
const legacyBody = await legacy.json().catch(() => null)
check(
  'a Legacy initialize is refused on a 400 naming the supported revisions',
  legacy.status === 400 &&
    legacyBody?.error?.code === -32022 &&
    legacyBody.error.data?.supported?.includes(MCP_VERSION),
  JSON.stringify(legacyBody?.error),
)

// The header is required, and its absence is a refusal rather than an assumed
// revision — over real HTTP, because a header is the one thing an in-process
// Request can be given by hand and a real client can still forget.
const bare = await realFetch(MCP, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
})
const bareBody = await bare.json().catch(() => null)
check(
  'a POST with no MCP-Protocol-Version header is refused with -32020',
  bare.status === 400 && bareBody?.error?.code === -32020,
  JSON.stringify(bareBody?.error),
)

const anonList = await rpc('tools/list')
check(
  'an unauthenticated tools/list answers no tools at all',
  Array.isArray(anonList.json?.result?.tools) && anonList.json.result.tools.length === 0,
  JSON.stringify(anonList.json?.result),
)

// Deliberately headerless, and deliberately a Legacy method name: the transport
// defines no header rules for a notification POST, so this is the one shape that
// is still accepted bare — which also means a Legacy client's `initialized` is
// dropped quietly rather than erroring into a void it cannot read.
const notified = await realFetch(MCP, {
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})
check('a headerless notification still gets 202 and no body', notified.status === 202)

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
