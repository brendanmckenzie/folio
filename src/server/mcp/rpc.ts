/**
 * The JSON-RPC 2.0 envelope `{base}/mcp` speaks, hand-rolled
 * (`../../../../docs/specs/platform/mcp-server.md` architecture decision 9).
 *
 * **Pure: no Hono, no Request, no runtime.** Parse a body, find the method, call
 * it, shape the answer or the error. That is the whole file, and it is why the
 * envelope is unit-testable in Node without a Worker.
 *
 * **No SDK.** Folio has nine runtime dependencies and an argument for each;
 * `@modelcontextprotocol/sdk` is Node-shaped and brings a transport built for a
 * process rather than for a request. The subset MCP actually needs here is four
 * messages — `initialize`, the `notifications/initialized` acknowledgement,
 * `tools/list`, `tools/call` — and Streamable HTTP permits a plain JSON response
 * to a POST. This server never initiates a message to the client, so there is no
 * stream to hold open, no session to keep and no Durable Object.
 */
import type { FolioErrorCode } from '../errors'
import { FolioError } from '../errors'

/** The only version of JSON-RPC there is, and the only one MCP uses. */
export const JSONRPC_VERSION = '2.0'

/* ------------------------------------------------------------------ codes --- */

/** Invalid JSON. The only error answered before an `id` could be read. */
export const PARSE_ERROR = -32700
/** Well-formed JSON that is not a JSON-RPC request — including a batch. */
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

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

  constructor(code: number, message: string) {
    super(message)
    this.name = 'RpcFault'
    this.code = code
  }
}

/** One method's implementation. `params` is always an object, possibly empty. */
export type RpcMethod = (params: Record<string, unknown>) => Promise<unknown> | unknown

export type RpcMethods = Readonly<Record<string, RpcMethod>>

/* ----------------------------------------------------------------- parsing --- */

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const fail = (id: RpcId | null, code: number, message: string): RpcResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: { code, message },
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

/* -------------------------------------------------------------- dispatch --- */

/**
 * Answers one POST body: `null` means "nothing to send", which is the correct
 * answer to a notification and the only case with no response.
 *
 * Every throw is translated here rather than in each method, so a method reads
 * as the thing it does. `RpcFault` carries its own code, a `FolioError` is
 * mapped by `rpcCodeFor` with its message intact, and anything else is a bug:
 * it is logged with the method that raised it — the same discipline
 * `app.onError` keeps — and the client is told nothing beyond a generic
 * internal error, so raw D1 text never travels.
 */
export async function handleRpc(text: string, methods: RpcMethods): Promise<RpcResponse | null> {
  const message = parse(text)
  if (message.kind === 'refused') return message.response

  const method = methods[message.method]

  if (message.kind === 'notification') {
    // An unknown notification is dropped, not refused: there is nowhere to send
    // the refusal, and a client is allowed to send notifications a server does
    // not know about.
    if (method) {
      try {
        await method(message.params)
      } catch (err) {
        console.error(`folio: mcp notification ${message.method} failed`, err)
      }
    }
    return null
  }

  if (!method) {
    return fail(message.id, METHOD_NOT_FOUND, `No such method: '${message.method}'.`)
  }

  try {
    return { jsonrpc: JSONRPC_VERSION, id: message.id, result: await method(message.params) }
  } catch (err) {
    if (err instanceof RpcFault) return fail(message.id, err.code, err.message)
    if (err instanceof FolioError) return fail(message.id, rpcCodeFor(err.code), err.message)
    console.error(`folio: unhandled error in mcp ${message.method}`, err)
    return fail(message.id, INTERNAL_ERROR, 'Something went wrong.')
  }
}
