/**
 * The Access screen's arithmetic: who may see it, what a scope *means*, which
 * scopes a chosen set already implies, and what the screen's one navigational
 * state looks like in a URL.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's decisions have to live somewhere a Node
 * test can reach. `content-model.ts` and `documents-model.ts` are the pattern and
 * this is the third instance.
 *
 * The bulk of it is the **scope vocabulary**, and that is not incidental. The
 * surface this replaces rendered scope selection as six 11px checkboxes in two
 * ragged columns, each labelled with its identifier and nothing else
 * (`admin/Access.tsx`), which had two faults rather than one: it never said what a
 * scope *does*, and it never said that ticking `content:write` already grants
 * `content:read` and `content:read:draft`. The second is the worse one — the
 * implication table is real, lives in `auth/roles.ts`, and a UI that hides it
 * makes a person tick three boxes to express one intention and then stores a
 * redundant list.
 */
import type { Role, Scope } from '../../../server/auth/roles'
import { ROLES, SCOPES, hasScope } from '../../../server/auth/roles'
import type { TokenRow } from '../../../server/auth/tokens'
import type { Me, MeUser } from '../../me'
import type { BadgeTone } from '../Badge'
import { when } from './content-rows'

/* -------------------------------------------------------------------- rows --- */

/**
 * An editor as `GET {base}/api/users` answers one — the route's own `toJson`,
 * which includes the address deliberately: an admin managing access needs it, and
 * a user row holds no secret.
 */
export interface AccessUser {
  id: string
  email: string
  name: string
  role: Role
  /** Null in the database; the server derives one for presence. Shown as a dot,
   * which is the only place a user's presence hue is visible outside a live
   * editing session. */
  colour: string | null
  /** How they last signed in, or null for somebody who never has. */
  provider: string | null
  createdAt: number
  lastSeenAt: number | null
}

/* --------------------------------------------------------------- the gate --- */

/**
 * Why this screen is or is not usable, as four cases rather than a boolean.
 *
 * `canManageAccess` in `admin/me.ts` already answers the boolean, and it is what
 * gates the sidebar entry (`ui/nav.ts`). A boolean is the wrong shape *inside* the
 * screen, though, because the URL is reachable by hand and the three refusals have
 * nothing in common: `auth: 'open'` is a deployment with no accounts at all — the
 * routes behind this screen 404 rather than 403 — while a viewer is a person whose
 * role is too weak, and neither is "not signed in".
 *
 * Rendering two empty tables in any of the three would be the worst answer, since
 * an empty table reads as "there are no editors" rather than "you are not being
 * told". `## Cross-cutting`'s rule is that a persistent condition is a banner in
 * flow, and a banner needs to know *which* condition.
 */
export type AccessGate =
  | { kind: 'ok'; self: MeUser }
  | { kind: 'open' }
  | { kind: 'anonymous'; loginUrl: string }
  | { kind: 'refused'; reason: string }

export function accessGate(me: Me): AccessGate {
  if (me.mode === 'open') return { kind: 'open' }
  if (me.actor === null) return { kind: 'anonymous', loginUrl: me.loginUrl }
  // A token never drives the admin — `canManageAccess` refuses one for the same
  // reason the socket does (4004): a token is not a person with a cursor. Worth
  // saying rather than falling through to the role branch, which would have to
  // invent a role a token does not have.
  if (me.actor.kind === 'token') {
    return {
      kind: 'refused',
      reason:
        'This session is authenticated by an API token. Sign in as an admin to manage access.',
    }
  }
  if (me.actor.role !== 'admin') {
    // Deliberately the same sentence shape as `refusalOf` on the server, so the
    // pre-emptive explanation and the 403 that would follow read alike.
    return {
      kind: 'refused',
      reason: `Your role (${me.actor.role}) may not manage editors or tokens; admin is required.`,
    }
  }
  return { kind: 'ok', self: me.actor }
}

/* ---------------------------------------------------------------- yourself --- */

export function isSelf(userId: string, selfId: string): boolean {
  return userId === selfId
}

/**
 * Why the screen refuses to remove your own account.
 *
 * `DELETE /users/:id` refuses this server-side too, so the button would be one
 * that always errors — but the reason is worth stating before the click rather
 * than after: it is the one delete that can leave a site with no way to manage
 * access at all, and the recovery is a `wrangler d1 execute` against production.
 */
export const SELF_REMOVE_REASON = 'You cannot remove your own account'

/**
 * Why the screen refuses to change your own role.
 *
 * **This one the server does not refuse**, and that asymmetry is the reason it is a
 * named constant rather than an inline string. `PATCH /users/:id` will happily
 * demote the last admin to `viewer`, and it then *revokes their sessions* — so the
 * lockout is the same one self-delete is guarded against, reached by a control that
 * looks reversible. Held in the UI here because the screen can hold it; recorded as
 * a server gap rather than fixed by reflex, since a route change is a wider blast
 * radius than this screen.
 */
export const SELF_ROLE_REASON = 'You cannot change your own role'

/** The roles a `<select>` offers, weakest first — `ROLES`' own order, which is the
 * order the permission table in `identity-and-access.md` reads in. */
export const ROLE_OPTIONS: readonly Role[] = ROLES

/**
 * What a role lets somebody do, in one line, from `identity-and-access.md`
 * decision 5's table plus the owner's 2026-07-30 split of *create* out to
 * `editor`.
 *
 * Beside the `<select>` rather than in a tooltip: "publisher" is not a word whose
 * powers anybody guesses correctly, and the difference between `editor` and
 * `publisher` is the one that matters most and is least visible.
 */
export const ROLE_MEANING: Record<Role, string> = {
  viewer: 'Reads drafts. Changes nothing.',
  editor: 'Writes documents and starts new ones. Cannot publish, move or delete.',
  publisher: 'Everything an editor does, plus publish, move, rename and delete.',
  admin: 'Everything, including managing editors and tokens.',
}

/* ------------------------------------------------------------------ scopes --- */

/**
 * What each scope actually permits, in the words a person minting a token would
 * use.
 *
 * `label` replaces the identifier as the control's name and the identifier moves to
 * a mono badge beside it — `docs/design-system.md`'s third commitment says
 * identifiers are typographic citizens, not that they are labels. `content:read:draft`
 * is the case that proves it: as a checkbox label it is unreadable, and as
 * "Read drafts — unpublished work in progress" it is obvious.
 */
export const SCOPE_MEANING: Record<Scope, { label: string; description: string }> = {
  'content:read': {
    label: 'Read published content',
    description: 'Everything the public site can see, and nothing that is unpublished.',
  },
  'content:read:draft': {
    label: 'Read drafts',
    description: 'Unpublished work in progress, as an editor sees it.',
  },
  'content:write': {
    label: 'Write content',
    description: 'Create and change documents. Does not make anything live.',
  },
  publish: {
    label: 'Publish',
    description: 'Make a draft live, take a page down, and set checkpoints.',
  },
  'assets:write': {
    label: 'Manage media',
    description: 'Upload, rename and delete files in the media library.',
  },
  admin: {
    label: 'Manage access',
    description: 'Invite editors, change roles, and mint or revoke tokens.',
  },
}

/** The order the individual scopes are offered in: weakest first, so the list
 * reads as a ramp and `admin` — which grants all of it — is last. `SCOPES`' own
 * declaration order already is that ramp. */
export const SCOPE_OPTIONS: readonly Scope[] = SCOPES

/**
 * A named shape of access, which is what a person minting a token actually has in
 * mind — "an import script", not "content:write plus assets:write".
 *
 * Five, and each names a real caller rather than a tidy subset of the scope list.
 * `docs/ui-architecture.md`'s brief for this screen is that scope selection
 * "becomes a real control", and a preset is the control; the individual scopes stay
 * reachable behind a disclosure, because a preset that cannot be departed from is a
 * cage rather than a shortcut.
 */
export interface TokenPreset {
  id: string
  label: string
  /** What kind of thing holds a token like this. */
  description: string
  scopes: readonly Scope[]
  /** Marks the preset that grants everything, so it can carry a red edge rather
   * than sitting fifth in a list of equals. */
  danger?: boolean
}

export const CUSTOM_PRESET = 'custom'

export const TOKEN_PRESETS: readonly TokenPreset[] = [
  {
    id: 'read',
    label: 'Read published content',
    description: 'A downstream renderer, a static build, a search indexer.',
    scopes: ['content:read'],
  },
  {
    id: 'preview',
    label: 'Read drafts',
    description: 'A preview deployment that has to see unpublished work.',
    scopes: ['content:read:draft'],
  },
  {
    id: 'import',
    label: 'Import and edit',
    description: 'A migration or an import script. Writes documents and uploads media.',
    scopes: ['content:write', 'assets:write'],
  },
  {
    id: 'publish',
    label: 'Write and publish',
    description: 'A scheduled publisher or a deploy hook. Everything but managing access.',
    scopes: ['content:write', 'publish', 'assets:write'],
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'Everything, including minting and revoking tokens. Prefer a narrower token.',
    scopes: ['admin'],
    danger: true,
  },
]

/** The preset a fresh dialog opens on. The narrowest one there is, so the lazy
 * path produces the least dangerous token rather than the most useful one — the
 * same choice `admin/Access.tsx`'s `DEFAULT_SCOPES` made and the one thing about
 * its scope control that was right. */
export const DEFAULT_PRESET = 'read'

/**
 * Every scope a selection actually grants, implications included.
 *
 * `hasScope` is the server's own predicate over `auth/roles.ts`'s `IMPLIES` table,
 * so this cannot drift from what a token will really be allowed to do — which is
 * the whole point of asking it rather than restating the table here.
 */
export function effectiveScopes(selected: readonly Scope[]): Scope[] {
  return SCOPES.filter((scope) => hasScope(selected, scope))
}

/**
 * Which *other* selected scope already grants this one, or null.
 *
 * This is the fact six independent checkboxes could not express. With
 * `content:write` ticked, `content:read` is granted whether or not its box is
 * ticked, so an unticked box beside it is a lie about what the token will do. The
 * screen renders those as granted, disabled, and naming what grants them.
 */
export function grantedBy(scope: Scope, selected: readonly Scope[]): Scope | null {
  return selected.find((held) => held !== scope && hasScope([held], scope)) ?? null
}

/**
 * The selection with everything redundant dropped: no scope that another selected
 * scope already implies.
 *
 * What gets stored, and it matters beyond tidiness — the tokens table renders the
 * scope list per row, so a token minted as "write and publish" should read
 * `content:write publish assets:write` rather than six badges of which three are
 * consequences. The server stores what it is given (`createToken` JSON-encodes the
 * array verbatim), so minimal here is minimal forever.
 */
export function minimalScopes(selected: readonly Scope[]): Scope[] {
  const unique = SCOPES.filter((scope) => selected.includes(scope))
  return unique.filter((scope) => grantedBy(scope, unique) === null)
}

/**
 * Ticking or unticking one box, canonicalised through `minimalScopes`.
 *
 * Only boxes whose state is genuinely their own ever reach this: a scope another
 * selection already implies is rendered granted and disabled, because unticking
 * `content:read` while `content:write` is held would be asking for a token that
 * cannot exist.
 */
export function toggleScope(selected: readonly Scope[], scope: Scope): Scope[] {
  const next = selected.includes(scope) ? selected.filter((s) => s !== scope) : [...selected, scope]
  return minimalScopes(next)
}

/**
 * Which preset a selection is, or `custom`.
 *
 * Compared over the minimal form on both sides, which is what makes the radio
 * group and the checkboxes agree: hand-ticking `content:write` and `assets:write`
 * selects *Import and edit*, because those two sets mint the same token and telling
 * them apart would be a distinction with no consequence.
 */
export function presetOf(selected: readonly Scope[]): string {
  const mine = minimalScopes(selected)
  const match = TOKEN_PRESETS.find((preset) => sameScopes(minimalScopes(preset.scopes), mine))
  return match?.id ?? CUSTOM_PRESET
}

/** Set equality over two already-minimal lists. Both come out of `minimalScopes`,
 * which filters `SCOPES` in declaration order, so order is not a variable and a
 * length-plus-membership check is exact. */
function sameScopes(a: readonly Scope[], b: readonly Scope[]): boolean {
  return a.length === b.length && a.every((scope) => b.includes(scope))
}

/** The scopes a preset id means, or null for `custom` and for an id nothing
 * declares — a URL or a stale render must not be able to name a sixth preset. */
export function scopesOfPreset(id: string): readonly Scope[] | null {
  return TOKEN_PRESETS.find((preset) => preset.id === id)?.scopes ?? null
}

/** A token with no scopes cannot be minted: `TokenCreateBody` requires at least
 * one and answers 400 otherwise, so the button says so before the request. */
export function mintRefusal(name: string, scopes: readonly Scope[]): string | undefined {
  if (!name.trim()) return 'Give the token a name first'
  if (scopes.length === 0) return 'Choose at least one thing this token may do'
  return undefined
}

/* ------------------------------------------------------------------ tokens --- */

export type TokenStatus = 'active' | 'expired' | 'revoked'

/**
 * A token's real state, which is three things and not the one boolean the old rail
 * showed (`revoked` or a last-used date).
 *
 * `expired` is the case that was missing and it is not cosmetic: `readToken`
 * refuses an expired token exactly as it refuses a revoked one, so a row reading
 * "last used 3d ago" with no further comment describes a credential that stopped
 * working in between.
 */
export function tokenStatus(
  row: Pick<TokenRow, 'revokedAt' | 'expiresAt'>,
  now: number = Date.now(),
): TokenStatus {
  if (row.revokedAt !== null) return 'revoked'
  if (row.expiresAt !== null && row.expiresAt <= now) return 'expired'
  return 'active'
}

/**
 * One tone per status, from `docs/design-system.md`'s state palette.
 *
 * **`active` is neutral, not green.** The rule is that a hue means one thing and
 * green means "complete"; the deeper rule is commitment 1 — colour is reserved for
 * state, so the *normal* case is grey and the two that need looking at are the ones
 * that carry a hue. Red for a deliberate withdrawal, amber for one that lapsed:
 * amber is drift and history, and an expiry is history.
 */
export function tokenStatusTone(status: TokenStatus): BadgeTone {
  switch (status) {
    case 'revoked':
      return 'danger'
    case 'expired':
      return 'warn'
    case 'active':
      return 'neutral'
  }
}

/** Why Revoke is refused: a revoked token cannot be revoked again (the route
 * answers 404 for it, since its `update` matches `revoked_at is null`). An expired
 * one still can be, and should be — expiry is not revocation, and the hash is only
 * permanently spent once `revoked_at` is set. */
export function revokeRefusal(row: Pick<TokenRow, 'revokedAt'>): string | undefined {
  return row.revokedAt === null ? undefined : 'This token is already revoked'
}

/** How long a fresh token lives. Offered as a small set rather than a number
 * field: `expiresInDays` accepts 1–3650 and nobody wants to type `90`. */
export const EXPIRY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
]

/** The `expiresInDays` a chosen option means, absent for "never" — which is the
 * shape `TokenCreateBody` wants, where the key being missing is what says
 * "no expiry". */
export function expiryDays(value: string): number | undefined {
  const days = Number(value)
  return Number.isInteger(days) && days > 0 ? days : undefined
}

/* --------------------------------------------------------------- stamps --- */

/**
 * A timestamp column, or `never`.
 *
 * `when` from `content-rows.ts` rather than a second coarsening: "3d ago, then a
 * date past a month" is a decision that screen already made and pinned with a
 * test, and a list of editors wants the same reading. The adapter is the `null`
 * case, which a story never has and a `last_seen_at` usually does — and `never` is
 * the whole answer for an invited account nobody has signed into yet.
 */
export function since(at: number | null, now?: number): string {
  return at === null ? 'never' : when({ updatedAt: at, draftUpdatedAt: null }, now)
}

/* --------------------------------------------------------------------- URL --- */

/**
 * The one navigational state on this screen: which creation dialog is open.
 *
 * Access has no filter and no sort, so this is the only thing on it that is a
 * *place* — and it is one. `{base}/access?new=token` is a link to "mint a token",
 * which is the design system's first principle applied to a dialog rather than
 * dodged because a dialog feels ephemeral: the editor's `?panel=history` already
 * settles that an overlay you deliberately opened belongs in the URL. What stays
 * out is the minted secret, which is never navigational and never in a link.
 *
 * The paging cursors stay out too, matching `useDocuments`: a cursor is opaque, it
 * is meaningless without the stack that makes *previous* a pop, and a link into the
 * middle of a keyset would arrive with no way back.
 */
export type AccessDialog = 'user' | 'token'

export interface AccessUrl {
  open: AccessDialog | null
}

export function parseAccessUrl(query: Readonly<Record<string, string>>): AccessUrl {
  return { open: query.new === 'user' || query.new === 'token' ? query.new : null }
}

export function accessQuery(url: AccessUrl): Record<string, string | undefined> {
  return { new: url.open ?? undefined }
}
