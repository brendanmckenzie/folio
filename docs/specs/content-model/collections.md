# Feature: Collections — querying documents instead of paging through all of them

> **Group:** content model
> **Build order:** 13
> **Size:** L
> **Status:** done
> **Wire version:** none
> **Migration:** `0010_content_index.sql`
> **Last updated:** 2026-07-29

## Summary

Folio can list the story tree and fetch one document. It cannot answer "the six
most recent insights tagged *policy*, page two". `PARITY.md` calls this
"the sleeper" and it is right: an insights index, a news list, a team grid, a
sitemap and a search page are all the same missing primitive, and every one of them
is currently a full scan in host code.

This spec adds three things:

1. A **publish-time index** — selected root-block fields projected into queryable
   columns, per locale, written atomically with the publish that produced them.
2. A **query engine** — `folio.query(env, …)` and a public HTTP route over it, with
   filter, sort and pagination.
3. A **`collection` field** — so a block declares "a list of insights, filtered by
   a topic the editor picks", receives the results already resolved, and the
   preview still re-renders per keystroke with no network in the loop.

It also fixes a scaling problem collections make impossible to ignore:
`rt.resolve()` loads **every story in the site** on every page render.

## Ground truth

**server (`packages/folio/src/server/`):**
- `runtime.ts:104-127` — `resolve()` calls
  `buildResolution((await listStories(db)).map(withUrls), assetBase)`. `listStories`
  is `select … from stories` with **no limit**. So a page render is O(all stories),
  and so is every tree render and every preview boot. At 40 pages this is
  invisible; at 800 insights it is the whole request.
- `publishedDocsByIds(db, ids)` (`stories.ts`) — one `where id in (…)`, the exact
  shape a result page needs.
- `publishStoryStatement` + `buildVersionWrite` are batched in `publish()` via
  `db.batch([…])`, precisely so the two cannot disagree. **An index write joins that
  batch**, which is what makes the index unable to drift from what is published.
- `deleteStoryStatement` returns an unrun statement plus the affected ids so a
  caller can batch the story delete with the versions delete. Index and ref rows
  join the same batch.
- `published_doc` is the whole document as JSON: `{ root: 'u0', bloks: { … } }`.
  The root blok's key is a random uid (`newUid`), so a root field's JSON path is not
  a constant — it is `$.bloks."<uid>".data.<field>`.
- `folio.stories(env)` is what the demo's `sitemap()` uses, and it returns every
  story with no pagination (`examples/demo/src/index.tsx`).

**core (`packages/folio/src/core/`):**
- `referencedIds(doc, schema)` walks bloks, finds `reference` fields, returns the id
  set — *"The caller loads exactly these and nothing else, so a page with no
  references costs no extra reads at all."* A collection field needs the same
  treatment, one level up: collect the queries, run them once, put the answers on
  the `Resolution`.
- `resolveReference` returns `ReferenceTarget { id, title, path, url, data, doc }` —
  the shape a block author already knows, and therefore the shape a collection item
  should be.
- `Resolution.docs` is populated only for the ids a document points at, and
  `RenderBlok` empties it on the way down to bound resolution to one level.

**admin (`packages/folio/src/admin/`):**
- `useReferencedDocs.ts` fetches referenced documents when the **set of ids**
  changes, never per render, for the stated reason that the preview re-renders on
  every keystroke. A collection hook is the same pattern keyed on the query set.

## Owner decision checkpoints

1. **An index table, not `json_extract` (recommended).** SQLite *can* address a root
   field with a computed path
   (`json_extract(published_doc, '$.bloks."' || json_extract(published_doc, '$.root') || '".data.topic')`)
   and can even index that expression. It is rejected because it needs one
   expression index per queryable field **per locale**, the expression is a nested
   extract nobody can read six months later, it cannot reach a field on a nested
   block if that is ever wanted, and it gives no natural home for reference edges.
   A 4-column table with two indexes does all of it. Cost: a write on every publish,
   and one more thing that must be rebuilt if it is ever corrupted (a rebuild
   command is part of this spec for that reason).
2. **Offset pagination (recommended).** `limit`/`offset` over an indexed sort.
   Keyset pagination is strictly better at scale and the scale is wrong: a CMS
   index page is hundreds of rows deep, not millions, and offset lets a page render
   "page 4 of 9" — which keyset cannot without a count anyway. Revisit if a
   collection ever exceeds ~10k rows.
3. **Collections in preview resolve against published content (recommended).**
   Querying drafts would mean opening every candidate Durable Object on every
   keystroke. The open story's own draft values are patched into the results when it
   is a member, and the list is marked `stale: true` so a block can show "list shows
   published items". The alternative — a draft index — doubles the index and needs a
   write per keystroke.
4. **A collection is a query, not a folder (recommended).** No new entity, no
   membership table: "the insights under /insights" is a filter on `type` and
   `parent_id`. The alternative — an explicit collection document holding a list —
   is a second ordering to maintain and drifts the moment someone creates an insight
   without touching it. Hand-picked lists are covered by `references()` in
   `data-documents.md`, which is the honest answer to the case where a query is the
   wrong tool.
5. **`resolve()` stops loading every story (recommended).** It loads the ids the
   document actually needs — its links, its references, its ancestors for
   breadcrumbs — plus every routable story only when a host asks for the full map.
   Cost: a behaviour change in `buildResolution`, which currently receives
   everything. This is a fix, not a feature, and collections are what make it
   urgent.

## User stories

### Editor builds an index page
**As** an editor **I want** an "Insight list" block where I choose a topic and a
count **so that** an index page keeps itself up to date as insights are published.

### Visitor pages through a list
**As** a visitor **I want** `/insights?page=3` to work **so that** I can reach older
articles.

### Developer builds a sitemap without a full scan
**As** a developer **I want** `folio.query(env, { type: 'page', perPage: 500,
page: n })` **so that** a sitemap of 2,000 pages does not load 2,000 documents.

### Developer filters an index in their own route
**As** a developer **I want** to query published content from my own Worker route
**so that** a filtered archive page is ordinary application code.

### Editor sees the list in the preview
**As** an editor **I want** the list block to show real items in the preview **so
that** I am not designing against a placeholder.

## Architecture decisions

### 1. `content_index`: one row per (story, locale, field), scalars only

```sql
content_index(story_id, locale, field, text_value, num_value)
```

Scalars because the table exists to **filter and sort**, not to render. What a card
needs to render (a heading, an image, a link) is content, and content lives in the
document — so a query loads the published documents for the *page* of results it is
returning (one `publishedDocsByIds` call, at most `perPage` rows) and hands each
item back as a `ReferenceTarget`, the shape `reference` already resolves to. A block
author who can render a reference can render a collection item with no new
knowledge.

`num_value` is separate from `text_value` so `order by` and range filters are
numeric rather than lexicographic. A field indexes into one or the other by its kind
(`number` → num, `boolean` → num 0/1, dates-as-text → both: ISO strings sort
correctly as text *and* parse to a number, and storing both costs 8 bytes and
removes a class of bug).

Per locale because a French index page filtered on a French topic is the whole point
of having translated fields (`localisation.md`).

### 2. Indexed fields are declared on the field, and only on a root block

```ts
export const insightRoot = defineBlock({
  name: 'insightRoot',
  fields: {
    title:     text({ required: true, indexed: true }),
    topic:     select({ options: TOPICS, indexed: true, translatable: false }),
    published: text({ label: 'Publish date', indexed: true }),   // ISO 8601
    body:      blocks({ allow: [...] }),
  },
  render: …,
})
```

Colocated with the field, like every other constraint in Folio, so the admin can
show that a field is filterable and the audit can report an index the schema no
longer declares.

**Root block only.** A field on a nested block would mean the index depends on which
blocks exist inside a document, so a block insert changes the index and the write is
no longer a fixed projection. The escape hatch, when one is genuinely needed, is a
root field the editor fills in — which is what "publish date" is anyway.

### 3. The index is written inside the publish batch, and rebuildable

`publish()` already batches the version insert and the `stories` update. It gains:

```
delete from content_index where story_id = ?
insert into content_index …            (one per indexed field per locale)
delete from content_refs where from_story = ?
insert into content_refs …             (one per outbound link/reference target)
```

All in the same `db.batch`, so the index cannot describe a document that is not
published, and a failed publish leaves neither. Delete-then-insert rather than
upsert because the set of rows shrinks when a field is cleared or a locale removed,
and a diffing upsert would have to work that out.

`content_refs` is written here because publish is the only moment the full outbound
edge set of a published document is in hand. It powers usage counts in
`data-documents.md` and, later, the cache purge set (`ROADMAP.md`).

`POST /folio/reindex` (admin) rebuilds both tables from `published_doc` in batches,
for a schema change that adds an `indexed` flag to an existing field — the one case
where publish-time writing is not enough, since nothing republishes.

### 4. `query()` in the server, one shape, three callers

```ts
export interface ContentQuery {
  type?: string | readonly string[]
  parent?: string | null            // direct children only; null = top level
  locale?: string                   // filters and sorts against this locale's index
  where?: Array<
    | { field: string; op: 'eq' | 'ne' | 'in' | 'contains' | 'startsWith'; value: string | readonly string[] }
    | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  >
  order?: { field: string; dir: 'asc' | 'desc' } | 'publishedAt' | 'ord' | 'title'
  page?: number                     // 1-based
  perPage?: number                  // default 20, max 100
  /** Published only (default), or drafts too — requires a draft-scoped caller. */
  status?: 'published'
}

export interface ContentPage {
  items: ReferenceTarget[]
  total: number
  page: number
  perPage: number
  pages: number
}
```

One `where` clause becomes one `exists (select 1 from content_index …)` subquery
against `(story_id, locale, field)`; several are anded. `order` joins the index once.
`total` is a second `count(*)` over the same predicate — two queries per collection,
which is why a page render resolves each distinct query once and shares it
(decision 5).

Callers: `folio.query(env, q)` for hosts, `GET /folio/content` for the admin and
external readers (`../platform/content-api.md` owns the auth and the shape of that
route's envelope), and the collection-field resolver.

### 5. A `collection` field is a query the editor configures, resolved onto the `Resolution`

```ts
fields: {
  list: collection({
    type: 'insight',
    filterable: ['topic'],      // what the editor may narrow by
    maxPerPage: 12,
    defaultOrder: { field: 'published', dir: 'desc' },
  }),
}

render: ({ list }) => (
  <ul>{list.items.map((i) => <li key={i.id}><a href={i.url}>{i.title}</a></li>)}</ul>
)
```

The stored value is the editor's choices — `{ where: [{ field: 'topic', op: 'eq',
value: 'policy' }], perPage: 6, page: 1 }` — validated against the field's
constraints on the way in and again on the way out, the same double enforcement
richtext's `marks` already has.

Resolution follows `reference` exactly: `collectionQueries(doc, schema)` returns the
distinct queries a document contains, the server runs each once and puts the answers
on `Resolution.collections`, keyed by a stable hash of the normalised query. So a
page with no collection field costs no extra reads, two blocks with the same query
cost one, and the preview client re-renders per keystroke against data it already
holds — the constraint that shapes every resolution decision in this codebase.

Pagination on a published page is the host's: it reads `?page=` and passes it into
`folio.resolve(env, doc, { page })`, which offsets every collection field in the
document. A page with two independently paginated lists is out of scope
(`?page` is one number), and the alternative — per-field page parameters keyed by
uid — is left until something needs it.

### 6. `resolve()` stops loading every story

`buildResolution` currently receives every row so any link can be resolved. It
becomes:

```ts
resolve(bindings, doc, { locale, page })
  → ids = linkedIds(doc, schema) ∪ referencedIds(doc, schema) ∪ ancestorsOf(story)
  → one `where id in (…)` for those rows
  → collection queries run separately, and their results carry their own StoryRefs
```

`folio.stories(env)` keeps returning everything for hosts that want it (the demo's
sitemap), now with pagination available. The admin's tree keeps loading the tree,
which is pages only after `../foundation/document-types.md` — and gains lazy
children per parent beyond a threshold, because a tree node with 800 insights under
it is unusable regardless of how fast the query is.

## Wire & schema changes

### D1 migration `0010_content_index.sql`

```sql
-- Queryable projection of published documents. Written inside publish()'s batch,
-- so it cannot describe an unpublished document, and rebuildable from
-- published_doc with POST /folio/reindex.
--
-- Scalars only: this table filters and sorts. Rendering a result loads the
-- published document for the page of results being returned.
create table if not exists content_index (
  story_id   text not null,
  -- '' is the source locale, so a single-locale site has exactly one row per
  -- field and no null handling anywhere.
  locale     text not null default '',
  field      text not null,
  text_value text,
  -- Numbers, booleans (0/1) and parsed dates, so ordering and ranges are numeric
  -- rather than lexicographic. A date is stored in both columns.
  num_value  real,
  primary key (story_id, locale, field)
);

create index if not exists content_index_lookup on content_index (field, locale, text_value);
create index if not exists content_index_num    on content_index (field, locale, num_value);

-- Outbound edges of a published document: story links, references, and the
-- targets of a collection field's stored filter when it names one. Written in the
-- same batch. Powers "used by N documents" and, later, the cache purge set.
create table if not exists content_refs (
  from_story text not null,
  to_story   text not null,
  -- 'link' | 'reference'
  kind       text not null,
  primary key (from_story, to_story, kind)
);

create index if not exists content_refs_to on content_refs (to_story);
```

No foreign keys, matching the rest of the schema: `versions.story_id` is a
convention too, and cleanup is batched explicitly where it happens
(`deleteStoryStatement`).

### Core types

- `Field` gains `indexed?: boolean` (on `text`, `textarea`, `number`, `boolean`,
  `select` only — typed so `richtext({ indexed: true })` does not compile) and a new
  `collection` kind.
- `ValueOf<collection>` is `ResolvedCollection = ContentPage & { stale?: boolean }`.
- `Resolution.collections?: Record<string, ResolvedCollection>`.
- `collectionQueries(doc, schema)`, `linkedIds(doc, schema)`,
  `indexRowsFor(doc, type, schema, locales)` — all pure, all in core, all testable
  without a database.
- `queryKey(q)`: a stable hash of the normalised query, so the admin and the server
  agree on the key without coordinating.

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/folio/content` | public for published; draft needs a scope | `ContentQuery` as query params, `ContentPage` as JSON |
| POST | `/folio/reindex` | admin | Rebuild `content_index` and `content_refs`; batched, resumable, returns counts |

`GET /folio/documents?type=` from `../foundation/document-types.md` becomes a thin
wrapper over `query()` and gains pagination.

## Acceptance criteria

### Filter, sort, paginate
```
GIVEN 25 published insights, 10 tagged 'policy', with published dates
WHEN GET /folio/content?type=insight&where=topic:eq:policy&order=published:desc&perPage=6&page=2
THEN 4 items come back, newest first, with total 10, pages 2
AND exactly two D1 statements ran for the predicate (count + page) plus one for
    the page's documents
```

### The index is atomic with the publish
```
GIVEN an insight whose topic changes from 'ai' to 'policy'
WHEN it is published
THEN its content_index row for topic reads 'policy'
AND a query for 'ai' no longer returns it
AND WHEN the publish batch fails
    THEN neither published_doc nor content_index changed
```

### Unpublished and deleted content leaves the index
```
GIVEN a published insight
WHEN the story is deleted
THEN its content_index and content_refs rows go in the same batch as the story
     and version rows
AND a query no longer returns it
```

### A collection field renders on a published page
```
GIVEN a page with an insight-list block configured to topic 'policy', 6 per page
WHEN the page is requested
THEN six insight items render with their titles and URLs
AND the page ships no JavaScript
AND a page with no collection field runs no collection query at all
```

### The same query twice costs once
```
GIVEN two blocks on one page with identical collection configuration
WHEN the page renders
THEN one query runs and both blocks render the same items
```

### Preview
```
GIVEN an editor previewing an index page
WHEN the preview loads
THEN the list shows published items, marked stale
AND WHEN the editor is previewing an insight that is a member of that list
    THEN its draft title appears in the list rather than its published title
AND typing into an unrelated field re-renders the list from data already held,
    with no network request
```

### Locale
```
GIVEN an insight whose topic is translated to 'politique' in fr
WHEN a French index page filters topic eq 'politique'
THEN it matches
AND the English page filtering 'policy' matches the same story
```

### Reindex
```
GIVEN a field newly marked indexed and 200 published documents
WHEN POST /folio/reindex runs
THEN every document's rows are rebuilt from published_doc, the run is resumable,
     and queries against the new field work without republishing anything
```

### Resolution no longer scans
```
GIVEN 800 stories and a page with two links and one reference
WHEN the page renders
THEN the resolution query loads those three stories plus the page's ancestors,
     not 800
AND every link and reference still resolves correctly
```

## Implementation plan

### Phase 1 — the index

1. Migration `0010_content_index.sql`.
2. `core/fields.ts`: `indexed`; `core/index-projection.ts`: `indexRowsFor(doc, type,
   schema, locales)` — pure, locale-aware, root-block only.
3. `core/refs.ts`: `linkedIds`, and the outbound edge set for `content_refs`
   (reuses `referencedIds` and the link walk that
   `scripts/fields-test.mjs` already exercises for renames).
4. `server/publish.ts`: index and ref statements in the existing batch.
5. `server/stories.ts`: index/ref deletes in `deleteStoryStatement`'s batch.
6. `server/reindex.ts` + `POST /folio/reindex`.
7. Tests: unit tests for the projection (locales, missing values, booleans, dates
   in both columns); workers tests for atomicity, delete cascade, and reindex.

### Phase 2 — the query engine

1. `server/query.ts`: `ContentQuery` → SQL, with every value bound (never
   interpolated), field names checked against the schema's indexed set before they
   reach SQL, `perPage` clamped, `page` clamped.
2. `server/routes/content.ts`: `GET /folio/content`, parsing via valibot in
   `validate.ts` with the same error envelope as everything else.
3. `folio.query(env, q)` on the public interface.
4. Tests: every operator; unknown field refused with `bad_request` (not a 500 and
   not a silent empty result); injection attempts through field names and values;
   pagination edges (page 0, page past the end, perPage over the cap).

### Phase 3 — the collection field

1. `core/fields.ts`: the `collection` kind, `ValueOf`, `collectionQueries`,
   `queryKey`.
2. `core/resolve.ts`: `Resolution.collections`; `resolveValue`'s `collection` case
   reads it (returning an empty page when absent, so a block never crashes).
3. `server/runtime.ts`: run the document's queries in `resolve()`; patch the open
   draft's values in preview mode (decision 3).
4. `admin`: a `CollectionInput` (type is fixed by the schema; the editor picks
   filters from `filterable`, a count, and an order), and a `useCollections` hook
   modelled on `useReferencedDocs` — fetch when the query *set* changes, never per
   render.
5. Tests: unit tests for `collectionQueries` dedupe and `queryKey` stability; admin
   tests for the input's constraint enforcement; a preview-bridge test that a
   keystroke does not refetch.

### Phase 4 — resolution scaling and the tree

1. `core/resolve.ts` / `server/runtime.ts`: narrow the resolution to the ids a
   document needs (decision 6). This is a behaviour change with a test each way:
   every link still resolves, and the query loads a bounded set.
2. `folio.stories(env, { page, perPage })`, keeping the unpaginated form working.
3. `StoryTree.tsx`: lazy children beyond a threshold, with a "show all" affordance.
4. `admin`: a collection list view per type (columns from `indexed` fields plus the
   title), sortable, paginated, with "New <type>" in context.

### Phase 5 — docs

1. `README.md`: a Collections section, the `collection` field, and the corrected
   claim about what resolution loads.
2. `PARITY.md`: Phase 2's *Query API* item, and note that full-text search
   is still open.
3. `ROADMAP.md`: *Story enumeration* out of *Uncovered*.

## Edge cases

- **A `where` on a field that is not `indexed`** → `bad_request` naming the field.
  Never a silent empty result: that is the failure mode that costs an afternoon.
- **An indexed field whose value is an object** (someone marks an `asset` indexed
  in a hand-written schema despite the type) → the projection stores `null` and the
  audit reports it. It cannot happen through the field builders.
- **A document with no value for an indexed field** → no row, so `eq` does not match
  and `order` sorts it last (`left join` with nulls last, stated explicitly in the
  SQL rather than left to SQLite's default).
- **`contains`** → `like '%x%'`, which cannot use the index. Documented as a scan and
  capped: allowed only alongside at least one indexable predicate, or on a
  collection under a size threshold. Full-text search is the real answer and is out
  of scope.
- **A collection field whose type was deleted from the config** → the query returns
  nothing and the admin's input shows "unknown type", the same posture unknown block
  types already have.
- **A collection pointing at its own page** (an index page listing pages, including
  itself) → allowed, and it does not recurse: items are `ReferenceTarget`s, and
  their `content` is only rendered if a block asks for it. A block that renders
  `item.content` for a self-including list gets one level, because
  `RenderBlok` empties `docs` on the way down — the existing bound covers this.
- **Two blocks, same query, different pages** → different `queryKey`s (page is part
  of the normalised query), so two queries. Correct, and the dedupe still catches
  the common case.
- **Reindex racing a publish** → both write the same rows; publish's batch wins for
  its own story, and reindex is idempotent. Worst case a row is written twice.
- **`perPage` of 1,000** → clamped to 100. A host wanting 2,000 sitemap entries
  pages through, which is why `folio.query` reports `pages`.
- **Index rows for a story that was never published** → none, and a draft-only
  document is therefore invisible to queries. That is correct for public pages and
  a limitation for the admin's list views, which is why `status: 'draft'` is a named
  open question rather than pretended solved.

## Testing requirements

**Unit:** the projection (every field kind, locales, absent values, date dual
storage); `collectionQueries` dedupe; `queryKey` stability across key order;
`linkedIds` over links inside richtext (the existing rename test in
`scripts/fields-test.mjs` proves that walk exists — reuse it).

**Workers:** every operator against a seeded database; atomicity of the publish
batch; delete cascade; reindex resumability; the narrowed resolution query;
injection attempts.

**End to end (`scripts/collections-test.mjs`, new):** seed 25 insights, publish
most, render an index page and assert the right six in the right order with no
`<script>`; page two; a locale-filtered query; edit an insight's title and assert
the index page's preview shows the draft title while the live page does not; delete
an insight and assert it leaves the list.

## Dependencies

- `../foundation/document-types.md` — a collection filters on `type`, which does not
  exist without it.
- `localisation.md` — the index is per locale. Buildable before localisation with
  `locale = ''` everywhere, and the column is there from the start so that is not a
  migration later.
- `../foundation/identity-and-access.md` — `POST /folio/reindex` is admin-gated, and
  draft-scoped queries need a scope.
- Consumers: `data-documents.md` (list views, usage counts),
  `../platform/content-api.md` (the read half is this route).

## Out of scope

- **Full-text search.** D1 supports FTS5 and it is the right answer for a search
  page; it is a separate index, a separate write path and a separate ranking
  question. `PARITY.md` sizes it at **M** and it should stay its own spec.
- **Draft-status queries** in the public route. The admin needs them for its list
  views (an unpublished insight must appear in the editor's list), and the honest
  answer is a second source — the `stories` table plus `draft_updated_at` from
  `../editing/unpublished-changes.md` — rather than a draft index. Named as an open
  question.
- **Indexing nested block fields** (decision 2).
- **Per-field pagination** on a page with two paginated lists (decision 5).
- **Faceted counts** ("Policy (12), AI (8)"). One `group by` over the same
  predicate; genuinely easy to add, deliberately not added until a design asks for
  it.
- **Cache invalidation using `content_refs`.** The table is written here; the cache
  it would purge does not exist yet.

## Open questions

Both resolved, and built as resolved.

- **The admin's list views query the `stories` table directly.** No draft index
  rows are maintained, and none ever will be by this design: the index is
  published-only by construction, and an editor's list is a list of *documents*,
  not a query over content. `listDocuments(db, type?)` and `GET /folio/documents`
  (from `../foundation/document-types.md`) are what the Data section reads, and
  `GET /folio/documents` was deliberately **not** turned into a wrapper over
  `query()` — doing so would have made every unpublished record invisible in the
  editor, which is the opposite of what an admin list is for.
- **`order` accepts a single field.** One was enough for every case examined, and a
  second is additive: it has to be threaded through the canonical form, the query
  string and the SQL, which is not free for a case nothing has asked for.

## Implementation notes

Landed in four commits. Tests: **1451 → 1566** (53 → 59 files), plus
`scripts/collections-test.mjs` at 45 checks. All four gates green by exit code;
every one of the nine e2e scripts re-run from a fresh database.

### What landed

**Phase 1, the index.** `migrations/0010_content_index.sql` — two new tables,
`stories` untouched. `core/index-projection.ts` (`indexRowsFor`, `projectValue`,
`indexedFieldNames`, `isIndexed`), `core/refs.ts` (`linkedIds`, `outboundRefs`,
`referencedIdsAllLocales`), `server/content-index.ts` (statement builders plus
`countReferencesTo` / `referencesTo` for spec 14), `server/reindex.ts`. The index
statements join publish's existing `db.batch`; unpublish and delete drop them in
theirs. `Field` gained `indexed?: boolean` on the five scalar kinds only, so
`richtext({ indexed: true })` does not compile.

**Phase 2, the query engine.** `core/query.ts` holds the shapes, the canonical form
and `queryKey`; `server/query.ts` turns one into SQL. `folio.query(env, q)`,
`folio.reindex(env, opts)`, `GET /folio/content`, `POST /folio/reindex`.

**Phase 3, the field.** `collection()`, `ValueOf<collection> = ResolvedCollection`,
`collectionQueries` / `collectionQuery` / `resolveCollection`,
`Resolution.collections` and `Resolution.page`. In the admin, `CollectionInput` and
`useCollections`.

**Phase 4, the narrowing.** `resolve()` loads a bounded id set (see below).
`folio.stories(env, { page, perPage })`. `StoryTree` truncates a level past fifty
siblings with "Show all N".

**Phase 5, docs.** README gained a Collections section and the corrected claim about
what resolution loads; `PARITY.md`'s *Query API* is done (full-text search
explicitly still open); `ROADMAP.md` records it and drops *Story enumeration* from
*Uncovered*.

### Deliberate deviations, and why

1. **`queryKey` is the canonical form, not a hash of it.** The spec asked for "a
   stable hash of the normalised query, so the admin and the server agree on the key
   without coordinating". The canonical string serves that purpose exactly, and a
   hash would trade a key you can read in a payload for a collision that silently
   serves one block another block's list. A page carries a handful of collections.
2. **A query is two D1 statements, not three.** The spec costed it as count + page +
   `publishedDocsByIds`. The page statement selects `published_doc` alongside the
   story columns, which is identical bytes with one fewer hop — and the id list the
   third statement would bind is the list the second just produced. The acceptance
   criterion's "exactly two … plus one" is met as "exactly two".
3. **`GET /folio/content` is gated at `READ`, not public.** The route table says
   "public for published"; the same section says `../platform/content-api.md` owns
   this route's auth and envelope. Published content is public by definition, so
   opening it later costs nothing, whereas opening it now and having spec 15 decide
   otherwise means removing a public surface. A published page is unaffected either
   way: its collections resolve inside `resolve()`, with no HTTP in the loop.
4. **`GET /folio/documents` did not become a wrapper over `query()`.** See the
   resolved open question above — it would have hidden every draft from the admin.
   It gained nothing; `folio.stories` is where pagination landed.
5. **`ne` is a `NOT EXISTS`.** So "topic is not ai" is true of a document with no
   topic, which is what it means in English. An `exists (… <> ?)` would have
   silently excluded every one of them.
6. **`collectionQueries` and `queryKey` live in `core/query.ts`, not
   `core/fields.ts`.** `fields.ts` is a leaf that imports types only; a document
   walk and a canonicaliser do not belong in it.
7. **The locale is not part of `queryKey`.** It rides on the `Resolution` alongside
   `page`, so one canonical form serves every language and `resolveCollection`
   computes the same key whichever locale it is rendering. `runQuery` takes the
   locale separately.
8. **`resolve()` gained `opts.story` and `opts.stories`, and `Resolution.page`.**
   The spec's sketch was `resolve(bindings, doc, { locale, page })`. Ancestors need
   the rendered story's *path* (they are addressed by path, in the same query — a
   recursive `parent_id` walk could not be), and the draft patch needs its id and
   type. `stories: 'all'` is decision 6's "plus every routable story only when a
   host asks for the full map", made explicit.
9. **Phase 4 step 4 — a per-type admin list view with columns from the indexed
   fields — was not built.** `data-documents.md` owns list views, and this spec's own
   resolved open question routes the admin's lists at `stories` rather than at the
   index, so it would have been built here and immediately rebuilt there. Recorded in
   `ROADMAP.md` rather than half-done.

### Where the spec was wrong about the codebase

- **`resolve()`'s narrowing needs three passes, not one.** The spec's sketch is
  `ids = linkedIds ∪ referencedIds ∪ ancestorsOf(story)` and one `where id in (…)`.
  But a referenced document and a global both contain links of their own, and
  `RenderBlok` empties `docs` one level down while `stories` **survives** — so a
  link inside a global's navigation resolves against the narrowed map. The
  implementation loads the direct ids, fetches the pulled-in documents, then loads
  what *those* point at. Three D1 reads worst case, two typically, one when there
  are no globals and no references — against two unconditionally before.
- **`referencedIds` reads the source locale only.** It is public API and
  `useReferencedDocs` keys off it, so it was left alone; `referencedIdsAllLocales`
  in `core/refs.ts` is the widened form the resolution and `content_refs` use. A
  translated `reference` target now resolves on a live page and still does not in the
  admin's own copy — recorded in `ROADMAP.md`.
- **The spec's `content_refs` note about "the targets of a collection field's stored
  filter when it names one" has nothing to write.** A collection filters on indexed
  *fields*; no stored filter names a story id. Left unimplemented rather than
  invented.
- **`unpublishStoryStatement`'s own doc comment already anticipated this spec** and
  said it was written unrun so the query-index deletes could join its batch. They do.

### The bug this spec could have reintroduced, and did not

A Folio-native richtext link mark stores a structured `attrs.link`
(`{ kind: 'story', id }`) and has **no `href`** — the href is derived from the
resolution at render time, which is what lets an internal prose link survive a
rename. Narrowing `resolve()` to `multilink` and `reference` *fields* would have
rendered every one of them as unstyled text with no anchor, and the two unit tests
guarding the sanitiser would still have passed, because they test the sanitiser.

`core/refs.ts` walks richtext marks, across `data` **and** every `i18n` locale. Three
tests pin it from three directions: a unit test that a story id reachable *only*
from a link mark is in `linkedIds`; a workers test that such an id is in the
resolution with a real URL and that nothing else is; and an e2e check that the
published page contains `href="/collections-index"`.

### Deferred, and named

Full-text search (its own spec, **M**); faceted counts (one `group by`, unbuilt
until a design asks); per-field pagination; draft-status queries; a `collection` on a
nested block; the admin list view above.

`content_refs` rows pointing at a deleted story were deferred here — another
document still names it, which is the fact spec 14 reads, and the row is rewritten
when that document is next published. **Since built:** `deleteStoryStatement` now
batches `clearInboundRefStatements` alongside `clearIndexStatements`, so a delete
drops the edges in both directions. An unpublish still keeps the inbound half,
because the story is still there to warn about.

### What spec 14 needs

```sql
create table content_refs (
  from_story text not null,
  to_story   text not null,
  kind       text not null,          -- 'link' | 'reference'
  primary key (from_story, to_story, kind)
);
create index content_refs_to on content_refs (to_story);
```

`countReferencesTo(db, id)` → `{ total, links, references }` (one `group by kind`)
and `referencesTo(db, id)` → the rows, both in `server/content-index.ts` and both
exported from `folio/server`. Published references only, which is what the table
holds — a draft pointing somewhere is not yet a usage. Self-edges are dropped, so a
page linking to itself never warns about itself.
