import { useId, useRef } from 'react'
import type { summariseDiff } from '../core/diff'
import { useFocusTrap } from './hooks/useFocusTrap'

/**
 * Named counts for the confirmation, in the same "what is about to happen"
 * framing `restore()` itself applies: `delta` is `diff(live, published)`
 * (`useVersions.delta`), so an `added` count here is a block the discard
 * brings back, not one it removes — the literal mutations about to be sent,
 * not `describeAgainstDraft`'s reversed History-rail phrasing.
 */
export function discardSummary(delta: ReturnType<typeof summariseDiff> | null): string {
  if (!delta || delta.total === 0) return 'no changes'
  return [
    delta.edited && `${delta.edited} edited`,
    delta.added && `${delta.added} added back`,
    delta.removed && `${delta.removed} removed`,
    delta.moved && `${delta.moved} moved`,
  ]
    .filter(Boolean)
    .join(', ')
}

interface Props {
  delta: ReturnType<typeof summariseDiff> | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * `unpublished-changes.md`'s owner decision 1: discard is a restore, not a
 * delete. It applies `diff(draft, published)` as one ordinary transaction, so
 * it syncs to other editors, lands in the activity trail, and Cmd+Z brings the
 * work back — the confirmation exists only so a slip of the mouse cannot look
 * indistinguishable from that outcome.
 */
export function DiscardDialog({ delta, busy, onConfirm, onCancel }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Inert while the restore is in flight, matching the Cancel button beneath.
  // `versions.restore` reports its own failures and always resolves, so `busy`
  // always clears.
  const dismiss = () => {
    if (!busy) onCancel()
  }
  useFocusTrap(panel, dismiss)

  return (
    <div className="discard">
      {/* Clicking the backdrop cancels, matching the delete and unpublish
          confirmations. `tabIndex={-1}` keeps it out of the cycle: the visible
          Cancel button is the keyboard route out. */}
      <button
        type="button"
        className="discard__scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismiss}
      />
      {/* The dialog is the panel, not the overlay, so the scrim's own "Cancel"
          label stays outside the region the dialog names. */}
      <div
        ref={panel}
        className="discard__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>Discard unpublished changes?</h3>

        <p>
          This applies {discardSummary(delta)} to go back to what is live. It is an ordinary edit —
          it syncs to every editor, appears in the activity trail, and Cmd+Z brings the work back.
        </p>

        <div className="discard__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Discarding…' : 'Discard changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
