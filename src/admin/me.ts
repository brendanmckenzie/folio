/**
 * Who the admin thinks it is, and what that lets it show.
 *
 * `GET /folio/me` answers this, once per load. The predicates below are pure and
 * are the admin's *only* source of truth about permissions — the server is the
 * authority (`identity-and-access.md` architecture decision 5), so everything
 * here is about not offering an affordance the server will refuse, never about
 * enforcement. The reject path has to be correct even when this is wrong.
 */
import type { AuthPolicy } from '../server/auth/config'
import { atLeast, type Role, type Scope } from '../server/auth/roles'

export interface MeUser {
  kind: 'user'
  id: string
  name: string
  colour: string
  role: Role
}

export interface MeToken {
  kind: 'token'
  id: string
  name: string
  scopes: Scope[]
}

export interface Me {
  /** `'open'` is a deployment with no accounts at all. */
  mode: 'open' | 'session'
  actor: MeUser | MeToken | null
  /**
   * Where "sign in" goes.
   *
   * **Always populated by `GET /folio/me`**, including under `auth: 'open'` — the
   * route builds it from `rt.base` unconditionally. The `''` below is only the
   * pre-boot guess, so it is not a discriminator for the auth mode: read `mode` for
   * that. This comment said the opposite until a screen tried to tell a real `open`
   * response from the optimistic default by looking here, which works by accident.
   */
  loginUrl: string
  /**
   * The sign-in providers and session policy, for the Settings screen
   * (`../../docs/ui-architecture.md` decision 6). Absent under `auth: 'open'`,
   * and absent from `OPEN` below because that is a guess made before any response.
   *
   * **On this response and not on the manifest, deliberately.** `GET
   * {base}/api/schema` is ungated, and `provision` plus `linksPerHour` describe a
   * security decision rather than a declaration — see `server/auth/config.ts`'s
   * `AuthPolicy` for the argument and `server/app.ts` for the rule. This route
   * already refuses an unauthenticated caller in session mode, so the block needed
   * no gate of its own.
   *
   * Nothing here is a permission, so none of the predicates below read it: it is
   * the answer to "what is this site configured as", which is a different question
   * from "what may I do".
   */
  policy?: AuthPolicy
}

/**
 * What the admin assumes before `/folio/me` answers, and what it keeps on an
 * `auth: 'open'` deployment.
 *
 * `mode: 'open'` as the *optimistic* default is deliberate: the alternative —
 * assuming a session and rendering everything disabled until a fetch lands —
 * makes the editor flicker into life read-only on every load, which reads as a
 * bug on the one deployment shape where permissions do not exist.
 */
export const OPEN: Me = { mode: 'open', actor: null, loginUrl: '' }

const asUser = (me: Me): MeUser | null => (me.actor?.kind === 'user' ? me.actor : null)

/** May they change a document's contents? */
export function canEdit(me: Me): boolean {
  if (me.mode === 'open') return true
  const user = asUser(me)
  // A token is not a person with a cursor; it never drives the admin, and the
  // socket refuses it outright (4004).
  return user !== null && atLeast(user.role, 'editor')
}

/** May they publish, unpublish or checkpoint? */
export function canPublish(me: Me): boolean {
  if (me.mode === 'open') return true
  const user = asUser(me)
  return user !== null && atLeast(user.role, 'publisher')
}

/**
 * May they create a document, including by duplicating one?
 *
 * `editor`, matching `CREATE` on the server. A new document is an unpublished
 * draft at a path nothing links to yet, so starting one withdraws nothing.
 * Changing or removing an existing URL is `canManageContent`.
 */
export function canCreateContent(me: Me): boolean {
  return canEdit(me)
}

/** May they delete, move or rename a document, or add a redirect? */
export function canManageContent(me: Me): boolean {
  return canPublish(me)
}

/**
 * May they manage editors and tokens? Never under `auth: 'open'`, where the
 * surface does not exist server-side either (it 404s), so offering the rail would
 * be offering a broken screen.
 */
export function canManageAccess(me: Me): boolean {
  const user = asUser(me)
  return me.mode === 'session' && user !== null && user.role === 'admin'
}

/** The label for the user menu, or null when there is nobody to name. */
export function actorLabel(me: Me): string | null {
  if (me.actor?.kind === 'user') return me.actor.name
  if (me.actor?.kind === 'token') return `token:${me.actor.name}`
  return null
}

/** The reason an affordance is disabled, for a `title`, or undefined when it is
 * not. Worth its own function: "why is this greyed out" with no answer is the
 * most annoying possible version of a permissions system. */
export function whyNot(me: Me, need: 'edit' | 'create' | 'publish' | 'manage'): string | undefined {
  const user = asUser(me)
  if (me.mode === 'open') return undefined
  if (!user) return 'Sign in to make changes'
  // 'create' rides on canEdit: an editor may start a document even though they
  // may not move or delete one, so a refusal here means read-only, not "cannot
  // publish".
  const allowed = need === 'edit' || need === 'create' ? canEdit(me) : canPublish(me)
  if (allowed) return undefined
  if (need === 'edit' || need === 'create') return `Your role (${user.role}) is read-only`
  return need === 'publish'
    ? `Your role (${user.role}) may not publish`
    : `Your role (${user.role}) may not move or delete documents`
}

/**
 * Reads `/folio/me`. Never throws: a deployment that cannot answer it is treated
 * as open rather than as locked, because the routes are the authority and the
 * only cost of guessing wrong here is an affordance the server then refuses.
 */
export async function fetchMe(apiBase: string, base: string): Promise<Me> {
  try {
    const res = await fetch(`${apiBase}/me`)
    if (res.status === 401) {
      // `base`, not `apiBase`: the sign-in flow is HTML on the bare mount, and a
      // 401 is the one path that has to build this URL itself rather than reading
      // the `loginUrl` a 200 carries.
      return { mode: 'session', actor: null, loginUrl: `${base}/login` }
    }
    if (!res.ok) return OPEN
    return (await res.json()) as Me
  } catch {
    return OPEN
  }
}
