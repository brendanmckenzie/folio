import { useState } from 'react'
import type { DocumentType } from '../core/schema'
import type { StoryNode } from '../core/story'
import { useFolio } from './FolioContext'
import { badgeLabel } from './StoryTree'

/**
 * The Data rail: every `record` and `singleton` type, with its documents beneath
 * it. Deliberately thin — `../../../docs/specs/content-model/data-documents.md`
 * owns the real thing (a table rather than a list, a form rather than a preview
 * iframe, usage counts before deletion). What is here is the minimum that makes
 * an unrouted document reachable at all, since by construction it is not in the
 * page tree.
 *
 * A singleton is one row rather than a group: there is exactly one, its id is
 * derived, and the act of listing is what created it (`ensureSingleton`, called
 * by `GET /folio/documents`). So it has no "+ New" and no delete.
 */
interface Props {
  documents: readonly StoryNode[]
  currentId: string
  onOpen: (story: StoryNode) => void
  onCreate: (title: string, parentId: string | null, type?: string) => Promise<void>
  /** Requests the delete confirmation, same contract as the page tree's. */
  onDelete: (story: StoryNode) => void
  onDuplicate: (story: StoryNode) => void
}

/**
 * The types this rail is responsible for, in declaration order: everything that
 * is not a page. Pure and exported so the grouping is tested without mounting.
 */
export function dataTypes(types: readonly DocumentType[]): DocumentType[] {
  return types.filter((t) => t.kind !== 'page')
}

/** One type's documents, in `ord` order (the server already sorted them). */
export function documentsOfType(documents: readonly StoryNode[], type: string): StoryNode[] {
  return documents.filter((d) => d.type === type)
}

/**
 * Rows whose type is no longer declared anywhere. Shown under their own heading
 * rather than dropped: a row that has become invisible because the code changed
 * is a row nobody can recover.
 */
export function orphanedDocuments(
  documents: readonly StoryNode[],
  types: readonly DocumentType[],
): StoryNode[] {
  const known = new Set(types.map((t) => t.name))
  return documents.filter((d) => !known.has(d.type))
}

export function DataList({ documents, currentId, onOpen, onCreate, onDelete, onDuplicate }: Props) {
  const { types } = useFolio()
  const [addingTo, setAddingTo] = useState<string | undefined>(undefined)
  const groups = dataTypes(types)
  const orphans = orphanedDocuments(documents, types)

  if (groups.length === 0 && orphans.length === 0) {
    return (
      <div className="data">
        <p className="rail__loading">
          This site declares no record or singleton types. Add one to
          <code>types</code> in <code>createFolio</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="data">
      {groups.map((type) => {
        const rows = documentsOfType(documents, type.name)
        const singleton = type.kind === 'singleton'
        return (
          <section className="data__group" key={type.name}>
            <header className="data__head">
              <h2>{type.label}</h2>
              {singleton ? null : (
                <button
                  type="button"
                  title={`New ${type.label}`}
                  onClick={() => setAddingTo(type.name)}
                >
                  + New
                </button>
              )}
            </header>

            {addingTo === type.name ? (
              <NewDocument
                label={type.label}
                onCancel={() => setAddingTo(undefined)}
                onSubmit={async (title) => {
                  await onCreate(title, null, type.name)
                  setAddingTo(undefined)
                }}
              />
            ) : null}

            <ul className="data__level">
              {rows.map((row) => (
                <li key={row.id}>
                  <div
                    className={`data__row ${row.id === currentId ? 'is-current' : ''}`}
                    onClick={() => onOpen(row)}
                  >
                    <span className="data__title">{row.title}</span>
                    <code className="data__slug">{row.slug}</code>
                    {badgeLabel(row.state) ? (
                      <span className={`stories__badge stories__badge--${row.state}`}>
                        {badgeLabel(row.state)}
                      </span>
                    ) : null}
                    {/* Neither action exists for a singleton: a second one is
                        unrepresentable, and deleting the one there is would only
                        mean it comes back empty on the next list. */}
                    {singleton ? null : (
                      <span className="stories__actions">
                        <button
                          type="button"
                          title={`Duplicate ${type.label}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onDuplicate(row)
                          }}
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          title={`Delete ${type.label}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(row)
                          }}
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
              {rows.length === 0 && !singleton ? (
                <li className="data__empty">No {type.label.toLowerCase()} documents yet.</li>
              ) : null}
            </ul>
          </section>
        )
      })}

      {orphans.length > 0 ? (
        <section className="data__group">
          <header className="data__head">
            <h2>Unknown type</h2>
          </header>
          <ul className="data__level">
            {orphans.map((row) => (
              <li key={row.id}>
                <div
                  className={`data__row ${row.id === currentId ? 'is-current' : ''}`}
                  onClick={() => onOpen(row)}
                >
                  <span className="data__title">{row.title}</span>
                  <code className="data__slug">{row.type}</code>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

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
      className="stories__new"
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
    </form>
  )
}
