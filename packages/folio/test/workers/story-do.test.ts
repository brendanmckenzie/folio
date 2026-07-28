import { env, runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import type { ClientMsg, Delta, Presence, ServerMsg } from '../../src/core/protocol'
import type { StoryDO } from '../../src/server'

/**
 * Behaviour pins for the story Durable Object.
 *
 * Everything here goes through one of two doors, both of them doors the product
 * actually uses:
 *
 *   - `runInDurableObject`, for the RPC surface (`getOrInit`, `recent`) and for
 *     the two private helpers the WebSocket handler leans on;
 *   - a real hibernatable WebSocket, obtained by sending the object an
 *     `Upgrade: websocket` request through its stub, for the protocol.
 *
 * Storage is isolated per test *file* but not per test (see the note in
 * smoke.test.ts), so every test takes a story name of its own and therefore a
 * Durable Object of its own. `story()` enforces that.
 */

/** Mirrors MAX_CATCHUP in src/server/story-do.ts. */
const CATCHUP_LIMIT = 200

/** Fresh every call: tests hand this to `getOrInit` and compare against it. */
const seed = (): Doc => ({
  root: 'root0000',
  bloks: {
    root0000: {
      uid: 'root0000',
      type: 'page',
      parent: null,
      slot: null,
      order: 'a0',
      data: { title: 'Home' },
    },
  },
})

type Mutations = Extract<ClientMsg, { type: 'tx' }>['mutations']

/** The one edit every test makes, so a delta is easy to eyeball. */
const setTitle = (value: string): Mutations => [
  { t: 'set', uid: 'root0000', field: 'title', value },
]

const claimed = new Set<string>()

/**
 * The object for a story nobody else in this file touches. `shared` opts a name
 * out of the uniqueness guard, for the one describe block that seeds a long log
 * in `beforeAll` and then reads it from several tests.
 */
function story(tag: string, shared = false): DurableObjectStub<StoryDO> {
  if (!shared) {
    if (claimed.has(tag)) throw new Error(`two tests share the story name '${tag}'`)
    claimed.add(tag)
  }
  return env.STORY.get(env.STORY.idFromName(`sty_${tag}`))
}

/** The private helpers of StoryDO. Keep in step with src/server/story-do.ts. */
interface StoryInternals {
  since(syncId: number): Delta[]
}

const internals = (instance: StoryDO) => instance as unknown as StoryInternals

/**
 * Stand-in for a hibernatable socket, for driving `webSocketMessage` with no
 * peer on the other end: seeding a long log through 200-odd real sockets is
 * needlessly slow, and the handler only ever asks a socket for its attachment.
 */
function ghost(peer: Presence | null): WebSocket {
  return {
    deserializeAttachment: () => peer,
    serializeAttachment: () => undefined,
    send: () => undefined,
  } as unknown as WebSocket
}

interface Peer {
  ws: WebSocket
  /** Every frame the object has sent this socket, in arrival order. */
  inbox: ServerMsg[]
  send(msg: ClientMsg): void
}

async function connect(stub: DurableObjectStub<StoryDO>): Promise<Peer> {
  const res = await stub.fetch('https://story.test/ws', { headers: { Upgrade: 'websocket' } })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('the object accepted the upgrade but returned no socket')
  ws.accept()
  const inbox: ServerMsg[] = []
  ws.addEventListener('message', (event) => {
    inbox.push(JSON.parse(event.data as string) as ServerMsg)
  })
  return { ws, inbox, send: (msg) => ws.send(JSON.stringify(msg)) }
}

/** Connects and says hello, returning the socket and the first reply frame. */
async function join(
  stub: DurableObjectStub<StoryDO>,
  who: { actor: string; name: string; colour: string; lastSyncId?: number },
): Promise<Peer> {
  const peer = await connect(stub)
  peer.send({
    type: 'hello',
    actor: who.actor,
    name: who.name,
    colour: who.colour,
    lastSyncId: who.lastSyncId ?? 0,
  })
  return peer
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

type FrameOf<T extends ServerMsg['type']> = Extract<ServerMsg, { type: T }>

/**
 * The first frame of `type` the object sent this socket. Bounded, and throws
 * when it runs out of patience, so a broadcast that never arrives shows up as a
 * failure rather than a hung test.
 */
async function frame<T extends ServerMsg['type']>(
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

const framesOf = <T extends ServerMsg['type']>(peer: Peer, type: T): FrameOf<T>[] =>
  peer.inbox.filter((f) => f.type === type) as FrameOf<T>[]

/** Lets pending fan-out land, so "nothing arrived" assertions mean something. */
async function settle() {
  for (let i = 0; i < 20; i++) await tick()
}

describe('StoryDO: the draft', () => {
  it('creates the document on first touch and ignores every later seed', async () => {
    const stub = story('init')

    const first = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const second = await runInDurableObject(stub, (instance) =>
      instance.getOrInit({ root: 'other000', bloks: {} }),
    )

    expect(first).toEqual(seed())
    expect(second).toEqual(seed())
  })

  it('bootstraps a client that has no watermark with the whole draft', async () => {
    const stub = story('bootstrap')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#f0f' })

    // The full shape of a bootstrap: nothing has been transacted, so syncId is
    // still 0 and this socket is the only one attached.
    expect(await frame(peer, 'bootstrap')).toEqual({
      type: 'bootstrap',
      doc: seed(),
      syncId: 0,
      peers: [],
    })
    peer.ws.close()
  })

  it('bootstraps on lastSyncId 0 even when the log could have covered the gap', async () => {
    const stub = story('bootstrap-zero')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const writer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#f0f' })
    writer.send({ type: 'tx', txId: 't1', mutations: setTitle('Edited') })
    await frame(writer, 'delta')

    // One delta behind, which is inside the catchup window, but a client with no
    // watermark has nothing to replay onto.
    const peer = await join(stub, { actor: 'a2', name: 'Bo', colour: '#0ff' })

    const boot = await frame(peer, 'bootstrap')
    expect(boot.syncId).toBe(1)
    expect(boot.doc.bloks.root0000?.data.title).toBe('Edited')
    writer.ws.close()
    peer.ws.close()
  })
})

describe('StoryDO: transactions', () => {
  it('applies a tx, advances the syncId and echoes the delta to its sender', async () => {
    const stub = story('tx-echo')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#f0f' })
    await frame(peer, 'bootstrap')

    peer.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') })

    // The echo is the acknowledgement; the actor comes off the hello attachment.
    expect(await frame(peer, 'delta')).toEqual({
      type: 'delta',
      syncId: 1,
      txId: 'tx-1',
      actor: 'a1',
      mutations: setTitle('Renamed'),
    })
    // getOrInit is also the read path for the live draft, so it now sees the edit.
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Renamed')
    peer.ws.close()
  })

  it('numbers deltas from the log, one per tx, in the order they landed', async () => {
    const stub = story('tx-order')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#f0f' })
    await frame(peer, 'bootstrap')

    peer.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('One') })
    await frame(peer, 'delta')
    peer.send({ type: 'tx', txId: 'tx-2', mutations: setTitle('Two') })
    await frame(peer, 'delta', 2)
    peer.send({ type: 'tx', txId: 'tx-3', mutations: setTitle('Three') })
    await frame(peer, 'delta', 3)

    expect(framesOf(peer, 'delta').map((d) => [d.syncId, d.txId])).toEqual([
      [1, 'tx-1'],
      [2, 'tx-2'],
      [3, 'tx-3'],
    ])
    peer.ws.close()
  })

  it('logs the actor and display name the socket said hello with', async () => {
    const stub = story('tx-actor')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(peer, 'bootstrap')

    peer.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') })
    await frame(peer, 'delta')

    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      syncId: 1,
      actor: 'usr_ada',
      actorName: 'Ada',
      mutations: setTitle('Renamed'),
    })
    expect(typeof trail[0]?.at).toBe('number')
    peer.ws.close()
  })

  it('attributes a tx from a socket with no attachment to an unknown actor', async () => {
    const stub = story('tx-unknown')

    await runInDurableObject(stub, async (instance) => {
      await instance.getOrInit(seed())
      await instance.webSocketMessage(
        ghost(null),
        JSON.stringify({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') }),
      )
    })

    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail[0]).toMatchObject({ actor: 'unknown', actorName: null })
  })
})

describe('StoryDO: activity trail', () => {
  it('returns the most recent transactions first and honours the limit', async () => {
    const stub = story('recent')
    await runInDurableObject(stub, async (instance) => {
      await instance.getOrInit(seed())
      for (const n of [1, 2, 3]) {
        await instance.webSocketMessage(
          ghost({ actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: null }),
          JSON.stringify({ type: 'tx', txId: `tx-${n}`, mutations: setTitle(`v${n}`) }),
        )
      }
    })

    const all = await runInDurableObject(stub, (instance) => instance.recent())
    const capped = await runInDurableObject(stub, (instance) => instance.recent(2))
    // A limit below 1 is clamped to 1 rather than returning nothing.
    const clamped = await runInDurableObject(stub, (instance) => instance.recent(0))

    expect(all.map((e) => e.syncId)).toEqual([3, 2, 1])
    expect(capped.map((e) => e.syncId)).toEqual([3, 2])
    expect(clamped.map((e) => e.syncId)).toEqual([3])
  })
})

describe('StoryDO: since()', () => {
  it('replays the mutations after a watermark, oldest first', async () => {
    const stub = story('since')
    await runInDurableObject(stub, async (instance) => {
      await instance.getOrInit(seed())
      for (const n of [1, 2, 3]) {
        await instance.webSocketMessage(
          ghost({ actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: null }),
          JSON.stringify({ type: 'tx', txId: `tx-${n}`, mutations: setTitle(`v${n}`) }),
        )
      }
    })

    const [fromZero, fromOne, fromEnd, beyondEnd] = await runInDurableObject(stub, (instance) => {
      const store = internals(instance)
      return [store.since(0), store.since(1), store.since(3), store.since(99)]
    })

    expect(fromZero).toEqual([
      { syncId: 1, txId: 'tx-1', actor: 'usr_ada', mutations: setTitle('v1') },
      { syncId: 2, txId: 'tx-2', actor: 'usr_ada', mutations: setTitle('v2') },
      { syncId: 3, txId: 'tx-3', actor: 'usr_ada', mutations: setTitle('v3') },
    ])
    expect(fromOne?.map((d) => d.syncId)).toEqual([2, 3])
    expect(fromEnd).toEqual([])
    expect(beyondEnd).toEqual([])
  })
})

describe('StoryDO: reconnecting', () => {
  const LOGGED = CATCHUP_LIMIT + 2
  const catchupStub = () => story('catchup', true)

  beforeAll(async () => {
    await runInDurableObject(catchupStub(), async (instance) => {
      await instance.getOrInit(seed())
      const socket = ghost({ actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: null })
      for (let n = 1; n <= LOGGED; n++) {
        await instance.webSocketMessage(
          socket,
          JSON.stringify({ type: 'tx', txId: `tx-${n}`, mutations: setTitle(`v${n}`) }),
        )
      }
    })
  })

  it('replays from the log when the gap is exactly MAX_CATCHUP', async () => {
    const peer = await join(catchupStub(), {
      actor: 'a1',
      name: 'Ada',
      colour: '#f0f',
      lastSyncId: LOGGED - CATCHUP_LIMIT,
    })

    const catchup = await frame(peer, 'catchup')
    expect(catchup.syncId).toBe(LOGGED)
    expect(catchup.deltas).toHaveLength(CATCHUP_LIMIT)
    expect(catchup.deltas[0]?.syncId).toBe(LOGGED - CATCHUP_LIMIT + 1)
    expect(catchup.deltas.at(-1)?.syncId).toBe(LOGGED)
    peer.ws.close()
  })

  it('sends the whole document when the gap is one past MAX_CATCHUP', async () => {
    const peer = await join(catchupStub(), {
      actor: 'a2',
      name: 'Bo',
      colour: '#0ff',
      lastSyncId: LOGGED - CATCHUP_LIMIT - 1,
    })

    const boot = await frame(peer, 'bootstrap')
    expect(boot.syncId).toBe(LOGGED)
    expect(boot.doc.bloks.root0000?.data.title).toBe(`v${LOGGED}`)
    peer.ws.close()
  })

  it('bootstraps a client whose watermark is ahead of the object', async () => {
    const peer = await join(catchupStub(), {
      actor: 'a3',
      name: 'Cy',
      colour: '#ff0',
      lastSyncId: LOGGED + 5,
    })

    expect((await frame(peer, 'bootstrap')).syncId).toBe(LOGGED)
    peer.ws.close()
  })
})

describe('StoryDO: multiplayer', () => {
  it('hands a joiner the peers already present and announces it to them', async () => {
    const stub = story('mp-join')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(ada, 'bootstrap')

    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#0ff' })

    expect((await frame(bo, 'bootstrap')).peers).toEqual([
      { actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: null },
    ])
    expect(await frame(ada, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_bo', name: 'Bo', colour: '#0ff', selection: null },
    })
    ada.ws.close()
    bo.ws.close()
  })

  it('broadcasts a delta from one socket to the other', async () => {
    const stub = story('mp-delta')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#0ff' })
    await frame(bo, 'bootstrap')

    ada.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') })

    const expected = {
      type: 'delta',
      syncId: 1,
      txId: 'tx-1',
      actor: 'usr_ada',
      mutations: setTitle('Renamed'),
    }
    expect(await frame(bo, 'delta')).toEqual(expected)
    // The sender sees the same frame, which is what acknowledges its tx.
    expect(await frame(ada, 'delta')).toEqual(expected)
    ada.ws.close()
    bo.ws.close()
  })

  it('relays a selection to the other socket and not back to its author', async () => {
    const stub = story('mp-presence')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#0ff' })
    await frame(bo, 'bootstrap')
    await frame(ada, 'presence')

    ada.send({ type: 'presence', selection: 'root0000' })

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: 'root0000' },
    })
    // Ada's own inbox still holds only Bo's arrival.
    await settle()
    expect(framesOf(ada, 'presence')).toHaveLength(1)
    ada.ws.close()
    bo.ws.close()
  })

  it('tells the remaining socket that a peer has gone', async () => {
    const stub = story('mp-gone')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#0ff' })
    await frame(bo, 'bootstrap')

    ada.ws.close(1000, 'closing the tab')

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_ada', name: 'Ada', colour: '#f0f', selection: null },
      gone: true,
    })
    bo.ws.close()
  })
})

describe('StoryDO: known bugs', () => {
  // SPEC(tx-dedupe): a txId already in the log must be acknowledged without being
  // applied again. Currently fails: every tx frame is inserted and broadcast, so a
  // client retrying after a flaky send doubles the transaction.
  it.fails('ignores a tx whose txId is already in the log', async () => {
    const stub = story('dedupe')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(peer, 'bootstrap')
    const tx: ClientMsg = { type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') }

    peer.send(tx)
    await frame(peer, 'delta')
    // The same frame, verbatim: a client resending after a dropped acknowledgement.
    peer.send(tx)
    await settle()

    const deltas = framesOf(peer, 'delta')
    expect(deltas[0]).toEqual({
      type: 'delta',
      syncId: 1,
      txId: 'tx-1',
      actor: 'usr_ada',
      mutations: setTitle('Renamed'),
    })
    // Re-acknowledging with the syncId the tx already has would be fine; handing
    // it a second one would not, and neither would a second row in the log.
    expect([...new Set(deltas.map((d) => d.syncId))]).toEqual([1])
    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail.map((e) => e.syncId)).toEqual([1])
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Renamed')
    peer.ws.close()
  })

  // SPEC(pre-hello): a socket that has not said hello yet must not be sent deltas.
  // Currently fails: broadcast walks every accepted socket, so a connection still
  // waiting to identify itself receives edits it cannot place.
  it.fails('keeps deltas away from a socket that has not said hello', async () => {
    const stub = story('pre-hello')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(ada, 'bootstrap')
    // Connected, accepted, silent: no hello, so the object knows nothing about it.
    const lurker = await connect(stub)

    ada.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') })
    await frame(ada, 'delta')
    await settle()

    expect(framesOf(lurker, 'delta')).toEqual([])
    ada.ws.close()
    lurker.ws.close()
  })

  // SPEC(malformed-frame): a frame that is not JSON, or a tx that is not a valid
  // mutation, must be dropped with the connection and the draft intact. Currently
  // fails: JSON.parse throws on the first, and applyAll dereferences the missing
  // blok on the second, out of the handler and into the runtime.
  it.fails('survives a malformed frame and an invalid mutation', async () => {
    const stub = story('malformed')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#f0f' })
    await frame(peer, 'bootstrap')

    // Driven through the handler directly, with the object's own accepted socket,
    // so a throw lands on this test rather than in the runtime's log.
    await runInDurableObject(stub, async (instance, state) => {
      const socket = state.getWebSockets()[0]!
      await instance.webSocketMessage(socket, 'not json at all {{{')
      await instance.webSocketMessage(
        socket,
        JSON.stringify({ type: 'tx', txId: 'tx-bad', mutations: [{ t: 'insert' }] }),
      )
    })

    const after = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(after).toEqual(seed())
    // And the socket still works: a well-formed tx is applied and acknowledged.
    peer.send({ type: 'tx', txId: 'tx-good', mutations: setTitle('Renamed') })
    expect((await frame(peer, 'delta')).txId).toBe('tx-good')
    peer.ws.close()
  })
})
