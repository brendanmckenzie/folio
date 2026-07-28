/**
 * The editor: its HTML page, and the sync socket the client opens from it.
 *
 * Both routes answer an id that names nothing without a JSON envelope, and for
 * different reasons — an HTML route owes a 404 page, and a failed WebSocket
 * upgrade is indistinguishable on the wire from a dropped connection — so neither
 * uses `loadStory`.
 */
import { Hono } from 'hono'
import { adminPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import { listStories, storyById, storyByPath } from '../stories'
import type { FolioEnv } from '../types'
import { isId } from '../validate'

/**
 * Application close code: the story this object backed has been deleted.
 * Mirrors story-do.ts's own (private) constant by hand — a wire constant, not
 * shared code — so a reconnect that discovers the deletion here closes with
 * the identical code a live purge closes with.
 */
const CLOSE_PURGED = 4002

export function editorRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  app.get('/story/:id/socket', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
    const bindings = c.var.bindings()
    const id = c.req.param('id')
    // A malformed id cannot name a story, so it takes the close path below
    // rather than a 400, for the reason documented there.
    const story = isId(id) ? await storyById(bindings.db, id) : null
    if (!story) {
      // A plain HTTP 404 here is indistinguishable, on the wire, from a
      // dropped upgrade: the client's WebSocket only ever sees a failed
      // handshake either way, and reconnects on a backoff forever — a
      // deleted story never comes back, so that backoff never ends. Upgrading
      // anyway and closing with the same application code a live purge uses
      // (see story-do.ts's `purge()`) lets the client's existing terminal
      // handling for that code cover this path too, whether the purge raced a
      // still-open socket or a reconnect discovers the deletion afterwards.
      const pair = new WebSocketPair()
      pair[1].accept()
      pair[1].close(CLOSE_PURGED, 'story deleted')
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    await rt.draftFor(bindings, story)
    // TODO: validate the session here and hand the verified identity to the DO
    // rather than letting the client self-report it in `hello`.
    return rt.stub(bindings, story.id).fetch(c.req.raw)
  })

  app.get('/edit/:id', async (c) => {
    const id = c.req.param('id')
    // An HTML route: an id nothing is behind — malformed or simply gone — is a
    // 404 page, not a JSON envelope.
    const story = isId(id) ? await storyById(c.var.bindings().db, id) : null
    if (!story) return c.notFound()
    return adminPage(rt, story)
  })

  app.get('/edit', async (c) => {
    const db = c.var.bindings().db
    const root = await storyByPath(db, '')
    const first = root ?? (await listStories(db))[0]
    return first ? c.redirect(`${rt.base}/edit/${first.id}`) : c.notFound()
  })

  return app
}
