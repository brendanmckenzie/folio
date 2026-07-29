import { Fragment, useState, type CSSProperties, type DragEvent } from 'react'
import { childrenOf, type Doc } from '../core/doc'
import type { Presence } from '../core/protocol'
import { slotsOf, summarise, type SchemaIndex } from '../core/schema'
import { useFolio } from './FolioContext'

interface Props {
  doc: Doc
  selection: string | null
  peers: Presence[]
  onSelect: (uid: string) => void
  onAdd: (parent: string, slot: string, type: string, index: number, preset?: string) => void
  onMove: (uid: string, parent: string, slot: string, index: number) => void
}

export function BlockTree(props: Props) {
  const { schema } = useFolio()
  const root = props.doc.bloks[props.doc.root]
  const rootDef = schema[root?.type ?? '']
  return (
    <nav className="tree">
      {/*
        The root block is selectable, which is how page metadata gets edited:
        title, description and so on are ordinary fields on it, so they inherit
        sync, undo and versioning instead of needing a separate save path.
      */}
      <div
        className={`tree__row tree__row--root ${props.selection === props.doc.root ? 'is-selected' : ''}`}
        onClick={() => props.onSelect(props.doc.root)}
      >
        <span className="tree__type">Page settings</span>
        <span className="tree__summary">{rootDef ? summarise(rootDef, root?.data ?? {}) : ''}</span>
      </div>
      {slotsOf(rootDef).map(([slot]) => (
        <Slot key={slot} {...props} parent={props.doc.root} slot={slot} depth={0} />
      ))}
    </nav>
  )
}

function Slot({
  parent,
  slot,
  depth,
  ...props
}: Props & { parent: string; slot: string; depth: number }) {
  const { schema } = useFolio()
  const { doc, selection, peers, onSelect, onAdd, onMove } = props
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const kids = childrenOf(doc, parent, slot)
  const field = schema[doc.bloks[parent]?.type ?? '']?.fields[slot]
  const allow = field?.kind === 'blocks' ? field.allow : []
  const full = field?.kind === 'blocks' && field.max !== undefined && kids.length >= field.max

  const over = (index: number) => (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('text/folio-uid')) return
    e.preventDefault()
    e.stopPropagation()
    setDropIndex(index)
  }
  const drop = (index: number) => (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropIndex(null)
    const uid = e.dataTransfer.getData('text/folio-uid')
    if (uid) onMove(uid, parent, slot, index)
  }

  return (
    <ul className="tree__slot" style={{ '--depth': depth } as CSSProperties}>
      <li
        className={`tree__gap ${dropIndex === 0 ? 'is-over' : ''}`}
        onDragOver={over(0)}
        onDragLeave={() => setDropIndex(null)}
        onDrop={drop(0)}
      />
      {kids.map((blok, i) => {
        const def = schema[blok.type]
        const watchers = peers.filter((p) => p.selection === blok.uid)

        return (
          <Fragment key={blok.uid}>
            <li>
              <div
                className={`tree__row ${selection === blok.uid ? 'is-selected' : ''}`}
                onClick={() => onSelect(blok.uid)}
              >
                {/* Handle only, so a click cannot turn into an accidental move. */}
                <span
                  className="tree__handle"
                  draggable
                  title="Drag to reorder or move"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/folio-uid', blok.uid)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                >
                  ⠿
                </span>
                <span className="tree__type">{def?.label ?? blok.type}</span>
                <span className="tree__summary">{summarise(def, blok.data)}</span>
                {watchers.map((p) => (
                  <span
                    key={p.actor}
                    className="tree__peer"
                    style={{ background: p.colour }}
                    title={p.name}
                  />
                ))}
              </div>

              {slotsOf(def).map(([childSlot]) => (
                <Slot
                  key={childSlot}
                  {...props}
                  parent={blok.uid}
                  slot={childSlot}
                  depth={depth + 1}
                />
              ))}
            </li>
            <li
              className={`tree__gap ${dropIndex === i + 1 ? 'is-over' : ''}`}
              onDragOver={over(i + 1)}
              onDragLeave={() => setDropIndex(null)}
              onDrop={drop(i + 1)}
            />
          </Fragment>
        )
      })}

      {allow.length > 0 && !full ? (
        <li className="tree__add">
          <AddMenu
            allow={allow}
            onPick={(type, preset) => onAdd(parent, slot, type, kids.length, preset)}
          />
        </li>
      ) : null}
    </ul>
  )
}

export interface MenuGroup {
  type: string
  label: string
  /** False for a `presetsOnly` block: no bare version to offer. */
  bare: boolean
  presets: { name: string; label: string }[]
}

/**
 * One group per allowed type, in declaration order (decision 5): the type's
 * label as a heading, the bare block first unless `presetsOnly` hides it,
 * then its presets nested beneath. Presets multiply entries on top of a menu
 * `ROADMAP.md` already flags as breaking around 15 types — grouping is the
 * minimum that keeps it legible; search, icons and categories stay on the
 * roadmap as their own work.
 *
 * Pure and exported so the grouping is tested directly, without mounting
 * `AddMenu`.
 */
export function menuGroups(schema: SchemaIndex, allow: readonly string[]): MenuGroup[] {
  return allow.map((type) => {
    const def = schema[type]
    return {
      type,
      label: def?.label ?? type,
      bare: !def?.presetsOnly,
      presets: (def?.presets ?? []).map((p) => ({ name: p.name, label: p.label })),
    }
  })
}

function AddMenu({
  allow,
  onPick,
}: {
  allow: readonly string[]
  onPick: (type: string, preset?: string) => void
}) {
  const { schema } = useFolio()
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" className="tree__addbtn" onClick={() => setOpen(true)}>
        + Add block
      </button>
    )
  }

  const pick = (type: string, preset?: string) => {
    onPick(type, preset)
    setOpen(false)
  }

  return (
    <div className="tree__menu" onMouseLeave={() => setOpen(false)}>
      {menuGroups(schema, allow).map((group) => (
        <div key={group.type} className="tree__menu-group">
          {/*
            The heading doubles as the bare block's own button — one entry,
            not a label plus a same-named button — except for a presetsOnly
            block, which has no bare version to pick.
          */}
          {group.bare ? (
            <button type="button" className="tree__menu-heading" onClick={() => pick(group.type)}>
              {group.label}
            </button>
          ) : (
            <p className="tree__menu-heading">{group.label}</p>
          )}
          {group.presets.map((preset) => (
            <button key={preset.name} type="button" onClick={() => pick(group.type, preset.name)}>
              {preset.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
