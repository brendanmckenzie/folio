/**
 * What `GET {base}/api/me` says about many sites
 * (`../../../docs/specs/foundation/multi-site.md`, the route table's `/me` row):
 * which scopes the caller reaches and in what role, which sites they may preview,
 * and whether they are the platform.
 *
 * **Pure, over a registry snapshot and the caller's grants**, so the answer and the
 * server's own checks are the same functions (`effectiveRole`, `previewEligible`,
 * `allows(…, ADMIN)`) rather than a second opinion. The admin reads this and
 * decides what to draw in `admin/me.ts`; nothing here is enforcement, and the
 * routes re-check every request.
 *
 * Absent on a deployment with no `sites`: that is how the admin knows it is one.
 */
import { ALL_SCOPES, chain, type Registry, SHARED_SCOPE, type SiteStatus } from '../../core/sites'
import { effectiveRole, type Grants, previewEligible, type Role } from './roles'

/** One scope the caller reaches, with their role there. */
export interface MeScope {
  id: string
  name: string
  kind: 'site' | 'group' | 'shared'
  /** The group a site belongs to, or null. */
  group: string | null
  /** The caller's effective role on this scope. A read up the chain is `viewer`. */
  role: Role
  /** The scopes this one reads from, nearest first, itself included. */
  chain: readonly string[]
  /** A site's status; null for a group and for `shared`. */
  status: SiteStatus | null
  /** A site's preview origin, or null. */
  preview: string | null
}

/** A site the caller may preview, and where its preview origin is. */
export interface MePreview {
  id: string
  name: string
  preview: string | null
  status: SiteStatus
  /** The scopes this site reads from, nearest first, itself included: what decides
   * which sites a page owned by a shared or group scope can be previewed in. */
  chain: readonly string[]
}

export interface MeSites {
  /** The singleton type that holds site-level fields, or null. */
  settings: string | null
  /** `*` + `admin`: the registry, users and tokens are theirs. */
  platform: boolean
  /** The caller's own grants, by scope. Empty under `auth: 'open'`. */
  grants: Grants
  scopes: MeScope[]
  previewable: MePreview[]
}

/**
 * `grants` is null under `auth: 'open'`, where every scope is editable by whoever
 * reaches the admin (`createFolio` warns): every role is `admin` and every site is
 * previewable.
 */
export function meSites(
  registry: Registry,
  grants: Grants | null,
  settings: string | undefined,
): MeSites {
  const roleOn = (scope: string): Role | null =>
    grants === null ? 'admin' : effectiveRole(grants, registry, scope)

  const candidates: Omit<MeScope, 'role'>[] = [
    // No `shared` on a deployment with `brands` (`multi-brand.md` decision 5):
    // offered anyway, it would be a scope every platform admin could pick and that
    // answers 404 to every call.
    ...(registry.shared
      ? [
          {
            id: SHARED_SCOPE,
            name: 'Shared',
            kind: 'shared' as const,
            group: null,
            chain: chain(registry, SHARED_SCOPE),
            status: null,
            preview: null,
          },
        ]
      : []),
    ...registry.groups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: 'group' as const,
      group: null,
      chain: chain(registry, g.id),
      status: null,
      preview: null,
    })),
    ...registry.sites.map((s) => ({
      id: s.id,
      name: s.name,
      kind: 'site' as const,
      group: s.group,
      chain: chain(registry, s.id),
      status: s.status,
      preview: s.preview,
    })),
  ]

  const scopes: MeScope[] = []
  for (const candidate of candidates) {
    const role = roleOn(candidate.id)
    if (role !== null) scopes.push({ ...candidate, role })
  }

  const previewable: MePreview[] = registry.sites
    .filter((s) => grants === null || previewEligible(grants, chain(registry, s.id)))
    .map((s) => ({
      id: s.id,
      name: s.name,
      preview: s.preview,
      status: s.status,
      chain: chain(registry, s.id),
    }))

  return {
    settings: settings ?? null,
    platform: grants === null || grants[ALL_SCOPES] === 'admin',
    grants: grants ?? {},
    scopes,
    previewable,
  }
}
