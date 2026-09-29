/**
 * Layered globals (`../../docs/specs/foundation/multi-site.md` decision 8): the
 * merge that turns a chain of layer documents into the one a site reads, and the
 * labels an editor sees over the top layer.
 *
 * A global has one document per scope (`layerId`), and a site reads the chain's
 * layers merged **per field**, most general first. The rule for each field of a
 * layer's root block, and of any `max: 1` child merged into the one below it:
 *
 * | In the more specific layer | Result |
 * | --- | --- |
 * | key absent from `data` and, for a `blocks` field, no children in the slot | inherited |
 * | `null` in `data` | removed |
 * | a `max: 1` blocks field whose child has the inherited child's type | merged recursively |
 * | a `max: 1` blocks field whose child has a different type | replaced by that child |
 * | a many-blocks field with children | replaces the inherited children |
 * | any other value | replaced |
 *
 * **Field values are never merged structurally.** A link merged over a link is a
 * value nobody wrote; a value is inherited whole or replaced whole.
 *
 * **`i18n` keeps its meaning.** An absent key inherits the layer below for that
 * locale; `null` still means *untranslated*, so the field falls back to the
 * merged source value — it never means removed. *Removed* exists only for source
 * `data`, because a translation of a field that has no value has nothing to
 * translate.
 *
 * Pure and core: nothing here reads D1 or a Durable Object, so the admin's
 * inherited / overridden / removed labels and the server's render come from one
 * answer.
 */
import { type Blok, compareSiblings, type Doc, type Json } from './doc'
import { type SchemaIndex, slotsOf } from './schema'
import { SHARED_SCOPE, singletonTypeOf } from './sites'

/** `parent` → `slot` → children in order, built once per document. */
type Kids = Map<string, Map<string, Blok[]>>

const indexes = new WeakMap<Doc, Kids>()

function kidsIndex(doc: Doc): Kids {
  const cached = indexes.get(doc)
  if (cached) return cached
  const out: Kids = new Map()
  for (const blok of Object.values(doc.bloks)) {
    if (blok.parent === null || blok.slot === null) continue
    const slots = out.get(blok.parent) ?? new Map<string, Blok[]>()
    const list = slots.get(blok.slot) ?? []
    list.push(blok)
    slots.set(blok.slot, list)
    out.set(blok.parent, slots)
  }
  for (const slots of out.values()) {
    for (const list of slots.values()) {
      list.sort((a, b) => compareSiblings(a.order, a.uid, b.order, b.uid))
    }
  }
  indexes.set(doc, out)
  return out
}

const childrenIn = (doc: Doc, parent: string, slot: string): Blok[] =>
  kidsIndex(doc).get(parent)?.get(slot) ?? []

/** Every slot name a blok has, from the schema or from the children it holds. */
function slotNamesOf(
  schema: SchemaIndex,
  type: string,
  ...held: { doc: Doc; uid: string }[]
): string[] {
  const names = new Set(slotsOf(schema[type]).map(([name]) => name))
  for (const { doc, uid } of held) {
    for (const name of kidsIndex(doc).get(uid)?.keys() ?? []) names.add(name)
  }
  return [...names]
}

/** `max: 1`: the slot holds one child, and layers merge into it rather than replace it. */
const isSingle = (schema: SchemaIndex, type: string, slot: string): boolean => {
  const field = schema[type]?.fields[slot]
  return field?.kind === 'blocks' && field.max === 1
}

/**
 * The layers a site reads, merged into one document, or `undefined` when none of
 * them exists.
 *
 * `layers` are most general first (`shared`, then a group, then the site) and an
 * entry is `undefined` for a scope whose layer has never been written — which
 * reads as every field inherited.
 *
 * **A chain of one is returned as it is**, the same object. That is the single-site
 * case and the whole of "byte-identical with no `sites`": nothing is copied,
 * normalised or stripped. A longer chain is always rebuilt, so a `null` in the
 * lowest existing layer reads as no value rather than as a stored `null`.
 */
export function mergeLayers(
  layers: readonly (Doc | undefined)[],
  schema: SchemaIndex,
): Doc | undefined {
  if (layers.length === 1) return layers[0]
  let acc: Doc | undefined
  for (const layer of layers) {
    if (layer) acc = mergeTwo(acc, layer, schema)
  }
  return acc
}

function mergeTwo(base: Doc | undefined, top: Doc, schema: SchemaIndex): Doc | undefined {
  const topRoot = top.bloks[top.root]
  if (!topRoot) return base
  const baseRoot = base?.bloks[base.root]
  const out: Record<string, Blok> = {}
  mergeBlok(
    out,
    schema,
    // A root of another type is not the same document; the more specific wins whole.
    base && baseRoot && baseRoot.type === topRoot.type ? { doc: base, blok: baseRoot } : undefined,
    { doc: top, blok: topRoot },
    { parent: null, slot: null, order: topRoot.order },
  )
  return { root: topRoot.uid, bloks: out }
}

interface Side {
  doc: Doc
  blok: Blok
}

interface Place {
  parent: string | null
  slot: string | null
  order: string
}

function mergeBlok(
  out: Record<string, Blok>,
  schema: SchemaIndex,
  base: Side | undefined,
  top: Side,
  at: Place,
): void {
  const uid = top.blok.uid
  const slots = slotNamesOf(
    schema,
    top.blok.type,
    { doc: top.doc, uid },
    ...(base ? [{ doc: base.doc, uid: base.blok.uid }] : []),
  )
  const isSlot = new Set(slots)

  const data: Record<string, Json> = { ...base?.blok.data }
  const removed = new Set<string>()
  for (const [name, value] of Object.entries(top.blok.data)) {
    if (isSlot.has(name)) continue
    if (value === null) {
      delete data[name]
      removed.add(name)
    } else {
      data[name] = value
    }
  }
  // A slot never has a stored value; a key under its name is drift, and the
  // children are the truth (`toNested` reads it the same way).
  for (const name of slots) delete data[name]

  const i18n = mergedI18n(base?.blok.i18n, top.blok.i18n, removed)

  out[uid] = {
    uid,
    type: top.blok.type,
    parent: at.parent,
    slot: at.slot,
    order: at.order,
    data,
    ...(i18n ? { i18n } : {}),
  }

  for (const slot of slots) {
    // `null` under a slot's name is the layer saying "no children here at all".
    if (top.blok.data[slot] === null) continue
    const mine = childrenIn(top.doc, uid, slot)
    const inherited = base ? childrenIn(base.doc, base.blok.uid, slot) : []
    if (mine.length === 0) {
      for (const kid of inherited) adopt(out, base!.doc, kid, uid)
    } else if (
      isSingle(schema, top.blok.type, slot) &&
      inherited[0] &&
      inherited[0].type === mine[0]!.type
    ) {
      mergeBlok(
        out,
        schema,
        { doc: base!.doc, blok: inherited[0] },
        { doc: top.doc, blok: mine[0]! },
        { parent: uid, slot, order: mine[0]!.order },
      )
    } else {
      for (const kid of mine) adopt(out, top.doc, kid, uid)
    }
  }
}

/**
 * Two layers' translations, layered per locale and per field. A key in the more
 * specific layer wins whatever it holds — `null` included, which is how a site
 * says a locale is untranslated even though the layer below translated it — and
 * a key it does not have inherits. The translations of a field the more specific
 * layer *removed* from `data` are dropped with it.
 */
function mergedI18n(
  below: Blok['i18n'],
  above: Blok['i18n'],
  removed: ReadonlySet<string>,
): Blok['i18n'] {
  if (!below && !above) return undefined
  const out: Record<string, Record<string, Json>> = {}
  for (const [locale, map] of Object.entries(below ?? {})) {
    const kept = Object.fromEntries(Object.entries(map).filter(([field]) => !removed.has(field)))
    if (Object.keys(kept).length > 0) out[locale] = kept
  }
  for (const [locale, map] of Object.entries(above ?? {})) {
    if (Object.keys(map).length > 0) out[locale] = { ...out[locale], ...map }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** `kid` and everything under it, into `out`, under `parent`. */
function adopt(out: Record<string, Blok>, doc: Doc, kid: Blok, parent: string): void {
  out[kid.uid] = { ...kid, parent }
  for (const list of kidsIndex(doc).get(kid.uid)?.values() ?? []) {
    for (const child of list) adopt(out, doc, child, kid.uid)
  }
}

/* ------------------------------------------------------------ the labels --- */

/**
 * What the top layer says about one field, for the editor's label (decision 8):
 * *Inherited from Shared*, *Overridden here*, *Removed here*.
 *
 * `from` is the scope the state comes from. For `overridden` and `removed` it is
 * the top layer's own scope. For `inherited` it is the nearest lower scope that
 * says anything about the field (a removal below counts, so a field a group
 * removed reads *inherited from* that group), or `null` when nothing below does.
 */
export type LayerState = { state: 'inherited' | 'overridden' | 'removed'; from: string | null }

interface Entry {
  doc: Doc
  blok: Blok
  scope: string
}

/**
 * The state of every field of the last layer's root block, keyed by field name.
 *
 * `layers` and `scopes` are parallel and most general first, as for `mergeLayers`.
 * A layer that does not exist reads as every field inherited. A `max: 1` blocks
 * field the layer overrides with a child that merges into the inherited one also
 * reports that child's fields, keyed `slot.field` — *Override* on such a field
 * writes an empty child precisely so those stay inherited one by one.
 */
export function layerStates(
  layers: readonly (Doc | undefined)[],
  scopes: readonly string[],
  schema: SchemaIndex,
): Record<string, LayerState> {
  const entries: (Entry | undefined)[] = layers.map((doc, i) => {
    const blok = doc?.bloks[doc.root]
    return doc && blok ? { doc, blok, scope: scopes[i]! } : undefined
  })
  const type = [...entries].reverse().find((e) => e)?.blok.type
  const out: Record<string, LayerState> = {}
  if (!type) return out
  const same = entries.map((e) => (e && e.blok.type === type ? e : undefined))
  statesOf(out, schema, type, same, scopes, '')
  return out
}

/** Whether `entry` has said anything about `name`: a value, a removal, or children. */
function speaks(entry: Entry | undefined, name: string, isBlocks: boolean): boolean {
  if (!entry) return false
  if (isBlocks) {
    return entry.blok.data[name] === null || childrenIn(entry.doc, entry.blok.uid, name).length > 0
  }
  return name in entry.blok.data
}

function statesOf(
  out: Record<string, LayerState>,
  schema: SchemaIndex,
  type: string,
  entries: readonly (Entry | undefined)[],
  scopes: readonly string[],
  prefix: string,
): void {
  const last = entries.length - 1
  const top = entries[last]
  for (const [name, field] of Object.entries(schema[type]?.fields ?? {})) {
    const isBlocks = field.kind === 'blocks'
    const key = `${prefix}${name}`
    if (top && speaks(top, name, isBlocks)) {
      if (top.blok.data[name] === null) {
        out[key] = { state: 'removed', from: scopes[last]! }
        continue
      }
      out[key] = { state: 'overridden', from: scopes[last]! }
      if (isBlocks && field.max === 1) {
        // The child continues the inherited one for as long as the layers below
        // keep giving a child of its type; a removal or another type starts it over.
        const child = childrenIn(top.doc, top.blok.uid, name)[0]!
        const chain: Entry[] = [{ doc: top.doc, blok: child, scope: scopes[last]! }]
        const chainScopes: string[] = [scopes[last]!]
        for (let i = last - 1; i >= 0; i--) {
          const e = entries[i]
          if (!speaks(e, name, true)) continue
          if (e!.blok.data[name] === null) break
          const below = childrenIn(e!.doc, e!.blok.uid, name)[0]
          if (!below || below.type !== child.type) break
          chain.unshift({ doc: e!.doc, blok: below, scope: e!.scope })
          chainScopes.unshift(e!.scope)
        }
        statesOf(out, schema, child.type, chain, chainScopes, `${key}.`)
      }
      continue
    }
    let from: string | null = null
    for (let i = last - 1; i >= 0; i--) {
      if (speaks(entries[i], name, isBlocks)) {
        from = scopes[i]!
        break
      }
    }
    out[key] = { state: 'inherited', from }
  }
}

/* ---------------------------------------------------------------- seeding --- */

/**
 * Whether a story id is a layer that starts **bare** on a multi-site deployment:
 * a singleton layer of any scope but `shared`.
 *
 * This is `layerSeed(registry, scope)` (`sites.ts`) answered without a registry,
 * for the callers that have a story id and no snapshot to hand: every scope in a
 * registry has `shared` below it except `shared` itself, so the two agree for
 * every scope that can own a row. It is false for anything that is not a
 * singleton layer, and callers must not ask on a deployment with no `sites`,
 * where nothing layers and every singleton seeds as it always did.
 */
export function isBareLayer(id: string): boolean {
  const layer = singletonTypeOf(id)
  return layer !== null && layer.scope !== SHARED_SCOPE
}
