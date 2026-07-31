import { describe, expect, it } from 'vitest'
import { rootSettingsLabel } from '../../../src/admin/BlockTree'
import { referenceCandidates } from '../../../src/admin/Inspector'
import { linkCandidates } from '../../../src/admin/LinkInput'
import { creatableUnder, dropRefusal, typeChip } from '../../../src/admin/StoryTree'
import type { BlockSchema, DocumentType } from '../../../src/core/schema'
import { draftState, type StoryNode } from '../../../src/core/story'

/**
 * document-types.md's admin half. Every filter is a pure exported function for
 * the same reason `visibleEntries` is (conditional-fields.md decision 2): the
 * rule is what matters, and mounting a tree to assert it would test React.
 */

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot' }
const INSIGHT: DocumentType = {
  name: 'insight',
  label: 'Insight',
  kind: 'page',
  root: 'pageRoot',
  under: ['page'],
}
const PERSON: DocumentType = {
  name: 'person',
  label: 'Person',
  kind: 'record',
  root: 'personRoot',
}
const SETTINGS: DocumentType = {
  name: 'settings',
  label: 'Site settings',
  kind: 'singleton',
  root: 'settingsRoot',
}
const TYPES = [PAGE, INSIGHT, PERSON, SETTINGS]

function node(overrides: Partial<StoryNode> & { id: string }): StoryNode {
  const publishedAt = overrides.publishedAt ?? null
  const unpublishedAt = overrides.unpublishedAt ?? null
  const state = draftState(publishedAt, unpublishedAt, 0, 0)
  return {
    type: 'page',
    parentId: null,
    slug: overrides.id,
    path: overrides.id,
    ord: 'a0',
    title: overrides.id,
    updatedAt: 0,
    publishedAt,
    unpublishedAt,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    state,
    hasUnpublishedChanges: state === 'changed',
    children: [],
    ...overrides,
  }
}

describe('creatableUnder', () => {
  it('offers only page kinds: nothing else is in the tree', () => {
    expect(creatableUnder(TYPES, 'page').map((t) => t.name)).toEqual(['page', 'insight'])
  })

  it('drops a type whose `under` the parent does not satisfy', () => {
    // `insight` is `under: ['page']`, so another insight is not a home for one.
    expect(creatableUnder(TYPES, 'insight').map((t) => t.name)).toEqual(['page'])
  })

  it('drops an `under`-constrained type at the top level, which has no type to match', () => {
    expect(creatableUnder(TYPES, undefined).map((t) => t.name)).toEqual(['page'])
  })

  it('treats an undeclared parent type as offering nothing constrained', () => {
    // A row whose type was removed from the code: `page` is unconstrained and
    // still offered, `insight` is not, and the tree stays usable either way.
    expect(creatableUnder(TYPES, 'vanished').map((t) => t.name)).toEqual(['page'])
  })

  it('offers every page type when none declares `under`', () => {
    const loose: DocumentType = { ...INSIGHT, under: undefined }
    expect(creatableUnder([PAGE, loose], undefined).map((t) => t.name)).toEqual(['page', 'insight'])
  })
})

describe('dropRefusal', () => {
  const insight = node({ id: 'i1', type: 'insight' })
  const page = node({ id: 'p1', type: 'page' })

  it('allows a drop the type’s `under` permits', () => {
    expect(dropRefusal(TYPES, insight, 'page')).toBeNull()
  })

  it('refuses a drop onto a type `under` does not name, saying which are allowed', () => {
    expect(dropRefusal(TYPES, insight, 'insight')).toBe('A Insight can only go under: Page')
  })

  it('refuses a drop to the top level', () => {
    expect(dropRefusal(TYPES, insight, undefined)).toBe('A Insight can only go under: Page')
  })

  it('allows anything for a type with no `under`', () => {
    expect(dropRefusal(TYPES, page, undefined)).toBeNull()
    expect(dropRefusal(TYPES, page, 'insight')).toBeNull()
  })

  it('allows a row whose own type is undeclared rather than freezing the tree', () => {
    // A config change must not make an existing tree undraggable; the server has
    // the final say either way.
    expect(dropRefusal(TYPES, node({ id: 'x', type: 'vanished' }), undefined)).toBeNull()
    expect(dropRefusal(TYPES, undefined, undefined)).toBeNull()
  })

  it('names the allowed parents by label, not by type name', () => {
    const office: DocumentType = {
      name: 'office',
      label: 'Office page',
      kind: 'page',
      root: 'pageRoot',
      under: ['insight'],
    }
    expect(dropRefusal([...TYPES, office], node({ id: 'o', type: 'office' }), 'page')).toBe(
      'A Office page can only go under: Insight',
    )
  })
})

describe('typeChip', () => {
  it('shows nothing on a single-type site: a chip that always reads "Page" is noise', () => {
    expect(typeChip([PAGE], 'page')).toBeNull()
  })

  it('shows the type’s label once there is more than one type', () => {
    expect(typeChip(TYPES, 'insight')).toEqual({ label: 'Insight', unknown: false })
  })

  it('says so, rather than hiding the row, when the type is no longer declared', () => {
    expect(typeChip(TYPES, 'vanished')).toEqual({ label: 'Unknown type', unknown: true })
  })
})

describe('linkCandidates', () => {
  const stories = [
    node({ id: 'home', type: 'page', path: '' }),
    node({ id: 'about', type: 'page', path: 'about' }),
    node({ id: 'insight', type: 'insight', path: 'insights/one' }),
    node({ id: 'ada', type: 'person', path: null }),
    node({ id: 'settings', type: 'settings', path: null }),
  ]

  it('never offers an unrouted document: there is no URL to link to', () => {
    expect(linkCandidates(stories).map((s) => s.id)).toEqual(['home', 'about', 'insight'])
  })

  it('narrows to the field’s own `types`, still excluding unrouted ones', () => {
    expect(linkCandidates(stories, ['insight']).map((s) => s.id)).toEqual(['insight'])
    // `person` is a legal type name but every person is unrouted, so the picker
    // is empty rather than offering something that resolves `broken`.
    expect(linkCandidates(stories, ['person'])).toEqual([])
  })

  it('sorts by path, so the root comes first', () => {
    expect(linkCandidates(stories).map((s) => s.path)).toEqual(['', 'about', 'insights/one'])
  })
})

describe('referenceCandidates', () => {
  const stories = [
    node({ id: 'about', type: 'page', path: 'about' }),
    node({ id: 'ada', type: 'person', path: null, title: 'Ada' }),
    node({ id: 'grace', type: 'person', path: null, title: 'Grace' }),
  ]

  it('does offer unrouted documents: pulling a record’s data in is the point', () => {
    expect(referenceCandidates(stories).map((s) => s.id)).toEqual(['about', 'ada', 'grace'])
  })

  it('narrows to the field’s own `types`', () => {
    expect(referenceCandidates(stories, ['person']).map((s) => s.id)).toEqual(['ada', 'grace'])
    expect(referenceCandidates(stories, ['form'])).toEqual([])
  })

  it('puts routed documents first, then unrouted ones by title', () => {
    const shuffled = [stories[2]!, stories[1]!, stories[0]!]
    expect(referenceCandidates(shuffled).map((s) => s.id)).toEqual(['about', 'ada', 'grace'])
  })
})

/*
 * `describe('the Data rail\u2019s grouping')` was here, over `DataList.tsx`'s
 * `dataTypes`, `documentsOfType` and `orphanedDocuments`. All three are gone with
 * the file (`../../../../docs/ui-architecture.md` port phase 3), and each is worth
 * saying where it went:
 *
 *  - `dataTypes` \u2014 the sidebar generates a nav item per declared type from the
 *    manifest, so "every non-page type, in declaration order" is `admin/ui/nav.ts`
 *    and is tested in `nav.test.ts`.
 *  - `documentsOfType` \u2014 grouping client-side over every record on the site is
 *    what `GET {base}/api/documents?type=` answers, paged.
 *  - `orphanedDocuments` \u2014 a row whose type is no longer declared. **This one is
 *    a capability, not a mechanism**, and it is the only part of the rail with
 *    nowhere to go yet: the nav is generated from the manifest, so an undeclared
 *    type has no screen. `GET {base}/audit` already reports `unknown types` in
 *    full, and `ui-architecture.md` puts the audit panel on Model at port phase 5 \u2014
 *    which is where it lands, with a link per finding. Until then the Documents
 *    screen names the type and points at the audit route rather than pretending the
 *    documents do not exist.
 */

describe('rootSettingsLabel', () => {
  const def = (label: string): BlockSchema => ({ name: 'x', label, fields: {} })

  it('reads "Page settings" for a page root, exactly as before this spec', () => {
    expect(rootSettingsLabel(def('Page'))).toBe('Page settings')
  })

  it('reads the record’s own label instead', () => {
    expect(rootSettingsLabel(def('Person'))).toBe('Person settings')
  })

  it('degrades rather than throwing for a root block the schema does not have', () => {
    expect(rootSettingsLabel(undefined)).toBe('Settings')
  })
})
