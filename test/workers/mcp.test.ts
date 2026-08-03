import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import type { NestedDoc } from '../../src/core/nested'
import type { DocumentType } from '../../src/core/schema'
import type { AuthConfig, FolioBindings } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import type { Role, Scope } from '../../src/server/auth/roles'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import { MCP_PROTOCOL_VERSION } from '../../src/server/routes/mcp'
import { STORY_STATE } from '../../src/server/validate'

/**
 * `{base}/mcp` over real workerd, real D1 and real Durable Objects
 * (`../../../docs/specs/platform/mcp-server.md` phase 3).
 *
 * Its own `createFolio` with providers configured, for the reason
 * `api.test.ts`'s header gives: every scope filter here is only observable under
 * `auth: 'session'`, because every gate short-circuits under `auth: 'open'`.
 * A second instance runs `auth: 'open'` precisely to assert that short-circuit,
 * and a third runs `mcp: false`.
 *
 * The **token is named `claude`** rather than `importer`, because
 * `token:<name>` in `versions.actor` is a spec requirement rather than a detail.
 */

const ORIGIN = 'https://mcp.test'
const BASE = `${ORIGIN}/folio`
const MCP = `${BASE}/mcp`

const hero = defineBlock({
  name: 'mcpHero',
  label: 'Hero',
  summary: 'heading',
  fields: { heading: text() },
  render: () => null,
})

const pageRoot = defineBlock({
  name: 'mcpPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text({ indexed: true }), body: blocks({ allow: ['mcpHero'] }) },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'mcpPageType', label: 'Page', kind: 'page', root: 'mcpPage', default: true },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
}

/**
 * Every publish fires this, and it is **not** in `hooks.await` — so
 * `createHookRunner` hands it to `ctx.waitUntil`. That is the whole apparatus
 * the `ExecutionContext` assertion below needs: the purge itself is an internal
 * awaited hook and cannot be observed, and Workers Cache is not simulated by
 * miniflare at all, so the *hook* is what a test can watch.
 */
const publishedIds: string[] = []

function build(over: { mode?: AuthConfig<Cloudflare.Env> | 'open'; mcp?: boolean } = {}) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot, hero],
    types,
    bindings,
    basePath: '/folio',
    auth: over.mode ?? auth,
    route: (p) => (p ? `/${p}` : '/'),
    hooks: {
      published: async (e) => {
        // Deliberately asynchronous: a hook that resolves on the microtask queue
        // is one whose completion depends on `waitUntil` having been reached.
        await Promise.resolve()
        publishedIds.push(e.story.id)
      },
    },
    ...(over.mcp === undefined ? {} : { mcp: over.mcp }),
  })
}

const folio = build()
const open = build({ mode: 'open' })
const off = build({ mcp: false })

function call(path: string, init?: RequestInit, on = folio, ctx = createExecutionContext()) {
  return on.handle(new Request(path, init), env, ctx) as Promise<Response>
}

/** A token with these scopes, named `claude`, and the header to send it with. */
async function tokenFor(...scopes: Scope[]) {
  const { token } = await createToken(env.DB, { name: 'claude', scopes })
  return { authorization: `Bearer ${token}` }
}

let people = 0

async function cookieFor(role: Role) {
  const user = await createUser(env.DB, {
    email: `${role}${people++}@example.com`,
    name: role,
    role,
  })
  const session = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${session.token}` }
}

/* ---------------------------------------------------------------- the wire --- */

interface RpcAnswer<T = unknown> {
  jsonrpc: string
  id: number | string | null
  result?: T
  error?: { code: number; message: string }
}

let nextId = 0

async function rpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  init: {
    headers?: Record<string, string>
    on?: ReturnType<typeof build>
    ctx?: ExecutionContext
  } = {},
): Promise<RpcAnswer<T>> {
  const res = await call(
    MCP,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    },
    init.on ?? folio,
    init.ctx ?? createExecutionContext(),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as RpcAnswer<T>
}

interface ToolResult {
  content: { type: string; text: string }[]
}

const listed = async (headers?: Record<string, string>, on?: ReturnType<typeof build>) =>
  (
    await rpc<{ tools: { name: string; description: string }[] }>('tools/list', {}, { headers, on })
  ).result!.tools.map((tool) => tool.name)

/** A tool call, with its JSON payload already unwrapped when it succeeded. */
async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
  ctx?: ExecutionContext,
): Promise<{ value?: T; error?: { code: number; message: string } }> {
  const answer = await rpc<ToolResult>('tools/call', { name, arguments: args }, { headers, ctx })
  if (answer.error) return { error: answer.error }
  return { value: JSON.parse(answer.result!.content[0]!.text) as T }
}

const READS = ['get_schema', 'search_documents', 'query_documents', 'get_document', 'list_versions']

beforeEach(async () => {
  publishedIds.length = 0
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
    env.DB.prepare('delete from versions'),
    env.DB.prepare('delete from content_index'),
    env.DB.prepare('delete from content_refs'),
    env.DB.prepare('delete from stories'),
  ])
})

/* -------------------------------------------------------------- initialize --- */

describe('initialize', () => {
  /**
   * **Succeeds with no credential, and that is deliberate.** An MCP client
   * probes before it is configured, and a 401 at `initialize` presents as "the
   * server is broken" rather than "the token is missing".
   */
  it('answers an unauthenticated handshake', async () => {
    const answer = await rpc<{
      protocolVersion: string
      capabilities: { tools: unknown }
      serverInfo: { name: string; version: string }
    }>('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'probe' } })

    expect(answer.error).toBeUndefined()
    expect(answer.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'folio', version: '0.0.0' },
    })
  })

  /** The honest answer to "what may I do" with nothing presented: nothing. */
  it('offers no tools at all to an unauthenticated caller', async () => {
    expect(await listed()).toEqual([])
  })

  /**
   * Liveness, answered without a credential like the handshake above it. MCP
   * requires a receiver to answer `ping` promptly; a client that keepalives reads
   * a `-32601` as a dead peer and drops the session, which for a hosted client
   * nobody here can patch is the most expensive way to be almost right.
   */
  it('answers ping, with or without a credential', async () => {
    expect((await rpc('ping')).result).toEqual({})
    expect((await rpc('ping', {}, { headers: await tokenFor('content:read') })).result).toEqual({})
  })

  it('answers a notification with 202 and no body', async () => {
    const res = await call(MCP, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('refuses a GET with 405 and Allow: POST', async () => {
    const res = await call(MCP)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })
})

/* -------------------------------------------------------------- tools/list --- */

describe('tools/list', () => {
  it('content:read — the reads, and no write, publish or delete', async () => {
    const offered = await listed(await tokenFor('content:read'))
    expect(offered).toEqual(READS)
  })

  it('content:write — the writes appear, delete_document does not', async () => {
    const offered = await listed(await tokenFor('content:write'))
    expect(offered).toContain('write_content')
    expect(offered).toContain('restore_version')
    expect(offered).not.toContain('delete_document')
    expect(offered).not.toContain('publish_document')
  })

  it('publish — publish and unpublish, and no content write', async () => {
    const offered = await listed(await tokenFor('publish'))
    expect(offered).toEqual([...READS, 'publish_document', 'unpublish_document'])
  })

  /** `IMPLIES` grants `assets:write` no content access at all, which is why it is
   * a separate scope rather than a rung on a ladder. */
  it('assets:write — upload_asset and nothing else', async () => {
    expect(await listed(await tokenFor('assets:write'))).toEqual(['upload_asset'])
  })

  it('admin — every tool, including delete_document', async () => {
    const offered = await listed(await tokenFor('admin'))
    expect(offered).toContain('delete_document')
    expect(offered).toHaveLength(15)
  })

  /**
   * A session cookie reaches here too, and a `UserActor` is filtered by role
   * through the same `Access` pair with no special case.
   */
  it('filters a session cookie by role, with no special case', async () => {
    expect(await listed(await cookieFor('viewer'))).toEqual(READS)
    const publisher = await listed(await cookieFor('publisher'))
    expect(publisher).toContain('publish_document')
    expect(publisher).not.toContain('delete_document')
  })

  /**
   * **`auth: 'open'` offers every tool**, exactly as `/api/v1` already answers
   * every request: every route gate short-circuits on the mode, so filtering
   * here would advertise a restriction that does not exist. An open deployment
   * has no access control by choice, and MCP is not the place to invent some.
   */
  it('offers every tool on an open deployment, with no credential at all', async () => {
    expect(await listed(undefined, open)).toHaveLength(15)
  })

  /** Names the site's own declared types, which is a bounded list of strings
   * rather than their fields (decision 7). */
  it('names the declared document types and blocks in the descriptions', async () => {
    const answer = await rpc<{ tools: { name: string; description: string }[] }>(
      'tools/list',
      {},
      { headers: await tokenFor('content:write') },
    )
    const byName = new Map(answer.result!.tools.map((t) => [t.name, t.description]))
    expect(byName.get('create_document')).toContain('Declared document types: mcpPageType.')
    expect(byName.get('write_content')).toContain('mcpHero')
    expect(byName.get('write_content')).toContain('mcpPage')
    // The *names*, never the fields — those come from get_schema.
    expect(byName.get('write_content')).not.toContain('heading')
  })
})

/* -------------------------------------------------------------- tools/call --- */

describe('tools/call', () => {
  const created = async (title = 'Pricing') => {
    const headers = await tokenFor('content:write')
    const answer = await callTool<{ id: string }>(
      'create_document',
      { title, content: { type: 'mcpPage', fields: { title, body: [] } } },
      headers,
    )
    return { id: answer.value!.id, headers }
  }

  it('dispatches a read to its v1 route and answers the route’s own JSON', async () => {
    const { id, headers } = await created()
    const answer = await callTool<{ id: string; source: string; content: NestedDoc }>(
      'get_document',
      { id, status: 'draft' },
      headers,
    )
    expect(answer.value?.id).toBe(id)
    expect(answer.value?.source).toBe('draft')
    expect(answer.value?.content.fields.title).toBe('Pricing')
  })

  /**
   * The attribution requirement: a token named `claude` produces `token:claude`
   * in `versions.actor`, in the object's log and in the activity trail — not the
   * person who minted the token.
   */
  it('writes and publishes as token:<name>', async () => {
    const { id, headers: write } = await created()

    const wrote = await callTool<{ changed: number }>(
      'write_content',
      {
        id,
        content: {
          type: 'mcpPage',
          fields: { title: 'Pricing', body: [{ type: 'mcpHero', fields: { heading: 'Plans' } }] },
        },
      },
      write,
    )
    expect(wrote.value?.changed).toBeGreaterThan(0)

    const published = await callTool<{ publishedAt: number }>(
      'publish_document',
      { id },
      await tokenFor('publish'),
    )
    expect(published.error).toBeUndefined()

    const row = await env.DB.prepare('select actor from versions where story_id = ?')
      .bind(id)
      .first<{ actor: string }>()
    expect(row?.actor).toBe('token:claude')

    const trail = await call(`${BASE}/api/story/${id}/activity`, {
      headers: await cookieFor('admin'),
    })
    const entries = (await trail.json()) as { rows: { actor: string }[] }
    expect(entries.rows.map((r) => r.actor)).toContain('token:claude')
  })

  /**
   * **The refusal is the v1 route's own `forbidden`, not a check the MCP layer
   * invented** — which is why `tools/call` looks a tool up over the whole table
   * rather than over the filtered list. The proof is the message: `refusalOf`
   * names the missing scope, and nothing in `server/routes/mcp.ts` can produce
   * that sentence.
   */
  it('lets the route refuse a tool the token’s scopes exclude', async () => {
    const { id } = await created()
    const answer = await callTool(
      'write_content',
      { id, content: { type: 'mcpPage', fields: { title: 'Nope' } } },
      await tokenFor('content:read'),
    )
    expect(answer.error?.code).toBe(-32603)
    expect(answer.error?.message).toBe("This token is missing the 'content:write' scope.")
  })

  /**
   * `delete_document` is the **one** exception, because its `admin` requirement
   * is stricter than its route's `content:write` — so the MCP layer has to make
   * that check itself, and the document must survive.
   */
  it('refuses delete_document below admin, and leaves the document there', async () => {
    const { id, headers } = await created()
    const answer = await callTool('delete_document', { id }, headers)
    expect(answer.error?.code).toBe(-32603)
    expect(answer.error?.message).toBe("This token is missing the 'admin' scope.")

    const still = await env.DB.prepare('select id from stories where id = ?').bind(id).first()
    expect(still).toBeTruthy()
  })

  it('deletes with an admin token, which is the narrowing’s other half', async () => {
    const { id } = await created()
    const answer = await callTool<{ deleted: string[] }>(
      'delete_document',
      { id },
      await tokenFor('admin'),
    )
    expect(answer.value?.deleted).toEqual([id])
  })

  /**
   * The validation loop the library already has: `fromNested` refuses the
   * payload, `NestedError` names the path, and `rethrow` maps it to
   * `bad_request` — which is JSON-RPC's *invalid params*. The message travels
   * verbatim, because that is what an agent learns the schema from.
   */
  it('answers a refused payload with the field error, having written nothing', async () => {
    const { id, headers } = await created()

    const wrongType = await callTool(
      'write_content',
      {
        id,
        content: {
          type: 'mcpPage',
          fields: { body: [{ type: 'mcpHero', fields: { heading: 42 } }] },
        },
      },
      headers,
    )
    expect(wrongType.error?.code).toBe(-32602)
    expect(wrongType.error?.message).toBe('body[0].fields.heading must be a string')

    const undeclared = await callTool(
      'write_content',
      {
        id,
        content: {
          type: 'mcpPage',
          fields: { body: [{ type: 'mcpHero', fields: { headng: 'typo' } }] },
        },
      },
      headers,
    )
    expect(undeclared.error?.code).toBe(-32602)
    // Names the block *and* the field, which is the point of the refusal.
    expect(undeclared.error?.message).toBe("body[0].fields.headng is not a field of 'mcpHero'")

    // Nothing landed: the draft still holds no hero at all.
    const after = await callTool<{ content: NestedDoc }>(
      'get_document',
      { id, status: 'draft' },
      headers,
    )
    expect(after.value?.content.fields.body).toEqual([])
  })

  it('answers an unknown tool name with invalid params, naming it', async () => {
    const answer = await rpc('tools/call', { name: 'drop_database', arguments: {} })
    expect(answer.error?.code).toBe(-32602)
    expect(answer.error?.message).toBe("No such tool: 'drop_database'.")
  })

  it('refuses a call with no tool name', async () => {
    const answer = await rpc('tools/call', { arguments: {} })
    expect(answer.error?.code).toBe(-32602)
    expect(answer.error?.message).toContain('"name" must name a tool')
  })

  it('reports a missing path argument as invalid params', async () => {
    const answer = await rpc(
      'tools/call',
      {
        name: 'get_document',
        arguments: {},
      },
      { headers: await tokenFor('content:read') },
    )
    expect(answer.error?.code).toBe(-32602)
    expect(answer.error?.message).toBe('id is required')
  })
})

/* ------------------------------------------------- building the sub-request --- */

describe('the sub-request the table builds', () => {
  it('sends query parameters, including the flag spelling `count` needs', async () => {
    const headers = await tokenFor('content:write')
    for (const title of ['Alpha', 'Beta']) {
      await callTool('create_document', { title }, headers)
    }

    const page = await callTool<{
      rows: { title: string }[]
      total?: number
      cursor: string | null
    }>('search_documents', { q: 'alpha', count: true }, headers)
    expect(page.value?.rows.map((r) => r.title)).toEqual(['Alpha'])
    expect(page.value?.total).toBe(1)

    // `routed` is a boolean argument whose route reads the string, so this also
    // pins that `String(false)` is what `?routed=` accepts.
    const records = await callTool<{ rows: unknown[] }>(
      'search_documents',
      { routed: false },
      headers,
    )
    expect(records.value?.rows).toEqual([])
  })

  /**
   * **The advertised `state` domain reaches the route unrefused.** This shipped
   * wrong: the input schema offered `published`, which `StoryState` does not
   * name, and omitted `live`, which is the value that means published — so the
   * one value a model was most likely to pick was the one guaranteed to be a
   * `bad_request`. An `enum` in an input schema is a second copy of the route's
   * validation, which is decision 2's fork one layer in, and it is invisible
   * unless something sends the advertised values at the real screen.
   */
  it('accepts every state the schema advertises, and refuses one it does not', async () => {
    const headers = await tokenFor('content:read')
    for (const state of STORY_STATE.options) {
      const answer = await callTool<{ rows: unknown[] }>('search_documents', { state }, headers)
      expect([state, answer.error?.message]).toEqual([state, undefined])
    }

    // The value the schema used to advertise, proving the screen is real and
    // that the list above is not simply being ignored.
    const refused = await callTool('search_documents', { state: 'published' }, headers)
    expect(refused.error?.message).toContain('must be one of')
  })

  /**
   * **The tool table is the boundary, so an argument must not be able to move
   * the path** (decision 2). A traversal-shaped id stays one segment, because
   * `fillPath` percent-encodes the separator and `new URL()` does not decode it
   * — so it reaches the route's own `idParam` screen rather than a different
   * route. Asserted on the *message*: `id contains unsupported characters` can
   * only have come from `{base}/api/v1/documents/:id`, which is the proof that
   * nothing walked out. `routes/mcp.ts` carries the belt-and-braces prefix check
   * behind this, and `test/unit/mcp/tools.test.ts` pins the encoding.
   */
  it('keeps a traversal-shaped argument inside its own path segment', async () => {
    const read = await tokenFor('content:read')
    for (const id of ['../../../login', '../../..', '../schema', '/../mcp']) {
      const answer = await callTool('get_document', { id }, read)
      expect([id, answer.error?.code]).toEqual([id, -32602])
      expect([id, answer.error?.message]).toEqual([id, 'id contains unsupported characters'])
    }

    // The same for the method whose whole tail is the argument.
    const answer = await callTool(
      'delete_document',
      { id: '../../../api/tokens/tok_x' },
      await tokenFor('admin'),
    )
    expect(answer.error?.message).toBe('id contains unsupported characters')
  })

  it('repeats an array argument as a repeated query key', async () => {
    const headers = await tokenFor('content:write')
    const { value } = await callTool<{ id: string }>(
      'create_document',
      { title: 'Findable', content: { type: 'mcpPage', fields: { title: 'Findable' } } },
      headers,
    )
    await callTool('publish_document', { id: value!.id }, await tokenFor('publish'))

    const hit = await callTool<{ items: { id: string }[] }>(
      'query_documents',
      { where: ['title:eq:Findable'], type: 'mcpPageType' },
      headers,
    )
    expect(hit.value?.items.map((d) => d.id)).toEqual([value!.id])

    // Two `where` clauses that cannot both hold: the second key reaching the
    // route at all is the thing being asserted, since one clause would pass
    // whether or not the array repeated.
    const miss = await callTool<{ items: unknown[] }>(
      'query_documents',
      { where: ['title:eq:Findable', 'title:eq:Nope'] },
      headers,
    )
    expect(miss.value?.items).toEqual([])
  })

  /**
   * The one row whose body is not JSON: `POST /assets` reads raw bytes, and
   * JSON-RPC cannot carry them, so `data` is base64 and is decoded before the
   * sub-request is built.
   */
  it('decodes base64 into the raw body upload_asset’s route reads', async () => {
    const png = 'iVBORw0KGgo='
    const answer = await callTool<{ asset: { key: string; filename: string } }>(
      'upload_asset',
      { filename: 'pixel.png', data: png },
      await tokenFor('assets:write'),
    )
    expect(answer.error).toBeUndefined()
    expect(answer.value?.asset.filename).toBe('pixel.png')
    const stored = await env.MEDIA.get(answer.value!.asset.key)
    expect(new Uint8Array((await stored!.arrayBuffer()).slice(0, 4))).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    )
  })

  it('refuses data that is not base64, before any route is reached', async () => {
    const answer = await callTool(
      'upload_asset',
      { filename: 'x.png', data: 'not base64!!' },
      await tokenFor('assets:write'),
    )
    expect(answer.error?.code).toBe(-32602)
    expect(answer.error?.message).toContain('base64')
  })
})

/* -------------------------------------------------- the ExecutionContext --- */

/**
 * **The thing decision 2 is most likely to get wrong, and no cache can see it.**
 *
 * Publish and delete purge the cache after they commit, on `ctx.waitUntil`. A
 * route reaches it through `hookCtx(c)`, which dereferences `c.executionCtx` —
 * populated by Hono from the third argument to `app.fetch`. The internal
 * dispatch therefore has to hand the *outer* request's context to the inner one,
 * and `platform/caching.md` warns that a missing `waitUntil` is unobservable in
 * every test because Workers Cache is not simulated by miniflare.
 *
 * So this asserts it **on the hook**: the context handed to `folio.handle` for
 * the `/mcp` POST records what is deferred on it, and a publish dispatched
 * through a tool call must show up there. A read must not, which is what rules
 * out the assertion passing for some unrelated reason.
 */
describe('the ExecutionContext reaches the dispatched route', () => {
  const spying = () => {
    const real = createExecutionContext()
    const deferred: Promise<unknown>[] = []
    const spy = Object.create(real) as ExecutionContext
    spy.waitUntil = (p: Promise<unknown>) => {
      deferred.push(p)
      real.waitUntil(p)
    }
    return { real, spy, deferred }
  }

  it('carries the live context into publish, so the after-commit hook runs', async () => {
    const write = await tokenFor('content:write')
    const { value } = await callTool<{ id: string }>(
      'create_document',
      { title: 'Live', content: { type: 'mcpPage', fields: { title: 'Live' } } },
      write,
    )
    const id = value!.id

    const { real, spy, deferred } = spying()
    const answer = await callTool('publish_document', { id }, await tokenFor('publish'), spy)
    expect(answer.error).toBeUndefined()

    // The inner route deferred work on the context the *outer* request was
    // handed. Dropping the ctx in the dispatch makes this empty.
    expect(deferred).toHaveLength(1)

    await waitOnExecutionContext(real)
    expect(publishedIds).toEqual([id])
  })

  it('defers nothing for a read, so the assertion above is about the hook', async () => {
    const read = await tokenFor('content:read')
    const { spy, deferred } = spying()
    await callTool('get_schema', {}, read, spy)
    expect(deferred).toEqual([])
  })
})

/* ---------------------------------------------------------------- mcp: false --- */

describe('createFolio({ mcp: false })', () => {
  /**
   * Owner checkpoint 2: on by default, off in config. Gated by the same token
   * table as `/api/v1`, so "on" adds no reachable surface a token could not
   * already reach — but a host with no tokens minted should be able to say so
   * rather than leave it to be inferred.
   */
  it('does not answer the endpoint at all', async () => {
    const res = await call(
      MCP,
      { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) },
      off,
    )
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('jsonrpc')
  })

  it('leaves /api/v1 alone, so the flag is about the endpoint and nothing else', async () => {
    const res = await call(
      `${BASE}/api/v1/schema`,
      { headers: await tokenFor('content:read') },
      off,
    )
    expect(res.status).toBe(200)
  })
})
