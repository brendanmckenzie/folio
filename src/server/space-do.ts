/**
 * The space Durable Object: one instance for the whole site, holding who is
 * where and fanning out structural events (`live-collaboration.md`).
 *
 * **It has no storage.** No `ctx.storage.sql`, no `ctx.storage.put`, nothing —
 * which is architecture decision 1 and the reason this object is cheap enough to
 * be a good idea. Everything it knows lives in socket attachments, so it cannot
 * lose anything that matters, it hibernates the moment nobody types, and the
 * worst a full eviction can do is rebuild a peer list that is still correct
 * (attachments survive eviction, which is exactly why presence lives in them).
 * The rejected alternative was polling a D1 table of heartbeats: a write per
 * editor every few seconds, and always slightly wrong.
 *
 * It is also, deliberately, not a second sync engine. Nothing content-shaped
 * crosses it (decision 3): a delta stays on its story's own socket where the
 * watermark and catchup live. Every frame here is advisory, unordered and never
 * authoritative — the authoritative answer is one `GET /folio/stories` away.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  fallbackColour,
  parseSpaceFrame,
  type PresenceSelection,
  PROTOCOL_VERSION,
  type SpaceEvent,
  type SpacePresence,
  type SpaceServerMsg,
} from '../core/protocol'
import { decodeIdentity, IDENTITY_HEADER, type SocketIdentity } from './auth/identity'
import type { Role } from './auth/roles'
import { CLOSE_VERSION, frameSizeError, liveSession, type SocketSession } from './sockets'

/**
 * What one space socket carries across hibernation.
 *
 * The same shape of thing `StoryDO`'s attachment is, and for the same reasons —
 * identity attached at upgrade time by the Worker, `joined` as the fan-out
 * membership test — plus where in the site this editor is.
 */
interface Attachment extends SocketSession {
  actor: string
  name: string
  colour: string
  /** Global role, or null when there is no session (`auth: 'open'`). */
  role: Role | null
  /**
   * Has said hello.
   *
   * **The membership test for fan-out**, exactly as in `StoryDO`: the
   * attachment exists from the moment the upgrade is accepted, so "has an
   * attachment" would admit every socket that has not identified itself. A
   * lurker must not appear in anybody's peer list and must not receive
   * anybody else's presence — the space channel is where names are shown
   * *outside* the document they were asserted in, so this is the one that
   * matters most.
   */
  joined: boolean
  /** Story id currently open, or null on a list screen. */
  storyId: string | null
  storyTitle: string | null
  locale: string | null
  selection: PresenceSelection | null
}

/** A fresh attachment for a socket that has just upgraded, before any frame. */
function attach(identity: SocketIdentity | null): Attachment {
  return {
    actor: identity?.actor ?? '',
    name: identity?.name ?? '',
    colour: identity?.colour ?? '',
    verified: identity !== null,
    role: identity?.role ?? null,
    session: identity?.session ?? null,
    expiresAt: identity?.expiresAt ?? 0,
    checkedAt: identity ? Date.now() : 0,
    joined: false,
    storyId: null,
    storyTitle: null,
    locale: null,
    selection: null,
  }
}

/**
 * The wire's view of a socket. Explicit rather than a spread of the attachment,
 * for the reason `StoryDO.presenceOf` documents and doubly so here: the
 * attachment carries a session id, and this frame goes to every editor in the
 * site rather than to the two people in one document.
 */
function presenceOf(a: Attachment): SpacePresence {
  const actor = a.actor || 'unknown'
  return {
    actor,
    name: a.name || 'Anonymous',
    colour: a.colour || fallbackColour(actor),
    role: a.role,
    storyId: a.storyId,
    storyTitle: a.storyTitle,
    locale: a.locale,
    selection: a.selection,
  }
}

const encode = (msg: SpaceServerMsg): string => JSON.stringify({ ...msg, v: PROTOCOL_VERSION })

export interface SpaceDOConfig<Env> {
  /**
   * The host's own env → the D1 binding used for the bounded session re-check.
   * The same seam `StoryDOConfig` documents: a Durable Object is constructed
   * with the raw host env and never sees `createFolio`'s config.
   *
   * This is not storage. The object persists nothing of its own; it reads
   * `sessions` to notice a revoked session on an already-open socket.
   */
  db: (env: Env) => D1Database
}

/** The host env shape `export { SpaceDO }` below assumes, matching `StoryDO`. */
interface DefaultSpaceEnv {
  DB: D1Database
}

/**
 * Builds the space Durable Object class bound to a host's own env shape. A
 * factory for the same reason `createStoryDO` is one — see `SpaceDOConfig`.
 */
export function createSpaceDO<Env>(config: SpaceDOConfig<Env>) {
  return class SpaceDOImpl extends DurableObject<Env> {
    async fetch(req: Request): Promise<Response> {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 })
      }
      // A Durable Object namespace is not publicly addressable, so this header
      // can only have been set by the Worker that owns this object — which is
      // what makes it trustworthy in a way `hello` never was
      // (`identity-and-access.md` decision 3). The space channel must never
      // accept a self-reported name where there is a session to read instead: it
      // is the one place a name is shown outside the document it was asserted in.
      const identity = decodeIdentity(req.headers.get(IDENTITY_HEADER))
      const pair = new WebSocketPair()
      // Hibernation, same as StoryDO: an admin tab left open all afternoon costs
      // nothing, and the attachments survive the eviction.
      this.ctx.acceptWebSocket(pair[1]!)
      pair[1]!.serializeAttachment(attach(identity))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    /**
     * A structural change, from the Worker's after-commit hook
     * (`server/runtime.ts`'s internal hooks). RPC rather than a fetch: the
     * caller already holds the stub, and there is no HTTP shape worth inventing.
     *
     * Never throws for want of a peer, and never for a socket going away
     * mid-broadcast: the write this describes has already committed, so a failed
     * broadcast must not be able to turn a successful publish into an error.
     */
    async broadcastEvent(event: SpaceEvent): Promise<void> {
      this.broadcast({ type: 'event', event })
    }

    /**
     * Every frame the object takes, with the same discipline `StoryDO` uses: a
     * frame it cannot read is answered and discarded, never thrown, because an
     * exception out of a hibernatable handler takes the connection with it.
     */
    async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
      const tooBig = frameSizeError(raw)
      if (tooBig) {
        this.sendTo(ws, { type: 'error', reason: tooBig })
        return
      }

      const msg = parseSpaceFrame(raw)
      if (!msg) {
        this.sendTo(ws, { type: 'error', reason: 'unreadable frame' })
        return
      }
      // Every frame, not only the handshake, and an absent `v` is a mismatch —
      // the same rule as the story socket, for the same reason: an unversioned
      // frame is either a stale client or one bypassing the client entirely, and
      // either way it must not be able to put a name on somebody else's screen.
      if (msg.v !== PROTOCOL_VERSION) {
        this.sendTo(ws, {
          type: 'error',
          reason: `protocol version ${msg.v ?? 'unset'}, this object speaks ${PROTOCOL_VERSION}`,
        })
        ws.close(CLOSE_VERSION, 'unsupported protocol version')
        return
      }

      // Before dispatch, whatever the frame's type: a socket whose session has
      // ended must stop being able to announce anything.
      const held = ws.deserializeAttachment() as Attachment | null
      const who = held ? await liveSession(config.db(this.env), ws, held, 'space-do') : null
      if (held && !who) return

      switch (msg.type) {
        case 'hello': {
          // A verified identity is not overwritable. `hello.identity` is read in
          // exactly one situation — `auth: 'open'`, where there are no accounts
          // and a client's self-report is the only thing telling two anonymous
          // tabs apart. A socket the Worker vouched for never reaches the second
          // branch, whatever it sent.
          const base = who ?? attach(null)
          const asserted = msg.identity
          const next: Attachment =
            base.verified || !asserted
              ? { ...base, joined: true }
              : {
                  ...base,
                  actor: asserted.actor,
                  name: asserted.name,
                  colour: asserted.colour,
                  joined: true,
                }
          ws.serializeAttachment(next)
          // The whole list once, then deltas: there is no watermark to be behind
          // on, so a joiner's first frame is the state and every frame after it
          // is a change.
          this.sendTo(ws, { type: 'peers', peers: this.peers(ws) })
          this.broadcast({ type: 'presence', peer: presenceOf(next) }, ws)
          break
        }

        case 'where': {
          if (!who?.joined) return
          const next: Attachment = {
            ...who,
            storyId: msg.storyId,
            storyTitle: msg.storyTitle,
            locale: msg.locale,
            // Moving to another document invalidates a selection that named a
            // blok in the old one: a stale uid would draw a dot on whatever
            // block happens to share it.
            selection: msg.storyId === who.storyId ? who.selection : null,
          }
          ws.serializeAttachment(next)
          this.broadcast({ type: 'presence', peer: presenceOf(next) }, ws)
          break
        }

        case 'selection': {
          if (!who?.joined) return
          const next: Attachment = { ...who, selection: msg.selection }
          ws.serializeAttachment(next)
          this.broadcast({ type: 'presence', peer: presenceOf(next) }, ws)
          break
        }
      }
    }

    async webSocketClose(ws: WebSocket) {
      this.departed(ws)
    }

    /** A socket that fails is gone just as thoroughly as one that closes cleanly. */
    async webSocketError(ws: WebSocket) {
      this.departed(ws)
    }

    private departed(ws: WebSocket) {
      const a = ws.deserializeAttachment() as Attachment | null
      // Only a socket that joined was ever announced as arriving, so only one
      // that joined has a departure to announce.
      if (a?.joined) {
        this.broadcast({ type: 'presence', peer: presenceOf(a), gone: true }, ws)
      }
    }

    /**
     * An editor with two tabs is two presences, same actor, different `storyId`
     * — which is the truth, and the admin's avatar list dedupes by actor for
     * display rather than this object pretending there is one.
     */
    private peers(exclude?: WebSocket): SpacePresence[] {
      const out: SpacePresence[] = []
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === exclude) continue
        const a = socket.deserializeAttachment() as Attachment | null
        if (a?.joined) out.push(presenceOf(a))
      }
      return out
    }

    private sendTo(ws: WebSocket, msg: SpaceServerMsg) {
      try {
        ws.send(encode(msg))
      } catch {
        // Socket is going away; close handling will clean up.
      }
    }

    /** Fan-out, quarantined to sockets that have said hello. See `joined`. */
    private broadcast(msg: SpaceServerMsg, exclude?: WebSocket) {
      const payload = encode(msg)
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === exclude) continue
        if (!(socket.deserializeAttachment() as Attachment | null)?.joined) continue
        try {
          socket.send(payload)
        } catch {
          // Socket is going away; close handling will clean up.
        }
      }
    }
  }
}

/**
 * The default this package ships, matching `StoryDO`: reads `env.DB` by
 * convention, so `export { SpaceDO } from 'folio/server'` works for every host
 * that already names its D1 binding `DB`.
 *
 * **A host declaring this class uses `new_classes`, not `new_sqlite_classes`** —
 * it holds no storage, which is a smaller commitment than `StoryDO` made and
 * cannot be changed afterwards either way. See README.
 */
export const SpaceDO = createSpaceDO<DefaultSpaceEnv>({ db: (env) => env.DB })
export type SpaceDO = InstanceType<typeof SpaceDO>
