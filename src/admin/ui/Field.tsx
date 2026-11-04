import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import css from "./Field.module.css";

interface FieldProps {
  label: ReactNode;
  /** Below the control. Explanation, not error. */
  help?: ReactNode;
  /** Below the control, and takes the place of `help` while set. */
  error?: ReactNode;
  required?: boolean;
  /** Right of the label. A locale note, a peer's name, "shared". */
  note?: ReactNode;
  /**
   * A length counter at the label's end: `42 / 60`. `over` draws it in the warning
   * colour. Advisory, so nothing is refused (`authoring-guidance.md` decision 14).
   */
  count?: { text: string; over: boolean };
  /** Under the help line: a field's "Writing guide" disclosure. */
  detail?: ReactNode;
  /**
   * The control sits **beside** the label rather than under it, with the help text
   * under the label. For a boolean and nothing else: every other control fills the
   * column, and a 16px checkbox under its own label reads as a field whose value has
   * gone missing. `Field.module.css`'s `.inline` argues the layout.
   */
  inline?: boolean;
  /** Receives the generated id, so the label points at the real control. */
  children: (id: string) => ReactNode;
}

/**
 * Label, control, and one line of explanation. The old `.field` carried the same
 * idea and every panel then re-declared the input rules underneath it, which is
 * how the data table's search box ended up as a bare browser default.
 *
 * The child is a function of the generated id rather than a plain node: it is the
 * only way to guarantee the label points at the control without every caller
 * inventing an id, and an unlabelled input in a CMS is a field nobody can
 * describe to a translator.
 */
export function Field({
  label,
  help,
  error,
  required,
  note,
  count,
  detail,
  inline,
  children,
}: FieldProps) {
  const id = useId();
  return (
    <div className={inline ? `${css.field} ${css.inline}` : css.field}>
      <label className={css.label} htmlFor={id}>
        {label}
        {required ? (
          <span className={css.required} aria-hidden="true">
            *
          </span>
        ) : null}
        {note ? <span className={css.note}>{note}</span> : null}
        {count ? (
          <span className={count.over ? `${css.count} ${css.over}` : css.count}>{count.text}</span>
        ) : null}
      </label>
      {children(id)}
      {error ? (
        <p className={css.error}>{error}</p>
      ) : help ? (
        <p className={css.help}>{help}</p>
      ) : null}
      {detail ?? null}
    </div>
  );
}

export function Input(props: Omit<InputHTMLAttributes<HTMLInputElement>, "className">) {
  return <input {...props} className={css.control} />;
}

export function Textarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">) {
  return <textarea {...props} className={`${css.control} ${css.textarea}`} />;
}

export function Select(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">) {
  return <select {...props} className={css.control} />;
}
