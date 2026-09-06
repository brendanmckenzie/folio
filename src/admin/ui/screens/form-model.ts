/**
 * The form builder's arithmetic (`docs/specs/content-model/forms.md` phase 6):
 * the add-field menu, the pure reducers over a field list (add, remove,
 * reorder, rename — with the split warning), field-name normalisation and its
 * refusals (including the honeypot collision decision 9 asks for), the
 * per-locale text a translating editor reads and writes, and the
 * `closesAt` ⇄ `<input type="datetime-local">` conversion.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component. `inspector-model.ts` and `redirects-model.ts` are
 * the pattern: everything a person can get wrong without a request lives here,
 * so a Node test can reach it.
 *
 * **Every save still goes through `validateFormFields`** (`core/forms.ts`) on
 * the server, which is the one validator (decision 2). Nothing here is a
 * second implementation of that — it is the client-side half that goes exactly
 * as far as being useful, `redirects-model.ts`'s `draftRefusal` posture: a
 * refusal the server does not need a round trip to give.
 */
import {
  type FormField,
  type FormFieldI18n,
  type FormFieldKind,
  type FormFieldOption,
  honeypotName,
  RESERVED_PREFIX,
} from '../../../core/forms'
import type { LocaleConfig } from '../../../core/locales'

/* -------------------------------------------------------------- locales --- */

/**
 * Whether the builder shows a locale switcher at all (decision 12: "shown
 * only when `config.locales` is set").
 *
 * `> 1`, not merely "declared", matching `EditorShell.tsx`'s own check for the
 * same reason: a `locales` config naming exactly one available locale (the
 * source, and nothing else) has nothing to switch *to*, so the control would
 * offer one option that is already showing.
 */
export function showLocaleSwitcher(locales: LocaleConfig | undefined): boolean {
  return (locales?.available.length ?? 0) > 1
}

/* --------------------------------------------------------------- the menu --- */

export interface FieldKindMeta {
  kind: FormFieldKind
  label: string
  /** One line for the add menu — what this kind is for, not how it validates. */
  hint: string
}

/** The thirteen kinds, in the order the add menu offers them — the order a
 *  contact form's questions actually arrive in: identity, then the message,
 *  then the choices, then the exceptional ones. */
export const FIELD_KINDS: readonly FieldKindMeta[] = [
  { kind: 'text', label: 'Text', hint: 'A single line — a name, a subject.' },
  { kind: 'email', label: 'Email', hint: 'Checked for shape, both here and on submit.' },
  { kind: 'tel', label: 'Phone', hint: 'A single line, no format enforced.' },
  { kind: 'url', label: 'Website', hint: 'Checked for shape, both here and on submit.' },
  { kind: 'textarea', label: 'Paragraph', hint: 'A multi-line message.' },
  { kind: 'number', label: 'Number', hint: 'Coerced and range-checked on submit.' },
  { kind: 'date', label: 'Date', hint: 'A single date, no time.' },
  { kind: 'select', label: 'Dropdown', hint: 'One choice from a list.' },
  { kind: 'radio', label: 'Radio buttons', hint: 'One choice, every option visible.' },
  { kind: 'checkbox', label: 'Single checkbox', hint: 'A yes/no — "I agree to…".' },
  { kind: 'checkboxes', label: 'Checkbox group', hint: 'Any number of choices from a list.' },
  {
    kind: 'file',
    label: 'File upload',
    hint: 'Gated: only a signed-in publisher can read it back.',
  },
  {
    kind: 'hidden',
    label: 'Hidden value',
    hint: "The host's own markup supplies this, not a visitor.",
  },
  {
    kind: 'statement',
    label: 'Statement',
    hint: 'Prose between questions. No input, stores nothing.',
  },
]

const KIND_LABELS: Record<FormFieldKind, string> = Object.fromEntries(
  FIELD_KINDS.map((k) => [k.kind, k.label]),
) as Record<FormFieldKind, string>

export function fieldKindLabel(kind: FormFieldKind): string {
  return KIND_LABELS[kind]
}

/** The kinds `validateFormFields` requires at least one option for. */
const OPTION_KINDS: ReadonlySet<FormFieldKind> = new Set(['select', 'radio', 'checkboxes'])

export function needsOptions(kind: FormFieldKind): boolean {
  return OPTION_KINDS.has(kind)
}

/* ---------------------------------------------------------------- naming --- */

/**
 * A typed name, screened to the charset `core/forms.ts`'s `NAME` regex
 * requires (`^[a-z][a-z0-9_]{0,63}$`) — ASCII only, deliberately narrower than
 * `formSlug`'s unicode-aware `\p{Letter}`: this is a CSV column header and an
 * HTML input `name`, an identifier rather than a human-facing path segment, so
 * a non-Latin label is dropped rather than carried through as a name nobody
 * downstream (a spreadsheet, a `<input name>`) can round-trip.
 *
 * Guaranteed to satisfy `NAME` for any input, including the empty string —
 * every caller can hand this straight to the server without a second check.
 */
export function normaliseFieldName(raw: string): string {
  const stripped = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  if (stripped === '') return 'field'
  return /^[a-z]/.test(stripped) ? stripped : `f_${stripped}`.slice(0, 64)
}

/**
 * Disambiguates `base` against `existing`, `_2`, `_3`, … — never touching
 * `base` itself when it is not already taken.
 *
 * Named for its first use (a field's own name against its siblings') but
 * generic over any slug-like set: `addOption` reuses it verbatim for an
 * option's `value` against its siblings' — the same "make this one thing
 * unique in this list" question, asked of a different list.
 */
export function uniqueFieldName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`.slice(0, 64)
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * What is wrong with a typed field name, or null. Three refusals, and all
 * three are things the server would otherwise 400 on:
 *
 * - the charset (unreachable once a name has gone through
 *   `normaliseFieldName`, but a direct caller — a test, a future paste-in
 *   flow — should still hear about it rather than send a name the server
 *   refuses);
 * - a duplicate within the same form (`validateFormFields`'s `seenNames`);
 * - a collision with this form's honeypot (decision 9: "the builder refuses a
 *   field whose slug collides with it" — the one refusal that is entirely
 *   this screen's to make, since the server never sees a name that never
 *   reaches it).
 *
 * The reserved-prefix refusal (`RESERVED_PREFIX`) is folded into the charset
 * one: `normaliseFieldName` never produces a leading underscore, so this only
 * fires for a name a caller constructed by hand.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export function fieldNameRefusal(
  name: string,
  ctx: { formId: string; otherNames: readonly string[] },
): string | null {
  if (!NAME_PATTERN.test(name)) {
    return 'Use lowercase letters, numbers and underscores, starting with a letter.'
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    return `Names starting with "${RESERVED_PREFIX}" are reserved by Folio.`
  }
  if (ctx.otherNames.includes(name)) {
    return 'Another question already uses this name.'
  }
  if (name === honeypotName(ctx.formId, ctx.otherNames)) {
    return "This name is reserved as this form's spam trap. Pick another."
  }
  return null
}

/**
 * What renaming an already-answered question costs, named at rename time
 * rather than discovered in the export (edge case: "A field is renamed after
 * 400 responses"). `hasResponses` is the caller's to know — this screen does
 * not hold the responses count itself, `GET {base}/api/forms/:id/usage` does,
 * the same read the delete dialog already makes.
 */
export function renameWarning(hasResponses: boolean): string | null {
  if (!hasResponses) return null
  return 'This form already has responses. Renaming keeps old answers under the old name — the table will show "—" for older rows under the new one, and the CSV export will carry both columns.'
}

/* ------------------------------------------------------------ blank field --- */

/** A fresh question of `kind`, named uniquely and pre-filled with whatever
 *  that kind cannot save without (`validateFormFields` throws on an option
 *  kind with none, and on `statement` with no text). */
export function blankField(
  kind: FormFieldKind,
  ctx: { formId: string; existing: readonly FormField[] },
): FormField {
  const names = ctx.existing.map((f) => f.name)
  const name = uniqueFieldName(normaliseFieldName(kind), names)
  const label = fieldKindLabel(kind)
  const field: FormField = { name, kind, label }
  if (needsOptions(kind)) {
    field.options = [{ value: 'option_1', label: 'Option 1' }]
  }
  if (kind === 'file') field.accept = 'documents'
  if (kind === 'statement') field.text = label
  return field
}

/* ------------------------------------------------------------- reducers --- */

export const MAX_FIELDS_REACHED = (limit: number) => `A form may hold at most ${limit} questions.`

export function addField(
  fields: readonly FormField[],
  kind: FormFieldKind,
  formId: string,
): FormField[] {
  return [...fields, blankField(kind, { formId, existing: fields })]
}

export function removeField(fields: readonly FormField[], name: string): FormField[] {
  return fields.filter((f) => f.name !== name)
}

/** Moves the field at `from` to `to`, clamped — a no-op past either end,
 *  matching `ReferencesField.tsx`'s `move`. */
export function moveField(fields: readonly FormField[], from: number, to: number): FormField[] {
  if (to < 0 || to >= fields.length || from === to) return [...fields]
  const next = [...fields]
  const [moved] = next.splice(from, 1)
  if (moved) next.splice(to, 0, moved)
  return next
}

/** Replaces the field currently named `name` with `next` — the one place a
 *  rename, a label edit, or an option change all funnel through, so there is
 *  one reducer to keep the array's order stable rather than three. */
export function updateField(
  fields: readonly FormField[],
  name: string,
  next: FormField,
): FormField[] {
  return fields.map((f) => (f.name === name ? next : f))
}

/* ------------------------------------------------------------ options --- */

export function addOption(field: FormField): FormField {
  const options = field.options ?? []
  const values = options.map((o) => o.value)
  const value = uniqueFieldName(`option_${options.length + 1}`, values)
  return { ...field, options: [...options, { value, label: `Option ${options.length + 1}` }] }
}

export function removeOption(field: FormField, value: string): FormField {
  return { ...field, options: (field.options ?? []).filter((o) => o.value !== value) }
}

export function updateOption(field: FormField, value: string, next: FormFieldOption): FormField {
  return { ...field, options: (field.options ?? []).map((o) => (o.value === value ? next : o)) }
}

/* -------------------------------------------------------------- locale --- */

/** The three keys a field's own prose can be translated under
 *  (`FormFieldI18n`; options are keyed separately, by value). */
export type TranslatableKey = 'label' | 'help' | 'placeholder'

/**
 * One string, in whichever locale is active. `source` is the render's source
 * locale (`LocaleConfig.default`) — editing it writes the base field, exactly
 * as `inspector-model.ts`'s `'source'` field mode does for a document; editing
 * anything else writes `i18n[locale]`, unfilled where nothing has been typed
 * (`inspector-model.ts`'s `'translate'` mode: never pre-filled with the
 * fallback, or "untranslated" becomes unreachable).
 */
export function fieldText(
  field: FormField,
  key: TranslatableKey,
  locale: string,
  source: string,
): string {
  if (locale === source) return field[key] ?? ''
  return field.i18n?.[locale]?.[key] ?? ''
}

/** The inverse of `fieldText`. An empty translation clears the key (and the
 *  locale entry, once nothing is left in it) rather than storing `''` — the
 *  same "hole, not a stored emptiness" rule `validateFieldI18n` reads back
 *  under, so a cleared translation actually falls through to the source. */
export function withFieldText(
  field: FormField,
  key: TranslatableKey,
  value: string,
  locale: string,
  source: string,
): FormField {
  if (locale !== source) {
    return { ...field, i18n: setI18nKey(field.i18n, locale, key, value) }
  }
  // `label` is the one of the three that is required, never optional
  // (`validateFormFields` throws on an empty one) — so the source write for it
  // always sets the string, empty or not, rather than deleting the key the way
  // `help` and `placeholder` do.
  if (key === 'label') return { ...field, label: value }
  if (key === 'help') {
    const next = { ...field }
    if (value === '') {
      delete next.help
      return next
    }
    return { ...next, help: value }
  }
  const next = { ...field }
  if (value === '') {
    delete next.placeholder
    return next
  }
  return { ...next, placeholder: value }
}

export function optionLabel(
  field: FormField,
  value: string,
  locale: string,
  source: string,
): string {
  if (locale === source) return field.options?.find((o) => o.value === value)?.label ?? ''
  return field.i18n?.[locale]?.options?.[value] ?? ''
}

export function withOptionLabel(
  field: FormField,
  value: string,
  label: string,
  locale: string,
  source: string,
): FormField {
  if (locale === source) return updateOption(field, value, { value, label })
  const current = field.i18n?.[locale]?.options ?? {}
  const options = { ...current }
  if (label === '') delete options[value]
  else options[value] = label
  const entry: FormFieldI18n = { ...field.i18n?.[locale] }
  if (Object.keys(options).length > 0) entry.options = options
  else delete entry.options
  return { ...field, i18n: replaceI18nEntry(field.i18n, locale, entry) }
}

function setI18nKey(
  i18n: Record<string, FormFieldI18n> | undefined,
  locale: string,
  key: TranslatableKey,
  value: string,
): Record<string, FormFieldI18n> | undefined {
  const entry: FormFieldI18n = { ...i18n?.[locale] }
  if (value === '') delete entry[key]
  else entry[key] = value
  return replaceI18nEntry(i18n, locale, entry)
}

/** Writes `entry` under `locale`, dropping the whole locale key once it holds
 *  nothing — an `i18n` map with an empty object under a locale is a hole a
 *  later reader (`translate()` in `server/forms.ts`) would have to learn to
 *  ignore twice. */
function replaceI18nEntry(
  i18n: Record<string, FormFieldI18n> | undefined,
  locale: string,
  entry: FormFieldI18n,
): Record<string, FormFieldI18n> | undefined {
  const next = { ...i18n }
  if (Object.keys(entry).length > 0) next[locale] = entry
  else delete next[locale]
  return Object.keys(next).length > 0 ? next : undefined
}

/* ---------------------------------------------------------- closesAt --- */

/** `closesAt` as `<input type="datetime-local">` wants it — local time, no
 *  timezone — or `''` for no closing date at all. */
export function closesAtInputValue(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The inverse. `''` is "no closing date", not "midnight of the epoch" — the
 *  distinction `FormPatchBody.closesAt`'s optional-and-nullable pair exists
 *  for (absent leaves it alone, `null` clears it; this screen always sends
 *  one or the other, never absent, since the field is always shown). */
export function closesAtFromInput(value: string): number | null {
  if (value.trim() === '') return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
