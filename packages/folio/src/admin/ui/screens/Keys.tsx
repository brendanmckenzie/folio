import { Dialog } from '../Dialog'
import css from './Keys.module.css'

/**
 * The keyboard map, shown by `?`.
 *
 * `ui-architecture.md`'s reason for it is the whole design brief: *"Complete, because
 * a keyboard-first tool with an undocumented map is not keyboard-first."* So this is
 * generated from one table that is also the map's single source of truth, rather than
 * hand-written prose that can fall behind the bindings.
 *
 * **What it does not do is check itself against the bindings**, and that is worth
 * being honest about. `useShortcuts` takes a `Record<string, handler>`, so a chord
 * listed here with nothing bound to it would render as a promise the admin does not
 * keep. Deriving the list from the live map instead was the obvious alternative and
 * it is worse: a map's keys are `mod+k`, which is not what a person reads, and the
 * *grouping* and the ordering below carry as much meaning as the chords do. The
 * compromise is that `KEYS` sits next to nothing else and every entry names the
 * screen or the surface that owns the binding, so a deleted feature's row is visible
 * in the same diff that deletes it.
 *
 * One row is deliberately a non-binding: `⌘S` does nothing and says so. It is on the
 * map because the reflex is real and the honest answer to it is part of the product
 * (`shortcuts.ts`'s `SAVE_NOTICE` carries the owner's own wording). Publish, by
 * contrast, has no chord at all and no row — `design-system.md`'s Resolved 3 — so its
 * absence here is the same decision, not an omission.
 */
interface Row {
  keys: string
  what: string
  /** Where the binding lives, so a row cannot outlive its feature unnoticed. */
  where: string
}

export const KEYS: { group: string; rows: Row[] }[] = [
  {
    group: 'Anywhere',
    rows: [
      { keys: '⌘K', what: 'Search documents, screens and commands', where: 'the shell' },
      { keys: '?', what: 'This map', where: 'the shell' },
      { keys: '⌘S', what: 'Nothing — and says so', where: 'the shell' },
    ],
  },
  {
    group: 'Go to',
    rows: [
      { keys: 'g h', what: 'Home', where: 'the shell' },
      { keys: 'g c', what: 'Content', where: 'the shell' },
      { keys: 'g d', what: 'Documents — the first declared record type', where: 'the shell' },
      { keys: 'g a', what: 'Assets', where: 'the shell' },
      { keys: 'g m', what: 'Model', where: 'the shell' },
      { keys: 'g r', what: 'Redirects', where: 'the shell' },
      { keys: 'g x', what: 'Access', where: 'the shell' },
      { keys: 'g s', what: 'Settings', where: 'the shell' },
    ],
  },
  {
    group: 'In a list or a tree',
    rows: [
      { keys: '↑ ↓', what: 'Move between rows', where: 'List' },
      { keys: '→ ←', what: 'Expand and collapse', where: 'List' },
      { keys: '⏎', what: 'Open the focused row', where: 'List' },
      { keys: 'Space', what: 'Select the focused row', where: 'List' },
      { keys: '⌥↑ ⌥↓', what: 'Reorder among siblings', where: 'Content' },
      { keys: '⌥← ⌥→', what: 'Change depth — reparent', where: 'Content' },
    ],
  },
  {
    group: 'In the editor',
    rows: [
      { keys: '⌘\\', what: 'Collapse the rail', where: 'the editor' },
      { keys: '⌘.', what: 'Collapse the inspector', where: 'the editor' },
      { keys: '⌘H', what: 'History', where: 'the editor' },
      { keys: '⌘⇧A', what: 'Add a block', where: 'the editor' },
      { keys: '⌘⏎', what: 'Focus mode for the field being edited', where: 'the editor' },
      { keys: '⌘Z  ⇧⌘Z', what: 'Undo and redo', where: 'the editor' },
      { keys: '⌘C  ⌘V', what: 'Copy and paste a block', where: 'the editor' },
    ],
  },
  {
    group: 'Anywhere there is an overlay',
    rows: [{ keys: 'Esc', what: 'Dismiss the topmost one', where: 'Dialog, Palette' }],
  },
]

export function Keys({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard"
      description="Every binding in the admin."
      size="wide"
      onClose={onClose}
    >
      <div className={css.groups}>
        {KEYS.map((group) => (
          <section className={css.group} key={group.group}>
            <h3 className={css.heading}>{group.group}</h3>
            {/*
              A description list, not a table. Each row is a term and its meaning
              rather than cells in a grid, and `dl` is the element that says so — a
              two-column `table` here would claim a relationship between the rows of
              one column that does not exist.
            */}
            <dl className={css.rows}>
              {group.rows.map((row) => (
                <div className={css.row} key={row.keys}>
                  <dt className={css.keys}>{row.keys}</dt>
                  <dd className={css.what}>{row.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
