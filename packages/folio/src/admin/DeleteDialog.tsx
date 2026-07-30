import { useId, useRef, useState } from 'react'
import { descendants, type StoryMeta, type StoryNode } from '../core/story'
import type { DocumentUsage } from './hooks/useDocumentUsage'
import { useFocusTrap } from './hooks/useFocusTrap'

export interface DeleteConfirmation {
  /** The path about to stop existing, `/`-prefixed. */
  label: string
  /** Where a redirect would point, `/`-prefixed (`/` itself for the root). */
  parentLabel: string
  /** Descendants beyond the story itself, so the confirmation can say what
   * else goes with it. */
  descendantCount: number
  /**
   * True for an unrouted document — a record or a singleton
   * (`../../../docs/specs/content-model/data-documents.md`). There is no path to
   * vacate, so there is no redirect to offer and nothing beneath it to warn
   * about; what matters instead is what *points* at it.
   */
  unrouted: boolean
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
  const unrouted = story.path === null
  return {
    // A record's own title, since it has no path to name it by.
    label: unrouted ? story.title : `/${story.path}`,
    parentLabel: parent?.path ? `/${parent.path}` : '/',
    descendantCount: unrouted ? 0 : descendants(rows, story.id).length - 1,
    unrouted,
  }
}

/**
 * The sentence the usage warning leads with (decision 4). Pure and exported so
 * the wording and the singular/plural are tested without mounting.
 *
 * Null when there is nothing to say — nothing points at it, or the count could
 * not be fetched. A dialog that says "used on 0 published pages" is noise; one
 * that says it because a request failed is worse than noise.
 */
export function usageSentence(usage: DocumentUsage | null): string | null {
  if (!usage || usage.total === 0) return null
  return `Used on ${usage.total} published ${usage.total === 1 ? 'document' : 'documents'}.`
}

interface Props {
  story: StoryNode
  /** The tree the admin already holds; `deleteConfirmation` derives the
   * parent and descendant count from it. */
  tree: readonly StoryMeta[]
  busy: boolean
  /** What points at this document, from `GET {base}/documents/:id/usage`. Null
   * while it is in flight, and null if the request failed. */
  usage?: DocumentUsage | null
  onCancel: () => void
  /** `redirect` is the checkbox's value at the moment of confirming. */
  onConfirm: (redirect: boolean) => void
}

/**
 * redirects.md's architecture decision 4: deleting a page offers a redirect
 * to its parent, checked by default — unwanted, the cost is deleting one row;
 * unchecked, the escape hatch for a page that should genuinely 404.
 *
 * data-documents.md's architecture decision 4 adds the other half: a document
 * something else points at **warns with a count and proceeds**. Blocking would
 * mean maintaining referential integrity across draft documents nobody can see,
 * and a broken reference already degrades safely — `resolveReference` returns null
 * and the block renders its empty state.
 */
export function DeleteDialog({ story, tree, busy, usage, onCancel, onConfirm }: Props) {
  const { label, parentLabel, descendantCount, unrouted } = deleteConfirmation(story, tree)
  const [redirect, setRedirect] = useState(true)
  const sentence = usageSentence(usage ?? null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Escape cancels, it never confirms — but only while cancelling is still on
  // offer. Mid-delete the Cancel button is disabled to say the deletion cannot
  // be called back, and a scrim or an Escape that dismissed anyway would be
  // saying the opposite about something irreversible. `stories.remove` reports
  // its own failures and always resolves, so `busy` always clears: this cannot
  // strand anyone in a dialog with no way out.
  const dismiss = () => {
    if (!busy) onCancel()
  }
  useFocusTrap(panel, dismiss)

  return (
    <div className="delete-story">
      {/* Clicking the backdrop cancels, matching the unpublish confirmation.
          `tabIndex={-1}` keeps it out of the cycle — it is the same affordance
          as the panel's Cancel button, and a keyboard user should meet the one
          they can see. */}
      <button
        type="button"
        className="delete-story__scrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismiss}
      />
      {/* The dialog is the panel, not the overlay: the scrim is chrome, and
          naming it part of the dialog would put a bare "Cancel" button inside
          the thing being described. */}
      <div
        ref={panel}
        className="delete-story__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>
          Delete <code>{label}</code>?
        </h3>

        <p>
          {descendantCount > 0
            ? `This removes ${descendantCount} page${descendantCount === 1 ? '' : 's'} beneath it too. `
            : ''}
          This cannot be undone.
        </p>

        {sentence ? (
          <div className="delete-story__usage">
            <p className="delete-story__usage-lead">{sentence}</p>
            <ul>
              {usage?.published.slice(0, 8).map((ref) => (
                <li key={`${ref.id}:${ref.kind}`}>
                  {ref.url ? <code>{ref.url}</code> : <span>{ref.title}</span>}
                  <span className="delete-story__usage-kind">{ref.kind}</span>
                </li>
              ))}
            </ul>
            {usage && usage.published.length > 8 ? (
              <p className="delete-story__usage-more">…and {usage.published.length - 8} more.</p>
            ) : null}
            {/* The caveat, stated rather than implied: `content_refs` is written
                at publish, so a draft that references this is not counted here. */}
            <p className="delete-story__usage-note">
              Published references only. A draft that points here is not counted. Those blocks will
              render their empty state.
            </p>
          </div>
        ) : null}

        {/* No path to vacate means no redirect to offer. */}
        {unrouted ? null : (
          <label className="delete-story__redirect">
            <input
              type="checkbox"
              checked={redirect}
              onChange={(e) => setRedirect(e.target.checked)}
            />
            Redirect <code>{label}</code> to <code>{parentLabel}</code>
          </label>
        )}

        <div className="delete-story__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => onConfirm(unrouted ? false : redirect)}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
