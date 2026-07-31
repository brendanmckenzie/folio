# Feature: Pagination, everywhere, as a rule

> **Group:** foundation
> **Build order:** 18, per docs/specs/README.md
> **Size:** L ≈ a week or two
> **Status:** in-progress — phase 1 landing; checkpoints and open questions all closed
> **Wire version:** none — no socket frame changes shape
> **Migration:** `0001_init.sql` (the ten existing migrations collapse into one)
> **Last updated:** 2026-07-31

## Summary

**No list may be unbounded — no route, no panel, no fetch.** Today five routes
return a whole table on every request, three truncate silently with no page two,
and the admin's two list surfaces page *client-side* over data already
transferred. `server/stories.ts:114`'s `listStories` even takes `{ limit, offset }`
already, and not one of its seven callers passes it.

This spec also moves the admin's internal JSON off the bare paths, because the
rebuilt shell needs `{base}/content` for a screen and a JSON route is answering
there (`ROADMAP.md` 1a). The two are one piece of work: both decide the shape of a
list route, and doing them separately means editing every list route twice.

## Ground truth

Verified 2026-07-31 against `main` at `4022ae3`.

**core (`packages/folio/src/core/`):**

- `story.ts:108` — `StoryState = 'draft' | 'unpublished' | 'live' | 'changed'`.
- `story.ts:116` `storyState(publishedAt, unpublishedAt)` and `story.ts:141`
  `draftState(publishedAt, unpublishedAt, draftSyncId, publishedSyncId)`. **Every
  input is a stored column**, so state is expressible in SQL — decision 4 turns on
  this.
- `story.ts:163` `ancestorPaths(path)` — ancestors are reached by path in one
  query, never by walking `parent_id`. A per-level tree walk must not break this.
- `resolve.ts:138` `buildResolution(stories, assetBase)` — takes a flat story
  list. Used server-side (`server/runtime.ts:588`) **and** in the admin
  (`admin/Editor.tsx:252`, over `flat`). The admin call is the load-bearing reason
  the full `/stories` fetch has survived.
- `doc.ts` `compareSiblings(ord, id, ord, id)` — sibling order is `(ord, id)`, so
  a keyset cursor over a level is `(ord, id)` and nothing else.

**server (`packages/folio/src/server/`):**

*Properly paged — two, and they disagree with each other:*

- `redirects.ts:169` `listRedirects` — a real **keyset** cursor over
  `(created_at desc, from_path desc)`, `limit` defaulted to 50 and clamped to 200,
  fetching `limit + 1` to decide `hasMore`. Returns
  `RedirectPage { rows, cursor: string | null }` (`redirects.ts:147`). Cursor is
  `${createdAt}_${from}`, opaque by convention (`redirects.ts:155`).
- `query.ts:225` `runQuery` — **offset** paging with a parallel `count(*)`,
  returning `ContentPage { items, total, page, perPage, pages }`. This is
  `collections.md`'s engine and backs `GET /api/v1/documents` and
  `folio.query()`.

*Capped, not paged — silent truncation, no page two:*

- `assets.ts:37` `listAssets(db, limit = 200)`, clamped to 500. **No search route
  either**, so asset 201 is unreachable by any means.
- `versions.ts:40` `listVersions(db, storyId, limit = 50)`.
- `routes/history.ts:73` activity — `limitParam(query, 60, 200)`
  (`validate.ts:626`).

*Unbounded — the whole table, every request:*

- `stories.ts:114` `listStories(db, opts?)`. Callers: `index.tsx:298` (the only one
  that passes a window, via `folio.stories(env, { page, perPage })`),
  `runtime.ts:525` (resolution, `wantAll` branch), `stories.ts:159` (`storyTree`),
  `stories.ts:554`, `:782`, `:943`, and `routes/editor.ts:117`.
- `stories.ts:173` `listDocuments(db, type?)` — every unrouted document, or every
  row of one type.
- `auth/users.ts:86` `listUsers`, `auth/tokens.ts:86` `listTokens` — whole table
  each.
- `stories.ts:415` `publishedDocsAll` — every published document, in one query,
  feeding `audit()`. `routes/migrations.ts:91` exposes it with no limit anywhere.

*The batched-job pattern to copy for anything long-running:*

- `migrate.ts:44` `continueFrom`, `:204` `storiesBehind(db, latestId, after, size)`,
  `:321` sets `report.continueFrom` when a batch came back full.
- `reindex.ts:31` the same shape, and `stories.ts:429`'s batch reader.

*Indexes that already exist (`migrations/0006_document_types.sql`):*

- `stories_parent_ord (parent_id, ord)` — **exactly** the index a per-level keyset
  walk needs, already there.
- `stories_type (type, ord)` — the Documents screen's order.
- `stories_path (path) where path is not null` — **unique**, so `path` is a total
  order over routed rows with no tiebreak needed. Plus `stories_parent_slug` and
  `stories_type_slug`.
- `assets_created (created_at desc)`, `versions_story (story_id, created_at desc)`,
  `api_tokens_created (created_at desc)`, `content_index_lookup (field, locale,
  text_value)`, `content_refs_to (to_story)`.
- **`stories_draft_updated (draft_updated_at desc)` is dead.** Added by `0005:19`,
  rebuilt by `0006:87`, and **nothing in `src/` orders by that column** — the only
  two references are a write (`story-do.ts:276`) and a projection
  (`stories.ts:34`). It also indexes the wrong expression for the query that now
  wants it; see decision 2a.
- **`users` has no `created_at` index** while `auth/users.ts:86` orders by it.
- `draft_updated_at` is **nullable** (`0006:64`, "null until the first debounced
  write"), which is what makes "last edited" a `coalesce` rather than a column —
  decision 2a.

**admin (`packages/folio/src/admin/`):**

- `DataTable.tsx:28` `ROWS_PER_PAGE = 20`, `:210` `sorted.slice(from, …)` — pages
  **client-side over the full list**. `:153` `pageCount` exists and is tested.
- `StoryTree.tsx:556` `LEVEL_LIMIT = 50`, `:523` "Show all {nodes.length}" — a
  *render* cap over data already transferred. The worst of both: it pays the
  transfer and hides the rows anyway.
- `Editor.tsx:252` `buildResolution(flat, …)` — needs a story row for every link
  target in the open document.
- `ui/Prototype.tsx` (the shell prototype) boots with **two** unpaged fetches,
  `/stories` and `/documents`, and says so in a comment.
- Every admin fetch goes through `boot.apiBase`, so an API prefix move costs the
  client one string.

**tests:**

- `test/workers/migrations.test.ts` pins the current D1 shape and is meant to be
  updated alongside a schema change (`CLAUDE.md`).
- `test/workers/records.test.ts` pins `clearIndexStatements` vs
  `clearInboundRefStatements` — untouched here, but it is in `stories.ts`.
- Roughly **265 literal `{base}`-relative paths** across `test/` and `scripts/`,
  which is the whole cost of the prefix move.

## Owner decision checkpoints

**All resolved 2026-07-31** — see `## Resolved` at the end for what was asked and
what came back. One answer overrode the recommendation and one added scope.

1. **Two paging shapes: keyset for the admin, page numbers for `/api/v1`.**
   Confirmed — decision 1.
2. **The internal prefix is `{base}/api/`**, not `{base}/_/` as recommended.
   Decision 3, rewritten around the rule that makes it work.
3. **The ten migrations collapse into one `0001_init.sql`.** Taken as already
   decided by the standing greenfield position (`CLAUDE.md`) rather than re-asked.
4. **`state` is a SQL expression, not a stored column.** An engineering call, not
   put to the owner — decision 4 carries the argument.
5. **The tree gets a flat twin, screen included** — decision 2a. Added scope, and
   the reason the schema needed a second look.

## User stories

### Open a large site without waiting for it
**As** an editor of a 5,000-page site **I want** the tree to load the top level
first **so that** the admin is usable before every row has been transferred.

### Reach every asset
**As** an editor **I want** to page and search the media library **so that** the
201st asset is not permanently invisible.

### Filter server-side and link to the result
**As** an editor **I want** `?state=changed` to be answered by the server **so
that** the filter still means something once the list is longer than one page, and
the URL still reproduces what I am looking at.

### Publish a filtered selection safely
**As** a publisher **I want** "select all 51,420 matching" to send a filter and a
count rather than 51,420 ids **so that** the operation is possible at all, and is
refused if the set moved underneath me.

## Architecture decisions

### 1. Two paging shapes, and the split is by audience

**Admin lists page by keyset cursor. `/api/v1` keeps page numbers.**

The admin's lists are live: somebody else is editing while you scroll. Keyset is
correct under concurrent writes — a row inserted above your cursor cannot make you
skip or repeat one — needs no `count(*)`, and matches `redirects.ts:169`, which is
the one route already doing this properly.

`/api/v1/documents` is a *published-content* query behind
`collections.md`'s engine, and its consumer is a host building a blog index that
genuinely wants "page 3 of 7". `runQuery` (`query.ts:225`) already answers
`{ items, total, page, perPage, pages }` and is correct for that job.

**Rejected: keyset everywhere**, retiring `runQuery`'s offset. It would take page
numbers away from the one caller for whom they are meaningful and correct: a
listing over *published* content, which by definition does not move between
requests the way a draft tree does.

**Rejected: offset everywhere**, which is the cheaper refactor. Over live content
offset silently skips and repeats rows, and "Page 3 of 7" is a number that was
true when the count query ran and not when the page query did.

The two are not a contradiction to be tidied away later, so both are named in
`ROADMAP.md` and in the envelope types: `Page<T>` (cursor) and `ContentPage`
(numbers) are different types on purpose.

### 2. The tree pages one level at a time

`GET {base}/api/stories` answers **one parent's children**, keyset over `(ord, id)`,
which is exactly `compareSiblings`' order and exactly the `stories_parent_ord`
index that already exists. No `parentId` means the top level.

This is what makes collapse mean something — a closed node has cost nothing — and
it retires `StoryTree.tsx:523`'s "Show all 812", which pays for every row and then
hides them.

**Rejected: paging the flattened tree.** A flat window across a depth-first walk
cuts a subtree in half at an arbitrary depth, so the client cannot draw an indent
for rows whose parents are on the previous page. The tree is the one list whose
structure *is* the ordering.

**Rejected: a depth cap** ("load three levels, then fetch on demand"), which is
the same problem with an arbitrary constant in front of it.

Consequence worth stating: the tree is no longer one request, so the admin cannot
hold "every story" — which is what forces decisions 6 and 7.

### 2a. The tree has a flat twin, and it needed a different index

`{base}/api/stories?flat=1&sort=edited|title|path` answers **every routed page**,
paged, with no structure — and Content gets a `[ Tree | Flat ]` toggle for it.

Two views of one thing, because they answer different questions. A tree tells you
how the site is *shaped*; a flat sortable list tells you what was touched last, and
on a 5,000-page site that is how a person finds anything. Storyblok ships both for
this reason. The mode is **in the URL** (`?view=flat&sort=edited`) and the last
choice is remembered as the default when arriving without one — the same rule
`ui-architecture.md` gives the Assets grid/table toggle, and the same reason:
linkable first, convenient second.

**Building it found a schema problem the tree does not have.** `sort=edited` means
"last edited", which is `draftUpdatedAt ?? updatedAt` — `draft_updated_at` is
**nullable** (`0006_document_types.sql:64`, "null until the first debounced
write"), and the admin already reads it that way (`draftState`'s neighbour in the
prototype's `when()`). So:

- `order by draft_updated_at desc` is **wrong**, not merely unindexed. SQLite sorts
  NULLs last under `desc`, so every page nobody has opened lands at the bottom —
  below a page last edited three years ago. A page created five minutes ago would
  sort last in a list called "last edited".
- The correct order is `coalesce(draft_updated_at, updated_at) desc, id desc`, and
  the cursor is that pair.
- **`stories_draft_updated (draft_updated_at desc)` is dead.** Added by `0005`,
  carried through `0006`'s rebuild, and nothing in `src/` orders by that column —
  the only two references are a write in `story-do.ts:276` and a projection in
  `stories.ts:34`. It was created for a query nobody wrote, and it indexes the
  wrong expression for the query that now exists.

The collapse replaces it with an expression index. `sort=title` needs a new one;
`sort=path` needs nothing, because `stories_path` is already unique over non-null
paths, which makes `path` a total order with no tiebreak column.

**Rejected: the flat list as its own screen** at its own URL. It is the same rows,
the same filters, the same selection and the same bulk actions — two screens would
duplicate all four and then drift. A toggle keeps one screen with two orderings.

**Rejected: sorting the tree instead** (a tree ordered by last edited). Order and
structure are the same axis in a tree — `ord` *is* the sibling order — so
re-sorting it either breaks the indent or sorts only within each parent, which is
not what "what changed lately" means.

**Rejected: a stored `last_edited` column** maintained by both writers. Removes the
`coalesce` and reintroduces decision 4's problem: two columns that can disagree
about the same fact.

### 3. The admin's internal JSON moves to `{base}/api/`, and a version segment is a promise

The screens take the bare paths, because a screen is what a person links to,
bookmarks and sends to a colleague. Four of them — `/content`, `/assets`,
`/documents/:type`, `/redirects` — are JSON routes today, and the collision is
total rather than incidental: the screens and the API are named after the same
resources because they are about the same resources.

`server/app.ts` already declares everything below its `/api/v1` mount "internal to
the admin and free to change with it", which is precisely the licence needed.

**The rule that makes one `/api` hold two different promises:**

> **A version segment is a promise. Its absence is the absence of one.**
> `{base}/api/v1/*` is a contract with somebody's script and changes by adding a
> `v2`. `{base}/api/*` with no version is internal to the admin, ships in the same
> deploy as its only caller, and may change shape in any commit.

After: `{base}/api/stories`, `{base}/api/documents`, `{base}/api/assets`,
`{base}/api/users`, `{base}/api/audit`, `{base}/api/search`, … while
`{base}/content`, `{base}/assets` and `{base}/edit/:id` are screens, and
`{base}/api/v1/*` is untouched.

This was **not** the recommendation. The objection was that the two surfaces would
look like siblings and be told apart only by the presence of `v1`, and it stands —
so it gets answered with a rule stated where it can be read rather than left as a
convention nobody wrote down:

- `server/app.ts` carries the rule as a comment at the mount, next to the existing
  one explaining why `/api/v1` is registered first.
- A workers test asserts the partition: **every** route under `{base}/api/v1` is a
  documented contract path, and **no** internal route sits under a versioned
  prefix. It fails if somebody adds `{base}/api/v1/stories` by reflex.
- Mount order is load-bearing and already correct: `/api/v1` is routed before the
  resource routes (`app.ts:79`) so `/api/v1/documents/:id` is never read as a
  resource `:id` pattern. The internal routes join *after* it, which keeps that
  true. An internal route may never be named `v1` or `v2`.

The upside the recommendation undervalued: one prefix means one mental model for
"this response is JSON", and a reader in a network tab sees `/api/` and stops
wondering. `_` would have been unambiguous to a person who already knew the
convention and cryptic to everyone else.

**Rejected: `{base}/_/`.** Unambiguous and unguessable in equal measure. The
partition test above buys back what it was protecting against.

**Rejected: the screens under `{base}/admin/`.** Spends a URL segment saying the
CMS is a CMS, on every URL a human ever sees, forever.

**Rejected: content negotiation on one path** — HTML for `Accept: text/html`, JSON
otherwise. One line of routing, and it fails silently the first time something
sends the wrong header. A URL should mean one thing.

Cost: ~265 literal paths across `test/` and `scripts/`. Mechanical, wide, and its
own phase so the diff is reviewable as a rename rather than mixed into logic.

### 4. `state` is a SQL expression over four existing columns

The Content screen's state chips have to be answered server-side once the list is
paged — a client-side predicate over one page filters the page, not the site.

`draftState` (`story.ts:141`) reads `published_at`, `unpublished_at`,
`draft_sync_id` and `published_sync_id`, all stored. So:

```sql
case
  when published_at is not null and draft_sync_id > published_sync_id then 'changed'
  when published_at is not null                                       then 'live'
  when unpublished_at is not null                                     then 'unpublished'
  else 'draft'
end
```

Written **once**, in `stories.ts`, next to `COLS`, and used by every filtered
read. The expression and `draftState` are pinned against each other by a test that
runs both over the same rows — two implementations of one rule is the actual risk
here, and it is worth a test rather than a comment.

**Rejected: a stored `state` column** maintained by publish and unpublish. Faster
to filter, indexable, and it can disagree with the four columns it derives from —
which is the same class of bug as a denormalised `title`, except that this one
decides whether a page appears in a publisher's list at all.

### 5. A count is a separate, opt-in query — and list headers opt in

`Page<T>` carries no total. A caller that wants one asks: `?count=1` adds one
`count(*)` over the same filter and returns it alongside.

**Every list header does ask**, because the owner's answer to the paging control was
"next / previous **plus** a count" — `Showing 20 of 1,284`. So in practice most
list requests carry `count=1`, and the mechanism still has to be opt-in for two
reasons that survive that:

- **A search box does not want it.** Typing runs a request per keystroke (debounced),
  and each would otherwise drag a full aggregate over the table behind it. The
  header keeps the count from the last settled query and dims it while typing.
- **The count is load-bearing somewhere else.** It is the guard on a bulk write
  (`ui-architecture.md` decision 7a — the server re-runs the captured filter,
  compares to `expected`, and refuses on mismatch). One count implementation serves
  the header and the guard, and they must not drift, which they would if the header
  got a cheap approximation baked into the envelope.

**Rejected: `total` always in the envelope.** Simpler to consume, and it makes the
count unavoidable exactly where it is least affordable.

**Rejected: an approximate count** past some threshold ("1,000+"). Honest about
cost, and it cannot be the bulk guard, so the guard would need a second exact
implementation — the drift this decision exists to prevent.

### 6. One `Page<T>` envelope and one cursor module

```ts
export interface Page<T> {
  rows: T[]
  /** Opaque. Pass back as `?cursor=`; null on the last page. */
  cursor: string | null
}
```

Plus `encodeCursor(parts)` / `decodeCursor(raw)` in one module, taking a tuple of
primitives — because the cursors here are two-column (`(ord, id)`,
`(created_at, id)`, `(created_at, from_path)`), and a page boundary that lands on
two rows sharing a millisecond has to resume exactly. `redirects.ts:155`'s
hand-rolled `${createdAt}_${from}` becomes a caller of it.

Opaque means opaque: base64 of a JSON tuple, and no client parses it. The redirects
cursor is already opaque *by convention* and the convention is worth enforcing with
an encoding, because the first client to parse one freezes the column order.

**Rejected: a cursor per route**, which is what exists now (exactly one, in
redirects) and which multiplies by eight here — eight chances to get `limit + 1`,
tie-breaking, or the last-page condition subtly wrong, and no shared test.

### 7. The admin asks for the ids it needs, not for every story

`GET {base}/api/stories?ids=a,b,c` — `storiesFor(db, ids, paths)`
(`stories.ts:137`) already resolves a batch of ids **and** a batch of ancestor
paths in one query, which is precisely what `buildResolution` needs.

This is the answer to the load-bearing caller: `Editor.tsx:252` builds a
`Resolution` from `flat` so a link's target id becomes a URL in the live preview.
It does not need every story, it needs the stories the open document mentions —
and the server already computes exactly that set for its own narrowed `resolve()`
(`core/refs.ts`, and note its warning that **richtext link marks are part of the
id set**; a Folio-native link mark has no `href` and derives it at render, so
narrowing the walk without them makes every internal prose link render as unstyled
text).

**Rejected: keeping one full fetch just for resolution**, paging only the visible
lists. It leaves the largest request in the boot path in place, which is the thing
this spec exists to remove, and it would quietly become the reason someone
re-added a tree-wide fetch later.

### 8. Link and reference pickers, and the palette, share one search route

`GET {base}/api/search?q=&kind=&type=&limit=` — over `stories.title`, `slug`, `path`
and `content_index`'s text values, returning a small paged `Page<StoryRef>`.

The pickers filter the full list in memory today; the palette in the shell
prototype does the same over its two boot fetches. Both need the same thing:
"documents matching this string, ranked, top twenty". One route, three consumers.

**Rejected: a client-side index** built once at boot. It is the full fetch again,
wearing a different hat.

**Rejected: FTS5**, which D1 supports. `content_index` plus `like` on three
columns is enough for a picker over a site's own content, and an FTS table is a
second write path to keep in step with the first for a feature nobody has asked
to be fuzzy yet. Named so it is a decision rather than an oversight.

### 9. A filter is one flat serialisable object, and three things read it

```ts
interface StoryFilter {
  parentId?: string | null   // null means the top level
  type?: string
  state?: StoryState
  q?: string
  locale?: string            // translation completeness, per localisation.md
}
```

The same shape is the URL's query on the Content screen, the argument to a paged
read, and the `filter` a select-all captures (`ui-architecture.md` decision 7a).
Flat and JSON-serialisable so all three can be the same object — a filter that
needed a class or a closure could not be put in a URL or stored in a job.

**Rejected: a filter expression language** (`state:changed AND type:page`).
Expressive, and it makes the URL a parser problem and the bulk guard a
re-evaluation problem, for a set of filters that is fixed and small.

### 10. The ten migrations become one `0001_init.sql`

`0001`–`0010` are sequenced only because they were written in sequence. Nothing is
deployed, there is no remote, and `scripts/e2e.sh` wipes local state on every run —
so the ledger records history nobody can read back.

Collapsing gives the pagination work one obvious place to put the index it needs
(`users (created_at)`) rather than an eleventh file that adds a single line, and it
makes the schema legible in one read. `test/workers/migrations.test.ts` is rewritten
against the collapsed shape, which is the actual work.

**Rejected: an eleventh migration adding one index.** Cheaper today, and it leaves
ten files documenting a history with no audience — the thing `CLAUDE.md` explicitly
licenses removing.

## Wire & schema changes

### D1 migration `0001_init.sql`

Replaces `0001_initial.sql` … `0010_content_index.sql`. Every table, column and
trigger carries over unchanged. Not reproduced in full here — it is the composition
of ten existing files — but the **index** delta over today's end state is exact and
is the whole schema story:

```sql
-- `listUsers` (auth/users.ts:86) orders by created_at and had no index for it.
create index users_created on users (created_at);

-- Flat mode's default sort (decision 2a). `draft_updated_at` is nullable, so
-- "last edited" is the coalesce, and the cursor is (that value, id).
create index stories_edited
  on stories (coalesce(draft_updated_at, updated_at) desc, id desc);

-- Flat mode's `sort=title`. `sort=path` needs nothing: `stories_path` is already
-- unique over non-null paths, so path alone is a total order.
create index stories_title on stories (title, id);

-- DROPPED, not carried over: `stories_draft_updated (draft_updated_at desc)`.
-- Added by 0005, rebuilt by 0006, and never read — nothing in src/ orders by that
-- column. `stories_edited` above is what the query that now exists actually needs.
```

Three indexes added, one dropped, so the net cost per write is two. The acceptance
criterion is that `migrations.test.ts`, rewritten, asserts the same column set it
asserts today and this index set — including the *absence* of
`stories_draft_updated`, so nobody restores it by copying an old file.

### Core types

Additive, and no persisted document or log entry changes shape:

- `core/pagination.ts` (new) — `Page<T>`, `encodeCursor`, `decodeCursor`.
- `core/story.ts` — `StoryFilter` (decision 9). No change to `StoryMeta`.
- No `Doc`, `Blok`, `Field`, `Mutation` or `Resolution` change. **No
  `PROTOCOL_VERSION` bump**: nothing on either socket changes shape, because the
  tree's advisory `space` events already carry no content
  (`docs/sync-design.md`, "The space channel is not the sync engine").

### New or changed routes

Every path below is the **new** internal prefix. All keep their current auth.

| Method | Path | Change |
| --- | --- | --- |
| GET | `{base}/api/stories` | Was the whole tree. Now one level: `?parentId=&cursor=&limit=&type=&state=&q=&count=` → `Page<StoryMeta>` |
| GET | `{base}/api/stories?flat=1` | New mode (decision 2a). `&sort=edited\|title\|path` plus the same filters → `Page<StoryMeta>`, no structure |
| GET | `{base}/api/stories?ids=a,b,c` | New mode, via `storiesFor`. Returns `{ rows }`, uncursored — a batch by id is not a page |
| GET | `{base}/api/documents` | `?type=&cursor=&limit=&state=&q=&count=` → `Page<StoryMeta>`. Still ensures singletons on first access |
| GET | `{base}/api/search` | New. `?q=&kind=&type=&limit=` → `Page<StoryRef>` |
| GET | `{base}/api/assets` | `?cursor=&limit=&q=&kind=&count=` → `Page<AssetRow>` |
| GET | `{base}/api/story/:id/versions` | `?cursor=&limit=` → `Page<VersionMeta>` |
| GET | `{base}/api/story/:id/activity` | `?cursor=&limit=` → `Page<ActivityEntry>` |
| GET | `{base}/api/users`, `{base}/api/tokens` | `?cursor=&limit=&count=` → `Page<…>` |
| GET | `{base}/api/audit` | `?continueFrom=&batch=` → the report plus `continueFrom`, per `migrate.ts`'s shape |
| GET | `{base}/api/v1/*` | **Unchanged.** Keeps `ContentPage` and page numbers — and stays mounted first (decision 3) |

`count=1` answers `{ rows, cursor, total }`; without it, no `total` key and no
aggregate query.

Screens (HTML, all serving the admin shell): `{base}/`, `{base}/content`,
`{base}/documents/:type`, `{base}/assets`, `{base}/edit/:id`, `{base}/access`,
`{base}/model`, `{base}/redirects`, `{base}/settings`, `{base}/ui`.
`server/routes/shell.ts` loses its `SHELL_PREFIX`. Content's own state lives in its
query: `?view=tree|flat&sort=&state=&type=&q=`.

Error codes unchanged: a malformed cursor is a `400` with the one envelope
(`server/errors.ts`), not a silent first page — see edge cases.

## Acceptance criteria

### The tree loads one level at a time

```
GIVEN a site with 400 top-level pages
WHEN the admin opens {base}/content
THEN GET {base}/api/stories returns at most `limit` rows and a non-null cursor
AND no request in the boot path returns more than `limit` story rows
AND expanding a node requests only that node's children
```

### A filter is answered by the server

```
GIVEN 600 pages of which 12 are `changed`
WHEN the URL is {base}/content?state=changed
THEN the request carries state=changed
AND the response contains only rows whose derived state is `changed`
AND the SQL expression agrees with `draftState` for every row
```

### Paging is stable under concurrent writes

```
GIVEN a first page has been fetched and a cursor returned
WHEN a peer creates a page that sorts above the cursor
AND the next page is fetched with that cursor
THEN no row from the first page appears again
AND no row that existed before either request is skipped
```

### A count is asked for, never assumed

```
GIVEN a list route with a filter
WHEN it is called without ?count=1
THEN the response has no total AND no count(*) is executed
WHEN it is called with ?count=1
THEN a total for the whole filter is returned alongside the page
```

### The editor resolves links without a tree-wide fetch

```
GIVEN a document with three internal links and a richtext link mark
WHEN the editor opens it
THEN GET {base}/api/stories?ids= is called with those four ids
AND every internal link in the preview renders with its href
AND no request returns the whole stories table
```

### A screen owns its own URL

```
GIVEN the prefix move has landed
WHEN a signed-in editor loads {base}/content directly
THEN the admin shell is served as HTML
AND {base}/api/stories answers JSON
AND no path answers both
```

## Implementation plan

Six phases, each committable and green.

### Phase 1 — Collapse the schema

1. `migrations/0001_init.sql` — the composition of `0001`–`0010`, plus
   `users_created`. Delete the ten.
2. Rewrite `test/workers/migrations.test.ts` against the collapsed shape, keeping
   every column and index assertion it makes today.
3. Reset and reseed locally per `CLAUDE.md`; run one `scripts/*-test.mjs`.

### Phase 2 — The envelope, pure and tested first

1. `core/pagination.ts` — `Page<T>`, `encodeCursor`, `decodeCursor`, and
   `windowOf(rows, limit)` for the fetch-`limit + 1`/`hasMore` dance every route
   repeats.
2. `core/story.ts` — `StoryFilter`, and `stateExpr` next to `COLS` in
   `server/stories.ts`.
3. Unit tests, in Node: round-trip encoding, tie-breaking on equal first
   components, malformed cursors, and `stateExpr` against `draftState` over a table
   of rows.
4. Rewrite `redirects.ts`'s cursor as a caller of the shared module. Nothing else
   changes behaviour in this phase.

### Phase 3 — The prefix move, alone

1. `server/app.ts` — mount the resource routes under `/_`.
2. `server/pages.tsx` — `apiBase` becomes `${rt.base}/_`; the admin follows with
   no other change.
3. `server/routes/shell.ts` — drop `SHELL_PREFIX`; screens take the bare paths.
   `admin/ui/route.ts` needs no edit: it is mount-relative.
4. Sweep `test/` and `scripts/` (~265 paths).
5. Nothing in this phase changes a response body. Reviewable as a rename.

### Phase 4 — Page the routes

Least-coupled first, one commit each: assets, versions, activity, users, tokens,
audit (`continueFrom`), documents, then stories — the tree last, because it is the
one with a structural answer rather than a mechanical one.

Each: server reader takes `{ filter, cursor, limit }`, route parses and clamps via
`limitParam`, `count` opt-in, workers test for the boundary.

### Phase 5 — Retire the full fetches

1. `GET {base}/api/stories?ids=` and switch `Editor.tsx:252` to ask for the ids the
   open document mentions, reusing the walk in `core/refs.ts`.
2. `GET {base}/api/search`, and switch the link picker, the reference picker and the
   palette onto it.
3. `runtime.ts:525`'s `wantAll` branch: confirm what still needs it, and narrow or
   document it.

### Phase 6 — Retire the client-side pagers

1. `DataTable.tsx` — `ROWS_PER_PAGE`/`slice` out, next/previous over the cursor in,
   `Showing n of N` from `?count=1`.
2. `StoryTree.tsx` — `LEVEL_LIMIT` and "Show all N" out; expansion fetches.
3. Both are surfaces the UI rebuild replaces, so this phase is the minimum that
   keeps the current admin honest until the ports land. It does not restyle
   anything.

### Phase 7 — Flat mode

Last, because it is the only phase that adds a capability rather than fixing one,
and it wants the route and the shell prototype's Content screen both already
paged.

1. `?flat=1&sort=edited|title|path` on the stories read, over the indexes phase 1
   added. Keyset per sort: `(coalesce(draft_updated_at, updated_at), id)`,
   `(title, id)`, `(path)`.
2. `admin/ui/screens/Content.tsx` — a `[ Tree | Flat ]` toggle, `?view=` in the
   URL, last choice remembered as the default (`ui/remembered.ts` already does
   this for the sidebar).
3. Flat rows show the **full path** rather than the slug, since there is no indent
   to carry ancestry — the opposite of the tree's rule, and the reason
   `List.module.css` already carries a note about that trade.
4. Filters, selection and bulk actions are the same objects in both modes. That is
   the point of a toggle rather than a second screen; a test asserts a selection
   survives the toggle, which is decision 7a's "captures rather than tracks" in its
   cheapest possible form.

## Edge cases

- **A malformed or stale cursor** → `400` with the one error envelope, not a
  silent first page. Silently restarting looks like a scroll that jumped, and the
  cursor is opaque, so a client sending a bad one has a bug worth surfacing.
- **A cursor whose row has since been deleted** → keyset compares values, not
  identity, so the next page resumes from the same *position*. No error, nothing
  skipped. This is the property offset paging does not have.
- **Two rows sharing an `ord`** (two clients inserting between the same
  neighbours) → the cursor's second component is `id`, matching
  `compareSiblings`, so the boundary is total.
- **`?ids=` with more ids than a query can bind** → chunk server-side. D1's bind
  limit is the constraint, not the caller's; a document with 300 links is
  legitimate.
- **`?ids=` naming a deleted story** → absent from `rows`, no error. A dangling
  link already degrades safely (`resolveReference` returns null and the block
  renders its empty state).
- **A filter matching nothing** → an empty `rows` and a null `cursor`. Not a 404:
  the list exists, it is empty, and the screen draws an `EmptyState`.
- **`state=changed` on an unrouted document** → records and singletons have the
  same four columns, so the expression applies unchanged.
- **Audit on a site whose published documents exceed one batch** → `continueFrom`,
  and the report merges client-side across batches the way `migrate` already does.
- **A bulk count that moved between read and execute** → refuse with the new
  count, per `ui-architecture.md` 7a. Out of scope to implement; in scope not to
  design against.
- **Flat mode's `sort=edited` over a page nobody has opened** → sorts by
  `updated_at`, because `coalesce` makes the row's own timestamp the fallback. This
  is the case a plain `draft_updated_at desc` gets exactly backwards, sinking a
  page created minutes ago to the bottom of a list called "last edited".
- **Flat mode `sort=title` with two identical titles** → the cursor's second
  component is `id`, so the boundary is total. Duplicate titles are legitimate:
  `stories_type_slug` constrains the slug, nothing constrains the title.
- **Toggling tree ↔ flat with rows selected** → the selection survives, unchanged.
  Both modes list the same rows under a different ordering, so a toggle is a
  narrower case of "a selection survives a filter change".
- **`?view=flat` on a site with one page** → the toggle still renders. It is not an
  affordance that appears past a threshold; a control that comes and goes with the
  data is one a person cannot learn.

## Testing requirements

**Unit (`packages/folio/test/unit/`, Node, nothing mounted):**

- `encodeCursor`/`decodeCursor` round trip, including a component containing the
  separator, and rejection of malformed input.
- `windowOf` — `hasMore` at exactly `limit`, at `limit + 1`, and empty.
- `stateExpr` against `draftState` over a table covering all four states plus the
  `changed`-with-nothing-to-publish case.
- `StoryFilter` → query string → `StoryFilter` round trip, since the URL, the
  read and a captured selection all use it.

**Workers (`packages/folio/test/workers/`, real workerd):**

- `migrations.test.ts` rewritten for the collapsed schema.
- Per-level tree paging: boundary, tie on `ord`, and a level whose parent has no
  children.
- Stability: fetch page one, insert a sorting-above row, fetch page two, assert no
  duplicate and no skip.
- Every paged route: `limit` clamped, cursor honoured, `count` opt-in, malformed
  cursor is a 400.
- `?ids=` chunking above the bind limit.
- The prefix move: a screen path serves HTML, its JSON twin serves JSON, no path
  serves both.
- **The `/api` partition** (decision 3): no internal route sits under a versioned
  prefix, and every `/api/v1` path is one the content API documents. This is the
  test that earns the shared prefix, so it is not optional.
- **Flat mode's three sorts**, each paged to exhaustion, plus the null case:
  a never-opened page created *now* sorts above a page edited long ago under
  `sort=edited`. That assertion is the whole reason `coalesce` is there.
- The dropped index: `stories_draft_updated` is **absent** after the collapse.

**End to end (`scripts/*.mjs`, live dev server on port 5199):**

- `scripts/pagination-test.mjs` — seed enough rows to need three pages, walk the
  cursor to exhaustion, assert every row seen exactly once. Follow both existing
  conventions: stamp `PROTOCOL_VERSION` on every frame if it opens a socket, and
  `signInGlobally()` from `scripts/lib/auth.mjs` first.
- Extend one existing script to prove the editor still resolves links after
  phase 5, since that is the regression with the worst symptom: prose links
  rendering as unstyled text.

## Dependencies

- None outstanding. `storiesFor` (`stories.ts:137`), `limitParam`
  (`validate.ts:626`), the `continueFrom` pattern (`migrate.ts`, `reindex.ts`) and
  `stories_parent_ord` all already exist.
- No new Cloudflare resource, binding or host config.
- **Blocks** `docs/specs/admin/url-and-shell.md`, which cannot specify a screen's
  URL parameters until this decides what a page is, and cannot give a screen its
  path until phase 3.
- **Pairs with** `ui-architecture.md` decision 7a: `StoryFilter` and the opt-in
  count are the two things a bulk write needs.

## Out of scope

- **Bulk write endpoints.** They consume `StoryFilter` and the count and are
  otherwise their own spec, with their own batched job and refusal semantics.
- **Infinite scroll.** Next/previous first; a scroll container that fetches is a
  UI decision the screen ports can make once the route is honest.
- **FTS5 search.** Decision 8 — `like` plus `content_index` is enough for a
  picker, and an FTS table is a second write path.
- **`content_index` coverage for non-`indexed` fields.** Search reaches what is
  indexed plus title, slug and path. Widening it is `collections.md`'s business.
- **Restyling `DataTable` or `StoryTree`.** Phase 6 keeps them correct; the UI
  rebuild replaces them.

## Resolved

Four questions put to the owner, 2026-07-31. Two confirmed a recommendation, one
overrode it, one added scope — and the added scope is the one that improved the
spec, because building it out found a dead index and a null-ordering bug.

1. **The internal prefix is `{base}/api/`, not `{base}/_/`** — the recommendation
   was overridden. The objection to it was real (a versioned contract and an
   unstable internal surface would look like siblings) so it is answered rather than
   dropped: **a version segment is a promise, and its absence is the absence of
   one**, stated at the mount in `app.ts` and pinned by a partition test. Decision 3.
2. **Next / previous, plus a count** — `Showing 20 of 1,284`. Confirms the keyset
   choice while making the opt-in count the normal case for a list header; decision 5
   now says why opt-in still matters (a search box per keystroke, and the bulk guard
   sharing one implementation).
3. **The flat page list gets built, not just supported** — a `[ Tree | Flat ]`
   toggle on Content, and decision 2a. Writing it up produced the two findings this
   spec would otherwise have shipped without: `stories_draft_updated` has never been
   read by anything, and `order by draft_updated_at desc` sinks a page created five
   minutes ago to the bottom of a list called "last edited", because the column is
   nullable and SQLite sorts nulls last under `desc`.
4. **Substring search, not FTS5** — `like` over title, slug and path plus
   `content_index`. Decision 8, unchanged.

## Open questions

None. The last two closed themselves once written down, 2026-07-31:

- **The `state` expression is interpolated next to `COLS`, not a SQL view.**
  `draftState` in `core/story.ts` is the definition; a view would be a second place
  to read the same rule, and the migration is the worst place to keep a rule the
  tests pin — a schema file is the one thing this spec is trying to make legible in
  a single read.
- **Flat mode ships without `sort=state`.** It would need a fourth index for a sort
  nobody has asked for, over a column that does not exist and four distinct values.
  Adding it later is one index and one `order by`; guessing now is a write cost on
  every story forever — which is precisely the mistake `stories_draft_updated`
  already made once.
