/**
 * The admin's data-document surfaces
 * (`docs/specs/content-model/data-documents.md`): the list view's columns,
 * sorting, search and pagination; the `references()` input's entries and
 * candidates; and the delete confirmation's usage sentence.
 *
 * Every assertion here is against an exported pure function rather than a mounted
 * component, which is the pattern the rest of `test/unit/admin/` follows.
 */
import { describe, expect, it } from 'vitest'
import {
  cellText,
  dataColumns,
  filterRows,
  pageCount,
  ROWS_PER_PAGE,
  sortRows,
} from '../../../src/admin/DataTable'
import { deleteConfirmation, usageSentence } from '../../../src/admin/DeleteDialog'
import { referenceEntries, unpickedCandidates } from '../../../src/admin/ReferencesInput'
import type { Json } from '../../../src/core/doc'
import { boolean, number, richtext, text } from '../../../src/core/fields'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta, StoryNode } from '../../../src/core/story'
import type { IndexedValues } from '../../../src/server/content-index'

function node(overrides: Partial<StoryNode> & { id: string }): StoryNode {
  return {
    type: 'person',
    parentId: null,
    slug: overrides.id,
    path: null,
    ord: 'a0',
    title: overrides.id,
    updatedAt: 0,
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
    children: [],
    ...overrides,
  }
}

const schema: SchemaIndex = {
  personRecord: {
    name: 'personRecord',
    label: 'Person',
    summary: 'fullName',
    fields: {
      fullName: text({ label: 'Full name', indexed: true }),
      role: text({ label: 'Role', indexed: true }),
      years: number({ label: 'Years', indexed: true }),
      lead: boolean({ label: 'Lead', indexed: true }),
      bio: richtext({ label: 'Bio' }),
    },
  },
  officeRecord: {
    name: 'officeRecord',
    label: 'Office',
    fields: { city: text({ label: 'City' }), phone: text() },
  },
}

const personType: DocumentType = {
  name: 'person',
  label: 'Person',
  kind: 'record',
  root: 'personRecord',
  titleField: 'fullName',
}
const officeType: DocumentType = {
  name: 'office',
  label: 'Office',
  kind: 'record',
  root: 'officeRecord',
}

/* -------------------------------------------------------------- columns --- */

describe('dataColumns', () => {
  it('is the title, then the root block’s indexed fields, then status and updated', () => {
    expect(dataColumns(schema, personType).map((c) => c.key)).toEqual([
      'title',
      'f:role',
      'f:years',
      'f:lead',
      'state',
      'updated',
    ])
  })

  it('skips the titleField as a field column — its value already IS the title', () => {
    expect(dataColumns(schema, personType).some((c) => c.field === 'fullName')).toBe(false)
  })

  it('takes each column’s label from the field, not its name', () => {
    const byKey = new Map(dataColumns(schema, personType).map((c) => [c.key, c.label]))
    expect(byKey.get('f:role')).toBe('Role')
    expect(byKey.get('f:years')).toBe('Years')
  })

  it('labels the title column from the titleField when a resolver is given', () => {
    const [first] = dataColumns(schema, personType, () => 'Full name')
    expect(first?.label).toBe('Full name')
  })

  it('is title plus status and updated for a type whose root marks nothing indexed', () => {
    expect(dataColumns(schema, officeType).map((c) => c.key)).toEqual(['title', 'state', 'updated'])
  })

  it('never omits the status column — the spec’s resolved open question', () => {
    expect(dataColumns(schema, officeType).some((c) => c.kind === 'state')).toBe(true)
  })
})

/* ---------------------------------------------------------------- cells --- */

describe('cellText', () => {
  const columns = dataColumns(schema, personType)
  const role = columns.find((c) => c.field === 'role')!
  const indexed: IndexedValues = {
    ada: { role: { text: 'Analyst', num: null } },
  }

  it('reads a published indexed value', () => {
    expect(cellText(node({ id: 'ada' }), role, indexed)).toBe('Analyst')
  })

  it('is blank for a document with nothing published, rather than throwing', () => {
    expect(cellText(node({ id: 'grace' }), role, indexed)).toBe('')
  })

  it('reads the title off the story row, not the index', () => {
    const title = columns.find((c) => c.kind === 'title')!
    expect(cellText(node({ id: 'ada', title: 'Ada Lovelace' }), title, indexed)).toBe(
      'Ada Lovelace',
    )
  })

  // The same `badgeLabel` the page tree uses, so a record's status reads exactly
  // as a page's does. The spec's resolved open question, and free because spec 3's
  // watermark is what makes `'changed'` reachable at all.
  it('reads draft state as its badge label', () => {
    const state = columns.find((c) => c.kind === 'state')!
    expect(cellText(node({ id: 'a', state: 'draft' }), state, {})).toBe('draft')
    expect(cellText(node({ id: 'a', state: 'changed' }), state, {})).toBe('unpublished changes')
    expect(cellText(node({ id: 'a', state: 'unpublished' }), state, {})).toBe('not live')
    // A live row has no badge, so the cell says so in words instead.
    expect(cellText(node({ id: 'a', state: 'live' }), state, {})).toBe('Live')
  })
})

/* ----------------------------------------------------------------- sort --- */

describe('sortRows', () => {
  const columns = dataColumns(schema, personType)
  const rows = [
    node({ id: 'c', title: 'Carol', updatedAt: 300 }),
    node({ id: 'a', title: 'Alice', updatedAt: 100 }),
    node({ id: 'b', title: 'Bob', updatedAt: 200 }),
  ]

  it('sorts by title ascending and descending', () => {
    expect(sortRows(rows, columns, { key: 'title', dir: 'asc' }, {}).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(sortRows(rows, columns, { key: 'title', dir: 'desc' }, {}).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ])
  })

  it('sorts an indexed number column numerically, not lexicographically', () => {
    const indexed: IndexedValues = {
      a: { years: { text: '9', num: 9 } },
      b: { years: { text: '10', num: 10 } },
      c: { years: { text: '2', num: 2 } },
    }
    expect(
      sortRows(rows, columns, { key: 'f:years', dir: 'asc' }, indexed).map((r) => r.id),
    ).toEqual(['c', 'a', 'b'])
  })

  it('sorts an ISO-date text column by its epoch, which is why num exists', () => {
    // `published`-shaped values: the text is the ISO string, `num` the epoch, so
    // the sort is chronological even across a year boundary.
    const isoSchema: SchemaIndex = {
      personRecord: {
        name: 'personRecord',
        label: 'Person',
        fields: { joined: text({ label: 'Joined', indexed: true }) },
      },
    }
    const isoColumns = dataColumns(isoSchema, {
      name: 'person',
      label: 'Person',
      kind: 'record',
      root: 'personRecord',
    })
    const indexed: IndexedValues = {
      a: { joined: { text: '2026-01-05', num: Date.parse('2026-01-05') } },
      b: { joined: { text: '2025-12-30', num: Date.parse('2025-12-30') } },
    }
    const sorted = sortRows(
      [node({ id: 'a' }), node({ id: 'b' })],
      isoColumns,
      { key: 'f:joined', dir: 'asc' },
      indexed,
    )
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('sorts by updated', () => {
    expect(sortRows(rows, columns, { key: 'updated', dir: 'desc' }, {}).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ])
  })

  it('puts a blank cell last whichever way the column points', () => {
    const indexed: IndexedValues = {
      a: { role: { text: 'Analyst', num: null } },
      b: { role: { text: 'Builder', num: null } },
    }
    // `c` has nothing published, so it sorts last both ways: burying "not
    // published yet" under a descending sort would hide the rows an editor is
    // most likely looking for.
    expect(sortRows(rows, columns, { key: 'f:role', dir: 'asc' }, indexed).at(-1)?.id).toBe('c')
    expect(sortRows(rows, columns, { key: 'f:role', dir: 'desc' }, indexed).at(-1)?.id).toBe('c')
  })

  it('breaks ties on the story id, so a reload does not reshuffle a page', () => {
    const tied = [node({ id: 'z', title: 'Same' }), node({ id: 'a', title: 'Same' })]
    expect(sortRows(tied, columns, { key: 'title', dir: 'asc' }, {}).map((r) => r.id)).toEqual([
      'a',
      'z',
    ])
  })

  it('leaves the order alone for a column it does not know', () => {
    expect(sortRows(rows, columns, { key: 'nope', dir: 'asc' }, {}).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ])
  })
})

/* --------------------------------------------------------------- search --- */

describe('filterRows', () => {
  const rows = [node({ id: 'a', title: 'Ada Lovelace' }), node({ id: 'b', title: 'Grace Hopper' })]
  const indexed: IndexedValues = {
    a: { role: { text: 'Analyst', num: null } },
    b: { role: { text: 'Rear Admiral', num: null } },
  }

  it('matches the title, case-insensitively', () => {
    expect(filterRows(rows, 'ADA', indexed).map((r) => r.id)).toEqual(['a'])
  })

  it('matches an indexed value the title does not contain', () => {
    expect(filterRows(rows, 'admiral', indexed).map((r) => r.id)).toEqual(['b'])
  })

  it('matches everything for an empty or whitespace query', () => {
    expect(filterRows(rows, '', indexed)).toHaveLength(2)
    expect(filterRows(rows, '   ', indexed)).toHaveLength(2)
  })

  it('matches nothing rather than throwing when a row has no indexed entry', () => {
    expect(filterRows([node({ id: 'c', title: 'Nobody' })], 'analyst', indexed)).toEqual([])
  })
})

/* ----------------------------------------------------------- pagination --- */

describe('pageCount', () => {
  it('gives a second page for 24 rows at 20 per page — the spec’s own example', () => {
    expect(ROWS_PER_PAGE).toBe(20)
    expect(pageCount(24)).toBe(2)
  })

  it('is one page for an exact fit, and never zero', () => {
    expect(pageCount(20)).toBe(1)
    expect(pageCount(0)).toBe(1)
  })
})

/* ------------------------------------------------------ references input --- */

describe('referenceEntries', () => {
  const stories = [
    node({ id: 'sty_ada', title: 'Ada' }),
    node({ id: 'sty_grace', title: 'Grace' }),
    node({ id: 'sty_about', type: 'page', path: 'about', title: 'About' }),
  ]

  it('pairs each stored id with its story, in the stored order', () => {
    const entries = referenceEntries(['sty_grace', 'sty_ada'] as unknown as Json, stories)
    expect(entries.map((e) => e.id)).toEqual(['sty_grace', 'sty_ada'])
    expect(entries.map((e) => e.story?.title)).toEqual(['Grace', 'Ada'])
  })

  it('KEEPS a deleted target as a missing entry — the editor half of decision 3', () => {
    const entries = referenceEntries(['sty_ada', 'sty_gone'] as unknown as Json, stories)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toEqual({ id: 'sty_gone', story: undefined })
  })

  it('is empty for an absent value', () => {
    expect(referenceEntries(null, stories)).toEqual([])
  })
})

describe('unpickedCandidates', () => {
  const stories = [
    node({ id: 'sty_ada', title: 'Ada' }),
    node({ id: 'sty_grace', title: 'Grace' }),
    node({ id: 'sty_about', type: 'page', path: 'about', title: 'About' }),
  ]

  it('narrows by the field’s types, so a page cannot be picked into a person list', () => {
    expect(unpickedCandidates(stories, [], ['person']).map((s) => s.id)).toEqual([
      'sty_ada',
      'sty_grace',
    ])
  })

  it('drops what is already picked, so nothing can be added twice', () => {
    expect(unpickedCandidates(stories, ['sty_ada'], ['person']).map((s) => s.id)).toEqual([
      'sty_grace',
    ])
  })

  it('offers every type when the field names none, records included', () => {
    expect(
      unpickedCandidates(stories, [])
        .map((s) => s.id)
        .sort(),
    ).toEqual(['sty_about', 'sty_ada', 'sty_grace'])
  })
})

/* --------------------------------------------------- delete confirmation --- */

describe('usageSentence', () => {
  const usage = (total: number) => ({ published: [], total, links: 0, references: total })

  it('names the count, plural', () => {
    expect(usageSentence(usage(4))).toBe('Used on 4 published documents.')
  })

  it('is singular for one', () => {
    expect(usageSentence(usage(1))).toBe('Used on 1 published document.')
  })

  it('says nothing when nothing points here', () => {
    expect(usageSentence(usage(0))).toBeNull()
  })

  it('says nothing when the count could not be fetched — never a false reassurance', () => {
    expect(usageSentence(null)).toBeNull()
  })
})

describe('deleteConfirmation for an unrouted document', () => {
  const person: StoryMeta = node({ id: 'sty_ada', title: 'Ada Lovelace', path: null })

  it('labels it by title, since it has no path to name it by', () => {
    expect(deleteConfirmation(person, [person]).label).toBe('Ada Lovelace')
  })

  it('marks it unrouted, which is what suppresses the redirect checkbox', () => {
    expect(deleteConfirmation(person, [person]).unrouted).toBe(true)
  })

  it('counts no descendants: nothing nests under a record', () => {
    expect(deleteConfirmation(person, [person]).descendantCount).toBe(0)
  })

  it('still labels a routed page by path, unchanged', () => {
    const about: StoryMeta = node({ id: 'about', type: 'page', path: 'about' })
    const result = deleteConfirmation(about, [about])
    expect(result.label).toBe('/about')
    expect(result.unrouted).toBe(false)
  })
})
