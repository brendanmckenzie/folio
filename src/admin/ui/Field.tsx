import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useId } from 'react'
import css from './Field.module.css'

interface FieldProps {
  label: ReactNode
  /** Below the control. Explanation, not error. */
  help?: ReactNode
  /** Below the control, and takes the place of `help` while set. */
  error?: ReactNode
  required?: boolean
  /** Right of the label. A locale note, a peer's name, "shared". */
  note?: ReactNode
  /** Receives the generated id, so the label points at the real control. */
  children: (id: string) => ReactNode
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
export function Field({ label, help, error, required, note, children }: FieldProps) {
  const id = useId()
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>
        {label}
        {required ? (
          <span className={css.required} aria-hidden="true">
            *
          </span>
        ) : null}
        {note ? <span className={css.note}>{note}</span> : null}
      </label>
      {children(id)}
      {error ? (
        <p className={css.error}>{error}</p>
      ) : help ? (
        <p className={css.help}>{help}</p>
      ) : null}
    </div>
  )
}

export function Input(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input {...props} className={css.control} />
}

export function Textarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return <textarea {...props} className={`${css.control} ${css.textarea}`} />
}

export function Select(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>) {
  return <select {...props} className={css.control} />
}
