/**
 * **Why the block picker is a `Dialog` and not a `Palette`.**
 *
 * `docs/ui-architecture.md` calls this surface "a palette, not a list", and
 * `docs/editor-port-plan.md` expected it to be "a second mount of `Palette.tsx`, not
 * a second implementation". It is a second mount of `rank.ts`, which is the part that
 * matters — one ranking implementation, four consumers, so `hro` finds Hero here
 * exactly as it finds a page in `⌘K` — but `Palette` itself could not take it, and
 * the gap is worth stating where the next person meets it.
 *
 * `PaletteAction` carries a `label` and an optional `hint`, and `Palette.module.css`
 * draws a row at `height: var(--row-h)` with the hint right-aligned in mono. The
 * design's requirement for this picker is a label **and a description** — one line
 * each — and a description is neither a hint nor something that fits beside one.
 *
 * **What would close it**, precisely: an optional `description` on `PaletteAction`,
 * plus a two-line row variant in `Palette.module.css`. `docs/design-system.md`
 * already prices the second line at 20px and calls it opt-in per row, so this is
 * within the primitive's own vocabulary rather than a stretch of it. It was not done
 * here because `Palette` is one of eleven fixed primitives and a twelfth — or a
 * widened eleventh — is a design conversation, not a screen's decision. Until then
 * this is `Dialog` plus `rank`, which is exactly what `MoveDialog` is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SchemaIndex } from '../../../core/schema'
import { Badge } from '../Badge'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { highlight, nextIndex, rank } from '../rank'
import css from './BlockPicker.module.css'
import { groupRanked, type PickerEntry, slotOffer } from './block-picker-model'

export interface BlockPickerProps {
  schema: SchemaIndex
  /** The block type owning the slot — `doc.bloks[parent].type`. */
  parentType: string
  /** The slot the block goes in. A `blocks`-kind field on `parentType`. */
  slot: string
  /** How many blocks the slot already holds, so a full slot refuses rather than
   * offering a list every entry of which would be rejected. */
  filled: number
  onClose: () => void
  /**
   * `useBlocks.add` with `(parent, slot, index)` already closed over by the caller
   * — the shape `BlockTree`'s `AddMenu` already uses, so the wiring is one arrow
   * function and this component never learns where in the slot the block lands.
   */
  onPick: (type: string, preset?: string) => void
}

/**
 * The block picker as a **palette, not a list** — `docs/ui-architecture.md`'s
 * editor section, and port phase 7c.
 *
 * This is the direct answer to the ceiling `ROADMAP.md` names: the current
 * `+ Add block` menu is an unsorted flat list that "stops working somewhere around
 * 15", and the reference project has 87 block types. Searchable, grouped, keyboard
 * first, and every entry says what it is.
 *
 * `Palette` supplies the ranking and not the chrome; the file header above says why,
 * and what would change it.
 *
 * **What the search matches**, since the choice is real: the entry's label, ranked
 * and highlighted, plus keywords that are ranked at `rank`'s own discount and never
 * highlighted — the block's type name, the preset's name, the parent type's label,
 * and every field's name and label. The last of those is `settings-model.ts`'s
 * `filterBlocks` trick and it is the one that earns its keep: `alt` finds Image,
 * `caption` finds the blocks that have one, and nobody maintains a synonym list.
 * Deliberately *not* matched: the derived description, because it is built from the
 * field labels that are already keywords and matching it would double their weight.
 */
export function BlockPicker({
  schema,
  parentType,
  slot,
  filled,
  onClose,
  onPick,
}: BlockPickerProps) {
  const offer = useMemo(
    () => slotOffer(schema, parentType, slot, filled),
    [filled, parentType, schema, slot],
  )

  return (
    <Dialog
      title={`Add to ${offer.slotLabel}`}
      description={
        offer.refusal === null
          ? 'Only the block types this slot accepts are listed.'
          : 'This slot has nothing to offer.'
      }
      size="wide"
      onClose={onClose}
    >
      {offer.refusal === null ? (
        <Picker entries={offer.entries} onClose={onClose} onPick={onPick} />
      ) : (
        /* A refusal rather than an empty list, and it names which of the four rules
           it was — see `slotOffer`. There is no action here on purpose: every one of
           the four is a fact about the schema, and an empty state whose next step
           would be "edit your Worker" is a next step nobody can take from a
           dialog. */
        <EmptyState title="Nothing can be added here" body={offer.refusal} />
      )}
    </Dialog>
  )
}

function Picker({
  entries,
  onClose,
  onPick,
}: {
  entries: readonly PickerEntry[]
  onClose: () => void
  onPick: (type: string, preset?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => rank(query, entries), [entries, query])
  const groups = useMemo(() => groupRanked(results), [results])

  // Clamped rather than reset, the same rule `Palette` follows: typing a character
  // that shortens the list should leave the selection on something, and resetting
  // to 0 on every keystroke fights anyone arrowing down while still typing.
  const index = Math.min(active, Math.max(results.length - 1, 0))

  // biome-ignore lint/correctness/useExhaustiveDependencies: index is the trigger, not a value the body reads — the DOM is queried for whichever row now carries data-active
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (at: number) => {
    const hit = results[at]
    if (!hit) return
    // Close first, then insert — `Palette.run`'s order. The insert moves the
    // selection and re-renders the tree and the inspector behind this dialog, and
    // doing that while the dialog is still mounted means the focus trap restores
    // focus to a control that has just been replaced.
    onClose()
    onPick(hit.item.type, hit.item.preset)
  }

  return (
    <>
      <input
        // Focus lands here through the focus trap, which picks the first tabbable
        // thing in the panel — `Dialog` has no `autoFocus` anywhere inside it, and
        // this is why.
        className={css.search}
        type="search"
        value={query}
        placeholder="Search blocks and presets"
        aria-label="Search blocks and presets"
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            run(index)
            return
          }
          // Escape is deliberately not handled: `useFocusTrap` owns it on the
          // window, so the one key that closes an overlay closes every overlay.
          const next = nextIndex(e.key, index, results.length)
          if (next !== null) {
            e.preventDefault()
            setActive(next)
          }
        }}
      />

      <div ref={listRef} className={css.results}>
        {results.length === 0 ? (
          <p className={css.empty}>Nothing matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className={css.group}>
              {group.solo ? null : <p className={css.groupName}>{group.label}</p>}
              {group.rows.map(({ at, entry, spans }) => (
                <button
                  key={entry.id}
                  type="button"
                  data-active={at === index}
                  className={`${css.row} ${at === index ? css.rowActive : ''}`}
                  onMouseMove={() => setActive(at)}
                  onClick={() => run(at)}
                >
                  <span className={css.label}>
                    {highlight(entry.label, spans).map((part, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by nature
                      <span key={i} className={part.hit ? css.hit : undefined}>
                        {part.text}
                      </span>
                    ))}
                    {/* Presets sit alongside plain blocks rather than in a submenu,
                        so something has to tell them apart. A badge, not a
                        different row shape: they are inserted by the same call with
                        one more argument, and a preset that looked like a different
                        kind of thing would imply otherwise. */}
                    {entry.bare ? null : <Badge tone="accent">Preset</Badge>}
                  </span>
                  <span className={css.description}>{entry.description}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  )
}
