import { createContext, Fragment, useContext } from "react";
import type { CSSProperties } from "react";
import {
  defineBlock,
  form,
  type LayoutSection,
  type ResolvedForm,
  type ResolvedFormField,
  text,
} from "folio/core";
import { type FolioForm, useFolioForm } from "folio/form";

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
  // Every other status (`invalid`, `rate`, `verify`, `error`) is `useFolioForm`'s to
  // announce, in `FormBody`, with the error summary beside it.
  return null;
}

/** One question, drawn by the host. The descriptor is already localised and
 *  already carries `required`, `pattern`, `min`/`max` and the option labels, so
 *  there is no locale code and no fallback logic anywhere in here. The hook's
 *  prop-getters supply the ids, the `name`, the `aria-*` wiring and the
 *  prefilled value; the host supplies the elements and the class names. */
function Question({ field, f }: { field: ResolvedFormField; f: FolioForm }) {
  // Prose between questions: no input, nothing stored. `formLayout` still
  // gives a `statement` a row of its own, and `hidden` never reaches here: it
  // comes back separately as `layout.inputs`.
  if (field.kind === "statement") {
    return <p className="form__statement">{field.text}</p>;
  }

  const error = f.errorFor(field.name);
  const grouped = field.kind === "radio" || field.kind === "checkboxes";

  return (
    <div className="form__field">
      {grouped ? (
        // A group is labelled by its legend-like label, not a `for`.
        <span className="form__label" {...f.labelProps(field)}>
          {field.label}
          {field.required ? <abbr title="required"> *</abbr> : null}
        </span>
      ) : (
        // biome-ignore lint/a11y/noLabelWithoutControl: `labelProps` supplies `htmlFor`.
        <label className="form__label" {...f.labelProps(field)}>
          {field.label}
          {field.required ? <abbr title="required"> *</abbr> : null}
        </label>
      )}

      {field.kind === "textarea" ? (
        <textarea className="form__input" rows={5} {...f.controlProps(field)} />
      ) : field.kind === "select" ? (
        <select className="form__input" {...f.controlProps(field)}>
          <option value="">Choose…</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : grouped ? (
        <fieldset className="form__group" {...f.groupProps(field)}>
          {field.options?.map((option) => (
            <label key={option.value} className="form__choice">
              <input {...f.controlProps(field, option)} />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : field.kind === "checkbox" ? (
        <input {...f.controlProps(field)} />
      ) : (
        <input className="form__input" {...f.controlProps(field)} />
      )}

      {field.help ? <p className="form__help">{field.help}</p> : null}
      {error ? (
        <p className="form__error" {...f.errorProps(field)}>
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

/** One section's rows. `cell.shown` is false only for a `hold`ing cell whose
 *  question is not currently asked (only once the hook has mounted). */
function Rows({ rows, f }: { rows: LayoutSection["rows"]; f: FolioForm }) {
  return rows.map((row) => (
    <div
      key={row.key}
      className="form__row"
      style={{ "--form-row-cols": row.cells.map((c) => `${c.grow}fr`).join(" ") } as CSSProperties}
    >
      {row.cells.map((cell) =>
        cell.shown ? (
          <Question key={cell.field.name} field={cell.field} f={f} />
        ) : (
          // An empty, `aria-hidden` slot, never a `visibility: hidden` input: that
          // still posts a value in a native submission.
          <div key={cell.field.name} aria-hidden="true" />
        ),
      )}
    </div>
  ));
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
 * On the public page it posts with **no JavaScript at all** (this page ships
 * none), because the transport is a native POST and the answer is a 303
 * (decision 5); a stepped form is then one page. The admin preview hydrates the
 * block, so there `useFolioForm` mounts and the steps show.
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
 *  `useContext` sit in components rather than in `render`.
 *
 *  It renders through `useFolioForm` (`folio/form`), and the same markup serves
 *  two paths. The public page ships no script (nothing hydrates it), so the hook
 *  never mounts: it renders what a server render does, every step as one page
 *  and every question present, and the browser posts the `<form>` natively. The
 *  admin preview does hydrate the block (`preview/mount.tsx`), so there the hook
 *  mounts and the stepped path shows: one step at a time, Back and Next, an
 *  error summary and live conditions. Either way the element is a plain
 *  `<form>` posting to `descriptor.action`, which is what lets the first path
 *  work at all. */
function FormBody({ descriptor }: { descriptor: ResolvedForm }) {
  const state = useContext(SubmissionStatus);
  const f = useFolioForm(descriptor, { search: state?.search ?? "" });

  return (
    <form {...f.formProps()}>
      {/* `_folio_page` (where this was submitted from) and `_folio_locale`
          (which language it was rendered in). Both are Folio's, both are dropped
          rather than stored as answers, and a host emits them verbatim rather
          than deriving either. */}
      {f.hidden.map((input) => (
        <input key={input.name} type="hidden" name={input.name} value={input.value} />
      ))}

      {/* The honeypot (decision 9). Named deterministically from the form id so a
          cached page and the live route always agree on which input is the decoy.
          Filling it answers success and stores nothing. */}
      <input className="form__decoy" {...f.honeypotProps()} />

      {/* `hidden`-kind questions: layout-transparent, so the layout carries them
          separately from every row. */}
      {f.layout.inputs.map((field) => (
        <input key={field.name} {...f.controlProps(field)} />
      ))}

      {f.problems.length > 0 ? (
        <div className="form__summary" {...f.summaryProps()}>
          <h3 {...f.summaryTitleProps()}>There is a problem</h3>
          <ul>
            {f.problems.map((problem) => (
              <li key={problem.name}>
                <a {...f.problemLinkProps(problem)}>{problem.message}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {f.status && f.status.kind !== "ok" && f.status.kind !== "closed" ? (
        <p className="form__notice form__notice--bad" {...f.statusProps()}>
          {f.status.message}
        </p>
      ) : null}

      {/* A form without steps is one group with a null step; the same loop covers
          it. `stepProps` hides the steps that are not current once mounted, and
          leaves every one visible before. */}
      {f.layout.steps.map((group, s) => {
        const sections = group.sections.map(({ section, rows }, i) =>
          section ? (
            <fieldset key={section.name} className="form__section">
              <legend>{section.label}</legend>
              {section.help ? <p className="form__help">{section.help}</p> : null}
              <Rows rows={rows} f={f} />
            </fieldset>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a `null` group has no name; its place is its identity.
            <Fragment key={i}>
              <Rows rows={rows} f={f} />
            </Fragment>
          ),
        );
        return group.step ? (
          <div key={group.step.name} className="form__step" {...f.stepProps(group)}>
            <h3 className="form__step-title" {...f.stepLabelProps(group)}>
              {group.step.label}
            </h3>
            {group.step.help ? <p className="form__help">{group.step.help}</p> : null}
            {sections}
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the unstepped group has no name.
          <Fragment key={s}>{sections}</Fragment>
        );
      })}

      <div className="form__nav">
        <button className="btn" {...f.backProps()}>
          Back
        </button>
        <button className="btn" {...f.nextProps()}>
          Next
        </button>
        <button className="btn btn--primary" {...f.submitProps()}>
          {descriptor.submitLabel}
        </button>
      </div>
    </form>
  );
}
