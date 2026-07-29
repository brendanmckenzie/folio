import { useCallback, useMemo } from 'react'
import type { ClipboardPayload } from '../../core/clipboard'
import { parseClipboard } from '../../core/clipboard'
import { cloneSubtree } from '../../core/clone'
import {
  ancestorsOf,
  type Blok,
  childrenOf,
  type Doc,
  type Json,
  keyAtIndex,
  subtree,
} from '../../core/doc'
import type { Mutation } from '../../core/mutations'
import { blankSubtree, type SchemaIndex, slotsOf } from '../../core/schema'
import type { StoryStore } from '../store'
import type { Notify } from './useNotice'

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

/** "this slot holds one block" / "this slot holds at most N blocks" — the
 * exact wording duplicate-and-paste.md's edge cases name for `max: 1`,
 * generalised for any other cap. Shared by `duplicateInsert` and
 * `pasteInsert` so the two refusals read identically. */
export function fullSlotMessage(max: number): string {
  return max === 1 ? 'this slot holds one block' : `this slot holds at most ${max} blocks`
}

/**
 * What one `duplicate(uid)` call issues: `uid`'s whole subtree, fresh uids
 * throughout (`cloneSubtree`), inserted immediately after the original in the
 * same slot — or an error naming why not: the document root cannot duplicate
 * itself (it *is* the document), and a full slot is refused the same way the
 * add menu already refuses one (architecture decision 2).
 *
 * Pure and exported so "one transaction, placed right after the original" is
 * tested directly against the mutation list, without mounting the hook.
 */
export function duplicateInsert(
  doc: Doc,
  schema: SchemaIndex,
  uid: string,
): { mutations: Mutation[]; selected: string } | { error: string } {
  if (uid === doc.root) return { error: 'The page itself cannot be duplicated.' }
  const blok = doc.bloks[uid]
  if (!blok || blok.parent === null || blok.slot === null) return { error: 'Unknown block.' }

  const siblings = childrenOf(doc, blok.parent, blok.slot)
  const field = schema[doc.bloks[blok.parent]?.type ?? '']?.fields[blok.slot]
  if (field?.kind === 'blocks' && field.max !== undefined && siblings.length >= field.max) {
    return { error: fullSlotMessage(field.max) }
  }

  const index = siblings.findIndex((b) => b.uid === uid) + 1
  const order = keyAtIndex(
    siblings.map((b) => b.order),
    index,
  )
  const bloks = cloneSubtree(doc, uid, { parent: blok.parent, slot: blok.slot, order })
  return { mutations: bloks.map((b) => ({ t: 'insert', blok: b })), selected: bloks[0]!.uid }
}

/**
 * Where a validated clipboard payload lands (architecture decision 3): the
 * current selection's own slot, immediately after it; the root's first slot
 * whose `allow` permits the top blok's type, when the root itself is
 * selected; refused, naming the block and the slot, when nothing accepts it,
 * the slot is already full, or nothing is selected at all.
 *
 * Pure, taking the clipboard's already-validated bloks (`parseClipboard`'s
 * success case) plus the doc/schema/selection the hook already holds, so
 * every refusal path is tested directly against the return value.
 */
export function pasteInsert(
  doc: Doc,
  schema: SchemaIndex,
  selection: string | null,
  bloks: readonly Blok[],
): { mutations: Mutation[]; selected: string } | { error: string } {
  const NOTHING_SELECTED = 'Select a block to paste after.'
  if (!selection) return { error: NOTHING_SELECTED }
  const target = doc.bloks[selection]
  if (!target) return { error: NOTHING_SELECTED }

  const top = bloks[0]!
  let parent: string
  let slot: string
  if (selection === doc.root) {
    const found = slotsOf(schema[target.type]).find(([, f]) => f.allow.includes(top.type))
    if (!found) return { error: `No slot on this page accepts a '${top.type}'.` }
    parent = doc.root
    slot = found[0]
  } else {
    if (target.parent === null || target.slot === null) return { error: NOTHING_SELECTED }
    parent = target.parent
    slot = target.slot
  }

  const field = schema[doc.bloks[parent]?.type ?? '']?.fields[slot]
  if (field?.kind !== 'blocks' || !field.allow.includes(top.type)) {
    return { error: `'${top.type}' is not allowed in this slot ('${slot}').` }
  }
  const siblings = childrenOf(doc, parent, slot)
  if (field.max !== undefined && siblings.length >= field.max) {
    return { error: fullSlotMessage(field.max) }
  }

  const index =
    selection === doc.root ? siblings.length : siblings.findIndex((b) => b.uid === selection) + 1
  const order = keyAtIndex(
    siblings.map((b) => b.order),
    index,
  )

  // The clipboard's own bloks, wired into a throwaway `Doc` so `cloneSubtree`
  // can re-allocate their uids exactly as it would for a subtree already
  // living in the real document: paste is a duplicate whose source is the
  // clipboard instead of `doc`.
  const scratch: Doc = { root: top.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
  const fresh = cloneSubtree(scratch, top.uid, { parent, slot, order })
  return { mutations: fresh.map((b) => ({ t: 'insert', blok: b })), selected: fresh[0]!.uid }
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
  /** Clones `uid`'s whole subtree with fresh uids, immediately after the
   * original in the same slot, as one transaction (duplicate-and-paste.md). */
  duplicate: (uid: string) => void
  /** Serialises `uid`'s whole subtree to the system clipboard, self-describing
   * so a later paste — on this page or another — can validate it first. */
  copy: (uid: string) => Promise<void>
  /** Parses `text` (from the browser's own `paste` event) as a Folio clipboard
   * payload and, if it validates against the current selection's slot, inserts
   * it as one transaction immediately after the selection. */
  paste: (text: string) => void
}

/**
 * The document mutations the editor's chrome issues. Every one is a transaction
 * on the store, so all of them inherit sync, undo and versioning; none of them
 * has a save path of its own.
 */
export function useBlocks(
  store: StoryStore,
  schema: SchemaIndex,
  notify: Notify,
  storyPath: string,
): Blocks {
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

  const duplicate = useCallback(
    (uid: string) => {
      const doc = store.getSnapshot().doc
      if (!doc) return
      const result = duplicateInsert(doc, schema, uid)
      if ('error' in result) {
        notify(result.error)
        return
      }
      if (store.tx(result.mutations)) store.select(result.selected)
    },
    [notify, schema, store],
  )

  const copy = useCallback(
    async (uid: string) => {
      const doc = store.getSnapshot().doc
      if (!doc) return
      const bloks = subtree(doc, uid).map((id) => doc.bloks[id]!)
      const payload: ClipboardPayload = {
        folio: 1,
        bloks,
        from: { storyId: store.storyId, path: storyPath },
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload))
      } catch {
        notify('Could not write to the clipboard.')
      }
    },
    [notify, store, storyPath],
  )

  const paste = useCallback(
    (text: string) => {
      const doc = store.getSnapshot().doc
      if (!doc) return
      const parsed = parseClipboard(text, schema)
      if ('error' in parsed) {
        notify(parsed.error)
        return
      }
      const result = pasteInsert(doc, schema, store.getSnapshot().selection, parsed.bloks)
      if ('error' in result) {
        notify(result.error)
        return
      }
      if (store.tx(result.mutations)) store.select(result.selected)
    },
    [notify, schema, store],
  )

  return useMemo(
    () => ({ add, addFirst, move, remove, setField, duplicate, copy, paste }),
    [add, addFirst, move, remove, setField, duplicate, copy, paste],
  )
}
