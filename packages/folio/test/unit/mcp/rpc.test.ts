import { describe, expect, it, vi } from 'vitest'
import { FolioError } from '../../../src/server/errors'
import {
  handleRpc,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  RpcFault,
  rpcCodeFor,
  type RpcMethods,
} from '../../../src/server/mcp/rpc'

/**
 * The JSON-RPC envelope `{base}/mcp` speaks
 * (`../../../../../docs/specs/platform/mcp-server.md` decision 9).
 *
 * Hand-rolled and pure, so every case here is a string in and an object out —
 * no Worker, no Hono, no runtime. That is the reason the transport was written
 * this way rather than taken from an SDK built for a process.
 */

/**
 * A stand-in method, deliberately **not** named `ping`: the real transport now
 * answers `ping` (`server/routes/mcp.ts`), and a double sharing that name would
 * read as coverage of it while testing only the envelope around it.
 */
const ok: RpcMethods = { probe: () => ({ probed: true }) }

const post = (body: unknown, methods: RpcMethods = ok) =>
  handleRpc(typeof body === 'string' ? body : JSON.stringify(body), methods)

describe('handleRpc', () => {
  it('answers a well-formed request with its id and result', async () => {
    expect(await post({ jsonrpc: '2.0', id: 7, method: 'probe' })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { probed: true },
    })
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
    const res = await post('{"jsonrpc":"2.0",')
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: PARSE_ERROR, message: 'That body is not valid JSON.' },
    })
  })

  /**
   * **A batch is refused, and the message says why.** MCP's 2025-06-18 revision
   * removed batching, and supporting it would mean holding a list of
   * partially-applied writes to report on — a transaction this server does not
   * have. A silent "answer the first element" is the failure mode to avoid.
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
      const res = await handleRpc(body, ok)
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

  it('answers an unknown method with method-not-found, naming it', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    expect(res?.error?.code).toBe(METHOD_NOT_FOUND)
    expect(res?.error?.message).toBe("No such method: 'resources/list'.")
  })

  /* ------------------------------------------------------ notifications --- */

  /**
   * **A notification gets no response**, which is a protocol requirement: a
   * client that receives an answer to a message it gave no id has a response it
   * cannot correlate.
   */
  it('answers a notification with nothing at all, having run it', async () => {
    let ran = 0
    const res = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        'notifications/initialized': () => {
          ran++
        },
      },
    )
    expect(res).toBeNull()
    expect(ran).toBe(1)
  })

  it('drops an unknown notification instead of refusing it', async () => {
    expect(await post({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull()
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

describe('rpcCodeFor', () => {
  it('is invalid-params for bad_request and internal for everything else', () => {
    expect(rpcCodeFor('bad_request')).toBe(INVALID_PARAMS)
    expect(rpcCodeFor('forbidden')).toBe(INTERNAL_ERROR)
    // A response with no readable envelope at all, which is a platform failure
    // rather than a route's refusal.
    expect(rpcCodeFor(undefined)).toBe(INTERNAL_ERROR)
  })
})
