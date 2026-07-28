import type { Doc } from '../core/doc'
import { applyAll, invertAll, type Mutation } from '../core/mutations'
import type { ClientMsg, Delta, Presence, ServerMsg } from '../core/protocol'

export interface StoreState {
  doc: Doc | null
  connected: boolean
  peers: Presence[]
  selection: string | null
  canUndo: boolean
  canRedo: boolean
  /** Local transactions not yet acknowledged by the Durable Object. */
  inflight: number
}

const COLOURS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#e5b100']
const COALESCE_MS = 700

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
  }

  private undoStack: Mutation[][] = []
  private redoStack: Mutation[][] = []
  private pending = new Map<string, Mutation[]>()
  private ws: WebSocket | null = null
  private lastSyncId = 0
  private backoff = 0
  private closed = false
  private lastEdit: { uid: string; field: string; at: number } | null = null

  /** Called with every mutation applied locally, for forwarding to the preview iframe. */
  onMutations: (mutations: Mutation[]) => void = () => {}
  onReset: (doc: Doc) => void = () => {}

  constructor(
    readonly storyId: string,
    readonly apiBase: string,
  ) {
    this.name = `Editor ${this.actor.slice(0, 3)}`
    this.colour = COLOURS[Math.floor(Math.random() * COLOURS.length)]!
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  connect() {
    // Re-entrant: React StrictMode mounts, cleans up, then mounts again, so a
    // disconnect must not permanently disable the store.
    this.closed = false
    const existing = this.ws?.readyState
    if (existing === WebSocket.OPEN || existing === WebSocket.CONNECTING) return

    const url = new URL(
      `${this.apiBase}/story/${encodeURIComponent(this.storyId)}/socket`,
      window.location.href,
    )
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = 0
      this.patch({ connected: true })
      this.send({
        type: 'hello',
        actor: this.actor,
        name: this.name,
        colour: this.colour,
        lastSyncId: this.lastSyncId,
      })
    }
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMsg)
    ws.onclose = () => {
      this.patch({ connected: false })
      if (this.closed) return
      const delay = Math.min(500 * 2 ** this.backoff++, 8000)
      setTimeout(() => this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }

  disconnect() {
    this.closed = true
    this.ws?.close()
    this.ws = null
  }

  private receive(msg: ServerMsg) {
    switch (msg.type) {
      case 'bootstrap': {
        this.lastSyncId = msg.syncId
        this.undoStack = []
        this.redoStack = []
        this.pending.clear()
        this.patch({ doc: msg.doc, peers: msg.peers, canUndo: false, canRedo: false, inflight: 0 })
        this.onReset(msg.doc)
        // Open on the root block so the inspector shows page settings rather
        // than an empty panel.
        this.select(msg.doc.root)
        break
      }
      case 'catchup': {
        for (const delta of msg.deltas) this.integrate(delta)
        this.lastSyncId = msg.syncId
        this.patch({ peers: msg.peers })
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
    }
  }

  private integrate(delta: Delta) {
    this.lastSyncId = Math.max(this.lastSyncId, delta.syncId)

    // Our own transaction echoing back is just an acknowledgement; we already
    // applied it optimistically.
    if (this.pending.delete(delta.txId)) {
      this.patch({ inflight: this.pending.size })
      return
    }
    const doc = this.state.doc
    if (!doc) return
    this.patch({ doc: applyAll(doc, delta.mutations) })
    this.onMutations(delta.mutations)
  }

  /** Apply locally, forward to the preview, then send. Never blocks on the network. */
  private dispatch(mutations: Mutation[]) {
    const doc = this.state.doc
    if (!doc || mutations.length === 0) return
    const txId = crypto.randomUUID().slice(0, 8)
    this.pending.set(txId, mutations)
    this.patch({
      doc: applyAll(doc, mutations),
      inflight: this.pending.size,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    })
    this.onMutations(mutations)
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

    if (!coalesce) this.undoStack.push(invertAll(doc, mutations))
    this.redoStack = []
    this.lastEdit = only?.t === 'set' ? { uid: only.uid, field: only.field, at: now } : null

    this.dispatch(mutations)
  }

  undo() {
    const doc = this.state.doc
    const entry = this.undoStack.pop()
    if (!doc || !entry) return
    this.redoStack.push(invertAll(doc, entry))
    this.lastEdit = null
    this.dispatch(entry)
  }

  redo() {
    const doc = this.state.doc
    const entry = this.redoStack.pop()
    if (!doc || !entry) return
    this.undoStack.push(invertAll(doc, entry))
    this.lastEdit = null
    this.dispatch(entry)
  }

  select(uid: string | null) {
    if (uid === this.state.selection) return
    this.patch({ selection: uid })
    this.send({ type: 'presence', selection: uid })
  }
}
