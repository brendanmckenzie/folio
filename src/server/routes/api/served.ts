/**
 * The status gate for a v1 read that names a surface
 * (`../../../../docs/specs/foundation/multi-site.md` decision 16).
 *
 * `GET {base}/~<site>/api/v1/pages/{path}` and `GET …/documents/by-path/…` are how a
 * headless front end reads a site's pages. The site is in the URL, chosen by whoever
 * built it, so unlike a request that arrived on the site's own host it has **not**
 * been through `handle()`'s candidate step and status gate. This is that gate, for a
 * caller that names the site.
 *
 * The caller says which surface it is serving (`?surface=live|preview`, default
 * `live`), and a site that surface would not serve is a `404` — "no such site", the
 * same answer as a scope nobody registered — **unless the caller holds `READ_DRAFT`
 * on the site's chain, or a preview grant for it**. A front end cannot see a draft by
 * lying about the surface: the most it can do is serve a `preview`-status site's
 * published pages on the wrong host, which is its own routing and not a leak.
 *
 * One rule, `mayPreviewDrafts` (`auth/roles.ts`), for who may see a site's drafts:
 * the same one `?_folio=`, `reader.page()` and draft mode's switch ask, so this route
 * cannot come to disagree with them.
 */
import type { Context } from 'hono'
import { gate, type SiteRef, type Surface } from '../../../core/sites'
import { mayPreviewDrafts } from '../../auth/roles'
import { FolioError } from '../../errors'
import type { FolioRuntime } from '../../runtime'
import type { FolioEnv } from '../../types'

/** What the gate admitted: the site row, and the surface the caller is serving. */
export interface ServedSite {
  site: SiteRef
  surface: Surface
  /** The caller may read this site's drafts, so `?status=draft` is theirs to ask. */
  drafts: boolean
}

/**
 * Null when there is nothing to gate: a deployment with no `sites`, and a scope that
 * is a group or `shared`, which no host serves — reading those is a role's business
 * (`withActor`), not a surface's. A `404` for a site the caller's surface would not
 * serve.
 */
export async function servedSite<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
): Promise<ServedSite | null> {
  if (!rt.sites) return null
  const scope = c.var.scope
  if (scope === null) return null
  const registry = await rt.sites.registry(c.env)
  const row = registry.sites.find((site) => site.id === scope)
  if (!row) return null

  const named = c.req.query('surface') ?? 'live'
  if (named !== 'live' && named !== 'preview') {
    throw new FolioError('bad_request', "surface must be 'live' or 'preview'")
  }
  // `auth: 'open'` has no accounts to hold a role, and admits every surface, as the
  // edge cases say of preview origins.
  const drafts = rt.auth.mode !== 'session' || mayPreviewDrafts(c.var.actor, registry, row.id)
  if (
    !drafts &&
    !gate(registry, { site: row.id, surface: named }, { path: null, grantFor: null })
  ) {
    throw new FolioError('not_found', 'No such site')
  }
  return { site: row, surface: named, drafts }
}
