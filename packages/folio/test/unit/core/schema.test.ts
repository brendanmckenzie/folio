import { describe, expect, it } from 'vitest'
import { blocks, number, select, text } from '../../../src/core/fields'
import { EMPTY_RESOLUTION, resolveValue } from '../../../src/core/resolve'
import {
  allocateSubtree,
  blankBlok,
  blankSubtree,
  type BlockSchema,
  type SchemaIndex,
  type SubtreeBlok,
  validatePresets,
} from '../../../src/core/schema'

// field-defaults-and-presets.md's ground truth: one mechanism at three
// scales — a field's own `default`, a block's `preset`, and a document's
// starting content (a root preset named 'default'). All three are layering
// exercised through `blankSubtree`; `allocateSubtree` is the schema-agnostic
// primitive underneath, shared with duplicate-and-paste.md.

const button: BlockSchema = {
  name: 'button',
  label: 'Button',
  fields: {
    label: text({ default: 'Read more' }),
    // Deliberately ordered so the kind default (first option) is 'ghost', not
    // 'primary' — the 'primary' preset below overrides it, and the two must be
    // visibly different values for the layering tests to mean anything.
    variant: select({
      options: [
        { label: 'Ghost', value: 'ghost' },
        { label: 'Primary', value: 'primary' },
      ],
    }),
  },
  presets: [{ name: 'primary', label: 'Primary button', data: { variant: 'primary' } }],
}

const hero: BlockSchema = {
  name: 'hero',
  label: 'Hero',
  fields: {
    heading: text(),
    align: select({
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
      ],
      default: 'center',
    }),
    actions: blocks({ allow: ['button'], max: 2 }),
  },
  presets: [
    { name: 'left', label: 'Hero — left', data: { align: 'left' } },
    {
      name: 'cta',
      label: 'Hero — with button',
      children: [{ slot: 'actions', type: 'button', preset: 'primary' }],
    },
    {
      name: 'pair',
      label: 'Hero — two buttons',
      children: [
        { slot: 'actions', type: 'button' },
        { slot: 'actions', type: 'button', preset: 'primary' },
      ],
    },
  ],
}

const schema: SchemaIndex = { button, hero }

describe('layering: kind default, field default, preset data — in that order', () => {
  it('falls back to the kind default when a field declares neither a default nor a preset override', () => {
    const b = blankBlok(schema, 'button', null, null, 'a0')
    // `variant` has no `default`, so it falls all the way to the kind default:
    // the first option, exactly as it did before this spec.
    expect(b.data.variant).toBe('ghost')
  })

  it('applies the field default with no preset', () => {
    const b = blankBlok(schema, 'hero', null, null, 'a0')
    expect(b.data.align).toBe('center')
  })

  it('lets a preset override the field default', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'left')
    expect(bloks[0]!.data.align).toBe('left')
  })

  it('writes the field default at creation, as part of the same blok, not a second write', () => {
    const b = blankBlok(schema, 'button', null, null, 'a0')
    expect(b.data.label).toBe('Read more')
  })
})

describe('blankSubtree: a preset with children lands as one array, parents before children', () => {
  it('creates the parent and its children together', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'cta')
    expect(bloks).toHaveLength(2)
    expect(bloks[0]!.type).toBe('hero')
    expect(bloks[1]!.type).toBe('button')
  })

  it('parents the child under the new hero, in the named slot, with a valid order', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'cta')
    const [root, child] = bloks
    expect(child!.parent).toBe(root!.uid)
    expect(child!.slot).toBe('actions')
    expect(typeof child!.order).toBe('string')
    expect(child!.order.length).toBeGreaterThan(0)
  })

  it('layers a nested preset over the child block’s own field defaults', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'cta')
    expect(bloks[1]!.data).toEqual({ label: 'Read more', variant: 'primary' })
  })

  it('gives every blok in the subtree a fresh, distinct uid', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'cta')
    expect(new Set(bloks.map((b) => b.uid)).size).toBe(bloks.length)
  })

  it('stamps the given parent/slot/order onto only the top blok', () => {
    const bloks = blankSubtree(schema, 'hero', 'root', 'body', 'a3', 'cta')
    expect(bloks[0]!.parent).toBe('root')
    expect(bloks[0]!.slot).toBe('body')
    expect(bloks[0]!.order).toBe('a3')
  })

  it('allocates sequential fractional orders for multiple children in the same slot, in array order', () => {
    const bloks = blankSubtree(schema, 'hero', null, null, 'a0', 'pair')
    const buttons = bloks.filter((b) => b.type === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.order < buttons[1]!.order).toBe(true)
    // The first names no preset (kind default, first option); the second
    // names 'primary' and is visibly different, proving the override landed
    // on the right blok rather than both just sharing the kind default.
    expect(buttons[0]!.data.variant).toBe('ghost')
    expect(buttons[1]!.data.variant).toBe('primary')
  })

  it('behaves exactly like blankBlok when no preset is given: a single bare blok', () => {
    const viaSubtree = blankSubtree(schema, 'button', null, null, 'a0')
    expect(viaSubtree).toHaveLength(1)
    const viaBlok = blankBlok(schema, 'button', null, null, 'a0')
    expect(viaBlok.data).toEqual(viaSubtree[0]!.data)
  })

  it('still throws for an unknown block type', () => {
    expect(() => blankSubtree(schema, 'nope', null, null, 'a0')).toThrow('Unknown block type: nope')
  })

  it('throws for an unknown preset name', () => {
    expect(() => blankSubtree(schema, 'hero', null, null, 'a0', 'nope')).toThrow(/Unknown preset/)
  })
})

describe('allocateSubtree: the schema-agnostic primitive underneath', () => {
  it('throws when no entry has parent: null', () => {
    const recipe: SubtreeBlok[] = [{ key: 'a', type: 'x', data: {}, parent: 'ghost', slot: null }]
    expect(() => allocateSubtree(recipe, null, null, 'a0')).toThrow('no root')
  })

  it('places the root at the given parent/slot/order and assigns it a fresh uid', () => {
    const recipe: SubtreeBlok[] = [
      { key: 'r', type: 'x', data: { a: 1 }, parent: null, slot: null },
    ]
    const [root] = allocateSubtree(recipe, 'P', 'body', 'a5')
    expect(root!.parent).toBe('P')
    expect(root!.slot).toBe('body')
    expect(root!.order).toBe('a5')
    expect(root!.data).toEqual({ a: 1 })
    expect(root!.uid).not.toBe('r')
  })

  it('wires a nested child to the root’s real uid, not its local key', () => {
    const recipe: SubtreeBlok[] = [
      { key: 'r', type: 'x', data: {}, parent: null, slot: null },
      { key: 'c', type: 'y', data: {}, parent: 'r', slot: 'kids' },
    ]
    const [root, child] = allocateSubtree(recipe, null, null, 'a0')
    expect(child!.parent).toBe(root!.uid)
    expect(child!.parent).not.toBe('r')
  })

  it('returns parents before children for a multi-level recipe', () => {
    const recipe: SubtreeBlok[] = [
      { key: 'r', type: 'root', data: {}, parent: null, slot: null },
      { key: 'c', type: 'child', data: {}, parent: 'r', slot: 's1' },
      { key: 'g', type: 'grandchild', data: {}, parent: 'c', slot: 's2' },
    ]
    const out = allocateSubtree(recipe, null, null, 'a0')
    expect(out.map((b) => b.type)).toEqual(['root', 'child', 'grandchild'])
  })
})

describe('validatePresets: every construction-time throw', () => {
  it('accepts a well-formed schema', () => {
    expect(() => validatePresets(schema)).not.toThrow()
  })

  it('throws for a preset naming an unknown block type', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { body: blocks({ allow: ['nope'] }) },
        presets: [{ name: 'd', label: 'D', children: [{ slot: 'body', type: 'nope' }] }],
      },
    }
    expect(() => validatePresets(bad)).toThrow(/unknown block type 'nope'/)
  })

  it('throws for a preset naming an unknown slot', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { title: text() },
        presets: [{ name: 'd', label: 'D', children: [{ slot: 'nope', type: 'hero' }] }],
      },
    }
    expect(() => validatePresets(bad)).toThrow(/unknown slot 'nope'/)
  })

  it('throws for a type a slot’s allow forbids', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { body: blocks({ allow: ['button'] }) },
        presets: [{ name: 'd', label: 'D', children: [{ slot: 'body', type: 'card' }] }],
      },
      button: { name: 'button', label: 'Button', fields: {} },
      card: { name: 'card', label: 'Card', fields: {} },
    }
    expect(() => validatePresets(bad)).toThrow(/does not allow 'card'/)
  })

  it('throws for a preset whose data names a field the block does not declare', () => {
    const bad: SchemaIndex = {
      button: {
        name: 'button',
        label: 'Button',
        fields: { label: text() },
        presets: [{ name: 'd', label: 'D', data: { nope: 'x' } }],
      },
    }
    expect(() => validatePresets(bad)).toThrow(/unknown field 'nope'/)
  })

  it('throws for a preset whose data names a blocks-kind field', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { body: blocks({ allow: ['button'] }) },
        presets: [{ name: 'd', label: 'D', data: { body: 'x' } }],
      },
      button: { name: 'button', label: 'Button', fields: {} },
    }
    expect(() => validatePresets(bad)).toThrow(/blocks field/)
  })

  it('throws when a preset supplies more children than the slot’s max', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { body: blocks({ allow: ['button'], max: 1 }) },
        presets: [
          {
            name: 'd',
            label: 'D',
            children: [
              { slot: 'body', type: 'button' },
              { slot: 'body', type: 'button' },
            ],
          },
        ],
      },
      button: { name: 'button', label: 'Button', fields: {} },
    }
    expect(() => validatePresets(bad)).toThrow(/allows at most 1/)
  })

  it('throws for presetsOnly with no presets', () => {
    const bad: SchemaIndex = {
      card: { name: 'card', label: 'Card', fields: {}, presetsOnly: true },
    }
    expect(() => validatePresets(bad)).toThrow(/presetsOnly but declares no presets/)
  })

  it('does not throw for presetsOnly with at least one preset', () => {
    const ok: SchemaIndex = {
      card: {
        name: 'card',
        label: 'Card',
        fields: { title: text() },
        presetsOnly: true,
        presets: [{ name: 'a', label: 'A' }],
      },
    }
    expect(() => validatePresets(ok)).not.toThrow()
  })

  it('throws for a preset naming an unknown nested preset', () => {
    const bad: SchemaIndex = {
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: { body: blocks({ allow: ['button'] }) },
        presets: [
          { name: 'd', label: 'D', children: [{ slot: 'body', type: 'button', preset: 'nope' }] },
        ],
      },
      button: { name: 'button', label: 'Button', fields: {}, presets: [] },
    }
    expect(() => validatePresets(bad)).toThrow(/unknown preset 'nope'/)
  })

  it('throws for a preset cycle', () => {
    const cyclic: SchemaIndex = {
      a: {
        name: 'a',
        label: 'A',
        fields: { kids: blocks({ allow: ['a'] }) },
        presets: [
          { name: 'loop', label: 'Loop', children: [{ slot: 'kids', type: 'a', preset: 'loop' }] },
        ],
      },
    }
    expect(() => validatePresets(cyclic)).toThrow(/cycle/i)
  })

  it('does not throw for a preset chain at exactly the depth bound', () => {
    expect(() => validatePresets(chainSchema(5))).not.toThrow()
  })

  it('throws for a preset chain nested past the depth bound', () => {
    expect(() => validatePresets(chainSchema(6))).toThrow(/depth/)
  })
})

describe('resolveValue: the render path does not learn about field.default (decision 4)', () => {
  it('falls back to the kind default for an absent number, ignoring field.default', () => {
    const field = number({ default: 42 })
    expect(resolveValue(field, undefined, EMPTY_RESOLUTION)).toBe(0)
  })

  it('does not surface field.default for an absent text value either', () => {
    const field = text({ default: 'Read more' })
    expect(resolveValue(field, undefined, EMPTY_RESOLUTION)).toBe('')
  })

  it('does not surface field.default for an absent select value either', () => {
    const field = select({ options: [{ label: 'A', value: 'a' }], default: 'a' })
    expect(resolveValue(field, undefined, EMPTY_RESOLUTION)).toBe('')
  })
})

/**
 * A straight chain of `n` distinct block types, `t1..tn`, each with one preset
 * `p` whose only child is the next type's own `p` preset. No cycle (every
 * `(type, preset)` pair is unique), so this isolates the depth bound from
 * cycle detection.
 */
function chainSchema(n: number): SchemaIndex {
  const out: SchemaIndex = {}
  for (let i = 1; i <= n; i++) {
    const next = i < n ? `t${i + 1}` : null
    out[`t${i}`] = {
      name: `t${i}`,
      label: `T${i}`,
      fields: { kids: blocks({ allow: [next ?? `t${i}`] }) },
      presets: [
        {
          name: 'p',
          label: 'P',
          children: next ? [{ slot: 'kids', type: next, preset: 'p' }] : [],
        },
      ],
    }
  }
  return out
}
