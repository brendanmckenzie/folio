import { describe, expect, it } from 'vitest'
import type { Registry, SiteRef } from '../../../src/core/sites'
import { FolioError } from '../../../src/server/errors'
import {
  assertAbsoluteRoute,
  assertUnclaimed,
  normaliseHost,
  normalisePreviewOrigin,
  type ResolvedSites,
  readRegistry,
  registrySnapshot,
  routeRequest,
  SNAPSHOT_TTL_MS,
  validateSiteId,
} from '../../../src/server/sites'

/**
 * `server/sites.ts` (`docs/specs/foundation/multi-site.md` decisions 1 and 4): the
 * registry read on the primary, the ten-second snapshot and its write-side drop,
 * the admin origin ahead of every candidate, and every write-time validation and
 * normalisation.
 */

const site = (id: string, over: Partial<SiteRef> = {}): SiteRef => ({
  id,
  name: id,
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
    site('gamma', {
      status: 'draft',
      hosts: ['gamma.example'],
      preview: 'https://p.gamma.example',
    }),
  ],
  groups: [{ id: 'north', name: 'North', brand: null }],
  shared: true,
}

const sites: ResolvedSites = {
  admin: 'https://cms.example',
  adminHost: 'cms.example',
  settings: undefined,
  resolve: undefined,
}

/* ---------------------------------------------------------- the read --- */

/**
 * A fake binding recording which constraint every session opened with and what
 * each statement said: enough to see that the registry is read on the primary
 * and never straight on the binding.
 */
function fakeD1(rows: { sites: unknown[]; hosts: unknown[] }) {
  const constraints: string[] = []
  let straight = 0
  const statement = (sql: string) => ({ sql })
  const session = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: { sql: string }[]) =>
      stmts.map((s) => ({ results: s.sql.includes('site_hosts') ? rows.hosts : rows.sites })),
  }
  const db = {
    withSession: (constraint: string) => {
      constraints.push(constraint)
      return session
    },
    prepare: (sql: string) => {
      straight++
      return statement(sql)
    },
    batch: async () => {
      straight++
      return []
    },
  } as unknown as D1Database
  return { db, constraints, straight: () => straight }
}

describe('readRegistry', () => {
  it('reads on a first-primary session, so a lagging replica cannot hand back an old registry', async () => {
    const fake = fakeD1({ sites: [], hosts: [] })
    await readRegistry(fake.db)
    expect(fake.constraints).toEqual(['first-primary'])
    expect(fake.straight()).toBe(0)
  })

  it('splits sites from groups and hangs every host on its site', async () => {
    const fake = fakeD1({
      sites: [
        {
          id: 'alpha',
          kind: 'site',
          name: 'Alpha',
          group_id: 'north',
          status: 'live',
          preview_origin: 'https://preview.alpha.example',
          brand: 'aaa',
        },
        {
          id: 'north',
          kind: 'group',
          name: 'North',
          group_id: null,
          status: null,
          preview_origin: null,
          brand: 'aaa',
        },
        {
          id: 'odd',
          kind: 'site',
          name: 'Odd',
          group_id: null,
          status: null,
          preview_origin: null,
          brand: null,
        },
      ],
      hosts: [
        { host: 'alpha.example', site_id: 'alpha' },
        { host: 'www.alpha.example', site_id: 'alpha' },
      ],
    })
    expect(await readRegistry(fake.db)).toEqual({
      sites: [
        {
          id: 'alpha',
          name: 'Alpha',
          group: 'north',
          status: 'live',
          hosts: ['alpha.example', 'www.alpha.example'],
          preview: 'https://preview.alpha.example',
          brand: 'aaa',
        },
        // A site row with no status reads as the most closed state, never as live.
        {
          id: 'odd',
          name: 'Odd',
          group: null,
          status: 'draft',
          hosts: [],
          preview: null,
          brand: null,
        },
      ],
      groups: [{ id: 'north', name: 'North', brand: 'aaa' }],
      shared: true,
    })
  })

  it('reads every row whatever its brand, with no shared scope on a branded deployment', async () => {
    // The snapshot filters (`servingRegistry`); the read does not, because a write
    // validates against every row and `GET /api/sites` lists them.
    const fake = fakeD1({
      sites: [
        {
          id: 'odd',
          kind: 'site',
          name: 'Odd',
          group_id: null,
          status: 'live',
          preview_origin: null,
          brand: null,
        },
      ],
      hosts: [],
    })
    const read = await readRegistry(fake.db, { branded: true })
    expect(read.shared).toBe(false)
    expect(read.sites.map((s) => [s.id, s.brand])).toEqual([['odd', null]])
  })
})

/* ------------------------------------------------------- the snapshot --- */

describe('registrySnapshot', () => {
  const counting = () => {
    let reads = 0
    let resolveNext: ((r: Registry) => void) | null = null
    return {
      read: (_db: D1Database) => {
        reads++
        return new Promise<Registry>((resolve) => {
          resolveNext = resolve
        })
      },
      settle: (r: Registry) => resolveNext?.(r),
      reads: () => reads,
    }
  }
  const db = {} as D1Database

  it('holds a registry for ten seconds and re-reads on the first request after', async () => {
    let clock = 1_000
    let reads = 0
    const snap = registrySnapshot({
      now: () => clock,
      read: async () => {
        reads++
        return registry
      },
    })
    await snap.get(db)
    clock += SNAPSHOT_TTL_MS - 1
    await snap.get(db)
    expect(reads).toBe(1)
    clock += 1
    await snap.get(db)
    expect(reads).toBe(2)
  })

  it('drops at once for the isolate that wrote', async () => {
    let reads = 0
    const snap = registrySnapshot({
      now: () => 0,
      read: async () => {
        reads++
        return registry
      },
    })
    await snap.get(db)
    snap.drop()
    await snap.get(db)
    expect(reads).toBe(2)
  })

  it('gives each concurrent request its own read and its own promise', async () => {
    let reads = 0
    const snap = registrySnapshot({
      now: () => 0,
      read: async () => {
        reads++
        return registry
      },
    })
    const a = snap.get(db)
    const b = snap.get(db)
    // No promise is handed to two requests: each belongs to the one that asked.
    expect(a).not.toBe(b)
    expect(await a).toBe(registry)
    expect(await b).toBe(registry)
    expect(reads).toBe(2)
  })

  it('reuses a settled registry within the ttl', async () => {
    let reads = 0
    const snap = registrySnapshot({
      now: () => 0,
      read: async () => {
        reads++
        return registry
      },
    })
    await Promise.all([snap.get(db), snap.get(db)])
    expect(reads).toBe(2)
    await snap.get(db)
    await snap.get(db)
    expect(reads).toBe(2)
  })

  it('does not keep a read that was in flight when a write dropped the snapshot', async () => {
    const c = counting()
    const snap = registrySnapshot({ now: () => 0, read: c.read })
    const stale = snap.get(db)
    snap.drop()
    c.settle(registry)
    // The read still answers the request that issued it.
    expect(await stale).toBe(registry)
    // The read that predates the write is not held: the next request reads again.
    const next = snap.get(db)
    c.settle(registry)
    await next
    expect(c.reads()).toBe(2)
  })

  it('does not hold a failed read', async () => {
    let fail = true
    const snap = registrySnapshot({
      now: () => 0,
      read: async () => {
        if (fail) throw new Error('d1 down')
        return registry
      },
    })
    await expect(snap.get(db)).rejects.toThrow('d1 down')
    fail = false
    await expect(snap.get(db)).resolves.toBe(registry)
  })
})

/* ------------------------------------------------------------ routing --- */

describe('routeRequest', () => {
  const at = (url: string) => new Request(url)
  const anon = { path: null, grantFor: null }

  it('answers the admin origin before any candidate, whatever a row claims', () => {
    // A row that holds the admin's own host as its preview origin, which the
    // write path refuses and SQL can still produce.
    const claimed: Registry = {
      ...registry,
      sites: [
        ...registry.sites,
        site('hotel', { preview: 'https://cms.example', hosts: ['cms.example'] }),
      ],
    }
    expect(routeRequest(sites, claimed, at('https://cms.example/folio/edit'), anon)).toEqual({
      kind: 'admin',
    })
  })

  it('routes a live host and a preview origin to their site and surface', () => {
    expect(routeRequest(sites, registry, at('https://alpha.example/about'), anon)).toMatchObject({
      kind: 'site',
      site: { id: 'alpha' },
      surface: 'live',
    })
    expect(
      routeRequest(sites, registry, at('https://preview.alpha.example/about'), anon),
    ).toMatchObject({ kind: 'site', site: { id: 'alpha' }, surface: 'preview' })
  })

  it('answers none for an unregistered host and for a draft site on both faces', () => {
    expect(routeRequest(sites, registry, at('https://nobody.example/'), anon)).toEqual({
      kind: 'none',
    })
    expect(routeRequest(sites, registry, at('https://gamma.example/'), anon)).toEqual({
      kind: 'none',
    })
    expect(routeRequest(sites, registry, at('https://p.gamma.example/'), anon)).toEqual({
      kind: 'none',
    })
  })

  it('still gates what a custom resolver chooses: a group or a draft site is no site', () => {
    for (const answer of ['north', 'gamma', 'shared', 'nobody']) {
      const custom: ResolvedSites = { ...sites, resolve: () => answer }
      expect(routeRequest(custom, registry, at('https://alpha.example/'), anon)).toEqual({
        kind: 'none',
      })
    }
    const toAlpha: ResolvedSites = { ...sites, resolve: () => 'alpha' }
    expect(routeRequest(toAlpha, registry, at('https://anything.example/'), anon)).toMatchObject({
      kind: 'site',
      site: { id: 'alpha' },
      surface: 'live',
    })
    // The surface is still the URL's: a resolver cannot move a preview origin.
    expect(
      routeRequest(toAlpha, registry, at('https://preview.alpha.example/'), anon),
    ).toMatchObject({ surface: 'preview' })
    // And a resolver cannot take the admin origin either.
    expect(routeRequest(toAlpha, registry, at('https://cms.example/'), anon)).toEqual({
      kind: 'admin',
    })
  })
})

/* ---------------------------------------------- write-time validation --- */

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof FolioError ? `${err.status} ${err.message}` : String(err)
  }
  return 'accepted'
}

describe('validateSiteId', () => {
  it('accepts lowercase letters, digits and inner hyphens, up to 32', () => {
    for (const id of ['a', 'alpha', 'north-east', 'site2', 'a'.repeat(32)]) {
      expect(validateSiteId(id)).toBe(id)
    }
  })

  it('refuses anything else', () => {
    for (const id of ['', 'Alpha', '-a', 'a-', 'a_b', 'a.b', 'a:b', 'a'.repeat(33), 42]) {
      expect(refusal(() => validateSiteId(id))).toMatch(/^400 id must be/)
    }
  })

  it('refuses the three reserved ids', () => {
    expect(refusal(() => validateSiteId('shared'))).toBe("400 'shared' is reserved")
    expect(refusal(() => validateSiteId('default'))).toBe("400 'default' is reserved")
    expect(refusal(() => validateSiteId('*'))).toMatch(/^400/)
  })
})

describe('normaliseHost', () => {
  it('lowercases and drops a port and a trailing dot', () => {
    expect(normaliseHost('P.EXAMPLE')).toBe('p.example')
    expect(normaliseHost('p.example:8443')).toBe('p.example')
    expect(normaliseHost('p.example.')).toBe('p.example')
    expect(normaliseHost('  www.Alpha.example ')).toBe('www.alpha.example')
  })

  it('refuses a URL, a path or credentials rather than trimming them away', () => {
    for (const raw of ['https://p.example', 'p.example/about', 'u@p.example', 'p example', '']) {
      expect(refusal(() => normaliseHost(raw))).toMatch(/^400/)
    }
  })
})

describe('normalisePreviewOrigin', () => {
  it('stores the origin: lowercase, no default port, no path', () => {
    expect(normalisePreviewOrigin('https://P.Example:443')).toBe('https://p.example')
    expect(normalisePreviewOrigin('https://p.example:8443/some/path?x')).toBe(
      'https://p.example:8443',
    )
  })

  it('allows http only on localhost and *.localhost', () => {
    expect(normalisePreviewOrigin('http://preview.localhost:5199')).toBe(
      'http://preview.localhost:5199',
    )
    expect(normalisePreviewOrigin('http://localhost:5199')).toBe('http://localhost:5199')
    expect(refusal(() => normalisePreviewOrigin('http://p.example'))).toMatch(
      /^400 A preview origin/,
    )
    expect(refusal(() => normalisePreviewOrigin('ftp://p.example'))).toMatch(/^400/)
    expect(refusal(() => normalisePreviewOrigin('p.example'))).toMatch(/^400/)
  })
})

describe('assertUnclaimed: every hostname is unique across both columns', () => {
  it('refuses a live host that is another site’s preview origin, by hostname', () => {
    const r: Registry = {
      sites: [site('one', { preview: normalisePreviewOrigin('https://p.example:443') })],
      groups: [],
      shared: true,
    }
    expect(
      refusal(() =>
        assertUnclaimed(r, 'cms.example', { site: 'two', hosts: [normaliseHost('P.EXAMPLE')] }),
      ),
    ).toBe("409 p.example is already claimed by site 'one's preview origin")
  })

  it('refuses a preview origin whose host is another site’s live host', () => {
    const r: Registry = {
      sites: [site('one', { hosts: ['p.example'] })],
      groups: [],
      shared: true,
    }
    expect(
      refusal(() =>
        assertUnclaimed(r, 'cms.example', { site: 'two', preview: 'https://p.example' }),
      ),
    ).toBe("409 p.example is already claimed by site 'one'")
  })

  it('refuses a second site’s live host, and a second site’s preview origin', () => {
    const r: Registry = {
      sites: [site('one', { hosts: ['one.example'], preview: 'https://p1.example' })],
      groups: [],
      shared: true,
    }
    expect(
      refusal(() => assertUnclaimed(r, 'cms.example', { site: 'two', hosts: ['one.example'] })),
    ).toMatch(/^409 one.example/)
    expect(
      refusal(() =>
        assertUnclaimed(r, 'cms.example', { site: 'two', preview: 'https://p1.example' }),
      ),
    ).toMatch(/^409 p1.example/)
  })

  it('refuses the admin origin’s host on either column', () => {
    expect(
      refusal(() =>
        assertUnclaimed(registry, 'cms.example', { site: 'two', hosts: ['cms.example'] }),
      ),
    ).toBe('409 cms.example is already claimed by the admin origin')
    expect(
      refusal(() =>
        assertUnclaimed(registry, 'cms.example', { site: 'two', preview: 'https://cms.example' }),
      ),
    ).toBe('409 cms.example is already claimed by the admin origin')
  })

  it('refuses a site claiming its own preview host as a live host', () => {
    expect(
      refusal(() =>
        assertUnclaimed(registry, 'cms.example', {
          site: 'alpha',
          hosts: ['preview.alpha.example'],
        }),
      ),
    ).toMatch(/^409 preview.alpha.example is already claimed by this site/)
  })

  it('lets a site keep what it already holds', () => {
    expect(
      refusal(() =>
        assertUnclaimed(registry, 'cms.example', {
          site: 'alpha',
          hosts: ['alpha.example', 'www.alpha.example'],
          preview: 'https://preview.alpha.example',
        }),
      ),
    ).toBe('accepted')
  })
})

describe('assertAbsoluteRoute', () => {
  it('requires route("", undefined, site) to be an absolute URL', () => {
    const s = site('alpha', { hosts: ['alpha.example'] })
    expect(refusal(() => assertAbsoluteRoute((p, _l, t) => `https://${t?.hosts[0]}/${p}`, s))).toBe(
      'accepted',
    )
    expect(refusal(() => assertAbsoluteRoute((p) => `/${p}`, s))).toMatch(/^400 route/)
    expect(
      refusal(() =>
        assertAbsoluteRoute(() => {
          throw new Error('no host')
        }, s),
      ),
    ).toMatch(/^400 route/)
  })
})
