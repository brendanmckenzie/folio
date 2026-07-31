/**
 * How a Content row's state and timestamp read.
 *
 * What is left of this file after the port, and the reduction is the interesting
 * part. It used to hold `flatten` too — a walk over a whole `StoryNode` tree with
 * every child in hand, filtering client-side and keeping a match's ancestors. All
 * three of those assumptions died with per-level paging
 * (`docs/specs/foundation/pagination.md` decision 2): there is no whole tree to
 * walk, a filter is the server's to answer, and "keep a match's ancestors" is not
 * expressible one level at a time — see `content-model.ts`'s `withFilter`.
 *
 * These two survived unchanged because they are about a **row**, not about the
 * tree, which is also why they stayed here rather than moving next door: nothing
 * in them knows that a tree exists.
 */
import type { StoryNode, StoryState } from '../../../core/story'
import type { BadgeTone } from '../Badge'

/**
 * One tone per state, from `docs/design-system.md`'s table. `draft` is
 * **neutral**, which is the review's one deliberate change to the old palette: a
 * draft is the normal state of new content, not a warning, and it wore the same
 * amber as a schema drift.
 */
export function stateTone(state: StoryState): BadgeTone {
  switch (state) {
    case 'live':
      return 'ok'
    case 'changed':
      return 'accent'
    case 'unpublished':
      return 'danger'
    case 'draft':
      return 'neutral'
  }
}

/**
 * The row's timestamp, and *which* timestamp is the point: `draftUpdatedAt` is
 * when the document last changed, `updatedAt` is when its row did — a move or a
 * rename. Preferring the draft watermark means "last edited" says what an editor
 * means by it.
 *
 * The same `coalesce` flat mode's `sort=edited` does in SQL, and for the same
 * reason: `draftUpdatedAt` is null until a document's first debounced write, so
 * reading the bare column would call a page created five minutes ago the oldest
 * thing on the site. One rule, stated twice because one end of it is SQL — and
 * pinned by a test that runs the sort and this function over the same rows.
 *
 * Relative, and coarse on purpose: a tree is scanned, and "3 days ago" is read at
 * a glance where a date is parsed. `now` is a parameter so this is pure — every
 * other function here is, and a clock read inside would make it the one thing a
 * test could not pin.
 */
export function when(
  node: Pick<StoryNode, 'updatedAt' | 'draftUpdatedAt'>,
  now: number = Date.now(),
): string {
  const at = node.draftUpdatedAt ?? node.updatedAt
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  // Past a month, a date is more use than a number of days nobody counts in.
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
