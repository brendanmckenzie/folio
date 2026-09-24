import { describe, expect, it } from 'vitest'
import { honeypotName } from '../../../src/core/forms'
import type { FormField } from '../../../src/core/forms'
import {
  BLANK_FORM_DRAFT,
  createFormBody,
  formDraftRefusal,
  formStatus,
  type FormRow,
  matchesForm,
  questionsLabel,
  responsesLabel,
  statusHint,
  updatedLabel,
} from '../../../src/admin/ui/screens/forms-model'
import {
  addField,
  addOption,
  blankField,
  canJoinPrevious,
  canMoveField,
  closesAtFromInput,
  closesAtInputValue,
  fieldKindLabel,
  FIELD_KINDS,
  fieldNameRefusal,
  fieldRows,
  fieldText,
  moveField,
  moveFieldStep,
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
  withBeside,
  withFieldText,
  withGrow,
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

/**
 * The form picker's filter box (`fields/FormField.tsx`). Client-side because
 * `GET {base}/api/forms` takes no `q` at all — there is nothing to send a query
 * to, which is the one case in this admin where filtering in the browser is the
 * honest answer rather than the lazy one.
 */
describe('matchesForm', () => {
  it('matches the label and the slug, because an editor may know either', () => {
    const contact = row({ label: 'Contact us', name: 'contact-us' })
    expect(matchesForm(contact, 'contact')).toBe(true)
    expect(matchesForm(contact, 'us')).toBe(true)
    expect(matchesForm(contact, 'contact-us')).toBe(true)
    expect(matchesForm(contact, 'careers')).toBe(false)
  })

  it('ignores case and surrounding space, which is what a typed filter carries', () => {
    const row_ = row({ label: 'Newsletter', name: 'newsletter' })
    expect(matchesForm(row_, 'NEWS')).toBe(true)
    expect(matchesForm(row_, '  news  ')).toBe(true)
  })

  it('offers everything for an empty filter, including one that is all space', () => {
    expect(matchesForm(row(), '')).toBe(true)
    expect(matchesForm(row(), '   ')).toBe(true)
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

  // The doc's own risk: a move or a delete leaves a `beside` naming a
  // predecessor the array no longer has, which silently re-forms a row with
  // whoever is there instead. Both reducers detach it rather than let that
  // happen (`form-layout-approach.md`'s "the builder's one subtle reducer").
  it("clears `beside` on the question that slides into the moved one's old place", () => {
    const joined = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
      { name: 'c', kind: 'text', label: 'C' },
    ] as const
    // Moving `a` to the end leaves `b` right after `c` — without the clear,
    // `b`'s `beside` would silently join `c`'s row instead of `a`'s.
    const moved = moveField(joined, 0, 2)
    expect(moved.map((f) => f.name)).toEqual(['b', 'c', 'a'])
    expect(moved[0]?.beside).toBeUndefined()
  })

  it("clears the moved question's own `beside`, since its predecessor changed", () => {
    const joined = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
      { name: 'c', kind: 'text', label: 'C' },
    ] as const
    // `b` moves next to `c`; left alone, `beside` would join `c`'s row instead
    // of the row it actually meant to join (`a`'s, which it left).
    const moved = moveField(joined, 1, 2)
    expect(moved.map((f) => f.name)).toEqual(['a', 'c', 'b'])
    expect(moved[2]?.beside).toBeUndefined()
  })

  it('a no-op move (past either end, or from === to) leaves every `beside` alone', () => {
    const joined = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
    ] as const
    expect(moveField(joined, 0, -1)[1]?.beside).toBe(true)
    expect(moveField(joined, 0, 0)[1]?.beside).toBe(true)
  })

  // Rows-slice review, finding 1: detaching only `fields[at]` does nothing
  // when a `hidden` question lands there, because `rowsOf` treats `hidden` as
  // transparent — the real question *after* it is the one whose predecessor
  // changed, and it still joins straight across the gap.
  it('skips a `hidden` question to find the real predecessor whose `beside` must clear', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B' },
      { name: 'h', kind: 'hidden', label: 'H', value: 'x' },
      { name: 'c', kind: 'text', label: 'C', beside: true },
      { name: 'd', kind: 'text', label: 'D' },
    ] as const
    // Moving `b` to the end leaves `h` sliding into its place, with `c` right
    // after — `c`'s `beside` must clear, not `h`'s (`h` never had one).
    const result = moveField(fields, 1, 4)
    expect(result.map((f) => f.name)).toEqual(['a', 'h', 'c', 'd', 'b'])
    expect(result[2]?.beside).toBeUndefined()
  })
})

describe('removeField', () => {
  it("clears `beside` on the question that slides into the removed one's place", () => {
    const joined = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B' },
      { name: 'c', kind: 'text', label: 'C', beside: true },
    ] as const
    // Removing `b` puts `c` right after `a` — without the clear, `c` would
    // silently join a row `a` never asked to share.
    const removed = removeField(joined, 'b')
    expect(removed.map((f) => f.name)).toEqual(['a', 'c'])
    expect(removed[1]?.beside).toBeUndefined()
  })

  it('leaves everything alone when the last question is removed', () => {
    const joined = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
    ] as const
    expect(removeField(joined, 'b').map((f) => f.name)).toEqual(['a'])
    expect(removeField(joined, 'b')[0]?.beside).toBeUndefined()
  })

  it('is a no-op for a name that is not there', () => {
    const joined = [{ name: 'a', kind: 'text', label: 'A' }] as const
    expect(removeField(joined, 'nope')).toEqual(joined)
  })

  // Rows-slice review, finding 1 (confirmed by probing): `A,B,H(hidden),C*`
  // has rows A / B+C — deleting `B` used to detach whatever landed at its old
  // index, which is `H`, a question that never had a `beside` to begin with.
  // `C` kept joining straight across the gap and silently merged into `A`'s
  // row. This fails on the code before the fix (it detaches `H`, a no-op, and
  // leaves `C`'s `beside` in place).
  it('skips a `hidden` question to find the real predecessor whose `beside` must clear', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B' },
      { name: 'h', kind: 'hidden', label: 'H', value: 'x' },
      { name: 'c', kind: 'text', label: 'C', beside: true },
    ] as const
    const result = removeField(fields, 'b')
    expect(result.map((f) => f.name)).toEqual(['a', 'h', 'c'])
    expect(result[2]?.beside).toBeUndefined()
  })

  it('leaves everything alone when the removed question was itself `hidden`', () => {
    // `hidden` is transparent to `rowsOf` wherever it sits — removing one
    // changes no real question's predecessor.
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'h', kind: 'hidden', label: 'H', value: 'x' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
    ] as const
    const result = removeField(fields, 'h')
    expect(result.map((f) => f.name)).toEqual(['a', 'b'])
    expect(result[1]?.beside).toBe(true)
  })
})

/**
 * Rows-slice review, finding 2: `moveField`'s raw `(from, to)` splice can
 * land a question in the middle of a row it was never asked to join, pairing
 * it with a neighbour the editor never chose. The owner has not ruled on
 * this case; the rule this repo settled on (and `moveFieldStep` implements)
 * is in its own doc comment. These tests are every branch of that rule.
 */
describe('moveFieldStep', () => {
  const NAME = { name: 'first', kind: 'text', label: 'First' } as const
  const MIDDLE = { name: 'middle', kind: 'text', label: 'Middle', beside: true } as const
  const LAST = { name: 'last', kind: 'text', label: 'Last', beside: true } as const

  it('reorders within a row, without pulling in a question outside it', () => {
    // Name: [First][Middle][Last] — pressing "down" on First swaps it with
    // Middle; the row stays one row, just reordered.
    const fields = [NAME, MIDDLE, LAST]
    const next = moveFieldStep(fields, 0, 1)
    expect(next.map((f) => f.name)).toEqual(['middle', 'first', 'last'])
    // Middle (now first) carries no `beside`; First and Last (now 2nd/3rd)
    // both do — the row's own shape, reassigned to match position.
    expect(next[0]?.beside).toBeUndefined()
    expect(next[1]?.beside).toBe(true)
    expect(next[2]?.beside).toBe(true)
  })

  it("carries each question's own `grow` with it when reordering within a row", () => {
    const fields = [NAME, { ...MIDDLE, grow: 3 as const }, LAST]
    const moved = moveFieldStep(fields, 2, -1) // swap Last and Middle
    expect(moved.map((f) => f.name)).toEqual(['first', 'last', 'middle'])
    expect(moved[2]?.grow).toBe(3) // Middle's own share travelled with it
  })

  it('a row-first question moving up detaches from its row-mates instead of leaving position 0', () => {
    const fields = [NAME, MIDDLE, LAST]
    const next = moveFieldStep(fields, 0, -1)
    // First never moves — it never had `beside` to begin with — but Middle,
    // the new row-first, loses the one that used to join it to First.
    expect(next.map((f) => f.name)).toEqual(['first', 'middle', 'last'])
    expect(next[1]?.beside).toBeUndefined()
    expect(next[2]?.beside).toBe(true) // Last still correctly follows Middle
  })

  it('a row-last question moving down detaches itself, leaving the rest of the row intact', () => {
    const fields = [NAME, MIDDLE, LAST]
    const next = moveFieldStep(fields, 2, 1)
    expect(next.map((f) => f.name)).toEqual(['first', 'middle', 'last'])
    expect(next[1]?.beside).toBe(true) // First+Middle still one row
    expect(next[2]?.beside).toBeUndefined() // Last is now standalone
  })

  // The review's exact probe: `P,F*,M` (`moveField(2, 1)` used to produce
  // `P,M,F*`, pairing F with M — a row nobody asked for).
  it('a standalone question moving past a multi-question row jumps clean over it', () => {
    const P = { name: 'p', kind: 'text', label: 'P' } as const
    const F = { name: 'f', kind: 'text', label: 'F', beside: true } as const
    const M = { name: 'm', kind: 'text', label: 'M' } as const
    const fields = [P, F, M]
    const next = moveFieldStep(fields, 2, -1) // press "up" on M
    expect(next.map((f) => f.name)).toEqual(['m', 'p', 'f'])
    // P+F are still one row, untouched — M landed before them, not between.
    expect(next[2]?.beside).toBe(true)
  })

  it('two standalone questions swap places, an ordinary adjacent move', () => {
    const A = { name: 'a', kind: 'text', label: 'A' } as const
    const B = { name: 'b', kind: 'text', label: 'B' } as const
    expect(moveFieldStep([A, B], 0, 1).map((f) => f.name)).toEqual(['b', 'a'])
    expect(moveFieldStep([A, B], 1, -1).map((f) => f.name)).toEqual(['b', 'a'])
  })

  it('is a no-op past either end of the whole list, for two standalone questions', () => {
    // Unlike `NAME`/`MIDDLE` above, neither of these joins the other, so
    // there is no row for either end to detach from — genuinely nowhere left
    // to go, which `canMoveField` below pins as `false` for the same fields.
    const A = { name: 'a', kind: 'text', label: 'A' } as const
    const B = { name: 'b', kind: 'text', label: 'B' } as const
    const fields = [A, B]
    expect(moveFieldStep(fields, 0, -1)).toEqual(fields)
    expect(moveFieldStep(fields, 1, 1)).toEqual(fields)
  })

  it('a `hidden` question is a plain single-step swap, never row-aware', () => {
    const H = { name: 'h', kind: 'hidden', label: 'H', value: 'x' } as const
    // Even sitting right before a row, moving the hidden question itself
    // never reasons about rows — it has none.
    const fields = [H, NAME, MIDDLE]
    const next = moveFieldStep(fields, 0, 1)
    expect(next.map((f) => f.name)).toEqual(['first', 'h', 'middle'])
    expect(next[2]?.beside).toBe(true) // untouched
  })

  it('a row embedded around a `hidden` question travels together on a jump', () => {
    // how[select] , campaign(hidden), other(beside) is one row; a standalone
    // question jumping over it must carry the hidden one along, unchanged.
    const HOW = {
      name: 'how',
      kind: 'select',
      label: 'How',
      options: [{ value: 'x', label: 'X' }],
    } as const
    const CAMPAIGN = { name: 'campaign', kind: 'hidden', label: 'Campaign', value: 'y' } as const
    const OTHER = { name: 'other', kind: 'text', label: 'Other', beside: true } as const
    const M = { name: 'm', kind: 'text', label: 'M' } as const
    const fields = [M, HOW, CAMPAIGN, OTHER]
    const next = moveFieldStep(fields, 0, 1) // press "down" on M
    expect(next.map((f) => f.name)).toEqual(['how', 'campaign', 'other', 'm'])
    expect(next[2]?.beside).toBe(true) // other still joins how, hidden intact between them
  })
})

describe('canMoveField', () => {
  it('is always true for any member of a multi-question row, even at either end of the whole form', () => {
    const NAME = { name: 'first', kind: 'text', label: 'First' } as const
    const MIDDLE = { name: 'middle', kind: 'text', label: 'Middle', beside: true } as const
    const fields = [NAME, MIDDLE]
    // The old rule (`i === 0` / `i === length - 1`) would disable both ends;
    // both can still detach from the row they are in.
    expect(canMoveField(fields, 0, -1)).toBe(true)
    expect(canMoveField(fields, 1, 1)).toBe(true)
  })

  it('is false for a standalone question with nothing beyond it to swap with', () => {
    const A = { name: 'a', kind: 'text', label: 'A' } as const
    const B = { name: 'b', kind: 'text', label: 'B' } as const
    expect(canMoveField([A, B], 0, -1)).toBe(false)
    expect(canMoveField([A, B], 1, 1)).toBe(false)
  })

  it('is true for a standalone question with a row to jump over', () => {
    const P = { name: 'p', kind: 'text', label: 'P' } as const
    const F = { name: 'f', kind: 'text', label: 'F', beside: true } as const
    const M = { name: 'm', kind: 'text', label: 'M' } as const
    expect(canMoveField([P, F, M], 2, -1)).toBe(true)
  })

  it('is false for a `hidden` question at either end of the whole form', () => {
    const H1 = { name: 'h1', kind: 'hidden', label: 'H1', value: 'x' } as const
    const A = { name: 'a', kind: 'text', label: 'A' } as const
    const H2 = { name: 'h2', kind: 'hidden', label: 'H2', value: 'y' } as const
    const fields = [H1, A, H2]
    expect(canMoveField(fields, 0, -1)).toBe(false)
    expect(canMoveField(fields, 2, 1)).toBe(false)
    // Both can still move the other way, into the middle question's place.
    expect(canMoveField(fields, 0, 1)).toBe(true)
    expect(canMoveField(fields, 2, -1)).toBe(true)
  })
})

describe('withBeside / withGrow', () => {
  const field = { name: 'a', kind: 'text', label: 'A' } as const

  it('sets `beside` true and clears it back to absent, never storing false', () => {
    const on = withBeside(field, true)
    expect(on.beside).toBe(true)
    expect(withBeside(on, false).beside).toBeUndefined()
    // Already absent: a no-op, not an object carrying `beside: undefined`.
    expect(Object.keys(withBeside(field, false))).toEqual(Object.keys(field))
  })

  it('stores 2, 3 or 4 and clears anything else back to the 1 default', () => {
    expect(withGrow(field, 3).grow).toBe(3)
    expect(withGrow(field, 1).grow).toBeUndefined()
    expect(withGrow(field, 9).grow).toBeUndefined()
    expect(withGrow(withGrow(field, 3), 1).grow).toBeUndefined()
  })
})

describe('canJoinPrevious', () => {
  it("refuses the form's first real question", () => {
    const fields = [{ name: 'a', kind: 'text', label: 'A' }] as const
    expect(canJoinPrevious(fields, 'a')).toBe(false)
  })

  it('refuses the question right after a statement', () => {
    const fields = [
      { name: 'note', kind: 'statement', label: 'Note', text: 'Prose' },
      { name: 'a', kind: 'text', label: 'A' },
    ] as const
    expect(canJoinPrevious(fields, 'a')).toBe(false)
  })

  it('allows an ordinary question with a real predecessor', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'b', kind: 'text', label: 'B' },
    ] as const
    expect(canJoinPrevious(fields, 'b')).toBe(true)
  })

  it('skips a `hidden` question when finding the real predecessor', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'h', kind: 'hidden', label: 'H', value: '1' },
      { name: 'b', kind: 'text', label: 'B' },
    ] as const
    expect(canJoinPrevious(fields, 'b')).toBe(true)
  })
})

describe('fieldRows', () => {
  it('groups a chain of `beside` questions into one row', () => {
    const fields = [
      { name: 'first', kind: 'text', label: 'First' },
      { name: 'middle', kind: 'text', label: 'Middle', beside: true },
      { name: 'last', kind: 'text', label: 'Last', beside: true },
    ] as const
    expect(fieldRows(fields)).toEqual([[0, 1, 2]])
  })

  it('a `hidden` question is always its own row, even between two that join', () => {
    const fields = [
      { name: 'how', kind: 'select', label: 'How' },
      { name: 'campaign', kind: 'hidden', label: 'Campaign', value: 'x' },
      { name: 'other', kind: 'text', label: 'Other', beside: true },
    ] as const
    expect(fieldRows(fields)).toEqual([[0, 2], [1]])
  })

  it('a statement breaks the row on both sides', () => {
    const fields = [
      { name: 'a', kind: 'text', label: 'A' },
      { name: 'note', kind: 'statement', label: 'Note', text: 'Prose' },
      { name: 'b', kind: 'text', label: 'B', beside: true },
    ] as const
    expect(fieldRows(fields)).toEqual([[0], [1], [2]])
  })

  it('caps a row at MAX_ROW_CELLS, narrowing a fifth `beside` into a new row', () => {
    const fields: FormField[] = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}`,
      kind: 'text',
      label: `F${i}`,
      ...(i > 0 ? { beside: true } : {}),
    }))
    expect(fieldRows(fields)).toEqual([[0, 1, 2, 3], [4]])
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
