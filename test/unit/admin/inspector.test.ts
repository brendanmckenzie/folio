import { describe, expect, it } from 'vitest'
import { visibleEntries } from '../../../src/admin/Inspector'
import type { Field } from '../../../src/core/fields'

// conditional-fields.md's architecture decision 2: the filter happens once,
// in the parent. `FieldInput` never learns about visibility, so these tests
// cover `visibleEntries` directly rather than mounting the component.

const layout: Field = {
  kind: 'select',
  options: [
    { label: 'Full', value: 'full' },
    { label: 'Split', value: 'split' },
  ],
}
const image: Field = { kind: 'asset', showIf: { field: 'layout', eq: 'split' } }
const imageAlt: Field = {
  kind: 'text',
  showIf: {
    all: [
      { field: 'layout', eq: 'split' },
      { field: 'image', isSet: true },
    ],
  },
}
const legacyId: Field = { kind: 'text', hidden: true }
const body: Field = { kind: 'blocks', allow: ['paragraph'] }
const plain: Field = { kind: 'text' }

const fields = { layout, image, imageAlt, legacyId, body, plain }

describe('visibleEntries', () => {
  it('always excludes blocks-kind fields, whatever the data', () => {
    const names = visibleEntries(fields, {}).map(([name]) => name)
    expect(names).not.toContain('body')
  })

  it('always excludes hidden: true fields, whatever their value or any condition', () => {
    const names = visibleEntries(fields, { layout: 'split' }).map(([name]) => name)
    expect(names).not.toContain('legacyId')
  })

  it('includes a field with no showIf unconditionally', () => {
    const names = visibleEntries(fields, {}).map(([name]) => name)
    expect(names).toContain('plain')
    expect(names).toContain('layout')
  })

  it("hides a field whose showIf does not match the blok's own data", () => {
    const names = visibleEntries(fields, { layout: 'full' }).map(([name]) => name)
    expect(names).not.toContain('image')
  })

  it('shows a field the moment its controlling value matches', () => {
    const names = visibleEntries(fields, { layout: 'split' }).map(([name]) => name)
    expect(names).toContain('image')
  })

  it('appears and disappears with its controller, in both directions', () => {
    const full = visibleEntries(fields, { layout: 'full', image: 'x.png' }).map(([n]) => n)
    const split = visibleEntries(fields, { layout: 'split', image: 'x.png' }).map(([n]) => n)
    expect(full).not.toContain('image')
    expect(split).toContain('image')

    const backToFull = visibleEntries(fields, { layout: 'full', image: 'x.png' }).map(([n]) => n)
    expect(backToFull).not.toContain('image')
  })

  it('evaluates a combinator against sibling data (all: layout split AND image set)', () => {
    expect(visibleEntries(fields, { layout: 'split', image: 'x.png' }).map(([n]) => n)).toContain(
      'imageAlt',
    )
    expect(visibleEntries(fields, { layout: 'split', image: '' }).map(([n]) => n)).not.toContain(
      'imageAlt',
    )
    expect(
      visibleEntries(fields, { layout: 'full', image: 'x.png' }).map(([n]) => n),
    ).not.toContain('imageAlt')
  })

  it('never sends a mutation: the filter is a pure function of fields and data', () => {
    // visibleEntries takes no onChange and calls nothing — a visibility
    // change is a render-time decision, not a write. Asserting the function's
    // arity/purity here is the regression guard against that changing later.
    expect(visibleEntries.length).toBe(2)
    const before = { ...fields }
    visibleEntries(fields, { layout: 'split' })
    expect(fields).toEqual(before)
  })

  it('preserves declaration order, so a revealed field never displaces a sibling before it', () => {
    // React keys are `${blok.uid}:${name}`, computed from this order by the
    // caller. If a field's position among its still-visible neighbours never
    // changes, its key/identity never changes either, so an in-flight upload
    // in a sibling field is unaffected by a reveal.
    const before = visibleEntries(fields, { layout: 'full' }).map(([n]) => n)
    const after = visibleEntries(fields, { layout: 'split', image: 'x.png' }).map(([n]) => n)

    // Every field visible before is still visible, in the same relative order.
    const beforeStillVisible = before.filter((n) => after.includes(n))
    const afterRestrictedToThose = after.filter((n) => before.includes(n))
    expect(afterRestrictedToThose).toEqual(beforeStillVisible)
  })

  it('a condition naming a field the data does not have evaluates false, not throwing', () => {
    const unknown: Field = { kind: 'text', showIf: { field: 'nope', eq: 'x' } }
    expect(() => visibleEntries({ unknown }, {})).not.toThrow()
    expect(visibleEntries({ unknown }, {}).map(([n]) => n)).not.toContain('unknown')
  })
})
