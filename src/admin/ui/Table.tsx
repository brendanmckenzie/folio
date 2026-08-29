import type { ReactNode } from 'react'
import css from './Table.module.css'

export interface Column<T> {
  key: string
  label: string
  /** Right-aligned and tabular. Counts, sizes, dates. */
  numeric?: boolean
  /** Absent means the column cannot be sorted, which is the default. */
  sortable?: boolean
  cell: (row: T) => ReactNode
}

export interface Sort {
  key: string
  dir: 'asc' | 'desc'
}

interface Props<T> {
  label: string
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  currentKey?: string | null
  sort?: Sort
  onSort?: (key: string) => void
  onOpen?: (row: T) => void
  /**
   * Right-aligned trailing cell, revealed on row hover or focus.
   *
   * **Only usable when something else in the row can take focus.** `visibility:
   * hidden` removes descendants from the tab order, so `tr:focus-within` cannot be
   * reached *from inside* the hidden cell — a row whose only focusable element is an
   * action here is a row whose actions are mouse-only. Documents is fine because its
   * first cell is an `onOpen` button: focus lands there, `:focus-within` fires, and
   * the actions become tabbable.
   *
   * A table with no `onOpen` and no other control wants a **named `Actions` column**
   * instead — an ordinary always-visible column, which is what Access does for its
   * tokens table. `admin.css` reached the same conclusion once before, in a comment
   * saying the version button is always visible "because hover-only is unreachable
   * by keyboard".
   *
   * Found by building Access. Not fixed by making this always visible, because that
   * puts two buttons on every row of every table and the hover reveal is what keeps a
   * dense list readable — the constraint is real and worth stating rather than
   * designing around.
   */
  actions?: (row: T) => ReactNode
  empty?: ReactNode
}

/**
 * The dense table. The old `.datatable__*` block was the best-designed surface in
 * the admin and most of its decisions are carried forward: sticky header,
 * sortable columns, one line per row, no zebra striping.
 *
 * What changes is where it lives. A table is a site-level view and the old layout
 * could only put it in the stage of a document editor, which is why opening one
 * left the inspector describing an unrelated page.
 */
export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  currentKey,
  sort,
  onSort,
  onOpen,
  actions,
  empty,
}: Props<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>

  return (
    <div className={css.scroll}>
      <table className={css.table} aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.numeric ? css.numeric : undefined}
                /*
                 * `aria-sort` belongs on the **header cell**, not on the button
                 * inside it — the attribute is only supported on a
                 * `columnheader`, so on the button it was announced nowhere at
                 * all. A real bug rather than a lint nit, and the one Biome's
                 * a11y rules found the moment they were switched on for `ui/`.
                 */
                aria-sort={
                  column.sortable && onSort
                    ? sort?.key === column.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                    : undefined
                }
              >
                {column.sortable && onSort ? (
                  <button type="button" className={css.sort} onClick={() => onSort(column.key)}>
                    {column.label}
                    <span className={css.arrow} aria-hidden="true">
                      {sort?.key === column.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                    </span>
                  </button>
                ) : (
                  <span className={css.head}>{column.label}</span>
                )}
              </th>
            ))}
            {/*
              Named, not empty. A header cell with no accessible name leaves every
              cell under it announced as belonging to a column called nothing, and
              this one holds the row's controls. Visually hidden because a visible
              "Actions" label over two hover-revealed buttons is noise on every row
              of every table.
            */}
            {actions ? (
              <th>
                <span className={css.srOnly}>Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            return (
              <tr key={key} className={key === currentKey ? css.current : undefined}>
                {columns.map((column, i) => (
                  <td key={column.key} className={column.numeric ? css.numeric : undefined}>
                    {i === 0 && onOpen ? (
                      <button type="button" className={css.open} onClick={() => onOpen(row)}>
                        {column.cell(row)}
                      </button>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
                {actions ? <td className={css.actions}>{actions(row)}</td> : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
