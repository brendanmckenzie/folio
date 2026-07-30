# Feature: Pagination, everywhere, as a rule

> **Group:** foundation
> **Build order:** 18, per docs/specs/README.md
> **Size:** L ≈ a week or two
> **Status:** draft
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
- `stories_draft_updated (draft_updated_at desc)` — Home's recency block.
- `stories_path (path) where path is not null`, `stories_parent_slug`,
  `stories_type_slug`.
- `assets_created (created_at desc)`, `versions_story (story_id, created_at desc)`,
  `api_tokens_created (created_at desc)`, `content_index_lookup (field, locale,
  text_value)`, `content_refs_to (to_story)`.
- **`users` has no `created_at` index** while `listUsers` orders by it. The only
  index this spec adds.

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

1. **Two paging shapes, deliberately: keyset for the admin, page numbers for
   `/api/v1`.** Recommended. The codebase already has both and they are right for
   different jobs — see decision 1. The alternative is one shape everywhere, which
   means either page numbers over live content (a lie) or no page numbers in a
   public blog listing (a missing feature).
2. **The admin's internal JSON moves to `{base}/_/`.** Recommended: one character,
   unmistakably internal, and no screen will ever be named `_`. Rejected
   alternatives in decision 3.
3. **The ten migrations collapse into one `0001_init.sql`.** Recommended, and
   already the owner's standing position (`CLAUDE.md`, "This is greenfield").
   `test/workers/migrations.test.ts` is rewritten with it.
4. **`state` is a SQL expression, not a stored column.** Recommended — every input
   is already stored, so a column would be a denormalisation that can disagree
   with itself. Decision 4.

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

`GET {base}/_/stories` answers **one parent's children**, keyset over `(ord, id)`,
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

### 3. The admin's internal JSON moves to `{base}/_/`

The screens take the bare paths, because a screen is what a person links to,
bookmarks and sends to a colleague. Four of them — `/content`, `/assets`,
`/documents/:type`, `/redirects` — are JSON routes today, and the collision is
total rather than incidental: the screens and the API are named after the same
resources because they are about the same resources.

`server/app.ts` already declares everything below its `/api/v1` mount "internal to
the admin and free to change with it", which is precisely the licence needed.

After: `{base}/_/stories`, `{base}/_/documents`, `{base}/_/assets`,
`{base}/_/users`, `{base}/_/audit`, `{base}/_/search`, … and `{base}/content`,
`{base}/assets`, `{base}/edit/:id` are screens. `/api/v1` is untouched — it is the
one surface that *is* a contract.

**Rejected: `{base}/api/` for internal JSON.** Reads well, and it blurs the exact
line `app.ts` draws: under `/api` would then live both a versioned contract and an
unstable internal surface, distinguished only by the presence of `v1`.

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

### 5. A count is a separate, opt-in query

`Page<T>` carries no total. A list header that wants "24 pages" asks for it:
`?count=1` adds one `count(*)` over the same filter and returns it alongside.

Two reasons. Keyset paging does not need a count to work, so making it part of the
envelope charges every page for a number most pages do not show. And **the count
is load-bearing somewhere else**: it is the guard on a bulk write
(`ui-architecture.md` decision 7a — the server re-runs the captured filter,
compares the count to `expected`, and refuses on mismatch). One count endpoint
shape serves the list header and the bulk guard, and they must not drift.

**Rejected: `total` always in the envelope.** Simpler to consume, and it makes
every keystroke of a search box run a second aggregate query over the whole table.

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

`GET {base}/_/stories?ids=a,b,c` — `storiesFor(db, ids, paths)`
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

`GET {base}/_/search?q=&kind=&type=&limit=` — over `stories.title`, `slug`, `path`
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

Replaces `0001_initial.sql` … `0010_content_index.sql`. Identical final shape,
plus one index. Not reproduced in full here — it is the composition of ten
existing files — but the delta over today's end state is exactly:

```sql
-- listUsers orders by created_at and had no index for it.
create index if not exists users_created on users (created_at);
```

Every table, column, index and trigger otherwise carries over unchanged. The
acceptance criterion is that `migrations.test.ts`, rewritten, asserts the same
column and index set it asserts today, plus `users_created`.

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
| GET | `{base}/_/stories` | Was the whole tree. Now one level: `?parentId=&cursor=&limit=&type=&state=&q=&count=` → `Page<StoryMeta>` |
| GET | `{base}/_/stories?ids=a,b,c` | New mode, via `storiesFor`. Returns `{ rows }`, uncursored — a batch by id is not a page |
| GET | `{base}/_/documents` | `?type=&cursor=&limit=&state=&q=&count=` → `Page<StoryMeta>`. Still ensures singletons on first access |
| GET | `{base}/_/search` | New. `?q=&kind=&type=&limit=` → `Page<StoryRef>` |
| GET | `{base}/_/assets` | `?cursor=&limit=&q=&kind=&count=` → `Page<AssetRow>` |
| GET | `{base}/_/story/:id/versions` | `?cursor=&limit=` → `Page<VersionMeta>` |
| GET | `{base}/_/story/:id/activity` | `?cursor=&limit=` → `Page<ActivityEntry>` |
| GET | `{base}/_/users`, `{base}/_/tokens` | `?cursor=&limit=&count=` → `Page<…>` |
| GET | `{base}/_/audit` | `?continueFrom=&batch=` → the report plus `continueFrom`, per `migrate.ts`'s shape |
| GET | `{base}/api/v1/*` | **Unchanged.** Keeps `ContentPage` and page numbers |

Screens (HTML, all serving the admin shell): `{base}/`, `{base}/content`,
`{base}/documents/:type`, `{base}/assets`, `{base}/edit/:id`, `{base}/access`,
`{base}/model`, `{base}/redirects`, `{base}/settings`, `{base}/ui`.
`server/routes/shell.ts` loses its `SHELL_PREFIX`.

Error codes unchanged: a malformed cursor is a `400` with the one envelope
(`server/errors.ts`), not a silent first page — see edge cases.

## Acceptance criteria

### The tree loads one level at a time

```
GIVEN a site with 400 top-level pages
WHEN the admin opens {base}/content
THEN GET {base}/_/stories returns at most `limit` rows and a non-null cursor
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
THEN GET {base}/_/stories?ids= is called with those four ids
AND every internal link in the preview renders with its href
AND no request returns the whole stories table
```

### A screen owns its own URL

```
GIVEN the prefix move has landed
WHEN a signed-in editor loads {base}/content directly
THEN the admin shell is served as HTML
AND {base}/_/stories answers JSON
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

1. `GET {base}/_/stories?ids=` and switch `Editor.tsx:252` to ask for the ids the
   open document mentions, reusing the walk in `core/refs.ts`.
2. `GET {base}/_/search`, and switch the link picker, the reference picker and the
   palette onto it.
3. `runtime.ts:525`'s `wantAll` branch: confirm what still needs it, and narrow or
   document it.

### Phase 6 — Retire the client-side pagers

1. `DataTable.tsx` — `ROWS_PER_PAGE`/`slice` out, next/previous over the cursor in.
2. `StoryTree.tsx` — `LEVEL_LIMIT` and "Show all N" out; expansion fetches.
3. Both are surfaces the UI rebuild replaces, so this phase is the minimum that
   keeps the current admin honest until the ports land. It does not restyle
   anything.

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

## Open questions

- **Does `GET {base}/_/stories` with no `parentId` mean "the top level" or "every
  routed story, paged flat"?** The spec assumes the former throughout, and a flat
  paged mode may still be wanted for a future "all pages, sorted by last edited"
  view. Deferring costs nothing: it is a separate query parameter, not a different
  route.
- **Should the `state` expression live in a SQL view** rather than being
  interpolated next to `COLS`? A view is tidier and D1 supports it; it also puts a
  rule the tests pin into the migration rather than into the code they test.
