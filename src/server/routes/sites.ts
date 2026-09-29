/**
 * The site registry: sites and groups, their hostnames, preview origins and
 * status (`../../../docs/specs/foundation/multi-site.md` decision 1).
 *
 * `{base}/api/sites*`, unscoped and platform tier (`ADMIN`, whose `tier` is
 * `'platform'`): `*` + `admin` for a person, the `admin` scope on an unbound token.
 * A site's own admins edit its *settings*, which are content, but never its
 * registry row, and a token bound to a site is refused here whatever it holds.
 *
 * Every write reads the registry fresh from the primary to validate against —
 * never the ten-second snapshot, or two writes a second apart could both claim
 * one host — and drops this isolate's snapshot afterwards, so the isolate that
 * made the change answers with it on its next request. The purges and the
 * `siteChanged` hook a registry write owes are phase 7's.
 *
 * Mounted only on a deployment with `sites`: with none there is no registry, and
 * these paths fall through to the `/api/*` 404 like any other unknown route.
 */
import { Hono } from 'hono'
import * as v from 'valibot'
import { validateSitesAuth } from '../auth/config'
import { ADMIN } from '../auth/roles'
import { FolioError } from '../errors'
import { requireAccess, requireAuthConfigured } from '../middleware'
import type { FolioRuntime } from '../runtime'
import {
  createSite,
  deleteSite,
  type RegistryWriteContext,
  replaceHosts,
  updateSite,
} from '../sites'
import type { FolioEnv } from '../types'
import { idParam, parseBody } from '../validate'

const OBJECT = 'must be a JSON object'
const NAME = v.pipe(
  v.string('must be a string'),
  v.trim(),
  v.minLength(1, 'is required'),
  v.maxLength(120, 'must be 120 characters or fewer'),
  v.regex(/^[^\p{Cc}\p{Cs}‪-‮⁦-⁩]*$/u, 'contains unsupported characters'),
)
const SHORT = v.pipe(v.string('must be a string'), v.maxLength(253, 'is too long'))
const STATUS = v.picklist(['draft', 'preview', 'live'], "must be 'draft', 'preview' or 'live'")
const HOSTS = v.pipe(v.array(SHORT, 'must be a list'), v.maxLength(50, 'lists at most 50 hosts'))

const SiteCreateBody = v.object(
  {
    id: SHORT,
    kind: v.picklist(['site', 'group'], "must be 'site' or 'group'"),
    name: NAME,
    group: v.optional(v.nullable(SHORT)),
    status: v.optional(STATUS),
    preview: v.optional(v.nullable(SHORT)),
    hosts: v.optional(HOSTS),
  },
  OBJECT,
)

const SitePatchBody = v.object(
  {
    // Accepted only as the id already in the URL, so a client that round-trips
    // the row is not punished for it. A different one is refused below: an id is
    // immutable once written.
    id: v.optional(SHORT),
    name: v.optional(NAME),
    group: v.optional(v.nullable(SHORT)),
    status: v.optional(STATUS),
    preview: v.optional(v.nullable(SHORT)),
  },
  OBJECT,
)

const HostsBody = v.object({ hosts: HOSTS }, OBJECT)

export function siteRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const sites = rt.sites
  if (!sites) return app
  // Construction time, like every other config rule: `createFolio` builds this app,
  // so a provider this deployment's grants cannot honour throws there, not at the
  // first sign-in. (`validateSites` beside `resolveAuth` is where it belongs.)
  validateSitesAuth(rt.auth)

  const ctx: RegistryWriteContext = { sites, route: rt.route }
  app.use('/sites', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/sites/*', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))

  app.get('/sites', async (c) => c.json(await sites.fresh(c.env)))

  app.post('/sites', async (c) => {
    const body = await parseBody(c.req, SiteCreateBody)
    const row = await createSite(c.var.bindings().db, await sites.fresh(c.env), body, ctx)
    sites.drop()
    return c.json(row, 201)
  })

  app.patch('/sites/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const { id: named, ...patch } = await parseBody(c.req, SitePatchBody)
    if (named !== undefined && named !== id) {
      throw new FolioError('bad_request', 'A site or group id cannot be changed')
    }
    const row = await updateSite(c.var.bindings().db, await sites.fresh(c.env), id, patch, ctx)
    sites.drop()
    return c.json(row)
  })

  app.put('/sites/:id/hosts', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const { hosts } = await parseBody(c.req, HostsBody)
    const row = await replaceHosts(c.var.bindings().db, await sites.fresh(c.env), id, hosts, ctx)
    sites.drop()
    return c.json(row)
  })

  app.delete('/sites/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    await deleteSite(c.var.bindings().db, await sites.fresh(c.env), id)
    sites.drop()
    return c.json({ deleted: id })
  })

  return app
}
