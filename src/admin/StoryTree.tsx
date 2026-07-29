import { useState } from 'react'
import { canNest, type DocumentType, typeByName } from '../core/schema'
import type { StoryNode, StoryState } from '../core/story'
import type { SpacePresence } from '../core/protocol'
import { useFolio } from './FolioContext'
import { formatWhen } from './History'
import { peersIn } from './spaceStore'

/**
 * The tree's badge for each of the four states `draftState` derives.
 * `'live'` shows nothing: an unadorned row already means "this is what's
 * public, and matches what was published". `'changed'` is the same liveness
 * with draft edits the last publish does not reflect
 * (`unpublished-changes.md`) — a "look here" hint from the coarse watermark
 * comparison, not a diff; the open story's own delta is authoritative for the
 * page actually being edited.
 */
export function badgeLabel(state: StoryState): string | null {
  if (state === 'unpublished') return 'not live'
  if (state === 'draft') return 'draft'
  if (state === 'changed') return 'unpublished changes'
  return null
}

/**
 * The page types a document may be created under — or dragged onto — a parent of
 * `parentType` (`undefined` for the top level). `under` constrains both, per
 * `document-types.md`'s resolved open question.
 *
 * Only `page` kinds are ever offered: nothing else is in the tree.
 *
 * Pure and exported so both the create menu and the drop check are tested
 * without mounting the tree.
 */
export function creatableUnder(
  types: readonly DocumentType[],
  parentType: string | undefined,
): DocumentType[] {
  const parent = typeByName(types, parentType)
  return types.filter((t) => t.kind === 'page' && canNest(t, parent))
}

/**
 * Whether a drag may land, and why not when it may not. A refusal notice rather
 * than a silent no-op: a drop that quietly springs back is indistinguishable
 * from a bug.
 *
 * Returns `null` when the move is allowed. The dragged row's own type may be
 * unknown (its type was removed from the config) — that is not a reason to
 * freeze the tree, so an unresolvable type is allowed through and the server has
 * the final say either way.
 */
export function dropRefusal(
  types: readonly DocumentType[],
  dragged: StoryNode | undefined,
  parentType: string | undefined,
): string | null {
  const type = typeByName(types, dragged?.type)
  if (!type || canNest(type, typeByName(types, parentType))) return null
  const allowed = (type.under ?? [])
    .map((name) => typeByName(types, name)?.label ?? name)
    .join(', ')
  return `A ${type.label} can only go under: ${allowed || 'nothing'}`
}

/**
 * A row's label in the active locale
 * (`../../../docs/specs/content-model/localisation.md` architecture decision 7):
 * `stories.title_i18n`'s entry, or the source-locale `title`.
 *
 * A cache of a cache, and the fallback is the point — the entry is written by
 * publish, so a page whose French title exists only in the draft reads in the
 * source language until it goes live. A wrong label in a tree is the accepted
 * cost of rendering the tree without opening every Durable Object; wrong
 * *content* on a page is not, and this never touches that.
 *
 * Pure and exported so the fallback is tested without mounting the tree.
 */
export function localeTitle(node: StoryNode, locale: string, isSourceLocale: boolean): string {
  if (isSourceLocale) return node.title
  return node.titleI18n?.[locale] || node.title
}

/**
 * "80%" for the tree's badge. A page with nothing translatable reads 100%: there
 * is no work owed, and calling it 0% would put a permanent warning on a page that
 * cannot be translated any further.
 */
export function translationPercent(status: { total: number; translated: number }): number {
  if (status.total === 0) return 100
  return Math.round((status.translated / status.total) * 100)
}

/** The chip a row wears when the site has more than one document type. A row
 * whose type is no longer declared says so rather than being hidden or deleted:
 * removing rows because the code changed is worse. */
export function typeChip(
  types: readonly DocumentType[],
  name: string,
): { label: string; unknown: boolean } | null {
  if (types.length < 2) return null
  const type = typeByName(types, name)
  return type ? { label: type.label, unknown: false } : { label: 'Unknown type', unknown: true }
}

interface Props {
  tree: StoryNode[]
  currentId: string
  onOpen: (story: StoryNode) => void
  onCreate: (title: string, parentId: string | null, type?: string) => Promise<void>
  onMove: (id: string, parentId: string | null, index: number) => Promise<void>
  /** Requests the delete confirmation (redirects.md); the editor owns whether
   * it is showing and what actually happens next. */
  onDelete: (story: StoryNode) => void
  /** Requests the duplicate confirmation (duplicate-and-paste.md); the editor
   * owns whether it is showing and what actually happens next, same as
   * `onDelete`. */
  onDuplicate: (story: StoryNode) => void
  /** Shows a refused drop (`document-types.md`). The server refuses it too; this
   * is so an editor is told before the request rather than by it. */
  onNotice: (message: string) => void
  /**
   * Who is in which story, from the space channel
   * (`../../../docs/specs/editing/live-collaboration.md`). Absent on a deployment
   * with no `SPACE` binding, and every row simply has no avatar — which is what
   * the tree looked like before this spec.
   */
  presence?: readonly SpacePresence[]
}

export function StoryTree({
  tree,
  currentId,
  onOpen,
  onCreate,
  onMove,
  onDelete,
  onDuplicate,
  onNotice,
  presence,
}: Props) {
  const { types } = useFolio()
  /**
   * Which parent the inline "new page" form is open under (`null` = top level,
   * `undefined` = closed), and which type it will create. Two pieces of state
   * rather than one encoded string: the parent and the type are independent, and
   * the type is simply ignored while the form is closed.
   */
  const [addingTo, setAddingTo] = useState<string | null | undefined>(undefined)
  const [addingType, setAddingType] = useState<string | undefined>(undefined)
  const openForm = (parentId: string | null, type?: string) => {
    setAddingTo(parentId)
    setAddingType(type)
  }
  const closeForm = () => setAddingTo(undefined)

  const topLevel = creatableUnder(types, undefined)

  return (
    <div className="stories">
      <header className="stories__head">
        <h2>Pages</h2>
        {/* One affordance while there is one thing it could mean; a menu the
            moment there is a choice (`document-types.md` phase 3). */}
        {topLevel.length > 1 ? (
          <NewMenu options={topLevel} onPick={(type) => openForm(null, type)} />
        ) : (
          <button
            type="button"
            onClick={() => openForm(null, topLevel[0]?.name)}
            title="New top-level page"
            disabled={topLevel.length === 0}
          >
            + New
          </button>
        )}
      </header>

      {addingTo === null ? (
        <NewPage
          onCancel={closeForm}
          onSubmit={async (title) => {
            await onCreate(title, null, addingType)
            closeForm()
          }}
        />
      ) : null}

      <Level
        nodes={tree}
        depth={0}
        parentId={null}
        parentType={undefined}
        currentId={currentId}
        addingTo={addingTo}
        addingType={addingType}
        openForm={openForm}
        closeForm={closeForm}
        onOpen={onOpen}
        onCreate={onCreate}
        onMove={onMove}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onNotice={onNotice}
        presence={presence}
      />
    </div>
  )
}

/** The per-type create menu, shown only when more than one page type could be
 * created here. */
function NewMenu({
  options,
  onPick,
  label = '+ New',
}: {
  options: readonly DocumentType[]
  onPick: (type: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title="New page"
      >
        {label}
      </button>
    )
  }
  return (
    <div className="stories__menu" onMouseLeave={() => setOpen(false)}>
      {options.map((type) => (
        <button
          key={type.name}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPick(type.name)
            setOpen(false)
          }}
        >
          {type.label}
        </button>
      ))}
    </div>
  )
}

function Level({
  nodes,
  depth,
  parentId,
  parentType,
  currentId,
  addingTo,
  addingType,
  openForm,
  closeForm,
  onOpen,
  onCreate,
  onMove,
  onDelete,
  onDuplicate,
  onNotice,
  presence,
}: {
  nodes: StoryNode[]
  depth: number
  parentId: string | null
  /** The type of the document this level's rows sit under, for `under`.
   * `undefined` at the top level, which has no type to match. */
  parentType: string | undefined
  addingTo: string | null | undefined
  addingType: string | undefined
  openForm: (parentId: string | null, type?: string) => void
  closeForm: () => void
} & Pick<
  Props,
  | 'currentId'
  | 'onOpen'
  | 'onCreate'
  | 'onMove'
  | 'onDelete'
  | 'onDuplicate'
  | 'onNotice'
  | 'presence'
>) {
  const { types, stories, locale, isSourceLocale, translation } = useFolio()
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)

  /**
   * Long levels are truncated (`../../../docs/specs/content-model/collections.md`
   * decision 6, phase 4): a tree node with 800 insights under it is unusable
   * however fast the query behind it is.
   *
   * `visibleAt` never hides the row that is **open**, or an ancestor of it — the
   * one case where truncating would make the editor look broken rather than tidy.
   * `nodes` is unchanged, so the drop-gap indices below still mean what they say.
   */
  const shown = showAll ? nodes : visibleAt(nodes, currentId)
  const hidden = nodes.length - shown.length

  const chipOf = (node: StoryNode) => typeChip(types, node.type)
  const childTypes = (node: StoryNode) => creatableUnder(types, node.type)

  /**
   * A drop into *this* level, refused with a notice when `under` forbids it.
   * Checked here as well as server-side so the editor is told before the request
   * rather than by it — the resolved open question's "refusal notice rather than
   * a silent no-op".
   */
  const drop = (index: number, id: string) => {
    const refusal = dropRefusal(
      types,
      stories.find((s) => s.id === id),
      parentType,
    )
    if (refusal) {
      onNotice(refusal)
      return
    }
    void onMove(id, parentId, index)
  }

  return (
    <ul className="stories__level" style={{ paddingLeft: depth ? 12 : 0 }}>
      {shown.map((node, i) => (
        <li key={node.id}>
          <div
            className={`stories__gap ${dropIndex === i ? 'is-over' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('text/folio-story')) return
              e.preventDefault()
              e.stopPropagation()
              setDropIndex(i)
            }}
            onDragLeave={() => setDropIndex(null)}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropIndex(null)
              const id = e.dataTransfer.getData('text/folio-story')
              if (id) drop(i, id)
            }}
          />

          <div
            className={`stories__row ${node.id === currentId ? 'is-current' : ''}`}
            onClick={() => onOpen(node)}
          >
            {/*
              Only the handle is draggable. Making the whole row draggable means
              a few pixels of movement during a click silently reparents a page.
            */}
            {node.path === '' ? (
              <span className="stories__handle stories__handle--fixed" />
            ) : (
              <span
                className="stories__handle"
                draggable
                title="Drag to reorder or move"
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/folio-story', node.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
              >
                ⠿
              </span>
            )}
            <span className="stories__title">{localeTitle(node, locale, isSourceLocale)}</span>
            {/* How much of this page is translated, for the open row only: it is
                computed from the draft already in the store, so it costs nothing
                and moves per keystroke. See `FolioContextValue.translation` for
                why every other row is left unbadged. */}
            {translation && node.id === currentId ? (
              <span
                className={`stories__i18n ${translation.missing.length === 0 ? 'is-complete' : ''}`}
                title={
                  translation.missing.length === 0
                    ? 'Fully translated'
                    : `${translation.missing.length} field${translation.missing.length === 1 ? '' : 's'} untranslated`
                }
              >
                {translationPercent(translation)}%
              </span>
            ) : null}
            {/* Only once the site has more than one document type: a chip that
                always reads "Page" is noise (`document-types.md` phase 3). */}
            {chipOf(node) ? (
              <span
                className={`stories__chip ${chipOf(node)?.unknown ? 'is-unknown' : ''}`}
                title={
                  chipOf(node)?.unknown
                    ? `The type '${node.type}' is no longer declared in the schema`
                    : undefined
                }
              >
                {chipOf(node)?.label}
              </span>
            ) : null}
            <code className="stories__path">/{node.path}</code>
            {badgeLabel(node.state) ? (
              <span
                className={`stories__badge stories__badge--${node.state}`}
                title={
                  node.state === 'changed' && node.draftUpdatedAt
                    ? `Edited ${formatWhen(node.draftUpdatedAt)}`
                    : undefined
                }
              >
                {badgeLabel(node.state)}
              </span>
            ) : null}
            {/* Who else is in this document (`live-collaboration.md`): the payoff
                of a channel that knows about more than one story, and the answer
                to "am I about to open the page somebody is already in". Deduped by
                actor, so one person with two tabs is one dot. */}
            {(presence ? peersIn(presence, node.id) : []).map((p) => (
              <span
                key={p.actor}
                className="stories__peer"
                style={{ background: p.colour }}
                title={p.tabs > 1 ? `${p.name} (${p.tabs} tabs)` : p.name}
              />
            ))}
            <span className="stories__actions">
              {/* `under` narrows what can be created here, not just what a drag
                  may drop into: an empty list disables the affordance rather
                  than offering a create the server would refuse. */}
              {childTypes(node).length > 1 ? (
                <NewMenu
                  label="+"
                  options={childTypes(node)}
                  onPick={(type) => openForm(node.id, type)}
                />
              ) : (
                <button
                  type="button"
                  title={
                    childTypes(node).length === 0
                      ? 'No document type may be created here'
                      : `Add ${childTypes(node)[0]?.label ?? 'page'}`
                  }
                  disabled={childTypes(node).length === 0}
                  onClick={(e) => {
                    e.stopPropagation()
                    openForm(node.id, childTypes(node)[0]?.name)
                  }}
                >
                  +
                </button>
              )}
              <button
                type="button"
                title="Duplicate page"
                onClick={(e) => {
                  e.stopPropagation()
                  onDuplicate(node)
                }}
              >
                ⧉
              </button>
              {node.path === '' ? null : (
                <button
                  type="button"
                  title="Delete page and children"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(node)
                  }}
                >
                  ×
                </button>
              )}
            </span>
          </div>

          {addingTo === node.id ? (
            <NewPage
              onCancel={closeForm}
              onSubmit={async (title) => {
                await onCreate(title, node.id, addingType)
                closeForm()
              }}
            />
          ) : null}

          {node.children.length || addingTo === node.id ? (
            <Level
              nodes={node.children}
              depth={depth + 1}
              parentId={node.id}
              parentType={node.type}
              currentId={currentId}
              addingTo={addingTo}
              addingType={addingType}
              openForm={openForm}
              closeForm={closeForm}
              onOpen={onOpen}
              onCreate={onCreate}
              onMove={onMove}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onNotice={onNotice}
              presence={presence}
            />
          ) : null}
        </li>
      ))}

      {hidden > 0 ? (
        <li>
          <button type="button" className="stories__more" onClick={() => setShowAll(true)}>
            Show all {nodes.length}
          </button>
        </li>
      ) : null}

      <li
        className={`stories__gap ${dropIndex === nodes.length ? 'is-over' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('text/folio-story')) return
          e.preventDefault()
          e.stopPropagation()
          setDropIndex(nodes.length)
        }}
        onDragLeave={() => setDropIndex(null)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropIndex(null)
          const id = e.dataTransfer.getData('text/folio-story')
          if (id) drop(nodes.length, id)
        }}
      />
    </ul>
  )
}

/**
 * How many siblings one level draws before it offers "Show all".
 *
 * Chosen to be past every hand-built tree and short of every generated one: a site
 * with fifty pages under one parent has organised them that way on purpose, and a
 * site with eight hundred has not.
 */
export const LEVEL_LIMIT = 50

/**
 * The prefix of a level to draw, extended when the open story (or an ancestor of
 * it) would otherwise be cut off.
 *
 * Pure and exported so the one property worth pinning is testable without mounting
 * the tree: **truncation never hides where you are.** A tree that silently omits the
 * page you have open reads as a bug, not as tidiness.
 */
export function visibleAt(nodes: readonly StoryNode[], currentId: string): StoryNode[] {
  if (nodes.length <= LEVEL_LIMIT) return [...nodes]
  const holdsCurrent = (node: StoryNode): boolean =>
    node.id === currentId || node.children.some(holdsCurrent)
  const at = nodes.findIndex(holdsCurrent)
  // `at + 1` rather than the limit, so the open row is the last one drawn: a level
  // that jumped to row 700 and drew fifty more would be its own kind of confusing.
  return nodes.slice(0, at >= LEVEL_LIMIT ? at + 1 : LEVEL_LIMIT)
}

function NewPage({
  onSubmit,
  onCancel,
}: {
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
        placeholder="Page title"
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
