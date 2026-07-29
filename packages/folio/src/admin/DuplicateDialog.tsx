import { useState } from 'react'
import type { StoryNode } from '../core/story'

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

  return (
    <div className="duplicate-story" role="dialog" aria-label="Duplicate page">
      {/* Clicking the backdrop cancels, matching the delete confirmation. */}
      <button
        type="button"
        className="duplicate-story__scrim"
        aria-label="Cancel"
        onClick={onCancel}
      />
      <div className="duplicate-story__panel">
        <h3>Duplicate {isRoot ? 'the homepage' : <code>/{story.path}</code>}?</h3>

        <p>
          {isRoot
            ? 'The homepage stays where it is: this creates an ordinary, top-level page instead.'
            : 'This creates a new page next to it.'}{' '}
          It starts from the current draft — including anything not yet published — and begins with
          no version history of its own. Nothing about the source page changes.
        </p>

        <label className="duplicate-story__title">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
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
