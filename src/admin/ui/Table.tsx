import type { ReactNode } from 'react'
import css from './Table.module.css'

export interface Column<T> {
  key: string
  label: string
  /** Right-aligned and tabular. Counts, sizes, dates. */
  numeric?: boolean
  /** Absent means the column cannot be sorted, which is the default. */
  sortable?: boolean
  /**
   * A declared width — a percentage, normally. Declaring one on **any** column
   * switches the whole table to `table-layout: fixed` and emits a `<colgroup>`,
   * which is the only thing that actually controls a column's width here.
   *
   * Needed because auto layout hands *all* the surplus to one column. With
   * `width: 100%` on the table, a table whose columns want 815px in a 1168px
   * container has 353px to place, and Chrome gives every pixel of it to the
   * first column: Settings' document types table drew a 634px `Type` column to
   * hold the word "Page" while `Where it can live` wrapped "Anywhere in the
   * tree" over three lines at 84px. Measured, not guessed — and neither a
   * `max-width` on the cell nor a percentage under auto layout moves it, because
   * table layout ignores both.
   *
   * So this is for a table whose columns are *known* — an explanatory table, or
   * a record table with few enough columns to apportion. A table with no widths
   * keeps the old behaviour, which is right when the rows nearly fill the width
   * they are given.
   */
  width?: string
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
  /**
   * A leading selection cell, **outside** the first column and therefore outside
   * the `onOpen` button that wraps it.
   *
   * That placement is the whole reason this is a slot rather than "just another
   * column": a checkbox rendered as `columns[0]` would land inside that button —
   * a control inside a control, which no browser lets you tick and no screen
   * reader can describe. It cannot ride in `actions` either, because that cell is
   * hidden until the row is hovered or focused, and a *checked* checkbox that
   * disappears is not a selection anybody can see.
   *
   * `head` is the header cell's content — the "select every row shown" control
   * where a caller has one. Give it an accessible name; the cell has no visible
   * label to inherit.
   */
  select?: { head?: ReactNode; cell: (row: T) => ReactNode }
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
  select,
  empty,
}: Props<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>

  /*
   * One declared width is enough to switch the table over, because a partly
   * declared table is the worst of both: the undeclared columns split whatever
   * is left equally, which is at least predictable, where auto layout would go
   * back to piling the surplus onto column one.
   *
   * The `select` and `actions` slots get a `<col>` of their own so the columns
   * line up with the cells — they are outside `columns` by design (see their
   * props) and a colgroup that skipped them would shift every width one cell to
   * the left.
   */
  const fixed = columns.some((column) => column.width !== undefined)

  return (
    <div className={css.scroll}>
      <table className={`${css.table} ${fixed ? css.fixed : ''}`} aria-label={label}>
        {fixed ? (
          <colgroup>
            {select ? <col className={css.select} /> : null}
            {columns.map((column) => (
              <col key={column.key} {...(column.width ? { style: { width: column.width } } : {})} />
            ))}
            {actions ? <col /> : null}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {select ? <th className={css.select}>{select.head}</th> : null}
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
              // `data-fit` marks a body row as measurable — `ui/fit.ts` reads one
              // to work out how many fit on a screen. Header rows deliberately do
              // not carry it: it is sticky, so it is not part of what scrolls past.
              <tr key={key} data-fit="" className={key === currentKey ? css.current : undefined}>
                {select ? <td className={css.select}>{select.cell(row)}</td> : null}
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
