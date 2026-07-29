import { DurableObject } from 'cloudflare:workers'
import type { Doc } from '../core/doc'
import { apply, mutationError } from '../core/mutations'
import {
  type ActivityEntry,
  type Delta,
  docCapError,
  MAX_FRAME_BYTES,
  parseClientFrame,
  type Presence,
  PROTOCOL_VERSION,
  type ServerMsg,
  txCapError,
} from '../core/protocol'

/** Beyond this many missed deltas it is cheaper to re-send the whole document. */
const MAX_CATCHUP = 200

/** Application close code: the peer speaks a wire version we do not implement. */
const CLOSE_VERSION = 4001

/** Application close code: the story this object backs has been deleted. */
const CLOSE_PURGED = 4002

/**
 * How long after the last logged transaction the debounced watermark alarm
 * waits before mirroring `sync_id` into D1 (`unpublished-changes.md`'s
 * architecture decision 4). A minute of typing costs one D1 write, not one per
 * keystroke.
 */
const WATERMARK_DEBOUNCE_MS = 2000

interface Attachment {
  actor: string
  name: string
  colour: string
  selection: string | null
}

const encode = (msg: ServerMsg): string => JSON.stringify({ ...msg, v: PROTOCOL_VERSION })

export interface StoryDOConfig<Env> {
  /**
   * The host's own env → the D1 binding this object mirrors its draft
   * watermark into. A Durable Object is constructed by the runtime with the
   * raw host env and never sees `createFolio`'s `bindings` config, so this is
   * the seam: the host's own worker calls `createStoryDO` once, the way it
   * already declares every other binding.
   */
  db: (env: Env) => D1Database
}

/** The host env shape `export { StoryDO }` below assumes: a D1 binding named
 * `DB`, matching every example and migration doc in this package. Call
 * `createStoryDO` directly for a differently named binding. */
interface DefaultStoryEnv {
  DB: D1Database
}

/**
 * Builds the story Durable Object class bound to a host's own env shape. See
 * `StoryDOConfig` for why this is a factory rather than a plain class.
 *
 * One instance per story. Holds the authoritative draft, an append-only
 * mutation log, and the WebSocket fan-out.
 *
 * Deliberately knows nothing about block schemas: the host application seeds it
 * with an initial document and it treats the contents as opaque.
 */
export function createStoryDO<Env>(config: StoryDOConfig<Env>) {
  return class StoryDOImpl extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.sql = ctx.storage.sql
      this.sql.exec(`
      create table if not exists doc (
        id      integer primary key check (id = 1),
        json    text not null,
        sync_id integer not null
      );
      create table if not exists log (
        sync_id    integer primary key autoincrement,
        tx_id      text not null,
        actor      text not null,
        actor_name text,
        mutations  text not null,
        at         integer not null
      );
    `)
      // Objects created before actor_name existed.
      try {
        this.sql.exec('alter table log add column actor_name text')
      } catch {
        // Column already present.
      }
      // Dedupe key: a resent transaction must find the row it already produced,
      // and must be unable to write a second one.
      try {
        this.sql.exec('create unique index if not exists log_tx_id on log (tx_id)')
      } catch {
        // An object that logged a duplicate txId before this index existed keeps
        // its log; the lookup below still answers a resend with the first row.
      }
    }

    /** Creates the document on first touch. Returns the current draft. */
    async getOrInit(seed: Doc): Promise<Doc> {
      return (await this.getOrInitWithSyncId(seed)).doc
    }

    /**
     * `getOrInit` plus the log position it was read at, atomically. `publish()`
     * needs both to agree on the same document: two separate RPC calls (this
     * object's draft, then its `head()`) are not atomic across the object's
     * request boundary, so a transaction landing between them could leave
     * `published_sync_id` ahead of the bytes actually snapshotted — silently
     * hiding a real change (`unpublished-changes.md`'s publish-race acceptance
     * criterion). `getOrInit` keeps its existing signature for every other
     * caller and is implemented in terms of this one.
     */
    async getOrInitWithSyncId(seed: Doc): Promise<{ doc: Doc; syncId: number }> {
      const row = this.read()
      if (row) return row
      this.sql.exec('insert into doc (id, json, sync_id) values (1, ?, 0)', JSON.stringify(seed))
      return { doc: seed, syncId: 0 }
    }

    /**
     * The log position alone, with no document attached — the coarse signal the
     * tree-wide badge is built from and the debounced alarm below writes into
     * D1. A story whose object has never been touched reads 0, matching the
     * `default 0` on `stories.draft_sync_id` (migrations/0005_draft_watermark.sql).
     */
    async head(): Promise<{ syncId: number }> {
      return { syncId: this.read()?.syncId ?? 0 }
    }

    /**
     * Clears the log and doc tables and evicts any open sockets. Called after the
     * host's D1 delete for this story has committed: purging first would leave a
     * window where a concurrent `getOrInit` re-seeds this object from a story that
     * D1 still thinks exists. A `getOrInit` after `purge()` finds no doc row and
     * reseeds from scratch, which is the point — a reused or resurrected id must
     * never see the deleted story's content.
     */
    async purge(): Promise<void> {
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.close(CLOSE_PURGED, 'story deleted')
        } catch {
          // Already closing.
        }
      }
      this.sql.exec('delete from log')
      this.sql.exec('delete from doc')
    }

    /**
     * Fires ~2s after the last logged transaction (see the `tx` handler below)
     * and writes this object's log position into D1, so the content tree can
     * show unpublished changes without waking every story's object. Guarded so a
     * transient D1 failure never surfaces to an editor: the transaction that
     * scheduled this alarm was already acknowledged before it fired, and a
     * missed watermark write self-heals on the next edit regardless — this
     * reschedule just closes the gap sooner than "the next edit" would.
     *
     * No story id is stored anywhere in this object; `ctx.id.name` is it,
     * because every stub in this codebase is obtained through `idFromName`
     * (`runtime.ts`'s `stub`), which is exactly what makes the name recoverable
     * here.
     */
    async alarm(): Promise<void> {
      const row = this.read()
      if (!row) return
      const name = this.ctx.id.name
      if (!name) return
      try {
        await config
          .db(this.env)
          .prepare('update stories set draft_sync_id = ?, draft_updated_at = ? where id = ?')
          .bind(row.syncId, Date.now(), name)
          .run()
      } catch (err) {
        console.error(`story-do: failed to write the draft watermark for ${name}`, err)
        try {
          await this.ctx.storage.setAlarm(Date.now() + WATERMARK_DEBOUNCE_MS)
        } catch {
          // Best-effort; the next transaction reschedules anyway.
        }
      }
    }

    private read(): { doc: Doc; syncId: number } | null {
      const row = this.sql
        .exec<{ json: string; sync_id: number }>('select json, sync_id from doc where id = 1')
        .toArray()[0]
      return row ? { doc: JSON.parse(row.json) as Doc, syncId: row.sync_id } : null
    }

    async fetch(req: Request): Promise<Response> {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 })
      }
      const pair = new WebSocketPair()
      // Hibernation: the object can be evicted between edits without dropping
      // connections, so an idle editing session costs nothing.
      this.ctx.acceptWebSocket(pair[1]!)
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    /**
     * The only door a mutation arrives by. Parsing, shape validation and dispatch
     * all happen inside here: a frame this object cannot read is answered and
     * discarded, never thrown, because an exception out of a hibernatable handler
     * takes the connection with it.
     */
    async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
      // Checked ahead of parsing: a frame this large would cost a JSON.parse over
      // attacker-controlled input before anything else gets a chance to refuse it,
      // and it stays a bounded, nameable error rather than an unreadable frame.
      //
      // Measured in UTF-8 bytes, not `.length`: a string's `.length` counts UTF-16
      // code units, so a frame padded with 3-byte-in-UTF-8 characters can be three
      // times MAX_FRAME_BYTES on the wire while reading well under the cap here -
      // exactly the value size (`set.value` at 64KB) this cap stands in for.
      const size =
        typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
      if (size > MAX_FRAME_BYTES) {
        const reason = `frame too large: ${size} exceeds ${MAX_FRAME_BYTES} bytes`
        this.sendTo(ws, { type: 'error', reason })
        return
      }

      const msg = parseClientFrame(raw)
      if (!msg) {
        this.sendTo(ws, { type: 'error', reason: 'unreadable frame' })
        return
      }
      // Version discipline covers every frame, not only the handshake: a peer that
      // claims a version this object does not implement, or claims none at all, is
      // refused whatever it sends. An absent `v` is a mismatch for every type, not
      // only `hello` — every frame this store's own client sends stamps `v`
      // (store.ts's `send`), so an unversioned frame is either a stale client from
      // before the wire carried a version or one bypassing the client entirely, and
      // either way it must not be able to write. Refusing only `hello` on a missing
      // version would let a tx or presence frame with the field simply dropped sail
      // through unversioned, attributed to whatever actor its socket happens to
      // have attached (or `unknown`, if none) — the exact hole versioning exists to
      // close, one omitted field away.
      const mismatch = msg.v !== PROTOCOL_VERSION
      if (mismatch) {
        this.sendTo(ws, {
          type: 'error',
          reason: `protocol version ${msg.v ?? 'unset'}, this object speaks ${PROTOCOL_VERSION}`,
        })
        ws.close(CLOSE_VERSION, 'unsupported protocol version')
        return
      }

      const current = this.read()
      if (!current) return

      switch (msg.type) {
        case 'hello': {
          const attachment: Attachment = {
            actor: msg.actor,
            name: msg.name,
            colour: msg.colour,
            selection: null,
          }
          ws.serializeAttachment(attachment)

          const behind = current.syncId - msg.lastSyncId
          const peers = this.peers(ws)

          if (msg.lastSyncId > 0 && behind >= 0 && behind <= MAX_CATCHUP) {
            this.sendTo(ws, {
              type: 'catchup',
              deltas: this.since(msg.lastSyncId),
              syncId: current.syncId,
              peers,
            })
          } else {
            this.sendTo(ws, { type: 'bootstrap', doc: current.doc, syncId: current.syncId, peers })
          }
          this.broadcast({ type: 'presence', peer: { ...attachment } }, ws)
          break
        }

        case 'tx': {
          const who = ws.deserializeAttachment() as Attachment | null
          const actor = who?.actor ?? 'unknown'

          // Already logged: answer with the delta this txId produced the first
          // time. Sender only, no re-apply, no new syncId — that idempotent ack is
          // what makes a client's resend after a dropped acknowledgement safe. It
          // is flagged as a replay because its syncId is old: a client that has
          // already drained this tx must recognise the frame instead of applying
          // stale mutations over a newer base.
          const logged = this.logged(msg.txId)
          if (logged) {
            this.sendTo(ws, { type: 'delta', ...logged, replay: true })
            return
          }

          // Same envelope as an invalid mutation: oversized is refused at the door
          // exactly like malformed, and the sender still gets its txId back to drop
          // the tx from `pending` rather than wait forever for a delta.
          const capError = txCapError(msg.mutations)
          if (capError) {
            this.sendTo(ws, { type: 'reject', txId: msg.txId, reason: capError })
            return
          }

          // Atomic at the door: one violation refuses the whole transaction, since
          // a half-applied tx cannot be undone. Each mutation is checked against
          // the document the ones before it produced, so a tx that inserts a
          // parent and moves an existing blok into it is legal — which the restore
          // path (diff(live, target)) depends on.
          let next = current.doc
          for (const m of msg.mutations) {
            const reason = mutationError(next, m)
            if (reason) {
              this.sendTo(ws, { type: 'reject', txId: msg.txId, reason })
              return
            }
            next = apply(next, m)
          }

          // Bounds what an unbounded run of individually-legal txs can grow the
          // document to; each admitted mutation above is already legal on its own,
          // so this is checked once against the tx's net effect rather than per
          // mutation. `nextJson` is reused below for the doc row instead of
          // serialising the document twice.
          const nextJson = JSON.stringify(next)
          const docReason = docCapError(next, nextJson)
          if (docReason) {
            this.sendTo(ws, { type: 'reject', txId: msg.txId, reason: docReason })
            return
          }

          this.sql.exec(
            'insert into log (tx_id, actor, actor_name, mutations, at) values (?, ?, ?, ?, ?)',
            msg.txId,
            actor,
            who?.name ?? null,
            JSON.stringify(msg.mutations),
            Date.now(),
          )
          const syncId = Number(
            this.sql.exec<{ id: number }>('select last_insert_rowid() as id').toArray()[0]?.id ?? 0,
          )
          this.sql.exec('update doc set json = ?, sync_id = ? where id = 1', nextJson, syncId)
          // Debounced watermark: mirror this log position into D1 a couple of
          // seconds after the last logged tx, so the tree can show which pages
          // have unpublished changes without opening every object
          // (unpublished-changes.md's architecture decision 4). One alarm per
          // burst, not one per keystroke — `getAlarm` is the "already scheduled"
          // check.
          try {
            if ((await this.ctx.storage.getAlarm()) === null) {
              await this.ctx.storage.setAlarm(Date.now() + WATERMARK_DEBOUNCE_MS)
            }
          } catch {
            // Scheduling failure is not fatal to the transaction that triggered
            // it, which has already been logged and is about to be acknowledged.
          }
          const delta: ServerMsg = {
            type: 'delta',
            syncId,
            txId: msg.txId,
            actor,
            mutations: msg.mutations,
          }
          // The sender's echo is its acknowledgement, so it is sent directly rather
          // than through the fan-out: the pre-hello quarantine withholds edits a
          // socket did not ask for, never the answer to one it did.
          this.sendTo(ws, delta)
          this.broadcast(delta, ws)
          break
        }

        case 'presence': {
          const attachment = ws.deserializeAttachment() as Attachment | null
          if (!attachment) return
          const next: Attachment = { ...attachment, selection: msg.selection }
          ws.serializeAttachment(next)
          this.broadcast({ type: 'presence', peer: { ...next } }, ws)
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
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment) this.broadcast({ type: 'presence', peer: { ...attachment }, gone: true }, ws)
    }

    /**
     * Most recent transactions, newest first. This is the fine-grained activity
     * trail — useful for "who changed this", not for restoring. Restores go
     * through versions in D1.
     */
    async recent(limit = 80): Promise<ActivityEntry[]> {
      return this.sql
        .exec<{
          sync_id: number
          actor: string
          actor_name: string | null
          mutations: string
          at: number
        }>(
          'select sync_id, actor, actor_name, mutations, at from log order by sync_id desc limit ?',
          Math.min(Math.max(limit, 1), 500),
        )
        .toArray()
        .map((r) => ({
          syncId: r.sync_id,
          actor: r.actor,
          actorName: r.actor_name,
          at: r.at,
          mutations: JSON.parse(r.mutations),
        }))
    }

    /** The delta a txId already produced, or null if this transaction is new. */
    private logged(txId: string): Delta | null {
      const row = this.sql
        .exec<{ sync_id: number; tx_id: string; actor: string; mutations: string }>(
          'select sync_id, tx_id, actor, mutations from log where tx_id = ? order by sync_id limit 1',
          txId,
        )
        .toArray()[0]
      if (!row) return null
      return {
        syncId: row.sync_id,
        txId: row.tx_id,
        actor: row.actor,
        mutations: JSON.parse(row.mutations),
      }
    }

    private since(syncId: number): Delta[] {
      return this.sql
        .exec<{ sync_id: number; tx_id: string; actor: string; mutations: string }>(
          'select sync_id, tx_id, actor, mutations from log where sync_id > ? order by sync_id',
          syncId,
        )
        .toArray()
        .map((r) => ({
          syncId: r.sync_id,
          txId: r.tx_id,
          actor: r.actor,
          mutations: JSON.parse(r.mutations),
        }))
    }

    private peers(exclude?: WebSocket): Presence[] {
      const out: Presence[] = []
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === exclude) continue
        const a = socket.deserializeAttachment() as Attachment | null
        if (a) out.push({ ...a })
      }
      return out
    }

    private sendTo(ws: WebSocket, msg: ServerMsg) {
      ws.send(encode(msg))
    }

    /**
     * Fan-out is quarantined to sockets that have said hello. A connection still
     * waiting to identify itself has no watermark to place a delta against, so
     * delivering one there is exactly how a client ends up with a gap it cannot
     * see; the hello attachment is the membership test, and it survives
     * hibernation for free.
     */
    private broadcast(msg: ServerMsg, exclude?: WebSocket) {
      const payload = encode(msg)
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === exclude) continue
        if (!socket.deserializeAttachment()) continue
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
 * The default this package ships: reads `env.DB` by convention, so
 * `export { StoryDO } from 'folio/server'` keeps working unchanged for every
 * host that already names its D1 binding `DB` (examples/demo included). A host
 * with a differently named binding calls `createStoryDO` directly instead.
 */
export const StoryDO = createStoryDO<DefaultStoryEnv>({ db: (env) => env.DB })
export type StoryDO = InstanceType<typeof StoryDO>
