import { useState } from 'react'
import type { Json } from '../core/doc'
import type { StoryNode } from '../core/story'
import { asStoryIds } from '../core/values'
import { useFolio } from './FolioContext'
import { referenceCandidates } from './Inspector'

/**
 * Editor for a `references()` field — a hand-picked, ordered list of documents
 * (`../../../docs/specs/content-model/data-documents.md` architecture decision
 * 3).
 *
 * The picker is `LinkInput`'s (a `select` narrowed by the field's `types`,
 * through the shared `referenceCandidates`); the card list is
 * `MultiAssetInput`'s, minus its machinery. That component has to mint local
 * card ids and reconcile them across every render, because an asset carries no
 * identity of its own and the same file may appear in the list twice. A
 * reference is a story id — a real identity, and unique here, since duplicates
 * are dropped on the way in — so these cards key by it directly.
 *
 * Every change writes the whole array back as one value, so a reorder is one
 * ordinary `set` mutation and therefore one undo step — consistent with how
 * every array-valued field in Folio behaves.
 */

interface Props {
  id: string
  value: Json
  types?: readonly string[]
  min?: number
  max?: number
  onChange: (value: Json) => void
}

/** One entry as the list draws it: the story when it resolves, the bare id when
 * it does not. */
export interface ReferenceEntry {
  id: string
  story: StoryNode | undefined
}

/**
 * The stored ids paired with the stories they name. Pure and exported so the
 * missing-target case is tested without mounting.
 *
 * A deleted target is kept here as `{ id, story: undefined }` rather than
 * dropped: the *renderer* drops it, which is what stops a page rendering an empty
 * card, but the editor has to show it or the list silently gets shorter and
 * nobody can say why. That split is the same one `multilink`'s `broken` flag
 * makes.
 */
export function referenceEntries(value: Json, stories: readonly StoryNode[]): ReferenceEntry[] {
  const byId = new Map(stories.map((s) => [s.id, s]))
  return asStoryIds(value).map((id) => ({ id, story: byId.get(id) }))
}

/** Candidates not already picked, narrowed by the field's `types`. */
export function unpickedCandidates(
  stories: readonly StoryNode[],
  chosen: readonly string[],
  types?: readonly string[],
): StoryNode[] {
  const taken = new Set(chosen)
  return referenceCandidates(stories, types).filter((s) => !taken.has(s.id))
}

export function ReferencesInput({ id, value, types, min, max, onChange }: Props) {
  const { stories } = useFolio()
  // Which id the picker is showing, for the gap between choosing and adding.
  // Nothing half-picked is ever stored, so this has to live here.
  const [pick, setPick] = useState('')

  const entries = referenceEntries(value, stories)
  const ids = entries.map((e) => e.id)
  const full = max !== undefined && ids.length >= max
  const short = min !== undefined && ids.length < min
  const offered = unpickedCandidates(stories, ids, types)

  const write = (next: readonly string[]) => onChange([...next] as unknown as Json)

  const add = (target: string) => {
    // Both guards matter: `full` is what decision 3's "a fourth pick beyond max
    // is refused by the input" means, and the duplicate check is what keeps the
    // stored value in step with `asStoryIds`, which drops repeats on the way out.
    if (!target || full || ids.includes(target)) return
    write([...ids, target])
    setPick('')
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    write(next)
  }

  return (
    <div className="refs">
      <ul className="refs__list">
        {entries.map((entry, i) => (
          <li className={`refs__card ${entry.story ? '' : 'refs__card--missing'}`} key={entry.id}>
            <span className="refs__ord">{i + 1}</span>
            <span className="refs__meta">
              {entry.story ? (
                <>
                  <span className="refs__title">{entry.story.title || 'Untitled'}</span>
                  <code className="refs__where">
                    {entry.story.path === null ? entry.story.type : `/${entry.story.path}`}
                  </code>
                </>
              ) : (
                <>
                  {/* Named, not merely counted: an editor needs to know *which*
                      entry vanished, and the id is all that is left of it. */}
                  <span className="refs__title">missing (deleted)</span>
                  <code className="refs__where">{entry.id}</code>
                </>
              )}
            </span>
            <span className="refs__actions">
              <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} title="Up">
                ↑
              </button>
              <button
                type="button"
                disabled={i === entries.length - 1}
                onClick={() => move(i, i + 1)}
                title="Down"
              >
                ↓
              </button>
              <button
                type="button"
                className="refs__remove"
                onClick={() => write(ids.filter((_, j) => j !== i))}
                title="Remove"
              >
                ×
              </button>
            </span>
          </li>
        ))}
        {entries.length === 0 ? <li className="refs__empty">Nothing picked yet.</li> : null}
      </ul>

      <div className="refs__pick">
        <select
          id={id}
          value={pick}
          disabled={full || offered.length === 0}
          onChange={(e) => {
            setPick(e.target.value)
            add(e.target.value)
          }}
        >
          <option value="">
            {full
              ? `Limit of ${max} reached`
              : offered.length === 0
                ? 'Nothing left to add'
                : 'Add…'}
          </option>
          {offered.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.path === null ? '' : ` — /${s.path}`}
            </option>
          ))}
        </select>
      </div>

      {/* `min` is a warning, never a refusal: `required` is declared-and-ignored
          across the whole field system (PARITY-MCKINNON phase 5), and this field
          has no business inventing its own enforcement ahead of the rest. */}
      {short ? (
        <p className="refs__warn">
          Pick at least {min} — {ids.length} chosen.
        </p>
      ) : null}
    </div>
  )
}
