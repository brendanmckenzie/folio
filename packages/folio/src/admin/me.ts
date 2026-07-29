/**
 * Who the admin thinks it is, and what that lets it show.
 *
 * `GET /folio/me` answers this, once per load. The predicates below are pure and
 * are the admin's *only* source of truth about permissions — the server is the
 * authority (`identity-and-access.md` architecture decision 5), so everything
 * here is about not offering an affordance the server will refuse, never about
 * enforcement. The reject path has to be correct even when this is wrong.
 */
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
  /** Where "sign in" goes. Empty under `auth: 'open'`. */
  loginUrl: string
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

/** May they create, delete, move or rename a document, or add a redirect? */
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
export function whyNot(me: Me, need: 'edit' | 'publish' | 'manage'): string | undefined {
  const user = asUser(me)
  if (me.mode === 'open') return undefined
  if (!user) return 'Sign in to make changes'
  const allowed = need === 'edit' ? canEdit(me) : canPublish(me)
  if (allowed) return undefined
  return need === 'edit'
    ? `Your role (${user.role}) is read-only`
    : `Your role (${user.role}) may not publish`
}

/**
 * Reads `/folio/me`. Never throws: a deployment that cannot answer it is treated
 * as open rather than as locked, because the routes are the authority and the
 * only cost of guessing wrong here is an affordance the server then refuses.
 */
export async function fetchMe(apiBase: string): Promise<Me> {
  try {
    const res = await fetch(`${apiBase}/me`)
    if (res.status === 401) {
      return { mode: 'session', actor: null, loginUrl: `${apiBase}/login` }
    }
    if (!res.ok) return OPEN
    return (await res.json()) as Me
  } catch {
    return OPEN
  }
}
