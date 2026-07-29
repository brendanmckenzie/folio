# Feature: Duplicate and paste — blocks, sections and whole documents

> **Group:** editing
> **Build order:** 6
> **Size:** S–M
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-07-29

## Summary

An editor who has built a three-column feature section and wants a second one has to
build it again, block by block, field by field. There is no duplicate, no copy, no
paste, and no way to reuse a page as the basis for another. `PARITY.md` puts
"duplicate a block, and copy/paste blocks between pages" in Phase 5 with the note that
*"editors will ask within a day"*, and every CMS in the comparison has all three
(Storyblok does cross-story block paste; Payload, Contentful, Sanity and Strapi all
duplicate documents).

It is cheap here because the mutation vocabulary already expresses it. A duplicate is a
run of `insert` mutations with fresh uids, sent as one transaction — so it syncs to
other editors, appears in the activity trail, and Cmd+Z undoes the whole thing in one
step. A duplicated *document* is a new story whose Durable Object is seeded with a
clone instead of a blank.

## Ground truth

**core (`packages/folio/src/core/`):**
- `subtree(doc, root, visited?)` (`doc.ts`) returns the uid plus every descendant,
  **parents before children**, and is total over a cyclic document.
- `childrenOf(doc, parent, slot)` returns siblings sorted by `compareSiblings`, and
  `keyAtIndex(keys, index)` produces a fractional key at a position — including the
  tied-key case, which it documents.
- `newUid()` is 16 hex chars of full entropy, chosen because *"32 bits collided at
  ~77k ids, and a collision meant an insert replacing an unrelated blok"*. A clone
  allocating uids depends on exactly that property.
- `mutationError` refuses an `insert` whose uid already exists (`duplicate uid`), so
  re-allocation is not optional — and the DO validates the whole transaction
  atomically, so one bad uid refuses the entire paste rather than half-applying it.
- `isBlok(x)` (`protocol.ts:219-229`) is a total shape guard over `unknown`, written for
  the socket. Clipboard content is untrusted input of the same kind, so it goes through
  the same guard rather than a new one.
- `diff()`'s insert rule — parents before children so a child never lands on a missing
  parent — is the ordering a multi-blok insert must follow.

**server (`packages/folio/src/server/`):**
- `StoryDO.getOrInit(seed: Doc)` takes **any** document and returns it if none exists.
  So duplicating a document needs no new Durable Object entry point and no dependency
  on `../foundation/schema-migrations.md`'s `commit` RPC.
- `createStory(db, { title, slug, parentId })` derives the slug through `uniqueSlug`,
  which appends `-2`, `-3`… on collision. A duplicate therefore lands at
  `about-2` with no work.
- `updateStory` refuses to reslug or reparent the root story (`path === ''`), which is
  why duplicating the root produces an ordinary top-level page (decision 5).

**admin (`packages/folio/src/admin/`):**
- `useBlocks.ts` is the single door for block mutations: `add`, `addFirst`, `move`,
  `remove`, `setField`. `move` already enforces the target slot's `allow` and the
  cycle guard via `ancestorsOf` — the same two checks a paste needs.
- `BlockTree.tsx:95-98` — drag sets `e.dataTransfer.setData('text/folio-uid', uid)`.
  The precedent for a Folio-specific clipboard type.
- `useUndoShortcut.ts` exists, so there is already a place keyboard handling lives.
- `store.tx(mutations)` returns `false` when the transaction exceeds the wire caps
  (`frameCapError`), with a written message, and rolls back its own undo bookkeeping.
  A large paste therefore fails cleanly with no new code.

## Owner decision checkpoints

1. **Every block-level operation is `insert` mutations through the store
   (recommended).** Duplicate, paste and duplicate-a-section are all the same
   transaction shape, so all three inherit sync, undo, presence and the activity trail.
   No new mutation kind, no new door.
2. **A duplicated document is seeded, not committed (recommended).** `createStory` then
   `getOrInit(clone)`. A brand-new document has no editors watching and no log worth
   an entry, so seeding is both simpler and more honest than replaying a hundred
   inserts into an empty object. It also keeps this spec independent of
   `../foundation/schema-migrations.md`.
3. **Uids are always re-allocated, including for a whole-document duplicate
   (recommended).** Two documents *could* safely share uids (nothing global keys on
   them), but "why do two pages contain blok `9f3c…`" is a question nobody should have
   to answer, and one allocation path is easier to reason about than two.
4. **A duplicated document does not inherit version history (recommended).** Its
   history starts at its creation. Copying versions would imply the copy was published
   at times it was not.
5. **Paste validates against the schema and refuses unknown types (recommended).**
   Clipboard content can come from another site, another Folio instance, or a text
   editor. Refusing with a named list of the offending types beats importing blocks
   that render as "Unknown block type".

## User stories

### Editor duplicates a section
**As** an editor **I want** to duplicate a feature section and edit the copy **so
that** building a second one takes a click rather than twenty.

### Editor reuses a section on another page
**As** an editor **I want** to copy blocks on one page and paste them on another **so
that** a layout I got right can be reused without rebuilding it.

### Editor starts a page from an existing one
**As** an editor **I want** to duplicate a whole page **so that** a new case study
starts from the last one instead of from nothing.

### Editor undoes a mistake in one step
**As** an editor **I want** Cmd+Z after a paste to remove everything that arrived
**so that** a paste into the wrong slot is not twelve undos.

### Editor is told when a paste cannot work
**As** an editor **I want** to be told that a copied block is not allowed in this slot
**so that** I am not left wondering why nothing happened.

## Architecture decisions

### 1. `cloneSubtree` — one primitive, three operations

```ts
// core/clone.ts, exported from folio/engine
export function cloneSubtree(
  doc: Doc,
  uid: string,
  target: { parent: string; slot: string; order: string },
): Blok[]
```

Walks `subtree(doc, uid)` (already parents-first), allocates a fresh uid for every
blok, rewrites each `parent` through the uid map, and places the top blok at `target`.
Descendants keep their own `order` strings unchanged — they are only compared against
their siblings within the copy, so they are already correct and re-deriving them would
be work for nothing.

Field values are copied verbatim, and three of them are worth calling out because they
are the cases where a naive clone would break:

- **Assets** keep their key, so both copies point at one R2 object and one media-library
  row. Correct: alt text and focal point are per usage (`README.md`), so the copies
  can diverge from here.
- **Links and references** keep their story ids, so they resolve identically and keep
  resolving after a rename. This is the payoff of storing ids rather than paths, again.
- **Richtext** is one JSON value, including its link marks, and copies whole. Nothing
  inside it references a uid.
- **Translations** (`../content-model/localisation.md`) are part of the blok's `i18n`
  map, so a clone carries every locale with no extra work.

The uid allocation and order placement are the same primitive
`field-defaults-and-presets.md` needs for a preset's children; whichever ships first
builds `allocateSubtree` and the other uses it.

### 2. Duplicate a block: one transaction, placed after the original

`useBlocks.duplicate(uid)`:

```ts
const blok = doc.bloks[uid]
const index = childrenOf(doc, blok.parent, blok.slot).findIndex((b) => b.uid === uid) + 1
const bloks = cloneSubtree(doc, uid, { parent: blok.parent, slot: blok.slot,
                                       order: keyAt(blok.parent, blok.slot, index) })
store.tx(bloks.map((blok) => ({ t: 'insert', blok })))
store.select(bloks[0].uid)
```

Immediately after the original, selected afterwards, one undo step. The slot's `max` is
checked first and the action is disabled (with a reason) when the slot is full — the
same rule `BlockTree`'s add menu already applies via `full`.

The root block cannot be duplicated: it is the document.

### 3. Copy and paste: a self-describing clipboard payload, validated like a wire frame

```json
{ "folio": 1,
  "bloks": [ … ],
  "from": { "storyId": "sty_abc123456789", "path": "about" } }
```

- **Copy** (`Cmd+C` with a block selected, or a menu action) writes
  `JSON.stringify(payload)` with `navigator.clipboard.writeText` inside the user
  gesture, so no permission prompt. `from` is diagnostic only — it lets the admin say
  "3 blocks copied from /about" and is never trusted.
- **Paste** (`Cmd+V`) reads `event.clipboardData.getData('text/plain')` from the
  browser's own `paste` event, which needs no clipboard-read permission at all. That
  is why paste is a keyboard/event feature and not a button: a button would need
  `clipboard-read`.
- **Validation**, in order, before a single mutation is built: JSON parses; `folio === 1`;
  `bloks` is a non-empty array; every entry passes `isBlok`; every `type` exists in the
  schema; the target slot's `allow` permits the top blok's type; every child's type is
  permitted by its parent's declared slot; the slot's `max` is not exceeded. Each
  failure has its own message naming what was wrong, because "paste did nothing" is
  the worst possible outcome.
- Uids in the payload are **ignored and re-allocated**, so pasting the same clipboard
  twice into the same document works, and a payload from another site cannot collide
  with anything.

**Where a paste lands**: into the same slot as the current selection, immediately after
it. With the root block selected, into its first slot whose `allow` permits the type.
With no selection, refused with a message. Predictable beats clever.

### 4. Duplicate a document: create, then seed

```
POST /folio/stories/:id/duplicate  { title?, parentId? }
  → source = draftFor(story)                    // the draft, not the published snapshot
  → clone  = cloneDoc(source)                   // fresh uids throughout, same root type
  → row    = createStory(db, { type, title: title ?? `${source.title} (copy)`, parentId })
  → getOrInit(clone) on the new story's object
  → 201 { story }
```

The **draft** is copied, deliberately: an editor duplicating a page means "give me
what I am looking at". The copy is unpublished (`published_doc` null), so nothing goes
live by accident, and it has no version history (checkpoint 4).

Two writes across two stores, and — exactly as
`../platform/content-api.md`'s create path documents — they cannot be atomic. The
failure mode is a story row with a blank document, which is indistinguishable from a
page someone created and never filled in, so it is a state the system already
understands. Ordering matters for that reason: row first, seed second.

### 5. Duplicating the root story produces an ordinary page

The root owns `''` and cannot be reslugged (`updateStory`). Its duplicate is therefore
a top-level page with a slug derived from its title, which is the only sensible reading
of "duplicate the homepage". The confirmation says where it will land.

Singletons cannot be duplicated at all once
`../foundation/document-types.md` lands — there is exactly one of each by definition —
and the route refuses with `conflict`.

## Wire & schema changes

None. No D1 change, no protocol change; a paste is `insert` mutations that were already
legal.

### Core types

```ts
// folio/engine
export function cloneSubtree(doc: Doc, uid: string,
                             target: { parent: string; slot: string; order: string }): Blok[]
export function cloneDoc(doc: Doc): Doc
export function parseClipboard(text: string, schema: SchemaIndex): 
  { bloks: Blok[]; from?: { storyId: string; path: string } } | { error: string }
```

`parseClipboard` returns a result rather than throwing, mirroring
`parseClientFrame`'s discipline: untrusted input is answered, never thrown out of an
event handler.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/folio/stories/:id/duplicate` | publisher | Duplicate a document. Body: optional `title`, `parentId`. |

## Acceptance criteria

### Duplicate a block with its subtree
```
GIVEN a features block with three children, one of which has two children of its own
WHEN the editor duplicates it
THEN one transaction inserts six bloks, parents before children
AND every uid is new, every parent points inside the copy, and the structure matches
AND the copy sits immediately after the original in the same slot
AND the copy is selected, and Cmd+Z removes all six in one step
AND another connected editor sees all six arrive at once
```

### Field values survive
```
GIVEN a duplicated subtree containing an asset, a story link, a reference and richtext
      with an internal link mark
THEN the copy points at the same asset key, the same story ids, and identical richtext
AND renaming the linked story afterwards updates both copies' hrefs
AND translations in every locale are present on the copy
```

### Paste across documents
```
GIVEN two blocks copied on page A
WHEN the editor opens page B, selects a block in an allowing slot and pastes
THEN the blocks are inserted after the selection with fresh uids, in one transaction
AND pasting a second time inserts a second copy with different uids again
```

### Paste refusals are explained
```
GIVEN a copied hero and a slot whose allow does not include it
WHEN the editor pastes
THEN nothing is inserted and the notice names the block and the slot
AND WHEN the clipboard holds non-Folio text, malformed JSON, or a block type this
        site does not define
    THEN each is refused with its own message, naming unknown types where relevant
AND WHEN the slot's max would be exceeded
    THEN it is refused before any mutation is built
```

### An oversized paste fails cleanly
```
GIVEN a copied subtree of 250 bloks
WHEN it is pasted
THEN store.tx refuses it with the existing too-many-changes message, nothing is
     inserted, and the undo stack is untouched
```

### Duplicate a document
```
GIVEN a published page 'About' with a draft that differs from what is live
WHEN it is duplicated
THEN a new story 'About (copy)' exists at path about-2, unpublished, with no versions
AND its document matches the source's DRAFT, with every uid re-allocated
AND the source is untouched
AND opening the copy shows the same content and can be published independently
```

### Duplicating the root
```
GIVEN the root story
WHEN it is duplicated
THEN a top-level page is created with a slug derived from its title, and the root
     story still owns ''
```

### No cross-document uid collisions
```
GIVEN a document duplicated twice
THEN no uid appears in more than one of the three documents
```

## Implementation plan

### Phase 1 — core

1. `core/clone.ts`: `cloneSubtree`, `cloneDoc`, sharing `allocateSubtree` with
   `field-defaults-and-presets.md`.
2. `core/clipboard.ts`: `parseClipboard`, reusing `isBlok` and the schema's `allow`
   rules.
3. Export both from `folio/engine` — they manipulate documents, which is what that
   entry point is for.
4. Tests: `test/unit/core/clone.test.ts` — deep subtrees, uid freshness and internal
   consistency, order placement, every field kind carried verbatim, `i18n` carried;
   `clipboard.test.ts` — every refusal path, including a payload whose nested types
   violate their parents' slots.

### Phase 2 — admin: blocks

1. `useBlocks.ts`: `duplicate(uid)`, `copy(uid)`, `paste(text)`.
2. `BlockTree.tsx`: per-row Duplicate and Copy actions, disabled with a reason when the
   slot is full; `Inspector.tsx` header gains Duplicate beside Delete.
3. A `useClipboardShortcuts` hook beside `useUndoShortcut`: `Cmd+C`/`Cmd+V` when the
   focus is not in a text input (a copy inside a richtext field must still copy text —
   this is the one fiddly part, and the rule is: only handle the shortcut when the
   active element is not an input, textarea or contenteditable).
4. Notices through the existing `useNotice` channel.
5. Tests: `test/unit/admin/` — one transaction per duplicate, selection afterwards,
   the input-focus rule, every refusal surfacing a message.

### Phase 3 — server: documents

1. `server/stories.ts`: `duplicateStory(db, id, patch)` — row creation, returning the
   source's `type` and title.
2. `routes/stories.ts`: `POST /stories/:id/duplicate`, refusing singletons, seeding the
   new object with the clone.
3. `StoryTree.tsx`: a Duplicate action per row, and a confirmation that names where the
   copy will land (especially for the root case).
4. Tests: `test/workers/stories.test.ts` — draft-not-published copied, slug dedupe, no
   versions, uid re-allocation, singleton refusal, and the row-first ordering (a failed
   seed leaves a blank-document story, not an orphan object).

### Phase 4 — docs

1. `README.md`: a short section, and `cloneSubtree`/`cloneDoc` in the `folio/engine`
   list.
2. `PARITY.md`: strike the Phase 5 duplicate/copy-paste items.

## Edge cases

- **Copy, then the original is deleted by another editor, then paste** → the clipboard
  holds full bloks, not references, so the paste works. This is why the payload carries
  blocks rather than uids.
- **Paste into a document whose root type differs** → irrelevant: validation is per
  slot and per type, not per document type. A `hero` pastes into any slot that allows
  heroes.
- **Paste from a newer version of the site** (a block type since removed) → refused,
  naming the type.
- **Paste of a subtree whose child violates its parent's `allow`** (hand-edited
  clipboard) → refused. Validation walks the whole payload, not just the top blok.
- **Duplicating a block while another editor edits it** → the clone is a snapshot of
  the document the duplicating client holds; concurrent edits to the original do not
  follow the copy. Expected, and the same semantics as any read-then-write.
- **Two editors paste the same clipboard simultaneously** → different uids, two copies.
  Correct: they each asked for one.
- **Duplicating a document with unpublished changes** → the draft is copied
  (decision 4), which is what the editor sees. Worth saying in the confirmation.
- **Duplicating a record** (`../content-model/data-documents.md`) → works unchanged;
  records are ordinary documents. `uniqueSlug` scopes by type for them.
- **A slot's `max` of 1 and a duplicate action** → disabled with "this slot holds one
  block".
- **Clipboard containing 5 MB of blocks** → `parseClipboard` caps the payload
  (proposed: the same `MAX_FRAME_BYTES` ceiling) before parsing, for the same reason
  the Durable Object checks frame size before `JSON.parse`.

## Testing requirements

**Unit:** `cloneSubtree`/`cloneDoc` (structure, uids, orders, every field kind, `i18n`);
`parseClipboard` refusals; the admin's one-transaction guarantee and the
input-focus rule for shortcuts.

**Workers:** document duplication end to end — row, seeded object, no versions, slug
dedupe, singleton refusal.

**End to end (extend `scripts/sync-test.mjs`):** two clients on one story; one
duplicates a subtree; assert the other receives a single transaction containing every
blok and that both documents converge. Cheap to add to a script that already drives two
clients.

## Dependencies

- None. Shares `allocateSubtree` with `field-defaults-and-presets.md`.
- `../foundation/document-types.md` adds the singleton refusal and per-type slug
  scoping afterwards.

## Out of scope

- **Copying a block *into* another site** (a shared block library across Folio
  installs). The payload is portable enough that it would often work; making it a
  supported feature means versioning the clipboard format and mapping schemas.
- **Reusable / linked blocks** (edit once, appears in five places). That is a
  reference, and `../content-model/data-documents.md` plus `globals.md` cover the two
  honest versions of it. A copy is a copy.
- **Multi-select** (copy five blocks at once). The clipboard payload is already an
  array, so it is forward-compatible; the tree's selection model is single-uid and
  changing that is its own piece of work.
- **Duplicating a subtree into a different slot in one action** (copy-to-slot). Paste
  covers it in two steps.
- **Duplicating a document with its descendants** (copy a whole section of the tree).
  A loop over the same route, and worth adding once someone asks — but the
  confirmation, the slug derivation and the partial-failure story all need care, so it
  is not smuggled in here.

## Implementation notes

Built in four phases, each committed green: core (`core/clone.ts`, `core/clipboard.ts`),
admin blocks (`useBlocks`, `BlockTree`, `Inspector`, `useClipboardShortcuts`), server
documents (`duplicateStory`, `POST /stories/:id/duplicate`, `StoryTree`,
`DuplicateDialog`), then docs. All five owner decision checkpoints landed as written.
64 tests added (32 unit core, 20 unit admin, 12 workers) plus 4 new `scripts/sync-test.mjs`
checks run live against a real dev server (16/16). Baseline 764 → 828.

**What shipped, versus the spec's own sketch:**

- `cloneSubtree`/`cloneDoc` (`core/clone.ts`) do **not** carry a subtree's original
  `order` strings forward, unlike architecture decision 1's prose ("descendants keep
  their own order strings unchanged"). Spec 5 (`field-defaults-and-presets.md`) landed
  first and built `allocateSubtree` as the shared uid *and* fractional-order allocator,
  with the explicit instruction (recorded in that spec's carryover notes) that this spec
  call it directly rather than write a second allocator. `allocateSubtree` always
  re-derives fresh, sequential fractional keys per `(parent, slot)` group in the
  recipe's own array order — so `cloneSubtree` walks each level via `childrenOf` (already
  sorted by `compareSiblings`) to build that array in the *correct* sibling order, and
  the fresh keys it gets back preserve relative order without reusing the old strings.
  The observable behaviour the acceptance criteria actually ask for — sibling order is
  preserved, orders are valid fractional keys — holds; only the mechanism differs from
  the sketch.
- The route pseudocode in "Architecture decision 4" passes a `type` field through to
  `createStory`. No such field exists: no document-type concept has landed yet
  (`../foundation/document-types.md` is later in the build order), so `duplicateStory`
  does not pass one. `cloneDoc` already carries the source's root block `type` forward
  as part of the document itself, which is what actually matters here.
- Singleton refusal (decision 5's second paragraph) is deliberately not implemented:
  there is nothing to check a singleton against yet. `document-types.md` owns adding it.
- `i18n` (mentioned in architecture decision 1's "translations" bullet) does not exist
  on `Blok` yet — `localisation.md` hasn't landed. Nothing needed doing; `data` is
  copied verbatim regardless of what fields it holds, so a future `i18n` map (if it
  ends up living in `data`) already carries through for free, and if it ends up as a
  sibling field on `Blok` instead, that spec will need to teach `subtreeRecipe` about it.
- The paste target's slot `allow`/`max` checks and `parseClipboard`'s internal
  type/slot-conformance checks are split as the spec's own core-type signature implies
  (`parseClipboard(text, schema)` takes no target): `parseClipboard` validates the
  payload's own internal structure; `pasteInsert` (`useBlocks.ts`, a new pure function
  alongside `subtreeInsert`) resolves and validates the destination. Internal `max`
  violations inside a hand-edited clipboard (as opposed to `allow` violations, which
  are checked) are not walked — only the destination slot's `max` is checked, matching
  the acceptance criteria's own oversized-paste and full-slot scenarios.
- Every refusal (duplicate, paste, slug/parent errors) surfaces through the existing
  `useNotice` toast; `useBlocks` gained two required parameters (`notify`, `storyPath`)
  as a result, with `Editor.tsx` as the only call site to update.
- Not implemented: multi-select copy, cross-site paste as a supported feature, and
  duplicating a document with its descendants — all called out in "Out of scope" above
  and left that way.
