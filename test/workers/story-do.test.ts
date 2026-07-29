import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Doc } from '../../src/core/doc'
import {
  type ClientMsg,
  type Delta,
  fallbackColour,
  MAX_DOC_BLOKS,
  MAX_FRAME_BYTES,
  MAX_NAME_LEN,
  MAX_TX_MUTATIONS,
  type Presence,
  PROTOCOL_VERSION,
  type ServerFrame,
  type ServerMsg,
} from '../../src/core/protocol'
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
  /** Every frame the object has sent this socket, in arrival order, minus `v`. */
  inbox: ServerMsg[]
  send(msg: ClientMsg): void
}

/**
 * Both directions carry the wire version: `send` stamps it, and every arriving
 * frame is checked for it here — once, so the per-frame assertions below stay
 * about content — and then stripped, since the version is a property of the
 * transport rather than of any message.
 */
async function connect(stub: DurableObjectStub<StoryDO>): Promise<Peer> {
  const res = await stub.fetch('https://story.test/ws', { headers: { Upgrade: 'websocket' } })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('the object accepted the upgrade but returned no socket')
  ws.accept()
  const inbox: ServerMsg[] = []
  ws.addEventListener('message', (event) => {
    const { v, ...msg } = JSON.parse(event.data as string) as ServerFrame
    expect(v).toBe(PROTOCOL_VERSION)
    inbox.push(msg as ServerMsg)
  })
  return { ws, inbox, send: (msg) => ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION })) }
}

/** Connects and says hello, returning the socket and the first reply frame. */
async function join(
  stub: DurableObjectStub<StoryDO>,
  who: { actor: string; name: string; colour: string; lastSyncId?: number },
): Promise<Peer> {
  const peer = await connect(stub)
  peer.send({
    type: 'hello',
    lastSyncId: who.lastSyncId ?? 0,
    identity: { actor: who.actor, name: who.name, colour: who.colour },
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

    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })

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
    const writer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
    writer.send({ type: 'tx', txId: 't1', mutations: setTitle('Edited') })
    await frame(writer, 'delta')

    // One delta behind, which is inside the catchup window, but a client with no
    // watermark has nothing to replay onto.
    const peer = await join(stub, { actor: 'a2', name: 'Bo', colour: '#00ffff' })

    const boot = await frame(peer, 'bootstrap')
    expect(boot.syncId).toBe(1)
    expect(boot.doc.bloks.root0000?.data.title).toBe('Edited')
    writer.ws.close()
    peer.ws.close()
  })
})

// unpublished-changes.md's architecture decision 4: the object mirrors its own
// log position into D1 on a debounced alarm rather than a per-transaction
// write, so the content tree can show unpublished changes without opening
// every story's object.
describe('StoryDO: draft watermark alarm', () => {
  it('head() on a fresh object reports syncId 0', async () => {
    const stub = story('head-fresh')
    expect(await runInDurableObject(stub, (instance) => instance.head())).toEqual({ syncId: 0 })
  })

  it('head() reflects the log position once transactions have landed', async () => {
    const stub = story('head-after-tx')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const writer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
    writer.send({ type: 'tx', txId: 't1', mutations: setTitle('Edited') })
    await frame(writer, 'delta')

    expect(await runInDurableObject(stub, (instance) => instance.head())).toEqual({ syncId: 1 })
    writer.ws.close()
  })

  it('schedules exactly one alarm per burst and writes the latest syncId once it fires', async () => {
    const stub = story('watermark-burst')
    await env.DB.prepare(
      `insert into stories (id, parent_id, slug, path, ord, title, updated_at)
       values (?, null, ?, ?, 'a0', 'Watermark Burst', ?)`,
    )
      .bind('sty_watermark-burst', 'watermark-burst', 'watermark-burst', Date.now())
      .run()

    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const writer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })

    // A burst of three transactions, all before the alarm ever fires.
    writer.send({ type: 'tx', txId: 't1', mutations: setTitle('One') })
    await frame(writer, 'delta', 1)
    writer.send({ type: 'tx', txId: 't2', mutations: setTitle('Two') })
    await frame(writer, 'delta', 2)
    writer.send({ type: 'tx', txId: 't3', mutations: setTitle('Three') })
    await frame(writer, 'delta', 3)

    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const row = await env.DB.prepare(
      'select draft_sync_id as draftSyncId, draft_updated_at as draftUpdatedAt from stories where id = ?',
    )
      .bind('sty_watermark-burst')
      .first<{ draftSyncId: number; draftUpdatedAt: number | null }>()
    expect(row?.draftSyncId).toBe(3)
    expect(row?.draftUpdatedAt).not.toBeNull()

    // One alarm per burst: nothing is left scheduled once it has fired, so a
    // second manual run finds none to run.
    expect(await runDurableObjectAlarm(stub)).toBe(false)

    writer.ws.close()
  })

  it('acknowledges the sender even when the story has no D1 row to mirror into', async () => {
    // Deliberately no `stories` row for this id: the tx path must not depend
    // on the watermark write succeeding (an update matching no rows is not an
    // error, but the object's own tx ack must not depend on it either way).
    const stub = story('watermark-orphan')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const writer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
    writer.send({ type: 'tx', txId: 't1', mutations: setTitle('Orphaned') })
    const delta = await frame(writer, 'delta')
    expect(delta.syncId).toBe(1)

    expect(await runDurableObjectAlarm(stub)).toBe(true)
    writer.ws.close()
  })
})

describe('StoryDO: transactions', () => {
  it('applies a tx, advances the syncId and echoes the delta to its sender', async () => {
    const stub = story('tx-echo')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
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
    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
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
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
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
      // Versioned, but never said hello: version discipline and the pre-hello
      // quarantine are separate checks, and this exercises the missing
      // attachment on its own.
      await instance.webSocketMessage(
        ghost(null),
        JSON.stringify({
          type: 'tx',
          txId: 'tx-1',
          mutations: setTitle('Renamed'),
          v: PROTOCOL_VERSION,
        }),
      )
    })

    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail[0]).toMatchObject({ actor: 'unknown', actorName: null })
  })
})

/**
 * `schema-migrations.md` architecture decision 4: the second door into the log.
 * The point of every test here is that it is *not* a second write path — it runs
 * the same `applyTransaction` the socket's `tx` frame does, so it inherits the
 * cap, the atomic validation, the document ceiling and the dedupe.
 */
describe('StoryDO: commit (the transaction RPC)', () => {
  const MIGRATION = { id: 'migration:0001-test', name: 'Migration 0001' }

  it('logs a transaction, advances the syncId, and attributes it to its actor', async () => {
    const stub = story('commit-log')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Migrated'), MIGRATION, 'commit-1'),
    )
    expect(result).toEqual({ syncId: 1, txId: 'commit-1' })

    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail[0]).toMatchObject({
      syncId: 1,
      actor: 'migration:0001-test',
      actorName: 'Migration 0001',
      mutations: setTitle('Migrated'),
    })
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Migrated')
  })

  it('mints its own txId when the caller supplies none', async () => {
    const stub = story('commit-txid')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Auto'), MIGRATION),
    )
    expect('rejected' in result).toBe(false)
    if ('rejected' in result) throw new Error(result.rejected)
    expect(result.txId).toMatch(/^tx_[0-9a-f]{20}$/)
    expect(result.syncId).toBe(1)
  })

  /**
   * The acceptance criterion "a migration reaches a connected editor live": no
   * sender to exclude, so every joined socket gets the delta. That is what makes
   * it appear without a reload, land in the activity trail, and undo.
   */
  it('broadcasts the delta to every joined socket', async () => {
    const stub = story('commit-broadcast')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
    const bo = await join(stub, { actor: 'a2', name: 'Bo', colour: '#00ffff' })
    await frame(ada, 'bootstrap')
    await frame(bo, 'bootstrap')

    await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('From a migration'), MIGRATION, 'commit-bc'),
    )

    for (const peer of [ada, bo]) {
      expect(await frame(peer, 'delta')).toEqual({
        type: 'delta',
        syncId: 1,
        txId: 'commit-bc',
        actor: 'migration:0001-test',
        mutations: setTitle('From a migration'),
      })
    }
    ada.ws.close()
    bo.ws.close()
  })

  /**
   * The pre-hello quarantine applies to this door too, and it has to: a socket
   * with no watermark cannot place a delta, so delivering one there is exactly
   * how a client ends up with a gap it cannot see.
   */
  it('does not broadcast to a socket that has not said hello', async () => {
    const stub = story('commit-quarantine')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const lurker = await connect(stub)

    await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Unseen'), MIGRATION, 'commit-q'),
    )

    await settle()
    expect(framesOf(lurker, 'delta')).toEqual([])
    lurker.ws.close()
  })

  it('dedupes a repeated txId: answered as a replay, written once', async () => {
    const stub = story('commit-dedupe')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const first = await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Once'), MIGRATION, 'commit-same'),
    )
    const second = await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Twice'), MIGRATION, 'commit-same'),
    )

    expect(first).toEqual({ syncId: 1, txId: 'commit-same' })
    expect(second).toEqual({ syncId: 1, txId: 'commit-same', replay: true })
    // The second call's mutations never ran: the log has one row and the
    // document still holds the first call's value.
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toHaveLength(1)
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Once')
  })

  it('does not re-broadcast a replay', async () => {
    const stub = story('commit-replay-quiet')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'a1', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')

    await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Once'), MIGRATION, 'commit-rq'),
    )
    await frame(peer, 'delta')
    await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Once'), MIGRATION, 'commit-rq'),
    )

    await settle()
    expect(framesOf(peer, 'delta')).toHaveLength(1)
    peer.ws.close()
  })

  it('refuses over the mutation cap with the same reason the socket path gives', async () => {
    const stub = story('commit-cap')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const tooMany = Array.from({ length: MAX_TX_MUTATIONS + 1 }, (_, i) => ({
      t: 'set' as const,
      uid: 'root0000',
      field: `f${i}`,
      value: i,
    }))
    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(tooMany, MIGRATION, 'commit-cap'),
    )

    expect(result).toEqual({
      rejected: `too many mutations: ${MAX_TX_MUTATIONS + 1} exceeds the ${MAX_TX_MUTATIONS} cap`,
    })
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
  })

  /**
   * Atomic: nothing partial lands. This is what lets the runner record a failure
   * per story and carry on — a chunk is either wholly applied or wholly refused,
   * so a re-run recomputes from a document in a known shape.
   */
  it('refuses an invalid mutation and logs nothing from the whole transaction', async () => {
    const stub = story('commit-invalid')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(
        [
          { t: 'set', uid: 'root0000', field: 'title', value: 'landed?' },
          { t: 'remove', uid: 'root0000' },
        ],
        MIGRATION,
        'commit-invalid',
      ),
    )

    expect(result).toEqual({ rejected: 'root remove: the root cannot be removed' })
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Home')
  })

  it('carries a retype through, so a migration can consolidate two block types', async () => {
    const stub = story('commit-retype')
    await runInDurableObject(stub, async (instance) => {
      await instance.getOrInit(seed())
      await instance.commit(
        [
          {
            t: 'insert',
            blok: {
              uid: 'bq000001',
              type: 'bigQuote',
              parent: 'root0000',
              slot: 'body',
              order: 'a0',
              data: { text: 'Hi' },
            },
          },
        ],
        MIGRATION,
        'commit-rt-seed',
      )
    })

    await runInDurableObject(stub, (instance) =>
      instance.commit(
        [
          { t: 'retype', uid: 'bq000001', type: 'quote' },
          { t: 'set', uid: 'bq000001', field: 'size', value: 'large' },
        ],
        MIGRATION,
        'commit-rt',
      ),
    )

    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.bq000001).toEqual({
      uid: 'bq000001',
      type: 'quote',
      parent: 'root0000',
      slot: 'body',
      order: 'a0',
      data: { text: 'Hi', size: 'large' },
    })
  })

  /**
   * Deliberate: the caller's job is `getOrInit` first, and inventing a seed here
   * would mean this object knowing what a document type looks like — the one
   * thing it is designed not to know.
   */
  it('refuses when the object has no document yet', async () => {
    const stub = story('commit-no-doc')
    const result = await runInDurableObject(stub, (instance) =>
      instance.commit(setTitle('Nothing to migrate'), MIGRATION, 'commit-nodoc'),
    )
    expect(result).toEqual({ rejected: 'no document: this story has never been opened' })
  })
})

describe('StoryDO: activity trail', () => {
  it('returns the most recent transactions first and honours the limit', async () => {
    const stub = story('recent')
    await runInDurableObject(stub, async (instance) => {
      await instance.getOrInit(seed())
      for (const n of [1, 2, 3]) {
        await instance.webSocketMessage(
          ghost({
            actor: 'usr_ada',
            name: 'Ada',
            colour: '#ff00ff',
            selection: null,
            locale: null,
          }),
          JSON.stringify({
            type: 'tx',
            txId: `tx-${n}`,
            mutations: setTitle(`v${n}`),
            v: PROTOCOL_VERSION,
          }),
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
          ghost({
            actor: 'usr_ada',
            name: 'Ada',
            colour: '#ff00ff',
            selection: null,
            locale: null,
          }),
          JSON.stringify({
            type: 'tx',
            txId: `tx-${n}`,
            mutations: setTitle(`v${n}`),
            v: PROTOCOL_VERSION,
          }),
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
      const socket = ghost({
        actor: 'usr_ada',
        name: 'Ada',
        colour: '#ff00ff',
        selection: null,
        locale: null,
      })
      for (let n = 1; n <= LOGGED; n++) {
        await instance.webSocketMessage(
          socket,
          JSON.stringify({
            type: 'tx',
            txId: `tx-${n}`,
            mutations: setTitle(`v${n}`),
            v: PROTOCOL_VERSION,
          }),
        )
      }
    })
  })

  it('replays from the log when the gap is exactly MAX_CATCHUP', async () => {
    const peer = await join(catchupStub(), {
      actor: 'a1',
      name: 'Ada',
      colour: '#ff00ff',
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
      colour: '#00ffff',
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
      colour: '#ffff00',
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
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')

    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })

    expect((await frame(bo, 'bootstrap')).peers).toEqual([
      { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff', selection: null, locale: null },
    ])
    expect(await frame(ada, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_bo', name: 'Bo', colour: '#00ffff', selection: null, locale: null },
    })
    ada.ws.close()
    bo.ws.close()
  })

  it('broadcasts a delta from one socket to the other', async () => {
    const stub = story('mp-delta')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
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
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'bootstrap')
    await frame(ada, 'presence')

    ada.send({ type: 'presence', selection: { uid: 'root0000', field: 'title' } })

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: {
        actor: 'usr_ada',
        name: 'Ada',
        colour: '#ff00ff',
        selection: { uid: 'root0000', field: 'title' },
        locale: null,
      },
    })
    // Ada's own inbox still holds only Bo's arrival.
    await settle()
    expect(framesOf(ada, 'presence')).toHaveLength(1)
    ada.ws.close()
    bo.ws.close()
  })

  /**
   * v4 (`live-collaboration.md`): the locale rides presence so a peer ring can
   * name it — two editors in one field in different languages are writing
   * different keys and are not in conflict. It rides the *story* channel rather
   * than being cross-referenced from the space channel so the label is right for
   * a host that never declared the space binding.
   */
  it('carries the editing locale alongside the selection', async () => {
    const stub = story('mp-presence-locale')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'bootstrap')
    await frame(ada, 'presence')

    ada.send({ type: 'presence', selection: { uid: 'root0000', field: 'title' }, locale: 'fr' })
    expect((await frame(bo, 'presence')).peer.locale).toBe('fr')

    // Back to the source locale: an absent locale means the source, permanently.
    ada.send({ type: 'presence', selection: { uid: 'root0000', field: 'title' } })
    expect((await frame(bo, 'presence', 2)).peer.locale).toBeNull()
    ada.ws.close()
    bo.ws.close()
  })

  it('tells the remaining socket that a peer has gone', async () => {
    const stub = story('mp-gone')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'bootstrap')

    ada.ws.close(1000, 'closing the tab')

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff', selection: null, locale: null },
      gone: true,
    })
    bo.ws.close()
  })
})

describe('StoryDO: protocol discipline', () => {
  // SPEC(tx-dedupe): a txId already in the log is acknowledged with the delta it
  // produced the first time, never applied or broadcast again.
  it('ignores a tx whose txId is already in the log', async () => {
    const stub = story('dedupe')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')
    const tx: ClientMsg = { type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') }

    peer.send(tx)
    await frame(peer, 'delta')
    // The same frame, verbatim: a client resending after a dropped acknowledgement.
    peer.send(tx)
    // Wait for the re-acknowledgement itself rather than a fixed number of ticks.
    // settle() is for asserting nothing arrived; here a second delta is expected,
    // and 20 ticks was occasionally not enough for it, which made this test flake.
    await frame(peer, 'delta', 2)

    const deltas = framesOf(peer, 'delta')
    expect(deltas[0]).toEqual({
      type: 'delta',
      syncId: 1,
      txId: 'tx-1',
      actor: 'usr_ada',
      mutations: setTitle('Renamed'),
    })
    // Re-acknowledged with the syncId the tx already has, marked as a replay so a
    // client that has moved on does not apply the stale mutations a second time.
    // Handing it a fresh syncId would not be fine, nor would a second log row.
    expect(deltas[1]).toEqual({
      type: 'delta',
      replay: true,
      syncId: 1,
      txId: 'tx-1',
      actor: 'usr_ada',
      mutations: setTitle('Renamed'),
    })
    expect([...new Set(deltas.map((d) => d.syncId))]).toEqual([1])
    const trail = await runInDurableObject(stub, (instance) => instance.recent())
    expect(trail.map((e) => e.syncId)).toEqual([1])
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.root0000?.data.title).toBe('Renamed')
    peer.ws.close()
  })

  // SPEC(pre-hello): a socket that has not said hello is not in the broadcast set,
  // so it cannot be handed an edit it has no watermark to place.
  it('keeps deltas away from a socket that has not said hello', async () => {
    const stub = story('pre-hello')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
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

  it('still answers a tx from a socket the quarantine covers', async () => {
    const stub = story('pre-hello-tx')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const lurker = await connect(stub)

    lurker.send({ type: 'tx', txId: 'tx-1', mutations: setTitle('Renamed') })

    // The quarantine withholds fan-out this socket did not ask for; the echo of
    // its own tx is the only acknowledgement it will ever get, so it is not
    // withheld — otherwise the first send goes unanswered and a resend does not.
    expect((await frame(lurker, 'delta')).txId).toBe('tx-1')
    expect((await frame(ada, 'delta')).actor).toBe('unknown')
    ada.ws.close()
    lurker.ws.close()
  })

  // SPEC(malformed-frame): a frame that is not JSON, or a tx that is not a valid
  // mutation, leaves the draft and the connection intact.
  it('survives a malformed frame and an invalid mutation', async () => {
    const stub = story('malformed')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
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

  it('names an unreadable frame in an error frame back to its sender', async () => {
    const stub = story('frame-error')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')

    peer.ws.send('not json at all {{{')
    expect((await frame(peer, 'error')).reason).toBe('unreadable frame')
    // A type the object does not implement is unreadable too, not silently dropped.
    peer.ws.send(JSON.stringify({ type: 'nonsense', v: PROTOCOL_VERSION }))
    expect((await frame(peer, 'error', 2)).reason).toBe('unreadable frame')
    peer.ws.close()
  })

  it('rejects a whole transaction when one of its mutations cannot apply', async () => {
    const stub = story('tx-reject')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'bootstrap')

    // The set would apply; removing the root never can.
    ada.send({
      type: 'tx',
      txId: 'tx-bad',
      mutations: [...setTitle('Renamed'), { t: 'remove', uid: 'root0000' }],
    })

    const reject = await frame(ada, 'reject')
    expect(reject.txId).toBe('tx-bad')
    expect(reject.reason).toContain('root remove')
    await settle()
    // Atomic: the half that could have applied did not, nothing was logged, and
    // no peer was told about an edit that does not exist.
    expect(await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))).toEqual(seed())
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
    expect(framesOf(ada, 'delta')).toEqual([])
    expect(framesOf(bo, 'delta')).toEqual([])
    ada.ws.close()
    bo.ws.close()
  })

  it('accepts a tx that moves an existing blok under one the same tx inserted', async () => {
    const stub = story('tx-compound')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')
    const blok = (uid: string, parent: string) => ({
      uid,
      type: 'box',
      parent,
      slot: 'body',
      order: 'a0',
      data: {},
    })

    peer.send({
      type: 'tx',
      txId: 'tx-1',
      mutations: [{ t: 'insert', blok: blok('kid00001', 'root0000') }],
    })
    await frame(peer, 'delta')
    // The shape diff() produces when a version restore reparents a survivor: the
    // new parent is only valid once the insert before it in the same tx lands.
    peer.send({
      type: 'tx',
      txId: 'tx-2',
      mutations: [
        { t: 'insert', blok: blok('box00001', 'root0000') },
        { t: 'move', uid: 'kid00001', parent: 'box00001', slot: 'body', order: 'a0' },
      ],
    })

    expect((await frame(peer, 'delta', 2)).txId).toBe('tx-2')
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.kid00001?.parent).toBe('box00001')
    peer.ws.close()
  })

  it('refuses a hello whose protocol version is missing or unknown', async () => {
    const stub = story('version')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))

    // A client from before the protocol carried a version.
    const stale = await connect(stub)
    const closes: number[] = []
    stale.ws.addEventListener('close', (event) => {
      closes.push(event.code)
    })
    stale.ws.send(
      JSON.stringify({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'a1', name: 'Ada', colour: '#ff00ff' },
      }),
    )

    const err = await frame(stale, 'error')
    expect(err.reason).toContain('unset')
    expect(err.reason).toContain(String(PROTOCOL_VERSION))
    await settle()
    // Refused, not tolerated: no state crosses to a peer we cannot understand.
    expect(framesOf(stale, 'bootstrap')).toEqual([])
    expect(closes).toEqual([4001])

    const future = await connect(stub)
    future.ws.send(
      JSON.stringify({
        type: 'hello',
        lastSyncId: 0,
        identity: { actor: 'a2', name: 'Bo', colour: '#00ffff' },
        v: PROTOCOL_VERSION + 98,
      }),
    )

    expect((await frame(future, 'error')).reason).toContain(String(PROTOCOL_VERSION + 98))
    await settle()
    expect(framesOf(future, 'bootstrap')).toEqual([])
  })

  it('refuses a later frame that claims an unknown version, not just the hello', async () => {
    const stub = story('version-tx')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')
    const closes: number[] = []
    peer.ws.addEventListener('close', (event) => {
      closes.push(event.code)
    })

    // A handshake this object understood does not license every later frame: the
    // version is a claim about the peer, so a frame that changes it is refused.
    peer.ws.send(
      JSON.stringify({
        type: 'tx',
        txId: 'tx-1',
        mutations: setTitle('FromV99'),
        v: PROTOCOL_VERSION + 98,
      }),
    )

    expect((await frame(peer, 'error')).reason).toContain(String(PROTOCOL_VERSION + 98))
    await settle()
    expect(framesOf(peer, 'delta')).toEqual([])
    expect(await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))).toEqual(seed())
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
    expect(closes).toEqual([4001])
  })

  it('announces a departure when a socket errors, exactly as a close does', async () => {
    const stub = story('ws-error')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(ada, 'bootstrap')
    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })
    await frame(bo, 'bootstrap')
    await frame(ada, 'presence')

    await runInDurableObject(stub, async (instance, state) => {
      const adaSide = state
        .getWebSockets()
        .find((s) => (s.deserializeAttachment() as Presence | null)?.actor === 'usr_ada')
      await instance.webSocketError(adaSide!)
    })

    expect(await frame(bo, 'presence')).toEqual({
      type: 'presence',
      peer: { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff', selection: null, locale: null },
      gone: true,
    })
    ada.ws.close()
    bo.ws.close()
  })
})

describe('StoryDO: wire caps', () => {
  // SPEC(frame-cap): a frame past MAX_FRAME_BYTES is named in an error and never
  // reaches JSON.parse; the connection is unaffected and keeps answering.
  it('answers an oversized frame with a named error and keeps the socket usable', async () => {
    const stub = story('cap-frame')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')

    peer.send({
      type: 'tx',
      txId: 'tx-huge',
      mutations: setTitle('x'.repeat(MAX_FRAME_BYTES + 1024)),
    })

    const err = await frame(peer, 'error')
    expect(err.reason).toContain('too large')
    expect(err.reason).toContain(String(MAX_FRAME_BYTES))
    await settle()
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])

    // Still open: a well-formed tx right after is applied and acknowledged.
    peer.send({ type: 'tx', txId: 'tx-good', mutations: setTitle('Renamed') })
    expect((await frame(peer, 'delta')).txId).toBe('tx-good')
    peer.ws.close()
  })

  // SPEC(tx-cap): a tx over MAX_TX_MUTATIONS is refused like an invalid mutation
  // - a reject naming the sender's txId, nothing logged, connection stays open -
  // not a version-mismatch-style close.
  it('rejects a tx over MAX_TX_MUTATIONS with a reject envelope, not a close', async () => {
    const stub = story('cap-tx')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')
    const closes: number[] = []
    peer.ws.addEventListener('close', (event) => closes.push(event.code))

    const mutations: Mutations = Array.from({ length: MAX_TX_MUTATIONS + 1 }, (_, i) => ({
      t: 'set',
      uid: 'root0000',
      field: `f${i}`,
      value: i,
    }))
    peer.send({ type: 'tx', txId: 'tx-over', mutations })

    const reject = await frame(peer, 'reject')
    expect(reject.txId).toBe('tx-over')
    expect(reject.reason).toContain(String(MAX_TX_MUTATIONS))
    await settle()
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
    expect(closes).toEqual([])

    peer.send({ type: 'tx', txId: 'tx-good', mutations: setTitle('Renamed') })
    expect((await frame(peer, 'delta')).txId).toBe('tx-good')
    peer.ws.close()
  })

  // SPEC(colour-cap): a colour the client cannot make the guard accept falls back
  // to one derived from actor, and that fallback - not the client's claim - is
  // what every other peer sees.
  it('falls back a spoofed colour, and the fallback is what peers see', async () => {
    const stub = story('cap-colour')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const ada = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: 'not-a-colour' })
    await frame(ada, 'bootstrap')

    const bo = await join(stub, { actor: 'usr_bo', name: 'Bo', colour: '#00ffff' })

    expect((await frame(bo, 'bootstrap')).peers).toEqual([
      {
        actor: 'usr_ada',
        name: 'Ada',
        colour: fallbackColour('usr_ada'),
        selection: null,
        locale: null,
      },
    ])
    ada.ws.close()
    bo.ws.close()
  })

  // SPEC(name-cap): an oversized or blank name is capped and defaulted before it
  // ever reaches a peer's presence list, not merely on the sender's own echo.
  it('caps an oversized name and defaults a blank one for every peer', async () => {
    const stub = story('cap-name')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const long = await join(stub, { actor: 'usr_ada', name: 'x'.repeat(200), colour: '#ff00ff' })
    await frame(long, 'bootstrap')

    const blank = await join(stub, { actor: 'usr_bo', name: '   ', colour: '#00ffff' })

    expect((await frame(blank, 'bootstrap')).peers).toEqual([
      {
        actor: 'usr_ada',
        name: 'x'.repeat(MAX_NAME_LEN),
        colour: '#ff00ff',
        selection: null,
        locale: null,
      },
    ])
    expect(await frame(long, 'presence')).toEqual({
      type: 'presence',
      peer: {
        actor: 'usr_bo',
        name: 'Anonymous',
        colour: '#00ffff',
        selection: null,
        locale: null,
      },
    })
    long.ws.close()
    blank.ws.close()
  })

  // SPEC(doc-cap): per-frame caps bound one message; nothing else bounds what an
  // unbounded run of individually-legal txs can grow the document to. A tx that
  // is itself tiny and otherwise legal is refused once it would push the whole
  // document past MAX_DOC_BLOKS, the same way an invalid mutation is refused.
  it('rejects a tx that would push the document over MAX_DOC_BLOKS', async () => {
    const stub = story('cap-doc-bloks')
    const near: Doc = {
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
        ...Object.fromEntries(
          Array.from({ length: MAX_DOC_BLOKS - 1 }, (_, i) => {
            const uid = `blok${String(i).padStart(4, '0')}`
            return [
              uid,
              { uid, type: 'box', parent: 'root0000', slot: 'body', order: `a${i}`, data: {} },
            ]
          }),
        ),
      },
    }
    // Seeded directly: MAX_DOC_BLOKS - 1 real transactions would make this test
    // itself the slow, unbounded thing the cap exists to prevent.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'insert into doc (id, json, sync_id) values (1, ?, 0)',
        JSON.stringify(near),
      )
    })

    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')

    peer.send({
      type: 'tx',
      txId: 'tx-grow',
      mutations: [
        {
          t: 'insert',
          blok: {
            uid: 'oneTooMany',
            type: 'box',
            parent: 'root0000',
            slot: 'body',
            order: 'zz',
            data: {},
          },
        },
      ],
    })

    const reject = await frame(peer, 'reject')
    expect(reject.txId).toBe('tx-grow')
    expect(reject.reason).toContain(String(MAX_DOC_BLOKS))
    await settle()
    // Refused at the door like any other cap: nothing logged, doc unchanged.
    expect(await runInDurableObject(stub, (instance) => instance.recent())).toEqual([])
    const doc = await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    expect(doc.bloks.oneTooMany).toBeUndefined()

    // Still open: a well-formed tx right after is applied and acknowledged.
    peer.send({ type: 'tx', txId: 'tx-good', mutations: setTitle('Renamed') })
    expect((await frame(peer, 'delta')).txId).toBe('tx-good')
    peer.ws.close()
  })

  // SPEC(version-every-frame): an absent `v` is a mismatch for every frame type,
  // not only `hello` - a socket cannot dodge version discipline by simply
  // omitting the field on a later frame.
  it('refuses a presence frame with no version, exactly like a versionless hello', async () => {
    const stub = story('cap-version-presence')
    await runInDurableObject(stub, (instance) => instance.getOrInit(seed()))
    const peer = await join(stub, { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' })
    await frame(peer, 'bootstrap')
    const closes: number[] = []
    peer.ws.addEventListener('close', (event) => closes.push(event.code))

    peer.ws.send(JSON.stringify({ type: 'presence', selection: { uid: 'root0000', field: null } }))

    const err = await frame(peer, 'error')
    expect(err.reason).toContain('unset')
    await settle()
    expect(closes).toEqual([4001])
  })
})
