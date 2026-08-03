import { DurableObject } from 'cloudflare:workers'
import type { Doc } from '../core/doc'
import { apply, type Mutation, mutationError } from '../core/mutations'
import {
  type ActivityEntry,
  type Delta,
  docCapError,
  fallbackColour,
  parseClientFrame,
  type Presence,
  type PresenceSelection,
  PROTOCOL_VERSION,
  type ServerMsg,
  txCapError,
} from '../core/protocol'
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { decodeIdentity, IDENTITY_HEADER, type SocketIdentity } from './auth/identity'
import type { Role } from './auth/roles'
import { type Keyset, keysetWhere, orderBy, whereOf } from './keyset'
import {
  CLOSE_PURGED,
  CLOSE_VERSION,
  frameSizeError,
  liveSession,
  type SocketSession,
} from './sockets'

/** Beyond this many missed deltas it is cheaper to re-send the whole document. */
const MAX_CATCHUP = 200

/**
 * The activity trail's order: newest first, over the log's own monotonic
 * `sync_id`. One column, because that is the case a unique primary allows — see
 * `Keyset`.
 */
const ACTIVITY_ORDER: Keyset = { columns: ['sync_id'], direction: 'desc' }

/**
 * How long after the last logged transaction the debounced watermark alarm
 * waits before mirroring `sync_id` into D1 (`unpublished-changes.md`'s
 * architecture decision 4). A minute of typing costs one D1 write, not one per
 * keystroke.
 */
const WATERMARK_DEBOUNCE_MS = 2000

/**
 * What one socket carries, for the life of the connection, across hibernation.
 *
 * The attachment now exists from the moment the upgrade is accepted rather than
 * from `hello`, which is what `joined` is for — see `broadcast`. Identity is
 * either server-verified (the Worker vouched for it on the upgrade) or advisory
 * (what `hello` asserted, which is all there is under `auth: 'open'`).
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
   * **The membership test for fan-out, and the load-bearing part of this whole
   * change.** `broadcast` used "has an attachment" as its pre-hello quarantine:
   * a socket that has not identified itself has no watermark, so a delta
   * delivered there is a gap the client cannot see. Attaching identity at
   * upgrade time gives every socket an attachment immediately, which would have
   * silently broken that test — a correctness regression in the sync engine
   * dressed up as a login change. Hence an explicit flag.
   */
  joined: boolean
  /** Which blok, and which field inside it (v4). See `PresenceSelection`. */
  selection: PresenceSelection | null
  /** Which locale this socket is editing in; null on the source locale. */
  locale: string | null
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
    selection: null,
    locale: null,
  }
}

/**
 * The wire's view of a socket: identity and selection, and none of the session
 * bookkeeping above.
 *
 * Explicit rather than a spread of the attachment, which is what this used to be:
 * spreading now would put `role`, `session` and `expiresAt` on a presence frame
 * broadcast to every other editor.
 */
function presenceOf(a: Attachment): Presence {
  const actor = a.actor || 'unknown'
  return {
    actor,
    name: a.name || 'Anonymous',
    colour: a.colour || fallbackColour(actor),
    selection: a.selection,
    locale: a.locale,
  }
}

const encode = (msg: ServerMsg): string => JSON.stringify({ ...msg, v: PROTOCOL_VERSION })

/**
 * What `commit` answers — the second door into the log
 * (`schema-migrations.md` architecture decision 4).
 *
 * A refusal is a value, not a throw: the runner records it per story and carries
 * on, so one document whose mutations the object will not take must not abort a
 * run over a hundred others.
 */
export type CommitResult =
  | {
      syncId: number
      txId: string
      /**
       * True when this txId was already in the log, so nothing new was written
       * and nothing was broadcast. The idempotent ack the socket path already
       * gives a resend, in the shape an RPC caller can read.
       */
      replay?: true
    }
  | { rejected: string }

/** A commit's own txId when the caller does not supply one. */
function newTxId(): string {
  return `tx_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** What `applyTransaction` hands back: the delta it logged, or why it refused. */
type TransactionResult = { ok: true; delta: Delta; replay: boolean } | { ok: false; reason: string }

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
 * Refuse a `db` that does not resolve to a D1 binding, at construction.
 *
 * The one thing this object needs from the host env is the database, and it
 * needs it in `alarm()` — a background write, two seconds after an edit, whose
 * failure was caught and logged. So a host that re-exported the default
 * `StoryDO` while naming its binding something other than `DB` got a working
 * editor, a working publish, and a `draft_updated_at` that was **never written**:
 * the content tree stopped reporting unpublished changes, and the only trace was
 * a `Cannot read properties of undefined (reading 'prepare')` in the dev log that
 * named neither the binding nor the fix.
 *
 * That is the same shape as the missing `assets` config that rendered a blank
 * admin behind a 200, and it gets the same treatment: throw, at the earliest
 * point the mistake is detectable, with the fix in the message.
 */
export function requireDb<Env>(config: StoryDOConfig<Env>, env: Env): void {
  const db = config.db(env) as D1Database | undefined
  if (db && typeof db.prepare === 'function') return
  const names = Object.keys(env as object)
    .sort()
    .join(', ')
  throw new Error(
    "folio: StoryDO's `db` did not resolve to a D1 binding. " +
      "`export { StoryDO } from 'folio/server'` assumes a binding named `DB`; " +
      'for any other name build your own: ' +
      '`export const StoryDO = createStoryDO<Env>({ db: (env) => env.MY_D1 })`. ' +
      `Bindings on this env: ${names || '(none)'}`,
  )
}

/**
 * The story object's public surface, **declared rather than inferred**, and the
 * reason is declaration emit rather than documentation.
 *
 * `createStoryDO` returns a class *expression*, which has no name tsc can write
 * into a `.d.ts`, so the emitter has to serialise the type inline — and it
 * refuses (TS4094) the moment such a type carries a private or protected
 * member. Ours held nine; making them `#private` does not help, because `ctx`
 * and `env` inherited from `DurableObject` are protected too and are reported
 * exactly the same way. The failure is silent in the worst way: tsc writes *no*
 * `story-do.d.ts` at all rather than an incomplete one, and `server/types.d.ts`
 * then dangles on `DurableObjectNamespace<StoryDO>`.
 *
 * Naming the return type is what fixes it. The cost is that this list is a
 * second statement of the public surface — but only in one direction: the class
 * expression is checked against it, so a signature that drifts fails the build,
 * and a *new* public method is simply not public until it is added here.
 *
 * `fetch` is redeclared even though `DurableObject` has it, because the base's
 * is optional and `StoryStub` (`server/types.ts`) picks it.
 */
export interface StoryDOInstance<Env> extends DurableObject<Env> {
  getOrInit(seed: Doc): Promise<Doc>
  getOrInitWithSyncId(seed: Doc): Promise<{ doc: Doc; syncId: number }>
  head(): Promise<{ syncId: number }>
  purge(): Promise<void>
  alarm(): Promise<void>
  fetch(req: Request): Promise<Response>
  commit(
    mutations: Mutation[],
    actor: { id: string; name: string },
    txId?: string,
  ): Promise<CommitResult>
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void>
  webSocketClose(ws: WebSocket): Promise<void>
  webSocketError(ws: WebSocket): Promise<void>
  recent(limit?: number, cursor?: string): Promise<Page<ActivityEntry>>
  hasTx(txId: string): Promise<{ syncId: number; mutations: number } | null>
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
export function createStoryDO<Env>(
  config: StoryDOConfig<Env>,
): new (
  ctx: DurableObjectState,
  env: Env,
) => StoryDOInstance<Env> {
  return class StoryDOImpl extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      requireDb(config, env)
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
     * `default 0` on `stories.draft_sync_id` (migrations/0001_init.sql).
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
      // A Durable Object namespace is not publicly addressable: the only way to
      // reach this object is through the Worker that set this header, which is
      // what makes it trustworthy in a way the `hello` frame never was
      // (identity-and-access.md architecture decision 3). Absent means
      // `auth: 'open'`, where `hello`'s self-report is the only identity going.
      const identity = decodeIdentity(req.headers.get(IDENTITY_HEADER))
      const pair = new WebSocketPair()
      // Hibernation: the object can be evicted between edits without dropping
      // connections, so an idle editing session costs nothing.
      this.ctx.acceptWebSocket(pair[1]!)
      // Attached immediately, so the identity exists before the first frame is
      // parsed. `joined: false` keeps this socket out of the fan-out until it
      // says hello — see `Attachment.joined`.
      pair[1]!.serializeAttachment(attach(identity))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    /**
     * Every guarantee a transaction has, in one place: txId dedupe, the frame's
     * mutation cap, atomic per-mutation validation, the document cap, the log
     * append, the doc row update and the debounced watermark alarm.
     *
     * Extracted because there are now two doors — the socket's `tx` frame and
     * the `commit` RPC (`schema-migrations.md` architecture decision 4) — and
     * two copies of this would drift, with the untested copy being the one that
     * drifted. What each door does *not* share is the fan-out and the role
     * check: a socket echoes to its sender and excludes it from the broadcast,
     * a commit has no sender at all.
     */
    private async applyTransaction(
      current: { doc: Doc; syncId: number },
      mutations: readonly Mutation[],
      who: { actor: string; name: string | null },
      txId: string,
    ): Promise<TransactionResult> {
      // Already logged: hand back the delta this txId produced the first time.
      // That idempotent ack is what makes a client's resend after a dropped
      // acknowledgement safe, and it is checked first so a resend never gets as
      // far as re-validating against a document that has since moved.
      const logged = this.logged(txId)
      if (logged) return { ok: true, delta: logged, replay: true }

      const capError = txCapError(mutations as Mutation[])
      if (capError) return { ok: false, reason: capError }

      // Atomic at the door: one violation refuses the whole transaction, since
      // a half-applied tx cannot be undone. Each mutation is checked against
      // the document the ones before it produced, so a tx that inserts a
      // parent and moves an existing blok into it is legal — which the restore
      // path (diff(live, target)) depends on.
      let next = current.doc
      for (const m of mutations) {
        const reason = mutationError(next, m)
        if (reason) return { ok: false, reason }
        next = apply(next, m)
      }

      // Bounds what an unbounded run of individually-legal txs can grow the
      // document to; each admitted mutation above is already legal on its own,
      // so this is checked once against the tx's net effect rather than per
      // mutation. `nextJson` is reused below for the doc row instead of
      // serialising the document twice.
      const nextJson = JSON.stringify(next)
      const docReason = docCapError(next, nextJson)
      if (docReason) return { ok: false, reason: docReason }

      this.sql.exec(
        'insert into log (tx_id, actor, actor_name, mutations, at) values (?, ?, ?, ?, ?)',
        txId,
        who.actor,
        who.name,
        JSON.stringify(mutations),
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

      return {
        ok: true,
        delta: { syncId, txId, actor: who.actor, mutations: mutations as Mutation[] },
        replay: false,
      }
    }

    /**
     * The second door into the log, for a caller with no socket
     * (`schema-migrations.md` architecture decision 4). A content migration
     * lands through here, and so does `../platform/content-api.md`'s write path.
     *
     * **Not a new write path.** It runs the same `applyTransaction` the `tx`
     * frame does, so it inherits every guard: the cap, atomic validation, the
     * document ceiling, dedupe, the log append and the watermark alarm. What it
     * adds is a fan-out with no sender to exclude — every joined socket gets the
     * delta, which is what makes a migration appear in an open editor live, in
     * the activity trail, and under Cmd+Z.
     *
     * `txId` is optional and generated when absent. A caller that supplies one
     * gets the log's dedupe: the same txId twice is answered `replay` and
     * written once. The migration runner deliberately does *not* reuse a txId
     * across runs — see `server/migrate.ts` for why value-idempotence, not
     * dedupe, is what protects two concurrent runs.
     *
     * Refuses rather than throws when the object has no document yet: the
     * caller's job is to `getOrInit` first, and inventing a seed here would mean
     * this object knowing what a document type looks like.
     */
    async commit(
      mutations: Mutation[],
      actor: { id: string; name: string },
      txId: string = newTxId(),
    ): Promise<CommitResult> {
      const current = this.read()
      if (!current) {
        return { rejected: 'no document: this story has never been opened' }
      }

      const result = await this.applyTransaction(
        current,
        mutations,
        { actor: actor.id, name: actor.name || null },
        txId,
      )
      if (!result.ok) return { rejected: result.reason }

      if (!result.replay) this.broadcast({ type: 'delta', ...result.delta })

      const { syncId, txId: logged } = result.delta
      return result.replay ? { syncId, txId: logged, replay: true } : { syncId, txId: logged }
    }

    /**
     * The only door a mutation arrives by over the wire. Parsing, shape
     * validation and dispatch all happen inside here: a frame this object cannot
     * read is answered and discarded, never thrown, because an exception out of
     * a hibernatable handler takes the connection with it.
     */
    async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
      // Ahead of parsing, and shared with SpaceDO (`sockets.ts`): a frame this
      // large would cost a JSON.parse over attacker-controlled input before
      // anything else got a chance to refuse it.
      const tooBig = frameSizeError(raw)
      if (tooBig) {
        this.sendTo(ws, { type: 'error', reason: tooBig })
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

      // Every frame, whatever its type: a socket whose session has ended must
      // stop being able to write, and the check has to happen before the frame is
      // dispatched rather than inside the one case that mutates.
      const held = ws.deserializeAttachment() as Attachment | null
      const who = held ? await liveSession(config.db(this.env), ws, held, 'story-do') : null
      if (held && !who) return

      const current = this.read()
      if (!current) return

      switch (msg.type) {
        case 'hello': {
          // A verified identity is not overwritable, and at v3 the frame says so
          // structurally: `hello.identity` is optional and nested
          // (`localisation.md`), and it is read in exactly one situation —
          // `auth: 'open'`, where there are no accounts and a client's self-report
          // is the only thing that tells two anonymous tabs apart. A socket the
          // Worker vouched for never reaches the second branch, whatever it sent.
          const base = who ?? attach(null)
          const asserted = msg.identity
          const attachment: Attachment =
            base.verified || !asserted
              ? { ...base, joined: true }
              : {
                  ...base,
                  actor: asserted.actor,
                  name: asserted.name,
                  colour: asserted.colour,
                  joined: true,
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
          this.broadcast({ type: 'presence', peer: presenceOf(attachment) }, ws)
          break
        }

        case 'tx': {
          const actor = who?.actor || 'unknown'

          // The role gate, and the only place in the object that has one
          // (architecture decision 5). A viewer is answered with the existing
          // `reject` envelope, which the client already handles by dropping the
          // tx and surfacing the reason — so a read-only editor degrades into a
          // read-only editor rather than into a broken one. Checked before the
          // dedupe lookup: a viewer's resend must not be answered with somebody
          // else's delta either.
          //
          // Deliberately outside `applyTransaction`: it is a property of *this
          // door*, not of the log. `commit` has no role to check — the route
          // that reaches it is gated on `admin` before the RPC is made.
          if (who?.role === 'viewer') {
            this.sendTo(ws, {
              type: 'reject',
              txId: msg.txId,
              reason: 'read-only: your role may not edit',
            })
            return
          }

          const result = await this.applyTransaction(
            current,
            msg.mutations,
            { actor, name: who?.name || null },
            msg.txId,
          )
          if (!result.ok) {
            // Same envelope for every refusal — oversized, malformed, or over
            // the document cap — and the sender always gets its txId back so it
            // can drop the tx from `pending` rather than wait for a delta that
            // will never come.
            this.sendTo(ws, { type: 'reject', txId: msg.txId, reason: result.reason })
            return
          }
          if (result.replay) {
            // Sender only, no re-apply, no new syncId. Flagged as a replay
            // because its syncId is old: a client that has already drained this
            // tx must recognise the frame instead of applying stale mutations
            // over a newer base.
            this.sendTo(ws, { type: 'delta', ...result.delta, replay: true })
            return
          }
          const delta: ServerMsg = { type: 'delta', ...result.delta }
          // The sender's echo is its acknowledgement, so it is sent directly rather
          // than through the fan-out: the pre-hello quarantine withholds edits a
          // socket did not ask for, never the answer to one it did.
          this.sendTo(ws, delta)
          this.broadcast(delta, ws)
          break
        }

        case 'presence': {
          // `joined`, not merely "has an attachment": a socket that has not said
          // hello has no identity to announce, and announcing one under
          // `auth: 'open'` would mean broadcasting an empty peer.
          if (!who?.joined) return
          // `locale` is normalised to null by `parseClientFrame` when absent, so
          // a client that never sends one reads as "the source locale" rather
          // than as "unknown".
          const next: Attachment = { ...who, selection: msg.selection, locale: msg.locale ?? null }
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
      const attachment = ws.deserializeAttachment() as Attachment | null
      // Only a socket that joined was ever announced as arriving, so only one
      // that joined has a departure to announce. Every socket has an attachment
      // now, so this is `joined` rather than a presence check.
      if (attachment?.joined) {
        this.broadcast({ type: 'presence', peer: presenceOf(attachment), gone: true }, ws)
      }
    }

    /**
     * Most recent transactions, newest first, **paged over a cursor**. This is the
     * fine-grained activity trail — useful for "who changed this", not for
     * restoring. Restores go through versions in D1.
     *
     * `foundation/pagination.md` phase 4 named this route and only converted the
     * versions route beside it, which left the two disagreeing in a way that read
     * as an oversight in the e2e scripts and was a real difference in the routes:
     * `versions.rows`, `activity` unadorned. Both are `Page<T>` now.
     *
     * The keyset is **one column**, and this is the case `Keyset` allows it for:
     * `sync_id` is assigned by the log itself and is monotonic within one
     * document, so it is already a total order and a tiebreak could never fire.
     *
     * The log is unbounded and grows with every transaction (`ROADMAP.md` records
     * that it wants compaction), so this is the one reader here where paging is
     * not a nicety — the old cap answered at most 500 of however many there are,
     * with no way to reach the rest.
     */
    async recent(limit = 80, cursor?: string): Promise<Page<ActivityEntry>> {
      const size = clampLimit(limit, 80, 500)
      const resume = keysetWhere(ACTIVITY_ORDER, cursor ? decodeCursor(cursor) : null)
      const rows = this.sql
        .exec<{
          sync_id: number
          actor: string
          actor_name: string | null
          mutations: string
          at: number
        }>(
          `select sync_id, actor, actor_name, mutations, at from log
           ${whereOf(resume.sql)} ${orderBy(ACTIVITY_ORDER)} limit ?`,
          ...resume.binds,
          // One more than asked for, which is how `paginate` knows there is a next
          // page without a second query.
          size + 1,
        )
        .toArray()
        .map((r) => ({
          syncId: r.sync_id,
          actor: r.actor,
          actorName: r.actor_name,
          at: r.at,
          mutations: JSON.parse(r.mutations) as ActivityEntry['mutations'],
        }))
      return paginate(rows, size, (row) => [row.syncId])
    }

    /**
     * Whether a txId is already in this log, and how much it did. A **read**: it
     * writes nothing, broadcasts nothing and touches no alarm.
     *
     * For `../platform/content-api.md`'s `Idempotency-Key`, and specifically for
     * the retry whose recomputed diff is *empty* — the ordinary case, since the
     * first attempt already landed the change. `commit` alone cannot answer that
     * one: an empty transaction is within every cap, so probing with
     * `commit([], actor, txId)` would log an empty tx for a genuinely-new key,
     * bump `sync_id`, and thereby make an unchanged story report unpublished
     * changes. So the question is asked instead of guessed at.
     */
    async hasTx(txId: string): Promise<{ syncId: number; mutations: number } | null> {
      const delta = this.logged(txId)
      return delta ? { syncId: delta.syncId, mutations: delta.mutations.length } : null
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
        if (a?.joined) out.push(presenceOf(a))
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
     * see.
     *
     * The membership test is `joined`, and it used to be "has an attachment".
     * That worked only because the attachment was *created* by `hello`; now that
     * the Worker attaches a verified identity at upgrade time, every socket has
     * one from the start, and the old test would have admitted every lurker.
     * See `Attachment.joined`.
     */
    private broadcast(msg: ServerMsg, exclude?: WebSocket) {
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
 * The default this package ships: reads `env.DB` by convention, so
 * `export { StoryDO } from 'folio/server'` keeps working unchanged for every
 * host that already names its D1 binding `DB` (examples/demo included). A host
 * with a differently named binding calls `createStoryDO` directly instead.
 */
export const StoryDO = createStoryDO<DefaultStoryEnv>({ db: (env) => env.DB })
export type StoryDO = InstanceType<typeof StoryDO>
