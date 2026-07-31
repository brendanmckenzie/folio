import { describe, expect, it } from 'vitest'
import {
  addTarget,
  bareDescription,
  entriesFor,
  groupRanked,
  presetDescription,
  slotOffer,
} from '../../../src/admin/ui/screens/block-picker-model'
import { rank } from '../../../src/admin/ui/rank'
import type { Blok, Doc } from '../../../src/core/doc'
import type { BlockSchema, SchemaIndex } from '../../../src/core/schema'

/**
 * The block picker's arithmetic, in Node with nothing mounted.
 *
 * The correctness point of the whole piece is the first `describe` below: **a
 * picker that offers a block the slot will refuse is worse than no picker**, so
 * `allow` and `max` are pinned four ways, one per refusal. Everything after it is
 * about legibility — the derived description, the grouping, and where `⌘⇧A` lands.
 */

const button: BlockSchema = {
  name: 'button',
  label: 'Button',
  fields: {
    label: { kind: 'text', label: 'Label' },
    href: { kind: 'text' },
  },
  presets: [
    { name: 'primary', label: 'Primary', data: { label: 'Buy now' } },
    { name: 'ghost', label: 'Ghost' },
  ],
}

const image: BlockSchema = {
  name: 'image',
  label: 'Image',
  fields: {
    file: { kind: 'asset', label: 'Image' },
    alt: { kind: 'text', label: 'Alt text' },
    caption: { kind: 'text', label: 'Caption' },
    credit: { kind: 'text', label: 'Credit' },
    ratio: { kind: 'text', label: 'Crop' },
  },
}

const hero: BlockSchema = {
  name: 'hero',
  label: 'Hero',
  fields: {
    heading: { kind: 'text', label: 'Heading' },
    body: { kind: 'textarea', label: 'Body' },
    actions: { kind: 'blocks', label: 'Actions', allow: ['button'], max: 2 },
  },
  presets: [
    {
      name: 'dark',
      label: 'Dark hero',
      data: { heading: 'Hello' },
      children: [
        { slot: 'actions', type: 'button' },
        { slot: 'actions', type: 'button', preset: 'ghost' },
      ],
    },
  ],
}

/** Purely structural: one slot, no values of its own. */
const section: BlockSchema = {
  name: 'section',
  label: 'Section',
  fields: { body: { kind: 'blocks', label: 'Body', allow: ['hero', 'image'] } },
}

/** Only its presets are offered, so the bare block must never appear. */
const card: BlockSchema = {
  name: 'card',
  label: 'Card',
  fields: { title: { kind: 'text', label: 'Title' } },
  presetsOnly: true,
  presets: [{ name: 'wide', label: 'Wide card' }],
}

const page: BlockSchema = {
  name: 'page',
  label: 'Page',
  fields: {
    title: { kind: 'text', label: 'Title' },
    body: { kind: 'blocks', label: 'Body', allow: ['hero', 'image', 'section', 'card'] },
    aside: { kind: 'blocks', label: 'Aside', allow: ['button'], max: 1 },
    nothing: { kind: 'blocks', label: 'Nothing', allow: [] },
  },
}

const schema: SchemaIndex = { button, image, hero, section, card, page }

describe('what a slot accepts', () => {
  it('offers exactly the types in `allow`, in that order', () => {
    const offer = slotOffer(schema, 'page', 'body', 0)
    expect(offer.refusal).toBeNull()
    expect(offer.slotLabel).toBe('Body')
    // `card` is presetsOnly, so its bare entry is absent and its preset is not.
    expect(offer.entries.map((e) => e.id)).toEqual([
      'hero',
      'hero/dark',
      'image',
      'section',
      'card/wide',
    ])
  })

  it('never offers a type the slot does not allow', () => {
    const offer = slotOffer(schema, 'hero', 'actions', 0)
    expect(offer.entries.map((e) => e.type)).toEqual(['button', 'button', 'button'])
    expect(offer.entries.some((e) => e.type === 'image')).toBe(false)
  })

  it('refuses a full slot, in the same words duplicate and paste use', () => {
    expect(slotOffer(schema, 'page', 'aside', 1)).toMatchObject({
      refusal: 'Aside is full — this slot holds one block.',
      entries: [],
    })
    expect(slotOffer(schema, 'hero', 'actions', 2).refusal).toBe(
      'Actions is full — this slot holds at most 2 blocks.',
    )
    // Under the cap it offers normally, and `max` is only a ceiling.
    expect(slotOffer(schema, 'hero', 'actions', 1).refusal).toBeNull()
  })

  it('refuses a slot whose allow list is empty', () => {
    expect(slotOffer(schema, 'page', 'nothing', 0)).toMatchObject({
      refusal: 'Nothing allows no block types.',
      entries: [],
    })
  })

  it('refuses a field that is not a slot, and a parent type it does not know', () => {
    expect(slotOffer(schema, 'page', 'title', 0).refusal).toBe('‘title’ is not a slot on Page.')
    expect(slotOffer(schema, 'nope', 'body', 0).refusal).toBe(
      '‘nope’ is not in the schema, so its slots are unknown.',
    )
  })

  it('keeps the slot label on a refusal, so the dialog still names where it is', () => {
    expect(slotOffer(schema, 'page', 'aside', 9).slotLabel).toBe('Aside')
    // Falls back to the field name when the slot declares no label.
    expect(slotOffer(schema, 'button', 'href', 0).slotLabel).toBe('href')
  })
})

describe('entries', () => {
  it('describes a plain block by the fields it holds', () => {
    const entry = entriesFor(schema, ['image'])[0]!
    expect(entry.description).toBe('Image, Alt text, Caption, Credit +1 more')
  })

  it('describes a structural block by what goes inside it', () => {
    expect(bareDescription(schema, section)).toBe('holds Hero, Image')
  })

  it('describes a block with both', () => {
    expect(bareDescription(schema, hero)).toBe('Heading, Body · holds Button')
  })

  it('has something to say about a block with no fields at all', () => {
    expect(bareDescription(schema, { name: 'rule', label: 'Rule', fields: {} })).toBe(
      'No fields of its own.',
    )
  })

  it('describes a preset by its type, what it sets and what it plants', () => {
    const entry = entriesFor(schema, ['hero']).find((e) => e.preset === 'dark')!
    expect(entry.description).toBe('Hero with Heading set, and Button ×2 inside')
  })

  it('names a preset that only sets, and one that only plants', () => {
    expect(presetDescription(schema, button, 'Button', button.presets![0]!)).toBe(
      'Button with Label set',
    )
    expect(
      presetDescription(schema, section, 'Section', {
        name: 'x',
        label: 'X',
        children: [{ slot: 'body', type: 'image' }],
      }),
    ).toBe('Section with Image inside')
    // A preset that does neither is still a preset, and saying so beats inventing
    // a sentence for it.
    expect(presetDescription(schema, button, 'Button', { name: 'y', label: 'Y' })).toBe('Button')
  })

  it('hides the bare block of a presetsOnly type', () => {
    expect(entriesFor(schema, ['card']).map((e) => e.id)).toEqual(['card/wide'])
  })

  it('groups a preset under its own type', () => {
    for (const entry of entriesFor(schema, ['hero'])) expect(entry.group).toBe('Hero')
  })

  it('falls back to the type name for a block the schema does not have', () => {
    expect(entriesFor(schema, ['ghost'])).toEqual([
      {
        id: 'ghost',
        type: 'ghost',
        label: 'ghost',
        description: 'Not in the schema.',
        group: 'ghost',
        bare: true,
        keywords: 'ghost ',
      },
    ])
  })
})

describe('search', () => {
  const entries = slotOffer(schema, 'page', 'body', 0).entries
  const ids = (q: string) => rank(q, entries).map((hit) => hit.item.id)

  it('finds a block by its label', () => {
    expect(ids('hero')[0]).toBe('hero')
  })

  it('finds a block by a field label nobody would think to name', () => {
    // `settings-model.ts`'s trick: the field labels are keywords, so `alt` answers
    // "which block has one of those" without a synonym list.
    expect(ids('alt')).toContain('image')
  })

  it('finds a preset by its own name', () => {
    expect(ids('dark')).toEqual(['hero/dark'])
  })

  it('shows everything, in declaration order, for an empty query', () => {
    expect(ids('')).toEqual(entries.map((e) => e.id))
  })

  it('answers nothing for a query that matches nothing', () => {
    expect(ids('zzzz')).toEqual([])
  })
})

describe('grouping the ranked list', () => {
  const entries = slotOffer(schema, 'page', 'body', 0).entries

  it('keeps groups in first-appearance order and indexes rows into the flat list', () => {
    const groups = groupRanked(rank('', entries))
    expect(groups.map((g) => g.label)).toEqual(['Hero', 'Image', 'Section', 'Card'])
    expect(groups.flatMap((g) => g.rows.map((r) => r.at))).toEqual([0, 1, 2, 3, 4])
  })

  it('drops the heading for a lone plain block, because the row is its own heading', () => {
    const groups = groupRanked(rank('', entries))
    expect(groups.find((g) => g.label === 'Image')!.solo).toBe(true)
    // Two entries under Hero, so the heading is doing work.
    expect(groups.find((g) => g.label === 'Hero')!.solo).toBe(false)
    // One entry, but it is a preset, so the heading is what says what it presets.
    expect(groups.find((g) => g.label === 'Card')!.solo).toBe(false)
  })

  it('narrows to one group when the query does', () => {
    const groups = groupRanked(rank('dark', entries))
    expect(groups.map((g) => g.label)).toEqual(['Hero'])
    expect(groups[0]!.solo).toBe(false)
  })
})

/* ------------------------------------------------------------------ target --- */

const blok = (uid: string, type: string, extra: Partial<Blok> = {}): Blok => ({
  uid,
  type,
  parent: null,
  slot: null,
  order: 'a0',
  data: {},
  ...extra,
})

const doc: Doc = {
  root: 'root',
  bloks: {
    root: blok('root', 'page'),
    h1: blok('h1', 'hero', { parent: 'root', slot: 'body', order: 'a0' }),
    i1: blok('i1', 'image', { parent: 'root', slot: 'body', order: 'a1' }),
    b1: blok('b1', 'button', { parent: 'h1', slot: 'actions', order: 'a0' }),
  },
}

describe('where ⌘⇧A lands', () => {
  it('adds a sibling immediately after the selection', () => {
    expect(addTarget(doc, schema, 'h1')).toEqual({ parent: 'root', slot: 'body', index: 1 })
    expect(addTarget(doc, schema, 'i1')).toEqual({ parent: 'root', slot: 'body', index: 2 })
  })

  it('does not descend into the selection, even when it has an empty slot', () => {
    // `h1` owns an `actions` slot with room in it; the target is still beside the
    // hero, so pressing the chord twice adds two siblings rather than nesting.
    expect(addTarget(doc, schema, 'h1')).toMatchObject({ parent: 'root' })
  })

  it('appends to the root’s first usable slot when the page itself is selected', () => {
    expect(addTarget(doc, schema, 'root')).toEqual({ parent: 'root', slot: 'body', index: 2 })
  })

  it('skips a root slot that allows nothing, and one that is full', () => {
    const narrow: SchemaIndex = {
      ...schema,
      page: {
        ...page,
        fields: {
          nothing: { kind: 'blocks', label: 'Nothing', allow: [] },
          aside: { kind: 'blocks', label: 'Aside', allow: ['button'], max: 1 },
          body: { kind: 'blocks', label: 'Body', allow: ['hero'] },
        },
      },
    }
    const filled: Doc = {
      root: 'root',
      bloks: {
        root: blok('root', 'page'),
        a1: blok('a1', 'button', { parent: 'root', slot: 'aside', order: 'a0' }),
      },
    }
    expect(addTarget(filled, narrow, 'root')).toEqual({ parent: 'root', slot: 'body', index: 0 })
  })

  it('refuses when the selection’s own slot is full', () => {
    const full: Doc = {
      root: 'root',
      bloks: {
        root: blok('root', 'page'),
        h1: blok('h1', 'hero', { parent: 'root', slot: 'body', order: 'a0' }),
        b1: blok('b1', 'button', { parent: 'h1', slot: 'actions', order: 'a0' }),
        b2: blok('b2', 'button', { parent: 'h1', slot: 'actions', order: 'a1' }),
      },
    }
    expect(addTarget(full, schema, 'b1')).toEqual({
      error: 'Cannot add another: this slot holds at most 2 blocks.',
    })
  })

  it('treats no selection as the page itself, which is the state on first load', () => {
    // Nothing has been clicked yet, and `⌘⇧A` then means "add a block to this
    // page". A refusal here would make the chord depend on the shell having
    // selected the root, which the old editor did and a new one need not.
    expect(addTarget(doc, schema, null)).toEqual({ parent: 'root', slot: 'body', index: 2 })
  })

  it('treats a selection the document no longer has the same way', () => {
    // A peer deleted the block while the chord was in the air.
    expect(addTarget(doc, schema, 'gone')).toEqual({ parent: 'root', slot: 'body', index: 2 })
  })

  it('refuses a root block with no slots at all', () => {
    const flat: Doc = { root: 'root', bloks: { root: blok('root', 'button') } }
    expect(addTarget(flat, schema, 'root')).toEqual({ error: 'Button has no slots to add to.' })
  })

  it('refuses when every root slot is full or accepts nothing', () => {
    const narrow: SchemaIndex = {
      ...schema,
      page: {
        ...page,
        fields: {
          nothing: { kind: 'blocks', label: 'Nothing', allow: [] },
          aside: { kind: 'blocks', label: 'Aside', allow: ['button'], max: 1 },
        },
      },
    }
    const filled: Doc = {
      root: 'root',
      bloks: {
        root: blok('root', 'page'),
        a1: blok('a1', 'button', { parent: 'root', slot: 'aside', order: 'a0' }),
      },
    }
    expect(addTarget(filled, narrow, 'root')).toEqual({
      error: 'Every slot on this page is full or accepts nothing.',
    })
  })
})
