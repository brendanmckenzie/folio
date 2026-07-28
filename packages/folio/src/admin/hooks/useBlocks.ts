import { useCallback, useMemo } from 'react'
import { ancestorsOf, childrenOf, type Json, keyAtIndex } from '../../core/doc'
import { blankBlok, type SchemaIndex } from '../../core/schema'
import type { StoryStore } from '../store'

export interface Blocks {
  add: (parent: string, slot: string, type: string, index: number) => void
  /** Adds the first type the slot allows, for the preview's own add button. */
  addFirst: (parent: string, slot: string) => void
  move: (uid: string, parent: string, slot: string, index: number) => void
  remove: (uid: string) => void
  /**
   * Writes a field on `uid`. The block is named by the caller and never read
   * from the selection: a write can be started and land much later.
   */
  setField: (uid: string, field: string, value: Json) => void
}

/**
 * The document mutations the editor's chrome issues. Every one is a transaction
 * on the store, so all of them inherit sync, undo and versioning; none of them
 * has a save path of its own.
 */
export function useBlocks(store: StoryStore, schema: SchemaIndex): Blocks {
  const keyAt = useCallback(
    (parent: string, slot: string, index: number, ignore?: string) => {
      const doc = store.getSnapshot().doc
      if (!doc) return keyAtIndex([], 0)
      const sibs = childrenOf(doc, parent, slot).filter((b) => b.uid !== ignore)
      return keyAtIndex(
        sibs.map((b) => b.order),
        index,
      )
    },
    [store],
  )

  const add = useCallback(
    (parent: string, slot: string, type: string, index: number) => {
      const blok = blankBlok(schema, type, parent, slot, keyAt(parent, slot, index))
      store.tx([{ t: 'insert', blok }])
      store.select(blok.uid)
    },
    [keyAt, schema, store],
  )

  const addFirst = useCallback(
    (parent: string, slot: string) => {
      const field = schema[store.getSnapshot().doc?.bloks[parent]?.type ?? '']?.fields[slot]
      const first = field?.kind === 'blocks' ? field.allow[0] : undefined
      if (first) add(parent, slot, first, 0)
    },
    [add, schema, store],
  )

  const move = useCallback(
    (uid: string, parent: string, slot: string, index: number) => {
      const doc = store.getSnapshot().doc
      if (!doc) return
      // Same rule and the same primitive the server-side guard uses: `ancestorsOf`
      // terminates on a cyclic document, a hand-rolled walk up `parent` does not.
      if (parent === uid || ancestorsOf(doc, parent).includes(uid)) return
      const field = schema[doc.bloks[parent]?.type ?? '']?.fields[slot]
      if (field?.kind !== 'blocks' || !field.allow.includes(doc.bloks[uid]?.type ?? '')) return
      store.tx([{ t: 'move', uid, parent, slot, order: keyAt(parent, slot, index, uid) }])
    },
    [keyAt, schema, store],
  )

  const remove = useCallback(
    (uid: string) => {
      store.tx([{ t: 'remove', uid }])
      store.select(null)
    },
    [store],
  )

  /**
   * The target is a parameter, not `store.getSnapshot().selection`, because an
   * asset field's write is issued when its upload *finishes*: reading the
   * selection here would land the value on whatever block is selected by then,
   * which is any block the user clicked while the upload was in flight. The
   * inspector passes the uid of the block whose field it is drawing, so the
   * target is fixed when the input renders — a write to a block that has since
   * been deleted is a no-op in `applyAll`, not a write to its replacement.
   */
  const setField = useCallback(
    (uid: string, field: string, value: Json) => {
      store.tx([{ t: 'set', uid, field, value }])
    },
    [store],
  )

  return useMemo(
    () => ({ add, addFirst, move, remove, setField }),
    [add, addFirst, move, remove, setField],
  )
}
