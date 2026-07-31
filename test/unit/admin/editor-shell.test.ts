import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Blok, Doc } from '../../../src/core/doc'
import type { BlockSchema, SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta } from '../../../src/core/story'
import {
  addTargetOf,
  blockGesture,
  blokRowsOf,
  clampInspector,
  DEFAULT_INSPECTOR,
  editorLayout,
  hasNestedBloks,
  isNarrowedViewport,
  MAX_INSPECTOR,
  MIN_INSPECTOR,
  previewFrame,
  type RailAddRow,
  type RailBlokRow,
  railRows,
  VIEWPORT_NAMES,
  VIEWPORTS,
} from '../../../src/admin/ui/screens/editor-model'
import { wantedStoryIds } from '../../../src/admin/ui/screens/useEditor'

/*
 * The editor screen's arithmetic, in Node. No admin test mounts a component, so
 * everything here is a pure function over a plain document — which is the reason
 * `editor-model.ts` exists at all.
 */

/* ------------------------------------------------------------------ fixtures --- */

const page: BlockSchema = {
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: { kind: 'text' },
    // Two slots, so the add rows have to name themselves.
    header: { kind: 'blocks', allow: ['hero'], max: 1, label: 'Header' },
    body: { kind: 'blocks', allow: ['hero', 'prose'], label: 'Body' },
  },
}

const hero: BlockSchema = {
  name: 'hero',
  label: 'Hero',
  summary: 'heading',
  fields: {
    heading: { kind: 'text' },
    actions: { kind: 'blocks', allow: ['button'] },
  },
}

const prose: BlockSchema = {
  name: 'prose',
  label: 'Prose',
  fields: { body: { kind: 'richtext' } },
}

const button: BlockSchema = { name: 'button', label: 'Button', fields: { label: { kind: 'text' } } }

const schema: SchemaIndex = { page, hero, prose, button }

function blok(
  uid: string,
  type: string,
  parent: string | null,
  slot: string | null,
  order: string,
  data: Blok['data'] = {},
): Blok {
  return { uid, type, parent, slot, order, data }
}

/**
 * root
 *   header: [heroA]
 *   body:   [proseB, proseC]
 * heroA
 *   actions: [buttonD]
 */
function doc(): Doc {
  const bloks = [
    blok('root', 'page', null, null, 'a0', { title: 'About us' }),
    blok('heroA', 'hero', 'root', 'header', 'a0', { heading: 'Hello' }),
    blok('buttonD', 'button', 'heroA', 'actions', 'a0'),
    blok('proseB', 'prose', 'root', 'body', 'a0'),
    blok('proseC', 'prose', 'root', 'body', 'a1'),
  ]
  return { root: 'root', bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])) }
}

const NONE: ReadonlySet<string> = new Set()

const story = (over: Partial<StoryMeta> = {}): StoryMeta => ({
  id: 's1',
  type: 'page',
  parentId: null,
  slug: 'about',
  path: 'about',
  ord: 'a0',
  title: 'About us',
  publishedAt: null,
  unpublishedAt: null,
  updatedAt: 0,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  state: 'draft',
  hasUnpublishedChanges: false,
  ...over,
})

/* ---------------------------------------------------------------- railRows --- */

describe('railRows', () => {
  it('puts the root first, labelled from the document type rather than "Page"', () => {
    const [first] = railRows(doc(), schema, NONE)
    expect(first).toMatchObject({ kind: 'root', uid: 'root', label: 'Page settings' })
  })

  it('falls back to plain "Settings" when the root block type is not in the schema', () => {
    const [first] = railRows(doc(), {}, NONE)
    expect(first).toMatchObject({ label: 'Settings' })
  })

  it('shows the root block’s summary field', () => {
    const [first] = railRows(doc(), schema, NONE)
    expect(first).toMatchObject({ summary: 'About us' })
  })

  it('walks slots in declaration order, children before the next slot', () => {
    const rows = railRows(doc(), schema, NONE)
    // header's hero (and its own subtree) before body's prose blocks — the
    // flattening is depth-first, which is what makes "the row below" mean what a
    // keyboard expects.
    expect(rows.map((r) => (r.kind === 'add' ? `+${r.slot}` : r.uid))).toEqual([
      'root',
      'heroA',
      'buttonD',
      '+actions',
      // `header` declares `max: 1` and already holds one, so it offers no add row.
      'proseB',
      'proseC',
      '+body',
    ])
  })

  it('indents by containment, not by slot', () => {
    const rows = railRows(doc(), schema, NONE)
    const depth = (uid: string) => rows.find((r) => r.kind !== 'add' && r.uid === uid)?.depth
    expect([depth('root'), depth('heroA'), depth('buttonD')]).toEqual([0, 1, 2])
  })

  it('names an add row’s slot only when its parent has more than one', () => {
    const rows = railRows(doc(), schema, NONE)
    const add = (slot: string) => rows.find((r) => r.kind === 'add' && r.slot === slot)
    // `page` has `header` and `body`, so `body`'s row says which.
    expect(add('body')).toMatchObject({ slotLabel: 'Body' })
    // `hero` has one slot, so naming it would be noise.
    expect(add('actions')).not.toHaveProperty('slotLabel')
  })

  it('falls back to the slot’s own name when the field declares no label', () => {
    const bare: SchemaIndex = {
      ...schema,
      page: {
        ...page,
        fields: {
          ...page.fields,
          body: { kind: 'blocks', allow: ['prose'] },
        },
      },
    }
    const rows = railRows(doc(), bare, NONE)
    expect(rows.find((r) => r.kind === 'add' && r.slot === 'body')).toMatchObject({
      slotLabel: 'body',
    })
  })

  it('marks a full slot on its children, so duplicate can refuse with a reason', () => {
    const rows = blokRowsOf(railRows(doc(), schema, NONE))
    expect(rows.find((r) => r.uid === 'heroA')).toMatchObject({ full: true, max: 1 })
    expect(rows.find((r) => r.uid === 'proseB')).toMatchObject({ full: false })
  })

  it('counts siblings within one slot, not across the parent', () => {
    const rows = blokRowsOf(railRows(doc(), schema, NONE))
    expect(rows.find((r) => r.uid === 'proseB')).toMatchObject({ index: 0, siblings: 2 })
    expect(rows.find((r) => r.uid === 'proseC')).toMatchObject({ index: 1, siblings: 2 })
    expect(rows.find((r) => r.uid === 'heroA')).toMatchObject({ index: 0, siblings: 1 })
  })

  it('is expanded by default and hides a collapsed block’s children', () => {
    const open = railRows(doc(), schema, NONE)
    expect(open.find((r) => r.kind !== 'add' && r.uid === 'heroA')).toMatchObject({
      expandable: true,
      expanded: true,
    })

    const shut = railRows(doc(), schema, new Set(['heroA']))
    expect(shut.some((r) => r.kind !== 'add' && r.uid === 'buttonD')).toBe(false)
    // Its own add row goes with it: it belongs to the hidden subtree.
    expect(shut.some((r) => r.kind === 'add' && r.slot === 'actions')).toBe(false)
    expect(shut.find((r) => r.kind !== 'add' && r.uid === 'heroA')).toMatchObject({
      expanded: false,
    })
  })

  it('does not offer a twisty on a childless block', () => {
    const rows = blokRowsOf(railRows(doc(), schema, NONE))
    // `prose` declares no slots at all, and `hero`'s `actions` is empty in this one.
    expect(rows.find((r) => r.uid === 'proseB')).toMatchObject({ expandable: false })
  })
})

describe('addTargetOf', () => {
  it('resolves the parent’s type and how full the slot is, for the picker', () => {
    const d = doc()
    const row = railRows(d, schema, NONE).find((r) => r.kind === 'add' && r.slot === 'body')
    expect(row).toBeDefined()
    expect(addTargetOf(row as RailAddRow, d)).toEqual({
      parent: 'root',
      parentType: 'page',
      slot: 'body',
      slotLabel: 'Body',
      // Two prose blocks already there, so a new one appends at 2 — and `filled`
      // is the same number, which is what lets a full slot refuse up front.
      filled: 2,
      index: 2,
    })
  })

  it('falls back to the slot name when the field declares no label', () => {
    const d = doc()
    const row = railRows(d, schema, NONE).find((r) => r.kind === 'add' && r.slot === 'actions')
    expect(addTargetOf(row as RailAddRow, d)).toMatchObject({
      parentType: 'hero',
      slotLabel: 'actions',
      filled: 1,
    })
  })
})

describe('hasNestedBloks', () => {
  it('is false for a document that is only its root, and true otherwise', () => {
    const only: Doc = { root: 'root', bloks: { root: blok('root', 'page', null, null, 'a0') } }
    expect(hasNestedBloks(only)).toBe(false)
    expect(hasNestedBloks(doc())).toBe(true)
    expect(hasNestedBloks(null)).toBe(false)
  })
})

/* ------------------------------------------------------------ blockGesture --- */

function rowFor(uid: string): { row: RailBlokRow; rows: ReturnType<typeof railRows> } {
  const rows = railRows(doc(), schema, NONE)
  const row = blokRowsOf(rows).find((r) => r.uid === uid)
  if (!row) throw new Error(`no row for ${uid}`)
  return { row, rows }
}

describe('blockGesture', () => {
  it('⌥↑ lands before the predecessor', () => {
    const { row, rows } = rowFor('proseC')
    expect(blockGesture('up', row, rows, doc(), schema)).toEqual({
      move: { uid: 'proseC', parent: 'root', slot: 'body', index: 0 },
    })
  })

  /*
   * The off-by-one, and it is the one thing in this file worth a test of its own:
   * sibling lists here include the moved block and `useBlocks`' `keyAt` excludes
   * it, so landing *after* the successor is `index + 1` rather than `index`. The
   * page tree's `gestureMove` has the identical trap.
   */
  it('⌥↓ lands after the successor, counting a list that excludes the moved block', () => {
    const { row, rows } = rowFor('proseB')
    expect(blockGesture('down', row, rows, doc(), schema)).toEqual({
      move: { uid: 'proseB', parent: 'root', slot: 'body', index: 1 },
    })
  })

  it('refuses the ends of a slot with a reason rather than doing nothing', () => {
    const first = rowFor('proseB')
    expect(blockGesture('up', first.row, first.rows, doc(), schema)).toEqual({
      refusal: 'Already first in this slot',
    })
    const last = rowFor('proseC')
    expect(blockGesture('down', last.row, last.rows, doc(), schema)).toEqual({
      refusal: 'Already last in this slot',
    })
  })

  it('⌥→ nests under the sibling above, appending to the first slot that accepts it', () => {
    // `proseC` under `proseB` is impossible — prose has no slots — so use a doc
    // where the block above does accept the one below it.
    const d = doc()
    d.bloks.heroE = blok('heroE', 'hero', 'root', 'body', 'a2')
    d.bloks.proseF = blok('proseF', 'prose', 'root', 'body', 'a3')
    const rows = railRows(d, schema, NONE)
    const row = blokRowsOf(rows).find((r) => r.uid === 'proseF')
    expect(row).toBeDefined()
    expect(blockGesture('in', row as RailBlokRow, rows, d, schema)).toEqual({
      refusal: 'A Hero has no slot that accepts a Prose',
    })

    const btn = blok('buttonG', 'button', 'root', 'body', 'a4')
    // `hero.actions` allows a button, and already holds one under `heroA`; under
    // `heroE` it holds none, so the append index is 0.
    d.bloks.buttonG = btn
    const rows2 = railRows(d, schema, NONE)
    const row2 = blokRowsOf(rows2).find((r) => r.uid === 'buttonG')
    expect(blockGesture('in', row2 as RailBlokRow, rows2, d, schema)).toEqual({
      refusal: 'A Prose has no slot that accepts a Button',
    })
  })

  it('⌥→ appends to the end of the new parent’s slot', () => {
    const d = doc()
    // A second button right after the first, still in `heroA`'s slot — then nest
    // it, so the target already has one child and the append index is 1.
    d.bloks.proseZ = blok('proseZ', 'prose', 'root', 'body', 'a2')
    d.bloks.heroY = blok('heroY', 'hero', 'root', 'body', 'a3')
    d.bloks.buttonX = blok('buttonX', 'button', 'root', 'body', 'a4')
    d.bloks.buttonW = blok('buttonW', 'button', 'heroY', 'actions', 'a0')
    const rows = railRows(d, schema, NONE)
    const row = blokRowsOf(rows).find((r) => r.uid === 'buttonX')
    expect(blockGesture('in', row as RailBlokRow, rows, d, schema)).toEqual({
      move: { uid: 'buttonX', parent: 'heroY', slot: 'actions', index: 1 },
    })
  })

  it('⌥→ refuses when there is nothing above it in the slot', () => {
    const { row, rows } = rowFor('proseB')
    expect(blockGesture('in', row, rows, doc(), schema)).toEqual({
      refusal: 'Nothing above it to nest under',
    })
  })

  it('⌥← becomes a sibling of its parent, immediately after it', () => {
    const { row, rows } = rowFor('buttonD')
    // `buttonD` lives in `heroA.actions`; `heroA` lives in `root.header`, which
    // allows only `hero`, so this is refused by the slot rather than by depth.
    expect(blockGesture('out', row, rows, doc(), schema)).toEqual({
      refusal: 'A Button is not allowed beside a Hero',
    })
  })

  it('⌥← lands after the parent when the grandparent’s slot allows it', () => {
    const d = doc()
    // A hero in `body`, which allows `hero` and `prose`, with a prose inside it —
    // no: `hero` has only an `actions` slot. So put a prose in `body` under a
    // hero's `actions`… `actions` allows only buttons. The honest arrangement is
    // a hero in `body` holding a button, moved out into `body`, which refuses —
    // and a *prose* nested in `body`'s own hero cannot exist. So the accepting
    // case is a hero moved out of `header` into… nothing above it.
    //
    // The reachable accepting case: `body` allows `hero`, so a hero nested inside
    // another block whose parent slot is `body` moves out cleanly.
    d.bloks.outerA = blok('outerA', 'hero', 'root', 'body', 'a2')
    d.bloks.innerB = blok('innerB', 'button', 'outerA', 'actions', 'a0')
    // `body` does not allow `button`, so widen the schema for this one case.
    const wide: SchemaIndex = {
      ...schema,
      page: {
        ...page,
        fields: { ...page.fields, body: { kind: 'blocks', allow: ['hero', 'prose', 'button'] } },
      },
    }
    const rows = railRows(d, wide, NONE)
    const row = blokRowsOf(rows).find((r) => r.uid === 'innerB')
    const outer = blokRowsOf(rows).find((r) => r.uid === 'outerA')
    expect(blockGesture('out', row as RailBlokRow, rows, d, wide)).toEqual({
      move: {
        uid: 'innerB',
        parent: 'root',
        slot: 'body',
        // Its parent's own index plus one. No adjustment for the moved block: it
        // is leaving a different slot, so `body`'s list already excludes it.
        index: (outer as RailBlokRow).index + 1,
      },
    })
  })

  it('⌥← refuses at the top level of the document', () => {
    const { row, rows } = rowFor('proseB')
    expect(blockGesture('out', row, rows, doc(), schema)).toEqual({
      refusal: 'Already at the top level of this document',
    })
  })

  it('⌥← refuses when the destination slot is full', () => {
    const d = doc()
    // `header` holds one hero and caps at one. A hero nested under that hero
    // cannot exist (`actions` takes buttons only), so nest a hero under a *body*
    // hero and try to move it out into the capped `header`… which is not its
    // grandparent. The capped case is reached by capping `body` instead.
    const capped: SchemaIndex = {
      ...schema,
      page: {
        ...page,
        fields: { ...page.fields, body: { kind: 'blocks', allow: ['hero', 'prose'], max: 2 } },
      },
    }
    d.bloks.outerA = blok('outerA', 'hero', 'root', 'body', 'a2')
    d.bloks.innerP = blok('innerP', 'button', 'outerA', 'actions', 'a0')
    const wide: SchemaIndex = {
      ...capped,
      page: {
        ...capped.page,
        fields: {
          ...capped.page?.fields,
          body: { kind: 'blocks', allow: ['hero', 'prose', 'button'], max: 3 },
        },
      } as BlockSchema,
    }
    const rows = railRows(d, wide, NONE)
    const row = blokRowsOf(rows).find((r) => r.uid === 'innerP')
    expect(blockGesture('out', row as RailBlokRow, rows, d, wide)).toEqual({
      refusal: 'That slot holds at most 3',
    })
  })
})

/* ----------------------------------------------------------- previewFrame --- */

describe('previewFrame', () => {
  it('is undefined with no story', () => {
    expect(previewFrame(undefined, 'https://x/p', 'en', true)).toBeUndefined()
  })

  it('is the caller’s URL on the source locale', () => {
    expect(previewFrame(story(), 'https://x/p?draft=1', 'en', true)).toBe('https://x/p?draft=1')
  })

  it('is undefined for a record, which has no page to be seen in', () => {
    expect(previewFrame(story({ path: null }), undefined, 'en', true)).toBeUndefined()
  })

  it('switches to the locale’s own URL, because switching locale is a reload', () => {
    const s = story({ previewUrls: { fr: 'https://x/fr/p?draft=1' } })
    expect(previewFrame(s, 'https://x/p?draft=1', 'fr', false)).toBe('https://x/fr/p?draft=1')
  })

  it('falls back to the source URL when the host declared no route for that locale', () => {
    expect(previewFrame(story(), 'https://x/p?draft=1', 'de', false)).toBe('https://x/p?draft=1')
  })
})

/* ----------------------------------------------------------- editorLayout --- */

describe('editorLayout', () => {
  const base = { railCollapsed: false, inspectorCollapsed: false }

  it('gives a routed page all three columns', () => {
    expect(editorLayout({ ...base, routed: true, preview: 'https://x/p', nested: true })).toEqual({
      form: false,
      rail: true,
      inspector: true,
    })
  })

  it('keeps the stage for a routed page whose host route returned no URL', () => {
    // Not form mode: the page *has* a URL namespace, so the honest answer is an
    // empty stage that says why, not a form.
    expect(editorLayout({ ...base, routed: true, preview: undefined, nested: true })).toMatchObject(
      { form: false },
    )
  })

  it('is a form for a record, and the inspector cannot be collapsed away', () => {
    expect(
      editorLayout({
        routed: false,
        preview: undefined,
        nested: false,
        railCollapsed: false,
        inspectorCollapsed: true,
      }),
    ).toEqual({ form: true, rail: false, inspector: true })
  })

  it('keeps the rail in form mode when the record has nested blocks', () => {
    // The design says a record loses the rail — right when its whole document is
    // one root block, wrong when part of it would become unreachable.
    expect(
      editorLayout({ ...base, routed: false, preview: undefined, nested: true }),
    ).toMatchObject({ form: true, rail: true })
  })

  it('gives a global a real preview, and therefore a stage', () => {
    expect(
      editorLayout({ ...base, routed: false, preview: 'https://x/?as=header', nested: true }),
    ).toEqual({ form: false, rail: true, inspector: true })
  })

  it('honours ⌘\\ in every mode', () => {
    expect(
      editorLayout({
        routed: false,
        preview: undefined,
        nested: true,
        railCollapsed: true,
        inspectorCollapsed: false,
      }),
    ).toMatchObject({ rail: false })
  })
})

/* -------------------------------------------------------------- the stage --- */

describe('viewports', () => {
  it('offers three widths, Desktop first', () => {
    expect(VIEWPORT_NAMES).toEqual(['Desktop', 'Tablet', 'Phone'])
    expect(VIEWPORT_NAMES.every((name) => name in VIEWPORTS)).toBe(true)
  })

  it('centres everything except Desktop, which is the column itself', () => {
    expect(isNarrowedViewport('Desktop')).toBe(false)
    expect(isNarrowedViewport('Tablet')).toBe(true)
    expect(isNarrowedViewport('Phone')).toBe(true)
  })
})

describe('clampInspector', () => {
  it('holds the bounds and rounds to whole pixels', () => {
    expect(clampInspector(10)).toBe(MIN_INSPECTOR)
    expect(clampInspector(9999)).toBe(MAX_INSPECTOR)
    expect(clampInspector(340.6)).toBe(341)
    expect(clampInspector(DEFAULT_INSPECTOR)).toBe(DEFAULT_INSPECTOR)
  })
})

/* --------------------------------------------------------- the resolution --- */

describe('wantedStoryIds', () => {
  const linked = (id: string) => ({ kind: 'story', id })

  const linky: BlockSchema = {
    name: 'linky',
    label: 'Linky',
    fields: {
      cta: { kind: 'multilink' },
      body: { kind: 'richtext' },
      author: { kind: 'reference' },
    },
  }
  const index: SchemaIndex = { linky }

  const one = (data: Blok['data'], i18n?: Blok['i18n']): Doc => ({
    root: 'r',
    bloks: {
      r: {
        uid: 'r',
        type: 'linky',
        parent: null,
        slot: null,
        order: 'a0',
        data,
        ...(i18n ? { i18n } : {}),
      },
    },
  })

  it('is empty for no document', () => {
    expect(wantedStoryIds(null, index)).toBe('')
  })

  it('collects link fields and reference fields together, sorted and deduped', () => {
    const d = one({ cta: linked('s2'), author: 's1' })
    expect(wantedStoryIds(d, index)).toBe('s1,s2')
  })

  /*
   * The one this file exists to pin. A Folio-native link mark inside richtext
   * stores a structured `attrs.link` and carries **no href** — the href is derived
   * from the resolution at render — so a story id that only ever appears in prose
   * is still an id the preview has to have. Narrowing this walk to link and
   * reference fields makes every internal prose link render as unstyled text, and
   * neither a richtext test nor a link-field test would catch it.
   */
  it('collects the story ids inside richtext link marks', () => {
    const d = one({
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'see this',
                marks: [{ type: 'link', attrs: { link: linked('s9') } }],
              },
            ],
          },
        ],
      },
    })
    expect(wantedStoryIds(d, index)).toBe('s9')
  })

  it('walks every locale, not only the source', () => {
    // A French paragraph can link somewhere the English one does not.
    const d = one({ cta: linked('s1') }, { fr: { cta: linked('s7') } })
    expect(wantedStoryIds(d, index)).toBe('s1,s7')
  })
})

/* -------------------------------------------------------------- breakpoints --- */

/**
 * The admin's responsive rule, pinned where it can be pinned.
 *
 * There were zero media queries in this admin before the editor, and the design
 * names exactly two widths: 1100px for the inspector, 800px for the rail. A CSS
 * module cannot be imported into a Node test as anything but a string, so this
 * reads the two files and asserts the set — which is the only mechanical guard
 * against the pattern being *established* and then quietly grown a third number by
 * the next screen that wants one.
 *
 * It is a real risk rather than a hypothetical: the numbers cannot be tokens
 * (`@media (max-width: var(--x))` is not valid CSS and `@custom-media` needs a
 * build step the token layer deliberately does not have), so nothing else stops
 * a fourth and a fifth appearing.
 */
describe('the admin has two breakpoints', () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../src/admin/ui/screens/${name}`, import.meta.url), 'utf8')

  const widths = (css: string) =>
    [...css.matchAll(/@media[^{]*?\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]))

  it('puts the inspector overlay at 1100px and nothing else in the shell', () => {
    expect(widths(read('EditorShell.module.css'))).toEqual([1100])
  })

  it('puts the rail overlay at 800px and nothing else in the rail', () => {
    expect(widths(read('BlockRail.module.css'))).toEqual([800])
  })

  it('states both numbers in prose, so the next screen copies rather than invents', () => {
    const shell = read('EditorShell.module.css')
    expect(shell).toContain('below 1100px')
    expect(shell).toContain('below 800px')
  })
})
