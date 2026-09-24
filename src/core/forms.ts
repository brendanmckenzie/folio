/**
 * Forms and their questions, the pure vocabulary
 * (`../../docs/specs/content-model/forms.md`).
 *
 * A form is a row, not a document (architecture decision 1): `forms.fields` is
 * one validated JSON column rather than a table per question (decision 2), so
 * `validateFormFields` is the one place a stored array becomes a typed one —
 * called by the PATCH route before it writes, the admin builder before it lets
 * you save, and the submit route when it compiles a `ResolvedForm`. One
 * implementation, one test, and no way for the admin to permit a shape the
 * server refuses.
 *
 * **Screened on read, like `parseScopes` (`server/auth/roles.ts`).** A field
 * whose `kind` this build does not recognise is dropped rather than thrown on,
 * so removing a field kind from the code narrows every stored form instead of
 * breaking it. Everything else about a *recognised* kind — a missing label, a
 * reserved name, an empty option list — is a genuine validation failure and
 * throws, because a legitimate write should never produce one and a stored row
 * should never have passed through this function without already satisfying it.
 *
 * This file knows nothing about D1, Hono or React: `server/forms.ts` and the
 * admin builder both import it, and the descriptor types below travel from
 * `resolve()` (`core/resolve.ts`) to a host's `render` with no server import in
 * between.
 */
import type { Json } from './doc'

/** The thirteen kinds a question on a form can be. */
export type FormFieldKind =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxes'
  | 'file'
  | 'hidden'
  | 'statement'

const FORM_FIELD_KINDS: readonly FormFieldKind[] = [
  'text',
  'textarea',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'select',
  'radio',
  'checkbox',
  'checkboxes',
  'file',
  'hidden',
  'statement',
]

const isFormFieldKind = (x: unknown): x is FormFieldKind =>
  typeof x === 'string' && (FORM_FIELD_KINDS as readonly string[]).includes(x)

/**
 * What a `file` question will take. A fixed menu, not a free content-type list:
 * an editor should not be able to invite `application/x-msdownload`.
 */
export type FileAccept = 'documents' | 'images' | 'both'

const DOCUMENT_TYPES: readonly string[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]

const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export const FILE_ACCEPT: Record<FileAccept, readonly string[]> = {
  documents: DOCUMENT_TYPES,
  images: IMAGE_TYPES,
  both: [...DOCUMENT_TYPES, ...IMAGE_TYPES],
}

export interface FormFieldOption {
  value: string
  label: string
}

/** Per-locale overrides. `Blok.i18n`'s shape one level down (decision 12). */
export interface FormFieldI18n {
  label?: string
  help?: string
  placeholder?: string
  /** Keyed by option `value`. */
  options?: Record<string, string>
}

export interface FormField {
  /** Slug, unique within the form. **This is the HTML input's `name`**, so it is
   *  what a submission's keys are and what a CSV column is headed. Renaming one
   *  splits a column; the builder says so. */
  name: string
  kind: FormFieldKind
  label: string
  help?: string
  placeholder?: string
  required?: boolean
  /** `maxlength` for text kinds; `max` for `number`. */
  max?: number
  min?: number
  /** An HTML `pattern` the host may put on the input, and which the server
   *  re-checks. Bounded, and compiled once at validation so a pathological
   *  expression is refused at save time rather than at submit time. */
  pattern?: string
  options?: readonly FormFieldOption[]
  accept?: FileAccept
  maxBytes?: number
  /** `hidden` only: the value the host's markup emits. */
  value?: string
  /** `statement` only: prose between questions. Renders no input and stores
   *  nothing. */
  text?: string
  /**
   * Joins the row the *previous* question is in, rather than starting a new
   * one — layout, not shape (`docs/form-layout-approach.md` decision 2): it never
   * touches `shapeOf`, never bumps `version`, and a save that changes only
   * this still purges `form:<id>` (`server/forms.ts`'s `updateForm`).
   * Narrowed rather than refused when it cannot apply — the form's first
   * question, and the one right after a `statement` — see `rowsOf`.
   */
  beside?: boolean
  /**
   * This question's share of its row, relative to its row-mates — an `fr`
   * unit, not a percentage, so a hidden neighbour never leaves a gap that has
   * to be recomputed (owner decision: relative shares, 1–4). Absent means 1,
   * which is why the type excludes it: a stored `1` and no key at all would
   * be the same fact recorded two ways.
   */
  grow?: 2 | 3 | 4
  i18n?: Record<string, FormFieldI18n>
}

export const MAX_FORM_FIELDS = 60
/** Names beginning with this are Folio's (decision 13). The builder refuses one. */
export const RESERVED_PREFIX = '_'

/** A `pattern`'s own length cap, so a save-time compile check cannot itself be
 *  the pathological input. Generous for any legitimate HTML `pattern`. */
const MAX_PATTERN_LENGTH = 200

const NAME = /^[a-z][a-z0-9_]{0,63}$/
const OPTION_KINDS: ReadonlySet<FormFieldKind> = new Set(['select', 'radio', 'checkboxes'])

/**
 * The slug `forms.name` is minted from. Same shape as `story.ts`'s `slugify` —
 * lowercase, one word joined by hyphens, bounded — with its own fallback,
 * because "a form with no name yet" is not "an untitled page".
 */
export function formSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'form'
  )
}

function validateOption(raw: unknown, fieldName: string, seen: Set<string>): FormFieldOption {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`forms: field "${fieldName}" has a malformed option`)
  }
  const o = raw as Record<string, unknown>
  if (typeof o.value !== 'string' || o.value === '') {
    throw new Error(`forms: field "${fieldName}" has an option with no value`)
  }
  if (seen.has(o.value)) {
    throw new Error(`forms: field "${fieldName}" has a duplicate option value "${o.value}"`)
  }
  seen.add(o.value)
  return { value: o.value, label: typeof o.label === 'string' ? o.label : o.value }
}

function validateOptions(raw: unknown, fieldName: string): readonly FormFieldOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`forms: field "${fieldName}" needs at least one option`)
  }
  const seen = new Set<string>()
  return raw.map((item) => validateOption(item, fieldName, seen))
}

/**
 * Best-effort, unlike the rest of this function: a translation that arrived
 * malformed is dropped rather than failing the whole save, the same posture
 * `localeChain` takes toward a missing translation — a hole, not an error.
 */
function validateFieldI18n(raw: unknown): Record<string, FormFieldI18n> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, FormFieldI18n> = {}
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const entry: FormFieldI18n = {}
    if (typeof v.label === 'string') entry.label = v.label
    if (typeof v.help === 'string') entry.help = v.help
    if (typeof v.placeholder === 'string') entry.placeholder = v.placeholder
    if (v.options && typeof v.options === 'object') {
      const options: Record<string, string> = {}
      for (const [key, optionLabel] of Object.entries(v.options as Record<string, unknown>)) {
        if (typeof optionLabel === 'string') options[key] = optionLabel
      }
      if (Object.keys(options).length > 0) entry.options = options
    }
    if (Object.keys(entry).length > 0) out[locale] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function validateOneField(raw: Record<string, unknown>, kind: FormFieldKind): FormField {
  const name = raw.name
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`forms: invalid field name ${JSON.stringify(name)}`)
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `forms: field name "${name}" starts with the reserved prefix "${RESERVED_PREFIX}"`,
    )
  }

  const label = raw.label
  if (typeof label !== 'string' || label === '') {
    throw new Error(`forms: field "${name}" needs a label`)
  }

  const field: FormField = { name, kind, label }

  if (typeof raw.help === 'string') field.help = raw.help
  if (typeof raw.placeholder === 'string') field.placeholder = raw.placeholder
  if (typeof raw.required === 'boolean') field.required = raw.required
  if (typeof raw.max === 'number' && Number.isFinite(raw.max)) field.max = raw.max
  if (typeof raw.min === 'number' && Number.isFinite(raw.min)) field.min = raw.min

  if (typeof raw.pattern === 'string') {
    if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`forms: field "${name}"'s pattern is too long`)
    }
    try {
      new RegExp(raw.pattern)
    } catch {
      throw new Error(`forms: field "${name}" has an invalid pattern`)
    }
    field.pattern = raw.pattern
  }

  if (OPTION_KINDS.has(kind)) {
    field.options = validateOptions(raw.options, name)
  }

  if (kind === 'file') {
    if (raw.accept !== 'documents' && raw.accept !== 'images' && raw.accept !== 'both') {
      throw new Error(`forms: field "${name}" needs a valid accept`)
    }
    field.accept = raw.accept
    if (raw.maxBytes !== undefined) {
      if (typeof raw.maxBytes !== 'number' || !Number.isFinite(raw.maxBytes) || raw.maxBytes <= 0) {
        throw new Error(`forms: field "${name}" has an invalid maxBytes`)
      }
      field.maxBytes = raw.maxBytes
    }
  }

  if (kind === 'hidden') {
    field.value = typeof raw.value === 'string' ? raw.value : ''
  }

  if (kind === 'statement') {
    if (typeof raw.text !== 'string' || raw.text === '') {
      throw new Error(`forms: field "${name}" needs statement text`)
    }
    field.text = raw.text
  }

  // Layout, not shape: a bad value is dropped rather than thrown on, the same
  // posture every other presentational key here takes — `readFields` calls
  // this too, and a layout mistake must never turn into `[]` (narrow on read;
  // the builder's own controls are what refuse on write).
  if (typeof raw.beside === 'boolean') field.beside = raw.beside
  if (raw.grow === 2 || raw.grow === 3 || raw.grow === 4) field.grow = raw.grow

  if (raw.i18n !== undefined) {
    const i18n = validateFieldI18n(raw.i18n)
    if (i18n) field.i18n = i18n
  }

  return field
}

/**
 * The one validator, called by the PATCH route, the builder and the compiler
 * (decision 2). `input` is already-parsed JSON — a caller reading `forms.fields`
 * back from D1 does its own `JSON.parse` first, the same convention
 * `parseScopes` uses for `api_tokens.scopes`.
 *
 * Bounded at `MAX_FORM_FIELDS`, and every `name` unique and outside
 * `RESERVED_PREFIX` — both are save-time failures, not narrowing, because a
 * legitimate write can never produce either.
 */
export function validateFormFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) {
    throw new Error('forms: fields must be an array')
  }
  if (input.length > MAX_FORM_FIELDS) {
    throw new Error(`forms: at most ${MAX_FORM_FIELDS} fields, got ${input.length}`)
  }

  const out: FormField[] = []
  const seenNames = new Set<string>()

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('forms: a field must be an object')
    }
    const candidate = raw as Record<string, unknown>

    // Screened on read: a kind this build does not know is dropped rather than
    // thrown on, so removing a field kind from the code narrows every stored
    // form instead of breaking it (parseScopes' rule, roles.ts:83).
    if (!isFormFieldKind(candidate.kind)) continue

    const field = validateOneField(candidate, candidate.kind)
    if (seenNames.has(field.name)) {
      throw new Error(`forms: duplicate field name "${field.name}"`)
    }
    seenNames.add(field.name)
    out.push(field)
  }

  return out
}

/**
 * The shape-bearing projection `forms.version` is bumped from (decision 7):
 * name, kind, whether it is required, and its option values — nothing a label,
 * help, placeholder or translation edit would touch. Pure, and comparable by
 * simple string equality against what is stored.
 */
export function shapeOf(fields: readonly FormField[]): string {
  return JSON.stringify(
    fields.map((f) => ({
      name: f.name,
      kind: f.kind,
      required: !!f.required,
      options: f.options?.map((o) => o.value),
    })),
  )
}

/** At most this many questions share one row (`docs/form-layout-approach.md`'s
 *  Candidate C: "Name with a title field is four; HubSpot caps at three"). A
 *  fifth `beside` question narrows into a row of its own rather than refusing
 *  the save — `rowsOf` never throws. */
export const MAX_ROW_CELLS = 4

/**
 * Which row each question falls in, in `fields`' own order — the one
 * algorithm behind both `compileField`'s `row` and the admin builder's own
 * grouping (`form-model.ts`'s `fieldRows`, which must agree with this on
 * where a row starts; it disagrees on purpose about `hidden` fields, which
 * this reuses the previous row number for and that function shows as their
 * own line).
 *
 * A row is the first question plus every following question with `beside`.
 * The start of the form, a `statement` and a row already at `MAX_ROW_CELLS`
 * all start a fresh one — a `statement` starts a row of one and forces the
 * *next* question into a fresh row too, whatever its own `beside` says.
 * `hidden` questions are layout-transparent: they neither join nor break a
 * row and are not counted against the cap, so this narrows a form that has
 * one wedged between two halves of what is visually one row.
 *
 * Returns one row number per field, same length and order as `fields` — a
 * `hidden` question's number is borrowed from whichever row is open when it
 * is reached (or `0` before the first one opens), because nothing groups by
 * it; `formLayout` filters `hidden` out before grouping by row number at all.
 */
export function rowsOf(fields: readonly FormField[]): number[] {
  const rows: number[] = []
  let row = -1
  let cellsInRow = 0
  let breaksNext = true // the start of the form breaks a row
  for (const field of fields) {
    if (field.kind === 'hidden') {
      rows.push(Math.max(row, 0))
      continue
    }
    const isStatement = field.kind === 'statement'
    if (isStatement || breaksNext || !field.beside || cellsInRow >= MAX_ROW_CELLS) {
      row += 1
      cellsInRow = 0
    }
    rows.push(row)
    cellsInRow += 1
    breaksNext = isStatement
  }
  return rows
}

/**
 * A fixed pool of plausible-looking decoy field names (decision 9) — a
 * reserved-looking name like `_hp` is a name a competent bot skips, so the
 * honeypot instead looks like an ordinary, boring input a form might have.
 */
const HONEYPOT_POOL: readonly string[] = [
  'company_website',
  'fax',
  'url_confirm',
  'middle_name',
  'company_name',
  'phone_extension',
  'address_2',
  'department',
  'reference_code',
  'home_page',
  'contact_id',
  'account_number',
]

/** A small, stable string hash — deterministic across runs and platforms,
 *  which `Array.prototype.sort`'s relative order and `Math.random` are not. */
function stableHash(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * Deterministic per form, from `HONEYPOT_POOL`, avoiding the form's own slugs
 * (decision 9). Stable per form id, so a cached page and the live route always
 * agree on which input is the decoy — the builder refuses a field slug that
 * collides with it.
 */
export function honeypotName(formId: string, taken: readonly string[]): string {
  const takenNames = new Set(taken)
  const available = HONEYPOT_POOL.filter((name) => !takenNames.has(name))
  const pool = available.length > 0 ? available : HONEYPOT_POOL
  const index = ((stableHash(formId) % pool.length) + pool.length) % pool.length
  // `index` is derived from `pool.length` itself, so it is always in bounds —
  // `noUncheckedIndexedAccess` cannot see that from a computed index.
  return pool[index]!
}

/* --------------------------------------------------------------- descriptor --- */

/** What a `render` receives for one question, already resolved through the
 *  locale chain (decision 12) — a host writes no locale code at all. */
export interface ResolvedFormField {
  name: string
  kind: FormFieldKind
  /** Already resolved through the locale chain. */
  label: string
  help?: string
  placeholder?: string
  required: boolean
  max?: number
  min?: number
  pattern?: string
  options?: readonly FormFieldOption[]
  accept?: readonly string[]
  maxBytes?: number
  value?: string
  text?: string
  /** Which row this question is in, in `fields`' own order — consecutive
   *  fields sharing a number form one row (`rowsOf`). Always present, unlike
   *  everything else optional above, so a host can group `fields` itself
   *  without reaching for `formLayout` when all it wants is the numbers. */
  row: number
  /** This question's share of its row, relative to its row-mates. Always
   *  present and `1` when the stored `FormField` left `grow` unset — a host
   *  writes `` `${grow}fr` `` straight onto a grid track with no fallback of
   *  its own to remember. */
  grow: number
}

/**
 * What a `form` field resolves to (`core/resolve.ts`'s `resolveValue`,
 * architecture decision 4): everything a host needs to render a working form
 * and nothing it has to derive — the action URL, the encoding, the honeypot's
 * name, and every question already localised.
 */
export interface ResolvedForm {
  id: string
  /** The slug, for a page carrying two forms. */
  name: string
  /** `{base}/f/<id>`. Computed at render, never stored — remounting Folio under a
   *  different base path must not invalidate anything, the rule `assetBase`
   *  already follows. */
  action: string
  method: 'post'
  enctype: 'application/x-www-form-urlencoded' | 'multipart/form-data'
  version: number
  /** `open` and the clock, together. */
  open: boolean
  fields: readonly ResolvedFormField[]
  /** `_folio_page` when the render knows its path; empty otherwise. */
  hidden: readonly { name: string; value: string }[]
  honeypot: string
  submitLabel: string
  successMessage: string
  closedMessage: string
  redirectTo: string | null
}

/* ------------------------------------------------------------- formLayout --- */

/**
 * One section's legend, for the day a form has more than one
 * (`docs/form-layout-approach.md` slice 2). Unused this slice — `formLayout` never
 * produces one — but shaped now so a host that groups on `LayoutSection`
 * today needs no changes when it lands.
 */
export interface ResolvedFormSection {
  name: string
  label: string
  help?: string
}

/** One cell of a row. `shown` is always `true` until slice 3's conditions
 *  land; a host renders `!shown` as an empty, `aria-hidden` slot rather than
 *  omitting it, which is what lets a `hold`ing neighbour keep its place. */
export interface LayoutCell {
  field: ResolvedFormField
  grow: number
  shown: boolean
}

/** One row: a stable `key` (the row's first field's name, unique across the
 *  form) and its cells, left to right in `fields`' own order. */
export interface LayoutRow {
  key: string
  cells: readonly LayoutCell[]
}

/** A section's own rows, or the one `section: null` group every question
 *  belongs to until slice 2 gives some of them a real one. */
export interface LayoutSection {
  section: ResolvedFormSection | null
  rows: readonly LayoutRow[]
}

/** What `formLayout` hands a host: rows to render in order, grouped into
 *  sections, plus the `hidden`-kind questions rows have no room for. */
export interface FormLayoutView {
  sections: readonly LayoutSection[]
  /** `hidden`-kind questions: position-free, rendered anywhere inside the
   *  `<form>` — a host emits each as `<input type="hidden">` and moves on. */
  inputs: readonly ResolvedFormField[]
}

/**
 * Groups a compiled form's `fields` into the rows and sections a host draws —
 * the one function so no host reimplements the grouping `rowsOf` already
 * computed server-side (`docs/form-layout-approach.md` Candidate C). Pure: no
 * fetch, no DOM, safe to call from a server render and from a preview bundle
 * alike.
 *
 * `answers` is next slice's: once `showIf` exists, a cell whose question is
 * not asked drops out (unless it `hold`s, staying with `shown: false`), a row
 * with nothing shown is removed, and a section whose own condition fails or
 * that has no rows left is removed too. Until then every cell is `shown` and
 * the parameter changes nothing — accepted now so a host that calls
 * `formLayout(form, answers)` today keeps compiling once slice 3 gives the
 * second argument something to do.
 */
export function formLayout(form: ResolvedForm, _answers?: Record<string, Json>): FormLayoutView {
  const inputs: ResolvedFormField[] = []
  const rows: LayoutCell[][] = []
  let openRow: number | null = null

  for (const field of form.fields) {
    if (field.kind === 'hidden') {
      inputs.push(field)
      continue
    }
    // `row`/`grow` are typed as always present, but a descriptor a host cached
    // across a deploy (KV, its own `caches.default`) can be one an older
    // `compileField` built, before either existed — narrowed here rather than
    // trusted, the same posture `readFields` takes toward a stored row. A
    // missing `row` falls back to a row of its own, never one row holding the
    // whole form (`null` never equals `null` below, only a **present**
    // `openRow` joins), and a missing `grow` falls back to the 1 default.
    const row = typeof field.row === 'number' ? field.row : null
    const grow = typeof field.grow === 'number' ? field.grow : 1
    const cell: LayoutCell = { field, grow, shown: true }
    if (row !== null && row === openRow) {
      rows[rows.length - 1]?.push(cell)
    } else {
      rows.push([cell])
      openRow = row
    }
  }

  const layoutRows: LayoutRow[] = rows.map((cells) => ({
    // `cells` is never empty — every row starts from a `push([cell])` above —
    // so its first entry is never the hole `noUncheckedIndexedAccess` warns of.
    key: cells[0]!.field.name,
    cells,
  }))

  return { sections: [{ section: null, rows: layoutRows }], inputs }
}
