# Feature: Unpublish — taking a page off the live site without deleting it

> **Group:** editing
> **Build order:** 1
> **Size:** S
> **Status:** draft
> **Wire version:** none
> **Migration:** `0003_unpublish.sql`
> **Last updated:** 2026-07-29

## Summary

There is no way to take a published page down. `publish()` writes
`stories.published_doc` and nothing ever clears it, so the only route to "this
should not be public any more" is deleting the story — which cascades the whole
subtree, drops every version row and purges the Durable Object.

Contentful, Sanity, Strapi, Payload and Storyblok all treat publish and unpublish as
a pair. This is closer to a missing primitive than a feature: it is one nullable
column write plus the state it implies in the tree and the top bar. It is first in
the build order because it costs a day and because the *next* two specs
(`unpublished-changes.md`, `../foundation/document-types.md`) both want to design the
tree's state machine once, with "not live" already in it.

## Ground truth

**server (`packages/folio/src/server/`):**
- `publishedDoc(db, path)` (`stories.ts`) is `select published_doc … where path = ?`
  and returns `null` when the column is null. `folio.published(env, path)` is a thin
  wrapper, and the demo answers `null` with a 404 (`examples/demo/src/index.tsx`).
  **So nulling the column is the entire liveness switch** — no route needs to learn
  anything.
- `publishStoryStatement(db, id, doc, fallbackTitle)` sets `published_doc`,
  `published_at`, `title` and `updated_at`, and is batched with the version insert in
  `publish()` so the two cannot disagree.
- `publishedDocsByIds(db, ids)` (`stories.ts`) omits ids whose `published_doc` is
  null. So an unpublished story **stops resolving as a `reference` on live pages for
  free**, and the renderer already treats an unresolvable reference as "render your
  own empty state" (`resolveReference`, `README.md`).
- `deleteStoryStatement` returns the affected ids so the route can batch the story
  delete with `deleteVersionsStatement` and purge each Durable Object. That is the
  current, destructive "unpublish".
- `migrations/0001_initial.sql`: `versions.kind text not null check (kind in
  ('publish', 'checkpoint'))`. **SQLite cannot alter a CHECK constraint**, so adding
  an `unpublish` version kind means rebuilding `versions` — see decision 2.
- `stories.published_at` is what the demo's `sitemap()` filters on
  (`.filter((s) => s.publishedAt)`), so clearing it keeps a host's sitemap correct
  with no host change.

**admin (`packages/folio/src/admin/`):**
- `StoryTree.tsx:119` — `{node.publishedAt ? null : <span className="stories__badge">draft</span>}`.
  One boolean, two states.
- `TopBar.tsx` — a single Publish button, disabled only while publishing or while a
  version preview is open. No secondary publishing actions and no menu to hang one
  off.
- `usePublish.ts` — `publish()` then `afterWrite(onPublished())`, with the deliberate
  rule that a failed refresh must not be reported as a failed publish.

## Owner decision checkpoints

1. **Unpublish clears `published_doc` and `published_at`; the draft is untouched
   (recommended).** Three separate operations, with three separate meanings, and this
   spec keeps them separate: *unpublish* removes the public page and keeps the work,
   *discard changes* (`unpublished-changes.md`) throws the work away and keeps the
   public page, *delete* removes everything.
2. **Record the unpublish on `stories`, not as a version kind (recommended).** Two
   nullable columns (`unpublished_at`, `unpublished_by`) rather than rebuilding
   `versions` to widen its CHECK constraint. An unpublish is not a document snapshot,
   so a version row is the wrong shape for it, and the rebuild would be a
   disproportionate migration for one enum value.
3. **No cascade to descendants (recommended).** Paths are independent: `/about/team`
   serves whether or not `/about` does. Cascading would surprise, and un-cascading
   would be a second operation. The confirmation instead *names* the descendants that
   will stay live, which is the information the editor actually lacks. Storyblok and
   Contentful behave the same way.
4. **The root story may be unpublished (recommended).** It makes the site root 404,
   which is drastic but legitimate and reversible in one click — unlike deleting the
   root, which is refused. The confirmation says plainly that `/` will stop serving.
5. **The host decides what an unpublished path answers (recommended).** Folio hands
   back `null` as it does today; a new `folio.status(env, path)` lets a host answer
   `410 Gone` for something deliberately unpublished and `404` for a path that never
   existed. Cheap, and it pairs with `../platform/redirects.md`.

## User stories

### Editor takes a page down
**As** an editor **I want to** unpublish a page **so that** an out-of-date offer
stops being public without me deleting the work that produced it.

### Editor puts it back
**As** an editor **I want** re-publishing to be one click **so that** taking
something down is not a decision I have to be afraid of.

### Editor understands the blast radius
**As** an editor unpublishing a section landing page **I want** to be told which
child pages stay live **so that** I do not leave `/about/team` orphaned by accident
and think I have hidden the whole section.

### Developer answers correctly for a removed page
**As** a developer **I want** to know that a path was unpublished rather than never
existing **so that** I can answer `410 Gone` and keep search engines honest.

### Editor sees the state in the tree
**As** an editor **I want** the tree to distinguish never published, unpublished and
live **so that** "draft" stops meaning two different things.

## Architecture decisions

### 1. Liveness is `published_doc is not null`, and nothing else

No status enum, no state column to keep in step with the document. The column that
serves the page is the column that says whether it is served, which makes the two
impossible to disagree. `published_at` is cleared alongside it because every
existing consumer — the demo's sitemap, `StoryTree`'s badge, `StoryMeta.publishedAt`
— already reads it as "is this live", and leaving it set would make all of them lie.

"When was this last published" is not lost: every publish writes a retained version
(`publish.ts`), so the newest `kind: 'publish'` version row *is* the publication
history, timestamped and attributed. `published_at` was always a cache.

### 2. The tree's four states, named once

| State | Test | Badge |
| --- | --- | --- |
| Never published | `published_at` null and `unpublished_at` null | `draft` |
| Unpublished | `published_at` null and `unpublished_at` set | `not live` |
| Live | `published_doc` set | none |
| Live, with unpublished changes | `published_doc` set and the draft differs | `changes` (`unpublished-changes.md`) |

Derived in `stories.ts`'s projection as `state: 'draft' | 'unpublished' | 'live' |
'changed'`, not in the admin, so the tree, the content API and any host reading
`folio.stories(env)` agree. `unpublished-changes.md` fills in the fourth row; this
spec ships the first three and leaves the field in place for it.

### 3. Unpublish is a route over a workflow, like publish

```ts
// server/publish.ts — beside publish() and checkpoint()
export async function unpublish(
  deps: PublishDeps,
  story: StorySelector,
  actor: string | null,
): Promise<{ unpublishedAt: number }>
```

Same shape and the same reason: no `Request`, no `Env`, so a scheduled unpublish (the
mirror of the scheduled publish on `ROADMAP.md`) can call it from a Durable Object
alarm. It does not read the draft at all, so it does not touch the Durable Object —
one D1 write, and the only workflow in the file that needs nothing from
`deps.draft`.

Idempotent: unpublishing something already unpublished answers `200` with the
existing `unpublished_at` rather than `409`. Taking a page down is exactly the kind of
action someone double-clicks.

### 4. Everything downstream falls out

- **References**: `publishedDocsByIds` already skips null rows, so a live page
  referencing an unpublished story renders its empty state. No change.
- **Preview**: unchanged. Preview reads the draft, and an unpublished page is still
  editable and previewable — which is the point.
- **Versions and restore**: untouched. An unpublished story keeps its whole history,
  and restoring a version into its draft leaves it unpublished until someone
  publishes.
- **Sitemaps**: the demo's `publishedAt` filter keeps working.
- **The query index** (`../content-model/collections.md`): index and ref rows are
  deleted on unpublish, in the same batch. That is a one-line addition to that spec's
  publish batch, noted here so it is not forgotten.
- **Multiplayer**: `story.published` gains a sibling `story.unpublished` in
  `live-collaboration.md`'s event list.

## Wire & schema changes

### D1 migration `0003_unpublish.sql`

```sql
-- Unpublishing clears published_doc (the liveness switch) and published_at. These
-- two columns are what distinguishes "taken down" from "never published", which
-- the tree needs to show and which nothing else records: an unpublish is not a
-- document snapshot, so it gets no versions row — and versions.kind carries a
-- CHECK constraint SQLite cannot widen without rebuilding the table.
alter table stories add column unpublished_at integer;
alter table stories add column unpublished_by text;
```

Both null on every existing row, which reads as "never unpublished" — correct for
every row written before this migration.

### Core / server types

- `StoryMeta` gains `unpublishedAt: number | null` and the derived
  `state: 'draft' | 'unpublished' | 'live' | 'changed'`.
- `unpublish()` in `server/publish.ts`; `unpublishStoryStatement` in `stories.ts`
  beside `publishStoryStatement`, unrun, for the same batching reason.
- `Folio.status(env, path): Promise<'live' | 'unpublished' | 'unknown'>`.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/folio/story/:id/unpublish` | Clear the published snapshot. Idempotent. |

Gated on the `publisher` role once `../foundation/identity-and-access.md` lands —
the same gate as publish, because the ability to take the site down is the same
privilege as the ability to change it.

## Acceptance criteria

### A page stops serving and keeps its work
```
GIVEN a published page at /offers with a draft the editor has been editing
WHEN it is unpublished
THEN GET /offers no longer returns the page (folio.published gives null)
AND the draft is byte-unchanged and still editable and previewable
AND its version history is intact
AND stories.unpublished_at and unpublished_by are set
```

### Re-publishing is an ordinary publish
```
GIVEN an unpublished page
WHEN it is published
THEN published_doc and published_at are written, a version row is retained,
     unpublished_at and unpublished_by are cleared, and GET /offers serves again
```

### Idempotent
```
GIVEN an already-unpublished page
WHEN unpublish is called again
THEN 200 with the original unpublished_at, and no write
```

### The tree distinguishes three states
```
GIVEN one never-published story, one unpublished story and one live story
WHEN the content tree loads
THEN they read 'draft', 'not live' and no badge respectively
AND the state is computed server-side, so a host reading folio.stories(env) sees
    the same three values
```

### Descendants are named, not cascaded
```
GIVEN /about published with /about/team and /about/history published beneath it
WHEN the editor unpublishes /about
THEN the confirmation names both descendants as staying live
AND after confirming, /about 404s while /about/team and /about/history still serve
```

### The root story
```
GIVEN the root story
WHEN the editor unpublishes it
THEN the confirmation states that / will stop serving
AND after confirming, / 404s, and the story is still editable and can be
    republished
AND delete is still refused for it, as today
```

### References degrade, they do not break
```
GIVEN page A referencing story B, both published
WHEN B is unpublished
THEN A still renders, with its reference block showing its own empty state
AND A's document is byte-unchanged
AND an editor previewing A still sees B's draft content (preview resolves drafts)
```

### Host can answer 410
```
GIVEN an unpublished path and a path that never existed
WHEN folio.status(env, path) is called for each
THEN it returns 'unpublished' and 'unknown', so the host can answer 410 and 404
```

## Implementation plan

### Phase 1 — server

1. Migration `0003_unpublish.sql`.
2. `stories.ts`: `unpublishStoryStatement`; `unpublishedAt` and the derived `state`
   in `COLS`; `storyStatus(db, path)`.
3. `publish.ts`: `unpublish(deps, story, actor)`; clear `unpublished_at` inside
   `publishStoryStatement` so re-publishing cannot leave a stale marker.
4. `routes/stories.ts`: `POST /story/:id/unpublish`, `loadStory` ahead of the body for
   the same reason the publish and checkpoint routes do it.
5. `server/index.tsx`: `folio.status`.
6. Tests: `test/workers/http.test.ts` and `stories.test.ts` — every acceptance
   criterion; `publishedDoc` returning null after unpublish; a reference to an
   unpublished story resolving to nothing on a live page but to a draft in preview.

### Phase 2 — admin

1. `usePublish.ts` gains `unpublish` alongside `publish`, sharing the `afterWrite`
   discipline (a failed refresh must not be reported as a failed unpublish).
2. `TopBar.tsx`: Publish becomes a primary button plus a small menu holding
   "Unpublish…" — the first secondary publishing action, so the menu is worth adding
   properly rather than squeezing a second button in.
3. Confirmation dialog: names the path, names live descendants (computed from the
   tree the admin already holds), and says the draft is kept. A distinct message for
   the root story.
4. `StoryTree.tsx`: render `node.state` instead of `!node.publishedAt`.
5. Tests: `test/unit/admin/` for the badge mapping and the descendant list in the
   confirmation.

### Phase 3 — docs

1. `README.md`: mention unpublish beside publish, and `folio.status` in the mount
   snippet's 404 branch.
2. `ROADMAP.md`: note that scheduled *un*publishing is now a one-line addition to the
   scheduled-publish alarm.

## Edge cases

- **Unpublish while another editor has the story open** → their draft is unaffected;
  they see the state change once `../editing/live-collaboration.md` broadcasts it, and
  until then their top bar is stale but harmless (their Publish button still works and
  re-publishes).
- **Unpublish then delete** → delete behaves exactly as today; `unpublished_at` goes
  with the row.
- **Unpublish a story with a scheduled publish pending** (once that ships) → the
  schedule stands and will re-publish it. Correct: a schedule is an instruction about
  the future. Worth surfacing in the confirmation when a schedule exists.
- **A host caching published pages** (once a cache exists) → unpublish must purge the
  same keys a publish does. Recorded in `../content-model/globals.md`'s cache note and
  in `ROADMAP.md`'s cache item.
- **`published_at` used as "created" by host code** → it never was, but a host might
  have leaned on it. Called out in the README change, because clearing it is
  observable.
- **Two editors unpublish at once** → idempotent, last write wins on
  `unpublished_by`. Nobody is harmed.
- **Unpublishing a `record` or `singleton`** (once `../foundation/document-types.md`
  lands) → allowed and meaningful: an unpublished record stops resolving in live
  references while staying editable. The tree's Data section uses the same badges.

## Testing requirements

**Workers:** every acceptance criterion; the idempotent second call; that unpublish
performs no Durable Object call at all (it is the one workflow that does not need the
draft); the derived `state` for all three cases.

**Unit:** the badge mapping; the confirmation's descendant computation over a tree.

**End to end (extend `scripts/history-test.mjs`):** publish → assert the page serves
→ unpublish → assert 404 and that the draft and version list survive → publish again
→ assert it serves and a second version was retained.

## Dependencies

- None. It is first for that reason.
- `../foundation/document-types.md` rebuilds `stories` in `0006`, so it must carry
  these two columns forward. That is the only reason this spec's migration number
  matters.

## Out of scope

- **Scheduled unpublish** (expiry dates). One alarm away once scheduled publishing
  exists, and it belongs with that work.
- **Cascading unpublish** (checkpoint 3).
- **A `410 Gone` default.** Folio returns `null` and the host answers; `folio.status`
  is the affordance, not a policy.
- **Removing an unpublished page from search indexes.** Needs the search index that
  does not exist; `../platform/publish-hooks.md` is where a host would hang it.
