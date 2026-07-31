/**
 * The editor's arithmetic: what rows the block rail draws, what a keyboard
 * gesture on one of them means, which URL the stage loads, and which of the three
 * columns exist at all.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts` is the pattern; this is the editor's instance
 * of it, and the shapes below are deliberately its neighbours' shapes: a rail row
 * is a `TreeRow` by another name, and `blockGesture` is `gestureMove` over bloks
 * instead of stories, down to the same off-by-one on a downward move.
 *
 * What is **not** here is anything that already exists. The document store, the
 * block mutations, the preview bridge, versions, publish and the migration status
 * are hooks under `admin/hooks/` and stay there; four small pure functions the old
 * admin already tested (`menuGroups`, `rootSettingsLabel`, `publishStatus`,
 * `globalPreviewUrl`) are imported by `EditorShell.tsx` rather than restated here.
 * This file holds the arithmetic the *new layout* needs and nothing else.
 */
import { childrenOf, type Doc } from '../../../core/doc'
import type { LocaleContext } from '../../../core/locales'
import { type SchemaIndex, slotsOf, summarise } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'

/* ----------------------------------------------------------------- the rail --- */

/**
 * The root block's own row. Selectable, because that is how page metadata gets
 * edited: title, description and so on are ordinary fields on it, so they inherit
 * sync, undo and versioning instead of needing a separate save path.
 */
export interface RailRootRow {
  kind: 'root'
  uid: string
  /** "Page settings", "Person settings" — the *type's* label, not "Page". */
  label: string
  summary: string
  depth: 0
}

/** One block. */
export interface RailBlokRow {
  kind: 'blok'
  uid: string
  type: string
  label: string
  summary: string
  depth: number
  parent: string
  slot: string
  /** Position among the siblings **including itself**, which is the counting
   * `blockGesture` documents and adjusts for. */
  index: number
  siblings: number
  /** A twisty belongs here: this block has at least one child. */
  expandable: boolean
  expanded: boolean
  /** The containing slot's cap, when it declares one. */
  max?: number
  /** The containing slot is at its cap, so duplicate is refused here for the same
   * reason the add row is absent (`useBlocks`'s `fullSlotMessage`). */
  full: boolean
}

/**
 * The `+ Add` affordance for one slot, as a row rather than a control hanging off
 * the block above it — which is what makes the rail one flat list, and therefore
 * one roving-tabindex `List` with one keyboard model.
 */
export interface RailAddRow {
  kind: 'add'
  parent: string
  slot: string
  /**
   * The slot's own label, and only when its parent has more than one slot.
   *
   * The old rail drew a bare `+ Add block` per slot, so a block with `header` and
   * `body` showed two identical buttons in a row and the only way to tell them
   * apart was to click one. Naming them costs nothing and is a real fix; naming
   * the *only* slot would be noise, which is why this is conditional.
   */
  slotLabel?: string
  depth: number
  /** Where a new block lands: the end of the slot. */
  index: number
  allow: readonly string[]
}

export type RailRow = RailRootRow | RailBlokRow | RailAddRow

/**
 * What the root row is called: "Page settings", "Person settings", and plain
 * "Settings" when the root block type is not in the schema at all. Carried over
 * from `BlockTree.tsx`'s `rootSettingsLabel` — the document type's own label
 * rather than "Page", because a person record's root block is not page settings.
 */
function rootLabel(label: string | undefined): string {
  return label ? `${label} settings` : 'Settings'
}

/**
 * The rail's rows, in the order they appear, flattened.
 *
 * The flattening is the point: `List`'s roving tabindex walks the rows that are
 * *on screen*, so "the next row" has to be a well-defined thing before ↑ ↓ or the
 * ⌥ gestures mean anything. The old rail was nested `<ul>`s with a `<div onClick>`
 * per row and no roles at all, which is why it could not be navigated by keyboard
 * and why Biome's a11y rules were off for it.
 *
 * `collapsed` is a set of uids whose children are hidden — **collapsed** rather
 * than expanded, so the default state of a document nobody has touched is fully
 * open. A block tree is shallow and an editor arriving at one wants to see it;
 * `Content`'s tree is the opposite because a site is wide and each level costs a
 * request. Same control, opposite default, for a reason.
 */
export function railRows(
  doc: Doc,
  schema: SchemaIndex,
  collapsed: ReadonlySet<string>,
  localeCtx?: LocaleContext,
): RailRow[] {
  const root = doc.bloks[doc.root]
  const rootDef = schema[root?.type ?? '']
  const out: RailRow[] = [
    {
      kind: 'root',
      uid: doc.root,
      label: rootLabel(rootDef?.label),
      summary: rootDef ? summarise(rootDef, root, localeCtx) : '',
      depth: 0,
    },
  ]

  const walk = (parent: string, depth: number): void => {
    const slots = slotsOf(schema[doc.bloks[parent]?.type ?? ''])
    for (const [slot, field] of slots) {
      const kids = childrenOf(doc, parent, slot)
      const full = field.max !== undefined && kids.length >= field.max
      kids.forEach((blok, index) => {
        const def = schema[blok.type]
        const expandable = slotsOf(def).some(
          ([childSlot]) => childrenOf(doc, blok.uid, childSlot).length > 0,
        )
        out.push({
          kind: 'blok',
          uid: blok.uid,
          type: blok.type,
          label: def?.label ?? blok.type,
          summary: summarise(def, blok, localeCtx),
          depth,
          parent,
          slot,
          index,
          siblings: kids.length,
          expandable,
          expanded: expandable && !collapsed.has(blok.uid),
          ...(field.max === undefined ? {} : { max: field.max }),
          full,
        })
        if (expandable && !collapsed.has(blok.uid)) walk(blok.uid, depth + 1)
      })
      // A slot with nothing allowed in it, or already at its cap, offers no row —
      // the same rule the old add menu applied by hiding itself.
      if (field.allow.length > 0 && !full) {
        out.push({
          kind: 'add',
          parent,
          slot,
          ...(slots.length > 1 ? { slotLabel: field.label ?? slot } : {}),
          depth,
          index: kids.length,
          allow: field.allow,
        })
      }
    }
  }
  walk(doc.root, 1)
  return out
}

/** The blok rows of a rail, which is what a keyboard gesture acts on and what
 * `List`'s row indices count. */
export function blokRowsOf(rows: readonly RailRow[]): RailBlokRow[] {
  return rows.filter((row): row is RailBlokRow => row.kind === 'blok')
}

/** Whether this document has anything under its root at all — the one fact form
 * mode needs about it. See `editorLayout`. */
export function hasNestedBloks(doc: Doc | null): boolean {
  if (!doc) return false
  return Object.values(doc.bloks).some((blok) => blok.uid !== doc.root)
}

/* ------------------------------------------------------------- the keyboard --- */

/** What a gesture asks `useBlocks`' `move` to do. */
export interface BlockMove {
  uid: string
  parent: string
  slot: string
  /**
   * Counted into the sibling list **excluding the block being moved**, which is
   * what `useBlocks`' `keyAt(parent, slot, index, ignore)` compares against.
   * Getting this wrong is an off-by-one that only shows on a downward move — the
   * identical trap `content-model.ts`'s `Move` documents, because it is the
   * identical arithmetic.
   */
  index: number
}

export type BlockGesture = 'up' | 'down' | 'out' | 'in'

/**
 * The `BlockMove` a gesture produces, or a refusal.
 *
 * Ordinary outliner semantics, matching the page tree's exactly so one keyboard
 * map covers both: `up`/`down` (`⌥↑ ⌥↓`) stay inside one slot, `in` (`⌥→`) makes
 * the block the last child of the sibling above it, `out` (`⌥←`) makes it a
 * sibling of its own parent, placed just after it.
 *
 * **Every refusal carries a reason**, and that is what this function is for.
 * `useBlocks`' own `move` already guards the same rules — a cycle, a type the
 * slot does not allow — but it guards them by returning silently, which is
 * correct for a drag (you dropped somewhere impossible; nothing happened) and
 * wrong for a keystroke, where nothing happening is indistinguishable from a
 * broken shortcut. So the arithmetic is here, with the words, and `move` stays
 * the backstop it is.
 *
 * The index arithmetic, since it is the part that is easy to get wrong. Sibling
 * lists here *include* the moved block and `keyAt` excludes it:
 *
 * - `up`: the block is at `index`; landing before its predecessor is exclusive
 *   index `index - 1`.
 * - `down`: removing the block shifts its successor down to exclusive index
 *   `index`, so landing after it is `index + 1`.
 * - `in` / `out`: the block leaves the slot entirely, so that slot's own list
 *   already excludes it and no adjustment applies.
 */
export function blockGesture(
  gesture: BlockGesture,
  at: RailBlokRow,
  rows: readonly RailRow[],
  doc: Doc,
  schema: SchemaIndex,
): { move: BlockMove } | { refusal: string } {
  if (gesture === 'up' || gesture === 'down') {
    if (gesture === 'up' && at.index === 0) return { refusal: 'Already first in this slot' }
    if (gesture === 'down' && at.index >= at.siblings - 1) {
      return { refusal: 'Already last in this slot' }
    }
    return {
      move: {
        uid: at.uid,
        parent: at.parent,
        slot: at.slot,
        index: gesture === 'up' ? at.index - 1 : at.index + 1,
      },
    }
  }

  if (gesture === 'in') {
    const above = blokRowsOf(rows).find(
      (row) => row.parent === at.parent && row.slot === at.slot && row.index === at.index - 1,
    )
    if (!above) return { refusal: 'Nothing above it to nest under' }
    const target = accepting(doc, schema, above.uid, at.type)
    if ('refusal' in target) {
      return { refusal: `A ${above.label} has no slot that accepts a ${at.label}` }
    }
    return { move: { uid: at.uid, parent: above.uid, slot: target.slot, index: target.count } }
  }

  // `out`: a sibling of the parent, immediately after it.
  const parentRow = blokRowsOf(rows).find((row) => row.uid === at.parent)
  if (!parentRow) return { refusal: 'Already at the top level of this document' }
  const field = slotsOf(schema[doc.bloks[parentRow.parent]?.type ?? '']).find(
    ([slot]) => slot === parentRow.slot,
  )?.[1]
  if (!field?.allow.includes(at.type)) {
    return { refusal: `A ${at.label} is not allowed beside a ${parentRow.label}` }
  }
  if (
    field.max !== undefined &&
    childrenOf(doc, parentRow.parent, parentRow.slot).length >= field.max
  ) {
    return { refusal: `That slot holds at most ${field.max}` }
  }
  return {
    move: {
      uid: at.uid,
      parent: parentRow.parent,
      slot: parentRow.slot,
      index: parentRow.index + 1,
    },
  }
}

/** The first slot on `parent` that accepts `type` and has room, with how many
 * children it already has — the append position `in` needs. */
function accepting(
  doc: Doc,
  schema: SchemaIndex,
  parent: string,
  type: string,
): { slot: string; count: number } | { refusal: true } {
  for (const [slot, field] of slotsOf(schema[doc.bloks[parent]?.type ?? ''])) {
    if (!field.allow.includes(type)) continue
    const count = childrenOf(doc, parent, slot).length
    if (field.max !== undefined && count >= field.max) continue
    return { slot, count }
  }
  return { refusal: true }
}

/* ---------------------------------------------------------------- the stage --- */

/**
 * Stage widths. The value is the CSS width the frame is given, not a breakpoint —
 * carried over from the old top bar, which had the same three and the same note.
 */
export const VIEWPORTS = { Desktop: '100%', Tablet: '834px', Phone: '390px' } as const
export type Viewport = keyof typeof VIEWPORTS

/** In declaration order, stated rather than taken from `Object.keys` so the order
 * on screen is not a property of how the object above happens to be written. */
export const VIEWPORT_NAMES: readonly Viewport[] = ['Desktop', 'Tablet', 'Phone']

/**
 * Whether the stage centres the frame with `--bg-app` either side, which is what
 * makes a narrowed viewport read as a device rather than as a page that failed to
 * fill its column (`ui-architecture.md`, the editor).
 */
export function isNarrowedViewport(viewport: Viewport): boolean {
  return viewport !== 'Desktop'
}

/**
 * The iframe src for the open document in the locale being edited.
 *
 * `preview` is the caller's answer for the source locale and covers the two cases
 * that need something the editor does not hold: a page's own `previewUrl`,
 * computed server-side by the host's `route` function, and a global's, which
 * `globalPreviewUrl` puts on top of a real host page. This adds the third fact,
 * which is the editor's own: **switching locale is a reload**, not a pushed frame
 * (`localisation.md` decision 6), because the host's chrome, its `<html lang>`
 * and possibly its stylesheet all change and no postMessage reaches those.
 *
 * Falls back to the source URL when the host declared no route for this locale,
 * which is better than an empty frame: the page renders in the source language
 * and the inspector is still editing the translation.
 */
export function previewFrame(
  story: StoryMeta | undefined,
  preview: string | undefined,
  locale: string,
  isSourceLocale: boolean,
): string | undefined {
  if (!story) return undefined
  if (!isSourceLocale) return story.previewUrls?.[locale] ?? preview
  return preview
}

/* --------------------------------------------------------------- the layout --- */

export interface EditorLayout {
  /**
   * No stage at all: this document has no page to be seen in, so its fields
   * *are* the screen — one centred form at a readable measure
   * (`data-documents.md` checkpoint 3, restated by `ui-architecture.md`).
   */
  form: boolean
  /** The block rail is on screen. */
  rail: boolean
  /** The inspector is on screen. In form mode it *is* the screen, so it cannot
   * be collapsed away — a collapse that empties the surface is a broken screen,
   * and `⌘.`'s control is hidden there rather than disabled. */
  inspector: boolean
}

/**
 * Which of the three columns exist.
 *
 * The one judgement in here is the rail in form mode. `ui-architecture.md` says a
 * record loses it — "minus the 240px rail spent on one row" — and that is right
 * for the common case, where a record's whole document is its root block. It is
 * wrong for the record that has nested blocks (the spec's own example is a
 * person's list of accreditations): with no rail and no preview to click, a block
 * below the root would be unreachable by any means. So the rail follows the
 * document rather than the mode, and `⌘\` still hides it either way.
 *
 * **Rejected: always hiding it in form mode**, which is what the design literally
 * says and which makes part of a document uneditable. **Rejected: always showing
 * it**, which is the 240px-for-one-row the design objects to.
 */
export function editorLayout(opts: {
  /** `story.path !== null`: a page has a URL, a record and a singleton do not. */
  routed: boolean
  /** What `previewFrame` answered. A global is unrouted *and* previewable, which
   * is why this is the input rather than `routed` alone. */
  preview: string | undefined
  /** Does the document have anything under its root? See `hasNestedBloks`. */
  nested: boolean
  railCollapsed: boolean
  inspectorCollapsed: boolean
}): EditorLayout {
  const form = !opts.routed && opts.preview === undefined
  return {
    form,
    rail: opts.railCollapsed ? false : form ? opts.nested : true,
    inspector: form ? true : !opts.inspectorCollapsed,
  }
}

/**
 * The inspector's width, in px: 340 to start, resizable from there.
 *
 * 340 is `ui-architecture.md`'s number, up from the old fixed 300, and the resize
 * is what makes it a starting point rather than a second fixed value. The bounds
 * are the honest ones: below `MIN` the field labels wrap, above `MAX` the stage
 * stops being the hero on a laptop.
 */
export const DEFAULT_INSPECTOR = 340
export const MIN_INSPECTOR = 260
export const MAX_INSPECTOR = 640

/** The width a drag or an arrow key lands on, clamped. Pure so the clamping is
 * tested without a pointer. */
export function clampInspector(width: number): number {
  return Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, Math.round(width)))
}
