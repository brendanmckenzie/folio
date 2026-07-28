import { DurableObject } from 'cloudflare:workers'
import type { Doc } from '../core/doc'
import { applyAll } from '../core/mutations'
import type { ActivityEntry, ClientMsg, Delta, Presence, ServerMsg } from '../core/protocol'

/** Beyond this many missed deltas it is cheaper to re-send the whole document. */
const MAX_CATCHUP = 200

interface Attachment {
  actor: string
  name: string
  colour: string
  selection: string | null
}

/**
 * One instance per story. Holds the authoritative draft, an append-only
 * mutation log, and the WebSocket fan-out.
 *
 * Deliberately knows nothing about block schemas: the host application seeds it
 * with an initial document and it treats the contents as opaque.
 */
export class StoryDO extends DurableObject {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
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
  }

  /** Creates the document on first touch. Returns the current draft. */
  async getOrInit(seed: Doc): Promise<Doc> {
    const row = this.read()
    if (row) return row.doc
    this.sql.exec('insert into doc (id, json, sync_id) values (1, ?, 0)', JSON.stringify(seed))
    return seed
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

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return
    const msg = JSON.parse(raw) as ClientMsg
    const current = this.read()
    if (!current) return

    switch (msg.type) {
      case 'hello': {
        const attachment: Attachment = { actor: msg.actor, name: msg.name, colour: msg.colour, selection: null }
        ws.serializeAttachment(attachment)

        const behind = current.syncId - msg.lastSyncId
        const peers = this.peers(ws)

        if (msg.lastSyncId > 0 && behind >= 0 && behind <= MAX_CATCHUP) {
          this.sendTo(ws, { type: 'catchup', deltas: this.since(msg.lastSyncId), syncId: current.syncId, peers })
        } else {
          this.sendTo(ws, { type: 'bootstrap', doc: current.doc, syncId: current.syncId, peers })
        }
        this.broadcast({ type: 'presence', peer: { ...attachment } }, ws)
        break
      }

      case 'tx': {
        const who = ws.deserializeAttachment() as Attachment | null
        const actor = who?.actor ?? 'unknown'
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
        this.sql.exec(
          'update doc set json = ?, sync_id = ? where id = 1',
          JSON.stringify(applyAll(current.doc, msg.mutations)),
          syncId,
        )
        // Echoed to the sender too, where it serves as the acknowledgement.
        this.broadcast({ type: 'delta', syncId, txId: msg.txId, actor, mutations: msg.mutations })
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
    ws.send(JSON.stringify(msg))
  }

  private broadcast(msg: ServerMsg, exclude?: WebSocket) {
    const payload = JSON.stringify(msg)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue
      try {
        socket.send(payload)
      } catch {
        // Socket is going away; close handling will clean up.
      }
    }
  }
}
