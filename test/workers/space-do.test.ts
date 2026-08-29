import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_BYTES,
  MAX_TITLE_LEN,
  PROTOCOL_VERSION,
  type SpaceClientMsg,
  type SpaceEvent,
  type SpacePresence,
  type SpaceServerFrame,
  type SpaceServerMsg,
} from '../../src/core/protocol'
import type { SpaceDO } from '../../src/server'

/**
 * Behaviour pins for the space Durable Object
 * (`../../docs/specs/editing/live-collaboration.md`).
 *
 * Two things are load-bearing and everything here exists to hold them:
 *
 *   - **the `joined` quarantine.** The attachment exists from upgrade time, so
 *     "has an attachment" would admit every lurker — and this channel is where a
 *     name is shown *outside* the document it was asserted in, which makes it the
 *     worse of the two places to get it wrong. `story-do.test.ts`'s "keeps deltas
 *     away from a socket that has not said hello" is the story-side equivalent.
 *   - **no storage.** Decision 1 is that this object persists nothing, which is
 *     what makes it cheap and what makes it unable to lose anything.
 *
 * Storage is isolated per test file but not per test, so every test names its own
 * space instance.
 */

const claimed = new Set<string>()

function space(tag: string): DurableObjectStub<SpaceDO> {
  if (claimed.has(tag)) throw new Error(`two tests share the space name '${tag}'`)
  claimed.add(tag)
  return env.SPACE.get(env.SPACE.idFromName(tag))
}

interface Peer {
  ws: WebSocket
  inbox: SpaceServerMsg[]
  /** Close codes seen on this socket. Collected from `connect`, not from the test
   * that expects one: a refusal closes fast enough to beat a listener attached
   * afterwards, which is how this reads as "never closed". */
  closes: number[]
  send(msg: SpaceClientMsg): void
  /** A frame exactly as it goes on the wire, for the version-discipline tests. */
  raw(text: string): void
}

async function connect(stub: DurableObjectStub<SpaceDO>): Promise<Peer> {
  const res = await stub.fetch('https://space.test/ws', { headers: { Upgrade: 'websocket' } })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('the object accepted the upgrade but returned no socket')
  ws.accept()
  const inbox: SpaceServerMsg[] = []
  const closes: number[] = []
  ws.addEventListener('message', (event) => {
    const { v, ...msg } = JSON.parse(event.data as string) as SpaceServerFrame
    expect(v).toBe(PROTOCOL_VERSION)
    inbox.push(msg as SpaceServerMsg)
  })
  ws.addEventListener('close', (event) => closes.push(event.code))
  return {
    ws,
    inbox,
    closes,
    send: (msg) => ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION })),
    raw: (text) => ws.send(text),
  }
}

async function join(
  stub: DurableObjectStub<SpaceDO>,
  who: { actor: string; name: string; colour: string },
): Promise<Peer> {
  const peer = await connect(stub)
  peer.send({ type: 'hello', identity: who })
  return peer
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

type FrameOf<T extends SpaceServerMsg['type']> = Extract<SpaceServerMsg, { type: T }>

/** Bounded wait for the nth frame of a type. Never `settle()` when a frame is
 * expected — the rule the orchestrator's flake fix established. */
async function frame<T extends SpaceServerMsg['type']>(
  peer: Peer,
  type: T,
  nth = 1,
): Promise<FrameOf<T>> {
  for (let i = 0; i < 300; i++) {
    const hits = peer.inbox.filter((f) => f.type === type)
    if (hits.length >= nth) return hits[nth - 1] as FrameOf<T>
    await tick()
  }
  const seen = peer.inbox.map((f) => f.type).join(', ') || 'nothing'
  throw new Error(`no ${nth > 1 ? `${nth} x ` : ''}'${type}' frame arrived; saw: ${seen}`)
}

const framesOf = <T extends SpaceServerMsg['type']>(peer: Peer, type: T): FrameOf<T>[] =>
  peer.inbox.filter((f) => f.type === type) as FrameOf<T>[]

/** Lets pending fan-out land, so "nothing arrived" means something. */
async function settle() {
  for (let i = 0; i < 20; i++) await tick()
}

async function closeCode(peer: Peer): Promise<number> {
  for (let i = 0; i < 300; i++) {
    if (peer.closes.length > 0) return peer.closes[0]!
    await tick()
  }
  throw new Error('the socket never closed')
}

const event = (over: Partial<SpaceEvent> = {}): SpaceEvent =>
  ({ kind: 'story.deleted', ids: ['sty_gone'], actor: null, ...over }) as SpaceEvent

/** Presence with nowhere-in-particular defaults, for the assertions below. */
const nowhere = (over: Partial<SpacePresence>): SpacePresence => ({
  actor: 'usr_ada',
  name: 'Ada',
  colour: '#ff00ff',
  role: null,
  storyId: null,
  storyTitle: null,
  locale: null,
  selection: null,
  ...over,
})

describe('SpaceDO: joining and leaving', () => {
  it('hands a joiner the peers already present and announces it to them', async () => {
    const stub = space('join')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    expect((await frame(ada, 'peers')).peers).toEqual([])

    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })

    expect((await frame(bo, 'peers')).peers).toEqual([nowhere({})])
    expect(await frame(ada, 'presence')).toEqual({
      type: 'presence',
      peer: nowhere({ actor: 'usr_bo', name: 'Bo', colour: '#00ffff' }),
    })
    ada.ws.close()
    bo.ws.close()
  })

  it('tells the remaining socket that a peer has gone', async () => {
    const stub = space('gone')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'peers')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'peers')

    ada.ws.close(1000, 'closing the tab')

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: nowhere({}),
      gone: true,
    })
    bo.ws.close()
  })

  /**
   * **The trap `identity-and-access.md` left for this spec.** The attachment
   * exists from upgrade time, so a socket that has not said hello has one — and
   * "has an attachment" as the membership test would put a nameless lurker in
   * everybody's peer list and hand it everybody else's names. `joined` is the
   * quarantine.
   */
  it('keeps a socket that has not said hello out of presence entirely', async () => {
    const stub = space('quarantine')
    const lurker = await connect(stub)
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })

    // Ada's peer list does not contain the lurker...
    expect((await frame(ada, 'peers')).peers).toEqual([])
    // ...and the lurker was told nothing about Ada.
    await settle()
    expect(lurker.inbox).toEqual([])

    // Nor can it announce a position without joining first.
    lurker.send({ type: 'where', storyId: 'sty_x', storyTitle: 'X', locale: null })
    lurker.send({ type: 'selection', selection: { uid: 'blk1', field: null } })
    await settle()
    expect(framesOf(ada, 'presence')).toEqual([])
    expect(lurker.inbox).toEqual([])

    lurker.ws.close()
    ada.ws.close()
  })

  /** An editor with two tabs is two presences, same actor, and that is the truth
   * (the spec's edge case). Deduping for *display* is the admin's job. */
  it('reports one presence per socket, not per actor', async () => {
    const stub = space('two-tabs')
    const watcher = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(watcher, 'peers')

    const tabA = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    const tabB = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(tabA, 'peers')
    tabA.send({ type: 'where', storyId: 'sty_a', storyTitle: 'A', locale: null })
    tabB.send({ type: 'where', storyId: 'sty_b', storyTitle: 'B', locale: null })

    // Four presence frames: two joins, then each tab's own `where`.
    await frame(watcher, 'presence', 4)
    const seen = framesOf(watcher, 'presence').filter((f) => f.peer.storyId !== null)
    expect(seen.map((f) => f.peer.storyId).sort()).toEqual(['sty_a', 'sty_b'])
    tabA.ws.close()
    tabB.ws.close()
    watcher.ws.close()
  })
})

describe('SpaceDO: where and selection', () => {
  it('broadcasts a position, capping the title and normalising the locale', async () => {
    const stub = space('where')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'peers')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'peers')
    await frame(ada, 'presence')

    ada.send({
      type: 'where',
      storyId: 'sty_about',
      storyTitle: `  ${'x'.repeat(MAX_TITLE_LEN + 50)}  `,
      locale: 'fr',
    })

    const seen = (await frame(bo, 'presence')).peer
    expect(seen.storyId).toBe('sty_about')
    expect(seen.storyTitle).toBe('x'.repeat(MAX_TITLE_LEN))
    expect(seen.locale).toBe('fr')
    ada.ws.close()
    bo.ws.close()
  })

  it('relays a selection and does not echo it to its author', async () => {
    const stub = space('selection')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'peers')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'peers')
    await frame(ada, 'presence')

    ada.send({ type: 'selection', selection: { uid: 'hero0000', field: 'heading' } })

    expect((await frame(bo, 'presence')).peer.selection).toEqual({
      uid: 'hero0000',
      field: 'heading',
    })
    await settle()
    // Ada's own inbox holds only Bo's arrival.
    expect(framesOf(ada, 'presence')).toHaveLength(1)
    ada.ws.close()
    bo.ws.close()
  })

  /**
   * Moving to another document invalidates a selection naming a blok in the old
   * one: a stale uid would draw a dot on whatever block happens to share it.
   */
  it('clears the selection when the story changes', async () => {
    const stub = space('move-clears')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'peers')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'peers')
    await frame(ada, 'presence')

    ada.send({ type: 'where', storyId: 'sty_a', storyTitle: 'A', locale: null })
    ada.send({ type: 'selection', selection: { uid: 'hero0000', field: null } })
    expect((await frame(bo, 'presence', 2)).peer.selection).toEqual({
      uid: 'hero0000',
      field: null,
    })

    ada.send({ type: 'where', storyId: 'sty_b', storyTitle: 'B', locale: null })
    const moved = await frame(bo, 'presence', 3)
    expect(moved.peer.storyId).toBe('sty_b')
    expect(moved.peer.selection).toBeNull()

    // The same story again keeps it: only a *change* of document invalidates.
    ada.send({ type: 'selection', selection: { uid: 'other000', field: null } })
    await frame(bo, 'presence', 4)
    ada.send({ type: 'where', storyId: 'sty_b', storyTitle: 'B renamed', locale: null })
    const same = await frame(bo, 'presence', 5)
    expect(same.peer.selection).toEqual({ uid: 'other000', field: null })
    ada.ws.close()
    bo.ws.close()
  })
})

describe('SpaceDO: events', () => {
  it('broadcasts an event from the Worker to every joined socket', async () => {
    const stub = space('events')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(ada, 'peers')
    await frame(bo, 'peers')

    const published: SpaceEvent = {
      kind: 'story.published',
      id: 'sty_home',
      title: 'Home',
      at: 1_700_000_000_000,
      versionId: 'ver_1',
      actor: 'usr_bo',
    }
    await stub.broadcastEvent(published)

    // Every joined socket, including the one whose actor caused it: a Worker
    // calling an RPC has no idea which socket the request arrived on, so the
    // client filters its own echo by `actor`.
    expect((await frame(ada, 'event')).event).toEqual(published)
    expect((await frame(bo, 'event')).event).toEqual(published)
    ada.ws.close()
    bo.ws.close()
  })

  it('does not reach a socket that has not said hello', async () => {
    const stub = space('events-quarantine')
    const lurker = await connect(stub)
    await stub.broadcastEvent(event())
    await settle()
    expect(lurker.inbox).toEqual([])
    lurker.ws.close()
  })

  /** The write that produced the event has already committed, so an object with
   * nobody attached must not make a noise about it. */
  it('is a no-op with no sockets at all', async () => {
    const stub = space('events-empty')
    await expect(stub.broadcastEvent(event())).resolves.toBeUndefined()
  })
})

describe('SpaceDO: protocol discipline', () => {
  it('refuses a frame with no version and closes 4001', async () => {
    const stub = space('no-version')
    const peer = await connect(stub)
    peer.raw(JSON.stringify({ type: 'hello' }))

    expect((await frame(peer, 'error')).reason).toContain('unset')
    expect(await closeCode(peer)).toBe(4001)
  })

  it('refuses a frame claiming another version and closes 4001', async () => {
    const stub = space('wrong-version')
    const peer = await connect(stub)
    peer.raw(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION - 1 }))

    expect((await frame(peer, 'error')).reason).toContain(String(PROTOCOL_VERSION))
    expect(await closeCode(peer)).toBe(4001)
  })

  it('answers an unreadable frame without closing', async () => {
    const stub = space('unreadable')
    const peer = await connect(stub)
    peer.raw('not json at all {{{')
    expect((await frame(peer, 'error')).reason).toBe('unreadable frame')
    peer.raw(JSON.stringify({ type: 'nonsense', v: PROTOCOL_VERSION }))
    expect((await frame(peer, 'error', 2)).reason).toBe('unreadable frame')
    peer.ws.close()
  })

  it('refuses an oversized frame before parsing it', async () => {
    const stub = space('oversized')
    const peer = await connect(stub)
    peer.raw(
      JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, pad: 'x'.repeat(MAX_FRAME_BYTES) }),
    )
    expect((await frame(peer, 'error')).reason).toContain('frame too large')
    peer.ws.close()
  })

  it('refuses anything but a websocket upgrade', async () => {
    const stub = space('not-upgrade')
    const res = await stub.fetch('https://space.test/ws')
    expect(res.status).toBe(426)
  })

  /**
   * A name on this channel is shown outside the document it was asserted in, so
   * an actor a client makes up must not be able to displace a verified one. Here
   * there is no verified identity to displace (no `x-folio-identity` header
   * reaches the object through a bare stub fetch), which is the `auth: 'open'`
   * case — the one situation the assertion is read at all — and the caps still
   * apply.
   */
  it('caps and defaults a self-asserted identity', async () => {
    const stub = space('asserted')
    const watcher = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(watcher, 'peers')

    const blank = await join(stub, { actor: 'usr_ada', name: '   ', colour: 'not-a-colour' })
    const seen = (await frame(watcher, 'presence')).peer
    expect(seen.name).toBe('Anonymous')
    expect(seen.colour).toMatch(/^#[0-9a-f]{6}$/)
    // Never a role from a client: there is no session here, so it is null.
    expect(seen.role).toBeNull()
    blank.ws.close()
    watcher.ws.close()
  })
})

describe('SpaceDO: storage', () => {
  /**
   * Decision 1, pinned. Presence is never persisted: everything lives in socket
   * attachments, so the object cannot lose anything that matters and hibernates
   * when idle. A future edit that reaches for `ctx.storage` fails here.
   */
  it('allocates no storage at all, before or after a busy session', async () => {
    const stub = space('no-storage')
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'peers')
    ada.send({ type: 'where', storyId: 'sty_home', storyTitle: 'Home', locale: 'fr' })
    ada.send({ type: 'selection', selection: { uid: 'hero0000', field: 'heading' } })
    await stub.broadcastEvent(event())
    await settle()

    const stored = await runInDurableObject(stub, async (_instance, state) => {
      const all = await state.storage.list()
      return all.size
    })
    expect(stored).toBe(0)

    // And no alarm either: nothing here is debounced into a later write.
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    expect(alarm).toBeNull()

    ada.ws.close()
  })
})
