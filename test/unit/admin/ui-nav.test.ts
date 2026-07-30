import { describe, expect, it } from 'vitest'
import type { DocumentType } from '../../../src/core/schema'
import type { Me } from '../../../src/admin/me'
import { activeItem, GROUP_AT, nav } from '../../../src/admin/ui/nav'

/**
 * The sidebar, which is generated from the manifest rather than written — so the
 * grouping threshold, the ordering and the role gate are all logic, and all
 * testable in Node without a component.
 */

const OPEN: Me = { mode: 'open', actor: null, loginUrl: '' }
const ADMIN: Me = {
  mode: 'session',
  actor: { kind: 'user', id: 'u1', name: 'Ada', colour: '#f00', role: 'admin' },
  loginUrl: '/folio/login',
}
const EDITOR: Me = {
  mode: 'session',
  actor: { kind: 'user', id: 'u2', name: 'Bo', colour: '#0f0', role: 'editor' },
  loginUrl: '/folio/login',
}

const type = (name: string, kind: DocumentType['kind'], extra: Partial<DocumentType> = {}) =>
  ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    kind,
    root: `${name}_root`,
    ...extra,
  }) as DocumentType

const PAGE = type('page', 'page')
const labels = (groups: ReturnType<typeof nav>) => groups.map((g) => g.items.map((i) => i.label))

describe('nav', () => {
  it('leads with Home, Content and Assets and needs no heading over them', () => {
    const groups = nav({ types: [PAGE], globals: [], me: OPEN })
    expect(groups[0]?.label).toBeUndefined()
    expect(groups[0]?.items.map((i) => i.label)).toEqual(['Home', 'Content', 'Assets'])
  })

  it('names each record type in the primary group, between Content and Assets', () => {
    const groups = nav({
      types: [PAGE, type('person', 'record'), type('office', 'record')],
      globals: [],
      me: OPEN,
    })
    expect(groups[0]?.items.map((i) => i.label)).toEqual([
      'Home',
      'Content',
      'Person',
      'Office',
      'Assets',
    ])
  })

  it('links a record type at its own list screen', () => {
    const groups = nav({ types: [PAGE, type('person', 'record')], globals: [], me: OPEN })
    expect(groups[0]?.items[2]?.screen).toEqual({ name: 'documents', type: 'person' })
  })

  it('keeps pages out of the sidebar: they live in the tree under Content', () => {
    const groups = nav({ types: [PAGE, type('article', 'page')], globals: [], me: OPEN })
    expect(labels(groups).flat()).not.toContain('Article')
  })

  it(`stays flat at ${GROUP_AT} record types and groups past it`, () => {
    const records = Array.from({ length: GROUP_AT }, (_, i) => type(`r${i}`, 'record'))
    const flat = nav({ types: [PAGE, ...records], globals: [], me: OPEN })
    expect(flat[0]?.items).toHaveLength(GROUP_AT + 3)

    const grouped = nav({
      types: [PAGE, ...records, type('r8', 'record')],
      globals: [],
      me: OPEN,
    })
    // The primary group is back to three, and the overflow is a headed,
    // collapsible group rather than a longer list.
    expect(grouped[0]?.items.map((i) => i.label)).toEqual(['Home', 'Content', 'Assets'])
    const documents = grouped.find((g) => g.label === 'Documents')
    expect(documents?.items).toHaveLength(GROUP_AT + 1)
    expect(documents?.collapsible).toBe(true)
  })

  it('groups on a declared group even when there are only two types', () => {
    const groups = nav({
      types: [
        PAGE,
        type('person', 'record', { group: 'Directory' }),
        type('office', 'record', { group: 'Directory' }),
      ],
      globals: [],
      me: OPEN,
    })
    expect(groups[0]?.items.map((i) => i.label)).toEqual(['Home', 'Content', 'Assets'])
    expect(groups.find((g) => g.label === 'Directory')?.items.map((i) => i.label)).toEqual([
      'Person',
      'Office',
    ])
  })

  it('orders groups by first appearance, like the palette, not alphabetically', () => {
    const groups = nav({
      types: [
        PAGE,
        type('zebra', 'record', { group: 'Zoo' }),
        type('apple', 'record', { group: 'Market' }),
        type('lion', 'record', { group: 'Zoo' }),
      ],
      globals: [],
      me: OPEN,
    })
    expect(groups.filter((g) => g.collapsible).map((g) => g.label)).toEqual(['Zoo', 'Market'])
    expect(groups.find((g) => g.label === 'Zoo')?.items.map((i) => i.label)).toEqual([
      'Zebra',
      'Lion',
    ])
  })

  it('puts ungrouped types under Documents, last, when others are grouped', () => {
    const groups = nav({
      types: [PAGE, type('person', 'record', { group: 'Directory' }), type('note', 'record')],
      globals: [],
      me: OPEN,
    })
    expect(groups.filter((g) => g.collapsible).map((g) => g.label)).toEqual([
      'Directory',
      'Documents',
    ])
    expect(groups.find((g) => g.label === 'Documents')?.items.map((i) => i.label)).toEqual(['Note'])
  })

  it('links a singleton straight at its document, since its id is derived', () => {
    const groups = nav({
      types: [PAGE, type('header', 'singleton')],
      globals: ['header'],
      me: OPEN,
    })
    const item = groups.find((g) => g.label === 'Globals')?.items[0]
    expect(item?.label).toBe('Header')
    expect(item?.screen).toEqual({ name: 'edit', id: 'sng_header' })
  })

  it('lists declared globals first, then any singleton that is not one', () => {
    const groups = nav({
      types: [PAGE, type('footer', 'singleton'), type('header', 'singleton')],
      globals: ['header'],
      me: OPEN,
    })
    expect(groups.find((g) => g.label === 'Globals')?.items.map((i) => i.label)).toEqual([
      'Header',
      'Footer',
    ])
  })

  it('has no Globals group at all when nothing declares a singleton', () => {
    expect(nav({ types: [PAGE], globals: [], me: OPEN }).map((g) => g.label)).not.toContain(
      'Globals',
    )
  })

  it('ignores a global naming a type that is not a singleton', () => {
    const groups = nav({ types: [PAGE, type('header', 'singleton')], globals: ['page'], me: OPEN })
    expect(groups.find((g) => g.label === 'Globals')?.items.map((i) => i.label)).toEqual(['Header'])
  })

  it('offers Access only to an admin — absent, not disabled', () => {
    const admin = nav({ types: [PAGE], globals: [], me: ADMIN })
    const editor = nav({ types: [PAGE], globals: [], me: EDITOR })
    const open = nav({ types: [PAGE], globals: [], me: OPEN })
    expect(labels(admin).flat()).toContain('Access')
    expect(labels(editor).flat()).not.toContain('Access')
    // `auth: 'open'` has no accounts, and the server 404s the surface too.
    expect(labels(open).flat()).not.toContain('Access')
  })

  it('keeps Model, Redirects and Settings for everyone', () => {
    const editor = labels(nav({ types: [PAGE], globals: [], me: EDITOR })).flat()
    expect(editor).toContain('Model')
    expect(editor).toContain('Redirects')
    expect(editor).toContain('Settings')
  })

  it('gives every item a glyph, since the collapsed rail draws nothing else', () => {
    const groups = nav({ types: [PAGE, type('person', 'record')], globals: [], me: ADMIN })
    for (const item of groups.flatMap((g) => g.items)) expect(item.icon).not.toBe('')
  })
})

describe('activeItem', () => {
  const groups = nav({
    types: [PAGE, type('person', 'record'), type('header', 'singleton')],
    globals: ['header'],
    me: ADMIN,
  })

  it('is the screen itself for anything but the editor', () => {
    expect(activeItem(groups, { name: 'assets' })).toEqual({ name: 'assets' })
  })

  it('lights up Content for an open page, so the sidebar never highlights nothing', () => {
    expect(activeItem(groups, { name: 'edit', id: 'sty_x' })).toEqual({ name: 'content' })
  })

  it("lights up a record's own list", () => {
    expect(activeItem(groups, { name: 'edit', id: 'sty_ada' }, 'person')).toEqual({
      name: 'documents',
      type: 'person',
    })
  })

  it('lights up the global itself when the open document is one', () => {
    expect(activeItem(groups, { name: 'edit', id: 'sng_header' }, 'header')).toEqual({
      name: 'edit',
      id: 'sng_header',
    })
  })

  it('falls back to Content for a type with no list in the nav', () => {
    expect(activeItem(groups, { name: 'edit', id: 'sty_x' }, 'ghost')).toEqual({ name: 'content' })
  })
})
