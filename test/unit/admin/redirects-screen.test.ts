import { describe, expect, it } from 'vitest'
import {
  BLANK_DRAFT,
  createdLabel,
  deletePath,
  deleteWarning,
  draftRefusal,
  isExternal,
  isNarrowed,
  parseRedirectsUrl,
  pathLabel,
  type RedirectDraft,
  type RedirectsUrl,
  redirectsParams,
  redirectsQuery,
  showing,
  sourceHint,
  sourceLabel,
  statusLabel,
  targetLabel,
} from '../../../src/admin/ui/screens/redirects-model'

/**
 * The Redirects screen's arithmetic, in Node with nothing mounted — the admin's
 * convention, and the reason `redirects-model.ts` exists at all rather than these
 * assertions living in a browser test.
 *
 * Four things are pinned harder than the rest, because all four are wrong in ways
 * that look right:
 *
 * - **`isExternal` cannot be derived from the normalisers.** The first version asked
 *   whether `normaliseTarget` and `normalisePath` disagreed, which is false for the
 *   commonest possible input: a lowercase URL with no trailing slash survives both
 *   unchanged. An off-site target that tests as a path gets rendered as
 *   `/https://example.com/x`.
 * - **`deletePath` encodes per segment.** The route is `:from{.+}` so the slashes
 *   have to survive, and everything else has to not. `encodeURIComponent` on the
 *   whole string breaks the first half; raw interpolation — what the old admin's
 *   hook did — breaks the second.
 * - **A self-redirect is a refusal, not a row.** `from === to` loops in a browser
 *   forever, and it has to be caught after normalisation or `/Offers/` and `offers`
 *   read as two different paths.
 * - **Defaults leave the URL.** `?source=all` and the bare path are the same screen,
 *   so the query builder writes `undefined` rather than the default value.
 */

const url = (over: Partial<RedirectsUrl> = {}): RedirectsUrl => ({
  source: 'all',
  q: '',
  ...over,
})

const draft = (over: Partial<RedirectDraft> = {}): RedirectDraft => ({
  ...BLANK_DRAFT,
  ...over,
})

describe('paths', () => {
  it('roots a stored path, and the root is a bare slash', () => {
    // Stored without a leading slash, exactly like `stories.path`, and shown with
    // one — the missing slash is a storage detail nobody should have to know.
    expect(pathLabel('services/strategy')).toBe('/services/strategy')
    expect(pathLabel('')).toBe('/')
  })

  it('tells an absolute URL from a path, including the case the first version got wrong', () => {
    // The regression: no uppercase, no trailing slash, nothing for a
    // normalise-and-compare to notice.
    expect(isExternal('https://example.com/x')).toBe(true)
    expect(isExternal('HTTPS://Example.com/X/')).toBe(true)
    expect(isExternal('mailto:someone@example.com')).toBe(true)
    expect(isExternal('  https://example.com  ')).toBe(true)

    expect(isExternal('services/strategy')).toBe(false)
    expect(isExternal('/services/strategy')).toBe(false)
    // A colon only starts a scheme when everything before it is a scheme token, so
    // a slug containing one is still a path.
    expect(isExternal('page/a:b')).toBe(false)
  })

  it('shows an off-site target whole and an on-site one rooted', () => {
    // `/https://example.com/x` would be a lie about where the browser lands.
    expect(targetLabel('https://example.com/x')).toBe('https://example.com/x')
    expect(targetLabel('offers')).toBe('/offers')
  })
})

describe('source', () => {
  it('spells the column out rather than printing auto and manual', () => {
    // The old screen printed the raw value. These two words are the only thing on
    // the screen answering "is it safe to delete this", so they are words.
    expect(sourceLabel('auto')).toBe('Automatic')
    expect(sourceLabel('manual')).toBe('By hand')
  })

  it('says who wrote it, differently for each', () => {
    expect(sourceHint('auto')).toContain('Folio')
    expect(sourceHint('manual')).toContain('editor')
    expect(sourceHint('auto')).not.toBe(sourceHint('manual'))
  })

  it('warns about the right consequence for each source, naming the path', () => {
    const auto = deleteWarning({ from: 'about/history', source: 'auto' })
    const manual = deleteWarning({ from: 'summer-sale', source: 'manual' })

    // An automatic row exists because something out there still points at the old
    // path, and it comes back only if the page moves again.
    expect(auto).toContain('/about/history')
    expect(auto).toContain('moves again')
    // A hand-added one has no such story: nothing else knows about it at all.
    expect(manual).toContain('/summer-sale')
    expect(manual).toContain('nothing will recreate it')
    // Both have to say the path 404s again, which is the actual cost.
    expect(auto).toContain('404')
    expect(manual).toContain('404')
  })
})

describe('status', () => {
  it('explains each code the schema allows', () => {
    // `301` is jargon the table cannot avoid showing — it is the number on the
    // response — but it does not have to be the only thing shown.
    expect(statusLabel(301)).toBe('Permanent')
    expect(statusLabel(302)).toBe('Temporary')
    expect(statusLabel(307)).toContain('method')
    expect(statusLabel(308)).toContain('method')
  })
})

describe('the URL', () => {
  it('reads defaults out of an empty query', () => {
    expect(parseRedirectsUrl({})).toEqual({ source: 'all', q: '' })
  })

  it('refuses a source it does not recognise rather than passing it on', () => {
    // A stale link or a typo resolves to the unfiltered list; sending `source=old`
    // to the route would be a 400 for a URL somebody bookmarked.
    expect(parseRedirectsUrl({ source: 'old' }).source).toBe('all')
    expect(parseRedirectsUrl({ source: 'manual' }).source).toBe('manual')
  })

  it('writes defaults as undefined so they leave the URL', () => {
    expect(redirectsQuery(url())).toEqual({ source: undefined, q: undefined })
    expect(redirectsQuery(url({ source: 'auto', q: 'services' }))).toEqual({
      source: 'auto',
      q: 'services',
    })
  })

  it('round-trips', () => {
    const start = url({ source: 'manual', q: 'offers' })
    const written = redirectsQuery(start)
    const query: Record<string, string> = {}
    for (const [key, value] of Object.entries(written)) if (value !== undefined) query[key] = value
    expect(parseRedirectsUrl(query)).toEqual(start)
  })

  it('tells a narrowed list from an empty one', () => {
    // Different empty states: offering *clear filters* under "no redirects yet" is
    // offering to clear nothing.
    expect(isNarrowed(url())).toBe(false)
    expect(isNarrowed(url({ q: '   ' }))).toBe(false)
    expect(isNarrowed(url({ q: 'x' }))).toBe(true)
    expect(isNarrowed(url({ source: 'auto' }))).toBe(true)
  })
})

describe('the request', () => {
  it('sends only what is set, and trims the search term', () => {
    const params = redirectsParams(url(), { limit: 50 })
    expect(params.toString()).toBe('limit=50')

    const filtered = redirectsParams(url({ source: 'manual', q: '  offers  ' }), { limit: 20 })
    expect(filtered.get('source')).toBe('manual')
    expect(filtered.get('q')).toBe('offers')
  })

  it('asks for a count and resumes from a cursor when told to', () => {
    const params = redirectsParams(url(), { limit: 50, cursor: 'abc', count: true })
    expect(params.get('count')).toBe('1')
    expect(params.get('cursor')).toBe('abc')
  })

  it('omits the cursor when there is none, so page one has one identity', () => {
    // The hook keys its cursor-stack reset on this string minus the cursor, so a
    // null cursor must not serialise as `cursor=null`.
    expect(redirectsParams(url(), { limit: 50, cursor: null }).has('cursor')).toBe(false)
  })

  it('has no sort parameter at all', () => {
    // One ordering, newest first — `listRedirects` argues it. A `sort` here would be
    // a second keyset over `from_path` for a job the search box does better.
    expect(redirectsParams(url(), { limit: 50 }).has('sort')).toBe(false)
  })
})

describe('the delete path', () => {
  it('keeps the slashes and encodes everything else', () => {
    // `:from{.+}` exists so a multi-segment path arrives whole.
    expect(deletePath('services/strategy')).toBe('services/strategy')
    // And the rest still has to be escaped, or the request means a different path
    // than the row does. The old admin's hook interpolated raw.
    expect(deletePath('old page')).toBe('old%20page')
    expect(deletePath('caf%C3%A9')).toBe('caf%25C3%25A9')
    expect(deletePath('a/b c/d')).toBe('a/b%20c/d')
  })
})

describe('the create form', () => {
  it('accepts an ordinary path pair', () => {
    expect(draftRefusal(draft({ from: 'summer-sale', to: 'offers' }))).toBeNull()
    expect(draftRefusal(draft({ from: '/Summer-Sale/', to: '/offers' }))).toBeNull()
    expect(draftRefusal(draft({ from: 'summer-sale', to: 'https://example.com/x' }))).toBeNull()
  })

  it('says which field is wrong, not just that something is', () => {
    // The message goes under the control it belongs to (`Field`'s `error`), so a
    // refusal has to name one.
    expect(draftRefusal(draft())).toMatchObject({ field: 'from' })
    expect(draftRefusal(draft({ from: 'summer-sale' }))).toMatchObject({ field: 'to' })
  })

  it('refuses a `from` written as a full URL', () => {
    // `normalisePath` would store `https:/example.com/x`, which no request can ever
    // match — a dead row the route accepts today, so this check is the only thing
    // standing between a typo and one.
    const refusal = draftRefusal(draft({ from: 'https://example.com/old', to: 'offers' }))
    expect(refusal).toMatchObject({ field: 'from' })
    expect(refusal?.message).toContain('path on this site')
  })

  it('refuses the site root, which always has a page on it', () => {
    // `updateStory` will not reslug or reparent the root, so the POST route's
    // occupied-path check refuses this every time. Saying so here saves the trip.
    expect(draftRefusal(draft({ from: '/', to: 'offers' }))).toMatchObject({ field: 'from' })
  })

  it('refuses a target that cannot be a link', () => {
    // `lookupRedirect` re-checks `isSafeHref` on read and refuses the row silently
    // to the host, so without this the row is written, listed, and never fires.
    const refusal = draftRefusal(draft({ from: 'x', to: 'javascript:alert(1)' }))
    expect(refusal).toMatchObject({ field: 'to' })
  })

  it('refuses a self-redirect, after normalising both sides', () => {
    // A browser follows `a → a` until it gives up. Comparing the raw strings would
    // miss it: these are one row in D1 and two strings anywhere else.
    expect(draftRefusal(draft({ from: 'offers', to: 'offers' }))).toMatchObject({ field: 'to' })
    expect(draftRefusal(draft({ from: '/Offers/', to: 'offers' }))).toMatchObject({ field: 'to' })
    expect(draftRefusal(draft({ from: 'offers', to: '/OFFERS' }))).toMatchObject({ field: 'to' })
  })
})

describe('the footer', () => {
  it('is `n of N`, and falls back to `n shown` when no count was asked for', () => {
    // Never page numbers (`ui-architecture.md` Resolved 5). `total` is absent until
    // `?count=1` answers, so the fallback is honest rather than a zero.
    expect(showing(20, 1284)).toBe('20 of 1284 redirects')
    expect(showing(1, 1)).toBe('1 of 1 redirect')
    expect(showing(20, undefined)).toBe('20 shown')
    expect(showing(0, 0)).toBe('0 of 0 redirects')
  })
})

describe('the timestamp', () => {
  it('reads relatively, through the one formatter every other list uses', () => {
    // A redirect has one timestamp and no drafts, so `draftUpdatedAt: null` is the
    // true answer rather than a placeholder and `when` degrades to `createdAt`. The
    // alternative was a second relative-time formatter, which is how two lists end
    // up disagreeing about what "3 days ago" rounds from.
    const now = Date.UTC(2026, 6, 31, 12, 0, 0)
    expect(createdLabel({ createdAt: now - 30_000 }, now)).toBe('just now')
    expect(createdLabel({ createdAt: now - 3 * 60 * 60 * 1000 }, now)).toBe('3h ago')
    expect(createdLabel({ createdAt: now - 4 * 24 * 60 * 60 * 1000 }, now)).toBe('4d ago')
  })
})
