/**
 * Data documents (`docs/specs/content-model/data-documents.md`): the `references`
 * field kind, `defineRecord`, and the ref walks widened to cover both.
 *
 * The renderer's half — a missing `render` in both modes, and each entry's
 * `content` — is `../preview/records-render.test.tsx`, because it needs JSX.
 */
import { describe, expect, it } from 'vitest'
import { defineRecord } from '../../../src/core/block'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import {
  defaultValue,
  multilink,
  reference,
  references,
  richtext,
  text,
} from '../../../src/core/fields'
import { outboundRefs, referencedIdsAllLocales } from '../../../src/core/refs'
import {
  buildResolution,
  referencedIds,
  resolveReferences,
  resolveValue,
  type Resolution,
} from '../../../src/core/resolve'
import type { SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta } from '../../../src/core/story'
import { asStoryIds } from '../../../src/core/values'

function story(overrides: Partial<StoryMeta> = {}): StoryMeta {
  return {
    id: 'sty_x',
    type: 'person',
    parentId: null,
    slug: 'x',
    path: null,
    ord: 'a0',
    title: 'X',
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    updatedAt: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    ...overrides,
  }
}

function blok(uid: string, type: string, data: Record<string, Json>, i18n?: Blok['i18n']): Blok {
  return { uid, type, parent: null, slot: null, order: 'a0', data, ...(i18n ? { i18n } : {}) }
}

const docOf = (root: Blok): Doc => ({ root: root.uid, bloks: { [root.uid]: root } })

/** A person record: one root block, one field, no renderer of its own. */
function personDoc(uid: string, name: string): Doc {
  return docOf(blok(uid, 'personRecord', { fullName: name }))
}

const schema: SchemaIndex = {
  team: {
    name: 'team',
    label: 'Team',
    fields: {
      people: references({ types: ['person'] }),
      lead: reference({ types: ['person'] }),
      heading: text(),
    },
  },
  personRecord: { name: 'personRecord', label: 'Person', fields: { fullName: text() } },
}

/* ------------------------------------------------------------ the value --- */

describe('asStoryIds', () => {
  it('reads an array of ids in the stored order', () => {
    expect(asStoryIds(['sty_c', 'sty_a', 'sty_b'])).toEqual(['sty_c', 'sty_a', 'sty_b'])
  })

  it('is empty for an absent value, which is what a fresh field holds', () => {
    expect(asStoryIds(undefined)).toEqual([])
    expect(asStoryIds(null)).toEqual([])
    expect(asStoryIds([])).toEqual([])
  })

  it('tolerates a bare string, so a `reference` widened by a migration reads as one entry', () => {
    expect(asStoryIds('sty_a')).toEqual(['sty_a'])
  })

  it('drops entries that are not non-empty strings rather than throwing', () => {
    expect(asStoryIds(['sty_a', '', null, 42, { id: 'sty_b' }, 'sty_c'])).toEqual([
      'sty_a',
      'sty_c',
    ])
  })

  it('drops duplicates: the same document twice has no sensible rendering', () => {
    expect(asStoryIds(['sty_a', 'sty_b', 'sty_a'])).toEqual(['sty_a', 'sty_b'])
  })
})

describe('defaultValue for references', () => {
  it('is an empty array, following multiasset', () => {
    expect(defaultValue(references())).toEqual([])
  })
})

/* -------------------------------------------------------------- resolve --- */

describe('resolveReferences', () => {
  const ada = story({ id: 'sty_ada', title: 'Ada' })
  const grace = story({ id: 'sty_grace', title: 'Grace' })
  const about = story({ id: 'sty_about', type: 'page', path: 'about', title: 'About' })

  const resolution: Resolution = {
    ...buildResolution([ada, grace, about]),
    docs: {
      sty_ada: personDoc('a', 'Ada Lovelace'),
      sty_grace: personDoc('g', 'Grace Hopper'),
      sty_about: docOf(blok('ab', 'page', { title: 'About us' })),
    },
  }

  it('preserves the editor’s chosen order rather than any order of its own', () => {
    expect(resolveReferences(['sty_grace', 'sty_ada'], resolution).map((r) => r.id)).toEqual([
      'sty_grace',
      'sty_ada',
    ])
    expect(resolveReferences(['sty_ada', 'sty_grace'], resolution).map((r) => r.id)).toEqual([
      'sty_ada',
      'sty_grace',
    ])
  })

  it('drops an unresolvable entry rather than leaving a hole', () => {
    const resolved = resolveReferences(['sty_ada', 'sty_deleted', 'sty_grace'], resolution)
    expect(resolved.map((r) => r.id)).toEqual(['sty_ada', 'sty_grace'])
    // Deliberately asserted: a hole would make every block author write
    // `team.filter(Boolean)` and most would forget.
    expect(resolved.every((r) => r !== null)).toBe(true)
  })

  it('drops a target whose type the field does not permit', () => {
    expect(
      resolveReferences(['sty_ada', 'sty_about'], resolution, ['person']).map((r) => r.id),
    ).toEqual(['sty_ada'])
  })

  it('permits every type when the field names none', () => {
    expect(resolveReferences(['sty_ada', 'sty_about'], resolution).map((r) => r.id)).toEqual([
      'sty_ada',
      'sty_about',
    ])
  })

  it('is an empty array for an absent value, never null', () => {
    expect(resolveReferences(undefined, resolution)).toEqual([])
    expect(resolveReferences([], resolution)).toEqual([])
  })

  it('carries each target’s root data, which is how a record with no renderer is read', () => {
    const [first] = resolveReferences(['sty_ada'], resolution)
    expect(first?.data).toEqual({ fullName: 'Ada Lovelace' })
    expect(first?.title).toBe('Ada')
    // An unrouted document: no URL at all, which is the point of a record.
    expect(first?.url).toBe('')
  })

  it('drops everything one level down, the same bound `reference` relies on', () => {
    const oneLevelDown: Resolution = { ...resolution, docs: {} }
    expect(resolveReferences(['sty_ada', 'sty_grace'], oneLevelDown)).toEqual([])
  })

  it('reaches render through resolveValue’s exhaustive dispatch', () => {
    const field = references({ types: ['person'] })
    const value = resolveValue(field, ['sty_grace', 'sty_ada'], resolution)
    expect((value as { id: string }[]).map((r) => r.id)).toEqual(['sty_grace', 'sty_ada'])
    expect(resolveValue(field, undefined, resolution)).toEqual([])
  })
})

/* ------------------------------------------------------------ ref walks --- */

describe('referencedIds over both reference kinds', () => {
  it('collects singular and plural targets together, deduplicated', () => {
    const doc = docOf(
      blok('r', 'team', { lead: 'sty_ada', people: ['sty_ada', 'sty_grace'], heading: 'Team' }),
    )
    expect(referencedIds(doc, schema).sort()).toEqual(['sty_ada', 'sty_grace'])
  })

  it('ignores a block type the schema does not know', () => {
    const doc = docOf(blok('r', 'mystery', { people: ['sty_ada'] }))
    expect(referencedIds(doc, schema)).toEqual([])
  })

  it('ignores junk inside a references value', () => {
    const doc = docOf(blok('r', 'team', { people: ['', null, 7] as unknown as Json }))
    expect(referencedIds(doc, schema)).toEqual([])
  })
})

describe('referencedIdsAllLocales over both reference kinds', () => {
  it('sees a plural list a translation picked and the source list did not', () => {
    const doc = docOf(
      blok(
        'r',
        'team',
        { people: ['sty_ada'] },
        { fr: { people: ['sty_grace', 'sty_marie'] } as Record<string, Json> },
      ),
    )
    expect(referencedIdsAllLocales(doc, schema).sort()).toEqual([
      'sty_ada',
      'sty_grace',
      'sty_marie',
    ])
  })

  it('writes one content_refs row per distinct target of a hand-picked list', () => {
    const doc = docOf(blok('r', 'team', { people: ['sty_ada', 'sty_grace'] }))
    expect(outboundRefs(doc, schema, 'sty_page')).toEqual([
      { to: 'sty_ada', kind: 'reference' },
      { to: 'sty_grace', kind: 'reference' },
    ])
  })

  it('still drops a self-edge, so a list naming its own document warns about nothing', () => {
    const doc = docOf(blok('r', 'team', { people: ['sty_page', 'sty_ada'] }))
    expect(outboundRefs(doc, schema, 'sty_page')).toEqual([{ to: 'sty_ada', kind: 'reference' }])
  })

  it('leaves the link walk alone: a plural reference is a reference, not a link', () => {
    const withLink: SchemaIndex = {
      ...schema,
      team: {
        ...schema.team!,
        fields: { ...schema.team!.fields, cta: multilink(), body: richtext() },
      },
    }
    const doc = docOf(
      blok('r', 'team', { people: ['sty_ada'], cta: { kind: 'story', id: 'sty_about' } }),
    )
    expect(outboundRefs(doc, withLink, 'sty_page')).toEqual([
      { to: 'sty_about', kind: 'link' },
      { to: 'sty_ada', kind: 'reference' },
    ])
  })
})

/* --------------------------------------------------------- defineRecord --- */

describe('defineRecord', () => {
  it('accepts a definition with no render at all', () => {
    const officeRecord = defineRecord({
      name: 'officeRecord',
      label: 'Office',
      summary: 'city',
      fields: { city: text(), phone: text() },
    })
    expect(officeRecord.render).toBeUndefined()
    // Still an ordinary BlockDef: the whole point of checkpoint 1 is that
    // nothing downstream forks on this.
    expect(officeRecord.name).toBe('officeRecord')
    expect(officeRecord.summary).toBe('city')
  })

  it('accepts a definition that does have one, for reference.content', () => {
    const withRenderer = defineRecord({
      name: 'personRecord',
      label: 'Person',
      fields: { fullName: text() },
      render: ({ fullName }) => fullName,
    })
    expect(typeof withRenderer.render).toBe('function')
  })
})
