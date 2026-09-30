import { describe, expect, it } from 'vitest'
import type { Registry } from '../../../src/core/sites'
import { meSites } from '../../../src/server/auth/me-sites'

/**
 * What `GET {base}/api/me` says about many sites, by the server's own functions.
 * The route is thin (`workers/me-sites.test.ts` reads it through `handle()`); the
 * answers are decided here.
 */

const REGISTRY: Registry = {
  groups: [{ id: 'north', name: 'North', brand: null }],
  sites: [
    {
      id: 'alpha',
      name: 'Alpha',
      group: 'north',
      status: 'live',
      hosts: [],
      preview: 'https://p.alpha.example',
      brand: null,
    },
    {
      id: 'bravo',
      name: 'Bravo',
      group: null,
      status: 'draft',
      hosts: [],
      preview: null,
      brand: null,
    },
  ],
  shared: true,
}

const ids = (scopes: { id: string }[]) => scopes.map((s) => s.id)

describe('meSites', () => {
  it('gives a platform admin every scope as admin, and every site to preview', () => {
    const me = meSites(REGISTRY, { '*': 'admin' }, 'siteSettings')
    expect(me.platform).toBe(true)
    expect(ids(me.scopes)).toEqual(['shared', 'north', 'alpha', 'bravo'])
    expect(me.scopes.every((s) => s.role === 'admin')).toBe(true)
    expect(ids(me.previewable)).toEqual(['alpha', 'bravo'])
    expect(me.settings).toBe('siteSettings')
    expect(me.grants).toEqual({ '*': 'admin' })
  })

  it('is platform only for an admin on `*`, never for an admin of a site', () => {
    expect(meSites(REGISTRY, { alpha: 'admin' }, undefined).platform).toBe(false)
    expect(meSites(REGISTRY, { '*': 'publisher' }, undefined).platform).toBe(false)
  })

  it('reads a site role up the chain as viewer, and writes only its own scope', () => {
    const me = meSites(REGISTRY, { alpha: 'editor' }, undefined)
    expect(me.scopes.map((s) => [s.id, s.role])).toEqual([
      ['shared', 'viewer'],
      ['north', 'viewer'],
      ['alpha', 'editor'],
    ])
    expect(me.scopes.find((s) => s.id === 'alpha')?.chain).toEqual(['alpha', 'north', 'shared'])
  })

  it('lets a group role write every site in the group', () => {
    const me = meSites(REGISTRY, { north: 'publisher' }, undefined)
    expect(me.scopes.find((s) => s.id === 'alpha')?.role).toBe('publisher')
    expect(ids(me.scopes)).not.toContain('bravo')
  })

  it('previews every site from a shared-only role, and carries each site’s chain', () => {
    const me = meSites(REGISTRY, { shared: 'viewer' }, undefined)
    expect(ids(me.scopes)).toEqual(['shared'])
    expect(me.previewable.map((s) => [s.id, s.chain])).toEqual([
      ['alpha', ['alpha', 'north', 'shared']],
      ['bravo', ['bravo', 'shared']],
    ])
  })

  it('previews nothing for a person with no grant that reaches a site', () => {
    expect(meSites(REGISTRY, {}, undefined).previewable).toEqual([])
    expect(ids(meSites(REGISTRY, { ghost: 'admin' }, undefined).scopes)).toEqual([])
  })

  it('carries a site’s status and preview origin, and none for a group or shared', () => {
    const me = meSites(REGISTRY, { '*': 'viewer' }, undefined)
    expect(me.scopes.find((s) => s.id === 'alpha')).toMatchObject({
      kind: 'site',
      status: 'live',
      preview: 'https://p.alpha.example',
      group: 'north',
    })
    expect(me.scopes.find((s) => s.id === 'north')).toMatchObject({ kind: 'group', status: null })
    expect(me.scopes.find((s) => s.id === 'shared')).toMatchObject({
      kind: 'shared',
      name: 'Shared',
    })
    expect(me.settings).toBeNull()
  })

  it('is admin on everything, and the platform, under auth: open', () => {
    const me = meSites(REGISTRY, null, undefined)
    expect(me.platform).toBe(true)
    expect(me.scopes.every((s) => s.role === 'admin')).toBe(true)
    expect(ids(me.previewable)).toEqual(['alpha', 'bravo'])
    expect(me.grants).toEqual({})
  })
})

describe('meSites on a deployment with brands', () => {
  // `multi-brand.md` decision 5: no `shared` scope, so none is offered, even to a
  // platform admin or under `auth: 'open'`, for whom every scope reads as `admin`.
  const BRANDED: Registry = {
    groups: [{ id: 'north', name: 'North', brand: 'aaa' }],
    sites: [
      {
        id: 'alpha',
        name: 'Alpha',
        group: 'north',
        status: 'live',
        hosts: [],
        preview: null,
        brand: 'aaa',
      },
    ],
    shared: false,
  }

  it('offers no shared scope, to a platform admin or under open auth', () => {
    expect(ids(meSites(BRANDED, { '*': 'admin' }, undefined).scopes)).toEqual(['north', 'alpha'])
    expect(ids(meSites(BRANDED, null, undefined).scopes)).toEqual(['north', 'alpha'])
  })

  it('still offers shared on a registry that has it', () => {
    expect(ids(meSites(REGISTRY, { '*': 'admin' }, undefined).scopes)).toContain('shared')
  })
})
