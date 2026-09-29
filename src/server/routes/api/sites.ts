/**
 * How a headless front end learns which site a host is, and which hosts there are
 * (`../../../../docs/specs/foundation/multi-site.md` decision 16), without an admin
 * token and without reading the registry routes.
 *
 * - `GET {base}/api/v1/sites/resolve?host=<host>` — the gate's result for that host as
 *   a first request would see it: `{ site: { id, name, group, status }, surface }`, or
 *   `404` for no site. For a draft site's preview origin, which serves nobody without a
 *   grant, `{ …, grantRequired: true }`: the front end learns it must send the visitor
 *   through `site/start`, rather than that the host does not exist.
 * - `GET {base}/api/v1/sites` — every `preview` and `live` site with its hosts and
 *   preview origin, for a front end that keeps its own map; a token bound to a scope
 *   sees that scope's sites only. A draft site is not on it: a site nobody can visit
 *   yet is nobody's business.
 *
 * **Both are unscoped** (`UNSCOPED_API`, `/v1/sites`): they name a host and a site, not
 * a `~<scope>`, and answer for a caller with `content:read`. **Both are v1**, so they
 * are a promise, and `api-partition.test.ts` lists them.
 *
 * Mounted only on a deployment with `sites`: with none there is no registry to ask.
 */
import { Hono } from 'hono'
import { gate, type Registry, type SiteRef, sitesUnder } from '../../../core/sites'
import { type Actor, READ } from '../../auth/roles'
import { FolioError } from '../../errors'
import { requireAccess } from '../../middleware'
import type { FolioRuntime } from '../../runtime'
import { candidateFor } from '../../sites'
import type { FolioEnv } from '../../types'

/** The sites a caller may be told about: all of them, or — for a token bound to a
 * scope — the ones under that binding. */
function visible(actor: Actor | null, registry: Registry): readonly SiteRef[] {
  if (actor?.kind !== 'token' || !actor.site) return registry.sites
  const under = new Set(sitesUnder(registry, actor.site))
  return registry.sites.filter((site) => under.has(site.id))
}

/** What a site looks like on the wire here: no hosts, no preview origin. */
function brief(site: SiteRef) {
  return { id: site.id, name: site.name, group: site.group, status: site.status }
}

export function siteReadRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const sites = rt.sites
  if (!sites) return app

  app.get('/sites/resolve', requireAccess<Env>(rt, READ), async (c) => {
    const host = (c.req.query('host') ?? '').trim()
    if (host === '' || host.length > 300 || /[\s/?#@\\]/.test(host.replace(/^https?:\/\//i, ''))) {
      throw new FolioError('bad_request', 'host must be a hostname, or an origin')
    }
    const registry = await sites.registry(c.env)

    // A bare host is tried as https first, then as http: a preview origin on
    // `localhost` is the one place `http:` is legal (decision 1). A request built for
    // the purpose, so a custom `sites.resolve` sees what it would see on a first
    // request to that host.
    const urls = /^https?:\/\//i.test(host) ? [host] : [`https://${host}`, `http://${host}`]
    for (const raw of urls) {
      let req: Request
      try {
        req = new Request(new URL('/', raw))
      } catch {
        throw new FolioError('bad_request', 'host must be a hostname, or an origin')
      }
      const chosen = candidateFor(sites, registry, req)
      if (chosen === 'admin' || chosen === null) continue
      const row = registry.sites.find((site) => site.id === chosen.site)
      if (!row || !visible(c.var.actor, registry).some((site) => site.id === row.id)) continue

      const served = gate(registry, chosen, { path: null, grantFor: null })
      if (served) return c.json({ site: brief(served), surface: chosen.surface })
      // A draft site's preview origin: refused to anybody without a grant, which is
      // an answer ("send them through `site/start`") rather than an absence.
      if (chosen.surface === 'preview' && row.status === 'draft') {
        return c.json({ site: brief(row), surface: chosen.surface, grantRequired: true })
      }
    }
    throw new FolioError('not_found', 'No site is served on that host')
  })

  app.get('/sites', requireAccess<Env>(rt, READ), async (c) => {
    const registry = await sites.registry(c.env)
    return c.json({
      sites: visible(c.var.actor, registry)
        .filter((site) => site.status !== 'draft')
        .map((site) => ({ ...brief(site), hosts: site.hosts, preview: site.preview }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
  })

  return app
}
