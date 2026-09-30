/**
 * **The multi-brand admin, mounted** (`docs/specs/foundation/multi-brand.md`, phase 7).
 *
 * The shell asks for its manifest at the scope's own base, and on a deployment with
 * `brands` the server answers that scope's brand's. Here the stub does the same, so a
 * shell that asked at the bare base with a scope chosen would draw the wrong brand's
 * types, which is the failure this file exists to catch. The single-brand half is
 * `multi-site.test.tsx`: no brand column, no brand field, the bare manifest fetch.
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { type Me, OPEN } from '../../../../src/admin/me'
import type { Manifest } from '../../../../src/core/schema'
import { meSites } from '../../../../src/server/auth/me-sites'
import { mountAt, MANIFEST, resetServed, serve } from './fixture'

const BRANDS = [
  { id: 'allaboutafrica', label: 'All About Africa' },
  { id: 'takeoffgo', label: 'Take Off Go' },
]

const REGISTRY = {
  groups: [],
  sites: [
    {
      id: 'aaa',
      name: 'AAA',
      group: null,
      status: 'live',
      hosts: ['allaboutafrica.example'],
      preview: 'https://p.aaa.example',
      brand: 'allaboutafrica',
    },
    {
      id: 'tog',
      name: 'TOG',
      group: null,
      status: 'draft',
      hosts: [],
      preview: null,
      brand: 'takeoffgo',
    },
  ],
  shared: false,
}

const BRANDED: Me = { ...OPEN, sites: meSites(REGISTRY as never, null, undefined, BRANDS) }

/** A brand's manifest: the fixture's, with its own second page type. */
const manifestOf = (brand: (typeof BRANDS)[number], extra: { name: string; label: string }) =>
  ({
    ...MANIFEST,
    types: [
      ...MANIFEST.types.filter((t) => t.name !== 'insight'),
      { name: extra.name, label: extra.label, kind: 'page', root: 'pageRoot' },
    ],
    brand,
  }) as Manifest

/** What the server does: the scope decides, and no scope is the neutral manifest. */
const schemaAt = (scope: string | null): Manifest => {
  if (scope === 'tog') return manifestOf(BRANDS[1]!, { name: 'tour', label: 'Tour' })
  if (scope === 'aaa') return manifestOf(BRANDS[0]!, { name: 'safari', label: 'Safari' })
  return { types: [], blocks: [], root: '', globals: [] }
}

afterEach(resetServed)

describe('the admin on a deployment with brands', () => {
  it('lists the scope’s brand’s types in the New menu, and the other brand’s in none', async () => {
    serve({ schemaAt, registry: REGISTRY })
    const { asked } = await mountAt('/folio/~tog/content', BRANDED)
    expect(asked.some((u) => u.endsWith('/folio/~tog/api/schema'))).toBe(true)
    expect(asked.some((u) => u.endsWith('/folio/api/schema'))).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    })
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Tour')).toBeTruthy()
    expect(within(menu).queryByText('Safari')).toBeNull()
  })

  it('is the other brand’s on the other brand’s scope', async () => {
    serve({ schemaAt, registry: REGISTRY })
    await mountAt('/folio/~aaa/content', BRANDED)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    })
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Safari')).toBeTruthy()
    expect(within(menu).queryByText('Tour')).toBeNull()
  })

  it('groups the switcher by brand, with no Shared', async () => {
    serve({ schemaAt, registry: REGISTRY })
    await mountAt('/folio/~tog/content', BRANDED)
    const select = screen.getByLabelText('Site') as HTMLElement & { value: string }
    expect(
      Array.from(select.querySelectorAll('optgroup')).map((g) => g.getAttribute('label')),
    ).toEqual(['All About Africa', 'Take Off Go'])
    expect(select.value).toBe('tog')
    expect(within(select as HTMLElement).getByText('TOG · Take Off Go')).toBeTruthy()
  })

  it('draws stubs, not a crash, when the scoped manifest answers an error', async () => {
    serve({ schemaAt, registry: REGISTRY, schemaStatus: 404 })
    await mountAt('/folio/~tog/content', BRANDED)
    expect(screen.queryByText('Tour')).toBeNull()
    // The server's own sentence reaches the toast, and the shell is still mounted.
    expect(screen.getByText('No site')).toBeTruthy()
  })

  it('names the site in the tab title', async () => {
    serve({ schemaAt, registry: REGISTRY })
    await mountAt('/folio/~tog/content', BRANDED)
    expect(document.title).toBe('Content · TOG · Folio')
  })

  it('shows the brand on the Sites screen, and asks for it in the dialog', async () => {
    serve({ schemaAt, registry: REGISTRY })
    await mountAt('/folio/sites', BRANDED)
    const table = screen.getByRole('table', { name: 'Sites and groups' })
    expect(within(table).getByRole('columnheader', { name: 'Brand' })).toBeTruthy()
    expect(within(table).getByText('Take Off Go')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New site' }))
    })
    const dialog = screen.getByRole('dialog')
    const brand = within(dialog).getByLabelText(/Brand/)
    expect(Array.from(brand.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Choose a brand',
      'All About Africa',
      'Take Off Go',
    ])
  })

  it('draws the bare shell from the neutral manifest: no types, no page menu', async () => {
    serve({ schemaAt, registry: REGISTRY })
    await mountAt('/folio/sites', BRANDED)
    expect(screen.queryByText('Tour')).toBeNull()
    expect(screen.queryByText('Safari')).toBeNull()
  })
})
