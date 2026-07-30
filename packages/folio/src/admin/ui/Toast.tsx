import css from './Toast.module.css'

/**
 * The transient message. Carried over from `admin.css` rather than redesigned,
 * because its one non-obvious property is load-bearing and easy to lose:
 *
 * **It is always mounted.** A live region has to be in the DOM before its text
 * changes for a screen reader to announce it reliably, so only the text toggles.
 * With no message it has no child text node and `:empty` collapses it to a
 * zero-size, inert box — invisible and out of layout rather than unmounted.
 *
 * It also sits outside the flow of any toolbar: a transient message must never
 * reflow a control somebody is about to click.
 */
export function Toast({ message }: { message: string | null }) {
  return (
    <div className={css.toast} role="status" aria-live="polite">
      {message}
    </div>
  )
}
