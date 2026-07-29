import { useCallback, useMemo } from 'react'
import { ancestorsOf, childrenOf, type Json, keyAtIndex } from '../../core/doc'
import type { Mutation } from '../../core/mutations'
import { blankSubtree, type SchemaIndex } from '../../core/schema'
import type { StoryStore } from '../store'

/**
 * What one `add` call issues: every blok a type (or its preset's whole
 * subtree) produces, as insert mutations in the same parents-before-children
 * order `blankSubtree` returns them in, plus which uid a caller should select
 * afterwards — always the top one, an added block's usual behaviour.
 *
 * Pure and exported so "a preset with children lands as one transaction" is
 * tested directly against the mutation list, without mounting the hook.
 */
export function subtreeInsert(
  schema: SchemaIndex,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
  preset?: string,
): { mutations: Mutation[]; selected: string } {
  const bloks = blankSubtree(schema, type, parent, slot, order, preset)
  return {
    mutations: bloks.map((blok) => ({ t: 'insert', blok })),
    selected: bloks[0]!.uid,
  }
}

export interface Blocks {
  /**
   * Inserts `type` (or, when `preset` is given, that preset's whole subtree —
   * field-defaults-and-presets.md) as one transaction: one undo step, one
   * delta, one activity entry, however many bloks it produces.
   */
  add: (parent: string, slot: string, type: string, index: number, preset?: string) => void
  /**
   * Adds the first type the slot allows, for the preview's own add button —
   * that type's own `'default'` preset if it declares one, a bare block
   * otherwise.
   */
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
    (parent: string, slot: string, type: string, index: number, preset?: string) => {
      const { mutations, selected } = subtreeInsert(
        schema,
        type,
        parent,
        slot,
        keyAt(parent, slot, index),
        preset,
      )
      store.tx(mutations)
      store.select(selected)
    },
    [keyAt, schema, store],
  )

  const addFirst = useCallback(
    (parent: string, slot: string) => {
      const field = schema[store.getSnapshot().doc?.bloks[parent]?.type ?? '']?.fields[slot]
      const first = field?.kind === 'blocks' ? field.allow[0] : undefined
      if (!first) return
      const preset = schema[first]?.presets?.some((p) => p.name === 'default')
        ? 'default'
        : undefined
      add(parent, slot, first, 0, preset)
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
