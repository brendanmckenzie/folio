import { describe, expect, it } from 'vitest'
import { honeypotName } from '../../../src/core/forms'
import {
  BLANK_FORM_DRAFT,
  createFormBody,
  formDraftRefusal,
  formStatus,
  type FormRow,
  questionsLabel,
  responsesLabel,
  statusHint,
  updatedLabel,
} from '../../../src/admin/ui/screens/forms-model'
import {
  addField,
  addOption,
  blankField,
  closesAtFromInput,
  closesAtInputValue,
  fieldKindLabel,
  FIELD_KINDS,
  fieldNameRefusal,
  fieldText,
  moveField,
  needsOptions,
  normaliseFieldName,
  optionLabel,
  removeField,
  removeOption,
  renameWarning,
  showLocaleSwitcher,
  uniqueFieldName,
  updateField,
  updateOption,
  withFieldText,
  withOptionLabel,
} from '../../../src/admin/ui/screens/form-model'

/**
 * The pure arithmetic behind all three Forms screens
 * (`docs/specs/content-model/forms.md` phase 6) — the list's status and count
 * labels, the "new form" dialog's refusal, and the builder's field reducers,
 * naming rules and per-locale text. No admin test mounts a component
 * (`vitest.config.ts`), so this is where all of it is pinned.
 */

const row = (over: Partial<FormRow> = {}): FormRow => ({
  id: 'frm_a',
  name: 'contact',
  label: 'Contact',
  version: 1,
  open: true,
  closesAt: null,
  createdAt: 0,
  updatedAt: 0,
  questions: 3,
  ...over,
})

/* ------------------------------------------------------------- forms list --- */

describe('formStatus', () => {
  it('is open with no closing date', () => {
    expect(formStatus(row({ open: true, closesAt: null }))).toBe('open')
  })

  it('is open while the closing date is still ahead', () => {
    expect(formStatus(row({ open: true, closesAt: 2000 }), 1000)).toBe('open')
  })

  it('is closed once the closing date has passed, even though the switch is still on', () => {
    expect(formStatus(row({ open: true, closesAt: 1000 }), 2000)).toBe('closed')
  })

  it('is closed the instant the closing date is reached', () => {
    // `<=`, matching `server/forms.ts`'s `isOpen`: the boundary itself is closed.
    expect(formStatus(row({ open: true, closesAt: 1000 }), 1000)).toBe('closed')
  })

  it('is closed by the switch alone, whatever the clock says', () => {
    expect(formStatus(row({ open: false, closesAt: null }))).toBe('closed')
    expect(formStatus(row({ open: false, closesAt: 5000 }), 0)).toBe('closed')
  })
})

describe('statusHint', () => {
  it('names the switch when it is off', () => {
    expect(statusHint(row({ open: false }))).toMatch(/switched off/i)
  })

  it('names the closing date once it has passed', () => {
    expect(statusHint(row({ open: true, closesAt: 1000 }), 2000)).toMatch(/closed automatically/i)
  })

  it('names the future closing date while still open', () => {
    expect(statusHint(row({ open: true, closesAt: 2000 }), 1000)).toMatch(/closes automatically/i)
  })

  it('says plainly that it is accepting submissions with no closing date at all', () => {
    expect(statusHint(row({ open: true, closesAt: null }))).toBe('Accepting submissions.')
  })
})

describe('questionsLabel', () => {
  it('is singular for exactly one question', () => {
    expect(questionsLabel(row({ questions: 1 }))).toBe('1 question')
  })

  it('is plural otherwise, including zero', () => {
    expect(questionsLabel(row({ questions: 0 }))).toBe('0 questions')
    expect(questionsLabel(row({ questions: 5 }))).toBe('5 questions')
  })
})

describe('responsesLabel', () => {
  it('is an em dash when the caller never asked ?counts=1', () => {
    expect(responsesLabel(row({ responses: undefined }))).toBe('—')
  })

  it('is an honest zero once asked, distinct from not having asked', () => {
    expect(responsesLabel(row({ responses: 0 }))).toBe('0 responses')
  })

  it('is singular for exactly one', () => {
    expect(responsesLabel(row({ responses: 1 }))).toBe('1 response')
  })
})

describe('updatedLabel', () => {
  it('reads "just now" for a row saved this instant', () => {
    expect(updatedLabel(row({ updatedAt: 1_000_000 }), 1_000_000)).toBe('just now')
  })

  it('has no draft state to prefer, unlike a story — updatedAt is the whole answer', () => {
    const hourAgo = 1_000_000 - 60 * 60 * 1000
    expect(updatedLabel(row({ updatedAt: hourAgo }), 1_000_000)).toBe('1h ago')
  })
})

describe('formDraftRefusal', () => {
  it('refuses a blank label', () => {
    expect(formDraftRefusal(BLANK_FORM_DRAFT)).toMatch(/label/i)
  })

  it('refuses a whitespace-only label the same way', () => {
    expect(formDraftRefusal({ label: '   ', name: '' })).toMatch(/label/i)
  })

  it('passes a real label, whatever the name field holds', () => {
    expect(formDraftRefusal({ label: 'Contact us', name: '' })).toBeNull()
    expect(formDraftRefusal({ label: 'Contact us', name: 'contact' })).toBeNull()
  })
})

describe('createFormBody', () => {
  it('trims the label and omits name entirely when it is blank', () => {
    expect(createFormBody({ label: '  Contact us  ', name: '  ' })).toEqual({
      label: 'Contact us',
    })
  })

  it('carries a typed name along, trimmed, so it never shadows the derived slug silently', () => {
    expect(createFormBody({ label: 'Contact us', name: '  my-contact  ' })).toEqual({
      label: 'Contact us',
      name: 'my-contact',
    })
  })
})

/* --------------------------------------------------------------- the menu --- */

describe('FIELD_KINDS', () => {
  it('names all thirteen kinds core/forms.ts declares, once each', () => {
    const kinds = FIELD_KINDS.map((k) => k.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds.sort()).toEqual(
      [
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
      ].sort(),
    )
  })

  it('gives fieldKindLabel the same label the menu itself offers', () => {
    for (const k of FIELD_KINDS) {
      expect(fieldKindLabel(k.kind)).toBe(k.label)
    }
  })
})

describe('needsOptions', () => {
  it('is true only for select, radio and checkboxes', () => {
    expect(needsOptions('select')).toBe(true)
    expect(needsOptions('radio')).toBe(true)
    expect(needsOptions('checkboxes')).toBe(true)
    for (const kind of FIELD_KINDS.map((k) => k.kind).filter(
      (k) => k !== 'select' && k !== 'radio' && k !== 'checkboxes',
    )) {
      expect(needsOptions(kind), kind).toBe(false)
    }
  })
})

describe('showLocaleSwitcher', () => {
  it('is hidden with no locales config at all', () => {
    expect(showLocaleSwitcher(undefined)).toBe(false)
  })

  it('is hidden with exactly one available locale — nothing to switch to', () => {
    expect(
      showLocaleSwitcher({ default: 'en', available: [{ code: 'en', label: 'English' }] }),
    ).toBe(false)
  })

  it('is shown once a second locale is available', () => {
    expect(
      showLocaleSwitcher({
        default: 'en',
        available: [
          { code: 'en', label: 'English' },
          { code: 'fr', label: 'Français' },
        ],
      }),
    ).toBe(true)
  })
})

/* ---------------------------------------------------------------- naming --- */

describe('normaliseFieldName', () => {
  it('lowercases and joins words with underscores', () => {
    expect(normaliseFieldName('First Name')).toBe('first_name')
  })

  it('strips leading and trailing separators', () => {
    expect(normaliseFieldName('  --Email--  ')).toBe('email')
  })

  it('falls back to "field" for nothing at all', () => {
    expect(normaliseFieldName('')).toBe('field')
    expect(normaliseFieldName('!!!')).toBe('field')
  })

  it('prefixes a name that would otherwise start with a digit', () => {
    expect(normaliseFieldName('2nd choice')).toBe('f_2nd_choice')
  })

  it('is always 64 characters or fewer', () => {
    expect(normaliseFieldName('x'.repeat(200)).length).toBeLessThanOrEqual(64)
  })

  it('drops non-ASCII letters rather than carrying them through unusably', () => {
    // Deliberately narrower than `formSlug`'s unicode-aware charset: this is
    // an HTML input `name` and a CSV column header, not a path segment.
    expect(normaliseFieldName('café')).toBe('caf')
  })
})

describe('uniqueFieldName', () => {
  it('leaves an untaken name alone', () => {
    expect(uniqueFieldName('email', ['name'])).toBe('email')
  })

  it('disambiguates a taken one with _2, _3, …', () => {
    expect(uniqueFieldName('email', ['email'])).toBe('email_2')
    expect(uniqueFieldName('email', ['email', 'email_2'])).toBe('email_3')
  })
})

describe('fieldNameRefusal', () => {
  const ctx = { formId: 'frm_a', otherNames: ['email', 'message'] }

  it('accepts a name that collides with nothing', () => {
    expect(fieldNameRefusal('phone', ctx)).toBeNull()
  })

  it('refuses the wrong charset — unreachable through the UI, since normaliseFieldName never produces one', () => {
    expect(fieldNameRefusal('First Name', ctx)).toMatch(/lowercase/i)
  })

  it('refuses a name starting with the reserved prefix — via the charset check, since NAME_PATTERN already requires starting with a-z', () => {
    // The reserved-prefix branch in both this function and `validateOneField`
    // (`core/forms.ts`) is unreachable on its own: a string cannot both start
    // with `[a-z]` (what the charset regex demands) and start with `_` (what
    // `RESERVED_PREFIX` is). Kept for symmetry with the server's own check
    // rather than as a distinct, independently reachable code path — what
    // matters is that a name in this namespace is refused, not which message
    // says so.
    expect(fieldNameRefusal('_folio_page', ctx)).not.toBeNull()
  })

  it('refuses a duplicate of another question on the same form', () => {
    expect(fieldNameRefusal('email', ctx)).toMatch(/already uses this name/i)
  })

  it("refuses a collision with this form's own honeypot (decision 9)", () => {
    const decoy = honeypotName(ctx.formId, ctx.otherNames)
    expect(fieldNameRefusal(decoy, ctx)).toMatch(/spam trap/i)
  })
})

describe('renameWarning', () => {
  it('is silent when the form has no responses yet', () => {
    expect(renameWarning(false)).toBeNull()
  })

  it('names the split once there are responses to split', () => {
    const warning = renameWarning(true)
    expect(warning).toMatch(/responses/i)
    expect(warning).toMatch(/csv/i)
  })
})

/* ------------------------------------------------------------ blank field --- */

describe('blankField', () => {
  it('names a fresh field after its own kind, uniquely', () => {
    const a = blankField('text', { formId: 'frm_a', existing: [] })
    expect(a.name).toBe('text')
    const b = blankField('text', { formId: 'frm_a', existing: [a] })
    expect(b.name).toBe('text_2')
  })

  it('pre-fills exactly one option for an option kind, so the save does not throw', () => {
    const field = blankField('select', { formId: 'frm_a', existing: [] })
    expect(field.options).toHaveLength(1)
  })

  it('defaults a file question to "documents"', () => {
    expect(blankField('file', { formId: 'frm_a', existing: [] }).accept).toBe('documents')
  })

  it('gives a statement question text to render, so it does not throw as empty', () => {
    const field = blankField('statement', { formId: 'frm_a', existing: [] })
    expect(field.text).toBeTruthy()
  })

  it('leaves a plain kind with no options, accept or text at all', () => {
    const field = blankField('email', { formId: 'frm_a', existing: [] })
    expect(field.options).toBeUndefined()
    expect(field.accept).toBeUndefined()
    expect(field.text).toBeUndefined()
  })
})

/* ------------------------------------------------------------- reducers --- */

describe('addField / removeField', () => {
  it('appends and removes by name', () => {
    const one = addField([], 'text', 'frm_a')
    expect(one).toHaveLength(1)
    const two = addField(one, 'email', 'frm_a')
    expect(two.map((f) => f.name)).toEqual(['text', 'email'])
    expect(removeField(two, 'text').map((f) => f.name)).toEqual(['email'])
  })

  it('names two fields of the same kind uniquely rather than colliding', () => {
    const one = addField([], 'text', 'frm_a')
    const two = addField(one, 'text', 'frm_a')
    expect(two.map((f) => f.name)).toEqual(['text', 'text_2'])
  })
})

describe('moveField', () => {
  const fields = [
    { name: 'a', kind: 'text', label: 'A' },
    { name: 'b', kind: 'text', label: 'B' },
    { name: 'c', kind: 'text', label: 'C' },
  ] as const

  it('moves an entry to a new position', () => {
    expect(moveField(fields, 0, 2).map((f) => f.name)).toEqual(['b', 'c', 'a'])
  })

  it('is a no-op past either end, matching ReferencesField.tsx', () => {
    expect(moveField(fields, 0, -1).map((f) => f.name)).toEqual(['a', 'b', 'c'])
    expect(moveField(fields, 2, 3).map((f) => f.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('updateField', () => {
  it('replaces the field matching the given name and nothing else', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B' },
    ] as const
    const next = updateField(fields, 'a', { name: 'a', kind: 'text', label: 'Renamed' })
    expect(next[0]?.label).toBe('Renamed')
    expect(next[1]).toBe(fields[1])
  })
})

describe('addOption / removeOption / updateOption', () => {
  it('adds an option with a unique value and an incrementing label', () => {
    const field = { name: 'q', kind: 'select', label: 'Q', options: [] } as const
    const one = addOption(field)
    expect(one.options).toEqual([{ value: 'option_1', label: 'Option 1' }])
    const two = addOption(one)
    expect(two.options?.[1]).toEqual({ value: 'option_2', label: 'Option 2' })
  })

  it('removes by value', () => {
    const field = {
      name: 'q',
      kind: 'select',
      label: 'Q',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    } as const
    expect(removeOption(field, 'a').options).toEqual([{ value: 'b', label: 'B' }])
  })

  it('updates one option in place, leaving the others untouched', () => {
    const field = {
      name: 'q',
      kind: 'select',
      label: 'Q',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    } as const
    const next = updateOption(field, 'a', { value: 'a', label: 'Renamed' })
    expect(next.options).toEqual([
      { value: 'a', label: 'Renamed' },
      { value: 'b', label: 'B' },
    ])
  })
})

/* -------------------------------------------------------------- locale --- */

describe('fieldText / withFieldText', () => {
  const source = 'en'

  it('reads and writes the base field in the source locale', () => {
    const field = { name: 'q', kind: 'text', label: 'Question' } as const
    expect(fieldText(field, 'label', source, source)).toBe('Question')
    expect(withFieldText(field, 'label', 'Renamed', source, source).label).toBe('Renamed')
  })

  it('is empty for an untranslated field, never falling back to the source', () => {
    const field = { name: 'q', kind: 'text', label: 'Question' } as const
    expect(fieldText(field, 'label', 'fr', source)).toBe('')
  })

  it('writes a translation into i18n rather than the base field', () => {
    const field = { name: 'q', kind: 'text', label: 'Question' } as const
    const next = withFieldText(field, 'label', 'Question (fr)', 'fr', source)
    expect(next.label).toBe('Question')
    expect(next.i18n?.fr?.label).toBe('Question (fr)')
  })

  it('never deletes a required label even when cleared to empty', () => {
    const field = { name: 'q', kind: 'text', label: 'Question' } as const
    const next = withFieldText(field, 'label', '', source, source)
    expect(next.label).toBe('')
    expect('label' in next).toBe(true)
  })

  it('deletes an optional key (help) once cleared, rather than storing an empty string', () => {
    const field = { name: 'q', kind: 'text', label: 'Q', help: 'Some help' } as const
    const next = withFieldText(field, 'help', '', source, source)
    expect(next.help).toBeUndefined()
    expect('help' in next).toBe(false)
  })

  it('clears an i18n translation and drops the empty locale entry entirely', () => {
    const field = {
      name: 'q',
      kind: 'text',
      label: 'Question',
      i18n: { fr: { label: 'Question (fr)' } },
    } as const
    const next = withFieldText(field, 'label', '', 'fr', source)
    expect(next.i18n).toBeUndefined()
  })

  it('keeps a sibling i18n key when only one is cleared', () => {
    const field = {
      name: 'q',
      kind: 'text',
      label: 'Question',
      i18n: { fr: { label: 'Question (fr)', help: 'Aide (fr)' } },
    } as const
    const next = withFieldText(field, 'label', '', 'fr', source)
    expect(next.i18n?.fr).toEqual({ help: 'Aide (fr)' })
  })
})

describe('optionLabel / withOptionLabel', () => {
  const source = 'en'
  const field = {
    name: 'q',
    kind: 'select',
    label: 'Q',
    options: [{ value: 'a', label: 'A' }],
  } as const

  it('reads and writes the base option label in the source locale', () => {
    expect(optionLabel(field, 'a', source, source)).toBe('A')
    const next = withOptionLabel(field, 'a', 'Renamed', source, source)
    expect(next.options?.[0]?.label).toBe('Renamed')
  })

  it('is empty for an untranslated option', () => {
    expect(optionLabel(field, 'a', 'fr', source)).toBe('')
  })

  it('writes a translated option label into i18n, leaving the base option untouched', () => {
    const next = withOptionLabel(field, 'a', 'A (fr)', 'fr', source)
    expect(next.options).toEqual(field.options)
    expect(next.i18n?.fr?.options).toEqual({ a: 'A (fr)' })
  })

  it('clears a translated option label and drops the empty structure entirely', () => {
    const translated = withOptionLabel(field, 'a', 'A (fr)', 'fr', source)
    const cleared = withOptionLabel(translated, 'a', '', 'fr', source)
    expect(cleared.i18n).toBeUndefined()
  })
})

/* ---------------------------------------------------------- closesAt --- */

describe('closesAtInputValue / closesAtFromInput', () => {
  it('is empty for no closing date, and empty input clears it back to null', () => {
    expect(closesAtInputValue(null)).toBe('')
    expect(closesAtFromInput('')).toBeNull()
    expect(closesAtFromInput('   ')).toBeNull()
  })

  it('round-trips a minute-aligned timestamp', () => {
    const ms = new Date(2026, 0, 15, 10, 30, 0, 0).getTime()
    const value = closesAtInputValue(ms)
    expect(closesAtFromInput(value)).toBe(ms)
  })

  it('formats as the datetime-local shape, zero-padded', () => {
    const ms = new Date(2026, 8, 5, 9, 5, 0, 0).getTime()
    expect(closesAtInputValue(ms)).toBe('2026-09-05T09:05')
  })
})
