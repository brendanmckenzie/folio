/**
 * Sites, groups and the shared scope, as pure functions over a registry
 * snapshot (`../../docs/specs/foundation/multi-site.md` decisions 3 and 4, and
 * `multi-brand.md` decisions 4 and 5 for a deployment with `brands`).
 *
 * Nothing here reads D1 or knows about a `Request` beyond its URL: the snapshot
 * is read and cached in `server/sites.ts`, and every question a render or a route
 * asks of it — which scopes a site reads from, which sites a scope's content
 * reaches, which site a URL belongs to and whether that site serves it — is
 * answered here, so the admin, the server and a test all get one answer.
 *
 * **A deployment with no `sites` never builds a registry at all.** Its one scope
 * is `default` and its chain is `SINGLE_SITE_CHAIN`, a constant: no read, no
 * snapshot, no candidate step. Everything below is multi-site only.
 */
import { SINGLETON_PREFIX } from './schema'

/** The scope above every site and group: default pages, a shared catalogue, the
 * base layer of every global. Reserved; never a registry row. Absent on a
 * deployment with `brands` (`Registry.shared`). */
export const SHARED_SCOPE = 'shared'

/**
 * The implicit site of a deployment with no `sites`, and the scope every row that
 * existed before `0011_sites.sql` was backfilled into. On a multi-site deployment
 * it is an ordinary site row — the migration inserts it `live` — so an existing
 * deployment that turns multi-site on finds its content under a site it can give
 * hostnames to.
 */
export const DEFAULT_SITE = 'default'

/** "Every scope", in a grant. Never a content scope. */
export const ALL_SCOPES = '*'

/**
 * The chain of a deployment with no `sites`: one scope, no registry.
 *
 * A constant rather than `chain(registry, DEFAULT_SITE)`, because there is no
 * registry to ask and asking would be a read on every request of a host that
 * never opted in. Every chain-taking reader binds it, single-site included:
 * `site_id` leads every index `0011` re-keyed, so a lookup that leaves it out is a
 * table scan rather than a seek.
 */
export const SINGLE_SITE_CHAIN: readonly string[] = [DEFAULT_SITE]

export type SiteStatus = 'draft' | 'preview' | 'live'

/** Which of a site's two faces a request arrived on. */
export type Surface = 'live' | 'preview'

export interface SiteRef {
  id: string
  name: string
  /** The group this site belongs to, or null. One group per site, one level. */
  group: string | null
  status: SiteStatus
  /** Live hostnames, lowercased, without a port. */
  hosts: readonly string[]
  /** The preview origin (`new URL(x).origin`), or null when none is set. */
  preview: string | null
  /**
   * The brand this site belongs to (`multi-brand.md` decision 4), or null. Null on
   * every row of a deployment with no `brands`, where nothing reads it; on one with
   * `brands` a row whose brand is null or not configured is left out of the
   * snapshot, so it serves nothing.
   */
  brand: string | null
}

export interface GroupRef {
  id: string
  name: string
  /** As `SiteRef.brand`. A group and its sites have one brand. */
  brand: string | null
}

/** `sites` and `site_hosts`, as one isolate's snapshot of them. */
export interface Registry {
  sites: readonly SiteRef[]
  groups: readonly GroupRef[]
  /**
   * Whether the `shared` scope exists (`multi-brand.md` decision 5): true on every
   * deployment with no `brands`, false on one with them, where a chain never
   * leaves a brand and so has nothing above a group. `chain`, `sitesUnder` and
   * `layerSeed` read it.
   */
  shared: boolean
}

export const EMPTY_REGISTRY: Registry = { sites: [], groups: [], shared: true }

/**
 * The rendering site, as it rides on a `Resolution` (`multi-site.md` decision 15).
 *
 * `chain` and `layered` are here, rather than recomputed from the registry by
 * whoever reads the resolution, so `cacheTags(resolution, opts)` keeps its
 * signature and a host calling `folio.cacheHeaders(resolution, { story })`
 * directly gets every tag a multi-site render needs — including the layer tags of
 * layers that do not exist yet.
 */
export interface SiteContext {
  id: string
  name: string
  group: string | null
  status: SiteStatus
  surface: Surface
  /** `chain(registry, id)`, nearest first. */
  chain: readonly string[]
  /** The configured globals and the settings type: the documents that layer. */
  layered: readonly string[]
  /**
   * The site's brand (`multi-brand.md` decision 21): what `folio.render` and
   * `renderGlobal` pick a registry by. **Present only on a deployment with
   * `brands`**, so a single-brand resolution serialises byte for byte as it did
   * before brands (`multi-site-pin.test.ts`).
   */
  brand?: string
}

const siteOf = (registry: Registry, id: string) => registry.sites.find((s) => s.id === id)
const groupOf = (registry: Registry, id: string) => registry.groups.find((g) => g.id === id)

/**
 * The scopes a scope reads from, nearest first (decision 3's table).
 *
 * | Scope | Chain | Chain with `brands` |
 * | --- | --- | --- |
 * | site `alpha` in group `north` | `alpha`, `north`, `shared` | `alpha`, `north` |
 * | site `bravo`, no group | `bravo`, `shared` | `bravo` |
 * | group `north` | `north`, `shared` | `north` |
 * | `shared` | `shared` | none |
 *
 * **An unknown scope has an empty chain**, and every chain-taking reader answers
 * an empty chain with nothing: a scope that is not in the registry owns no
 * content anyone can see, which is decision 4's "a reader answers as a site with
 * no content". A site naming a group that has since gone skips it rather than
 * failing, for the same reason a grant naming a deleted scope is ignored.
 *
 * **A chain never crosses a brand** (`multi-brand.md` decision 5). On a registry
 * with no `shared` the chain stops at the group, so `~shared` is empty — a 404 at
 * `withScope`, and nothing can be written there — and a site whose group carries
 * another brand skips the group exactly as it skips one that has gone. The
 * registry routes refuse to write that pairing; this is the fence for a row
 * written by SQL.
 */
export function chain(registry: Registry, scope: string): readonly string[] {
  const top = registry.shared ? [SHARED_SCOPE] : []
  if (scope === SHARED_SCOPE) return top
  const site = siteOf(registry, scope)
  if (site) {
    const group = site.group ? groupOf(registry, site.group) : undefined
    return group && sameBrand(registry, site, group)
      ? [site.id, group.id, ...top]
      : [site.id, ...top]
  }
  if (groupOf(registry, scope)) return [scope, ...top]
  return []
}

/** Whether a site may read its group: always with no `brands`, else only within one brand. */
const sameBrand = (registry: Registry, site: SiteRef, group: GroupRef) =>
  registry.shared || site.brand === group.brand

/**
 * The sites a scope's content reaches: a site is itself, a group its sites, and
 * `shared` every site. What a purge fans out over (`path:<site>:<path>` per site)
 * and what a share's render site must be one of. Unknown is none, and so is
 * `shared` on a registry without it; a group reaches only the sites whose chain
 * holds it.
 */
export function sitesUnder(registry: Registry, scope: string): readonly string[] {
  if (scope === SHARED_SCOPE) return registry.shared ? registry.sites.map((s) => s.id) : []
  if (siteOf(registry, scope)) return [scope]
  const group = groupOf(registry, scope)
  if (group) {
    return registry.sites
      .filter((s) => s.group === scope && sameBrand(registry, s, group))
      .map((s) => s.id)
  }
  return []
}

/**
 * The registry a deployment with `brands` serves from (`multi-brand.md` decision
 * 4): every row whose brand is one of `brands`, and `shared: false`. **A row whose
 * brand is null or not configured is left out**, so it is no candidate, has an
 * empty chain and answers `404 No site or group` at every `~<scope>` — the same
 * fence as an unknown scope. It is neither the first brand nor every brand.
 *
 * Only the snapshot is filtered. A registry write validates against every row —
 * a host an unbranded row holds is still claimed — and `GET {base}/api/sites`
 * lists them, so a platform admin can see what to repair.
 */
export function servingRegistry(registry: Registry, brands: readonly string[]): Registry {
  const known = (brand: string | null) => brand !== null && brands.includes(brand)
  return {
    sites: registry.sites.filter((s) => known(s.brand)),
    groups: registry.groups.filter((g) => known(g.brand)),
    shared: false,
  }
}

/**
 * A global's layer document for one scope (decision 8): `sng_<type>` for
 * `default`, so every singleton id that existed before multi-site is untouched,
 * and `sng_<type>:<scope>` for every other scope.
 *
 * The colon is safe as a separator because `validateTypes` refuses one in a type
 * name, and a story id allows it (`validate.ts`'s `ID`).
 */
export function layerId(type: string, scope: string): string {
  return scope === DEFAULT_SITE
    ? `${SINGLETON_PREFIX}${type}`
    : `${SINGLETON_PREFIX}${type}:${scope}`
}

/** `layerId`, inverted. Null for anything that is not a singleton id. */
export function singletonTypeOf(id: string): { type: string; scope: string } | null {
  if (!id.startsWith(SINGLETON_PREFIX)) return null
  const rest = id.slice(SINGLETON_PREFIX.length)
  const at = rest.indexOf(':')
  if (at === -1) return rest ? { type: rest, scope: DEFAULT_SITE } : null
  const type = rest.slice(0, at)
  const scope = rest.slice(at + 1)
  return type && scope ? { type, scope } : null
}

/**
 * How a new layer document starts (decision 8): `'bare'` — a root with `data: {}`,
 * so every field is inherited — only when there is a layer below it to inherit
 * from. The bottom of a chain seeds exactly as a single-site singleton does,
 * defaults and preset included, so a host's declared defaults are what every
 * site inherits. The test is the chain, not the id: with `brands` the bottom is a
 * group, or a site with no group, which therefore seeds `'full'`
 * (`multi-brand.md` decision 5).
 */
export function layerSeed(registry: Registry, scope: string): 'bare' | 'full' {
  return chain(registry, scope).length > 1 ? 'bare' : 'full'
}

/**
 * The default candidate step (decision 4, step 1): the site whose live host this
 * URL's host is, or the site whose preview origin this URL's origin is, or none.
 *
 * `URL` has already lowercased the host and dropped a default port, which is the
 * normalisation the registry stores (`server/sites.ts`), so the comparison is a
 * plain equality. A custom `sites.resolve` replaces this step and nothing else:
 * whatever it answers still goes through `gate`.
 */
export function candidate(registry: Registry, url: URL): { site: string; surface: Surface } | null {
  const host = url.hostname.toLowerCase()
  const live = registry.sites.find((s) => s.hosts.includes(host))
  if (live) return { site: live.id, surface: 'live' }
  const preview = registry.sites.find((s) => s.preview !== null && s.preview === url.origin)
  if (preview) return { site: preview.id, surface: 'preview' }
  return null
}

/**
 * The paths under `{base}` a draft site's preview origin answers before anybody
 * holds a grant for it (decision 4's table): the handoff that mints the grant,
 * draft mode's switch, a share link, and an asset's bytes. Without them nobody
 * could ever preview a site that is not yet public.
 */
const BEFORE_GRANT = ['/site/enter', '/draft/enter', '/draft/exit', '/share']

function admittedBeforeGrant(path: string): boolean {
  return BEFORE_GRANT.includes(path) || path.startsWith('/asset/')
}

/**
 * The status gate (decision 4, step 2), and it is always Folio's.
 *
 * | Surface | `draft` | `preview` | `live` |
 * | --- | --- | --- | --- |
 * | `live` host | no site | no site | the site |
 * | `preview` origin | the site only for a pre-grant path, or a grant (or share) for it | the site | the site |
 *
 * **A candidate that is not a `kind = 'site'` row is no site** — a group,
 * `shared`, `default` on a deployment whose registry has no such row, or an id
 * nobody registered. `registry.sites` holds only site rows by construction, so
 * the lookup is the check; a custom `sites.resolve` answering `'north'` cannot
 * make a group serve.
 *
 * `req.path` is the request's path below `{base}` (`'/site/enter'`), or null for a
 * request outside it. `req.grantFor` is the site a grant or share cookie on the
 * request verified for, which is a D1 read the caller makes after this
 * synchronous step and never inside a custom resolver.
 */
export function gate(
  registry: Registry,
  c: { site: string; surface: Surface },
  req: { path: string | null; grantFor: string | null },
): SiteRef | null {
  const site = siteOf(registry, c.site)
  if (!site) return null
  if (c.surface === 'live') return site.status === 'live' ? site : null
  if (site.status !== 'draft') return site
  if (req.grantFor === site.id) return site
  if (req.path !== null && admittedBeforeGrant(req.path)) return site
  return null
}
