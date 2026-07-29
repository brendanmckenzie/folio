import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryStore, type WebSocketLike } from '../../../src/admin/store'
import type { Doc } from '../../../src/core/doc'
import type { Mutation } from '../../../src/core/mutations'
import {
  type ClientMsg,
  type Presence,
  PROTOCOL_VERSION,
  type ServerMsg,
} from '../../../src/core/protocol'

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

  /** A server frame, versioned exactly as the object encodes it. */
  emit(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify({ ...msg, v: PROTOCOL_VERSION }) })
  }

  /** Whatever the peer on the other end actually put on the wire. */
  deliver(data: string) {
    this.onmessage?.({ data })
  }

  /** The transport going away underneath the store. */
  drop(code?: number, reason?: string) {
    this.readyState = CLOSED
    this.onclose?.(code === undefined ? {} : { code, reason })
  }

  client(): ClientMsg[] {
    return this.frames.map((f) => JSON.parse(f) as ClientMsg)
  }

  hello(): HelloMsg | undefined {
    return this.client().find((m): m is HelloMsg => m.type === 'hello')
  }

  /** The watermark every hello on this socket asked from, in order. */
  hellos(): number[] {
    return this.client()
      .filter((m): m is HelloMsg => m.type === 'hello')
      .map((m) => m.lastSyncId)
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
        v: PROTOCOL_VERSION,
        lastSyncId: 0,
        // v3: one optional nested object, advisory, and read only under
        // `auth: 'open'` (`localisation.md`).
        identity: { actor: h.store.actor, name: h.store.name, colour: h.store.colour },
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

    it('stamps a transaction with a 64-bit id', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Edited')])

      // The log's unique dedupe key. A collision answers this tx with the delta of
      // a stranger's transaction, which drains the queue without applying anything
      // — so the id is full entropy, not a uuid slice.
      expect(h.last().txs()[0]!.txId).toMatch(/^[0-9a-f]{16}$/)
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

    it('bootstrap clears the history a new base has absorbed', () => {
      const h = setup()
      boot(h)

      h.store.tx([set('hero', 'heading', 'X')])
      const tx = h.last().txs()[0]!
      h.last().emit({
        type: 'delta',
        syncId: 1,
        txId: tx.txId,
        actor: h.store.actor,
        mutations: tx.mutations,
      })
      expect(h.store.getSnapshot()).toMatchObject({ inflight: 0, canUndo: true })

      // Confirmed, so nothing in the history can be placed against the new base.
      h.last().emit({ type: 'bootstrap', doc: fixture(), syncId: 9, peers: [] })
      expect(h.store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false })
    })

    it('bootstrap keeps the history entry of a transaction it left pending', () => {
      const h = setup()
      boot(h, 3)

      h.last().drop()
      h.store.tx([set('hero', 'heading', 'Offline')])

      const next = reconnect(h)
      next.emit({ type: 'bootstrap', doc: fixture(), syncId: 3, peers: [] })

      // The edit is on screen and in flight, so it stays undoable: the entries that
      // go are the ones the new base absorbed, not the queue's.
      expect(h.store.getSnapshot()).toMatchObject({ inflight: 1, canUndo: true })
      h.store.undo()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })
  })

  /**
   * `localisation.md`'s "two locales, one document, no conflict" and "each
   * editor's Cmd+Z reverts only their own locale".
   *
   * The store learns nothing about locales: a locale-scoped `set` is an ordinary
   * mutation, so it inherits the optimistic apply, the coalescing window, the
   * undo stack and the wire discipline for free. These tests exist to pin that
   * it really is free.
   */
  describe('locale-scoped transactions', () => {
    const setIn = (uid: string, field: string, value: string, locale: string): Mutation => ({
      t: 'set',
      uid,
      field,
      value,
      locale,
    })

    const translated = (store: StoryStore, uid: string, field: string, locale: string) =>
      store.getSnapshot().doc?.bloks[uid]?.i18n?.[locale]?.[field]

    it('applies a translation locally and leaves the source alone', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([setIn('hero', 'heading', 'Bonjour', 'fr')])

      expect(translated(h.store, 'hero', 'heading', 'fr')).toBe('Bonjour')
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      // The locale rides on the wire unchanged, so the object writes the same key.
      expect(h.last().txs()[0]?.mutations).toEqual([setIn('hero', 'heading', 'Bonjour', 'fr')])
    })

    it('lets two locales edit the same field with neither overwriting the other', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([setIn('hero', 'heading', 'Bonjour', 'fr')])
      // The other translator's delta arrives from the object.
      const ours = h.last().txs()[0]!
      h.last().emit({
        type: 'delta',
        syncId: 4,
        txId: ours.txId,
        actor: h.store.actor,
        mutations: ours.mutations,
      })
      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: 'tx-de',
        actor: 'someone-else',
        mutations: [setIn('hero', 'heading', 'Hallo', 'de')],
      })

      expect(translated(h.store, 'hero', 'heading', 'fr')).toBe('Bonjour')
      expect(translated(h.store, 'hero', 'heading', 'de')).toBe('Hallo')
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })

    it('undoes only its own locale', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([setIn('hero', 'heading', 'Bonjour', 'fr')])
      h.store.tx([setIn('hero', 'heading', 'Hallo', 'de')])
      // Two entries, not one: different fields as far as coalescing is concerned
      // would be wrong here — it is the same field, so this pins that a locale
      // change is not coalesced into the previous locale's edit.
      h.store.undo()

      expect(translated(h.store, 'hero', 'heading', 'de')).toBeNull()
      expect(translated(h.store, 'hero', 'heading', 'fr')).toBe('Bonjour')
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })

    it('undoes a source-locale edit without touching a translation', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([setIn('hero', 'heading', 'Bonjour', 'fr')])
      h.store.tx([set('hero', 'heading', 'Edited')])
      h.store.undo()

      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(translated(h.store, 'hero', 'heading', 'fr')).toBe('Bonjour')
    })

    /**
     * The coalescing window keys on `(uid, field)` and deliberately not on the
     * locale: a translator typing into the French heading produces one undo step
     * per run of keystrokes, which is the behaviour every other field already has.
     * Switching locale mid-run is not a case worth a second key — the switch
     * reloads the preview, which takes longer than the window.
     */
    it('coalesces a run of keystrokes in one locale into one undo step', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([setIn('hero', 'heading', 'B', 'fr')])
      h.store.tx([setIn('hero', 'heading', 'Bo', 'fr')])
      h.store.tx([setIn('hero', 'heading', 'Bon', 'fr')])
      h.store.undo()

      expect(translated(h.store, 'hero', 'heading', 'fr')).toBeNull()
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
        { type: 'presence', v: PROTOCOL_VERSION, selection: 'root' },
        { type: 'presence', v: PROTOCOL_VERSION, selection: 'hero' },
      ])
      expect(h.store.getSnapshot().selection).toBe('hero')
    })
  })

  describe('rebase and rejection', () => {
    it('drops a rejected transaction, its history entry and nothing else', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Refused')])
      const tx = h.last().txs()[0]!
      expect(h.store.getSnapshot()).toMatchObject({ inflight: 1, canUndo: true })

      h.last().emit({ type: 'reject', txId: tx.txId, reason: 'no such blok' })

      // The tx never landed, so the view goes back to base and the entry that
      // would have undone it is gone with it.
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.store.getSnapshot()).toMatchObject({
        inflight: 0,
        canUndo: false,
        canRedo: false,
        notice: 'Edit refused: no such blok',
      })

      h.store.undo()
      expect(h.last().txs()).toHaveLength(1)
    })

    it('drops the history entries taken after a refused transaction', () => {
      const h = setup()
      boot(h, 3)

      // Locally the set applies and the move no-ops against a missing parent; the
      // object refuses the whole transaction, so this view never existed there.
      h.store.tx([
        set('hero', 'heading', 'A'),
        { t: 'move', uid: 'hero', parent: 'gone', slot: 'body', order: 'a1' },
      ])
      const refused = h.last().txs()[0]!
      h.store.tx([set('hero', 'heading', 'B')])

      h.last().emit({ type: 'reject', txId: refused.txId, reason: 'missing parent' })

      expect(value(h.store, 'hero', 'heading')).toBe('B')
      // The later entry inverts to 'A' — a value no server state will ever hold —
      // so it leaves with the refusal instead of putting 'A' back on the wire.
      expect(h.store.getSnapshot().canUndo).toBe(false)
      const sent = h.last().txs().length
      h.store.undo()
      expect(h.last().txs()).toHaveLength(sent)
    })

    it('keeps the history from before a refused transaction', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'sub', 'Kept')])
      const kept = h.last().txs()[0]!
      h.last().emit({
        type: 'delta',
        syncId: 4,
        txId: kept.txId,
        actor: h.store.actor,
        mutations: kept.mutations,
      })
      h.store.tx([set('hero', 'heading', 'Refused')])
      const refused = h.last().txs()[1]!

      h.last().emit({ type: 'reject', txId: refused.txId, reason: 'no such blok' })

      // That entry inverts against confirmed state only, so it is still reachable.
      expect(h.store.getSnapshot().canUndo).toBe(true)
      h.store.undo()
      expect(value(h.store, 'hero', 'sub')).toBe('There')
    })

    it('cannot redo a transaction the server refused', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Refused')])
      const tx = h.last().txs()[0]!
      // Undone before the verdict arrives: the redo entry would put 'Refused' back.
      h.store.undo()
      expect(h.store.getSnapshot().canRedo).toBe(true)

      h.last().emit({ type: 'reject', txId: tx.txId, reason: 'no such blok' })

      expect(h.store.getSnapshot().canRedo).toBe(false)
      h.store.redo()
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })

    it('re-runs the handshake when a delta arrives past a gap', () => {
      const h = setup()
      boot(h, 2)

      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: 'r5',
        actor: 'bee',
        mutations: [set('hero', 'heading', 'five')],
      })

      // Not applied, and the handshake is re-run from the watermark to fill the hole
      // (the first hello on this socket predates the bootstrap, hence the 0).
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.last().hellos()).toEqual([0, 2])

      h.last().emit({
        type: 'catchup',
        syncId: 5,
        peers: [],
        deltas: [
          { syncId: 3, txId: 'r3', actor: 'bee', mutations: [set('hero', 'sub', 'three')] },
          { syncId: 4, txId: 'r4', actor: 'bee', mutations: [set('root', 'title', 'four')] },
          { syncId: 5, txId: 'r5', actor: 'bee', mutations: [set('hero', 'heading', 'five')] },
        ],
      })
      expect(value(h.store, 'hero', 'heading')).toBe('five')
      h.last().drop()
      expect(reconnect(h).hello()?.lastSyncId).toBe(5)
    })

    it('asks for a bootstrap when the catchup cannot bridge the gap', () => {
      const h = setup()
      boot(h, 2)

      h.last().emit({
        type: 'delta',
        syncId: 5,
        txId: 'r5',
        actor: 'bee',
        mutations: [set('hero', 'heading', 'five')],
      })
      // The log could not fill 3 and 4, so the catchup still starts past the gap.
      h.last().emit({
        type: 'catchup',
        syncId: 5,
        peers: [],
        deltas: [
          { syncId: 5, txId: 'r5', actor: 'bee', mutations: [set('hero', 'heading', 'five')] },
        ],
      })

      // lastSyncId 0 is the only way to ask this protocol for the whole document.
      expect(h.last().hellos()).toEqual([0, 2, 0])
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
    })

    it('does not re-send a queued transaction the catchup already confirmed', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Landed')])
      const tx = h.last().txs()[0]!
      h.last().drop()

      const next = reconnect(h)
      next.emit({
        type: 'catchup',
        syncId: 4,
        peers: [],
        deltas: [{ syncId: 4, txId: tx.txId, actor: h.store.actor, mutations: tx.mutations }],
      })

      expect(next.txs()).toEqual([])
      expect(h.store.getSnapshot().inflight).toBe(0)
      expect(value(h.store, 'hero', 'heading')).toBe('Landed')
    })

    it('drains a resent transaction on the replayed acknowledgement', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Landed')])
      const tx = h.last().txs()[0]!
      h.last().drop()

      // It did land before the socket went away, so the bootstrap already has it.
      const landed = fixture()
      landed.bloks.hero = { ...landed.bloks.hero!, data: { heading: 'Landed', sub: 'There' } }
      const next = reconnect(h)
      next.emit({ type: 'bootstrap', doc: landed, syncId: 4, peers: [] })
      expect(next.txs().map((t) => t.txId)).toEqual([tx.txId])

      next.emit({
        type: 'delta',
        replay: true,
        syncId: 4,
        txId: tx.txId,
        actor: h.store.actor,
        mutations: tx.mutations,
      })

      // The stale mutations are not applied over the newer base; the tx just drains.
      expect(h.store.getSnapshot().inflight).toBe(0)
      expect(value(h.store, 'hero', 'heading')).toBe('Landed')
    })

    it('re-seeds the preview when a replayed acknowledgement changes the view', () => {
      const h = setup()
      boot(h, 3)

      h.store.tx([set('hero', 'heading', 'Mine')])
      const tx = h.last().txs()[0]!
      h.last().drop()

      // It landed at 4 and a peer overwrote the field at 5, so the fresh base does
      // not contain it and replaying the queue puts it back on screen.
      const newer = fixture()
      newer.bloks.hero = { ...newer.bloks.hero!, data: { heading: 'Peer', sub: 'There' } }
      const next = reconnect(h)
      next.emit({ type: 'bootstrap', doc: newer, syncId: 5, peers: [] })
      expect(value(h.store, 'hero', 'heading')).toBe('Mine')

      const seen = h.resets.length
      next.emit({
        type: 'delta',
        replay: true,
        syncId: 4,
        txId: tx.txId,
        actor: h.store.actor,
        mutations: tx.mutations,
      })

      // Draining the queue changed the view, so the preview cannot be left holding
      // the replayed one: the acknowledgement re-seeds it with the whole document.
      expect(value(h.store, 'hero', 'heading')).toBe('Peer')
      expect(h.resets.slice(seen).map((d) => d.bloks.hero!.data.heading)).toEqual(['Peer'])
    })

    it('a mid-session bootstrap keeps a selection the document still has', () => {
      const h = setup()
      boot(h, 2)
      h.store.select('hero')

      // A gap the log could not bridge sends the document mid-edit; the cursor
      // must not move, and no third presence frame goes out.
      h.last().emit({ type: 'bootstrap', doc: fixture(), syncId: 6, peers: [] })

      expect(h.store.getSnapshot().selection).toBe('hero')
      expect(
        h
          .last()
          .client()
          .filter((m) => m.type === 'presence'),
      ).toEqual([
        { type: 'presence', v: PROTOCOL_VERSION, selection: 'root' },
        { type: 'presence', v: PROTOCOL_VERSION, selection: 'hero' },
      ])
    })

    it('a bootstrap that lost the selected blok falls back to the root', () => {
      const h = setup()
      boot(h, 2)
      h.store.select('hero')

      const withoutHero = fixture()
      delete withoutHero.bloks.hero
      h.last().emit({ type: 'bootstrap', doc: withoutHero, syncId: 6, peers: [] })

      expect(h.store.getSnapshot().selection).toBe('root')
    })
  })

  describe('wire discipline', () => {
    it('reports an unreadable frame instead of throwing out of the handler', () => {
      const h = setup()
      boot(h, 3)

      expect(() => h.last().deliver('{ not json')).not.toThrow()
      expect(h.store.getSnapshot().notice).toBe('Unreadable frame from the server.')

      // The socket is still live: the next readable frame applies as usual.
      h.last().emit({
        type: 'delta',
        syncId: 4,
        txId: 'r4',
        actor: 'bee',
        mutations: [set('hero', 'sub', 'ok')],
      })
      expect(value(h.store, 'hero', 'sub')).toBe('ok')
    })

    it('refuses a frame that claims a version it does not implement', () => {
      const h = setup()
      boot(h, 3)

      h.last().deliver(
        JSON.stringify({
          type: 'delta',
          v: PROTOCOL_VERSION + 1,
          syncId: 4,
          txId: 'r4',
          actor: 'bee',
          mutations: [set('hero', 'heading', 'from the future')],
        }),
      )

      // Applying a frame of an unknown vintage is how a document diverges silently.
      expect(value(h.store, 'hero', 'heading')).toBe('Hi')
      expect(h.store.getSnapshot().notice).toContain(`protocol version ${PROTOCOL_VERSION + 1}`)
      // Terminal: a reconnect would meet the same two versions.
      expect(h.last().closedByStore).toBe(true)
      vi.advanceTimersByTime(60_000)
      expect(h.sockets).toHaveLength(1)
    })

    it('does not retry a connection the object refused', () => {
      const h = setup()
      boot(h, 3)

      h.last().drop(4001, 'unsupported protocol version')

      vi.advanceTimersByTime(60_000)
      expect(h.sockets).toHaveLength(1)
      expect(h.store.getSnapshot().notice).toBe('unsupported protocol version')
    })

    it('does not retry after the story has been purged', () => {
      const h = setup()
      boot(h, 3)

      h.last().drop(4002, 'story deleted')

      vi.advanceTimersByTime(60_000)
      expect(h.sockets).toHaveLength(1)
      expect(h.store.getSnapshot().notice).toBe('story deleted')
    })

    // SPEC(session-close): 4003 is terminal and offers a sign-in link, and — the
    // part that matters — `pending` survives it, so nothing typed is lost when a
    // session expires mid-edit (identity-and-access.md's first edge case).
    it('goes terminal on 4003 with a sign-in link, and keeps the unsent queue', () => {
      const h = setup()
      boot(h, 3)

      // Two edits in flight, unacknowledged.
      h.store.tx([set('hero', 'heading', 'Typed while signed in')])
      h.store.tx([set('hero', 'heading', 'And again')])
      const sentBefore = h.last().txs().length
      expect(sentBefore).toBe(2)
      expect(h.store.getSnapshot().inflight).toBe(2)

      h.last().drop(4003, 'session expired')

      vi.advanceTimersByTime(60_000)
      // Refused, not dropped: reconnecting cannot change the answer.
      expect(h.sockets).toHaveLength(1)
      const state = h.store.getSnapshot()
      expect(state.signIn).toBe(true)
      // The store's own wording, not the server's terse reason: only the client
      // knows the queue survived, and that is the part a person needs told.
      expect(state.notice).toContain('Sign in again')
      expect(state.notice).toContain('nothing you typed has been lost')
      // Still queued, and still on screen.
      expect(state.inflight).toBe(2)
      expect(value(h.store, 'hero', 'heading')).toBe('And again')

      // Signing in again and reconnecting re-sends them with their original
      // txIds, which the object's log dedupes.
      const before = h
        .last()
        .txs()
        .map((t) => t.txId)
      h.store.connect()
      const revived = boot(h, 3)
      expect(revived.txs().map((t) => t.txId)).toEqual(before)
    })

    it('goes terminal on 4004, also with a sign-in link', () => {
      const h = setup()
      boot(h, 3)

      h.last().drop(4004, 'an API token cannot open an editing session')

      vi.advanceTimersByTime(60_000)
      expect(h.sockets).toHaveLength(1)
      expect(h.store.getSnapshot().signIn).toBe(true)
      expect(h.store.getSnapshot().notice).toContain('do not have access')
    })

    it('does not offer a sign-in link for a version mismatch or a purge', () => {
      // Signing in again fixes neither, so the link would be a dead end dressed
      // up as an action.
      const version = setup()
      boot(version, 3)
      version.last().drop(4001, 'unsupported protocol version')
      expect(version.store.getSnapshot().signIn).toBe(false)

      const purged = setup()
      boot(purged, 3)
      purged.last().drop(4002, 'story deleted')
      expect(purged.store.getSnapshot().signIn).toBe(false)
    })
  })

  describe('pinned behaviour', () => {
    // SPEC(offline-queue): txs made while the socket is down are queued in `pending`, re-sent with
    // their original txIds once the reconnect has resolved `base`, and replayed on top of it — a
    // bootstrap replaces `base` only.
    it('queues transactions made while offline and replays them on reconnect', () => {
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

    // SPEC(echo-rebase): every delta, a peer's or our own echo, applies to `base` in syncId order
    // and the view is `base` with `pending` replayed on top, so every client converges on the
    // server's log order.
    it('converges on the server order when a remote tx is logged first', () => {
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

    // SPEC(reconnect-timer): disconnect() cancels the scheduled reconnect, so a retry queued before
    // it can never fire.
    it('never reconnects after disconnect()', () => {
      const h = setup()
      boot(h)

      h.last().drop()
      h.store.disconnect()
      vi.advanceTimersByTime(60_000)

      expect(h.sockets).toHaveLength(1)
    })

    // SPEC(watermark): lastSyncId advances only contiguously, so it stops at the first gap and a
    // missed delta is still replayed.
    it('does not advance the watermark past a gap', () => {
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
