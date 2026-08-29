import { type Blok, childrenOf, type Doc } from './doc'
import { allocateSubtree, type SubtreeBlok } from './schema'

/**
 * `uid`'s own subtree, turned into an `allocateSubtree` recipe: every blok keeps
 * its *old* uid as the recipe's local `key` (already unique within the
 * document, so it needs no fresh one just to be unique within this call),
 * `parent` renamed from `null` to the old parent uid it actually has — except
 * `uid` itself, whose `parent`/`slot` become `null`, the two fields
 * `allocateSubtree` expects of a recipe's one root.
 *
 * Walked via `childrenOf`, not a raw `Object.values(doc.bloks)` scan (`subtree`
 * in doc.ts is parents-before-children too, but in whatever order the
 * document's bloks happen to be keyed in): a duplicated section's children
 * must keep their relative order, and `childrenOf` is the function that
 * already sorts siblings correctly.
 *
 * `visited` bounds the walk the same way `subtree` bounds itself: a document
 * written before `move`'s cycle guard existed can still contain one, and a
 * clone of it must terminate rather than recurse forever.
 */
function subtreeRecipe(doc: Doc, uid: string): SubtreeBlok[] {
  const out: SubtreeBlok[] = []
  const visited = new Set<string>()

  const walk = (id: string, parent: string | null, slot: string | null) => {
    if (visited.has(id)) return
    visited.add(id)
    const b = doc.bloks[id]
    if (!b) return
    // `i18n` is a sibling of `data` on `Blok`, not a key inside it
    // (`localisation.md` decision 1), so it has to be named here: a recipe
    // carrying only `data` would let duplicate, paste and "duplicate this
    // document" each silently drop every translation. This is the debt that spec
    // deferred to localisation.
    out.push({
      key: id,
      type: b.type,
      data: b.data,
      parent,
      slot,
      ...(b.i18n ? { i18n: b.i18n } : {}),
    })

    const slots = new Set<string>()
    for (const child of Object.values(doc.bloks)) {
      if (child.parent === id && child.slot !== null) slots.add(child.slot)
    }
    for (const slotName of slots) {
      for (const kid of childrenOf(doc, id, slotName)) walk(kid.uid, id, slotName)
    }
  }

  walk(uid, null, null)
  return out
}

/**
 * A fresh copy of `uid` and its whole subtree, placed at `target`: every uid
 * re-allocated (`allocateSubtree`), every `parent` rewritten to point inside
 * the copy, structure and sibling order otherwise identical. Field values —
 * asset keys, story ids, richtext (including its link marks), the `i18n` map —
 * are carried verbatim: nothing inside a field value names a uid this copy
 * needs to rewrite, so there is nothing to walk.
 *
 * The one primitive `duplicate`, `paste` and "duplicate a document" all share
 * (`duplicate-and-paste.md`'s architecture decision 1): the difference between
 * them is only what recipe feeds it and where the result lands.
 */
export function cloneSubtree(
  doc: Doc,
  uid: string,
  target: { parent: string; slot: string; order: string },
): Blok[] {
  return allocateSubtree(subtreeRecipe(doc, uid), target.parent, target.slot, target.order)
}

/**
 * A fresh copy of a whole document: same root type, every uid re-allocated,
 * every other blok's structure and field values unchanged. `parent`/`slot`
 * are `null` for the top blok, exactly as a document root's are everywhere
 * else in this codebase (`server/runtime.ts`'s `seed`, the DO's own stored
 * doc) — `cloneSubtree`'s narrower `target` type is for placing a subtree
 * *inside* an existing document, which a whole-document clone is not doing.
 *
 * `field-defaults-and-presets.md`'s `blankSubtree` is the sibling of this at
 * creation time; this is the one at duplication time. Neither commits
 * anything — see `duplicateStory` (server/stories.ts) for what seeds the
 * result into a new story.
 */
export function cloneDoc(doc: Doc): Doc {
  const bloks = allocateSubtree(subtreeRecipe(doc, doc.root), null, null, 'a0')
  const root = bloks[0]!
  return { root: root.uid, bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
}
