/**
 * The one shape a failed request answers with, and the only place a message
 * becomes client-visible.
 *
 * Either a route wrote the message deliberately (here, or as a schema message
 * in validate.ts) or the client never sees it: raw D1 text names tables and
 * constraints, and an internal `Error` message is written for whoever reads the
 * logs, not for whoever made the request.
 */

export type FolioErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'too_large' | 'unsupported'

/** Every status a FolioError can produce, so `c.json(body, status)` stays typed. */
export type FolioErrorStatus = 400 | 404 | 409 | 413 | 501

const STATUS: Record<FolioErrorCode, FolioErrorStatus> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported: 501,
}

export class FolioError extends Error {
  readonly code: FolioErrorCode
  readonly status: FolioErrorStatus

  constructor(code: FolioErrorCode, message: string) {
    super(message)
    this.name = 'FolioError'
    this.code = code
    this.status = STATUS[code]
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string }
}

export function envelope(err: FolioError): ErrorEnvelope {
  return { error: { code: err.code, message: err.message } }
}

/**
 * The envelope for anything that was not a FolioError, and deliberately says
 * nothing: an unrecognised throw is a bug or a platform failure, so its message
 * belongs in the log line and nowhere else. `internal` is not a FolioErrorCode
 * for the same reason — no route can choose to answer with it.
 */
export const INTERNAL: ErrorEnvelope = {
  error: { code: 'internal', message: 'Something went wrong.' },
}

/**
 * Messages thrown by stories.ts / versions.ts / the business-logic half of
 * assets.ts (`uploadAsset`'s "Empty upload" and its own post-buffer size
 * check) that a client can act on, mapped to a code. Those stay plain-`Error`
 * throwers on purpose (rewriting them is the next phase's work), so the
 * translation lives at the route boundary rather than inside them.
 * `readCappedBody`'s cap, being input validation rather than business logic,
 * throws `FolioError` directly instead, the same as validate.ts.
 */
const EXACT: ReadonlyMap<string, FolioErrorCode> = new Map([
  ['Unknown parent', 'bad_request' as const],
  ['Unknown story', 'not_found' as const],
  ['Cannot move a story into its own subtree', 'bad_request' as const],
  ['Cannot delete the root story', 'conflict' as const],
  ['Empty upload', 'bad_request' as const],
])

/**
 * Errors recognised by shape rather than exact text. The third element replaces
 * the message: D1's constraint text names the table and the column, which is
 * exactly the kind of internal detail that must not travel.
 */
const PATTERNS: ReadonlyArray<[RegExp, FolioErrorCode, string?]> = [
  // assets.ts computes the limit into its own message, which is worth keeping.
  [/^File is larger than /, 'too_large'],
  [
    /UNIQUE constraint failed/i,
    'conflict',
    'Another story already occupies that path. Rename it or pick a different parent.',
  ],
]

/** `message` of `e` and of its `cause` chain: D1 puts the useful text in either. */
function messagesOf(e: unknown, depth = 3): string[] {
  if (depth === 0 || !(e instanceof Error)) return []
  return [e.message, ...messagesOf(e.cause, depth - 1)]
}

/**
 * Re-throws what a stories/versions/assets helper threw: as a FolioError when
 * the failure is one a client can be told about, unchanged otherwise so
 * `app.onError` logs it and answers with INTERNAL. Never returns — a route's
 * catch block is `catch (e) { rethrow(e) }`.
 */
export function rethrow(e: unknown): never {
  if (e instanceof FolioError) throw e

  const messages = messagesOf(e)
  for (const message of messages) {
    const exact = EXACT.get(message)
    if (exact) throw new FolioError(exact, message)
  }
  for (const [pattern, code, override] of PATTERNS) {
    const hit = messages.find((message) => pattern.test(message))
    if (hit !== undefined) throw new FolioError(code, override ?? hit)
  }

  throw e
}
