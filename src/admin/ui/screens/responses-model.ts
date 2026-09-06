/**
 * The Responses screen's arithmetic (`docs/specs/content-model/forms.md` phase
 * 7): what the URL says, what a cell reads, what the drawer lists, what a
 * selection means and what each confirmation asks.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node
 * test can reach it. `redirects-model.ts` and `assets-model.ts` are the pattern,
 * and this screen has more of it than either: a date filter, a column set
 * derived from a form, a selection in two shapes and three confirmations.
 *
 * **Everything here treats a stored value as text somebody else wrote.** A
 * response is the one row in Folio typed by an anonymous stranger, so nothing in
 * this file builds markup, and nothing that leaves it is anything but a string
 * React will escape. There is no `dangerouslySetInnerHTML` on this screen and no
 * reason there ever should be — the CSV's own de-fanging lives server-side, in
 * `form-responses.ts`, because the file is written there.
 */
import type { FormField } from '../../../core/forms'
import type { ResponseRow } from '../../../server/form-responses'
import type { ResponseFilter } from '../../../server/forms'
import type { Confirmation } from './content-model'

/* --------------------------------------------------------------- the URL --- */

/**
 * The screen's state, as the URL carries it.
 *
 * Dates are `YYYY-MM-DD` strings rather than epoch numbers, because the URL is
 * something a person reads and pastes to a colleague — `?from=2026-09-01` says
 * what it means and `?from=1788307200000` does not. The conversion to the
 * millisecond bounds the route wants happens in one place (`responseFilterOf`),
 * so a half-typed date in the box is never a request.
 */
export interface ResponsesUrl {
  /** Inclusive, as a calendar day. */
  from: string
  /** Inclusive, as a calendar day — the *whole* of that day (see `bounds`). */
  to: string
  q: string
}

export const BLANK_RESPONSES_URL: ResponsesUrl = { from: '', to: '', q: '' }

/** A day as `<input type="date">` emits one. Anything else is not a date and is
 *  simply not sent — a filter the server would refuse is a filter that empties a
 *  table while somebody is still typing it. */
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function parseResponsesUrl(query: Readonly<Record<string, string>>): ResponsesUrl {
  return {
    from: DAY.test(query.from ?? '') ? (query.from ?? '') : '',
    to: DAY.test(query.to ?? '') ? (query.to ?? '') : '',
    q: query.q ?? '',
  }
}

/** The inverse, as the query object `href` takes. Defaults are `undefined` so
 *  they leave the URL rather than sitting in it. */
export function responsesQuery(url: ResponsesUrl): Record<string, string | undefined> {
  return { from: url.from || undefined, to: url.to || undefined, q: url.q || undefined }
}

/** Telling "nobody has answered yet" from "nothing matches" — offering *clear
 *  filters* under the first is offering to clear nothing. */
export function isNarrowed(url: ResponsesUrl): boolean {
  return url.from !== '' || url.to !== '' || url.q.trim() !== ''
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A calendar day to the millisecond bounds the route uses.
 *
 * **UTC, and `to` is the day *after* the one typed.** The column is epoch
 * milliseconds and the route's `to` is exclusive, so "to 3 September" has to mean
 * "before 4 September 00:00" or the last day a person names is silently missing
 * from their own filter — which is the kind of wrong that looks like a bug in the
 * form rather than in the date picker.
 */
function bounds(day: string): number | undefined {
  if (!DAY.test(day)) return undefined
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(at) ? at : undefined
}

/**
 * The screen's filter as the `ResponseFilter` both the list route and a captured
 * selection use — one function, so the rows a person is looking at, the count
 * their select-all is guarded by and the set a bulk delete walks are the same
 * three clauses.
 */
export function responseFilterOf(url: ResponsesUrl): ResponseFilter {
  const from = bounds(url.from)
  const to = bounds(url.to)
  const q = url.q.trim()
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to: to + DAY_MS }),
    ...(q ? { q } : {}),
  }
}

/**
 * The request `GET {base}/api/forms/:id/responses` gets for a screen state.
 *
 * One function so the URL the screen shows and the request it makes cannot
 * disagree — `redirectsParams`' rule. `count=1` asks for two numbers at once:
 * the header's total and the age of the oldest row (decision 17).
 */
export function responsesParams(
  url: ResponsesUrl,
  opts: { limit: number; cursor?: string | null; count?: boolean },
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(opts.limit) })
  const filter = responseFilterOf(url)
  if (filter.from !== undefined) params.set('from', String(filter.from))
  if (filter.to !== undefined) params.set('to', String(filter.to))
  if (filter.q) params.set('q', filter.q)
  if (opts.count) params.set('count', '1')
  if (opts.cursor) params.set('cursor', opts.cursor)
  return params
}

/** The export's URL, carrying the same filter the table is showing (decision
 *  16). A plain link rather than a fetch: the answer is a file, the route sets
 *  `content-disposition`, and the session cookie rides along as it does for
 *  every other same-origin navigation. */
export function csvHref(apiBase: string, formId: string, url: ResponsesUrl): string {
  const params = responsesParams(url, { limit: 1 })
  params.delete('limit')
  const query = params.toString()
  return `${apiBase}/forms/${encodeURIComponent(formId)}/responses.csv${query ? `?${query}` : ''}`
}

/* ---------------------------------------------------------------- a row --- */

/**
 * The table's columns: the form's **current** questions, in the builder's order.
 *
 * Decision 16 makes this asymmetric with the export on purpose — the CSV's header
 * is the union of every key ever submitted, obtained with a full scan, and a
 * screen load is not a full scan's budget. What a person is looking at is the
 * form they have; the drawer and the export are where a retired key surfaces.
 *
 * `statement` is dropped: it renders no input and stores nothing, so a column for
 * one is a column of dashes.
 */
export function tableColumns(fields: readonly FormField[]): FormField[] {
  return fields.filter((field) => field.kind !== 'statement')
}

/** What a current field asks for and this response never answered. The same `—`
 *  the export writes, and for decision 16's reason: "this did not exist yet" and
 *  "they left it blank" are different facts. */
export const ABSENT = '—'

/**
 * One answer as text.
 *
 * A `file` question stores no answer at all — the bytes are an R2 object and the
 * metadata is the `files` column — so its cell reads the filename, which is the
 * only part of an upload a table can show.
 */
export function cellText(field: FormField, response: ResponseRow): string {
  if (field.kind === 'file') {
    return response.files.find((file) => file.field === field.name)?.filename ?? ABSENT
  }
  return answerText(response.data[field.name])
}

/** A stored value as text. `yes`/`no` for a tick box, because the question was
 *  one and `true` is a programmer's word for it. */
export function answerText(value: unknown): string {
  if (value === undefined) return ABSENT
  if (Array.isArray(value)) return value.length === 0 ? ABSENT : value.join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/**
 * When it arrived, relative and coarse for the table.
 *
 * `content-rows.ts`' `when` is not reused here and the reason is its tail: past a
 * month it renders a day and a month with **no year**, which is right for content
 * somebody edited recently and wrong for a table whose whole point is that rows
 * accumulate for years.
 */
export function submittedLabel(at: number, now: number = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** The full timestamp, for a cell's `title` and for the drawer. Local, because
 *  the person reading it is deciding whether they saw this one yesterday. */
export function submittedExact(at: number): string {
  return new Date(at).toLocaleString()
}

/**
 * How old the oldest surviving response is, in the coarsest unit that is still
 * true.
 *
 * Exists for decision 17 and for nothing else: retention here is **manual**,
 * nothing sweeps and nothing will remind anybody, so the surface that would show
 * the symptom shows it. Spec 28 says the same thing about auth events — *"a route
 * that answers 'the oldest event here is 400 days old' has said the thing no log
 * line was going to say"*.
 */
export function ageLabel(at: number, now: number = Date.now()): string {
  const days = Math.max(Math.floor((now - at) / DAY_MS), 0)
  if (days < 1) return 'less than a day'
  if (days < 60) return `${days} ${days === 1 ? 'day' : 'days'}`
  const months = Math.floor(days / 30)
  if (months < 24) return `${months} months`
  return `${Math.floor(days / 365)} years`
}

/**
 * The retention line under the table, or nothing when the form has never been
 * answered.
 *
 * Deliberately a statement of fact and not a warning tone: Folio is doing exactly
 * what it was asked to, and the point is that somebody reading this screen knows
 * how long they have been collecting for.
 */
export function retentionNote(oldest: number | null | undefined, now?: number): string | null {
  if (oldest === undefined || oldest === null) return null
  return `The oldest response here is ${ageLabel(oldest, now)} old. Folio never deletes one for you.`
}

/* --------------------------------------------------------------- drawer --- */

/**
 * One line of the detail drawer.
 *
 * `retired` is the whole reason this is a model function rather than a `map` in
 * the component: decision 7 says a two-year-old response has to stay *readable*
 * after the form has moved on, and the way it does that is by the drawer saying
 * "this field is no longer in this form" rather than showing a key nobody can
 * explain.
 */
export interface AnswerLine {
  name: string
  /** The question's label while it exists; the bare key once it does not, which
   *  is all that is left of a retired question. */
  label: string
  value: string
  retired: boolean
  /** Present for a `file` question the response actually carries — the field
   *  name the gated download route is addressed by. */
  file?: { filename: string; size: number }
}

/**
 * Every key a response holds, current questions first.
 *
 * The order is the export's: the form's questions in the builder's order, then
 * everything else sorted. A current question the response never answered is kept
 * and shown as `—`, because "they did not answer this" is an answer to the
 * question somebody opened the drawer with.
 */
export function answerLines(response: ResponseRow, fields: readonly FormField[]): AnswerLine[] {
  const lines: AnswerLine[] = []
  const declared = new Set<string>()

  for (const field of tableColumns(fields)) {
    declared.add(field.name)
    const file = response.files.find((one) => one.field === field.name)
    lines.push({
      name: field.name,
      label: field.label || field.name,
      value: cellText(field, response),
      retired: false,
      ...(file ? { file: { filename: file.filename, size: file.size } } : {}),
    })
  }

  const extras = new Set<string>()
  for (const key of Object.keys(response.data)) if (!declared.has(key)) extras.add(key)
  // A retired *file* question leaves no key in `data` at all, so the files column
  // is the only place it survives. Without this the drawer would say a response
  // holds nothing while an object with somebody's CV in it sits in the bucket.
  for (const file of response.files) if (!declared.has(file.field)) extras.add(file.field)

  for (const key of [...extras].sort()) {
    const file = response.files.find((one) => one.field === key)
    lines.push({
      name: key,
      label: key,
      value: file ? file.filename : answerText(response.data[key]),
      retired: true,
      ...(file ? { file: { filename: file.filename, size: file.size } } : {}),
    })
  }
  return lines
}

/** The gated download's URL for one question of one response. The route names
 *  the **question**, never the R2 key (decision 15). */
export function fileHref(
  apiBase: string,
  formId: string,
  responseId: string,
  field: string,
): string {
  return `${apiBase}/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(
    responseId,
  )}/file/${encodeURIComponent(field)}`
}

/** A size as a person reads one. `assets-model.ts` has the same job for the
 *  library; this is not imported from there because that one is about images and
 *  carries a whole vocabulary with it. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ------------------------------------------------------------ selection --- */

/**
 * What the bulk layer holds, in the two shapes a selection comes in
 * (`core/bulk.ts`'s `BulkSelection<ResponseFilter>`, as component state).
 *
 * `Set`s rather than arrays because every read is a membership test — one per row
 * per render — and the wire shape is built once, at post time, by
 * `selectionBody`. The captured half stores the **filter**, not the URL: a
 * select-all captures conditions at the moment it is clicked and has to survive
 * the person changing a date afterwards, which is the property the server's
 * `expected` guard checks against.
 */
export type Ticked =
  | { all: false; ids: ReadonlySet<string> }
  | { all: true; filter: ResponseFilter; expected: number; exclude: ReadonlySet<string> }

export const NOTHING: Ticked = { all: false, ids: new Set() }

export function isTicked(ticked: Ticked, id: string): boolean {
  return ticked.all ? !ticked.exclude.has(id) : ticked.ids.has(id)
}

/** How many rows the selection means. Never below zero: `exclude` can outgrow
 *  `expected` if the set shrank under somebody who kept ticking. */
export function tickCount(ticked: Ticked): number {
  return ticked.all ? Math.max(ticked.expected - ticked.exclude.size, 0) : ticked.ids.size
}

/** Ticking a row off a select-all **adds to `exclude`** rather than collapsing
 *  the selection into ids — which is what keeps "all 51,420 except these two"
 *  four small JSON fields instead of 51,418 of them. */
export function toggleTick(ticked: Ticked, id: string): Ticked {
  if (ticked.all) {
    const exclude = new Set(ticked.exclude)
    if (!exclude.delete(id)) exclude.add(id)
    return { ...ticked, exclude }
  }
  const ids = new Set(ticked.ids)
  if (!ids.delete(id)) ids.add(id)
  return { all: false, ids }
}

export function tickAllShown(ticked: Ticked, rows: readonly ResponseRow[]): Ticked {
  const on = rows.length > 0 && rows.every((row) => isTicked(ticked, row.id))
  if (ticked.all) {
    const exclude = new Set(ticked.exclude)
    for (const row of rows) {
      if (on) exclude.add(row.id)
      else exclude.delete(row.id)
    }
    return { ...ticked, exclude }
  }
  const ids = new Set(ticked.ids)
  for (const row of rows) {
    if (on) ids.delete(row.id)
    else ids.add(row.id)
  }
  return { all: false, ids }
}

/** Everything matching the filter the person is looking at, as it stood when
 *  they clicked. `expected` is the header's own `total`, which is what makes the
 *  server's guard a comparison of one number against itself. */
export function selectAll(url: ResponsesUrl, expected: number): Ticked {
  return { all: true, filter: responseFilterOf(url), expected, exclude: new Set() }
}

/** The `selection` field of the bulk body. `exclude` is omitted when empty rather
 *  than sent as `[]`: the route's two options are `v.strictObject`, so every key
 *  in the body is one it reads. */
export function selectionBody(ticked: Ticked): Record<string, unknown> {
  if (!ticked.all) return { ids: [...ticked.ids] }
  return {
    all: true,
    filter: ticked.filter,
    expected: ticked.expected,
    ...(ticked.exclude.size === 0 ? {} : { exclude: [...ticked.exclude] }),
  }
}

/**
 * What the selection bar says.
 *
 * **The invisible part of a selection is named rather than implied**, because
 * acting on more than you can see is the hazard here more than anywhere else in
 * the admin: these rows cannot be republished, restored or undone.
 */
export function selectionSummary(ticked: Ticked, rows: readonly ResponseRow[]): string {
  const count = tickCount(ticked)
  if (count === 0) return 'Nothing selected'
  const shown = rows.filter((row) => isTicked(ticked, row.id)).length
  const hidden = Math.max(count - shown, 0)
  const split = hidden === 0 ? '' : shown === 0 ? ', none shown here' : ` · ${shown} shown here`
  if (!ticked.all) return `${responses(count)} selected${split}`
  const off = ticked.exclude.size === 0 ? '' : `, except the ${ticked.exclude.size} you ticked off`
  return `All ${num(ticked.expected)} matching${off}${split}`
}

/* ------------------------------------------------------- confirmations --- */

const num = (n: number): string => n.toLocaleString('en-US')
const responses = (n: number): string => `${num(n)} ${n === 1 ? 'response' : 'responses'}`

/**
 * The question before a bulk delete, or null when there is nothing to ask about.
 *
 * **Always asked**, unlike the Content screen's, which skips the confirmation for
 * a fully visible non-delete selection. There is no non-delete action here, and
 * nothing on this screen is recoverable: a response is what one person sent once,
 * and neither a republish nor a redirect brings it back.
 */
export function deleteConfirmation(
  ticked: Ticked,
  rows: readonly ResponseRow[],
  hasFiles: boolean,
): Confirmation | null {
  const count = tickCount(ticked)
  if (count === 0) return null
  const shown = rows.filter((row) => isTicked(ticked, row.id)).length
  const hidden = Math.max(count - shown, 0)
  const invisible =
    hidden === 0
      ? ''
      : shown === 0
        ? 'None of them are shown by the current filter.'
        : `${num(hidden)} ${hidden === 1 ? 'is' : 'are'} not shown by the current filter.`
  const captured = ticked.all
    ? 'Everything matching your filters, as it stood when you chose it.'
    : ''
  const files = hasFiles ? ' Any files people attached go with them.' : ''
  return {
    title: `Delete ${responses(count)}?`,
    body: `${captured} ${invisible} This cannot be undone — a response is what one person sent once, and nothing recreates it.${files}`
      .replace(/\s+/g, ' ')
      .trim(),
    danger: true,
  }
}

/** The 409's re-confirmation. **A door, not a wall**: it carries the new count,
 *  so somebody who read "40" while three more arrived confirms once rather than
 *  investigating. */
export function deleteRefusal(refusal: { expected: number; actual: number }): Confirmation {
  const verb = refusal.actual === 1 ? 'matches' : 'match'
  return {
    title: `${responses(refusal.actual)} ${verb} now, not ${num(refusal.expected)}`,
    body: `Somebody submitted or deleted one while you were reading the number. Delete the ${num(refusal.actual)} that ${verb} now?`,
    danger: true,
  }
}

/** The affirmative button beside `deleteRefusal`'s question, so it never reads as
 *  a bare *OK*. */
export function retryLabel(refusal: { actual: number }): string {
  return `Delete ${responses(refusal.actual)}`
}

/**
 * What one or more batched deletes did, as one sentence.
 *
 * **Nothing here is atomic and the UI must not imply it is.** Each row is its own
 * write; the successes are counted and the failures named, `reportOf`'s rule for
 * documents and `runSummary`'s for the library.
 */
export function runReport(done: number, failed: readonly { title: string; message: string }[]) {
  if (failed.length === 0) return `Deleted ${responses(done)}`
  const named = failed
    .slice(0, 2)
    .map((one) => `${one.title || 'a response'} (${one.message})`)
    .join(', ')
  const rest = failed.length > 2 ? `, and ${failed.length - 2} more` : ''
  return done === 0
    ? `Could not delete ${failed.length === 1 ? 'it' : 'any of them'}: ${named}${rest}`
    : `Deleted ${num(done)}, ${failed.length} refused: ${named}${rest}`
}

/** What deleting one row destroys, for the single-response confirmation. Names
 *  the files, because they are the part somebody does not think of. */
export function deleteOneWarning(response: ResponseRow): string {
  const files = response.files.length
  const attached =
    files === 0
      ? ''
      : ` The ${files === 1 ? 'file' : `${files} files`} attached to it ${files === 1 ? 'goes' : 'go'} too.`
  return `Submitted ${submittedExact(response.createdAt)}. This cannot be undone — nothing recreates it.${attached}`
}
