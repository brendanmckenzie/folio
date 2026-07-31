/**
 * The inspector's arithmetic: which fields draw, which control each kind maps to,
 * what a field's input is bound to in the active locale, whether it may be typed
 * into, what a peer ring says, and what a value's own constraints complain about.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `documents-model.ts` is the pattern this follows.
 *
 * **Most of this is copied verbatim from `admin/Inspector.tsx`, comments included,
 * and that is deliberate.** `docs/editor-port-plan.md`'s rule for port phase 7b is
 * to port the field inputs' *styling* and not their logic: validation, the locale
 * columns, the peer rings and the disabled control on a shared field are correct
 * and hard-won. Copying rather than importing is the same trade every phase of this
 * port made — the old admin still serves `{base}/edit/:id` and keeps its own copies
 * until it is deleted, exactly as `DataTable.tsx` kept `dataColumns` while
 * `documents-model.ts` grew its own.
 *
 * Genuinely new here, and named so a reviewer can find it: `controlFor`,
 * `isEditable`, `fieldWarning`, `canFocus` and `FOCUS_MEASURE_CH`. The first two
 * make decisions the old component made inline as a nested ternary; the third
 * gathers the `required`/`min`/`max` warnings that were scattered across three
 * inputs; the last two belong to focus mode, which is new.
 */
import { matches } from '../../../core/conditions'
import type { Blok, Json } from '../../../core/doc'
import type { Field } from '../../../core/fields'
import { isTranslatable } from '../../../core/locales'
import type { Presence } from '../../../core/protocol'
import { asRichtext, isRichtextEmpty, richtextToText } from '../../../core/richtext'
import type { SchemaIndex } from '../../../core/schema'
import { asAsset, asAssets, asStoryIds } from '../../../core/values'

/* ------------------------------------------------------------ which fields --- */

/**
 * The fields a block's form actually draws: `blocks`-kind fields never reach
 * the inspector (they render as tree slots, see `BlockRail.tsx`), `hidden: true`
 * fields never draw (conditional-fields.md's `showIf: false` shorthand, for a
 * field kept only so a later migration can still read it), and a `showIf` field
 * draws only when its condition matches the *same blok's* own data.
 *
 * Filtering here, once, in the parent, means the field row keeps its current
 * props and learns nothing about visibility. Declaration order is preserved
 * (`Object.entries` order), so a field's React key (`${blok.uid}:${name}`, set
 * where this is consumed) never moves when a sibling appears or disappears — an
 * in-flight upload in one field survives a condition revealing another.
 */
export function visibleEntries(
  fields: Record<string, Field>,
  data: Record<string, Json>,
): [string, Field][] {
  return Object.entries(fields).filter(
    ([, f]) => f.kind !== 'blocks' && !f.hidden && (!f.showIf || matches(f.showIf, data)),
  )
}

/* ------------------------------------------------------------------ locales --- */

/**
 * How one field's input behaves in the active locale
 * (`localisation.md` decision 4 and the resolved open question).
 *
 * Three states, and they are exhaustive:
 *
 *   - `'source'` — the source locale is active. Exactly the pre-localisation
 *     editor: one input, bound to `data`, no second column.
 *   - `'translate'` — a non-source locale and the field is `translatable`. The
 *     input is bound to **the locale's own raw value**, never the fallback: an
 *     input pre-filled with the English would copy it into the translation the
 *     moment somebody typed one character, and "untranslated" would become
 *     unreachable. The source appears beside it, read-only.
 *   - `'shared'` — a non-source locale and the field is not translatable. The
 *     input is disabled and says so, bound to the source value so it is legible.
 *     Nothing writes a locale-scoped `set` from here, which is the editor half of
 *     decision 4's asymmetry: the renderer *would* honour one.
 */
export type FieldMode = 'source' | 'translate' | 'shared'

export function fieldMode(field: Field, isSourceLocale: boolean): FieldMode {
  if (isSourceLocale) return 'source'
  return isTranslatable(field) ? 'translate' : 'shared'
}

/**
 * The value an input is bound to, given its mode. Separated from `fieldMode` for
 * the property worth pinning on its own: a `'translate'` input reads the raw
 * locale map, so an untranslated field is *empty*, and never the fallback.
 */
export function boundValue(blok: Blok, name: string, mode: FieldMode, locale: string): Json | null {
  if (mode === 'translate') return blok.i18n?.[locale]?.[name] ?? null
  return blok.data[name] ?? null
}

/**
 * Whether this field's control accepts input right now.
 *
 * Two independent reasons it might not, and they are different facts about
 * different things: `readOnly` is the *document* (a past version is on the stage,
 * or the role may not edit), `'shared'` is the *field* (a non-translatable field in
 * a non-source locale — `localisation.md` decision 4's editor half). Both end up
 * disabling the same control, which is why the old component could get away with a
 * `<fieldset disabled>` at each level and never name the union.
 *
 * Named here because focus mode needs it: a richtext surface is `contenteditable`
 * and a native `fieldset[disabled]` does **not** reach it, so TipTap has to be told
 * separately. That was a real hole in the old inspector — a version preview left
 * every prose field typeable, and the keystroke was then refused by the store.
 */
export function isEditable(mode: FieldMode, readOnly: boolean): boolean {
  return !readOnly && mode !== 'shared'
}

/**
 * Which locale a write from this field carries, or `undefined` for the source.
 *
 * One function so the rule lives once: `'translate'` writes into `i18n[locale]`,
 * and both other modes write `data`. `'shared'` never reaches here in practice
 * because its control is disabled — but returning `undefined` rather than the
 * locale is what makes that safe rather than merely unlikely.
 */
export function writeLocale(mode: FieldMode, locale: string): string | undefined {
  return mode === 'translate' ? locale : undefined
}

/* ----------------------------------------------------------------- presence --- */

/**
 * Who else has this field focused (`live-collaboration.md` decision 3 and 5).
 *
 * **Advisory, never a lock** (checkpoint 2): both people may type, and this is
 * the warning that says so. A peer holding the *block* but no particular field
 * is not holding this field — the block tree's dot already says where they are.
 */
export function fieldWatchers(peers: readonly Presence[], uid: string, field: string): Presence[] {
  return peers.filter((p) => p.selection?.uid === uid && p.selection.field === field)
}

/**
 * What a peer ring says. The locale is named whenever it differs from the one
 * this editor is in, because two people in the same field in different languages
 * are writing different keys and are not in conflict at all
 * (`live-collaboration.md`'s edge case): a bare "Ann is here" would report a
 * clash that does not exist.
 */
export function watcherLabel(peer: Presence, locale: string | null): string {
  const theirs = peer.locale ?? null
  const mine = locale ?? null
  return theirs === mine
    ? `${peer.name} is in this field`
    : `${peer.name} is here in ${theirs ?? 'the source language'}`
}

/* ----------------------------------------------------------------- controls --- */

/**
 * What *kind of control* a field kind draws — for the decisions the row above it
 * has to make, not for dispatch.
 *
 * Three of those decisions exist and all three used to be inline conditions on
 * `field.kind` scattered through the JSX: a checkbox's label sits beside it rather
 * than above it, only richtext offers focus mode, and only the composite kinds want
 * the row's full width. Naming the grouping puts them in one place a Node test can
 * reach, and the final `else` in the old twelve-branch ternary — which silently
 * caught both `text` and any kind added later — becomes a mapping that does not
 * compile with a kind missing.
 *
 * **`Control.tsx` still switches on `field.kind`, and that is not duplication.**
 * A React component has to narrow the discriminated union to reach `field.options`
 * or `field.accept`, which only a switch on the discriminant does; this answers a
 * different question about the same value.
 *
 * `'blocks'` maps to `'none'` and is never reached: `visibleEntries` drops it before
 * a row is built, because children are tree slots rather than a value.
 */
export type ControlKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'asset'
  | 'multiasset'
  | 'link'
  | 'richtext'
  | 'reference'
  | 'references'
  | 'collection'
  | 'none'

/** A record keyed by every declared kind rather than a switch, so a new kind in
 * `core/fields.ts` is a type error here instead of a silent fallthrough. */
const CONTROLS: { readonly [K in Field['kind']]: ControlKind } = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  boolean: 'checkbox',
  select: 'select',
  asset: 'asset',
  multiasset: 'multiasset',
  multilink: 'link',
  richtext: 'richtext',
  reference: 'reference',
  references: 'references',
  collection: 'collection',
  blocks: 'none',
}

export function controlFor(kind: Field['kind']): ControlKind {
  return CONTROLS[kind]
}

/**
 * This kind's control is laid out **across** its row rather than down it.
 *
 * True for exactly one kind, and the reason is width: every other control fills the
 * column, so anything beside it would be squeezed, while a checkbox is 16px and
 * leaves the rest of the row empty. So a boolean's warning sits next to the box
 * instead of under it, which is the difference between one line and two for the
 * commonest field in any schema.
 *
 * What this deliberately does *not* do is move the label beside the box. `Field`
 * renders its label above its children and that is the primitive's shape; bypassing
 * it for one field kind would mean a checkbox whose label came from somewhere else
 * than every other label in the panel, which is exactly the per-panel divergence the
 * fixed primitive set exists to stop.
 */
export function isInlineControl(kind: Field['kind']): boolean {
  return controlFor(kind) === 'checkbox'
}

/* --------------------------------------------------------------- validation --- */

/**
 * What a field's own constraints have to say about its current value, or null when
 * they have nothing to say.
 *
 * **Every one of these is a warning and none is a refusal**, which is the rule the
 * whole field system already follows: `required` is declared-and-ignored on write
 * (`core/fields.ts` says so of `references.min`, and it is true of `required`
 * everywhere), so an inspector that refused to write an empty required field would
 * be inventing enforcement ahead of the renderer, the content API and the importer.
 * `max` on `multiasset` and `references` is the one exception and it is enforced by
 * the *input* — the only place a pick can be refused before it becomes a value — so
 * it is reported here as a state rather than as a complaint.
 *
 * Gathered into one function rather than left in three inputs: `ReferencesInput`
 * had the `min` warning, `MultiAssetInput` had the `max` note, and `required` was a
 * red asterisk with no message at all, so "is this field satisfied" had no single
 * answer anywhere.
 */
export function fieldWarning(field: Field, value: Json): string | null {
  if (field.kind === 'references') {
    const n = asStoryIds(value).length
    if (field.min !== undefined && n < field.min) {
      return `Pick at least ${field.min} — ${n} chosen.`
    }
  }
  if (field.kind === 'multiasset' && field.max !== undefined) {
    const n = asAssets(value).length
    if (n >= field.max) return `Limit of ${field.max} reached.`
  }
  if (field.kind === 'number' && typeof value === 'number') {
    if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}.`
    if (field.max !== undefined && value > field.max) return `Must be at most ${field.max}.`
  }
  if (field.required && isBlank(field, value)) return 'Required — this is still empty.'
  return null
}

/**
 * Whether a value counts as nothing, per kind. `false` and `0` are values, an
 * empty richtext document and a whitespace-only string are not — the same rule
 * `core/locales.ts`'s `isEmptySource` applies when it decides whether a field is
 * work a translator owes, and stated the same way for the same reason.
 */
export function isBlank(field: Field, value: Json): boolean {
  if (value === null || value === undefined) return true
  if (field.kind === 'richtext') return isRichtextEmpty(asRichtext(value))
  if (field.kind === 'boolean' || field.kind === 'number') return false
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (field.kind === 'asset') return asAsset(value) === null
  return false
}

/* --------------------------------------------------------------- focus mode --- */

/**
 * A readable measure, in characters.
 *
 * `docs/ui-architecture.md`'s decision 5 rejects "a wider inspector for everyone" —
 * 340px is right for the twenty other field kinds and wrong for one — so focus mode
 * exists to give prose a measure rather than to give the column pixels. 60–75
 * characters is the band typography has agreed on for a century; 68 is the middle of
 * it, which leaves room to move in either direction without an argument.
 *
 * Expressed in `ch` at the point of use rather than as a pixel width, and that is
 * the load-bearing part: `ch` is the width of the rendered `0`, so the measure stays
 * 68 characters if `--text-lg` changes or a host's font stack resolves differently.
 * A `560px` panel is 68 characters in one font and 84 in another.
 */
export const FOCUS_MEASURE_CH = 68

/** The band above, as a predicate, so a later edit to `FOCUS_MEASURE_CH` fails a
 * Node test rather than quietly making prose unreadable. */
export function isReadableMeasure(ch: number): boolean {
  return ch >= 60 && ch <= 75
}

/**
 * Whether `⌘⏎` means anything for the field that currently has focus.
 *
 * The chord is the shell's (`ui/shortcuts.ts` owns every binding), and the store
 * already knows which field is focused — `focusField` records it for presence — so
 * the shell needs exactly this one predicate to decide whether to open focus mode
 * or do nothing. Richtext only, deliberately: every other kind fits a 340px column,
 * and an overlay for a checkbox is a joke at the editor's expense.
 */
export function canFocus(
  schema: SchemaIndex,
  blok: Blok | null,
  field: string | null,
): field is string {
  if (!blok || !field) return false
  return schema[blok.type]?.fields[field]?.kind === 'richtext'
}

/* ------------------------------------------------------- the source column --- */

/**
 * One source value as display text — what a translator is translating *from*, for
 * every kind except richtext, which renders formatted through the preview's own
 * `RichText`.
 *
 * The same unwrapping `summarise` does, for the same reason: an object value would
 * otherwise read "[object Object]".
 */
export function sourceText(field: Field, value: Json): string {
  if (value === null || value === undefined) return ''
  switch (field.kind) {
    case 'richtext':
      return richtextToText(asRichtext(value))
    case 'asset':
      return asAsset(value)?.filename ?? ''
    case 'multiasset':
      return Array.isArray(value) ? `${value.length} file${value.length === 1 ? '' : 's'}` : ''
    case 'references': {
      // A count, not the ids: raw `sty_…` strings beside a translation input tell
      // a translator nothing they can act on.
      const n = asStoryIds(value).length
      return `${n} document${n === 1 ? '' : 's'}`
    }
    case 'boolean':
      return value ? 'yes' : 'no'
    case 'select': {
      const option = field.options.find((o) => o.value === value)
      return option?.label ?? String(value)
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}
