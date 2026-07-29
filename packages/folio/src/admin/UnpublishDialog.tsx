import { liveDescendants, type StoryMeta, type StoryNode } from '../core/story'

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

  return (
    <div className="unpublish" role="dialog" aria-label="Unpublish page">
      {/* Clicking the backdrop cancels, matching the media library's modal. */}
      <button type="button" className="unpublish__scrim" aria-label="Cancel" onClick={onCancel} />
      <div className="unpublish__panel">
        <h3>Unpublish {isRoot ? 'the site root' : <code>{label}</code>}?</h3>

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
