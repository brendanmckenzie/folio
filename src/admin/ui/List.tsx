import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { useRef } from 'react'
import css from './List.module.css'
import { nextIndex } from './rank'

interface ListProps {
  /** Required: an unlabelled list of rows is unreadable to a screen reader, and
   * every list in this admin has a heading it can borrow. */
  label: string
  /**
   * Switches the container to `role="tree"` and its rows to `role="treeitem"`.
   *
   * Not cosmetic, and not optional for a tree: `aria-expanded` and `aria-level`
   * are **not supported on `role="option"`**, so a disclosure list built on the
   * listbox roles is one a screen reader cannot describe — and Biome's
   * `useAriaPropsSupportedByRole` says so, which is how this was found. A flat
   * list stays a listbox, because a tree with every item at level 1 announces
   * depth that is not there.
   */
  tree?: boolean
  /** Whether rows can be ticked for a bulk action, which a tree or listbox has to
   * declare rather than imply. */
  multiselect?: boolean
  /**
   * A keypress this list did not handle, with the focused row's index and a way to
   * move focus.
   *
   * This is how the Content screen gets `→ ←` and the four `⌥` gestures without
   * either side reaching into the other. The list knows which element has focus and
   * what index it is — it already queries for that — so it hands both over rather
   * than making the caller wrap it in a div and re-query the DOM. That wrapper was
   * the first version, and it was worse twice: a `<div onKeyDown>` with no role is
   * exactly what `noStaticElementInteractions` exists to catch, and it duplicated
   * the row-index arithmetic that lives here.
   *
   * `-1` when focus is on the container rather than a row.
   */
  onUnhandledKey?: (
    e: KeyboardEvent<HTMLDivElement>,
    focused: number,
    focus: (index: number) => void,
  ) => void
  children: ReactNode
}

/**
 * The keyboard container for `Row`. Roving tabindex, so the list is one stop in
 * the page's tab order and ↑ ↓ Home End PageUp PageDown move within it.
 *
 * This is what replaced the content tree's `<div onClick>` rows
 * (`StoryTree.tsx:355-357`) — the last open a11y item in `ROADMAP.md` and the
 * reason Biome's a11y rules were switched off. The arithmetic lives in `rank.ts`'s
 * `nextIndex` so it is unit tested without a DOM; only the focus call needs the
 * browser.
 *
 * Note what it deliberately does **not** interpret: → ← and the ⌥ gestures. Those
 * mean expand, collapse, reorder and reparent — all four are about the *tree*
 * rather than about a list — so they go out through `onUnhandledKey` and
 * `content-model.ts` holds their arithmetic. A container that decided them would
 * have to know what a story is.
 */
export function List({ label, tree, multiselect, onUnhandledKey, children }: ListProps) {
  const box = useRef<HTMLDivElement>(null)

  const rowsOf = () => Array.from(box.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!box.current) return
    const rows = rowsOf()
    const active = document.activeElement
    // -1 when focus is on the container rather than a row, which is the state
    // after tabbing in — `nextIndex` reads that as "nothing active yet" and puts
    // ArrowDown on the first row rather than the second.
    const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
    const focus = (index: number) => rows[Math.min(rows.length - 1, Math.max(0, index))]?.focus()

    /**
     * A modified arrow is not ours.
     *
     * **This was a bug, and the symptom is worth recording because it looked like
     * nothing happening.** `⌥↑` reorders a page among its siblings, and the
     * gesture is the screen's. Without this guard the list saw `ArrowUp` first,
     * moved focus to the previous row, and *then* handed over — so the screen acted
     * on the neighbour. The reorder fired against the wrong page, or was refused as
     * already-first, and either way the row you pressed it on did not move.
     *
     * Ignoring modified chords is also correct on its own terms: `⌥↑` means "move
     * this row", not "move the cursor", and a container that consumed both would
     * leave no way to tell them apart.
     */
    const bare = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
    const next = bare ? nextIndex(e.key, current, rows.length) : null
    if (next !== null) {
      e.preventDefault()
      rows[next]?.focus()
      return
    }
    onUnhandledKey?.(e, current, focus)
  }

  // Two literal roles rather than one expression, because `role={tree ? … : …}`
  // makes the element's role unresolvable to a linter — and then every `aria-*`
  // on it reads as an attribute on a plain `div`, which is how this file learned
  // that `aria-label` is "not supported by this element".
  return tree ? (
    <div
      ref={box}
      className={css.list}
      role="tree"
      aria-label={label}
      aria-multiselectable={multiselect ? true : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  ) : (
    <div
      ref={box}
      className={css.list}
      role="listbox"
      aria-label={label}
      aria-multiselectable={multiselect ? true : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

interface RowProps {
  /** Ticked for a bulk action. Becomes `aria-selected`. */
  selected?: boolean
  /**
   * The row you are looking at — the open document, in a list you reached the
   * editor from.
   *
   * Separate from `selected` on purpose, and the distinction is not pedantry:
   * `aria-selected` means "in the set this control has chosen", which is the
   * checkbox's business, while "this is the thing on screen" is
   * `aria-current="page"`. Rendering the second as the first would tell a screen
   * reader the open page is part of the next bulk delete.
   */
  current?: boolean
  /** Tree depth. Indents by `--indent` per level — 16px, up from the old 10px,
   * where a child and its parent were hard to tell apart. */
  depth?: number
  /**
   * Matches the `tree` on the `List` around it, switching this row to
   * `role="treeitem"` and letting it declare `aria-level`.
   *
   * Passed rather than derived through a context, because a context for one
   * boolean is a lot of machinery — and passed rather than *guessed* from the
   * presence of `depth` or `expanded`, which was the first version and got flat
   * mode wrong: a flat list has selection and no structure, so a row with neither
   * depth nor children still has to be an `option` inside a listbox rather than a
   * one-level tree.
   */
  tree?: boolean
  /** Whether this row's children are showing. `undefined` for a leaf, and that is
   * load-bearing: `aria-expanded={false}` on a treeitem means *closed parent*, so
   * a leaf that declared it would promise children it does not have. */
  expanded?: boolean
  /** The drag affordance, or a tree's disclosure control. Only the handle is ever
   * draggable, never the whole row: a few pixels of movement during a click must
   * not silently reparent a page. */
  handle?: ReactNode
  /** Before the handle and outside the indent — the selection checkbox. */
  lead?: ReactNode
  /** Right-aligned, revealed on hover or focus-within. */
  actions?: ReactNode
  /** Secondary text after the title — a path, a slug, a summary. Truncates. */
  meta?: ReactNode
  /** Right of `meta` and always visible: state badges, presence, counts. */
  trailing?: ReactNode
  onOpen?: () => void
  /**
   * Ticks or unticks the row. When present, **Space selects and Enter opens** —
   * the Finder and Gmail convention, and the only way a keyboard reaches a
   * checkbox inside a roving-tabindex list without the checkbox becoming its own
   * tab stop and costing the list its "one stop in the tab order" property.
   */
  onSelect?: () => void
  children: ReactNode
}

/**
 * One row, for every list in the admin. Replaces four independent implementations
 * of hover / selected / actions-on-hover (`.stories__row`, `.tree__row`,
 * `.data__row`, and the data table's own).
 *
 * A real focusable element with a role, unlike all four of them.
 */
export function Row({
  selected,
  current,
  depth = 0,
  tree,
  expanded,
  handle,
  lead,
  actions,
  meta,
  trailing,
  onOpen,
  onSelect,
  children,
}: RowProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' && onSelect) {
      e.preventDefault()
      onSelect()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen?.()
    }
  }

  const shared = {
    'data-row': '',
    'aria-selected': Boolean(selected),
    'aria-current': current ? ('page' as const) : undefined,
    // The escape hatch for a `meta` that truncated: nothing may be visible only
    // sometimes and unrecoverable the rest of the time.
    title: typeof meta === 'string' ? meta : undefined,
    style: { '--depth': depth } as CSSProperties,
    className: [css.row, selected ? css.ticked : '', current ? css.selected : ''].join(' '),
    onClick: onOpen,
    onKeyDown,
  }

  const inner = (
    <>
      {lead ? <span className={css.lead}>{lead}</span> : null}
      {depth > 0 ? <span className={css.indent} /> : null}
      {handle ? <span className={css.handle}>{handle}</span> : null}
      <span className={css.title}>{children}</span>
      {meta ? <span className={css.meta}>{meta}</span> : null}
      {trailing ? <span className={css.trailing}>{trailing}</span> : null}
      {actions ? <span className={css.actions}>{actions}</span> : null}
    </>
  )

  // Literal roles and a literal `tabIndex`, for the reason `List` gives above —
  // and `tabIndex` for a second one: a role that arrives through a spread is a role
  // no linter can pair with the attributes it governs, so `treeitem` read as "an
  // interactive role that is not focusable" while the focusability was sitting in
  // the spread three lines up.
  return tree ? (
    <div
      {...shared}
      role="treeitem"
      tabIndex={current ? 0 : -1}
      aria-level={depth + 1}
      aria-expanded={expanded}
    >
      {inner}
    </div>
  ) : (
    <div {...shared} role="option" tabIndex={current ? 0 : -1}>
      {inner}
    </div>
  )
}

/** The uppercase micro-header above a list. The one place `--text-xs` tracking
 * is allowed. */
export function ListHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={css.header}>
      <h2 className={css.headerTitle}>{children}</h2>
      {actions ? <div className={css.headerActions}>{actions}</div> : null}
    </div>
  )
}
