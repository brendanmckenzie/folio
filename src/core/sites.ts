/**
 * Sites, groups and the shared scope, as pure functions over a registry
 * snapshot (`../../docs/specs/foundation/multi-site.md` decisions 3 and 4).
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
 * base layer of every global. Reserved; never a registry row. */
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
}

export interface GroupRef {
  id: string
  name: string
}

/** `sites` and `site_hosts`, as one isolate's snapshot of them. */
export interface Registry {
  sites: readonly SiteRef[]
  groups: readonly GroupRef[]
}

export const EMPTY_REGISTRY: Registry = { sites: [], groups: [] }

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
}

const siteOf = (registry: Registry, id: string) => registry.sites.find((s) => s.id === id)
const groupOf = (registry: Registry, id: string) => registry.groups.find((g) => g.id === id)

/**
 * The scopes a scope reads from, nearest first (decision 3's table).
 *
 * | Scope | Chain |
 * | --- | --- |
 * | site `alpha` in group `north` | `alpha`, `north`, `shared` |
 * | site `bravo`, no group | `bravo`, `shared` |
 * | group `north` | `north`, `shared` |
 * | `shared` | `shared` |
 *
 * **An unknown scope has an empty chain**, and every chain-taking reader answers
 * an empty chain with nothing: a scope that is not in the registry owns no
 * content anyone can see, which is decision 4's "a reader answers as a site with
 * no content". A site naming a group that has since gone skips it rather than
 * failing, for the same reason a grant naming a deleted scope is ignored.
 */
export function chain(registry: Registry, scope: string): readonly string[] {
  if (scope === SHARED_SCOPE) return [SHARED_SCOPE]
  const site = siteOf(registry, scope)
  if (site) {
    return site.group && groupOf(registry, site.group)
      ? [site.id, site.group, SHARED_SCOPE]
      : [site.id, SHARED_SCOPE]
  }
  if (groupOf(registry, scope)) return [scope, SHARED_SCOPE]
  return []
}

/**
 * The sites a scope's content reaches: a site is itself, a group its sites, and
 * `shared` every site. What a purge fans out over (`path:<site>:<path>` per site)
 * and what a share's render site must be one of. Unknown is none.
 */
export function sitesUnder(registry: Registry, scope: string): readonly string[] {
  if (scope === SHARED_SCOPE) return registry.sites.map((s) => s.id)
  if (siteOf(registry, scope)) return [scope]
  if (groupOf(registry, scope)) {
    return registry.sites.filter((s) => s.group === scope).map((s) => s.id)
  }
  return []
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
 * site inherits. The test is the chain, not the id.
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
