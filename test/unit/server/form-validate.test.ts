import { describe, expect, it } from 'vitest'
import type { FormField } from '../../../src/core/forms'
import {
  bodyHash,
  capFor,
  clientIp,
  DEFAULT_RATE_PER_HOUR,
  type FolioForms,
  ipHash,
  rawBodyOf,
  RATE_WINDOW_MS,
  type SubmissionBody,
  throttleHashes,
  validateForms,
  validateSubmission,
} from '../../../src/server/form-responses'
import type { Form } from '../../../src/server/forms'
import { MAX_ANSWER_CHARS } from '../../../src/server/validate'

/**
 * The pure half of the one route an anonymous stranger on the internet may POST
 * to (`docs/specs/content-model/forms.md` phase 4).
 *
 * Everything here is a decision about hostile input, which is why it is a unit
 * test rather than a workerd one: the interesting cases are a hundred shapes of
 * body, not a hundred round trips.
 *
 * Four of these exist because the failure is silent rather than loud:
 *
 *  - **Only declared questions are stored, and a `_` name is never one.** The
 *    submit button's `name`, the honeypot and whatever an extension injected all
 *    arrive on a real browser POST (decision 13). A leak the other way is worse:
 *    `_folio_page` is Folio's own input, and a submission that could write it as
 *    an *answer* would be a response forging its own metadata.
 *  - **The kind switch is exhaustive.** A fourteenth field kind that fell through
 *    would be a question on a public endpoint that nothing validates, and the
 *    `never` assignment is what makes that a compile error instead.
 *  - **The body cap is derived from the form, not from a constant.** Passing
 *    `MAX_UPLOAD_BYTES` would let a stranger stream 20MB at a three-question
 *    contact form.
 *  - **The IP hash carries its hour**, so the one quasi-identifier in the table
 *    stops being computable from an address once that hour has passed
 *    (decision 10) — and the limiter has to check the previous bucket too, or
 *    "ten an hour" is "ten a wall-clock hour" and resets at the top of it.
 */

const NAME: FormField = { name: 'full_name', kind: 'text', label: 'Your name' }
const EMAIL: FormField = { name: 'email', kind: 'email', label: 'Email', required: true }
const REASON: FormField = {
  name: 'reason',
  kind: 'select',
  label: 'Reason',
  options: [
    { value: 'sales', label: 'Sales' },
    { value: 'support', label: 'Support' },
  ],
}

/** A submitted body, in the repeated-key shape a browser actually sends. */
function body(raw: Record<string, string | string[]>): SubmissionBody {
  return new Map(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))
}

function makeForm(fields: FormField[]): Form {
  return {
    id: 'frm_0123456789ab',
    name: 'contact',
    label: 'Contact us',
    fields,
    version: 1,
    open: true,
    closesAt: null,
    closedMessage: '',
    successMessage: '',
    submitLabel: 'Submit',
    redirectTo: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('validateSubmission: what is stored', () => {
  it('keeps declared questions, drops everything else the browser sent', () => {
    const source: FormField = { name: 'source', kind: 'hidden', label: 'Source', value: 'site' }
    const { values, errors } = validateSubmission(
      [NAME, EMAIL, source],
      body({
        full_name: 'Ada',
        email: 'ada@example.com',
        // The host's markup emitted this, so it is stored — a hidden question is
        // validated, stored and exported like any other answer (decision 13).
        source: 'newsletter',
        // A submit button, Folio's own hidden input, the honeypot, and a
        // campaign parameter a script appended. None is a declared question.
        submit: 'Send',
        _folio_page: '/contact',
        company_website: '',
        utm_medium: 'email',
      }),
    )

    expect(errors).toEqual({})
    expect(Object.keys(values).sort()).toEqual(['email', 'full_name', 'source'])
    expect(values.source).toBe('newsletter')
  })

  /**
   * The screen that stops a response forging its own metadata. It is the second
   * of two locks on the same door — `validateFormFields` refuses a field slug in
   * the `_` namespace, so this can only fire for a row that predates that — and
   * it is the one that holds when the first has been got around.
   */
  it('never stores an answer under a Folio-reserved name, even if a form declares one', () => {
    const smuggled = { name: '_folio_page', kind: 'text', label: 'Page' } as FormField
    const { values } = validateSubmission(
      [smuggled, NAME],
      body({ _folio_page: 'https://evil.example/', full_name: 'Ada' }),
    )
    expect(values).toEqual({ full_name: 'Ada' })
  })

  it('stores nothing for a statement, which renders no input', () => {
    const note: FormField = { name: 'note', kind: 'statement', label: 'Note', text: 'Read this' }
    const { values, errors } = validateSubmission([note], body({ note: 'I typed here' }))
    expect(values).toEqual({})
    expect(errors).toEqual({})
  })
})

describe('validateSubmission: per question', () => {
  it('refuses a required answer that is absent or blank, and names the field', () => {
    expect(validateSubmission([EMAIL], body({})).errors).toEqual({ email: 'required' })
    expect(validateSubmission([EMAIL], body({ email: '   ' })).errors).toEqual({
      email: 'required',
    })
    // Not required and not given is not an error, and stores no key at all.
    expect(validateSubmission([NAME], body({})).values).toEqual({})
  })

  it('refuses a number that is not one, rather than coercing it', () => {
    const budget: FormField = { name: 'budget', kind: 'number', label: 'Budget', min: 10, max: 100 }
    // `Number('12abc')` is NaN and `parseInt('12abc')` is 12; neither is what the
    // visitor meant, so the shape is screened before either runs.
    expect(validateSubmission([budget], body({ budget: '12abc' })).errors).toEqual({
      budget: 'invalid',
    })
    expect(validateSubmission([budget], body({ budget: '42' })).values).toEqual({ budget: 42 })
    expect(validateSubmission([budget], body({ budget: '9' })).errors).toEqual({
      budget: 'out_of_range',
    })
    expect(validateSubmission([budget], body({ budget: '101' })).errors).toEqual({
      budget: 'out_of_range',
    })
  })

  it('refuses a date that matches the shape and is not a day', () => {
    const when: FormField = { name: 'when', kind: 'date', label: 'When' }
    expect(validateSubmission([when], body({ when: '2026-09-06' })).values).toEqual({
      when: '2026-09-06',
    })
    expect(validateSubmission([when], body({ when: '2026-02-31' })).errors).toEqual({
      when: 'invalid',
    })
    expect(validateSubmission([when], body({ when: '06/09/2026' })).errors).toEqual({
      when: 'invalid',
    })
  })

  it('refuses an option nothing declared, for both a select and a checkboxes', () => {
    expect(validateSubmission([REASON], body({ reason: 'sales' })).values).toEqual({
      reason: 'sales',
    })
    // The whole point of an option list: a value outside it is a request that
    // never came from the rendered markup.
    expect(validateSubmission([REASON], body({ reason: 'billing' })).errors).toEqual({
      reason: 'invalid',
    })

    const topics: FormField = {
      name: 'topics',
      kind: 'checkboxes',
      label: 'Topics',
      required: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }
    expect(validateSubmission([topics], body({ topics: ['a', 'b'] })).values).toEqual({
      topics: ['a', 'b'],
    })
    expect(validateSubmission([topics], body({ topics: ['a', 'z'] })).errors).toEqual({
      topics: 'invalid',
    })
    // Nothing ticked sends no key at all, so `required` on one can only mean
    // "at least one".
    expect(validateSubmission([topics], body({})).errors).toEqual({ topics: 'required' })

    const optional: FormField = { ...topics, required: false }
    expect(validateSubmission([optional], body({})).values).toEqual({ topics: [] })
  })

  it('reads a checkbox by presence, which is the only thing a browser sends', () => {
    const consent: FormField = { name: 'consent', kind: 'checkbox', label: 'OK?', required: true }
    expect(validateSubmission([consent], body({ consent: 'on' })).values).toEqual({ consent: true })
    expect(validateSubmission([consent], body({})).errors).toEqual({ consent: 'required' })

    const optional: FormField = { ...consent, required: false }
    expect(validateSubmission([optional], body({})).values).toEqual({ consent: false })
  })

  it('applies the question’s own max and pattern, and a backstop above both', () => {
    const short: FormField = { name: 'code', kind: 'text', label: 'Code', max: 4 }
    expect(validateSubmission([short], body({ code: 'abcd' })).values).toEqual({ code: 'abcd' })
    expect(validateSubmission([short], body({ code: 'abcde' })).errors).toEqual({
      code: 'too_long',
    })

    // No `max` at all is still bounded: this is a public endpoint and the column
    // is what gets the string.
    const open: FormField = { name: 'story', kind: 'textarea', label: 'Story' }
    const long = 'x'.repeat(MAX_ANSWER_CHARS + 1)
    expect(validateSubmission([open], body({ story: long })).errors).toEqual({ story: 'too_long' })

    const postcode: FormField = {
      name: 'postcode',
      kind: 'text',
      label: 'Postcode',
      pattern: '[0-9]{4}',
    }
    expect(validateSubmission([postcode], body({ postcode: '3000' })).values).toEqual({
      postcode: '3000',
    })
    // Anchored, the way an HTML `pattern` is: a match somewhere inside is not a
    // match.
    expect(validateSubmission([postcode], body({ postcode: 'x3000x' })).errors).toEqual({
      postcode: 'invalid',
    })
  })

  it('lets a textarea hold newlines and refuses one anywhere else', () => {
    const story: FormField = { name: 'story', kind: 'textarea', label: 'Story' }
    expect(validateSubmission([story], body({ story: 'one\r\ntwo' })).values).toEqual({
      story: 'one\ntwo',
    })

    // The identical string under a single-line question is somebody making one
    // stored value look like two.
    expect(validateSubmission([NAME], body({ full_name: 'Ada\nLovelace' })).errors).toEqual({
      full_name: 'invalid',
    })
    // And a C0 control is refused whatever the question: a stored string must
    // not be able to lie about what it is.
    expect(validateSubmission([NAME], body({ full_name: 'Ada\u0000' })).errors).toEqual({
      full_name: 'invalid',
    })
  })

  it('refuses a url that is not http, so a stored answer is never a javascript: link', () => {
    const site: FormField = { name: 'site', kind: 'url', label: 'Website' }
    expect(validateSubmission([site], body({ site: 'https://example.com/x' })).values).toEqual({
      site: 'https://example.com/x',
    })
    // A host renders this in its own markup. `javascript:` and `data:` are not
    // websites.
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'example.com']) {
      expect(validateSubmission([site], body({ site: bad })).errors, bad).toEqual({
        site: 'invalid',
      })
    }
  })
})

describe('capFor', () => {
  it('grows with the questions the editor built, not with what a request claims', () => {
    const bare = capFor(makeForm([]))
    const three = capFor(makeForm([NAME, EMAIL, REASON]))
    expect(three).toBeGreaterThan(bare)

    // A three-question contact form is tens of kilobytes, not the media
    // library's twenty megabytes — which is the whole reason this is not
    // `MAX_UPLOAD_BYTES`.
    expect(three).toBeLessThan(1024 * 1024)

    // A question that declares a longer answer buys a larger body, and only it.
    const roomy = capFor(makeForm([{ name: 'story', kind: 'textarea', label: 'S', max: 9000 }]))
    expect(roomy).toBeGreaterThan(three)
  })

  it('budgets a file question its own maxBytes, so phase 5 does not have to widen it', () => {
    const withFile = capFor(
      makeForm([
        { name: 'cv', kind: 'file', label: 'CV', accept: 'documents', maxBytes: 1_000_000 },
      ]),
    )
    expect(withFile).toBeGreaterThan(1_000_000)
  })
})

describe('bodyHash', () => {
  it('is the same for the same answers in a different order, and different otherwise', async () => {
    const a = await bodyHash({ email: 'ada@example.com', full_name: 'Ada' })
    const b = await bodyHash({ full_name: 'Ada', email: 'ada@example.com' })
    // A double-click sends the same body twice; nothing guarantees the same key
    // order survives two parses, and a duplicate that hashed differently would
    // be stored twice.
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)

    expect(await bodyHash({ full_name: 'Ada', email: 'grace@example.com' })).not.toBe(a)
  })

  it('changes when a file changes, which is what lets the check run before the R2 put', async () => {
    const values = { full_name: 'Ada' }
    const one = await bodyHash(values, [{ field: 'cv', size: 10, contentHash: 'aa' }])
    const two = await bodyHash(values, [{ field: 'cv', size: 10, contentHash: 'bb' }])
    expect(one).not.toBe(two)
    expect(one).not.toBe(await bodyHash(values))
  })
})

describe('the IP hash and its bucket', () => {
  const IP = '203.0.113.7'
  const FORM = 'frm_0123456789ab'

  it('never contains the address, and stops matching once the hour has passed', async () => {
    const at = 1_700_000_000_000
    const hash = await ipHash(IP, FORM, at)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('203')

    // Inside the same hour it is stable — that is what makes it a counter.
    expect(await ipHash(IP, FORM, at + 60_000)).toBe(hash)
    // An hour on it is a different value, and nobody holding the database can
    // get back to it from the address any more (decision 10).
    expect(await ipHash(IP, FORM, at + RATE_WINDOW_MS)).not.toBe(hash)
    // And the same visitor is unlinkable across two forms on one site.
    expect(await ipHash(IP, 'frm_ffffffffffff', at)).not.toBe(hash)
  })

  it('answers the current bucket and the previous one, in that order', async () => {
    const at = 1_700_000_000_000
    const [current, previous] = await throttleHashes(IP, FORM, at)
    expect(current).toBe(await ipHash(IP, FORM, at))
    // Without the second, "ten an hour" resets at the top of the hour and eleven
    // submissions across 10:58 and 11:01 are two buckets of well under ten.
    expect(previous).toBe(await ipHash(IP, FORM, at - RATE_WINDOW_MS))
    expect(current).not.toBe(previous)
  })

  it('reads the address the edge sets and nothing a client can write', () => {
    const with_ = (headers: Record<string, string>) =>
      clientIp(new Request('https://example.com/folio/f/frm_0123456789ab', { headers }))

    expect(with_({ 'cf-connecting-ip': IP })).toBe(IP)
    // `X-Forwarded-For` is a header the limited party writes, so limiting on it
    // is limiting a value of their choosing.
    expect(with_({ 'x-forwarded-for': IP })).toBeNull()
    // A local `wrangler dev` has no address, and the honest answer is none — not
    // a shared bucket everybody lands in.
    expect(with_({})).toBeNull()
    expect(with_({ 'cf-connecting-ip': 'x'.repeat(200) })).toBeNull()
  })
})

describe('rawBodyOf', () => {
  it('hands verify the first value per key, under whatever name the widget chose', () => {
    expect(rawBodyOf(body({ 'cf-turnstile-response': 'token', topics: ['a', 'b'] }))).toEqual({
      'cf-turnstile-response': 'token',
      topics: 'a',
    })
  })
})

describe('validateForms', () => {
  it('answers null for a host that configured none, which is not "forms are off"', () => {
    expect(validateForms(undefined)).toBeNull()
  })

  it('defaults the rate limit and keeps the host function', () => {
    const verify = () => true
    const resolved = validateForms({ verify })
    expect(resolved?.ratePerHour).toBe(DEFAULT_RATE_PER_HOUR)
    expect(resolved?.config.verify).toBe(verify)

    expect(validateForms({ ratePerHour: 3 })?.ratePerHour).toBe(3)
    // Zero is a deliberate "no limit", not a typo, and is the one value below
    // the range that is accepted.
    expect(validateForms({ ratePerHour: 0 })?.ratePerHour).toBe(0)
  })

  it('refuses a misconfiguration at construction, naming it', () => {
    // A silently ignored `verifiy` is a site that verifies nobody, and `verify`
    // fails closed — so the symptom of getting this wrong is a contact form that
    // collects nothing.
    expect(() => validateForms({ verifiy: () => true } as unknown as FolioForms<unknown>)).toThrow(
      /unknown `forms` key "verifiy"/,
    )
    expect(() => validateForms({ verify: 'yes' } as unknown as FolioForms<unknown>)).toThrow(
      /`forms.verify` must be a function/,
    )
    for (const rate of [-1, 101, 1.5]) {
      expect(() => validateForms({ ratePerHour: rate }), String(rate)).toThrow(/ratePerHour/)
    }
  })
})
