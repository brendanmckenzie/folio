/**
 * The editor: its HTML page, and the sync socket the client opens from it.
 *
 * Both routes answer an id that names nothing without a JSON envelope, and for
 * different reasons — an HTML route owes a 404 page, and a failed WebSocket
 * upgrade is indistinguishable on the wire from a dropped connection — so neither
 * uses `loadStory`.
 */
import { Hono } from 'hono'
import { type SocketIdentity, withIdentity } from '../auth/identity'
import { READ_DRAFT } from '../auth/roles'
import { requireHtmlAccess } from '../middleware'
import { adminPage, previewPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import { ensureSingleton, listStories, storyById, storyByPath } from '../stories'
import type { FolioEnv } from '../types'
import { isId } from '../validate'

/**
 * Application close codes, mirroring story-do.ts's own (private) constants by
 * hand — wire constants, not shared code — so a refusal decided here closes with
 * the identical code the object itself would use.
 *
 * `CLOSE_PURGED`: the story this object backed has been deleted.
 * `CLOSE_UNAUTHENTICATED`: no session, or one that has ended.
 * `CLOSE_FORBIDDEN`: a valid credential that may not hold an editing session.
 */
const CLOSE_PURGED = 4002
const CLOSE_UNAUTHENTICATED = 4003
const CLOSE_FORBIDDEN = 4004

/**
 * Accepts the upgrade and immediately closes with an application code.
 *
 * A plain HTTP failure here is indistinguishable, on the wire, from a dropped
 * upgrade: the client's WebSocket only ever sees a failed handshake either way,
 * and reconnects on a backoff forever — which for a deleted story or an expired
 * session is a backoff that never ends. Upgrading anyway and closing with a code
 * the client treats as terminal is the pattern this route already used for a
 * purged story, and every refusal below now shares it.
 */
function refuseSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair()
  pair[1]!.accept()
  pair[1]!.close(code, reason)
  return new Response(null, { status: 101, webSocket: pair[0] })
}

export function editorRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * The sync socket. Deliberately **not** behind `requireAccess`: every refusal
   * on this route is an upgrade-then-close rather than a status code, for the
   * reason `refuseSocket` documents.
   *
   * A `viewer` does get a socket (the spec's one open question, resolved as
   * specified): read-only through the socket is how they watch live changes, and
   * the object refuses their `tx` frames with the existing `reject` envelope. The
   * accepted cost is that a viewer holds an editing session and appears in
   * presence.
   *
   * A *token* does not. A token is a script, and an editing session is a person
   * with a cursor; 4004 says so rather than pretending the credential is unknown.
   */
  app.get('/story/:id/socket', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
    const bindings = c.var.bindings()
    const id = c.req.param('id')
    // A malformed id cannot name a story, so it takes the close path below
    // rather than a 400, for the reason documented above.
    const story = isId(id) ? await storyById(bindings.db, id) : null
    if (!story) return refuseSocket(CLOSE_PURGED, 'story deleted')

    // The verified identity handed to the object, or null under `auth: 'open'`,
    // where `hello`'s self-report is the only identity there is.
    let identity: SocketIdentity | null = null
    if (rt.auth.mode === 'session') {
      const actor = c.var.actor
      if (!actor) return refuseSocket(CLOSE_UNAUTHENTICATED, 'not signed in')
      if (actor.kind !== 'user') {
        return refuseSocket(CLOSE_FORBIDDEN, 'an API token cannot open an editing session')
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

    await rt.draftFor(bindings, story)
    // `withIdentity` always sets or deletes the header, never leaves it: this
    // forwards the client's own request, so a conditional set would let a client
    // assert an identity by sending the header itself.
    return rt.stub(bindings, story.id).fetch(withIdentity(c.req.raw, identity))
  })

  app.get('/edit/:id', requireHtmlAccess<Env>(rt, READ_DRAFT), async (c) => {
    const id = c.req.param('id')
    // An HTML route: an id nothing is behind — malformed or simply gone — is a
    // 404 page, not a JSON envelope. Checked *before* the bindings are taken, so
    // an id that cannot name a story never touches the host's environment
    // (test/workers/app.test.ts pins exactly this).
    if (!isId(id)) return c.notFound()
    const bindings = c.var.bindings()
    const story = await storyById(bindings.db, id)
    if (!story) return c.notFound()
    return adminPage(rt, bindings, story)
  })

  app.get('/edit', requireHtmlAccess<Env>(rt, READ_DRAFT), async (c) => {
    const db = c.var.bindings().db
    const root = await storyByPath(db, '')
    const first = root ?? (await listStories(db))[0]
    return first ? c.redirect(`${rt.base}/edit/${first.id}`) : c.notFound()
  })

  /**
   * The bare preview for a singleton with no `previewPath` (`globals.md`
   * decision 4): there is no host page to render it in context, so this
   * renders the singleton alone, on the host's own preview stylesheet, with a
   * note explaining why. `ensureSingleton` is fine to call here — an editor
   * opening this route is the "first access" moment, same as `/documents`.
   *
   * Gated like the editor page, not like a published one: what it renders is a
   * live draft.
   */
  app.get('/preview/global/:name', requireHtmlAccess<Env>(rt, READ_DRAFT), async (c) => {
    const name = c.req.param('name')
    const type = rt.typeOf(name)
    if (type?.kind !== 'singleton') return c.notFound()
    const bindings = c.var.bindings()
    const story = await ensureSingleton(bindings.db, type, rt.schemaId)
    return previewPage(rt, bindings, story, { bare: true })
  })

  return app
}
