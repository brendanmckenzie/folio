import css from './Toast.module.css'
import { scoped } from './scope'

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
 *
 * **`scoped`, and it is not optional.** This is rendered as a *sibling* of
 * `Shell` (`Admin.tsx`), so unlike everything else in the admin it is not
 * inside the shell's `.folio-ui` and inherits nothing from it — which shipped,
 * and showed up as a toast rendered in the browser's default serif. `Times` was
 * the visible half; it was also missing `box-sizing: border-box` and the one
 * focus treatment, and every `var(--*)` it names below resolves off `:root`
 * only by luck of that tier being unscoped.
 *
 * It does not portal, because a root-level sibling is already where a portal
 * would put it — which is exactly why `ui-scope.test.ts`'s portal sweep did not
 * catch this. That test now asks the question by *stylesheet* instead: anything
 * `position: fixed` is a surface of its own and has to carry the scope.
 */
export function Toast({ message }: { message: string | null }) {
  return (
    <div className={scoped(css.toast)} role="status" aria-live="polite">
      {message}
    </div>
  )
}
