import { describe, expect, it } from 'vitest'
import { externalUpdate } from '../../../src/admin/ui/screens/fields/useRichtext'
import {
  fieldWatchers,
  visibleEntries,
  watcherLabel,
} from '../../../src/admin/ui/screens/inspector-model'
import type { Field } from '../../../src/core/fields'
import type { Presence } from '../../../src/core/protocol'

/*
 * The inspector's model, in Node.
 *
 * Until port phase 8 the three describes below ran against `admin/Inspector.tsx`
 * and a fourth asserted that `inspector-model.ts` answered identically — the
 * duplication was deliberate while both panels existed. The old panel is deleted, so
 * they point at the surviving copy and the comparison went with its other half.
 * `externalUpdate` came the same way, out of `admin/RichTextInput.tsx` and into
 * `screens/fields/useRichtext.ts`.
 */

// conditional-fields.md's architecture decision 2: the filter happens once,
// in the parent. `FieldRow` never learns about visibility, so these tests
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

/* ===========================================================================
 * The five things port phase 7b added rather than ported — `controlFor`,
 * `isEditable`, `writeLocale`, `canFocus` and the focus-mode measure — plus the
 * locale arithmetic the old panel had too.
 * ========================================================================= */

import type { Blok } from '../../../src/core/doc'
import type { SchemaIndex } from '../../../src/core/schema'
import {
  canFocus,
  FOCUS_MEASURE_CH,
  isEditable,
  isReadableMeasure,
  sourceText,
  writeLocale,
} from '../../../src/admin/ui/screens/inspector-model'

const blok = (over: Partial<Blok> = {}): Blok => ({
  uid: 'hero',
  type: 'hero',
  parent: null,
  slot: null,
  order: 'a0',
  data: {},
  ...over,
})

/*
 * `fieldMode` and `boundValue` are covered in `localisation.test.ts`, which holds the
 * richer set — it exercises every field kind through `core/fields`' builders. Both
 * used to be tested twice because there were two implementations; port phase 8 left
 * one, so the thinner copy of the tests went with the thinner copy of the function.
 */
describe('isEditable / writeLocale', () => {
  it('is two independent refusals about two different things', () => {
    expect(isEditable('source', false)).toBe(true)
    // The document: a past version is on the stage, or the role may not edit.
    expect(isEditable('source', true)).toBe(false)
    expect(isEditable('translate', true)).toBe(false)
    // The field: not translatable, in a non-source locale.
    expect(isEditable('shared', false)).toBe(false)
  })

  /**
   * The one door every translation goes through. `'shared'` returning undefined
   * rather than the locale is what makes decision 4's editor half safe rather
   * than merely unlikely: even if a shared control were somehow reachable, no
   * locale-scoped `set` could leave it.
   */
  it('scopes a write to the locale only while translating', () => {
    expect(writeLocale('translate', 'fr')).toBe('fr')
    expect(writeLocale('source', 'fr')).toBeUndefined()
    expect(writeLocale('shared', 'fr')).toBeUndefined()
  })
})

/*
 * ui-architecture.md decision 5: focus mode exists for one field kind, because
 * 340px is right for the other twenty and wrong for prose.
 */
describe('canFocus', () => {
  const schema = {
    hero: {
      label: 'Hero',
      fields: { heading: { kind: 'text' }, body: { kind: 'richtext' } },
    },
  } as unknown as SchemaIndex

  it('is richtext and nothing else', () => {
    const b = blok()
    expect(canFocus(schema, b, 'body')).toBe(true)
    expect(canFocus(schema, b, 'heading')).toBe(false)
  })

  it('is false with nothing selected, nothing focused, or an unknown block', () => {
    expect(canFocus(schema, null, 'body')).toBe(false)
    expect(canFocus(schema, blok(), null)).toBe(false)
    expect(canFocus(schema, blok({ type: 'nope' }), 'body')).toBe(false)
    expect(canFocus(schema, blok(), 'nope')).toBe(false)
  })
})

describe('the focus-mode measure', () => {
  /**
   * A real regression guard rather than a tautology: the band is what makes the
   * overlay worth having, so somebody widening it to 90 characters because the
   * panel looked narrow fails here instead of shipping unreadable prose.
   */
  it('is inside the 60–75 character band typography has agreed on', () => {
    expect(isReadableMeasure(FOCUS_MEASURE_CH)).toBe(true)
    expect(isReadableMeasure(50)).toBe(false)
    expect(isReadableMeasure(90)).toBe(false)
  })
})

/*
 * The read-only source column. Everything except richtext renders as text,
 * because that is all there is to show — and the unwrapping matters, because a
 * raw object would read "[object Object]" beside a translation input.
 */
describe('sourceText', () => {
  it('is empty for nothing at all', () => {
    expect(sourceText({ kind: 'text' }, null)).toBe('')
    expect(sourceText({ kind: 'text' }, undefined as never)).toBe('')
  })

  it('names an asset by its filename and counts the plurals', () => {
    expect(sourceText({ kind: 'asset' }, { key: 'k', filename: 'a.png' } as never)).toBe('a.png')
    expect(sourceText({ kind: 'multiasset' }, [1, 2] as never)).toBe('2 files')
    expect(sourceText({ kind: 'multiasset' }, [1] as never)).toBe('1 file')
  })

  /** A count, not the ids: raw `sty_…` strings tell a translator nothing. */
  it('counts references rather than listing ids', () => {
    expect(sourceText({ kind: 'references' }, ['sty_a', 'sty_b'] as never)).toBe('2 documents')
    expect(sourceText({ kind: 'references' }, ['sty_a'] as never)).toBe('1 document')
  })

  it('reads a select through its own option label', () => {
    const field: Field = { kind: 'select', options: [{ label: 'Split', value: 'split' }] }
    expect(sourceText(field, 'split')).toBe('Split')
    // A stored value the schema no longer offers still shows something.
    expect(sourceText(field, 'gone')).toBe('gone')
  })

  it('says yes and no rather than true and false', () => {
    expect(sourceText({ kind: 'boolean' }, true)).toBe('yes')
    expect(sourceText({ kind: 'boolean' }, false)).toBe('no')
  })

  it('flattens richtext to its text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    }
    expect(sourceText({ kind: 'richtext' }, doc as never)).toContain('Hi')
  })
})

/*
 * The seam, asserted at compile time.
 *
 * Port phase 7a hands the inspector an `EditorSlot` and the wiring is
 * `inspector={(slot) => <Inspector {...slot} />}` — so every *required* prop of
 * `InspectorProps` has to exist on `EditorSlot`, with a compatible type. This
 * assignment is what says so: a prop added here that the slot does not carry, or a
 * key renamed on either side, is a type error in this file rather than a surprise in
 * whichever file does the wiring.
 *
 * Not a runtime `it()`, because there is nothing to run. `tsc` covers `test/`, which
 * is what makes a type-only assertion a real gate.
 */
import type { EditorSlot } from '../../../src/admin/ui/screens/EditorShell'
import type { InspectorProps } from '../../../src/admin/ui/screens/Inspector'

const inspectorTakesAnEditorSlot: (slot: EditorSlot) => InspectorProps = (slot) => slot

describe('the 7a seam', () => {
  it('is a type-level assertion, and this keeps the import from reading as dead', () => {
    expect(typeof inspectorTakesAnEditorSlot).toBe('function')
  })
})
