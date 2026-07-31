import type { CSSProperties, ReactNode } from 'react'
import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { Button } from '../Button'
import css from './FocusMode.module.css'
import { FOCUS_MEASURE_CH } from './inspector-model'

interface Props {
  /** The field's own label. This overlay is one field, so it is the whole heading. */
  title: string
  /** The locale note, repeated: somebody who opened focus mode from a translation
   * column has to still be able to see which language they are writing. */
  note?: ReactNode
  /** The read-only source-locale column, at the same measure, below the prose. */
  source?: ReactNode
  /** The toolbar and the prose surface. See `RichTextField`. */
  children: ReactNode
  onClose: () => void
}

/**
 * One richtext field, alone over the stage, at a readable measure.
 *
 * **A container, not a second editor.** The `children` handed in are the *same*
 * `<EditorContent>` element the inspector was rendering, from the same
 * `useRichtext` hook instance, so a keystroke here takes the identical path a
 * keystroke in the 340px column takes: `onUpdate` → `onChange` →
 * `blocks.setField` → `store.tx`. There is no second write path to keep in step
 * because there is no second editor. `useRichtext`'s header carries the mechanism
 * (TipTap's `EditorContent` re-parents `editor.view.dom` rather than rebuilding it),
 * and `RichTextField` is the component that never unmounts across the toggle.
 *
 * This is `ui-architecture.md`'s decision 5 in full: the answer to richtext at 340px
 * is a measure, not more pixels, because widening the inspector for the one field
 * kind that needs it costs preview width on every screen where prose is not being
 * edited.
 *
 * `useFocusTrap` and not a seventh hand-rolled trap — it is the only one in the
 * admin and six dialogs use it. Escape closes; focus returns to the field in the
 * inspector, which `RichTextField` does rather than the trap, because by the time
 * this mounts the element the trap would have remembered has already been
 * re-parented out from under it.
 */
export function FocusMode({ title, note, source, children, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(panel, onClose)

  return createPortal(
    <div className={css.wrap} style={{ '--measure': `${FOCUS_MEASURE_CH}ch` } as CSSProperties}>
      <button
        type="button"
        className={css.scrim}
        tabIndex={-1}
        aria-label="Close focus mode"
        onClick={onClose}
      />
      <div
        ref={panel}
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={css.head}>
          <h2 id={titleId} className={css.title}>
            {title}
          </h2>
          {note ? <span className={css.note}>{note}</span> : null}
          <span className={css.spacer} />
          <span className={css.hint}>
            <kbd>Esc</kbd> to close
          </span>
        </div>

        <div className={css.body}>{children}</div>

        {source ? <div className={css.source}>{source}</div> : null}

        <div className={css.foot}>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
