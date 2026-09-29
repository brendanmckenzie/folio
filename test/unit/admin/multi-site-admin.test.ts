import { describe, expect, it } from 'vitest'
import {
  atScope,
  canAdmin,
  canDeleteForms,
  canEdit,
  canEditIn,
  canManageAccess,
  canManageSites,
  canPublish,
  firstScope,
  isMultiSite,
  type Me,
  OPEN,
  previewChoices,
  scopeChoices,
  scopeName,
  showsScopeSwitcher,
  whyNot,
} from '../../../src/admin/me'
import { paneSrc } from '../../../src/admin/hooks/usePreviewBridge'
import { activeItem, nav, scopeOptionGroups } from '../../../src/admin/ui/nav'
import {
  bareMount,
  crumbs,
  href,
  isInsideMount,
  parse,
  scopeOfApiBase,
  scopedApiBase,
  scopedMount,
  splitScope,
  switchScopeUrl,
} from '../../../src/admin/ui/route'
import {
  bindingLabel,
  accessGate,
  type AccessUser,
  grantRows,
  grantScopeOptions,
  grantsOf,
  grantsReason,
  grantsRefusal,
  nextScope,
  presetsFor,
  scopesForBinding,
  withGrant,
  withoutGrant,
} from '../../../src/admin/ui/screens/access-model'
import {
  inheritNotices,
  isInherited,
  noticeLink,
  noticeText,
  paneChoice,
  paneLabel,
  paneSource,
  paneUnavailable,
} from '../../../src/admin/ui/screens/editor-model'
import {
  canCreateHome,
  homePageBody,
  type InheritedAction,
  inheritedAction,
  ownerLabel,
  quickCards,
  showsInherited,
} from '../../../src/admin/ui/screens/home-model'
import {
  belowBlok,
  isLayerDocument,
  layerActions,
  layerInfo,
  layerLabel,
  layerMutations,
  layerPrefix,
  scopesBelow,
} from '../../../src/admin/ui/screens/inspector-model'
import {
  createBody,
  emptyForm,
  formOf,
  formRefusal,
  hostsChanged,
  parseHosts,
  patchBody,
  previewNote,
  settingsHref,
  siteRows,
  sitesGate,
} from '../../../src/admin/ui/screens/sites-model'
import type { Blok, Doc } from '../../../src/core/doc'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'
import type { Registry } from '../../../src/core/sites'
import type { StoryMeta } from '../../../src/core/story'
import { meSites } from '../../../src/server/auth/me-sites'
import type { InheritedRow } from '../../../src/server/stories'

/**
 * The multi-site admin (`docs/specs/foundation/multi-site.md`, phase 8), in Node:
 * the predicates in `me.ts`, the scope in the URL, the nav, the registry screen's
 * model, the editor's pane and notices, the layer labels, and the grants.
 *
 * **Every describe has a single-site twin assertion.** The phase's hard rule is that
 * a deployment with no `sites` looks exactly as it did, and the way that rule breaks
 * is a new branch that is on by default — so each area pins what a single-site `Me`
 * is handed, alongside what a multi-site one is.
 */

const REGISTRY: Registry = {
  groups: [{ id: 'north', name: 'North' }],
  sites: [
    {
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      hosts: ['alpha.example'],
      preview: 'https://preview.alpha.example',
    },
    {
      id: 'bravo',
      name: 'Bravo',
      group: null,
      status: 'draft',
      hosts: [],
      preview: null,
    },
  ],
}

/** A signed-in person on a multi-site deployment, built by the server's own function. */
function multi(grants: Record<string, 'viewer' | 'editor' | 'publisher' | 'admin'>): Me {
  return {
    mode: 'session',
    loginUrl: '/folio/login',
    actor: {
      kind: 'user',
      id: 'usr_a',
      name: 'Ada',
      colour: '#123456',
      // `role` is the `*` grant, which is what `readSession` answers.
      role: grants['*'] ?? 'viewer',
    },
    sites: meSites(REGISTRY, grants, 'siteSettings'),
  }
}

const single = (role: 'viewer' | 'editor' | 'publisher' | 'admin'): Me => ({
  mode: 'session',
  loginUrl: '/folio/login',
  actor: { kind: 'user', id: 'usr_a', name: 'Ada', colour: '#123456', role },
})

const PLATFORM = multi({ '*': 'admin' })
const SITE_ADMIN = multi({ alpha: 'admin' })
const NATIONAL = multi({ shared: 'publisher' })
const REGIONAL = multi({ north: 'editor' })

/** Open with sites: what the server answers for `auth: 'open'`. */
const OPEN_MULTI: Me = { ...OPEN, sites: meSites(REGISTRY, null, 'siteSettings') }

describe('me: scopes and roles', () => {
  it('answers the server side of /me by the same functions the routes use', () => {
    expect(SITE_ADMIN.sites?.platform).toBe(false)
    expect(PLATFORM.sites?.platform).toBe(true)
    // A role on a site is at least viewer up its chain: Alpha, North and Shared.
    expect(SITE_ADMIN.sites?.scopes.map((s) => [s.id, s.role])).toEqual([
      ['shared', 'viewer'],
      ['north', 'viewer'],
      ['alpha', 'admin'],
    ])
    // A shared-only publisher reaches shared and nothing else, but may preview every
    // site whose chain includes it (`previewEligible`).
    expect(NATIONAL.sites?.scopes.map((s) => s.id)).toEqual(['shared'])
    expect(NATIONAL.sites?.previewable.map((s) => s.id)).toEqual(['alpha', 'bravo'])
    // A group editor writes the group and every site in it.
    expect(REGIONAL.sites?.scopes.map((s) => [s.id, s.role])).toEqual([
      ['shared', 'viewer'],
      ['north', 'editor'],
      ['alpha', 'editor'],
    ])
    expect(REGIONAL.sites?.previewable.map((s) => s.id)).toEqual(['alpha'])
  })

  it('reads the role on the scope being shown, and nothing without one', () => {
    // Alpha's admin edits and publishes Alpha, and is a viewer on Shared.
    expect(canEdit(atScope(SITE_ADMIN, 'alpha'))).toBe(true)
    expect(canPublish(atScope(SITE_ADMIN, 'alpha'))).toBe(true)
    expect(canEdit(atScope(SITE_ADMIN, 'shared'))).toBe(false)
    // No scope chosen (the Sites page), or one they do not reach: nothing scoped.
    expect(canEdit(atScope(SITE_ADMIN, null))).toBe(false)
    expect(canEdit(atScope(SITE_ADMIN, 'bravo'))).toBe(false)
    // A platform admin is admin on every scope.
    expect(canPublish(atScope(PLATFORM, 'bravo'))).toBe(true)
  })

  it('reads the role on the scope that OWNS a page, not the one being shown', () => {
    const alpha = atScope(SITE_ADMIN, 'alpha')
    expect(canEditIn(alpha, 'alpha')).toBe(true)
    // A shared page opened under ~alpha: readable, not writable.
    expect(canEditIn(alpha, 'shared')).toBe(false)
    // A national publisher writes shared and cannot write a site.
    const national = atScope(NATIONAL, 'shared')
    expect(canEditIn(national, 'shared')).toBe(true)
    expect(canEditIn(national, 'alpha')).toBe(false)
  })

  it('makes users, tokens and the describe run the platform, and a form delete the scope', () => {
    const alpha = atScope(SITE_ADMIN, 'alpha')
    expect(canManageAccess(alpha)).toBe(false)
    expect(canAdmin(alpha)).toBe(false)
    // SCOPE_ADMIN: an admin of the form's own scope.
    expect(canDeleteForms(alpha)).toBe(true)
    expect(canDeleteForms(atScope(SITE_ADMIN, 'shared'))).toBe(false)
    const platform = atScope(PLATFORM, 'alpha')
    expect(canManageAccess(platform)).toBe(true)
    expect(canAdmin(platform)).toBe(true)
  })

  it('offers the registry to the platform and to auth: open, and to nobody else', () => {
    expect(canManageSites(PLATFORM)).toBe(true)
    expect(canManageSites(SITE_ADMIN)).toBe(false)
    expect(canManageSites(NATIONAL)).toBe(false)
    // "The registry open too" (edge cases).
    expect(canManageSites(OPEN_MULTI)).toBe(true)
    // But not Access, which does not exist without accounts.
    expect(canManageAccess(OPEN_MULTI)).toBe(false)
    // Every scope is editable under open.
    expect(canEdit(atScope(OPEN_MULTI, 'alpha'))).toBe(true)
  })

  it('explains a refusal with the role on the scope', () => {
    expect(whyNot(atScope(SITE_ADMIN, 'shared'), 'edit')).toBe('Your role (viewer) is read-only')
  })

  it('finds a first scope: a site, else a group, else shared', () => {
    expect(firstScope(PLATFORM)).toBe('alpha')
    expect(firstScope(NATIONAL)).toBe('shared')
    expect(firstScope(REGIONAL)).toBe('alpha')
    expect(firstScope(single('admin'))).toBeNull()
  })

  it('names a scope, and falls back to its id', () => {
    expect(scopeName(PLATFORM, 'north')).toBe('North')
    expect(scopeName(PLATFORM, 'shared')).toBe('Shared')
    expect(scopeName(PLATFORM, 'gone')).toBe('gone')
  })

  it('previews a page in the sites whose chain reads from its owner', () => {
    expect(previewChoices(NATIONAL, 'shared').map((s) => s.id)).toEqual(['alpha', 'bravo'])
    expect(previewChoices(PLATFORM, 'north').map((s) => s.id)).toEqual(['alpha'])
    expect(previewChoices(PLATFORM, 'bravo').map((s) => s.id)).toEqual(['bravo'])
  })

  it('draws nothing multi-site for a single-site deployment', () => {
    for (const me of [single('admin'), single('viewer'), OPEN]) {
      expect(isMultiSite(me)).toBe(false)
      expect(scopeChoices(me)).toEqual([])
      expect(showsScopeSwitcher(me)).toBe(false)
      expect(canManageSites(me)).toBe(false)
      // `atScope` hands back the very object, so no consumer sees a `scope` key.
      expect(atScope(me, 'default')).toBe(me)
    }
    expect(canEdit(single('editor'))).toBe(true)
    expect(canManageAccess(single('admin'))).toBe(true)
    expect(canDeleteForms(single('admin'))).toBe(true)
    expect(canEditIn(single('viewer'), 'default')).toBe(false)
  })
})

describe('the scope in the URL', () => {
  const BASE = '/folio'

  it('puts the scope in the mount, so every screen path is what it always was', () => {
    expect(splitScope('/folio/~alpha/content', BASE)).toEqual({
      scope: 'alpha',
      mount: '/folio/~alpha',
    })
    expect(splitScope('/folio/~alpha', BASE)).toEqual({ scope: 'alpha', mount: '/folio/~alpha' })
    const mount = '/folio/~alpha'
    expect(parse('/folio/~alpha/edit/sty_1', mount).screen).toEqual({ name: 'edit', id: 'sty_1' })
    expect(href({ name: 'content' }, mount)).toBe('/folio/~alpha/content')
  })

  it('has no scope on a single-site URL, whatever the path', () => {
    for (const path of ['/folio', '/folio/content', '/folio/edit/sty_1', '/folio/sites']) {
      expect(splitScope(path, BASE)).toEqual({ scope: null, mount: BASE })
    }
    // Not a scope: an uppercase or hyphen-edged segment.
    expect(splitScope('/folio/~Alpha/content', BASE).scope).toBeNull()
    expect(splitScope('/folio/~-x/content', BASE).scope).toBeNull()
  })

  it('threads apiBase as {base}/~<scope>/api, and only with a scope', () => {
    expect(scopedApiBase('/folio/api', BASE, 'alpha')).toBe('/folio/~alpha/api')
    expect(scopedApiBase('/folio/api', BASE, null)).toBe('/folio/api')
    expect(scopedMount(BASE, 'alpha')).toBe('/folio/~alpha')
    expect(scopedMount(BASE, null)).toBe(BASE)
  })

  it('tells a component with only apiBase which scope it is in', () => {
    expect(scopeOfApiBase('/folio/~alpha/api')).toBe('alpha')
    expect(scopeOfApiBase('/folio/api')).toBeNull()
    expect(scopeOfApiBase('https://cms.example/folio/~north/api')).toBe('north')
  })

  it('takes over a link only within the same scope', () => {
    expect(isInsideMount('/folio/~alpha/content', '/folio/~alpha', BASE)).toBe(true)
    expect(isInsideMount('/folio/~bravo/content', '/folio/~alpha', BASE)).toBe(false)
    expect(isInsideMount('/folio/sites', '/folio/~alpha', BASE)).toBe(false)
    // Under the bare mount a scoped path is another mount's shell: a page load.
    expect(isInsideMount('/folio/~alpha/content', BASE, BASE)).toBe(false)
    expect(isInsideMount('/folio/content', BASE, BASE)).toBe(true)
    expect(isInsideMount('/folio/sites', BASE, BASE)).toBe(true)
  })

  it('takes the scope off a mount', () => {
    expect(bareMount('/folio/~alpha')).toBe('/folio')
    expect(bareMount('/folio')).toBe('/folio')
  })

  it('keeps the screen across scopes only where it means the same in each', () => {
    expect(switchScopeUrl(BASE, 'bravo', { name: 'content' })).toBe('/folio/~bravo/content')
    expect(switchScopeUrl(BASE, 'bravo', { name: 'edit', id: 'sty_1' })).toBe('/folio/~bravo')
    expect(switchScopeUrl(BASE, 'bravo', { name: 'home' })).toBe('/folio/~bravo')
  })

  it('has a Sites screen that round-trips like any other', () => {
    expect(parse('/folio/sites', BASE).screen).toEqual({ name: 'sites' })
    expect(href({ name: 'sites' }, BASE)).toBe('/folio/sites')
    expect(crumbs({ screen: { name: 'sites' }, query: {} })).toEqual([{ text: 'Sites' }])
  })
})

describe('the sidebar', () => {
  const TYPES = [
    { name: 'page', label: 'Page', kind: 'page', root: 'r' },
    { name: 'header', label: 'Header', kind: 'singleton', root: 'h' },
  ] as DocumentType[]
  const labels = (groups: ReturnType<typeof nav>) =>
    groups.flatMap((g) => g.items.map((i) => i.label))

  it('offers Sites to the platform, in a scope and on the page with none', () => {
    expect(
      labels(nav({ types: TYPES, globals: [], me: atScope(PLATFORM, 'alpha'), scope: 'alpha' })),
    ).toContain('Sites')
    expect(
      labels(nav({ types: TYPES, globals: [], me: atScope(PLATFORM, null), scope: null })),
    ).toEqual(['Sites'])
  })

  it('has no Sites for a site admin, and nothing at all on the page with no scope', () => {
    const alpha = atScope(SITE_ADMIN, 'alpha')
    expect(labels(nav({ types: TYPES, globals: [], me: alpha, scope: 'alpha' }))).not.toContain(
      'Sites',
    )
    expect(nav({ types: TYPES, globals: [], me: atScope(SITE_ADMIN, null), scope: null })).toEqual(
      [],
    )
  })

  it('links a global to the scope’s own layer', () => {
    const items = (scope: string) =>
      nav({ types: TYPES, globals: ['header'], me: atScope(PLATFORM, scope), scope })
        .flatMap((g) => g.items)
        .find((i) => i.label === 'Header')?.screen
    expect(items('alpha')).toEqual({ name: 'edit', id: 'sng_header:alpha' })
    expect(items('shared')).toEqual({ name: 'edit', id: 'sng_header:shared' })
    // `default`'s layer is the bare id, so an existing singleton id is untouched.
    expect(items('default')).toEqual({ name: 'edit', id: 'sng_header' })
  })

  it('is the sidebar it always was with no sites: no Sites, no scope, bare singleton ids', () => {
    const groups = nav({ types: TYPES, globals: ['header'], me: single('admin') })
    expect(labels(groups)).not.toContain('Sites')
    expect(groups.flatMap((g) => g.items).find((i) => i.label === 'Header')?.screen).toEqual({
      name: 'edit',
      id: 'sng_header',
    })
    expect(activeItem(groups, { name: 'home' })).toEqual({ name: 'home' })
  })

  it('groups the switcher Shared, Groups, Sites, and drops an empty group', () => {
    const groups = scopeOptionGroups(scopeChoices(PLATFORM))
    expect(groups.map((g) => g.label)).toEqual(['Shared', 'Groups', 'Sites'])
    expect(groups[2]?.options.map((o) => o.id)).toEqual(['alpha', 'bravo'])
    expect(scopeOptionGroups(scopeChoices(NATIONAL)).map((g) => g.label)).toEqual(['Shared'])
    expect(scopeOptionGroups(scopeChoices(single('admin')))).toEqual([])
  })
})

describe('the Sites screen', () => {
  it('holds for a platform admin and for auth: open', () => {
    expect(sitesGate(PLATFORM, false)).toEqual({ kind: 'ok' })
    expect(sitesGate(OPEN_MULTI, false)).toEqual({ kind: 'ok' })
  })

  it('refuses a site admin, a national publisher and the signed-out', () => {
    expect(sitesGate(SITE_ADMIN, false).kind).toBe('refused')
    expect(sitesGate(NATIONAL, false).kind).toBe('refused')
    expect(sitesGate({ ...PLATFORM, actor: null }, false).kind).toBe('anonymous')
  })

  it('says a single-site deployment has no registry, and waits for /me', () => {
    expect(sitesGate(single('admin'), false)).toEqual({ kind: 'absent' })
    expect(sitesGate(OPEN, false)).toEqual({ kind: 'absent' })
    // The optimistic guess is not an answer.
    expect(sitesGate(OPEN, true)).toEqual({ kind: 'booting' })
  })

  it('lists groups before sites, each by id', () => {
    expect(siteRows(REGISTRY).map((r) => [r.kind, r.id])).toEqual([
      ['group', 'north'],
      ['site', 'alpha'],
      ['site', 'bravo'],
    ])
  })

  it('says why a site without a preview origin cannot preview', () => {
    const rows = siteRows(REGISTRY)
    expect(previewNote(rows.find((r) => r.id === 'bravo')!)).toContain('No preview origin')
    expect(previewNote(rows.find((r) => r.id === 'alpha')!)).toBeNull()
    expect(previewNote(rows.find((r) => r.id === 'north')!)).toBeNull()
  })

  it('validates an id before the request', () => {
    const form = { ...emptyForm('site'), name: 'Delta' }
    expect(formRefusal({ ...form, id: '' }, 'create')).toBe('Give it an id first')
    expect(formRefusal({ ...form, id: 'Bad Id' }, 'create')).toContain('lowercase')
    expect(formRefusal({ ...form, id: 'shared' }, 'create')).toContain('reserved')
    expect(formRefusal({ ...form, id: '*' }, 'create')).toContain('lowercase')
    expect(formRefusal({ ...form, id: 'delta' }, 'create')).toBeUndefined()
    // An id is not asked for on edit, and a name always is.
    expect(formRefusal({ ...form, id: '' }, 'edit')).toBeUndefined()
    expect(formRefusal({ ...form, id: 'delta', name: ' ' }, 'edit')).toBe('Give it a name first')
  })

  it('builds a create body a group and a site each have the right fields of', () => {
    expect(createBody({ ...emptyForm('group'), id: 'north', name: ' North ' })).toEqual({
      id: 'north',
      kind: 'group',
      name: 'North',
    })
    expect(
      createBody({
        ...emptyForm('site'),
        id: 'delta',
        name: 'Delta',
        group: 'north',
        status: 'preview',
        preview: ' https://preview.delta.example ',
        hosts: 'delta.example\nwww.delta.example',
      }),
    ).toEqual({
      id: 'delta',
      kind: 'site',
      name: 'Delta',
      group: 'north',
      status: 'preview',
      preview: 'https://preview.delta.example',
      hosts: ['delta.example', 'www.delta.example'],
    })
  })

  it('patches only what changed, and hosts by their own route', () => {
    const alpha = siteRows(REGISTRY).find((r) => r.id === 'alpha')!
    expect(patchBody(formOf(alpha), alpha)).toEqual({})
    expect(patchBody({ ...formOf(alpha), name: 'Alpha 2', status: 'preview' }, alpha)).toEqual({
      name: 'Alpha 2',
      status: 'preview',
    })
    expect(patchBody({ ...formOf(alpha), group: '' }, alpha)).toEqual({ group: null })
    expect(patchBody({ ...formOf(alpha), preview: '' }, alpha)).toEqual({ preview: null })
    expect(hostsChanged(formOf(alpha), alpha)).toBe(false)
    expect(hostsChanged({ ...formOf(alpha), hosts: 'alpha.example, new.example' }, alpha)).toBe(
      true,
    )
    expect(parseHosts(' a.example,\n b.example  ')).toEqual(['a.example', 'b.example'])
  })

  it('opens a scope’s settings layer in the editor under that scope', () => {
    expect(settingsHref('/folio', 'siteSettings', 'alpha')).toBe(
      '/folio/~alpha/edit/sng_siteSettings%3Aalpha',
    )
    expect(settingsHref('/folio', 'siteSettings', 'shared')).toBe(
      '/folio/~shared/edit/sng_siteSettings%3Ashared',
    )
    expect(settingsHref('/folio', 'siteSettings', 'default')).toBe(
      '/folio/~default/edit/sng_siteSettings',
    )
  })
})

describe('home: inherited pages', () => {
  const row = (over: Partial<InheritedRow>): InheritedRow =>
    ({
      id: 'sty_1',
      type: 'page',
      title: 'Stores',
      path: 'stores',
      site: 'shared',
      shadowedBy: null,
      forkedSince: false,
      ...over,
    }) as InheritedRow

  it('offers inherited pages to a scope with something above it, and to no other', () => {
    expect(showsInherited(atScope(PLATFORM, 'alpha'))).toBe(true)
    expect(showsInherited(atScope(PLATFORM, 'north'))).toBe(true)
    expect(showsInherited(atScope(PLATFORM, 'shared'))).toBe(false)
    expect(showsInherited(atScope(PLATFORM, null))).toBe(false)
    expect(showsInherited(single('admin'))).toBe(false)
    expect(showsInherited(OPEN)).toBe(false)
  })

  it('forks an unshadowed page, points at an override, and stays read-only for a viewer', () => {
    const alpha = atScope(PLATFORM, 'alpha')
    const kinds = (action: InheritedAction) => action.kind
    expect(kinds(inheritedAction(row({}), [row({})], alpha))).toBe('fork')
    expect(inheritedAction(row({ shadowedBy: 'sty_2', forkedSince: true }), [], alpha)).toEqual({
      kind: 'overridden',
      id: 'sty_2',
      changed: true,
    })
    const viewer = atScope(multi({ shared: 'viewer', alpha: 'viewer' }), 'alpha')
    expect(kinds(inheritedAction(row({}), [row({})], viewer))).toBe('none')
  })

  it('refuses a fork under a parent the scope has not forked, by name', () => {
    const alpha = atScope(PLATFORM, 'alpha')
    const info = row({ id: 'sty_info', title: 'Info', path: 'info' })
    const parking = row({ id: 'sty_p', title: 'Parking', path: 'info/parking' })
    expect(inheritedAction(parking, [info, parking], alpha)).toEqual({
      kind: 'blocked',
      reason: 'Fork Info first',
    })
    expect(
      inheritedAction(parking, [{ ...info, shadowedBy: 'sty_mine' }, parking], alpha).kind,
    ).toBe('fork')
    // A parent on another page is the server's to refuse; nothing is guessed here.
    expect(inheritedAction(parking, [parking], alpha).kind).toBe('fork')
  })

  it('names a page’s owner', () => {
    expect(ownerLabel(PLATFORM, { site: 'north' })).toBe('North')
    expect(ownerLabel(PLATFORM, { site: 'shared' })).toBe('Shared')
  })

  it('offers Create home page to someone who may create, in a scope with no home', () => {
    expect(canCreateHome(atScope(PLATFORM, 'alpha'), undefined)).toBe(true)
    expect(canCreateHome(atScope(PLATFORM, 'alpha'), { id: 'sty_root' })).toBe(false)
    expect(canCreateHome(atScope(multi({ alpha: 'viewer' }), 'alpha'), undefined)).toBe(false)
    expect(canCreateHome(single('admin'), undefined)).toBe(false)
  })

  it('creates the home page as the default page type at the root', () => {
    const types = [
      { name: 'post', label: 'Post', kind: 'page', root: 'p' },
      { name: 'page', label: 'Page', kind: 'page', root: 'r', default: true },
    ] as DocumentType[]
    expect(homePageBody(types)).toEqual({ title: 'Home', type: 'page', root: true })
    expect(
      homePageBody([{ name: 'person', label: 'P', kind: 'record', root: 'x' }] as DocumentType[]),
    ).toBeNull()
  })

  it('links a global card to the scope’s layer, and to sng_<type> with no scope', () => {
    const types = [
      { name: 'header', label: 'Header', kind: 'singleton', root: 'h' },
    ] as DocumentType[]
    const card = (scope?: string | null) =>
      quickCards({
        types,
        globals: ['header'],
        counts: null,
        assets: undefined,
        mayCreate: false,
        ...(scope !== undefined ? { scope } : {}),
      }).find((c) => c.key === 'global:header')?.screen
    expect(card('alpha')).toEqual({ name: 'edit', id: 'sng_header:alpha' })
    expect(card()).toEqual({ name: 'edit', id: 'sng_header' })
    expect(card(null)).toEqual({ name: 'edit', id: 'sng_header' })
  })
})

describe('the pane', () => {
  const story = (over: Partial<StoryMeta> = {}): StoryMeta =>
    ({
      id: 'sty_1',
      type: 'page',
      title: 'Stores',
      path: 'stores',
      site: 'shared',
      previewUrl: 'https://alpha.example/stores?_folio=preview',
      ...over,
    }) as StoryMeta

  it('previews a shared page in the scope being shown, when that is a site', () => {
    const pane = paneChoice(atScope(PLATFORM, 'alpha'), story(), null)
    expect(pane).toMatchObject({ kind: 'site', origin: 'https://preview.alpha.example' })
    expect(pane.kind === 'site' && pane.choices.map((s) => s.id)).toEqual(['alpha', 'bravo'])
    expect(paneLabel(pane)).toBe('Previewing in Alpha')
  })

  it('takes the picker’s choice, and falls back to the first when it is not on offer', () => {
    const me = atScope(PLATFORM, 'shared')
    expect(paneChoice(me, story(), 'bravo')).toMatchObject({ site: { id: 'bravo' } })
    expect(paneChoice(me, story(), 'gone')).toMatchObject({ site: { id: 'alpha' } })
  })

  it('says a site with no preview origin cannot show the page', () => {
    const pane = paneChoice(atScope(PLATFORM, 'bravo'), story({ site: 'bravo' }), null)
    expect(pane).toMatchObject({ kind: 'site', origin: null })
    expect(paneLabel(pane)).toContain('no preview origin')
    expect(
      paneSource(pane, 'https://x.example/stores?_folio=preview', story(), '/folio'),
    ).toBeUndefined()
  })

  it('names the deployment’s reason for an empty pane, and none when it can load', () => {
    const noOrigin = paneChoice(atScope(PLATFORM, 'bravo'), story({ site: 'bravo' }), null)
    expect(paneUnavailable(noOrigin)).toContain('no preview origin')
    const fine = paneChoice(atScope(PLATFORM, 'alpha'), story({ site: 'alpha' }), null)
    expect(paneUnavailable(fine)).toBeNull()
    expect(paneUnavailable({ kind: 'none' })).toBeNull()
  })

  it('says why when the caller may preview no site that shows the page', () => {
    // A regional editor previews only Alpha; Bravo's own page has no such site.
    const pane = paneChoice(atScope(REGIONAL, 'alpha'), story({ site: 'bravo' }), null)
    expect(pane.kind).toBe('unavailable')
    expect(paneLabel(pane)).toContain('cannot preview')
  })

  it('loads site/start on the ADMIN origin, never the preview URL itself', () => {
    const me = atScope(PLATFORM, 'alpha')
    const pane = paneChoice(me, story({ site: 'alpha' }), null)
    const src = paneSource(
      pane,
      'https://alpha.example/stores?_folio=preview',
      story({ site: 'alpha' }),
      '/folio',
    )
    // The handoff, so every (re)load mints a fresh grant for that site.
    expect(src?.startsWith('/folio/~alpha/site/start?next=')).toBe(true)
    // The preview URL's path survives as `next`, naming the story, and its origin does not.
    const next = new URL(src!, 'https://cms.example').searchParams.get('next')
    expect(next).toBe('/stores?_folio=preview&_folio_id=sty_1')
    expect(src).not.toContain('alpha.example')
  })

  it('names no story for a document with no path', () => {
    const layer = story({ id: 'sng_x:alpha', path: null, site: 'alpha' })
    const pane = paneChoice(atScope(PLATFORM, 'alpha'), layer, null)
    const src = paneSource(pane, 'https://alpha.example/?_folio=preview&as=x', layer, '/folio')
    expect(decodeURIComponent(src!)).not.toContain('_folio_id')
  })

  it('is the pane it always was with no sites: the host’s own URL, untouched', () => {
    const me = single('admin')
    const pane = paneChoice(me, story({ site: 'default' }), null)
    expect(pane).toEqual({ kind: 'none' })
    expect(paneLabel(pane)).toBeNull()
    expect(paneSource(pane, '/stores?_folio=preview', story(), '/folio')).toBe(
      '/stores?_folio=preview',
    )
    expect(paneSource(pane, undefined, story(), '/folio')).toBeUndefined()
  })

  it('builds the same URL for Open preview in a new tab', () => {
    expect(paneSrc('/folio', 'alpha', '/stores?_folio=preview')).toBe(
      '/folio/~alpha/site/start?next=%2Fstores%3F_folio%3Dpreview',
    )
  })
})

describe('the notices over an inherited page', () => {
  const alpha = atScope(PLATFORM, 'alpha')
  const shared = { id: 'sty_1', site: 'shared', path: 'stores', forkedFrom: null } as StoryMeta

  it('is read-only on a page another scope owns, with Fork for someone who may create', () => {
    expect(isInherited(alpha, shared)).toBe(true)
    expect(isInherited(alpha, { ...shared, site: 'alpha' })).toBe(false)
    expect(inheritNotices(alpha, shared, { override: undefined, fork: undefined })).toEqual([
      { kind: 'readonly', owner: 'Shared', canFork: true },
    ])
    const viewer = atScope(multi({ alpha: 'viewer' }), 'alpha')
    expect(inheritNotices(viewer, shared, { override: undefined, fork: undefined })).toEqual([
      { kind: 'readonly', owner: 'Shared', canFork: false },
    ])
  })

  it('says the scope overrides the page, once it does, with a link to the override', () => {
    const notices = inheritNotices(alpha, shared, { override: { id: 'sty_mine' }, fork: undefined })
    const override = notices.find((n) => n.kind === 'overridden')!
    expect(noticeText(override)).toBe('Alpha overrides this page.')
    expect(noticeLink(override, '/folio/~alpha')).toEqual({
      text: 'Open Alpha’s version',
      href: '/folio/~alpha/edit/sty_mine',
    })
  })

  it('says the original changed since a fork, with a link', () => {
    const fork = { id: 'sty_2', site: 'alpha', path: 'stores', forkedFrom: 'sty_1' } as StoryMeta
    const notices = inheritNotices(alpha, fork, {
      override: undefined,
      fork: { source: { id: 'sty_1', site: 'shared' }, changed: true },
    })
    expect(notices).toEqual([{ kind: 'forkChanged', source: 'Shared', id: 'sty_1' }])
    expect(noticeText(notices[0]!)).toBe('The Shared version has changed since you forked it.')
    expect(noticeLink(notices[0]!, '/folio/~alpha')?.href).toBe('/folio/~alpha/edit/sty_1')
    // Not changed: no notice, and none while the fork status has not answered.
    expect(
      inheritNotices(alpha, fork, {
        override: undefined,
        fork: { source: { id: 'sty_1', site: 'shared' }, changed: false },
      }),
    ).toEqual([])
    expect(inheritNotices(alpha, fork, { override: undefined, fork: undefined })).toEqual([])
  })

  it('draws no notice at all on a single-site deployment', () => {
    expect(
      inheritNotices(single('admin'), shared, {
        override: { id: 'x' },
        fork: { source: { id: 'y', site: 'shared' }, changed: true },
      }),
    ).toEqual([])
  })
})

describe('the inspector’s layer labels', () => {
  const SCHEMA: SchemaIndex = {
    hdr: {
      name: 'hdr',
      label: 'Header',
      fields: {
        title: { kind: 'text' },
        cta: { kind: 'text', translatable: true },
        theme: { kind: 'blocks', allow: ['th'], max: 1 },
      },
    },
    th: { name: 'th', label: 'Theme', fields: { primary: { kind: 'text' } } },
  }
  const doc = (root: string, data: Record<string, unknown>, extra: Doc['bloks'] = {}): Doc => ({
    root,
    bloks: {
      [root]: {
        uid: root,
        type: 'hdr',
        parent: null,
        slot: null,
        order: 'a0',
        data: data as never,
      },
      ...extra,
    },
  })
  const sharedDoc = doc('s', { title: 'A', cta: 'Visit' })
  const northDoc = doc('n', { cta: 'Hello' })
  const alphaDoc = doc('a', { title: null })
  const nameOf = (scope: string) => scopeName(PLATFORM, scope)

  it('labels each field against the layers below, as the spec’s example', () => {
    const info = layerInfo({
      doc: alphaDoc,
      docs: [sharedDoc, northDoc],
      below: ['shared', 'north'],
      own: 'alpha',
      schema: SCHEMA,
      nameOf,
    })
    expect(layerLabel(info.states.title!, nameOf)).toBe('Removed here')
    expect(layerLabel(info.states.cta!, nameOf)).toBe('Inherited from North')
    expect(layerLabel({ state: 'overridden', from: 'alpha' }, nameOf)).toBe('Overridden here')
    expect(layerLabel({ state: 'inherited', from: 'shared' }, nameOf)).toBe('Inherited from Shared')
    // The merged layers below, for Override to copy from.
    expect(info.below?.bloks[info.below.root]?.data).toMatchObject({ title: 'A', cta: 'Hello' })
  })

  it('offers Override and Remove on an inherited field, Reset and Remove on an overridden one', () => {
    expect(layerActions('inherited', false)).toEqual(['override', 'remove'])
    expect(layerActions('overridden', false)).toEqual(['reset', 'remove'])
    expect(layerActions('removed', false)).toEqual(['reset'])
    // Absent, not disabled, when read-only.
    expect(layerActions('inherited', true)).toEqual([])
  })

  it('writes the inherited value on Override, every locale’s at once', () => {
    const inherited = doc('s', { cta: 'Visit' })
    inherited.bloks.s!.i18n = { fr: { cta: 'Visitez' }, de: { cta: 'Besuchen' } }
    const top = alphaDoc.bloks.a!
    expect(layerMutations('override', top, 'cta', inherited.bloks.s)).toEqual([
      { t: 'set', uid: 'a', field: 'cta', value: 'Visit' },
      { t: 'set', uid: 'a', field: 'cta', value: 'Visitez', locale: 'fr' },
      { t: 'set', uid: 'a', field: 'cta', value: 'Besuchen', locale: 'de' },
    ])
    // Nothing inherited, nothing to copy: typing is what overrides.
    expect(layerMutations('override', top, 'cta', undefined)).toEqual([])
  })

  it('unsets on Reset, in every locale the layer holds, and nulls on Remove', () => {
    const own = doc('a', { cta: 'Hi' }).bloks.a!
    own.i18n = { fr: { cta: 'Salut' } }
    expect(layerMutations('reset', own, 'cta', undefined)).toEqual([
      { t: 'unset', uid: 'a', field: 'cta' },
      { t: 'unset', uid: 'a', field: 'cta', locale: 'fr' },
    ])
    expect(layerMutations('remove', own, 'cta', undefined)).toEqual([
      { t: 'set', uid: 'a', field: 'cta', value: null },
    ])
  })

  it('files a max:1 child’s fields under slot.field and labels nothing deeper', () => {
    const child: Blok = {
      uid: 'c',
      type: 'th',
      parent: 'a',
      slot: 'theme',
      order: 'a0',
      data: {},
    }
    const layer = doc('a', {}, { c: child })
    expect(layerPrefix(layer, SCHEMA, layer.bloks.a!)).toBe('')
    expect(layerPrefix(layer, SCHEMA, layer.bloks.c!)).toBe('theme.')
    const deep = {
      ...layer,
      bloks: { ...layer.bloks, d: { ...child, uid: 'd', parent: 'c' } },
    } as Doc
    expect(layerPrefix(deep, SCHEMA, deep.bloks.d!)).toBeNull()
  })

  it('finds the inherited blok a child continues', () => {
    const sharedChild = {
      uid: 'sc',
      type: 'th',
      parent: 's',
      slot: 'theme',
      order: 'a0',
      data: { primary: 'red' },
    } as never
    const below = doc('s', {}, { sc: sharedChild })
    const layer = doc(
      'a',
      {},
      { c: { uid: 'c', type: 'th', parent: 'a', slot: 'theme', order: 'a0', data: {} } as never },
    )
    expect(belowBlok(layer, below, layer.bloks.a!)?.uid).toBe('s')
    expect(belowBlok(layer, below, layer.bloks.c!)?.uid).toBe('sc')
    expect(belowBlok(layer, undefined, layer.bloks.a!)).toBeUndefined()
  })

  it('labels a layer of a scope with something below it, and never the shared or a single-site one', () => {
    expect(isLayerDocument('sng_header:alpha', true)).toBe(true)
    expect(isLayerDocument('sng_header', true)).toBe(true)
    expect(isLayerDocument('sng_header:shared', true)).toBe(false)
    expect(isLayerDocument('sty_1', true)).toBe(false)
    // A single-site deployment: never, whatever the id.
    expect(isLayerDocument('sng_header', false)).toBe(false)
    expect(isLayerDocument('sng_header:alpha', false)).toBe(false)
  })

  it('takes the chain’s scopes below the layer, most general first', () => {
    expect(scopesBelow(['alpha', 'north', 'shared'], 'alpha')).toEqual(['shared', 'north'])
    expect(scopesBelow(['bravo', 'shared'], 'bravo')).toEqual(['shared'])
    expect(scopesBelow(['shared'], 'shared')).toEqual([])
  })
})

describe('grants', () => {
  const user = (over: Partial<AccessUser> = {}): AccessUser => ({
    id: 'usr_b',
    email: 'b@example.com',
    name: 'Bo',
    role: 'viewer',
    colour: null,
    provider: null,
    roleFrom: null,
    createdAt: 1,
    lastSeenAt: null,
    passkeys: 0,
    grants: [
      { scope: '*', role: 'editor', roleFrom: null },
      { scope: 'alpha', role: 'publisher', roleFrom: null },
      { scope: 'gone', role: 'admin', roleFrom: null },
    ],
    ...over,
  })

  it('lists grants with the platform first, and flags a deleted scope as ignored', () => {
    const rows = grantRows(user(), atScope(PLATFORM, 'alpha'))
    expect(rows.map((r) => [r.scope, r.label, r.ignored])).toEqual([
      ['*', 'Every site', false],
      ['alpha', 'Alpha', false],
      ['gone', 'gone', true],
    ])
  })

  it('cannot edit a grant a sign-in placed, and says who placed it', () => {
    expect(grantsReason(user())).toBeNull()
    const placed = user({ grants: [{ scope: 'alpha', role: 'editor', roleFrom: 'oidc' }] })
    expect(grantsReason(placed)).toContain('oidc')
  })

  it('edits a copy of every grant, ignored ones included, so saving drops none unseen', () => {
    expect(grantsOf(user())).toEqual({ '*': 'editor', alpha: 'publisher', gone: 'admin' })
  })

  it('adds and removes a grant, and offers only scopes not yet granted', () => {
    const me = atScope(PLATFORM, 'alpha')
    expect(withGrant({ alpha: 'editor' }, 'alpha', 'admin')).toEqual({ alpha: 'admin' })
    expect(withoutGrant({ alpha: 'editor', bravo: 'viewer' }, 'alpha')).toEqual({ bravo: 'viewer' })
    expect(grantScopeOptions(me)[0]).toEqual({ id: '*', label: 'Every site (platform)' })
    expect(nextScope(me, { '*': 'admin', shared: 'viewer' })).toBe('north')
    expect(
      nextScope(me, Object.fromEntries(grantScopeOptions(me).map((o) => [o.id, 'viewer']))),
    ).toBeNull()
    expect(grantsRefusal({})).toBe('Give at least one grant')
    expect(grantsRefusal({ alpha: 'editor' })).toBeUndefined()
  })

  it('binds a token to a scope, and never lets a bound token hold admin', () => {
    expect(presetsFor(false).some((p) => p.scopes.includes('admin'))).toBe(true)
    expect(presetsFor(true).some((p) => p.scopes.includes('admin'))).toBe(false)
    expect(scopesForBinding(['admin'], true)).toEqual(['content:read'])
    expect(scopesForBinding(['admin'], false)).toEqual(['admin'])
    expect(scopesForBinding(['content:write'], true)).toEqual(['content:write'])
    expect(bindingLabel(PLATFORM, 'alpha')).toBe('Alpha')
    expect(bindingLabel(PLATFORM, null)).toBe('Every site')
  })

  it('gates Access on the platform, with a sentence that says so', () => {
    expect(accessGate(atScope(PLATFORM, 'alpha')).kind).toBe('ok')
    const refused = accessGate(atScope(SITE_ADMIN, 'alpha'))
    expect(refused).toMatchObject({ kind: 'refused' })
    expect(refused.kind === 'refused' && refused.reason).toContain('platform administrator')
    // Single-site: unchanged.
    expect(accessGate(single('admin')).kind).toBe('ok')
    expect(accessGate(single('editor')).kind).toBe('refused')
  })
})
