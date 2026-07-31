/**
 * The admin's data-document surfaces
 * (`docs/specs/content-model/data-documents.md`): the Documents screen's columns
 * and cells, its sort and URL model, the `references()` input's entries and
 * candidates, and the delete confirmation's usage sentence.
 *
 * Every assertion here is against an exported pure function rather than a mounted
 * component, which is the pattern the rest of `test/unit/admin/` follows.
 *
 * **Three describes left this file rather than being ported**, and where they went
 * is the point of `ui-architecture.md` port phase 3:
 *
 *  - `sortRows` — sorting is `GET {base}/api/documents?sort=&dir=`. The behaviour
 *    it pinned that still exists is pinned in `test/workers/stories.test.ts`; the
 *    behaviour it pinned that does **not** is sorting by an `indexed` column, which
 *    `core/story.ts`'s `DocumentSort` explains the absence of.
 *  - `filterRows` — searching is `?q=`, and it reaches `content_index` server-side.
 *    Its one interesting assertion ("matches an indexed value the title does not
 *    contain") is a workers test now, because it is a `where` clause.
 *  - `pageCount` — there are no page numbers. `Showing n of N` plus next/previous,
 *    per `ui-architecture.md` Resolved 5.
 */
import { describe, expect, it } from 'vitest'
import { deleteConfirmation, usageSentence } from '../../../src/admin/DeleteDialog'
import { referenceEntries, unpickedCandidates } from '../../../src/admin/ReferencesInput'
import {
  cellText,
  type DocumentRow,
  dirOf,
  documentColumns,
  documentsParams,
  documentsQuery,
  filterOf,
  isNarrowed,
  isStale,
  naturalDir,
  parseDocumentsUrl,
  withSort,
} from '../../../src/admin/ui/screens/documents-model'
import type { Json } from '../../../src/core/doc'
import { boolean, number, richtext, text } from '../../../src/core/fields'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'
import type { StoryMeta, StoryNode } from '../../../src/core/story'

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

/** A row as the route answers it: the story plus its published indexed values. */
function row(
  overrides: Partial<StoryNode> & { id: string },
  indexed: DocumentRow['indexed'] = {},
): DocumentRow {
  return { ...node(overrides), indexed }
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

describe('documentColumns', () => {
  it('is the title, then the root block’s indexed fields, then status and updated', () => {
    expect(documentColumns(schema, personType).map((c) => c.key)).toEqual([
      'title',
      'f:role',
      'f:years',
      'f:lead',
      'state',
      'updated',
    ])
  })

  it('skips the titleField as a field column — its value already IS the title', () => {
    expect(documentColumns(schema, personType).some((c) => c.field === 'fullName')).toBe(false)
  })

  it('takes each column’s label from the field, not its name', () => {
    const byKey = new Map(documentColumns(schema, personType).map((c) => [c.key, c.label]))
    expect(byKey.get('f:role')).toBe('Role')
    expect(byKey.get('f:years')).toBe('Years')
  })

  it('labels the title column from the titleField when a resolver is given', () => {
    const [first] = documentColumns(schema, personType, () => 'Full name')
    expect(first?.label).toBe('Full name')
  })

  it('is title plus status and updated for a type whose root marks nothing indexed', () => {
    expect(documentColumns(schema, officeType).map((c) => c.key)).toEqual([
      'title',
      'state',
      'updated',
    ])
  })

  it('never omits the status column — the spec’s resolved open question', () => {
    expect(documentColumns(schema, officeType).some((c) => c.kind === 'state')).toBe(true)
  })

  /**
   * The load-bearing half of the sort decision, and the reason it is a test rather
   * than a comment: which headers are buttons is *derived* from the column kind, so
   * a `field` column that quietly gained a `sort` would render an `aria-sort` on a
   * header the route cannot honour — a control that looks live and does nothing.
   */
  it('makes only title and updated sortable — never an indexed field column', () => {
    const columns = documentColumns(schema, personType)
    expect(columns.filter((c) => c.sort).map((c) => [c.key, c.sort])).toEqual([
      ['title', 'title'],
      ['updated', 'edited'],
    ])
    expect(columns.filter((c) => c.kind === 'field').every((c) => c.sort === undefined)).toBe(true)
  })
})

/* ---------------------------------------------------------------- cells --- */

describe('cellText', () => {
  const columns = documentColumns(schema, personType)
  const role = columns.find((c) => c.field === 'role')!
  const title = columns.find((c) => c.kind === 'title')!

  it('reads a published indexed value off the row', () => {
    expect(cellText(row({ id: 'ada' }, { role: { text: 'Analyst', num: null } }), role)).toBe(
      'Analyst',
    )
  })

  it('is blank for a document with nothing published, rather than throwing', () => {
    expect(cellText(row({ id: 'grace' }), role)).toBe('')
  })

  it('reads the title off the story row, not the index', () => {
    expect(cellText(row({ id: 'ada', title: 'Ada Lovelace' }), title)).toBe('Ada Lovelace')
  })

  /**
   * `state` and `updated` are a badge and a relative timestamp, so they are the
   * component's business rather than a string's — and returning `''` for them is
   * what says so. The old version answered `badgeLabel(state) ?? 'Live'` here,
   * which put a *rendering* decision inside a text function and meant the word
   * "Live" existed nowhere near the badge that shows it.
   */
  it('leaves state and updated to the component', () => {
    const state = columns.find((c) => c.kind === 'state')!
    const updated = columns.find((c) => c.kind === 'updated')!
    expect(cellText(row({ id: 'a', state: 'changed' }), state)).toBe('')
    expect(cellText(row({ id: 'a', updatedAt: 1 }), updated)).toBe('')
  })
})

describe('isStale', () => {
  it('is true for `changed` and nothing else', () => {
    expect(isStale({ state: 'changed' })).toBe(true)
    expect(isStale({ state: 'live' })).toBe(false)
    // A draft has never been published, so its blank cells are not *stale* — there
    // is nothing they disagree with. The distinction matters because the badge's
    // sentence is about disagreement.
    expect(isStale({ state: 'draft' })).toBe(false)
    expect(isStale({ state: 'unpublished' })).toBe(false)
  })
})

/* ------------------------------------------------------------- sort model --- */

describe('the sort model', () => {
  it('gives each sort its own natural direction', () => {
    // Alphabetical ascending and newest-edited-first are both what a person means
    // by clicking the column once.
    expect(naturalDir('title')).toBe('asc')
    expect(naturalDir('ord')).toBe('asc')
    expect(naturalDir('edited')).toBe('desc')
  })

  /**
   * `withSort` models a **click**, not an assignment. So clicking the column that
   * is already active flips it — which is why the default URL (`title`, ascending)
   * plus one `withSort(url, 'title')` is descending rather than a no-op.
   */
  it('flips direction when the already-active column is clicked', () => {
    const url = parseDocumentsUrl({})
    expect([url.sort, dirOf(url)]).toEqual(['title', 'asc'])

    const once = withSort(url, 'title')
    expect(dirOf(once)).toBe('desc')
    expect(dirOf(withSort(once, 'title'))).toBe('asc')
  })

  /**
   * The half that is easy to get wrong: carrying the previous column's direction
   * over is the obvious implementation, and it means clicking `Last edited` while
   * sorted Z→A hands you oldest-first — which reads as a bug rather than as a
   * preserved preference.
   */
  it('starts a different column at its own direction rather than carrying one over', () => {
    const descTitle = withSort(parseDocumentsUrl({}), 'title')
    expect([descTitle.sort, dirOf(descTitle)]).toEqual(['title', 'desc'])
    // Still newest-first, not oldest-first.
    expect(dirOf(withSort(descTitle, 'edited'))).toBe('desc')

    const ascEdited = withSort(withSort(parseDocumentsUrl({}), 'edited'), 'edited')
    expect([ascEdited.sort, dirOf(ascEdited)]).toEqual(['edited', 'asc'])
    // Back to `title`, which is ascending on its own terms rather than inheriting.
    expect(dirOf(withSort(ascEdited, 'title'))).toBe('asc')
  })
})

/* --------------------------------------------------------------------- URL --- */

describe('parseDocumentsUrl / documentsQuery', () => {
  it('defaults to title ascending with no filter', () => {
    expect(parseDocumentsUrl({})).toEqual({ sort: 'title', dir: undefined, state: 'all', q: '' })
  })

  it('round-trips every non-default state', () => {
    const url = {
      sort: 'edited' as const,
      dir: 'asc' as const,
      state: 'changed' as const,
      q: 'ada',
    }
    expect(parseDocumentsUrl(documentsQuery(url) as Record<string, string>)).toEqual(url)
  })

  it('leaves defaults out of the URL rather than writing them into it', () => {
    // `?sort=title&dir=asc&state=all` is four times the length of the bare path and
    // says exactly the same thing.
    expect(documentsQuery(parseDocumentsUrl({}))).toEqual({
      sort: undefined,
      dir: undefined,
      state: undefined,
      q: undefined,
    })
  })

  it("omits `dir` when it is the sort's own direction, on either sort", () => {
    expect(documentsQuery({ sort: 'edited', dir: 'desc', state: 'all', q: '' }).dir).toBeUndefined()
    expect(documentsQuery({ sort: 'title', dir: 'asc', state: 'all', q: '' }).dir).toBeUndefined()
    expect(documentsQuery({ sort: 'edited', dir: 'asc', state: 'all', q: '' }).dir).toBe('asc')
  })

  it('falls back rather than throwing on a stale bookmark', () => {
    const url = parseDocumentsUrl({ sort: 'surname', dir: 'sideways', state: 'archived' })
    expect(url).toEqual({ sort: 'title', dir: undefined, state: 'all', q: '' })
  })
})

describe('filterOf / isNarrowed', () => {
  it('drops `all` rather than sending a fifth state value', () => {
    expect(filterOf(parseDocumentsUrl({}))).toEqual({})
    expect(filterOf(parseDocumentsUrl({ state: 'draft' }))).toEqual({ state: 'draft' })
  })

  it('trims the query, so whitespace is not a filter', () => {
    expect(filterOf(parseDocumentsUrl({ q: '  ada  ' }))).toEqual({ q: 'ada' })
    expect(filterOf(parseDocumentsUrl({ q: '   ' }))).toEqual({})
    expect(isNarrowed(filterOf(parseDocumentsUrl({ q: '   ' })))).toBe(false)
  })

  /** Telling "no records yet" from "nothing matches": offering *clear filters*
   * under the first is offering to clear nothing. */
  it('is narrowed by a state or a query and by nothing else', () => {
    expect(isNarrowed(filterOf(parseDocumentsUrl({})))).toBe(false)
    expect(isNarrowed(filterOf(parseDocumentsUrl({ state: 'live' })))).toBe(true)
    expect(isNarrowed(filterOf(parseDocumentsUrl({ q: 'ada' })))).toBe(true)
    // The sort is not a filter.
    expect(isNarrowed(filterOf(parseDocumentsUrl({ sort: 'edited' })))).toBe(false)
  })
})

describe('documentsParams', () => {
  const params = (
    query: Record<string, string>,
    opts: { limit: number; cursor?: string | null; count?: boolean } = { limit: 50 },
  ) => Object.fromEntries(documentsParams(parseDocumentsUrl(query), 'person', opts))

  it('always carries the type, the sort and a resolved direction', () => {
    // The direction is spelled out even when it is the natural one: this is the
    // request rather than the URL, and a route reading an absent `dir` would have
    // to know the same table of natural directions to agree with the screen.
    expect(params({})).toEqual({ type: 'person', sort: 'title', dir: 'asc', limit: '50' })
    expect(params({ sort: 'edited' }).dir).toBe('desc')
  })

  it('carries the filter, and omits what is not set', () => {
    expect(params({ state: 'changed', q: 'ada' })).toEqual({
      type: 'person',
      sort: 'title',
      dir: 'asc',
      limit: '50',
      state: 'changed',
      q: 'ada',
    })
  })

  it('asks for a count and a cursor only when told to', () => {
    expect(params({}).count).toBeUndefined()
    expect(params({}, { limit: 50, count: true }).count).toBe('1')
    expect(params({}, { limit: 50, cursor: 'abc' }).cursor).toBe('abc')
    // A null cursor is the first page, which is the absence of the parameter
    // rather than an empty one — `?cursor=` would be a malformed cursor and a 400.
    expect(params({}, { limit: 50, cursor: null }).cursor).toBeUndefined()
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
