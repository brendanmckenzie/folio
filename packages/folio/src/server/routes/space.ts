/**
 * The space channel's upgrade route (`live-collaboration.md`).
 *
 * One route, and it is a WebSocket upgrade, so it follows `editor.ts`'s
 * discipline rather than `requireAccess`'s: every refusal is an
 * accept-then-close with an application code, because a plain HTTP failure is
 * indistinguishable on the wire from a dropped upgrade and leaves the client
 * reconnecting on a backoff forever.
 */
import { Hono } from 'hono'
import { type SocketIdentity, withIdentity } from '../auth/identity'
import { CLOSE_FORBIDDEN, CLOSE_UNAUTHENTICATED } from '../sockets'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'

/**
 * Accepts the upgrade and immediately closes with an application code. The same
 * pattern, and the same reasoning, as `editor.ts`'s `refuseSocket`; duplicated
 * rather than shared because it is four lines and lives beside the route whose
 * refusals it is about.
 */
function refuseSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair()
  pair[1]!.accept()
  pair[1]!.close(code, reason)
  return new Response(null, { status: 101, webSocket: pair[0] })
}

export function spaceRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Any role, including `viewer`: seeing who else is in the site is not an
   * editing capability, and a viewer already gets the story socket
   * (`identity-and-access.md`'s resolved open question).
   *
   * A **token** does not, for exactly the reason it cannot open the sync socket
   * (4004): a token is a script, and presence is a person with a cursor. A
   * script in the avatar list would be a name nobody can talk to.
   *
   * A host with no `space` binding gets a 426 rather than a close code. The admin
   * is told through its bootstrap and never opens this socket at all, so reaching
   * here without the binding means something hand-made, and a status code is the
   * honest answer to it.
   */
  app.get('/space/socket', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
    const bindings = c.var.bindings()
    const space = rt.space(bindings)
    if (!space) return c.text('The space channel is not configured', 426)

    let identity: SocketIdentity | null = null
    if (rt.auth.mode === 'session') {
      const actor = c.var.actor
      if (!actor) return refuseSocket(CLOSE_UNAUTHENTICATED, 'not signed in')
      if (actor.kind !== 'user') {
        return refuseSocket(CLOSE_FORBIDDEN, 'an API token cannot appear in presence')
      }
      identity = {
        actor: actor.id,
        name: actor.name,
        colour: actor.colour,
        role: actor.role,
        session: actor.session,
        expiresAt: actor.expiresAt,
      }
    }

    // `withIdentity` always sets or deletes the header, never leaves it: this
    // forwards the client's own request, so a conditional set would let a client
    // assert an identity by sending the header itself — which on this channel
    // would put a chosen name on every screen in the site.
    return space.fetch(withIdentity(c.req.raw, identity))
  })

  return app
}
