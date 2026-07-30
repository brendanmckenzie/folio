import { useMemo, useState } from 'react'
import type { StoryNode } from '../../../core/story'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { List, ListHeader, Row } from '../List'
import { href, type Screen } from '../route'
import { type StateFilter, flatten, stateTone, when } from './content-rows'
import css from './Content.module.css'

interface Props {
  tree: readonly StoryNode[]
  loading: boolean
  mount: string
  /** The open document, if the editor was reached from here — so walking back to
   * the tree shows you where you were. */
  selected?: string
  query: Readonly<Record<string, string>>
  onQuery: (next: Record<string, string | undefined>) => void
  onOpen: (screen: Screen) => void
  /**
   * Whether to draw the type badge. False when every page in the tree is the same
   * type, where the column is one word repeated on every row — the exact noise
   * `docs/ui-review.md` complained about in the old rail, reproduced faithfully on
   * the first render of this screen until I looked at it.
   *
   * Computed from the **whole tree**, not from the filtered rows and not from the
   * manifest: the rows would make a column appear and vanish as somebody types,
   * and the manifest would keep the column on a site that declares a second page
   * type and has never used it.
   */
  showType: boolean
}

/** Eight placeholder rows, named rather than indexed — an index key on a list
 * that never reorders is harmless, but writing one teaches the wrong habit for the
 * lists here that do. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']

const FILTERS: { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'changed', label: 'Changed' },
  { value: 'live', label: 'Live' },
  { value: 'unpublished', label: 'Unpublished' },
]

/**
 * The page tree, given the whole screen instead of 280px — which is most of what
 * `docs/ui-review.md` found wrong with it. The path stops truncating, the state
 * badge and the timestamp fit at once, and the type is a column rather than a word
 * repeated on every row.
 *
 * Two findings from building it, both worth carrying into the port:
 *
 * 1. **The expand twisty and the drag handle want the same slot.** `Row`'s
 *    `handle` was designed for the drag affordance, and a tree needs a disclosure
 *    control in exactly that position. Here the twisty takes it and there is no
 *    dragging yet; the Content port needs `Row` to hold both, and the twisty is
 *    the one that must never be draggable.
 * 2. **State comes from `StoryMeta.state`, which the server derives** — so the
 *    filter is a client-side predicate over a field, not a query the tree route
 *    would need to learn. That is true until the tree is paged, at which point the
 *    same predicate has to move server-side and the chip has to serialise; see
 *    `ROADMAP.md`'s pagination item, which is why this screen is a prototype and
 *    not the port.
 */
export function Content({
  tree,
  loading,
  mount,
  selected,
  query,
  onQuery,
  onOpen,
  showType,
}: Props) {
  // Collapse state lives with the screen, not in the URL: `design-system.md`
  // lists it with the open menus and unsent palette queries. A link to a page in
  // a tree is a link to the page, not to a particular shape of tree.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const state = (query.state ?? 'all') as StateFilter
  const search = query.q ?? ''

  const rows = useMemo(
    () => flatten(tree, { closed, state, search }),
    [tree, closed, state, search],
  )

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className={css.screen}>
      <ListHeader
        actions={
          <>
            <input
              className={css.search}
              type="search"
              value={search}
              placeholder="Search pages"
              aria-label="Search pages"
              // `replace`, not `push`: one history entry per keystroke makes Back
              // useless, which is the failure mode "the URL is the state" has to
              // avoid to be worth having.
              onChange={(e) => onQuery({ q: e.target.value })}
            />
            <Button
              variant="primary"
              size="sm"
              disabled
              reason="Creating pages arrives with the Content port"
            >
              New page
            </Button>
          </>
        }
      >
        Content
      </ListHeader>

      <div className={css.chips} role="group" aria-label="Filter by state">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={`${css.chip} ${state === filter.value ? css.chipOn : ''}`}
            aria-pressed={state === filter.value}
            onClick={() => onQuery({ state: filter.value === 'all' ? undefined : filter.value })}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className={css.skeletons} aria-hidden="true">
          {/* Skeleton rows, not a spinner: `--row-h` is fixed, so the shape of the
              answer is known before it arrives and the screen does not jump. */}
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={tree.length === 0 ? 'No pages yet' : 'Nothing matches'}
          body={
            tree.length === 0
              ? 'A page is a document in the tree. Every one of them has a URL.'
              : 'Try a different state, or clear the search.'
          }
          action={
            tree.length === 0 ? null : (
              <Button size="sm" onClick={() => onQuery({ state: undefined, q: undefined })}>
                Clear filters
              </Button>
            )
          }
        />
      ) : (
        <List label="Pages">
          {rows.map((row) => (
            <Row
              key={row.node.id}
              depth={row.depth}
              selected={row.node.id === selected}
              handle={
                row.node.children.length > 0 ? (
                  <button
                    type="button"
                    className={css.twisty}
                    data-open={closed.has(row.node.id) ? undefined : ''}
                    aria-label={`${closed.has(row.node.id) ? 'Expand' : 'Collapse'} ${row.node.title}`}
                    aria-expanded={!closed.has(row.node.id)}
                    onClick={(e) => {
                      // The row's own click opens the document. A twisty inside it
                      // must not do both.
                      e.stopPropagation()
                      toggle(row.node.id)
                    }}
                  >
                    ›
                  </button>
                ) : (
                  <span className={css.twistySpacer} />
                )
              }
              meta={row.node.slug === '' ? '/' : row.node.slug}
              trailing={
                // Fixed-width columns rather than a flex run of chips. Right-aligned
                // metadata is the correct pattern for a list row, but the first
                // version let each cell size to its content, so `live · 2m ago` and
                // `draft · 22 Jan` put their badges at different x positions on
                // adjacent rows — which is what makes a wide list read as scattered
                // instead of tabular.
                <span className={css.cols} data-typed={showType ? '' : undefined}>
                  {showType ? <Badge>{row.node.type}</Badge> : null}
                  <Badge tone={stateTone(row.node.state)}>{row.node.state}</Badge>
                  <span className={css.stamp}>{when(row.node)}</span>
                </span>
              }
              onOpen={() => onOpen({ name: 'edit', id: row.node.id })}
            >
              {/* A real link inside the row, so the title is cmd-clickable and
                  copyable even though the whole row is clickable too. */}
              <a
                className={css.title}
                href={href({ name: 'edit', id: row.node.id }, mount)}
                // The row is already handling the click and navigating; letting
                // this bubble would do it twice.
                onClick={(e) => e.stopPropagation()}
              >
                {row.node.title || <span className={css.untitled}>Untitled</span>}
              </a>
            </Row>
          ))}
        </List>
      )}

      <p className={css.footnote}>
        {rows.length} of {countAll(tree)} pages. Unpaged, deliberately: this reads the tree route as
        it is today, and paging it is <code>ROADMAP.md</code>&rsquo;s next foundation item.
      </p>
    </div>
  )
}

function countAll(tree: readonly StoryNode[]): number {
  return tree.reduce((n, node) => n + 1 + countAll(node.children), 0)
}
