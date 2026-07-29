import { useState } from 'react'
import type { StoryNode, StoryState } from '../core/story'
import { formatWhen } from './History'

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

interface Props {
  tree: StoryNode[]
  currentId: string
  onOpen: (story: StoryNode) => void
  onCreate: (title: string, parentId: string | null) => Promise<void>
  onMove: (id: string, parentId: string | null, index: number) => Promise<void>
  /** Requests the delete confirmation (redirects.md); the editor owns whether
   * it is showing and what actually happens next. */
  onDelete: (story: StoryNode) => void
  /** Requests the duplicate confirmation (duplicate-and-paste.md); the editor
   * owns whether it is showing and what actually happens next, same as
   * `onDelete`. */
  onDuplicate: (story: StoryNode) => void
}

export function StoryTree({
  tree,
  currentId,
  onOpen,
  onCreate,
  onMove,
  onDelete,
  onDuplicate,
}: Props) {
  const [addingTo, setAddingTo] = useState<string | null | undefined>(undefined)

  return (
    <div className="stories">
      <header className="stories__head">
        <h2>Pages</h2>
        <button type="button" onClick={() => setAddingTo(null)} title="New top-level page">
          + New
        </button>
      </header>

      {addingTo === null ? (
        <NewPage
          onCancel={() => setAddingTo(undefined)}
          onSubmit={async (title) => {
            await onCreate(title, null)
            setAddingTo(undefined)
          }}
        />
      ) : null}

      <Level
        nodes={tree}
        depth={0}
        parentId={null}
        currentId={currentId}
        addingTo={addingTo}
        setAddingTo={setAddingTo}
        onOpen={onOpen}
        onCreate={onCreate}
        onMove={onMove}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />
    </div>
  )
}

function Level({
  nodes,
  depth,
  parentId,
  currentId,
  addingTo,
  setAddingTo,
  onOpen,
  onCreate,
  onMove,
  onDelete,
  onDuplicate,
}: {
  nodes: StoryNode[]
  depth: number
  parentId: string | null
  addingTo: string | null | undefined
  setAddingTo: (v: string | null | undefined) => void
} & Pick<Props, 'currentId' | 'onOpen' | 'onCreate' | 'onMove' | 'onDelete' | 'onDuplicate'>) {
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  return (
    <ul className="stories__level" style={{ paddingLeft: depth ? 12 : 0 }}>
      {nodes.map((node, i) => (
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
              if (id) void onMove(id, parentId, i)
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
            <span className="stories__title">{node.title}</span>
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
            <span className="stories__actions">
              <button
                type="button"
                title="Add child page"
                onClick={(e) => {
                  e.stopPropagation()
                  setAddingTo(node.id)
                }}
              >
                +
              </button>
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
              onCancel={() => setAddingTo(undefined)}
              onSubmit={async (title) => {
                await onCreate(title, node.id)
                setAddingTo(undefined)
              }}
            />
          ) : null}

          {node.children.length || addingTo === node.id ? (
            <Level
              nodes={node.children}
              depth={depth + 1}
              parentId={node.id}
              currentId={currentId}
              addingTo={addingTo}
              setAddingTo={setAddingTo}
              onOpen={onOpen}
              onCreate={onCreate}
              onMove={onMove}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
            />
          ) : null}
        </li>
      ))}

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
          if (id) void onMove(id, parentId, nodes.length)
        }}
      />
    </ul>
  )
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
