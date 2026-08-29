import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { blocks, defineBlock, text } from '../../src/core'
import {
  PROTOCOL_VERSION,
  type SpaceEvent,
  type SpaceServerFrame,
  type SpaceServerMsg,
} from '../../src/core/protocol'
import { createFolio, type FolioBindings } from '../../src/server'
import type { SpaceDO } from '../../src/server'

/**
 * Structural events reaching the space channel
 * (`../../docs/specs/editing/live-collaboration.md` decision 4 and phase 3).
 *
 * The property under test is end to end and is the whole point of using the
 * internal-hook seam (`publish-hooks.md` decision 5) rather than a second
 * after-commit path: a mutating route emits **exactly one** event once its D1
 * write has committed, and **none at all** when the write was refused.
 *
 * Own `createFolio` rather than `SELF`, following `app.test.ts`: the thing under
 * test is what the config's own `bindings` accessor hands back — including the
 * optional `space` — and a test that cannot vary that cannot check the
 * degrades-without-the-binding half.
 */

const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    body: blocks({ label: 'Body', allow: [] }),
  },
  render: () => null,
})

const ORIGIN = 'https://example.com'

const withSpace = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  space: e.SPACE,
  media: e.MEDIA,
})

/** The same host, minus the one optional binding this spec adds. */
const withoutSpace = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
})

function folioWith(bindings: (e: Cloudflare.Env) => FolioBindings) {
  return createFolio<Cloudflare.Env>({
    blocks: [page],
    root: 'page',
    bindings,
    basePath: '/folio',
    auth: 'open',
    route: (path) => (path ? `/${path}` : '/'),
  })
}

const folio = folioWith(withSpace)
const blind = folioWith(withoutSpace)

/**
 * A request through `handle`, with its `waitUntil` drained.
 *
 * Draining is not optional here: the broadcast rides `waitUntil` deliberately, so
 * that an unreachable space object cannot fail a write that already committed —
 * which means a test that does not wait sees no event and would read as a bug in
 * the emitter.
 */
async function call(
  app: ReturnType<typeof folioWith>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const ctx = createExecutionContext()
  const res = await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

/** The one space instance the runtime addresses, by the name it uses. */
const spaceStub = () => env.SPACE.get(env.SPACE.idFromName('space')) as DurableObjectStub<SpaceDO>

interface Listener {
  ws: WebSocket
  events: SpaceEvent[]
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** A joined socket on the space object, collecting whatever the Worker broadcasts. */
async function listen(): Promise<Listener> {
  const res = await spaceStub().fetch('https://space.test/ws', {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket
  if (!ws) throw new Error('no socket')
  ws.accept()
  const events: SpaceEvent[] = []
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data as string) as SpaceServerFrame
    const msg = frame as SpaceServerMsg
    if (msg.type === 'event') events.push(msg.event)
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      identity: { actor: 'watcher', name: 'Watcher', colour: '#000000' },
      v: PROTOCOL_VERSION,
    }),
  )
  // Joined before the caller mutates anything: an event broadcast to a socket
  // still in the pre-hello quarantine is correctly dropped, which would read here
  // as a missing emit.
  for (let i = 0; i < 50; i++) await tick()
  return { ws, events }
}

/** Bounded wait for the nth event, so an absent broadcast fails rather than hangs. */
async function waitForEvents(l: Listener, n: number): Promise<SpaceEvent[]> {
  for (let i = 0; i < 300; i++) {
    if (l.events.length >= n) return l.events
    await tick()
  }
  throw new Error(`expected ${n} event(s), saw ${l.events.length}`)
}

/** Lets any in-flight broadcast land, so "no event" means something. */
async function settle() {
  for (let i = 0; i < 60; i++) await tick()
}

beforeAll(async () => {
  await env.DB.prepare('delete from stories').run()
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title)
     values (?, 'page', null, '', '', 'a0', 'Home')`,
  )
    .bind('sty_spaceev1')
    .run()
})

describe('structural events', () => {
  it('emits exactly one story.created after a create, and none after a refused one', async () => {
    const l = await listen()

    const ok = await call(folio, 'POST', '/folio/api/stories', {
      title: 'Made',
      parentId: 'sty_spaceev1',
    })
    expect(ok?.status).toBe(200)
    const created = (await ok?.json<{ id: string }>())!

    const event = (await waitForEvents(l, 1))[0]!
    expect(event).toEqual({
      kind: 'story.created',
      id: created.id,
      parentId: 'sty_spaceev1',
      title: 'Made',
      type: 'page',
      // `auth: 'open'`, so there is nobody to attribute it to.
      actor: null,
    })

    // A refused create writes nothing, so it says nothing.
    const bad = await call(folio, 'POST', '/folio/api/stories', {
      title: 'Nowhere',
      parentId: 'sty_does_not_exist',
    })
    expect(bad?.status).toBeGreaterThanOrEqual(400)
    await settle()
    expect(l.events).toHaveLength(1)
    l.ws.close()
  })

  it('emits one story.updated naming every path that moved', async () => {
    const l = await listen()
    const made = (await (
      await call(folio, 'POST', '/folio/api/stories', { title: 'Parent', parentId: 'sty_spaceev1' })
    )?.json<{ id: string; path: string }>())!
    const child = (await (
      await call(folio, 'POST', '/folio/api/stories', { title: 'Child', parentId: made.id })
    )?.json<{ id: string; path: string }>())!
    await waitForEvents(l, 2)
    l.events.length = 0

    const res = await call(folio, 'PATCH', `/folio/api/stories/${made.id}`, { slug: 'renamed' })
    expect(res?.status).toBe(200)

    const event = (await waitForEvents(l, 1))[0]!
    expect(event.kind).toBe('story.updated')
    if (event.kind !== 'story.updated') throw new Error('wrong kind')
    // The subtree, not only the renamed row: a client has to be able to tell
    // whether anything it is looking at moved without asking.
    expect(event.changes.map((c) => c.id).sort()).toEqual([child.id, made.id].sort())
    expect(event.changes.find((c) => c.id === made.id)?.to).toBe('renamed')

    // A patch that moves no path stays silent rather than firing an empty
    // `changes` array. (Note that a *title* patch is not one of those: the slug is
    // re-derived from the title when no slug is given, so renaming a page does
    // move its URL — which is precisely why this event exists.)
    l.events.length = 0
    await call(folio, 'PATCH', `/folio/api/stories/${made.id}`, { slug: 'renamed' })
    await settle()
    expect(l.events).toHaveLength(0)
    l.ws.close()
  })

  it('emits one story.deleted with every removed id', async () => {
    const l = await listen()
    const made = (await (
      await call(folio, 'POST', '/folio/api/stories', { title: 'Doomed', parentId: 'sty_spaceev1' })
    )?.json<{ id: string }>())!
    await waitForEvents(l, 1)
    l.events.length = 0

    const res = await call(folio, 'DELETE', `/folio/api/stories/${made.id}`)
    expect(res?.status).toBe(200)

    const event = (await waitForEvents(l, 1))[0]!
    expect(event).toMatchObject({ kind: 'story.deleted', ids: [made.id] })

    // The root refuses to be deleted, and a refusal is not an event.
    l.events.length = 0
    const refused = await call(folio, 'DELETE', '/folio/api/stories/sty_spaceev1')
    expect(refused?.status).toBeGreaterThanOrEqual(400)
    await settle()
    expect(l.events).toHaveLength(0)
    l.ws.close()
  })

  it('emits one story.published naming the version', async () => {
    const l = await listen()
    const made = (await (
      await call(folio, 'POST', '/folio/api/stories', {
        title: 'Goes live',
        parentId: 'sty_spaceev1',
      })
    )?.json<{ id: string }>())!
    await waitForEvents(l, 1)
    l.events.length = 0

    const res = await call(folio, 'POST', `/folio/api/story/${made.id}/publish`)
    expect(res?.status).toBe(200)

    const event = (await waitForEvents(l, 1))[0]!
    expect(event.kind).toBe('story.published')
    if (event.kind !== 'story.published') throw new Error('wrong kind')
    expect(event.id).toBe(made.id)
    expect(event.versionId).toMatch(/^ver_/)
    expect(event.at).toBeGreaterThan(0)

    // Publishing a story that does not exist is refused and says nothing.
    l.events.length = 0
    const missing = await call(folio, 'POST', '/folio/api/story/sty_nope000000000000/publish')
    expect(missing?.status).toBeGreaterThanOrEqual(400)
    await settle()
    expect(l.events).toHaveLength(0)
    l.ws.close()
  })

  /**
   * "Degrades without the binding" from the server's side: a host with no `space`
   * binding must not have its writes fail, or slowed, or logged about. The write
   * simply succeeds and nothing is broadcast.
   */
  it('writes succeed with no space binding at all, and broadcast nothing', async () => {
    const l = await listen()
    const res = await call(blind, 'POST', '/folio/api/stories', {
      title: 'No channel here',
      parentId: 'sty_spaceev1',
    })
    expect(res?.status).toBe(200)
    await settle()
    expect(l.events).toHaveLength(0)
    l.ws.close()
  })
})
