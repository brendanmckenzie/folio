import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TRANSFORM_DIMENSION,
  MAX_TRANSFORM_QUALITY,
  MAX_UPLOAD_BYTES,
  MIN_TRANSFORM_DIMENSION,
  MIN_TRANSFORM_QUALITY,
  parseTransform,
  serveAsset,
} from '../../src/server/assets'
import type { AssetRow } from '../../src/server/assets'

/**
 * Upload and serving policy: test/workers/http.test.ts already exercises the
 * shape of the API (the JSON envelope, the field types); this file pins the
 * decisions from the hardening pass instead — what a route stores when a
 * client's header disagrees with the bytes it sent, what it serves inline
 * versus as a download, and what keeps a public, per-query-string transform
 * route from being an unbounded Images bill.
 */

const ORIGIN = 'https://example.com'
const BASE = `${ORIGIN}/folio`
const API = `${BASE}/api`

interface ErrorEnvelope {
  error: { code: string; message: string }
}

async function failureOf(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: ErrorEnvelope }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, init)
  return { status: res.status, body: await res.json<ErrorEnvelope>() }
}

function upload(filename: string, contentType: string, body: BodyInit, extraHeaders = {}) {
  return SELF.fetch(`${API}/assets?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...extraHeaders },
    body,
  })
}

/** 1×1 transparent PNG — same fixture http.test.ts uses. */
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

/** GIF89a, 1×1: enough of a header for both `imageSize` and `sniffContentType`. */
const GIF_1X1 = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
])

describe('upload: content type is derived from magic bytes, never trusted from the header', () => {
  it('overrides a lying Content-Type with what the bytes actually are', async () => {
    // Claims PNG; the bytes are a GIF. The stored type follows the bytes.
    const res = await upload('photo.png', 'image/png', GIF_1X1)
    expect(res.status).toBe(201)
    const { asset } = await res.json<{ asset: AssetRow }>()
    expect(asset.contentType).toBe('image/gif')
  })

  it('overrides the other direction too: real image bytes under a claimed non-image type', async () => {
    const res = await upload('photo.dat', 'application/octet-stream', PNG_1X1)
    const { asset } = await res.json<{ asset: AssetRow }>()
    expect(asset.contentType).toBe('image/png')
  })

  it('stores bytes matching no known signature as the download type, whatever the header claimed', async () => {
    const res = await upload('payload.png', 'image/png', '<script>alert(1)</script>')
    const { asset } = await res.json<{ asset: AssetRow }>()
    expect(asset.contentType).toBe('application/octet-stream')
  })
})

describe('serving: five raster types render inline, everything else downloads', () => {
  it('serves a PNG inline, with nosniff, CSP and an explicit inline disposition', async () => {
    const { asset } = await (await upload('photo.png', 'image/png', PNG_1X1)).json<{
      asset: AssetRow
    }>()

    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-disposition')).toBe('inline')
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('serves an uploaded SVG as an attachment, with nosniff — never inline as an image', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
    const { asset } = await (await upload('logo.svg', 'image/svg+xml', svg)).json<{
      asset: AssetRow
    }>()

    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('application/octet-stream')
    expect(served.headers.get('content-disposition')).toBe('attachment')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    // The file itself is kept intact — only its rendering is refused.
    expect(await served.text()).toBe(svg)
  })

  it('is inert behind nosniff + CSP + attachment even when the bytes are a GIF/HTML polyglot', async () => {
    // A short GIF signature followed immediately by a script tag: the upload
    // sniffs as image/gif (the signature is what decides, never the claimed
    // header) and must still never execute as this origin's HTML.
    const polyglot = 'GIF89a<html><script>alert(document.domain)</script></html>'
    const { asset } = await (await upload('poly.gif', 'text/html', polyglot)).json<{
      asset: AssetRow
    }>()
    expect(asset.contentType).toBe('image/gif')

    const served = await SELF.fetch(`${BASE}/asset/${asset.key}`)
    expect(served.headers.get('content-type')).toBe('image/gif')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    // Bytes travel intact — only ever rendered as an image/gif, sandboxed.
    expect(await served.text()).toBe(polyglot)
  })
})

describe('the public asset route only ever reads a key Folio itself minted', () => {
  it('refuses a key that is not the ast_<hex>-<filename> shape, even if the bucket holds an object there', async () => {
    // Simulates another object co-tenanted in the same bucket under a
    // guessable, un-prefixed key — never something `uploadAsset` produced.
    await env.MEDIA.put('config.json', '{"token":"hunter2"}', {
      httpMetadata: { contentType: 'application/json' },
    })

    const { status, body } = await failureOf('/folio/asset/config.json')
    expect(status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })
})

describe('upload size cap: enforced before the body is fully buffered', () => {
  it('refuses an oversized upload on the declared Content-Length, before reading anything', async () => {
    const { status, body } = await failureOf('/folio/api/assets?filename=huge.png', {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'content-length': String(MAX_UPLOAD_BYTES + 1),
      },
      body: PNG_1X1,
    })

    expect(status).toBe(413)
    expect(body.error.code).toBe('too_large')
  })

  it('aborts a streamed upload with no (or an understated) Content-Length once the running total exceeds the cap, without buffering the whole thing first', async () => {
    const chunkSize = 1024 * 1024 // 1MB
    const totalChunks = 30 // 30MB total, comfortably over the 20MB cap
    let sent = 0
    let pulls = 0
    let cancelled = false

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (sent >= totalChunks) {
          controller.close()
          return
        }
        sent++
        controller.enqueue(new Uint8Array(chunkSize))
      },
      cancel() {
        cancelled = true
      },
    })

    const res = await SELF.fetch(`${API}/assets?filename=huge.png`, {
      method: 'POST',
      // Deliberately no content-length: this is the path the header-based
      // check cannot catch, and the one the streaming reader exists for.
      headers: { 'content-type': 'image/png' },
      body,
    })

    expect(res.status).toBe(413)
    const envelope = await res.json<ErrorEnvelope>()
    expect(envelope.error.code).toBe('too_large')
    // Aborted well short of the full 30 chunks, and the source stream was
    // told to stop rather than being drained to completion.
    expect(pulls).toBeLessThan(totalChunks)
    expect(cancelled).toBe(true)
  })
})

describe('transform query: clamped, never rejected', () => {
  it('snaps width, height and quality into their ranges instead of dropping an out-of-range value', () => {
    const params = new URLSearchParams('w=1&h=999999&q=1000')
    expect(parseTransform(params)).toEqual({
      width: MIN_TRANSFORM_DIMENSION,
      height: MAX_TRANSFORM_DIMENSION,
      quality: MAX_TRANSFORM_QUALITY,
    })
  })

  it('drops only a genuinely non-numeric value', () => {
    const params = new URLSearchParams('w=not-a-number&q=nope')
    expect(parseTransform(params)).toEqual({})
  })

  it('snaps a quality below the floor up to it', () => {
    expect(parseTransform(new URLSearchParams('q=1'))).toEqual({ quality: MIN_TRANSFORM_QUALITY })
  })

  it('clamps an out-of-range focal point into [0, 1] instead of handing it straight to the Images binding', () => {
    // Out-of-range gravity throws inside the Images binding, and that throw is
    // what used to fall through to serving the full-size original — repeatably,
    // since a thrown transform is never written to the Cache API.
    expect(parseTransform(new URLSearchParams('w=16&fit=cover&fp=1e12,-500'))).toEqual({
      width: 16,
      fit: 'cover',
      focal: { x: 1, y: 0 },
    })
  })
})

/**
 * No Images binding is configured for this test worker on purpose (see
 * wrangler.jsonc) — the fallback path it exercises is itself a load-bearing
 * scenario. Caching a real Images invocation needs a binding to spy on, so
 * these tests call `serveAsset` directly with a stub rather than adding one to
 * the shared test worker, exactly as the wiring in src/server/routes/assets.ts
 * does at the route.
 */
describe('transform responses are wrapped in the Cache API, keyed on the full URL', () => {
  function fakeImages(outputBytes: ArrayBuffer, contentType: string) {
    let invocations = 0
    const transformer: ImageTransformer = {
      transform: () => transformer,
      draw: () => transformer,
      output: async () => ({
        response: () => new Response(outputBytes, { headers: { 'content-type': contentType } }),
        contentType: () => contentType,
        image: () => new ReadableStream(),
      }),
    }
    const images = {
      input: () => {
        invocations++
        return transformer
      },
      info: async () => {
        throw new Error('not exercised by this test')
      },
      hosted: {},
    } as unknown as ImagesBinding
    return { images, invocations: () => invocations }
  }

  it('serves the second identical transform request from cache, without a second Images invocation', async () => {
    const key = 'ast_cachetest1-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })

    const { images, invocations } = fakeImages(new Uint8Array([9, 9, 9]).buffer, 'image/webp')
    const request = new Request(`${BASE}/asset/${key}?w=100`)
    const transform = parseTransform(new URL(request.url).searchParams)

    const first = await serveAsset(env.MEDIA, images, key, transform, request)
    const second = await serveAsset(env.MEDIA, images, key, transform, request)

    expect(invocations()).toBe(1)
    expect(second.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array(await second.arrayBuffer()),
    )
  })

  it('does not share a cache entry across a different query string', async () => {
    const key = 'ast_cachetest2-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })
    const { images, invocations } = fakeImages(new Uint8Array([1]).buffer, 'image/webp')

    const reqA = new Request(`${BASE}/asset/${key}?w=100`)
    const reqB = new Request(`${BASE}/asset/${key}?w=200`)
    await serveAsset(env.MEDIA, images, key, parseTransform(new URL(reqA.url).searchParams), reqA)
    await serveAsset(env.MEDIA, images, key, parseTransform(new URL(reqB.url).searchParams), reqB)

    expect(invocations()).toBe(2)
  })

  it('shares a cache entry across raw query strings that clamp to the identical transform', async () => {
    const key = 'ast_cachetest4-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })
    const { images, invocations } = fakeImages(new Uint8Array([2]).buffer, 'image/webp')

    // Four raw query strings, one clamped output: an out-of-range width, the
    // max itself, a cache-busting extra param, and a `+`-padded number. Keying
    // the cache on the raw URL (rather than the clamped transform) would mint
    // one Images invocation apiece — an anonymous, unauthenticated client
    // minting unlimited billable transforms behind a single asset URL.
    const rawQueries = ['w=99999', `w=${MAX_TRANSFORM_DIMENSION}`, 'w=2400&cachebust=1', 'w=+2400']
    for (const q of rawQueries) {
      const req = new Request(`${BASE}/asset/${key}?${q}`)
      await serveAsset(env.MEDIA, images, key, parseTransform(new URL(req.url).searchParams), req)
    }

    expect(invocations()).toBe(1)
  })

  it('never runs the transform for a HEAD request, and never logs one as a failure', async () => {
    const key = 'ast_cachetest5-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })
    const { images, invocations } = fakeImages(new Uint8Array([3]).buffer, 'image/webp')

    const request = new Request(`${BASE}/asset/${key}?w=100`, { method: 'HEAD' })
    const transform = parseTransform(new URL(request.url).searchParams)

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await serveAsset(env.MEDIA, images, key, transform, request)
      expect(res.status).toBe(200)
      // The original, not the transform's output: a HEAD never spends an
      // Images invocation, so it was never going to have the transformed type.
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(invocations()).toBe(0)
      expect(logged).not.toHaveBeenCalled()
      // Not pinned for a year: this is not the variant `?w=100` asked for.
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    } finally {
      logged.mockRestore()
    }
  })

  it('degrades to a short cache-control, not immutable, when no Images binding is configured at all', async () => {
    const key = 'ast_cachetest6-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })

    const request = new Request(`${BASE}/asset/${key}?w=100`)
    const transform = parseTransform(new URL(request.url).searchParams)
    const res = await serveAsset(env.MEDIA, undefined, key, transform, request)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('logs rather than swallows a transform failure, and still serves the original', async () => {
    const key = 'ast_cachetest3-photo.png'
    await env.MEDIA.put(key, PNG_1X1, { httpMetadata: { contentType: 'image/png' } })

    const transformer: ImageTransformer = {
      transform: () => transformer,
      draw: () => transformer,
      output: async () => {
        throw new Error('boom')
      },
    }
    const images = {
      input: () => transformer,
      info: async () => {
        throw new Error('not exercised by this test')
      },
      hosted: {},
    } as unknown as ImagesBinding

    const request = new Request(`${BASE}/asset/${key}?w=100`)
    const transform = parseTransform(new URL(request.url).searchParams)

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await serveAsset(env.MEDIA, images, key, transform, request)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      // Never immutable: this is the original standing in for a variant that
      // failed, and the failure may well be transient.
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
      expect(logged).toHaveBeenCalled()
      expect(String(logged.mock.calls[0]?.[0])).toContain(key)
    } finally {
      logged.mockRestore()
    }
  })
})

describe('a missing asset answers with the envelope, like every other failure', () => {
  it('unknown key → 404 { error: { code: not_found } }', async () => {
    const { status, body } = await failureOf('/folio/asset/ast_abcdef123456-none.png')
    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
    // The message is client-safe and names no bucket, key shape, or internals.
    expect(body.error.message).toBe('No such asset')
  })

  it('transformed request for an unknown key gets the same envelope', async () => {
    const { status, body } = await failureOf('/folio/asset/ast_abcdef123456-none.png?w=100')
    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})
