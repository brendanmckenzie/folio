import type { ButtonHTMLAttributes, ReactNode } from 'react'
import css from './Button.module.css'

export type ButtonVariant = 'primary' | 'default' | 'subtle' | 'danger'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** Fills the width of its container. For a dialog footer, never. */
  block?: boolean
  /**
   * Why this is disabled. Rendered as the title, because the system's rule is
   * that a refusal explains itself — a greyed control with no explanation is the
   * thing `TopBar.tsx` already goes out of its way to avoid. Ignored unless
   * `disabled`, so passing both is safe.
   */
  reason?: string
  children?: ReactNode
}

/**
 * The only button. Four variants, two sizes, and nothing else — the old
 * stylesheet had `.btn-primary`, `.btn-danger` and roughly twenty per-panel
 * overrides of the bare `button` element, which is how a "secondary" button
 * ended up looking different in six places.
 *
 * `subtle` is the one that earns its place: row actions, table actions and menu
 * triggers all want a button that is invisible at rest and bordered on hover,
 * and every one of them hand-rolled it.
 */
export function Button({
  variant = 'default',
  size = 'md',
  block,
  reason,
  disabled,
  title,
  type = 'button',
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      title={disabled ? (reason ?? title) : title}
      /*
       * The variant, addressable from a container. CSS modules hash the class
       * names, so `.danger .foot button` in `Dialog.module.css` has no way to say
       * "the danger one" without this — and a destructive dialog needs to raise its
       * own action's weight without `Button` growing a fifth variant that only ever
       * made sense inside one component. See `Dialog`'s `danger` prop.
       */
      data-variant={variant}
      className={[css.btn, css[variant], css[size], block ? css.block : ''].join(' ')}
    >
      {children}
    </button>
  )
}
