import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { useRef } from 'react'
import css from './List.module.css'
import { nextIndex } from './rank'

interface ListProps {
  /** Required: an unlabelled list of rows is unreadable to a screen reader, and
   * every list in this admin has a heading it can borrow. */
  label: string
  children: ReactNode
}

/**
 * The keyboard container for `Row`. Roving tabindex, so the list is one stop in
 * the page's tab order and ↑ ↓ Home End PageUp PageDown move within it.
 *
 * This is what replaces the content tree's `<div onClick>` rows
 * (`StoryTree.tsx:355-357`) — the last open a11y item in `ROADMAP.md` and the
 * reason Biome's a11y rules are switched off. The arithmetic lives in
 * `rank.ts`'s `nextIndex` so it is unit tested without a DOM; only the focus call
 * needs the browser.
 */
export function List({ label, children }: ListProps) {
  const box = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = box.current
    if (!el) return
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-row]'))
    const active = document.activeElement
    // -1 when focus is on the container rather than a row, which is the state
    // after tabbing in — `nextIndex` reads that as "nothing active yet" and puts
    // ArrowDown on the first row rather than the second.
    const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
    const next = nextIndex(e.key, current, rows.length)
    if (next === null) return
    e.preventDefault()
    rows[next]?.focus()
  }

  return (
    <div ref={box} className={css.list} role="listbox" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

interface RowProps {
  selected?: boolean
  /** Tree depth. Indents by `--indent` per level — 16px, up from the old 10px,
   * where a child and its parent were hard to tell apart. */
  depth?: number
  /** The drag affordance. Only the handle is draggable, never the whole row: a
   * few pixels of movement during a click must not silently reparent a page. */
  handle?: ReactNode
  /** Right-aligned, revealed on hover or focus-within. */
  actions?: ReactNode
  /** Secondary text after the title — a path, a slug, a summary. Truncates. */
  meta?: ReactNode
  /** Right of `meta` and always visible: state badges, presence, counts. */
  trailing?: ReactNode
  onOpen?: () => void
  children: ReactNode
}

/**
 * One row, for every list in the admin. Replaces four independent
 * implementations of hover / selected / actions-on-hover (`.stories__row`,
 * `.tree__row`, `.data__row`, and the data table's own).
 *
 * A real focusable element with a role, unlike all four of them.
 */
export function Row({
  selected,
  depth = 0,
  handle,
  actions,
  meta,
  trailing,
  onOpen,
  children,
}: RowProps) {
  return (
    <div
      data-row=""
      role="option"
      aria-selected={Boolean(selected)}
      tabIndex={selected ? 0 : -1}
      // The escape hatch for a `meta` the container query has hidden, or one that
      // truncated: nothing may be visible only sometimes and unrecoverable the
      // rest of the time.
      title={typeof meta === 'string' ? meta : undefined}
      style={{ '--depth': depth } as CSSProperties}
      className={`${css.row} ${selected ? css.selected : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen?.()
        }
      }}
    >
      {handle ? <span className={css.handle}>{handle}</span> : null}
      <span className={css.title}>{children}</span>
      {meta ? <span className={css.meta}>{meta}</span> : null}
      {trailing ? <span className={css.trailing}>{trailing}</span> : null}
      {actions ? <span className={css.actions}>{actions}</span> : null}
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
