import { type Blok, type Json, keyAtIndex, newUid } from './doc'
import { defaultValue, type Field } from './fields'
import { asRichtext, richtextToText } from './richtext'
import { asAsset } from './values'

/**
 * A named bundle of field values (and optionally children), the second of the
 * three scales `field-defaults-and-presets.md` unifies: a per-field `default`,
 * a `preset`, and — a preset with `name: 'default'` on the document's root
 * block — a starting document. Declarative data, not a function: it reaches
 * the admin through the manifest, the same constraint `showIf` was forced by.
 */
export interface BlockPreset {
  /** Unique within the block. 'default' is used for a document's starting content. */
  name: string
  label: string
  /** Partial field values, layered over the field defaults, layered over the kind defaults. */
  data?: Record<string, Json>
  /** Recursive: each names a slot, a type, and optionally another block's own preset. */
  children?: readonly { slot: string; type: string; preset?: string }[]
}

/**
 * The serializable half of a block definition. This is everything the admin UI
 * needs, which is why the admin can ship prebuilt and learn about a project's
 * blocks over HTTP instead of at build time.
 */
export interface BlockSchema {
  name: string
  label: string
  /** Field name whose value labels this block in the tree. */
  summary?: string
  fields: Record<string, Field>
  presets?: readonly BlockPreset[]
  /** Hides the bare block from the add menu; only its presets are offered there. */
  presetsOnly?: boolean
}

export type SchemaIndex = Record<string, BlockSchema>

export interface Manifest {
  /** Block type used as the document root. */
  root: string
  blocks: BlockSchema[]
}

export function indexManifest(manifest: Manifest): SchemaIndex {
  return Object.fromEntries(manifest.blocks.map((b) => [b.name, b]))
}

export function summarise(schema: BlockSchema | undefined, data: Record<string, Json>): string {
  if (!schema?.summary) return ''
  const value = data[schema.summary]
  if (value == null) return ''

  // Fields whose value is an object need unwrapping, or the block tree fills up
  // with "[object Object]".
  switch (schema.fields[schema.summary]?.kind) {
    case 'richtext':
      return richtextToText(asRichtext(value)).slice(0, 64)
    case 'asset':
      return asAsset(value)?.filename.slice(0, 64) ?? ''
    default:
      return typeof value === 'object' ? '' : String(value).slice(0, 64)
  }
}

/**
 * A node in a subtree recipe, before any uid or fractional order exists.
 *
 * `key` links a child's `parent` to another entry in the same array — it is
 * local to one `allocateSubtree` call and never reaches the resulting `Blok`,
 * which gets a real uid instead. Exactly one entry has `parent: null`: the
 * subtree's root, which attaches to `allocateSubtree`'s own
 * `parent`/`slot`/`order` arguments rather than to another entry here.
 */
export interface SubtreeBlok {
  key: string
  type: string
  data: Record<string, Json>
  parent: string | null
  slot: string | null
}

/**
 * Turns a subtree recipe into real `Blok`s: a fresh uid throughout, and a
 * fresh fractional order per (parent, slot) group, allocated in the recipe's
 * own array order via `keyAtIndex` against an empty sibling list — every slot
 * here is brand new, so there is nothing existing to collide with.
 *
 * Returns parents before children, so the array can be sent as one
 * transaction (`store.tx(bloks.map((blok) => ({ t: 'insert', blok })))`) and
 * `diff.ts`'s insert rule — a child never lands on a missing parent — is
 * satisfied for free.
 *
 * Deliberately schema-agnostic: it knows nothing about field kinds, defaults
 * or presets, only about wiring a tree of (type, data) pairs to real ids and
 * orders. `blankSubtree` below is the schema-aware caller, building its recipe
 * from a preset; `duplicate-and-paste.md` is the other caller, building its
 * recipe from an existing document's subtree instead. Whichever spec lands
 * first builds this, the other uses it as-is.
 */
export function allocateSubtree(
  bloks: readonly SubtreeBlok[],
  parent: string | null,
  slot: string | null,
  order: string,
): Blok[] {
  const root = bloks.find((b) => b.parent === null)
  if (!root) throw new Error('allocateSubtree: recipe has no root (an entry with parent: null)')

  const uids = new Map(bloks.map((b) => [b.key, newUid()]))
  const childrenOfKey = new Map<string, SubtreeBlok[]>()
  for (const b of bloks) {
    if (b.parent === null) continue
    const list = childrenOfKey.get(b.parent) ?? []
    list.push(b)
    childrenOfKey.set(b.parent, list)
  }

  const out: Blok[] = []
  const place = (
    node: SubtreeBlok,
    realParent: string | null,
    realSlot: string | null,
    realOrder: string,
  ) => {
    const uid = uids.get(node.key)!
    out.push({
      uid,
      type: node.type,
      parent: realParent,
      slot: realSlot,
      order: realOrder,
      data: node.data,
    })

    // Group by slot so siblings within the same slot get sequential orders;
    // unrelated slots on the same new parent do not share a sequence.
    const bySlot = new Map<string, SubtreeBlok[]>()
    for (const child of childrenOfKey.get(node.key) ?? []) {
      const list = bySlot.get(child.slot ?? '') ?? []
      list.push(child)
      bySlot.set(child.slot ?? '', list)
    }
    for (const [childSlot, kids] of bySlot) {
      let keys: string[] = []
      for (const kid of kids) {
        const kidOrder = keyAtIndex(keys, keys.length)
        keys = [...keys, kidOrder]
        place(kid, uid, childSlot, kidOrder)
      }
    }
  }

  place(root, parent, slot, order)
  return out
}

/**
 * Resolves one block type, and optionally one of its presets, into a subtree
 * recipe. Three layers, evaluated in this order, in this one place: the
 * kind's own zero value, then the field's own `default`, then the preset's
 * `data`. Recurses into the preset's `children`, each becoming its own nested
 * recipe rooted at the parent's local key.
 */
function subtreeRecipe(
  schema: SchemaIndex,
  type: string,
  preset: string | undefined,
): SubtreeBlok[] {
  const def = schema[type]
  if (!def) throw new Error(`Unknown block type: ${type}`)

  const presetDef = preset ? def.presets?.find((p) => p.name === preset) : undefined
  if (preset && !presetDef) throw new Error(`Unknown preset '${preset}' on block '${type}'`)

  const data: Record<string, Json> = {}
  for (const [name, field] of Object.entries(def.fields)) {
    // Creation only, deliberately: `field.default` is consulted here and only
    // here (plus the preset override below). `resolveValue` never learns about
    // it (decision 4) — this is one of the two call sites that comment names.
    if (field.kind !== 'blocks') data[name] = field.default ?? defaultValue(field)
  }
  if (presetDef?.data) Object.assign(data, presetDef.data)

  const key = newUid()
  const out: SubtreeBlok[] = [{ key, type, data, parent: null, slot: null }]

  for (const child of presetDef?.children ?? []) {
    const [childRoot, ...rest] = subtreeRecipe(schema, child.type, child.preset)
    out.push({ ...childRoot!, parent: key, slot: child.slot }, ...rest)
  }

  return out
}

/**
 * The single creation point for a block and, when `preset` names one with
 * `children`, everything under it — a starting document is just this called
 * with the root type and a preset named `'default'` (`server/runtime.ts`'s
 * `seed`). Schema-aware: layers kind defaults, field defaults and the
 * preset's own values (see `subtreeRecipe`), then hands the recipe to
 * `allocateSubtree` for uid and order allocation.
 */
export function blankSubtree(
  schema: SchemaIndex,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
  preset?: string,
): Blok[] {
  return allocateSubtree(subtreeRecipe(schema, type, preset), parent, slot, order)
}

/**
 * `blankSubtree` with no preset, unwrapped to the single blok it always
 * produces in that case — so a caller that never needs children (most of
 * them) does not have to deal with an array.
 */
export function blankBlok(
  schema: SchemaIndex,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
): Blok {
  return blankSubtree(schema, type, parent, slot, order)[0]!
}

const MAX_PRESET_DEPTH = 5

/**
 * Construction-time checks for every block's `presets`: an unknown type, an
 * unknown slot, a type a slot's `allow` forbids, a field the block does not
 * declare, a slot's `max` exceeded, a `presetsOnly` block with no presets, and
 * a preset chain that cycles or nests deeper than `MAX_PRESET_DEPTH`.
 *
 * Called once, from `createRuntime`, before any request is served — the same
 * point a config-shape mistake should surface, not three requests later as a
 * runtime throw from `blankSubtree`.
 *
 * Cycle detection walks `(type, preset)` pairs down the *schema* (a preset
 * chain), never touching a document — the same shape as `ancestorsOf`'s
 * visited set, applied to config instead of data.
 */
export function validatePresets(schema: SchemaIndex): void {
  for (const def of Object.values(schema)) {
    if (def.presetsOnly && !(def.presets && def.presets.length > 0)) {
      throw new Error(`Block '${def.name}' is presetsOnly but declares no presets`)
    }
    for (const preset of def.presets ?? []) {
      validatePreset(schema, def, preset, [])
    }
  }
}

function validatePreset(
  schema: SchemaIndex,
  def: BlockSchema,
  preset: BlockPreset,
  path: readonly string[],
): void {
  const here = `${def.name}/${preset.name}`
  if (path.includes(here)) {
    throw new Error(`Preset cycle: ${[...path, here].join(' -> ')}`)
  }
  const chain = [...path, here]
  if (chain.length > MAX_PRESET_DEPTH) {
    throw new Error(
      `Preset '${preset.name}' on '${def.name}' nests past depth ${MAX_PRESET_DEPTH}: ${chain.join(' -> ')}`,
    )
  }

  for (const field of Object.keys(preset.data ?? {})) {
    const f = def.fields[field]
    if (!f) {
      throw new Error(`Preset '${preset.name}' on '${def.name}' sets unknown field '${field}'`)
    }
    if (f.kind === 'blocks') {
      throw new Error(
        `Preset '${preset.name}' on '${def.name}' sets '${field}', a blocks field — put it in 'children' instead`,
      )
    }
  }

  const perSlot = new Map<string, number>()
  for (const child of preset.children ?? []) {
    const slotField = def.fields[child.slot]
    if (slotField?.kind !== 'blocks') {
      throw new Error(`Preset '${preset.name}' on '${def.name}' names unknown slot '${child.slot}'`)
    }
    const childDef = schema[child.type]
    if (!childDef) {
      throw new Error(
        `Preset '${preset.name}' on '${def.name}' names unknown block type '${child.type}'`,
      )
    }
    if (!slotField.allow.includes(child.type)) {
      throw new Error(
        `Preset '${preset.name}' on '${def.name}': slot '${child.slot}' does not allow '${child.type}'`,
      )
    }
    const count = (perSlot.get(child.slot) ?? 0) + 1
    perSlot.set(child.slot, count)
    if (slotField.max !== undefined && count > slotField.max) {
      throw new Error(
        `Preset '${preset.name}' on '${def.name}': slot '${child.slot}' allows at most ${slotField.max}, the preset supplies more`,
      )
    }
    if (child.preset) {
      const childPreset = childDef.presets?.find((p) => p.name === child.preset)
      if (!childPreset) {
        throw new Error(
          `Preset '${preset.name}' on '${def.name}' names unknown preset '${child.preset}' on '${child.type}'`,
        )
      }
      validatePreset(schema, childDef, childPreset, chain)
    }
  }
}

/** Slots (blocks-kind fields) declared by a block type. */
export function slotsOf(
  schema: BlockSchema | undefined,
): [string, Extract<Field, { kind: 'blocks' }>][] {
  if (!schema) return []
  return Object.entries(schema.fields).filter(
    (entry): entry is [string, Extract<Field, { kind: 'blocks' }>] => entry[1].kind === 'blocks',
  )
}
