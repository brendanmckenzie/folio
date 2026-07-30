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
  /** Right-aligned trailing cell, revealed on row hover. */
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
              <th key={column.key} className={column.numeric ? css.numeric : undefined}>
                {column.sortable && onSort ? (
                  <button
                    type="button"
                    className={css.sort}
                    aria-sort={
                      sort?.key === column.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    onClick={() => onSort(column.key)}
                  >
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
            {actions ? <th className={css.actionsHead} /> : null}
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
