import { useState } from 'react'
import type { StoryRef } from '../../../../core/resolve'
import { Button } from '../../Button'
import { Dialog } from '../../Dialog'
import { EmptyState } from '../../EmptyState'
import { Field, Input } from '../../Field'
import { type Candidate, candidateHint, useCandidates } from './candidates'
import css from './fields.module.css'

interface Props {
  apiBase: string
  /** Names the field in the dialog's own title, so two pickers opened from one
   * block are told apart by the question rather than by position. */
  label: string
  /** Routed pages only — a story link. False offers records too. See `CandidateQuery`. */
  routed: boolean
  types?: readonly string[]
  /** Already picked, and therefore not offered. */
  exclude?: readonly string[]
  onPick: (id: string) => void
  onClose: () => void
}

/**
 * One document, chosen.
 *
 * Replaces the `<select>` that `Inspector.tsx`'s `reference` branch,
 * `ReferencesInput`'s *Add…* and `LinkInput`'s *Choose a page…* each drew over
 * `useFolio().stories` — every document on the site, held in memory. That array is
 * gone (`candidates.ts` says why), so this searches instead, which also happens to
 * fix the ceiling `ROADMAP.md` names: an unsorted flat list of documents "stops
 * working somewhere around 15".
 *
 * A `Dialog` and not the `Palette` primitive, which was the obvious reuse and is
 * the wrong shape here. `Palette` ranks a list it is handed, client-side, and its
 * rows `run()` a command — so a server-searched list would be ranked twice, once by
 * the route's `LIKE` and once by `rank.ts`, and the second ranking would reorder
 * rows the first had already ordered by **path**, which is the sitemap order this
 * list exists to show. `Palette` is right for ⌘K and for the block picker, where
 * the whole set is in hand.
 *
 * Committing is one affordance — the row itself. There is deliberately no footer
 * *Use this*, unlike `AssetPicker`: a document row carries its title and its path
 * and nothing else worth inspecting first, so a two-step commit would be a second
 * click for no second look.
 *
 * No `autoFocus` and no focus-on-mount ref either: `Dialog`'s `useFocusTrap` moves
 * focus to the first tabbable thing in the panel, and the search box is it.
 */
export function DocumentPicker({ apiBase, label, routed, types, exclude, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const candidates = useCandidates(
    apiBase,
    { q, routed, ...(types ? { types } : {}), ...(exclude ? { exclude } : {}) },
    true,
  )

  return (
    <Dialog
      title={`Choose a document for ${label}`}
      description={
        routed
          ? 'Pages only: a document with no URL of its own has nothing to link to.'
          : 'Pages and records both — a reference resolves content, not a URL.'
      }
      size="wide"
      onClose={onClose}
      actions={<Button onClick={onClose}>Cancel</Button>}
    >
      {/* A real label, not a placeholder: a placeholder disappears the moment
          somebody types, which is exactly when a screen reader is asked what this
          control is. Biome's `noLabelWithoutControl` is on in `admin/ui/**` and
          agrees, but the rule is right on its own terms. */}
      <Field label="Search documents">
        {(id) => (
          <Input
            id={id}
            type="search"
            value={q}
            placeholder="Title or path"
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </Field>

      {candidates.error ? (
        <EmptyState title="Could not list documents" body={candidates.error} />
      ) : candidates.rows.length === 0 ? (
        <EmptyState
          title={candidates.loading ? 'Searching…' : 'Nothing matches'}
          body={
            candidates.loading
              ? 'Asking the server.'
              : q
                ? 'Try a shorter search.'
                : 'Nothing this field can point at exists yet.'
          }
        />
      ) : (
        <ul className={css.pickerRows}>
          {candidates.rows.map((row) => (
            <li key={row.id}>
              <button type="button" className={css.pickerRow} onClick={() => onPick(row.id)}>
                <span className={css.pickedTitle}>{row.title || 'Untitled'}</span>
                <span className={css.pickedWhere}>{candidateHint(row)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

/**
 * What a *picked* id draws, out of the resolution the preview is already rendered
 * from — so choosing a document costs a request and showing one costs nothing.
 *
 * `Resolution.stories` holds exactly the ids this document points at, which is
 * precisely what `useRefStories` fetched, so a reference that resolves is free here.
 * `undefined` means the target is not in the resolution: either it was deleted, or
 * the fetch has not landed yet. The caller distinguishes them by what it says —
 * `ReferenceField` names it *missing* only once the row it needs would have arrived.
 */
export function candidateOf(
  stories: Readonly<Record<string, StoryRef>>,
  id: string,
): Candidate | undefined {
  const ref = stories[id]
  if (!ref) return undefined
  return { id, title: ref.title, path: ref.routable ? ref.path : null, type: ref.type }
}
