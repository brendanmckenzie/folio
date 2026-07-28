import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryStore, type WebSocketLike } from '../../../src/admin/store'
import type { Doc } from '../../../src/core/doc'
import type { Mutation } from '../../../src/core/mutations'
import type { ClientMsg, Presence, ServerMsg } from '../../../src/core/protocol'

type HelloMsg = Extract<ClientMsg, { type: 'hello' }>
type TxMsg = Extract<ClientMsg, { type: 'tx' }>

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/**
 * Stands in for the browser WebSocket. Nothing happens on its own: the test
 * opens it, feeds it server frames and drops it, so every ordering is explicit.
 */
class FakeSocket implements WebSocketLike {
  readyState = CONNECTING
  /** Everything handed to send(). A real socket would refuse some of it. */
  readonly frames: string[] = []
  closedByStore = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(readonly path: string) {}

  send(data: string) {
    this.frames.push(data)
  }

  /** The store hanging up. A real socket reports onclose asynchronously, so this does not. */
  close() {
    this.closedByStore = true
    this.readyState = CLOSED
  }

  open() {
    this.readyState = OPEN
    this.onopen?.({})
  }

  emit(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  /** The transport going away underneath the store. */
  drop() {
    this.readyState = CLOSED
    this.onclose?.({})
  }

  client(): ClientMsg[] {
    return this.frames.map((f) => JSON.parse(f) as ClientMsg)
  }

  hello(): HelloMsg | undefined {
    return this.client().find((m): m is HelloMsg => m.type === 'hello')
  }

  txs(): TxMsg[] {
    return this.client().filter((m): m is TxMsg => m.type === 'tx')
  }
}

function fixture(): Doc {
  return {
    root: 'root',
    bloks: {
      root: {
        uid: 'root',
        type: 'page',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'Home' },
      },
      hero: {
        uid: 'hero',
        type: 'hero',
        parent: 'root',
        slot: 'body',
        order: 'a1',
        data: { heading: 'Hi', sub: 'There' },
      },
    },
  }
}

function peer(actor: string, selection: string | null = null): Presence {
  return { actor, name: `Editor ${actor}`, colour: '#0090ff', selection }
}

function set(uid: string, field: string, value: string): Mutation {
  return { t: 'set', uid, field, value }
}

function setup() {
  const sockets: FakeSocket[] = []
  const applied: Mutation[][] = []
  const resets: Doc[] = []
  const store = new StoryStore('page-1', '/folio', {
    createSocket: (path) => {
      const socket = new FakeSocket(path)
      sockets.push(socket)
      return socket
    },
  })
  store.onMutations = (mutations) => applied.push(mutations)
  store.onReset = (doc) => resets.push(doc)
  return { store, sockets, applied, resets, last: () => sockets[sockets.length - 1]! }
}

type Harness = ReturnType<typeof setup>

/** Connect, open the socket and bootstrap it at `syncId`. */
function boot(h: Harness, syncId = 0, peers: Presence[] = []): FakeSocket {
  h.store.connect()
  h.last().open()
  h.last().emit({ type: 'bootstrap', doc: fixture(), syncId, peers })
  return h.last()
}

function value(store: StoryStore, uid: string, field: string) {
  return store.getSnapshot().doc?.bloks[uid]?.data[field]
}

/** Let the backoff timer fire and open whatever socket the store made. */
function reconnect(h: Harness): FakeSocket {
  vi.advanceTimersByTime(500)
  const socket = h.last()
  socket.open()
  return socket
}

describe('admin sync store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('connecting', () => {
    it('opens the story socket and says hello with its watermark', () => {
      const h = setup()
      h.store.connect()

      expect(h.sockets).toHaveLength(1)
      expect(h.last().path).toBe('/folio/story/page-1/socket')
      // Nothing is sent before the socket is open.
      expect(h.last().frames).toEqual([])

      h.last().open()

      expect(h.last().hello()).toEqual({
        type: 'hello',
        actor: h.store.actor,
        name: h.store.name,
        colour: h.store.colour,
        lastSyncId: 0,
      })
      expect(h.store.getSnapshot().connected).toBe(true)
    })

    it('does not open a second socket while one is connecting', () => {
      const h = setup()
      h.store.connect()
      h.store.connect()
      expect(h.sockets).toHaveLength(1)
    })

    it('reconnects with backoff after the transport drops', () => {
      const h = setup()
      boot(h, 2)

      h.last().drop()
      expect(h.store.getSnapshot().connected).toBe(false)

      vi.advanceTimersByTime(499)
      expect(h.sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(h.sockets).toHaveLength(2)

      // A failed attempt doubles the delay; a successful open resets it.
      h.last().drop()
      vi.advanceTimersByTime(999)
      expect(h.sockets).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(h.sockets).toHaveLength(3)
    })
  })

  describe('receiving', () => {
    it('bootstrap replaces the document, peers and selection', () => {
      const h = setup()
      boot(h, 7, [peer('bee', 'hero')])

      const state = h.store.getSnapshot()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(state.peers).toEqual([peer('bee', 'hero')])
      // Opened on the root so the inspector shows page settings, not an empty panel.
      expect(state.selection).toBe('root')
      expect(h.resets).toHaveLength(1)
      expect(h.applied).toEqual([])
      // Selecting the root announces presence.
      expect(
        h
          .last()
          .client()
          .map((m) => m.type),
      ).toEqual(['hello', 'presence'])
    })

    it('catchup applies missed deltas in log order and advances the watermark', () => {
      const h = setup()
      boot(h, 4)

      h.last().emit({
        type: 'catchup',
        syncId: 6,
        peers: [peer('bee')],
        deltas: [
          { syncId: 5, txId: 'r1', actor: 'bee', mutations: [set('hero', 'heading', 'first')] },
          { syncId: 6, txId: 'r2', actor: 'bee', mutations: [set('hero', 'heading', 'second')] },
        ],
      })

      expect(value(h.store, 'hero', 'heading')).toBe('second')
      expect(h.applied).toEqual([
        [set('hero', 'heading', 'first')],
        [set('hero', 'heading', 'second')],
      ])
      expect(h.store.getSnapshot().peers).toEqual([peer('bee')])

      h.last().drop()
      expect(reconnect(h).hello()?.lastSyncId).toBe(6)
    })

    it('applies a remote delta and forwards it to the preview', () => {
      const h = setup()
      boot(h, 4)

      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: 'r1',
        actor: 'bee',
        mutations: [set('hero', 'sub', 'Elsewhere')],
      })

      expect(value(h.store, 'hero', 'sub')).toBe('Elsewhere')
      expect(h.applied).toEqual([[set('hero', 'sub', 'Elsewhere')]])
    })

    it('presence adds, replaces and removes a peer', () => {
      const h = setup()
      boot(h)

      h.last().emit({ type: 'presence', peer: peer('bee', 'hero') })
      expect(h.store.getSnapshot().peers).toEqual([peer('bee', 'hero')])

      h.last().emit({ type: 'presence', peer: peer('bee', 'root') })
      expect(h.store.getSnapshot().peers).toEqual([peer('bee', 'root')])

      h.last().emit({ type: 'presence', peer: peer('bee', 'root'), gone: true })
      expect(h.store.getSnapshot().peers).toEqual([])
    })
  })

  describe('optimistic transactions', () => {
    it('applies locally at once, sends the frame, and stays inflight until the echo', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Edited')])

      // Local apply and preview forwarding happen with no network in the loop.
      expect(value(h.store, 'hero', 'heading')).toBe('Edited')
      expect(h.applied).toEqual([[set('hero', 'heading', 'Edited')]])
      // The toolbar reads inflight > 0 as "Saving…".
      expect(h.store.getSnapshot().inflight).toBe(1)

      const tx = h.last().txs()[0]!
      expect(tx.mutations).toEqual([set('hero', 'heading', 'Edited')])

      h.last().emit({
        type: 'delta',
        syncId: 4,
        txId: tx.txId,
        actor: h.store.actor,
        mutations: tx.mutations,
      })

      // The echo is the acknowledgement: pending drains and "Saving…" clears.
      expect(h.store.getSnapshot().inflight).toBe(0)
      expect(value(h.store, 'hero', 'heading')).toBe('Edited')
      // Not applied or forwarded twice.
      expect(h.applied).toEqual([[set('hero', 'heading', 'Edited')]])
    })

    it('counts every unacknowledged transaction', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'One')])
      h.store.tx([set('root', 'title', 'Two')])
      expect(h.store.getSnapshot().inflight).toBe(2)

      const [first, second] = h.last().txs()
      h.last().emit({
        type: 'delta',
        syncId: 4,
        txId: first!.txId,
        actor: h.store.actor,
        mutations: first!.mutations,
      })
      expect(h.store.getSnapshot().inflight).toBe(1)
      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: second!.txId,
        actor: h.store.actor,
        mutations: second!.mutations,
      })
      expect(h.store.getSnapshot().inflight).toBe(0)
    })

    it('ignores a transaction before there is a document', () => {
      const h = setup()
      h.store.connect()
      h.last().open()

      h.store.tx([set('hero', 'heading', 'Too early')])

      expect(h.last().txs()).toEqual([])
      expect(h.store.getSnapshot().inflight).toBe(0)
    })
  })

  describe('undo coalescing', () => {
    it('collapses a run on the same field into one undo entry', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'H')])
      vi.advanceTimersByTime(100)
      h.store.tx([set('hero', 'heading', 'He')])
      vi.advanceTimersByTime(100)
      h.store.tx([set('hero', 'heading', 'Hey')])
      expect(value(h.store, 'hero', 'heading')).toBe('Hey')

      h.store.undo()

      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.store.getSnapshot().canUndo).toBe(false)
    })

    it('starts a new undo entry for a different field', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'H')])
      vi.advanceTimersByTime(100)
      h.store.tx([set('hero', 'sub', 'S')])

      h.store.undo()
      expect(value(h.store, 'hero', 'sub')).toBe('There')
      expect(value(h.store, 'hero', 'heading')).toBe('H')
      expect(h.store.getSnapshot().canUndo).toBe(true)

      h.store.undo()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.store.getSnapshot().canUndo).toBe(false)
    })

    it('starts a new undo entry once the coalesce window has passed', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'H')])
      // The window is 700ms from the previous edit on that field.
      vi.advanceTimersByTime(800)
      h.store.tx([set('hero', 'heading', 'He')])

      h.store.undo()
      expect(value(h.store, 'hero', 'heading')).toBe('H')
      expect(h.store.getSnapshot().canUndo).toBe(true)
    })

    it('never coalesces a multi-mutation transaction', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'H')])
      h.store.tx([set('hero', 'heading', 'He'), set('hero', 'sub', 'S')])

      h.store.undo()
      expect(value(h.store, 'hero', 'heading')).toBe('H')
      expect(value(h.store, 'hero', 'sub')).toBe('There')
    })
  })

  describe('undo and redo', () => {
    it('round-trips through the socket as ordinary transactions', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'X')])
      h.store.undo()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true })

      h.store.redo()
      expect(value(h.store, 'hero', 'heading')).toBe('X')
      expect(h.store.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false })

      // Undo and redo travel to the other editors like any other edit.
      expect(
        h
          .last()
          .txs()
          .map((t) => t.mutations),
      ).toEqual([
        [set('hero', 'heading', 'X')],
        [set('hero', 'heading', 'Hi')],
        [set('hero', 'heading', 'X')],
      ])
    })

    it('drops the redo stack when a new local transaction arrives', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'X')])
      h.store.undo()
      expect(h.store.getSnapshot().canRedo).toBe(true)

      h.store.tx([set('hero', 'sub', 'S')])
      expect(h.store.getSnapshot().canRedo).toBe(false)

      h.store.redo()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })

    it('bootstrap clears the undo history', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'X')])
      expect(h.store.getSnapshot().canUndo).toBe(true)

      h.last().emit({ type: 'bootstrap', doc: fixture(), syncId: 9, peers: [] })
      expect(h.store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false })
    })
  })

  describe('selection', () => {
    it('announces a change once and ignores a repeat', () => {
      const h = setup()
      boot(h)

      h.store.select('hero')
      h.store.select('hero')

      expect(
        h
          .last()
          .client()
          .filter((m) => m.type === 'presence'),
      ).toEqual([
        { type: 'presence', selection: 'root' },
        { type: 'presence', selection: 'hero' },
      ])
      expect(h.store.getSnapshot().selection).toBe('hero')
    })
  })

  describe('known bugs', () => {
    // SPEC(offline-queue): txs made while the socket is down are queued, sent on reconnect, and
    // still reflected in the doc afterwards. Currently fails: send() silently drops the frame and
    // bootstrap clears pending.
    it.fails('queues transactions made while offline and replays them on reconnect', () => {
      const h = setup()
      boot(h, 3)

      h.last().drop()
      expect(h.store.getSnapshot().connected).toBe(false)

      h.store.tx([set('hero', 'heading', 'Offline edit')])
      expect(value(h.store, 'hero', 'heading')).toBe('Offline edit')

      const next = reconnect(h)
      // The client cannot be caught up from the log, so the DO re-sends the document.
      next.emit({ type: 'bootstrap', doc: fixture(), syncId: 3, peers: [] })

      expect(next.txs().map((t) => t.mutations)).toEqual([[set('hero', 'heading', 'Offline edit')]])
      expect(value(h.store, 'hero', 'heading')).toBe('Offline edit')
    })

    // SPEC(echo-rebase): when the server logs a remote tx before this client's pending tx, every
    // client must converge on the server's log order. Currently fails: the echo is swallowed as a
    // bare ack, so the remote value applied over the optimistic one is what sticks.
    it.fails('converges on the server order when a remote tx is logged first', () => {
      const h = setup()
      boot(h, 10)

      h.store.tx([set('root', 'title', 'mine')])
      const tx = h.last().txs()[0]!

      // The DO logged the other editor's transaction first, so the log reads: theirs, then mine.
      h.last().emit({
        type: 'delta',
        syncId: 11,
        txId: 'remote-1',
        actor: 'bee',
        mutations: [set('root', 'title', 'theirs')],
      })
      h.last().emit({
        type: 'delta',
        syncId: 12,
        txId: tx.txId,
        actor: h.store.actor,
        mutations: tx.mutations,
      })

      // Replaying the log gives 'mine'; that is where every client has to land.
      expect(value(h.store, 'root', 'title')).toBe('mine')
    })

    // SPEC(reconnect-timer): a reconnect scheduled before disconnect() must never fire.
    // Currently fails: the timer is not cancelled and connect() resets `closed`.
    it.fails('never reconnects after disconnect()', () => {
      const h = setup()
      boot(h)

      h.last().drop()
      h.store.disconnect()
      vi.advanceTimersByTime(60_000)

      expect(h.sockets).toHaveLength(1)
    })

    // SPEC(watermark): lastSyncId must stop at the first gap so a missed delta is still replayed.
    // Currently fails: integrate() takes max(), so syncId 5 hides the missing 4.
    it.fails('does not advance the watermark past a gap', () => {
      const h = setup()
      boot(h, 2)

      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: 'r5',
        actor: 'bee',
        mutations: [set('hero', 'heading', 'five')],
      })
      h.last().emit({
        type: 'delta',
        syncId: 3,
        txId: 'r3',
        actor: 'bee',
        mutations: [set('hero', 'sub', 'three')],
      })

      h.last().drop()
      // 4 never arrived, so asking for everything after 4 or later loses it for good.
      expect(reconnect(h).hello()?.lastSyncId).toBeLessThan(4)
    })
  })
})
