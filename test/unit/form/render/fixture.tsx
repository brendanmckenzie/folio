import type { InputHTMLAttributes } from "react";
import type { ResolvedForm, ResolvedFormField } from "../../../../src/core/forms";
import { type FolioForm, type FolioFormOptions, useFolioForm } from "../../../../src/form";

export const rf = (
  name: string,
  row: number,
  extra: Partial<ResolvedFormField> = {},
): ResolvedFormField => ({
  name,
  kind: "text",
  label: name,
  required: false,
  row,
  grow: 1,
  ...extra,
});

export const baseForm = (over: Partial<ResolvedForm> = {}): ResolvedForm => ({
  id: "frm_test0000ab",
  name: "apply",
  action: "/f/frm_test0000ab",
  method: "post",
  enctype: "application/x-www-form-urlencoded",
  version: 1,
  open: true,
  fields: [],
  sections: [],
  hidden: [{ name: "_folio_page", value: "/apply" }],
  honeypot: "company_website",
  submitLabel: "Send",
  successMessage: "Thanks, we got it.",
  closedMessage: "",
  redirectTo: null,
  ...over,
});

/** Three steps: about, group (only for groups) and trip. */
export const steppedForm = (over: Partial<ResolvedForm> = {}): ResolvedForm =>
  baseForm({
    steps: [
      { name: "about", label: "About you" },
      { name: "group", label: "Group", showIf: { field: "travelling", eq: "group" } },
      { name: "trip", label: "Your trip" },
    ],
    fields: [
      rf("email", 0, { kind: "email", required: true, step: "about" }),
      rf("phone", 1, { kind: "tel", pattern: "^\\+?[0-9 ]{8,}$", step: "about" }),
      rf("travelling", 2, {
        kind: "radio",
        required: true,
        step: "about",
        options: [
          { value: "group", label: "A group" },
          { value: "solo", label: "Just me" },
        ],
      }),
      rf("group_size", 3, { kind: "number", required: true, step: "group" }),
      rf("trip_date", 4, { kind: "date", step: "trip" }),
      rf("interests", 5, {
        kind: "checkboxes",
        required: true,
        step: "trip",
        options: [
          { value: "birds", label: "Birds" },
          { value: "walks", label: "Walks" },
        ],
      }),
      rf("notes", 6, { kind: "textarea", step: "trip" }),
    ],
    ...over,
  });

type Props = InputHTMLAttributes<HTMLInputElement>;

export function Host({
  form,
  options,
  expose,
  gate,
  fresh,
  onRender,
}: {
  form: ResolvedForm;
  options?: FolioFormOptions;
  expose?: (f: FolioForm) => void;
  /** Disable the submit button, as a captcha gate does. */
  gate?: boolean;
  /** Hand the hook a new descriptor object on every render, as an unmemoised host does. */
  fresh?: boolean;
  onRender?: () => void;
}) {
  onRender?.();
  const f = useFolioForm(fresh ? { ...form } : form, options);
  expose?.(f);
  const field = (fld: ResolvedFormField) => {
    const err = f.errorProps(fld);
    if (fld.kind === "radio" || fld.kind === "checkboxes") {
      return (
        <fieldset {...f.groupProps(fld)}>
          <legend id={f.labelProps(fld).id}>{fld.label}</legend>
          {fld.options?.map((o) => (
            <span key={o.value}>
              <input {...(f.controlProps(fld, o) as Props)} />
              {/* biome-ignore lint/a11y/noLabelWithoutControl: htmlFor comes from labelProps */}
              <label {...f.labelProps(fld, o)}>{o.label}</label>
            </span>
          ))}
          {err && <p {...err}>{f.errorFor(fld.name)?.message}</p>}
        </fieldset>
      );
    }
    return (
      <div>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: htmlFor comes from labelProps */}
        <label {...f.labelProps(fld)}>{fld.label}</label>
        {fld.kind === "textarea" ? (
          <textarea {...(f.controlProps(fld) as object)} />
        ) : (
          <input {...(f.controlProps(fld) as Props)} />
        )}
        {err && <p {...err}>{f.errorFor(fld.name)?.message}</p>}
      </div>
    );
  };
  return (
    <div>
      {f.status && (
        <div data-testid="status" {...f.statusProps()}>
          {f.status.message}
        </div>
      )}
      <form data-testid="form" {...f.formProps()}>
        {f.hidden.map((h) => (
          <input key={h.name} type="hidden" name={h.name} value={h.value} />
        ))}
        <input {...f.honeypotProps()} />
        {f.problems.length > 0 && (
          <div data-testid="summary" {...f.summaryProps()}>
            <h2 {...f.summaryTitleProps()}>There is a problem</h2>
            <ul>
              {f.problems.map((p) => (
                <li key={p.name}>
                  <a {...f.problemLinkProps(p)}>{p.message}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {f.layout.steps.map((s) => (
          <div
            key={s.step?.name ?? "all"}
            data-testid={`step-${s.step?.name ?? "all"}`}
            {...f.stepProps(s)}
          >
            {s.step && <h2 {...f.stepLabelProps(s)}>{s.step.label}</h2>}
            {s.sections.map((sec) =>
              sec.rows.map((row) => (
                <div key={row.key}>
                  {row.cells.map((c) => (
                    <div key={c.field.name}>{field(c.field)}</div>
                  ))}
                </div>
              )),
            )}
          </div>
        ))}
        {f.layout.inputs.map((i) => (
          <input key={i.name} {...(f.controlProps(i) as Props)} />
        ))}
        {f.stepped && (
          <button data-testid="back" {...f.backProps()}>
            Back
          </button>
        )}
        {f.stepped && (
          <button data-testid="next" {...f.nextProps()}>
            Next
          </button>
        )}
        <button data-testid="submit" {...f.submitProps()} disabled={gate || f.pending}>
          Send
        </button>
      </form>
    </div>
  );
}
