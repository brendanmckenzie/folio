/**
 * `{base}/mcp` — one POST speaking MCP over Streamable HTTP
 * (`../../../../docs/specs/platform/mcp-server.md`).
 *
 * **Outside `/api`, and deliberately unversioned** (decision 8). Not under
 * `/api` because an unmatched path there terminates in Folio's JSON 404 envelope
 * and every route below it answers `errors.ts`'s single shape, while MCP answers
 * JSON-RPC: a 200 carrying an `error` object with its own code space. One prefix
 * with two error envelopes is exactly the sibling confusion
 * `test/workers/api-partition.test.ts` exists to prevent. Unversioned because MCP
 * carries its own revision on every request and tools are *discovered* rather than
 * compiled against — renaming a tool costs a client one refresh of `tools/list`,
 * not a deploy.
 *
 * **This endpoint is modern-only: MCP revision `2026-07-28`.** There is no
 * handshake and no session. Every POST declares its revision in an
 * `MCP-Protocol-Version` header that must agree with the body's `_meta`, and
 * `server/discover` answers what used to take `initialize`. `initialize` itself is
 * refused with the supported-version list, which is both the spec's SHOULD for a
 * modern-only server and the signal a dual-era client needs. See `../mcp/rpc.ts`
 * for the order those checks run in and why the order is the contract.
 *
 * **The route itself is ungated, and each tool call is gated by the route it
 * dispatches to.** `server/discover` with no credential succeeds and `tools/list`
 * is then empty: an MCP client probes before it is configured, and a 401 at
 * discovery presents as "the server is broken" rather than "the token is
 * missing". The empty list is the honest answer, and it is the only thing an
 * uncredentialed caller learns here.
 */
import type { Context, Hono } from 'hono'
import { Hono as HonoApp } from 'hono'
import type { Actor } from '../auth/roles'
import { type ErrorEnvelope, FolioError } from '../errors'
import {
  handleRpc,
  INVALID_PARAMS,
  RpcFault,
  type RpcMethod,
  rpcCodeFor,
  SUPPORTED_VERSIONS,
} from '../mcp/rpc'
import { previewDocument, type PreviewDocumentContext } from '../mcp/shot'
import {
  fillPath,
  MCP_TOOLS,
  type McpTool,
  nonBodyKeys,
  type ToolMethod,
  toolByName,
  toolsFor,
} from '../mcp/tools'
import { ensureAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { API_VERSION } from './api'

/**
 * A tool row that names a v1 route — every row but `preview_document`
 * (`../mcp/tools.ts`'s header comment). `dispatch`, below, only ever runs
 * against one of these; `hasRoute` is how `tools/call` tells the two apart
 * without asserting.
 */
type RoutedTool = McpTool & { method: ToolMethod; path: string }

function hasRoute(tool: McpTool): tool is RoutedTool {
  return tool.path !== undefined
}

/** `version` tracks the package's, which is pre-release and says so. */
const SERVER_INFO = { name: 'folio', version: '0.0.0' } as const

/**
 * `DiscoverResult._meta`'s key for the server's own identity. Self-reported and
 * unverified by the protocol, which is why the spec tells clients not to make
 * behavioural or security decisions from it — it is for display and logs.
 */
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/**
 * `instructions` is the one place a server can address the model in prose rather
 * than through a tool description, so it carries the two things that are true of
 * every tool here and are not visible from any single one: the list is filtered by
 * what the credential may do, and a write is a real edit that people see.
 */
const INSTRUCTIONS = [
  'Folio is a block-based CMS. Documents are trees of typed blocks; call get_schema first to learn the site’s block and field shapes before writing.',
  'The tools offered are already filtered to what this credential may do, so anything listed is permitted and nothing else exists to try.',
  'Writes go through the same log a human editor’s keystrokes do: an edit appears live in any open editor, is attributed to this token in the activity trail, and is undoable. Publishing is a separate, explicit step.',
].join(' ')

export function mcpRoutes<Env>(
  rt: FolioRuntime,
  /**
   * The mounted app, for the internal dispatch below. A live reference rather
   * than a copy: `createApp` passes the app it is still registering routes on,
   * and Hono resolves a path at request time, so every route mounted after this
   * one is reachable all the same.
   */
  app: Hono<FolioEnv<Env>>,
): Hono<FolioEnv<Env>> {
  const routes = new HonoApp<FolioEnv<Env>>()

  /* ------------------------------------------------------------ dispatch --- */

  /**
   * A tool call, as a sub-request to the tool's own v1 route.
   *
   * **This is decision 2, and it is the whole design.** The row names a method
   * and a path; this builds a `Request` for it, copies the caller's credential
   * onto it, and calls the mounted app's own `fetch`. No network hop — it is a
   * function call — and no second implementation of the gate, the validator or
   * the nested-shape translation. The cost, named rather than optimised: one
   * extra `readToken`, because `withActor` resolves the credential again for the
   * sub-request. That is one indexed D1 read against a table with a unique index
   * on the hash. A signed internal header that skipped the gate is how a gate
   * stops being one.
   *
   * Two things ride along and both are load-bearing:
   *
   *   - **The credential.** `credentialOf` (`auth/resolve.ts`) reads the session
   *     cookie *and* `Authorization: Bearer`, cookie first, so whichever the
   *     caller sent is copied across verbatim. A session cookie reaching `/mcp`
   *     is an ordinary case, not a special one. The `Origin` header is
   *     deliberately **not** copied: `withActor`'s cross-site check has already
   *     run against the real request, and re-presenting a fabricated origin to
   *     the inner one would be checking our own paperwork.
   *   - **The live `ExecutionContext`.** Publish and delete defer work after they
   *     commit — the cache purge, and every host hook not named in `hooks.await`
   *     — and a route reaches it through `hookCtx(c)`, which dereferences
   *     `c.executionCtx`, populated by Hono from the third argument to
   *     `app.fetch`. `../platform/caching.md` warns that a missing `waitUntil` is
   *     unobservable in every test, because Workers Cache is not simulated by
   *     miniflare, so `test/workers/mcp.test.ts` asserts this on **the hook**
   *     rather than on the cache: the context handed to the outer `/mcp` POST has
   *     to be the one the inner route defers on.
   *
   *     Worth knowing for the next reader: omitting the third argument here is
   *     not in fact silent, because `hookCtx`'s closure *throws* on a context
   *     that has none — a publish through a tool call answers a 500. It is only
   *     silent for a deployment with nothing to defer, which is exactly the
   *     deployment for which it does not matter.
   *
   * There is no recursion to guard against: the *shape* of the path comes from
   * the table, and the check below keeps the filled-in result under
   * `{base}/api/v1` whatever an argument tries, so a tool can never address
   * `/mcp` or anything else on the mount.
   */
  /**
   * `authorization`/`cookie`, copied from the caller verbatim and nothing
   * else. The one rule two callers share: `dispatch`'s internal `fetch`
   * (below) and `preview_document`'s direct read of the request
   * (`previewContext`, below that) both need the caller's credential and
   * neither needs — nor should forward — anything else, `Origin` included
   * (see `dispatch`'s own comment on why). Written once so neither can drift
   * from the other.
   */
  const credentialHeaders = (c: Context<FolioEnv<Env>>): Record<string, string> => {
    const headers: Record<string, string> = {}
    const authorization = c.req.header('authorization')
    if (authorization) headers.authorization = authorization
    const cookie = c.req.header('cookie')
    if (cookie) headers.cookie = cookie
    return headers
  }

  const dispatch = async (
    c: Context<FolioEnv<Env>>,
    tool: RoutedTool,
    args: Record<string, unknown>,
  ): Promise<Response> => {
    const url = new URL(`${rt.base}/api/${API_VERSION}${fillPath(tool.path, args)}`, c.req.url)

    /**
     * **"A tool cannot reach further than the API does" (decision 2), stated
     * where it can be checked rather than only where it is meant.**
     *
     * `fillPath`'s `encodeURIComponent` is what makes it true today: a `/` in an
     * argument becomes `%2F`, which `new URL()` does *not* decode, so the
     * argument stays one path segment and a traversal-shaped id reaches the
     * route's own `idParam` screen instead of a different route. That is a fact
     * about one stdlib call, one careless refactor from `String(value)` — and
     * `new URL()` normalises `..` before any router sees the path, so getting it
     * wrong would silently point a tool at `{base}/login`. Nothing would
     * escalate (the sub-request carries the caller's own credential either way),
     * but the table would stop being the boundary the whole design rests on.
     *
     * So the invariant is asserted on the *normalised* pathname, which is total:
     * it holds for `..`, for a separator however it is spelled, and for whatever
     * the next surprise in URL parsing turns out to be. Unreachable while
     * `fillPath` encodes, deliberately — `test/unit/mcp/tools.test.ts` pins the
     * encoding that keeps it that way.
     */
    if (!url.pathname.startsWith(`${rt.base}/api/${API_VERSION}/`)) {
      throw new FolioError('bad_request', 'A tool argument may not change the path it addresses')
    }

    for (const key of tool.query ?? []) {
      const value = args[key]
      if (value === undefined || value === null) continue
      // An array repeats the key, which is how `?where=` and `?type=` are spelled.
      for (const one of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(one))
      }
    }
    for (const key of tool.flags ?? []) {
      if (args[key] === true) url.searchParams.set(key, '1')
    }

    const headers = new Headers(credentialHeaders(c))

    let body: BodyInit | undefined
    if (tool.body === 'json') {
      const skip = nonBodyKeys(tool)
      const payload: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) {
        if (!skip.has(key)) payload[key] = value
      }
      headers.set('content-type', 'application/json')
      body = JSON.stringify(payload)
    } else if (tool.body === 'base64') {
      body = decodeBase64(args.data)
    }

    return app.fetch(
      new Request(url, { method: tool.method, headers, body }),
      c.env,
      c.executionCtx,
    )
  }

  /** The v1 route's answer as MCP tool content, or its envelope as a JSON-RPC error. */
  const resultOf = async (res: Response): Promise<unknown> => {
    const text = await res.text()
    if (res.ok) return { content: [{ type: 'text', text }] }

    // Every v1 failure is `errors.ts`'s one envelope, and its message is written
    // to be acted on, so it travels verbatim. A non-JSON body here would mean a
    // platform failure rather than a route's refusal, so the status is all there
    // is to report.
    let envelope: ErrorEnvelope | undefined
    try {
      envelope = JSON.parse(text) as ErrorEnvelope
    } catch {
      envelope = undefined
    }
    const error = envelope?.error
    throw new RpcFault(
      rpcCodeFor(error?.code),
      error?.message ?? `That route answered ${res.status}.`,
    )
  }

  /* ------------------------------------------------------------- methods --- */

  /**
   * The tools this actor may call.
   *
   * Filtered by `allows`, which is `hasScope` for a token and a role comparison
   * for a person, so a `UserActor` arriving by session cookie needs no special
   * case (decision 6). **A tool you cannot call does not appear**: a model that
   * can see `publish_document` will try it, and a 403 mid-task reads as a
   * malfunction rather than a boundary — but more importantly the tool list is
   * the only place an agent learns what it may do, so a list that overstates the
   * grant is a lie told at the one moment the agent is deciding what to attempt.
   *
   * Under `auth: 'open'` every tool is offered, exactly as `/api/v1` already
   * answers every request: every route gate short-circuits on the mode
   * (`auth/resolve.ts`), so filtering here would advertise a restriction that
   * does not exist. An open deployment has no access control by choice, and MCP
   * is not the place to invent some.
   */
  const offered = (actor: Actor | null): readonly McpTool[] =>
    rt.auth.mode !== 'session' ? MCP_TOOLS : toolsFor(actor)

  /**
   * The description a client sees: the row's own, plus the site's declared type
   * or block names where the row asks for them (decision 7). A bounded list of
   * strings, not their fields — the fields come from `get_schema` — and it costs
   * nothing because the manifest is derived at construction. **Phase 5 step 4
   * owns growing this**; it is the one seam a dynamic description needs.
   */
  const described = (tool: McpTool): string => {
    if (tool.manifest === 'types') {
      const names = rt.types.map((type) => type.name).join(', ')
      return `${tool.description} Declared document types: ${names}.`
    }
    if (tool.manifest === 'blocks') {
      const names = Object.keys(rt.schema).join(', ')
      return `${tool.description} Declared blocks: ${names}.`
    }
    return tool.description
  }

  /**
   * The one non-route tool's own context: the request's own URL — so a
   * relative preview URL (a host's `route` may return one, and
   * `{base}/preview/global/:name` always does) becomes an absolute one a
   * remote browser can reach — and the same credential, copied the same
   * way `dispatch` copies it.
   */
  const previewContext = (c: Context<FolioEnv<Env>>): PreviewDocumentContext => ({
    origin: c.req.url,
    headers: credentialHeaders(c),
  })

  const methodsFor = (c: Context<FolioEnv<Env>>): Record<string, RpcMethod> => ({
    /**
     * **Mandatory in `2026-07-28`** (`server/discover` is a MUST), and the whole
     * of what used to be `initialize`: supported revisions, capabilities and
     * identity in one request, with no session established and nothing remembered.
     *
     * Calling it is *optional for a client* — it may send any RPC inline and
     * handle `UnsupportedProtocolVersionError` — so this is a convenience and a
     * probe, never a gate. Like the rest of the endpoint it answers without a
     * credential: a client discovers before it is configured, and refusing here
     * would present as a broken server rather than a missing token.
     *
     * `capabilities.tools` is an empty object rather than `{ listChanged: true }`:
     * the list is derived from the code and the credential, so it cannot change
     * under a client and there is no notification to promise. No `subscriptions`
     * capability for the same reason — nothing here ever pushes.
     *
     * **No `ttlMs` or `cacheScope`.** Both are optional, and declaring a cache
     * lifetime is a promise that this answer does not vary. It does not vary
     * today, and it is one small object to recompute, so the promise buys nothing
     * and would be the thing quietly broken by the first capability that depends
     * on who is asking.
     */
    'server/discover': () => ({
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    }),

    /**
     * Liveness. **This is the fifth message, and decision 9's "four" did not
     * exclude it** — that enumeration is of the *tool* surface, the things that
     * would have needed a stream or a session. `ping` is a transport obligation
     * of the base protocol, in the same category as the `GET` below answering
     * 405 rather than an empty stream: MCP requires a receiver to answer it
     * promptly, and a client that keepalives reads a `-32601` as a dead peer and
     * tears the session down. For an endpoint whose whole premise is being
     * reachable from a hosted client nobody here can patch, that is the most
     * expensive kind of deviation and the hardest to observe. It needs no state,
     * no stream and no declared capability.
     */
    ping: () => ({}),

    'tools/list': () => ({
      tools: offered(c.var.actor).map((tool) => ({
        name: tool.name,
        description: described(tool),
        inputSchema: tool.inputSchema,
      })),
    }),

    /**
     * **Looked up over the whole table, not the filtered list**, and that is an
     * acceptance criterion rather than an oversight: a tool the credential
     * excludes is dispatched anyway so the refusal is *the v1 route's own*
     * `forbidden`, naming the missing scope, rather than a second gate the MCP
     * layer invented and would have to keep in step. `delete_document` is one
     * exception, because its `admin` requirement is stricter than its route's;
     * `preview_document` is the other, because it has no route to do the
     * refusing at all — both are `narrowed`, and `ensureAccess` below is the
     * only gate either one gets (see `narrowed` in `../mcp/tools.ts`).
     */
    'tools/call': async (params) => {
      const name = params.name
      if (typeof name !== 'string') {
        throw new RpcFault(INVALID_PARAMS, '"name" must name a tool.')
      }
      const tool = toolByName(name)
      if (!tool) throw new RpcFault(INVALID_PARAMS, `No such tool: '${name}'.`)

      const args =
        typeof params.arguments === 'object' &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}

      if (tool.narrowed) ensureAccess(rt, c.var.actor, tool.need)

      // `preview_document` alone has no v1 route to dispatch to (decisions 5,
      // 5a) — `ensureAccess` above is already its only gate, and it runs
      // before this branch so that ordering holds whichever way it goes.
      if (!hasRoute(tool)) {
        return previewDocument(rt, c.var.bindings(), previewContext(c), args)
      }

      return resultOf(await dispatch(c, tool, args))
    },
  })

  /* -------------------------------------------------------------- routes --- */

  /**
   * **The HTTP status comes from the outcome, not from this handler.** Since
   * `2026-07-28` it is protocol-significant: a `400` carrying a recognised modern
   * error is how a dual-era client learns to retry as modern instead of falling
   * back to `initialize`, and a `404` with `-32601` separates "no such method" from
   * a `404` served by something that is not an MCP endpoint at all. `rpc.ts` owns
   * that mapping because it owns which error was raised.
   */
  routes.post('/mcp', async (c) => {
    const { status, response } = await handleRpc(await c.req.text(), methodsFor(c), (name) =>
      c.req.header(name),
    )
    // A notification has no response, and 202 is what Streamable HTTP says to
    // answer when there is nothing to send back.
    if (!response) return c.body(null, 202)
    return c.json(response, status as 200)
  })

  /**
   * **`2026-07-28` removed the GET stream and protocol-level sessions from
   * Streamable HTTP outright**, so this is no longer a server declining an optional
   * channel — there is no such channel to decline. A server on this revision that
   * receives the older transport's traffic is told to answer `405` to a GET *or a
   * DELETE* (the latter was how a session was terminated), and to ignore
   * `Mcp-Session-Id` and `Last-Event-ID` rather than honour them. Ignoring is what
   * this endpoint has always done, having never had a session to name.
   */
  const noStream = (c: Context<FolioEnv<Env>>) =>
    c.text(
      'This endpoint speaks JSON-RPC over POST. MCP revision 2026-07-28 removed the GET stream and protocol-level sessions, so there is nothing to GET and no session to delete.',
      405,
      { allow: 'POST' },
    )

  routes.get('/mcp', noStream)
  routes.delete('/mcp', noStream)

  return routes
}

/**
 * Base64 to bytes. `atob` is in workerd; `Buffer` is not.
 *
 * The buffer is allocated explicitly rather than by `new Uint8Array(n)` so its
 * type is `ArrayBuffer` and not `ArrayBufferLike` — the latter is not a
 * `BodyInit`, and casting to make it one would be hiding the same question.
 */
function decodeBase64(value: unknown): ArrayBuffer {
  if (typeof value !== 'string') {
    throw new RpcFault(INVALID_PARAMS, 'data must be a base64 string')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new RpcFault(INVALID_PARAMS, 'data is not valid base64')
  }
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return buffer
}
