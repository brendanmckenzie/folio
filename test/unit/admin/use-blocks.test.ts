import { describe, expect, it } from 'vitest'
import {
  duplicateInsert,
  fullSlotMessage,
  pasteInsert,
  subtreeInsert,
} from '../../../src/admin/hooks/useBlocks'
import type { Blok, Doc } from '../../../src/core/doc'
import { blocks, text } from '../../../src/core/fields'
import type { Mutation } from '../../../src/core/mutations'
import type { BlockSchema, SchemaIndex } from '../../../src/core/schema'

/** Every mutation `subtreeInsert` builds is an insert; this test file only cares about `blok`. */
function blokOf(m: Mutation): Blok {
  if (m.t !== 'insert') throw new Error(`expected an insert mutation, got ${m.t}`)
  return m.blok
}

// field-defaults-and-presets.md's acceptance criterion "a preset with
// children lands as one transaction": `useBlocks.add` sends every blok a
// preset produces as one `store.tx(mutations)` call. `subtreeInsert` is the
// pure boundary that builds that mutation list, so the property is tested
// without mounting the hook.

const button: BlockSchema = {
  name: 'button',
  label: 'Button',
  fields: { label: text({ default: 'Read more' }) },
  presets: [{ name: 'primary', label: 'Primary', data: { label: 'Buy now' } }],
}

const hero: BlockSchema = {
  name: 'hero',
  label: 'Hero',
  fields: { actions: blocks({ allow: ['button'], max: 2 }) },
  presets: [
    {
      name: 'cta',
      label: 'Hero — with button',
      children: [{ slot: 'actions', type: 'button', preset: 'primary' }],
    },
  ],
}

const schema: SchemaIndex = { button, hero }

describe('subtreeInsert', () => {
  it('builds one insert mutation for a type with no preset', () => {
    const { mutations } = subtreeInsert(schema, 'button', null, null, 'a0')
    expect(mutations).toEqual([{ t: 'insert', blok: expect.objectContaining({ type: 'button' }) }])
  })

  it('builds every blok a preset with children produces, all as insert mutations', () => {
    const { mutations } = subtreeInsert(schema, 'hero', null, null, 'a0', 'cta')
    expect(mutations).toHaveLength(2)
    expect(mutations.every((m) => m.t === 'insert')).toBe(true)
  })

  it('orders the mutations parents before children, matching diff.ts’s insert rule', () => {
    const { mutations } = subtreeInsert(schema, 'hero', null, null, 'a0', 'cta')
    expect(mutations.map((m) => blokOf(m).type)).toEqual(['hero', 'button'])
  })

  it('parents the child mutation’s blok on the hero mutation’s own blok, not a placeholder', () => {
    const { mutations } = subtreeInsert(schema, 'hero', null, null, 'a0', 'cta')
    const [heroBlok, buttonBlok] = mutations.map(blokOf)
    expect(buttonBlok!.parent).toBe(heroBlok!.uid)
  })

  it('selects the top blok, the same thing a bare add has always selected', () => {
    const { mutations, selected } = subtreeInsert(schema, 'hero', null, null, 'a0', 'cta')
    expect(selected).toBe(blokOf(mutations[0]!).uid)
  })

  it('stamps the given parent/slot/order onto the top blok only', () => {
    const { mutations } = subtreeInsert(schema, 'button', 'root', 'body', 'a3')
    const blok = blokOf(mutations[0]!)
    expect(blok.parent).toBe('root')
    expect(blok.slot).toBe('body')
    expect(blok.order).toBe('a3')
  })
})

// duplicate-and-paste.md's architecture decisions 1-3: duplicate and paste
// are both one-transaction inserts, built by pure functions so the property
// ("one transaction", "placed right after the selection", every refusal) is
// tested directly against the return value, without mounting the hook or a
// store.

function blok(overrides: Partial<Blok> & { uid: string; type: string }): Blok {
  return { parent: null, slot: null, order: 'a0', data: {}, ...overrides }
}

const page: BlockSchema = {
  name: 'page',
  label: 'Page',
  fields: { body: blocks({ allow: ['hero'] }) },
}

const capped: BlockSchema = {
  name: 'capped',
  label: 'Capped',
  fields: { item: blocks({ allow: ['button'], max: 1 }) },
}

const richSchema: SchemaIndex = { ...schema, page, capped }

/** root (page) -> hero -> one button, already at 1 of 2 in `hero.actions`. */
function docWithHero(): Doc {
  return {
    root: 'root',
    bloks: {
      root: blok({ uid: 'root', type: 'page' }),
      hero: blok({ uid: 'hero', type: 'hero', parent: 'root', slot: 'body', order: 'a0' }),
      b1: blok({
        uid: 'b1',
        type: 'button',
        parent: 'hero',
        slot: 'actions',
        order: 'a0',
        data: { label: 'One' },
      }),
    },
  }
}

/** root (capped) with one button already occupying its max-1 slot. */
function docWithCappedSlot(): Doc {
  return {
    root: 'root',
    bloks: {
      root: blok({ uid: 'root', type: 'capped' }),
      b1: blok({ uid: 'b1', type: 'button', parent: 'root', slot: 'item', order: 'a0' }),
    },
  }
}

describe('duplicateInsert', () => {
  it('refuses to duplicate the document root: it is the document', () => {
    const result = duplicateInsert(docWithHero(), richSchema, 'root')
    expect('error' in result).toBe(true)
  })

  it('builds one insert mutation per blok in the subtree, as one transaction', () => {
    const result = duplicateInsert(docWithHero(), richSchema, 'b1')
    if ('error' in result) throw new Error(result.error)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]!.t).toBe('insert')
  })

  it('places the copy immediately after the original, in the same slot', () => {
    const result = duplicateInsert(docWithHero(), richSchema, 'b1')
    if ('error' in result) throw new Error(result.error)
    const copy = blokOf(result.mutations[0]!)
    expect(copy.parent).toBe('hero')
    expect(copy.slot).toBe('actions')
    expect(copy.order > 'a0').toBe(true)
  })

  it('selects the duplicate, not the original', () => {
    const result = duplicateInsert(docWithHero(), richSchema, 'b1')
    if ('error' in result) throw new Error(result.error)
    expect(result.selected).toBe(blokOf(result.mutations[0]!).uid)
    expect(result.selected).not.toBe('b1')
  })

  it('refuses with "this slot holds one block" when the slot’s max is 1', () => {
    const result = duplicateInsert(docWithCappedSlot(), richSchema, 'b1')
    expect(result).toEqual({ error: fullSlotMessage(1) })
  })
})

describe('fullSlotMessage', () => {
  it('names the special case for max: 1', () => {
    expect(fullSlotMessage(1)).toBe('this slot holds one block')
  })

  it('names the general case for a larger max', () => {
    expect(fullSlotMessage(3)).toBe('this slot holds at most 3 blocks')
  })
})

describe('pasteInsert', () => {
  const clip = (type: string, data: Record<string, unknown> = {}): Blok[] => [
    blok({ uid: 'clip1', type, data: data as Blok['data'] }),
  ]

  it('refuses when nothing is selected', () => {
    const result = pasteInsert(docWithHero(), richSchema, null, clip('button'))
    expect('error' in result).toBe(true)
  })

  it('refuses when the selection no longer exists in the document', () => {
    const result = pasteInsert(docWithHero(), richSchema, 'ghost', clip('button'))
    expect('error' in result).toBe(true)
  })

  it('lands in the selected block’s own slot, immediately after it', () => {
    const result = pasteInsert(docWithHero(), richSchema, 'b1', clip('button', { label: 'Pasted' }))
    if ('error' in result) throw new Error(result.error)
    const copy = blokOf(result.mutations[0]!)
    expect(copy.parent).toBe('hero')
    expect(copy.slot).toBe('actions')
    expect(copy.order > 'a0').toBe(true)
  })

  it('refuses a type the selected slot does not allow, naming the type and the slot', () => {
    const result = pasteInsert(docWithHero(), richSchema, 'b1', clip('hero'))
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('hero')
    expect(result.error).toContain('actions')
  })

  it('refuses when the target slot is already at its max', () => {
    const result = pasteInsert(docWithCappedSlot(), richSchema, 'b1', clip('button'))
    expect(result).toEqual({ error: fullSlotMessage(1) })
  })

  it('with the root selected, lands in the root’s first slot that allows the type', () => {
    const rootIsHero: Doc = { root: 'hero', bloks: { hero: blok({ uid: 'hero', type: 'hero' }) } }
    const result = pasteInsert(rootIsHero, richSchema, 'hero', clip('button'))
    if ('error' in result) throw new Error(result.error)
    const copy = blokOf(result.mutations[0]!)
    expect(copy.parent).toBe('hero')
    expect(copy.slot).toBe('actions')
  })

  it('with the root selected and no slot accepting the type, refuses', () => {
    const rootIsButton: Doc = {
      root: 'b0',
      bloks: { b0: blok({ uid: 'b0', type: 'button' }) },
    }
    const result = pasteInsert(rootIsButton, richSchema, 'b0', clip('button'))
    expect('error' in result).toBe(true)
  })

  it('pasting the same clipboard twice produces two copies with different uids', () => {
    const first = pasteInsert(docWithHero(), richSchema, 'b1', clip('button'))
    const second = pasteInsert(docWithHero(), richSchema, 'b1', clip('button'))
    if ('error' in first || 'error' in second) throw new Error('expected both to succeed')
    expect(blokOf(first.mutations[0]!).uid).not.toBe(blokOf(second.mutations[0]!).uid)
  })
})
