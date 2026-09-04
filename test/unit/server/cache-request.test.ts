import { describe, expect, it } from 'vitest'
import { cacheKeyFor, cacheVerdictFor } from '../../../src/server/cache-request'

/**
 * The decidable half of caching (`src/server/cache-request.ts`).
 *
 * Workers Caching cannot be observed from a test — miniflare simulates no part
 * of it — so the discipline is that everything computable is a pure function
 * with tests here, and the wiring is three lines in the host. These are the two
 * functions a wrong answer from which is either a disclosure (the admin cached)
 * or a cache that never hits (a click id left in the key).
 */

const BASE = '/folio'
const req = (url: string, init?: RequestInit) => new Request(`https://example.com${url}`, init)

describe('cacheVerdictFor', () => {
  it('answers null for a path Folio does not own, so the host classifies it', () => {
    expect(cacheVerdictFor(req('/'), BASE)).toBeNull()
    expect(cacheVerdictFor(req('/experience'), BASE)).toBeNull()
    expect(cacheVerdictFor(req('/quote/abc123'), BASE)).toBeNull()
  })

  it('caches the public asset route and refuses the admin one beside it', () => {
    // Singular is the public file; plural is the admin's gated list. One letter
    // apart, and the whole difference between a CDN and a disclosure.
    expect(cacheVerdictFor(req('/folio/asset/abc123'), BASE)).toBe('cache')
    expect(cacheVerdictFor(req('/folio/api/assets'), BASE)).toBe('bypass')
    expect(cacheVerdictFor(req('/folio/api/assets/abc123'), BASE)).toBe('bypass')
  })

  it('refuses every other Folio surface', () => {
    for (const path of [
      '/folio',
      '/folio/',
      '/folio/edit',
      '/folio/login',
      '/folio/api/stories',
      '/folio/api/v1/documents',
      '/folio/mcp',
    ]) {
      expect(cacheVerdictFor(req(path), BASE), path).toBe('bypass')
    }
  })

  it('refuses anything but GET and HEAD', () => {
    expect(cacheVerdictFor(req('/folio/asset/a', { method: 'HEAD' }), BASE)).toBe('cache')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(cacheVerdictFor(req('/experience', { method }), BASE), method).toBe('bypass')
    }
  })

  it('refuses a socket upgrade, which is a GET', () => {
    expect(cacheVerdictFor(req('/folio/sync', { headers: { upgrade: 'WebSocket' } }), BASE)).toBe(
      'bypass',
    )
  })

  /**
   * The rule that keeps unpublished content off the edge, and it is coarse on
   * purpose: any Folio credential bypasses, on any path, rather than each route
   * deciding whether this particular credential mattered to it.
   */
  it('refuses a request carrying any Folio credential, on a host path too', () => {
    for (const cookie of [
      'folio_session=abc',
      '__Host-folio_session=abc',
      'folio_draft=1',
      '__Host-folio_draft=1',
      // A share token is `mintSecret()`'s 64 lowercase hex characters; a value
      // that is not one is not a credential and must not be treated as one.
      `folio_share=${'a1b2c3d4'.repeat(8)}`,
      'other=1; folio_draft=1',
    ]) {
      expect(cacheVerdictFor(req('/experience', { headers: { cookie } }), BASE), cookie).toBe(
        'bypass',
      )
    }
  })

  it('does not refuse an unrelated cookie', () => {
    expect(cacheVerdictFor(req('/experience', { headers: { cookie: 'hubspotutk=x' } }), BASE)).toBe(
      null,
    )
  })

  /** Folio's own render modes live outside `basePath` and would otherwise read as host pages. */
  it('refuses the preview and draft render modes', () => {
    expect(cacheVerdictFor(req('/experience?_folio=preview'), BASE)).toBe('bypass')
    expect(cacheVerdictFor(req('/experience?_folio=draft'), BASE)).toBe('bypass')
    // An unrecognised value is not a mode and is handed back like any other page.
    expect(cacheVerdictFor(req('/experience?_folio=nonsense'), BASE)).toBeNull()
  })

  it('respects a host that mounted Folio somewhere else', () => {
    expect(cacheVerdictFor(req('/admin/cms/asset/a'), '/admin/cms')).toBe('cache')
    expect(cacheVerdictFor(req('/admin/cms/edit'), '/admin/cms')).toBe('bypass')
    // `/folio` is an ordinary host path on a site that mounted elsewhere.
    expect(cacheVerdictFor(req('/folio/edit'), '/admin/cms')).toBeNull()
  })

  it('does not mistake a sibling path for the base', () => {
    expect(cacheVerdictFor(req('/folio-news'), BASE)).toBeNull()
    expect(cacheVerdictFor(req('/folio-news/asset/a'), BASE)).toBeNull()
  })
})

describe('cacheKeyFor', () => {
  it('strips every utm_ parameter', () => {
    expect(cacheKeyFor('https://example.com/x?utm_source=a&utm_medium=b&utm_campaign=c')).toBe(
      'https://example.com/x',
    )
  })

  /**
   * The ones that actually matter: unique per click, so left in the key they
   * guarantee a miss *and* write an entry nobody will read again.
   */
  it('strips per-click identifiers', () => {
    for (const id of ['gclid', 'fbclid', 'msclkid', 'gbraid', 'wbraid', 'ttclid', 'dclid']) {
      expect(cacheKeyFor(`https://example.com/x?${id}=Abc-123_xyz`), id).toBe(
        'https://example.com/x',
      )
    }
  })

  it('is case-insensitive about the parameter name', () => {
    expect(cacheKeyFor('https://example.com/x?UTM_Source=a&FBCLID=b')).toBe('https://example.com/x')
  })

  /**
   * The safe direction to be wrong in. A query parameter is part of a URL's
   * identity by default; `?page=2` is a different page and hosts genuinely read
   * `?ref=`. An unknown parameter costs a cache miss, never a wrong answer.
   */
  it('keeps everything it does not recognise', () => {
    expect(cacheKeyFor('https://example.com/x?page=2&ref=partner')).toBe(
      'https://example.com/x?page=2&ref=partner',
    )
  })

  it('keeps the real parameters when they travel with click ids', () => {
    expect(cacheKeyFor('https://example.com/x?utm_source=a&page=2&fbclid=b')).toBe(
      'https://example.com/x?page=2',
    )
  })

  it('sorts survivors, so one resource is one entry', () => {
    expect(cacheKeyFor('https://example.com/x?b=2&a=1')).toBe(
      cacheKeyFor('https://example.com/x?a=1&b=2'),
    )
    expect(cacheKeyFor('https://example.com/x?b=2&a=1')).toBe('https://example.com/x?a=1&b=2')
  })

  it('leaves a URL with no query alone', () => {
    expect(cacheKeyFor('https://example.com/x')).toBe('https://example.com/x')
    expect(cacheKeyFor(new URL('https://example.com/x'))).toBe('https://example.com/x')
  })

  it('keeps a repeated parameter repeated', () => {
    expect(cacheKeyFor('https://example.com/x?tag=a&tag=b')).toBe(
      'https://example.com/x?tag=a&tag=b',
    )
  })
})
