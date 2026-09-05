/**
 * Roles that come from the directory rather than from a person clicking.
 *
 * `RoleMapper` (`./config.ts`) is a plain function — a host writes whatever it
 * needs, because the shapes are not one shape: Entra's app `roles` claim versus
 * its `groups`, a group *overage* claim that points at a directory API, an
 * Access JWT's `custom` block, a role derived from the email domain. That is
 * `../../../docs/specs/foundation/auth-providers.md` decision 5, and its
 * rejected alternative is a declarative `oidc({ roles: { claim, map } })` DSL
 * that would have covered the first of those four and none of the rest.
 *
 * `roleFromClaim` is the common case written once, so the tenant whose IdP does
 * put a flat list of group names in one claim configures it rather than writes
 * it. It is a *helper that returns a mapper*, not a second mechanism: everything
 * downstream sees a function.
 *
 * **The highest-ranking match wins.** Somebody in `cms-editors` and `cms-admins`
 * is an admin, because the alternative is that their access depends on the order
 * their directory happened to serialise two groups in.
 */
import { type Role, isRole, ROLES } from './roles'
import type { RoleMapper, VerifiedIdentity } from './config'

export interface RoleFromClaimOptions {
  /**
   * Which claim holds the values: `'groups'`, `'roles'`, or a dotted path into a
   * nested object such as `'custom.groups'`. A path segment that is not a plain
   * object stops the walk and answers "no claim", which is the same as absent.
   */
  claim: string
  /** Claim value → role. Every value must be a role this build declares. */
  map: Record<string, Role>
  /**
   * The role for an identity none of `map`'s keys matched. Omitted means `null`,
   * and `null` is not "no opinion": the interaction table in decision 5 treats it
   * as "this identity holds no role here", which refuses a user this same
   * provider previously placed. That is checkpoint 3 — their group was removed,
   * and keeping the stored role would be stale privilege.
   */
  default?: Role
}

/** Weakest to strongest, from `ROLES`' own declaration order. */
const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<
  Role,
  number
>

/**
 * A mapper that reads one claim and looks its values up in a table.
 *
 * Validated **at construction**, the same discipline `resolveAuth` keeps: a
 * `map` naming a role no build declares is a configuration mistake, and the
 * alternative to throwing here is a mapper that returns a non-role at sign-in
 * time — which `completeSignIn` refuses as `error=provider`, three months later,
 * to whichever person happened to be in that group first.
 */
export function roleFromClaim(opts: RoleFromClaimOptions): RoleMapper {
  const path = String(opts.claim ?? '')
    .split('.')
    .filter((segment) => segment !== '')
  if (path.length === 0) {
    throw new Error('folio: roleFromClaim({ claim }) must name a claim')
  }
  for (const [value, role] of Object.entries(opts.map ?? {})) {
    if (!isRole(role)) {
      throw new Error(
        `folio: roleFromClaim maps '${value}' to '${String(role)}', which is not a role`,
      )
    }
  }
  if (opts.default !== undefined && !isRole(opts.default)) {
    throw new Error(`folio: roleFromClaim's default '${String(opts.default)}' is not a role`)
  }
  const fallback = opts.default ?? null

  return (identity: VerifiedIdentity): Role | null => {
    const raw = readPath(identity.claims, path)
    // One value or many: a `groups` claim is an array and a `role` claim is
    // usually a string, and a mapper that only understood one of those would
    // silently ignore half the identity providers there are.
    const values = Array.isArray(raw) ? raw : [raw]
    let best: Role | null = null
    for (const value of values) {
      // A number, a nested object, a null inside the array: not a group name,
      // and not an error either — a directory is allowed to put things in a
      // claim that this mapping has no opinion about.
      if (typeof value !== 'string') continue
      const role = opts.map[value]
      if (role === undefined) continue
      if (best === null || RANK[role] > RANK[best]) best = role
    }
    return best ?? fallback
  }
}

/** Walks a dotted path through plain objects. Anything else — an array, a
 * string, a null — stops the walk, because there is nothing further to read. */
function readPath(claims: Readonly<Record<string, unknown>> | undefined, path: string[]): unknown {
  let cursor: unknown = claims
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Why a role cannot be edited here, naming the provider that placed it.
 *
 * One sentence, in one place, because it is said twice: `PATCH {base}/api/users/:id`
 * answers it as a `409` (decision 5, checkpoint 2) and the Access screen puts it
 * on the disabled `<select>` before anybody clicks. The admin's usual rule is
 * that a control a person cannot use is *absent* rather than disabled — here the
 * reason is the whole message, and a missing role column would say nothing about
 * where the role actually comes from.
 */
export function roleSetByReason(provider: string): string {
  return `Their role is set by ${provider}. Change it there.`
}
