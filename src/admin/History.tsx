import { useState } from 'react'
import type { Doc } from '../core/doc'
import type { Mutation } from '../core/mutations'
import type { ActivityEntry } from '../core/protocol'
import type { SchemaIndex } from '../core/schema'
import type { VersionMeta } from '../server/versions'

interface Props {
  versions: VersionMeta[]
  activity: ActivityEntry[]
  doc: Doc
  schema: SchemaIndex
  busy: boolean
  /** Version currently being previewed, if any. */
  viewingId: string | null
  onCheckpoint: (label: string) => Promise<void>
  /**
   * Restoring is reached from the preview banner rather than from this list, so
   * a version is always seen before it is applied.
   */
  onView: (version: VersionMeta) => Promise<void>
  onExitView: () => void
  onRefresh: () => void
}

export function History({
  versions,
  activity,
  doc,
  schema,
  busy,
  viewingId,
  onCheckpoint,
  onView,
  onExitView,
  onRefresh,
}: Props) {
  const [naming, setNaming] = useState(false)

  return (
    <div className="history">
      <header className="history__head">
        <h2>Versions</h2>
        <div>
          <button type="button" onClick={onRefresh} title="Reload">
            ↻
          </button>
          <button type="button" onClick={() => setNaming(true)} disabled={busy}>
            + Checkpoint
          </button>
        </div>
      </header>

      {naming ? (
        <NameCheckpoint
          onCancel={() => setNaming(false)}
          onSubmit={async (label) => {
            await onCheckpoint(label)
            setNaming(false)
          }}
        />
      ) : null}

      {versions.length === 0 ? (
        <p className="history__empty">
          No versions yet. Publishing saves one automatically, or save a checkpoint now.
        </p>
      ) : (
        <ul className="history__list">
          {versions.map((v) => (
            <li key={v.id} className={`version ${v.id === viewingId ? 'is-viewing' : ''}`}>
              <span className={`version__kind version__kind--${v.kind}`} title={v.kind} />
              <span className="version__body">
                <span className="version__label">{v.label || (v.kind === 'publish' ? 'Published' : 'Checkpoint')}</span>
                <span className="version__meta">
                  {formatWhen(v.createdAt)}
                  {v.actor ? ` · ${v.actor}` : ''}
                </span>
              </span>
              {v.id === viewingId ? (
                <button type="button" onClick={onExitView}>
                  Close
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void onView(v)} title="Preview without changing anything">
                  View
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <header className="history__head history__head--sub">
        <h2>Activity</h2>
      </header>

      {activity.length === 0 ? (
        <p className="history__empty">No edits recorded yet.</p>
      ) : (
        <ul className="history__list">
          {activity.map((entry) => (
            <li key={entry.syncId} className="activity">
              <span className="activity__what">{describe(entry.mutations, doc, schema)}</span>
              <span className="activity__meta">
                {entry.actorName ?? entry.actor} · {formatWhen(entry.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NameCheckpoint({
  onSubmit,
  onCancel,
}: {
  onSubmit: (label: string) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  return (
    <form
      className="history__new"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(label.trim())
      }}
    >
      <input
        autoFocus
        value={label}
        placeholder="Name this checkpoint"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button type="submit" className="btn-primary">
        Save
      </button>
    </form>
  )
}

/**
 * Best-effort phrase for one transaction. Block and field labels come from the
 * *current* document, so a mutation touching a since-deleted block degrades to
 * a generic description rather than failing.
 */
function describe(mutations: readonly Mutation[], doc: Doc, schema: SchemaIndex): string {
  const first = mutations[0]
  if (!first) return 'No change'

  const labelFor = (uid: string) => {
    const blok = doc.bloks[uid]
    if (!blok) return 'a block'
    if (uid === doc.root) return 'Page settings'
    return schema[blok.type]?.label ?? blok.type
  }

  let phrase: string
  switch (first.t) {
    case 'set': {
      const blok = doc.bloks[first.uid]
      const field = blok ? schema[blok.type]?.fields[first.field] : undefined
      phrase = `Changed ${labelFor(first.uid)} · ${field?.label ?? first.field}`
      break
    }
    case 'insert':
      phrase = `Added ${schema[first.blok.type]?.label ?? first.blok.type}`
      break
    case 'remove':
      phrase = `Removed ${labelFor(first.uid)}`
      break
    case 'move':
      phrase = `Moved ${labelFor(first.uid)}`
      break
  }

  const rest = mutations.length - 1
  return rest > 0 ? `${phrase} +${rest} more` : phrase
}

export function formatWhen(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}
