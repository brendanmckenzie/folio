/**
 * What a stranger sent, and everything that decides whether it is kept
 * (`../../docs/specs/content-model/forms.md` phase 4).
 *
 * **This is the only place in Folio an anonymous request writes a row.** Every
 * other write path is behind `requireAccess`; `{base}/f/:id` is behind nothing at
 * all, because a form on a published page has to work for somebody who has never
 * heard of this CMS and has JavaScript switched off. So the posture here is the
 * opposite of the rest of the server: nothing that arrives is trusted, every
 * string is bounded before it reaches a column, and the size of what gets stored
 * is decided by the *form* rather than by whoever posted to it.
 *
 * Four properties are load-bearing and each is silent when it breaks:
 *
 * - **A submitter cannot forge a response's metadata.** `form_id`, `version`,
 *   `created_at`, `locale`, `page` and `ip_hash` are columns this file computes;
 *   `data` holds *declared field names only*, and a declared name can never begin
 *   with `RESERVED_PREFIX` because `validateFormFields` refuses one. So there is
 *   no key a submitter can send that lands anywhere but inside `data`, and none
 *   inside `data` that Folio also reads as metadata (decision 13).
 * - **The duplicate collapse is one statement.** `insert … select … where not
 *   exists` has no read-then-write pair for two clicks to race through, which is
 *   the property `consumeChallenge` gets the same way (decision 14).
 * - **The IP is hashed with the hour it arrived in** and the raw address is never
 *   stored, so the one quasi-identifier in the table stops being computable from
 *   a visitor's address as soon as that hour passes (decision 10).
 * - **Nothing here binds a caller-sized list.** Every statement binds a fixed
 *   number of parameters — thirteen at the widest — whatever the form holds and
 *   whatever arrived. A submitted response's field count *is* caller-influenced,
 *   so `data` is one bound JSON string rather than a column per answer, and the
 *   100-parameter ceiling (`db.ts`) is never in play.
 *
 * `FolioDb`, never `D1Database` (`db.ts`): the submit route is a POST, so
 * `withBindings` opens its session `PRIMARY_FIRST` and the duplicate check reads
 * what the previous click just wrote.
 */
import type { FormField, FormFieldKind } from '../core/forms'
import { MAX_UPLOAD_BYTES, readCappedBody } from './assets'
import { hashToken } from './auth/secrets'
import type { FolioDb } from './db'
import { FolioError } from './errors'
import type { Form, FormMeta } from './forms'
import { isPrintableAnswer, MAX_ANSWER_CHARS, MAX_SUBMISSION_KEYS } from './validate'

/* ------------------------------------------------------------- the body --- */

/**
 * A submitted body, before anything has decided what it means: every value the
 * request carried for a key, in the order it carried them.
 *
 * A list per key rather than a string, because `checkboxes` is the one question
 * a browser answers with the same `name` repeated — reading only the first would
 * silently store one tick out of five.
 */
export type SubmissionBody = ReadonlyMap<string, readonly string[]>

/** Characters allowed for per answer character, since a urlencoded body inflates
 *  a byte into up to three (`%E2`), and a multipart part carries a header. */
const BYTES_PER_CHAR = 4

/** What one answer is budgeted when its question sets no `max` of its own. */
const DEFAULT_ANSWER_CHARS = 2_000

/** An option value is capped at 120 characters by `validate.ts`, so a
 *  `checkboxes` question's whole answer is bounded by how many it offers. */
const OPTION_VALUE_CHARS = 120

/** A `number` or `date` answer, generously. */
const SCALAR_ANSWER_CHARS = 64

/**
 * Bytes allowed for everything that is not an answer: Folio's own hidden inputs,
 * the honeypot, the submit button's name, whatever a password manager added, and
 * multipart's boundaries.
 */
const FIXED_BODY_ALLOWANCE = 16 * 1024

/** Characters one question's answer can occupy, for the body cap. */
function answerBudget(field: FormField): number {
  switch (field.kind) {
    case 'select':
    case 'radio':
    case 'checkboxes':
      return Math.max(1, field.options?.length ?? 1) * OPTION_VALUE_CHARS
    case 'checkbox':
    case 'number':
    case 'date':
      return SCALAR_ANSWER_CHARS
    case 'statement':
      return 0
    default:
      return Math.min(field.max ?? DEFAULT_ANSWER_CHARS, MAX_ANSWER_CHARS)
  }
}

/**
 * The byte cap this form's submissions are read under (decision 15): the sum of
 * its questions' own caps plus a fixed allowance, **not** `MAX_UPLOAD_BYTES`.
 *
 * The difference is the whole point. A contact form with three text questions
 * budgets about thirty kilobytes; passing the asset route's 20MB would let a
 * stranger stream twenty megabytes into a Worker at a form that has nowhere to
 * put a single byte of it. The cap is derived from what the editor built, so it
 * grows when a question does and never because a request said so.
 *
 * A `file` question contributes its own `maxBytes` (clamped to the upload
 * ceiling) so the cap is already right when phase 5 starts storing them; until
 * then the bytes are read and dropped, which is the correct order — refusing the
 * request would be refusing it for the wrong reason.
 */
export function capFor(form: Form): number {
  let bytes = FIXED_BODY_ALLOWANCE
  for (const field of form.fields) {
    if (field.kind === 'file') {
      bytes += Math.min(field.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES)
      continue
    }
    bytes += answerBudget(field) * BYTES_PER_CHAR
  }
  return bytes
}

function tooLarge(cap: number): FolioError {
  return new FolioError('too_large', `That submission is larger than ${cap} bytes.`)
}

/**
 * The request's bytes, under `capFor`'s ceiling and never past it.
 *
 * `content-length` is checked first so an honest oversized client is refused
 * before a byte is read, and `readCappedBody` (`assets.ts`) makes the cap real
 * for one that declared nothing — *"a declared length is only ever a claim"*.
 * Its refusal is re-worded here because its own message says "File", which is
 * the truth for an asset upload and a puzzle on a contact form.
 */
export async function readSubmissionBody(req: Request, cap: number): Promise<ArrayBuffer> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) throw tooLarge(cap)
  try {
    return await readCappedBody(req.body, cap)
  } catch (err) {
    if (err instanceof FolioError && err.code === 'too_large') throw tooLarge(cap)
    throw err
  }
}

/** Everything after the first `;`, lowercased: `multipart/form-data; boundary=…`. */
function contentTypeOf(req: Request): string {
  return (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

function tooManyKeys(): FolioError {
  return new FolioError(
    'bad_request',
    `A submission may carry ${MAX_SUBMISSION_KEYS} keys at most.`,
  )
}

/**
 * A `FormData` as a `SubmissionBody`.
 *
 * **A non-string entry is dropped, never stringified.** A `File` reaching
 * `String(value)` is the literal text `[object File]`, stored as somebody's
 * answer with no error anywhere — the same failure `enctype` on the descriptor
 * exists to prevent, arriving from the other end. Phase 5 is what reads files;
 * until then they are dropped rather than mistaken for prose.
 */
function fromFormData(data: FormData): SubmissionBody {
  const out = new Map<string, string[]>()
  for (const [key, value] of data) {
    if (typeof value !== 'string') continue
    const existing = out.get(key)
    if (existing) existing.push(value)
    else {
      if (out.size >= MAX_SUBMISSION_KEYS) throw tooManyKeys()
      out.set(key, [value])
    }
  }
  return out
}

/**
 * A parsed JSON body as a `SubmissionBody`, so one validator serves both
 * transports (decision 5).
 *
 * Scalars become their string form and an array becomes the repeated-key shape a
 * browser would have sent; anything else — an object, a null, a nested array —
 * is dropped, because there is no question on any form whose answer is one.
 */
function fromJson(raw: unknown): SubmissionBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FolioError('bad_request', 'A JSON submission must be an object.')
  }
  const out = new Map<string, string[]>()
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_SUBMISSION_KEYS) throw tooManyKeys()
    if (typeof value === 'string') out.set(key, [value])
    else if (typeof value === 'number' && Number.isFinite(value)) out.set(key, [String(value)])
    else if (typeof value === 'boolean') out.set(key, [String(value)])
    else if (Array.isArray(value))
      out.set(
        key,
        value.filter((v) => typeof v === 'string'),
      )
  }
  return out
}

/**
 * The whole of reading a submission: the bytes under the form's cap, then one of
 * the two transports.
 *
 * The body is buffered *before* it is parsed, deliberately. `Request#formData()`
 * and `Request#json()` both read to completion with no cap of their own, so
 * calling either first would put an unbounded body in a Worker's memory and only
 * then discover how big it was.
 */
export async function readSubmission(req: Request, cap: number): Promise<SubmissionBody> {
  const bytes = await readSubmissionBody(req, cap)

  if (contentTypeOf(req) === 'application/json') {
    try {
      return fromJson(JSON.parse(new TextDecoder().decode(bytes)))
    } catch (err) {
      if (err instanceof FolioError) throw err
      throw new FolioError('bad_request', 'That submission was not valid JSON.')
    }
  }

  try {
    // The **whole** header, parameters included: `multipart/form-data` carries
    // its boundary there, and handing the parser the bare media type is a body
    // that reads as empty rather than as an error.
    const type = req.headers.get('content-type') ?? 'application/x-www-form-urlencoded'
    const data = await new Response(bytes, { headers: { 'content-type': type } }).formData()
    return fromFormData(data)
  } catch (err) {
    if (err instanceof FolioError) throw err
    throw new FolioError('bad_request', 'That submission could not be read as a form.')
  }
}

/** The raw body as `verify` receives it (decision 13): first value per key, so a
 *  host reads its widget's token under whatever name the widget chose. */
export function rawBodyOf(body: SubmissionBody): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, values] of body) out[key] = values[0] ?? ''
  return out
}

/* --------------------------------------------------------- the validator --- */

/** What one answer is stored as. */
export type ResponseValue = string | number | boolean | readonly string[]

/**
 * Why one answer was refused. A token rather than a sentence: it rides in a JSON
 * body a script reads and, in the native transport, only the *names* travel at
 * all (decision 6) — so the prose a visitor sees is the host's, in the host's own
 * language, from its own markup.
 */
export type AnswerRefusal = 'required' | 'invalid' | 'too_long' | 'out_of_range'

export interface SubmissionResult {
  /** Declared questions only, keyed by field name. */
  values: Record<string, ResponseValue>
  /** Field name → why. Empty means the submission is good. */
  errors: Record<string, AnswerRefusal>
}

/** Loose on purpose: the strict test is a delivery attempt, and a form that
 *  refuses `a@b` refuses a real address somebody has. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** A calendar date as `<input type="date">` submits one. */
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** A number as a person types one. `Number('12abc')` is `NaN` and `parseInt` is
 *  `12`; neither is what the visitor meant, so the shape is screened first. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** The kinds whose answer may legitimately contain a line break. */
const MULTILINE: ReadonlySet<FormFieldKind> = new Set(['textarea'])

interface Answer {
  value?: ResponseValue
  error?: AnswerRefusal
}

/**
 * One text answer: bounded, screened, and checked against the question's own
 * `max` and `pattern`.
 *
 * The cap is the question's `max` **and** `MAX_ANSWER_CHARS`, never one of them:
 * a question with no `max` still may not carry ten thousand characters into a
 * column, and one whose `max` is larger than the backstop does not raise it.
 */
function textAnswer(field: FormField, raw: string): Answer {
  const value = MULTILINE.has(field.kind) ? raw.replace(/\r\n/g, '\n').trim() : raw.trim()
  if (value === '') return field.required ? { error: 'required' } : {}
  if (!isPrintableAnswer(value, MULTILINE.has(field.kind))) return { error: 'invalid' }

  const max = Math.min(field.max ?? MAX_ANSWER_CHARS, MAX_ANSWER_CHARS)
  // By code point, matching the cap `validate.ts` applies to everything else a
  // person types: `.length` counts a surrogate pair twice.
  if ([...value].length > max) return { error: 'too_long' }

  if (field.pattern !== undefined) {
    let re: RegExp | null = null
    // Compiled at save time by `validateFormFields`, so a throw here is
    // unreachable; a pattern that cannot compile screens nothing rather than
    // turning every submission into a 500.
    try {
      re = new RegExp(`^(?:${field.pattern})$`)
    } catch {
      re = null
    }
    if (re && !re.test(value)) return { error: 'invalid' }
  }
  return { value }
}

function optionValues(field: FormField): ReadonlySet<string> {
  return new Set((field.options ?? []).map((o) => o.value))
}

/**
 * One question against what arrived for it.
 *
 * **The switch is exhaustive**, the rule `resolveValue` sets in `core/resolve.ts`:
 * the default branch assigns to `never`, so a fourteenth field kind fails to
 * compile here rather than being silently unvalidated on a public endpoint —
 * which is the one place in this codebase where "handled by falling through" is a
 * security bug rather than a missing feature.
 */
function validateAnswer(field: FormField, raw: readonly string[]): Answer {
  const first = raw[0] ?? ''

  switch (field.kind) {
    // Neither renders an input, so neither stores an answer. A key matching one
    // is dropped exactly like any other undeclared key (decision 13); phase 5 is
    // what teaches `file` to read the bytes.
    case 'statement':
    case 'file':
      return {}

    case 'checkbox': {
      // A browser sends the key only when the box is ticked, so presence is the
      // answer and `required` on one means "must be ticked".
      const ticked = raw.length > 0 && first !== '' && first !== 'false'
      if (field.required && !ticked) return { error: 'required' }
      return { value: ticked }
    }

    case 'checkboxes': {
      const allowed = optionValues(field)
      const ticked = raw.filter((v) => v !== '')
      if (ticked.some((v) => !allowed.has(v))) return { error: 'invalid' }
      // Nothing ticked sends no key at all, so `[]` is the honest answer and
      // `required` can only mean "at least one".
      if (ticked.length === 0) return field.required ? { error: 'required' } : { value: [] }
      return { value: [...new Set(ticked)] }
    }

    case 'select':
    case 'radio': {
      if (first === '') return field.required ? { error: 'required' } : {}
      return optionValues(field).has(first) ? { value: first } : { error: 'invalid' }
    }

    case 'number': {
      const text = first.trim()
      if (text === '') return field.required ? { error: 'required' } : {}
      if (text.length > SCALAR_ANSWER_CHARS || !NUMBER.test(text)) return { error: 'invalid' }
      const value = Number(text)
      if (!Number.isFinite(value)) return { error: 'invalid' }
      if (field.min !== undefined && value < field.min) return { error: 'out_of_range' }
      if (field.max !== undefined && value > field.max) return { error: 'out_of_range' }
      return { value }
    }

    case 'date': {
      const text = first.trim()
      if (text === '') return field.required ? { error: 'required' } : {}
      if (!DATE.test(text)) return { error: 'invalid' }
      // `2026-02-31` matches the shape and is not a day. `Date.parse` of an
      // ISO date is UTC midnight, so the round trip is exact.
      const parsed = new Date(`${text}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        return { error: 'invalid' }
      }
      return { value: text }
    }

    case 'email': {
      const answer = textAnswer(field, first)
      if (answer.error || answer.value === undefined) return answer
      return EMAIL.test(String(answer.value)) ? answer : { error: 'invalid' }
    }

    case 'url': {
      const answer = textAnswer(field, first)
      if (answer.error || answer.value === undefined) return answer
      try {
        const url = new URL(String(answer.value))
        // http(s) only: a stored `javascript:` or `data:` answer is a link a
        // host's markup would happily render.
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'invalid' }
      } catch {
        return { error: 'invalid' }
      }
      return answer
    }

    // A `hidden` question stores what the markup emitted rather than the value
    // the builder typed: that is the whole of decision 13's "a host that wants to
    // pass its own value declares a hidden field for it", and it is validated,
    // bounded and exported like any other answer.
    case 'hidden':
    case 'text':
    case 'textarea':
    case 'tel':
      return textAnswer(field, first)

    default: {
      const never: never = field.kind
      throw new Error(`forms: unhandled field kind ${String(never)}`)
    }
  }
}

/**
 * Every declared question against what arrived, and nothing else
 * (decision 13).
 *
 * Pure — a field list and a body in, values and per-field refusals out — so the
 * hardest-to-reason-about half of a public write path is unit-tested in Node
 * rather than only through workerd.
 *
 * Two rules run before any question is looked at, and both are screens rather
 * than validations:
 *
 * - **Only declared names are read.** The submit button's `name`, the honeypot,
 *   whatever a password manager injected and whatever a captcha widget called
 *   its own input are all simply not asked for. A 422 on an undeclared key was
 *   rejected: it breaks the first time a `<button name="submit">` appears.
 * - **A `_`-prefixed name is Folio's** and can never be an answer. It cannot
 *   collide with a declared name either, because `validateFormFields` refuses a
 *   field slug in that namespace — so this is the second of two locks on the same
 *   door, and the one that holds if a stored row ever predates the first.
 */
export function validateSubmission(
  fields: readonly FormField[],
  body: SubmissionBody,
): SubmissionResult {
  const values: Record<string, ResponseValue> = {}
  const errors: Record<string, AnswerRefusal> = {}

  for (const field of fields) {
    if (field.name.startsWith('_')) continue
    const { value, error } = validateAnswer(field, body.get(field.name) ?? [])
    if (error) errors[field.name] = error
    else if (value !== undefined) values[field.name] = value
  }

  return { values, errors }
}

/* -------------------------------------------------------------- hashing --- */

/** The window an identical submission collapses inside (decision 14). */
export const DUPLICATE_WINDOW_MS = 60 * 1000

/** The window the per-IP-hash limit counts over, and the width of one hash
 *  bucket. `challenges.ts`'s `RATE_WINDOW_MS`, for the same reason. */
export const RATE_WINDOW_MS = 60 * 60 * 1000

export const DEFAULT_RATE_PER_HOUR = 10
export const MIN_RATE_PER_HOUR = 1
export const MAX_RATE_PER_HOUR = 100

/** What `body_hash` covers for one uploaded file. `contentHash` is the bytes,
 *  which is what lets the duplicate check run *before* the R2 put (decision 14). */
export interface FilePart {
  field: string
  size: number
  contentHash: string
}

/**
 * The fingerprint the sixty-second duplicate collapse compares.
 *
 * Canonical by construction: keys sorted, values in their stored form, files by
 * field name — so two identical submissions hash identically however the browser
 * happened to order the parts, and a genuine second submission a minute later
 * does not.
 *
 * `hashToken` (`auth/secrets.ts`) is the codebase's one SHA-256-to-hex, and this
 * is not a secret in the sense that file's header means — it hashes a body, not a
 * credential — but a third implementation of the same digest is worth less than
 * the slightly odd import.
 */
export function bodyHash(
  values: Record<string, ResponseValue>,
  files: readonly FilePart[] = [],
): Promise<string> {
  const answers = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]])
  const parts = [...files]
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map((f) => [f.field, f.size, f.contentHash])
  return hashToken(JSON.stringify([answers, parts]))
}

/**
 * The visitor's address, as Cloudflare's own edge reports it.
 *
 * **`CF-Connecting-IP` and nothing else.** The edge sets it on every request and
 * overwrites whatever the client sent, which is what makes it worth hashing;
 * `X-Forwarded-For` is a header a submitter writes, so limiting on it would be
 * limiting a value the limited party chooses. Absent is a local `wrangler dev` or
 * a direct hit, and the honest answer there is "no address", not a shared bucket
 * everybody lands in.
 */
export function clientIp(req: Request): string | null {
  const raw = req.headers.get('cf-connecting-ip')
  if (!raw) return null
  const ip = raw.trim()
  // A bound rather than a format check: this is hashed, never parsed or
  // compared, so the only thing that matters is that it cannot be enormous.
  return ip.length > 0 && ip.length <= 64 ? ip : null
}

/**
 * `sha256(ip : form_id : hour)` (decision 10). The raw address is never stored
 * and never leaves this function.
 *
 * The form id makes the same visitor unlinkable across two forms on one site.
 * The hour bucket is what makes the value expire without a sweep: once that hour
 * has passed nobody holding the database can compute it from an address again,
 * because the preimage nobody would think to try is the one that is gone.
 */
export function ipHash(ip: string, formId: string, at: number): Promise<string> {
  return hashToken(`${ip}:${formId}:${Math.floor(at / RATE_WINDOW_MS)}`)
}

/**
 * The current bucket's hash and the previous one's (decision 10).
 *
 * Both, because a single bucket is not a rate limit: ten submissions at 10:58
 * and an eleventh at 11:01 are eleven in three minutes and two different hashes.
 * Counting either against a rolling hour makes the window true at the cost of one
 * extra bind. The first is the hash the new row is stored under.
 */
export function throttleHashes(ip: string, formId: string, now: number): Promise<[string, string]> {
  return Promise.all([
    ipHash(ip, formId, now),
    ipHash(ip, formId, now - RATE_WINDOW_MS),
  ]) as Promise<[string, string]>
}

/**
 * How many responses either bucket has collected in the last hour.
 *
 * Three binds, never a caller-sized list, and served by `form_responses_throttle`
 * — the partial index, which holds only the rows with an address behind them.
 * Like `recentChallengeCount`, this is a *partial* answer and says so: it bounds
 * a script, not a botnet.
 */
export async function recentSubmissionCount(
  db: FolioDb,
  hashes: readonly [string, string],
  now: number = Date.now(),
): Promise<number> {
  const row = await db
    .prepare('select count(*) as n from form_responses where ip_hash in (?, ?) and created_at > ?')
    .bind(hashes[0], hashes[1], now - RATE_WINDOW_MS)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/* --------------------------------------------------------------- writing --- */

/** One uploaded file, as the `submitted` hook receives it and as the `files`
 *  column stores it. Empty until phase 5 mints a `sub_` key. */
export interface SubmittedFile {
  field: string
  /** The R2 key, under the `sub_` prefix the public asset route cannot serve. */
  key: string
  filename: string
  size: number
  contentType: string
}

/**
 * A stored response, as the `submitted` hook receives it.
 *
 * **A projection, not the row.** `ip_hash` and `body_hash` are deliberately
 * absent: the first is the one quasi-identifier in the table and the second is a
 * fingerprint of the answers, and neither is anything a notification, a CRM push
 * or a Slack message has a use for. A host that genuinely needs them holds the
 * `db` binding. This is `presenceOf`'s posture toward a socket attachment,
 * applied to a payload that leaves the process.
 */
export interface FormResponse {
  id: string
  formId: string
  version: number
  createdAt: number
  data: Record<string, ResponseValue>
  locale: string
  page: string
}

export interface NewResponse {
  form: Form
  data: Record<string, ResponseValue>
  locale: string
  page: string
  /** Null when the request carried no client IP. The row then sits outside the
   *  partial index and no rate limit can ever match it. */
  ipHash: string | null
  bodyHash: string
  files: readonly SubmittedFile[]
  now?: number
}

export interface InsertedResponse {
  response: FormResponse
  /**
   * False when an identical body arrived inside the last minute and this one
   * collapsed into it.
   *
   * The caller still answers success — from the visitor's side it worked — but
   * **must not fire `submitted`**: one row that reached a CRM twice because
   * somebody double-clicked is exactly the outcome the collapse exists to
   * prevent.
   */
  stored: boolean
}

/**
 * `res_<12 hex>`, the convention every other minted id follows.
 *
 * Exported because the submit route mints one for a submission it is **not**
 * going to store: a caught honeypot has to answer with an id that looks exactly
 * like a real one, or the answer itself tells whoever wrote the bot which field
 * to leave alone next time.
 */
export function newResponseId(): string {
  return `res_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * One response, or the discovery that it was a duplicate — **in one statement**
 * (decision 14).
 *
 * `insert … select … where not exists` is what makes a double-click safe without
 * a lock: there is no read-then-write pair for the second click to fit through,
 * and `changes = 0` is the answer rather than a row that was inserted and then
 * regretted. `consumeChallenge` gets its single-use property the same way.
 *
 * `version` is read off the form the server just loaded, never off anything the
 * page claimed: a page cached for a week submits against the live form, and the
 * stored stamp has to say which shape actually validated it (decision 7).
 *
 * Thirteen binds, fixed. Nothing here is sized by the submitter.
 */
export async function insertResponse(db: FolioDb, input: NewResponse): Promise<InsertedResponse> {
  const now = input.now ?? Date.now()
  const response: FormResponse = {
    id: newResponseId(),
    formId: input.form.id,
    version: input.form.version,
    createdAt: now,
    data: input.data,
    locale: input.locale,
    page: input.page,
  }

  const result = await db
    .prepare(
      `insert into form_responses
         (id, form_id, version, created_at, data, locale, page, ip_hash, body_hash, files)
       select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       where not exists (
         select 1 from form_responses
         where form_id = ? and body_hash = ? and created_at > ?
       )`,
    )
    .bind(
      response.id,
      response.formId,
      response.version,
      response.createdAt,
      JSON.stringify(response.data),
      response.locale,
      response.page,
      input.ipHash,
      input.bodyHash,
      JSON.stringify(input.files),
      response.formId,
      input.bodyHash,
      now - DUPLICATE_WINDOW_MS,
    )
    .run()

  return { response, stored: (result.meta.changes ?? 0) > 0 }
}

/* ------------------------------------------------- the host's own half --- */

/**
 * What a host may configure about submissions (`FolioConfig.forms`).
 *
 * Two keys, and between them the two anti-spam controls Folio cannot decide for
 * itself. The third — the honeypot — is always on and needs no configuration at
 * all, which is why it is not here.
 *
 * Absent is a complete answer: the honeypot still runs, the default rate limit
 * still applies, and nothing verifies. That is what "this site does not verify"
 * looks like, the same shape `gate` and `describe` take toward their features.
 */
export interface FolioForms<Env> {
  /**
   * Human verification — a host function, not a vendor name and a key
   * (decision 9).
   *
   * Turnstile and hCaptcha both mint their token **client-side at submit time**,
   * which makes them the one mechanism a week-old cached page cannot invalidate;
   * a signed nonce with a minimum fill time cannot work here at all, because
   * every visitor to a cached page holds the same token issued at the same
   * moment. So Folio holds no key, calls no third party, keeps no vendor list and
   * has no timeout policy for anybody to disagree with.
   *
   * Receives the **raw** body, before undeclared keys are dropped, because the
   * token's name belongs to the host's widget and Folio does not know it
   * (decision 13).
   *
   * **Fails closed, including on a throw** (decision 11). This is the opposite
   * posture to the hooks it sits beside, and the difference is the point: a hook
   * runs after a write has committed and its failure must never undo one, while
   * this runs before and its whole job is to refuse traffic nobody can vouch for.
   * A captcha that opens on error is decorative — making it error is the first
   * thing an attacker tries.
   *
   * **Declared as a method rather than a property-typed arrow**, for
   * `FolioGate`'s stated reason: only method parameters are bivariant under
   * `strictFunctionTypes`, and without that a host's `FolioForms<Env>` would not
   * be assignable to the `FolioForms<unknown>` the runtime widens it to.
   */
  verify?(
    input: { req: Request; body: Readonly<Record<string, string>>; form: FormMeta },
    env: Env,
  ): boolean | Promise<boolean>
  /**
   * Submissions per IP-hash per hour. Default 10, valid 1–100, and **0 disables
   * it entirely**.
   *
   * Ten rather than three because the limit is per *address*, and a shared NAT
   * puts a whole office behind one (decision 9's edge case). Like
   * `recentChallengeCount`, it is a partial answer and says so: it bounds a
   * script, not a botnet.
   */
  ratePerHour?: number
}

/** `FolioConfig.forms`, validated and defaulted. */
export interface ResolvedForms {
  config: FolioForms<unknown>
  /** `config.ratePerHour`, defaulted. `0` means no limit is applied. */
  ratePerHour: number
}

const FORMS_KEYS = ['verify', 'ratePerHour']

/**
 * Construction-time validation, alongside `validateGate`, `validateDescribe` and
 * `validateHooks` and for their reason: a configuration mistake in a CMS should
 * throw once, before a request is served.
 *
 * The stakes are a rung higher here than for the others. The request that would
 * otherwise discover a broken `verify` is an anonymous POST from the public
 * internet — so a `verify` that is not a function would fail closed on every
 * submission the site ever received, and the symptom is a contact form that
 * silently collects nothing while the admin shows no error at all.
 *
 * Unknown keys are refused, the treatment `hooks` and `describe` both get:
 * `verifiy` or `ratePerHourly` would otherwise be a silently ignored preference,
 * and one of those two silences is "this site is not verifying anybody".
 */
export function validateForms<Env>(forms: FolioForms<Env> | undefined): ResolvedForms | null {
  if (!forms) return null

  for (const key of Object.keys(forms)) {
    if (!FORMS_KEYS.includes(key)) {
      throw new Error(`folio: unknown \`forms\` key "${key}" (valid: ${FORMS_KEYS.join(', ')})`)
    }
  }
  if (forms.verify !== undefined && typeof forms.verify !== 'function') {
    throw new Error('folio: `forms.verify` must be a function — the host decides who is human')
  }

  const ratePerHour = forms.ratePerHour ?? DEFAULT_RATE_PER_HOUR
  const inRange =
    ratePerHour === 0 || (ratePerHour >= MIN_RATE_PER_HOUR && ratePerHour <= MAX_RATE_PER_HOUR)
  if (!Number.isInteger(ratePerHour) || !inRange) {
    throw new Error(
      `folio: \`forms.ratePerHour\` is ${JSON.stringify(forms.ratePerHour)}; it must be 0 (no limit) or a whole number from ${MIN_RATE_PER_HOUR} to ${MAX_RATE_PER_HOUR}`,
    )
  }

  return { config: forms as FolioForms<unknown>, ratePerHour }
}
