import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import css from './Palette.module.css'
import { highlight, nextIndex, rank, type Rankable } from './rank'

export interface PaletteAction extends Rankable {
  id: string
  /** The heading it appears under. Grouping is by first appearance, so the
   * declaration order of the action list decides the order of the groups. */
  group: string
  /** Right-aligned: a path for a document, a shortcut for a command. */
  hint?: string
  run: () => void
}

interface Props {
  actions: readonly PaletteAction[]
  onClose: () => void
}

/**
 * ⌘K. The single highest-leverage thing missing from the admin today: with a
 * palette, the tree's 50-row level cap, the flat unsearchable block picker and
 * the media library's absent search all stop being navigation problems.
 *
 * Actions are the same `MenuItem`-shaped data a `Menu` takes, deliberately: an
 * action is declared once and appears in a menu, here, and behind a shortcut
 * without being written three times.
 *
 * The ranking is `rank.ts`, which is pure and unit tested in Node — the admin's
 * whole test suite works that way and this rebuild keeps it that way.
 */
export function Palette({ actions, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => rank(query, actions), [actions, query])

  // Clamped rather than reset: typing a character that shortens the list should
  // leave the selection on something, and resetting to 0 on every keystroke
  // fights anyone arrowing down while still typing.
  const index = Math.min(active, Math.max(results.length - 1, 0))

  // biome-ignore lint/correctness/useExhaustiveDependencies: index is the trigger, not a value the body reads — the DOM is queried for whichever row now carries data-active
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (i: number) => {
    const hit = results[i]
    if (!hit) return
    onClose()
    hit.item.run()
  }

  // Groups in first-appearance order, so the action list's own ordering carries
  // through instead of being sorted alphabetically behind the author's back.
  const groups: {
    name: string
    rows: { at: number; action: PaletteAction; spans: readonly [number, number][] }[]
  }[] = []
  for (const [at, { item, match }] of results.entries()) {
    const group = groups.find((g) => g.name === item.group) ?? { name: item.group, rows: [] }
    if (!groups.includes(group)) groups.push(group)
    group.rows.push({ at, action: item, spans: match.spans })
  }

  return createPortal(
    <div className={css.wrap}>
      <button
        type="button"
        className={css.scrim}
        tabIndex={-1}
        aria-label="Close"
        onClick={onClose}
      />
      <div className={css.panel} role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          // The one place a focus-on-mount is right, and it is done with a ref
          // callback rather than `autoFocus` for the reason the dialog comment
          // gives: React applies autoFocus during commit, before a focus trap can
          // read who opened the thing.
          ref={(el) => el?.focus()}
          className={css.input}
          type="text"
          placeholder="Search pages, documents and commands…"
          aria-label="Search pages, documents and commands"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose()
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              run(index)
              return
            }
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
              <div key={group.name} className={css.group}>
                <p className={css.groupName}>{group.name}</p>
                {group.rows.map(({ at, action, spans }) => (
                  <button
                    key={action.id}
                    type="button"
                    data-active={at === index}
                    className={`${css.row} ${at === index ? css.rowActive : ''}`}
                    onMouseMove={() => setActive(at)}
                    onClick={() => run(at)}
                  >
                    <span className={css.label}>
                      {highlight(action.label, spans).map((part, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by nature
                        <span key={i} className={part.hit ? css.hit : undefined}>
                          {part.text}
                        </span>
                      ))}
                    </span>
                    {action.hint ? <span className={css.hint}>{action.hint}</span> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/*
 * There is deliberately no `usePaletteShortcut` here. `⌘K` is one entry in the
 * shell's shortcut map (`ui/shortcuts.ts`), not a hook this component owns —
 * otherwise the second shortcut gets its own hook too, and the admin is back to
 * four bindings with no single place that knows about them.
 */
