import { describe, expect, it } from 'vitest'
import { fieldWatchers, visibleEntries, watcherLabel } from '../../../src/admin/Inspector'
import type { Field } from '../../../src/core/fields'
import { externalUpdate } from '../../../src/admin/RichTextInput'
import type { Presence } from '../../../src/core/protocol'

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

/*
 * editing/live-collaboration.md decision 3 and 5: field-level presence, drawn
 * from `Presence.selection`'s `{ uid, field }` pair. Advisory, never a lock
 * (checkpoint 2) — these pin what the ring *says*, since nothing it draws is
 * allowed to disable anything.
 */

const ann = (selection: Presence['selection'], locale: string | null = null): Presence => ({
  actor: 'usr_ann',
  name: 'Ann',
  colour: '#e5484d',
  selection,
  locale,
})

describe('fieldWatchers', () => {
  it('finds a peer holding this exact field', () => {
    const peers = [ann({ uid: 'hero', field: 'heading' })]
    expect(fieldWatchers(peers, 'hero', 'heading')).toEqual(peers)
  })

  /**
   * The block tree's dot already says where somebody is. A ring on every field
   * of the block they clicked would claim they are in all of them at once.
   */
  it('does not treat a blok-level selection as holding any field', () => {
    const peers = [ann({ uid: 'hero', field: null })]
    expect(fieldWatchers(peers, 'hero', 'heading')).toEqual([])
  })

  it('ignores the same field on another blok, and a peer with nothing selected', () => {
    const peers = [ann({ uid: 'other', field: 'heading' }), ann(null)]
    expect(fieldWatchers(peers, 'hero', 'heading')).toEqual([])
  })
})

describe('watcherLabel', () => {
  it('says nothing about language when both editors are in the same one', () => {
    expect(watcherLabel(ann({ uid: 'hero', field: 'heading' }, 'fr'), 'fr')).toBe(
      'Ann is in this field',
    )
    expect(watcherLabel(ann({ uid: 'hero', field: 'heading' }), null)).toBe('Ann is in this field')
  })

  /**
   * The spec's edge case: two people in one field in different locales are
   * writing different keys and are not in conflict at all, so a bare "Ann is
   * here" would report a clash that does not exist.
   */
  it('names the peer’s language when it differs from this editor’s', () => {
    expect(watcherLabel(ann({ uid: 'hero', field: 'heading' }, 'fr'), null)).toBe(
      'Ann is here in fr',
    )
    expect(watcherLabel(ann({ uid: 'hero', field: 'heading' }), 'fr')).toBe(
      'Ann is here in the source language',
    )
  })
})

/*
 * editing/live-collaboration.md phase 4, step 1: the richtext hazard. An external
 * value pushed in with `setContent` resets the caret, so a peer typing in the same
 * prose field would yank your cursor out of mid-sentence. Deferring while focused
 * is the honest fix inside a last-write-wins model — it does not pretend to merge.
 */
describe('externalUpdate', () => {
  const A = '{"type":"doc","content":[1]}'
  const B = '{"type":"doc","content":[2]}'

  it('ignores this editor’s own round trip', () => {
    expect(externalUpdate(A, A, A, false)).toBe('ignore')
    // And still ignores it while focused, which is the per-keystroke case.
    expect(externalUpdate(A, A, A, true)).toBe('ignore')
  })

  it('ignores a value the surface already shows', () => {
    expect(externalUpdate(A, B, A, false)).toBe('ignore')
  })

  it('applies an external value when nobody is typing here', () => {
    expect(externalUpdate(B, A, A, false)).toBe('apply')
  })

  /** The acceptance criterion: Ann's caret does not move and her in-progress text
   * is not replaced while she is in the field. */
  it('defers an external value while this field has focus', () => {
    expect(externalUpdate(B, A, A, true)).toBe('defer')
  })
})
