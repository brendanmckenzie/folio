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

**9. The wire protocol is versioned.** Every message carries `v`. The DO refuses
any frame with an unknown version; persisted logs already outlive deploys, and
the wire format will too.

**10. A wire change must be additive to a logged mutation, and every entry
already in a log must replay under its old meaning forever.** Bumping the version
is how a *peer* finds out it cannot read what this deploy sends. It is never a
licence to reinterpret what an older deploy wrote.

The concrete case, and the shape every later one should copy: **a `set` with no
`locale` is a source-locale write, permanently** (v3, `content-model/
localisation.md`). Every `set` in every log written before locales existed is
exactly that, so the whole history replays with no migration — and `invert`
*omits* the locale key rather than writing `undefined` for a source-locale write,
so a fresh inverse serialises byte-for-byte as an old one did. `retype` (v2) is the
other shape that works: a new variant, so a `set` written under v1 is still a
`set`.

The bump was still necessary, and for the opposite reason to the obvious one: a v2
*client* handed a locale-scoped delta would drop the field it does not know about
and write the value into `data`. That is not a missing feature, it is silent
divergence between two clients looking at the same document — so it has to be
refused at the handshake instead.

**v4 is the cheapest bump there has been, and it is worth saying why.** Presence
gained a field and a locale, and a second channel appeared
(`editing/live-collaboration.md`) — and *nothing in it touches a mutation*.
Presence is never persisted and the space object holds no storage at all, so
there is no log entry whose meaning could shift and nothing to stay compatible
with. The bump is still needed, for the same shape of reason as v3: a v3 client
handed `selection: { uid, field }` fails its own shape guard and drops every
presence frame, and a peer dot that silently stops appearing is exactly what the
handshake exists to make visible.

## The space channel is not the sync engine

`editing/live-collaboration.md` added a second socket, to a second Durable Object
(`SpaceDO`), and **nothing about it is authoritative**. This is the one thing a
future reader must not misunderstand about it, so it gets a section of its own.

The story channel is an ordered log. Every delta has a `syncId`, a client tracks a
watermark, a gap triggers a resync, and a resend is deduped by `txId`. All of that
exists because the document is the source of truth and divergence is silent.

The space channel has none of it, and must never grow any of it:

- **No content crosses it.** It carries "story X was renamed / created / deleted /
  published" and who is where. A delta stays on its story's own socket, where the
  watermark and the catchup logic are. Putting content here would mean two
  orderings to reconcile — the one thing this design is careful about — for a
  feature whose worst failure is a stale tree.
- **No ordering guarantee, and no watermark.** Two renames in flight resolve as
  "last applied wins", and if that is the wrong one the next tree load corrects
  it. Nothing is replayed, because there is nothing to replay onto.
- **No persistence, anywhere.** The object holds no SQLite and no key-value
  storage; presence lives entirely in socket attachments and dies with them.
  There is therefore no state that a missed frame could corrupt.
- **Events are idempotent and advisory.** A client that missed one is corrected by
  the next `GET /folio/stories`, which is the authoritative answer and is always
  one request away. That is what makes it safe for the client to reload rather
  than reconcile.

The practical consequence: a bug on the space channel can make the editor's tree
stale or an avatar wrong. It cannot lose an edit, cannot diverge two documents,
and cannot corrupt a log. If a change to it ever *could*, that change belongs on
the story channel instead.

Two things follow that look like duplication and are not. A selection is sent on
both channels — the story channel needs it for per-block dots with no round trip
through a second object, and the space channel needs it for the tree and for
follow-mode. And the editing locale rides story presence as well as space
presence, so a peer ring can name a language even on a deployment that never
declared the space binding. Two cheap frames beat one object trying to be both.

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
