/**
 * The block picker's arithmetic: which entries a slot offers, what each one says
 * about itself, how the ranked results group, and where `⌘⇧A` puts a block when
 * nobody clicked a `+`.
 *
 * Pure functions, for the admin's testing convention — no admin test mounts a
 * component, so a screen's logic lives where a Node test can reach it
 * (`content-model.ts` is the pattern). This is the file that most needed it:
 * **a picker that offers a block the slot will refuse is worse than no picker**,
 * and the refusal is a schema question with four distinct answers.
 *
 * Two things the design asks for do not exist in `BlockSchema` and are derived
 * here instead:
 *
 *   - **A category.** `ui-architecture.md` says "grouped by category"; there is no
 *     `category` field, and `field-defaults-and-presets.md` decision 5 parks
 *     "search, icons and categories" on the roadmap as their own work. So the group
 *     is the **block type**, with its presets under it — which is the grouping that
 *     decision already specifies and the exact reason the design calls this picker
 *     free: "the manifest already carries labels and `field-defaults-and-presets.md`
 *     already groups presets under their type". A `category?: string` on
 *     `BlockSchema` is what would make this coarser, and it is one line plus a
 *     manifest field whenever somebody wants it.
 *   - **A description.** Also absent, and derived from what the block *holds*: its
 *     field labels, its slots, and for a preset what it fills in and plants. That
 *     is not a stand-in for a hand-written sentence so much as a different, better
 *     property — a derived description cannot drift from the block it describes,
 *     which a hand-written one does the first time a field is renamed.
 */
import { childrenOf, type Doc } from '../../../core/doc'
import type { Field } from '../../../core/fields'
import { type BlockPreset, type BlockSchema, type SchemaIndex, slotsOf } from '../../../core/schema'
import { fullSlotMessage } from '../../hooks/useBlocks'
import type { Ranked } from '../rank'

/* ----------------------------------------------------------------- entries --- */

/** One thing the picker can insert: a plain block type, or one of its presets. */
export interface PickerEntry {
  /** `type`, or `type/preset`. Stable, and what a keyed list needs. */
  id: string
  type: string
  /** Absent for the plain block. Passed straight to `useBlocks.add`. */
  preset?: string
  label: string
  /** What you get, derived from the schema. See the file header. */
  description: string
  /** The block type this entry belongs to — the group's heading. */
  group: string
  /** True for the plain block rather than a preset of it. */
  bare: boolean
  /**
   * Searched by `rank` and never highlighted: the block's own name, the preset's
   * name, and every field's name and label.
   *
   * The field labels are the interesting part and the precedent is
   * `settings-model.ts`'s `filterBlocks`, which says it plainly — "searching
   * `indexed` or `alt` answers *which blocks have one of those*". In a picker that
   * means typing `alt` finds Image, and typing `caption` finds the two blocks that
   * have one, without anybody maintaining a synonym list.
   */
  keywords: string
}

/**
 * What a slot offers, and why it offers nothing when it does not.
 *
 * `refusal` and `entries` rather than a union, because the picker draws the slot's
 * name in its title either way: a `⌘⇧A` that opened a dialog saying nothing would
 * be indistinguishable from a chord that did not fire.
 */
export interface SlotOffer {
  /** The slot's own label, for the picker's title. */
  slotLabel: string
  /** Why nothing can be added here, or null. */
  refusal: string | null
  /** Empty whenever `refusal` is set. */
  entries: PickerEntry[]
}

/**
 * **How the picker learns what a slot accepts.** A slot is a `blocks`-kind field on
 * the parent block's type (`slotsOf` enumerates them), and it constrains its
 * children in exactly two ways: `allow` is a whitelist of block type names, and
 * `max` caps how many the slot may hold. Both are checked here, and both are
 * checked again by `useBlocks.move` and by `pasteInsert` — this is the third caller
 * of the same rule, not a new one.
 *
 * The four refusals are distinguished on purpose. "Not a slot", "allows nothing",
 * "already full" and "unknown parent type" are four different facts about the
 * schema, and collapsing them into one message is how an editor ends up asking a
 * developer which of them it was.
 */
export function slotOffer(
  schema: SchemaIndex,
  /** The block type owning the slot — `doc.bloks[parent].type`. */
  parentType: string,
  slot: string,
  /** How many blocks the slot already holds, for `max`. */
  filled: number,
): SlotOffer {
  const parentDef = schema[parentType]
  const field: Field | undefined = parentDef?.fields[slot]
  const slotLabel = field?.label ?? slot

  if (!parentDef) {
    return {
      slotLabel,
      refusal: `‘${parentType}’ is not in the schema, so its slots are unknown.`,
      entries: [],
    }
  }
  if (field?.kind !== 'blocks') {
    return {
      slotLabel,
      refusal: `‘${slot}’ is not a slot on ${parentDef.label}.`,
      entries: [],
    }
  }
  if (field.allow.length === 0) {
    return { slotLabel, refusal: `${slotLabel} allows no block types.`, entries: [] }
  }
  if (field.max !== undefined && filled >= field.max) {
    // `fullSlotMessage` rather than a fifth wording of the same cap: duplicate and
    // paste already share it so their refusals read identically, and a picker that
    // phrased it differently would look like a different rule.
    return {
      slotLabel,
      refusal: `${slotLabel} is full — ${fullSlotMessage(field.max)}.`,
      entries: [],
    }
  }

  return { slotLabel, refusal: null, entries: entriesFor(schema, field.allow) }
}

/**
 * One group per allowed type in the slot's own `allow` order, the plain block first
 * unless `presetsOnly` hides it, then its presets — `field-defaults-and-presets.md`
 * decision 5, which `menuGroups` in `BlockTree.tsx` already implements for the menu
 * this replaces. Flat here, because `rank` reorders and the grouping is recovered
 * afterwards by `groupRanked`.
 *
 * Declaration order, not alphabetical: `allow` is the block author's own ordering
 * and it survives an empty query, exactly as the palette's action list does.
 */
export function entriesFor(schema: SchemaIndex, allow: readonly string[]): PickerEntry[] {
  const entries: PickerEntry[] = []
  for (const type of allow) {
    const def = schema[type]
    const label = def?.label ?? type
    const fieldTerms = def ? fieldTermsOf(def) : ''
    if (!def?.presetsOnly) {
      entries.push({
        id: type,
        type,
        label,
        description: bareDescription(schema, def),
        group: label,
        bare: true,
        keywords: `${type} ${fieldTerms}`,
      })
    }
    for (const preset of def?.presets ?? []) {
      entries.push({
        id: `${type}/${preset.name}`,
        type,
        preset: preset.name,
        label: preset.label,
        description: presetDescription(schema, def, label, preset),
        group: label,
        bare: false,
        keywords: `${type} ${preset.name} ${label} ${fieldTerms}`,
      })
    }
  }
  return entries
}

/* ------------------------------------------------------------ descriptions --- */

/** How many names a description lists before it starts counting them. Four is what
 * fits a picker row at a readable measure; past that the count is more use than the
 * names. */
const NAMED = 4

function listOf(items: readonly string[]): string {
  if (items.length <= NAMED) return items.join(', ')
  return `${items.slice(0, NAMED).join(', ')} +${items.length - NAMED} more`
}

/** A block's own field labels, slots excluded — a `blocks` field is structure
 * rather than a value, the same split `blockCards` makes in `settings-model.ts`. */
function valueFields(def: BlockSchema): string[] {
  return Object.entries(def.fields)
    .filter(([, field]) => field.kind !== 'blocks')
    .map(([name, field]) => field.label ?? name)
}

/** Every searchable word about a block's fields: each field's name *and* its
 * label, slots included, since a slot is a thing somebody looks for by name. */
function fieldTermsOf(def: BlockSchema): string {
  return Object.entries(def.fields)
    .flatMap(([name, field]) => [name, field.label ?? ''])
    .join(' ')
}

/**
 * What a plain block holds: its fields, then what its slots take.
 *
 * A block that is purely structural — a Section whose only field is a slot — gets a
 * description made of what goes *in* it, which is the only true thing there is to
 * say about it and is also what somebody is choosing it for.
 */
export function bareDescription(schema: SchemaIndex, def: BlockSchema | undefined): string {
  if (!def) return 'Not in the schema.'
  const fields = valueFields(def)
  const takes = [...new Set(slotsOf(def).flatMap(([, slot]) => slot.allow))].map(
    (type) => schema[type]?.label ?? type,
  )
  const parts = [listOf(fields), takes.length > 0 ? `holds ${listOf(takes)}` : '']
  const phrase = parts.filter(Boolean).join(' · ')
  return phrase || 'No fields of its own.'
}

/**
 * What a preset is: the type it is a starting point for, what it fills in, and what
 * it plants.
 *
 * Naming the type is what makes a preset row legible on its own, which matters
 * because a query can narrow a group down to one preset and leave its heading
 * behind — and because a preset's label is the author's ("Dark", "With video") and
 * need not mention the block at all.
 */
export function presetDescription(
  schema: SchemaIndex,
  def: BlockSchema | undefined,
  typeLabel: string,
  preset: BlockPreset,
): string {
  const sets = Object.keys(preset.data ?? {}).map((name) => def?.fields[name]?.label ?? name)
  const counts = new Map<string, number>()
  for (const child of preset.children ?? []) {
    counts.set(child.type, (counts.get(child.type) ?? 0) + 1)
  }
  // `Button ×2` rather than a pluralised label: a label is the author's noun and
  // this has no business turning "Person" into "Persons".
  const kids = [...counts].map(([type, n]) => {
    const label = schema[type]?.label ?? type
    return n === 1 ? label : `${label} ×${n}`
  })
  const parts = [
    sets.length > 0 ? `${listOf(sets)} set` : '',
    kids.length > 0 ? `${listOf(kids)} inside` : '',
  ].filter(Boolean)
  return parts.length > 0 ? `${typeLabel} with ${parts.join(', and ')}` : typeLabel
}

/* ---------------------------------------------------------------- grouping --- */

export interface PickerRow {
  /** Position in the flat ranked list, which is what the active index counts in. */
  at: number
  entry: PickerEntry
  /** The matched runs of `entry.label`, for highlighting. */
  spans: readonly [number, number][]
}

export interface PickerGroup {
  label: string
  /**
   * No heading is drawn: the group has exactly one visible row and it is the plain
   * block, so the heading would repeat the row's own label. `AddMenu` reached the
   * same conclusion from the other direction and made the heading double as the
   * button; a palette cannot do that, so it drops the heading instead.
   */
  solo: boolean
  rows: PickerRow[]
}

/**
 * Ranked results, regrouped by type in first-appearance order — the same rule
 * `Palette` applies to its action groups, so the author's declaration order carries
 * through an empty query and the best match leads once there is one.
 */
export function groupRanked(ranked: readonly Ranked<PickerEntry>[]): PickerGroup[] {
  const groups: PickerGroup[] = []
  for (const [at, { item, match }] of ranked.entries()) {
    let group = groups.find((g) => g.label === item.group)
    if (!group) {
      group = { label: item.group, solo: false, rows: [] }
      groups.push(group)
    }
    group.rows.push({ at, entry: item, spans: match.spans })
  }
  for (const group of groups) {
    group.solo = group.rows.length === 1 && group.rows[0]!.entry.bare
  }
  return groups
}

/* ------------------------------------------------------------------ target --- */

/** Where a block goes: the slot, its owner, and the ordinal position within it.
 * The same three arguments `useBlocks.add` takes. */
export interface AddTarget {
  parent: string
  slot: string
  index: number
}

/**
 * Where `⌘⇧A` puts a block, given the current selection.
 *
 * The `+` in a slot knows its own target; the chord does not, so the rule has to be
 * written down somewhere — and this is `pasteInsert`'s rule minus the type check,
 * deliberately, because two gestures that both mean "put a block near here" landing
 * in different places is a worse surprise than either rule on its own:
 *
 *   - **A block is selected** → a sibling immediately after it, in its own slot.
 *   - **The document root is selected** → its first slot with room, appended. The
 *     root has no siblings, so there is no other reading.
 *   - **Nothing is selected** → *the same as the root*, which is the one place this
 *     departs from `pasteInsert`. On a freshly opened editor nothing has been
 *     clicked, and `⌘⇧A` then plainly means "add a block to this page"; the old
 *     editor selected the root on load for exactly that reason, but the chord must
 *     not depend on a shell having done so. Paste refuses in that state because it
 *     has a typed payload that has to fit *somewhere specific*; add has no payload
 *     yet, so there is nothing to refuse over. A selection naming a block the
 *     document no longer has — a peer deleted it while the chord was pressed —
 *     resolves the same way, for the same reason.
 *
 * Rejected: descending into the *selection's* own first slot. It is tempting for a
 * container — select a Section, add inside it — and it makes the chord
 * unpredictable when repeated: pressed twice it would put the second block inside
 * the first rather than beside it, and there is no way to tell from the tree which
 * of the two it is about to do.
 */
export function addTarget(
  doc: Doc,
  schema: SchemaIndex,
  selection: string | null,
): AddTarget | { error: string } {
  const root = doc.bloks[doc.root]
  const target = (selection === null ? undefined : doc.bloks[selection]) ?? root
  // A document with no root block is not a document. Nothing reachable produces
  // one, and the alternative to saying so is a target pointing at nothing.
  if (!target || !root) return { error: 'This document has no root block.' }

  if (target.uid === doc.root) {
    const slots = slotsOf(schema[root.type])
    if (slots.length === 0) {
      return { error: `${schema[root.type]?.label ?? root.type} has no slots to add to.` }
    }
    for (const [slot, field] of slots) {
      if (field.allow.length === 0) continue
      const filled = childrenOf(doc, doc.root, slot).length
      if (field.max !== undefined && filled >= field.max) continue
      return { parent: doc.root, slot, index: filled }
    }
    return { error: 'Every slot on this page is full or accepts nothing.' }
  }

  if (target.parent === null || target.slot === null) {
    // A non-root blok with no parent is a document that failed to hold together;
    // `mutationError` refuses the mutations that would produce one.
    return { error: 'That block is not in a slot.' }
  }
  const siblings = childrenOf(doc, target.parent, target.slot)
  const field = schema[doc.bloks[target.parent]?.type ?? '']?.fields[target.slot]
  if (field?.kind !== 'blocks') return { error: 'That block is not in a slot.' }
  if (field.max !== undefined && siblings.length >= field.max) {
    return { error: `Cannot add another: ${fullSlotMessage(field.max)}.` }
  }
  return {
    parent: target.parent,
    slot: target.slot,
    index: siblings.findIndex((b) => b.uid === target.uid) + 1,
  }
}
