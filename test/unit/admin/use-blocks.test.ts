import { describe, expect, it } from 'vitest'
import { subtreeInsert } from '../../../src/admin/hooks/useBlocks'
import type { Blok } from '../../../src/core/doc'
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
