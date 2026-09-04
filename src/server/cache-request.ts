/**
 * Which requests may be served from a shared cache, and under what key.
 *
 * **Why this is Folio's job rather than the host's.** Workers Caching is
 * opt-*out*: with it enabled, a 200 carrying no `Cache-Control` is stored under
 * RFC 9111 heuristic freshness for two hours. So the question "may this be
 * cached" is asked about every request, and getting it wrong once puts the
 * admin's JSON — authenticated by a *cookie*, which is not a bypass condition;
 * only `Set-Cookie` on the response is — into a cache anyone can read. The
 * knowledge needed to answer it is Folio's: which paths it owns, that
 * `{base}/asset/:key` is public while `{base}/api/assets` is not, and the names
 * of the three cookies that mean "this render may be a draft". A host
 * re-deriving that list is a host one route away from a disclosure.
 *
 * `null` for a path Folio does not own, exactly as `handle()` answers null, and
 * for the same reason: the host's routes are the host's to classify.
 *
 * Everything here is a pure function over a `Request` and a base path, which is
 * the only honest way to cover a cache miniflare does not simulate — the
 * decidable part is unit-tested and the wiring is three lines in the host.
 */
import { hasDraftCookie, readSessionCookie, shareCookieTokens } from './auth/cookie'

/**
 * Whether a request may be served from a shared cache, as far as Folio can tell.
 * `null` means "not mine to judge".
 */
export type CacheVerdict = 'cache' | 'bypass' | null

/**
 * Query parameters that identify a *click*, not a resource.
 *
 * Stripping them is not a nicety. `fbclid` and `gclid` are unique per click, so
 * left in the cache key every paid and social visitor misses the cache **and**
 * writes an entry nobody will ever read again — the cache fills with garbage and
 * the campaign traffic, which is the traffic that was paid for, is the slowest
 * on the site.
 *
 * An explicit set plus the `utm_` prefix, never a general "strip everything".
 * A query parameter is part of a URL's identity by default and some of them
 * change the response; `?page=2` is a different page and `?ref=` is a parameter
 * hosts genuinely read. Anything not named here stays in the key, which is the
 * safe direction to be wrong in: a cache miss, not a wrong answer.
 */
const CLICK_IDS = new Set([
  // Google Ads / Analytics
  'gclid',
  'gclsrc',
  'gbraid',
  'wbraid',
  'dclid',
  // Meta
  'fbclid',
  // Microsoft / Bing
  'msclkid',
  // TikTok, X, LinkedIn, Instagram, Pinterest, Yandex, Snapchat
  'ttclid',
  'twclid',
  'li_fat_id',
  'igshid',
  'epik',
  'yclid',
  'sc_cid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  // Adobe
  's_kwcid',
])

function isClickId(name: string): boolean {
  const key = name.toLowerCase()
  return key.startsWith('utm_') || CLICK_IDS.has(key)
}

/**
 * The URL this request should be cached under: the same URL with click
 * identifiers removed and the survivors sorted.
 *
 * Sorted because `?a=1&b=2` and `?b=2&a=1` are the same resource and two cache
 * entries otherwise. Fragment and credentials are already absent from a server's
 * view of a URL.
 *
 * Pass the result as `cf.cacheKey` on the loopback fetch to the cached
 * entrypoint. It cannot be applied to an inbound request: a cache hit is
 * answered *before* the Worker runs, so the eyeball's own URL is the key unless
 * a gateway re-keys it on the way through.
 */
export function cacheKeyFor(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : new URL(url.toString())
  const kept: [string, string][] = []
  for (const [name, value] of parsed.searchParams) {
    if (!isClickId(name)) kept.push([name, value])
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  parsed.search = ''
  for (const [name, value] of kept) parsed.searchParams.append(name, value)
  return parsed.toString()
}

/**
 * Folio's verdict on a request.
 *
 * The order is the design, and every `'bypass'` above the `'cache'` line is
 * there because it would otherwise be cached:
 *
 *   1. **Not a GET or HEAD.** Nothing else is cacheable, and a write reaching
 *      the cached entrypoint would be a write served from cache.
 *   2. **A WebSocket upgrade.** The sync socket is a `GET`.
 *   3. **Any Folio credential.** A draft or share cookie means this render may
 *      *be* a draft, and an editor's session means their responses can carry a
 *      bookmark `Set-Cookie`. Neither may populate or be answered from the entry
 *      the public reads. This is coarse on purpose — an editor is one of a
 *      handful of people, and the alternative is deciding per-route whether a
 *      credential mattered.
 *   4. **`?_folio=preview` / `?_folio=draft`.** Folio's own render modes, which
 *      live *outside* `basePath` and would otherwise fall through to the host's
 *      `null` branch and be judged as an ordinary page.
 *   5. **`{base}/asset/:key`** is the one Folio surface that must be cached:
 *      public by design, high volume, one indexed read and an R2 GET, and it
 *      already answers immutable cache headers. Note it is singular —
 *      `{base}/api/assets` is the admin's gated list and is caught by the next
 *      rule.
 *   6. **Anything else under `{base}`** is the admin, its JSON, its sockets and
 *      its sign-in. Never.
 */
export function cacheVerdictFor(req: Request, base: string): CacheVerdict {
  if (req.method !== 'GET' && req.method !== 'HEAD') return 'bypass'
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return 'bypass'

  const cookie = req.headers.get('cookie')
  if (
    readSessionCookie(cookie) !== null ||
    hasDraftCookie(cookie) ||
    shareCookieTokens(cookie).length > 0
  ) {
    return 'bypass'
  }

  const url = new URL(req.url)
  const mode = url.searchParams.get('_folio')
  if (mode === 'preview' || mode === 'draft') return 'bypass'

  if (url.pathname === `${base}/asset` || url.pathname.startsWith(`${base}/asset/`)) return 'cache'
  if (url.pathname === base || url.pathname.startsWith(`${base}/`)) return 'bypass'

  return null
}
