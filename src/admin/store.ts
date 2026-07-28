import { type Doc, newUid } from '../core/doc'
import { applyAll, invertAll, type Mutation } from '../core/mutations'
import {
  type ClientMsg,
  type Delta,
  type Presence,
  PROTOCOL_VERSION,
  type ServerFrame,
  type ServerMsg,
} from '../core/protocol'

export interface StoreState {
  doc: Doc | null
  connected: boolean
  peers: Presence[]
  selection: string | null
  canUndo: boolean
  canRedo: boolean
  /** Local transactions not yet acknowledged by the Durable Object. */
  inflight: number
  /** Last refusal from the object — a rejected tx or an unreadable frame. */
  notice: string | null
}

const COLOURS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#e5b100']
const COALESCE_MS = 700

/** `WebSocket.readyState` values, spelled out so the store needs no global WebSocket. */
const CONNECTING = 0
const OPEN = 1

/**
 * Application close codes the Durable Object hangs up with. Both say this client
 * is refused rather than unlucky, so neither is retried. Kept in step with
 * `story-do.ts` by hand: they are wire constants, not shared code.
 */
const CLOSE_VERSION = 4001
const CLOSE_PURGED = 4002

/**
 * A local transaction waiting on the object's verdict. `pending` is also the
 * offline queue: a tx stays in it until its echo or its rejection arrives, so a
 * send made while the socket is down is replayed rather than lost.
 */
interface PendingTx {
  mutations: Mutation[]
  seq: number
}

/**
 * One undo/redo step: absolute inverse values (deliberately, per the design) plus
 * the dispatch sequence of the transaction it inverts. The sequence is what makes
 * the history answerable about a refusal — an entry stamped at or after a refused
 * tx inverts against a document that contained it.
 */
interface HistoryEntry {
  mutations: Mutation[]
  seq: number
}

/**
 * The slice of the WebSocket API this store uses. Narrowing the dependency to an
 * interface is what lets the store run outside a browser (tests drive a fake).
 */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface StoryStoreOptions {
  /**
   * Opens the socket for `path` (a page-relative URL). Defaults to a real
   * WebSocket resolved against `window.location`.
   */
  createSocket?: (path: string) => WebSocketLike
}

function browserSocket(path: string): WebSocketLike {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // A real WebSocket has exactly this surface; only its handler signatures are
  // narrower (Event/MessageEvent) than the structural type, hence the cast.
  return new WebSocket(url) as unknown as WebSocketLike
}

export class StoryStore {
  readonly actor = crypto.randomUUID().slice(0, 8)
  readonly name: string
  readonly colour: string

  private listeners = new Set<() => void>()
  private state: StoreState = {
    doc: null,
    connected: false,
    peers: [],
    selection: null,
    canUndo: false,
    canRedo: false,
    inflight: 0,
    notice: null,
  }

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  /** Last server-confirmed document. The rendered view is this with `pending` on top. */
  private base: Doc | null = null
  private pending = new Map<string, PendingTx>()
  /** Dispatch counter: a transaction and the history entry inverting it share a value. */
  private seq = 0
  private ws: WebSocketLike | null = null
  private lastSyncId = 0
  private backoff = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** A handshake re-run is outstanding; a second gap escalates to a bootstrap. */
  private resyncing = false
  private lastEdit: { uid: string; field: string; at: number } | null = null
  private createSocket: (path: string) => WebSocketLike

  /** Called with every mutation applied locally, for forwarding to the preview iframe. */
  onMutations: (mutations: Mutation[]) => void = () => {}
  onReset: (doc: Doc) => void = () => {}

  constructor(
    readonly storyId: string,
    readonly apiBase: string,
    options: StoryStoreOptions = {},
  ) {
    this.name = `Editor ${this.actor.slice(0, 3)}`
    this.colour = COLOURS[Math.floor(Math.random() * COLOURS.length)]!
    this.createSocket = options.createSocket ?? browserSocket
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): StoreState => this.state

  private patch(next: Partial<StoreState>) {
    this.state = { ...this.state, ...next }
    for (const fn of this.listeners) fn()
  }

  private send(msg: ClientMsg) {
    // Every frame carries the wire version; the object refuses a hello without it.
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }))
  }

  /**
   * The rendered view: `base` with every pending tx replayed on top, in send
   * order. Recomputed from scratch on every change — a document is a handful of
   * bloks and `pending` a handful of txs, so correctness beats an incremental
   * cache here. Revisit only if profiling says so.
   */
  private replay(base: Doc): Doc {
    let doc = base
    for (const tx of this.pending.values()) doc = applyAll(doc, tx.mutations)
    return doc
  }

  /** Publish a freshly rebased view plus the flags derived from base and stacks. */
  private commit(extra: Partial<StoreState> = {}): Doc | null {
    const doc = this.base ? this.replay(this.base) : null
    this.patch({
      doc,
      inflight: this.pending.size,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      ...extra,
    })
    return doc
  }

  private hello(lastSyncId = this.lastSyncId) {
    this.send({
      type: 'hello',
      actor: this.actor,
      name: this.name,
      colour: this.colour,
      lastSyncId,
    })
  }

  /**
   * A gap means a missed delta, so the handshake is re-run from the watermark
   * rather than applied past. If the catchup that answers is itself gapped the
   * log cannot bridge it, so the next attempt asks for a bootstrap
   * (`lastSyncId: 0`) — which also stops a gap from looping the handshake.
   */
  private resync() {
    this.hello(this.resyncing ? 0 : this.lastSyncId)
    this.resyncing = true
  }

  /**
   * Re-send the queue with the original txIds. The object dedupes by txId, so a
   * tx that already landed comes back as a replayed acknowledgement instead of
   * applying twice, and one that no longer applies comes back rejected.
   */
  private flush() {
    for (const [txId, tx] of this.pending) this.send({ type: 'tx', txId, mutations: tx.mutations })
  }

  connect() {
    // Re-entrant: React StrictMode mounts, cleans up, then mounts again, so an
    // explicit connect after disconnect must revive the store. Only an explicit
    // call clears `closed`; the scheduled reconnect never does.
    this.closed = false
    const existing = this.ws?.readyState
    if (existing === OPEN || existing === CONNECTING) return

    const ws = this.createSocket(`${this.apiBase}/story/${encodeURIComponent(this.storyId)}/socket`)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = 0
      this.resyncing = false
      this.patch({ connected: true })
      this.hello()
    }
    ws.onmessage = (e) => this.frame(e.data)
    ws.onclose = (ev) => {
      this.patch({ connected: false })
      const { code, reason } = (ev ?? {}) as { code?: number; reason?: string }
      // Refused, not dropped: reconnecting cannot change the object's answer, so
      // the store goes terminal and says why instead of hammering the socket.
      if (code === CLOSE_VERSION || code === CLOSE_PURGED) {
        this.closed = true
        this.patch({ notice: reason || 'The server closed this editing session.' })
        return
      }
      if (this.closed) return
      const delay = Math.min(500 * 2 ** this.backoff++, 8000)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.closed) this.connect()
      }, delay)
    }
    ws.onerror = () => ws.close()
  }

  /**
   * Terminal: the scheduled reconnect is cancelled, so nothing this store had in
   * flight can reopen the socket afterwards. `pending` survives — an unmount is
   * not a rejection — and only an explicit `connect()` starts over.
   */
  disconnect() {
    this.closed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }

  /**
   * The door every inbound frame comes through, and the mirror of the object's
   * own discipline: a frame that will not parse is reported, never thrown out of
   * the handler, and a frame claiming a version this build does not implement is
   * refused rather than guessed at — applying its deltas is how a doc silently
   * diverges. A version mismatch is terminal for the same reason the object's
   * 4001 is: a reconnect brings the same two versions back.
   */
  private frame(data: unknown) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.patch({ notice: 'Unreadable frame from the server.' })
      return
    }
    const msg = parsed as ServerFrame
    if (msg.v !== PROTOCOL_VERSION) {
      this.patch({
        notice:
          `The server speaks protocol version ${msg.v ?? 'unset'}, this editor speaks ` +
          `${PROTOCOL_VERSION}. Reload the page.`,
      })
      this.disconnect()
      return
    }
    this.receive(msg)
  }

  private receive(msg: ServerMsg) {
    switch (msg.type) {
      case 'bootstrap': {
        // A bootstrap resolves `base` only. `pending` is the offline queue, so it
        // survives, is replayed on top of the new base, and is re-sent below.
        this.lastSyncId = msg.syncId
        this.resyncing = false
        this.base = msg.doc
        // History follows the queue: an entry whose tx is still pending undoes an
        // edit that is on screen and in flight, so it survives with it. Entries
        // the new base has absorbed cannot be placed against it and go.
        const live = new Set([...this.pending.values()].map((tx) => tx.seq))
        this.undoStack = this.undoStack.filter((e) => live.has(e.seq))
        this.redoStack = this.redoStack.filter((e) => live.has(e.seq))
        const doc = this.replay(msg.doc)
        this.commit({ peers: msg.peers, notice: null })
        this.onReset(doc)
        // A bootstrap can land mid-session (a gap the log could not bridge), so a
        // selection the new document still has is kept rather than yanked. With
        // none, open the root block so the inspector shows page settings rather
        // than an empty panel.
        const held = this.state.selection
        this.select(held && msg.doc.bloks[held] ? held : msg.doc.root)
        this.flush()
        break
      }
      case 'catchup': {
        // A gap inside the catchup leaves the rest of the frame stale: `resync`
        // has already asked for the document instead.
        for (const delta of msg.deltas) if (!this.integrate(delta)) return
        this.resyncing = false
        this.patch({ peers: msg.peers })
        this.flush()
        break
      }
      case 'delta':
        this.integrate(msg)
        break
      case 'presence': {
        const peers = this.state.peers.filter((p) => p.actor !== msg.peer.actor)
        if (!msg.gone) peers.push(msg.peer)
        this.patch({ peers })
        break
      }
      case 'reject': {
        // Refused at the door: nothing was logged, so the tx leaves the queue and
        // the view is recomputed without it. Its own history entry goes, and so
        // does every entry stamped after it: those inverses were taken against a
        // document that still contained the refused mutations, so undoing one
        // would put a refused value back and send it as a fresh transaction.
        // Entries from before it invert against confirmed state and survive. The
        // redo stack goes wholesale — a redo must not re-send refused mutations.
        const tx = this.pending.get(msg.txId)
        if (!tx) break
        this.pending.delete(msg.txId)
        this.undoStack = this.undoStack.filter((e) => e.seq < tx.seq)
        this.redoStack = []
        const doc = this.commit({ notice: `Edit refused: ${msg.reason}` })
        if (doc) this.onReset(doc)
        break
      }
      case 'error':
        this.patch({ notice: msg.reason })
        break
    }
  }

  /**
   * Fold one logged delta into `base`, in syncId order, and drop our own echo
   * from the queue. False means the frame sat past a gap: it was not applied and
   * the watermark did not move.
   */
  private integrate(delta: Delta & { replay?: true }): boolean {
    if (!this.base) return true
    // The idempotent acknowledgement of a resend: the tx is in the log at its
    // original syncId, already in `base`, so it only leaves the queue. Leaving it
    // still changes the replayed view, so the preview is re-seeded with the whole
    // document — the delta's mutations do not describe the change.
    if (delta.replay || delta.syncId <= this.lastSyncId) {
      if (this.pending.delete(delta.txId)) {
        const doc = this.commit()
        if (doc) this.onReset(doc)
      }
      return true
    }
    if (delta.syncId !== this.lastSyncId + 1) {
      this.resync()
      return false
    }

    this.lastSyncId = delta.syncId
    const ours = this.pending.delete(delta.txId)
    this.base = applyAll(this.base, delta.mutations)
    const doc = this.commit()
    // With the queue drained the delta's mutations describe the view exactly, so
    // the preview takes them incrementally. Under a rebase they do not — the
    // view is base plus pending — so it takes the whole document.
    if (doc && this.pending.size > 0) this.onReset(doc)
    else if (!ours) this.onMutations(delta.mutations)
    return true
  }

  /**
   * Apply locally, forward to the preview, then send. Never blocks on the network.
   *
   * `txId` is 64 bits of entropy, not a uuid slice: it is the log's unique dedupe
   * key, so a collision would answer this transaction with a stranger's delta and
   * lose the edit silently. The log is never trimmed, so 32 bits was not enough.
   */
  private dispatch(mutations: Mutation[], seq: number) {
    if (!this.base || mutations.length === 0) return
    const txId = newUid()
    this.pending.set(txId, { mutations, seq })
    this.commit({ notice: null })
    this.onMutations(mutations)
    // Dropped while the socket is down; `pending` holds it until a reconnect.
    this.send({ type: 'tx', txId, mutations })
  }

  tx(mutations: Mutation[]) {
    const doc = this.state.doc
    if (!doc || mutations.length === 0) return

    // Typing produces one `set` per keystroke. Collapse a run on the same field
    // into a single undo entry rather than one per character.
    const only = mutations.length === 1 ? mutations[0] : null
    const now = Date.now()
    const coalesce =
      only?.t === 'set' &&
      this.lastEdit?.uid === only.uid &&
      this.lastEdit.field === only.field &&
      now - this.lastEdit.at < COALESCE_MS

    const seq = ++this.seq
    if (!coalesce) this.undoStack.push({ mutations: invertAll(doc, mutations), seq })
    this.redoStack = []
    this.lastEdit = only?.t === 'set' ? { uid: only.uid, field: only.field, at: now } : null

    this.dispatch(mutations, seq)
  }

  undo() {
    const doc = this.state.doc
    const entry = this.undoStack.pop()
    if (!doc || !entry) return
    const seq = ++this.seq
    this.redoStack.push({ mutations: invertAll(doc, entry.mutations), seq })
    this.lastEdit = null
    this.dispatch(entry.mutations, seq)
  }

  redo() {
    const doc = this.state.doc
    const entry = this.redoStack.pop()
    if (!doc || !entry) return
    const seq = ++this.seq
    this.undoStack.push({ mutations: invertAll(doc, entry.mutations), seq })
    this.lastEdit = null
    this.dispatch(entry.mutations, seq)
  }

  select(uid: string | null) {
    if (uid === this.state.selection) return
    this.patch({ selection: uid })
    this.send({ type: 'presence', selection: uid })
  }
}
