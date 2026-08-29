/**
 * Who someone is, and what that lets them do.
 *
 * Pure predicates over plain data: no D1, no Request, no Hono. The middleware
 * resolves an `Actor` and then asks this file whether it is allowed, so every
 * "may they?" question in the codebase has one implementation and one test
 * (`identity-and-access.md` architecture decision 5).
 */

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
}

export interface TokenActor {
  kind: 'token'
  /** `api_tokens.id`. */
  id: string
  name: string
  scopes: readonly Scope[]
}

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
}

/** Reading published structure: the tree, the version list, the media library. */
export const READ: Access = { role: 'viewer', scope: 'content:read' }

/** Reading a live draft — the editor's own content, before it is published. */
export const READ_DRAFT: Access = { role: 'viewer', scope: 'content:read:draft' }

/** Editing a document's contents. The socket's `tx` is the other half of this. */
export const EDIT: Access = { role: 'editor', scope: 'content:write' }

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
export const CREATE: Access = { role: 'editor', scope: 'content:write' }

/**
 * Deleting, moving or renaming a document, and adding a manual redirect.
 * `publisher`, not `editor`, per the role table: each changes or withdraws a URL
 * the site already serves, which is a publishing act even when nothing is
 * published in the same breath. Creating is `CREATE` — see there for why it split.
 */
export const MANAGE: Access = { role: 'publisher', scope: 'content:write' }

/** Publishing, unpublishing and checkpointing. */
export const PUBLISH: Access = { role: 'publisher', scope: 'publish' }

/** Uploading, renaming or deleting an asset. */
export const ASSETS: Access = { role: 'editor', scope: 'assets:write' }

/** Managing editors and tokens. */
export const ADMIN: Access = { role: 'admin', scope: 'admin' }

/**
 * Whether this actor may do that. A null actor is never allowed — the
 * `auth: 'open'` bypass lives in the middleware, deliberately, so that this
 * file cannot be the reason an unauthenticated request got through.
 */
export function allows(actor: Actor | null, access: Access): boolean {
  if (!actor) return false
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
  return actor.kind === 'token'
    ? `This token is missing the '${access.scope}' scope.`
    : `Your role (${actor.role}) may not do that; ${access.role} is required.`
}
