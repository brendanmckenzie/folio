import type { CSSProperties, KeyboardEvent } from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { Doc } from '../../../core/doc'
import type { LocaleContext } from '../../../core/locales'
import type { Presence } from '../../../core/protocol'
import type { SchemaIndex } from '../../../core/schema'
import { menuGroups } from '../../BlockTree'
import { Button } from '../Button'
import { List, Row } from '../List'
import { Menu, type MenuItem } from '../Menu'
import css from './BlockRail.module.css'
import {
  type AddTarget,
  addTargetOf,
  type BlockGesture,
  type BlockMove,
  blockGesture,
  type RailAddRow,
  type RailBlokRow,
  type RailRootRow,
  railRows,
} from './editor-model'

interface Props {
  /** What is on screen: the live draft, or the version being viewed. Null while
   * the store bootstraps. */
  doc: Doc | null
  schema: SchemaIndex
  localeCtx: LocaleContext | undefined
  selection: string | null
  /** Per-story presence. One dot per block whoever has focus in it — the tree's
   * grain is the block, and the per-field ring lives in the inspector. */
  peers: readonly Presence[]
  /** Viewing a past version, or a role that may not edit: every control that
   * would write is absent rather than disabled. */
  readOnly: boolean
  onSelect: (uid: string) => void
  onAdd: (parent: string, slot: string, type: string, index: number, preset?: string) => void
  onMove: (move: BlockMove) => void
  onDuplicate: (uid: string) => void
  onCopy: (uid: string) => void
  onNotice: (message: string) => void
  /**
   * Port phase 7c's seam. Present, and `+ Add` opens the searchable picker instead
   * of the grouped menu below — same slot, same `onAdd`, a different affordance in
   * front of it. Absent keeps the menu, which is what makes the rail complete on
   * its own rather than waiting on another phase.
   */
  onRequestAdd?: (target: AddTarget) => void
  /** `⌘\`, and the `«` in the header. Held above this component so the shortcut
   * and the button drive the same value. */
  onCollapse: () => void
}

/** Six placeholder rows while the document is in flight. Named rather than
 * indexed, matching Content's and Documents'. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * Which gesture an ⌥-arrow means. A table rather than a nested ternary, for the
 * reason `Content.tsx` gives: four two-word branches read as four rules.
 */
const GESTURES: Record<string, BlockGesture | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'out',
  ArrowRight: 'in',
}

/**
 * The block tree, and **nothing else** — seven rail tabs become zero
 * (`ui-architecture.md` decision 4): history is a slide-over, and redirects, the
 * content model and access are screens of their own.
 *
 * This is `BlockTree.tsx` ported. Its logic was right and is reused where it is
 * already pure (`menuGroups`); what changed is everything around it, and three of
 * those are fixes rather than restyling:
 *
 * 1. **It is a real tree with a real keyboard.** The old rail was nested `<ul>`s
 *    of `<div onClick>` with no roles, which is why it could not be reached from
 *    the keyboard at all and why Biome's a11y rules were off for the admin. Rows
 *    are `List`/`Row` now: one tab stop, roving tabindex, `↑ ↓` to traverse,
 *    `→ ←` to expand and collapse, `⌥` arrows to reorder and reparent — the same
 *    model the Content screen got in port phase 2, over bloks instead of stories.
 * 2. **Drag-and-drop is gone, and reorder is better for it.** The old rail moved
 *    blocks by dragging a handle onto a 4px gap element between rows; a drop that
 *    landed a pixel wrong did nothing, and no keyboard could do it at all. The
 *    replacement is `⌥↑ ⌥↓ ⌥← ⌥→` plus a `↑`/`↓` pair in each row's actions, both
 *    going through `blockGesture` — so a refusal ("Already last in this slot", "A
 *    Hero has no slot that accepts a Button") is a *sentence* rather than a
 *    gesture that quietly fails. This follows Content, which dropped `StoryTree`'s
 *    drag for exactly this reason.
 * 3. **Add rows name their slot** when a block has more than one. Two identical
 *    `+ Add block` buttons in a row was the old behaviour.
 *
 * The picker behind `+ Add` is still `menuGroups` in a `Menu`. Port phase 7c
 * replaces it with `Palette` — a searchable, grouped, described picker — and that
 * is a second mount of an existing primitive, not a second implementation: it
 * needs exactly the `onAdd` this already calls.
 */
export function BlockRail(props: Props) {
  const { doc, schema, localeCtx, selection, readOnly, onNotice, onMove } = props
  /**
   * Which blocks have their children hidden.
   *
   * **Collapsed**, not expanded, so a document nobody has touched is fully open.
   * `Content`'s tree is the other way round because a site is wide and each level
   * costs a request; a block tree is shallow and already in memory, so hiding it
   * by default would be hiding the thing the rail exists to show.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const rows = useMemo(
    () => (doc ? railRows(doc, schema, collapsed, localeCtx) : []),
    [doc, schema, collapsed, localeCtx],
  )

  /**
   * The rows `List` counts, which is not all of them: an add row is a `<div>` with
   * a button in it and carries no `data-row`, so it is skipped by the roving
   * tabindex and its trigger is its own tab stop. Same shape as Content's
   * `MoreRow`, and the reason the two lists are indexed against a filtered array
   * rather than the rendered one.
   */
  const focusable = useMemo(
    () => rows.filter((row): row is RailRootRow | RailBlokRow => row.kind !== 'add'),
    [rows],
  )

  const toggle = useCallback((uid: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(uid)) next.add(uid)
      return next
    })
  }, [])

  const gesture = useCallback(
    (which: BlockGesture, at: RailBlokRow) => {
      if (!doc) return
      const outcome = blockGesture(which, at, rows, doc, schema)
      if ('refusal' in outcome) {
        onNotice(outcome.refusal)
        return
      }
      onMove(outcome.move)
    },
    [doc, rows, schema, onNotice, onMove],
  )

  /**
   * `→ ←` and the four `⌥` gestures, for whichever row has focus.
   *
   * Reached through `List`'s `onUnhandledKey` rather than a handler on a wrapper
   * div: the list already knows which row is focused and what index it is, so it
   * hands both over. `↑ ↓ Home End` never arrive here — those are `List`'s.
   */
  const onRowKey = (
    e: KeyboardEvent<HTMLDivElement>,
    index: number,
    focus: (i: number) => void,
  ) => {
    const at = focusable[index]
    if (!at) return

    if (e.altKey) {
      const which = GESTURES[e.key]
      // An ⌥ chord that is not one of the four is the browser's, so it keeps its
      // default — which is why the guard is before `preventDefault` and not after.
      if (!which) return
      e.preventDefault()
      // Read-only for either reason (a past version on screen, a role that may not
      // edit): the row's own ↑ ↓ controls are absent too, so silence here is
      // consistent rather than a swallowed gesture.
      if (readOnly) return
      // The root block *is* the document: it has no siblings to move among and no
      // parent to move out of, and saying so beats a gesture that looks broken.
      if (at.kind === 'root') {
        onNotice('The document itself cannot be moved')
        return
      }
      gesture(which, at)
      return
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const open = at.kind === 'blok' && at.expandable && at.expanded
    if (e.key === 'ArrowRight') {
      // → on a closed parent opens it; on an open one it steps to the first child,
      // which is the row physically below. Leaving that to ↓ would mean → doing
      // nothing at all on an already-open node.
      if (at.kind === 'blok' && at.expandable && !at.expanded) toggle(at.uid)
      else focus(index + 1)
      return
    }
    // ← collapses an open node, and steps out to the parent otherwise.
    if (open) toggle(at.uid)
    else if (at.kind === 'blok') focus(focusable.findIndex((row) => row.uid === at.parent))
  }

  return (
    <aside className={css.rail} aria-label="Blocks">
      <div className={css.head}>
        <span className={css.title}>Blocks</span>
        <Button size="sm" variant="subtle" onClick={props.onCollapse} title="Hide the rail (⌘\)">
          «
        </Button>
      </div>

      {doc === null ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : (
        <div className={css.body}>
          <List label="Blocks" tree onUnhandledKey={onRowKey}>
            {rows.map((row) =>
              row.kind === 'add' ? (
                readOnly ? null : (
                  <AddRow
                    key={`add:${row.parent}:${row.slot}`}
                    row={row}
                    schema={schema}
                    onAdd={props.onAdd}
                    {...(props.onRequestAdd && doc
                      ? { onRequest: () => props.onRequestAdd?.(addTargetOf(row, doc)) }
                      : {})}
                  />
                )
              ) : (
                <BlockRow
                  key={row.uid}
                  row={row}
                  current={selection === row.uid}
                  peers={props.peers}
                  readOnly={readOnly}
                  onSelect={props.onSelect}
                  onToggle={toggle}
                  onGesture={gesture}
                  onDuplicate={props.onDuplicate}
                  onCopy={props.onCopy}
                />
              ),
            )}
          </List>
        </div>
      )}
    </aside>
  )
}

/* ------------------------------------------------------------------- a row --- */

function BlockRow({
  row,
  current,
  peers,
  readOnly,
  onSelect,
  onToggle,
  onGesture,
  onDuplicate,
  onCopy,
}: {
  row: RailRootRow | RailBlokRow
  current: boolean
  peers: readonly Presence[]
  readOnly: boolean
  onSelect: (uid: string) => void
  onToggle: (uid: string) => void
  onGesture: (which: BlockGesture, at: RailBlokRow) => void
  onDuplicate: (uid: string) => void
  onCopy: (uid: string) => void
}) {
  const watchers = peers.filter((peer) => peer.selection?.uid === row.uid)
  const blok = row.kind === 'blok' ? row : null
  const expandable = blok?.expandable ?? false

  return (
    <Row
      tree
      depth={row.depth}
      {...(expandable && blok ? { expanded: blok.expanded } : {})}
      current={current}
      onOpen={() => onSelect(row.uid)}
      meta={row.summary}
      handle={
        expandable && blok ? (
          <button
            type="button"
            className={css.twisty}
            data-open={blok.expanded ? '' : undefined}
            aria-label={`${blok.expanded ? 'Collapse' : 'Expand'} ${blok.label}`}
            // No `aria-expanded` here: the treeitem around it already carries it,
            // and two elements announcing the same state is one of them lying as
            // soon as they disagree.
            onClick={(e) => {
              e.stopPropagation()
              onToggle(row.uid)
            }}
          >
            ›
          </button>
        ) : (
          // A leaf still owes the column its width, or every leaf label sits 16px
          // left of its siblings' and the indent stops reading as depth.
          <span className={css.twistySpacer} />
        )
      }
      trailing={
        watchers.length > 0 ? (
          <span className={css.peers}>
            {watchers.map((peer) => (
              <span
                key={peer.actor}
                className={css.peer}
                style={{ background: peer.colour }}
                title={peer.locale ? `${peer.name} (${peer.locale})` : peer.name}
              />
            ))}
          </span>
        ) : null
      }
      actions={
        blok && !readOnly ? (
          <span className={css.actions}>
            {/*
              The mouse's half of reorder, and the reason drag is not missed: two
              buttons that name what they do and refuse with a sentence, against a
              drop target that was 4px tall and silent. Both call the same
              `blockGesture` the ⌥ arrows do.
            */}
            <Glyph label={`Move ${blok.label} up`} onClick={() => onGesture('up', blok)}>
              ↑
            </Glyph>
            <Glyph label={`Move ${blok.label} down`} onClick={() => onGesture('down', blok)}>
              ↓
            </Glyph>
            <Glyph
              label={`Duplicate ${blok.label}`}
              disabled={blok.full}
              reason={
                blok.max === 1
                  ? 'This slot holds one block'
                  : `This slot holds at most ${blok.max} blocks`
              }
              onClick={() => onDuplicate(blok.uid)}
            >
              ⧉
            </Glyph>
            <Glyph label={`Copy ${blok.label}`} onClick={() => onCopy(blok.uid)}>
              ⎘
            </Glyph>
          </span>
        ) : null
      }
    >
      <span className={css.label}>{row.label}</span>
    </Row>
  )
}

/** A row action: one glyph, one accessible name, and a refusal that explains
 * itself. `Button`'s `reason` is only read while `disabled`, so passing both is
 * safe and is what keeps a greyed control from being a mystery. */
function Glyph({
  label,
  disabled,
  reason,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  reason?: string
  onClick: () => void
  children: string
}) {
  return (
    <Button
      size="sm"
      variant="subtle"
      aria-label={label}
      title={label}
      {...(disabled ? { disabled: true, ...(reason ? { reason } : {}) } : {})}
      onClick={(e) => {
        // The row's own click selects the block. An action inside it must not do
        // both.
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </Button>
  )
}

/* ------------------------------------------------------------------ adding --- */

/**
 * One slot's `+ Add`.
 *
 * A plain `<div>` with a control in it rather than a `Row`, deliberately: it is
 * not an item in the tree, it carries no `data-row`, and `List`'s roving tabindex
 * therefore skips it while its trigger stays an ordinary tab stop. `Content`'s
 * `MoreRow` is the same shape for the same reason.
 */
function AddRow({
  row,
  schema,
  onAdd,
  onRequest,
}: {
  row: RailAddRow
  schema: SchemaIndex
  onAdd: (parent: string, slot: string, type: string, index: number, preset?: string) => void
  /** Opens the picker instead of the menu. See `Props.onRequestAdd`. */
  onRequest?: () => void
}) {
  const label = row.slotLabel ? `+ ${row.slotLabel}` : '+ Add block'

  if (onRequest) {
    return (
      <div className={css.addRow} style={{ '--depth': row.depth } as CSSProperties}>
        <span className={css.addIndent} />
        <Button size="sm" variant="subtle" onClick={onRequest}>
          {label}
        </Button>
      </div>
    )
  }

  const items: MenuItem[] = menuGroups(schema, row.allow).flatMap((group) => [
    ...(group.bare
      ? [
          {
            id: group.type,
            label: group.label,
            run: () => onAdd(row.parent, row.slot, group.type, row.index),
          },
        ]
      : []),
    ...group.presets.map((preset) => ({
      id: `${group.type}:${preset.name}`,
      label: preset.label,
      run: () => onAdd(row.parent, row.slot, group.type, row.index, preset.name),
    })),
  ])

  return (
    <div className={css.addRow} style={{ '--depth': row.depth } as CSSProperties}>
      <span className={css.addIndent} />
      <Menu align="start" trigger={label} items={items} />
    </div>
  )
}
