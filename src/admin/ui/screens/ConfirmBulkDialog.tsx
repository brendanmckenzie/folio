import { Button } from '../Button'
import { Dialog } from '../Dialog'
import type { Confirmation } from './content-model'

/**
 * The question before a bulk write, and the one after a refused one.
 *
 * **Its whole job is naming the invisible part** (`ui-architecture.md`
 * decision 7a): *"Publish 12 pages? 9 are not shown by the current filter."*
 * Acting on more than you can see is the hazard, so that is where it gets said —
 * and for a select-all it also restates the conditions the selection captured,
 * because "51,420 pages" without *matching what* is a number nobody can check.
 *
 * **The sentences are not here.** `confirmOf` and `refusalOf` build them in
 * `content-model.ts` and this file renders whichever it is handed, which is the
 * admin's testing convention taken literally: no test mounts a component, so
 * wording only reachable by rendering is wording nobody will test. The two shapes
 * are the same `Confirmation`, so the 409's re-confirmation is this dialog with a
 * different question rather than a second dialog that drifts from it.
 *
 * No focus trap of its own, and no `autoFocus`: `Dialog` owns both, and
 * `autoFocus` fights the trap because React applies it before the trap reads
 * `activeElement` to remember the opener.
 */
export function ConfirmBulkDialog({
  confirmation,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  confirmation: Confirmation
  /** The affirmative button — `verbOf` for a question, `retryLabel` for a refusal,
   * so it never reads as a bare *OK*. */
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      title={confirmation.title}
      description={confirmation.body}
      {...(confirmation.danger ? { danger: true } : {})}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={confirmation.danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}
