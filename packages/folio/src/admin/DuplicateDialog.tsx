import { useId, useRef, useState } from 'react'
import type { StoryNode } from '../core/story'
import { useFocusTrap } from './hooks/useFocusTrap'

interface Props {
  story: StoryNode
  busy: boolean
  onCancel: () => void
  onConfirm: (title: string) => void
}

/**
 * duplicate-and-paste.md's architecture decision 5: the root cannot share its
 * own '' path, so its duplicate is an ordinary top-level page instead — named
 * here, since that is the one case "where it will land" is not obvious.
 * Decision 4 (no version history) and "the draft is copied" (the editor sees
 * exactly what is on screen, not the last published snapshot) are worth
 * saying too, per the spec's edge case on duplicating a page with unpublished
 * changes.
 */
export function DuplicateDialog({ story, busy, onCancel, onConfirm }: Props) {
  const isRoot = story.path === ''
  const [title, setTitle] = useState(`${story.title} (copy)`)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Inert while the duplicate is in flight, matching the Cancel button beneath.
  // `stories.duplicate` reports its own failures and always resolves, so `busy`
  // always clears.
  const dismiss = () => {
    if (!busy) onCancel()
  }
  useFocusTrap(panel, dismiss)

  return (
    <div className="duplicate-story">
      {/* Clicking the backdrop cancels, matching the delete confirmation.
          `tabIndex={-1}` keeps it out of the cycle: the visible Cancel button is
          the keyboard route out. */}
      <button
        type="button"
        className="duplicate-story__scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismiss}
      />
      {/* The dialog is the panel, not the overlay, so the scrim's own "Cancel"
          label stays outside the region the dialog names. */}
      <div
        ref={panel}
        className="duplicate-story__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>Duplicate {isRoot ? 'the homepage' : <code>/{story.path}</code>}?</h3>

        <p>
          {isRoot
            ? 'The homepage stays where it is: this creates an ordinary, top-level page instead.'
            : 'This creates a new page next to it.'}{' '}
          It starts from the current draft — including anything not yet published — and begins with
          no version history of its own. Nothing about the source page changes.
        </p>

        {/* No `autoFocus`: it fires during commit, before the trap's effect
            reads `document.activeElement` to remember the opener, so the dialog
            would record *itself* as what to restore focus to and the tree row
            that opened it would never get focus back. The trap lands on the
            first tabbable control, which is this input anyway. */}
        <label className="duplicate-story__title">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="duplicate-story__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onConfirm(title)}
            disabled={busy || !title.trim()}
          >
            {busy ? 'Duplicating…' : 'Duplicate'}
          </button>
        </div>
      </div>
    </div>
  )
}
