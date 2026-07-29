# Feature: Unpublished changes — draft state made visible, and reversible

> **Group:** editing
> **Build order:** 3
> **Size:** S (phase 1) + S (phase 2)
> **Status:** done
> **Wire version:** none
> **Migration:** `0005_draft_watermark.sql` (phase 2 only)
> **Last updated:** 2026-07-29

## Summary

Folio already saves without publishing: every keystroke lands in the story's
Durable Object draft, and `publish()` is a separate snapshot into
`stories.published_doc`. What is missing is any way to *see* that, or to undo it.
An editor cannot tell whether the page they are looking at matches the live site,
cannot see what would go out if they hit Publish, cannot tell which of thirty
pages have work sitting in them, and cannot throw draft work away and go back to
what is live.

The machinery for all four already exists and points at the wrong document.
`diff()`, `summariseDiff()`, the read-only preview and the restore-as-a-transaction
path were built for **versions** (`src/admin/hooks/useVersions.ts`), and every
publish writes a version (`src/server/publish.ts`). So "compare the draft with
what is live" is the version machinery aimed at the newest `publish` version, and
"discard my changes" is a restore of it.

## Ground truth

**server (`packages/folio/src/server/`):**
- `publish()` (`publish.ts`) batches a `versions` row and the
  `stories.published_doc` update in one `db.batch`, so **every publish is a
  retained version** and the newest `kind = 'publish'` version row is always
  byte-identical to `published_doc`.
- `stories` columns (`migrations/0001_initial.sql`): `published_doc`,
  `published_at`, `updated_at`. `updated_at` is written by `updateStory` and by
  publish — **not** by document edits, which never touch D1 at all.
- `listVersions` (`versions.ts`) is newest-first and omits the `doc` payload;
  `getVersion` returns `{ meta, doc }`.
- The live draft lives only in `StoryDO`'s own SQLite (`story-do.ts`, `doc` table
  with a `sync_id` column). Nothing outside the object can see that syncId
  without opening it: `getOrInit` returns the `Doc` alone.
- `StoryDO` takes `env` and ignores it (`super(ctx, env as never)`), so it has no
  D1 handle today.

**admin (`packages/folio/src/admin/`):**
- `StoryTree.tsx:119` already renders a `draft` badge, but its condition is
  `!node.publishedAt` — "never published", not "has unpublished changes". A page
  published once and edited since looks clean.
- `useVersions.ts` owns: `view()` (push a document into the preview iframe
  read-only), `delta` (`summariseDiff(diff(liveDoc, viewing.doc))`), `restore()`
  (diff live against target, refuse over `MAX_TX_MUTATIONS`, apply as one
  `store.tx`, report "Cmd+Z to undo").
- `TopBar.tsx` shows connection state (`Synced` / `Saving…` / `Connecting…`) and
  a Publish button disabled only while publishing or while a version is on
  screen. There is no "nothing to publish" state.
- `usePublish.ts`'s own comment already claims a publish "changes the tree's draft
  badge" — which is only true for a first publish.
- `store.ts` holds `base` (last server-confirmed doc) plus `pending`, and exposes
  the replayed view as `state.doc`.

**tests:**
- `test/unit/core/diff.test.ts` (551 lines) covers diff emission order and
  round-tripping, including property tests for the rescued-children case.
- `scripts/history-test.mjs` (19 checks) covers publish writing a version, list
  ordering, minimal restore diffs and that a restore leaves the published page
  untouched until re-published.

## Owner decision checkpoints

1. **Discard is a restore, not a delete (recommended).** "Discard unpublished
   changes" applies `diff(draft, published)` as one ordinary transaction, so it
   syncs to other editors, lands in the activity trail and Cmd+Z brings the work
   back. The alternative — resetting the DO's document row — would be a silent
   overwrite that other editors would see appear from nowhere and nobody could
   undo. Cost of the recommendation: a discard is itself a change, so the page is
   "changed since publish" again straight after discarding until the diff is
   recomputed (it recomputes to empty, so this is invisible in practice).
2. **Publish is disabled when there is nothing to publish (recommended).** It
   also stops the `versions` table growing on repeat clicks, which `ROADMAP.md`
   lists as unbounded. Overriding this means keeping "publish anyway" for the case
   where someone wants a fresh timestamp.
3. **Phase 2's tree-wide badge needs the Durable Object to write to D1
   (recommended).** A tree render cannot open thirty Durable Objects to ask each
   one whether it is dirty. The alternative — a per-row `head()` RPC — costs one
   object wake-up per visible row on every tree load. Scheduled publishing (the
   next item in `ROADMAP.md`) needs the same D1 handle in the object, so the cost
   is shared.

## User stories

### Editor knows whether what they see is live
**As** an editor **I want** the editor to tell me that this page has changes that
are not on the live site **so that** I do not assume my work went out, and do not
publish a page I was only halfway through.

### Editor sees what publishing would do
**As** an editor **I want to** see a summary and a read-only preview of what is
currently live before I publish **so that** I can check the difference rather
than trusting my memory of what I changed.

### Editor throws away a draft
**As** an editor **I want to** discard unpublished changes and go back to what is
live **so that** an experiment I do not like does not have to be unpicked by hand.

### Editor finds the work in progress
**As** an editor coming back on Monday **I want** the content tree to show which
pages have unpublished changes and when they were last touched **so that** I can
find what I left half-done.

## Architecture decisions

### 1. "Published" is the newest `publish` version, not a second read of `published_doc`

`publish()` writes both in one batch, so the two cannot disagree. Using the
version row means the whole comparison rides on routes that already exist
(`GET /folio/story/:id/versions`, `GET /folio/versions/:versionId`) and on
`useVersions`'s existing fetch-and-cache, rather than adding a
`GET /folio/story/:id/published` that would return the same bytes by a second
path. A story that has never been published has no `publish` version, which is
exactly the state the existing `!publishedAt` badge already describes.

### 2. Divergence is computed from the diff, not tracked as a flag

`diff(published, draft)` is already the authority on "how do these differ", it is
already property-tested, and `summariseDiff` already produces the phrasing
("3 edited, 1 added"). A separate dirty flag maintained on write would be a second
source of truth that can drift from the documents it describes — and it would be
wrong the moment someone edits a field back to its published value, which the
diff gets right for free.

### 3. The tree-wide badge is a watermark comparison, not a diff

Phase 2 wants the badge on rows whose documents are not loaded. Diffing thirty
documents to render a tree is absurd, so the tree compares two integers:
`stories.draft_sync_id` (the DO's log position) against
`stories.published_sync_id` (the position that was published). Greater means
changed. This is deliberately *coarser* than the diff: an edit that cancels itself
out leaves the watermark ahead, so a row can read "changed" while the open-page
diff is empty. That is the right trade — the tree is a "look here" hint, and the
open page is authoritative — and the open page's diff overrides the badge for the
story being edited.

### 4. The Durable Object writes its watermark on a debounced alarm

Writing to D1 per transaction would put a D1 write in the keystroke path, which
is exactly what the local-first design exists to avoid. Instead `StoryDO`
schedules an alarm ~2 s after the last logged transaction and, when it fires,
writes `draft_sync_id` and `draft_updated_at` once for the whole burst. A minute
of typing costs one D1 write. The badge is therefore eventually consistent by a
couple of seconds, which nobody can perceive in a tree they are not looking at.

To do that the object needs a D1 handle, and `StoryDO` currently discards `env`.
`createFolio`'s `bindings` accessor is the host's contract for env → bindings, but
a Durable Object is constructed by the runtime with the raw host env and never
sees that config. So the class becomes a factory:

```ts
// host worker
export const StoryDO = createStoryDO<Env>({ db: (env) => env.DB })
```

`export { StoryDO } from 'folio/server'` keeps working as a default that reads
`env.DB` by convention, so the demo and any existing host need no change until
they want a differently-named binding. Scheduled publishing needs precisely this
handle, so it is not a cost this feature invents.

### 5. Discard reuses `restore`, and is not a new code path

`useVersions.restore(version, preloadedDoc)` already does the whole job: diff,
refuse over `MAX_TX_MUTATIONS` with a readable message, leave version-preview
mode, `store.tx`, report the summary and that Cmd+Z undoes it. Discard is a
button that calls it with the newest publish version. The only new code is the
confirmation copy.

## Wire & schema changes

### D1 migration `0005_draft_watermark.sql` (phase 2)

```sql
-- The Durable Object's log position, mirrored into D1 by a debounced alarm so
-- the content tree can show which pages have unpublished changes without
-- opening every object. Coarser than a diff on purpose: see the spec.
alter table stories add column draft_sync_id integer not null default 0;
alter table stories add column draft_updated_at integer;
-- The log position that was published. Set by publish() in the same batch as
-- published_doc, so the two can never disagree about what is live.
alter table stories add column published_sync_id integer not null default 0;

create index if not exists stories_draft_updated on stories (draft_updated_at desc);
```

`default 0` on both watermarks makes an existing database read "nothing changed
since publish" rather than "everything changed", which is the safer wrong answer
for rows written before this column existed. The first edit to any story corrects
it.

### Core / server types

- `StoryMeta` gains `draftSyncId: number`, `draftUpdatedAt: number | null`,
  `publishedSyncId: number`, and a derived `hasUnpublishedChanges: boolean`
  computed in `stories.ts`'s `COLS` projection rather than in the admin, so the
  tree, the content API and any host reading `folio.stories(env)` agree.
- `StoryDO.getOrInit` keeps its signature. A new RPC `head(): Promise<{ syncId:
  number }>` is added for callers that need the position without the document
  (phase 1 uses it to decide whether to bother diffing).
- `publish()` returns `publishedSyncId` alongside `publishedAt`, taken from
  `head()` inside the same call that reads the draft.

### Routes

No new routes in phase 1. Phase 2 adds nothing either: the watermarks ride on the
existing `GET /folio/stories` tree payload.

## Acceptance criteria

### The open page reports its divergence
```
GIVEN a story published once and edited since
WHEN the editor loads it
THEN the top bar reads "3 unpublished changes" (edited/added/removed/moved counts
     from summariseDiff)
AND the Publish button is enabled
```

### A clean page says so
```
GIVEN a story whose draft is identical to its newest publish version
WHEN the editor loads it
THEN the top bar reads "Up to date"
AND the Publish button is disabled with the title "No changes to publish"
```

### Editing a value back to its published state clears the state
```
GIVEN a story with one changed heading
WHEN the editor types the published heading back into the field
THEN the count returns to zero and Publish disables again
```

### Comparing against live
```
GIVEN a story with unpublished changes
WHEN the editor clicks "3 unpublished changes"
THEN the published document is pushed into the preview iframe read-only,
     the inspector goes read-only and Publish is disabled — the same mode a
     version preview already enters
AND the banner reports how the draft differs from what is live
AND "Discard changes" is reachable only from that banner
```

### Discarding
```
GIVEN a story with unpublished changes and a second editor connected
WHEN the first editor discards them and confirms
THEN one transaction lands carrying diff(draft, published)
AND the second editor's document and preview update live
AND the change appears in the activity trail
AND Cmd+Z restores the discarded work
AND the live page is unchanged throughout (nothing was published)
```

### Never-published stories
```
GIVEN a story that has never been published
WHEN the editor loads it
THEN the state reads "Not published yet", the tree keeps its existing "draft"
     badge, and Discard is unavailable (there is nothing to go back to)
```

### The tree finds work in progress (phase 2)
```
GIVEN story A edited 10 minutes ago and published 5 minutes ago,
      and story B edited 10 minutes ago and last published yesterday
WHEN the content tree loads
THEN B carries an "unpublished changes" marker and A does not
AND no Durable Object is opened to render the tree
```

### The watermark survives a publish race
```
GIVEN an editor typing into story B
WHEN a publish runs while a transaction is in flight
THEN published_sync_id records the position of the document that was actually
     snapshotted, so the transaction that landed after it leaves B marked changed
```

## Implementation plan

### Phase 1 — the open story (no migration, no wire change)

1. **`StoryDO.head()`** in `src/server/story-do.ts`: `select sync_id from doc`.
   Add to the `StoryStub` pick in `server/types.ts`.
2. **`usePublishedDoc`** hook (`src/admin/hooks/`): finds the newest
   `kind === 'publish'` entry in the list `useVersions` already loads, fetches its
   document once, caches it by version id, and invalidates on publish. Returns
   `{ published: Doc | null, delta: summariseDiff | null }` computed against the
   live doc with `diff`.
   *Note:* `useVersions` only loads its lists when the History rail is open
   (`active`). The publish-version lookup must not depend on that, so the version
   list fetch moves up into `Editor.tsx`'s composition and both hooks read it.
3. **`TopBar.tsx`**: replace the bare `Synced` label with a state machine —
   `Connecting…` / `Saving…` / `Up to date` / `N unpublished changes` /
   `Not published yet`. Clicking the changed state enters the comparison view.
   Publish gains `disabled` on the clean state.
4. **Comparison view**: `useVersions`'s `view()` already accepts a version; call
   it with the newest publish version so the whole read-only mode is reused.
   `ViewingBar.tsx` gains a "Discard changes" action (confirm dialog naming the
   counts) that calls `restore()` with the same version.
5. **Tests**: `test/unit/admin/` for the delta hook (clean, dirty, edited-back,
   never-published); extend `test/unit/admin/viewing-bar.test.ts` for the discard
   affordance; extend `scripts/history-test.mjs` with a discard round trip
   (publish → edit → discard → assert the draft matches published and the live
   page never changed).

### Phase 2 — tree-wide state (migration `0005`, DO gains D1)

1. **Migration `0005_draft_watermark.sql`** as above.
2. **`createStoryDO<Env>({ db })`** in `src/server/story-do.ts`, with the existing
   `StoryDO` export becoming `createStoryDO({ db: (env) => env.DB })` so hosts
   need no change. Document the binding requirement in the README's mount
   snippet.
3. **Debounced watermark write**: after a logged transaction, `ctx.storage.
   setAlarm(now + 2000)` unless one is already set; `alarm()` writes
   `draft_sync_id`/`draft_updated_at` for this story. Guard the D1 write with a
   try/catch that logs and reschedules once — a failed watermark write must never
   affect the transaction that triggered it, which has already been acknowledged.
4. **`publish()`** takes `head()` alongside the draft and includes
   `published_sync_id` in the existing `db.batch`, so it lands atomically with
   `published_doc`.
5. **`stories.ts`**: extend `COLS`, derive `hasUnpublishedChanges`.
6. **`StoryTree.tsx`**: distinguish "never published" (existing badge) from
   "unpublished changes" (new marker), and show relative `draftUpdatedAt` on
   hover. For the open story, prefer the exact diff from phase 1 over the
   watermark.
7. **Tests**: `test/workers/story-do.test.ts` for the alarm write (fake timers,
   real workerd, assert one write per burst); `test/workers/stories.test.ts` for
   the derived flag; `test/workers/http.test.ts` for publish writing the
   watermark in the same batch.

## Edge cases

- **Story restored from an old version, then not published** → the restore is an
  ordinary transaction, so the draft differs from published and the state reads
  changed. Correct: the live site still has the newer content.
- **Publish while the comparison view is open** → Publish is already disabled in
  that mode (`TopBar.tsx`'s `mode === 'viewing'` guard); on exit the delta
  recomputes to empty.
- **A diff larger than `MAX_TX_MUTATIONS`** → discard refuses with the existing
  message from `restore()`. The offer is not silently truncated.
- **Two editors, one discards** → the discard is one transaction like any other;
  the second editor sees it arrive and can undo it. No locking.
- **Watermark ahead of a no-op edit** (type a character, delete it) → the tree
  reads changed, the open page reads clean. Documented in decision 3; the open
  page wins.
- **DO purged after a story delete** → the row is gone in the same batch
  (`deleteStoryStatement` + `deleteVersionsStatement`), so no orphan watermark.
- **A story whose DO has never been touched** → `draft_sync_id` stays 0,
  `published_sync_id` 0, so the row reads clean and the existing "draft" badge
  covers the never-published case.
- **Clock skew between `draft_updated_at` and `published_at`** → both are written
  by Workers with `Date.now()`; the badge compares syncIds, not timestamps, so
  skew affects only the "last edited" hint.

## Testing requirements

**Unit:** the delta hook's four states; `diff(published, draft)` symmetry with the
existing diff property tests; the discard confirmation copy derived from
`summariseDiff`.

**Workers:** the debounced alarm (one write per burst, correct syncId, failure
does not break the tx path); `publish()` writing `published_sync_id` atomically;
`head()` on a fresh object returning 0; the derived `hasUnpublishedChanges` in the
tree payload.

**End to end (`scripts/history-test.mjs`):** publish → edit → assert changed →
compare → discard → assert draft equals published, the live page never changed,
and the discard is undoable.

## Dependencies

- None strictly. `unpublish.md` should land first anyway, so the tree's state machine
  is designed once with "not live" in it rather than gaining a state afterwards: that
  spec defines the derived `state` field and leaves the `changed` case for this one to
  fill in.
- `../foundation/document-types.md` rebuilds `stories` in `0006` and must carry this
  spec's three columns forward.
- Phase 2's `createStoryDO` factory is the same seam scheduled publishing needs
  (`ROADMAP.md` → Next), and should be built with that in mind.

## Out of scope

- **Parallel named drafts / content branches.** A story carrying more than one
  divergent draft ("the campaign rewrite") is a different storage model — one DO
  per (story, branch), branch-aware preview URLs, publish-as-promote — and it is
  not what is needed to see and undo the single draft that exists today. Revisit
  once this ships and the gap is still felt.
- **Per-block publishing.** Publishing part of a document breaks the atomic
  snapshot that makes `published_doc` a single row and versions restorable.
- **Approval workflow** (submit for review, publisher signs off). Needs roles from
  `../foundation/identity-and-access.md`; deliberately not smuggled in here.
- **Scheduled publishing.** Already on `ROADMAP.md` as the next item; this spec
  only makes sure the D1 handle it needs arrives in the Durable Object.

## Open questions

- Should the comparison view be reachable from the tree (compare any page without
  opening it), or only from the open story's top bar? **Resolved: the top bar
  only.** The comparison view opens from the "N unpublished changes" state in
  `TopBar.tsx` (`onCompare`, aimed at the newest publish version via
  `useVersions.view()`); the tree has no comparison entry point of its own.

## Implementation notes

Both phases landed, in the reverse of the order they are written above: the
watermark plumbing (phase 2) came first here because `core/story.ts`'s
`StoryMeta` needed its final shape — `draftSyncId`, `draftUpdatedAt`,
`publishedSyncId`, `hasUnpublishedChanges` — before the open-story delta (phase
1) could be built against it without a second pass. Both phases are complete;
this reordering did not change what either phase delivers.

**What landed, roughly as specified:**
- `draftState` (`core/story.ts`) widens `storyState` into the `'changed'` case
  the type already reserved for it, from the watermark pair.
- `StoryDO` became `createStoryDO<Env>({ db })`; `export { StoryDO }` is that
  factory pre-applied to `env => env.DB`, so no existing host needs to change.
  A debounced (~2s) alarm mirrors the log position into D1 once per burst.
- `publish()` reads the draft and its syncId in one atomic call
  (`getOrInitWithSyncId`), not two — a real race the acceptance criteria named
  and a workers test now pins.
- `usePublishedDoc` (new hook) computes `summariseDiff(diff(published, draft))`
  against the newest publish version; its pure half (`publishedDelta`) is
  exported and unit-tested directly, no React runtime required.
- `TopBar.tsx`'s bare "Synced" label became the five-state machine the plan
  named (`publishStatus`, also a pure, unit-tested function).
- Discard reuses `restore()` outright, per architecture decision 5. The one
  new piece of UI is `DiscardDialog.tsx`; `ViewingBar`'s existing "Restore this
  version" swaps to "Discard changes" only when the version on screen is the
  newest publish version reached via the compare button, not an arbitrary
  History checkpoint.
- `useVersions` no longer owns the version list fetch — `useVersionsList` is
  new, loads unconditionally, and both `useVersions` and `usePublishedDoc` read
  it from `Editor.tsx`, per the spec's own note on this.

**Where the spec's ground truth had drifted or needed filling in:**
- `liveDescendants` (`unpublish.md`'s helper, `core/story.ts`) filtered on
  `state === 'live'` alone. Making `'changed'` reachable would have silently
  dropped a page with unpublished changes from "these stay live" in the
  unpublish confirmation — fixed to treat `'changed'` as live too, with a test
  pinning it.
- The spec does not say what "nothing to publish" means for a story that is
  currently `'unpublished'` (taken down) but content-identical to its last
  publish. Disabling Publish there would trap an editor who wants to bring the
  page back live with no further edits, so `publishStatus`'s
  `nothingToPublish` only fires while the story's current state is `'live'`;
  `'unpublished'` always leaves Publish enabled. Documented in `TopBar.tsx` and
  `top-bar.test.ts`.
- `publishStoryStatement`/`publishStory` gained a required `publishedSyncId`
  parameter rather than a defaulted one: a wrong watermark is a silently
  hidden bug (a row reads "clean" when it is not), not a loud one, so every
  call site — including every pre-existing test — now passes one explicitly.

**Deferred:** the per-row `head()` RPC the owner decision rejected was not
built at all (the alarm approach was accepted as written). Scheduled
publishing itself is still out of scope, per this spec's own "Out of scope".

**Tests added:** 26 (659 → 685): 20 unit (`core/story.test.ts`'s `draftState`
and the `liveDescendants`/`unpublishConfirmation` "changed" cases;
`published-doc.test.ts`'s four delta states; `top-bar.test.ts`'s
`publishStatus` cases; `viewing-bar.test.ts`'s `discardSummary` cases), 6
workers (`story-do.test.ts`'s watermark alarm block, `stories.test.ts`'s
derived-state and `publishedSyncId` cases, `http.test.ts`'s publish-race
case), plus `scripts/history-test.mjs` grew from 29 to 41 checks, run live
against a real dev server from a fresh database.
