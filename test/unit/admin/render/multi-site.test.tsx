/**
 * **The multi-site admin, mounted** (`docs/specs/foundation/multi-site.md`, phase 8).
 *
 * Two halves and both are load-bearing. The multi-site half asserts the scope
 * switcher, the scoped API, the Sites screen and the layer labels appear where the
 * spec says. The single-site half asserts they do **not** appear anywhere else —
 * because the phase's hard rule is that a deployment with no `sites` looks exactly as
 * it did, and the way that breaks is a branch that is on by default. Each multi-site
 * assertion below is therefore paired with the same query against a single-site mount.
 *
 * `Me` is built by the server's own `meSites`, so this file cannot describe a `/me`
 * the server would not send.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type Me, OPEN } from '../../../../src/admin/me'
import { Inspector } from '../../../../src/admin/ui/screens/Inspector'
import type { Blocks } from '../../../../src/admin/hooks/useBlocks'
import { StoryStore } from '../../../../src/admin/store'
import { SiteDialog } from '../../../../src/admin/ui/screens/SiteDialog'
import { UI_SCOPE } from '../../../../src/admin/ui/scope'
import { layerInfo } from '../../../../src/admin/ui/screens/inspector-model'
import { emptyForm } from '../../../../src/admin/ui/screens/sites-model'
import type { Blok, Doc } from '../../../../src/core/doc'
import { buildResolution } from '../../../../src/core/resolve'
import type { SchemaIndex } from '../../../../src/core/schema'
import { meSites } from '../../../../src/server/auth/me-sites'
import { ADMIN, mountAt, REGISTRY } from './fixture'

const PLATFORM: Me = {
  ...ADMIN,
  sites: meSites(REGISTRY as never, { '*': 'admin' }, 'siteSettings'),
}

/** Alpha's own admin: no `*` grant, so `role` is the default `viewer`. */
const SITE_ADMIN: Me = {
  ...ADMIN,
  actor: { ...ADMIN.actor, role: 'viewer' } as Me['actor'],
  sites: meSites(REGISTRY as never, { alpha: 'admin' }, 'siteSettings'),
}

const OPEN_MULTI: Me = { ...OPEN, sites: meSites(REGISTRY as never, null, 'siteSettings') }

const switcher = () => screen.queryByLabelText('Site') as (HTMLElement & { value: string }) | null
const link = (name: string) => screen.queryAllByRole('link', { name })

describe('the scope switcher', () => {
  it('is in the sidebar on a multi-site deployment, on the scope in the URL', async () => {
    await mountAt('/folio/~alpha/content', PLATFORM)
    const select = switcher()!
    expect(select).not.toBeNull()
    expect(select.value).toBe('alpha')
    // Grouped Shared / Groups / Sites.
    expect(
      Array.from(select.querySelectorAll('optgroup')).map((g) => g.getAttribute('label')),
    ).toEqual(['Shared', 'Groups', 'Sites'])
  })

  it('is absent on a single-site deployment, with a session and without', async () => {
    await mountAt('/folio/content', ADMIN)
    expect(switcher()).toBeNull()
  })

  it('is absent under auth: open with no sites', async () => {
    await mountAt('/folio/content', OPEN)
    expect(switcher()).toBeNull()
  })

  it('goes to the same screen in another scope, as a page load', async () => {
    await mountAt('/folio/~alpha/content', PLATFORM)
    const assign = vi.fn()
    const original = window.location
    // Not the router: a new scope is a new mount with its own API, so it must load.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, pathname: original.pathname, assign },
    })
    try {
      fireEvent.change(switcher()!, { target: { value: 'bravo' } })
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
    expect(assign).toHaveBeenCalledWith('/folio/~bravo/content')
  })
})

describe('the scoped API', () => {
  it('asks the scope’s own routes for its content, and the unscoped ones for who you are', async () => {
    const { asked } = await mountAt('/folio/~alpha/content', PLATFORM)
    expect(asked.some((u) => u.includes('/folio/~alpha/api/documents?kind=singleton'))).toBe(true)
    expect(asked.some((u) => u.endsWith('/folio/api/me'))).toBe(true)
    expect(asked.some((u) => u.endsWith('/folio/api/schema'))).toBe(true)
  })

  it('asks the unscoped routes only, on a single-site deployment', async () => {
    const { asked } = await mountAt('/folio/content', ADMIN)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.filter((u) => u.includes('~'))).toEqual([])
  })

  it('says so, rather than 403ing, for a scope the caller does not reach', async () => {
    await mountAt('/folio/~bravo/content', SITE_ADMIN)
    expect(screen.getByText(/You have no role on/)).toBeTruthy()
  })

  it('sends the bare root to the caller’s first scope', async () => {
    const replace = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, pathname: '/folio', search: '', replace },
    })
    try {
      window.history.replaceState(null, '', '/folio')
      await mountAt('/folio', PLATFORM)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
    expect(replace).toHaveBeenCalledWith('/folio/~alpha')
  })
})

describe('the Sites screen', () => {
  it('lists the registry for a platform admin', async () => {
    const { asked } = await mountAt('/folio/sites', PLATFORM)
    const table = screen.getByRole('table', { name: 'Sites and groups' })
    expect(within(table).getByText('Alpha')).toBeTruthy()
    expect(within(table).getByText('Bravo')).toBeTruthy()
    expect(within(table).getByText('North')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New site' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy()
    expect(asked.some((u) => u.endsWith('/folio/api/sites'))).toBe(true)
    // A site with no preview origin says so, where a person will look.
    expect(within(table).getByTitle(/No preview origin/)).toBeTruthy()
  })

  it('is in the sidebar for the platform, and not for a site admin', async () => {
    await mountAt('/folio/~alpha/content', PLATFORM)
    expect(link('Sites').length).toBeGreaterThan(0)
  })

  it('does not exist for a site admin: no link, no table, and no request for the registry', async () => {
    const { asked } = await mountAt('/folio/~alpha/content', SITE_ADMIN)
    expect(link('Sites')).toEqual([])
    document.body.innerHTML = ''
    const again = await mountAt('/folio/sites', SITE_ADMIN)
    expect(screen.queryByRole('table', { name: 'Sites and groups' })).toBeNull()
    expect(screen.getByText('Sites are managed by the platform')).toBeTruthy()
    expect(again.asked.some((u) => u.endsWith('/sites'))).toBe(false)
    expect(asked.some((u) => u.endsWith('/sites'))).toBe(false)
  })

  it('is open under auth: open, where the registry is open too', async () => {
    await mountAt('/folio/sites', OPEN_MULTI)
    expect(screen.getByRole('table', { name: 'Sites and groups' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New site' })).toBeTruthy()
  })

  it('says a single-site deployment has no registry, and asks for none', async () => {
    for (const me of [ADMIN, OPEN]) {
      document.body.innerHTML = ''
      const { asked } = await mountAt('/folio/sites', me)
      expect(screen.getByText('This deployment has one site')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'New site' })).toBeNull()
      expect(asked.some((u) => u.endsWith('/sites'))).toBe(false)
    }
  })

  it('opens the Settings tab onto a scope’s layer, under that scope', async () => {
    await mountAt('/folio/sites', PLATFORM)
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    })
    // `onQuery` replaces the URL; the tab is a query, so it needs the router's state.
    expect(window.location.search).toBe('?tab=settings')
    const alpha = screen.getByRole('link', { name: /^Alpha/ })
    expect(alpha.getAttribute('href')).toBe('/folio/~alpha/edit/sng_siteSettings%3Aalpha')
    expect(screen.getByRole('link', { name: /^Shared/ }).getAttribute('href')).toBe(
      '/folio/~shared/edit/sng_siteSettings%3Ashared',
    )
  })

  it('creates through a dialog that is the one focus-trapped portal, scoped', async () => {
    await mountAt('/folio/sites', PLATFORM)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New site' }))
    })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText(/Id/)).toBeTruthy()
    expect(within(dialog).getByLabelText('Preview origin')).toBeTruthy()
    expect(within(dialog).getByLabelText('Hostnames')).toBeTruthy()
    // The portal root, outside the shell, carries the scope class.
    const root = dialog.closest(`.${UI_SCOPE}`)
    expect(root).not.toBeNull()
    expect(root?.parentElement).toBe(document.body)
  })
})

describe('the site dialog', () => {
  it('re-declares the styling scope on the portal it mounts', () => {
    const { baseElement, container } = render(
      <SiteDialog
        mode="create"
        initial={emptyForm('site')}
        groups={[{ id: 'north', name: 'North', brand: null }]}
        onClose={() => {}}
        onSave={async () => {}}
      />,
    )
    const mounted = [...baseElement.children].filter((el) => el !== container)
    expect(mounted.length).toBeGreaterThan(0)
    for (const root of mounted) expect(root.classList.contains(UI_SCOPE)).toBe(true)
  })

  it('leaves a group with no status, preview or hostnames to fill in', () => {
    render(
      <SiteDialog
        mode="create"
        initial={emptyForm('group')}
        groups={[]}
        onClose={() => {}}
        onSave={async () => {}}
      />,
    )
    expect(screen.queryByLabelText('Preview origin')).toBeNull()
    expect(screen.queryByLabelText('Hostnames')).toBeNull()
    expect(screen.getByLabelText(/Id/)).toBeTruthy()
  })

  it('does not offer an id on edit, and Save needs a name', () => {
    render(
      <SiteDialog
        mode="edit"
        initial={{ ...emptyForm('site'), id: 'alpha', name: '' }}
        groups={[]}
        onClose={() => {}}
        onSave={async () => {}}
      />,
    )
    expect(screen.queryByLabelText(/^Id/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Home: inherited pages', () => {
  it('lists what a scope inherits, with Fork, for someone who may create', async () => {
    await mountAt('/folio/~alpha', PLATFORM)
    const table = screen.getByRole('table', { name: 'Inherited pages' })
    expect(within(table).getByText('Stores')).toBeTruthy()
    expect(within(table).getByRole('button', { name: 'Fork' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create home page' })).toBeTruthy()
  })

  it('has no such block in the shared scope, which inherits nothing', async () => {
    await mountAt('/folio/~shared', PLATFORM)
    expect(screen.queryByRole('table', { name: 'Inherited pages' })).toBeNull()
  })

  it('has no such block on a single-site deployment, and asks for none', async () => {
    const { asked } = await mountAt('/folio', ADMIN)
    expect(screen.queryByText('Inherited pages')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create home page' })).toBeNull()
    expect(asked.some((u) => u.includes('/inherited'))).toBe(false)
  })
})

/* -------------------------------------------------------------- inspector --- */

const SCHEMA: SchemaIndex = {
  hdr: {
    name: 'hdr',
    label: 'Header',
    fields: { title: { kind: 'text', label: 'Title' }, cta: { kind: 'text', label: 'Call' } },
  },
}

const layer = (uid: string, data: Blok['data']): Doc => ({
  root: uid,
  bloks: { [uid]: { uid, type: 'hdr', parent: null, slot: null, order: 'a0', data } },
})

const blocks: Blocks = {
  add: () => {},
  addFirst: () => {},
  move: () => {},
  remove: () => {},
  setField: () => {},
  duplicate: () => {},
  copy: async () => {},
  paste: () => {},
}

function mountInspector(over: { layers?: ReturnType<typeof layerInfo>; readOnly?: boolean }) {
  const doc = layer('a', { title: null })
  const store = new StoryStore('sng_header:alpha', '/folio/~alpha/api')
  const tx = vi.spyOn(store, 'tx').mockReturnValue(true)
  const utils = render(
    <Inspector
      store={store}
      schema={SCHEMA}
      types={[]}
      apiBase="/folio/~alpha/api"
      mount="/folio/~alpha"
      locales={undefined}
      locale="en"
      isSourceLocale
      resolution={buildResolution([], '/folio/asset')}
      blok={doc.bloks.a as Blok}
      readOnly={over.readOnly ?? false}
      blocks={blocks}
      story={{ id: 'sng_header:alpha', type: 'header', title: 'Header', path: null } as never}
      routed={false}
      isRootBlok={false}
      globalHint={null}
      onEditGlobal={() => {}}
      onNotice={() => {}}
      form={false}
      doc={doc}
      {...(over.layers ? { layers: over.layers } : {})}
    />,
  )
  return { ...utils, tx, doc }
}

const LAYERS = () =>
  layerInfo({
    doc: layer('a', { title: null }),
    docs: [layer('s', { title: 'A', cta: 'Visit' })],
    below: ['shared'],
    own: 'alpha',
    schema: SCHEMA,
    nameOf: (scope) => (scope === 'shared' ? 'Shared' : scope),
  })

describe('the inspector’s layer labels', () => {
  it('labels each field against the layers below, and offers its actions', () => {
    mountInspector({ layers: LAYERS() })
    expect(screen.getByText('Removed here')).toBeTruthy()
    expect(screen.getByText('Inherited from Shared')).toBeTruthy()
    // title is removed: only Reset. cta is inherited: Override and Remove.
    expect(screen.getAllByRole('button', { name: 'Reset to inherited' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Override' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  })

  it('writes an unset on Reset, the inherited value on Override, and null on Remove', () => {
    const { tx } = mountInspector({ layers: LAYERS() })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to inherited' }))
    expect(tx).toHaveBeenLastCalledWith([{ t: 'unset', uid: 'a', field: 'title' }])
    fireEvent.click(screen.getByRole('button', { name: 'Override' }))
    expect(tx).toHaveBeenLastCalledWith([{ t: 'set', uid: 'a', field: 'cta', value: 'Visit' }])
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(tx).toHaveBeenLastCalledWith([{ t: 'set', uid: 'a', field: 'cta', value: null }])
  })

  it('shows the inherited value read-only until Override makes it the layer’s own', () => {
    mountInspector({ layers: LAYERS() })
    const cta = screen.getByLabelText(/^Call/) as HTMLInputElement
    expect(cta.value).toBe('Visit')
    expect(cta.closest('fieldset')?.disabled).toBe(true)
  })

  it('draws no action at all on a read-only layer', () => {
    mountInspector({ layers: LAYERS(), readOnly: true })
    expect(screen.queryByRole('button', { name: 'Override' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset to inherited' })).toBeNull()
  })

  it('draws NO layer label and no action without layers: a single-site inspector', () => {
    mountInspector({})
    expect(screen.queryByText(/Inherited/)).toBeNull()
    expect(screen.queryByText('Overridden here')).toBeNull()
    expect(screen.queryByText('Removed here')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Override' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset to inherited' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    // And the field is an ordinary editable one.
    expect((screen.getByLabelText(/^Call/) as HTMLInputElement).closest('fieldset')?.disabled).toBe(
      false,
    )
  })
})

/* ------------------------------------------------------------------ access --- */

describe('Access', () => {
  it('shows grants per scope on a multi-site deployment, and a role on a single-site one', async () => {
    await mountAt('/folio/~alpha/access', PLATFORM)
    expect(screen.getByRole('columnheader', { name: 'Access' })).toBeTruthy()
    // Per scope, and the one naming a deleted scope is listed and says it reaches nothing.
    expect(screen.getByText('Alpha: publisher')).toBeTruthy()
    expect(screen.getByText('ghost: editor (ignored)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit access' })).toBeTruthy()
    document.body.innerHTML = ''
    await mountAt('/folio/access', ADMIN)
    // The table is empty here, so the header is not drawn; the screen’s own heading is.
    expect(screen.queryByRole('columnheader', { name: 'Access' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit access' })).toBeNull()
  })

  it('refuses a site admin, in the platform’s words', async () => {
    await mountAt('/folio/~alpha/access', SITE_ADMIN)
    expect(
      screen.getByText(/Only a platform administrator manages editors and tokens/),
    ).toBeTruthy()
  })

  it('binds a token to a scope, with no Full access once it is bound', async () => {
    await mountAt('/folio/~alpha/access?new=token', PLATFORM)
    const dialog = screen.getByRole('dialog')
    const works = within(dialog).getByLabelText('Works on')
    expect(within(dialog).getByRole('radio', { name: /Full access/ })).toBeTruthy()
    await act(async () => {
      fireEvent.change(works, { target: { value: 'alpha' } })
    })
    expect(within(dialog).queryByRole('radio', { name: /Full access/ })).toBeNull()
  })

  it('has no binding field, and Full access, on a single-site deployment', async () => {
    await mountAt('/folio/access?new=token', ADMIN)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Works on')).toBeNull()
    expect(within(dialog).getByRole('radio', { name: /Full access/ })).toBeTruthy()
  })

  it('asks for grants, not a role, when inviting on a multi-site deployment', async () => {
    await mountAt('/folio/~alpha/access?new=user', PLATFORM)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Role')).toBeNull()
    expect(within(dialog).getByLabelText('Scope to grant')).toBeTruthy()
  })

  it('asks for a role on a single-site deployment', async () => {
    await mountAt('/folio/access?new=user', ADMIN)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Role')).toBeTruthy()
    expect(within(dialog).queryByLabelText('Scope to grant')).toBeNull()
  })
})

/* -------------------------------------------------------------------- pane --- */

describe('the preview pane', () => {
  const frame = () => document.querySelector('iframe') as HTMLIFrameElement | null

  it('loads site/start on the admin origin for the site, not the preview URL itself', async () => {
    await mountAt('/folio/~alpha/edit/sty_home', PLATFORM)
    const src = frame()?.getAttribute('src') ?? ''
    expect(src.startsWith('/folio/~alpha/site/start?next=')).toBe(true)
    expect(new URL(src, 'https://cms.example').searchParams.get('next')).toBe(
      '/?_folio=preview&_folio_id=sty_home',
    )
    expect(screen.getByText('Previewing in Alpha')).toBeTruthy()
  })

  it('says a site with no preview origin cannot show the page, instead of blaming the host', async () => {
    await mountAt('/folio/~bravo/edit/sty_home', PLATFORM)
    expect(frame()).toBeNull()
    expect(screen.getAllByText(/has no preview origin/).length).toBeGreaterThan(0)
  })

  it('loads the host’s own preview URL, untouched, on a single-site deployment', async () => {
    await mountAt('/folio/edit/sty_home', ADMIN)
    expect(frame()?.getAttribute('src')).toBe('/?_folio=preview')
    expect(screen.queryByText(/Previewing in/)).toBeNull()
  })

  it('offers Open preview in a new tab when the browser refused the cookie', async () => {
    await mountAt('/folio/~alpha/edit/sty_home', PLATFORM)
    expect(screen.queryByRole('link', { name: 'Open preview in a new tab' })).toBeNull()
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'folio-preview', type: 'grant-blocked' },
          origin: 'https://preview.alpha.example',
          source: frame()?.contentWindow ?? null,
        }),
      )
    })
    const open = screen.getByRole('link', { name: 'Open preview in a new tab' })
    expect(open.getAttribute('href')).toBe(frame()?.getAttribute('src'))
    expect(open.getAttribute('target')).toBe('_blank')
  })

  it('ignores the same message from any other origin', async () => {
    await mountAt('/folio/~alpha/edit/sty_home', PLATFORM)
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'folio-preview', type: 'grant-blocked' },
          origin: 'https://elsewhere.example',
          source: frame()?.contentWindow ?? null,
        }),
      )
    })
    expect(screen.queryByRole('link', { name: 'Open preview in a new tab' })).toBeNull()
  })
})
