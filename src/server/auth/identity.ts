/**
 * The verified identity the Worker hands the Durable Object on a socket upgrade.
 *
 * Why a header is trustworthy here, when `hello`'s identity fields never were:
 * a Durable Object namespace is not publicly addressable. The only way to reach
 * the object is through this Worker, and this Worker sets the header itself —
 * `withIdentity` **always** overwrites or removes whatever the client sent, which
 * is the whole security argument and the one line that must never be softened
 * into a conditional set.
 */
import type { Role } from './roles'

/** Not a stable public name: only `routes/editor.ts` writes it and only
 * `story-do.ts` reads it, and a client's own value is discarded. */
export const IDENTITY_HEADER = 'x-folio-identity'

export interface SocketIdentity {
  /** `users.id`. What the mutation log records and presence broadcasts. */
  actor: string
  name: string
  /** Already resolved: the row's colour, or `fallbackColour(id)`. The object
   * never has to derive one, so a peer's colour cannot differ by code path. */
  colour: string
  role: Role
  /** `sessions.id`, for the object's periodic revocation re-check. */
  session: string
  /** Session expiry, epoch ms. Checked on every frame (checkpoint 5). */
  expiresAt: number
}

/**
 * Base64url over UTF-8, not raw JSON. A header value is bytes: a display name
 * with an accent in it is fine in a JS string and is *not* reliably fine in an
 * HTTP header, and the failure would be an exception on the upgrade path for
 * some users' names and not others.
 */
export function encodeIdentity(identity: SocketIdentity): string {
  const bytes = new TextEncoder().encode(JSON.stringify(identity))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Total over its input: an unreadable header means "no verified identity",
 * which is exactly what a socket opened under `auth: 'open'` has. */
export function decodeIdentity(raw: string | null | undefined): SocketIdentity | null {
  if (!raw) return null
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SocketIdentity>
    if (
      typeof parsed.actor !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.colour !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.session !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return parsed as SocketIdentity
  } catch {
    return null
  }
}

/**
 * The request that actually reaches the object.
 *
 * The header is set when there is an identity and **deleted** when there is not.
 * Never left alone: `routes/editor.ts` forwards a client's own request to the
 * stub, so a conditional set would let a client under `auth: 'open'` — or an
 * unauthenticated one on a session deployment, in the moment before the refusal
 * — assert whatever identity it liked simply by sending this header itself.
 */
export function withIdentity(req: Request, identity: SocketIdentity | null): Request {
  const headers = new Headers(req.headers)
  if (identity) headers.set(IDENTITY_HEADER, encodeIdentity(identity))
  else headers.delete(IDENTITY_HEADER)
  // Rebuilt from the URL rather than cloned: this is a GET upgrade with no body,
  // and the object reads nothing off the request but `Upgrade` and this header.
  return new Request(req.url, { method: req.method, headers })
}
