import { describe, expect, it } from 'vitest'
import {
  candidate,
  chain,
  DEFAULT_SITE,
  gate,
  layerId,
  layerSeed,
  type Registry,
  SHARED_SCOPE,
  servingRegistry,
  type SiteRef,
  type SiteStatus,
  singletonTypeOf,
  sitesUnder,
} from '../../../src/core/sites'

/**
 * `core/sites.ts` (`docs/specs/foundation/multi-site.md` decisions 3, 4 and 8):
 * the chain, the reach of a scope, the layer ids, and the candidate and gate
 * steps that turn a URL into the site that serves it — every cell of decision 4's
 * table included — and the same questions on a registry with `brands`
 * (`docs/specs/foundation/multi-brand.md` decisions 4 and 5), where there is no
 * `shared` and a chain never leaves a brand.
 */

const site = (id: string, over: Partial<SiteRef> = {}): SiteRef => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  group: null,
  status: 'live',
  hosts: [],
  preview: null,
  brand: null,
  ...over,
})

const registry: Registry = {
  sites: [
    site('alpha', {
      group: 'north',
      hosts: ['alpha.example'],
      preview: 'https://preview.alpha.example',
    }),
    site('bravo', { hosts: ['bravo.example', 'www.bravo.example'] }),
    site('charlie', { group: 'north' }),
    site('default'),
    // A site whose group has since been removed from the registry.
    site('delta', { group: 'gone' }),
  ],
  groups: [
    { id: 'north', name: 'North', brand: null },
    { id: 'south', name: 'South', brand: null },
  ],
  shared: true,
}

describe('chain: the scopes a scope reads from, nearest first', () => {
  it('walks a site in a group up through the group to shared', () => {
    expect(chain(registry, 'alpha')).toEqual(['alpha', 'north', SHARED_SCOPE])
  })

  it('goes straight to shared for a site with no group', () => {
    expect(chain(registry, 'bravo')).toEqual(['bravo', SHARED_SCOPE])
  })

  it('walks a group to shared, and shared is its own whole chain', () => {
    expect(chain(registry, 'north')).toEqual(['north', SHARED_SCOPE])
    expect(chain(registry, SHARED_SCOPE)).toEqual([SHARED_SCOPE])
  })

  it('treats the migrated default row as the ordinary site it is', () => {
    expect(chain(registry, DEFAULT_SITE)).toEqual([DEFAULT_SITE, SHARED_SCOPE])
  })

  it('skips a group that no longer exists rather than failing', () => {
    expect(chain(registry, 'delta')).toEqual(['delta', SHARED_SCOPE])
  })

  it('is empty for a scope nobody registered, which reads as no content', () => {
    expect(chain(registry, 'zulu')).toEqual([])
    expect(chain(registry, '*')).toEqual([])
  })
})

describe('sitesUnder: the sites a scope reaches', () => {
  it('is a site itself', () => {
    expect(sitesUnder(registry, 'bravo')).toEqual(['bravo'])
  })

  it('is a group’s own sites, and nothing for an empty group', () => {
    expect(sitesUnder(registry, 'north')).toEqual(['alpha', 'charlie'])
    expect(sitesUnder(registry, 'south')).toEqual([])
  })

  it('is every site for shared', () => {
    expect(sitesUnder(registry, SHARED_SCOPE)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'default',
      'delta',
    ])
  })

  it('is nothing for an unknown scope', () => {
    expect(sitesUnder(registry, 'zulu')).toEqual([])
  })
})

describe('layerId and singletonTypeOf', () => {
  it('keeps the default layer at today’s singleton id', () => {
    expect(layerId('header', DEFAULT_SITE)).toBe('sng_header')
    expect(singletonTypeOf('sng_header')).toEqual({ type: 'header', scope: DEFAULT_SITE })
  })

  it('suffixes every other scope, and parses it back', () => {
    for (const scope of [SHARED_SCOPE, 'north', 'alpha']) {
      const id = layerId('siteSettings', scope)
      expect(id).toBe(`sng_siteSettings:${scope}`)
      expect(singletonTypeOf(id)).toEqual({ type: 'siteSettings', scope })
    }
  })

  it('answers null for an id that is not a singleton, or has an empty half', () => {
    expect(singletonTypeOf('sty_about')).toBeNull()
    expect(singletonTypeOf('sng_')).toBeNull()
    expect(singletonTypeOf('sng_:alpha')).toBeNull()
    expect(singletonTypeOf('sng_header:')).toBeNull()
  })
})

describe('layerSeed: only a layer with something below it starts bare', () => {
  it('seeds shared in full, and every site and group bare', () => {
    expect(layerSeed(registry, SHARED_SCOPE)).toBe('full')
    expect(layerSeed(registry, 'north')).toBe('bare')
    expect(layerSeed(registry, 'alpha')).toBe('bare')
    expect(layerSeed(registry, 'bravo')).toBe('bare')
  })
})

describe('candidate: the default step from a URL to a site', () => {
  it('answers the live surface for a live host, whatever its case or port', () => {
    expect(candidate(registry, new URL('https://ALPHA.example/about'))).toEqual({
      site: 'alpha',
      surface: 'live',
    })
    expect(candidate(registry, new URL('https://www.bravo.example:443/'))).toEqual({
      site: 'bravo',
      surface: 'live',
    })
  })

  it('answers the preview surface for a preview origin, compared as an origin', () => {
    expect(candidate(registry, new URL('https://Preview.Alpha.example:443/x?y=1'))).toEqual({
      site: 'alpha',
      surface: 'preview',
    })
  })

  it('does not take the preview origin for another scheme or port', () => {
    expect(candidate(registry, new URL('http://preview.alpha.example/'))).toBeNull()
    expect(candidate(registry, new URL('https://preview.alpha.example:8443/'))).toBeNull()
  })

  it('answers none for a host nobody registered', () => {
    expect(candidate(registry, new URL('https://elsewhere.example/'))).toBeNull()
  })
})

/**
 * Decision 4's table, every cell. The draft/preview cell is the only one with
 * conditions, and each condition is a separate case: without the pre-grant paths
 * nobody could ever preview a site before it launches.
 */
describe('gate: decision 4’s table, every cell', () => {
  const withStatus = (status: SiteStatus): Registry => ({
    sites: [
      site('gamma', { status, hosts: ['gamma.example'], preview: 'https://p.gamma.example' }),
    ],
    groups: [{ id: 'north', name: 'North', brand: null }],
    shared: true,
  })
  const anon = { path: null, grantFor: null }

  it('serves a live host only for a live site', () => {
    expect(gate(withStatus('draft'), { site: 'gamma', surface: 'live' }, anon)).toBeNull()
    expect(gate(withStatus('preview'), { site: 'gamma', surface: 'live' }, anon)).toBeNull()
    expect(gate(withStatus('live'), { site: 'gamma', surface: 'live' }, anon)?.id).toBe('gamma')
  })

  it('serves a preview origin to anyone once the site is preview or live', () => {
    expect(gate(withStatus('preview'), { site: 'gamma', surface: 'preview' }, anon)?.id).toBe(
      'gamma',
    )
    expect(gate(withStatus('live'), { site: 'gamma', surface: 'preview' }, anon)?.id).toBe('gamma')
  })

  it('refuses a draft site’s preview origin to an anonymous page request', () => {
    const r = withStatus('draft')
    expect(gate(r, { site: 'gamma', surface: 'preview' }, anon)).toBeNull()
    expect(gate(r, { site: 'gamma', surface: 'preview' }, { path: '/', grantFor: null })).toBeNull()
    expect(
      gate(r, { site: 'gamma', surface: 'preview' }, { path: '/api/v1/pages/x', grantFor: null }),
    ).toBeNull()
  })

  it('admits the pre-grant paths on a draft site’s preview origin', () => {
    const r = withStatus('draft')
    for (const path of ['/site/enter', '/draft/enter', '/draft/exit', '/share', '/asset/a/b.png']) {
      expect(gate(r, { site: 'gamma', surface: 'preview' }, { path, grantFor: null })?.id).toBe(
        'gamma',
      )
    }
    // Not on a live host: a pre-grant path is a preview-origin rule only.
    expect(
      gate(r, { site: 'gamma', surface: 'live' }, { path: '/site/enter', grantFor: null }),
    ).toBeNull()
  })

  it('admits a draft site’s preview origin for a grant on that site, and no other', () => {
    const r = withStatus('draft')
    expect(
      gate(r, { site: 'gamma', surface: 'preview' }, { path: '/', grantFor: 'gamma' })?.id,
    ).toBe('gamma')
    expect(
      gate(r, { site: 'gamma', surface: 'preview' }, { path: '/', grantFor: 'alpha' }),
    ).toBeNull()
  })

  it('never lets a group, shared or an unknown id serve, whatever chose it', () => {
    const r = withStatus('live')
    for (const id of ['north', SHARED_SCOPE, 'zulu', '*']) {
      expect(gate(r, { site: id, surface: 'live' }, anon)).toBeNull()
      expect(
        gate(r, { site: id, surface: 'preview' }, { path: '/site/enter', grantFor: id }),
      ).toBeNull()
    }
  })
})

/**
 * A registry with `brands` (`multi-brand.md` decisions 4 and 5): brand `aaa` has
 * group `north` holding `alpha`, and `bravo` with no group; brand `tgo` has
 * `tango`, and `mixed`, which names aaa's `north` — a row only SQL could write,
 * since the registry routes refuse it.
 */
const branded: Registry = {
  sites: [
    site('alpha', { group: 'north', brand: 'aaa' }),
    site('bravo', { brand: 'aaa' }),
    site('tango', { brand: 'tgo' }),
    site('mixed', { group: 'north', brand: 'tgo' }),
  ],
  groups: [{ id: 'north', name: 'North', brand: 'aaa' }],
  shared: false,
}

describe('with brands: a chain never leaves a brand, and there is no shared', () => {
  it('stops a site in a group at the group, and a site with no group at itself', () => {
    expect(chain(branded, 'alpha')).toEqual(['alpha', 'north'])
    expect(chain(branded, 'bravo')).toEqual(['bravo'])
    expect(chain(branded, 'north')).toEqual(['north'])
  })

  it('has no shared scope: its chain is empty, so ~shared is a 404', () => {
    expect(chain(branded, SHARED_SCOPE)).toEqual([])
    expect(sitesUnder(branded, SHARED_SCOPE)).toEqual([])
  })

  it('skips a group of another brand, as it skips one that has gone', () => {
    expect(chain(branded, 'mixed')).toEqual(['mixed'])
    expect(sitesUnder(branded, 'north')).toEqual(['alpha'])
  })

  it('seeds the bottom of every chain in full: a group, and a site with no group', () => {
    expect(layerSeed(branded, 'north')).toBe('full')
    expect(layerSeed(branded, 'bravo')).toBe('full')
    expect(layerSeed(branded, 'tango')).toBe('full')
    // Only a site with its group below it inherits.
    expect(layerSeed(branded, 'alpha')).toBe('bare')
  })

  it('leaves an unbranded registry exactly as it was', () => {
    expect(chain(registry, 'alpha')).toEqual(['alpha', 'north', SHARED_SCOPE])
    expect(layerSeed(registry, 'bravo')).toBe('bare')
    expect(sitesUnder(registry, SHARED_SCOPE)).toHaveLength(5)
  })
})

describe('servingRegistry: what a deployment with brands serves from', () => {
  const rows: Registry = {
    sites: [
      site('alpha', { group: 'north', brand: 'aaa' }),
      site('default'),
      site('ghost', { brand: 'retired' }),
      site('tango', { brand: 'tgo' }),
    ],
    groups: [
      { id: 'north', name: 'North', brand: 'aaa' },
      { id: 'orphans', name: 'Orphans', brand: null },
    ],
    shared: false,
  }
  const served = servingRegistry(rows, ['aaa', 'tgo'])

  it('keeps the rows of configured brands, and has no shared scope', () => {
    expect(served.sites.map((s) => s.id)).toEqual(['alpha', 'tango'])
    expect(served.groups.map((g) => g.id)).toEqual(['north'])
    expect(served.shared).toBe(false)
  })

  it('leaves out a null brand and an unconfigured one: no chain, no candidate', () => {
    for (const id of ['default', 'ghost', 'orphans']) expect(chain(served, id)).toEqual([])
    expect(gate(served, { site: 'default', surface: 'live' }, { path: null, grantFor: null })).toBe(
      null,
    )
  })

  it('is neither the first brand nor every brand for a null row', () => {
    expect(served.sites.some((s) => s.brand === null)).toBe(false)
    expect(sitesUnder(served, 'north')).toEqual(['alpha'])
  })
})
