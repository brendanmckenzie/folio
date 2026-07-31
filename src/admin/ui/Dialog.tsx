import type { ReactNode } from 'react'
import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../hooks/useFocusTrap'
import css from './Dialog.module.css'

interface Props {
  title: ReactNode
  /** One line under the title. "This cannot be undone", and nothing longer. */
  description?: ReactNode
  /** Wider than the default 420px. `wide` is for a picker; `full` for the media
   * library, which is a grid rather than a question. */
  size?: 'default' | 'wide'
  onClose: () => void
  /** Rendered right-aligned in the footer, in reading order: cancel, then the
   * action. The action carries its own variant. */
  actions?: ReactNode
  children?: ReactNode
  /**
   * This dialog's action destroys something.
   *
   * `docs/design-system.md`'s primitive table specifies this prop and the first
   * implementation dropped it, which showed up as soon as there was a destructive
   * dialog to look at: `variant="danger"` is a **quiet** button by design — red
   * text, tinted only on hover — because it also serves a row's controls and a bulk
   * bar, where a solid red slab per row would be shouting. In a dialog footer that
   * left Cancel, which has a border, looking heavier than Delete, which did not.
   * The affirmative action reading as the lesser of the two is the worst possible
   * hierarchy for the one control that cannot be undone.
   *
   * So the *dialog* carries the signal rather than the button growing a fifth
   * variant: a red top edge on the panel, and the footer's danger button rendered
   * at its own hover weight — bordered and tinted at rest. Both use the existing
   * `--state-danger-*` tokens, so both themes are covered by construction.
   */
  danger?: boolean
}

/**
 * The only dialog. Replaces five overlay namespaces in `admin.css` — `.library`,
 * `.unpublish`, `.delete-story`, `.duplicate-story`, `.discard` — which between
 * them served six dialogs, one of which had given up and rendered itself as
 * another's (`PublishDialog.tsx` used `.discard`). `ROADMAP.md` already called a
 * seventh dialog the trigger for this; the seventh had quietly arrived.
 *
 * Two behaviours are carried over deliberately rather than reinvented:
 *
 * - **`useFocusTrap` on the panel, not the wrapper.** Focus in on open, back to
 *   the opener on close, Tab cycles, Escape dismisses. Pointing it at the
 *   wrapper would pull the scrim into the cycle and put a bare button inside the
 *   region the dialog names.
 * - **No `autoFocus` anywhere inside.** React applies it during commit, before
 *   the trap reads `activeElement` to remember who opened the dialog, so the two
 *   fight and the opener is lost.
 *
 * New: it portals to `document.body`. The media library is currently
 * `position: fixed` markup living inside an asset field's own subtree, which
 * works only because nothing above it happens to establish a containing block.
 */
export function Dialog({
  title,
  description,
  size = 'default',
  onClose,
  actions,
  children,
  danger,
}: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useFocusTrap(panel, onClose)

  return createPortal(
    <div className={css.wrap}>
      {/*
        A real button so the scrim is a click target with a name, held out of the
        tab cycle because Escape is the keyboard way out and a nameless stop
        before every dialog is noise.
      */}
      <button
        type="button"
        className={css.scrim}
        tabIndex={-1}
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={[css.panel, size === 'wide' ? css.wide : '', danger ? css.danger : '']
          .filter(Boolean)
          .join(' ')}
      >
        <div className={css.head}>
          <h2 id={titleId} className={css.title}>
            {title}
          </h2>
          {description ? (
            <p id={descId} className={css.description}>
              {description}
            </p>
          ) : null}
        </div>
        {children ? <div className={css.body}>{children}</div> : null}
        {actions ? <div className={css.foot}>{actions}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
