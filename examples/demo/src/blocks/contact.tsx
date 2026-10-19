import { createContext, Fragment, useContext } from "react";
import type { CSSProperties } from "react";
import {
  defineBlock,
  form,
  formLayout,
  type Json,
  prefillAnswers,
  text,
  type ResolvedForm,
  type ResolvedFormField,
} from "folio/core";

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
  status: string;
  /** `folio_form`: the form's slug, so a page carrying two forms can tell which
   *  one answered. Never the id — the id is in the action and nowhere else. */
  form: string;
  /** `folio_invalid`: the field names the server refused. */
  invalid: readonly string[];
  /** The page's own query string, for `prefillAnswers`. Present on every page
   *  render, with `status: ''` when nothing was submitted, so a form can seed its
   *  inputs from `?area=safari` without a submission having happened. */
  search: string;
}

export const SubmissionStatus = createContext<SubmissionState | null>(null);

/**
 * The banner above the form. A component rather than a branch inside `render`,
 * because `def.render(props)` is called as a plain function (`preview/Render.tsx`)
 * and a hook belongs in something React itself calls.
 */
function Notice({ form: descriptor }: { form: ResolvedForm }) {
  const state = useContext(SubmissionStatus);
  // `folio_form` is what makes two forms on one page distinguishable; without
  // this test both would announce every submission.
  if (!state || state.form !== descriptor.name) return null;

  if (state.status === "ok") {
    return (
      <p className="form__notice form__notice--ok">
        {descriptor.successMessage || "Thanks — we have that."}
      </p>
    );
  }
  if (state.status === "closed") {
    return <p className="form__notice">{descriptor.closedMessage || "This form is closed."}</p>;
  }
  return (
    <p className="form__notice form__notice--bad">
      {state.status === "rate"
        ? "That was a lot of submissions. Try again shortly."
        : state.status === "verify"
          ? "We could not verify that submission."
          : "Please check the highlighted answers."}
    </p>
  );
}

/** One question, drawn by the host. The descriptor is already localised and
 *  already carries `required`, `pattern`, `min`/`max` and the option labels, so
 *  there is no locale code and no fallback logic anywhere in here. */
function Question({
  field,
  invalid,
  seed,
}: {
  field: ResolvedFormField;
  invalid: boolean;
  /** `prefillAnswers`' answer for this question, if any. */
  seed?: Json;
}) {
  const id = `f-${field.name}`;
  const bad = invalid || undefined;
  const seeded = typeof seed === "string" || typeof seed === "number" ? String(seed) : undefined;
  const chosen = Array.isArray(seed) ? seed : typeof seed === "string" ? [seed] : [];

  // Prose between questions: no input, nothing stored. `formLayout` still
  // gives a `statement` a row of its own — it is never `hidden`, so it is
  // never routed to `FormBody`'s `view.inputs` instead.
  if (field.kind === "statement") {
    return <p className="form__statement">{field.text}</p>;
  }
  // `hidden` never reaches here: `formLayout` pulls it out into
  // `view.inputs`, position-free, before this component ever sees `field`.

  return (
    <div className="form__field">
      <label className="form__label" htmlFor={id}>
        {field.label}
        {field.required ? <abbr title="required"> *</abbr> : null}
      </label>

      {field.kind === "textarea" ? (
        <textarea
          id={id}
          className="form__input"
          rows={5}
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
          maxLength={field.max}
          defaultValue={seeded}
          aria-invalid={bad}
        />
      ) : field.kind === "select" ? (
        <select
          id={id}
          className="form__input"
          name={field.name}
          required={field.required}
          defaultValue={seeded}
          aria-invalid={bad}
        >
          <option value="">Choose…</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "radio" || field.kind === "checkboxes" ? (
        <fieldset className="form__group" aria-invalid={bad}>
          {field.options?.map((option) => (
            <label key={option.value} className="form__choice">
              <input
                type={field.kind === "radio" ? "radio" : "checkbox"}
                name={field.name}
                value={option.value}
                required={field.kind === "radio" && field.required}
                defaultChecked={chosen.includes(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : field.kind === "checkbox" ? (
        <input
          id={id}
          type="checkbox"
          name={field.name}
          value="1"
          required={field.required}
          defaultChecked={seed === true}
          aria-invalid={bad}
        />
      ) : field.kind === "file" ? (
        // `accept` is the exact content-type list the server will re-check
        // against the *bytes*, so the picker and the route cannot disagree —
        // and the route's refusal is the one that counts.
        <input
          id={id}
          type="file"
          className="form__input"
          name={field.name}
          required={field.required}
          accept={field.accept?.join(",")}
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
          defaultValue={seeded}
          aria-invalid={bad}
          {...(field.kind === "number"
            ? { min: field.min, max: field.max }
            : { maxLength: field.max })}
        />
      )}

      {field.help ? <p className="form__help">{field.help}</p> : null}
    </div>
  );
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
  name: "contactForm",
  label: "Form",
  summary: "heading",
  fields: {
    heading: text({ label: "Heading", translatable: true }),
    // The stored value is the form's id; the inspector draws a picker over the
    // Forms screen's own rows for it, so nothing here has to explain where to
    // find one.
    form: form({ label: "Form" }),
  },
  render: ({ heading, form: descriptor }) => {
    // Deleted since the page was published: the same posture a `reference` to a
    // deleted document takes, and the delete dialog warned about it first.
    if (!descriptor) return null;

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
          <p className="form__closed">{descriptor.closedMessage || "This form is closed."}</p>
        )}
      </section>
    );
  },
});

/** The `<form>` itself. Split out so `Notice`'s hook and this one's
 *  `useContext` sit in components rather than in `render`. */
function FormBody({ descriptor }: { descriptor: ResolvedForm }) {
  const state = useContext(SubmissionStatus);
  const invalid = new Set(state?.form === descriptor.name ? state.invalid : []);
  // `formLayout` (`folio/core`) is the one function that groups a compiled
  // form's flat `fields` into rows and sections, so this host never
  // reimplements the grouping `beside`/`grow` already describe. Called with no
  // `answers` on purpose: this page ships no client script, which is the
  // no-JavaScript path (`docs/specs/content-model/form-logic.md` decision 7). Every
  // question and section is present and every cell `shown`, and the descriptor's
  // `required` is only ever "required unconditionally", so a visitor who cannot
  // reveal a conditional question is never blocked by one. The server works out
  // which questions applied. A host with a script would switch to
  // `formLayout(descriptor, answers)` after mount.
  const view = formLayout(descriptor);
  // Query-string prefill: only questions the editor opted in (`prefill: 'query'`).
  const seeds = prefillAnswers(descriptor, { query: state?.search ?? "" });

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

      {/* `hidden`-kind questions: layout-transparent, so `formLayout` carries
          them separately from every row — they render anywhere in the form. */}
      {view.inputs.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value ?? ""} />
      ))}

      {view.sections.map(({ section, rows }, i) => {
        const body = rows.map((row) => (
          <div
            key={row.key}
            className="form__row"
            style={
              { "--form-row-cols": row.cells.map((c) => `${c.grow}fr`).join(" ") } as CSSProperties
            }
          >
            {row.cells.map((cell) =>
              cell.shown ? (
                <Question
                  key={cell.field.name}
                  field={cell.field}
                  invalid={invalid.has(cell.field.name)}
                  {...(seeds[cell.field.name] !== undefined
                    ? { seed: seeds[cell.field.name] as Json }
                    : {})}
                />
              ) : (
                // A `hold`ing cell whose question is not currently asked
                // (only with `answers`): an empty, `aria-hidden` slot, never a
                // `visibility: hidden` input — that still posts a value in a
                // native submission.
                <div key={cell.field.name} aria-hidden="true" />
              ),
            )}
          </div>
        ));
        // A real section is a `<fieldset>` with a `<legend>`; the questions outside
        // any section come back as `section: null` groups, which may sit before
        // and after the real ones.
        return section ? (
          <fieldset key={section.name} className="form__section">
            <legend>{section.label}</legend>
            {section.help ? <p className="form__help">{section.help}</p> : null}
            {body}
          </fieldset>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a `null` group has no name; its place is its identity.
          <Fragment key={i}>{body}</Fragment>
        );
      })}

      <button className="btn btn--primary" type="submit">
        {descriptor.submitLabel}
      </button>
    </form>
  );
}
