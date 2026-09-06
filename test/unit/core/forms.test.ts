import { describe, expect, it } from 'vitest'
import {
  FILE_ACCEPT,
  formSlug,
  honeypotName,
  MAX_FORM_FIELDS,
  RESERVED_PREFIX,
  shapeOf,
  validateFormFields,
} from '../../../src/core/forms'
import type { FormField } from '../../../src/core/forms'

/**
 * `core/forms.ts`'s pure vocabulary (`docs/specs/content-model/forms.md`
 * architecture decisions 2, 3, 7, 9, 13). Phase 1 leaves the field kind
 * resolving to `null` — this is what pins the vocabulary itself, ahead of
 * anything that stores or renders it.
 */

describe('formSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(formSlug('Contact Us')).toBe('contact-us')
  })

  it('strips leading and trailing separators', () => {
    expect(formSlug('  --Contact--  ')).toBe('contact')
  })

  it('falls back to "form", not "untitled" (a form is not a page)', () => {
    expect(formSlug('')).toBe('form')
    expect(formSlug('!!!')).toBe('form')
  })

  it('bounds the length the same way story.ts slugify does', () => {
    expect(formSlug('a'.repeat(200)).length).toBe(64)
  })
})

describe('validateFormFields', () => {
  const textField = { name: 'email', kind: 'text', label: 'Email' }

  it('accepts a well-formed field, carrying only what was declared', () => {
    expect(validateFormFields([textField])).toEqual([
      { name: 'email', kind: 'text', label: 'Email' },
    ])
  })

  it('refuses a non-array', () => {
    expect(() => validateFormFields('nope')).toThrow()
    expect(() => validateFormFields(null)).toThrow()
    expect(() => validateFormFields({})).toThrow()
  })

  it(`refuses more than MAX_FORM_FIELDS (${MAX_FORM_FIELDS})`, () => {
    const many = Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({
      name: `f${i}`,
      kind: 'text',
      label: `F${i}`,
    }))
    expect(() => validateFormFields(many)).toThrow()
  })

  it('accepts exactly MAX_FORM_FIELDS', () => {
    const many = Array.from({ length: MAX_FORM_FIELDS }, (_, i) => ({
      name: `f${i}`,
      kind: 'text',
      label: `F${i}`,
    }))
    expect(validateFormFields(many)).toHaveLength(MAX_FORM_FIELDS)
  })

  // Screened on read, like `parseScopes` (roles.ts:83): a kind this build does
  // not recognise is dropped rather than thrown on, so removing a field kind
  // from the code narrows a stored form instead of breaking it.
  it('drops a field of an unrecognised kind rather than throwing', () => {
    expect(
      validateFormFields([textField, { name: 'ranking', kind: 'nps-score', label: 'Score' }]),
    ).toEqual([{ name: 'email', kind: 'text', label: 'Email' }])
  })

  it('refuses an invalid or empty name', () => {
    expect(() => validateFormFields([{ name: '', kind: 'text', label: 'X' }])).toThrow()
    expect(() => validateFormFields([{ name: 'Email', kind: 'text', label: 'X' }])).toThrow()
    expect(() => validateFormFields([{ name: '1st', kind: 'text', label: 'X' }])).toThrow()
    expect(() => validateFormFields([{ kind: 'text', label: 'X' }])).toThrow()
  })

  it(`refuses a name starting with the reserved prefix "${RESERVED_PREFIX}"`, () => {
    expect(() => validateFormFields([{ name: '_folio_page', kind: 'text', label: 'X' }])).toThrow()
  })

  it('refuses two fields sharing a name', () => {
    expect(() =>
      validateFormFields([textField, { name: 'email', kind: 'textarea', label: 'Email again' }]),
    ).toThrow()
  })

  it('refuses a field with no label', () => {
    expect(() => validateFormFields([{ name: 'email', kind: 'text' }])).toThrow()
    expect(() => validateFormFields([{ name: 'email', kind: 'text', label: '' }])).toThrow()
  })

  it('carries help, placeholder, required, min and max through when present', () => {
    const [field] = validateFormFields([
      {
        name: 'age',
        kind: 'number',
        label: 'Age',
        help: 'In years',
        placeholder: '18',
        required: true,
        min: 0,
        max: 120,
      },
    ]) as [FormField]
    expect(field).toEqual({
      name: 'age',
      kind: 'number',
      label: 'Age',
      help: 'In years',
      placeholder: '18',
      required: true,
      min: 0,
      max: 120,
    })
  })

  describe('options', () => {
    for (const kind of ['select', 'radio', 'checkboxes']) {
      it(`requires at least one option for "${kind}"`, () => {
        expect(() => validateFormFields([{ name: 'x', kind, label: 'X', options: [] }])).toThrow()
        expect(() => validateFormFields([{ name: 'x', kind, label: 'X' }])).toThrow()
      })
    }

    it('refuses a duplicate option value', () => {
      expect(() =>
        validateFormFields([
          {
            name: 'x',
            kind: 'select',
            label: 'X',
            options: [
              { value: 'a', label: 'A' },
              { value: 'a', label: 'A again' },
            ],
          },
        ]),
      ).toThrow()
    })

    it('refuses an option with no value, and defaults a missing label to the value', () => {
      expect(() =>
        validateFormFields([
          { name: 'x', kind: 'select', label: 'X', options: [{ label: 'No value' }] },
        ]),
      ).toThrow()

      const [field] = validateFormFields([
        { name: 'x', kind: 'select', label: 'X', options: [{ value: 'yes' }] },
      ]) as [FormField]
      expect(field.options).toEqual([{ value: 'yes', label: 'yes' }])
    })

    it('does not attach options to a kind that does not use them', () => {
      const [field] = validateFormFields([
        { name: 'x', kind: 'text', label: 'X', options: [{ value: 'a', label: 'A' }] },
      ]) as [FormField]
      expect(field.options).toBeUndefined()
    })
  })

  describe('file', () => {
    it('requires a valid accept', () => {
      expect(() => validateFormFields([{ name: 'cv', kind: 'file', label: 'CV' }])).toThrow()
      expect(() =>
        validateFormFields([{ name: 'cv', kind: 'file', label: 'CV', accept: 'exe' }]),
      ).toThrow()
    })

    it('accepts every FILE_ACCEPT key', () => {
      for (const accept of Object.keys(FILE_ACCEPT)) {
        const [field] = validateFormFields([{ name: 'cv', kind: 'file', label: 'CV', accept }]) as [
          FormField,
        ]
        expect(field.accept).toBe(accept)
      }
    })

    it('refuses a non-positive or non-finite maxBytes', () => {
      expect(() =>
        validateFormFields([
          { name: 'cv', kind: 'file', label: 'CV', accept: 'documents', maxBytes: 0 },
        ]),
      ).toThrow()
      expect(() =>
        validateFormFields([
          { name: 'cv', kind: 'file', label: 'CV', accept: 'documents', maxBytes: Number.NaN },
        ]),
      ).toThrow()
    })
  })

  it('defaults a hidden field\'s value to "" when absent', () => {
    const [field] = validateFormFields([{ name: 'src', kind: 'hidden', label: 'Source' }]) as [
      FormField,
    ]
    expect(field.value).toBe('')
  })

  it('requires non-empty text for a statement field', () => {
    expect(() =>
      validateFormFields([{ name: 'intro', kind: 'statement', label: 'Intro' }]),
    ).toThrow()
    const [field] = validateFormFields([
      { name: 'intro', kind: 'statement', label: 'Intro', text: 'Please answer honestly.' },
    ]) as [FormField]
    expect(field.text).toBe('Please answer honestly.')
  })

  describe('pattern', () => {
    it('compiles and keeps a valid pattern', () => {
      const [field] = validateFormFields([
        { name: 'zip', kind: 'text', label: 'ZIP', pattern: '^[0-9]{5}$' },
      ]) as [FormField]
      expect(field.pattern).toBe('^[0-9]{5}$')
    })

    it('refuses a pattern that does not compile as a RegExp', () => {
      expect(() =>
        validateFormFields([{ name: 'zip', kind: 'text', label: 'ZIP', pattern: '(' }]),
      ).toThrow()
    })

    it('refuses a pattern past the length cap, before ever compiling it', () => {
      expect(() =>
        validateFormFields([
          { name: 'zip', kind: 'text', label: 'ZIP', pattern: '.'.repeat(1000) },
        ]),
      ).toThrow()
    })
  })

  describe('i18n', () => {
    it('keeps a well-formed translation', () => {
      const [field] = validateFormFields([
        {
          name: 'email',
          kind: 'text',
          label: 'Email',
          i18n: { fr: { label: 'Courriel', options: { yes: 'Oui' } } },
        },
      ]) as [FormField]
      expect(field.i18n).toEqual({ fr: { label: 'Courriel', options: { yes: 'Oui' } } })
    })

    it('drops a malformed locale entry rather than throwing (best-effort, like a missing translation)', () => {
      const [field] = validateFormFields([
        {
          name: 'email',
          kind: 'text',
          label: 'Email',
          i18n: { fr: 'not an object', de: { label: 'E-Mail' } },
        },
      ]) as [FormField]
      expect(field.i18n).toEqual({ de: { label: 'E-Mail' } })
    })

    it('omits i18n entirely when nothing survived screening', () => {
      const [field] = validateFormFields([
        { name: 'email', kind: 'text', label: 'Email', i18n: { fr: 'nope' } },
      ]) as [FormField]
      expect(field.i18n).toBeUndefined()
    })
  })
})

describe('shapeOf', () => {
  const base: FormField = { name: 'email', kind: 'text', label: 'Email' }

  it('is stable for the identical field list', () => {
    expect(shapeOf([base])).toBe(shapeOf([{ ...base }]))
  })

  it('does NOT change for a label, help, placeholder or translation edit', () => {
    const before = shapeOf([base])
    const after = shapeOf([
      { ...base, label: 'Your email', help: 'We will reply here', placeholder: 'jane@example.com' },
    ])
    expect(after).toBe(before)
  })

  it('changes when a field is added', () => {
    expect(shapeOf([base, { name: 'name', kind: 'text', label: 'Name' }])).not.toBe(shapeOf([base]))
  })

  it('changes when a field is removed', () => {
    expect(shapeOf([base])).not.toBe(shapeOf([]))
  })

  it('changes when a field is renamed', () => {
    expect(shapeOf([{ ...base, name: 'contact_email' }])).not.toBe(shapeOf([base]))
  })

  it('changes when a field is retyped', () => {
    expect(shapeOf([{ ...base, kind: 'email' }])).not.toBe(shapeOf([base]))
  })

  it('changes when required flips either way', () => {
    const required = shapeOf([{ ...base, required: true }])
    const notRequired = shapeOf([{ ...base, required: false }])
    const absent = shapeOf([base])
    expect(required).not.toBe(notRequired)
    expect(notRequired).toBe(absent) // absent and explicit-false are the same shape
  })

  it('changes when an option value changes, but not when only its label does', () => {
    const select: FormField = {
      name: 'plan',
      kind: 'select',
      label: 'Plan',
      options: [{ value: 'a', label: 'Plan A' }],
    }
    const relabelled: FormField = { ...select, options: [{ value: 'a', label: 'Renamed plan A' }] }
    const revalued: FormField = { ...select, options: [{ value: 'b', label: 'Plan A' }] }

    expect(shapeOf([relabelled])).toBe(shapeOf([select]))
    expect(shapeOf([revalued])).not.toBe(shapeOf([select]))
  })
})

describe('honeypotName', () => {
  it('is deterministic for the same form id', () => {
    expect(honeypotName('frm_abc123abc123', [])).toBe(honeypotName('frm_abc123abc123', []))
  })

  it('never returns a name in `taken`, unless every pool name is taken', () => {
    // Run it against several ids so the assertion is not one lucky index.
    const ids = ['frm_a', 'frm_b', 'frm_c', 'frm_d', 'frm_e']
    const taken = ['company_website', 'fax', 'url_confirm']
    for (const id of ids) {
      expect(taken).not.toContain(honeypotName(id, taken))
    }
  })

  it('falls back to the fixed pool when every name in it is somehow taken', () => {
    const everything = [
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
    expect(() => honeypotName('frm_x', everything)).not.toThrow()
    expect(typeof honeypotName('frm_x', everything)).toBe('string')
  })
})
