import { describe, expect, it } from 'vitest'
import { menuGroups } from '../../../src/admin/BlockTree'
import type { Presence } from '../../../src/core/protocol'
import type { BlockSchema, SchemaIndex } from '../../../src/core/schema'

// field-defaults-and-presets.md's architecture decision 5: one group per
// type, in declaration order, the bare block first unless `presetsOnly`
// hides it, presets nested beneath.

const button: BlockSchema = {
  name: 'button',
  label: 'Button',
  fields: {},
  presets: [
    { name: 'primary', label: 'Primary button' },
    { name: 'ghost', label: 'Ghost button' },
  ],
}

const hero: BlockSchema = { name: 'hero', label: 'Hero', fields: {} }

const card: BlockSchema = {
  name: 'card',
  label: 'Card',
  fields: {},
  presetsOnly: true,
  presets: [{ name: 'a', label: 'Card — A' }],
}

const schema: SchemaIndex = { button, hero, card }

describe('menuGroups', () => {
  it('groups by type, in the given (declaration) order', () => {
    const groups = menuGroups(schema, ['hero', 'button', 'card'])
    expect(groups.map((g) => g.type)).toEqual(['hero', 'button', 'card'])
  })

  it('nests a type’s presets under its own group, in schema order', () => {
    const [group] = menuGroups(schema, ['button'])
    expect(group!.presets.map((p) => p.name)).toEqual(['primary', 'ghost'])
  })

  it('offers the bare block for an ordinary type', () => {
    const [group] = menuGroups(schema, ['hero'])
    expect(group!.bare).toBe(true)
    expect(group!.presets).toEqual([])
  })

  it('hides the bare block for a presetsOnly type, offering only its presets', () => {
    const [group] = menuGroups(schema, ['card'])
    expect(group!.bare).toBe(false)
    expect(group!.presets.map((p) => p.name)).toEqual(['a'])
  })

  it('falls back to the type name when a type is missing from the schema', () => {
    const [group] = menuGroups(schema, ['nope'])
    expect(group).toEqual({ type: 'nope', label: 'nope', bare: true, presets: [] })
  })

  it('uses the block’s label, not its type name, as the group label', () => {
    const [group] = menuGroups(schema, ['button'])
    expect(group!.label).toBe('Button')
  })
})

/*
 * editing/live-collaboration.md decision 3: the block tree keeps one dot per
 * *block*, derived by ignoring `Presence.selection.field`. The field-level ring
 * belongs to the inspector; the tree's grain is the block.
 */
describe('per-block presence dots', () => {
  const peer = (uid: string | null, field: string | null = null): Presence => ({
    actor: `usr_${uid ?? 'nowhere'}`,
    name: 'Ann',
    colour: '#e5484d',
    selection: uid === null ? null : { uid, field },
    locale: null,
  })

  /** Exactly the derivation `Slot` performs. Kept in step with BlockTree.tsx. */
  const watchers = (peers: Presence[], uid: string) => peers.filter((p) => p.selection?.uid === uid)

  it('shows a dot for a peer in the block whether or not they hold a field', () => {
    const peers = [peer('hero'), peer('hero', 'heading')]
    expect(watchers(peers, 'hero')).toHaveLength(2)
  })

  it('shows nothing for a peer elsewhere or nowhere', () => {
    expect(watchers([peer('other', 'heading'), peer(null)], 'hero')).toEqual([])
  })
})
