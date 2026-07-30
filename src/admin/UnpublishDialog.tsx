import { useId, useRef } from 'react'
import { liveDescendants, type StoryMeta, type StoryNode } from '../core/story'
import { useFocusTrap } from './hooks/useFocusTrap'

export interface UnpublishConfirmation {
  isRoot: boolean
  /** The path that will stop serving, `/`-prefixed. */
  label: string
  /** Live descendants, `/`-prefixed, that `unpublish.md`'s architecture
   * decision 3 does not cascade to — named so the editor is not left to guess
   * what stays up. */
  descendantPaths: string[]
}

/**
 * What the confirmation needs to say, computed from the tree the admin
 * already holds rather than a second fetch: whether this is the root story,
 * the path being taken down, and which live descendants stay live.
 */
export function unpublishConfirmation(
  story: StoryMeta,
  rows: readonly StoryMeta[],
): UnpublishConfirmation {
  const isRoot = story.path === ''
  return {
    isRoot,
    label: isRoot ? '/' : `/${story.path}`,
    descendantPaths: liveDescendants(rows, story.id).map((d) => `/${d.path}`),
  }
}

interface Props {
  story: StoryNode
  /** The tree the admin already holds; `unpublishConfirmation` derives the
   * descendant list from it. */
  tree: readonly StoryMeta[]
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * `unpublish.md`'s architecture decision 3: no cascade, but the editor is told
 * what stays live rather than left to guess. Decision 4: the root story may be
 * unpublished, with its own wording since "/" is a different kind of drastic
 * than an ordinary page.
 */
export function UnpublishDialog({ story, tree, busy, onConfirm, onCancel }: Props) {
  const { isRoot, label, descendantPaths } = unpublishConfirmation(story, tree)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Inert while the unpublish is in flight, matching the Cancel button beneath.
  // `publish.unpublish` reports its own failures and always resolves, so `busy`
  // always clears.
  const dismiss = () => {
    if (!busy) onCancel()
  }
  useFocusTrap(panel, dismiss)

  return (
    <div className="unpublish">
      {/* Clicking the backdrop cancels, matching the media library's modal.
          `tabIndex={-1}` keeps it out of the cycle: the visible Cancel button is
          the keyboard route out. */}
      <button
        type="button"
        className="unpublish__scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismiss}
      />
      {/* The dialog is the panel, not the overlay, so the scrim's own "Cancel"
          label stays outside the region the dialog names. */}
      <div
        ref={panel}
        className="unpublish__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>Unpublish {isRoot ? 'the site root' : <code>{label}</code>}?</h3>

        <p>
          <code>{label}</code> will stop serving. The draft is kept — it stays editable and
          previewable, and republishing is one click.
        </p>

        {descendantPaths.length > 0 ? (
          <div className="unpublish__descendants">
            <p>These pages are not cascaded, and stay live:</p>
            <ul>
              {descendantPaths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="unpublish__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Unpublishing…' : 'Unpublish'}
          </button>
        </div>
      </div>
    </div>
  )
}
