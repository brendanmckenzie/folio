import { describe, expect, it } from 'vitest'
import { toManifest } from '../../../src/core/block'
import type { Doc } from '../../../src/core/doc'
import { asset, blocks, richtext, text } from '../../../src/core/fields'
import { fromPlainText } from '../../../src/core/richtext'
import {
  type BlockSchema,
  canNest,
  defaultType,
  type DocumentType,
  isRouted,
  type SchemaIndex,
  singletonId,
  titleFieldOf,
  titleOf,
  typeByName,
  validateTypes,
} from '../../../src/core/schema'

/**
 * document-types.md's core half: the type descriptors themselves, the title
 * derivation that replaces the hard-coded `data.title` read, and the
 * construction-time validation that turns a config mistake into one throw
 * rather than a 500 on whichever route reaches it first.
 */

const pageBlock: BlockSchema = {
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text(),
    body: blocks({ allow: [] }),
  },
}

/** A root with no `title` field at all — the case the old
 * `doc.bloks[doc.root].data.title` read silently published as ''. */
const personBlock: BlockSchema = {
  name: 'personRecord',
  label: 'Person',
  summary: 'fullName',
  fields: {
    fullName: text(),
    role: text(),
    portrait: asset(),
    bio: richtext(),
  },
}

/** A root with neither `title` nor `summary`, so `titleFieldOf` runs out. */
const bareBlock: BlockSchema = {
  name: 'bare',
  label: 'Bare',
  fields: { note: text() },
}

const schema: SchemaIndex = {
  page: pageBlock,
  personRecord: personBlock,
  bare: bareBlock,
}

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }
const PERSON: DocumentType = {
  name: 'person',
  label: 'Person',
  kind: 'record',
  root: 'personRecord',
  titleField: 'fullName',
}
const SETTINGS: DocumentType = {
  name: 'settings',
  label: 'Settings',
  kind: 'singleton',
  root: 'bare',
}

function doc(type: string, data: Record<string, unknown>): Doc {
  return {
    root: 'r',
    bloks: {
      r: {
        uid: 'r',
        type,
        parent: null,
        slot: null,
        order: 'a0',
        data: data as Doc['bloks'][string]['data'],
      },
    },
  }
}

describe('DocumentKind', () => {
  it('routes a page and nothing else', () => {
    expect(isRouted(PAGE)).toBe(true)
    expect(isRouted(PERSON)).toBe(false)
    expect(isRouted(SETTINGS)).toBe(false)
    // A row whose type was removed from the code has no type to consult; it is
    // not treated as routable on the strength of nothing.
    expect(isRouted(undefined)).toBe(false)
  })
})

describe('singletonId', () => {
  it('derives the id from the type name, so a second one is unrepresentable', () => {
    expect(singletonId(SETTINGS)).toBe('sng_settings')
    expect(singletonId('header')).toBe('sng_header')
  })
})

describe('typeByName and defaultType', () => {
  const types = [PERSON, PAGE, SETTINGS]

  it('finds a declared type, and answers undefined for an unknown or absent name', () => {
    expect(typeByName(types, 'page')).toBe(PAGE)
    expect(typeByName(types, 'nope')).toBeUndefined()
    expect(typeByName(types, undefined)).toBeUndefined()
  })

  it('defaults to the first page type when none is marked', () => {
    // PERSON is declared first but is a record, so it can never be what a bare
    // "New page" creates.
    expect(defaultType(types)).toBe(PAGE)
  })

  it('prefers an explicit default over declaration order', () => {
    const insight: DocumentType = {
      name: 'insight',
      label: 'Insight',
      kind: 'page',
      root: 'page',
      default: true,
    }
    expect(defaultType([PAGE, insight])).toBe(insight)
  })
})

describe('canNest (`under`)', () => {
  const insight: DocumentType = {
    name: 'insight',
    label: 'Insight',
    kind: 'page',
    root: 'page',
    under: ['page'],
  }

  it('permits anything when `under` is absent', () => {
    expect(canNest(PAGE, undefined)).toBe(true)
    expect(canNest(PAGE, insight)).toBe(true)
  })

  it('permits only the named parent types', () => {
    expect(canNest(insight, PAGE)).toBe(true)
    expect(canNest(insight, insight)).toBe(false)
  })

  it('refuses the top level, which has no type to match', () => {
    expect(canNest(insight, undefined)).toBe(false)
  })
})

describe('titleFieldOf: the fallback chain', () => {
  it('prefers the type’s own titleField', () => {
    expect(titleFieldOf(PERSON, personBlock)).toBe('fullName')
  })

  it('falls back to `title` when the root block declares one', () => {
    expect(titleFieldOf(PAGE, pageBlock)).toBe('title')
  })

  it('then to the root block’s summary field', () => {
    // No titleField, and `personRecord` has no `title` — so `summary` decides.
    const untitled: DocumentType = { ...PERSON, titleField: undefined }
    expect(titleFieldOf(untitled, personBlock)).toBe('fullName')
  })

  it('then to nothing at all, which is what makes titleOf use its literal', () => {
    expect(titleFieldOf(SETTINGS, bareBlock)).toBeUndefined()
  })
})

describe('titleOf', () => {
  it('reads the type’s title field from a root with no `title` field at all', () => {
    const d = doc('personRecord', { fullName: 'Ada Lovelace', role: 'Engineer' })
    expect(titleOf(d, PERSON, schema)).toBe('Ada Lovelace')
  })

  it('reads `title` for an ordinary page', () => {
    expect(titleOf(doc('page', { title: 'About us' }), PAGE, schema)).toBe('About us')
  })

  it('trims, and falls back when the value is blank', () => {
    expect(titleOf(doc('page', { title: '  Spaced  ' }), PAGE, schema)).toBe('Spaced')
    expect(titleOf(doc('page', { title: '   ' }), PAGE, schema)).toBe('Untitled')
  })

  it('falls back to the caller’s own value in preference to the literal', () => {
    // What publish does: the row's cached title is a better answer than
    // 'Untitled' for a root block that offers no title field.
    expect(titleOf(doc('bare', { note: 'x' }), SETTINGS, schema, 'Site settings')).toBe(
      'Site settings',
    )
  })

  it('unwraps a richtext title field rather than stringifying the object', () => {
    const rich: DocumentType = { ...PERSON, titleField: 'bio' }
    const d = doc('personRecord', { bio: fromPlainText('Wrote the first program') })
    expect(titleOf(d, rich, schema)).toBe('Wrote the first program')
  })

  it('is total over a document with no root blok', () => {
    expect(titleOf({ root: 'gone', bloks: {} }, PAGE, schema, 'Fallback')).toBe('Fallback')
  })

  it('is total over a root blok whose type is not in the schema', () => {
    expect(titleOf(doc('vanished', { title: 'Still there' }), undefined, schema, 'F')).toBe('F')
  })
})

describe('toManifest', () => {
  it('carries every type through and keeps `root` as the default page type’s root block', () => {
    const manifest = toManifest({}, [
      PERSON,
      { ...PAGE, default: true },
      SETTINGS,
    ] as DocumentType[])
    expect(manifest.types.map((t) => t.name)).toEqual(['person', 'page', 'settings'])
    expect(manifest.root).toBe('page')
  })

  it('copies the array rather than aliasing the config’s own', () => {
    const types = [PAGE]
    expect(toManifest({}, types).types).not.toBe(types)
  })
})

describe('validateTypes', () => {
  const ok = [PAGE, PERSON, SETTINGS]

  it('accepts a valid set', () => {
    expect(() => validateTypes(ok, schema)).not.toThrow()
  })

  it('refuses an empty set', () => {
    expect(() => validateTypes([], schema)).toThrow(/is empty/)
  })

  it('refuses a duplicate type name', () => {
    expect(() => validateTypes([PAGE, { ...PAGE, label: 'Other' }], schema)).toThrow(
      /duplicate document type 'page'/,
    )
  })

  it('refuses a root block that is not in the registry, naming both', () => {
    expect(() => validateTypes([{ ...PAGE, root: 'ghost' }], schema)).toThrow(
      /'page' names root block 'ghost'/,
    )
  })

  it('refuses a titleField the root block does not declare', () => {
    expect(() => validateTypes([{ ...PAGE, titleField: 'nope' }], schema)).toThrow(
      /titleField 'nope', which 'page' does not declare/,
    )
  })

  it('refuses a titleField that is a blocks field', () => {
    expect(() => validateTypes([{ ...PAGE, titleField: 'body' }], schema)).toThrow(
      /titleField 'body', a blocks field/,
    )
  })

  it('refuses a set with no page type: nothing could be routed or be the root story', () => {
    expect(() => validateTypes([PERSON, SETTINGS], schema)).toThrow(/must be kind 'page'/)
  })

  it('refuses two defaults, naming both', () => {
    const a: DocumentType = { ...PAGE, default: true }
    const b: DocumentType = {
      name: 'insight',
      label: 'I',
      kind: 'page',
      root: 'page',
      default: true,
    }
    expect(() => validateTypes([a, b], schema)).toThrow(/more than one default.*page, insight/)
  })

  it('refuses a non-page default', () => {
    expect(() => validateTypes([PAGE, { ...PERSON, default: true }], schema)).toThrow(
      /default document type 'person' is kind 'record'/,
    )
  })

  it('refuses `under` on a kind that is not in the tree', () => {
    expect(() => validateTypes([PAGE, { ...PERSON, under: ['page'] }], schema)).toThrow(
      /kind 'record' and cannot declare 'under'/,
    )
  })

  it('refuses `under` naming an undeclared type', () => {
    expect(() => validateTypes([{ ...PAGE, under: ['ghost'] }], schema)).toThrow(
      /'under' unknown type 'ghost'/,
    )
  })

  it('accepts an `under` chain that reaches the top level', () => {
    const insight: DocumentType = {
      name: 'insight',
      label: 'Insight',
      kind: 'page',
      root: 'page',
      under: ['page'],
    }
    expect(() => validateTypes([PAGE, insight], schema)).not.toThrow()
  })

  it('refuses an `under` cycle, because no document of either type could be created', () => {
    // The spec's own example: insight only under page, page only under insight.
    const a: DocumentType = { ...PAGE, under: ['insight'] }
    const b: DocumentType = {
      name: 'insight',
      label: 'Insight',
      kind: 'page',
      root: 'page',
      under: ['page'],
    }
    expect(() => validateTypes([a, b], schema)).toThrow(/can never be created/)
  })

  it('refuses a type that is only allowed under itself', () => {
    expect(() =>
      validateTypes(
        [
          PAGE,
          {
            name: 'insight',
            label: 'Insight',
            kind: 'page',
            root: 'page',
            under: ['insight'],
          },
        ],
        schema,
      ),
    ).toThrow(/'insight' can never be created/)
  })
})
