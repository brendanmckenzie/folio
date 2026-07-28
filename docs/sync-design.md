# Sync engine: correctness decisions

Decisions behind the Phase 2 hardening pass. The review that motivated them
found every serious defect where two clients, a reconnect, or interleaved
requests meet; these are the rules that make those paths convergent. The test
suite pins each one; this file records *why*.

## The model, restated

Linear-style log replication, deliberately not OT/CRDT: the Durable Object owns
a totally-ordered mutation log per story; clients apply optimistically and the
server's order is truth. Merge semantics are last-write-wins per field. That is
the right trade for a CMS — the invariants below exist to make LWW *converge*,
not to make concurrent prose merges clever.

## Rules

**1. A transaction is atomic and validated at the door.** The DO validates
every mutation in a tx against its live doc before appending anything. One
invalid mutation rejects the whole tx: nothing lands in the log, no delta is
broadcast, and the sender gets a `reject { txId, reason }`. Client handling of
`reject`: drop the tx from `pending`, recompute the view, surface it. Partial
application is never an option — a half-applied tx is not undoable.

**2. `apply()` is defensive anyway.** Independently of server validation,
applying an invalid mutation is a structural no-op: a `move` that would create
a cycle, parent the root, self-parent, or target a missing parent; an `insert`
whose uid already exists; a `remove` of the root. Client and server run the
same `applyAll` over the same log, so the guard must be deterministic and live
in core — and old logs written before the guards must still replay to a sane
doc. Tree walkers (`subtree`, `ancestorsOf`) carry a visited set for the same
reason: a poisoned log must degrade, never hang.

**3. The server dedupes by txId.** The log's `tx_id` is unique. A resent tx
that already applied is answered with its original delta (an idempotent ack)
and is never re-applied or re-broadcast. This is what makes resending safe.

**4. Clients keep `base` + `pending`, and rebase.** `base` is the last
server-confirmed doc; the rendered view is `base` with pending txs replayed on
top. Every incoming delta — a peer's or our own echo — applies to `base` in
syncId order; our echo also removes its tx from `pending`. The old scheme
(swallow own echo as a pure ack, apply remote deltas onto the optimistic view)
diverges permanently whenever the server orders a peer's write between ours;
rebase makes the view equal `base` the moment `pending` drains, on every
client.

**5. Offline edits queue; reconnect replays.** Sends while the socket is not
OPEN are queued, not dropped. After a reconnect finishes syncing `base`
(catchup or bootstrap), the client re-sends `pending` in order with the
original txIds — rule 3 makes the retry at-most-once, rule 1 rejects whatever
no longer applies. A bootstrap replaces `base`, never `pending`.

**6. The watermark only moves contiguously.** `lastSyncId` advances only
through consecutive syncIds. A gap means a missed delta: the client re-runs the
hello/catchup handshake rather than papering over it. On the server side, a
socket receives no broadcasts until its `hello` is processed — the pre-hello
window was the source of the gaps. `webSocketError` cleans up exactly like
`webSocketClose`.

**7. Uids are 64-bit; ties break on uid.** 8 hex chars (32 bits) collides at
~77k ids and an insert collision silently replaces the victim (rule 2 now
refuses it; new uids are 16 hex chars). Sibling order compares `(order, uid)`
so equal fractional keys — two clients inserting between the same neighbours —
render identically everywhere. Existing 8-char uids stay valid.

**8. Diff emits inserts → moves → sets → removes.** Removals cascade over the
live subtree at apply time, so they must come last or they destroy children the
diff intended to rescue (`diff(live, target)` is the restore path). Inserted
parents already precede their children; moves before removes can therefore
always land.

**9. The wire protocol is versioned.** Every message carries `v: 1`. The DO
refuses a `hello` with an unknown version; persisted logs already outlive
deploys, and the wire format will too.

## Deliberately unchanged

- **LWW on concurrent field writes** — correct for this product; rebase makes
  it converge, which is all it owed us.
- **Undo across remote edits clobbers peers** — accepted; an undo entry stores
  absolute values. Revisit only with real editor feedback.
- **`set` of an absent field inverts to `null`, not absent** — a deliberate
  normalisation, pinned by test.
- **Story-tree writes in D1 are last-write-wins under concurrency** — the
  practical fix (a coordinating DO or retry-on-constraint) is scheduled with
  the migrations work, where `unique(parent_id, slug)` lands.
