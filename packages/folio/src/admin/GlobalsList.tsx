import type { DocumentType } from '../core/schema'
import type { StoryNode } from '../core/story'
import { useFolio } from './FolioContext'

/**
 * The configured globals (`FolioConfig.globals`, `../../../docs/specs/content-
 * model/globals.md`), in the order they were declared — a subset of the
 * declared `singleton` types, not every one of them (the spec's resolved open
 * question: explicit costs one line of config and keeps the per-request read
 * set obvious). Pure and exported so the ordering is tested without mounting
 * the rail.
 */
export function globalTypes(
  types: readonly DocumentType[],
  globals: readonly string[],
): DocumentType[] {
  return globals
    .map((name) => types.find((t) => t.name === name))
    .filter((t): t is DocumentType => Boolean(t))
}

/**
 * The iframe src for previewing `type`'s singleton in context
 * (`globals.md` decision 4): the `previewPath` story's own preview URL with
 * `&as=<name>` appended, or the bare preview route
 * (`server/routes/editor.ts`'s `/preview/global/:name`) when there is no
 * `previewPath` declared, or no story currently lives at the one that is.
 * Pure and exported so it is tested without an iframe.
 */
export function globalPreviewUrl(
  type: DocumentType,
  flat: readonly StoryNode[],
  /** The bare mount, not `apiBase`: `/preview/global/:name` renders HTML. */
  base: string,
): string {
  if (type.previewPath !== undefined) {
    const host = flat.find((s) => s.path === type.previewPath)
    if (host?.previewUrl) return `${host.previewUrl}&as=${encodeURIComponent(type.name)}`
  }
  return `${base}/preview/global/${encodeURIComponent(type.name)}`
}

interface Props {
  documents: readonly StoryNode[]
  currentId: string
  onOpen: (id: string) => void
}

/**
 * A Globals section above the page tree, listing exactly the singletons
 * `FolioConfig.globals` names — the Data rail already lists every singleton
 * (`DataList.tsx`), but this is the shortcut for the ones every page render
 * actually uses. Selecting one opens it like a story: it *is* one.
 */
export function GlobalsList({ documents, currentId, onOpen }: Props) {
  const { types, globals } = useFolio()
  const list = globalTypes(types, globals)
  if (list.length === 0) return null

  return (
    <div className="globals">
      <header className="globals__head">
        <h2>Globals</h2>
      </header>
      <ul className="globals__level">
        {list.map((type) => {
          const row = documents.find((d) => d.type === type.name)
          return (
            <li key={type.name}>
              <button
                type="button"
                className={`globals__row ${row?.id === currentId ? 'is-current' : ''}`}
                disabled={!row}
                onClick={() => row && onOpen(row.id)}
              >
                {type.label}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
