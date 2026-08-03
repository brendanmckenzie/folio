import { describe, expect, it } from 'vitest'
import {
  chooseTarget,
  clipSelector,
  DEFAULT_VIEWPORT,
  MAX_DIMENSION,
  MIN_DIMENSION,
  resolveViewport,
} from '../../../src/server/mcp/shot'

/**
 * `preview_document`'s pure functions
 * (`../../../../../docs/specs/platform/mcp-server.md` decisions 5, 5a).
 *
 * **Nothing about the image is testable here** — Browser Rendering is not
 * simulated by miniflare, the position `platform/caching.md` is in with
 * Workers Cache. What *is* testable, and is the whole reason `shot.ts` splits
 * this way, is the three decisions that choose what gets photographed and how:
 * the viewport a caller gets when it says nothing, the selector a clip becomes,
 * and which URL a document's id resolves to.
 */

describe('resolveViewport', () => {
  it('defaults to 1440×900', () => {
    expect(resolveViewport()).toEqual(DEFAULT_VIEWPORT)
    expect(resolveViewport(null)).toEqual(DEFAULT_VIEWPORT)
    expect(resolveViewport({})).toEqual(DEFAULT_VIEWPORT)
  })

  it('clamps below MIN_DIMENSION up to it', () => {
    expect(resolveViewport({ width: 1, height: 1 })).toEqual({
      width: MIN_DIMENSION,
      height: MIN_DIMENSION,
    })
    expect(resolveViewport({ width: MIN_DIMENSION - 1 })).toEqual({
      width: MIN_DIMENSION,
      height: DEFAULT_VIEWPORT.height,
    })
  })

  it('clamps above MAX_DIMENSION down to it', () => {
    expect(resolveViewport({ width: 100_000, height: 100_000 })).toEqual({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
    })
    expect(resolveViewport({ height: MAX_DIMENSION + 1 })).toEqual({
      width: DEFAULT_VIEWPORT.width,
      height: MAX_DIMENSION,
    })
  })

  it('rounds a fractional dimension', () => {
    expect(resolveViewport({ width: 500.4, height: 500.6 })).toEqual({ width: 500, height: 501 })
  })

  /**
   * Not a caller error — a bad shape has an obvious right answer, the default,
   * the same reasoning `validate.ts`'s `limitParam` gives for a query-string
   * limit. `previewDocument` never validates `args.viewport` beyond "is it an
   * object", so this is the only screen a garbage value gets.
   */
  it('falls back to the default for a non-number, NaN or infinite value', () => {
    for (const bad of ['1440', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(resolveViewport({ width: bad as never })).toEqual({
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
      })
    }
  })
})

describe('clipSelector', () => {
  it('is the [data-folio-uid="…"] shape mount.tsx already relies on', () => {
    expect(clipSelector('a1b2c3d4e5f6a1b2')).toBe('[data-folio-uid="a1b2c3d4e5f6a1b2"]')
  })

  it('escapes a quote or backslash, defensively rather than for a real uid', () => {
    expect(clipSelector('a"b')).toBe('[data-folio-uid="a\\"b"]')
    expect(clipSelector('a\\b')).toBe('[data-folio-uid="a\\\\b"]')
  })
})

describe('chooseTarget', () => {
  const base = '/folio'

  it('a routed page: its own draftUrl, untouched', () => {
    const story = { draftUrl: '/guides/east-africa?_folio=draft', type: 'guideType' }
    expect(chooseTarget(base, story, 'page')).toEqual({
      kind: 'page',
      url: '/guides/east-africa?_folio=draft',
    })
  })

  /**
   * **This is the function that makes the global-preview fix real.** Without
   * `?mode=draft`, `preview_document` would photograph the editing chrome —
   * `folio-editing`, a marker div, the postMessage bridge — for every
   * singleton, which is exactly the failure the phase 4 review named.
   */
  it('a singleton with no page: the bare global preview, in draft mode', () => {
    const story = { draftUrl: null, type: 'siteSettings' }
    expect(chooseTarget(base, story, 'singleton')).toEqual({
      kind: 'global',
      url: '/folio/preview/global/siteSettings?mode=draft',
    })
    // Asserted as a literal substring too, so a refactor that drops the query
    // string cannot pass by only checking the URL's shape.
    const target = chooseTarget(base, story, 'singleton')
    expect(target.kind === 'global' && target.url.includes('?mode=draft')).toBe(true)
  })

  it('encodes the type name into the global preview path', () => {
    const story = { draftUrl: null, type: 'a type/with?chars' }
    expect(chooseTarget(base, story, 'singleton')).toEqual({
      kind: 'global',
      url: `/folio/preview/global/${encodeURIComponent('a type/with?chars')}?mode=draft`,
    })
  })

  it('a plain record with no page and no bare preview: none', () => {
    const story = { draftUrl: null, type: 'productType' }
    expect(chooseTarget(base, story, 'record')).toEqual({ kind: 'none' })
  })

  it('an unrouted document of an undeclared kind: none, not a guess', () => {
    const story = { draftUrl: null, type: 'productType' }
    expect(chooseTarget(base, story, undefined)).toEqual({ kind: 'none' })
  })

  it('prefers draftUrl over kind when both could answer', () => {
    // A routed page is never a singleton in practice, but the function itself
    // reads `draftUrl` first — stated so a future reordering is a deliberate
    // change rather than an accident.
    const story = { draftUrl: '/x?_folio=draft', type: 'siteSettings' }
    expect(chooseTarget(base, story, 'singleton')).toEqual({ kind: 'page', url: '/x?_folio=draft' })
  })
})
