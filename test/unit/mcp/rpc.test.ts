import { describe, expect, it, vi } from 'vitest'
import { FolioError } from '../../../src/server/errors'
import {
  handleRpc,
  HEADER_MISMATCH,
  httpStatusFor,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  RpcFault,
  rpcCodeFor,
  type RpcMethods,
  SUPPORTED_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
} from '../../../src/server/mcp/rpc'

/**
 * The JSON-RPC envelope `{base}/mcp` speaks, plus revision `2026-07-28`'s
 * request-metadata rules (`../../../docs/specs/platform/mcp-server.md`
 * decision 9).
 *
 * Hand-rolled and pure, so every case here is a string plus a header lookup in and
 * an object out — no Worker, no Hono, no runtime. That is the reason the transport
 * was written this way rather than taken from an SDK built for a process.
 */

/**
 * A stand-in method, deliberately **not** named `ping`: the real transport answers
 * `ping` (`server/routes/mcp.ts`), and a double sharing that name would read as
 * coverage of it while testing only the envelope around it.
 */
const ok: RpcMethods = { probe: () => ({ probed: true }) }

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * The headers a conforming client would send for this body: the revision, the
 * mirrored method, and the mirrored tool name where the method is `tools/call`.
 * Derived from the body rather than written per test, so every existing case keeps
 * exercising the envelope instead of the metadata check — and so a test that means
 * to break one header does it by naming that header alone.
 */
function headersFor(body: unknown, extra: Record<string, string> = {}): Record<string, string> {
  const map: Record<string, string> = { 'mcp-protocol-version': MCP_PROTOCOL_VERSION }
  if (isRecord(body)) {
    if (typeof body.method === 'string') map['mcp-method'] = body.method
    if (body.method === 'tools/call' && isRecord(body.params)) {
      const name = body.params.name
      if (typeof name === 'string') map['mcp-name'] = name
    }
  }
  return { ...map, ...extra }
}

const lookup = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()]

const text = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))

const outcome = (body: unknown, methods: RpcMethods = ok, headers?: Record<string, string>) =>
  handleRpc(text(body), methods, lookup(headers ?? headersFor(body)))

const post = async (body: unknown, methods: RpcMethods = ok, headers?: Record<string, string>) =>
  (await outcome(body, methods, headers)).response

describe('handleRpc', () => {
  it('answers a well-formed request with its id and result', async () => {
    expect(await post({ jsonrpc: '2.0', id: 7, method: 'probe' })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { probed: true },
    })
  })

  it('answers a well-formed request with HTTP 200', async () => {
    expect((await outcome({ jsonrpc: '2.0', id: 7, method: 'probe' })).status).toBe(200)
  })

  it('passes params through as an object, and defaults them to empty', async () => {
    const seen: unknown[] = []
    const methods = {
      echo: (params: Record<string, unknown>) => {
        seen.push(params)
        return null
      },
    }
    await post({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } }, methods)
    await post({ jsonrpc: '2.0', id: 2, method: 'echo' }, methods)
    // `params: null` is how some clients spell "none", and it is not an error.
    await post({ jsonrpc: '2.0', id: 3, method: 'echo', params: null }, methods)
    expect(seen).toEqual([{ a: 1 }, {}, {}])
  })

  it('accepts a string id as well as a number, and answers with the same one', async () => {
    const res = await post({ jsonrpc: '2.0', id: 'call-1', method: 'probe' })
    expect(res?.id).toBe('call-1')
  })

  /* ------------------------------------------------------------ refusals --- */

  it('refuses a malformed body as a parse error, with a null id', async () => {
    const res = await outcome('{"jsonrpc":"2.0",')
    expect(res.response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: PARSE_ERROR, message: 'That body is not valid JSON.' },
    })
    expect(res.status).toBe(400)
  })

  /**
   * **A batch is refused, and the message says why.** MCP removed batching, and
   * supporting it would mean holding a list of partially-applied writes to report
   * on — a transaction this server does not have. A silent "answer the first
   * element" is the failure mode to avoid.
   */
  it('refuses a batch, naming the reason rather than answering the first element', async () => {
    for (const batch of [[], [{ jsonrpc: '2.0', id: 1, method: 'probe' }]]) {
      const res = await post(batch)
      expect(res?.error?.code).toBe(INVALID_REQUEST)
      expect(res?.error?.message).toContain('does not accept batched requests')
      expect(res?.error?.message).toContain('one JSON-RPC message per POST')
    }
  })

  it('refuses a body that is not an object at all', async () => {
    for (const body of ['"hello"', '42', 'null']) {
      const res = await post(body)
      expect(res?.error?.code).toBe(INVALID_REQUEST)
      expect(res?.error?.message).toContain('must be a JSON object')
    }
  })

  it('refuses a missing or wrong jsonrpc version', async () => {
    for (const body of [
      { id: 1, method: 'probe' },
      { jsonrpc: '1.0', id: 1, method: 'probe' },
    ]) {
      const res = await post(body)
      expect(res?.error?.code).toBe(INVALID_REQUEST)
      expect(res?.error?.message).toContain('"jsonrpc": "2.0"')
    }
  })

  it('refuses a message with no usable method name', async () => {
    for (const method of [undefined, '', 42, null]) {
      const res = await post({ jsonrpc: '2.0', id: 1, method })
      expect(res?.error?.code).toBe(INVALID_REQUEST)
      expect(res?.error?.message).toContain('"method" must be a non-empty string')
    }
  })

  /**
   * `id: null` is a **response-only** value in JSON-RPC, so a request carrying
   * one is malformed. Told so rather than silently treated as a notification,
   * because a dropped message presents to a client as a hang rather than an
   * error.
   */
  it('refuses a null or wrongly-typed id rather than reading it as a notification', async () => {
    for (const id of [null, {}, true]) {
      const res = await post({ jsonrpc: '2.0', id, method: 'probe' })
      expect(res?.error?.code).toBe(INVALID_REQUEST)
      expect(res?.error?.message).toContain('"id" must be a string or a number')
    }
  })

  it('refuses params that are not an object, keeping the id so a client can correlate', async () => {
    const res = await post({ jsonrpc: '2.0', id: 9, method: 'probe', params: [1, 2] })
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: INVALID_PARAMS, message: '"params" must be a JSON object.' },
    })
  })

  /**
   * **404, not a 200 with an error.** The status is what separates "this endpoint
   * does not implement that method" from a `404` served by something that hosts no
   * MCP endpoint at all — a distinction a dual-era client's fallback depends on.
   */
  it('answers an unknown method with 404 and method-not-found, naming it', async () => {
    const res = await outcome({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    expect(res.status).toBe(404)
    expect(res.response?.error?.code).toBe(METHOD_NOT_FOUND)
    expect(res.response?.error?.message).toBe("No such method: 'resources/list'.")
  })

  /* ------------------------------------------------------ notifications --- */

  /**
   * **A notification gets no response**, which is a protocol requirement: a
   * client that receives an answer to a message it gave no id has a response it
   * cannot correlate. 202 is the status Streamable HTTP specifies for one.
   */
  it('answers a notification with 202 and nothing at all, having run it', async () => {
    let ran = 0
    const res = await outcome(
      { jsonrpc: '2.0', method: 'housekeeping' },
      {
        housekeeping: () => {
          ran++
        },
      },
    )
    expect(res.response).toBeNull()
    expect(res.status).toBe(202)
    expect(ran).toBe(1)
  })

  it('drops an unknown notification instead of refusing it', async () => {
    expect(await post({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull()
  })

  /**
   * The transport does not define header rules for a notification POST, so the
   * metadata check never sees one. A notification with no headers at all is
   * accepted rather than refused — which also means a Legacy client's
   * `notifications/initialized` is dropped quietly instead of erroring into a void.
   */
  it('does not apply the header rules to a notification', async () => {
    const res = await outcome({ jsonrpc: '2.0', method: 'notifications/initialized' }, ok, {})
    expect(res.status).toBe(202)
    expect(res.response).toBeNull()
  })

  it('swallows a throwing notification, because there is nowhere to send the error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(
      { jsonrpc: '2.0', method: 'boom' },
      {
        boom: () => {
          throw new Error('nope')
        },
      },
    )
    expect(res).toBeNull()
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  /* ------------------------------------------------------------- throwing --- */

  it('carries an RpcFault’s own code and message', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'boom' },
      {
        boom: () => {
          throw new RpcFault(INVALID_PARAMS, "No such tool: 'nope'.")
        },
      },
    )
    expect(res?.error).toEqual({ code: INVALID_PARAMS, message: "No such tool: 'nope'." })
  })

  /**
   * The mapping the spec fixes: `bad_request` is the caller's fault, so it is
   * *invalid params*; everything else is the server reporting a condition, and
   * JSON-RPC has one code for that. **The message travels verbatim** in both
   * cases, because `errors.ts` is already the only place a message becomes
   * client-visible and its messages are written to be acted on.
   */
  it('maps a FolioError by code and keeps its message word for word', async () => {
    const cases = [
      ['bad_request', INVALID_PARAMS],
      ['unauthorized', INTERNAL_ERROR],
      ['forbidden', INTERNAL_ERROR],
      ['not_found', INTERNAL_ERROR],
      ['conflict', INTERNAL_ERROR],
      ['too_large', INTERNAL_ERROR],
      ['unsupported', INTERNAL_ERROR],
      ['incomplete', INTERNAL_ERROR],
    ] as const

    for (const [code, expected] of cases) {
      const message = `${code} happened, here is what to do`
      const res = await post(
        { jsonrpc: '2.0', id: 4, method: 'boom' },
        {
          boom: () => {
            throw new FolioError(code, message)
          },
        },
      )
      expect([code, res?.error]).toEqual([code, { code: expected, message }])
    }
  })

  /**
   * Anything else is a bug or a platform failure, so it is logged with the
   * method that raised it and the client is told nothing — the same discipline
   * `app.onError` keeps, so raw D1 text never travels.
   */
  it('hides an unrecognised throw behind a generic internal error, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(
      { jsonrpc: '2.0', id: 5, method: 'boom' },
      {
        boom: () => {
          throw new Error('D1_ERROR: no such column: secrets.value')
        },
      },
    )
    expect(res?.error).toEqual({ code: INTERNAL_ERROR, message: 'Something went wrong.' })
    expect(logged).toHaveBeenCalledWith('folio: unhandled error in mcp boom', expect.any(Error))
    logged.mockRestore()
  })

  it('awaits an async method', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 6, method: 'slow' },
      {
        slow: async () => {
          await Promise.resolve()
          return 'done'
        },
      },
    )
    expect(res?.result).toBe('done')
  })
})

/* --------------------------------------------------- the `initialize` refusal --- */

describe('handleRpc, the initialize handshake', () => {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' }

  /**
   * A Legacy client's opening message, and the one refusal whose *content* the
   * spec constrains: a modern-only server SHOULD name its supported versions,
   * because a Legacy client has no fall-forward and this is the only diagnostic a
   * user will ever see.
   */
  it('refuses initialize with the supported-version list, on a 400', async () => {
    const res = await outcome({ ...initialize, params: { protocolVersion: '2025-06-18' } })
    expect(res.status).toBe(400)
    expect(res.response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION)
    expect(res.response?.error?.data).toEqual({
      supported: SUPPORTED_VERSIONS,
      requested: '2025-06-18',
    })
    expect(res.response?.error?.message).toContain('2026-07-28')
  })

  /**
   * **Answered before the header checks**, which is the whole reason it has its own
   * branch: a Legacy client sends no `Mcp-Method` header, so header validation
   * would answer "missing header" — true, and silent about the only thing that
   * would help.
   */
  it('names the versions even when no modern header was sent at all', async () => {
    const res = await outcome(initialize, ok, {})
    expect(res.response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION)
    expect(res.response?.error?.data).toEqual({ supported: SUPPORTED_VERSIONS, requested: null })
  })

  it('refuses it even if a client somehow declares the modern revision', async () => {
    const res = await outcome({ ...initialize, params: { protocolVersion: MCP_PROTOCOL_VERSION } })
    expect(res.response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION)
  })
})

/* ----------------------------------------------------------- request metadata --- */

describe('handleRpc, Streamable HTTP request metadata', () => {
  const probe = { jsonrpc: '2.0', id: 1, method: 'probe' }
  const call = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_document', arguments: {} },
  }
  const tools: RpcMethods = { 'tools/call': () => ({ called: true }) }

  it('refuses a request with no MCP-Protocol-Version header', async () => {
    const res = await outcome(probe, ok, { 'mcp-method': 'probe' })
    expect(res.status).toBe(400)
    expect(res.response?.error?.code).toBe(HEADER_MISMATCH)
    expect(res.response?.error?.message).toContain('MCP-Protocol-Version')
  })

  it('refuses a revision it does not implement, listing the ones it does', async () => {
    const res = await outcome(probe, ok, {
      'mcp-protocol-version': '2025-11-25',
      'mcp-method': 'probe',
    })
    expect(res.status).toBe(400)
    expect(res.response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION)
    expect(res.response?.error?.data).toEqual({
      supported: SUPPORTED_VERSIONS,
      requested: '2025-11-25',
    })
  })

  it('refuses a header that disagrees with the body’s own _meta', async () => {
    const body = {
      ...probe,
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    }
    const res = await outcome(body, ok, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'probe',
    })
    expect(res.response?.error?.code).toBe(HEADER_MISMATCH)
    expect(res.response?.error?.message).toContain('does not match')
  })

  it('accepts a matching _meta revision', async () => {
    const body = {
      ...probe,
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION } },
    }
    expect((await outcome(body)).response?.result).toEqual({ probed: true })
  })

  /**
   * The one deliberate softening. The rule exists so a header cannot disagree with
   * a body; a body that declares nothing cannot disagree with anything, and the
   * header — what intermediaries actually route on — has already been checked.
   */
  it('accepts a body that omits _meta entirely, given a good header', async () => {
    expect((await outcome(probe)).response?.result).toEqual({ probed: true })
  })

  it('refuses a missing Mcp-Method header', async () => {
    const res = await outcome(probe, ok, { 'mcp-protocol-version': MCP_PROTOCOL_VERSION })
    expect(res.response?.error?.code).toBe(HEADER_MISMATCH)
    expect(res.response?.error?.message).toContain('Mcp-Method')
  })

  it('refuses an Mcp-Method header that does not match the body', async () => {
    const res = await outcome(probe, ok, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    })
    expect(res.response?.error?.code).toBe(HEADER_MISMATCH)
    expect(res.response?.error?.message).toContain('tools/list')
  })

  it('requires Mcp-Name on a tools/call and refuses a mismatch', async () => {
    const missing = await outcome(call, tools, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
    })
    expect(missing.response?.error?.code).toBe(HEADER_MISMATCH)
    expect(missing.response?.error?.message).toContain('Mcp-Name')

    const wrong = await outcome(call, tools, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'delete_document',
    })
    expect(wrong.response?.error?.code).toBe(HEADER_MISMATCH)
  })

  it('accepts a matching Mcp-Name', async () => {
    expect((await outcome(call, tools)).response?.result).toEqual({ called: true })
  })

  /**
   * A client **MUST** Base64-encode any header value it cannot represent as plain
   * ASCII, and servers **MUST** decode before comparing. Folio's tool names are all
   * `snake_case`, so this is unreachable from our own table — decoded anyway,
   * because the rule is about what a client may send.
   */
  it('decodes the Base64 sentinel before comparing Mcp-Name', async () => {
    const encoded = `=?base64?${btoa('get_document')}?=`
    const res = await outcome(call, tools, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': encoded,
    })
    expect(res.response?.result).toEqual({ called: true })
  })

  it('treats a malformed sentinel as a mismatch rather than crashing', async () => {
    const res = await outcome(call, tools, {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': '=?base64?not!valid!base64?=',
    })
    expect(res.response?.error?.code).toBe(HEADER_MISMATCH)
  })

  /**
   * Header names are case-insensitive and Hono's own lookup honours that, but only
   * if it is asked in a form it normalises. Asserting on the *names asked for*
   * rather than on the outcome is what makes this a test of the contract instead of
   * a restatement of the fixture: a lookup keyed however the test likes would pass
   * either way.
   */
  it('asks for every header in lower case', async () => {
    const asked: string[] = []
    await handleRpc(text(call), tools, (name) => {
      asked.push(name)
      return headersFor(call)[name]
    })
    expect(asked.length).toBeGreaterThan(0)
    expect(asked).toEqual(asked.map((name) => name.toLowerCase()))
  })
})

describe('httpStatusFor', () => {
  /**
   * The status is part of the protocol since `2026-07-28`, so this mapping is
   * pinned rather than left to whatever the route happened to pass.
   */
  it('maps the protocol-significant codes and leaves the rest on 200', () => {
    expect(httpStatusFor(METHOD_NOT_FOUND)).toBe(404)
    expect(httpStatusFor(HEADER_MISMATCH)).toBe(400)
    expect(httpStatusFor(UNSUPPORTED_PROTOCOL_VERSION)).toBe(400)
    expect(httpStatusFor(PARSE_ERROR)).toBe(400)
    expect(httpStatusFor(INVALID_REQUEST)).toBe(400)
    expect(httpStatusFor(INVALID_PARAMS)).toBe(200)
    expect(httpStatusFor(INTERNAL_ERROR)).toBe(200)
  })
})

describe('rpcCodeFor', () => {
  it('is invalid-params for bad_request and internal for everything else', () => {
    expect(rpcCodeFor('bad_request')).toBe(INVALID_PARAMS)
    expect(rpcCodeFor('forbidden')).toBe(INTERNAL_ERROR)
    // A response with no readable envelope at all, which is a platform failure
    // rather than a route's refusal.
    expect(rpcCodeFor(undefined)).toBe(INTERNAL_ERROR)
  })
})
