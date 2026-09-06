import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anthropicDescriber,
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_DESCRIBE_PROMPT,
  parseDescribeJson,
} from '../../../src/server/describe-anthropic'
import type { DescribeInput, FolioDescribe } from '../../../src/server/types'

/**
 * `anthropicDescriber` — the one adapter, against a **stubbed `fetch`**
 * (`docs/specs/content-model/media-library.md` decision 8, phase 8).
 *
 * **Nothing here has ever reached a live model, and nothing here can.** There is
 * no API key in this repository and there should not be one: a suite that spent
 * money on every `pnpm test` would be a suite that gets skipped, and the seam
 * exists precisely so Folio's own tests never need a provider. What that buys is
 * everything on Folio's side of the wire — which request is built, which of the
 * two image paths is taken, and what is done with an answer — and what it cannot
 * buy is confirmation that the API accepts the request. That is a first-run
 * problem, it is named in the README, and it is why the two properties below are
 * the ones asserted hardest:
 *
 *  - **The image path is chosen from the URL, not from a failed attempt.** A
 *    `wrangler dev` deployment is the first place a host tries this and its
 *    asset URL is fetchable from nowhere but that machine, so `localhost` has to
 *    take the bytes path *before* a call is spent discovering it.
 *  - **A failure is a throw, never an empty result.** `describeAsset` records a
 *    throw in `describe_error` and stamps `described_at` either way — so an
 *    adapter that swallowed a refusal into `{}` would retire the row from the
 *    backlog with nothing to find it by, which is the one outcome that is both
 *    silent and unrecoverable.
 */

const KEY = 'sk-ant-test'

function inputOf(extra: Partial<DescribeInput> = {}): DescribeInput {
  return {
    id: 'ast_abc123',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    width: 1200,
    height: 800,
    url: 'https://example.com/folio/asset/ast_abc123-photo.jpg?w=512&f=webp',
    bytes: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    tags: [
      { id: 'tag_1', name: 'Headshot' },
      { id: 'tag_2', name: 'Black and white' },
    ],
    ...extra,
  }
}

/** One stubbed answer, in the shape the Messages API documents. */
function answering(text: string, init: { status?: number; stopReason?: string } = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          stop_reason: init.stopReason ?? 'end_turn',
        }),
        { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** What `fetch` was called with. `vi.fn()` has no argument types of its own. */
function callsOf(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return fetchMock.mock.calls as unknown as [string, RequestInit][]
}

/** The parsed body of the one call that was made. */
function sent(fetchMock: ReturnType<typeof vi.fn>): {
  model: string
  max_tokens: number
  system: string
  messages: { role: string; content: { type: string; [k: string]: unknown }[] }[]
} {
  return JSON.parse(String(callsOf(fetchMock)[0]![1].body))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('construction', () => {
  it('refuses a missing key rather than sending an unauthenticated call', () => {
    expect(() => anthropicDescriber({ apiKey: '' })).toThrow(/`apiKey` is required/)
    expect(() => anthropicDescriber({ apiKey: undefined as unknown as string })).toThrow(
      /`apiKey` is required/,
    )
  })

  it('answers something a host may put straight into `describe`', () => {
    // A compile-time assertion as much as a runtime one, and the interesting
    // half is the compile-time one: `FolioDescribe.fn` is declared as a
    // *method* so its parameters stay bivariant, which is what lets a host's
    // `FolioDescribe<Env>` reach the `FolioDescribe<unknown>` the runtime
    // widens it to. An adapter returning a one-argument function has to satisfy
    // that two-argument method, and nothing but a type-check would say if it
    // stopped doing so.
    const config: FolioDescribe<{ ANTHROPIC_API_KEY: string }> = {
      fn: anthropicDescriber({ apiKey: KEY }),
    }
    expect(typeof config.fn).toBe('function')
  })
})

describe('the request', () => {
  it('carries the key, the API version and the default model', async () => {
    const fetchMock = answering('{"alt":"A woman cycling"}')
    await anthropicDescriber({ apiKey: KEY })(inputOf())

    const [url, init] = callsOf(fetchMock)[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
    expect(sent(fetchMock).model).toBe(DEFAULT_DESCRIBE_MODEL)
  })

  it('sends nothing a host-chosen model could refuse', async () => {
    // No `thinking`, no `output_config`, no beta header. Every one of those is
    // rejected by *some* model somebody might name, and an adapter that 400s on
    // the cheap model chosen to afford a 40,000-image run is worse than one
    // that leaves a knob unturned.
    const fetchMock = answering('{}')
    await anthropicDescriber({ apiKey: KEY })(inputOf())

    const body = sent(fetchMock) as unknown as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system'])
    const [, init] = callsOf(fetchMock)[0]!
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('anthropic-beta')
  })

  it("takes the host's model and replaces — rather than appends to — the prompt", async () => {
    const fetchMock = answering('{}')
    await anthropicDescriber({
      apiKey: KEY,
      model: 'claude-haiku-4-5',
      prompt: 'Answer {"alt": "…"} only.',
    })(inputOf())

    const body = sent(fetchMock)
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.system).toContain('Answer {"alt": "…"} only.')
    expect(body.system).not.toContain(DEFAULT_DESCRIBE_PROMPT)
  })

  it('puts the vocabulary in the system prompt, by name, and never asks for one that is not there', async () => {
    const fetchMock = answering('{}')
    await anthropicDescriber({ apiKey: KEY })(inputOf())

    const { system } = sent(fetchMock)
    expect(system).toContain(DEFAULT_DESCRIBE_PROMPT)
    // Names, not slugs: a name is what an editor typed, and `matchTags`
    // slugifies whatever comes back either way.
    expect(system).toContain('- Headshot')
    expect(system).toContain('- Black and white')
    // The stable half is first and the image is in the message, which is the
    // order a cached prefix wants even though nothing here asks for one.
    expect(system.indexOf(DEFAULT_DESCRIBE_PROMPT)).toBeLessThan(system.indexOf('- Headshot'))
  })

  it('tells the model there is nothing to choose from when no tag exists', async () => {
    const fetchMock = answering('{}')
    await anthropicDescriber({ apiKey: KEY })(inputOf({ tags: [] }))
    expect(sent(fetchMock).system).toContain('No tags exist in this library yet')
  })
})

describe('which of the two image paths is taken', () => {
  it('hands over the URL, and does not touch R2, when the deployment is public', async () => {
    const fetchMock = answering('{}')
    const bytes = vi.fn(async () => new ArrayBuffer(4))
    await anthropicDescriber({ apiKey: KEY })(inputOf({ bytes }))

    const [image] = sent(fetchMock).messages[0]!.content
    expect(image).toEqual({
      type: 'image',
      source: {
        type: 'url',
        url: 'https://example.com/folio/asset/ast_abc123-photo.jpg?w=512&f=webp',
      },
    })
    // The laziness is the whole reason `bytes()` is a function: at
    // `concurrency: 4` against a 20MB ceiling, reading one per call that did
    // not need it is 80MB of live ArrayBuffer per batch.
    expect(bytes).toHaveBeenCalledTimes(0)
  })

  it.each([
    'http://localhost:5199/folio/asset/k.jpg',
    'http://127.0.0.1:8787/folio/asset/k.jpg',
    'http://192.168.1.20/folio/asset/k.jpg',
    'http://10.0.0.4/folio/asset/k.jpg',
    'http://172.20.0.4/folio/asset/k.jpg',
    'http://studio.local/folio/asset/k.jpg',
    'http://preview/folio/asset/k.jpg',
    'file:///tmp/k.jpg',
    'not a url at all',
  ])('sends the bytes instead when a model API could not fetch %s', async (url) => {
    const fetchMock = answering('{}')
    await anthropicDescriber({ apiKey: KEY })(inputOf({ url }))

    const [image] = sent(fetchMock).messages[0]!.content
    expect(image).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AQIDBA==' },
    })
  })

  it('names the reason rather than sending an inline type the API rejects', async () => {
    // AVIF and SVG are storable by `uploadAsset` and are not base64 image
    // sources. On a public deployment the URL carries them; on a local one
    // there is nothing to send, and a message naming that is better than
    // somebody else's 400.
    await expect(
      anthropicDescriber({ apiKey: KEY })(
        inputOf({ url: 'http://localhost:5199/folio/asset/k.avif', contentType: 'image/avif' }),
      ),
    ).rejects.toThrow(/image\/avif cannot be sent inline/)
  })
})

describe('the answer', () => {
  it('reads the JSON object and hands it on unclamped', async () => {
    // Unclamped on purpose: `describeAsset` type-checks, truncates and matches
    // every field, and a second implementation here is the one that drifts.
    answering(
      '{"alt":"A woman cycling past a red brick wall","description":"  A very long description  ","tags":["Headshot","product-shot",7]}',
    )
    await expect(anthropicDescriber({ apiKey: KEY })(inputOf())).resolves.toEqual({
      alt: 'A woman cycling past a red brick wall',
      description: '  A very long description  ',
      tags: ['Headshot', 'product-shot', 7],
    })
  })

  it('joins every text block before looking for the object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: 'thinking', thinking: '' },
                { type: 'text', text: '{"alt":' },
                { type: 'text', text: '"Split across blocks"}' },
              ],
              stop_reason: 'end_turn',
            }),
            { status: 200 },
          ),
      ),
    )
    await expect(anthropicDescriber({ apiKey: KEY })(inputOf())).resolves.toMatchObject({
      alt: 'Split across blocks',
    })
  })

  it('throws the status and a bounded body on a refused call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(2000), { status: 401 })),
    )
    const err = await anthropicDescriber({ apiKey: KEY })(inputOf()).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^anthropic: 401 x+$/)
    // `describe_error` is a column somebody reads in a table, and a provider's
    // body is not bounded by anything.
    expect((err as Error).message.length).toBeLessThan(360)
  })

  it('throws on a refusal rather than storing an empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [],
              stop_reason: 'refusal',
              stop_details: { category: 'csam' },
            }),
            { status: 200 },
          ),
      ),
    )
    await expect(anthropicDescriber({ apiKey: KEY })(inputOf())).rejects.toThrow(
      /the model declined \(csam\)/,
    )
  })
})

describe('parseDescribeJson', () => {
  it('reads an object a model wrapped in prose or a fence', () => {
    expect(parseDescribeJson('Here you go:\n```json\n{"alt":"A cat"}\n```\n')).toEqual({
      alt: 'A cat',
      description: undefined,
      tags: undefined,
    })
  })

  it('throws when there is no object, rather than answering an empty one', () => {
    // An empty result is the dangerous answer: `describeAsset` would stamp
    // `described_at` with no error, retiring the row from the backlog with
    // nothing left to find it by.
    expect(() => parseDescribeJson('I cannot see an image.')).toThrow(/no JSON object/)
    expect(() => parseDescribeJson('')).toThrow(/no JSON object/)
    expect(() => parseDescribeJson('{ not json }')).toThrow(/was not JSON/)
    expect(() => parseDescribeJson('["alt"]')).toThrow(/no JSON object/)
    expect(() => parseDescribeJson('null')).toThrow(/no JSON object/)
  })

  it('keeps only the three fields the seam declares', () => {
    expect(parseDescribeJson('{"alt":"a","focalPoint":{"x":1},"folder":"clients"}')).toEqual({
      alt: 'a',
      description: undefined,
      tags: undefined,
    })
  })
})
