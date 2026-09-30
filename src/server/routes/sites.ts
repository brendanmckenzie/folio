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
 * made the change answers with it on its next request.
 *
 * **Every write then fires `siteChanged`** (`multi-site.md` decisions 4 and 16), and
 * Folio's own hook for it purges `site:<id>` now and again 25 seconds later
 * (`cache-purge.ts`'s `purgeSite`): another isolate may hold a registry ten seconds
 * old, and a page it renders inside that window is cached after the first purge. The
 * payload carries the changed row and exactly what was purged, so a headless front
 * end that keeps its own host map refreshes that one entry on the event.
 *
 * **On a deployment with `brands` every row carries one** (`multi-brand.md`
 * decision 4): a create names it, a site joins only a group of its own brand (400),
 * a brand nobody configured is refused (400), and a brand changes only on a scope
 * that holds no content and, for a group, has no sites (409). `GET` lists every row,
 * a row of no configured brand included, since that is where a platform admin
 * repairs one: the snapshot a request is served from leaves it out.
 *
 * Mounted only on a deployment with `sites`: with none there is no registry, and
 * these paths fall through to the `/api/*` 404 like any other unknown route.
 */
import { Hono } from 'hono'
import * as v from 'valibot'
import type { Context } from 'hono'
import type { GroupRef, Registry, SiteRef } from '../../core/sites'
import { actorString, ADMIN } from '../auth/roles'
import { FolioError } from '../errors'
import { hookCtx, requireAccess, requireAuthConfigured } from '../middleware'
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
    brand: v.optional(v.nullable(SHORT)),
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
    brand: v.optional(v.nullable(SHORT)),
  },
  OBJECT,
)

const HostsBody = v.object({ hosts: HOSTS }, OBJECT)

export function siteRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const sites = rt.sites
  if (!sites) return app
  const ctx: RegistryWriteContext = { sites, route: rt.route, brands: sites.brands }
  app.use('/sites', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))
  app.use('/sites/*', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, ADMIN))

  /**
   * After a write that has already committed and dropped this isolate's snapshot:
   * tell the internal hooks (the purge of `site:<id>`, twice) and then the host's.
   * `row` is what the registry now holds under the id, or null once it is deleted.
   */
  const changed = async (
    c: Context<FolioEnv<Env>>,
    id: string,
    kind: 'site' | 'group',
    change: 'created' | 'updated' | 'deleted',
    row: SiteRef | GroupRef | null,
  ): Promise<void> => {
    await rt.hookRunner(hookCtx(c)).run('siteChanged', {
      site: id,
      kind,
      change,
      row,
      actor: actorString(c.var.actor),
    })
  }

  /** A row's kind, from the fresh registry it is about to be edited in. */
  const kindIn = (registry: Registry, id: string): 'site' | 'group' =>
    registry.groups.some((group) => group.id === id) ? 'group' : 'site'

  app.get('/sites', async (c) => c.json(await sites.fresh(c.env)))

  app.post('/sites', async (c) => {
    const body = await parseBody(c.req, SiteCreateBody)
    const row = await createSite(c.var.bindings().db, await sites.fresh(c.env), body, ctx)
    sites.drop()
    await changed(c, row.id, body.kind, 'created', row)
    return c.json(row, 201)
  })

  app.patch('/sites/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const { id: named, ...patch } = await parseBody(c.req, SitePatchBody)
    if (named !== undefined && named !== id) {
      throw new FolioError('bad_request', 'A site or group id cannot be changed')
    }
    const registry = await sites.fresh(c.env)
    const row = await updateSite(c.var.bindings().db, registry, id, patch, ctx)
    sites.drop()
    await changed(c, id, kindIn(registry, id), 'updated', row)
    return c.json(row)
  })

  app.put('/sites/:id/hosts', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const { hosts } = await parseBody(c.req, HostsBody)
    const registry = await sites.fresh(c.env)
    const row = await replaceHosts(c.var.bindings().db, registry, id, hosts, ctx)
    sites.drop()
    await changed(c, id, kindIn(registry, id), 'updated', row)
    return c.json(row)
  })

  app.delete('/sites/:id', async (c) => {
    const id = idParam('id', c.req.param('id'))
    const registry = await sites.fresh(c.env)
    const kind = kindIn(registry, id)
    await deleteSite(c.var.bindings().db, registry, id)
    sites.drop()
    // Its pages are cached under `site:<id>` and the host it answered on is now nobody's:
    // the purge is the same, and a front end's host map drops the entry on `deleted`.
    await changed(c, id, kind, 'deleted', null)
    return c.json({ deleted: id })
  })

  return app
}
