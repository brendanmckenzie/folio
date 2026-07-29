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
