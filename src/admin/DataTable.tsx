import { useMemo, useState } from 'react'
import { indexedFields } from '../core/index-projection'
import type { DocumentType, SchemaIndex } from '../core/schema'
import type { StoryNode } from '../core/story'
import type { IndexedValues } from '../server/content-index'
import { useFolio } from './FolioContext'
import { badgeLabel } from './StoryTree'

/**
 * One type's documents as a table — the list view
 * (`../../../docs/specs/content-model/data-documents.md` architecture decision
 * 2), and the piece `collections.md` deliberately deferred here because this
 * spec owns list views.
 *
 * Columns are the type's title plus its root block's `indexed` fields, then the
 * draft state and when it was last touched. Sortable, searchable and paginated
 * **client-side**, over the flat list the admin already holds: `GET
 * /folio/documents` returns every unrouted document in one request, so sorting
 * twenty-four people costs nothing and needs no route. The ceiling is the same
 * one `collections.md` sets, and the page tree is unaffected because records were
 * never in it.
 *
 * Deliberately NOT `GET /folio/content?type=…`: that reads published content, and
 * the resolved open question is explicit — the admin lists **documents**, so a
 * person nobody has published yet has to appear.
 */

export const ROWS_PER_PAGE = 20

export interface DataColumn {
  /** Unique, and the sort key. */
  key: string
  label: string
  kind: 'title' | 'field' | 'state' | 'updated'
  /** Set for `kind: 'field'`: the `indexed` field this column reads. */
  field?: string
}

export interface DataSort {
  key: string
  dir: 'asc' | 'desc'
}

/**
 * The columns for one type. Pure and exported so the derivation is tested without
 * mounting.
 *
 * The type's `titleField` is skipped as a field column: its value already *is*
 * the title column, since that is what `titleFor` derives the row's title from,
 * and a table showing "Ada Lovelace" twice would be a bug that looks like a
 * feature. `state` is a column rather than a decoration on the title — the
 * spec's resolved open question, and free now that spec 3's watermark exists.
 */
export function dataColumns(
  schema: SchemaIndex,
  type: DocumentType,
  labelOf: (field: string, fallback: string) => string = (_f, fallback) => fallback,
): DataColumn[] {
  const columns: DataColumn[] = [
    {
      key: 'title',
      label: type.titleField ? labelOf(type.titleField, 'Title') : 'Title',
      kind: 'title',
    },
  ]
  for (const [name, field] of indexedFields(schema, type.root)) {
    if (name === type.titleField) continue
    columns.push({ key: `f:${name}`, label: field.label ?? name, kind: 'field', field: name })
  }
  columns.push({ key: 'state', label: 'Status', kind: 'state' })
  columns.push({ key: 'updated', label: 'Updated', kind: 'updated' })
  return columns
}

/** What one cell shows. `''` for a value that is not published yet. */
export function cellText(row: StoryNode, column: DataColumn, indexed: IndexedValues): string {
  switch (column.kind) {
    case 'title':
      return row.title
    case 'state':
      return badgeLabel(row.state) ?? 'Live'
    case 'updated':
      return row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleDateString() : ''
    default:
      return indexed[row.id]?.[column.field ?? '']?.text ?? ''
  }
}

/**
 * The value a sort compares. A number where the index says a number is genuinely
 * meant (`num_value`), which is what makes a publish-date column sort by date
 * rather than lexicographically; a lowercased string everywhere else.
 */
function sortKey(row: StoryNode, column: DataColumn, indexed: IndexedValues): string | number {
  if (column.kind === 'updated') return row.updatedAt ?? 0
  if (column.kind === 'field') {
    const cell = indexed[row.id]?.[column.field ?? '']
    if (cell?.num !== null && cell?.num !== undefined) return cell.num
    return (cell?.text ?? '').toLowerCase()
  }
  return cellText(row, column, indexed).toLowerCase()
}

/**
 * Sorted rows. Stable in the ordinary sense — equal keys fall back to the story
 * id, so a page of rows does not reshuffle when an unrelated document is
 * published and the list reloads.
 */
export function sortRows(
  rows: readonly StoryNode[],
  columns: readonly DataColumn[],
  sort: DataSort,
  indexed: IndexedValues,
): StoryNode[] {
  const column = columns.find((c) => c.key === sort.key)
  if (!column) return [...rows]
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = sortKey(a, column, indexed)
    const right = sortKey(b, column, indexed)
    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * sign || a.id.localeCompare(b.id)
    }
    // A blank cell sorts last whichever way the column is pointing: "not
    // published yet" is not a value, and burying it under a descending sort
    // would hide exactly the rows an editor is looking for.
    const l = String(left)
    const r = String(right)
    if (l === '' || r === '') return (l === '' ? 1 : 0) - (r === '' ? 1 : 0)
    return l.localeCompare(r) * sign || a.id.localeCompare(b.id)
  })
}

/**
 * Rows matching a search box, over the title and every indexed value — the two
 * things on screen. Case-insensitive substring; an empty query matches
 * everything.
 */
export function filterRows(
  rows: readonly StoryNode[],
  query: string,
  indexed: IndexedValues,
): StoryNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => {
    if (row.title.toLowerCase().includes(needle)) return true
    return Object.values(indexed[row.id] ?? {}).some((v) => v.text.toLowerCase().includes(needle))
  })
}

/** Total pages for a row count, never fewer than one. */
export const pageCount = (total: number, perPage = ROWS_PER_PAGE) =>
  Math.max(1, Math.ceil(total / perPage))

interface Props {
  type: DocumentType
  /** This type's documents, unsorted and unfiltered. */
  documents: readonly StoryNode[]
  indexed: IndexedValues
  currentId: string
  onOpen: (story: StoryNode) => void
  onCreate: (title: string, parentId: string | null, type?: string) => Promise<void>
  /** Requests the delete confirmation, same contract as the page tree's. */
  onDelete: (story: StoryNode) => void
  onDuplicate: (story: StoryNode) => void
  /** False for a role that may not create, delete or duplicate. */
  canManage: boolean
}

export function DataTable({
  type,
  documents,
  indexed,
  currentId,
  onOpen,
  onCreate,
  onDelete,
  onDuplicate,
  canManage,
}: Props) {
  const { schema } = useFolio()
  const [sort, setSort] = useState<DataSort>({ key: 'title', dir: 'asc' })
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)

  const columns = useMemo(
    () =>
      dataColumns(
        schema,
        type,
        (field, fallback) => schema[type.root]?.fields[field]?.label ?? fallback,
      ),
    [schema, type],
  )
  const matched = useMemo(() => filterRows(documents, query, indexed), [documents, indexed, query])
  const sorted = useMemo(
    () => sortRows(matched, columns, sort, indexed),
    [columns, indexed, matched, sort],
  )
  const pages = pageCount(sorted.length)
  // Clamped rather than reset by an effect: a search that shortens the list while
  // page 2 is showing should land on the last page, not lose the query.
  const showing = Math.min(page, pages)
  const from = (showing - 1) * ROWS_PER_PAGE
  const rows = sorted.slice(from, from + ROWS_PER_PAGE)

  const toggleSort = (key: string) =>
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }))

  return (
    <div className="datatable">
      <header className="datatable__head">
        <h2>{type.label}</h2>
        <span className="datatable__count">
          {documents.length} {documents.length === 1 ? 'document' : 'documents'}
        </span>
        <input
          type="search"
          className="datatable__search"
          placeholder={`Search ${type.label.toLowerCase()}…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
        />
        {canManage ? (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            + New
          </button>
        ) : null}
      </header>

      {adding ? (
        <NewDocument
          label={type.label}
          onCancel={() => setAdding(false)}
          onSubmit={async (title) => {
            await onCreate(title, null, type.name)
            setAdding(false)
          }}
        />
      ) : null}

      <div className="datatable__scroll">
        <table className="datatable__table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} aria-sort={ariaSort(sort, column.key)}>
                  <button type="button" onClick={() => toggleSort(column.key)}>
                    {column.label}
                    {sort.key === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
              ))}
              <th className="datatable__actions-head">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.id === currentId ? 'is-current' : ''}>
                {columns.map((column) => (
                  <td key={column.key}>
                    {column.kind === 'title' ? (
                      <button type="button" className="datatable__open" onClick={() => onOpen(row)}>
                        {row.title || <em>Untitled</em>}
                      </button>
                    ) : column.kind === 'state' ? (
                      badgeLabel(row.state) ? (
                        <span className={`stories__badge stories__badge--${row.state}`}>
                          {badgeLabel(row.state)}
                        </span>
                      ) : (
                        <span className="datatable__live">Live</span>
                      )
                    ) : (
                      cellText(row, column, indexed) || <span className="datatable__blank">—</span>
                    )}
                  </td>
                ))}
                <td className="datatable__actions">
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        title={`Duplicate ${row.title}`}
                        onClick={() => onDuplicate(row)}
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        title={`Delete ${row.title}`}
                        onClick={() => onDelete(row)}
                      >
                        ×
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="datatable__empty" colSpan={columns.length + 1}>
                  {query
                    ? `Nothing matches “${query}”.`
                    : `No ${type.label.toLowerCase()} documents yet.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <footer className="datatable__foot">
        <span>
          {sorted.length === 0
            ? 'Nothing to show'
            : `${from + 1}–${Math.min(from + ROWS_PER_PAGE, sorted.length)} of ${sorted.length}`}
        </span>
        <div className="datatable__pager">
          <button type="button" disabled={showing <= 1} onClick={() => setPage(showing - 1)}>
            ← Previous
          </button>
          <span>
            Page {showing} of {pages}
          </span>
          <button type="button" disabled={showing >= pages} onClick={() => setPage(showing + 1)}>
            Next →
          </button>
        </div>
        {/* The honesty note decision 2's columns need: a blank cell is a value
            nobody has published, not an empty field. */}
        <span className="datatable__note">
          Columns show published values. A draft document’s cells stay blank until it is published.
        </span>
      </footer>
    </div>
  )
}

const ariaSort = (sort: DataSort, key: string): 'ascending' | 'descending' | 'none' =>
  sort.key !== key ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending'

function NewDocument({
  label,
  onSubmit,
  onCancel,
}: {
  label: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  return (
    <form
      className="datatable__new"
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim()) onSubmit(title.trim())
      }}
    >
      <input
        autoFocus
        value={title}
        placeholder={`${label} name`}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button type="submit" className="btn-primary">
        Add
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}
