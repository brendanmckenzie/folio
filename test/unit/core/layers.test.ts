import { describe, expect, it } from 'vitest'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { diff } from '../../../src/core/diff'
import { blocks, text } from '../../../src/core/fields'
import { isBareLayer, layerStates, mergeLayers } from '../../../src/core/layers'
import { fieldValue } from '../../../src/core/locales'
import { applyAll } from '../../../src/core/mutations'
import { fromNested, NestedError, toNested } from '../../../src/core/nested'
import type { SchemaIndex } from '../../../src/core/schema'

/**
 * Decision 8's table, one test per row, then the `i18n` rule and the labels.
 *
 * The fixture is a header: a title, a call to action, a `max: 1` theme block that
 * can be one of two types, and a many-blocks list of links.
 */
const schema: SchemaIndex = {
  header: {
    name: 'header',
    label: 'Header',
    fields: {
      title: text({ translatable: true, required: true }),
      cta: text({ translatable: true }),
      logo: text(),
      theme: blocks({ allow: ['theme', 'plain'], max: 1 }),
      links: blocks({ allow: ['link'] }),
    },
  },
  theme: { name: 'theme', label: 'Theme', fields: { primary: text(), radius: text() } },
  plain: { name: 'plain', label: 'Plain', fields: { primary: text() } },
  link: { name: 'link', label: 'Link', fields: { label: text() } },
}

let n = 0
const uid = (prefix: string) => `${prefix}${++n}`

interface Spec {
  data?: Record<string, Json>
  i18n?: Blok['i18n']
  theme?: { type?: string; data: Record<string, Json> }
  links?: string[]
}

/** A layer document: a header root, an optional theme child, and any links. */
function layer(spec: Spec = {}): Doc {
  const root = uid('root')
  const bloks: Record<string, Blok> = {
    [root]: {
      uid: root,
      type: 'header',
      parent: null,
      slot: null,
      order: 'a0',
      data: spec.data ?? {},
      ...(spec.i18n ? { i18n: spec.i18n } : {}),
    },
  }
  if (spec.theme) {
    const id = uid('theme')
    bloks[id] = {
      uid: id,
      type: spec.theme.type ?? 'theme',
      parent: root,
      slot: 'theme',
      order: 'a0',
      data: spec.theme.data,
    }
  }
  for (const [i, label] of (spec.links ?? []).entries()) {
    const id = uid('link')
    bloks[id] = {
      uid: id,
      type: 'link',
      parent: root,
      slot: 'links',
      order: `a${i}`,
      data: { label },
    }
  }
  return { root, bloks }
}

const rootOf = (doc: Doc | undefined): Blok => doc!.bloks[doc!.root]!
const dataOf = (doc: Doc | undefined) => rootOf(doc).data
const kids = (doc: Doc | undefined, slot: string): Blok[] =>
  Object.values(doc!.bloks)
    .filter((b) => b.parent === doc!.root && b.slot === slot)
    .sort((a, b) => (a.order < b.order ? -1 : 1))
const fr = { code: 'fr', fallbacks: [] }

describe('mergeLayers', () => {
  it('returns nothing when no layer exists', () => {
    expect(mergeLayers([undefined, undefined], schema)).toBeUndefined()
    expect(mergeLayers([], schema)).toBeUndefined()
  })

  it('returns a chain of one exactly as it is, the same object', () => {
    // The single-site case, and the whole of "byte-identical with no `sites`": no
    // copy, no normalising, no null stripped.
    const only = layer({ data: { title: 'A', cta: null } })
    expect(mergeLayers([only], schema)).toBe(only)
  })

  it('reads a layer with nothing below it as itself, minus what it removed', () => {
    const north = layer({ data: { title: 'North', cta: null } })
    const merged = mergeLayers([undefined, north], schema)
    expect(dataOf(merged)).toEqual({ title: 'North' })
  })

  it('inherits a key the more specific layer does not hold', () => {
    const shared = layer({ data: { title: 'A', cta: 'Visit' } })
    const alpha = layer({ data: { title: 'Alpha' } })
    expect(dataOf(mergeLayers([shared, alpha], schema))).toEqual({ title: 'Alpha', cta: 'Visit' })
  })

  it('treats null as removed, and removed as the answer for every layer above it', () => {
    const shared = layer({ data: { title: 'A', cta: 'Visit' } })
    const north = layer({ data: { title: null } })
    const alpha = layer({ data: { cta: 'Go' } })
    const merged = mergeLayers([shared, north, alpha], schema)
    expect(dataOf(merged)).toEqual({ cta: 'Go' })
    expect('title' in dataOf(merged)).toBe(false)
  })

  it('lets a layer set a key again after a layer below it removed it', () => {
    const shared = layer({ data: { title: 'A' } })
    const north = layer({ data: { title: null } })
    const alpha = layer({ data: { title: 'Alpha' } })
    expect(dataOf(mergeLayers([shared, north, alpha], schema))).toEqual({ title: 'Alpha' })
  })

  it('replaces any other value whole, never merging it structurally', () => {
    // A link merged over a link is a value nobody wrote.
    const shared = layer({ data: { logo: { href: '/a', label: 'A', target: '_blank' } } })
    const alpha = layer({ data: { logo: { href: '/b' } } })
    expect(dataOf(mergeLayers([shared, alpha], schema)).logo).toEqual({ href: '/b' })
  })

  it('does not mutate a layer it merges', () => {
    const shared = layer({ data: { title: 'A' }, theme: { data: { primary: '#000' } } })
    const alpha = layer({ data: { title: null }, theme: { data: { radius: 'sq' } } })
    const before = JSON.stringify([shared, alpha])
    mergeLayers([shared, alpha], schema)
    expect(JSON.stringify([shared, alpha])).toBe(before)
  })

  describe('a max: 1 blocks field', () => {
    it('merges a child of the inherited type recursively, field by field', () => {
      const shared = layer({ theme: { data: { primary: '#000', radius: 'round' } } })
      const alpha = layer({ theme: { data: { primary: '#e00' } } })
      const merged = mergeLayers([shared, alpha], schema)
      const [theme] = kids(merged, 'theme')
      expect(theme!.type).toBe('theme')
      expect(theme!.data).toEqual({ primary: '#e00', radius: 'round' })
      expect(kids(merged, 'theme')).toHaveLength(1)
    })

    it('lets the child remove one of its own fields', () => {
      const shared = layer({ theme: { data: { primary: '#000', radius: 'round' } } })
      const alpha = layer({ theme: { data: { radius: null } } })
      const [theme] = kids(mergeLayers([shared, alpha], schema), 'theme')
      expect(theme!.data).toEqual({ primary: '#000' })
    })

    it('replaces the inherited child when the child has another type', () => {
      const shared = layer({ theme: { data: { primary: '#000', radius: 'round' } } })
      const alpha = layer({ theme: { type: 'plain', data: { primary: '#e00' } } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'theme').map((b) => [b.type, b.data])).toEqual([
        ['plain', { primary: '#e00' }],
      ])
    })

    it('inherits the child when the layer has none', () => {
      const shared = layer({ theme: { data: { primary: '#000' } } })
      const alpha = layer({ data: { title: 'Alpha' } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'theme').map((b) => b.data)).toEqual([{ primary: '#000' }])
      // Re-parented under the merged root, not left pointing at shared's.
      expect(kids(merged, 'theme')[0]!.parent).toBe(merged!.root)
    })

    it('reads a null under the slot as removed, whatever the layers below hold', () => {
      const shared = layer({ theme: { data: { primary: '#000' } } })
      const alpha = layer({ data: { theme: null } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'theme')).toEqual([])
      expect('theme' in dataOf(merged)).toBe(false)
    })
  })

  describe('a many-blocks field', () => {
    it('replaces the inherited children when the layer has children', () => {
      const shared = layer({ links: ['One', 'Two', 'Three'] })
      const alpha = layer({ links: ['Mine'] })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'links').map((b) => b.data.label)).toEqual(['Mine'])
    })

    it('inherits the children when the layer has none', () => {
      const shared = layer({ links: ['One', 'Two'] })
      const alpha = layer({ data: { title: 'Alpha' } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'links').map((b) => b.data.label)).toEqual(['One', 'Two'])
    })

    it('reads a null under the slot as removed, the way to say "no links at all"', () => {
      const shared = layer({ links: ['One', 'Two'] })
      const alpha = layer({ data: { links: null } })
      expect(kids(mergeLayers([shared, alpha], schema), 'links')).toEqual([])
    })

    it('keeps the order of the winning layer, and every descendant', () => {
      const shared = layer({ links: ['One'] })
      const alpha = layer({ links: ['B', 'A'] })
      const merged = mergeLayers([shared, alpha], schema)
      expect(kids(merged, 'links').map((b) => b.data.label)).toEqual(['B', 'A'])
      expect(Object.keys(merged!.bloks)).toHaveLength(3)
    })
  })

  describe('i18n', () => {
    it('inherits a locale key the layer does not hold', () => {
      const shared = layer({
        data: { title: 'A', cta: 'Visit' },
        i18n: { fr: { cta: 'Visitez', title: 'Le A' } },
      })
      const alpha = layer({ i18n: { fr: { cta: 'Allez' } } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(rootOf(merged).i18n).toEqual({ fr: { cta: 'Allez', title: 'Le A' } })
      expect(fieldValue(rootOf(merged), 'title', fr)).toBe('Le A')
      expect(fieldValue(rootOf(merged), 'cta', fr)).toBe('Allez')
    })

    it('keeps null as untranslated: the field falls back to the merged source value', () => {
      const shared = layer({ data: { cta: 'Visit' }, i18n: { fr: { cta: 'Visitez' } } })
      const north = layer({ data: { cta: 'Hello' } })
      const alpha = layer({ i18n: { fr: { cta: null } } })
      const merged = mergeLayers([shared, north, alpha], schema)
      // Not Shared's French, and not removed: the merged source value.
      expect(rootOf(merged).i18n).toEqual({ fr: { cta: null } })
      expect(dataOf(merged).cta).toBe('Hello')
      expect(fieldValue(rootOf(merged), 'cta', fr)).toBe('Hello')
    })

    it('never reads a null translation as removing the source value', () => {
      const shared = layer({ data: { title: 'A' } })
      const alpha = layer({ i18n: { fr: { title: null } } })
      expect(dataOf(mergeLayers([shared, alpha], schema))).toEqual({ title: 'A' })
    })

    it('drops the translations of a source field the layer removed', () => {
      const shared = layer({ data: { title: 'A' }, i18n: { fr: { title: 'Le A', cta: 'Oui' } } })
      const alpha = layer({ data: { title: null } })
      const merged = mergeLayers([shared, alpha], schema)
      expect(rootOf(merged).i18n).toEqual({ fr: { cta: 'Oui' } })
    })

    it('adds a locale a lower layer never had', () => {
      const shared = layer({ data: { cta: 'Visit' } })
      const alpha = layer({ i18n: { de: { cta: 'Besuchen' } } })
      expect(rootOf(mergeLayers([shared, alpha], schema)).i18n).toEqual({ de: { cta: 'Besuchen' } })
    })

    it('leaves i18n off a blok when no layer holds a translation', () => {
      const shared = layer({ data: { title: 'A' } })
      const alpha = layer({ data: { title: 'B' } })
      expect(rootOf(mergeLayers([shared, alpha], schema))).not.toHaveProperty('i18n')
    })
  })

  it("reads the spec's header example: shared, north and alpha", () => {
    const shared = layer({ data: { title: 'A', cta: 'Visit' } })
    const north = layer({ data: { cta: 'Hello' } })
    const alpha = layer({ data: { title: null } })
    const onAlpha = mergeLayers([shared, north, alpha], schema)
    expect(dataOf(onAlpha)).toEqual({ cta: 'Hello' })
    // bravo has no group and no layer of its own.
    const onBravo = mergeLayers([shared, undefined], schema)
    expect(dataOf(onBravo)).toEqual({ title: 'A', cta: 'Visit' })
  })
})

describe('layerStates', () => {
  const scopes = ['shared', 'north', 'alpha']

  it("labels the spec's example: title removed here, cta inherited from north", () => {
    const shared = layer({ data: { title: 'A', cta: 'Visit' } })
    const north = layer({ data: { cta: 'Hello' } })
    const alpha = layer({ data: { title: null } })
    const states = layerStates([shared, north, alpha], scopes, schema)
    expect(states.title).toEqual({ state: 'removed', from: 'alpha' })
    expect(states.cta).toEqual({ state: 'inherited', from: 'north' })
  })

  it('labels an overridden value with the top layer as its source', () => {
    const shared = layer({ data: { title: 'A' } })
    const alpha = layer({ data: { title: 'B' } })
    expect(layerStates([shared, undefined, alpha], scopes, schema).title).toEqual({
      state: 'overridden',
      from: 'alpha',
    })
  })

  it('names no source for a field nothing below holds', () => {
    const alpha = layer({ data: { title: 'B' } })
    expect(layerStates([undefined, undefined, alpha], scopes, schema).logo).toEqual({
      state: 'inherited',
      from: null,
    })
  })

  it('reads a layer that does not exist as every field inherited', () => {
    const shared = layer({ data: { title: 'A', cta: 'Visit' } })
    const states = layerStates([shared, undefined, undefined], scopes, schema)
    expect(states.title).toEqual({ state: 'inherited', from: 'shared' })
    expect(states.cta).toEqual({ state: 'inherited', from: 'shared' })
    expect(states.logo).toEqual({ state: 'inherited', from: null })
    expect(Object.keys(states).sort()).toEqual(['cta', 'links', 'logo', 'theme', 'title'])
  })

  it('reads a removal below as the thing being inherited', () => {
    const shared = layer({ data: { title: 'A' } })
    const north = layer({ data: { title: null } })
    const alpha = layer({})
    expect(layerStates([shared, north, alpha], scopes, schema).title).toEqual({
      state: 'inherited',
      from: 'north',
    })
  })

  it('labels a blocks field by its children, and by a null under its name', () => {
    const shared = layer({ links: ['One'] })
    const alpha = layer({ links: ['Mine'], data: { theme: null } })
    const states = layerStates([shared, undefined, alpha], scopes, schema)
    expect(states.links).toEqual({ state: 'overridden', from: 'alpha' })
    expect(states.theme).toEqual({ state: 'removed', from: 'alpha' })
    const inherits = layerStates([shared, undefined, layer()], scopes, schema)
    expect(inherits.links).toEqual({ state: 'inherited', from: 'shared' })
  })

  it("labels the fields of a merged max: 1 child one by one, keyed 'slot.field'", () => {
    const shared = layer({ theme: { data: { primary: '#000', radius: 'round' } } })
    const alpha = layer({ theme: { data: { primary: '#e00' } } })
    const states = layerStates([shared, undefined, alpha], scopes, schema)
    expect(states.theme).toEqual({ state: 'overridden', from: 'alpha' })
    expect(states['theme.primary']).toEqual({ state: 'overridden', from: 'alpha' })
    expect(states['theme.radius']).toEqual({ state: 'inherited', from: 'shared' })
  })

  it('does not report the fields of a child that replaced the inherited one', () => {
    const shared = layer({ theme: { data: { primary: '#000', radius: 'round' } } })
    const alpha = layer({ theme: { type: 'plain', data: { primary: '#e00' } } })
    const states = layerStates([shared, undefined, alpha], scopes, schema)
    expect(states['theme.primary']).toEqual({ state: 'overridden', from: 'alpha' })
    // `radius` is a field of the replaced child's type, not of the new one.
    expect(states).not.toHaveProperty('theme.radius')
  })

  it('answers nothing when no layer exists', () => {
    expect(layerStates([undefined, undefined, undefined], scopes, schema)).toEqual({})
  })
})

describe('isBareLayer', () => {
  it('is true for the layer of every scope but shared, and false for a non-layer', () => {
    expect(isBareLayer('sng_header:alpha')).toBe(true)
    expect(isBareLayer('sng_header:north')).toBe(true)
    // `default` is an ordinary site on a multi-site deployment: shared is below it.
    expect(isBareLayer('sng_header')).toBe(true)
    expect(isBareLayer('sng_header:shared')).toBe(false)
    expect(isBareLayer('abc123')).toBe(false)
    expect(isBareLayer('sng_')).toBe(false)
  })
})

/**
 * The v1 nested shape and `diff` for a layer with something below it: an absent key
 * is inherited, `null` is removed, and nothing is written that the editor did not.
 */
describe('a bare layer through the nested shape and diff', () => {
  const withDefaults: SchemaIndex = {
    ...schema,
    header: {
      ...schema.header!,
      fields: {
        ...schema.header!.fields,
        title: text({ translatable: true, default: 'Untitled' }),
      },
    },
    theme: {
      ...schema.theme!,
      fields: { primary: text(), radius: text({ default: 'rounded' }) },
    },
  }

  it('writes no defaults into a new blok, where an ordinary document gets them', () => {
    const base = layer()
    const input = { fields: { theme: [{ type: 'theme', fields: { primary: '#e00' } }] } }
    const bare = fromNested(input, withDefaults, base, { layer: 'bare' })
    expect(kids(bare, 'theme')[0]!.data).toEqual({ primary: '#e00' })
    const ordinary = fromNested(input, withDefaults, base)
    expect(kids(ordinary, 'theme')[0]!.data).toEqual({ primary: '#e00', radius: 'rounded' })
  })

  it('stores null for any field as removed, and leaves an absent one absent', () => {
    const out = fromNested({ fields: { cta: null, title: 'Mine' } }, withDefaults, layer(), {
      layer: 'bare',
    })
    expect(dataOf(out)).toEqual({ cta: null, title: 'Mine' })
    expect('logo' in dataOf(out)).toBe(false)
  })

  it('accepts null for a blocks field only in a layer, storing it under the slot name', () => {
    const out = fromNested(
      { fields: { theme: null } },
      withDefaults,
      layer({ theme: { data: {} } }),
      {
        layer: 'bare',
      },
    )
    expect(dataOf(out).theme).toBeNull()
    expect(kids(out, 'theme')).toEqual([])
    expect(() => fromNested({ fields: { theme: null } }, withDefaults, layer())).toThrow(
      NestedError,
    )
  })

  it('reads an array as "children, or none", clearing a stored null', () => {
    const removed = layer({ data: { theme: null } })
    const out = fromNested({ fields: { theme: [] } }, withDefaults, removed, { layer: 'bare' })
    expect('theme' in dataOf(out)).toBe(false)
  })

  it('reads a removed slot as null, and an inherited one as an empty array', () => {
    const removed = toNested(layer({ data: { theme: null } }), withDefaults, { layer: 'bare' })
    expect(removed.fields.theme).toBeNull()
    const inherited = toNested(layer(), withDefaults, { layer: 'bare' })
    expect(inherited.fields.theme).toEqual([])
    // An ordinary read never invents a null under a slot.
    expect(toNested(layer({ data: { theme: null } }), withDefaults).fields.theme).toEqual([])
  })

  it('round-trips a layer through toNested and fromNested', () => {
    const doc = layer({ data: { title: null, cta: 'Hi' }, theme: { data: { primary: '#000' } } })
    const again = fromNested(toNested(doc, withDefaults, { layer: 'bare' }), withDefaults, doc, {
      layer: 'bare',
      mode: 'replace',
    })
    expect(again).toEqual(doc)
  })

  describe('diff', () => {
    it('writes an unset for a key that vanished, and a set of null for a key that became null', () => {
      const from = layer({ data: { cta: 'Hi', title: 'T' } })
      const root = from.root
      const to = {
        ...from,
        bloks: { ...from.bloks, [root]: { ...from.bloks[root]!, data: { title: null } } },
      }
      const bare = diff(from, to, { layer: 'bare' })
      expect(bare).toEqual(
        expect.arrayContaining([
          { t: 'unset', uid: root, field: 'cta' },
          { t: 'set', uid: root, field: 'title', value: null },
        ]),
      )
      expect(applyAll(from, bare)).toEqual(to)
      // Without the option, a vanished key is a set of null, as it always was.
      expect(diff(from, to)).toEqual(
        expect.arrayContaining([{ t: 'set', uid: root, field: 'cta', value: null }]),
      )
    })

    it('tells a removed key from an inherited one both ways, and a locale key likewise', () => {
      const from = layer({ data: { title: null }, i18n: { fr: { cta: null } } })
      const root = from.root
      const to = { ...from, bloks: { ...from.bloks, [root]: { ...from.bloks[root]!, data: {} } } }
      delete to.bloks[root]!.i18n
      const out = diff(from, to, { layer: 'bare' })
      expect(out).toEqual(
        expect.arrayContaining([
          { t: 'unset', uid: root, field: 'title' },
          { t: 'unset', uid: root, field: 'cta', locale: 'fr' },
        ]),
      )
      expect(diff(from, from, { layer: 'bare' })).toEqual([])
      // And absent to null is a change in a layer, and is not in an ordinary document.
      const back = diff(to, from, { layer: 'bare' })
      expect(back).toEqual(
        expect.arrayContaining([{ t: 'set', uid: root, field: 'title', value: null }]),
      )
      expect(diff(to, from)).toEqual([])
    })
  })
})
