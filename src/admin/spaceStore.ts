/**
 * The client half of the space channel (`live-collaboration.md` phase 2, step 4).
 *
 * `StoryStore`'s shape — `subscribe` / `getSnapshot`, reconnect with backoff,
 * terminal close codes — with everything about *content* removed: no document,
 * no mutation log, no pending queue, no watermark. There is nothing here to be
 * behind on, which is what makes this store a third the size of that one rather
 * than a copy of it.
 *
 * Everything it carries is advisory. A dropped frame is corrected by the next
 * one, a dropped socket by the next peer list, and a stale tree by the reload the
 * event handler triggers — so nothing in here retries a message or reconciles an
 * ordering.
 */
import {
  PROTOCOL_VERSION,
  type PresenceSelection,
  type SpaceClientMsg,
  type SpaceEvent,
  type SpacePresence,
  type SpaceServerFrame,
  type SpaceServerMsg,
} from '../core/protocol'
import { PRESENCE_THROTTLE_MS, type WebSocketLike } from './store'

export interface SpaceState {
  connected: boolean
  /** Everybody else in the site. This client is never in its own list. */
  peers: SpacePresence[]
  /** The last refusal from the object, or a terminal close's explanation. */
  notice: string | null
}

/** `WebSocket.readyState` values, spelled out so this store needs no global. */
const CONNECTING = 0
const OPEN = 1

/**
 * Terminal close codes, kept in step with `server/sockets.ts` by hand — they are
 * wire constants, not shared code, the same convention `store.ts` follows.
 *
 * 4002 is deliberately absent: it means "this story was purged", which the space
 * object has no notion of.
 */
const CLOSE_VERSION = 4001
const CLOSE_UNAUTHENTICATED = 4003
const CLOSE_FORBIDDEN = 4004

/**
 * What each terminal code says. Terser than `store.ts`'s equivalent on purpose:
 * losing the space channel loses presence and live tree updates, and nothing a
 * person typed — so the wording must not imply otherwise.
 */
const TERMINAL: Record<number, string> = {
  [CLOSE_VERSION]: 'Reload the page: this editor and the server disagree on the protocol version.',
  [CLOSE_UNAUTHENTICATED]: 'Presence stopped: your session ended.',
  [CLOSE_FORBIDDEN]: 'Presence is not available for this credential.',
}

export interface SpaceStoreOptions {
  createSocket?: (path: string) => WebSocketLike
  /**
   * A structural event from another editor. Owned by the caller (`Editor.tsx`),
   * because what to do about it — patch the tree, reload it, show a notice — is a
   * question about the editor rather than about the socket.
   */
  onEvent?: (event: SpaceEvent) => void
}

function browserSocket(path: string): WebSocketLike {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url) as unknown as WebSocketLike
}

export class SpaceStore {
  /**
   * The identity this client asserts, and — exactly as on the story channel — one
   * the object ignores whenever the Worker vouched for a session. It exists for
   * `auth: 'open'`, where nothing else tells two anonymous tabs apart.
   */
  readonly identity: { actor: string; name: string; colour: string }

  private listeners = new Set<() => void>()
  private state: SpaceState = { connected: false, peers: [], notice: null }
  private ws: WebSocketLike | null = null
  private backoff = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private presenceAt = 0
  /** The last `where` / `selection` pair put on the wire, for the dedupe. */
  private lastSent: string | null = null
  private where: { storyId: string | null; storyTitle: string | null; locale: string | null } = {
    storyId: null,
    storyTitle: null,
    locale: null,
  }
  private selection: PresenceSelection | null = null
  private createSocket: (path: string) => WebSocketLike
  private onEvent: (event: SpaceEvent) => void

  constructor(
    readonly apiBase: string,
    identity: { actor: string; name: string; colour: string },
    options: SpaceStoreOptions = {},
  ) {
    this.identity = identity
    this.createSocket = options.createSocket ?? browserSocket
    this.onEvent = options.onEvent ?? (() => {})
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): SpaceState => this.state

  private patch(next: Partial<SpaceState>) {
    this.state = { ...this.state, ...next }
    for (const fn of this.listeners) fn()
  }

  private send(msg: SpaceClientMsg) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }))
  }

  connect() {
    // Re-entrant for the same reason `StoryStore.connect` is: StrictMode mounts,
    // cleans up and mounts again.
    this.closed = false
    const existing = this.ws?.readyState
    if (existing === OPEN || existing === CONNECTING) return

    const ws = this.createSocket(`${this.apiBase}/space/socket`)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = 0
      this.patch({ connected: true, notice: null })
      this.send({ type: 'hello', identity: this.identity })
      // A new socket is a new attachment holding no position at all, so the
      // dedupe has to forget what the previous one was told.
      this.lastSent = null
      this.announce()
    }
    ws.onmessage = (e) => this.frame(e.data)
    ws.onclose = (ev) => {
      this.patch({ connected: false, peers: [] })
      const { code, reason } = (ev ?? {}) as { code?: number; reason?: string }
      if (code !== undefined && code in TERMINAL) {
        // Refused, not dropped: reconnecting cannot change the answer.
        this.closed = true
        this.patch({ notice: reason || TERMINAL[code]! })
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

  disconnect() {
    this.closed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer)
    this.presenceTimer = null
    this.ws?.close()
    this.ws = null
  }

  /** Where this editor is. Null `storyId` is a list screen, which is a real place. */
  setWhere(storyId: string | null, storyTitle: string | null, locale: string | null) {
    const next = { storyId, storyTitle, locale: locale || null }
    if (JSON.stringify(next) === JSON.stringify(this.where)) return
    // Moving document invalidates a selection naming a blok in the old one.
    if (next.storyId !== this.where.storyId) this.selection = null
    this.where = next
    this.announce()
  }

  /** Mirrors the story-level selection, so follow-mode can land on a block. */
  setSelection(selection: PresenceSelection | null) {
    if (JSON.stringify(selection) === JSON.stringify(this.selection)) return
    this.selection = selection
    this.announce()
  }

  /**
   * Both frames, deduplicated and throttled together on the same 100 ms window as
   * the story channel's presence. One window for the pair rather than one each:
   * opening a document sets a `where` and a selection in the same tick, and two
   * independent throttles would send both immediately and then argue about which
   * was trailing.
   */
  private announce() {
    const key = JSON.stringify([this.where, this.selection])
    if (key === this.lastSent) return
    this.lastSent = key

    const now = Date.now()
    const wait = PRESENCE_THROTTLE_MS - (now - this.presenceAt)
    if (wait <= 0) {
      this.presenceAt = now
      this.flushPresence()
      return
    }
    if (this.presenceTimer !== null) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      this.presenceAt = Date.now()
      this.flushPresence()
    }, wait)
  }

  private flushPresence() {
    this.send({ type: 'where', ...this.where })
    this.send({ type: 'selection', selection: this.selection })
  }

  /**
   * The door every inbound frame comes through. Mirrors `StoryStore.frame`: a
   * frame that will not parse is reported rather than thrown, and a version
   * mismatch is terminal because a reconnect brings the same two versions back.
   */
  private frame(data: unknown) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.patch({ notice: 'Unreadable frame on the presence channel.' })
      return
    }
    const msg = parsed as SpaceServerFrame
    if (msg.v !== PROTOCOL_VERSION) {
      this.patch({ notice: TERMINAL[CLOSE_VERSION]! })
      this.disconnect()
      return
    }
    this.receive(msg)
  }

  private receive(msg: SpaceServerMsg) {
    switch (msg.type) {
      case 'peers':
        this.patch({ peers: msg.peers })
        break
      case 'presence': {
        // Keyed by actor **and** story, because one person with two tabs is two
        // presences in two documents and that is the truth (the spec's edge
        // case). The avatar list dedupes by actor for display.
        const peers = this.state.peers.filter(
          (p) => !(p.actor === msg.peer.actor && p.storyId === msg.peer.storyId),
        )
        if (!msg.gone) peers.push(msg.peer)
        this.patch({ peers })
        break
      }
      case 'event':
        this.onEvent(msg.event)
        break
      case 'error':
        this.patch({ notice: msg.reason })
        break
    }
  }
}

/**
 * Peers grouped for the avatar list: one entry per actor, with a count of how
 * many tabs they have open and the story of the first one.
 *
 * Pure and exported so the dedupe is tested without a socket. Two tabs are two
 * presences on the wire — that is the truth and the object must not lie about it
 * — but two identical avatars side by side is noise, so the *display* dedupes.
 */
export interface SpaceAvatar {
  actor: string
  name: string
  colour: string
  storyId: string | null
  storyTitle: string | null
  locale: string | null
  selection: PresenceSelection | null
  /** How many sockets this actor has open. 1 for almost everybody. */
  tabs: number
}

export function avatarsOf(peers: readonly SpacePresence[]): SpaceAvatar[] {
  const out: SpaceAvatar[] = []
  for (const p of peers) {
    const seen = out.find((a) => a.actor === p.actor)
    if (seen) {
      seen.tabs += 1
      // The tab that is actually in a document wins the label: "Ann is on About"
      // is more use than "Ann is somewhere" just because her other tab is on a
      // list screen.
      if (seen.storyId === null && p.storyId !== null) {
        seen.storyId = p.storyId
        seen.storyTitle = p.storyTitle
        seen.locale = p.locale
        seen.selection = p.selection
      }
      continue
    }
    out.push({
      actor: p.actor,
      name: p.name,
      colour: p.colour,
      storyId: p.storyId,
      storyTitle: p.storyTitle,
      locale: p.locale,
      selection: p.selection,
      tabs: 1,
    })
  }
  return out
}

/** Peers in one story, for a tree row's avatars. */
export function peersIn(peers: readonly SpacePresence[], storyId: string): SpaceAvatar[] {
  return avatarsOf(peers.filter((p) => p.storyId === storyId))
}

/**
 * What a peer's avatar says: their name, where they are, and how many tabs.
 *
 * "on a list screen" is a real answer rather than a missing one — an editor
 * browsing the tree is present and worth showing, and saying so is better than an
 * avatar that looks broken. Pure and exported so the wording is tested without
 * mounting anything.
 *
 * Moved here from `admin/TopBar.tsx` when port phase 8 deleted it, next to the
 * `SpaceAvatar` it describes. **Nothing renders it today**, and that is a real gap
 * rather than dead code: the rebuilt editor has per-story presence but has not yet
 * joined the space channel, so the top bar has no avatars to label. See
 * `ui-architecture.md`'s open question 7.
 */
export function followLabel(peer: SpaceAvatar): string {
  const tabs = peer.tabs > 1 ? ` · ${peer.tabs} tabs` : ''
  if (peer.storyId === null) return `${peer.name} — on a list screen${tabs}`
  const where = peer.storyTitle ?? 'a document'
  const locale = peer.locale ? ` (${peer.locale})` : ''
  return `${peer.name} — ${where}${locale}${tabs}`
}
