import { type Blok, type Doc, type Json, keyAtIndex, newUid } from './doc'
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

/**
 * How a document type relates to the URL namespace (`document-types.md`
 * architecture decision 2) — the whole routing story, checked in exactly three
 * places: routing (`storyByPath`/`publishedDoc`), path derivation
 * (`derivePaths` skips unrouted rows) and the admin's tree. Everywhere else a
 * document is a document.
 *
 * | kind        | routable | in the page tree            | how many |
 * | ----------- | -------- | --------------------------- | -------- |
 * | `page`      | yes      | yes, with `parent_id`/`path`| many     |
 * | `record`    | no       | no (both columns null)      | many     |
 * | `singleton` | no       | no                          | one      |
 */
export type DocumentKind = 'page' | 'record' | 'singleton'

export interface DocumentType {
  name: string
  label: string
  kind: DocumentKind
  /** Block type used as this document's root. Also where its metadata lives. */
  root: string
  /**
   * Root field holding the display title, cached into `stories.title` on
   * publish. Defaults through `titleFieldOf`: `'title'` when the root block has
   * one, then the root block's `summary` field, then nothing.
   */
  titleField?: string
  /**
   * Only this type's documents may be created under — or dragged onto — a
   * document of these types. Absent means anywhere. Declaring it also means
   * this type can never sit at the top level, since the top level has no type
   * to match. `page` kinds only: nothing else is in the tree to be under
   * anything.
   */
  under?: readonly string[]
  /** The type a bare "New page" creates. Implicitly the first `page` type. */
  default?: boolean
}

export interface Manifest {
  /** Every declared document type, in declaration order. */
  types: DocumentType[]
  blocks: BlockSchema[]
  /**
   * @deprecated The default page type's root block. Kept for one release, for
   * hosts and tests reading `manifest.root` from before `types` existed.
   */
  root: string
}

export function indexManifest(manifest: Manifest): SchemaIndex {
  return Object.fromEntries(manifest.blocks.map((b) => [b.name, b]))
}

/**
 * A singleton's id is derived from its type rather than minted
 * (`document-types.md` architecture decision 4): `sng_settings` is unique for
 * free, so no `singleton boolean` column and no uniqueness constraint are
 * needed to stop a second one existing — there is simply no other id it could
 * be created under. Nothing parses a story id, everything compares it, so this
 * is as valid a Durable Object name as `newStoryId`'s output.
 */
export const SINGLETON_PREFIX = 'sng_'

export function singletonId(type: DocumentType | string): string {
  return `${SINGLETON_PREFIX}${typeof type === 'string' ? type : type.name}`
}

/** True for the one kind that lives in the page tree and owns a URL. */
export function isRouted(type: DocumentType | undefined): boolean {
  return type?.kind === 'page'
}

export function typeByName(
  types: readonly DocumentType[],
  name: string | undefined,
): DocumentType | undefined {
  return name === undefined ? undefined : types.find((t) => t.name === name)
}

/**
 * The type a bare "New page" creates: the one marked `default: true`, or the
 * first `page` type declared. `validateTypes` has already guaranteed there is
 * at least one, so this never returns undefined for a validated config.
 */
export function defaultType(types: readonly DocumentType[]): DocumentType {
  const marked = types.find((t) => t.default)
  const fallback = types.find((t) => t.kind === 'page')
  const chosen = marked ?? fallback
  if (!chosen) throw new Error('folio: no page document type is declared')
  return chosen
}

/**
 * True when a document of `type` may sit under a parent of `parentType`
 * (`undefined` meaning the top level) — `under`, which constrains drag targets
 * as well as creation, with a refusal rather than a silent no-op.
 */
export function canNest(type: DocumentType, parentType: DocumentType | undefined): boolean {
  if (!type.under) return true
  return parentType !== undefined && type.under.includes(parentType.name)
}

/**
 * Which root field holds the display title, per architecture decision 3: the
 * type's own `titleField`, then `'title'` if the root block declares one, then
 * the root block's `summary` field. Undefined when a root block offers none of
 * the three, which is what makes `titleOf` fall back to its literal.
 */
export function titleFieldOf(
  type: DocumentType | undefined,
  def: BlockSchema | undefined,
): string | undefined {
  if (type?.titleField) return type.titleField
  if (def && 'title' in def.fields) return 'title'
  return def?.summary
}

/**
 * What a document is called, for the tree cache, the version list and the
 * admin — one helper so all three agree. Replaces the hard-coded
 * `doc.bloks[doc.root]?.data.title` read that `publishStoryStatement` and
 * `versions.ts` each carried, which silently produced an empty title for any
 * root block without a `title` field.
 */
export function titleOf(
  doc: Doc,
  type: DocumentType | undefined,
  schema: SchemaIndex,
  fallback = 'Untitled',
): string {
  const root = doc.bloks[doc.root]
  if (!root) return fallback
  const def = schema[root.type]
  const field = titleFieldOf(type, def)
  if (!field) return fallback
  return fieldText(def, field, root.data).trim() || fallback
}

/**
 * One field's value as display text. Fields whose value is an object need
 * unwrapping, or a tree row fills up with "[object Object]".
 */
function fieldText(def: BlockSchema | undefined, name: string, data: Record<string, Json>): string {
  const value = data[name]
  if (value == null) return ''
  switch (def?.fields[name]?.kind) {
    case 'richtext':
      return richtextToText(asRichtext(value))
    case 'asset':
      return asAsset(value)?.filename ?? ''
    default:
      return typeof value === 'object' ? '' : String(value)
  }
}

export function summarise(schema: BlockSchema | undefined, data: Record<string, Json>): string {
  if (!schema?.summary) return ''
  return fieldText(schema, schema.summary, data).slice(0, 64)
}

/**
 * Construction-time checks for the `types` a host declared, alongside
 * `validatePresets` and `validateHooks`: a configuration mistake in a CMS
 * should throw once, before a request is served, rather than becoming a
 * runtime 500 on whichever code path reaches it first.
 */
export function validateTypes(types: readonly DocumentType[], schema: SchemaIndex): void {
  if (types.length === 0) throw new Error('folio: `types` is empty; declare at least one')

  const seen = new Set<string>()
  for (const type of types) {
    if (!type.name) throw new Error('folio: a document type has no `name`')
    if (seen.has(type.name)) throw new Error(`folio: duplicate document type '${type.name}'`)
    seen.add(type.name)

    const def = schema[type.root]
    if (!def) {
      throw new Error(
        `folio: document type '${type.name}' names root block '${type.root}', which is not in the registry`,
      )
    }
    if (type.titleField) {
      const field = def.fields[type.titleField]
      if (!field) {
        throw new Error(
          `folio: document type '${type.name}' names titleField '${type.titleField}', which '${type.root}' does not declare`,
        )
      }
      if (field.kind === 'blocks') {
        throw new Error(
          `folio: document type '${type.name}' names titleField '${type.titleField}', a blocks field`,
        )
      }
    }
    // `under` places a document in the tree, and only a `page` is ever in it.
    // Silently ignoring it on a record would leave a config key that reads as
    // a constraint and enforces nothing.
    if (type.under && type.kind !== 'page') {
      throw new Error(
        `folio: document type '${type.name}' is kind '${type.kind}' and cannot declare 'under' — only a page lives in the tree`,
      )
    }
  }

  if (!types.some((t) => t.kind === 'page')) {
    throw new Error("folio: at least one document type must be kind 'page'")
  }

  const defaults = types.filter((t) => t.default)
  if (defaults.length > 1) {
    throw new Error(
      `folio: more than one default document type (${defaults.map((t) => t.name).join(', ')})`,
    )
  }
  if (defaults[0] && defaults[0].kind !== 'page') {
    throw new Error(
      `folio: default document type '${defaults[0].name}' is kind '${defaults[0].kind}'; only a page can be the default`,
    )
  }

  for (const type of types) {
    for (const name of type.under ?? []) {
      if (!seen.has(name)) {
        throw new Error(`folio: document type '${type.name}' is 'under' unknown type '${name}'`)
      }
    }
  }
  // Every `under` chain has to reach a type that can sit at the top level, or
  // no document of that type could ever be created at all. Walks the config,
  // never a document — the same shape `validatePreset`'s cycle check has.
  for (const type of types) {
    if (!grounded(type, types, [])) {
      throw new Error(
        `folio: document type '${type.name}' can never be created: its 'under' chain never reaches a type with no 'under'`,
      )
    }
  }
}

function grounded(
  type: DocumentType,
  types: readonly DocumentType[],
  path: readonly string[],
): boolean {
  if (!type.under) return true
  if (path.includes(type.name)) return false
  const chain = [...path, type.name]
  return type.under.some((name) => {
    const parent = typeByName(types, name)
    return parent ? grounded(parent, types, chain) : false
  })
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
