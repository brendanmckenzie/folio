/**
 * The JSON-RPC 2.0 envelope `{base}/mcp` speaks, hand-rolled
 * (`../../../docs/specs/platform/mcp-server.md` architecture decision 9), plus
 * Streamable HTTP's request-metadata rules, which are inseparable from it.
 *
 * **Pure: no Hono, no Request, no runtime.** Parse a body, check the metadata,
 * find the method, call it, shape the answer or the error. That is the whole file,
 * and it is why the envelope is unit-testable in Node without a Worker. The
 * transport's headers arrive as a lookup function rather than as a `Request`, so
 * nothing here knows what a `Headers` is.
 *
 * **The header rules live beside the envelope on purpose**, even though one is
 * transport and the other is JSON-RPC: revision `2026-07-28` made the *order* of
 * the checks part of the contract. `initialize` has to be answered before the
 * header checks, an unsupported version before an unknown method, and each of
 * those decides an HTTP status. Splitting the file would split that order.
 *
 * **No SDK.** Folio has nine runtime dependencies and an argument for each;
 * `@modelcontextprotocol/sdk` is Node-shaped and brings a transport built for a
 * process rather than for a request. The subset MCP actually needs here is four
 * messages — `server/discover`, `ping`, `tools/list`, `tools/call` — and
 * Streamable HTTP permits a plain JSON response to a POST. This server never
 * initiates a message to the client, so there is no stream to hold open, no
 * session to keep and no Durable Object. Since `2026-07-28` that is not merely
 * permitted but the shape the protocol assumes: sessions and the GET stream were
 * removed from the transport outright.
 */
import type { FolioErrorCode } from '../errors'
import { FolioError } from '../errors'

/** The only version of JSON-RPC there is, and the only one MCP uses. */
export const JSONRPC_VERSION = '2.0'

/* --------------------------------------------------------------- revisions --- */

/**
 * The MCP revision this server implements.
 *
 * **Modern-only, deliberately.** `2026-07-28` replaced the `initialize` handshake
 * with per-request metadata, and the handshake-based revisions (`2025-11-25` and
 * earlier, which is what Folio used to answer) are classed *Legacy*. Nothing here
 * speaks them: Folio is greenfield, both ends of every deploy ship together, and a
 * second era to keep in step is a compatibility mechanism with no data behind it.
 *
 * The cost is stated where it lands: a Legacy-only client cannot talk to this
 * server and has no fall-forward. `initialize` therefore answers an
 * `UnsupportedProtocolVersionError` naming this list, which is both the spec's own
 * SHOULD for a modern-only server and the signal that makes a *dual-era* client
 * retry as modern rather than fall back to a handshake nothing will answer.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

/** Every revision this server will accept, newest first. */
export const SUPPORTED_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION]

/* ------------------------------------------------------------------ codes --- */

/** Invalid JSON. The only error answered before an `id` could be read. */
export const PARSE_ERROR = -32700
/** Well-formed JSON that is not a JSON-RPC request — including a batch. */
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

/**
 * MCP's own reserved sub-range, from `2026-07-28`. Both are answered with
 * `400 Bad Request`, and both are *recognised modern errors* — which is what tells
 * a dual-era client it is talking to a modern server and should retry rather than
 * fall back to `initialize`.
 */
export const HEADER_MISMATCH = -32020
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

/**
 * The HTTP status a JSON-RPC error is carried on.
 *
 * **Since `2026-07-28` the status is part of the protocol rather than decoration**,
 * because it is how a dual-era client decides whether to fall back: a `400` with a
 * recognised modern error body means "retry modern", and a `404` with `-32601`
 * distinguishes an unimplemented method from a `404` produced by a server that
 * does not host an MCP endpoint at all.
 *
 * Everything else stays on `200`. A JSON-RPC error is a successful HTTP exchange
 * carrying an application-level refusal, and the transport requires a request (as
 * opposed to a notification) to be answered with a JSON body — so an invalid
 * `params` or an internal fault is a 200 with an `error`, exactly as before.
 */
export function httpStatusFor(code: number): number {
  if (code === METHOD_NOT_FOUND) return 404
  if (
    code === HEADER_MISMATCH ||
    code === UNSUPPORTED_PROTOCOL_VERSION ||
    code === PARSE_ERROR ||
    code === INVALID_REQUEST
  ) {
    return 400
  }
  return 200
}

/**
 * A `FolioError`'s code in JSON-RPC's own space
 * (`mcp-server.md`'s "Errors"): `bad_request` is the caller's fault and maps to
 * *invalid params*; everything else — `unauthorized`, `forbidden`, `not_found`,
 * `conflict`, `too_large`, `unsupported`, `incomplete` — is the server
 * reporting a condition, which JSON-RPC has exactly one code for.
 *
 * The **message travels verbatim**, wherever this is used. `errors.ts` is
 * already the only place a message becomes client-visible and its messages are
 * written to be acted on: `documents.ts`'s `incomplete` names the id to retry
 * with, `refusalOf` names the missing scope, `NestedError` names the field that
 * did not fit. Rewording any of those for an agent would be strictly worse than
 * what a script already gets.
 */
export function rpcCodeFor(code: FolioErrorCode | string | undefined): number {
  return code === 'bad_request' ? INVALID_PARAMS : INTERNAL_ERROR
}

/* ------------------------------------------------------------------ shape --- */

/** JSON-RPC ids are a string or a number. `null` is a response-only value. */
export type RpcId = string | number

export interface RpcError {
  code: number
  message: string
  /**
   * Structured detail. Only `UnsupportedProtocolVersionError` uses it, and it has
   * to: the client's whole recovery is reading `supported` and retrying.
   */
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: typeof JSONRPC_VERSION
  /** `null` only when the request was too malformed to carry one. */
  id: RpcId | null
  result?: unknown
  error?: RpcError
}

/**
 * An error with a JSON-RPC code already chosen, for the cases a `FolioError`
 * cannot express: an unknown method, an unknown tool, a params object that is
 * not an object. Thrown by a method and caught by `handleRpc`.
 */
export class RpcFault extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcFault'
    this.code = code
    this.data = data
  }
}

/**
 * Refuse a request because its protocol revision is not one we implement.
 *
 * `data.supported` is the load-bearing part and the reason this is not a plain
 * `-32601`: it is the only route a client has back to a working request.
 */
export function unsupportedVersion(requested: string | undefined): RpcFault {
  return new RpcFault(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
    supported: SUPPORTED_VERSIONS,
    requested: requested ?? null,
  })
}

/** One method's implementation. `params` is always an object, possibly empty. */
export type RpcMethod = (params: Record<string, unknown>) => Promise<unknown> | unknown

export type RpcMethods = Readonly<Record<string, RpcMethod>>

/* ----------------------------------------------------------------- parsing --- */

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const fail = (id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: data === undefined ? { code, message } : { code, message, data },
})

/**
 * A parsed message: a request (answer it), a notification (do not), or a
 * refusal that is already a response.
 */
type Parsed =
  | { kind: 'request'; id: RpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'refused'; response: RpcResponse }

function parse(text: string): Parsed {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'refused', response: fail(null, PARSE_ERROR, 'That body is not valid JSON.') }
  }

  /**
   * **A batch is refused, with the reason.** MCP's 2025-06-18 revision removed
   * JSON-RPC batching, and supporting it here would mean holding a list of
   * partially-applied writes to report on — which is a transaction this server
   * does not have. Saying so is better than answering the first element and
   * dropping the rest.
   */
  if (Array.isArray(body)) {
    return {
      kind: 'refused',
      response: fail(
        null,
        INVALID_REQUEST,
        'This server does not accept batched requests: send one JSON-RPC message per POST.',
      ),
    }
  }

  if (!isRecord(body)) {
    return {
      kind: 'refused',
      response: fail(null, INVALID_REQUEST, 'A JSON-RPC message must be a JSON object.'),
    }
  }

  if (body.jsonrpc !== JSONRPC_VERSION) {
    return {
      kind: 'refused',
      response: fail(null, INVALID_REQUEST, `Expected "jsonrpc": "${JSONRPC_VERSION}".`),
    }
  }

  if (typeof body.method !== 'string' || body.method === '') {
    return {
      kind: 'refused',
      response: fail(null, INVALID_REQUEST, '"method" must be a non-empty string.'),
    }
  }
  const method = body.method

  /**
   * **A notification is a message with no `id`, and it gets no response at
   * all** — a protocol requirement rather than a nicety, since a client that
   * receives an answer to a notification has a response it cannot correlate.
   * `id: null` is *not* a notification: it is a response-only value, so a
   * message carrying one is malformed and is told so rather than silently
   * dropped, which is the failure mode that looks like a hang.
   */
  const id = body.id
  if (id === undefined) {
    return { kind: 'notification', method, params: paramsOf(body) ?? {} }
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    return {
      kind: 'refused',
      response: fail(null, INVALID_REQUEST, '"id" must be a string or a number.'),
    }
  }

  const params = paramsOf(body)
  if (params === null) {
    return {
      kind: 'refused',
      response: fail(id, INVALID_PARAMS, '"params" must be a JSON object.'),
    }
  }
  return { kind: 'request', id, method, params }
}

/** `params` as an object, `{}` when absent, `null` when it is neither. */
function paramsOf(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body.params === undefined || body.params === null) return {}
  return isRecord(body.params) ? body.params : null
}

/* ------------------------------------------------------- request metadata --- */

/** The `_meta` key a modern request carries its revision in. */
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'

/** A case-insensitive header lookup. Hono's `c.req.header` satisfies it exactly. */
export type HeaderLookup = (name: string) => string | undefined

/**
 * Streamable HTTP mirrors selected body fields into headers so that load
 * balancers and gateways can route without parsing a body — and then requires the
 * server to prove the two agree, because "different components relying on
 * different sources of truth" is the vulnerability the mirroring would otherwise
 * introduce. A failure is `400` with `-32020`.
 *
 * Three rules, and one deliberate softening:
 *
 *   - **`MCP-Protocol-Version` is required.** Absent, it is a refusal rather than
 *     an assumed revision: assuming one is only correct for a server that also
 *     speaks the pre-`2025-06-18` versions that predate the header, and this one
 *     does not.
 *   - **`Mcp-Method` is required and must equal `method`.**
 *   - **`Mcp-Name` is required for `tools/call` and must equal `params.name`**,
 *     after decoding the Base64 sentinel a client uses for any value that is not
 *     plainly ASCII. Folio's tool names are all `snake_case`, so the sentinel is
 *     unreachable from our own table — decoded anyway, because the rule is about
 *     what a *client* may send and a name is not the only thing this shape carries.
 *
 * The softening: a body whose `params._meta` omits the version is accepted when the
 * header is present and supported. The rule exists so a header cannot disagree with
 * a body, and a body that declares nothing cannot disagree with anything. Rejecting
 * it would add a failure mode with no security value, and the header — the thing
 * intermediaries actually route on — has already been checked.
 *
 * Not enforced, deliberately: `x-mcp-header` parameter mirroring, which is a
 * server-opt-in feature (`MAY`) that no tool in `tools.ts` declares.
 */
export function checkRequestMetadata(
  header: HeaderLookup,
  method: string,
  params: Record<string, unknown>,
): void {
  const declared = header('mcp-protocol-version')
  if (!declared) {
    throw new RpcFault(
      HEADER_MISMATCH,
      'Missing required header: MCP-Protocol-Version. Every POST to this endpoint must declare its protocol revision.',
    )
  }

  const inBody = metaVersion(params)
  if (inBody !== undefined && inBody !== declared) {
    throw new RpcFault(
      HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header value '${declared}' does not match the '${META_VERSION}' in params._meta ('${inBody}').`,
    )
  }

  if (!SUPPORTED_VERSIONS.includes(declared)) throw unsupportedVersion(declared)

  const headerMethod = header('mcp-method')
  if (!headerMethod) {
    throw new RpcFault(HEADER_MISMATCH, 'Missing required header: Mcp-Method.')
  }
  if (headerMethod !== method) {
    throw new RpcFault(
      HEADER_MISMATCH,
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body method '${method}'.`,
    )
  }

  if (method !== 'tools/call') return

  const name = params.name
  if (typeof name !== 'string') return // `tools/call` itself reports a missing name.
  const headerName = header('mcp-name')
  if (headerName === undefined) {
    throw new RpcFault(HEADER_MISMATCH, 'Missing required header: Mcp-Name.')
  }
  if (decodeSentinel(headerName) !== name) {
    throw new RpcFault(
      HEADER_MISMATCH,
      `Header mismatch: Mcp-Name header value '${headerName}' does not match body params.name ('${name}').`,
    )
  }
}

function metaVersion(params: Record<string, unknown>): string | undefined {
  const meta = params._meta
  if (!isRecord(meta)) return undefined
  const version = meta[META_VERSION]
  return typeof version === 'string' ? version : undefined
}

/**
 * `=?base64?…?=` back to its value, or the value unchanged.
 *
 * The markers are case-sensitive and must appear exactly, so this does not try to
 * be generous about them: a value that merely looks similar is a value, not an
 * encoding. Undecodable base64 inside the markers is returned as-is, which fails
 * the comparison and reports a mismatch — the right answer, since a malformed
 * sentinel is a malformed header either way.
 */
function decodeSentinel(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value
  const encoded = value.slice('=?base64?'.length, -'?='.length)
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)))
  } catch {
    return value
  }
}

/* -------------------------------------------------------------- dispatch --- */

/** What one POST is answered with. `response: null` means "send no body". */
export interface RpcOutcome {
  status: number
  response: RpcResponse | null
}

/** A notification: accepted, nothing to say. */
const ACCEPTED: RpcOutcome = { status: 202, response: null }

const refuse = (id: RpcId | null, code: number, message: string, data?: unknown): RpcOutcome => ({
  status: httpStatusFor(code),
  response: fail(id, code, message, data),
})

/**
 * Answers one POST body.
 *
 * Every throw is translated here rather than in each method, so a method reads
 * as the thing it does. `RpcFault` carries its own code, a `FolioError` is
 * mapped by `rpcCodeFor` with its message intact, and anything else is a bug:
 * it is logged with the method that raised it — the same discipline
 * `app.onError` keeps — and the client is told nothing beyond a generic
 * internal error, so raw D1 text never travels.
 *
 * **The order of the three checks below is the protocol**, not an implementation
 * detail, and each step says why it sits where it does.
 */
export async function handleRpc(
  text: string,
  methods: RpcMethods,
  header: HeaderLookup,
): Promise<RpcOutcome> {
  const message = parse(text)
  if (message.kind === 'refused') {
    const code = message.response.error?.code ?? INVALID_REQUEST
    return { status: httpStatusFor(code), response: message.response }
  }

  if (message.kind === 'notification') {
    // An unknown notification is dropped, not refused: there is nowhere to send
    // the refusal, and a client is allowed to send notifications a server does
    // not know about. The transport does not define header rules for a
    // notification POST, so `checkRequestMetadata` deliberately never sees one.
    const method = methods[message.method]
    if (method) {
      try {
        await method(message.params)
      } catch (err) {
        console.error(`folio: mcp notification ${message.method} failed`, err)
      }
    }
    return ACCEPTED
  }

  /**
   * **`initialize` is answered first, before any header is looked at.**
   *
   * It is a Legacy method and this server is modern-only, so the interesting
   * question is not *whether* to refuse it but *what the refusal has to carry*.
   * The spec's SHOULD is that a modern-only server names its supported versions
   * in any error it returns to `initialize`, because a Legacy client has no
   * fall-forward and this message is the only diagnostic a user will ever see.
   *
   * Checked before `checkRequestMetadata` for exactly that reason: a Legacy
   * client sends no `Mcp-Method` header and often no `MCP-Protocol-Version`
   * either, so header validation would answer "missing header" — true, useless,
   * and silent about the thing the client needs to know. Answering `-32022` with
   * the version list instead also gets a *dual-era* client to the right place,
   * since a recognised modern error tells it to retry as modern rather than fall
   * back to a handshake nothing here will ever answer.
   */
  if (message.method === 'initialize') {
    const requested = message.params.protocolVersion
    const fault = unsupportedVersion(typeof requested === 'string' ? requested : undefined)
    return refuse(
      message.id,
      fault.code,
      'This server implements MCP revision 2026-07-28 and does not accept the `initialize` handshake. Send requests directly, declaring the revision in the MCP-Protocol-Version header.',
      fault.data,
    )
  }

  try {
    checkRequestMetadata(header, message.method, message.params)
  } catch (err) {
    if (err instanceof RpcFault) return refuse(message.id, err.code, err.message, err.data)
    throw err
  }

  /**
   * Unknown method last, and it answers `404` rather than a 200 with an error.
   * The status is what distinguishes "this endpoint does not implement that
   * method" from a `404` produced by a server that hosts no MCP endpoint at all,
   * which is a distinction a dual-era client's fallback logic depends on.
   */
  const method = methods[message.method]
  if (!method) {
    return refuse(message.id, METHOD_NOT_FOUND, `No such method: '${message.method}'.`)
  }

  try {
    return {
      status: 200,
      response: { jsonrpc: JSONRPC_VERSION, id: message.id, result: await method(message.params) },
    }
  } catch (err) {
    if (err instanceof RpcFault) return refuse(message.id, err.code, err.message, err.data)
    if (err instanceof FolioError) return refuse(message.id, rpcCodeFor(err.code), err.message)
    console.error(`folio: unhandled error in mcp ${message.method}`, err)
    return refuse(message.id, INTERNAL_ERROR, 'Something went wrong.')
  }
}
