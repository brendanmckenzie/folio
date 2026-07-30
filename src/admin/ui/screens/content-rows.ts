/**
 * The Content screen's arithmetic: what rows a tree, a set of closed nodes and a
 * filter produce, and how a row's state and timestamp read.
 *
 * Separate from the component for the reason every pure module in `ui/` is: the
 * admin's tests run in Node and mount nothing, so a screen's *logic* has to be
 * somewhere a test can reach. What is left in `Content.tsx` is markup and event
 * wiring, which is the part a browser has to judge anyway.
 */
import type { StoryNode, StoryState } from '../../../core/story'
import type { BadgeTone } from '../Badge'

export type StateFilter = 'all' | StoryState

export interface TreeRow {
  node: StoryNode
  depth: number
}

export interface FlattenOptions {
  /** Ids whose children are hidden. Collapse is the *exception* stored here, not
   * the rule: a fresh tree is fully expanded, so a site nobody has clicked
   * through shows everything it has. */
  closed: ReadonlySet<string>
  state: StateFilter
  search: string
}

/**
 * The tree as a flat list of rows with a depth each — the shape `Row`'s `depth`
 * prop wants, and the shape ↑ ↓ traversal needs, since a keyboard walks the rows
 * that are *visible* rather than the structure.
 *
 * **A match keeps its ancestors.** That is the one non-obvious rule here, and it
 * is what makes filtering a tree usable rather than confusing: a filtered tree
 * that drops the parents of its matches turns nested pages into a flat list at
 * random depths, and the indent stops meaning anything. An ancestor kept only
 * because a descendant matched is marked by nothing special — it is a real page,
 * and clicking it is a reasonable thing to want to do.
 *
 * A closed node still hides its children even when one of them matches, because
 * the person closed it. The count in the footnote is what tells them the
 * difference.
 */
export function flatten(tree: readonly StoryNode[], opts: FlattenOptions): TreeRow[] {
  const needle = opts.search.trim().toLowerCase()
  const filtering = needle !== '' || opts.state !== 'all'

  const walk = (nodes: readonly StoryNode[], depth: number): TreeRow[] =>
    nodes.flatMap((node) => {
      const children = opts.closed.has(node.id) ? [] : walk(node.children, depth + 1)
      if (!filtering) return [{ node, depth }, ...children]
      // Kept when it matches, or when anything below it did.
      if (matches(node, needle, opts.state) || children.length > 0) {
        return [{ node, depth }, ...children]
      }
      return []
    })

  return walk(tree, 0)
}

function matches(node: StoryNode, needle: string, state: StateFilter): boolean {
  if (state !== 'all' && node.state !== state) return false
  if (needle === '') return true
  // Title, slug and path: the three things a person types when looking for a
  // page. Path matters most — it is the one that is unique.
  return (
    node.title.toLowerCase().includes(needle) ||
    node.slug.toLowerCase().includes(needle) ||
    (node.path ?? '').toLowerCase().includes(needle)
  )
}

/**
 * One tone per state, from `docs/design-system.md`'s table. `draft` is
 * **neutral**, which is the review's one deliberate change to the old palette: a
 * draft is the normal state of new content, not a warning, and it currently wears
 * the same amber as a schema drift.
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
