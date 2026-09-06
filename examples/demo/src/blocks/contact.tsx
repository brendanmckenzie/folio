import { createContext, useContext } from 'react'
import { defineBlock, form, text, type ResolvedForm, type ResolvedFormField } from 'folio/core'

/**
 * What the host read off its own URL after a submission
 * (`docs/specs/content-model/forms.md` architecture decision 6).
 *
 * The 303 a native POST answers with carries at most three parameters —
 * `folio_status`, `folio_form` and `folio_invalid` — and **nothing personal**,
 * which is precisely what lets the thank-you page stay in the edge cache. So
 * the *host* reads them and the block renders the descriptor's own
 * `successMessage`: Folio ships no markup for this and no component to override.
 *
 * A context rather than a prop because a block's `render` is called with the
 * document's field values and nothing else — there is no seam for "and also,
 * what does the query string say". `src/index.tsx` provides it around
 * `folio.render`; the default is `null`, which is what the editor's preview
 * bundle gets (there is no submission there, and no query string either).
 */
export interface SubmissionState {
  /** `folio_status`: `ok` | `invalid` | `closed` | `rate` | `verify` | `error`. */
  status: string
  /** `folio_form`: the form's slug, so a page carrying two forms can tell which
   *  one answered. Never the id — the id is in the action and nowhere else. */
  form: string
  /** `folio_invalid`: the field names the server refused. */
  invalid: readonly string[]
}

export const SubmissionStatus = createContext<SubmissionState | null>(null)

/**
 * The banner above the form. A component rather than a branch inside `render`,
 * because `def.render(props)` is called as a plain function (`preview/Render.tsx`)
 * and a hook belongs in something React itself calls.
 */
function Notice({ form: descriptor }: { form: ResolvedForm }) {
  const state = useContext(SubmissionStatus)
  // `folio_form` is what makes two forms on one page distinguishable; without
  // this test both would announce every submission.
  if (!state || state.form !== descriptor.name) return null

  if (state.status === 'ok') {
    return (
      <p className="form__notice form__notice--ok">
        {descriptor.successMessage || 'Thanks — we have that.'}
      </p>
    )
  }
  if (state.status === 'closed') {
    return <p className="form__notice">{descriptor.closedMessage || 'This form is closed.'}</p>
  }
  return (
    <p className="form__notice form__notice--bad">
      {state.status === 'rate'
        ? 'That was a lot of submissions. Try again shortly.'
        : state.status === 'verify'
          ? 'We could not verify that submission.'
          : 'Please check the highlighted answers.'}
    </p>
  )
}

/** One question, drawn by the host. The descriptor is already localised and
 *  already carries `required`, `pattern`, `min`/`max` and the option labels, so
 *  there is no locale code and no fallback logic anywhere in here. */
function Question({ field, invalid }: { field: ResolvedFormField; invalid: boolean }) {
  const id = `f-${field.name}`
  const bad = invalid || undefined

  // Prose between questions: no input, nothing stored.
  if (field.kind === 'statement') {
    return <p className="form__statement">{field.text}</p>
  }
  // A value the host's markup emits and the server validates and stores like
  // any other answer (decision 13) — a campaign id, a source.
  if (field.kind === 'hidden') {
    return <input type="hidden" name={field.name} value={field.value ?? ''} />
  }

  return (
    <div className="form__field">
      <label className="form__label" htmlFor={id}>
        {field.label}
        {field.required ? <abbr title="required"> *</abbr> : null}
      </label>

      {field.kind === 'textarea' ? (
        <textarea
          id={id}
          className="form__input"
          rows={5}
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
          maxLength={field.max}
          aria-invalid={bad}
        />
      ) : field.kind === 'select' ? (
        <select
          id={id}
          className="form__input"
          name={field.name}
          required={field.required}
          aria-invalid={bad}
        >
          <option value="">Choose…</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'radio' || field.kind === 'checkboxes' ? (
        <fieldset className="form__group" aria-invalid={bad}>
          {field.options?.map((option) => (
            <label key={option.value} className="form__choice">
              <input
                type={field.kind === 'radio' ? 'radio' : 'checkbox'}
                name={field.name}
                value={option.value}
                required={field.kind === 'radio' && field.required}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : field.kind === 'checkbox' ? (
        <input
          id={id}
          type="checkbox"
          name={field.name}
          value="1"
          required={field.required}
          aria-invalid={bad}
        />
      ) : field.kind === 'file' ? (
        // `accept` is the exact content-type list the server will re-check
        // against the *bytes*, so the picker and the route cannot disagree —
        // and the route's refusal is the one that counts.
        <input
          id={id}
          type="file"
          className="form__input"
          name={field.name}
          required={field.required}
          accept={field.accept?.join(',')}
          aria-invalid={bad}
        />
      ) : (
        <input
          id={id}
          type={field.kind}
          className="form__input"
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
          pattern={field.pattern}
          aria-invalid={bad}
          {...(field.kind === 'number'
            ? { min: field.min, max: field.max }
            : { maxLength: field.max })}
        />
      )}

      {field.help ? <p className="form__help">{field.help}</p> : null}
    </div>
  )
}

/**
 * A form on a page (`docs/specs/content-model/forms.md`).
 *
 * The whole of the integration is `form: form({…})` below: the stored value is a
 * form's id, and `resolve()` puts the compiled descriptor on the resolution, so
 * this block receives a `ResolvedForm` — the action URL, the encoding, every
 * question already resolved through the locale chain, the hidden inputs and the
 * honeypot's name — or `null` if the form has since been deleted.
 *
 * **Folio ships no `<FolioForm>` and no CSS** (decision 4). This markup is the
 * host's, all of it, which is the point: a form is the one place a design system
 * has strong opinions.
 *
 * It posts with **no JavaScript at all** — this page ships none — because the
 * transport is a native POST and the answer is a 303 (decision 5).
 */
export const contactForm = defineBlock({
  name: 'contactForm',
  label: 'Form',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    // The stored value is the form's id; the inspector draws a picker over the
    // Forms screen's own rows for it, so nothing here has to explain where to
    // find one.
    form: form({ label: 'Form' }),
  },
  render: ({ heading, form: descriptor }) => {
    // Deleted since the page was published: the same posture a `reference` to a
    // deleted document takes, and the delete dialog warned about it first.
    if (!descriptor) return null

    return (
      <section className="form">
        {heading ? <h2 className="form__heading">{heading}</h2> : null}
        <Notice form={descriptor} />

        {descriptor.open ? (
          <FormBody descriptor={descriptor} />
        ) : (
          // Advertised in the descriptor *and* enforced at the route
          // (decision 14): a page cached for a week keeps serving the old
          // markup, so the route is the enforcement and this is the courtesy.
          <p className="form__closed">{descriptor.closedMessage || 'This form is closed.'}</p>
        )}
      </section>
    )
  },
})

/** The `<form>` itself. Split out so `Notice`'s hook and this one's
 *  `useContext` sit in components rather than in `render`. */
function FormBody({ descriptor }: { descriptor: ResolvedForm }) {
  const state = useContext(SubmissionStatus)
  const invalid = new Set(state?.form === descriptor.name ? state.invalid : [])

  return (
    <form method={descriptor.method} action={descriptor.action} encType={descriptor.enctype}>
      {/* `_folio_page` (where this was submitted from) and `_folio_locale`
          (which language it was rendered in). Both are Folio's, both are dropped
          rather than stored as answers, and a host emits them verbatim rather
          than deriving either. */}
      {descriptor.hidden.map((input) => (
        <input key={input.name} type="hidden" name={input.name} value={input.value} />
      ))}

      {/* The honeypot (decision 9). Named deterministically from the form id out
          of a pool of boring-looking names, so a cached page and the live route
          always agree on which input is the decoy — and so a bot cannot spot it
          by its name. Filling it answers success and stores nothing. */}
      <input
        type="text"
        name={descriptor.honeypot}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="form__decoy"
      />

      {descriptor.fields.map((field) => (
        <Question key={field.name} field={field} invalid={invalid.has(field.name)} />
      ))}

      <button className="btn btn--primary" type="submit">
        {descriptor.submitLabel}
      </button>
    </form>
  )
}
