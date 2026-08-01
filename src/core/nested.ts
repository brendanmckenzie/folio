/**
 * The nested document shape the Content API speaks, and the two functions that
 * convert between it and the stored graph
 * (`../../../docs/specs/platform/content-api.md` architecture decision 3).
 *
 * A stored document is normalised: a flat map of bloks keyed by uid, each holding
 * its own `parent`, `slot` and a fractional `order` string. That is the right
 * shape for a mutation log — every edit touches one entry, and two people
 * reordering concurrently never conflict — and the wrong shape to ask somebody's
 * import script to construct. So the API speaks trees:
 *
 * ```json
 * { "uid": "9f3c…", "type": "page",
 *   "fields": { "title": "About us",
 *               "body": [ { "uid": "1a2b…", "type": "hero",
 *                           "fields": { "heading": "Hello" } } ] } }
 * ```
 *
 * `blocks` fields become arrays in `fields`, so the shape mirrors what a block
 * author sees in `render` rather than the storage graph, and nobody outside this
 * file has to know that fractional indexing exists.
 *
 * Two properties carry the whole design:
 *
 *   - **uids round-trip.** A `uid` is optional on the way in: present means "this
 *     blok, updated in place", absent means "a new one, place it between its
 *     neighbours". So a read-modify-write preserves identity, which is what keeps
 *     version diffs minimal, presence attached to the right block and undo
 *     granular. A shape without uids would make every write a wholesale replace.
 *   - **order is positional.** `fromNested` keeps every existing sibling key it
 *     can (the longest strictly-increasing run of them) and mints keys only for
 *     the gaps, so moving two items in a list of fifty writes two moves rather
 *     than fifty.
 *
 * Core, not server: nothing here touches D1, Hono or the Durable Object, and the
 * validation refusals are plain values a route turns into an envelope. `NestedError`
 * exists because `FolioError` is a server type and core cannot import it;
 * `server/errors.ts`'s `rethrow` translates one into the other.
 */
import { type Blok, type Doc, type Json, keysBetween, newUid, subtree } from './doc'
import { defaultValue, type Field } from './fields'
import { dataOf } from './locales'
import type { LocaleContext } from './locales'
import { type BlockSchema, type SchemaIndex, slotsOf } from './schema'

/** A `blocks` field's value is an array of nested bloks; everything else is JSON. */
export type NestedValue = Json | readonly NestedBlok[]

/**
 * One block as a tree node. `uid` and `type` are always present on the way *out*;
 * on the way in both may be omitted — an absent `uid` means a new blok, an absent
 * `type` inherits the one already stored under that uid.
 */
export interface NestedBlok {
  uid: string
  type: string
  fields: Record<string, NestedValue>
  /**
   * Per-locale field overrides, exactly as stored (`localisation.md`): `i18n` is
   * a sibling of `data` on `Blok`, not a key inside it, so it is a sibling of
   * `fields` here too rather than being folded into it. Absent when the blok has
   * no translations, and **omitted entirely** from a locale-resolved read, where
   * `fields` already holds the resolved values.
   */
  i18n?: Record<string, Record<string, Json>>
}

/** A whole document is its root block, nested. */
export type NestedDoc = NestedBlok

/**
 * The same tree on the way **in**, with everything a caller may leave out left
 * out: no `uid` (mint one), no `type` (inherit the stored one), no `fields` at
 * all (a node that only reorders its siblings).
 *
 * A separate type from `NestedBlok` rather than making that one's keys optional,
 * because the guarantees differ in the two directions and a reader should not
 * have to check for a `uid` on something `toNested` produced. Every `NestedBlok`
 * is a valid `NestedInput`, which is what makes read-modify-write typecheck.
 *
 * `fromNested` takes `unknown` regardless — it is validating a payload off the
 * wire, and a type is not a check — so this is documentation and TypeScript
 * comfort for a host writing an import script, not a parsing contract.
 */
export interface NestedInput {
  uid?: string
  type?: string
  fields?: Record<string, Json | readonly NestedInput[]>
  i18n?: Record<string, Record<string, Json>>
}

/**
 * Why a payload was refused, and where.
 *
 * A value with a path rather than a thrown `FolioError`, because this file is
 * core and `FolioError` is server. `rethrow` maps it to `bad_request` at the route
 * boundary, so a caller sees `body[0].fields.headng is not a field of 'hero'` in
 * the ordinary error envelope.
 *
 * Naming what was refused is the point (decision 3): silently dropping an unknown
 * field is how an import appears to succeed and loses a third of its content.
 */
export class NestedError extends Error {
  /** Dotted path into the payload, e.g. `body[0].fields.heading`. `''` is the root. */
  readonly path: string

  constructor(path: string, detail: string) {
    super(path ? `${path} ${detail}` : detail)
    this.name = 'NestedError'
    this.path = path
  }
}

/**
 * Ceiling on how deep a payload may nest. Nothing an editor can build comes near
 * it; an untrusted payload could otherwise exhaust the stack before any cap that
 * counts bloks had a chance to refuse it.
 */
export const MAX_NESTED_DEPTH = 100

/** Ceiling on how many nodes one payload may carry, matching the document cap. */
export const MAX_NESTED_NODES = 20_000

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * A uid arriving from outside. Nothing parses a uid and everything compares it
 * (see `newUid`), so this bounds and screens rather than matching the 16-hex mint
 * format: uids written at 8 characters are still valid, and an importer that
 * wants to carry its source system's ids should be able to.
 */
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A locale code arriving from outside — the same charset a config declares. */
const LOCALE_RE = /^[A-Za-z0-9_-]{1,32}$/

/* ------------------------------------------------------------ to nested --- */

export interface ToNestedOptions {
  /**
   * Read every field in this locale, through `fieldValue`'s fallback chain, and
   * omit `i18n` from the result. The **reading** shape: what a French mobile app
   * wants, and deliberately not round-trippable — writing it back would put
   * French into the source locale's `data`. Absent gives the authoring shape:
   * source values in `fields`, translations alongside in `i18n`.
   */
  locale?: LocaleContext
}

/** `parent` → `slot` → children, sorted, built once for a whole walk. */
type ChildIndex = Map<string, Map<string, Blok[]>>

function childIndex(doc: Doc): ChildIndex {
  const out: ChildIndex = new Map()
  for (const blok of Object.values(doc.bloks)) {
    // Only the root has no parent and no slot; anything else without them is an
    // orphan no tree walk can reach, and is left out rather than guessed at.
    if (blok.parent === null || blok.slot === null) continue
    const slots = out.get(blok.parent) ?? new Map<string, Blok[]>()
    const list = slots.get(blok.slot) ?? []
    list.push(blok)
    slots.set(blok.slot, list)
    out.set(blok.parent, slots)
  }
  for (const slots of out.values()) {
    for (const list of slots.values()) {
      list.sort((a, b) => (a.order === b.order ? cmp(a.uid, b.uid) : cmp(a.order, b.order)))
    }
  }
  return out
}

const cmp = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1)

/**
 * The stored document as a tree.
 *
 * Slots are taken from the document's own children rather than only from the
 * schema, so a slot whose field has since been removed from the code still reads
 * — the same reasoning as the spec's "a read of a document whose type was removed
 * from the config is returned as-is": refusing to read content because code
 * changed is worse than reporting it. Declared slots with no children read as
 * `[]`, so a consumer sees the shape rather than having to know it.
 */
export function toNested(doc: Doc, schema: SchemaIndex, opts?: ToNestedOptions): NestedDoc {
  const root = doc.bloks[doc.root]
  if (!root) throw new NestedError('', 'the document has no root block')
  return nestOne(root, schema, childIndex(doc), opts, new Set(), 0, '')
}

function nestOne(
  blok: Blok,
  schema: SchemaIndex,
  children: ChildIndex,
  opts: ToNestedOptions | undefined,
  visited: Set<string>,
  depth: number,
  path: string,
): NestedBlok {
  if (depth > MAX_NESTED_DEPTH) {
    throw new NestedError(path, `nests deeper than ${MAX_NESTED_DEPTH} levels`)
  }
  // A log written before `apply` refused cycles can still contain one, so the
  // walk is made total the same way `subtree` is.
  visited.add(blok.uid)

  const def = schema[blok.type]
  const slots = new Set(slotsOf(def).map(([name]) => name))
  const bySlot = children.get(blok.uid)

  const fields: Record<string, NestedValue> = {}
  // `dataOf` returns `blok.data` itself when there is nothing to layer, so the
  // single-locale read allocates nothing.
  const data = opts?.locale ? dataOf(blok, opts.locale) : blok.data
  for (const [name, value] of Object.entries(data)) {
    // A `blocks` field never has a stored value (`blankSubtree` skips it), so a
    // key colliding with a slot name is drift, and the slot is the truth.
    if (slots.has(name)) continue
    fields[name] = value
  }
  for (const name of new Set([...slots, ...(bySlot?.keys() ?? [])])) {
    fields[name] = (bySlot?.get(name) ?? [])
      .filter((child) => !visited.has(child.uid))
      .map((child, i) =>
        nestOne(child, schema, children, opts, visited, depth + 1, childPath(path, name, i)),
      )
  }

  return {
    uid: blok.uid,
    type: blok.type,
    fields,
    // Omitted, not written as undefined, so a blok with no translations
    // serialises byte-identically to one from before locales existed. Omitted in
    // locale mode too: `fields` already holds the resolved values.
    ...(blok.i18n && !opts?.locale ? { i18n: blok.i18n } : {}),
  }
}

const childPath = (parent: string, slot: string, index: number): string =>
  parent ? `${parent}.${slot}[${index}]` : `${slot}[${index}]`

const fieldPath = (parent: string, name: string): string =>
  parent ? `${parent}.fields.${name}` : `fields.${name}`

/* ---------------------------------------------------------- from nested --- */

export interface FromNestedOptions {
  /**
   * **`'merge'` (the default, the spec's resolved open question).** A key absent
   * from `fields` leaves the stored value alone; an absent `i18n` leaves
   * translations alone; an absent slot leaves that slot's children alone. So a
   * partial payload is safe, and "update one price on 400 products" does not
   * require reading and resending each whole document.
   *
   * A slot key that *is* present is authoritative for that slot, which is how a
   * block is removed through `PUT` at all. `PATCH /fields` is the narrower tool
   * for a pure field write.
   *
   * `'replace'` makes `fields` the whole content: an absent scalar is cleared, an
   * absent slot's children are removed, and an absent `i18n` is refused on any
   * blok that actually has translations to lose — see `translationsAtRisk`.
   */
  mode?: 'merge' | 'replace'
}

/**
 * A nested payload as a stored document, validated against the schema.
 *
 * `base` is the document this write is against. It is what makes uids mean
 * "update in place", what supplies the values a merge leaves alone, and what
 * sibling order keys are kept from. Without it this builds a document from
 * scratch: every uid the payload does not supply is minted and every order is
 * fresh.
 *
 * The result is meant to be handed to `diff(base, target)` and committed, so it
 * carries `base.root` as its own root: `diff` refuses two documents with
 * different roots, and a document's root block is created once and never
 * replaced.
 *
 * Refuses, naming the path, rather than dropping: an unknown block type, a block
 * a slot's `allow` forbids, a slot over its `max`, an unknown field name, a value
 * of the wrong JSON shape, a duplicate uid, and a replace that would destroy
 * translations it was not told about.
 */
export function fromNested(
  input: unknown,
  schema: SchemaIndex,
  base?: Doc,
  opts?: FromNestedOptions,
): Doc {
  const mode = opts?.mode ?? 'merge'
  const ctx: BuildContext = {
    schema,
    base,
    mode,
    out: {},
    claimed: new Set(),
    carries: [],
    nodes: 0,
  }

  const node = requireNode(input, '')
  const baseRoot = base ? base.bloks[base.root] : undefined
  if (base && node.uid !== undefined && node.uid !== base.root) {
    throw new NestedError(
      'uid',
      `is '${node.uid}', but this document's root block is '${base.root}' — a document's root is created once and never replaced`,
    )
  }
  const rootUid = base ? base.root : (uidOf(node, '') ?? newUid())

  build(ctx, node, {
    uid: rootUid,
    parent: null,
    slot: null,
    order: baseRoot?.order ?? 'a0',
    baseBlok: baseRoot,
    slotField: undefined,
    path: '',
    depth: 0,
  })

  // Deferred to here, not done inside the walk, because "is this uid claimed by
  // the payload somewhere else" is only answerable once the whole payload has
  // been read.
  if (base) {
    for (const uid of ctx.carries) {
      for (const u of subtree(base, uid)) {
        if (ctx.claimed.has(u)) {
          throw new NestedError(
            '',
            `uid '${u}' is placed by this payload and also carried over from a slot the payload does not mention — supply that slot explicitly`,
          )
        }
        ctx.out[u] = base.bloks[u]!
      }
    }
  }

  return { root: rootUid, bloks: ctx.out }
}

interface BuildContext {
  schema: SchemaIndex
  base: Doc | undefined
  mode: 'merge' | 'replace'
  out: Record<string, Blok>
  /** Uids the payload itself places, for the carry-over collision check. */
  claimed: Set<string>
  /** Base uids whose subtrees survive verbatim because their slot was omitted. */
  carries: string[]
  nodes: number
}

interface Placement {
  uid: string
  parent: string | null
  slot: string | null
  order: string
  baseBlok: Blok | undefined
  /** The parent's declaration of the slot this lands in, for the `allow` check. */
  slotField: Extract<Field, { kind: 'blocks' }> | undefined
  path: string
  depth: number
}

function build(ctx: BuildContext, node: Record<string, unknown>, at: Placement): void {
  if (at.depth > MAX_NESTED_DEPTH) {
    throw new NestedError(at.path, `nests deeper than ${MAX_NESTED_DEPTH} levels`)
  }
  if (++ctx.nodes > MAX_NESTED_NODES) {
    throw new NestedError('', `carries more than ${MAX_NESTED_NODES} blocks`)
  }

  // `typeOf` has already refused a type the payload *introduces* and the schema
  // does not declare, so `def` is undefined here only for a type the blok already
  // stores — a block whose definition was deleted from the code. Left writable on
  // purpose: refusing it would mean a document holding one could not be edited at
  // all, not even elsewhere in the same document.
  const type = typeOf(node, at, ctx)
  const def = ctx.schema[type]
  if (at.parent === null && at.baseBlok && type !== at.baseBlok.type) {
    throw new NestedError(
      at.path ? `${at.path}.type` : 'type',
      `is '${type}', but the root block's type is the document type ('${at.baseBlok.type}') and changing it is a schema migration, not a content write`,
    )
  }
  // `allow`, enforced only on a block this payload *puts* here — introduced,
  // moved in from elsewhere, or retyped. A block already sitting in this slot at
  // this type is left alone, for the same reason an undeclared type is: a block
  // type deleted from the code is deleted from every `allow` list too, and
  // refusing it would make the document holding it unwritable. The admin draws
  // the same line, enforcing `allow` on a drag rather than on the blocks already
  // in place.
  if (at.slotField && !alreadyHere(at, type) && !at.slotField.allow.includes(type)) {
    throw new NestedError(
      at.path,
      `is a '${type}', which slot '${at.slot}' does not allow (${at.slotField.allow.join(', ')})`,
    )
  }

  const supplied = fieldsOf(node, at.path)
  const slotNames = slotsFor(ctx, def, at, supplied)
  const data = scalarData(ctx, def, at, supplied, slotNames)
  const i18n = translations(ctx, def, at, node, slotNames)

  ctx.out[at.uid] = {
    uid: at.uid,
    type,
    parent: at.parent,
    slot: at.slot,
    order: at.order,
    data,
    ...(i18n ? { i18n } : {}),
  }

  for (const slot of slotNames) {
    const raw = supplied[slot]
    if (raw === undefined) {
      // Merge leaves an unmentioned slot alone; replace empties it, which is what
      // makes replace able to say "this document has no body".
      if (ctx.mode === 'merge' && ctx.base) {
        for (const child of baseChildren(ctx.base, at.uid, slot)) ctx.carries.push(child.uid)
      }
      continue
    }
    placeChildren(ctx, def, at, slot, raw)
  }
}

/** True when the base already holds this blok, at this type, in this exact slot. */
const alreadyHere = (at: Placement, type: string): boolean =>
  at.baseBlok !== undefined &&
  at.baseBlok.type === type &&
  at.baseBlok.parent === at.parent &&
  at.baseBlok.slot === at.slot

/** The declared type, the stored one, or a refusal. */
function typeOf(node: Record<string, unknown>, at: Placement, ctx: BuildContext): string {
  const declared = node.type
  if (declared === undefined) {
    if (at.baseBlok) return at.baseBlok.type
    throw new NestedError(at.path ? `${at.path}.type` : 'type', 'is required for a new block')
  }
  if (typeof declared !== 'string' || !declared) {
    throw new NestedError(at.path ? `${at.path}.type` : 'type', 'must be a non-empty string')
  }
  if (!ctx.schema[declared] && !(at.baseBlok && at.baseBlok.type === declared)) {
    throw new NestedError(
      at.path ? `${at.path}.type` : 'type',
      `is not a declared block type: '${declared}'`,
    )
  }
  return declared
}

function uidOf(node: Record<string, unknown>, path: string): string | undefined {
  const uid = node.uid
  if (uid === undefined || uid === null) return undefined
  if (typeof uid !== 'string' || !UID_RE.test(uid)) {
    throw new NestedError(path ? `${path}.uid` : 'uid', 'must be 1-64 of [A-Za-z0-9_-]')
  }
  return uid
}

function requireNode(input: unknown, path: string): Record<string, unknown> {
  if (!isRecord(input)) throw new NestedError(path, 'must be a JSON object')
  return input
}

function fieldsOf(node: Record<string, unknown>, path: string): Record<string, unknown> {
  const fields = node.fields
  if (fields === undefined) return {}
  if (!isRecord(fields)) {
    throw new NestedError(path ? `${path}.fields` : 'fields', 'must be a JSON object')
  }
  return fields
}

/**
 * Which of this block's field names are slots.
 *
 * From the schema when it knows the type. Without a schema — the
 * stored-but-undeclared type above — from the base's own children, which is the
 * only deterministic answer available: guessing from the shape of a supplied
 * value would make "an array of objects" mean "blocks" for every field.
 */
function slotsFor(
  ctx: BuildContext,
  def: BlockSchema | undefined,
  at: Placement,
  supplied: Record<string, unknown>,
): string[] {
  if (def) return slotsOf(def).map(([name]) => name)
  if (!ctx.base) return []
  const names = new Set<string>()
  for (const blok of Object.values(ctx.base.bloks)) {
    if (blok.parent === at.uid && blok.slot !== null) names.add(blok.slot)
  }
  // A slot the base has no children in yet cannot be discovered this way, so a
  // supplied array is taken at its word for an undeclared type.
  for (const [name, value] of Object.entries(supplied)) {
    if (Array.isArray(value) && value.every(isRecord)) names.add(name)
  }
  return [...names]
}

/**
 * Why an undeclared field name was refused. Two wordings, because the two cases
 * need different advice: a key the document *does* store is drift a caller may
 * hand straight back but not change, and one it does not is simply a typo — which
 * is the case the whole "name what you refused" rule exists for.
 */
function undeclared(
  def: BlockSchema | undefined,
  stored: Record<string, Json> | undefined,
  name: string,
): string {
  const owner = def ? `is not a field of '${def.name}'` : 'is not a field this block declares'
  return stored && name in stored
    ? `${owner}; the stored value can be sent back unchanged, but not changed`
    : owner
}

function scalarData(
  ctx: BuildContext,
  def: BlockSchema | undefined,
  at: Placement,
  supplied: Record<string, unknown>,
  slotNames: readonly string[],
): Record<string, Json> {
  const slots = new Set(slotNames)
  // Merge starts from what is stored; replace starts from nothing, so an absent
  // key clears the value.
  const data: Record<string, Json> =
    ctx.mode === 'merge' && at.baseBlok ? { ...at.baseBlok.data } : {}

  /**
   * A **new** blok starts with a key for every declared field, exactly as
   * `subtreeRecipe` gives one created in the editor.
   *
   * Without this, a document written through the content API or an importer is
   * missing a key for every field the payload omitted — and "this blok has no
   * key for a field the schema declares" is precisely what the audit's
   * `missing-field` check reads as *a field added after the document was
   * written*. So every API-created document reported drift forever, and the one
   * panel meant to surface real problems was all false positives on a clean
   * site. Reported as "Missing fields" on Home the first time a real host
   * imported content.
   *
   * It also fixes a quieter one. `core/schema.ts` says `field.default` is
   * consulted at creation "and only here" — which was true of the editor's path
   * and false of this one, so an imported blok silently missed every declared
   * default.
   *
   * Keyed on `at.baseBlok` rather than on the mode, because the question is
   * whether this blok is being created, not how the write was framed. A
   * *replace* over an existing blok still starts from `{}` and still clears an
   * absent scalar, which is its documented job.
   */
  if (!at.baseBlok && def) {
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.kind === 'blocks' || slots.has(name)) continue
      data[name] = field.default ?? defaultValue(field)
    }
  }

  for (const [name, value] of Object.entries(supplied)) {
    if (slots.has(name)) continue
    const path = fieldPath(at.path, name)
    const field = def?.fields[name]
    if (!field) {
      // Unchanged drift passes through: `toNested` emits every stored key, so a
      // read-modify-write of a document holding an orphaned key must not be
      // refused for handing that key straight back. Introducing or changing one
      // is refused, naming it.
      if (at.baseBlok && jsonEqual(at.baseBlok.data[name] ?? null, value ?? null)) {
        data[name] = value as Json
        continue
      }
      throw new NestedError(path, undeclared(def, at.baseBlok?.data, name))
    }
    if (field.kind === 'blocks') {
      throw new NestedError(path, 'is a blocks field, so its value must be an array of blocks')
    }
    const shape = fieldShapeError(field, value)
    if (shape) throw new NestedError(path, shape)
    data[name] = value as Json
  }

  return data
}

/**
 * `i18n` for one blok: layered over what is stored in merge mode, taken whole in
 * replace mode.
 *
 * The refusal at the bottom is the one the spec calls "the most likely real bug
 * this whole spec would otherwise ship". A replace payload that omits `i18n` on a
 * blok with translations would diff them away silently, so it is refused with an
 * explanation and `i18n: {}` is how a caller says "clear them" deliberately. In
 * merge mode there is nothing to refuse: an absent `i18n` leaves translations
 * alone, which is exactly why merge is the default.
 */
function translations(
  ctx: BuildContext,
  def: BlockSchema | undefined,
  at: Placement,
  node: Record<string, unknown>,
  slotNames: readonly string[],
): Record<string, Record<string, Json>> | undefined {
  const raw = node.i18n
  const stored = at.baseBlok?.i18n

  if (raw === undefined || raw === null) {
    if (ctx.mode === 'merge') return stored
    const risk = translationsAtRisk(stored)
    if (risk.length > 0) {
      throw new NestedError(
        at.path ? `${at.path}.i18n` : 'i18n',
        `is absent, and a replace would discard the translations this block holds (${risk.join(', ')}). Send the translations you want kept, or 'i18n': {} to clear them deliberately.`,
      )
    }
    return undefined
  }

  if (!isRecord(raw)) {
    throw new NestedError(at.path ? `${at.path}.i18n` : 'i18n', 'must be a JSON object')
  }

  const slots = new Set(slotNames)
  const out: Record<string, Record<string, Json>> = ctx.mode === 'merge' && stored
    ? Object.fromEntries(Object.entries(stored).map(copyLocale))
    : {}

  for (const [code, map] of Object.entries(raw)) {
    const at18n = at.path ? `${at.path}.i18n.${code}` : `i18n.${code}`
    if (!LOCALE_RE.test(code)) throw new NestedError(at18n, 'is not a locale code')
    if (!isRecord(map)) throw new NestedError(at18n, 'must be a JSON object')
    const layer: Record<string, Json> = ctx.mode === 'merge' ? (out[code] ?? {}) : {}
    for (const [name, value] of Object.entries(map)) {
      const path = `${at18n}.${name}`
      if (slots.has(name)) {
        throw new NestedError(path, 'is a blocks field, and children are not a per-locale value')
      }
      const field = def?.fields[name]
      if (!field) {
        if (stored && jsonEqual(stored[code]?.[name] ?? null, value ?? null)) {
          layer[name] = value as Json
          continue
        }
        throw new NestedError(path, undeclared(def, stored?.[code], name))
      }
      // Deliberately **not** checked against `translatable`. That flag is an
      // editor affordance, and `Common.translatable` says so: a value that
      // reaches `i18n` from an importer or the content API wins regardless, and
      // `/folio/audit` is what reports the ones nobody marked.
      const shape = fieldShapeError(field, value)
      if (shape) throw new NestedError(path, shape)
      layer[name] = value as Json
    }
    out[code] = layer
  }

  return Object.keys(out).length > 0 ? out : undefined
}

const copyLocale = ([code, map]: [string, Record<string, Json>]): [
  string,
  Record<string, Json>,
] => [code, { ...map }]

/** Locales holding at least one defined, non-null value — what a replace would lose. */
function translationsAtRisk(stored: Record<string, Record<string, Json>> | undefined): string[] {
  if (!stored) return []
  return Object.entries(stored)
    .filter(([, map]) => Object.values(map).some((v) => v !== null && v !== undefined))
    .map(([code]) => code)
    .sort()
}

/* -------------------------------------------------------------- children --- */

function baseChildren(base: Doc, parent: string, slot: string): Blok[] {
  const out: Blok[] = []
  for (const blok of Object.values(base.bloks)) {
    if (blok.parent === parent && blok.slot === slot) out.push(blok)
  }
  out.sort((a, b) => (a.order === b.order ? cmp(a.uid, b.uid) : cmp(a.order, b.order)))
  return out
}

function placeChildren(
  ctx: BuildContext,
  def: BlockSchema | undefined,
  at: Placement,
  slot: string,
  raw: unknown,
): void {
  const slotField = def?.fields[slot]
  if (def && slotField?.kind !== 'blocks') {
    throw new NestedError(fieldPath(at.path, slot), `is not a slot of '${def.name}'`)
  }
  if (!Array.isArray(raw)) {
    throw new NestedError(fieldPath(at.path, slot), 'must be an array of blocks')
  }
  if (slotField?.kind === 'blocks' && slotField.max !== undefined && raw.length > slotField.max) {
    throw new NestedError(
      fieldPath(at.path, slot),
      `holds ${raw.length} blocks, and this slot allows at most ${slotField.max}`,
    )
  }

  const nodes = raw.map((entry, i) => requireNode(entry, childPath(at.path, slot, i)))
  // Claimed as each uid is resolved, not when its blok is built: two entries of
  // the *same* array would otherwise both be resolved before either was claimed,
  // and a duplicate within one slot is the likeliest way to write one by accident.
  const uids = nodes.map((node, i) => {
    const path = childPath(at.path, slot, i)
    const supplied = uidOf(node, path)
    if (supplied === undefined) {
      const minted = newUid()
      ctx.claimed.add(minted)
      return minted
    }
    if (ctx.claimed.has(supplied)) {
      throw new NestedError(path, `reuses uid '${supplied}', which this payload has already placed`)
    }
    ctx.claimed.add(supplied)
    return supplied
  })

  // A base blok is only worth its existing order key *here*: one that has moved
  // in from another slot needs a fresh key, and one that never existed needs one
  // too.
  const existing = uids.map((uid) => {
    const blok = ctx.base?.bloks[uid]
    return blok && blok.parent === at.uid && blok.slot === slot ? blok.order : undefined
  })
  const orders = assignOrders(existing)

  for (const [i, node] of nodes.entries()) {
    const uid = uids[i]!
    build(ctx, node, {
      uid,
      parent: at.uid,
      slot,
      order: orders[i]!,
      baseBlok: ctx.base?.bloks[uid],
      slotField: slotField?.kind === 'blocks' ? slotField : undefined,
      path: childPath(at.path, slot, i),
      depth: at.depth + 1,
    })
  }
}

/**
 * Order keys for one slot's target sequence, keeping as many existing ones as
 * possible.
 *
 * The kept set is the longest **strictly** increasing subsequence of the existing
 * keys, in target order — strictly, so a pair of tied keys (reachable by design;
 * see `keyAtIndex`) can never both be kept and leave a gap with equal bounds.
 * Everything not kept gets a fresh key from `keysBetween`, in the gap between its
 * nearest kept neighbours.
 *
 * This is the whole reason a positional shape does not mean a wholesale
 * rewrite: inserting an item at the front of a list of fifty keeps all fifty
 * keys and mints one, so `diff` emits one insert rather than fifty moves. The
 * naive alternative — compare each item's target index with its stored index —
 * would emit fifty.
 */
export function assignOrders(existing: readonly (string | undefined)[]): string[] {
  const n = existing.length
  if (n === 0) return []
  const keep = longestIncreasing(existing)
  const orders: string[] = new Array(n)
  for (const i of keep) orders[i] = existing[i]!

  let i = 0
  while (i < n) {
    if (keep.has(i)) {
      i++
      continue
    }
    let j = i
    while (j < n && !keep.has(j)) j++
    const fresh = keysBetween(i > 0 ? orders[i - 1]! : null, j < n ? orders[j]! : null, j - i)
    for (let k = i; k < j; k++) orders[k] = fresh[k - i]!
    i = j
  }
  return orders
}

/** Indices of a longest strictly-increasing subsequence; `undefined` never qualifies. */
function longestIncreasing(keys: readonly (string | undefined)[]): Set<number> {
  /** `tails[l]` is the index of the smallest tail among increasing runs of length `l + 1`. */
  const tails: number[] = []
  const prev: number[] = new Array(keys.length).fill(-1)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (key === undefined) continue
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[tails[mid]!]! < key) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1
    tails[lo] = i
  }

  const out = new Set<number>()
  let cursor = tails.length > 0 ? tails[tails.length - 1]! : -1
  while (cursor >= 0) {
    out.add(cursor)
    cursor = prev[cursor]!
  }
  return out
}

/* ------------------------------------------------------------ field shape --- */

/**
 * Why a value cannot be this field's, or null.
 *
 * The one place API input meets the schema, per decision 3, and the switch is
 * **exhaustive on purpose**: a new field kind fails to compile here, exactly as
 * it does in `resolveValue`. A kind whose stored shape this file did not know
 * about would otherwise be silently unvalidated on the way in.
 *
 * `null` is accepted for **every** kind, ahead of the switch, and that is not
 * laxness. It is the mutation vocabulary's "no value": `set(field, null)` is a
 * legal transaction for any field, `resolveValue` normalises it to the kind's own
 * empty value on the way out, and `fieldValue` reads it as *untranslated* in a
 * locale map — which makes it the only way to express "untranslate this", since
 * there is no delete-field mutation. Refusing it would mean a document holding a
 * nulled field could not be read and written back.
 */
export function fieldShapeError(field: Field, value: unknown): string | null {
  if (value === null) return null
  const json = jsonError(value)
  if (json) return json

  switch (field.kind) {
    case 'text':
    case 'textarea':
      return typeof value === 'string' ? null : 'must be a string'
    case 'select':
      if (typeof value !== 'string') return 'must be a string'
      if (value === '' || field.options.some((o) => o.value === value)) return null
      return `must be one of: ${field.options.map((o) => o.value).join(', ')}`
    case 'number':
      return typeof value === 'number' ? null : 'must be a number'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false'
    // The richer stored shapes (`AssetValue`, `LinkValue`, `RichtextDoc`), each
    // checked only as far as "an object, or null for absent". Their contents are
    // re-checked where it matters and by the code that owns the shape:
    // `asAsset`/`asLink` on the way out, `sanitiseRichtext` on the way in.
    case 'asset':
    case 'multilink':
    case 'richtext':
      return isRecord(value) ? null : 'must be an object or null'
    case 'multiasset':
      return Array.isArray(value) ? null : 'must be an array'
    case 'reference':
      return typeof value === 'string' ? null : 'must be a story id or null'
    case 'references':
      // The stored shape is a plain array of story-id strings
      // (`data-documents.md`); `asStoryIds` is what reads it back.
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'must be an array of story ids'
    case 'collection':
      // The editor's choices within the field's declared query, never the query
      // itself (`collections.md`), and `{}` means "the field's own defaults".
      return isRecord(value) ? null : 'must be an object'
    case 'blocks':
      return Array.isArray(value) ? null : 'must be an array of blocks'
    default: {
      const unhandled: never = field
      throw new Error(`Unhandled field kind: ${(unhandled as Field).kind}`)
    }
  }
}

/**
 * Why this value is not JSON, or null. `fromNested` takes `unknown`, so a
 * hand-built object (rather than one off `JSON.parse`) can carry `undefined`, a
 * function or a cycle — each of which would be silently dropped or would throw
 * inside the Durable Object's `JSON.stringify` instead of being refused here.
 */
function jsonError(value: unknown, depth = 0): string | null {
  if (depth > MAX_NESTED_DEPTH) return `nests deeper than ${MAX_NESTED_DEPTH} levels`
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null
    case 'number':
      return Number.isFinite(value) ? null : 'must be a finite number'
    case 'object':
      break
    default:
      return 'must be a JSON value'
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const err = jsonError(entry, depth + 1)
      if (err) return err
    }
    return null
  }
  if (!isRecord(value)) return 'must be a JSON value'
  for (const entry of Object.values(value)) {
    const err = jsonError(entry, depth + 1)
    if (err) return err
  }
  return null
}

/**
 * Structural equality over JSON, for the "unchanged drift passes through" rule.
 * A local copy rather than `diff.ts`'s `deepEqual` because that one is typed at
 * `Json` and these values are still `unknown` when they are compared.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonEqual(v, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => k in b && jsonEqual(a[k], b[k]))
}
