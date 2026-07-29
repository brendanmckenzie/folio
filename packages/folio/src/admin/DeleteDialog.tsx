import { useState } from 'react'
import { descendants, type StoryMeta, type StoryNode } from '../core/story'

export interface DeleteConfirmation {
  /** The path about to stop existing, `/`-prefixed. */
  label: string
  /** Where a redirect would point, `/`-prefixed (`/` itself for the root). */
  parentLabel: string
  /** Descendants beyond the story itself, so the confirmation can say what
   * else goes with it. */
  descendantCount: number
}

/**
 * What the confirmation needs to say, computed from the tree the admin
 * already holds: the path being removed, where redirects.md's architecture
 * decision 4 would point a redirect (the nearest surviving ancestor — the
 * deleted node's own parent, since the whole subtree goes together), and how
 * much else is going with it.
 */
export function deleteConfirmation(
  story: StoryMeta,
  rows: readonly StoryMeta[],
): DeleteConfirmation {
  const parent = story.parentId ? rows.find((r) => r.id === story.parentId) : undefined
  return {
    label: `/${story.path}`,
    parentLabel: parent ? `/${parent.path}` : '/',
    descendantCount: descendants(rows, story.id).length - 1,
  }
}

interface Props {
  story: StoryNode
  /** The tree the admin already holds; `deleteConfirmation` derives the
   * parent and descendant count from it. */
  tree: readonly StoryMeta[]
  busy: boolean
  onCancel: () => void
  /** `redirect` is the checkbox's value at the moment of confirming. */
  onConfirm: (redirect: boolean) => void
}

/**
 * redirects.md's architecture decision 4: deleting a page offers a redirect
 * to its parent, checked by default — unwanted, the cost is deleting one row;
 * unchecked, the escape hatch for a page that should genuinely 404.
 */
export function DeleteDialog({ story, tree, busy, onCancel, onConfirm }: Props) {
  const { label, parentLabel, descendantCount } = deleteConfirmation(story, tree)
  const [redirect, setRedirect] = useState(true)

  return (
    <div className="delete-story" role="dialog" aria-label="Delete page">
      {/* Clicking the backdrop cancels, matching the unpublish confirmation. */}
      <button
        type="button"
        className="delete-story__scrim"
        aria-label="Cancel"
        onClick={onCancel}
      />
      <div className="delete-story__panel">
        <h3>
          Delete <code>{label}</code>?
        </h3>

        <p>
          {descendantCount > 0
            ? `This removes ${descendantCount} page${descendantCount === 1 ? '' : 's'} beneath it too. `
            : ''}
          This cannot be undone.
        </p>

        <label className="delete-story__redirect">
          <input
            type="checkbox"
            checked={redirect}
            onChange={(e) => setRedirect(e.target.checked)}
          />
          Redirect <code>{label}</code> to <code>{parentLabel}</code>
        </label>

        <div className="delete-story__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => onConfirm(redirect)}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
