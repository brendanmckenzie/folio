import type { DocumentType } from '../core/schema'
import type { StoryNode } from '../core/story'
import { useFolio } from './FolioContext'
import { badgeLabel } from './StoryTree'

/**
 * The Data rail: one row per non-page type, with how many documents it has
 * (`../../../docs/specs/content-model/data-documents.md` architecture decision
 * 2). Selecting a type opens its list view — a real table — in the stage; the
 * rail itself stays a short index, because twenty-four people do not belong in a
 * 280px column.
 *
 * A singleton is one row rather than a group: there is exactly one, its id is
 * derived, and the act of listing is what created it (`ensureSingleton`, called
 * by `GET /folio/documents`). So it has no "+ New", no delete, and no table —
 * clicking it opens the document itself.
 */
interface Props {
  documents: readonly StoryNode[]
  /** The type whose table the stage is showing, if any. */
  selectedType: string | null
  /** The document currently open, so its own type reads as active too. */
  currentId: string
  onSelectType: (name: string) => void
  onOpen: (story: StoryNode) => void
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
 *
 * Listed directly in the rail rather than getting a table of their own, and for a
 * reason the table cannot work around — the columns come from a type's root
 * block's `indexed` fields, and an orphan has no declared type to read them from
 * (`data-documents.md`'s "a record type renamed in code" edge case).
 */
export function orphanedDocuments(
  documents: readonly StoryNode[],
  types: readonly DocumentType[],
): StoryNode[] {
  const known = new Set(types.map((t) => t.name))
  return documents.filter((d) => !known.has(d.type))
}

export function DataList({ documents, selectedType, currentId, onSelectType, onOpen }: Props) {
  const { types } = useFolio()
  const groups = dataTypes(types)
  const orphans = orphanedDocuments(documents, types)
  const current = documents.find((d) => d.id === currentId)

  if (groups.length === 0 && orphans.length === 0) {
    return (
      <div className="data">
        <p className="rail__loading">
          This site declares no record or singleton types. Add one to <code>types</code> in{' '}
          <code>createFolio</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="data">
      <ul className="data__types">
        {groups.map((type) => {
          const rows = documentsOfType(documents, type.name)
          const singleton = type.kind === 'singleton'
          // The one row a singleton has, so clicking the type opens it.
          const only = singleton ? rows[0] : undefined
          const active = selectedType === type.name || (singleton && current?.id === only?.id)
          return (
            <li key={type.name}>
              <button
                type="button"
                className={`data__type ${active ? 'is-current' : ''}`}
                onClick={() => (only ? onOpen(only) : onSelectType(type.name))}
              >
                <span className="data__type-label">{type.label}</span>
                {singleton ? (
                  <span className="data__type-kind">one</span>
                ) : (
                  <span className="data__type-count">{rows.length}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {orphans.length > 0 ? (
        <section className="data__group">
          <header className="data__head">
            <h2>Unknown type</h2>
          </header>
          <ul className="data__level">
            {orphans.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`data__row ${row.id === currentId ? 'is-current' : ''}`}
                  onClick={() => onOpen(row)}
                >
                  <span className="data__title">{row.title}</span>
                  <code className="data__slug">{row.type}</code>
                  {badgeLabel(row.state) ? (
                    <span className={`stories__badge stories__badge--${row.state}`}>
                      {badgeLabel(row.state)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
