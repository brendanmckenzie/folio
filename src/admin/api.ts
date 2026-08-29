/**
 * The admin's side of the one error envelope.
 *
 * Every Folio failure answers `{ error: { code, message } }` (see
 * server/errors.ts), and that message is the only one written for a human. So
 * there is exactly one place that reads it, and every mutating call in the admin
 * goes through `expectOk` — a call that ignores `res.ok` leaves the UI showing
 * state the server refused, which is worse than an error.
 *
 * The rule is about *mutations*. A read taken after a mutation has already landed
 * is the other half of it (`afterWrite`): its failure is not the write's, and
 * reporting it as one contradicts the success the user has just been shown.
 */

/**
 * What to do about a 401, registered once at boot by `main.tsx`.
 *
 * A callback rather than a `window.location.assign` inline, for two reasons: this
 * module is imported by tests that run in Node with no `window`, and a *session*
 * failure is the one failure that must not become a toast — so there has to be
 * exactly one place that decides it is a navigation instead, and it has to be
 * observable from a test (`identity-and-access.md` phase 4, step 1).
 *
 * Null on an `auth: 'open'` deployment, where a 401 cannot happen.
 */
let unauthorizedHandler: ((next: string) => void) | null = null

export function onUnauthorized(handler: ((next: string) => void) | null): void {
  unauthorizedHandler = handler
}

/**
 * Where a 401 sends the browser. Pure, so the query-string shape is testable
 * without a `window`: the login page brings you back to the page you were on
 * rather than dumping you at the root of the CMS.
 */
export function signInUrl(loginUrl: string, next: string): string {
  return `${loginUrl}?next=${encodeURIComponent(next)}`
}

/**
 * The message a failed response carries. `fallback` covers the case where the
 * body is not the envelope at all — a proxy's own 502 page, or a request that
 * died before reaching the worker — because there is no message to quote then.
 */
export async function failureOf(res: Response, fallback?: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
  return body.error?.message ?? fallback ?? `Request failed (${res.status})`
}

/**
 * Passes a successful response through and throws the envelope's message
 * otherwise, so callers can wrap a whole sequence in one try/catch and show
 * `(e as Error).message` verbatim.
 *
 * A 401 is the one status that does not simply become a message. Every mutating
 * call in the admin comes through here, so this is the single place that can turn
 * "your session ended" into a sign-in navigation rather than a toast telling you
 * to sign in with no way to. It still throws afterwards: the caller's own state
 * (a busy flag, an optimistic row) has to unwind either way, and the navigation
 * is not instantaneous.
 *
 * 403 deliberately *is* just a message. Signing in again cannot change the answer
 * to a permissions refusal, and redirecting there would be a loop.
 */
export async function expectOk(res: Response, fallback?: string): Promise<Response> {
  if (res.ok) return res
  const message = await failureOf(res, fallback)
  if (res.status === 401) unauthorizedHandler?.(message)
  throw new Error(message)
}

/** `expectOk` plus the parsed body, for the calls whose answer is used. */
export async function expectJson<T>(res: Response, fallback?: string): Promise<T> {
  return (await expectOk(res, fallback)).json() as Promise<T>
}

/**
 * A refresh that follows a mutation the server has already accepted, with its
 * failure deliberately dropped.
 *
 * The two must not share a catch. Publishing, checkpointing and restoring all
 * re-read something afterwards — the tree's draft badge, the version list — and
 * a rejection from that read inside the operation's own try reports a completed
 * write as a failure: an error toast beside the green "Published" flash, or a
 * restore that has already synced telling you it did not. A stale list until the
 * next refresh is the smaller lie, and the operation's success notice survives.
 */
export function afterWrite(refresh: Promise<unknown>): Promise<void> {
  return refresh.then(
    () => {},
    () => {},
  )
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const

/** A JSON-bodied request. Its answer still has to go through `expectOk`. */
export function send(url: string, method: 'POST' | 'PATCH', body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  })
}
