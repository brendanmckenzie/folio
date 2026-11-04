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
   * A length counter at the label's end: `42 / 60`. `near` draws it in the warning
   * colour, `over` in the danger colour of the sentence a field shows once it is past
   * the limit, so the two cues in one field agree. Advisory, so nothing is refused
   * (`authoring-guidance.md` decision 14).
   */
  count?: { text: string; over: boolean; near?: boolean };
  /** Under the help line: a field's "Writing guide" disclosure. */
  detail?: ReactNode;
  /**
   * The control sits **beside** the label rather than under it, with the help text
   * under the label. For a boolean and nothing else: every other control fills the
   * column, and a 16px checkbox under its own label reads as a field whose value has
   * gone missing. `Field.module.css`'s `.inline` argues the layout.
   */
  inline?: boolean;
  /**
   * Receives the generated id, so the label points at the real control, and the
   * counter's id when there is a `count`, for the control's `aria-describedby`.
   */
  children: (id: string, describedBy?: string) => ReactNode;
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
  const countId = `${id}-count`;
  const labelEl = (
    <label className={css.label} htmlFor={id}>
      {label}
      {required ? (
        <span className={css.required} aria-hidden="true">
          *
        </span>
      ) : null}
      {note ? <span className={css.note}>{note}</span> : null}
    </label>
  );
  return (
    <div className={inline ? `${css.field} ${css.inline}` : css.field}>
      {/*
        The counter sits beside the label and **outside** it: inside a `<label>` its text
        would be part of the input's accessible name, re-announced on every keystroke
        ("Heading 42 / 60"). It describes the control instead, through the id handed to
        `children` for `aria-describedby`.
      */}
      {count ? (
        <div className={css.labelRow}>
          {labelEl}
          <span id={countId} className={countClass(count)}>
            {count.text}
          </span>
        </div>
      ) : (
        labelEl
      )}
      {children(id, count ? countId : undefined)}
      {error ? (
        <p className={css.error}>{error}</p>
      ) : help ? (
        <p className={css.help}>{help}</p>
      ) : null}
      {detail ?? null}
    </div>
  );
}

function countClass(count: { over: boolean; near?: boolean }): string | undefined {
  if (count.over) return `${css.count} ${css.over}`;
  if (count.near) return `${css.count} ${css.near}`;
  return css.count;
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
