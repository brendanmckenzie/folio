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

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

/** Base64 of `RENDITION`, which is what an unmodified stub should send. */
const RENDITION = new Uint8Array([9, 9, 9, 9]).buffer
const RENDITION_B64 = 'CQkJCQ=='

/**
 * **Two** stubbed fetches, because there are two now: the rendition Folio reads
 * for itself, then the API call carrying it. The image is answered for any URL
 * that is not the endpoint, which is what lets every test above stay written
 * about the request alone.
 *
 * `image: null` makes that first fetch *throw*, which is the shape a DNS failure
 * or a refused connection takes; a `status` makes it answer one, which is the
 * shape a WAF takes.
 */
function answering(
  text: string,
  init: {
    status?: number
    stopReason?: string
    image?: { status?: number; type?: string; bytes?: ArrayBuffer } | null
  } = {},
) {
  const fetchMock = vi.fn(async (target: unknown) => {
    if (String(target) !== ENDPOINT) {
      if (init.image === null) throw new TypeError('fetch failed')
      const image = init.image ?? {}
      return new Response(image.bytes ?? RENDITION, {
        status: image.status ?? 200,
        headers: { 'content-type': image.type ?? 'image/webp' },
      })
    }
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text }],
        stop_reason: init.stopReason ?? 'end_turn',
      }),
      { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** What `fetch` was called with. `vi.fn()` has no argument types of its own. */
function callsOf(fetchMock: ReturnType<typeof vi.fn>): [string | URL, RequestInit][] {
  return fetchMock.mock.calls as unknown as [string | URL, RequestInit][]
}

/** The API call, found by URL rather than by position — the image fetch is first. */
function apiCall(fetchMock: ReturnType<typeof vi.fn>): [string | URL, RequestInit] {
  const call = callsOf(fetchMock).find(([target]) => String(target) === ENDPOINT)
  expect(call, 'no call was made to the Messages API').toBeDefined()
  return call!
}

/** The parsed body of the API call. */
function sent(fetchMock: ReturnType<typeof vi.fn>): {
  model: string
  max_tokens: number
  system: string
  messages: { role: string; content: { type: string; [k: string]: unknown }[] }[]
} {
  return JSON.parse(String(apiCall(fetchMock)[1].body))
}

/** The image block of the one message sent. */
function imageSent(fetchMock: ReturnType<typeof vi.fn>) {
  return sent(fetchMock).messages[0]!.content[0]
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

    const [url, init] = apiCall(fetchMock)
    expect(String(url)).toBe(ENDPOINT)
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
    const [, init] = apiCall(fetchMock)
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

/**
 * **Folio reads the image; the model API never does.**
 *
 * This block used to assert the opposite, and the sentence it was defending —
 * "the image path is chosen from the URL, not from a failed attempt" — was
 * defending the wrong thing. Handing over a URL means a third party fetching
 * your site while announcing itself as an AI agent, and Folio only runs behind
 * Cloudflare, whose AI-crawler blocking is user-agent based and lists
 * `Claude-User`. The first host to press *Describe* on a real library got a 403
 * from their own WAF, reported by the API as `400 Unable to download the file`.
 *
 * So the assertions invert: the bytes are read here, from the *rendition* URL
 * (already `?w=512&f=webp` wherever an Images binding exists, which is what
 * keeps this affordable), and `input.bytes()` is the net under it.
 */
describe('where the image bytes come from', () => {
  it('reads the rendition itself rather than asking the model API to fetch it', async () => {
    const fetchMock = answering('{}')
    const bytes = vi.fn(async () => new ArrayBuffer(4))
    await anthropicDescriber({ apiKey: KEY })(inputOf({ bytes }))

    // The rendition is fetched first, and it is the transform URL rather than
    // the original: a 512px webp is what makes an inline image affordable.
    expect(String(callsOf(fetchMock)[0]![0])).toBe(
      'https://example.com/folio/asset/ast_abc123-photo.jpg?w=512&f=webp',
    )
    expect(imageSent(fetchMock)).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: RENDITION_B64 },
    })
    // R2 is still untouched on the path that works, which is the reason
    // `bytes()` is a function rather than a buffer.
    expect(bytes).toHaveBeenCalledTimes(0)
  })

  it('trusts the response content type over the row, because the transform changes it', async () => {
    // The row says `image/jpeg` and the rendition is webp. Sending the row's
    // type would be a 400 about a mismatch rather than about anything real.
    const fetchMock = answering('{}', { image: { type: 'image/webp; charset=binary' } })
    await anthropicDescriber({ apiKey: KEY })(inputOf({ contentType: 'image/jpeg' }))

    expect(imageSent(fetchMock)).toMatchObject({
      source: { media_type: 'image/webp' },
    })
  })

  it.each([
    ['a WAF or bot rule', { image: { status: 403 } }],
    ['a deployment behind Access', { image: { status: 302 } }],
    ['a refused connection', { image: null }],
    ['a rendition that is not an inline type', { image: { type: 'text/html' } }],
  ])(
    'falls back to the stored original when the rendition cannot be read: %s',
    async (_why, init) => {
      const fetchMock = answering('{}', init as Parameters<typeof answering>[1])
      await anthropicDescriber({ apiKey: KEY })(inputOf())

      // `inputOf`'s bytes are [1,2,3,4], and the media type is the row's.
      expect(imageSent(fetchMock)).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AQIDBA==' },
      })
    },
  )

  it.each(['file:///tmp/k.jpg', 'not a url at all'])(
    'does not try to fetch %s, and falls back without spending a request on it',
    async (url) => {
      const fetchMock = answering('{}')
      await anthropicDescriber({ apiKey: KEY })(inputOf({ url }))

      // One call, and it is the API: nothing was attempted against the URL.
      expect(callsOf(fetchMock)).toHaveLength(1)
      expect(imageSent(fetchMock)).toMatchObject({
        source: { type: 'base64', media_type: 'image/jpeg' },
      })
    },
  )

  it('reaches a localhost deployment, which the URL path never could', async () => {
    // `wrangler dev` is the first place a host tries this, and its asset URL is
    // fetchable from exactly one machine — the one now doing the fetching. This
    // used to be a hard-coded special case taking the bytes path.
    const fetchMock = answering('{}')
    const bytes = vi.fn(async () => new ArrayBuffer(4))
    await anthropicDescriber({ apiKey: KEY })(
      inputOf({ url: 'http://localhost:5199/folio/asset/k.jpg', bytes }),
    )

    expect(imageSent(fetchMock)).toMatchObject({ source: { media_type: 'image/webp' } })
    expect(bytes).toHaveBeenCalledTimes(0)
  })

  it('names the reason when neither the rendition nor the original can be sent inline', async () => {
    // AVIF and SVG are storable by `uploadAsset` and are not base64 image
    // sources. With the rendition unreadable there is nothing to send, and a
    // message naming both halves beats somebody else's 400.
    answering('{}', { image: { status: 500 } })
    await expect(
      anthropicDescriber({ apiKey: KEY })(inputOf({ contentType: 'image/avif' })),
    ).rejects.toThrow(/could not be read, and image\/avif cannot be sent inline/)
  })

  it('refuses an oversized image before spending the call, and says how to fix it', async () => {
    // Only reachable on the fallback path in practice — a 512px webp is never
    // 5MB — so the message points at the binding that would have produced one.
    answering('{}', { image: null })
    await expect(
      anthropicDescriber({ apiKey: KEY })(
        inputOf({ bytes: async () => new ArrayBuffer(6 * 1024 * 1024) }),
      ),
    ).rejects.toThrow(/6MB, over the API's 5MB limit — configure an Images binding/)
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
