/**
 * The session cookie: what it is called, how it is written, and how it is read.
 *
 * Pure string work over a URL and a header value — no D1, no Request type — so
 * the name-selection rule below is testable on its own, which matters because
 * getting it wrong is the difference between "works deployed, never works
 * locally" and the reverse.
 */

/** The name on HTTPS. `__Host-` binds the cookie to this exact host, forbids a
 * `Domain` attribute and requires `Secure` + `Path=/`, so a sibling subdomain
 * cannot set or overwrite it. */
export const SECURE_COOKIE = '__Host-folio_session'

/** The name everywhere else. `http://localhost` under `wrangler dev` is not
 * HTTPS, and a `__Host-` cookie there is refused by the browser outright. */
export const PLAIN_COOKIE = 'folio_session'

/** The short-lived cookie carrying OIDC's `state`, `nonce` and PKCE verifier. */
export const SECURE_OIDC_COOKIE = '__Host-folio_oidc'
export const PLAIN_OIDC_COOKIE = 'folio_oidc'

/**
 * Draft preview links (`../../../../docs/specs/platform/draft-sharing.md`).
 *
 * **A third name, never the session's.** `readSessionCookie` looks for exactly two
 * names and this is neither, so a browser holding only this one resolves to *no
 * actor at all* — which is what makes "a share cookie is refused by every route in
 * the server" a property of the cookie's name rather than of a check somebody
 * remembered to write.
 */
export const SECURE_SHARE_COOKIE = '__Host-folio_share'
export const PLAIN_SHARE_COOKIE = 'folio_share'

/**
 * The name to *write* for this request: prefixed on HTTPS, plain otherwise. Both
 * are read on the way in (`readCookie`), so a developer moving between localhost
 * and a deployed worker is never stuck holding a cookie the server will not
 * accept.
 */
export function cookieName(url: URL | string): string {
  return isSecure(url) ? SECURE_COOKIE : PLAIN_COOKIE
}

export function oidcCookieName(url: URL | string): string {
  return isSecure(url) ? SECURE_OIDC_COOKIE : PLAIN_OIDC_COOKIE
}

export function shareCookieName(url: URL | string): string {
  return isSecure(url) ? SECURE_SHARE_COOKIE : PLAIN_SHARE_COOKIE
}

function isSecure(url: URL | string): boolean {
  return (typeof url === 'string' ? new URL(url) : url).protocol === 'https:'
}

/**
 * One cookie's value out of a `Cookie` header, or null.
 *
 * Hand-rolled rather than via a library: the header is a `; `-separated list
 * whose values are opaque to us (ours are hex), and a cookie *name* cannot
 * contain `=`, so splitting on the first one is exact.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim() || null
  }
  return null
}

/**
 * The session token this request presents, under either name.
 *
 * The prefixed name is preferred when both are present: a `__Host-` cookie can
 * only have been set by this exact host over HTTPS, so it is the more
 * trustworthy of the two whenever a stale plain one is also lying around.
 */
export function readSessionCookie(header: string | null | undefined): string | null {
  return readCookie(header, SECURE_COOKIE) ?? readCookie(header, PLAIN_COOKIE)
}

export function readOidcCookie(header: string | null | undefined): string | null {
  return readCookie(header, SECURE_OIDC_COOKIE) ?? readCookie(header, PLAIN_OIDC_COOKIE)
}

/**
 * How many preview links one browser may carry at once.
 *
 * **The cookie holds a list, and this is why.** A grant covers one document
 * (`shares.ts`), so an editor reviewing three pages sends three links — and with a
 * single-valued cookie the third click would silently unseat the first, so the
 * reviewer going back to an earlier tab and refreshing would get the ordinary
 * published page with no explanation of what changed. That is precisely the
 * "it quietly stopped working" failure this codebase refuses elsewhere, and the
 * alternative fixes it for twenty lines and one bounded `in (…)`.
 *
 * Five, not unbounded: the value rides on every request to the host, and a list
 * that grows without limit is a header somebody eventually hits a proxy limit with.
 * Newest wins on overflow (`withShareToken`), because the link just clicked is the
 * one being looked at.
 */
export const MAX_SHARE_COOKIE_TOKENS = 5

/** The separator inside the share cookie. Any non-hex byte would do — the tokens
 * are `mintSecret()`'s lowercase hex — and `.` is the one a reader recognises as
 * "a list of opaque parts". */
const SHARE_SEPARATOR = '.'

/** A minted share token, as a cookie part: exactly what `mintSecret()` produces. */
const SHARE_TOKEN = /^[0-9a-f]{64}$/

/**
 * The share tokens this request presents: screened, de-duplicated and capped.
 *
 * Screened *here* rather than at the query, and that is the point of the function
 * existing at all: everything that leaves it is 64 lowercase hex characters, so
 * nothing a client can put in a cookie ever reaches `hashToken` or a D1 bind
 * unbounded. A malformed part is dropped rather than failing the whole cookie — a
 * stale value from an older deploy must not lock a reviewer out of a link that is
 * still good.
 */
export function shareCookieTokens(header: string | null | undefined): string[] {
  const raw = readCookie(header, SECURE_SHARE_COOKIE) ?? readCookie(header, PLAIN_SHARE_COOKIE)
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(SHARE_SEPARATOR)) {
    if (!SHARE_TOKEN.test(part) || out.includes(part)) continue
    out.push(part)
    if (out.length === MAX_SHARE_COOKIE_TOKENS) break
  }
  return out
}

/**
 * The cookie value to write when `token` is added to whatever this request already
 * carried: newest first, no duplicates, capped.
 *
 * Newest first so the cap evicts the oldest link rather than the one just clicked.
 */
export function withShareToken(header: string | null | undefined, token: string): string {
  const rest = shareCookieTokens(header).filter((t) => t !== token)
  return [token, ...rest].slice(0, MAX_SHARE_COOKIE_TOKENS).join(SHARE_SEPARATOR)
}

export interface CookieOptions {
  /** Seconds. Omitted for a session cookie that should die with the browser. */
  maxAge?: number
  /** Defaults to `Lax`, which is the CSRF half of architecture decision 4. */
  sameSite?: 'Lax' | 'Strict'
}

/**
 * A `Set-Cookie` value.
 *
 * `HttpOnly` because no script has any business reading it; `SameSite=Lax`
 * because every mutating route is a JSON POST/PATCH/DELETE and Lax withholds
 * the cookie from cross-site ones of exactly that shape; `Path=/` because
 * `__Host-` requires it and because it covers a host that mounts Folio under a
 * different `basePath`. `Secure` follows the name: a `Secure` cookie on
 * `http://localhost` would simply never be stored.
 */
export function serialiseCookie(
  url: URL | string,
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite ?? 'Lax'}`]
  if (isSecure(url)) parts.push('Secure')
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`)
  return parts.join('; ')
}

/**
 * Clears the cookie under *both* names, in two `Set-Cookie` headers.
 *
 * Both, always: a browser that once held the plain name (a developer who moved
 * from localhost to a preview URL) would otherwise keep sending it after signing
 * out, and the server reads both on the way in.
 */
export function clearCookies(url: URL | string, secure: string, plain: string): string[] {
  const expire = (name: string) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  // The prefixed name must carry `Secure` or the browser ignores the deletion.
  return isSecure(url) ? [`${expire(secure)}; Secure`, expire(plain)] : [expire(plain)]
}

export function clearSessionCookies(url: URL | string): string[] {
  return clearCookies(url, SECURE_COOKIE, PLAIN_COOKIE)
}

export function clearOidcCookies(url: URL | string): string[] {
  return clearCookies(url, SECURE_OIDC_COOKIE, PLAIN_OIDC_COOKIE)
}

export function clearShareCookies(url: URL | string): string[] {
  return clearCookies(url, SECURE_SHARE_COOKIE, PLAIN_SHARE_COOKIE)
}
