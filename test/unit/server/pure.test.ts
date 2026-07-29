import { describe, expect, it } from 'vitest'
import {
  imageSize,
  MAX_TRANSFORM_DIMENSION,
  MAX_TRANSFORM_QUALITY,
  MIN_TRANSFORM_DIMENSION,
  MIN_TRANSFORM_QUALITY,
  parseTransform,
  sniffContentType,
} from '../../../src/server/assets'
import { serializeJson } from '../../../src/server/Document'
import { normalisePath, redirectStatements } from '../../../src/server/redirects'

// ---------------------------------------------------------------------------
// imageSize
// ---------------------------------------------------------------------------

describe('imageSize', () => {
  describe('PNG', () => {
    it('parses valid PNG header', () => {
      // Minimal valid PNG: 8-byte signature + IHDR chunk with width/height
      const png = new Uint8Array([
        // PNG signature
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        // IHDR chunk length (13 bytes)
        0x00, 0x00, 0x00, 0x0d,
        // IHDR chunk type
        0x49, 0x48, 0x44, 0x52,
        // Width: 100 (0x00000064)
        0x00, 0x00, 0x00, 0x64,
        // Height: 50 (0x00000032)
        0x00, 0x00, 0x00, 0x32,
      ])
      expect(imageSize(png)).toEqual({ width: 100, height: 50 })
    })

    it('rejects PNG too short for header', () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      expect(imageSize(png)).toBeNull()
    })

    it('rejects bytes with PNG signature but no IHDR', () => {
      const png = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x50,
        0x4c,
        0x54,
        0x45, // PLTE chunk instead of IHDR
      ])
      expect(imageSize(png)).toBeNull()
    })
  })

  describe('JPEG', () => {
    it('parses valid JPEG with SOF0 marker', () => {
      // Minimal JPEG: SOI + SOF0 + dimensions
      const jpeg = new Uint8Array([
        // SOI marker
        0xff,
        0xd8,
        // SOF0 marker (0xc0) with length
        0xff,
        0xc0,
        0x00,
        0x0b, // length: 11 bytes
        // Precision
        0x08,
        // Height: 200 (0x00c8)
        0x00,
        0xc8,
        // Width: 150 (0x0096)
        0x00,
        0x96,
        // Num components
        0x01,
      ])
      expect(imageSize(jpeg)).toEqual({ width: 150, height: 200 })
    })

    it('parses JPEG with SOF1 marker', () => {
      const jpeg = new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc1, // SOF1 marker
        0x00,
        0x0b,
        0x08,
        0x00,
        0x64, // height: 100
        0x00,
        0x32, // width: 50
        0x01,
      ])
      expect(imageSize(jpeg)).toEqual({ width: 50, height: 100 })
    })

    it('skips JPEG table markers (DHT, DQT)', () => {
      const jpeg = new Uint8Array([
        0xff,
        0xd8,
        // DHT marker (0xc4)
        0xff,
        0xc4,
        0x00,
        0x05, // length: 5
        0x00,
        0x00,
        0x00,
        // SOF0 marker after DHT
        0xff,
        0xc0,
        0x00,
        0x0b,
        0x08,
        0x00,
        0x80, // height: 128
        0x00,
        0x40, // width: 64
        0x01,
      ])
      expect(imageSize(jpeg)).toEqual({ width: 64, height: 128 })
    })

    it('ignores 0xc8 marker (reserved)', () => {
      const jpeg = new Uint8Array([
        0xff,
        0xd8,
        // Reserved marker (0xc8)
        0xff,
        0xc8,
        0x00,
        0x05,
        0x00,
        0x00,
        0x00,
        // Actual SOF0
        0xff,
        0xc0,
        0x00,
        0x0b,
        0x08,
        0x00,
        0x20, // height: 32
        0x00,
        0x10, // width: 16
        0x01,
      ])
      expect(imageSize(jpeg)).toEqual({ width: 16, height: 32 })
    })

    it('returns null when no SOF marker found', () => {
      const jpeg = new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xd9, // EOI marker, no SOF
      ])
      expect(imageSize(jpeg)).toBeNull()
    })

    it('returns null for truncated JPEG', () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff])
      expect(imageSize(jpeg)).toBeNull()
    })
  })

  describe('GIF', () => {
    it('parses GIF87a header', () => {
      const gif = new Uint8Array([
        0x47,
        0x49,
        0x46, // GIF signature
        0x38,
        0x37,
        0x61, // 87a version
        // Width: 320 (little-endian: 0x0140 -> 0x40, 0x01)
        0x40,
        0x01,
        // Height: 240 (little-endian: 0x00f0 -> 0xf0, 0x00)
        0xf0,
        0x00,
      ])
      expect(imageSize(gif)).toEqual({ width: 320, height: 240 })
    })

    it('parses GIF89a header', () => {
      const gif = new Uint8Array([
        0x47,
        0x49,
        0x46, // GIF
        0x38,
        0x39,
        0x61, // 89a version
        // Width: 1 (little-endian)
        0x01,
        0x00,
        // Height: 1 (little-endian)
        0x01,
        0x00,
      ])
      expect(imageSize(gif)).toEqual({ width: 1, height: 1 })
    })

    it('rejects GIF header too short', () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46])
      expect(imageSize(gif)).toBeNull()
    })
  })

  describe('WEBP', () => {
    it('parses WEBP with VP8X chunk', () => {
      const webp = new Uint8Array([
        // RIFF signature at offset 0
        0x52, 0x49, 0x46, 0x46,
        // File size (little-endian) at offset 4
        0x20, 0x00, 0x00, 0x00,
        // WEBP signature at offset 8
        0x57, 0x45, 0x42, 0x50,
        // VP8X chunk type at offset 12
        0x56, 0x50, 0x38, 0x58,
        // Chunk size (little-endian) at offset 16
        0x0a, 0x00, 0x00, 0x00,
        // Chunk data starts at offset 20
        // VP8X flags at offset 20
        0x00,
        // Reserved at offsets 21-23
        0x00, 0x00, 0x00,
        // Width-1 at offset 24-26 (24-bit little-endian)
        // width-1 = 99 (0x63 = 100 - 1)
        0x63, 0x00, 0x00,
        // Height-1 at offset 27-29 (24-bit little-endian)
        // height-1 = 79 (0x4f = 80 - 1)
        0x4f, 0x00, 0x00,
      ])
      expect(imageSize(webp)).toEqual({ width: 100, height: 80 })
    })

    it('parses WEBP with VP8 chunk', () => {
      const webp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        // VP8 chunk type (lossy)
        0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00,
        // VP8 frame data (simplified)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Width at offset 26 (little-endian, masked with 0x3fff): 512 (0x0200)
        0x00, 0x02,
        // Height at offset 28 (little-endian, masked with 0x3fff): 256 (0x0100)
        0x00, 0x01,
      ])
      expect(imageSize(webp)).toEqual({ width: 512, height: 256 })
    })

    it('parses WEBP with VP8L chunk', () => {
      const webp = new Uint8Array([
        // RIFF signature at offset 0
        0x52, 0x49, 0x46, 0x46,
        // File size at offset 4
        0x20, 0x00, 0x00, 0x00,
        // WEBP signature at offset 8
        0x57, 0x45, 0x42, 0x50,
        // VP8L chunk type at offset 12
        0x56, 0x50, 0x38, 0x4c,
        // Chunk size at offset 16
        0x0a, 0x00, 0x00, 0x00,
        // Chunk data starts at offset 20
        // One byte at offset 20
        0x00,
        // VP8L encoded dimensions at offset 21-24 (little-endian 32-bit)
        // Bits [0:14] = width-1, bits [14:28] = height-1
        // width-1 = 199 (0xc7), height-1 = 149 (0x95)
        // bits = 199 | (149 << 14) = 0xc7 | 0x254000 = 0x2540c7
        // As little-endian bytes: 0xc7, 0x40, 0x25, 0x00
        0xc7, 0x40, 0x25, 0x00,
        // Padding to reach minimum 30 bytes
        0x00, 0x00, 0x00, 0x00, 0x00,
      ])
      expect(imageSize(webp)).toEqual({ width: 200, height: 150 })
    })

    it('returns null for WEBP too short', () => {
      const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46])
      expect(imageSize(webp)).toBeNull()
    })

    it('returns null for RIFF without WEBP signature', () => {
      const riff = new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0x20,
        0x00,
        0x00,
        0x00,
        0x41,
        0x56,
        0x49,
        0x20, // AVI signature instead
      ])
      expect(imageSize(riff)).toBeNull()
    })
  })

  it('returns null for unknown format', () => {
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    expect(imageSize(unknown)).toBeNull()
  })

  it('returns null for empty data', () => {
    const empty = new Uint8Array([])
    expect(imageSize(empty)).toBeNull()
  })

  it('handles junk bytes gracefully', () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    expect(imageSize(junk)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// sniffContentType
// ---------------------------------------------------------------------------

describe('sniffContentType', () => {
  it('recognises a PNG signature', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(sniffContentType(png)).toBe('image/png')
  })

  it('recognises a JPEG signature', () => {
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  })

  it('recognises a GIF signature, either version', () => {
    expect(sniffContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif')
    expect(sniffContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
  })

  it('recognises a WEBP signature', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    expect(sniffContentType(webp)).toBe('image/webp')
  })

  it('does not mistake another RIFF container for WEBP', () => {
    const avi = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ])
    expect(sniffContentType(avi)).toBeUndefined()
  })

  it('recognises an AVIF ftyp box', () => {
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ])
    expect(sniffContentType(avif)).toBe('image/avif')
  })

  it('does not mistake another ftyp brand for AVIF', () => {
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ])
    expect(sniffContentType(heic)).toBeUndefined()
  })

  it('returns undefined for bytes matching no known signature, including truncated ones', () => {
    expect(sniffContentType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeUndefined()
    expect(sniffContentType(new Uint8Array([0x89, 0x50]))).toBeUndefined()
    expect(sniffContentType(new Uint8Array([]))).toBeUndefined()
  })

  it('is not fooled by a claimed type: only the bytes decide', () => {
    // The scenario uploadAsset relies on: a client-supplied header is never
    // consulted here at all, only the buffer.
    const html = new TextEncoder().encode('<script>alert(1)</script>')
    expect(sniffContentType(html)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseTransform
// ---------------------------------------------------------------------------

describe('parseTransform', () => {
  describe('dimension parsing', () => {
    it('parses width and height', () => {
      const params = new URLSearchParams('w=800&h=600')
      expect(parseTransform(params)).toEqual({
        width: 800,
        height: 600,
      })
    })

    it('snaps width/height zero or negative up to the minimum, rather than dropping them', () => {
      const params = new URLSearchParams('w=0&h=-10')
      expect(parseTransform(params)).toEqual({
        width: MIN_TRANSFORM_DIMENSION,
        height: MIN_TRANSFORM_DIMENSION,
      })
    })

    it('ignores non-numeric width/height', () => {
      const params = new URLSearchParams('w=abc&h=def')
      expect(parseTransform(params)).toEqual({})
    })

    it('parses only valid dimensions when mixed', () => {
      const params = new URLSearchParams('w=400&h=invalid')
      expect(parseTransform(params)).toEqual({ width: 400 })
    })

    it('ignores width/height that are not finite', () => {
      const params = new URLSearchParams('w=Infinity&h=NaN')
      expect(parseTransform(params)).toEqual({})
    })

    it('clamps width and height to the largest dimension the route serves', () => {
      // The query is public and every distinct value mints its own Images
      // transformation and its own immutable cache entry.
      const params = new URLSearchParams('w=1000000&h=999999')
      expect(parseTransform(params)).toEqual({
        width: MAX_TRANSFORM_DIMENSION,
        height: MAX_TRANSFORM_DIMENSION,
      })
    })

    it('collapses fractional dimensions onto whole pixels, then clamps', () => {
      const params = new URLSearchParams('w=800.6&h=0.5')
      // trunc(0.5) is 0, which then snaps up to the minimum rather than
      // surviving as a 0-pixel image.
      expect(parseTransform(params)).toEqual({ width: 800, height: MIN_TRANSFORM_DIMENSION })
    })
  })

  describe('quality parsing', () => {
    it('parses quality parameter', () => {
      const params = new URLSearchParams('q=80')
      expect(parseTransform(params)).toEqual({ quality: 80 })
    })

    it('snaps quality zero or negative up to the minimum, rather than dropping it', () => {
      const params = new URLSearchParams('q=0&w=100')
      expect(parseTransform(params)).toEqual({ width: 100, quality: MIN_TRANSFORM_QUALITY })
    })

    it('clamps quality to the decided ceiling', () => {
      const params = new URLSearchParams('q=99999')
      expect(parseTransform(params)).toEqual({ quality: MAX_TRANSFORM_QUALITY })
    })
  })

  describe('fit parameter', () => {
    it('accepts fit=cover', () => {
      const params = new URLSearchParams('fit=cover&w=100')
      const result = parseTransform(params)
      expect(result).toHaveProperty('fit', 'cover')
      expect(result.width).toBe(100)
    })

    it('accepts fit=contain', () => {
      const params = new URLSearchParams('fit=contain')
      expect(parseTransform(params)).toHaveProperty('fit', 'contain')
    })

    it('accepts fit=scale-down', () => {
      const params = new URLSearchParams('fit=scale-down')
      expect(parseTransform(params)).toHaveProperty('fit', 'scale-down')
    })

    it('rejects invalid fit values', () => {
      const params = new URLSearchParams('fit=invalid&w=100')
      const result = parseTransform(params)
      expect(result).not.toHaveProperty('fit')
      expect(result.width).toBe(100)
    })
  })

  describe('format parameter', () => {
    it('accepts webp format', () => {
      const params = new URLSearchParams('f=webp')
      expect(parseTransform(params)).toHaveProperty('format', 'webp')
    })

    it('accepts avif format', () => {
      const params = new URLSearchParams('f=avif')
      expect(parseTransform(params)).toHaveProperty('format', 'avif')
    })

    it('accepts jpeg format', () => {
      const params = new URLSearchParams('f=jpeg')
      expect(parseTransform(params)).toHaveProperty('format', 'jpeg')
    })

    it('accepts png format', () => {
      const params = new URLSearchParams('f=png')
      expect(parseTransform(params)).toHaveProperty('format', 'png')
    })

    it('rejects invalid format', () => {
      const params = new URLSearchParams('f=bmp&w=100')
      const result = parseTransform(params)
      expect(result).not.toHaveProperty('format')
      expect(result.width).toBe(100)
    })
  })

  describe('focal point parameter', () => {
    it('parses focal point x,y', () => {
      const params = new URLSearchParams('fp=0.5,0.75')
      const result = parseTransform(params)
      expect(result.focal).toEqual({ x: 0.5, y: 0.75 })
    })

    it('ignores focal point if not both x and y', () => {
      const params = new URLSearchParams('fp=0.5&w=100')
      const result = parseTransform(params)
      expect(result.focal).toBeUndefined()
      expect(result.width).toBe(100)
    })

    it('ignores focal point if values are not finite', () => {
      const params = new URLSearchParams('fp=NaN,0.5&w=100')
      const result = parseTransform(params)
      expect(result.focal).toBeUndefined()
    })

    it('clamps an out-of-range focal point into [0, 1] rather than passing it through', () => {
      // The Images binding's `gravity` expects normalised 0..1 coordinates;
      // handing it 100/200 unclamped throws the transform, which used to fall
      // through to serving the full-size original, repeatably.
      const params = new URLSearchParams('fp=100,200')
      expect(parseTransform(params)).toHaveProperty('focal', { x: 1, y: 1 })
    })

    it('clamps a negative focal point up to 0', () => {
      const params = new URLSearchParams('fp=-5,-0.5')
      expect(parseTransform(params)).toHaveProperty('focal', { x: 0, y: 0 })
    })
  })

  it('combines all parameters', () => {
    const params = new URLSearchParams('w=1024&h=768&q=75&f=webp&fit=cover&fp=0.5,0.5')
    const result = parseTransform(params)
    expect(result).toEqual({
      width: 1024,
      height: 768,
      quality: 75,
      format: 'webp',
      fit: 'cover',
      focal: { x: 0.5, y: 0.5 },
    })
  })

  it('returns empty object for no parameters', () => {
    const params = new URLSearchParams()
    expect(parseTransform(params)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// serializeJson
// ---------------------------------------------------------------------------

describe('serializeJson', () => {
  it('serializes simple objects', () => {
    const result = serializeJson({ a: 1, b: 'hello' })
    expect(result).toBe('{"a":1,"b":"hello"}')
  })

  it('serializes arrays', () => {
    const result = serializeJson([1, 2, 3])
    expect(result).toBe('[1,2,3]')
  })

  it('escapes < character', () => {
    const result = serializeJson({ html: '<script>' })
    expect(result).toBe('{"html":"\\u003cscript>"}')
    expect(result).not.toContain('<')
  })

  it('escapes multiple < characters', () => {
    const result = serializeJson('<<>')
    expect(result).toBe('"\\u003c\\u003c>"')
  })

  it('does not escape other special characters', () => {
    const result = serializeJson({ quote: '"', backslash: '\\' })
    expect(result).toContain('\\"')
    expect(result).toContain('\\\\')
  })

  it('preserves \\u2028 and \\u2029 in strings', () => {
    // These are now valid in JS string literals (ES2019+)
    const result = serializeJson('line\u2028sep\u2029end')
    expect(result).toContain('\u2028')
    expect(result).toContain('\u2029')
  })

  it('round-trips objects through parse', () => {
    const original = { name: 'John', age: 30, items: [1, 2, 3] }
    const serialized = serializeJson(original)
    const parsed = JSON.parse(serialized)
    expect(parsed).toEqual(original)
  })

  it('serializes null', () => {
    expect(serializeJson(null)).toBe('null')
  })

  // SPEC(undefined-crash): serializeJson is total over its input. undefined
  // normalises to JSON null rather than crashing .replace() on the non-string
  // JSON.stringify(undefined) returns.
  it('serializes undefined as null', () => {
    expect(serializeJson(undefined)).toBe('null')
  })

  it('serializes boolean values', () => {
    expect(serializeJson(true)).toBe('true')
    expect(serializeJson(false)).toBe('false')
  })

  it('serializes numeric values', () => {
    expect(serializeJson(42)).toBe('42')
    expect(serializeJson(3.14)).toBe('3.14')
    expect(serializeJson(0)).toBe('0')
  })

  it('safely embeds in HTML script tag', () => {
    const data = { text: '<img src=x onerror=alert(1)>' }
    const json = serializeJson(data)
    const html = `<script>var data = ${json}</script>`
    // Should not contain unescaped <
    expect(html).not.toMatch(/<img/)
    expect(html).toContain('\\u003c')
  })

  it('handles deeply nested structures', () => {
    const nested = {
      a: {
        b: {
          c: {
            d: '<deep>',
          },
        },
      },
    }
    const result = serializeJson(nested)
    expect(result).toContain('\\u003c')
    expect(JSON.parse(result)).toEqual(nested)
  })
})

// ---------------------------------------------------------------------------
// normalisePath / redirectStatements (redirects.md)
// ---------------------------------------------------------------------------

/**
 * The narrowest possible D1Database: `redirectStatements` only ever calls
 * `.prepare(sql).bind(...args)` and never runs a statement, so recording the
 * two is enough to test the builder without workerd or a real database.
 */
function fakeDb(): { db: D1Database; calls: { sql: string; args: unknown[] }[] } {
  const calls: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          calls.push({ sql, args })
          return { sql, args }
        },
      }
    },
  } as unknown as D1Database
  return { db, calls }
}

describe('normalisePath', () => {
  it('strips a single leading and trailing slash', () => {
    expect(normalisePath('/about/')).toBe('about')
  })

  it('strips repeated leading and trailing slashes', () => {
    expect(normalisePath('///about///')).toBe('about')
  })

  it('lowercases the path, so case variants hit the same row', () => {
    expect(normalisePath('/Summer-Sale')).toBe('summer-sale')
  })

  it('strips a query string, which is preserved on the redirect by the host instead', () => {
    expect(normalisePath('/old?utm_source=x')).toBe('old')
    expect(normalisePath('old?a=1&b=2')).toBe('old')
  })

  it('is the empty string for the root, with or without a slash', () => {
    expect(normalisePath('')).toBe('')
    expect(normalisePath('/')).toBe('')
  })

  it('leaves an already-normalised path untouched', () => {
    expect(normalisePath('about/team')).toBe('about/team')
  })
})

describe('redirectStatements', () => {
  it('builds exactly three statements, in order: delete, collapse, insert', () => {
    const { db, calls } = fakeDb()
    const statements = redirectStatements(db, {
      from: 'about',
      to: 'about-us',
      storyId: 'sty_about',
    })

    expect(statements).toHaveLength(3)
    expect(calls[0]?.sql).toMatch(/^delete from redirects where from_path = \?/)
    expect(calls[0]?.args).toEqual(['about-us'])

    expect(calls[1]?.sql).toMatch(/^update redirects set to_path = \? where to_path = \?/)
    expect(calls[1]?.args).toEqual(['about-us', 'about'])

    expect(calls[2]?.sql).toMatch(/insert or replace into redirects/)
    expect(calls[2]?.args).toEqual([
      'about',
      'about-us',
      301,
      'auto',
      'sty_about',
      expect.any(Number),
    ])
  })

  it('normalises both from and to before any statement is built', () => {
    const { db, calls } = fakeDb()
    redirectStatements(db, { from: '/About/', to: '/About-Us/', storyId: null })

    expect(calls[0]?.args).toEqual(['about-us'])
    expect(calls[1]?.args).toEqual(['about-us', 'about'])
    expect(calls[2]?.args?.slice(0, 2)).toEqual(['about', 'about-us'])
  })

  it('returns no statements when the path did not actually change', () => {
    const { db, calls } = fakeDb()
    expect(redirectStatements(db, { from: 'about', to: 'about', storyId: 'sty_about' })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('returns no statements for the root, which never has a path to vacate', () => {
    const { db, calls } = fakeDb()
    expect(redirectStatements(db, { from: '', to: '', storyId: 'sty_home' })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('accepts an absolute URL as the target without lowercasing or slash-stripping it', () => {
    const { db, calls } = fakeDb()
    redirectStatements(db, {
      from: 'old-microsite',
      to: 'https://Example.com/Path/',
      storyId: null,
    })

    expect(calls[2]?.args?.[1]).toBe('https://Example.com/Path/')
  })

  it('defaults status to 301 and source to auto', () => {
    const { db, calls } = fakeDb()
    redirectStatements(db, { from: 'a', to: 'b', storyId: 'sty_a' })
    expect(calls[2]?.args?.[2]).toBe(301)
    expect(calls[2]?.args?.[3]).toBe('auto')
  })

  it('honours an explicit status and source', () => {
    const { db, calls } = fakeDb()
    redirectStatements(db, { from: 'a', to: 'b', storyId: null, status: 302, source: 'manual' })
    expect(calls[2]?.args?.[2]).toBe(302)
    expect(calls[2]?.args?.[3]).toBe('manual')
  })
})
