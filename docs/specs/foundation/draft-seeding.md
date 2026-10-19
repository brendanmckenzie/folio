# Feature: A draft seeds from what is published

> **Group:** foundation
> **Build order:** 27, per docs/specs/README.md
> **Size:** M
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-10-19

## Summary

A story whose D1 row arrives without its Durable Object, which is what copying a
database between environments does every time, used to get a **blank draft with a
fresh root uid** on first editor open. From there every supported write was closed:
`diff` refuses documents with different roots, so `POST /documents/:id/restore` and
`PUT /documents/:id/content` both failed, and the admin's Restore button reported
`Cannot diff documents with different roots`, which names the mechanism and not the
cause. The document was unrecoverable through the product.

Found on a live staging environment 2026-08-30, where all twelve documents were in
this state: `published_doc` and `versions` intact, every draft blank.

Two changes, both built (issue #28):

1. **A cold object seeds from D1.** When a story's object holds no document, its
   draft is seeded from `published_doc`; if that is null, from the newest `versions`
   row (migrated on read); if the story has neither, from the blank seed it gets
   today. The D1 read happens only on that cold branch.
2. **Restore re-roots its target.** `restoreVersion` rewrites the version's document
   onto the live draft's root uid before diffing, so a restore across differing roots
   succeeds. This repairs documents that are already broken on a live deployment: an
   object seeded blank before this shipped holds state, so point 1 never fires for it.

## Ground truth

Verified against `main` at `6ecbcc0`.

**the seed (`src/server/runtime.ts`):**
- `seed(type, title)` builds a blank subtree with `blankSubtree` and returns
  `{ root: root.uid, bloks: ... }`. **The root uid is minted, not derived from the
  story id**, so purging an object and reopening it produces a *third* uid rather
  than recovering the first.
- Every draft read of an existing id reaches the object through `initDraft` (below),
  via `draftFor`, `draftForWithSyncId`, `draft`, and the two draft-mode resolve sites
  that read references and layers on a branded deployment.

**the object (`src/server/story-do.ts`):**
- `getOrInitWithSyncId(seed, baseline = 0)` is `const row = this.read(); if (row)
  return row;` then an insert. **The seed is used only when the object has no doc.**
- `head()` is `this.read()?.syncId ?? 0`. **It cannot distinguish "no document" from
  "a document nobody has edited"**, so it is not a usable "has this been initialised"
  probe. `peek()` is.
- `log.sync_id` is `integer primary key autoincrement`; `applyTransaction` takes the
  new `syncId` from `last_insert_rowid()`.
- The client refuses a non-contiguous delta (`admin/store.ts`), and hello offers a
  catch-up whenever `0 < behind <= MAX_CATCHUP`.

**the badge:** `draft_sync_id > published_sync_id` reads `changed` (`STATE_EXPR`,
`server/stories.ts`). Both columns copy with the database; the object's own position
does not.

**the guard that closes every write (`src/core/diff.ts`):** `diff` throws when
`from.root !== to.root`. That is correct: two documents with different roots have no
mutation path between them, because **no mutation can change a root uid** (`root` is
a field on `Doc`, not a blok). The assumption it rests on, that a story's root never
changes, holds for a document created through Folio and not for one whose row was
imported.

**restore:** `restoreVersion` (`src/server/write.ts`) is shared by
`POST {base}/api/story/:id/restore` and `POST /api/v1/documents/:id/restore` (and MCP's
`restore_version`). It reads the draft once, takes a "before restore" checkpoint, and
diffs.

**seeding from real content already exists** for a *new* id: duplicating a document
and creating one with content both call `getOrInit(content)` directly. Those stay
direct, because there is nothing in D1 to seed from.

## Owner decision checkpoints

1. **A repaired document's draft equals its published copy, not its pre-break
   draft.** Unpublished changes made in the source environment never crossed the
   wire, so they are gone. A row that arrives `changed` reads `changed` until its next
   publish (see "The log position").

2. **Shape decided 2026-10-19.** Seed from D1 on a cold object, and re-root on
   restore. A route that purges and re-seeds an existing object, and a deterministic
   root uid, were both rejected.

## User stories

### An operator copies production content into staging
**As** a developer refreshing a staging environment from a database export **I want**
the editor to show the content that is in the database **so that** staging is usable
without knowing that Durable Objects exist.

### An editor opens a page that has never been edited here
**As** an editor **I want to** open an imported page and see its published content in
the editor **so that** I can change one line rather than rebuild the page.

### An operator repairs an environment already in this state
**As** a developer holding blank drafts that were seeded before this fix **I want** to
restore the newest publish from History **so that** the fix is not a hand-written
script against internals.

## Architecture decisions

### 1. A cold object seeds from `published_doc`, then the newest version, then blank

The object's `doc` table has no row with `id = 1`: that is `this.read()` returning
null, and nothing else. The cold path then reads D1 and seeds from it only when **the
`stories` row exists**.

- **`published_doc` first.** It is already at the row's `schema_id` (the migration
  runner migrates it and the draft together), so it needs no migration, and it is
  exactly what the site serves. The draft equals live.
- **The newest version second**, ordered `created_at desc, id desc` (the History
  rail's own order), fetched through `getVersion` with the brand's migrations, so a
  version written under an older model comes up to the brand's newest migration. This
  is the branch for a story with no `published_doc`: never published, or unpublished,
  which nulls `published_doc`.
- **Blank last**, as today.

Not "newest of the two". A version newer than the publish is a `checkpoint`, a
snapshot of some draft state. Preferring it would make what the editor opens depend
on whether somebody happened to checkpoint before the copy, which an operator cannot
predict. It remains one click away in History.

Rejected: **leaving it blank and documenting the workaround.** The workaround is a
`PUT /content` with an omitted root uid, discovered by reading `core/nested.ts`. A
recovery procedure nobody can find from the error message is not a recovery procedure.

Rejected: **seeding from versions only.** Published is what the site serves and needs
no migration; a version is history.

### 2. The object gains `peek`, so the cold path pays and the warm path does not

`StoryStub` gains `peek(): Promise<{ doc: Doc; syncId: number } | null>`, the
existing `this.read()`. `initDraft` in `runtime.ts` is peek, then (cold only) one D1
read, then `getOrInitWithSyncId(source ?? fallback, baseline)`. The warm path is one
RPC exactly as before (and ships no seed over the wire); the cold path is two RPCs and
one D1 read (two for a version seed), once per object.

The blank `fallback` stays eagerly computed by each caller, so `seedFor`'s "a layer
with no registry throws" keeps throwing on every call and not only on a cold one.

Rejected: **a lazy `() => Promise<Doc>` over RPC**, which makes the object call back
into the Worker mid-write. Rejected: **probing with `head()`**, which reads 0 for a
seeded, untouched document and would re-seed it on every open.

### 3. The race is already handled

Two cold reads both `peek` null, both read D1, both call `getOrInitWithSyncId`; the
object's `read()`-then-insert returns the winner's row to the loser. Both seeds are the
same document, except a blank fallback, whose random root is the existing race.

A cold read that read the row before `deleteDocument` and inserts after its purge
leaves a seeded object behind a deleted row. Today the same interleaving leaves a
blank one. Neither is reachable, so it is accepted.

### 4. The log position: a seed from D1 starts at the row's own watermark

Seeding at `sync_id 0` under a copied row breaks the badge: a row that arrives with
`draft_sync_id 57, published_sync_id 50` would see its first edit write
`draft_sync_id 1`, and `1 > 50` is false, so a page with real unpublished edits reads
`live`. A publish without an edit would stamp `published_sync_id 0` under a
`draft_sync_id 57` and read `changed` forever.

So a cold seed from D1 starts the log at **`baseline = max(draft_sync_id,
published_sync_id)`**, and the next transaction is `baseline + 1`. A baseline of 0
(every story created through Folio, every blank seed of a fresh row) is byte-for-byte
the old code path. To guarantee `baseline + 1` without writing `sqlite_sequence`,
the object inserts sentinel `log` rows inside `transactionSync` (one autoincremented,
one at the explicit `sync_id` if that is higher), deletes both, and inserts the doc
row at that position. The sentinels never survive, so the activity trail, `hasTx` and
catch-up never see them.

**Hello does not offer a catch-up across a gap.** With a baseline the log has no rows
at or below its position, so a hello at `0 < lastSyncId < position` would have been
answered "caught up" with no deltas. Hello now sends `catchup` only when `since()`
returns exactly `behind` rows, else `bootstrap`. Bootstrap is always correct.

A row that arrived `changed` reads `changed` while its draft equals its publish: that
is the existing "settled" state (`SETTLED_TITLE`), which the admin already explains.
Clearing it eagerly would take a D1 write on a read path.

### 5. A preview takes the same cold path, and it is not a write

A draft-mode resolve, a `GrantActor` and a share all reach the cold path and seed the
object. "A preview never writes" is a rule about D1 (layer rows via `ensureSingleton`,
any `{base}/api` write); the cold path issues one or two D1 reads and the object-local
insert a preview already performs today with a blank seed, and schedules no watermark
alarm. Seeding blank on a preview was the bug, not the safe option: it froze the wrong
document into the object.

**A deleted story seeds nothing.** The query is anchored on `stories`, so an orphaned
`versions` row cannot resurrect content, and the draft-mode `known.has` filter that
stops a deleted reference being asked for its draft at all is untouched. A **new**
story seeds from the caller's content through a direct `getOrInit`.

### 6. Restore re-roots its target

`rerootOnto(target, root)` in `src/core/diff.ts`, beside `diff`: same root returns the
target itself; otherwise `uid`, `parent` and the map key of the old root become the
live root, and nothing else changes (`data`, `i18n` and links hold values and story
ids, not blok uids). A collision with an existing block throws. It is the *target* that
moves, never the live document. **Not added to `folio/engine`**; it is internal, so the
`exports` surface does not change.

It runs inside `restoreVersion`, on the draft that function read, never a second read.
A version whose root block is a **different type** is refused `409 conflict` there:
`diff` skips a root retype and the schema-agnostic object would accept one type's
fields onto another's root. The admin's version *comparisons* (`useVersions`'s
"viewing a version" delta and `usePublishedDoc`'s `publishedDelta`) call `rerootOnto`
before diffing so they show the real difference instead of nothing.

Rejected: **a reseed route that purges and replaces an object.** Re-rooting repairs an
already-broken document through an ordinary transaction that is recoverable from its
"before restore" checkpoint, so a route that destroys state is not needed.

Rejected: **relaxing `diff`'s root guard**, and **rewording its error**: with both
restore paths re-rooting, the only remaining way to hit the throw is a `PUT /content`
payload naming the old root, which `fromNested` refuses with its own message.

Rejected: **a deterministic root uid derived from the story id.** It changes nothing
for a copied database, whose `published_doc` and `versions` carry the source
environment's random root.

## Wire & schema changes

None. No migration, no `PROTOCOL_VERSION` bump, no `exports` change, no new
`createFolio` key. `StoryDO` gains `peek` and a defaulted `baseline` parameter; it is
the same class, so no Durable Object migration tag.

## Acceptance criteria

### An imported story opens with its content

```
GIVEN a stories row with published_doc and no Durable Object state
WHEN the editor opens that document
THEN the draft equals the published document, root uid included
AND a subsequent restore or PUT /content succeeds
```

### The version fallback

```
GIVEN a row with no published_doc and versions
WHEN its draft is first read
THEN it is seeded from the newest version, migrated to the brand's newest migration
```

### Nothing else seeds from D1

```
GIVEN a new story, a deleted story, or a preview of a cold row
THEN a new story keeps its caller's content, a deleted story seeds blank,
AND a preview issues no D1 write
```

### The warm path costs nothing extra

```
GIVEN a document whose object already holds a draft
WHEN its draft is read
THEN no D1 seed read is made, and a later change to published_doc does not change it
```

### The badge and the log

```
GIVEN a row seeded at draft_sync_id 57, published_sync_id 50
THEN the object's position is 57 and its next transaction is 58
AND publishing without an edit reads live
AND a hello from inside the gap is answered with a bootstrap
```

### Restore across roots

```
GIVEN a version whose root uid differs from the live draft's
WHEN it is restored
THEN it succeeds as one transaction, and the live root is unchanged
GIVEN a version whose root block is a different type
THEN it is refused 409 and nothing is written
```

## Implementation plan (as built)

1. `story-do.ts`: `peek()`, `getOrInit(seed, baseline)`, the sentinel baseline, the
   hello contiguity check; `types.ts` adds `peek` to `StoryStub`.
2. `core/diff.ts`: `rerootOnto`; `diff`'s comment says what holds the root invariant.
3. `server/versions.ts`: `draftSeedSource(db, id, migrate)`, one statement anchored on
   `stories`, taking `FolioDb`.
4. `server/runtime.ts`: `initDraft`, used by `draftFor`, `draftForWithSyncId`, `draft`
   and the two branded draft-mode resolve sites.
5. `server/write.ts`: the root-type check and `rerootOnto` inside `restoreVersion`;
   `useVersions.ts` and `usePublishedDoc.ts` re-root before comparing.
6. Tests, `docs/handbook.md`, `UPGRADING.md`, `AGENTS.md`, `CLAUDE.md`.

## Edge cases

- **`unpublish` clears `published_doc`** (and sets `unpublished_at`), so an
  unpublished story falls to the version branch, not to blank.
- **A version under an older `schema_id`** is migrated on seed only up to the *row's*
  `schema_id`, not to the newest migration. `runMigrations` computes what is due from
  that column and applies it to the draft, so seeding past it would apply the gap
  twice and corrupt a non-idempotent `up`. The normal migrate path finishes the job.
- **A record or singleton** (no path) is treated identically.
- **A purged object whose sequence is already higher than the baseline** seeds at the
  higher position, which is a deleted story and harmless.
- **A story already seeded blank before this fix** is not healed: its object holds
  state. Restore the newest publish from History.

## Testing requirements

**Unit:** `rerootOnto` (identity, rename and re-parent, no mutation of input,
collision throws, `diff` round trip) in `test/unit/core/diff.test.ts`; a
`publishedDelta` case across differing roots in `test/unit/admin/published-doc.test.ts`.

**Workers (real workerd):** `test/workers/draft-seeding.test.ts` simulates the missing
object by inserting D1 rows directly: published source, version-only source, migrated
version, blank fresh row, baseline and badge, publish-without-edit, hello across the
gap, warm path, concurrent cold opens, a new story, a deleted story, and a preview
that records no write. `test/workers/api.test.ts` covers restore across roots and the
409 on a root type change.

**End to end:** not needed beyond the existing sync and history scripts; the condition
is a database state, which a workers test creates exactly.

## Dependencies

None. Sequenced independently of 23; it changes no list route.

## Out of scope

- **Recovering the pre-break draft.** It never crossed the wire. Checkpoint 1.
- **Copying Durable Object state between environments.** There is no API for it, and
  seeding from D1 makes it unnecessary.
- **Healing objects already seeded blank**, beyond the restore procedure.

## Implementation notes

Built 2026-10-19 for issue #28.

**What landed:** everything in the plan above, with no D1 migration, wire bump or
export change. Tests: `test/workers/draft-seeding.test.ts` (12), two restore tests in
`api.test.ts`, five `rerootOnto` unit tests and one `publishedDelta` test. Each fix was
broken in turn to confirm the tests fail: disabling the D1 seed fails eight of the
twelve seeding tests, removing the re-root fails the cross-root restore test, and
dropping the hello contiguity check fails the gap test.

**Where the plan was wrong:**

- **Restore had moved server-side** (PR #50) after the plan was written. `rerootOnto`
  and the root-type check live in the shared `restoreVersion`, not in the admin Restore
  button, and cover `{base}/api/story/:id/restore`, `/api/v1` restore and MCP at once.
  The admin keeps `rerootOnto` only for its two version comparisons. "Undo a restore"
  is restoring the "before restore" checkpoint, not Cmd+Z, and `UPGRADING.md` says so.
- **The hello contiguity test needed a gap of the right shape.** A hello at
  `lastSyncId 3` against a baseline of 57 is refused by `behind > MAX_CATCHUP`
  regardless, so it passed with the fix removed; the test uses `lastSyncId 50`, which
  is inside the catch-up window and over an empty log.
- **A rename migration empties the old key rather than deleting it**, so the migrated
  version test asserts the old value is gone, not that the key is absent.
- **The preview test uses a single-site global**, not a reference. The draft-mode
  global path calls `ensureSingleton` for an *existing* row (no write) and then
  `draftFor`, which exercises the same cold path; the branded sites reach it through
  the same `initDraft`.
- Superseded and removed: the `POST /documents/:id/reseed` route, its blank-draft guard
  and `force`, the reworded `diff` error, and the `FolioError` translation of the root
  mismatch.
