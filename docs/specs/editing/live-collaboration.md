# Feature: Live collaboration — seeing the rest of the team, not just the page

> **Group:** editing
> **Build order:** 16
> **Size:** M
> **Status:** done
> **Wire version:** bumps `PROTOCOL_VERSION` to 4 (`presence` carries a field; a second space-level channel appears)
> **Migration:** none (one new Durable Object class, so a `wrangler.jsonc` migration tag)
> **Last updated:** 2026-07-30

## Summary

Multiplayer already works *inside* one document: edits broadcast per keystroke,
presence dots show who has which block selected, reconnection replays the deltas a
client missed. What is missing is everything one step out.

You can only see people who are in the same story as you. Another editor renaming a
page does not reach your tree, so your links keep showing the old URL until you
refresh. Someone publishing does not reach your view at all. Presence is per block,
not per field, so two people in the same block have no idea they are about to
overwrite each other — and for a richtext field they will, visibly and with the caret
jumping, because the incoming value is pushed into the editor
(`src/admin/RichTextInput.tsx:145-153`).

This spec adds a **space-level channel**: one Durable Object every open admin joins,
carrying presence across stories and broadcasting structural events. Field-level
presence, an overwrite notice, and follow-mode fall out of it.

## Ground truth

**server (`packages/folio/src/server/story-do.ts`):**
- Presence is assembled from `this.ctx.getWebSockets()` on the *story's* object, so
  its scope is exactly one document. There is no object that knows about more than
  one story.
- `Attachment` is `{ actor, name, colour, selection }` where `selection` is a uid
  string or null, capped at `MAX_SELECTION_LEN = 64` (`core/protocol.ts:87`).
- `broadcast` skips sockets with no attachment — the pre-hello quarantine.
  `../foundation/identity-and-access.md` turns that into an explicit `joined` flag,
  and this spec depends on that having happened.
- Sockets are hibernatable (`acceptWebSocket`), so an idle editing session costs
  nothing, and `serializeAttachment` survives eviction. Both properties must hold for
  the new object too.

**admin (`packages/folio/src/admin/`):**
- `store.ts` — one `StoryStore` per open story, one socket, `select(uid)` sends a
  `presence` frame, and `state.peers` is maintained from `presence` broadcasts.
- `TopBar.tsx` renders one dot per peer with `title={p.name}`, and a "me" dot.
- `useStories.ts` reloads the tree after a create/patch/delete the *local* client
  made. Nothing reloads it when someone else changes it.
- `usePublish.ts`'s `onPublished` reloads the local tree badge and version list. A
  peer's publish reaches nobody.
- Resolution in the admin is built from the story tree it has already loaded
  (`core/resolve.ts`'s comment: *"rebuilt only when structure changes, which is
  exactly when a URL can have moved"*) — so a peer's rename is precisely a case
  where it should be rebuilt and is not.
- `usePreviewBridge.ts` pushes `apply` / `replace` / `resolve` / `select` frames into
  the iframe, and checks `event.origin` and `event.source` on everything coming back.
- `RichTextInput.tsx:145-153` — an incoming value that differs from the local one is
  pushed in with `editor.commands.setContent`, which resets the selection. Comment:
  *"Applies edits that came from somewhere else: another editor over the WebSocket, an
  undo, or a version restore."* Correct, and the reason two people in one richtext
  field is unpleasant rather than merely last-write-wins.

**demo:** `wrangler.jsonc` declares `migrations: [{ tag: 'v1', new_sqlite_classes:
['StoryDO'] }]`, and the README notes `new_sqlite_classes` cannot be changed for an
already-deployed class — so a second class needs its own tag.

## Owner decision checkpoints

1. **One space-level Durable Object, presence never persisted (recommended).** A
   single instance named `'space'`, no SQLite storage at all, everything in socket
   attachments. It cannot lose anything that matters, it hibernates when idle, and it
   is the only way to know who is in the site rather than in a document. The
   alternative — polling a D1 table of heartbeats — is a write per editor per few
   seconds and is always slightly wrong.
2. **Advisory presence, never locking (recommended).** Showing "Ann is editing this
   field" and letting both people type is better than a lock, because every lock
   needs a release, and a released-by-timeout lock is a worse failure (you were
   locked out of your own page for 30 seconds) than an overwrite you were warned
   about. Overriding this means designing lock expiry, lock stealing, and what
   happens to a lock held by a hibernated socket.
3. **Structural events broadcast; content changes stay per story (recommended).**
   The space channel carries "story X was renamed / moved / created / deleted /
   published", not deltas. Deltas stay on the story's own socket where the watermark
   and catchup logic live. Putting content on the space channel would mean a second
   ordering to reconcile, which is the one thing the sync design is careful about.
4. **Globals in a page preview become hydrated and refreshable (recommended,
   optional phase).** `globals.md` deferred live propagation of a header edit into
   another page's preview. With a space channel it is reachable: hydrate globals
   read-only in a page preview and refresh them when an event says their draft moved.
   It is phase 4 and can be dropped without affecting the rest.

## User stories

### Editor sees who is in the site
**As** an editor **I want** to see that Ann is on the About page and Ben is in the
footer **so that** I do not open the same page and fight them, and so I know who to
ask.

### Editor is not surprised by a rename
**As** an editor **I want** another editor's rename to update my tree and my link
previews **so that** I am not looking at a URL that no longer exists.

### Editor knows a page went live
**As** an editor **I want** to know that someone else published the page I have open
**so that** I do not publish over their work or wonder why the live site changed.

### Editor is warned before an overwrite
**As** an editor **I want** to see that someone else is in the field I am about to
type into, and to be told when they change it under me **so that** the last-write-
wins model is visible rather than silent.

### Editor follows a colleague
**As** an editor on a call **I want** to click Ann's avatar and land on what she is
looking at **so that** "the bit above the map" resolves in one click.

## Architecture decisions

### 1. `SpaceDO` — one instance, no storage, presence in attachments

```ts
export class SpaceDO extends DurableObject {
  // No sql, no storage. Nothing here outlives the sockets.
  async fetch(req: Request): Promise<Response>       // upgrade only
  async webSocketMessage(ws, raw)                    // hello | where | selection
  async broadcastEvent(event: SpaceEvent): Promise<void>   // RPC, from the Worker
}
```

Reached at `GET /folio/space/socket`, one instance
(`space.idFromName('space')`), joined by every admin when it loads and left when it
unloads. Same discipline as `StoryDO`, deliberately: frame-size check before
`JSON.parse`, hand-rolled total shape guards, version check on every frame, a
`joined` flag as the broadcast membership test, and an exception never allowed out of
a hibernatable handler.

It holds no SQLite storage, which means `new_classes` rather than
`new_sqlite_classes` in the host's `wrangler.jsonc` — a smaller commitment than
`StoryDO`, and a note worth putting in the README beside the existing warning.

Identity comes from the session, attached by the Worker before the upgrade, exactly
as `../foundation/identity-and-access.md` does it for `StoryDO`. The space channel
must never accept a self-reported name: it is the one place a name is shown *outside*
the document it was asserted in.

### 2. Space presence: where someone is, and what they have selected

```ts
interface SpacePresence {
  actor: string
  name: string
  colour: string
  role: Role
  /** Story id currently open, or null while the admin is on a list screen. */
  storyId: string | null
  storyTitle: string | null
  locale: string | null
  /** Mirrors the story-level selection, so follow-mode can land on a block. */
  selection: { uid: string; field: string | null } | null
}
```

The client sends `{ type: 'where', storyId, storyTitle, locale }` when it opens a
document and `{ type: 'selection', … }` when the selection changes, throttled to at
most one frame per 100 ms and only when the value actually changed. Presence is
chatty by nature and this is the whole cost control: no timers, no heartbeats, one
frame per real change.

There is deliberate duplication here — selection rides on both the story channel
(where per-block dots need it, with no round trip through a second object) and the
space channel (where the tree and follow-mode need it). Two cheap frames beats one
object trying to be both.

### 3. Field-level selection, on both channels

`Presence.selection` becomes `{ uid: string; field: string | null } | null`.

- `MAX_SELECTION_LEN` applies to each part; the shape guard rejects anything else, and
  `normalizeSelection` caps both.
- The inspector reports the focused field; `store.select(uid)` keeps working and means
  `{ uid, field: null }`.
- The block tree keeps showing a dot per block (derived by ignoring `field`), and the
  inspector shows a coloured ring plus a name on the field a peer holds.

This is the wire bump (`PROTOCOL_VERSION` → 4). Nothing persists a `Presence`, so
unlike a mutation there is no old data to stay compatible with — presence is the
cheapest thing in the protocol to change, which is why it is worth doing properly
rather than encoding a field into the uid string.

### 4. Structural events, broadcast from the Worker after the write commits

```ts
type SpaceEvent =
  | { kind: 'story.created';   id: string; parentId: string | null; title: string; type: string }
  | { kind: 'story.updated';   id: string; title: string; slug: string; parentId: string | null; path: string | null }
  | { kind: 'story.moved';     id: string; parentId: string | null; ord: string }
  | { kind: 'story.deleted';   ids: string[] }
  | { kind: 'story.published'; id: string; at: number; actor: string; versionId: string }
  | { kind: 'global.changed';  name: string; storyId: string }
```

Emitted by the routes that already own those writes (`routes/stories.ts`,
`publish.ts`'s callers) **after** the D1 write commits, through
`ctx.waitUntil(space.broadcastEvent(event))` — so a failed broadcast never fails a
write that succeeded, which is the same rule `api.ts`'s `afterWrite` follows on the
client.

What each event buys, on every open admin:

- `story.updated` / `story.moved` / `story.created` / `story.deleted` → the tree
  patches itself, and the resolution is rebuilt from it and pushed into the preview as
  a `resolve` frame. **A peer's rename therefore fixes every link in your open
  preview, live** — which is the payoff the link design was built for
  (`core/resolve.ts`: resolution is *"rebuilt only when structure changes, which is
  exactly when a URL can have moved"*).
- `story.published` → the tree's unpublished-changes marker updates
  (`unpublished-changes.md`), and an editor with that story open gets a notice naming
  who published.
- `story.deleted` → an editor with that story open is told, rather than discovering it
  through a 4002 close with no explanation.

Events are advisory and idempotent: a client that missed one is corrected by the next
tree reload, and the payload is small enough to apply directly rather than triggering
a refetch. No watermark, no catchup, no ordering guarantee — deliberately, because the
authoritative answer is always one `GET /folio/stories` away.

### 5. Overwrite notice, and the richtext hazard named

Two additions, both in the client:

1. **Before**: a field a peer holds shows their colour and name in the inspector, from
   space or story presence. Advisory (checkpoint 2).
2. **After**: when a delta from another actor contains a `set` on the field this client
   currently has focused, the store surfaces it — "Ann changed this field" — through
   the existing notice channel rather than inventing a second one.

For richtext this matters more than a notice. `RichTextInput`'s effect pushes an
incoming value in with `setContent`, which resets the caret, so a peer typing in the
same richtext field yanks your cursor. The honest fix within a last-write-wins model
is to **defer** the external update while the field has focus and local edits are
newer, apply it on blur, and tell the user their copy is behind — not to merge, which
is `y-prosemirror` (explicitly out of scope in `README.md`). That behaviour is
specified below and tested, because it is the difference between "last write wins" and
"unusable with two people".

### 6. Follow-mode is a client feature over presence

Clicking a peer's avatar opens their `storyId` (client-side navigation, which the
admin already does — *"Switching pages is client-side, so the rail keeps its tab and
there is no reload"*), sets the locale to theirs, and selects their `selection.uid`.
Nothing new on the wire; it is the reason `selection` is on the space channel.

Continuous following (moving as they move) is deliberately not included: it needs an
exit affordance, a "they left" state, and scroll synchronisation that the preview
bridge does not carry.

## Wire & schema changes

### D1

None.

### Host configuration

```jsonc
"durable_objects": { "bindings": [
  { "name": "STORY", "class_name": "StoryDO" },
  { "name": "SPACE", "class_name": "SpaceDO" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["StoryDO"] },
  // SpaceDO holds no storage, so it is not a SQLite class.
  { "tag": "v2", "new_classes": ["SpaceDO"] }
]
```

`FolioBindings` gains `space?: DurableObjectNamespace<SpaceDO>`. **Optional**, and
this is deliberate: without it, everything in this spec degrades to today's behaviour
(per-story presence, manual refresh) rather than failing. A library that hard-requires
a new binding breaks every existing host on upgrade.

### Core types

- `Presence.selection` becomes `{ uid: string; field: string | null } | null`;
  `PROTOCOL_VERSION` → 4.
- New `SpaceClientMsg` (`hello` | `where` | `selection`) and `SpaceServerMsg`
  (`peers` | `presence` | `event`), with `parseSpaceFrame` beside
  `parseClientFrame` and the same total-over-`unknown` discipline.
- `SpaceEvent` per decision 4.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/space/socket` | session (any role) | The space channel |

## Acceptance criteria

### Cross-story presence
```
GIVEN Ann on /folio/edit/A and Ben on /folio/edit/B
WHEN both admins have loaded
THEN each sees the other in the top bar with their name and colour, labelled with
     the story they are on
AND the tree row for A shows Ann's avatar and B's shows Ben's
AND neither appears in the other's per-block presence dots (different documents)
```

### A rename reaches an open preview
```
GIVEN Ann editing page P, which links to page Q, with the preview open
WHEN Ben renames Q's slug
THEN Ann's tree updates without a refresh
AND Ann's preview re-renders with Q's new URL in the link, with no reload of the
    iframe and no fetch of P's document
AND P's document is byte-unchanged (links store ids, not paths)
```

### A publish reaches an open editor
```
GIVEN Ann editing page P
WHEN Ben publishes P
THEN Ann is told who published and when, her unpublished-changes state recomputes,
     and her draft is untouched
```

### A delete is explained
```
GIVEN Ann editing page P
WHEN Ben deletes P
THEN Ann's socket closes with 4002 as it does today
AND Ann sees "Ben deleted this page" rather than an unexplained terminal close
```

### Field-level presence
```
GIVEN Ann and Ben both with block X selected
WHEN Ann focuses the heading field and Ben focuses the body field
THEN each sees the other's colour and name on the field the other holds
AND both may type: nothing is locked
```

### Overwrite notice on a text field
```
GIVEN Ann focused on block X's heading
WHEN Ben's set on that field arrives
THEN Ann's input shows Ben's value (last write wins, unchanged)
AND Ann is told "Ben changed this field"
```

### Richtext does not steal the caret
```
GIVEN Ann typing in block X's body richtext
WHEN Ben's set on that field arrives
THEN Ann's caret does not move and her in-progress text is not replaced
AND she is told her copy is behind
AND on blur, Ben's value is applied
AND with Ann not focused on that field, Ben's value applies immediately, as today
```

### Follow
```
GIVEN Ben on story B with block Y selected in locale fr
WHEN Ann clicks Ben's avatar
THEN Ann's editor opens story B client-side, switches to fr, and selects Y
```

### Degrades without the binding
```
GIVEN a host that has not declared the SPACE binding
WHEN the admin loads
THEN no space socket is attempted, per-story presence works exactly as before,
     and nothing logs an error to the console
```

### Presence is not persisted and hibernates
```
GIVEN every editor closes their tab
WHEN the space object is inspected
THEN it holds no storage, and the next editor to connect sees an empty peer list
AND an idle object with connected-but-silent sockets performs no work
```

### Chattiness is bounded
```
GIVEN an editor dragging a selection across ten blocks in one second
THEN at most ten selection frames are sent on the story channel and at most ten on
     the space channel, deduplicated so an unchanged selection sends nothing
```

## Implementation plan

Deploy order: phase 1 is a wire bump and ships with the admin, as always. Phase 2 adds
a Durable Object class, which needs the host's `wrangler.jsonc` migration tag — so the
binding is optional and the admin feature-detects it (decision: `FolioBindings.space`
absent → the admin is told through the bootstrap and never opens the socket).

### Phase 1 — field-level selection

1. `core/protocol.ts`: `Presence.selection` shape, `normalizeSelection` over both
   parts, `PROTOCOL_VERSION` → 4.
2. `story-do.ts`: attachment and the `presence` case.
3. `admin`: `store.select(uid, field?)`; `Inspector.tsx` reports focus and renders a
   peer ring on a held field; `BlockTree.tsx` derives its dot by ignoring `field`.
4. Tests: `protocol.test.ts` (guard and caps), `store.test.ts` (throttle, dedupe),
   `story-do.test.ts` (broadcast shape).

### Phase 2 — the space channel

1. `server/space-do.ts`: `SpaceDO`, with the frame discipline copied from `StoryDO`
   and a shared helper for the parts that are genuinely identical (frame size check,
   version check, `joined` membership) rather than a second copy.
2. `server/routes/space.ts`: the upgrade route, with the same
   accept-and-close-with-a-code pattern for a refused connection.
3. `server/types.ts`: optional `space` binding, surfaced to the admin through the
   `__FOLIO_ADMIN__` bootstrap.
4. `admin/spaceStore.ts`: a small store mirroring `StoryStore`'s shape (subscribe /
   getSnapshot, reconnect with backoff, terminal on 4001/4003) but with no document,
   no log and no queue.
5. `admin`: `TopBar` avatars from space presence; `StoryTree` row avatars; a
   "who's here" popover.
6. Tests: `test/workers/space-do.test.ts` — join/leave, peer lists, no storage,
   version refusal, unauthenticated refusal; `test/unit/admin/space-store.test.ts`
   with a fake socket.

### Phase 3 — structural events

1. `server/routes/stories.ts` and the publish route: emit events through
   `ctx.waitUntil` after the commit.
2. `admin/hooks/useStories.ts`: apply events to the tree; rebuild the resolution;
   push a `resolve` frame into the preview.
3. `Editor.tsx`: notices for `story.published` and `story.deleted` on the open story.
4. Tests: workers tests that each route emits exactly one event after a successful
   write and none after a failed one; an admin test that a `story.updated` event
   rebuilds the resolution without refetching the document.

### Phase 4 — the richtext hazard, and live globals (optional)

1. `RichTextInput.tsx`: defer an external update while focused with newer local
   edits; apply on blur; report being behind. This is the highest-value item in the
   spec for anyone who has actually tried two people in one field, and it is
   independent of the space channel.
2. The overwrite notice in `store.ts` (a delta from another actor touching the
   focused field).
3. Globals hydrated read-only in page previews and refreshed on `global.changed`,
   closing the gap `globals.md` deferred.
4. Follow-mode.

### Phase 5 — docs

1. `README.md`: the space binding, the migration tag, what degrades without it.
2. `docs/sync-design.md`: a section stating that the space channel is advisory,
   unordered and never authoritative — the one thing a future reader must not
   misunderstand about it.

## Edge cases

- **Space object unreachable** (transient) → the admin retries with the existing
  backoff and everything else keeps working. Presence is the only casualty.
- **A thousand editors** → one object's fan-out is O(n) per frame. Presence throttling
  bounds frames per editor; the real bound is that a CMS space has tens of editors.
  If that changes, sharding by story-prefix is the escape hatch, and it is not built.
- **An editor with two tabs** → two presences, same actor, different `storyId`. Shown
  once per tab, because that is the truth; the avatar list dedupes by actor for
  display and shows a count.
- **A hibernated space socket** → attachments survive, so a peer list rebuilt after
  eviction is still correct. This is why presence lives in attachments and not in
  memory.
- **An event about a story the client has never seen** → applied to the tree as a
  create; if it references an unknown parent, the client refetches the tree rather
  than guessing. One refetch is cheaper than a wrong tree.
- **Events arriving out of order** (two renames in flight) → last applied wins, and
  the next tree load corrects it. Advisory by decision 4.
- **Role revoked while connected** → the space socket closes 4003 like the story
  socket, and presence disappears from every other client because the socket closed.
- **Presence for a record or a global** → same channel, `storyTitle` is the record's
  title, and the tree avatar appears in the Data or Globals section
  (`../content-model/data-documents.md`, `../content-model/globals.md`).
- **A peer in a different locale editing the same field** → not a conflict at all
  (different keys), and the presence ring should say which locale, or it reads as a
  clash that is not one. Small but worth getting right.
- **`selection` naming a uid the receiving client's document does not have** (they are
  behind) → rendered as no dot rather than an error; the next delta brings the blok.

## Testing requirements

**Unit:** presence shape and caps; selection throttle and dedupe; the space store's
reconnect and terminal codes; event application to a tree (including the unknown-parent
refetch).

**Workers:** `SpaceDO` join/leave/peers/version/auth; no storage allocated; each
mutating route emitting exactly one event after success and none after failure.

**End to end (`scripts/space-test.mjs`, new):** three Node clients — two story sockets
on different stories plus a space socket — assert cross-story presence, that a rename
through the HTTP API reaches the space socket, that the renaming client's own tree and
a peer's tree both converge, and that a story socket's per-block presence is unchanged
by any of it. Model on `scripts/sync-test.mjs`, which already drives Node WebSocket
clients against the dev server.

## Dependencies

- `../foundation/identity-and-access.md` — a verified identity, and the `joined` flag
  that replaces "has an attachment" as the broadcast membership test. Building this on
  self-reported identity would put a spoofable name on every screen in the site
  instead of one document, so it is a hard dependency.
- `unpublished-changes.md` — `story.published` updates the marker that spec adds.
- `../content-model/globals.md` — phase 4's live globals close the gap it deferred.
- Host-side: one new Durable Object binding and a `wrangler.jsonc` migration tag,
  both optional.

## Out of scope

- **Collaborative richtext (CRDT).** `README.md` states the position and the cost:
  decomposing prose into the blok graph means translating ProseMirror transactions
  into mutations, which is `y-prosemirror` rewritten. Phase 4 makes the
  last-write-wins model bearable instead; it does not pretend to merge.
- **Cursors and text selections inside a richtext field.** Needs ProseMirror
  decorations fed from presence, and is only worth it alongside a CRDT.
- **Comments and mentions on blocks.** A real want, a separate spec, and it needs
  persistence — which the space object deliberately has none of.
- **Continuous follow-mode** (decision 6).
- **Presence on the published site** ("3 people viewing"). Not a CMS feature.
- **Per-space sharding of the space object.** Named as the escape hatch, not built.

## Open questions

None left.

- *Should the space channel carry a "someone is typing in story X" hint?* **No, and it
  is not built.** Judged more noise than signal: an avatar already says somebody is in
  a document, and a boolean that flickers on and off every few seconds adds movement to
  the tree without adding an answer anybody acts on. The channel carries where people
  are and what changed structurally; whether a given person is mid-sentence is not a
  question the tree needs to answer.

## Implementation notes

Landed 2026-07-30 in six commits (`d5a1c44`, `72b6f44`, `fa0f642`, `6bd114e`,
`643cd61`, `4f3ba46`). Tests: 1791 → 1873 (66 → 69 files). `PROTOCOL_VERSION` is
**4**. No D1 migration, as the header says: presence is never persisted, which is
also what makes this the cheapest wire bump there has been — nothing in it touches
a mutation, so there is no log entry whose meaning could shift and nothing to stay
compatible with. `scripts/space-test.mjs` is 26 checks against a live server.

**All five phases landed, including the optional one.** Phase 4's live-globals step
is the one thing that landed only in part; see "Deliberately not built" below.

### The one real departure from the spec: events reload, they do not patch

Decision 4 says a client applies an event's payload to its tree directly rather
than refetching. **It cannot, and the reason is `StoryNode.url`.** That field is
computed by the *host's* own `route` function, on the server, so the admin has no
way to derive it for a page whose path just moved. A tree patched with the right
path and a stale URL is strictly worse than one that refetches: every link to that
page in the preview you are looking at would keep pointing at the vacated URL,
which is the exact failure this feature exists to fix.

So `spaceEventEffect` (`admin/hooks/useSpace.ts`) answers with a reload, and the
acceptance criteria still hold, because they are about three specific things and a
reload breaks none of them: the open document is never refetched, the iframe never
reloads, and the resolution rebuilt from the new tree reaches the preview as a
`resolve` frame. One `GET /folio/stories` is the cost. The spec's own edge case
already said "one refetch is cheaper than a wrong tree"; this generalises that from
the unknown-parent case to every case.

### Two additions beyond the spec's sketch

**`Presence` also carries a `locale`.** The spec's edge case asks the peer ring to
name which language somebody is editing in, since two people in one field in two
locales are writing different keys and are not in conflict at all. The alternative
was cross-referencing the space channel's `SpacePresence.locale` by actor, which
would have made the label wrong — silently claiming a clash — on a deployment
without the space binding. It rides the story channel instead, where the ring is.

**Every `SpaceEvent` carries its `actor`.** Two jobs. The object broadcasts to
every joined socket, because a Worker calling an RPC has no idea which socket the
request arrived on and inventing a way for it to know is a lot of machinery for one
redundant refetch — so the client that caused a change ignores its own echo by
comparing this. And it is how a notice gets a *name*: the id is looked up in the
peer list this same channel already carries, so no display name has to ride on the
event. An actor who has since closed their tab reads as "Someone".

### What the spec got wrong or could not know about the codebase

- **`SpacePresence.role: Role`** is `role: string | null` on the wire. `Role` lives
  in `server/auth/roles.ts` and the wire lives in `core/`, which does not import
  the server. The object writes it from the verified identity, never from a claim.
- **The `SpaceEvent` payloads** are narrower than the sketch, because each one is
  assembled from what its after-commit hook actually holds and nothing else — no
  second query to enrich an event that fires on every rename. `story.updated`
  carries `changes: {id, from, to}[]` (which is what `pathsChanged` has) rather
  than `{title, slug, parentId, path}`; `story.moved` does not exist at all,
  because a move changes paths and therefore *is* a `story.updated`.
- **A pure sibling reorder broadcasts nothing.** No path changes, so
  `pathsChanged` does not fire. Named rather than papered over: closing it would
  mean a second after-commit path for the sake of a row moving up one place, and
  the symptom is a peer's tree keeping the old order until its next load.
- **`useGlobalDocs` returns `{ docs, reload }`** now, not a bare record. The
  `reload` is the seam `globals.md` deferred, driven by `global.changed`.
- **`adminPage(rt, bindings, story)`** takes the bindings, to put `space: boolean`
  in the `__FOLIO_ADMIN__` bootstrap. The `isId` check in `/edit/:id` moved
  *ahead* of taking the bindings, because `test/workers/app.test.ts` pins that an
  id which cannot name a story never touches the host's environment.

### Shared, not copied

`server/sockets.ts` is new and holds what the two socket-bearing objects genuinely
share: the application close codes, the pre-parse frame-size ceiling, and the
bounded session re-check. `StoryDO` was refactored onto it, which is why that file
got shorter. Two copies of a security check drift, and the untested copy drifts
first. What is *not* shared stayed put: the story object's catchup, watermark and
quarantine reasoning, and the space object's per-story presence.

`SpaceDO` is a factory (`createSpaceDO<Env>({ db })`) for the same reason
`createStoryDO` is — a Durable Object is constructed with the raw host env and
never sees `createFolio`'s config. The `db` there is *not* storage: the object
persists nothing of its own and reads `sessions` only to notice a revocation on an
already-open socket. `wrangler.jsonc` therefore declares it with **`new_classes`**,
under its own `v2` tag; a test pins that no storage and no alarm exist after a busy
session.

### The trap, held

`identity-and-access.md` warned that the attachment now exists from upgrade time,
so "has an attachment" admits every lurker. `SpaceDO` uses `joined`, and it matters
more here than on the story socket: this is the one channel that shows a name
*outside* the document it was asserted in. There is a test that a socket which has
not said hello appears in nobody's peer list, receives nobody's presence, receives
no events, and cannot announce a position. Presence frames are built by an explicit
`presenceOf`, never a spread, and the e2e asserts no `session` or `expiresAt` key
reaches a frame.

### Deliberately not built

- **Live propagation of a *draft* edit inside a global into another page's open
  preview** — phase 4, step 3, the half of it that needed a per-keystroke path from
  `StoryDO` to `SpaceDO`. `global.changed` exists and fires when a configured
  global is **published**, and `useGlobalDocs.reload` consumes it, so the seam is
  built and the published case works. The draft case would mean the story object
  holding the space binding and emitting on every transaction, which is content on
  the space channel in all but name (decision 3), and it was not worth the risk on
  an optional phase. Recorded in README's "Not built yet".
- **Continuous follow-mode**, per decision 6. Click-to-follow is built and needed
  nothing new on the wire, which is the reason `selection` rides the space channel
  at all.
- Everything under *Out of scope* stands: no CRDT, no cursors inside a richtext
  field, no comments, no presence on the published site, no sharding.
