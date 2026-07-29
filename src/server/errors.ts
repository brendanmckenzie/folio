/**
 * The one shape a failed request answers with, and the only place a message
 * becomes client-visible.
 *
 * Either a route wrote the message deliberately (here, or as a schema message
 * in validate.ts) or the client never sees it: raw D1 text names tables and
 * constraints, and an internal `Error` message is written for whoever reads the
 * logs, not for whoever made the request.
 */
import { NestedError } from '../core/nested'

export type FolioErrorCode =
  | 'bad_request'
  /** No usable credential at all: absent, expired, or revoked. Never "the right
   * credential lacking permission" — that is `forbidden`, and telling the two
   * apart is what lets the admin turn exactly one of them into a sign-in
   * redirect (`identity-and-access.md`). */
  | 'unauthorized'
  /** A credential this server recognises, doing something its role or scope does
   * not cover. Retrying with the same credential can never help, so the admin
   * must not treat it as a session problem. */
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'unsupported'
  /**
   * Half of a two-store write landed (`content-api.md` architecture decision 5).
   * D1 and a Durable Object share no transaction, so creating a document is a row
   * and then a document, and the second one can fail. 502 rather than 500 because
   * nothing is wrong with the request or with this server's logic — one dependency
   * did not answer — and rather than 200 because reporting success for a document
   * whose content never arrived is how an importer silently loses a third of its
   * input. The message names the id that *was* created, so the caller can retry
   * the content alone rather than the whole create.
   */
  | 'incomplete'

/** Every status a FolioError can produce, so `c.json(body, status)` stays typed. */
export type FolioErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 501 | 502

const STATUS: Record<FolioErrorCode, FolioErrorStatus> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported: 501,
  incomplete: 502,
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
  // document-types.md: the refusals that keep a document on the routed or the
  // unrouted side of the fence it was created on. All `bad_request`: the
  // request is well-formed, it just asks for something the model does not
  // represent.
  ['An unrouted document cannot have a parent', 'bad_request' as const],
  ['Cannot create a page under an unrouted document', 'bad_request' as const],
  ['Cannot move a page under an unrouted document', 'bad_request' as const],
  ['Cannot move an unrouted document into the page tree', 'bad_request' as const],
  // `conflict`, not `bad_request`: the request is legible and the server simply
  // will not do it. Retyping a document is a schema migration
  // (schema-migrations.md), and a singleton exists because the schema says so.
  ["Cannot change a document's type", 'conflict' as const],
  ['Cannot delete a singleton document', 'conflict' as const],
  ['Cannot duplicate a singleton document', 'conflict' as const],
])

/**
 * Errors recognised by shape rather than exact text. The third element replaces
 * the message: D1's constraint text names the table and the column, which is
 * exactly the kind of internal detail that must not travel.
 */
const PATTERNS: ReadonlyArray<[RegExp, FolioErrorCode, string?]> = [
  // assets.ts computes the limit into its own message, which is worth keeping.
  [/^File is larger than /, 'too_large'],
  // document-types.md: `unsupported`, not `not_found` — the request is
  // well-formed, the server just has no such type declared.
  [/^Unknown document type: /, 'unsupported'],
  // The `under` refusal, which names the type and its allowed parents, so the
  // message itself is what travels (that is the point of a refusal notice
  // rather than a silent no-op).
  [/^A '[^']*' document is only allowed under/, 'bad_request'],
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
  // A nested payload the schema refused (`content-api.md`). Its message is
  // already written for a client and already names the path that failed
  // (`body[0].fields.headng is not a field of 'hero'`) — the whole point of the
  // refusal — so it travels verbatim. It is translated here rather than caught in
  // each route because every route that writes content already funnels through
  // `rethrow`, and a per-route catch is one a later route would forget.
  if (e instanceof NestedError) throw new FolioError('bad_request', e.message)

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
