import { describe, expect, it } from 'vitest'
import { diff, summariseDiff } from '../../../src/core/diff'
import { type Blok, type Doc, type Json, keyAtIndex } from '../../../src/core/doc'
import {
  asset,
  blocks,
  boolean,
  collection,
  multiasset,
  multilink,
  number,
  reference,
  references,
  richtext,
  select,
  text,
  textarea,
} from '../../../src/core/fields'
import {
  assignOrders,
  fieldShapeError,
  fromNested,
  MAX_NESTED_DEPTH,
  type NestedBlok,
  NestedError,
  type NestedInput,
  toNested,
} from '../../../src/core/nested'
import type { SchemaIndex } from '../../../src/core/schema'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = 'root'

const schema: SchemaIndex = {
  page: {
    name: 'page',
    label: 'Page',
    summary: 'title',
    fields: {
      title: text({ translatable: true }),
      noindex: boolean(),
      body: blocks({ allow: ['hero', 'prose', 'nest'] }),
      aside: blocks({ allow: ['prose'], max: 1 }),
    },
  },
  /** Self-nesting, so the depth ceiling is reachable without tripping `allow`. */
  nest: { name: 'nest', label: 'Nest', fields: { kids: blocks({ allow: ['nest'] }) } },
  hero: {
    name: 'hero',
    label: 'Hero',
    fields: {
      heading: text({ translatable: true }),
      align: select({
        options: [
          { label: 'L', value: 'left' },
          { label: 'C', value: 'center' },
        ],
      }),
      actions: blocks({ allow: ['button'], max: 2 }),
    },
  },
  prose: { name: 'prose', label: 'Prose', fields: { body: richtext({ translatable: true }) } },
  button: { name: 'button', label: 'Button', fields: { label: text(), link: multilink() } },
  every: {
    name: 'every',
    label: 'Every kind',
    fields: {
      t: text(),
      ta: textarea(),
      n: number(),
      b: boolean(),
      s: select({ options: [{ label: 'A', value: 'a' }] }),
      a: asset(),
      ma: multiasset(),
      ml: multilink(),
      rt: richtext(),
      ref: reference(),
      refs: references(),
      col: collection({ type: 'page' }),
      kids: blocks({ allow: ['button'] }),
    },
  },
}

function blk(uid: string, over: Partial<Blok> = {}): Blok {
  return { uid, type: 'prose', parent: ROOT, slot: 'body', order: 'a0', data: {}, ...over }
}

function mkDoc(bloks: Blok[]): Doc {
  const map: Record<string, Blok> = {}
  for (const b of bloks) map[b.uid] = b
  return { root: ROOT, bloks: map }
}

/** Root + hero(a0) with two buttons + prose(a1). The spec's own example shape. */
function sample(): Doc {
  return mkDoc([
    { uid: ROOT, type: 'page', parent: null, slot: null, order: 'a0', data: { title: 'About us' } },
    blk('h', { type: 'hero', order: 'a0', data: { heading: 'Hello', align: 'left' } }),
    blk('b1', {
      type: 'button',
      parent: 'h',
      slot: 'actions',
      order: 'a0',
      data: { label: 'One' },
    }),
    blk('b2', {
      type: 'button',
      parent: 'h',
      slot: 'actions',
      order: 'a1',
      data: { label: 'Two' },
    }),
    blk('p', { type: 'prose', order: 'a1', data: { body: null } }),
  ])
}

const at = (nested: NestedBlok, ...path: (string | number)[]): NestedBlok => {
  let node = nested
  for (let i = 0; i < path.length; i += 2) {
    const list = node.fields[path[i] as string] as NestedBlok[]
    node = list[path[i + 1] as number]!
  }
  return node
}

// ---------------------------------------------------------------------------
// toNested
// ---------------------------------------------------------------------------

describe('toNested', () => {
  it('nests children into the slot they live in, in sibling order', () => {
    const nested = toNested(sample(), schema)
    expect(nested.uid).toBe(ROOT)
    expect(nested.type).toBe('page')
    expect(nested.fields.title).toBe('About us')

    const body = nested.fields.body as NestedBlok[]
    expect(body.map((b) => b.type)).toEqual(['hero', 'prose'])
    expect(at(nested, 'body', 0).fields.heading).toBe('Hello')
    expect(
      (at(nested, 'body', 0).fields.actions as NestedBlok[]).map((b) => b.fields.label),
    ).toEqual(['One', 'Two'])
  })

  it('keeps every uid, so a read-modify-write can address a block', () => {
    const nested = toNested(sample(), schema)
    expect(at(nested, 'body', 0).uid).toBe('h')
    expect(at(nested, 'body', 0, 'actions', 1).uid).toBe('b2')
  })

  it('emits a declared slot with no children as an empty array', () => {
    const nested = toNested(sample(), schema)
    expect(nested.fields.aside).toEqual([])
    expect(at(nested, 'body', 1).fields).not.toHaveProperty('actions')
  })

  it('never emits a blocks field as a scalar, even when data holds one', () => {
    const doc = sample()
    // Drift: something wrote a value into a slot's name.
    doc.bloks[ROOT]!.data.body = 'not a block list'
    const nested = toNested(doc, schema)
    expect(Array.isArray(nested.fields.body)).toBe(true)
  })

  it('reads a slot whose field the schema no longer declares', () => {
    const doc = sample()
    doc.bloks.extra = blk('extra', { type: 'prose', slot: 'removedSlot', order: 'a0' })
    const nested = toNested(doc, schema)
    expect((nested.fields.removedSlot as NestedBlok[]).map((b) => b.uid)).toEqual(['extra'])
  })

  it('reads a block whose type was removed from the schema, as-is', () => {
    const doc = sample()
    doc.bloks.gone = blk('gone', { type: 'vanished', order: 'a2', data: { whatever: 1 } })
    const nested = toNested(doc, schema)
    const found = (nested.fields.body as NestedBlok[]).find((b) => b.uid === 'gone')!
    expect(found.type).toBe('vanished')
    expect(found.fields.whatever).toBe(1)
  })

  it('carries i18n verbatim, and omits it when absent', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    const nested = toNested(doc, schema)
    expect(nested.i18n).toEqual({ fr: { title: 'À propos' } })
    expect(at(nested, 'body', 0)).not.toHaveProperty('i18n')
  })

  it('resolves fields in a locale and then omits i18n entirely', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    const nested = toNested(doc, schema, { locale: { code: 'fr', fallbacks: [] } })
    expect(nested.fields.title).toBe('À propos')
    expect(nested).not.toHaveProperty('i18n')
  })

  it('falls back through the locale chain, like every other field read', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    const nested = toNested(doc, schema, { locale: { code: 'fr-CA', fallbacks: ['fr'] } })
    expect(nested.fields.title).toBe('À propos')
  })

  it('refuses a document with no root block', () => {
    expect(() => toNested({ root: 'missing', bloks: {} }, schema)).toThrow(NestedError)
  })

  it('terminates on a cyclic document rather than recursing forever', () => {
    const doc = mkDoc([
      { uid: ROOT, type: 'page', parent: null, slot: null, order: 'a0', data: {} },
      blk('x', { parent: 'y', slot: 'body' }),
      blk('y', { parent: 'x', slot: 'body' }),
    ])
    // Neither is reachable from the root, so the walk simply finds nothing.
    expect(toNested(doc, schema).fields.body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// fromNested — round trip
// ---------------------------------------------------------------------------

describe('fromNested round trip', () => {
  it('reproduces the document exactly, against its own base', () => {
    const doc = sample()
    expect(fromNested(toNested(doc, schema), schema, doc)).toEqual(doc)
  })

  it('reproduces it in replace mode too', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    expect(fromNested(toNested(doc, schema), schema, doc, { mode: 'replace' })).toEqual(doc)
  })

  it('preserves structure with no base, minting fresh order keys', () => {
    const doc = sample()
    const rebuilt = fromNested(toNested(doc, schema), schema)
    expect(Object.keys(rebuilt.bloks).sort()).toEqual(Object.keys(doc.bloks).sort())
    for (const [uid, blok] of Object.entries(rebuilt.bloks)) {
      const was = doc.bloks[uid]!
      expect({ ...blok, order: '' }).toEqual({ ...was, order: '' })
    }
    // The sequence survives even though the keys are new.
    expect(sequence(rebuilt, ROOT, 'body')).toEqual(sequence(doc, ROOT, 'body'))
  })

  it('emits one set mutation for one edited field', () => {
    const doc = sample()
    const nested = toNested(doc, schema)
    ;(nested.fields.body as NestedBlok[])[0]!.fields.heading = 'Changed'
    const target = fromNested(nested, schema, doc)
    expect(diff(doc, target)).toEqual([{ t: 'set', uid: 'h', field: 'heading', value: 'Changed' }])
  })

  it('writes nothing at all for an unchanged payload', () => {
    const doc = sample()
    expect(diff(doc, fromNested(toNested(doc, schema), schema, doc))).toEqual([])
  })
})

function sequence(doc: Doc, parent: string, slot: string): string[] {
  return Object.values(doc.bloks)
    .filter((b) => b.parent === parent && b.slot === slot)
    .sort((a, b) => (a.order === b.order ? a.uid.localeCompare(b.uid) : a.order < b.order ? -1 : 1))
    .map((b) => b.uid)
}

// ---------------------------------------------------------------------------
// fromNested — inserts and reorders
// ---------------------------------------------------------------------------

/**
 * Fifty siblings whose order keys come from `keyAtIndex`, not from a made-up
 * `a00` sequence: `generateKeyBetween` refuses a key it did not mint, so a
 * hand-written fixture would test the wrong thing (and did, first time round).
 */
function fiftyDeep(): Doc {
  const bloks: Blok[] = [
    { uid: ROOT, type: 'page', parent: null, slot: null, order: 'a0', data: {} },
  ]
  const keys: string[] = []
  for (let i = 0; i < 50; i++) {
    const order = keyAtIndex(keys, keys.length)
    keys.push(order)
    bloks.push(blk(`p${i}`, { order }))
  }
  return mkDoc(bloks)
}

/** A new block with no uid — what a caller writes when adding one. */
const fresh = (type: string, fields: Record<string, Json> = {}): NestedInput => ({ type, fields })

/** The read node with one or more slots replaced, as a payload. */
const withSlots = (
  node: NestedBlok,
  slots: Record<string, readonly NestedInput[]>,
): NestedInput => ({ ...node, fields: { ...node.fields, ...slots } })

const slotOf = (node: NestedBlok, name: string): NestedBlok[] => node.fields[name] as NestedBlok[]

describe('fromNested ordering', () => {
  it('adds a block with no uid and keeps the ones that were there', () => {
    const doc = sample()
    const nested = toNested(doc, schema)
    const body = slotOf(nested, 'body')

    const target = fromNested(
      withSlots(nested, { body: [body[0]!, body[1]!, fresh('prose', { body: null })] }),
      schema,
      doc,
    )
    expect(summariseDiff(diff(doc, target))).toMatchObject({ added: 1, removed: 0, moved: 0 })
    expect(sequence(target, ROOT, 'body').slice(0, 2)).toEqual(['h', 'p'])
  })

  it('swaps two blocks and adds a third with a minimal set of moves', () => {
    const doc = sample()
    const nested = toNested(doc, schema)
    const body = slotOf(nested, 'body')

    const target = fromNested(
      withSlots(nested, { body: [body[1]!, body[0]!, fresh('prose', { body: null })] }),
      schema,
      doc,
    )
    // One insert, and exactly one move — not two inserts and two removes, which
    // is the failure mode a shape without uids would have.
    expect(summariseDiff(diff(doc, target))).toMatchObject({ added: 1, removed: 0, moved: 1 })
    expect(sequence(target, ROOT, 'body').slice(0, 2)).toEqual(['p', 'h'])
  })

  it('inserting at the front of fifty writes one insert and no moves', () => {
    const doc = fiftyDeep()
    const nested = toNested(doc, schema)
    const payload = withSlots(nested, {
      body: [fresh('prose', { body: null }), ...slotOf(nested, 'body')],
    })
    expect(summariseDiff(diff(doc, fromNested(payload, schema, doc)))).toMatchObject({
      added: 1,
      removed: 0,
      moved: 0,
    })
  })

  it('moving one item of fifty to the front moves exactly one', () => {
    const doc = fiftyDeep()
    const nested = toNested(doc, schema)
    const body = slotOf(nested, 'body')
    const payload = withSlots(nested, { body: [body[49]!, ...body.slice(0, 49)] })
    expect(summariseDiff(diff(doc, fromNested(payload, schema, doc)))).toMatchObject({
      added: 0,
      removed: 0,
      moved: 1,
    })
  })

  it('removes a block a supplied slot no longer lists', () => {
    const doc = sample()
    const nested = toNested(doc, schema)
    const target = fromNested(
      withSlots(nested, { body: [slotOf(nested, 'body')[0]!] }),
      schema,
      doc,
    )
    expect(target.bloks.p).toBeUndefined()
    expect(diff(doc, target)).toEqual([{ t: 'remove', uid: 'p' }])
  })

  it('gives a block moved between slots a fresh key rather than its old one', () => {
    const doc = sample()
    const nested = toNested(doc, schema)
    const body = slotOf(nested, 'body')
    const target = fromNested(
      withSlots(nested, { body: [body[0]!], aside: [body[1]!] }),
      schema,
      doc,
    )
    expect(target.bloks.p!.slot).toBe('aside')
    expect(summariseDiff(diff(doc, target))).toMatchObject({ added: 0, removed: 0, moved: 1 })
  })
})

describe('assignOrders', () => {
  it('keeps every key when the sequence is already sorted', () => {
    expect(assignOrders(['a0', 'a1', 'a2'])).toEqual(['a0', 'a1', 'a2'])
  })

  it('mints keys for the new entries and keeps the rest in order', () => {
    const out = assignOrders(['a0', undefined, 'a1'])
    expect(out[0]).toBe('a0')
    expect(out[2]).toBe('a1')
    expect(out[0]! < out[1]!).toBe(true)
    expect(out[1]! < out[2]!).toBe(true)
  })

  it('keeps the longest increasing run, not merely a greedy prefix', () => {
    // A greedy scan would keep only 'a3' and remint a0..a2.
    const out = assignOrders(['a3', 'a0', 'a1', 'a2'])
    expect(out.slice(1)).toEqual(['a0', 'a1', 'a2'])
    expect(out[0]! < out[1]!).toBe(true)
  })

  it('never keeps both of a tied pair, so a gap never has equal bounds', () => {
    const out = assignOrders(['a0', 'a0', 'a0'])
    expect(new Set(out).size).toBe(3)
    expect(out[0]! < out[1]!).toBe(true)
    expect(out[1]! < out[2]!).toBe(true)
  })

  it('mints a whole fresh sequence when nothing existed', () => {
    const out = assignOrders([undefined, undefined, undefined])
    expect(out[0]! < out[1]!).toBe(true)
    expect(out[1]! < out[2]!).toBe(true)
  })

  it('is empty for an empty slot', () => {
    expect(assignOrders([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// fromNested — merge and replace
// ---------------------------------------------------------------------------

describe('fromNested merge mode', () => {
  it('leaves an absent scalar field alone', () => {
    const doc = sample()
    doc.bloks[ROOT]!.data.noindex = true
    const target = fromNested({ uid: ROOT, fields: { title: 'New' } }, schema, doc)
    expect(target.bloks[ROOT]!.data).toEqual({ title: 'New', noindex: true })
  })

  it('leaves an absent slot alone, subtrees and all', () => {
    const doc = sample()
    const target = fromNested({ uid: ROOT, fields: { title: 'New' } }, schema, doc)
    expect(Object.keys(target.bloks).sort()).toEqual(['b1', 'b2', 'h', 'p', ROOT].sort())
    expect(diff(doc, target)).toEqual([{ t: 'set', uid: ROOT, field: 'title', value: 'New' }])
  })

  it('leaves absent translations alone', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    const target = fromNested({ uid: ROOT, fields: { title: 'New' } }, schema, doc)
    expect(target.bloks[ROOT]!.i18n).toEqual({ fr: { title: 'À propos' } })
  })

  it('layers supplied translations over the stored ones, per locale and field', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' }, de: { title: 'Über uns' } }
    const target = fromNested(
      { uid: ROOT, fields: {}, i18n: { fr: { title: 'Nouveau' } } },
      schema,
      doc,
    )
    expect(target.bloks[ROOT]!.i18n).toEqual({
      fr: { title: 'Nouveau' },
      de: { title: 'Über uns' },
    })
  })

  it('needs no type for a block it already knows', () => {
    const doc = sample()
    const target = fromNested(
      { uid: ROOT, fields: { body: [{ uid: 'h', fields: { heading: 'Hi' } }] } },
      schema,
      doc,
    )
    expect(target.bloks.h!.type).toBe('hero')
    expect(target.bloks.h!.data.heading).toBe('Hi')
    // Merge keeps the hero's own untouched field and its children.
    expect(target.bloks.h!.data.align).toBe('left')
    expect(target.bloks.b1).toBeDefined()
  })
})

describe('fromNested replace mode', () => {
  it('clears a field the payload does not mention', () => {
    const doc = sample()
    doc.bloks[ROOT]!.data.noindex = true
    const target = fromNested({ uid: ROOT, fields: { title: 'New' } }, schema, doc, {
      mode: 'replace',
    })
    expect(target.bloks[ROOT]!.data).toEqual({ title: 'New' })
  })

  it('removes the children of a slot the payload does not mention', () => {
    const doc = sample()
    const target = fromNested({ uid: ROOT, fields: { title: 'x' } }, schema, doc, {
      mode: 'replace',
    })
    expect(Object.keys(target.bloks)).toEqual([ROOT])
  })

  it('refuses to silently discard translations it was not told about', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    expect(() =>
      fromNested({ uid: ROOT, type: 'page', fields: { title: 'x' } }, schema, doc, {
        mode: 'replace',
      }),
    ).toThrow(/would discard the translations/)
  })

  it('accepts an explicit empty i18n as "clear them"', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: 'À propos' } }
    const target = fromNested({ uid: ROOT, fields: { title: 'x' }, i18n: {} }, schema, doc, {
      mode: 'replace',
    })
    expect(target.bloks[ROOT]!.i18n).toBeUndefined()
  })

  it('does not complain about a blok whose translations are all null', () => {
    const doc = sample()
    doc.bloks[ROOT]!.i18n = { fr: { title: null } }
    expect(() =>
      fromNested({ uid: ROOT, fields: { title: 'x' } }, schema, doc, { mode: 'replace' }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// fromNested — refusals
// ---------------------------------------------------------------------------

describe('fromNested refusals', () => {
  const refuse = (input: unknown, base?: Doc, mode?: 'merge' | 'replace') => {
    try {
      fromNested(input, schema, base, mode ? { mode } : undefined)
    } catch (e) {
      if (e instanceof NestedError) return e
      throw e
    }
    throw new Error('expected a NestedError')
  }

  it('refuses a payload that is not an object', () => {
    expect(refuse('nope').message).toMatch(/must be a JSON object/)
    expect(refuse([]).message).toMatch(/must be a JSON object/)
  })

  it('refuses an unknown block type, naming it', () => {
    const e = refuse({ type: 'nope', fields: {} })
    expect(e.message).toMatch(/not a declared block type: 'nope'/)
  })

  it('names the failing path for a misspelled field', () => {
    const e = refuse(
      { type: 'page', fields: { body: [{ type: 'hero', fields: { headng: 'oops' } }] } },
      undefined,
    )
    expect(e.path).toBe('body[0].fields.headng')
    expect(e.message).toMatch(/is not a field of 'hero'/)
  })

  it('names the failing path for an unknown type deep in the tree', () => {
    const e = refuse({ type: 'page', fields: { body: [{ type: 'nope', fields: {} }] } })
    expect(e.path).toBe('body[0].type')
  })

  it('refuses a block a slot does not allow', () => {
    const e = refuse({ type: 'page', fields: { body: [{ type: 'button', fields: {} }] } })
    expect(e.path).toBe('body[0]')
    expect(e.message).toMatch(/slot 'body' does not allow/)
  })

  it('refuses a slot over its declared max', () => {
    const e = refuse({
      type: 'page',
      fields: {
        aside: [
          { type: 'prose', fields: {} },
          { type: 'prose', fields: {} },
        ],
      },
    })
    expect(e.message).toMatch(/allows at most 1/)
  })

  it('refuses a value of the wrong JSON shape, naming the path', () => {
    const e = refuse({ type: 'page', fields: { noindex: 'yes' } })
    expect(e.path).toBe('fields.noindex')
    expect(e.message).toMatch(/must be true or false/)
  })

  it('refuses a scalar written into a slot', () => {
    const e = refuse({ type: 'page', fields: { body: 'text' } })
    expect(e.message).toMatch(/must be an array of blocks/)
  })

  it('refuses a duplicate uid within one payload', () => {
    const e = refuse({
      type: 'page',
      fields: {
        body: [
          { uid: 'dup', type: 'prose', fields: {} },
          { uid: 'dup', type: 'prose', fields: {} },
        ],
      },
    })
    expect(e.message).toMatch(/reuses uid 'dup'/)
  })

  it('refuses a malformed uid', () => {
    const e = refuse({
      type: 'page',
      fields: { body: [{ uid: 'a/b', type: 'prose', fields: {} }] },
    })
    expect(e.path).toBe('body[0].uid')
  })

  it('refuses a root uid that is not the base document root', () => {
    const e = refuse({ uid: 'somethingelse', type: 'page', fields: {} }, sample())
    expect(e.message).toMatch(/never replaced/)
  })

  it("refuses changing the root block's type", () => {
    const e = refuse({ uid: ROOT, type: 'hero', fields: {} }, sample())
    expect(e.message).toMatch(/schema migration/)
  })

  it('refuses a new block with no type at all', () => {
    const e = refuse({ type: 'page', fields: { body: [{ fields: {} }] } })
    expect(e.path).toBe('body[0].type')
    expect(e.message).toMatch(/required for a new block/)
  })

  it('refuses a non-object i18n and a bad locale code', () => {
    expect(refuse({ type: 'page', fields: {}, i18n: 'fr' }).message).toMatch(
      /must be a JSON object/,
    )
    expect(refuse({ type: 'page', fields: {}, i18n: { 'fr!': {} } }).message).toMatch(
      /not a locale code/,
    )
  })

  it('refuses a per-locale value for a blocks field', () => {
    const e = refuse({ type: 'page', fields: {}, i18n: { fr: { body: [] } } })
    expect(e.message).toMatch(/children are not a per-locale value/)
  })

  it('refuses a payload nested past the depth ceiling', () => {
    let node: NestedBlok = { type: 'nest', fields: {} } as NestedBlok
    for (let i = 0; i < MAX_NESTED_DEPTH + 2; i++) {
      node = { type: 'nest', fields: { kids: [node] } } as unknown as NestedBlok
    }
    expect(refuse({ type: 'page', fields: { body: [node] } }).message).toMatch(/nests deeper than/)
  })

  it('refuses a non-JSON value', () => {
    const e = refuse({ type: 'page', fields: { title: undefined, noindex: false } })
    expect(e.path).toBe('fields.title')
  })

  it('refuses an undeclared field the base does not already store', () => {
    const e = refuse({ uid: ROOT, fields: { invented: 1 } }, sample())
    expect(e.path).toBe('fields.invented')
  })

  it('lets an unchanged orphaned key pass straight back through', () => {
    const doc = sample()
    doc.bloks[ROOT]!.data.orphan = 'left over'
    const target = fromNested(toNested(doc, schema), schema, doc)
    expect(target.bloks[ROOT]!.data.orphan).toBe('left over')
    expect(diff(doc, target)).toEqual([])
  })

  it('refuses changing an orphaned key rather than writing it', () => {
    const doc = sample()
    doc.bloks[ROOT]!.data.orphan = 'left over'
    const nested = toNested(doc, schema)
    const payload = { ...nested, fields: { ...nested.fields, orphan: 'changed' } }
    expect(() => fromNested(payload, schema, doc)).toThrow(/sent back unchanged, but not changed/)
  })

  it('lets a block whose type was deleted from the code still be written', () => {
    const doc = sample()
    doc.bloks.gone = blk('gone', { type: 'vanished', order: 'a2', data: { whatever: 1 } })
    const nested = toNested(doc, schema)
    const target = fromNested(
      { ...nested, fields: { ...nested.fields, title: 'New' } },
      schema,
      doc,
    )
    expect(target.bloks.gone!.type).toBe('vanished')
    expect(diff(doc, target)).toEqual([{ t: 'set', uid: ROOT, field: 'title', value: 'New' }])
  })

  it('refuses a uid that is both placed and carried over from an unmentioned slot', () => {
    const doc = sample()
    // `p` lives in `body`; place it in `aside` while leaving `body` unmentioned.
    const e = refuse({ uid: ROOT, fields: { aside: [{ uid: 'p', fields: {} }] } }, doc)
    expect(e.message).toMatch(/also carried over/)
  })
})

// ---------------------------------------------------------------------------
// fieldShapeError
// ---------------------------------------------------------------------------

describe('fieldShapeError', () => {
  const every = schema.every!.fields
  const ok = (name: keyof typeof every, value: unknown) => fieldShapeError(every[name]!, value)

  it('accepts the stored shape of every field kind', () => {
    expect(ok('t', 'hi')).toBeNull()
    expect(ok('ta', '')).toBeNull()
    expect(ok('n', 3.5)).toBeNull()
    expect(ok('b', false)).toBeNull()
    expect(ok('s', 'a')).toBeNull()
    expect(ok('s', '')).toBeNull()
    expect(ok('a', null)).toBeNull()
    expect(ok('a', { key: 'ast_x', filename: 'x.png' })).toBeNull()
    expect(ok('ma', [])).toBeNull()
    expect(ok('ml', null)).toBeNull()
    expect(ok('rt', { type: 'doc', content: [] })).toBeNull()
    expect(ok('ref', null)).toBeNull()
    expect(ok('ref', 'sty_x')).toBeNull()
    expect(ok('refs', ['sty_x', 'sty_y'])).toBeNull()
    expect(ok('col', {})).toBeNull()
    expect(ok('kids', [])).toBeNull()
  })

  it('refuses the wrong shape for each kind', () => {
    expect(ok('t', 1)).toMatch(/string/)
    expect(ok('n', '3')).toMatch(/number/)
    expect(ok('n', Number.POSITIVE_INFINITY)).toMatch(/finite/)
    expect(ok('b', 'true')).toMatch(/true or false/)
    expect(ok('s', 'nope')).toMatch(/must be one of: a/)
    expect(ok('a', 'ast_x')).toMatch(/object or null/)
    expect(ok('ma', {})).toMatch(/array/)
    expect(ok('rt', 'prose')).toMatch(/object or null/)
    expect(ok('ref', 42)).toMatch(/story id or null/)
    expect(ok('refs', ['a', 2])).toMatch(/array of story ids/)
    expect(ok('col', [])).toMatch(/object/)
    expect(ok('kids', {})).toMatch(/array of blocks/)
  })

  it('refuses a value that is not JSON at all', () => {
    expect(ok('a', { fn: () => 1 })).toMatch(/JSON value/)
    expect(ok('ma', [undefined])).toMatch(/JSON value/)
  })
})

// ---------------------------------------------------------------------------
// Seeded property: round trip against the base is identity
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number
const int = (rand: Rand, n: number) => Math.floor(rand() * n)
const pick = <T>(rand: Rand, xs: readonly T[]): T => xs[int(rand, xs.length)]!

/** Only shapes the schema above actually permits, so the generator never trips a refusal. */
function randDoc(rand: Rand): Doc {
  const bloks: Record<string, Blok> = {
    [ROOT]: {
      uid: ROOT,
      type: 'page',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title: pick(rand, ['One', 'Two', '']), noindex: int(rand, 2) === 0 },
      ...(int(rand, 3) === 0 ? { i18n: { fr: { title: pick(rand, ['Un', 'Deux', null]) } } } : {}),
    },
  }
  const bodyCount = int(rand, 6)
  const heroes: string[] = []
  for (let i = 0; i < bodyCount; i++) {
    const uid = `n${i}`
    const type = pick(rand, ['hero', 'prose'] as const)
    bloks[uid] = {
      uid,
      type,
      parent: ROOT,
      slot: 'body',
      order: `a${i}`,
      data:
        type === 'hero'
          ? { heading: pick(rand, ['H', '']), align: pick(rand, ['left', 'center']) }
          : { body: null },
    }
    if (type === 'hero') heroes.push(uid)
  }
  if (int(rand, 3) === 0) {
    bloks.side = { uid: 'side', type: 'prose', parent: ROOT, slot: 'aside', order: 'a0', data: {} }
  }
  let button = 0
  for (const hero of heroes) {
    for (let i = 0; i < int(rand, 3); i++) {
      const uid = `btn${button++}`
      bloks[uid] = {
        uid,
        type: 'button',
        parent: hero,
        slot: 'actions',
        order: `a${i}`,
        data: { label: pick(rand, ['Go', '']), link: null },
      }
    }
  }
  return { root: ROOT, bloks }
}

describe('fromNested/toNested round trip (seeded property)', () => {
  it('is identity against the base for 300 generated documents, in both modes', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = randDoc(mulberry32(seed))
      const nested = toNested(doc, schema)
      expect(fromNested(nested, schema, doc), `seed ${seed} merge`).toEqual(doc)
      expect(fromNested(nested, schema, doc, { mode: 'replace' }), `seed ${seed} replace`).toEqual(
        doc,
      )
      expect(diff(doc, fromNested(nested, schema, doc)), `seed ${seed} diff`).toEqual([])
    }
  })

  it('preserves every sibling sequence when rebuilt with no base', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const doc = randDoc(mulberry32(seed))
      const rebuilt = fromNested(toNested(doc, schema), schema)
      for (const parent of Object.keys(doc.bloks)) {
        for (const slot of ['body', 'aside', 'actions']) {
          expect(sequence(rebuilt, parent, slot), `seed ${seed} ${parent}/${slot}`).toEqual(
            sequence(doc, parent, slot),
          )
        }
      }
    }
  })
})
