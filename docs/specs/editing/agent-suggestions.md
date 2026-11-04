# Feature: Agent suggestions, and agents in the room

> **Group:** editing
> **Build order:** 39
> **Size:** L
> **Status:** draft
> **Wire version:** bumps `PROTOCOL_VERSION` to 6 (a `suggestion` server frame; `bootstrap` and `catchup` carry pending suggestions; `tx` may carry `accepts`; a `decline` client frame; `Presence` gains `kind` and `ttlMs`)
> **Migration:** `0018_suggestions.sql` (one counter column on `stories`). The Durable Object's own tables are created by the object, as `log` and `doc` already are
> **Build sequence:** v1.5, after specs 40 and 41 ship as v1.4 (`docs/1.0-plan.md` is unaffected; this is post-1.0 work). It touches `story-do.ts`, `core/protocol.ts` and `admin/store.ts`, so nothing else that edits those three may be in flight while it builds
> **Last updated:** 2026-11-04

## Summary

An agent connected over MCP can change a document today, and it can only do it one
way: by writing straight into the draft (`write_content`, `patch_fields`,
`src/server/mcp/tools.ts:338-391`). A person who wants an agent's help on a live site
has two choices, both bad. Give it `content:write` and accept that every proposal
lands in the draft the moment the model decides it is right, or give it nothing and
copy its answers in by hand. There is no way to say "propose this, and I will
review it", which is the thing a person actually wants from a collaborator they do
not fully trust yet.

The agent is also invisible while it works. A token cannot open an editing socket
(`src/server/routes/editor.ts:86-88`), so it never appears in presence, and the only
place its name shows is the activity trail after the fact. An editor watching a
field change under them is told "Somebody else changed this field", because the
overwrite notice looks the actor up among the peers and the agent is never one
(`src/admin/store.ts:555`).

This spec adds **suggestions**: a changeset an agent proposes instead of writes,
held by the story's Durable Object beside the log, shown live in every open editor,
and accepted or declined by a person per block or as a whole. Accepting is an
ordinary transaction sent from the reviewer's own editor, so it lands in the log,
the activity trail and the reviewer's own undo stack. It also adds **agent
presence**: a token that touches a document appears as a named peer in that
document's editor for a short while after it last acted, with a dot on the block it
touched.

## Ground truth

Read at `704fbf9` (main, v1.3.1). Line numbers are for that commit.

**Two claims elsewhere in this repository are false, and this spec is partly the fix
for them:**

- `docs/mcp.md:238` says an edit made over MCP "is **undone by Cmd+Z** in that
  editor, in one step", and `StoryDO.commit`'s comment says the same ("under Cmd+Z",
  `src/server/story-do.ts:588-590`). It is not. The undo stack is per client and is
  pushed only by `StoryStore.tx` (`src/admin/store.ts:603`). A delta from anybody
  else is folded into `base` by `integrate` (`store.ts:498-532`) and never becomes
  an undo entry. `write.ts:199-200` states the true rule: "The restorer's own undo
  stack lives in the browser and a server commit never joins it." An agent's direct
  write is recoverable by restoring a version, not by Cmd+Z.
- `state.md`'s premise that agent writes "get sync, undo, presence and the activity
  trail" is right about sync and the trail, wrong about undo (above), and wrong about
  presence: a token is refused an editing socket (`editor.ts:86-88`) and nothing else
  puts a non-socket actor into `peers()` (`story-do.ts:909-917`).

**core (`src/core/`):**

- `PROTOCOL_VERSION = 5` (`protocol.ts:45`), with the version table in the comment
  above it (`:16-44`). `ClientMsg` is `hello | tx | presence` (`:105-108`);
  `ServerMsg` is `bootstrap | catchup | delta | presence | reject | error`
  (`:110-128`). `bootstrap` and `catchup` carry `peers: Presence[]`.
- `Presence` is `{ actor, name, colour, selection, locale }` (`:64-82`). Nothing on
  it says whether the peer is a person.
- `ActivityEntry` is `{ syncId, actor, actorName, at, mutations }` (`:150-156`).
- `MAX_TX_MUTATIONS = 200` (`:187`), `MAX_FRAME_BYTES = 256 KiB` (`:195`, checked on
  inbound frames only, in `frameSizeError`), `MAX_DOC_BYTES = 8 MiB` (`:209`). A
  `bootstrap` already carries the whole document, so a server frame of several MiB
  is a shape the platform is already asked to deliver.
- `isClientMsg` (`:422-438`) and `parseClientFrame` (`:450-480`) are the hand-rolled
  guards; `parseClientFrame` rebuilds every message rather than passing it through,
  so a new frame type or field must be added to both.
- `invert` (`mutations.ts:212-259`) answers absolute prior state: a `set` inverts to
  the prior value or to an `unset` when the key was absent; `insert` inverts to
  `remove`; `remove` inverts to an `insert` of every blok in the subtree, parents
  first; `move` to a move back; `retype` to the old type. `invertAll` (`:261`)
  inverts against the state each mutation saw.
- `mutationError` (`mutations.ts:63-90`) is the door's validator; `apply` is a
  structural no-op on anything it refuses (`:98`).

**server (`src/server/`):**

- `StoryDO` holds two SQLite tables, `doc` and `log` (`story-do.ts:261-275`). Columns
  are added in place with a guarded `alter table` (`:277-281`), which is the pattern
  a new log column follows.
- `applyTransaction` (`:509-578`) is every guarantee a transaction has: dedupe on
  `txId` first (`:519-520`), the mutation cap, atomic per-mutation validation, the
  document cap, the log insert (`:546-553`), the doc row update (`:557`), then an
  `await` on the alarm (`:564-571`). The log insert and the doc update are two
  statements with no `transactionSync` around them.
- `commit` (`:602-624`) is the second door: same `applyTransaction`, then a
  broadcast to every joined socket. `CommitResult` is a value, never a throw
  (`:125-136`).
- The socket's `tx` case (`:723-775`) has the object's only role gate: a `viewer`
  is answered `reject` (`:737-744`). The sender's echo goes to the sender directly
  (`:772`), and the rest of the room through `broadcast` (`:773`).
- `peers()` (`:909-917`) is built from `ctx.getWebSockets()` alone, and
  `presenceOf` (`:104-113`) is the explicit projection the invariant in `CLAUDE.md`
  protects ("never spread the attachment").
- `purge()` (`:389-399`) closes every socket and deletes `log` and `doc`. It is the
  only cleanup a deleted story gets inside its object.
- **A Durable Object has one alarm, and `StoryDO` spends it on the draft watermark**
  (`alarm()`, `:415-441`, scheduled only when `getAlarm() === null`, `:565`).
  `src/server/scheduler.ts:5-20` records the two ways a second use of that alarm
  collides with the first. Anything in this spec that needs a timer must not use it.
- `mirrorDraftData` (`:455-467`) is the precedent for a D1 write from inside the
  object: a statement of its own, awaited, a failure logged and not retried, so a
  Worker deployed before its column exists fails that one write and nothing else.
- `recent()` (`:831-858`) selects named columns from `log`, so a new column is
  invisible to it until it is named.
- `StoryDOInstance` (`:218-236`) is the declared public surface; a new public method
  is not callable over RPC until it is added there (`:210-213`), and `StoryStub`
  (`src/server/types.ts:585-596`) is a `Pick` of it that also has to grow.
- `commitAll` (`write.ts:91-135`) chunks at `MAX_TX_MUTATIONS` and writes nothing for
  an empty list. `writeDocument` (`:177-188`) is read-diff-commit.
- `PUT /documents/:id/content` is `putContent` (`routes/api/documents.ts:537-574`):
  `fromNested` against the draft, with `layerOption` for a bare layer.
  `PATCH /documents/:id/fields` (`:582-630`) builds `set` mutations by hand after
  `fieldShapeError` and drops unchanged values. Both load the story with
  `load(c, id, "write")` and attribute through `writeActor` (`:161-166`), which is
  `actorString` and `actorName` and never anything a client sent.
- `POST /documents/:id/publish` (`:699-709`) calls `publish()`
  (`src/server/publish.ts:119`), which reads the draft through `draftWithSyncId` and
  nothing else in the object.
- The schema migration runner commits as `migration:<id>` (`migrate.ts:253`,
  `:335`).
- The space object holds no storage at all (`space-do.ts:5-10`), and
  `docs/sync-design.md` ("The space channel is not the sync engine") says it must
  never grow any.

**auth (`src/server/auth/roles.ts`):**

- `ROLES` is `viewer, editor, publisher, admin` (`:15`). `SCOPES` is seven names in
  ramp order (`:45-53`); `IMPLIES` (`:67-79`) says what each grants.
- `actorString` answers `token:<name>` for a token and `users.id` for a person
  (`:306-310`). Two tokens with one name are one actor everywhere.
- `allows` (`:414-432`): a `GrantActor` answers only scope-tier reads with role
  `viewer` (`:418-422`); a token is judged by `hasScope`, a person by `atLeast`.
- `tokenScopesOn` (`:167-177`) gives a site-bound token its full scopes only on the
  scopes that write to its site, and only `READ_SCOPES` (`:156`) further down the
  chain.
- `EDIT` is `{ editor, content:write, scope }` (`:344`); `CREATE` is the same
  (`:359`); `READ_DRAFT` is `{ viewer, content:read:draft, scope }` (`:341`).

**MCP (`src/server/mcp/`, `src/server/routes/mcp.ts`):**

- Every tool but `preview_document` is a row naming a v1 route, dispatched through
  the mounted app's own `fetch` (`tools.ts:1-25`, decision 2 of
  `docs/specs/platform/mcp-server.md`). `tools/list` filters rows by `allows(actor,
  tool.need)` (`toolsFor`, `:554-556`), so a tool the token cannot call is not
  listed.
- `INSTRUCTIONS` (`routes/mcp.ts:89`) is the server's prose to the client.
- MCP decision 11 rejected an `Idempotency-Key` tool argument because "a model that
  must remember to pass a nonce will forget".

**admin (`src/admin/`):**

- `StoryStore` keeps `base` plus `pending` (`store.ts:197-199`). `PendingTx` is
  `{ mutations, seq }` (`:93-96`). A reconnect resends every pending tx with only
  `txId` and `mutations` (`:314`). A `reject` drops the tx and every undo entry at or
  after it (`:470-485`).
- `tx()` (`:586-621`) pushes `invertAll(doc, mutations)` onto the undo stack and
  coalesces runs of `set` on one field; `dispatch` (`:569-583`) sends the frame.
- A `presence` frame replaces the peer with the same `actor` (`:464-468`). Nothing
  ever removes a peer except a `gone` frame or a bootstrap.
- `BlockRail` draws a dot per peer whose `selection.uid` is the row
  (`ui/screens/BlockRail.tsx:279`).
- `actorForm` (`ui/screens/history-model.ts:134-151`) already renders `token:<name>`
  as a token with a badge.
- Token presets live in `ui/screens/access-model.ts:290-321`, and every scope needs a
  `SCOPE_MEANING` entry (`:232-261`), which is a `Record<Scope, …>` and so fails to
  compile when a scope is added without one.

**D1:**

- `COLS` (`stories.ts:76-81`) is the one column list every `StoryMeta` read uses.
  Next free migration is `0018` (`CLAUDE.md`, "The two ledgers").

**tests:**

- `test/workers/story-do.test.ts` drives the object directly, including the
  pre-hello quarantine test the `joined` invariant names.
- `test/workers/scope-partition.test.ts` enumerates every mounted id route from Hono
  and fails on one that is not fence-tested.
- `test/unit/mcp/tools.test.ts` round-trips every routed row against the app;
  `test/unit/mcp/scopes.test.ts` pins `tools/list` per scope set.
- `test/unit/core/protocol.test.ts` pins the guards.

## User stories

### Editor reviews what the assistant proposed
**As** an editor **I want to** see an assistant's proposed copy in the page I have
open, block by block, **so that** I can take the parts that are right and leave the
rest without retyping anything.

### Editor takes it back
**As** an editor **I want** Cmd+Z after accepting a suggestion to undo the accept in
one step **so that** accepting is as safe as typing.

### Site owner trusts an assistant on a live site
**As** a site owner **I want to** mint a token that can propose changes and cannot
make them **so that** I can let an assistant work on the live site without its
mistakes reaching the draft unreviewed.

### Editor sees the assistant at work
**As** an editor **I want to** see "claude" in the editor's peer list, with a dot on
the block it just touched, **so that** a field changing under me has a name on it.

### Publisher knows what is outstanding
**As** a publisher **I want to** see that a page has suggestions waiting before I
publish **so that** I do not ship a page while a correction to it sits unreviewed.

### Agent learns what was kept
**As** an agent **I want to** read back which of my suggestions were accepted and
which were declined **so that** my next proposal builds on the reviewer's choices.

## Architecture decisions

### 1. Pending suggestions live in the story's Durable Object, in a table beside the log

A suggestion is a row in a new `suggestion` table in the story object's SQLite, next
to `doc` and `log`. The object validates it against the live document when it
arrives, computes each unit's prior state from that same document, broadcasts it on
the story's socket, and applies an accepted part through `applyTransaction` in the
same object request that marks it accepted.

**Rejected: a D1 table.** Accepting reads the suggestion, checks it against the
current draft, writes the log, and marks the suggestion decided. With the suggestion
in D1 and the draft in the object, that is two stores and no transaction across
them: a crash between "log written" and "D1 marked accepted" leaves a suggestion
that offers to apply itself twice. D1 reads also run on sessions that may be served
by a replica (`server/db.ts`), so "is this still pending" can be answered from the
past. And nothing else needs the rows in SQL: no list query crosses stories except
the count, which decision 10 mirrors on its own.

**Rejected: the log itself, as entries flagged pending.** The log is the applied
history, and its contract is that `doc` is the fold of it. A pending entry would
have to be skipped by `since()` catch-up, by `recent()`, by every client's
`applyAll`, and by the watermark, which mirrors `sync_id` into
`stories.draft_sync_id`. A pending suggestion that advanced `sync_id` would make a
page report unpublished changes for content that is not in the draft. Every one of
those readers would need the flag, and the one that forgot would apply a proposal
nobody accepted.

The tradeoff accepted: suggestions cannot be listed across a site with one query.
The counter in decision 10 covers the tree, and a site-wide review queue is out of
scope.

### 2. A suggestion is a list of mutations partitioned into units, one per block

The stored suggestion is the same `Mutation[]` a direct write of the same payload
would have committed, in the same order (`diff`'s inserts, moves, sets, removes,
`sync-design.md` rule 8). At creation the object partitions it into **units** with
`suggestionUnits(doc, mutations)` (new, `src/core/suggestions.ts`), walking the
mutations in order:

- An `insert` whose parent is not inserted by this suggestion starts a unit keyed
  `ins:<uid>`. An `insert` whose parent is inserted by this suggestion joins that
  parent's unit. So a new section with three cards is one unit.
- A `set` or `unset` on a blok this suggestion inserts joins that insert's unit.
  Otherwise it joins the unit `blk:<uid>`, so every field edit on one existing block
  is one unit.
- A `move` whose target parent this suggestion inserts joins that insert's unit,
  because it cannot apply without it. Otherwise it joins `blk:<uid>`.
- A `remove` and a `retype` join `blk:<uid>` (or the insert's unit, for a blok the
  suggestion both inserts and removes).

Each unit stores the indices of its mutations and its **inverse**: `invertAll`
over the unit's own mutations against the document as it stood when the suggestion
arrived. The inverse is the record of what the unit would overwrite, which is what
decision 3 tests and what the reviewer is shown as "now".

Accepting a set of units applies `acceptMutations(suggestion, keys)`: the
suggestion's mutations at those units' indices, in ascending index order. Order is
preserved, so a subset of a valid `diff` stays in `diff` order.

A suggestion is capped at `MAX_TX_MUTATIONS` mutations and at
`MAX_SUGGESTION_BYTES = 192 KiB` of serialised mutations. Both caps exist for one
reason: accepting every unit must fit in one transaction and one inbound frame
(`MAX_FRAME_BYTES`, 256 KiB, less the envelope), so that an accept is atomic and is
one undo step.

**Rejected: one undivided changeset, accept or decline whole.** An agent rewriting a
page's copy produces a dozen independent block edits, and the ordinary review is
"yes to these four". All-or-nothing turns that into "decline, then ask again with
fewer changes", which is the retyping this feature exists to remove.

**Rejected: per-field units.** A field is the wrong grain for anything structural
(an inserted card has no "field" to accept), and for copy the reviewer's unit of
attention is the block: the rail and the preview both show blocks. Per-block also
keeps the inverse of a removed subtree in one unit, so it cannot be half accepted.

**Rejected: chunking a large suggestion over several transactions on accept.** It
would make "accept all" several log entries, several undo steps, and a state in
which half of an accepted suggestion has landed when the socket drops. An agent
that wants a larger change makes two suggestions.

### 3. A human edit never blocks or discards a suggestion; it makes the units it overlaps *conflicted*, which is computed and never stored

`unitDrift(current, unit)` (new, `core/suggestions.ts`) compares the document as it
is now with the unit's inverse and reports where they differ. A unit with any drift
is **conflicted**. The rules, one per inverse mutation kind, skipping any inverse
that addresses a blok the same unit inserts:

| Inverse | Conflicted when |
| --- | --- |
| `set { uid, field, locale, value }` | the blok is gone, or its value at `(field, locale)` no longer deep-equals `value` |
| `unset { uid, field, locale }` (the key was absent) | the blok is gone, or the key is now present |
| `remove { uid }` (the unit inserts `uid`) | `uid` now exists, or the insert's parent is gone |
| `move { uid, parent, slot, order }` | the blok is gone, or its `parent`, `slot` or `order` differs |
| `insert { blok }` (the unit removes a subtree) | that blok is gone, or no longer deep-equals `blok` |
| `retype { uid, type }` | the blok is gone, or its type differs |

Drift is computed, not tracked: the object never walks pending suggestions on a
keystroke, the client computes it from its own view for display, and the list
route computes it on read. A colleague who edits a field and then reverts it makes
the unit current again, which a stored flag would get wrong.

**A conflicted unit can still be accepted by a person.** The reviewer sees the
current value beside the suggested one and chooses; accepting overwrites the newer
edit exactly as typing over it would, and `live-collaboration.md` decision 5's
overwrite notice tells the colleague if they have that field focused. That is
last-write-wins made visible, the model `sync-design.md` already chose.

**Rejected: lock a block while a suggestion is pending on it.** An agent could
freeze any page it can suggest on, and the people who own the content would be the
ones locked out by a proposal from a tool.

**Rejected: decline a unit automatically when it conflicts.** One unrelated
keystroke in a block would throw away an agent's whole proposal for it, and the
reviewer would never see what was proposed.

**Rejected: rebase or three-way merge a unit onto the newer state.** The sync engine
is deliberately not OT or CRDT (`sync-design.md`, "The model, restated"). A merged
value is a third text nobody wrote or reviewed.

### 4. Accepting is an ordinary `tx` from the reviewer's editor, carrying `accepts`; declining is a frame of its own

The admin accepts by dispatching the units' mutations through `StoryStore` as an
ordinary transaction whose frame also says `accepts: { id, units }`. The object
checks that claim and, in the same object request, marks those units accepted. A
decline is a `decline { id, units }` frame with no mutations.

This is what gives undo its right meaning (decision 8), and it inherits the rest of
the socket's guarantees for free: optimistic local apply, rebase, the offline queue
and resend, txId dedupe, and the socket's role gate, which is "the one write path no
`requireAccess` stands in front of" (`editor.ts:90-96`) and already refuses a
viewer.

The object's order of checks for a `tx` with `accepts`:

1. The role gate, unchanged (`story-do.ts:737-744`).
2. **Dedupe first.** If `txId` is already logged, answer the replay ack as today. A
   resend of an accept that already landed must not be refused because its units
   are no longer pending.
3. The suggestion exists, is `open`, and every named unit is `pending`. Otherwise
   `reject` with "that suggestion is no longer pending".
4. `mutations` deep-equals `acceptMutations(suggestion, units)`. Otherwise `reject`
   with "the accepted changes do not match the suggestion". This is what stops a
   client marking a suggestion accepted while sending something else.
5. `applyTransaction`, with the units' state change and the log row's attribution
   written in **one `transactionSync`** with the log insert and the doc update.

Step 5 needs a change to `applyTransaction`: the log insert (`:546-553`), the doc
update (`:557`) and an optional `alongside()` callback run inside
`ctx.storage.transactionSync`, and only then is the alarm awaited. Today the two
writes are separate statements with an `await` after them, which was harmless while
they were the only writes; a third write that must agree with them is not.

**Rejected: an HTTP accept route that calls `commit` server-side.** A server commit
never joins anybody's undo stack (`write.ts:199-200`), so Cmd+Z after accepting
would undo the reviewer's previous keystroke instead. It would also put a write path
in the admin that the socket's role gate does not cover, beside one that it does.

**Rejected: a dedicated `accept` socket frame that the object expands into
mutations.** Same undo problem from the other side: the client would learn the
mutations only from the echo, after the fact, so it has nothing to invert locally,
and its optimistic view would lag its own click.

### 5. Suggesting is two new MCP tools over one new v1 route, not a mode flag on the write tools

`POST /api/v1/documents/:id/suggestions` takes either a nested `content` payload
(with `mode`, as `PUT /content` does) or `fields` / `bloks` / `locale` (as
`PATCH /fields` does), plus an optional `summary`. Two tool rows point at it:
`suggest_content` and `suggest_fields`, with exactly the argument schemas of
`write_content` and `patch_fields` plus `summary`. Two more rows cover the rest:
`list_suggestions` (`GET /documents/:id/suggestions`) and `withdraw_suggestion`
(`DELETE /documents/:id/suggestions/:sid`).

The route builds its mutations with **the same code** the write routes use. Phase 3
extracts `contentMutations` from `putContent` and `fieldMutations` from the
`PATCH /fields` handler into `routes/api/documents.ts` helpers that return
`Mutation[]`, and the four routes differ only in where those mutations go
(`commitAll` or `stub.suggest`). There is still one validator per payload shape,
which is MCP decision 2's whole point.

**Rejected: `suggest: true` on `write_content` and `patch_fields`.** Two failures.
`tools/list` filters on a row's `need` (`toolsFor`, `tools.ts:554-556`), so a
suggest-only token either sees `write_content` (and is refused whenever the model
forgets the flag) or does not see it at all (and cannot suggest). And forgetting the
flag on a token that *can* write is a direct write of the exact change the person
wanted to review. MCP decision 11 rejected a nonce argument for the same reason: the
failure mode of a forgotten argument must not be the thing the argument guards.

**Rejected: one `suggest` tool taking either shape.** A schema with two mutually
exclusive halves is the kind of argument a model gets wrong, and the write side
already settled on one tool per shape.

### 6. Permissions: a new `content:suggest` scope; people suggest only through the API; only people accept

| Actor | Suggest | Write directly | Accept / decline | Withdraw |
| --- | --- | --- | --- | --- |
| Token with `content:suggest` | yes | no | no | its own |
| Token with `content:write` (implies `content:suggest`) | yes | yes | no | its own |
| Person, `viewer` | no | no | no | no |
| Person, `editor` and above | yes (API only) | yes | yes | their own |
| Preview grant | no | no | no | no |

- `SCOPES` gains `content:suggest`, between `content:read:draft` and `content:write`
  (the ramp order `access-model.ts` relies on). `IMPLIES["content:suggest"]` is
  `content:read`, `content:read:draft`, `content:suggest`: a suggestion is computed
  against the draft, so a token that can suggest must be able to read it.
  `IMPLIES["content:write"]` gains `content:suggest`; `admin` already implies every
  scope.
- `SUGGEST: Access = { role: "editor", scope: "content:suggest", tier: "scope" }`.
  The role matters only to a person calling the v1 route with a session cookie, and
  `editor` grants a person nothing they did not have, since an editor may write.
- Accepting and declining happen only on the socket, so they are gated by the
  socket's role check: any role but `viewer`. Accepting is writing, so it needs
  exactly what writing needs. A token cannot open a socket (`editor.ts:86-88`), so a
  token can never accept, whatever it holds.
- Withdraw is `SUGGEST` plus "the caller's `actorString` is the suggestion's
  author". Anyone else is `forbidden`; an editor who wants it gone declines it.
- `CREATE` is unchanged. A suggest-only token cannot create a document, because
  `POST /documents` writes its content in the same request (`documents.ts:466-515`),
  so a create under `content:suggest` would be a direct write by another name.

The token to give an AI assistant, in the docs, the token dialog and the demo,
is `content:suggest` alone. **Rejected: recommend `content:write` and add suggest as an
opt-in.** The default then lets an assistant's mistake reach the draft unreviewed,
which is the problem this spec exists to remove; a site owner who wants direct writes
chooses the `import` preset knowingly.

**Rejected: reuse `content:write` for suggesting.** Then a token that can only
propose cannot exist, and that token is the feature.

**Rejected: let a token accept over HTTP.** A token that can suggest and accept is a
write token with an extra round trip, and an HTTP accept is decision 4's rejected
alternative.

### 7. Suggesting needs a write's reach across scopes, and the brand's schema validates it on the way in

- **Multi-site.** The route loads the story with `load(c, id, "write")`, exactly as
  `PUT /content` does. A document outside the request's writable scopes is a 404,
  and a site-bound token's `content:suggest` is not among the `READ_SCOPES` it keeps
  further down the chain (`tokenScopesOn`, `roles.ts:167-177`), so a token bound to
  `alpha` can read a shared page and cannot suggest on it. A suggestion is a write
  into editors' screens, and it gets a write's fence.
- **Grants.** `allows` refuses a `GrantActor` everything but reads
  (`roles.ts:418-422`), so `SUGGEST` is refused by construction. Pinned by a test so
  a later widening of `allows` cannot let a preview credential propose content.
- **Layers.** `suggest_content` passes `layerOption` exactly as `putContent` does,
  so a suggestion on a bare layer carries `unset` for an inherited key rather than a
  `null`.
- **Multi-brand.** The route validates against `brandOf(c).schema`, which is the
  story's brand, exactly as the write routes do. The object stays schema-blind, and
  it can: a suggestion's mutations are already valid for that brand's schema when
  they are stored.
- **Schema migrations supersede.** A content migration changes what field names
  mean, and a stored suggestion was validated against the old meaning. `commit`
  gains an option `supersede: true`, `migrate.ts` passes it, and the object closes
  every open suggestion on that story as `superseded` in the same `transactionSync`.
  The agent sees `superseded` in `list_suggestions` and can propose again against
  the migrated document.

### 8. After an accept, Cmd+Z undoes the accepted content in one step and does not reopen the suggestion

An accept is pushed onto the reviewer's undo stack like any transaction (decision 4),
never coalesced with a neighbouring keystroke. Undo sends the inverse as a plain
`tx` with no `accepts`. The suggestion stays `accepted`; the trail shows the accept
and then the reviewer's revert. Redo re-applies the mutations, again as a plain tx.

**Rejected: undo reopens the suggestion.** The undo stack is client-local and stores
absolute values (`sync-design.md`, "Deliberately unchanged"). For the object to
reopen a suggestion it would have to recognise one transaction as the inverse of
another, and a reopened suggestion's inverse would describe a document from before
the accept, so every unit would read conflicted at once. An editor who wants the
agent's proposal back has it in the activity trail and in `list_suggestions`.

The agent's own *direct* writes keep today's semantics, now stated truthfully: they
are not on any editor's undo stack, and phase 5 corrects `docs/mcp.md` and the
`commit` comment to say so.

### 9. Publishing is never blocked by a pending suggestion; the admin says so beside the button and the API says so in the answer

A suggestion is not in the draft, so publishing cannot ship it. There is no
correctness reason to block, and a reason not to: blocking would let any holder of
`content:suggest` stall a release by proposing something. The publish control in
the editor shows a line under it while the document has open suggestions ("2
suggestions waiting for review"), with no confirmation step. `POST
/documents/:id/publish` adds `pendingSuggestions: number` to its answer, so an agent
that publishes learns what it left open. Scheduled publishing is unaffected.
Suggestions survive a publish and an unpublish untouched.

**Rejected: a confirmation dialog when suggestions are pending.** A dialog on every
publish of a page with a stale proposal trains people to click through it, and
then it warns nobody.

**Rejected: discard pending suggestions on publish.** A publish says nothing about
whether a proposal was wanted.

### 10. One counter column in D1, written by the object on every change in the open count

`0018_suggestions.sql` adds `stories.suggestions_pending integer not null default
0`: the number of open suggestions on the story. The object writes it after every
create, decision, withdrawal and supersede, as a statement of its own, awaited, a
failure logged and not retried (the `mirrorDraftData` pattern, `story-do.ts:455-467`).
Suggestions change at human speed, so there is no debounce and no alarm. `COLS`
selects it as `suggestionsPending`; `StoryMeta` and `ApiDocumentMeta` carry it; the
Content tree draws a marker on a row where it is non-zero.

**Rejected: no D1 mirror.** The tree would have to wake every story's object to show
which pages have something waiting, which is exactly what the watermark mirror
exists to avoid.

**Rejected: a D1 `suggestions` table as the mirror.** Decision 1's two-store problem,
in a smaller form: a count can be wrong for a moment and costs a marker; a row set
that disagrees with the object offers a suggestion that cannot be accepted.

### 11. An agent is in the room as a time-limited presence row in the story object, expired by the client and never by the alarm

A token that touches a document leaves a row in a new `agent_presence` table in the
story's object: `{ actor, name, colour, selection_uid, selection_field, seen_at }`,
keyed by `actor`. `peers()` returns every joined socket as today plus every row seen
within `AGENT_PRESENCE_TTL_MS = 90_000`, and deletes older rows as it reads. A
`Presence` built from a row carries `kind: "token"` and `ttlMs`, the time it has
left; the admin store drops a token peer when that time passes unless a newer frame
for it arrived. A socket peer carries `kind: "person"` and `ttlMs: null`.

What touches it:

- Every write and every suggestion by a `TokenActor` passes the peer into the same
  RPC (`commit`'s new `presence` option, `suggest`'s argument), and the object
  upserts it and **broadcasts the `presence` frame before the `delta` or
  `suggestion` frame**. That ordering is what lets the overwrite notice say
  "claude changed this field" (`store.ts:555` looks the actor up among peers when
  the delta arrives).
- A draft read by a token (`GET /documents/:id?status=draft`, `preview_document`,
  `list_suggestions`) calls a new `touch(peer)` RPC under `waitUntil`, off the
  response's critical path. A published read never wakes the object, and does not
  touch presence.
- `selection` is the first unit's anchor for a suggestion, the uid of the first
  mutation for a write, `preview_document`'s `blok` when given, and null otherwise.
  It is what puts the dot on the row in `BlockRail`.
- `touch` broadcasts only when the row is new, its selection changed, or the last
  broadcast for it is more than 30 seconds old, so an agent polling a draft does
  not flood the room.

Every token gets presence, not only an MCP session: the v1 route cannot tell the
two apart without trusting a header, and a deploy script that is writing to the
page right now is exactly as worth seeing as an assistant. The label is the token's
name, which is what the activity trail already shows. A person calling the API
with a session cookie gets no agent row; if they have the editor open they are
already present.

**Rejected: an alarm to expire agent presence.** The object's one alarm belongs to
the watermark, and `scheduler.ts:5-20` is the record of what goes wrong when a
second purpose shares it: either the watermark waits behind a presence expiry or a
presence expiry is pushed back by every keystroke.

**Rejected: a WebSocket per MCP session.** The MCP endpoint is stateless HTTP
(MCP decision 9). Nothing on the Worker side survives between two tool calls to
hold a socket open.

**Rejected: agent avatars on the space channel.** The space object holds no storage
by design and must never grow any (`sync-design.md`). An agent has no socket, so a
space presence for it would have to be stored somewhere, and the story object is the
only place that already stores something about that document. Agents appear in the
editor of the document they touch, not in the site-wide avatar strip.

### 12. `PROTOCOL_VERSION` goes to 6; nothing about a logged mutation changes

The bump carries: `Presence.kind` and `Presence.ttlMs`; `bootstrap.suggestions` and
`catchup.suggestions` (open suggestions only); a `suggestion` server frame carrying
one whole `Suggestion`, sent on every state change; `tx.accepts`; and the `decline`
client frame. A v5 client handed a `suggestion` frame would fail its guard and drop
it, and would never show the review; a v5 client sending a `tx` cannot accept
anything, which is safe but invisible. Both are the stale-tab case the handshake
exists to refuse.

No `Mutation` variant changes, so every entry in every log replays unchanged. The
log gains three nullable columns for attribution (`suggestion_id`, `suggested_by`,
`suggested_by_name`), added in place by the object's constructor. The attribution
is copied onto the log row rather than joined from `suggestion`, because decided
suggestions are pruned (decision 13) and the trail is not.

### 13. Bounds: twenty open suggestions per document, a megabyte in all, the fifty most recent closed ones kept

- At most `MAX_OPEN_SUGGESTIONS = 20` open suggestions per story. The twenty-first
  is a `conflict` naming the number and saying to withdraw one or wait for review.
- At most `MAX_OPEN_SUGGESTION_BYTES = 1 MiB` of stored mutations and inverses across
  the open ones, because every one of them rides in each `bootstrap`. Over it, the
  new one is `too_large`.
- Closed suggestions are kept for `list_suggestions` and the admin's "recently
  decided" list, newest fifty per story. Older ones are deleted when a suggestion is
  created or closed.
- `summary` is at most 280 characters after the same control and bidi screening
  `validate.ts` applies to every CMS string, and it is rendered as plain text.
- An identical open suggestion from the same author (same mutations, deep-equal)
  is answered with the existing one and `replayed: true`, so an agent that retries a
  call does not file the same proposal twice. This is MCP decision 11's argument
  carried over: idempotence by value, not by a key the model must remember.
- A suggestion that produces no mutations (the payload matches the draft) creates
  nothing and answers `{ suggestion: null }`.

## Wire & schema changes

### D1 migration `0018_suggestions.sql`

```sql
-- Spec 39 (docs/specs/editing/agent-suggestions.md), decision 10.
--
-- How many open suggestions this story's Durable Object holds. A mirror, written by
-- the object after every change in that number, so the content tree can mark a
-- page with something waiting without waking its object. The object is the truth;
-- a stale count costs a marker, never a suggestion.
alter table stories add column suggestions_pending integer not null default 0;
```

Additive. It must be applied before the Worker that selects it is deployed, as for
`0014`–`0017`. A Worker from before it ignores the column, so rolling the Worker back
leaves the migration in place harmlessly.

### Durable Object storage (created by `StoryDO`'s constructor)

```sql
create table if not exists suggestion (
  id           text primary key,          -- sug_<20 hex>
  author       text not null,             -- actorString, e.g. token:claude
  author_name  text,
  author_kind  text not null,             -- 'token' | 'user' | 'anonymous'
  summary      text,
  base_sync_id integer not null,          -- the log position it was computed against
  mutations    text not null,             -- JSON Mutation[]
  units        text not null,             -- JSON SuggestionUnit[]
  bytes        integer not null,          -- utf8 size of mutations + every inverse
  state        text not null,             -- 'open' | 'closed'
  closed_by    text,                      -- 'review' | 'withdrawn' | 'superseded'
  created_at   integer not null,
  closed_at    integer
);
create index if not exists suggestion_state on suggestion (state, created_at desc);

create table if not exists agent_presence (
  actor           text primary key,
  name            text not null,
  colour          text not null,
  selection_uid   text,
  selection_field text,
  seen_at         integer not null,
  announced_at    integer not null
);
```

`log` gains `suggestion_id text`, `suggested_by text`, `suggested_by_name text`, each
by a guarded `alter table` in the constructor (the `actor_name` pattern,
`story-do.ts:277-281`). `purge()` deletes from `suggestion` and `agent_presence` as
well as `log` and `doc`.

### Core types (`src/core/suggestions.ts`, new; re-exported from `folio/core`'s internal barrel only, not from a public subpath)

```ts
export type UnitState = "pending" | "accepted" | "declined" | "void";

export interface SuggestionUnit {
  /** `blk:<uid>` for edits to an existing blok, `ins:<uid>` for an inserted subtree. */
  key: string;
  /** The blok the unit is about: the existing one, or the topmost inserted one. */
  anchor: string;
  /** Indices into `Suggestion.mutations`, ascending. */
  indices: number[];
  /** `invertAll` over this unit's mutations, against the document at creation. */
  inverse: Mutation[];
  state: UnitState;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: number | null;
}

export interface Suggestion {
  id: string;
  author: string;
  authorName: string | null;
  authorKind: "token" | "user" | "anonymous";
  summary: string | null;
  baseSyncId: number;
  createdAt: number;
  mutations: Mutation[];
  units: SuggestionUnit[];
  state: "open" | "closed";
  closedBy: "review" | "withdrawn" | "superseded" | null;
  closedAt: number | null;
}

/** Where the document no longer matches what a unit would overwrite. */
export interface UnitDrift {
  uid: string;
  field: string | null;
  locale: string | null;
  kind: "value" | "missing" | "exists" | "moved" | "retyped" | "changed";
}

export function suggestionUnits(doc: Doc, mutations: readonly Mutation[]): SuggestionUnit[];
export function unitDrift(current: Doc, suggestion: Suggestion, unit: SuggestionUnit): UnitDrift[];
export function acceptMutations(suggestion: Suggestion, keys: readonly string[]): Mutation[];
```

A unit is `void` when its suggestion closed by withdrawal or supersede while it was
still `pending`. A suggestion closes with `closedBy: "review"` when no unit is
`pending`.

### Protocol (`src/core/protocol.ts`), v6

```ts
export interface Presence {
  actor: string;
  name: string;
  colour: string;
  selection: PresenceSelection | null;
  locale: string | null;
  /** `token` for a presence row an API caller left (decision 11). */
  kind: "person" | "token";
  /** Milliseconds this peer has left, for a `token`; null for a socket. */
  ttlMs: number | null;
}

export type ClientMsg =
  | { type: "hello"; lastSyncId: number; identity?: HelloIdentity }
  | { type: "tx"; txId: string; mutations: Mutation[]; accepts?: { id: string; units: string[] } }
  | { type: "presence"; selection: PresenceSelection | null; locale?: string | null }
  /** `units: null` declines every pending unit. */
  | { type: "decline"; id: string; units: string[] | null };

export type ServerMsg =
  | { type: "bootstrap"; doc: Doc; syncId: number; peers: Presence[]; suggestions: Suggestion[] }
  | { type: "catchup"; deltas: Delta[]; syncId: number; peers: Presence[]; suggestions: Suggestion[] }
  | ({ type: "delta"; replay?: true } & Delta)
  | { type: "presence"; peer: Presence; gone?: boolean }
  /** One suggestion, whole, after any change to it. An upsert by `id`; a client
   * drops it from its open set when `state` is `closed`. */
  | { type: "suggestion"; suggestion: Suggestion }
  | { type: "reject"; txId: string; reason: string }
  | { type: "error"; reason: string };

export interface ActivityEntry {
  syncId: number;
  actor: string;
  actorName: string | null;
  at: number;
  mutations: Mutation[];
  /** Set on the transaction that accepted part of a suggestion. */
  suggestion: { id: string; author: string; authorName: string | null } | null;
}
```

`isClientMsg` and `parseClientFrame` gain the `decline` case and the optional
`accepts` on `tx`, each bounded: `id` and every unit key capped at
`MAX_SELECTION_LEN`, `units` at `MAX_TX_MUTATIONS` entries. The version table in the
comment above `PROTOCOL_VERSION` gains row 6.

### `StoryDOInstance` (and `StoryStub`) additions

```ts
suggest(
  mutations: Mutation[],
  author: { id: string; name: string | null; kind: "token" | "user" | "anonymous" },
  summary: string | null,
  presence: AgentPeer | null,
): Promise<{ suggestion: Suggestion; replayed?: true } | { rejected: string; code: "conflict" | "too_large" | "not_found" }>;
suggestions(state: "open" | "closed" | "all", limit: number): Promise<Array<Suggestion & { drift: Record<string, UnitDrift[]> }>>;
withdraw(id: string, actor: string): Promise<{ suggestion: Suggestion } | { rejected: string; code: "not_found" | "forbidden" | "conflict" }>;
touch(peer: AgentPeer): Promise<void>;
commit(
  mutations: Mutation[],
  actor: { id: string; name: string },
  txId?: string,
  opts?: { presence?: AgentPeer; supersede?: true },
): Promise<CommitResult>;
```

`AgentPeer` is `{ actor: string; name: string; colour: string; selection: PresenceSelection | null }`,
built by one helper, `agentPeerOf(actor, selection)` in `src/server/write.ts`, which
answers null for anything but a `TokenActor`.

### New or changed routes

All under `{base}/api/v1`, all `load(c, id, ...)`-fenced like their neighbours.

| Method, path | Access | Body / query | Answer | Errors |
| --- | --- | --- | --- | --- |
| `POST /documents/:id/suggestions` | `SUGGEST` | `{ summary?, content, mode? }` or `{ summary?, fields?, bloks?, locale? }`; exactly one shape | `{ suggestion: SuggestionSummary \| null, replayed?: true }` | `bad_request` (both shapes, neither, or the write routes' own field errors), `not_found`, `conflict` (20 open), `too_large` (mutations, bytes, or the 1 MiB budget) |
| `GET /documents/:id/suggestions` | `READ_DRAFT` | `?state=open\|closed\|all` (default `open`), `?limit` (1-50, default 20) | `{ suggestions: SuggestionDetail[] }` | `not_found` |
| `DELETE /documents/:id/suggestions/:sid` | `SUGGEST` | none | `{ suggestion: SuggestionSummary }` | `not_found`, `forbidden` (not the author), `conflict` (already closed) |
| `POST /documents/:id/publish` (changed) | unchanged | unchanged | adds `pendingSuggestions: number` | unchanged |
| `GET /documents/:id`, search results (changed) | unchanged | unchanged | `ApiDocumentMeta` adds `pendingSuggestions: number` | unchanged |

`SuggestionSummary` is `{ id, state, closedBy, units: [{ key, anchor, state }], createdAt }`.
`SuggestionDetail` adds `summary`, `author`, `authorName`, and per unit the
`mutations`, the `inverse` (labelled `before` in the JSON) and `drift`. The nested
`content` shape is not used for the answer: a unit is a set of mutations, and
`get_document` already answers the current document in nested shape for an agent
that wants to compare.

One internal admin route, beside the activity route in `routes/history.ts`:
`GET {base}/api/story/:id/suggestions?state=closed`, `READ_DRAFT`,
`fenceStory(rt, "read")`, the same object call. The admin does not read the v1
contract (`write.ts`'s `restoreVersion` comment).

### MCP tool rows (`src/server/mcp/tools.ts`)

| Name | Route | `need` |
| --- | --- | --- |
| `suggest_content` | `POST /documents/:id/suggestions`, body `content`, `mode`, `summary` | `SUGGEST` |
| `suggest_fields` | `POST /documents/:id/suggestions`, body `fields`, `bloks`, `locale`, `summary` | `SUGGEST` |
| `list_suggestions` | `GET /documents/:id/suggestions`, query `state`, `limit` | `READ_DRAFT` |
| `withdraw_suggestion` | `DELETE /documents/:id/suggestions/:sid` | `SUGGEST` |

`suggest_content` and `suggest_fields` reuse `CONTENT` and `patch_fields`' argument
schemas verbatim (the same constants, not copies). The descriptions say that an
editor reviews the change before it reaches the draft, that `list_suggestions`
reports what was accepted or declined, and that a large rewrite should be split into
one suggestion per section. `write_content` and `patch_fields` gain one sentence: a
token that cannot write should use the `suggest_` tools. The header comment's row
count is updated. `INSTRUCTIONS` gains one sentence: when the `suggest_` tools are
listed and the write tools are not, every change is a proposal a person reviews.

### Host configuration

None. No new binding, no `createFolio` key, no `wrangler.jsonc` change: the new
tables live in the existing SQLite-backed `StoryDO` (`new_sqlite_classes`, tag `v1`).

## Acceptance criteria

### A suggestion reaches an open editor and leaves the draft alone

```
GIVEN an editor has a page open
AND a token "claude" holding only content:suggest
WHEN the token calls suggest_fields on the page with a new hero title
THEN the editor receives a presence frame for "claude" (kind token) with the hero blok selected
AND then a suggestion frame with one pending unit blk:<hero uid>
AND get_document status=draft still returns the old title
AND stories.suggestions_pending is 1
AND stories.draft_sync_id is unchanged
```

### Accepting is one transaction, one undo step, attributed twice

```
GIVEN an open suggestion with units blk:A and blk:B
WHEN the editor accepts blk:A
THEN one tx is logged with the editor as actor and suggested_by token:claude
AND the suggestion frame shows blk:A accepted and blk:B pending
AND the activity trail entry reads as the editor accepting claude's suggestion
WHEN the editor presses Cmd+Z
THEN block A's fields return to their previous values in one step
AND the suggestion still shows blk:A accepted
```

### Accept all, decline all

```
GIVEN an open suggestion with three pending units
WHEN the editor accepts all
THEN exactly one tx is logged containing every unit's mutations in suggestion order
AND the suggestion is closed with closedBy review
AND suggestions_pending drops by one
GIVEN another open suggestion
WHEN the editor declines all
THEN nothing is logged
AND the suggestion is closed with every unit declined
```

### A conflicted unit is shown and still acceptable

```
GIVEN an open suggestion setting block A's title to "New"
WHEN a colleague types "Other" into block A's title
THEN the reviewer's editor shows unit blk:A as conflicted with "Other" as the current value
AND list_suggestions reports drift kind value on (A, title)
WHEN the reviewer accepts blk:A
THEN block A's title is "New"
AND the colleague, if focused on that field, sees "<reviewer> changed this field"
WHEN instead the colleague types the title back to its original value
THEN unit blk:A is no longer conflicted
```

### The object refuses a forged or late accept

```
GIVEN an open suggestion
WHEN a socket sends tx with accepts naming it and mutations that differ from acceptMutations
THEN the tx is rejected with "the accepted changes do not match the suggestion"
AND nothing is logged
WHEN a socket sends an accept for units another reviewer already declined
THEN the tx is rejected with "that suggestion is no longer pending"
AND the sender's pending tx and its undo entry are dropped
WHEN a socket resends an accept tx whose txId is already logged
THEN it receives the replay ack, not a rejection
```

### Viewers, grants and bound tokens

```
GIVEN a viewer's socket
WHEN it sends an accept tx or a decline frame
THEN it is refused read-only and nothing changes
GIVEN a preview grant
WHEN it calls POST /documents/:id/suggestions
THEN 403
GIVEN a token bound to site alpha with content:suggest
WHEN it suggests on a shared document readable from alpha
THEN 404, the same answer a write gets
GIVEN a token with only content:suggest
THEN tools/list includes suggest_content, suggest_fields, list_suggestions, withdraw_suggestion, get_document
AND excludes write_content, patch_fields, create_document
```

### Agent presence comes and goes without the alarm

```
GIVEN an editor has a page open
WHEN a token patches a field on it
THEN the presence frame for the token arrives before the delta
AND the editor's peer list shows the token's name with a token badge
AND BlockRail shows the token's dot on the patched block
WHEN 90 seconds pass with no further call from the token
THEN the editor's store has dropped the token peer
AND a fresh bootstrap does not list it
AND ctx.storage.getAlarm() was never set by presence
```

### Publish is not blocked

```
GIVEN a page with two open suggestions
WHEN a publisher publishes it
THEN the publish succeeds and the response carries pendingSuggestions 2
AND both suggestions remain open
AND the editor's publish control showed "2 suggestions waiting for review" beforehand
```

### Bounds and idempotence

```
GIVEN a token suggests the same payload twice
THEN the second answer carries the first suggestion's id and replayed true
GIVEN 20 open suggestions on a page
WHEN a 21st is made
THEN conflict, naming the limit
GIVEN a payload whose diff exceeds 200 mutations
THEN too_large, telling the agent to split it
GIVEN a payload equal to the draft
THEN { suggestion: null } and nothing is stored
```

### Lifecycle

```
GIVEN a page with open suggestions
WHEN the page is deleted
THEN its object's suggestion and agent_presence tables are empty
WHEN a content migration commits to a page with open suggestions
THEN every open suggestion is closed as superseded in the same object request
WHEN the author withdraws its own open suggestion
THEN it is closed as withdrawn, pending units void, and editors receive the frame
WHEN a different token tries to withdraw it
THEN 403
```

## Implementation plan

Five phases. Each leaves the tree green. Phase 1 must land first; phase 2 depends on
it; phases 3 and 4 both depend on phase 2 and touch disjoint files, so they can run
in parallel; phase 5 follows both. One release, v1.5.0, carries all five: the wire
and the admin ship in the same deploy, so no phase is deployed alone.

### Phase 1: core types, units, drift, the v6 wire

1. New `src/core/suggestions.ts`: the types above, `suggestionUnits`, `unitDrift`,
   `acceptMutations`, and the constants `MAX_SUGGESTION_BYTES`,
   `MAX_OPEN_SUGGESTIONS`, `MAX_OPEN_SUGGESTION_BYTES`, `MAX_CLOSED_KEPT = 50`,
   `MAX_SUMMARY_LEN = 280`, `AGENT_PRESENCE_TTL_MS = 90_000`. Pure, no I/O.
2. `src/core/protocol.ts`: `PROTOCOL_VERSION = 6` and its table row; `Presence.kind`
   and `ttlMs`; the `tx.accepts` field and `decline` frame in `ClientMsg`, both
   guards and `parseClientFrame`; `suggestions` on `bootstrap` and `catchup`; the
   `suggestion` server frame; `ActivityEntry.suggestion`.
3. `src/server/story-do.ts`: the minimum to compile against the new types:
   `presenceOf` sets `kind: "person"`, `ttlMs: null`; `bootstrap` and `catchup` send
   `suggestions: []`; `recent()` answers `suggestion: null`. `src/admin/store.ts`:
   accepts the new fields and ignores them.
4. Unit tests: `test/unit/core/suggestions.test.ts` (new) and
   `test/unit/core/protocol.test.ts` (extended). See Testing requirements.

Gate: `pnpm typecheck`, `./node_modules/.bin/biome ci .`, `pnpm test`, and
`./scripts/e2e.sh scripts/sync-test.mjs` (the scripts stamp `PROTOCOL_VERSION` from
source, so a bump that broke a frame shows here).

### Phase 2: the object

1. Constructor: the `suggestion` and `agent_presence` tables and the three `log`
   columns, guarded as `actor_name` is.
2. Refactor `applyTransaction` so the log insert, the doc update and an optional
   `alongside(syncId)` callback run in one `ctx.storage.transactionSync`, and only
   then the alarm is awaited. The log insert writes the three attribution columns
   when given.
3. `suggest(...)`: reject when there is no document (as `commit` does); `txCapError`;
   `mutationError` over the chain and `docCapError` on the result, exactly as
   `applyTransaction` validates, without writing the log; byte caps; the identical-
   open-suggestion replay; the open count and budget; `suggestionUnits` and the
   inverses against the current document; insert; prune closed beyond fifty; upsert
   and broadcast presence when given; broadcast the `suggestion` frame; mirror the
   count.
4. The `tx` case: when `accepts` is present, the order in decision 4. The
   `alongside` callback sets the units `accepted` with the socket's actor and name,
   closes the suggestion when nothing is pending, and writes the log attribution.
   After the delta, broadcast the `suggestion` frame and mirror the count.
5. The `decline` case: role gate (viewer refused with the same `reject` wording,
   addressed by an `error` frame since there is no txId), units pending, mark
   declined, close if nothing pending, broadcast, mirror.
6. `withdraw(id, actor)`, `suggestions(state, limit)` (with `unitDrift` computed
   against the current document), and `touch(peer)` with the 30-second broadcast
   throttle.
7. `commit` gains `opts.presence` (upsert and broadcast presence before the delta)
   and `opts.supersede` (close every open suggestion as `superseded` inside the
   `alongside` callback, then broadcast each and mirror).
8. `peers()` appends live `agent_presence` rows through a new explicit
   `agentPresenceOf(row, now)` (never a spread), and deletes expired rows.
   `bootstrap` and `catchup` send the open suggestions.
9. `purge()` deletes from `suggestion` and `agent_presence`.
10. `recent()` selects the three log columns and fills `ActivityEntry.suggestion`.
11. `StoryDOInstance` and `StoryStub` gain `suggest`, `suggestions`, `withdraw`,
    `touch`, and the new `commit` signature.
12. `migrations/0018_suggestions.sql`; the mirror statement is
    `update stories set suggestions_pending = ? where id = ?`.
13. `src/server/migrate.ts:335`: pass `{ supersede: true }` to `commit`.

Gate: phase 1's gates plus `test/workers/story-do.test.ts` and
`test/workers/migrations.test.ts` extended (Testing requirements).

### Phase 3: auth, routes, MCP (parallel with phase 4)

1. `src/server/auth/roles.ts`: `content:suggest` in `SCOPES` between
   `content:read:draft` and `content:write`; its `IMPLIES` row; `content:write`
   implies it; `SUGGEST` access.
2. `src/admin/ui/screens/access-model.ts`: `SCOPE_MEANING["content:suggest"]`
   ("Suggest changes", "Propose edits to drafts for an editor to accept. Changes
   nothing on its own."). The token presets are set in step 7.
3. `src/server/write.ts`: `agentPeerOf(actor, selection)`; `commitAll` takes
   `opts?: { presence?: AgentPeer }` and passes it on the first chunk only.
4. `src/server/routes/api/documents.ts`: extract `contentMutations` and
   `fieldMutations`; rewrite `putContent` and the `PATCH /fields` handler over them
   with no behaviour change; thread `agentPeerOf(c.var.actor, …)` into both writes
   and into `restore`; add the three suggestion routes; `pendingSuggestions` on the
   publish answer and on `toApiDocumentMeta`; `touch` under `waitUntil` on a token's
   draft read.
5. `src/server/validate.ts`: `SuggestBody` (the two shapes, mutually exclusive,
   `summary` screened and capped) and `SuggestionStateParam`.
6. `src/server/stories.ts`: `suggestions_pending as suggestionsPending` in `COLS`;
   `src/core/story.ts`: `StoryMeta.suggestionsPending?: number`.
7. `src/server/routes/history.ts`: the internal `GET {base}/api/story/:id/suggestions`.
8. `src/server/mcp/tools.ts`: the four rows; description sentences on
   `write_content` and `patch_fields`; the header comment's count.
   `src/server/routes/mcp.ts`: the `INSTRUCTIONS` sentence; `preview_document`
   touches presence with its `blok`.

Gate: `pnpm test` with `api.test.ts`, `scope-partition.test.ts`, `mcp.test.ts`,
`test/unit/mcp/tools.test.ts` and `test/unit/mcp/scopes.test.ts` extended.

### Phase 4: the admin (parallel with phase 3)

1. `src/admin/store.ts`: `StoreState.suggestions: Suggestion[]`, set by `bootstrap`
   and `catchup`, upserted by `suggestion` frames, closed ones removed.
   `PendingTx` gains `accepts?`, and the reconnect resend (`:314`) sends it.
   `accept(id, units)` builds `acceptMutations`, pushes `invertAll` onto the undo
   stack without coalescing (and clears `lastEdit`), and dispatches with `accepts`.
   `decline(id, units)` sends the frame. A token peer is dropped by a per-actor
   timer set from `ttlMs` on receipt and reset by each newer frame for it.
2. `src/admin/ui/screens/suggestions-model.ts` (new, pure): per unit, a label (the
   anchor's block type and title field), the fields it changes with before, after
   and current value, and its drift via `unitDrift`. All presentation logic lives
   here, not in a component (the lesson `folio-admin-scroll-regions` records).
3. `SuggestionsPanel.tsx` (new), mounted in `EditorShell` beside `HistoryPanel`:
   open suggestions with author (through `actorForm`), summary as plain text, units
   with Accept and Decline, Accept all and Decline all, a conflicted marker showing
   the current value; below, recently decided suggestions from the internal route.
4. `BlockRail.tsx`: a marker on a row whose uid anchors a pending unit; token peers'
   dots carry a token glyph. `Inspector.tsx`: for the selected blok, the pending
   unit's suggested value under each field it changes, with the unit's Accept and
   Decline.
5. Preview: a "Show suggestion" toggle in the panel re-seeds the preview with the
   current view plus the chosen units' mutations through the bridge's existing
   reset path, and restores the plain view when turned off or when the suggestion
   closes. It never touches `base` or `pending`.
6. The publish control: the "N suggestions waiting for review" line.
   `HistoryPanel` / `history-model.ts`: an entry with `suggestion` reads as the actor
   accepting the author's suggestion. Content tree: a marker for
   `suggestionsPending > 0`.
7. Any new portal re-declares `scoped()` (`CLAUDE.md`, the `tokens.css` invariant).
   No new dialog; if one becomes necessary it uses `useFocusTrap`.

Gate: `pnpm typecheck`, `pnpm test` with the admin unit tests, `pnpm build:demo`.

### Phase 5: end to end, docs, release notes

1. `scripts/suggestions-test.mjs` (new; follow the e2e conventions in `CLAUDE.md`:
   stamp `v` on every frame, `signInGlobally()`, `import './lib/ts-resolve.mjs'`).
   `scripts/e2e-all.sh` picks it up; `CLAUDE.md`'s "all 25" becomes 26.
2. `docs/mcp.md`: section 1 offers the suggest-only token; section 5 is rewritten:
   direct writes are live and attributed and **not** on anyone's undo stack;
   suggestions are reviewed, and an accepted one is one undo step for the reviewer;
   the agent is visible in the editor while it works.
3. `src/server/story-do.ts`'s `commit` comment: drop "under Cmd+Z".
4. `docs/sync-design.md`: a section "Suggestions are beside the log, not in it",
   stating decision 1 and the accept-is-a-tx rule. `docs/handbook.md`: a section on
   suggestions and agent presence. `AGENTS.md`: the suggest tools and when to use
   them. `docs/configuration.md` is unchanged (no config key).
5. `UPGRADING.md`: `### Agent suggestions (v1.5.0)`: apply `0018` before deploying
   the Worker; `PROTOCOL_VERSION` 6 makes open tabs reload; the new scope; rollback
   (Edge cases).
6. `CLAUDE.md`: `PROTOCOL_VERSION` "at 5" becomes 6 in both places; the ledger gains
   `0018_suggestions.sql` and "Next free is `0019`"; a line under the invariants for
   decision 4's accept check order and for "agent presence never uses the alarm".
7. Token presets: `TOKEN_PRESETS` in `access-model.ts` gains an "AI assistant" preset
   whose scopes are `["content:suggest"]` and nothing else, labelled "Suggest changes"
   (description: "An AI assistant that proposes edits for an editor to accept."). The
   token dialog offers it first, the demo seed mints its example assistant token with
   it, and `AGENTS.md` and `docs/handbook.md` name it as the token to give an
   assistant. The `import` and `publish` presets are unchanged.

Gate: `./scripts/e2e-all.sh`, then `node scripts/release.mjs --smoke-only`.

## Edge cases

- **The story's object is cold when a suggestion arrives** → the route reads the
  draft first through `draftOf` (which seeds through `initDraft`), exactly as the
  write routes do, so `suggest` finds a document. `suggest` still refuses "no
  document" rather than seeding, as `commit` does.
- **The page is deleted with suggestions open** → `purge()` empties both new tables
  and the D1 row is gone with the story. A reused id never sees them.
- **The token that made a suggestion is revoked** → the suggestion stays open and
  reviewable; it is content waiting for a person, and the author's name is stored on
  it. The revoked token cannot withdraw it; an editor declines it.
- **Two reviewers act on one suggestion at once** → the object serialises them. The
  second accept or decline finds the units no longer pending and is rejected; the
  second reviewer's optimistic view is rolled back by the existing reject handling
  and the `suggestion` frame shows what happened.
- **An accept is queued offline** → it is in `pending` with its `accepts` and is
  resent on reconnect. If the suggestion was decided meanwhile it is rejected and
  dropped with its undo entry; if it already landed (same txId) the replay ack
  removes it.
- **Overlapping suggestions** → each is independent. Accepting one makes the other's
  overlapping units conflicted by decision 3's rule, with no special case.
- **A suggestion on a translated field** → its mutations carry `locale`, its inverse
  does too, and drift is per locale key. A French edit does not conflict an English
  suggestion.
- **A version restore while suggestions are open** → a restore is a commit; the
  suggestions it overlaps read conflicted. Nothing is superseded, because the schema
  did not change.
- **A content migration** → supersedes every open suggestion on each story it
  commits to (decision 7). A story the migration leaves unchanged produces no commit
  and keeps its suggestions, which is right: its field names did not move.
- **Duplicating a document** → suggestions stay with the original. They are proposals
  against one draft.
- **A suggestion on a singleton global or a bare layer** → allowed under the same
  `load(…, "write")` rule as a write; the layer option makes an inherited key an
  `unset`.
- **The Content tree badge after a decline** → the count in D1 is written by the
  object at once, but the tree is read on load; an open tree updates on its next
  fetch. No space event is added, because a decline happens inside the object, which
  has no path to the space object, and the space channel's events are advisory
  anyway.
- **A deploy script writing 400 records** → 400 objects each gain one presence row
  and no alarm. Nobody has those records open, so nothing is broadcast; the rows
  expire by being ignored and are deleted on the next `peers()`.
- **Two tokens with the same name** → one actor everywhere already (`actorString`), so
  one presence peer. Withdraw treats them as one author, which is what the trail
  already says they are.
- **`auth: 'open'`** → `requireAccess` passes everything, the author is `api` with
  kind `anonymous`, no presence row is written (there is no `TokenActor`), and any
  socket may accept (there are no roles to check).
- **A stale v5 tab** → refused at its next frame with the existing version error and
  told to reload. It cannot see suggestions and cannot accept one.
- **The suggestion was computed against an older read than the object holds** → the
  route reads the draft, diffs, and calls `suggest`; a keystroke landing in between
  is captured in the unit's inverse as "before". The suggestion then proposes the
  agent's value over that keystroke, visibly, as a suggestion. Nothing is lost and
  the reviewer decides.

## Testing requirements

**Unit (`test/unit/`):**

- `core/suggestions.test.ts`: `suggestionUnits` groups an inserted subtree (parent,
  children, sets on them, a move into it) into one `ins:` unit; groups every field
  edit on an existing blok into one `blk:` unit; a remove and its sets share a unit.
  `acceptMutations` preserves index order and every subset of a `diff` output applies
  with no `mutationError`. `unitDrift`: one test per row of decision 3's table,
  including the null-versus-absent case (`set` of a field that was absent inverts to
  `unset`, and a later `null` written there is drift), the "edited and reverted"
  case (no drift), and per-locale independence.
- `core/protocol.test.ts`: `decline` and `tx.accepts` round-trip through
  `parseClientFrame` with junk keys dropped and lengths capped; a `tx` with a
  malformed `accepts` is unreadable, not a `tx` without one.
- `mcp/tools.test.ts`: the four rows round-trip against their routes;
  `suggest_content` and `suggest_fields` share the write rows' schema constants.
- `mcp/scopes.test.ts`: `content:suggest` alone lists exactly the read tools plus
  the four suggestion tools; `content:write` lists both sets.
- `server/roles.test.ts` (new): `IMPLIES` rows;
  `allows(grant, SUGGEST)` is false; `tokenScopesOn` keeps `content:suggest` only on
  writer scopes.
- `admin/suggestions-model.test.ts`: labels, before/after/current per field, and
  drift display, over fixtures that include a translated field.
- `admin/store.test.ts`: accept pushes one undo entry
  that is not coalesced with a preceding keystroke; undo after accept sends a plain
  `tx` with no `accepts`; a rejected accept drops its undo entry; resend carries
  `accepts`; a token peer is dropped after `ttlMs` and kept when refreshed.

**Workers (`test/workers/`, real workerd):**

- `story-do.test.ts`: a suggestion leaves `doc`, `log` and `head()` untouched and
  broadcasts only to joined sockets (the pre-hello quarantine still holds for the new
  frame). Accept: one log row with all three attribution columns; units accepted;
  the log row and the unit state agree even when the test forces a failure inside
  `alongside` (nothing is written). The check order of decision 4, one test per
  step, including "replay ack beats not-pending". Viewer refused for accept and
  decline. `commit` with `presence`: the presence frame precedes the delta on the
  wire. `commit` with `supersede`: every open suggestion closed. `purge()` empties
  both tables. `peers()` drops an expired row and never spreads one (assert the frame
  has exactly the `Presence` keys). **`getAlarm()` is null after a `touch` and after
  a suggestion on an object with no pending watermark**, which pins decision 11's
  rejected alternative. The 21st suggestion, the byte budget, the identical replay,
  the closed-fifty prune.
- `api.test.ts`: both body shapes; both-or-neither is `bad_request`; field errors are
  the write routes' wording; empty diff answers `{ suggestion: null }`; withdraw by a
  different token is 403; `pendingSuggestions` on publish and on document meta.
  `PUT /content` and `PATCH /fields` behave byte-identically after the extraction
  (their existing tests unchanged and green).
- `scope-partition.test.ts`: the three new v1 id routes and the internal admin route
  are fence-tested (the test fails until they are, by design).
- `multi-site.test.ts`: a bound token's suggestion on a shared document is 404; a
  grant's is 403.
- `multi-brand.test.ts`: a suggestion validates against the story's brand schema and
  refuses a field only the other brand declares.
- `mcp.test.ts`: `suggest_fields` over JSON-RPC creates a suggestion attributed
  `token:<name>`; `list_suggestions` reports drift after a direct write.
- `migrations.test.ts`: `stories.suggestions_pending` exists with default 0.
- `migrate.test.ts`: a migration run supersedes open suggestions on the stories it
  changes and leaves others open.

**End to end (`scripts/suggestions-test.mjs`, port 5199):**

- Mint a `content:suggest` token; open an editor socket as `editor@example.com`;
  `suggest_fields` over MCP; observe presence (kind token) then the suggestion frame;
  accept one unit by sending a `tx` with `accepts`; observe the delta and the
  updated suggestion; read the draft back over v1 and assert the accepted value and
  the untouched one; read `/folio/api/story/:id/activity` and assert the attribution;
  decline the rest; `list_suggestions state=closed` shows both decisions; a second
  suggestion plus a direct conflicting `PATCH /fields` shows drift in
  `list_suggestions`; `DELETE` withdraws a third; `GET` the story row and assert
  `suggestionsPending` is 0.

## Dependencies

- Spec 24 (`platform/mcp-server.md`): the tool table, decision 2's dispatch, decision
  6's filtering, decision 10's attribution.
- Spec 16 (`editing/live-collaboration.md`): field-level presence, the overwrite
  notice this spec makes name the agent.
- Spec 21 (`platform/content-api.md`): `writeDocument`, `commitAll`, `fromNested`.
- Spec 23 (`foundation/multi-site.md`) and spec 34 (`foundation/multi-brand.md`): the
  write fence and the brand's schema, both used unchanged.
- No Cloudflare resource, binding or host configuration change.

## Out of scope

- **Suggestion mode for people in the editor** (a reviewer-less "track changes" toggle
  for editors, or a viewer acting as a suggester). Deferred until real editor feedback
  asks for it. The storage and review machinery here
  would carry it, but the editing UX of typing into a proposal rather than the draft
  is a separate design, and nothing in this spec forecloses it.
- **A site-wide review queue screen.** The tree marker and the per-document panel
  cover discovery; a queue across every page wants the admin UI review that is
  sequenced after v1.5, and it would read the D1 counter this spec adds.
- **Suggesting new documents, moves, renames or deletes.** Each is a row change in D1,
  not a draft change in the object, and none has a draft to review it against.
  `create_document`, `move_document` and `delete_document` keep their current access.
- **Agent avatars in the site-wide strip** (decision 11's rejected space channel).
- **Comments or a conversation thread on a suggestion.** `summary` is the agent's one
  line of rationale; replying to an agent happens in the agent's own client, which
  is the positioning in this workstream (Folio does not build a chat panel).
- **"Claude, on behalf of Sam."** Unchanged from MCP's out-of-scope entry: the author
  is the token.
- **Compacting the log.** Three nullable columns make it no harder.
