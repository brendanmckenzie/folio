/**
 * The site registry on the server: reading it, caching it per isolate, routing a
 * request through it, and validating what is written to it
 * (`../../docs/specs/foundation/multi-site.md` decisions 1 and 4).
 *
 * The pure half — chains, the candidate step, the status gate — is
 * `core/sites.ts`. This file is the half that knows about D1, a `Request` and
 * `createFolio`'s config, and it only ever runs on a deployment that configured
 * `sites`: a single-site host never constructs a snapshot, so it never reads the
 * registry at all.
 */
import {
  ALL_SCOPES,
  candidate,
  DEFAULT_SITE,
  gate,
  type GroupRef,
  type Registry,
  SHARED_SCOPE,
  type SiteRef,
  type SiteStatus,
  type Surface,
} from '../core/sites'
import { type FolioDb, PRIMARY_FIRST } from './db'
import { FolioError } from './errors'

/* ------------------------------------------------------- internal headers --- */

/**
 * The internal request headers `handle()` hands the app, and the one list of
 * them it deletes from **every** inbound request before setting any (the
 * `withIdentity` discipline, `auth/identity.ts`). A header a client sent is
 * never read: the only way one reaches `withScope` is `handle()` writing it.
 *
 * - `SCOPE_HEADER` — the `~<scope>` segment `handle()` stripped from the path.
 * - `SITE_HEADER` / `SURFACE_HEADER` — the gated site this request was answered
 *   for, and which of its faces it arrived on.
 */
export const SCOPE_HEADER = 'x-folio-scope'
export const SITE_HEADER = 'x-folio-site'
export const SURFACE_HEADER = 'x-folio-surface'
export const INTERNAL_HEADERS: readonly string[] = [SCOPE_HEADER, SITE_HEADER, SURFACE_HEADER]

/* ------------------------------------------------------------ the snapshot --- */

/** How long an isolate trusts its registry before the next request re-reads it. */
export const SNAPSHOT_TTL_MS = 10_000

type SiteRow = {
  id: string
  kind: 'site' | 'group'
  name: string
  group_id: string | null
  status: SiteStatus | null
  preview_origin: string | null
  brand: string | null
}

/**
 * `sites` plus `site_hosts`, one batched read, **on a `first-primary` session**.
 *
 * Takes the raw `D1Database`, not a request's `FolioDb`, because the constraint
 * is the point: a request's own session may have opened on a replica, and a
 * replica can hand an isolate a registry older than the write that just changed
 * it — a site that went live ten minutes ago still answering 404 for another
 * isolate's ten seconds, over and over, for as long as that replica lags.
 *
 * **Every row, whatever its brand**, with `shared` false when `branded`. This is
 * what a registry write validates against and what `GET {base}/api/sites` lists;
 * what a request is served from is `servingRegistry` of it (`core/sites.ts`),
 * which the runtime's snapshot applies (`multi-brand.md` decision 4).
 */
export async function readRegistry(
  db: D1Database,
  opts: { branded?: boolean } = {},
): Promise<Registry> {
  const session = db.withSession(PRIMARY_FIRST)
  const [siteRows, hostRows] = await session.batch([
    session.prepare(
      'select id, kind, name, group_id, status, preview_origin, brand from sites order by id',
    ),
    session.prepare('select host, site_id from site_hosts order by host'),
  ])
  const hosts = new Map<string, string[]>()
  for (const row of (hostRows?.results ?? []) as { host: string; site_id: string }[]) {
    const list = hosts.get(row.site_id) ?? []
    list.push(row.host)
    hosts.set(row.site_id, list)
  }
  const sites: SiteRef[] = []
  const groups: GroupRef[] = []
  for (const row of (siteRows?.results ?? []) as SiteRow[]) {
    if (row.kind === 'group') {
      groups.push({ id: row.id, name: row.name, brand: row.brand })
      continue
    }
    sites.push({
      id: row.id,
      name: row.name,
      group: row.group_id,
      // `status` is nullable in the table (a group has none); a site row with
      // none reads as the most closed state rather than as live.
      status: row.status ?? 'draft',
      hosts: hosts.get(row.id) ?? [],
      preview: row.preview_origin,
      brand: row.brand,
    })
  }
  return { sites, groups, shared: !opts.branded }
}

export interface RegistrySnapshot {
  /** The registry, from this isolate's snapshot while it is fresh, else re-read. */
  get: (db: D1Database) => Promise<Registry>
  /**
   * Forget the snapshot. The isolate that writes a registry change calls this
   * straight after the write, so it answers the new state on its very next
   * request; every other isolate catches up within `SNAPSHOT_TTL_MS`.
   */
  drop: () => void
}

/**
 * One isolate's registry, held for ten seconds and refreshed lazily by the first
 * request after that (decision 4). **Beat a read per request**: a round trip in
 * front of every page. **Beat a version row read per request**: the same round
 * trip under another name.
 *
 * Concurrent requests during a refresh share the one read rather than each
 * issuing their own. A `drop()` that lands while a read is in flight wins: that
 * read's answer may predate the write, so it is handed to the requests that were
 * already waiting and not kept.
 */
export function registrySnapshot(
  opts: { ttl?: number; now?: () => number; read?: (db: D1Database) => Promise<Registry> } = {},
): RegistrySnapshot {
  const ttl = opts.ttl ?? SNAPSHOT_TTL_MS
  const now = opts.now ?? Date.now
  const read = opts.read ?? readRegistry
  let held: { registry: Registry; at: number } | null = null
  let inflight: Promise<Registry> | null = null
  let generation = 0

  return {
    get: (db) => {
      if (held && now() - held.at < ttl) return Promise.resolve(held.registry)
      if (inflight) return inflight
      const started = generation
      const at = now()
      const reading: Promise<Registry> = read(db).then(
        (registry) => {
          if (inflight === reading) inflight = null
          if (generation === started) held = { registry, at }
          return registry
        },
        (err) => {
          if (inflight === reading) inflight = null
          throw err
        },
      )
      inflight = reading
      return reading
    },
    drop: () => {
      generation++
      held = null
      inflight = null
    },
  }
}

/* ------------------------------------------------------------- routing --- */

/** What `sites` config becomes once `validateSites` has checked it. */
export interface ResolvedSites {
  /** `new URL(sites.admin).origin`. */
  admin: string
  /** The admin origin's hostname, for the uniqueness rule on registry writes. */
  adminHost: string
  /** The settings singleton type, or undefined. */
  settings: string | undefined
  resolve: ((req: Request, registry: Registry) => string | null) | undefined
}

/**
 * Where a request belongs, in decision 4's order.
 *
 * - `admin` — the request is on `sites.admin`. **Checked before any candidate**,
 *   so no registry row — whatever validation it slipped past, a row written by
 *   SQL, or a later change to `sites.admin` — can take the admin, sign-in or the
 *   registry routes offline.
 * - `site` — a candidate the status gate admitted.
 * - `none` — no candidate, or one the gate refused. Never `default` or any other
 *   site: the host's own routing answers.
 */
export type SiteRoute =
  | { kind: 'admin' }
  | { kind: 'site'; site: SiteRef; surface: Surface }
  | { kind: 'none' }

export function routeRequest(
  sites: ResolvedSites,
  registry: Registry,
  req: Request,
  gateReq: { path: string | null; grantFor: string | null },
): SiteRoute {
  const chosen = candidateFor(sites, registry, req)
  if (chosen === 'admin') return { kind: 'admin' }
  if (!chosen) return { kind: 'none' }

  // Step 2, always Folio's: a group, `shared` or a site the status keeps closed
  // is no site, whoever chose it.
  const site = gate(registry, chosen, gateReq)
  return site ? { kind: 'site', site, surface: chosen.surface } : { kind: 'none' }
}

/**
 * Steps 0 and 1 of `routeRequest` alone: `'admin'` for the admin origin, otherwise
 * the candidate, ungated, or null. Exported for the one caller that has to know
 * which site a refused request was a candidate for — `handle()`, which then reads
 * a grant or share cookie for it (a D1 read, decision 4: after this synchronous
 * step and never inside a custom resolver) and gates again with `grantFor`.
 */
export function candidateFor(
  sites: ResolvedSites,
  registry: Registry,
  req: Request,
): 'admin' | { site: string; surface: Surface } | null {
  const url = new URL(req.url)
  if (url.origin === sites.admin) return 'admin'

  // Step 1, the only replaceable one. A custom resolver names a candidate id; the
  // surface is still decided by the URL, because a site's preview origin is a
  // registry fact and not something a resolver may reassign.
  if (sites.resolve) {
    const id = sites.resolve(req, registry)
    if (id === null) return null
    const row = registry.sites.find((s) => s.id === id)
    return { site: id, surface: row?.preview === url.origin ? 'preview' : 'live' }
  }
  return candidate(registry, url)
}

/* ---------------------------------------------- write-time validation --- */

/** A site or group id (decision 1): lowercase, digits and inner hyphens, 1–32. */
export const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** Ids no registry write may take. `default` is the migration's own row only. */
const RESERVED = new Set([SHARED_SCOPE, DEFAULT_SITE, ALL_SCOPES])

export function validateSiteId(raw: unknown): string {
  if (typeof raw !== 'string' || !SITE_ID.test(raw)) {
    throw new FolioError(
      'bad_request',
      'id must be 1–32 lowercase letters, digits or inner hyphens',
    )
  }
  if (RESERVED.has(raw)) throw new FolioError('bad_request', `'${raw}' is reserved`)
  return raw
}

const isLocal = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost')

/**
 * A live hostname as the registry stores it: lowercased, without a port, without
 * a trailing dot. A value carrying a scheme, a path, a query or credentials is
 * refused rather than trimmed to its host, because it is a mistake about what the
 * field means and silently taking part of it would hide that.
 */
export function normaliseHost(raw: unknown): string {
  if (typeof raw !== 'string') throw new FolioError('bad_request', 'a host must be a string')
  const trimmed = raw.trim().replace(/\.$/, '')
  if (!trimmed || /[/?#@\s]/.test(trimmed)) {
    throw new FolioError('bad_request', `'${raw}' is not a hostname`)
  }
  let url: URL
  try {
    url = new URL(`https://${trimmed}`)
  } catch {
    throw new FolioError('bad_request', `'${raw}' is not a hostname`)
  }
  return url.hostname
}

/**
 * A preview origin as the registry stores it: `new URL(x).origin` — lowercase,
 * default port removed — and `https:`, or `http:` only on `localhost` and
 * `*.localhost`, where a browser treats it as a secure context anyway.
 */
export function normalisePreviewOrigin(raw: unknown): string {
  if (typeof raw !== 'string') throw new FolioError('bad_request', 'preview must be a string')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new FolioError('bad_request', `'${raw}' is not an absolute URL`)
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocal(url.hostname))
  if (!secure) {
    throw new FolioError(
      'bad_request',
      'A preview origin must be https (or http on localhost / *.localhost)',
    )
  }
  return url.origin
}

/**
 * The claims rule (decision 1): **every hostname is unique across both
 * columns.** No live host may be another site's live host, any site's
 * preview-origin host, or the admin's host; no preview-origin host may be any
 * live host, another site's preview-origin host, or the admin's host.
 *
 * Compared as hostnames, so `P.EXAMPLE` as one site's live host and
 * `https://p.example:443` as another's preview origin collide, which is the
 * point: a request for that host could not say which site it meant.
 */
export function assertUnclaimed(
  registry: Registry,
  adminHost: string,
  write: { site: string; hosts?: readonly string[]; preview?: string | null },
): void {
  const others = registry.sites.filter((s) => s.id !== write.site)
  const self = registry.sites.find((s) => s.id === write.site)
  const previewHost = (origin: string | null) => (origin ? new URL(origin).hostname : null)

  const hosts = write.hosts ?? self?.hosts ?? []
  const preview = write.preview !== undefined ? write.preview : (self?.preview ?? null)
  const ownPreviewHost = previewHost(preview)

  const refuse = (host: string, by: string) => {
    throw new FolioError('conflict', `${host} is already claimed by ${by}`)
  }
  const seen = new Set<string>()
  for (const host of hosts) {
    if (seen.has(host)) refuse(host, 'this request')
    seen.add(host)
    if (host === adminHost) refuse(host, 'the admin origin')
    if (host === ownPreviewHost) refuse(host, "this site's preview origin")
    for (const other of others) {
      if (other.hosts.includes(host)) refuse(host, `site '${other.id}'`)
      if (previewHost(other.preview) === host) refuse(host, `site '${other.id}'s preview origin`)
    }
  }
  if (ownPreviewHost) {
    if (ownPreviewHost === adminHost) refuse(ownPreviewHost, 'the admin origin')
    for (const other of others) {
      if (other.hosts.includes(ownPreviewHost)) refuse(ownPreviewHost, `site '${other.id}'`)
      if (previewHost(other.preview) === ownPreviewHost) {
        refuse(ownPreviewHost, `site '${other.id}'s preview origin`)
      }
    }
  }
}

/**
 * `route('', undefined, site)` must answer an absolute URL on a multi-site
 * deployment (decision 1): a site's links, its sitemap and its share links all
 * leave the admin origin, and a relative one would resolve against it.
 */
export function assertAbsoluteRoute(
  route: (path: string, locale?: string, site?: SiteRef) => string,
  site: SiteRef,
): void {
  try {
    new URL(route('', undefined, site))
  } catch {
    throw new FolioError(
      'bad_request',
      `route('', undefined, site) must answer an absolute URL for site '${site.id}'`,
    )
  }
}

/* ----------------------------------------------------------- the writes --- */

export interface SiteCreate {
  id: string
  kind: 'site' | 'group'
  name: string
  group?: string | null
  status?: SiteStatus
  preview?: string | null
  hosts?: readonly string[]
  brand?: string | null
}

export interface SitePatch {
  name?: string
  group?: string | null
  status?: SiteStatus
  preview?: string | null
  brand?: string | null
}

export interface RegistryWriteContext {
  sites: ResolvedSites
  route: (path: string, locale?: string, site?: SiteRef) => string
  /** The configured brand ids, or null on a deployment with no `brands`. */
  brands: readonly string[] | null
}

function assertGroup(registry: Registry, group: string | null | undefined): string | null {
  if (group === undefined || group === null) return null
  if (!registry.groups.some((g) => g.id === group)) {
    throw new FolioError('bad_request', `No group '${group}'`)
  }
  return group
}

/**
 * A written brand (`multi-brand.md` decision 4): one of the configured ids on a
 * deployment with `brands`, and nothing at all on one without — where a brand
 * would be a column nothing reads, and a claim nothing enforces. **Never a
 * default**: a create that names none on a branded deployment is refused, not
 * given the first brand.
 */
function assertBrand(
  brands: readonly string[] | null,
  brand: string | null | undefined,
  required: boolean,
): string | null | undefined {
  if (brands === null) {
    if (brand !== undefined && brand !== null) {
      throw new FolioError('bad_request', 'This deployment has no brands: a row has none')
    }
    return brand === undefined ? undefined : null
  }
  if (brand === undefined && !required) return undefined
  if (brand === undefined || brand === null) {
    throw new FolioError('bad_request', `brand is required: one of ${brands.join(', ')}`)
  }
  if (!brands.includes(brand)) {
    throw new FolioError('bad_request', `No brand '${brand}': one of ${brands.join(', ')}`)
  }
  return brand
}

/**
 * A site and its group have one brand (decision 4), so a chain never crosses one
 * (decision 5). Nothing to check with no `brands`, or for a site with no group.
 */
function assertGroupBrand(
  registry: Registry,
  brands: readonly string[] | null,
  site: { group: string | null; brand: string | null },
): void {
  if (brands === null || site.group === null) return
  const group = registry.groups.find((g) => g.id === site.group)
  if (group && group.brand !== site.brand) {
    throw new FolioError(
      'bad_request',
      `Group '${group.id}' is ${group.brand === null ? 'of no brand' : `brand '${group.brand}'`}: a site joins a group of its own brand`,
    )
  }
}

/** A write's `sites` row insert or conflict, turned into the refusal a caller reads. */
async function batchOrConflict(
  db: FolioDb,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await db.batch(statements)
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err))) {
      throw new FolioError('conflict', 'That id, host or preview origin is already claimed')
    }
    throw err
  }
}

/**
 * Creates a site or a group. `registry` is a fresh read, never the snapshot:
 * validating a claim against a ten-second-old view would let two writes a second
 * apart both take the same host.
 */
export async function createSite(
  db: FolioDb,
  registry: Registry,
  input: SiteCreate,
  ctx: RegistryWriteContext,
): Promise<SiteRef | GroupRef> {
  const id = validateSiteId(input.id)
  if (registry.sites.some((s) => s.id === id) || registry.groups.some((g) => g.id === id)) {
    throw new FolioError('conflict', `'${id}' already exists`)
  }
  const now = Date.now()
  const brand = assertBrand(ctx.brands, input.brand, true) ?? null

  if (input.kind === 'group') {
    if (input.group || input.status || input.preview || input.hosts?.length) {
      throw new FolioError(
        'bad_request',
        'A group has no group, status, preview origin or hosts: one level of groups',
      )
    }
    await batchOrConflict(db, [
      db
        .prepare(
          `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at)
           values (?, 'group', ?, null, null, null, ?, ?, ?)`,
        )
        .bind(id, input.name, brand, now, now),
    ])
    return { id, name: input.name, brand }
  }

  const site: SiteRef = {
    id,
    name: input.name,
    group: assertGroup(registry, input.group),
    status: input.status ?? 'draft',
    hosts: [...new Set((input.hosts ?? []).map(normaliseHost))],
    preview:
      input.preview === undefined || input.preview === null
        ? null
        : normalisePreviewOrigin(input.preview),
    brand,
  }
  assertGroupBrand(registry, ctx.brands, site)
  assertUnclaimed(registry, ctx.sites.adminHost, {
    site: id,
    hosts: site.hosts,
    preview: site.preview,
  })
  assertAbsoluteRoute(ctx.route, site)

  await batchOrConflict(db, [
    db
      .prepare(
        `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at)
         values (?, 'site', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, site.name, site.group, site.status, site.preview, site.brand, now, now),
    ...site.hosts.map((host) =>
      db.prepare('insert into site_hosts (host, site_id) values (?, ?)').bind(host, id),
    ),
  ])
  return site
}

/** Edits a row. The id is immutable, so it is the address and never the payload. */
export async function updateSite(
  db: FolioDb,
  registry: Registry,
  id: string,
  patch: SitePatch,
  ctx: RegistryWriteContext,
): Promise<SiteRef | GroupRef> {
  const now = Date.now()
  const brand = assertBrand(ctx.brands, patch.brand, false)
  const group = registry.groups.find((g) => g.id === id)
  if (group) {
    if (patch.group !== undefined || patch.status !== undefined || patch.preview !== undefined) {
      throw new FolioError('bad_request', 'A group has a name and a brand only')
    }
    const next: GroupRef = { id, name: patch.name ?? group.name, brand: brand ?? group.brand }
    const guard = next.brand !== group.brand ? rebrandGuard(id) : NO_GUARD
    const done = await db
      .prepare(`update sites set name = ?, brand = ?, updated_at = ? where id = ?${guard.sql}`)
      .bind(next.name, next.brand, now, id, ...guard.binds)
      .run()
    if (guard !== NO_GUARD && !done.meta.changes) await refuseRebrand(db, id, 'group')
    return next
  }

  const current = registry.sites.find((s) => s.id === id)
  if (!current) throw new FolioError('not_found', `No site '${id}'`)
  const next: SiteRef = {
    ...current,
    name: patch.name ?? current.name,
    group: patch.group !== undefined ? assertGroup(registry, patch.group) : current.group,
    status: patch.status ?? current.status,
    preview:
      patch.preview === undefined
        ? current.preview
        : patch.preview === null
          ? null
          : normalisePreviewOrigin(patch.preview),
    brand: brand ?? current.brand,
  }
  assertGroupBrand(registry, ctx.brands, next)
  assertUnclaimed(registry, ctx.sites.adminHost, { site: id, preview: next.preview })
  assertAbsoluteRoute(ctx.route, next)
  const guard = next.brand !== current.brand ? rebrandGuard(id) : NO_GUARD

  const [done] = await batchOrConflict(db, [
    db
      .prepare(
        `update sites set name = ?, group_id = ?, status = ?, preview_origin = ?, brand = ?,
                updated_at = ? where id = ?${guard.sql}`,
      )
      .bind(next.name, next.group, next.status, next.preview, next.brand, now, id, ...guard.binds),
  ])
  if (guard !== NO_GUARD && !done?.meta.changes) await refuseRebrand(db, id, 'site')
  return next
}

/** Replaces a site's live hostnames, all of them, in one batch. */
export async function replaceHosts(
  db: FolioDb,
  registry: Registry,
  id: string,
  hosts: readonly string[],
  ctx: RegistryWriteContext,
): Promise<SiteRef> {
  const current = registry.sites.find((s) => s.id === id)
  if (!current) throw new FolioError('not_found', `No site '${id}'`)
  const next: SiteRef = { ...current, hosts: [...new Set(hosts.map(normaliseHost))] }
  assertUnclaimed(registry, ctx.sites.adminHost, { site: id, hosts: next.hosts })
  assertAbsoluteRoute(ctx.route, next)

  await batchOrConflict(db, [
    db.prepare('delete from site_hosts where site_id = ?').bind(id),
    ...next.hosts.map((host) =>
      db.prepare('insert into site_hosts (host, site_id) values (?, ?)').bind(host, id),
    ),
    db.prepare('update sites set updated_at = ? where id = ?').bind(Date.now(), id),
  ])
  return next
}

/**
 * The tables that hold content owned by a scope (decision 3). Deleting a scope
 * that still owns a row in any of them would orphan it under an id nothing can
 * reach, so the delete is refused instead.
 */
const OWNED = [
  'stories',
  'assets',
  'asset_folders',
  'asset_tags',
  'forms',
  'redirects',
  // The answers a site received to a form it does not own. They are content: left
  // behind, they would be read again by whoever next takes the id.
  'form_responses',
] as const

/**
 * Whether anything a scope owns, or (for a group) any site in it, is in the way:
 * the first table that holds a row, else null. One batch, shared by the delete and
 * by a brand change.
 */
async function ownedBy(db: FolioDb, id: string): Promise<string | null> {
  const probes = await db.batch([
    ...OWNED.map((table) =>
      db.prepare(`select exists (select 1 from ${table} where site_id = ?) as n`).bind(id),
    ),
    db.prepare('select exists (select 1 from sites where group_id = ?) as n').bind(id),
  ])
  const holding = probes.findIndex((r) => ((r.results[0] as { n: number } | undefined)?.n ?? 0) > 0)
  return holding === -1 ? null : (OWNED[holding] ?? 'sites')
}

/**
 * A brand change (`multi-brand.md` decision 4) — refused (409) while the scope
 * owns content, which was written against the old brand's registry and would be
 * rendered by the new one's, and on a group that has sites, whose brand would
 * then differ from theirs. The same list that refuses a delete.
 *
 * **The check is part of the `update`**, a `not exists` per table, so a story
 * created between a probe and the write cannot slip through: the row changes only
 * if the scope is empty at the moment it does. No row changed is the refusal, and
 * `refuseRebrand` reads what was in the way only to say so.
 *
 * What this cannot close: another isolate's registry snapshot still answers the
 * old brand for up to `SNAPSHOT_TTL_MS`, so a first page created there in that
 * window is written against the old brand's registry. A rebrand is safe on a
 * scope nobody is editing.
 */
function rebrandGuard(id: string): { sql: string; binds: string[] } {
  const probes = [
    ...OWNED.map((table) => `select 1 from ${table} where site_id = ?`),
    'select 1 from sites where group_id = ?',
  ]
  return {
    sql: probes.map((probe) => ` and not exists (${probe})`).join(''),
    binds: probes.map(() => id),
  }
}

const NO_GUARD = { sql: '', binds: [] as string[] }

async function refuseRebrand(db: FolioDb, id: string, kind: 'site' | 'group'): Promise<never> {
  const what = await ownedBy(db, id)
  throw new FolioError(
    'conflict',
    what === null
      ? `The ${kind} '${id}' changed while its brand was being set; try again`
      : what === 'sites'
        ? `Group '${id}' still has sites; a group and its sites have one brand`
        : `The ${kind} '${id}' still owns ${what}; its brand can change only while it holds no content`,
  )
}

/**
 * Deletes a site or group — refused (409) while it owns content or, for a group,
 * while any site is in it (decision 1). **`default` is never deletable**: it is
 * the migration's own row, its id is reserved against re-creation, and a
 * deployment that deleted it could never have it back.
 */
export async function deleteSite(db: FolioDb, registry: Registry, id: string): Promise<void> {
  const known = registry.sites.some((s) => s.id === id) || registry.groups.some((g) => g.id === id)
  if (!known) throw new FolioError('not_found', `No site or group '${id}'`)
  if (id === DEFAULT_SITE) throw new FolioError('conflict', 'The default site cannot be deleted')

  const what = await ownedBy(db, id)
  if (what !== null) {
    throw new FolioError('conflict', `'${id}' still owns ${what}; move or delete them first`)
  }

  await db.batch([
    db.prepare('delete from site_hosts where site_id = ?').bind(id),
    // Every grant on the scope, whoever set it (decision 1): grants are not a reason
    // to refuse a delete, so a retired site never waits on its editors signing in
    // again. Explicit rather than left to a cascade `site_roles` does not declare on
    // `scope_id`, and a later sign-in whose mapper still names the scope drops that
    // entry (decision 17). Tokens bound to it are refused at use (`withActor`).
    db.prepare('delete from site_roles where scope_id = ?').bind(id),
    // Preview grants and share links naming the site as their render site
    // (`site_grants` and `shares` declare no foreign key on it): a grant is a
    // credential for a site that no longer exists, and a share can never redeem.
    // Explicit, like every cleanup here, and in the same batch.
    db.prepare('delete from site_grants where site_id = ?').bind(id),
    // Tokens bound to the scope, and the preview grants minted from them. The id can be
    // registered again, and a token that authenticated on the old site must not
    // authenticate on the new one.
    db
      .prepare(
        'delete from site_grants where token_id in (select id from api_tokens where site_id = ?)',
      )
      .bind(id),
    db.prepare('delete from api_tokens where site_id = ?').bind(id),
    db.prepare('delete from shares where site_id = ?').bind(id),
    db.prepare('delete from sites where id = ?').bind(id),
  ])
}
