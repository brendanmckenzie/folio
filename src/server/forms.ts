/**
 * The `forms` table: an editor's questions, stored as a row rather than a
 * document (`../../docs/specs/content-model/forms.md` architecture decision 1).
 *
 * A form is closer to a redirect or a schedule than to a page — a bespoke table
 * with a bespoke screen — so none of `stories`' machinery applies here. Four
 * things that come free with a document do not come free with this, and each has
 * a replacement in this file rather than a gap:
 *
 * - **Draft versus live.** There is none: a save is live at once (decision 7).
 * - **Version history.** `forms.version`, bumped only when `shapeOf` changes and
 *   stamped on every response, so a two-year-old response stays readable after
 *   the form has moved on.
 * - **Concurrent editing.** `updateForm` takes an `expectedUpdatedAt` and the
 *   guard is in the `update`'s own `where`, so two editors cannot both win
 *   (decision 18). It is weaker than the document editor's merge, deliberately,
 *   and this is where the whole of that story lives.
 * - **Per-field translation.** `FormField.i18n`, one level below `Blok.i18n`.
 *
 * **`FolioDb`, never `D1Database`** (`db.ts`): every read here runs on whatever
 * session the caller threaded in, and taking the wider type is how a query
 * silently goes back to the primary.
 *
 * **Two readers bind a caller-sized list and both chunk** — `formsByIds` (the
 * resolve read, one id per form a document embeds) and `countResponsesByForm`
 * (one id per row of a list page, up to 200). D1 binds at most 100 parameters
 * per statement, which is the ceiling and not a soft limit, so `bindChunks`
 * sizes both rather than a comment promising nobody will pass more than ninety.
 */
import {
  FILE_ACCEPT,
  type FormField,
  type FormFieldOption,
  formSlug,
  honeypotName,
  type ResolvedForm,
  type ResolvedFormField,
  shapeOf,
  validateFormFields,
} from '../core/forms'
import type { LocaleContext } from '../core/locales'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import type { StoryMeta } from '../core/story'
import { MAX_UPLOAD_BYTES } from './assets'
import { bindChunks, type FolioDb } from './db'
import { FolioError } from './errors'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'
import { storiesFor } from './stories'
import type { FolioLogger } from './types'

/** A form as the builder reads it: the row, with its questions parsed. */
export interface Form {
  /** `frm_<12 hex>`. Immutable — the action URL in published HTML names it, so
   *  renaming a form must never touch it (decision 3). */
  id: string
  /** Slug, unique across the site. The admin's handle, and what rides back on a
   *  redirect as `folio_form=<name>`. Never part of an action URL. */
  name: string
  label: string
  fields: FormField[]
  version: number
  /** The editor's switch. The *effective* state is this and the clock together —
   *  see `isOpen`, which is the one place the two are combined. */
  open: boolean
  closesAt: number | null
  closedMessage: string
  successMessage: string
  submitLabel: string
  redirectTo: string | null
  createdAt: number
  /** The optimistic-concurrency token a PATCH carries back (decision 18). */
  updatedAt: number
}

/**
 * A form's identity without its questions: what a hook payload carries, and
 * what the list screen shows.
 *
 * `questions` is a count rather than the array. A list page is up to 200 rows
 * and a form's `fields` is the widest column in this schema; the builder reads
 * one form and gets the array, the list reads two hundred and does not need it.
 */
export interface FormSummary {
  id: string
  name: string
  label: string
  version: number
  open: boolean
  closesAt: number | null
  createdAt: number
  updatedAt: number
  questions: number
  /** Only under `?counts=1`: how many responses this form has collected. */
  responses?: number
}

/** What a hook payload names a form by (`hooks.ts`'s `formChanged`). */
export interface FormMeta {
  id: string
  name: string
  label: string
  version: number
}

export function formMeta(form: Form | FormSummary): FormMeta {
  return { id: form.id, name: form.name, label: form.label, version: form.version }
}

/**
 * How many bytes one `file` question will actually accept
 * (`../../docs/specs/content-model/forms.md` decision 15: *"a `maxBytes`
 * clamped to `MAX_UPLOAD_BYTES`"*).
 *
 * **The clamp is here rather than in `validateFormFields`** because
 * `MAX_UPLOAD_BYTES` is the media library's ceiling and `core/forms.ts` knows
 * nothing about R2. Storing the editor's number unclamped and clamping on every
 * read is the same posture `parseScopes` takes: lowering the platform ceiling
 * narrows every stored form at once instead of leaving rows that claim more than
 * the server will take.
 *
 * Three readers and they must not disagree: `capFor` sums it into the body cap,
 * `prepareUploads` enforces it per file, and `compileField` puts it on the
 * descriptor so a host's own `maxBytes` attribute says what the server will do.
 */
export function fileCap(field: FormField): number {
  return Math.min(field.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES)
}

/** Whether this form needs the `media` binding at all (decision 15). */
export function hasFileQuestion(fields: readonly FormField[]): boolean {
  return fields.some((f) => f.kind === 'file')
}

/**
 * The effective open state: the switch **and** the clock, never one of them
 * (decision 14). There is deliberately no stored "closed" column for a cron to
 * flip and for the clock to then disagree with — `0004_shares.sql`'s live/lapsed
 * rule, applied to a second table.
 */
export function isOpen(form: Form, now: number = Date.now()): boolean {
  return form.open && (form.closesAt === null || form.closesAt > now)
}

/** `frm_<12 hex>`, minted exactly the way `uploadAsset` mints an asset id. */
function newFormId(): string {
  return `frm_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const COLS = `id, name, label, fields, version, open, closes_at as closesAt,
  closed_message as closedMessage, success_message as successMessage,
  submit_label as submitLabel, redirect_to as redirectTo,
  created_at as createdAt, updated_at as updatedAt`

const SUMMARY_COLS = `id, name, label, version, open, closes_at as closesAt,
  created_at as createdAt, updated_at as updatedAt,
  json_array_length(fields) as questions`

interface FormRow extends Omit<Form, 'fields' | 'open'> {
  fields: string
  open: number
}

interface SummaryRow extends Omit<FormSummary, 'open' | 'responses'> {
  open: number
}

/**
 * The stored `fields` column, parsed and screened.
 *
 * `validateFormFields` is the one validator (decision 2) and it is called here
 * on the way *out* as well as on the way in, which is what makes "a kind this
 * build does not know is dropped" true of stored rows rather than only of
 * writes.
 *
 * A column this cannot read at all answers no questions and logs one line,
 * rather than throwing. The throw would be more honest about the row and much
 * worse in effect: it would take out the *list* of every form, and the screen an
 * editor would use to find and fix the broken one. It cannot arise from a write
 * through this file — every write validates first — so this is the shape
 * `redirectOf` uses for a row an older build or a hand-run script left behind.
 */
function readFields(id: string, raw: string, logger: FolioLogger = console): FormField[] {
  try {
    return validateFormFields(JSON.parse(raw))
  } catch (err) {
    logger.error(`folio: form ${id} has unreadable fields`, err)
    return []
  }
}

/**
 * `validateFormFields` on the way *in*, with its refusal turned into the one
 * error envelope.
 *
 * The core validator throws a plain `Error` because it knows nothing about HTTP
 * — it is called by the admin builder and by the submit route's compiler as well
 * as by a PATCH — and an untranslated throw is a 500 for what is squarely the
 * client's mistake. Its messages are already written for whoever made it (they
 * name the field and what is wrong with it), which is why they travel verbatim
 * rather than being replaced with something vaguer.
 */
function fieldsFromInput(input: unknown): FormField[] {
  try {
    return validateFormFields(input)
  } catch (err) {
    throw new FolioError('bad_request', err instanceof Error ? err.message : 'Invalid form fields')
  }
}

function toForm(row: FormRow, logger: FolioLogger = console): Form {
  return { ...row, open: row.open !== 0, fields: readFields(row.id, row.fields, logger) }
}

function toSummary(row: SummaryRow): FormSummary {
  return { ...row, open: row.open !== 0 }
}

/* ------------------------------------------------------------------ reads --- */

export async function formById(
  db: FolioDb,
  id: string,
  logger: FolioLogger = console,
): Promise<Form | null> {
  const row = await db.prepare(`select ${COLS} from forms where id = ?`).bind(id).first<FormRow>()
  return row ? toForm(row, logger) : null
}

export async function formByName(
  db: FolioDb,
  name: string,
  logger: FolioLogger = console,
): Promise<Form | null> {
  const row = await db
    .prepare(`select ${COLS} from forms where name = ?`)
    .bind(name)
    .first<FormRow>()
  return row ? toForm(row, logger) : null
}

/**
 * The forms a document embeds, for `resolve()` (decision 4).
 *
 * **Chunked**, because the list is caller-sized: it comes off the document walk,
 * one id per `form` field on the page, and a landing page with a form in every
 * section is the ordinary case rather than the pathological one. `bindChunks`
 * sizes the statements so a call site cannot forget (`db.ts`).
 *
 * Empty in, empty out: `in ()` is not valid SQL. An id with no row behind it is
 * simply absent, which is what lets `resolveValue` answer `null` for a form that
 * has since been deleted.
 */
export async function formsByIds(
  db: FolioDb,
  ids: readonly string[],
  logger: FolioLogger = console,
): Promise<Form[]> {
  if (ids.length === 0) return []
  const pages = await Promise.all(
    bindChunks([...new Set(ids)], 1).map(async (chunk) => {
      const { results } = await db
        .prepare(`select ${COLS} from forms where id in (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk)
        .all<FormRow>()
      return results
    }),
  )
  return pages.flat().map((row) => toForm(row, logger))
}

/* -------------------------------------------------------------- descriptor --- */

/**
 * What `compileForm` needs beyond the row itself. All three come from the
 * render, none of them from storage.
 */
export interface FormRenderContext {
  /**
   * Where Folio is mounted (`FolioConfig.basePath`). The action is
   * `${base}/f/<id>`, **computed here and never stored**, the rule `assetBase`
   * already follows: remounting Folio under a different base path must not
   * invalidate every page that carries a form.
   */
  base: string
  /**
   * The render's locale, or undefined for the source locale. Every string a
   * visitor reads is resolved through this chain here, so a host writes no
   * locale code at all (decision 12).
   */
  locale?: LocaleContext
  /**
   * The URL of the page being rendered, for the `_folio_page` hidden input.
   * Absent when the render does not know its page — `folio.resolve(env, doc)`
   * with no `story`, or a document that has no path. Then `hidden` is empty and
   * the submit route falls back to `Referer` and then to `/`.
   */
  page?: string
  /** The clock half of `isOpen`. Injected so a test can move it. */
  now?: number
}

/** The i18n keys a `FormField` can translate one string under. */
type TranslatableKey = 'label' | 'help' | 'placeholder'

/**
 * One string through the locale chain: the active locale, then each fallback,
 * then the source. `fieldValue`'s rule (`core/locales.ts`) applied to a form's
 * own i18n map — **the first *defined* candidate wins**, so a translation of
 * `''` is a deliberate emptiness that survives and a missing one falls back
 * rather than leaving a hole.
 */
function translate(
  field: FormField,
  key: TranslatableKey,
  locale: LocaleContext | undefined,
): string | undefined {
  if (locale) {
    for (const code of [locale.code, ...locale.fallbacks]) {
      const candidate = field.i18n?.[code]?.[key]
      if (candidate !== undefined) return candidate
    }
  }
  return field[key]
}

/** An option's label through the same chain, keyed by the option's value. */
function translateOption(
  field: FormField,
  option: FormFieldOption,
  locale: LocaleContext | undefined,
): FormFieldOption {
  if (locale) {
    for (const code of [locale.code, ...locale.fallbacks]) {
      const candidate = field.i18n?.[code]?.options?.[option.value]
      if (candidate !== undefined) return { value: option.value, label: candidate }
    }
  }
  return option
}

/**
 * One question as a host renders it.
 *
 * **Written key by key on purpose, never `{ ...field }`.** A spread would carry
 * the whole `i18n` map — every locale's strings, on every page, for a visitor
 * reading one — and would carry whatever a later column adds to `FormField`
 * without anybody deciding it should be public. The projection is the decision.
 */
function compileField(field: FormField, locale: LocaleContext | undefined): ResolvedFormField {
  const out: ResolvedFormField = {
    name: field.name,
    kind: field.kind,
    label: translate(field, 'label', locale) ?? field.label,
    // Always a boolean: a host writes `required={f.required}` and an absent key
    // would render `required` as present-and-false in some frameworks.
    required: field.required === true,
  }
  const help = translate(field, 'help', locale)
  if (help !== undefined) out.help = help
  const placeholder = translate(field, 'placeholder', locale)
  if (placeholder !== undefined) out.placeholder = placeholder
  if (field.max !== undefined) out.max = field.max
  if (field.min !== undefined) out.min = field.min
  if (field.pattern !== undefined) out.pattern = field.pattern
  if (field.options) out.options = field.options.map((o) => translateOption(field, o, locale))
  // The expanded content-type list, not the stored token: a host puts it
  // straight on the input's `accept`, and the menu it came from is an editor's
  // vocabulary rather than a visitor's.
  if (field.accept !== undefined) out.accept = FILE_ACCEPT[field.accept]
  // The **clamped** cap, not the stored number: a host renders this as the
  // input's own limit, and a descriptor promising 50MB against a server that
  // takes 20 is a visitor watching an upload fail after it finished.
  if (field.maxBytes !== undefined) out.maxBytes = fileCap(field)
  if (field.value !== undefined) out.value = field.value
  if (field.text !== undefined) out.text = field.text
  return out
}

/** The name Folio's own hidden input carries. `_`-prefixed, and the builder
 *  refuses a field slug in that namespace (decision 13). */
export const PAGE_INPUT = '_folio_page'

/**
 * The render's locale, carried back on the submission (decision 12: *"the
 * response records which locale it was submitted in"*).
 *
 * Emitted **only for a non-source render**, so a single-locale site's descriptor
 * is byte-identical to the one it had before this existed — `localeContext`'s own
 * rule, and the same absence `Resolution.locale` follows. The submit route runs
 * whatever comes back through `localeOf`, so a value a submitter invented is
 * stored as `''` rather than as itself.
 */
export const LOCALE_INPUT = '_folio_locale'

/**
 * A stored form as a `render` receives it (decision 4): everything a host needs
 * to render a working form and nothing it has to derive — the action, the
 * encoding, the honeypot's name, and every question already localised.
 *
 * Three things here are the whole reason this is compiled server-side rather
 * than left to a host:
 *
 * - **`open` comes from `isOpen`, never from `form.open`.** The switch alone is
 *   half the answer; a form whose `closesAt` has passed is closed and the route
 *   will say so whatever the markup said (decision 14). Deriving it twice is how
 *   the page and the endpoint come to disagree.
 * - **`enctype` is on the descriptor.** A form with a file question submitted as
 *   `application/x-www-form-urlencoded` sends the string `[object File]` and
 *   raises no error anywhere.
 * - **This is a projection, not a view of the row.** Nothing a visitor should not
 *   see may ride along: not `updatedAt` (the concurrency token), not `closesAt`,
 *   not the authoring `i18n` maps, and not whatever a later column adds. The
 *   descriptor is assembled key by key and `test/workers/forms.test.ts` pins its
 *   exact shape, the same posture `presenceOf` takes toward a socket attachment.
 */
export function compileForm(form: Form, ctx: FormRenderContext): ResolvedForm {
  const fields = form.fields.map((field) => compileField(field, ctx.locale))
  return {
    id: form.id,
    name: form.name,
    action: `${ctx.base}/f/${form.id}`,
    method: 'post',
    enctype: form.fields.some((f) => f.kind === 'file')
      ? 'multipart/form-data'
      : 'application/x-www-form-urlencoded',
    version: form.version,
    open: isOpen(form, ctx.now ?? Date.now()),
    fields,
    hidden: [
      ...(ctx.page ? [{ name: PAGE_INPUT, value: ctx.page }] : []),
      ...(ctx.locale ? [{ name: LOCALE_INPUT, value: ctx.locale.code }] : []),
    ],
    honeypot: honeypotName(
      form.id,
      form.fields.map((f) => f.name),
    ),
    submitLabel: form.submitLabel,
    successMessage: form.successMessage,
    closedMessage: form.closedMessage,
    redirectTo: form.redirectTo,
  }
}

/**
 * How many responses each of `ids` has collected, as a map. Absent ids are
 * absent from the answer rather than zero, so a caller can tell "no rows" from
 * "not asked".
 *
 * One grouped query per chunk rather than one query per form, and **chunked for
 * the same reason `formsByIds` is**: the ids are a list page's worth, and a page
 * is up to 200 rows against a 100-parameter ceiling.
 */
export async function countResponsesByForm(
  db: FolioDb,
  ids: readonly string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const pages = await Promise.all(
    bindChunks([...new Set(ids)], 1).map(async (chunk) => {
      const { results } = await db
        .prepare(
          `select form_id as id, count(*) as n from form_responses
           where form_id in (${chunk.map(() => '?').join(', ')}) group by form_id`,
        )
        .bind(...chunk)
        .all<{ id: string; n: number }>()
      return results
    }),
  )
  return Object.fromEntries(pages.flat().map((row) => [row.id, row.n]))
}

/**
 * `(updated_at, id)` descending — the one ordering this table is read in, and
 * exactly what `forms_updated` covers. There is no `sort` parameter for the same
 * reason `listRedirects` has none: a second ordering means a second keyset with
 * its own tie-breaking, for a table bounded by what a person will build.
 */
const FORMS_ORDER: Keyset = { columns: ['updated_at', 'id'], direction: 'desc' }

export interface ListFormsOptions {
  limit?: number
  cursor?: string
  /** Adds `total` for the whole table — one extra `count(*)`, only when asked
   *  (`../../docs/specs/foundation/pagination.md` decision 5). */
  count?: boolean
  /** Adds `responses` per row. Opt-in on its own, because it is a second query
   *  over a table that grows without bound while `forms` does not. */
  counts?: boolean
}

export async function listForms(
  db: FolioDb,
  opts: ListFormsOptions = {},
): Promise<Page<FormSummary>> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  const resume = keysetWhere(FORMS_ORDER, cursor)

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${SUMMARY_COLS} from forms ${whereOf(resume.sql)} ${orderBy(FORMS_ORDER)} limit ?`,
      )
      .bind(...resume.binds, limit + 1)
      .all<SummaryRow>(),
    // The count ignores the cursor deliberately: it counts the whole table,
    // which is what a header means by "of 12" and not "how many are left".
    opts.count ? db.prepare('select count(*) as n from forms').first<{ n: number }>() : null,
  ])

  let page = paginate(rows.results.map(toSummary), limit, (row) => [row.updatedAt, row.id])

  // After `paginate`, not before: the over-fetched row is discarded there, and
  // counting it would be one id of work for a row nobody is shown.
  if (opts.counts) {
    const counts = await countResponsesByForm(
      db,
      page.rows.map((row) => row.id),
    )
    page = { ...page, rows: page.rows.map((row) => ({ ...row, responses: counts[row.id] ?? 0 })) }
  }
  return total ? { ...page, total: total.n } : page
}

/**
 * Everything the delete dialog names, in one round trip: the published documents
 * that render this form, and the two things a delete destroys.
 *
 * **A superset of `GET {base}/api/assets/:id/usage`'s shape**, and the extra half
 * is the point. Checkpoint 17 is the media library's decision 14 in another
 * costume — metadata that deletes content — and the answer chosen there was
 * *warn on both counts and then cascade*, not refuse. A dialog that has to make
 * two more calls to learn what it is about to destroy is a dialog somebody ships
 * with one of them missing, and the acceptance criterion asks for all three
 * numbers together.
 *
 * `published` is the same `{ id, title, path }` rows the asset route answers, so
 * the screen's "where it is used" component is the same one.
 */
export interface FormUsage {
  published: StoryMeta[]
  /** Distinct published documents rendering this form. */
  total: number
  /** Responses a delete would destroy. */
  responses: number
  /** Uploaded files a delete would destroy, counted across those responses. */
  files: number
}

export async function formUsage(db: FolioDb, id: string): Promise<FormUsage> {
  // The shape `assetReferences` (content-index.ts) has, with `kind` bound rather
  // than interpolated: `content_refs.to_id` holds whatever `kind` says it holds
  // (`core/refs.ts`), and for `form` that is a `frm_…` id.
  const [refs, counts] = await Promise.all([
    db
      .prepare(
        `select from_story as "from" from content_refs
         where to_id = ? and kind = ? order by "from"`,
      )
      .bind(id, 'form')
      .all<{ from: string }>(),
    responseCounts(db, id),
  ])

  // `storiesFor` chunks, so an inbound list is its problem rather than this
  // one's — a form on every page of a 500-page site is the normal case for a
  // footer contact form, not the pathological one.
  const published = await storiesFor(
    db,
    refs.results.map((row) => row.from),
  )
  published.sort(
    (a, b) =>
      (a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) ||
      (a.path ?? a.title).localeCompare(b.path ?? b.title),
  )
  return { published, total: published.length, ...counts }
}

/**
 * How many responses and how many uploaded files this form holds.
 *
 * `json_array_length` over the `files` column rather than reading every row's
 * keys: the count is what a dialog shows, and a form with fifty thousand
 * responses must not become fifty thousand rows in a Worker's memory to answer
 * "how many files". Deleting the objects is a different question and reads them
 * in pages, which is what `deleteForm`'s walk does before its batch.
 */
async function responseCounts(
  db: FolioDb,
  id: string,
): Promise<{ responses: number; files: number }> {
  const row = await db
    .prepare(
      `select count(*) as responses, coalesce(sum(json_array_length(files)), 0) as files
       from form_responses where form_id = ?`,
    )
    .bind(id)
    .first<{ responses: number; files: number }>()
  return { responses: row?.responses ?? 0, files: row?.files ?? 0 }
}

/* ----------------------------------------------------------------- writes --- */

export interface CreateFormInput {
  label: string
  /** Slugified. Absent, the label supplies it. */
  name?: string
}

/**
 * A new, empty form.
 *
 * **`insert … on conflict (name) do nothing`, then read back**, rather than a
 * bare insert: the `unique` index is the arbiter and a lost race must answer the
 * same 409 naming the same form as a lost pre-check, not D1's constraint text.
 * The pre-check exists as well, because it is what makes the message name the
 * form that is already there rather than only the slug.
 */
export async function createForm(db: FolioDb, input: CreateFormInput): Promise<Form> {
  const name = formSlug(input.name ?? input.label)
  const taken = await formByName(db, name)
  if (taken) throw slugConflict(taken)

  const id = newFormId()
  const now = Date.now()
  const result = await db
    .prepare(
      `insert into forms (id, name, label, fields, version, open, created_at, updated_at)
       values (?, ?, ?, '[]', 1, 1, ?, ?)
       on conflict (name) do nothing`,
    )
    .bind(id, name, input.label, now, now)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    const winner = await formByName(db, name)
    // Unreachable unless the row went again between the insert and this read.
    if (!winner) throw new FolioError('conflict', `Could not create the form '${name}'`)
    throw slugConflict(winner)
  }

  const form = await formById(db, id)
  if (!form) throw new FolioError('conflict', `Could not create the form '${name}'`)
  return form
}

function slugConflict(existing: Form): FolioError {
  return new FolioError(
    'conflict',
    `"${existing.label}" already uses the name '${existing.name}'. Pick a different one.`,
  )
}

export interface UpdateFormInput {
  /** The `updatedAt` the client read. A stale one is a 409 (decision 18). */
  expectedUpdatedAt: number
  label?: string
  name?: string
  /** Unparsed JSON — `validateFormFields` is what turns it into questions. */
  fields?: unknown
  open?: boolean
  closesAt?: number | null
  successMessage?: string
  closedMessage?: string
  submitLabel?: string
  redirectTo?: string | null
}

export interface UpdateFormResult {
  form: Form
  /**
   * Whether `shapeOf` moved, and therefore whether `version` was bumped. The
   * route turns this into `formChanged`, and Folio's own hook turns *that* into
   * a purge of `form:<id>` — a label edit fires neither (decision 7).
   */
  structural: boolean
}

/**
 * A builder save. Null when there is no such form; a 409 when somebody else
 * saved first.
 *
 * **The guard is in the `update`'s own `where`, not in a read before it.** A
 * read-then-write pair has a window two editors clicking Save at once fit
 * through, and losing an editor's work without saying so is the failure decision
 * 18 exists to prevent. The pre-read is only for computing the next row.
 *
 * **`updated_at` is forced to move.** Two saves inside one millisecond would
 * otherwise share a token, and the second editor's stale value would validate
 * against the first's write — the guard reading as passed on exactly the race it
 * is there for.
 */
export async function updateForm(
  db: FolioDb,
  id: string,
  input: UpdateFormInput,
): Promise<UpdateFormResult | null> {
  const current = await formById(db, id)
  if (!current) return null

  const fields = input.fields === undefined ? current.fields : fieldsFromInput(input.fields)
  const structural = shapeOf(fields) !== shapeOf(current.fields)
  const version = structural ? current.version + 1 : current.version

  const name = input.name === undefined ? current.name : formSlug(input.name)
  if (name !== current.name) {
    const taken = await formByName(db, name)
    if (taken) throw slugConflict(taken)
  }

  const next: Form = {
    ...current,
    name,
    label: input.label ?? current.label,
    fields,
    version,
    open: input.open ?? current.open,
    closesAt: input.closesAt === undefined ? current.closesAt : input.closesAt,
    successMessage: input.successMessage ?? current.successMessage,
    closedMessage: input.closedMessage ?? current.closedMessage,
    submitLabel: input.submitLabel ?? current.submitLabel,
    redirectTo: input.redirectTo === undefined ? current.redirectTo : input.redirectTo,
    updatedAt: Math.max(Date.now(), current.updatedAt + 1),
  }

  const result = await db
    .prepare(
      `update forms set name = ?, label = ?, fields = ?, version = ?, open = ?, closes_at = ?,
         closed_message = ?, success_message = ?, submit_label = ?, redirect_to = ?, updated_at = ?
       where id = ? and updated_at = ?`,
    )
    .bind(
      next.name,
      next.label,
      JSON.stringify(next.fields),
      next.version,
      next.open ? 1 : 0,
      next.closesAt,
      next.closedMessage,
      next.successMessage,
      next.submitLabel,
      next.redirectTo,
      next.updatedAt,
      id,
      input.expectedUpdatedAt,
    )
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new FolioError(
      'conflict',
      'This form was changed by somebody else. Reload it and make your change again.',
    )
  }
  return { form: next, structural }
}

/* ------------------------------------------------------- the R2 half --- */

/**
 * Responses read per page of the delete walk. A page holds ids and one JSON
 * column each, not the answers, so this is a memory bound rather than a bind
 * one — the statement binds four parameters whatever the page size is.
 */
const UPLOAD_WALK_PAGE = 200

/** R2 refuses a `delete` naming more than a thousand keys. */
const R2_DELETE_KEYS = 1000

/**
 * The R2 keys one page of responses holds, and the id to resume from.
 *
 * **Walked by `id`, not by `created_at`**, for `assetsMatching`'s reason: the set
 * is about to be destroyed as it is walked, and `id` is the one key that is
 * stable, unique and rewritten by nothing. `files <> '[]'` keeps the walk to the
 * rows that have anything in them, so a form whose questions are all text
 * terminates on the first page.
 *
 * Screened on read: a `files` entry whose `key` is not a string is dropped
 * rather than thrown on, the posture `parseScopes` sets for every JSON column in
 * this schema. A malformed row must not be the reason a form cannot be deleted.
 */
async function uploadKeysPage(
  db: FolioDb,
  formId: string,
  after: string,
): Promise<{ keys: string[]; last: string | null }> {
  const { results } = await db
    .prepare(
      `select id, files from form_responses
       where form_id = ? and files <> '[]' and id > ?
       order by id limit ?`,
    )
    .bind(formId, after, UPLOAD_WALK_PAGE)
    .all<{ id: string; files: string }>()

  const keys: string[] = []
  for (const row of results) keys.push(...uploadKeysOf(row.files))
  return { keys, last: results.at(-1)?.id ?? null }
}

/** The R2 keys inside one `form_responses.files` value. Total: anything that is
 *  not an object with a string `key` is simply not a key. */
export function uploadKeysOf(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as { key?: unknown }).key : undefined,
    )
    .filter((key): key is string => typeof key === 'string' && key !== '')
}

/**
 * Objects out of the bucket, a thousand keys at a time.
 *
 * **This throws**, deliberately, and every caller decides what that means: the
 * delete paths let it abort so the rows stay behind to retry from, and the
 * submit route's compensating cleanup swallows it because the failure it is
 * compensating for is the one worth reporting (`uploadAsset`'s rule).
 */
export async function deleteUploads(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_KEYS) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_KEYS))
  }
}

/** Every object every response to this form holds, in keyset pages. */
async function purgeFormUploads(db: FolioDb, bucket: R2Bucket, formId: string): Promise<void> {
  let after = ''
  for (;;) {
    const { keys, last } = await uploadKeysPage(db, formId, after)
    if (keys.length > 0) await deleteUploads(bucket, keys)
    if (last === null) return
    after = last
  }
}

export interface DeleteFormResult {
  deleted: boolean
  /** Responses destroyed with it. */
  responses: number
  /** Uploaded files destroyed with it. */
  files: number
}

/**
 * The form, its responses, and the edges that pointed at it — one batch.
 *
 * **The cascade is deliberate and it is the decision** (checkpoint 17): the
 * dialog names what it will destroy and then destroys it, rather than refusing
 * while a count is non-zero. `formUsage` is what makes the naming possible, and
 * it is the half of this that must not go missing — a delete that quietly took
 * four hundred people's answers with it is the media library's decision 14
 * failure wearing a different hat.
 *
 * Inbound `content_refs` go too, the way `deleteAsset` clears its own: the rows
 * mean "this published page renders this form", and nothing renders a form that
 * no longer exists.
 *
 * **The R2 objects go first, walked in keyset pages** (decision 15). They have
 * to: the keys are only knowable from the rows this batch is about to destroy,
 * so a batch that ran first would leave every file ever submitted to this form
 * in the bucket with nothing left pointing at it — invisible, permanent, and
 * paid for monthly. The walk is paged rather than one `select`, because a form
 * with fifty thousand responses is the case `responseCounts` was already written
 * around.
 *
 * **A failed object delete aborts the whole thing, and that is the recoverable
 * side to be wrong on.** This is the one place `deleteAsset`'s "swallow the R2
 * failure" rule is inverted, and the reason is the order: `deleteAsset` deletes
 * the row first, so by the time R2 is reached there is nothing left to retry
 * *from*. Here the rows are still there, so throwing leaves a delete that can
 * simply be repeated; swallowing would commit the batch and orphan the objects
 * the walk had just failed to remove.
 *
 * Nothing here binds a caller-sized list: three statements, one or two binds
 * each, and the walk is four binds a page whatever the form holds.
 */
export async function deleteForm(
  db: FolioDb,
  id: string,
  bucket?: R2Bucket,
): Promise<DeleteFormResult> {
  const counts = await responseCounts(db, id)
  if (counts.files > 0) {
    if (!bucket) {
      // Unreachable through the routes — a form cannot gain a `file` question
      // on a host with no `media` binding — but a delete that silently orphaned
      // twelve people's CVs because a caller passed two arguments instead of
      // three is exactly the failure `documents.ts` exists to stop elsewhere.
      throw new FolioError(
        'unsupported',
        'No media bucket is configured, and this form holds uploaded files.',
      )
    }
    await purgeFormUploads(db, bucket, id)
  }
  const [, , removed] = await db.batch([
    db.prepare('delete from form_responses where form_id = ?').bind(id),
    db.prepare('delete from content_refs where to_id = ? and kind = ?').bind(id, 'form'),
    db.prepare('delete from forms where id = ?').bind(id),
  ])
  const deleted = (removed?.meta.changes ?? 0) > 0
  return deleted ? { deleted, ...counts } : { deleted: false, responses: 0, files: 0 }
}

/* --------------------------------------------------------------- responses --- */

/**
 * What the responses table and the CSV export are both filtered by
 * (`../../docs/specs/content-model/forms.md` decision 16: the export honours the
 * filter the table is showing, so there is one filter shape and not two).
 *
 * Declared here rather than beside the responses store, because `validate.ts`
 * parses it out of a query string and the responses store does not exist yet —
 * a filter is a shape, and the shape belongs with the feature.
 */
export interface ResponseFilter {
  /** Inclusive lower bound on `created_at`, in epoch milliseconds. */
  from?: number
  /** Exclusive upper bound on `created_at`, in epoch milliseconds. */
  to?: number
  /** Substring scan over the stored answers. Deliberately a scan: no index
   *  serves a leading-wildcard `like`, and decision 16's sibling reasoning is
   *  that a form's responses are read by a person on one screen. */
  q?: string
}
