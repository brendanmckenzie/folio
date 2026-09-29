/**
 * Who someone is, and what that lets them do.
 *
 * Pure predicates over plain data: no D1, no Request, no Hono. The middleware
 * resolves an `Actor` and then asks this file whether it is allowed, so every
 * "may they?" question in the codebase has one implementation and one test
 * (`identity-and-access.md` architecture decision 5).
 */

import { ALL_SCOPES, chain, type Registry, SHARED_SCOPE } from '../../core/sites'

/* ------------------------------------------------------------------ roles --- */

/** Ordered weakest to strongest; `RANK` below is derived from this order. */
export const ROLES = ['viewer', 'editor', 'publisher', 'admin'] as const

export type Role = (typeof ROLES)[number]

const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<
  Role,
  number
>

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x)
}

/**
 * True when `role` is `min` or stronger. Roles are a total order — every
 * stronger role can do everything a weaker one can — which is what lets a route
 * declare a single minimum rather than a set.
 */
export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min]
}

/* ----------------------------------------------------------------- scopes --- */

/**
 * What an API token may do. Deliberately not roles: a token is not a person, so
 * "read published content and nothing else" is a shape of access that no human
 * account ever has, and "manage users" is one no token should be able to grow
 * into by being promoted.
 */
export const SCOPES = [
  'content:read',
  'content:read:draft',
  'content:write',
  'publish',
  'assets:write',
  'forms:read',
  'admin',
] as const

export type Scope = (typeof SCOPES)[number]

export function isScope(x: unknown): x is Scope {
  return typeof x === 'string' && (SCOPES as readonly string[]).includes(x)
}

/**
 * What holding one scope already grants, itself included. Spelled out rather
 * than derived from a hierarchy because the relationships are not a chain:
 * `publish` implies reading the draft it is about to publish, but says nothing
 * about writing one, and `assets:write` implies nothing about content at all.
 */
const IMPLIES: Record<Scope, readonly Scope[]> = {
  admin: [...SCOPES],
  'content:write': ['content:read', 'content:read:draft', 'content:write'],
  publish: ['content:read', 'content:read:draft', 'publish'],
  'content:read:draft': ['content:read', 'content:read:draft'],
  'content:read': ['content:read'],
  'assets:write': ['assets:write'],
  // Reading what strangers typed about themselves is implied by nothing but
  // `admin` (`../../../docs/specs/content-model/forms.md` decision 8): a token
  // that may write content has no business reading a form's responses, and a
  // token minted to push responses into a CRM has no business writing pages.
  'forms:read': ['forms:read'],
}

/** True when any granted scope implies `need`. Total: an unknown grant is ignored. */
export function hasScope(granted: readonly Scope[], need: Scope): boolean {
  return granted.some((s) => IMPLIES[s]?.includes(need) ?? false)
}

/**
 * The scopes a stored JSON array actually grants: anything that is not
 * currently a declared scope is dropped, so removing a scope from the code
 * narrows every token that held it instead of throwing on read.
 */
export function parseScopes(json: string): Scope[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(value) ? value.filter(isScope) : []
}

/* ----------------------------------------------------------------- grants --- */

/**
 * Every grant one person holds, by scope id (`site_roles`,
 * `../../../docs/specs/foundation/multi-site.md` decision 10): a site, a group,
 * `shared`, or `*` for every scope. With no `sites` configured there is exactly one
 * entry, on `*`, which is today's role one table over.
 */
export type Grants = Readonly<Record<string, Role>>

/**
 * The scopes whose grant *writes* scope X: X itself, its group when X is a site in
 * one, and `*`. Never `shared`, unless X is `shared`: a shared-content role is a role
 * on shared content and nothing below it, and nothing flows down for editing.
 */
function writersOf(registry: Registry, scope: string): string[] {
  return [...chain(registry, scope).filter((s) => s !== SHARED_SCOPE || s === scope), ALL_SCOPES]
}

/**
 * The effective role on scope X (decision 10): the highest of the grants on X, on
 * `*`, and (for a site) on its group — and at least `viewer` when any grant's chain
 * reaches X, because **reads flow up the chain; writes never do**. Null when no
 * grant reaches X at all, which `withActor` answers with a 403 naming the scope.
 *
 * An unknown scope has an empty chain, so only a `*` grant reaches it — and
 * `withScope` has already 404'd a scope nobody registered before this is asked.
 */
export function effectiveRole(grants: Grants, registry: Registry, scope: string): Role | null {
  let best: Role | null = null
  for (const writer of writersOf(registry, scope)) {
    const role = grants[writer]
    if (role !== undefined && (best === null || RANK[role] > RANK[best])) best = role
  }
  if (best !== null) return best
  for (const held of Object.keys(grants)) {
    if (held !== ALL_SCOPES && chain(registry, held).includes(scope)) return 'viewer'
  }
  return null
}

/**
 * Whether these grants may preview a site whose chain is `siteChain` (decision 13):
 * `READ_DRAFT` on **any** scope in it, or on `*`. Every role gives `READ_DRAFT`, so
 * holding any grant there is enough. Phase 5's `site/start` asks this, on the one
 * route `withActor` does not refuse for a caller with no role on the site.
 */
export function previewEligible(grants: Grants, siteChain: readonly string[]): boolean {
  return Object.entries(grants).some(
    ([scope, role]) =>
      (scope === ALL_SCOPES || siteChain.includes(scope)) && atLeast(role, READ_DRAFT.role),
  )
}

/** The scopes that are reads, which is all a token keeps up its binding's chain. */
const READ_SCOPES: readonly Scope[] = ['content:read', 'content:read:draft']

/**
 * What a token's scopes are worth on scope X (decisions 11 and 14), or null when its
 * binding does not reach X.
 *
 * Unbound (`site` null) is today's token: every scope it holds, everywhere. Bound, it
 * writes its own scope and — bound to a group — every site in it, exactly as a group
 * grant does; up its binding's chain it keeps only its read scopes ("another scope is
 * a 403 except a read up the binding's chain").
 */
export function tokenScopesOn(
  scopes: readonly Scope[],
  site: string | null,
  registry: Registry,
  scope: string,
): Scope[] | null {
  if (site === null) return [...scopes]
  if (writersOf(registry, scope).includes(site)) return [...scopes]
  if (chain(registry, site).includes(scope)) return READ_SCOPES.filter((s) => hasScope(scopes, s))
  return null
}

/* ------------------------------------------------------------------ actor --- */

export interface UserActor {
  kind: 'user'
  /** `users.id`. This is what lands in `versions.actor` and the DO's log. */
  id: string
  name: string
  colour: string
  role: Role
  /** `sessions.id` — the SHA-256 of the cookie's token, for revocation checks. */
  session: string
  /** Session expiry, epoch ms. Rides in the socket attachment (checkpoint 5). */
  expiresAt: number
  /**
   * `sessions.provider`: which provider minted *this* session, for `/me` to
   * answer and for `foundation/passkeys.md`'s account screen to draw beside each
   * browser. Nothing gates on it.
   *
   * **Optional, unlike `session` and `expiresAt`**, because a `UserActor` is not
   * always a session read: a test builds one to ask a permission question, and
   * "which provider" has no answer there. `readSession` fills it from the join
   * it already runs, so the honest answer costs no extra query.
   */
  provider?: string | null
  /**
   * `users.email` and the `*` grant's `site_roles.role_from`, both filled from the
   * statement `readSession` already runs, so neither costs a query.
   *
   * **Optional for the same reason `provider` is**: a `UserActor` built to ask a
   * permission question has no row behind it. `GET {base}/api/me` projects both so
   * the account screen can show a person their own address and say *why* their role
   * is not editable when an identity provider set it (`foundation/passkeys.md`
   * decision 6). Neither is a new disclosure: it is the caller's own row, answered
   * to the caller.
   */
  email?: string
  roleFrom?: string | null
  /**
   * Every grant the person holds, `*` included (`multi-site.md` decision 10), read
   * in the statement `readSession` already runs. `role` above is the **effective**
   * role on the request's scope, which `withActor` computes from these; the platform
   * tier reads the `*` entry here directly, so a site admin under `~alpha` is never
   * mistaken for a platform admin.
   *
   * **Optional for the same reason `provider` is**: an actor built to ask a
   * permission question has no rows behind it, and then its `role` is the whole
   * answer, platform tier included — exactly what `allows()` answered before grants.
   */
  grants?: Grants
}

export interface TokenActor {
  kind: 'token'
  /** `api_tokens.id`. */
  id: string
  name: string
  /** On a scoped request, what the token's scopes are worth *there*
   * (`tokenScopesOn`): a read up its binding's chain keeps only the read scopes. */
  scopes: readonly Scope[]
  /**
   * `api_tokens.site_id`: the scope the token is bound to, or null for a token
   * bound to none (decision 14). **A bound token is refused by every platform-tier
   * route**, whatever its scopes, and can never be minted with `admin`. Optional on
   * the type, like `UserActor.grants`: absent is unbound, today's token.
   */
  site?: string | null
}

/**
 * A preview grant's holder on a site's preview origin (`multi-site.md` decision
 * 13): a person's session or a token, redeemed through `site/enter`. **It may read
 * the site's chain, published and draft, and nothing else** — no write anywhere, no
 * admin route, no socket — so `allows()` gives it `READ` and `READ_DRAFT` and
 * refuses every other `Access`. Which chain it may read is the fence's to check,
 * against `site`. Spec 23's phase 5 is what resolves a credential to one.
 */
export interface GrantActor {
  kind: 'grant'
  /** `site_grants.id`. */
  id: string
  userId: string | null
  tokenId: string | null
  name: string
  /** The site the grant was minted for, whose chain it reads. */
  site: string
  expiresAt: number
}

/**
 * Who a route sees. **`GrantActor` is not in it yet**: nothing resolves a credential
 * to one until spec 23's phase 5, and joining the union then is that phase's edit
 * (`routes/auth.ts`' `/me` narrows `Actor` to two kinds). `allows()` already
 * answers for it.
 */
export type Actor = UserActor | TokenActor

/**
 * What the activity trail and `versions.actor` record. A token says
 * `token:import-script` rather than naming a person who was not there.
 */
export function actorString(actor: Actor | null): string | null {
  if (!actor) return null
  return actor.kind === 'user' ? actor.id : `token:${actor.name}`
}

/** The display name for presence and history, or null with no actor. */
export function actorName(actor: Actor | null): string | null {
  return actor ? actor.name : null
}

/* ----------------------------------------------------------------- access --- */

/**
 * What one route needs, in both currencies: the minimum role for a signed-in
 * person and the scope for a token. Declared together because they are the same
 * requirement expressed twice, and separating them is how the two drift.
 */
export interface Access {
  role: Role
  scope: Scope
  /**
   * Which role the check reads (`multi-site.md` decision 10). `'scope'` is the
   * effective role on the request's scope — every content act. `'platform'` is the
   * deployment-wide acts — the registry, users, tokens, auth events, reindex,
   * migrate, audit, bulk describe — and reads the `*` grant alone for a person and,
   * for a token, requires it to be bound to nothing.
   */
  tier: 'platform' | 'scope'
}

/** Reading published structure: the tree, the version list, the media library. */
export const READ: Access = { role: 'viewer', scope: 'content:read', tier: 'scope' }

/** Reading a live draft — the editor's own content, before it is published. */
export const READ_DRAFT: Access = { role: 'viewer', scope: 'content:read:draft', tier: 'scope' }

/** Editing a document's contents. The socket's `tx` is the other half of this. */
export const EDIT: Access = { role: 'editor', scope: 'content:write', tier: 'scope' }

/**
 * Creating a document, including by duplicating one.
 *
 * `editor`, deliberately lower than `MANAGE`. The owner overrode the spec's role
 * table here: a new document is an unpublished draft at a path nothing links to
 * yet, so creating one serves nothing and breaks nothing, and "an editor may
 * write a page but not start one" is a strange line to hold. Moving, renaming and
 * deleting stay at `MANAGE` because those act on a URL that may already be live.
 *
 * The token scope is unchanged (`content:write`), so this widens the session path
 * only — a token that could create before still can, and one that could not still
 * cannot.
 */
export const CREATE: Access = { role: 'editor', scope: 'content:write', tier: 'scope' }

/**
 * Deleting, moving or renaming a document, and adding a manual redirect.
 * `publisher`, not `editor`, per the role table: each changes or withdraws a URL
 * the site already serves, which is a publishing act even when nothing is
 * published in the same breath. Creating is `CREATE` — see there for why it split.
 */
export const MANAGE: Access = { role: 'publisher', scope: 'content:write', tier: 'scope' }

/** Publishing, unpublishing and checkpointing. */
export const PUBLISH: Access = { role: 'publisher', scope: 'publish', tier: 'scope' }

/** Uploading, renaming or deleting an asset. */
export const ASSETS: Access = { role: 'editor', scope: 'assets:write', tier: 'scope' }

/**
 * Reading submitted form responses, and downloading the files that came with
 * them (`../../../docs/specs/content-model/forms.md` decision 8).
 *
 * **`publisher`, not `viewer`**, and the gap from `READ` is the point: every
 * other reader in this file is about the site's own content, and these rows are
 * what strangers typed about themselves — a name, an address, a CV. An editor
 * who may write a page is not thereby somebody who may read the enquiries.
 */
export const FORMS: Access = { role: 'publisher', scope: 'forms:read', tier: 'scope' }

/**
 * The deployment-wide acts: editors, tokens, auth events, the site registry,
 * reindex, migrate, audit, bulk describe. **Platform tier** (`multi-site.md`
 * decision 10): `*` + `admin` for a person, the `admin` scope on an unbound token.
 *
 * Platform rather than a new name, so that a use of `ADMIN` nobody re-examined
 * fails closed — a site admin is refused it — rather than open.
 */
export const ADMIN: Access = { role: 'admin', scope: 'admin', tier: 'platform' }

/**
 * `admin` on the request's scope: the content acts that were `ADMIN` before the
 * tiers split — deleting a form, its responses, the CSV. A site's own admin may do
 * these on its own site; they reach no other.
 */
export const SCOPE_ADMIN: Access = { role: 'admin', scope: 'admin', tier: 'scope' }

/** The `*` grant a person holds, or null. An actor with no `grants` — one built to
 * ask a permission question — has only `role`, and that is its answer. */
function platformRole(actor: UserActor): Role | null {
  return actor.grants ? (actor.grants[ALL_SCOPES] ?? null) : actor.role
}

/**
 * Whether this actor may do that. A null actor is never allowed — the
 * `auth: 'open'` bypass lives in the middleware, deliberately, so that this
 * file cannot be the reason an unauthenticated request got through.
 */
export function allows(actor: Actor | GrantActor | null, access: Access): boolean {
  if (!actor) return false
  // A preview grant reads, published and draft, and does nothing else — no tier,
  // no role, no scope beyond those two answers it (decision 13).
  if (actor.kind === 'grant') {
    return access.tier === 'scope' && READ_SCOPES.includes(access.scope) && access.role === 'viewer'
  }
  if (access.tier === 'platform') {
    if (actor.kind === 'token')
      return (actor.site ?? null) === null && hasScope(actor.scopes, access.scope)
    const role = platformRole(actor)
    return role !== null && atLeast(role, access.role)
  }
  return actor.kind === 'user'
    ? atLeast(actor.role, access.role)
    : hasScope(actor.scopes, access.scope)
}

/**
 * Why `actor` was refused, for the error message. Names the missing scope for a
 * token (the spec's token acceptance criterion) and the required role for a
 * person, since neither is guessable from the other end.
 */
export function refusalOf(actor: Actor, access: Access): string {
  if (access.tier === 'platform') {
    if (actor.kind === 'token' && (actor.site ?? null) !== null) {
      return `This token is bound to '${actor.site}'; only an unbound token may do that.`
    }
    // Only for a person holding grants beyond `*`, whose role on some site says
    // nothing about this: "admin is required" to a site's admin would explain
    // nothing. With no `sites` every grant is on `*`, so this never fires there.
    if (actor.kind === 'user' && Object.keys(actor.grants ?? {}).some((s) => s !== ALL_SCOPES)) {
      return `That needs the ${access.role} role on every site; your role everywhere is ${platformRole(actor) ?? 'none'}.`
    }
  }
  return actor.kind === 'token'
    ? `This token is missing the '${access.scope}' scope.`
    : `Your role (${actor.role}) may not do that; ${access.role} is required.`
}
