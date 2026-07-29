/**
 * Signing an e2e script in, the way a browser does.
 *
 * The demo configures a real sign-in provider (`magicLink`), so every script that
 * touches the API needs a session — which means completing the flow a person
 * completes with their inbox. The demo's `send` logs the link and stashes it at
 * `/dev/last-signin` (localhost only), so that is the "mailbox" here.
 *
 * `signIn` returns the cookie header. `signInGlobally` goes further and wraps the
 * process's own `fetch` and `WebSocket` so both carry it, which is deliberate:
 * a browser attaches a cookie ambiently to every request and every upgrade, and
 * threading a header through ~80 call sites across six scripts would model that
 * worse *and* read worse. Nothing else in these scripts changes as a result.
 */

const DEFAULT_BASE = 'http://localhost:5199'

/** The admin seeded by examples/demo/seed.sql. */
export const DEMO_ADMIN = 'demo@example.com'
export const DEMO_EDITOR = 'editor@example.com'
export const DEMO_VIEWER = 'viewer@example.com'

/** The session cookie out of a `Set-Cookie` list, under either name. */
export function sessionCookieFrom(res) {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]
  for (const value of values) {
    const match = /(^|[;,]\s*)(__Host-folio_session|folio_session)=([^;]+)/.exec(value ?? '')
    if (match) return `${match[2]}=${match[3]}`
  }
  return null
}

/**
 * Requests a sign-in link, reads it out of the demo's dev outbox, and consumes
 * it. Returns the `cookie` header value to send from then on.
 *
 * Uses the raw `fetch` on purpose — it runs before `signInGlobally` has wrapped
 * anything, and a wrapped fetch would send a cookie it does not yet have.
 */
export async function signIn(base = DEFAULT_BASE, email = DEMO_ADMIN, doFetch = fetch) {
  const asked = await doFetch(`${base}/folio/login/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!asked.ok) throw new Error(`sign-in request failed: ${asked.status}`)

  const outbox = await doFetch(`${base}/dev/last-signin`)
  const { url } = await outbox.json()
  if (!url) {
    throw new Error(
      'no sign-in link was captured — is examples/demo configured with magicLink, and is the seed applied?',
    )
  }

  // `redirect: 'manual'` so the 302 (and its Set-Cookie) is what comes back,
  // rather than whatever the editor answers after the redirect.
  const verified = await doFetch(url, { redirect: 'manual' })
  const cookie = sessionCookieFrom(verified)
  if (!cookie) throw new Error(`sign-in set no session cookie (status ${verified.status})`)
  return cookie
}

/**
 * `signIn`, then makes every later `fetch` and `WebSocket` in this process carry
 * the cookie unless the caller set one itself.
 *
 * The `WebSocket` wrapper is what makes the sync scripts work at all: the socket
 * route is gated like every other, and Node's global WebSocket takes headers
 * through its (non-standard) options argument.
 */
export async function signInGlobally(base = DEFAULT_BASE, email = DEMO_ADMIN) {
  const realFetch = globalThis.fetch
  const cookie = await signIn(base, email, realFetch)

  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has('cookie')) headers.set('cookie', cookie)
    return realFetch(input, { ...init, headers })
  }

  const RealWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url, options) {
      super(url, { ...(options ?? {}), headers: { cookie, ...(options?.headers ?? {}) } })
    }
  }

  return { cookie, realFetch, RealWebSocket }
}
