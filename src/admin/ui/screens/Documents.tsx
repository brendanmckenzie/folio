import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocumentType, SchemaIndex } from '../../../core/schema'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import type { Screen } from '../route'
import { stateTone, when } from './content-rows'
import { CreateDialog } from './CreateDialog'
import type { CreateBody } from './create-model'
import css from './Documents.module.css'
import { DeleteDialog } from './DeleteDialog'
import {
  cellText,
  type DocumentColumn,
  type DocumentRow,
  type DocumentsUrl,
  documentColumns,
  documentsQuery,
  dirOf,
  filterOf,
  isNarrowed,
  isStale,
  parseDocumentsUrl,
  withSort,
} from './documents-model'
import { useDocuments } from './useDocuments'
import { messageOf } from './useContent'

interface Props {
  /** The declared type this screen is a list of. */
  type: DocumentType
  schema: SchemaIndex
  apiBase: string
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
  onOpen: (screen: Screen) => void
  onNotice: (message: string) => void
  /** The open document, if the editor was reached from here. */
  selected?: string
}

const STATES = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'changed', label: 'Changed' },
  { value: 'live', label: 'Live' },
  { value: 'unpublished', label: 'Unpublished' },
] as const

/** Six placeholder rows. Named rather than indexed, matching Content's. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * One type's records as a table — `docs/ui-architecture.md`'s port phase 3, and
 * the retirement of `DataList.tsx` and `DataTable.tsx`.
 *
 * The spec names three changes from the surface it replaces, and building it added
 * a fourth:
 *
 * 1. **It is a screen.** The old table could only live in the *stage* of a document
 *    editor, so opening the People list left a 300px inspector beside it describing
 *    an unrelated page and a migration banner above it describing that page's schema
 *    drift. That was `docs/ui-review.md`'s structural complaint about this surface,
 *    and it is fixed by moving rather than by styling.
 * 2. **Columns are published values, and a `changed` row says so.** The old footer
 *    carried a standing apology on every page — "Columns show published values. A
 *    draft document's cells stay blank until it is published." A row that wears
 *    `changed` beside cells that disagree with its draft explains the same thing
 *    where it is true, which is the difference between a note and an answer.
 * 3. **Columns come from the type's `indexed` fields**, unchanged in principle from
 *    `dataColumns` — which got this right — and now in `documents-model.ts` where a
 *    Node test can reach it.
 * 4. **Sorting, searching and paging are the server's.** All three were client-side
 *    over a whole-table fetch, which is why `GET {base}/api/documents` was the last
 *    unbounded read in the admin. The visible cost is that an `indexed` column's
 *    header is no longer a sort button; `core/story.ts`'s `DocumentSort` argues that
 *    trade, and the short version is that the sort anybody actually reaches for on a
 *    record list is the title, which is a real `stories` column.
 */
export function Documents(props: Props) {
  const { type, schema, apiBase, onQuery, onNotice, onOpen } = props
  const url = parseDocumentsUrl(props.query)
  const filter = filterOf(url)
  const data = useDocuments(apiBase, type.name, url)

  const [deleting, setDeleting] = useState<DocumentRow | null>(null)
  const [busy, setBusy] = useState(false)

  const go = useCallback((next: DocumentsUrl) => onQuery(documentsQuery(next)), [onQuery])

  const columns = useMemo(
    () =>
      documentColumns(
        schema,
        type,
        (field, fallback) => schema[type.root]?.fields[field]?.label ?? fallback,
      ),
    [schema, type],
  )

  /**
   * A singleton has exactly one document, so a list of it is a list of one — and
   * `ui-architecture.md` links globals straight at the document for that reason.
   * Nothing in the shell navigates here, but the URL is reachable by hand, so it
   * resolves to the document rather than rendering a one-row table.
   *
   * The redirect rides the fetch deliberately: asking for a singleton's type is
   * what *creates* it (the route's `?type=` branch), so the row this hands to
   * `onOpen` is guaranteed to exist by the act of having asked for it.
   *
   * In an effect and not in the render body: `onOpen` is a `history` write, and
   * navigating while React is rendering is the version of this that works until it
   * is called twice.
   */
  const only = type.kind === 'singleton' ? data.page.rows[0] : undefined
  useEffect(() => {
    if (only) onOpen({ name: 'edit', id: only.id })
  }, [only, onOpen])

  const write = useCallback(
    async (row: DocumentRow, action: 'duplicate' | 'delete') => {
      setBusy(true)
      try {
        const path =
          action === 'duplicate'
            ? `/stories/${encodeURIComponent(row.id)}/duplicate`
            : `/stories/${encodeURIComponent(row.id)}`
        const res = await fetch(`${apiBase}${path}`, {
          method: action === 'duplicate' ? 'POST' : 'DELETE',
          ...(action === 'duplicate'
            ? { headers: { 'content-type': 'application/json' }, body: '{}' }
            : {}),
        })
        if (!res.ok) throw new Error(await messageOf(res))
        onNotice(
          action === 'duplicate'
            ? `Duplicated ${row.title || 'the document'}`
            : `Deleted ${row.title || 'the document'}`,
        )
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, data, onNotice],
  )

  const tableColumns: Column<DocumentRow>[] = columns.map((column) => ({
    key: column.key,
    label: column.label,
    ...(column.sort ? { sortable: true } : {}),
    cell: (row) => <Cell row={row} column={column} />,
  }))

  if (data.page.error && data.page.rows.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>{type.label}</ListHeader>
        <EmptyState
          title={`Could not load ${type.label.toLowerCase()}`}
          body={data.page.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const firstLoad = data.page.loading && data.page.rows.length === 0

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <>
            <input
              className={css.search}
              type="search"
              value={url.q}
              placeholder={`Search ${type.label.toLowerCase()}`}
              aria-label={`Search ${type.label.toLowerCase()}`}
              onChange={(e) => go({ ...url, q: e.target.value })}
            />
            <NewDocumentButton
              type={type}
              schema={schema}
              apiBase={apiBase}
              onCreated={(id) => onOpen({ name: 'edit', id })}
              onNotice={onNotice}
            />
          </>
        }
      >
        {type.label}
      </ListHeader>

      <div className={css.controls}>
        <fieldset className={css.chips}>
          <legend className={css.srOnly}>Filter by state</legend>
          {STATES.map((state) => (
            <button
              key={state.value}
              type="button"
              className={`${css.chip} ${url.state === state.value ? css.chipOn : ''}`}
              aria-pressed={url.state === state.value}
              onClick={() => go({ ...url, state: state.value })}
            >
              {state.label}
            </button>
          ))}
        </fieldset>
      </div>

      {firstLoad ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : (
        <Table
          label={`${type.label} documents`}
          columns={tableColumns}
          rows={data.page.rows}
          rowKey={(row) => row.id}
          currentKey={props.selected ?? null}
          sort={{ key: sortColumnKey(columns, url), dir: dirOf(url) }}
          onSort={(key) => {
            const sort = columns.find((c) => c.key === key)?.sort
            if (sort) go(withSort(url, sort))
          }}
          onOpen={(row) => onOpen({ name: 'edit', id: row.id })}
          actions={(row) => (
            <span className={css.rowActions}>
              <Button
                size="sm"
                variant="subtle"
                disabled={busy}
                title={`Duplicate ${row.title || 'this document'}`}
                onClick={() => void write(row, 'duplicate')}
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="subtle"
                disabled={busy}
                title={`Delete ${row.title || 'this document'}`}
                onClick={() => setDeleting(row)}
              >
                Delete
              </Button>
            </span>
          )}
          empty={
            <EmptyState
              title={isNarrowed(filter) ? 'Nothing matches' : `No ${type.label.toLowerCase()} yet`}
              body={
                isNarrowed(filter)
                  ? 'Try a different state, or clear the search.'
                  : `A ${type.label.toLowerCase()} is a document with no URL of its own. It is edited as a form and reached from here.`
              }
              action={
                isNarrowed(filter) ? (
                  <Button size="sm" onClick={() => go({ ...url, state: 'all', q: '' })}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        />
      )}

      <div className={css.footer}>
        {/*
          `Showing n of N`, which is the owner's answer to the paging control
          (`ui-architecture.md` Resolved 5): next / previous plus an exact count,
          never "page 3 of 7" — which `DataTable.tsx`'s footer promised and could
          only keep because it held every row.
        */}
        <span className={css.count}>
          {data.page.total === undefined
            ? `${data.page.rows.length} shown`
            : `${data.page.rows.length} of ${data.page.total} ${data.page.total === 1 ? 'document' : 'documents'}`}
        </span>
        <span className={css.pager}>
          <Button
            size="sm"
            disabled={!data.canGoBack}
            reason="This is the first page"
            onClick={data.prevPage}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={data.page.cursor === null}
            reason="This is the last page"
            onClick={data.nextPage}
          >
            Next
          </Button>
        </span>
      </div>

      {deleting ? (
        <DeleteDialog
          apiBase={apiBase}
          row={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const row = deleting
            setDeleting(null)
            void write(row, 'delete')
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Which column the current sort belongs to, for `Table`'s `aria-sort`.
 *
 * The screen's sort is a `DocumentSort` and the table's is a column key, and the
 * mapping is not the identity: `edited` is the `updated` column. Derived from the
 * column list rather than hard-coded, so a column that gains a sort needs no edit
 * here.
 */
function sortColumnKey(columns: readonly DocumentColumn[], url: DocumentsUrl): string {
  return columns.find((c) => c.sort === url.sort)?.key ?? ''
}

/* ------------------------------------------------------------------- a cell --- */

function Cell({ row, column }: { row: DocumentRow; column: DocumentColumn }) {
  if (column.kind === 'state') {
    return (
      <Badge
        tone={stateTone(row.state)}
        {...(isStale(row)
          ? {
              // The `changed` badge's job on *this* screen, which is a stronger
              // claim than the one it makes on Content: there, it means "there is
              // something to publish". Here the cells beside it are the published
              // values, so it also means "what you are reading is not what this
              // document currently says".
              title: 'The cells here are published values. This document has unpublished changes.',
            }
          : {})}
      >
        {row.state}
      </Badge>
    )
  }
  if (column.kind === 'updated') return <span className={css.stamp}>{when(row)}</span>

  const text = cellText(row, column)
  // Returned bare rather than wrapped in a fragment: a component may return a
  // string in React 19, and `<>{text}</>` is a `noUselessFragments` error.
  if (text) return text
  if (column.kind === 'title') return <span className={css.untitled}>Untitled</span>
  // A blank cell is a value nobody has published, not an empty field — and the
  // row's own badge is what says which. A dash rather than nothing, so an empty
  // cell reads as deliberate.
  return <span className={css.blank}>—</span>
}

/* ------------------------------------------------------------------ create --- */

/**
 * `+ New`, which **asks for a name and then writes once** (`CreateDialog`).
 *
 * This used to post on click with a hard-coded `'Untitled'`, and the comment here
 * argued for it: a record's title is derived from its `titleField`, so a name typed
 * into a one-field form before the document exists is a name typed into the wrong
 * place. **That argument is false, and `seed()` in `server/runtime.ts` is why.** A
 * new document's doc is seeded lazily on first access, and `seed` writes the row's
 * title *into the type's own title field*, resolved through `titleFieldOf` — so a
 * title sent to `POST /stories` lands in `fullName` for a `person`, which is
 * precisely the field the old comment said it belonged in. The dialog's one field
 * *is* that field, asked a moment earlier, and it stays editable there afterwards.
 *
 * The new reason for asking is a defect the old shape produced: **a document must
 * not exist before it has a name.** Clicking New and walking away left a permanent
 * `Untitled` row in the list, in search and in every "used by N" count, and the
 * demo database held two of them. Strapi's create form writes nothing until you
 * save; Storyblok asks for a name in a modal first. This is the second.
 *
 * Rejected: **create-then-edit, which is what Contentful does** and what this was.
 * It has one real advantage — the editor opens a keystroke sooner, with no modal
 * in the way — and it pays for it with rows nobody meant to create, which only the
 * person who made them can recognise as junk. An abandoned dialog costs nothing.
 */
function NewDocumentButton({
  type,
  schema,
  apiBase,
  onCreated,
  onNotice,
}: {
  type: DocumentType
  /** For the dialog's one label: the title field's own, so a `person` is asked for
   * a "Full name". */
  schema: SchemaIndex
  apiBase: string
  onCreated: (id: string) => void
  onNotice: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [creating, setCreating] = useState(false)

  /** Closes on success only: a failed POST leaves the dialog open with the typed
   * name still in it, and the message in the toast above it. */
  const create = async (body: CreateBody) => {
    setPending(true)
    try {
      const res = await fetch(`${apiBase}/stories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      setCreating(false)
      onCreated(((await res.json()) as { id: string }).id)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
        New {type.label.toLowerCase()}
      </Button>
      {creating ? (
        <CreateDialog
          type={type}
          schema={schema}
          pending={pending}
          onClose={() => setCreating(false)}
          onCreate={(body) => void create(body)}
        />
      ) : null}
    </>
  )
}
