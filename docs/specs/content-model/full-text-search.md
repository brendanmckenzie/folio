# Feature: Full-text search

> **Group:** content model
> **Build order:** 30
> **Size:** M
> **Status:** draft
> **Wire version:** none
> **Migration:** `0007_content_fts.sql` — a claim. **Takes `0005` on the decided
> order** (31 carries none), and every `0007` in this file restamps with it.
> **Build sequence:** 2 of 4 — 31 → 30 → 28 → 29 (owner, 2026-09-05). The **Build order** above is this spec's identity, not its place in the queue.
> **Last updated:** 2026-09-05

## Summary

Search today is substring `like` over `stories.title`, `slug` and `path`, plus a
correlated probe into `content_index.text_value` (`src/server/stories.ts:383-470`,
`searchStories` at `:865-903`). It cannot reach body text, it cannot rank, and the
query compiler refuses a bare `contains` with the comment "Full-text search is the
real answer and is out of scope" (`src/server/query.ts:130-134`). Spec 18 rejected
FTS5 by name (`foundation/pagination.md:430-433`) and `docs/design-system.md:453-461`
named the trigger for taking it up: *body-text search being asked for*. The owner has
asked for it.

This spec adds an FTS5 index written **inside the same publish batch as
`content_index`**, and makes full-text a term of `ContentQuery` — `search` — so
`folio.query`, the `collection` field, `GET {base}/api/content`, `GET /api/v1/documents`
and MCP `query_documents` all get ranked, snippeted search from one compiler.

## Ground truth

Verified 2026-09-05 against the tree. Line numbers are load-bearing where given.

**core (`src/core/`):**
- `index-projection.ts:152-183` `indexRowsFor(doc, type, schema, locales)` reads the
  **root block only**, emits one row per (locale, field): source locale `''` first,
  then each declared non-source locale via `fieldValue(root, name, ctx)` with
  `localeChain` (`:178-179`). Its doc comment (`:141-151`) promises a stable row
  order so publish and reindex write byte-identical SQL. `indexedFieldNames` at `:87`
  is the set `where`/`order` are checked against. This is the pattern to copy.
- `refs.ts:104`, `:144`, `:189` walk **every** blok (`Object.values(doc.bloks)`) and
  `:61` walks every `i18n` map — the whole-graph precedent. `outboundRefs` at `:244`.
- `richtext.ts:283` `richtextToText(doc: RichtextDoc): string`, whose comment says it
  is "for excerpts, search indexing and `summary`". `asRichtext` at `:94` accepts a
  plain string. Node names at `:18-28` include `codeBlock`. `RichtextDoc` at `:76`.
- `schema.ts:233` `titleOf(doc, type, schema, fallback, locale?)` — the one function
  that fills `stories.title` and `title_i18n` (`server/runtime.ts:522-545`).
- `fields.ts:72-74` `interface Indexable { indexed?: boolean }`, mixed into exactly
  the five scalar kinds at `:82-86`; `richtext` at `:103-108` is `& Common` only, so
  `richtext({ indexed: true })` does not compile, on purpose (`:58-70`). `Common`
  carries `showIf` (`:18`), `hidden` (`:20`), `translatable` (`:48`). The
  `collection` kind is `:172-179` (`type`, `filterable`, `maxPerPage`,
  `defaultOrder`, `Omit<Common, 'translatable'>`).
- `query.ts:25` `TextOp` includes `'contains'`; `:48-52` `BUILT_IN_ORDERS`
  (`publishedAt`, `ord`, `title`); `:65` `ContentOrder`; `:67-87` `ContentQuery`;
  `:89-95` `ContentPage { items: ReferenceTarget[] … }`; `:107-108`
  `DEFAULT_PER_PAGE = 20`, `MAX_PER_PAGE = 100`; `:133-179` `normaliseQuery` (default
  order `publishedAt desc`); `:191-204` `queryKey` — an **explicit positional array**
  of seven elements, "stable against a future field being added in the middle of the
  interface"; `:244` `CollectionValue`; `:305-325` `collectionQuery(field, value,
  page?)` — a render-time `page` beats the stored one; `:340-363`
  `collectionQueries(doc, schema, page?, locale?)`.
- `resolve.ts:61` `Resolution`, with `page?: number` at `:125` — the precedent for a
  render-time value threaded into every collection query. `ReferenceTarget` at
  `:318` is the item shape (`id`, `title`, `path`, `url`, `data`, `doc`).
- `locales.ts:81` `fieldValue`, `:103` `dataOf`, `:157` `localeContext` (undefined
  for the source). `doc.ts:66` `compareSiblings`. `protocol.ts:200,203`
  `MAX_DOC_BLOKS = 20_000`, `MAX_DOC_BYTES = 8 MiB`.

**server (`src/server/`):**
- `content-index.ts:25-30` `ContentProjection { index, refs }`; `:36-47`
  `contentProjection` — "the one place the two halves are computed together, so
  publish and reindex cannot drift"; `:55` `MAX_ROWS = 400`; `:66-110`
  `indexStatements` (delete-then-insert, bound parameters throughout); `:130-137`
  `clearIndexStatements(db, ids)`; `:162` `clearInboundRefStatements`. The file
  header (`:1-16`) states the rule: every function returns **unrun** statements that
  join the publish/unpublish/delete batch, so the index can never describe an
  unpublished document.
- `publish.ts:67` `PublishDeps.projection?: (story, doc) => ContentProjection`;
  `:154-158` batches `[versionStatement, publishStatement, ...indexStatements]`;
  `:212` unpublish batches `clearIndexStatements`.
- `documents.ts:151-167` `deleteDocument` is the one caller batching
  `deleteStoryStatement`'s five arrays; `stories.ts:1893` builds
  `indexStatements: [...clearIndexStatements, ...clearInboundRefStatements]`.
  `stories.ts:1220` `stampSchemaStatement`, `:1253` `publishedDocsAfter`, `:1941`
  `publishStoryStatement`, `:95` `STORY_COLS`.
- `reindex.ts:40-46` `ReindexReport { documents, indexRows, refRows, … }`; `:75-96`
  runs `contentProjection` + `indexStatements` per document over
  `publishedDocsAfter`.
- `query.ts:115-195` `contentSql(q, indexed, locale, perPageMax)` → `{ count, page,
  normalised }`. `:130-141` is the `contains` refusal. `:144` the only implicit
  clause, `stories.published_doc is not null`. `:186-192`: binds are order-join
  binds, then where binds, then `limit, offset`, and `stories.id asc` is appended to
  every sort. `:226-277` `runQuery` runs count and page concurrently and maps rows
  to `ReferenceTarget`, parsing `published_doc` per row.
- `runtime.ts:749-760` `queryDeps`/`query`; `:767-768` `projection`; `:703`
  `collectionQueries(doc, schema, opts?.page, active)`; `:83` the `page` option.
- `routes/content.ts:59-67` `parseOrder`; `:85-118` `queryFromParams` reads `type`,
  `parent`, `locale`, `where`, `order`, `page`, `perPage` and hard-codes
  `status: 'published'` (`:116`). `routes/api/documents.ts:237-246` `GET /documents`
  is the same parser behind `READ`. `routes/api/search.ts:57` is the substring
  meta-search over `stories`, drafts included.
- `mcp/tools.ts:179-206` `query_documents`, `query: ['type', 'parent', 'locale',
  'where', 'order', 'page', 'perPage']` at `:205`. `validate.ts:923` `SEARCH_Q =
  trim, maxLength(200)`; `:78` `typeNameQuery`. `errors.ts:12-26` codes include
  `bad_request`, `unsupported`.
- **A pre-existing gap this spec closes in passing:** `migrate.ts:310-317` rewrites
  `published_doc` through `stampSchemaStatement` and does **not** re-run
  `indexStatements`. A content migration that changes an indexed value leaves
  `content_index` stale until a manual reindex. A migration that rewrites prose
  would leave the FTS index stale the same way (decision 8).
- **A pre-existing hazard, out of scope but bounded here:** `indexStatements`
  (`content-index.ts:76-86`) binds `rows × 5` in one statement, capped at
  `MAX_ROWS = 400` — up to 2,000 parameters. D1 documents a per-query bound-parameter
  cap; this spec's guess was 100, and `stories.ts:203-209` says of `BIND_CHUNK = 100`
  that "D1's own ceiling is higher" without naming it. **Those two cannot both be
  right, and a doc search on 2026-09-05 did not settle it.** Settle it empirically in
  phase 1, in the same workers test as the `'delete'` gate: bind 150, 500 and 2,000
  parameters to one statement and see which fails. If the cap is 100, `content_index`
  is *already* broken for any document producing more than twenty (locale × indexed
  field) rows — five indexed fields across five locales — and phase 3 chunks both
  tables' inserts rather than only sizing the new one around the cap. The new
  statements stay under 100 by construction either way (decision 3's
  `MAX_SEARCH_ROWS = 24` × 4 binds = 96).

**admin (`src/admin/`):**
- `ui/screens/fields/CollectionField.tsx` renders filters, count and sort from a
  `CollectionValue`; `hooks/useCollections.ts:68` fetches `GET {base}/api/content`
  via `queryToParams`. `ui/useSearch.ts` → `GET {base}/api/search`, 20 rows, ranked
  client-side by `ui/rank.ts`.

**tests:**
- `test/unit/server/query.test.ts` pins `contentSql`'s text and bind order.
  `test/workers/collections.test.ts:135-160` seeds published rows directly then
  reindexes. `test/workers/migrations.test.ts:624-645` asserts `content_index` and
  `content_refs` shape from `pragma_table_info`/`sqlite_master`, including index
  *absences*. `test/workers/records.test.ts:430-486` asserts `content_index` and
  `content_refs` after publish, unpublish and delete.
- `test/workers/sql-split.ts:14-16` is `BEGIN … END`-aware and "matches wrangler
  4.114's own `splitSqlIntoStatements`", so a trigger *would* split correctly in the
  local harness. This design uses none anyway (decision 1).
- **FTS5 is compiled into the test runtime.** The workerd binary in
  `node_modules/.pnpm/@cloudflare+workerd-darwin-arm64@1.20260722.1` carries
  `ENABLE_FTS5` and the tokenizer names `unicode61`, `porter`, `trigram` and
  `fts5vocab`. Cloudflare's D1 docs state FTS5 is supported in production.

**docs:**
- `foundation/pagination.md:418-433` decision 8 rejects FTS5 ("a second write path
  to keep in step with the first for a feature nobody has asked to be fuzzy yet.
  Named so it is a decision rather than an oversight"), restated at `:788-789` and
  `:816`. `content-model/collections.md:570-573` sizes it M as its own spec.
  `docs/design-system.md:453-461` names the upgrade trigger. `README.md:1141`,
  `:2388` say "its own spec"; `README.md:1407` shows a host writing its own
  `indexForSearch` in a publish hook — to revise. `foundation/multi-site.md:80-84`
  lists the tables that hang off a story id.

## Owner decision checkpoints

1. **Excluded kinds.** `select` labels, `number`, `boolean`, asset alt text and
   filenames, `multilink` labels and referenced records' titles are all **out** of
   the index. Cost: the demo's `topic: 'policy'` is not found by "policy" unless the
   prose says it. Adding `select({ searchable: true })` that indexes the *label* is
   additive later. **Recommended: exclude.**
2. **Opt-out, not opt-in.** `searchable?: boolean` on `text`, `textarea` and
   `richtext` only, default `true`. Needed for the demo's `embed` textarea (raw
   iframe HTML) and anything like it. **Recommended.**
3. **The last token is always prefix-matched** (`"sunset"*`) when it is two or more
   characters. A cheap stemming substitute and type-ahead in one; no flag.
   **Recommended.**
4. **A snippet is `SnippetPart[]`** (`{ text, match }`), never a `<mark>` string.
   **Recommended** (decision 6).
5. **`runMigrations` re-projects the index** for every document it republishes,
   which fixes the pre-existing `content_index` gap in the same commit. Small.
   **Recommended: in scope, phase 3b.**
6. **The admin's palette and pickers stay on substring search.** They must reach
   drafts and unpublished documents; FTS is published-only. No "search content"
   result kind in the palette. **Recommended.**
7. **`collection({ searchable: true })` and `Resolution.search`** — a search-results
   page is a page holding a collection block — **in scope as the last code phase**.
   It is the one phase that can be deferred without unpicking anything.
   **Recommended: in.**
8. **A search on a gated deployment is scoped to the gate's public value** unless the
   caller filters that field itself. Decision 11, added 2026-09-05 after the owner
   read specs 30 and 31 together. Search is the one place a list becomes a leak the
   host cannot reasonably be asked to remember: a snippet is a marked extract of
   precisely the prose `redactDoc` exists to withhold. **Owner decision: in, search
   only — collections and `folio.query` without a `search` term stay untouched, per
   spec 31 checkpoint 6.**

**Owner decisions, 2026-09-05.** Checkpoints 1–7 confirmed as recommended.
Checkpoint 8 added and confirmed in the same sitting. Build order: **spec 31 lands
before this spec**, so `ResolvedGate` exists when the compiler is written rather than
being retrofitted into it (Dependencies).

## User stories

### Visitor searches the site
**As** a visitor **I want to** type "harbour sunset" into a search box **so that** I
find the page whose *body* says it, ranked with the best match first and a snippet
showing why.

### Developer builds a search page in one query
**As** a host developer **I want to** call `folio.query({ search: q, type: 'insight',
page })` **so that** a search page is the same primitive as an archive page, with
no second index I maintain in a publish hook.

### Editor adds a search box to a listing block
**As** an editor **I want to** declare a collection block `searchable` **so that** a
visitor can narrow the list by typing, without a developer writing a route.

### Agent finds content by what it says
**As** an assistant on the MCP endpoint **I want to** `query_documents` with `search`
**so that** I can find the document about a topic rather than guessing its title.

### Developer trusts the index
**As** a host developer **I want to** know that a publish, an unpublish, a delete, a
reindex and a content migration each leave the search index describing exactly the
published site **so that** search never returns a page that is not live.

## Architecture decisions

### 1. External-content FTS5 over a plain `content_text` table, written by four bound statements, no triggers

```sql
create table content_text (
  id       integer primary key autoincrement,
  story_id text not null,
  locale   text not null default '',
  title    text not null default '',
  body     text not null default ''
);
create unique index content_text_story on content_text (story_id, locale);

create virtual table content_fts using fts5(
  title, body,
  content='content_text', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
```

The per-story replace, appended to the same publish batch after the existing
`content_index` and `content_refs` statements:

```sql
-- 1  de-index the old tokens; the old values come from the content table itself
insert into content_fts(content_fts, rowid, title, body)
  select 'delete', id, title, body from content_text where story_id = ?;
-- 2  drop the rows (content_text_story leads on story_id, so this is an index seek)
delete from content_text where story_id = ?;
-- 3  the new rows, one per locale
insert into content_text (story_id, locale, title, body) values (?, ?, ?, ?), (?, ?, ?, ?);
-- 4  index them
insert into content_fts(rowid, title, body)
  select id, title, body from content_text where story_id = ?;
```

Unpublish and delete are statements 1 and 2 with `story_id in (…)`.

**Rejected: a plain FTS5 table with `story_id UNINDEXED`.** FTS5 indexes only rowid
and `MATCH`; `delete … where story_id = ?` is a full scan of the `%_content` shadow
table, reading every row's body. At 10k documents × 2 locales × ~4 kB that is ~80 MB
of pages and 20k rows read *per publish*. Not fatal at 3k documents, but it makes a
publish O(site) where every other statement in the batch is O(document). That is the
wrong shape whatever the constant.

**Rejected: external content with triggers.** Canonical in SQLite, and the local
harness would even split the DDL correctly. But it moves half the write path into
DDL where `content-index.ts`'s header rule — every function returns unrun statements
that join one batch — can no longer see it, and it is the one SQL construct with a
reported `wrangler d1 migrations apply` splitting failure in the wild. Four bound
statements is exactly what `indexStatements` already looks like.

**Rejected: contentless-delete (`content=''`, `contentless_delete=1`).** Deletes by
rowid without old values, but a contentless table cannot answer `snippet()` or
`highlight()`, and the snippet is half the feature.

**Rejected: a rowid map table.** It is external content with an extra table and a
subquery in every `values`.

Three properties of the DDL, each deliberate:

- **`autoincrement`**, so a rowid is never reused. Without it a phantom token entry
  left by a hand-edited `content_text` could attach to a new document's rowid.
- **One unique index**, `(story_id, locale)`, which serves both the delete lookup and
  the invariant. No `content_text_locale` — the repo's standing rule is that an
  index nothing reads is asserted absent (`migrations.test.ts`), and nothing starts
  a query from a locale.
- **The `'delete'` command via `insert … select`.** FTS5's special delete needs the
  old column values; they are in `content_text`, so the batch supplies them with
  nothing read into JS. The FTS5 `xUpdate` path is per row, so a multi-row `select`
  is fine in principle — **phase 1's workers test must prove it in workerd** before
  anything is built on it. This is the one place the design leans on behaviour not
  yet observed in this repo.

This is also the direct answer to spec 18 decision 8. It rejected FTS5 as "a second
write path to keep in step with the first". **There is no second write path.**
`contentProjection` returns `{ index, refs, search }`; `indexStatements` emits all
three tables' statements; `publish`, `unpublish`, `deleteDocument` and `reindex` are
unchanged callers. The trigger that decision named — body-text search being asked
for — has fired, and the objection it raised is met by putting the third table where
the first two already are.

### 2. Tokenizer `unicode61 remove_diacritics 2`, `prefix='2 3'`, bm25 weights title 10 : body 1, in the query

- **Rejected: `porter`.** An English stemmer applied to French or German rows
  produces wrong stems, and the table is multi-locale by construction. The
  tokenizer is fixed in shared DDL, so there is no per-host knob to make it right
  for one site and wrong for the next. Checkpoint 3's trailing `*` recovers most
  of what stemming buys for type-ahead.
- **Rejected: `trigram`.** Substring semantics ("sun" finds "Sunderland"), roughly
  three times the index, a three-character minimum, and bm25 over trigrams is not
  relevance. Named here as the future answer for CJK text, which `unicode61`
  tokenises as one run per script segment — a known limitation, stated in Edge
  cases.
- `remove_diacritics 2` is what makes "cafe" find "café" and "Zurich" find
  "Zürich"; the multi-locale claim depends on it.
- `prefix='2 3'` costs index space for two- and three-character prefixes so the
  trailing `*` is a seek rather than a scan of the vocabulary.
- **Weights live in the SQL**: `-bm25(content_fts, 10.0, 1.0)`, visible in
  `contentSql` and pinned by the unit test. **Rejected:** persisting them with
  `insert into content_fts(content_fts, rank) values ('bm25(10.0, 1.0)')` — the same
  effect as hidden state in the database.
- Negated so `score` is positive and higher is better, and `relevance` sorts `desc`
  like every other "best first" order.

### 3. The projection is pure, whole-graph, per locale, and lives in `src/core/search-projection.ts`

```ts
/** One `content_text` row. `locale` is `''` for the source, as `content_index`. */
export interface SearchRow {
  locale: string
  title: string
  body: string
}

/** `text` | `textarea` | `richtext`, unless `searchable: false`. */
export function isSearchable(field: Field): boolean

export function searchRowsFor(
  doc: Doc,
  type: DocumentType | undefined,
  schema: SchemaIndex,
  locales?: LocaleConfig,
): SearchRow[]

/** User input → FTS5 MATCH syntax, or null when nothing is left to search for. */
export function ftsQuery(input: string): string | null

export interface SnippetPart {
  text: string
  match: boolean
}
export function splitSnippet(raw: string | null): SnippetPart[]

export const MAX_SEARCH_BODY = 65_536
export const MAX_SEARCH_TITLE = 256
export const MAX_SEARCH_ROWS = 24
```

Rules, kept to one flag:

- **Walk bloks in document order**: root, then depth-first by slot with siblings
  sorted by `compareSiblings`, orphans last in map order. A snippet then reads in
  page order, and two runs are byte-identical — `indexRowsFor`'s promise, kept.
- For each field in `schema[blok.type].fields` with `isSearchable`: `text` and
  `textarea` contribute the string; `richtext` contributes
  `richtextToText(asRichtext(v))`. Values are read via `fieldValue(blok, name, ctx)`
  so the `fr` row holds what a French visitor reads — the translation or the
  fallback. Rows for `''` and each declared non-source locale (skipping
  `locales.default`), exactly `indexRowsFor`'s loop.
- `title` is `titleOf(doc, type, schema, '', ctx)`: the same function that fills
  `stories.title` and `title_i18n`, so the ranked title and the listed title agree.
- Pieces are joined with `\n`, whitespace collapsed, `\u0001`/`\u0002` (decision 6's
  markers) and other C0 controls stripped, the body truncated at `MAX_SEARCH_BODY`
  on a word boundary and the title at `MAX_SEARCH_TITLE`.
- A row is emitted only when `title || body` is non-empty. A record holding one
  `select` and one `number` contributes nothing and costs nothing.
- **Excluded kinds:** `select`, `number`, `boolean`, `asset`, `multiasset`,
  `multilink`, `reference`, `references`, `blocks`, `collection`. Referenced titles
  specifically: A's row would depend on B's title, which changes when B publishes
  without A republishing — a staleness delete-then-insert cannot see.
- **`hidden` and `showIf` are ignored.** `showIf` hides the *input*, and the
  renderer still renders the value (`conditional-fields.md` checkpoint 3), so
  respecting it would make the index disagree with the page. Consulting `hidden`
  would make two flags express one intent. One flag: `searchable: false`.

**Rejected: opt-in (`searchable: true`).** `indexed` is opt-in because each field
costs a row per locale and makes a filter promise. Search costs one row per locale
however many fields contribute, and "full-text search finds my prose" is what a host
expects with no schema edit.

**Rejected: a block-level opt-out.** Field-level already covers a `code` or `embed`
block's one field, and a second place to look is a second place to forget.

A host importer that writes `published_doc` directly and already calls
`indexRowsFor` calls `searchRowsFor` beside it; both are exported from `core/index.ts`.

### 4. `search` is a term of `ContentQuery`; ordering defaults to `relevance`; items gain `snippet` and `score`

```ts
// core/query.ts
export interface ContentQuery {
  // …existing keys unchanged…
  /** Full-text term. Trimmed, whitespace-collapsed, capped at 200 characters. */
  search?: string
}

export type ContentOrder = ContentOrderSpec | 'publishedAt' | 'ord' | 'title' | 'relevance'
export const BUILT_IN_ORDERS = { publishedAt: 'desc', ord: 'asc', title: 'asc', relevance: 'desc' }

export interface ContentItem extends ReferenceTarget {
  /** Present when the query had `search`. */
  snippet?: SnippetPart[]
  score?: number
}
export interface ContentPage {
  items: ContentItem[]
  // …unchanged…
}
```

`normaliseQuery`: trim, collapse whitespace, cap at 200, drop when empty; the default
order becomes `relevance desc` when `search` is present; `relevance` without `search`
throws `bad_request` ("order 'relevance' needs a search") from `contentSql`, beside
`unknownField`. `queryKey` appends `n.search ?? ''` as the **eighth** element — the
array is positional precisely so this is safe. `search` counts as narrowing for the
`contains` guard at `query.ts:135-141`.

The compiled page statement (the count is the same join without score or snippet):

```sql
select p.*,
       (select snippet(content_fts, 1, char(1), char(2), '…', 32)
          from content_fts
         where content_fts match ? and content_fts.rowid = p.fts_rowid) as snippet
from (
  select <STORY_COLS>, stories.published_doc, fts.score, fts.rowid as fts_rowid
  from stories
  join (
    select ct.story_id, ct.id as rowid, -bm25(content_fts, 10.0, 1.0) as score
      from content_fts
      join content_text ct on ct.id = content_fts.rowid
     where content_fts match ? and ct.locale = ?
  ) fts on fts.story_id = stories.id
  [left join content_index co on … ]          -- only for an indexed-field order
  where stories.published_doc is not null and <existing clauses>
  order by fts.score desc, stories.id asc      -- or the caller's order; the id tiebreak always
  limit ? offset ?
) p
```

**Bind order, pinned by the unit test:** `[ftsQuery, ftsQuery, localeKey,
...orderBinds, ...whereBinds, perPage, offset]`. The outer select-list `?` is
textually first, so it binds first.

- **The snippet is a correlated subquery over the paged outer rows, deliberately.**
  Inside the `MATCH` subquery, `snippet()` would run for every hit before the sort —
  a 2,000-hit query would read 2,000 bodies. Here it runs `perPage` times, and
  `MATCH ? AND rowid = ?` is an equality probe FTS5 handles directly. **Rejected:** a
  third statement fetching snippets by rowid — one more sequential round trip, where
  `runQuery` today gets count and page in parallel.
- **Locale is a column of `content_text`, filtered after `MATCH`.** Hits for other
  locales are discarded. On a three-locale site that is two thirds of a candidate set
  which is already small. **Rejected:** indexing `locale` as an FTS column and
  prepending `loc:fr AND` to the match — a hack whose saving is a fraction of a
  small number.
- **Fallback text is indexed under the locale at publish, so the query is one
  equality.** **Rejected:** query-time fallback (`coalesce` across two rows) — not
  expressible in a `MATCH`, double-counts documents, and diverges from
  `content_index`'s rule.
- **Page numbers over rank.** `contentSql` is offset-paged already, the sort is
  total (`score, id`), and a keyset over a float rank is not stable. The same trade
  `collections.md` made.
- bm25's inverse document frequency is computed over the whole table, all locales.
  A slight skew, irrelevant at CMS scale; named so it is a known thing.
- The FTS5 hidden `MATCH` column bears the *table* name, so the design never aliases
  `content_fts` inside the match subquery.

### 5. User input is tokenised and quoted; nothing reaches FTS5 as syntax

`ftsQuery(input)`:

1. Split on runs of anything outside `\p{L}`, `\p{N}`, `\p{Co}` — `unicode61`'s
   default token characters. `"`, `-`, `:`, `^`, `*`, `(`, `)`, `+`, and the words
   `NOT`, `AND`, `OR`, `NEAR` can never act as operators: punctuation becomes a
   separator, and a keyword becomes a quoted term.
2. Drop tokens longer than 64 characters; keep at most 12.
3. Quote each token: `"token"`. The last token gets `*` outside the quotes when it is
   two or more characters.
4. Join with spaces — FTS5's implicit AND. **Rejected: OR.** "sunset beach" should
   mean both, which is what a visitor means.
5. No tokens left (`???`, an emoji-only string) → `null` → `contentSql` emits `0 = 1`:
   an honest empty page, never a 500, never "everything".

A stray character in a search box is the commonest input there is, and a `MATCH`
syntax error is a 500 with the visitor's own text in the log. Step 1 is what makes
that impossible rather than merely unlikely.

### 6. A snippet is `{ text, match }[]`, split server-side on control-character markers

`snippet(content_fts, 1, char(1), char(2), '…', 32)` marks matches with `\u0001` and
`\u0002`; `splitSnippet` (pure) splits on them. The projection strips both from
content (decision 3), so the split is unambiguous.

**Rejected: a `<mark>…</mark>` string.** A host must either trust it as HTML — an
injection the moment a paragraph *about* HTML contains `<script>` literally — or
escape it, which destroys the marks. **Rejected: `{ before, match, after }`.** A
32-token window commonly holds several matches.

Column `1` (body) is fixed. The body includes the root's title field text when that
field is searchable, so a title-only hit still produces a marked snippet. **Rejected:**
FTS5's automatic column (`-1`) — a title-only snippet duplicates what the host already
shows beside it.

### 7. Published only, like `content_index`; the admin stays on substring search

A draft-only document is invisible to `search`, exactly as it is to collections
(`collections.md:537-541`). A site search page under draft mode (spec 25 `draftAt`)
searches published content and can be marked stale like any collection. Draft search
would mean a second index written per keystroke from every Durable Object, or opening
every candidate object per query — the trade `collections.md` decision 3 already
refused.

The palette and the pickers must reach drafts and unpublished documents, so they stay
on `searchStories`. The trigger for revisiting is an editor asking to find a page by a
phrase in its body.

### 8. `runMigrations` re-projects the index when it rewrites `published_doc`

`MigrateDeps` gains the optional `projection` `PublishDeps` already has. The single
statement at `migrate.ts:310-317` becomes a batch:
`[stampSchemaStatement(…), ...indexStatements(db, id, projection(story, migratedDoc))]`
when `publishedResult.mutations.length > 0`. This fixes the `content_index` staleness
in the same commit.

**Rejected: documenting "run reindex after migrate".** A body-text rewrite is
precisely the case where a stale search index is invisible until a visitor reports it
(checkpoint 5).

### 9. Multi-site needs no change here

Every predicate is on `stories` (the outer `where`), `content_text` hangs off
`story_id`, and reindex walks `publishedDocsAfter` over `stories`. Spec 23's implicit
`site_id` scope lands in `contentSql`'s clause list and the search join inherits it.
`content_text` joins the list at `multi-site.md:80-84` of tables that need a `site_id`
only where a query starts from them — and none does.

### 10. `collection({ searchable: true })`, and `Resolution.search` threaded like `page`

```ts
collection({ type: 'insight', searchable: true, maxPerPage: 10 })

interface CollectionValue { /* … */ search?: string }              // an editor-fixed term, optional
collectionQuery(field, value, page?, search?)                      // the render-time search wins, like page
collectionQueries(doc, schema, page?, locale?, search?)
interface Resolution { /* … */ search?: string }
folio.resolve(doc, { page, search })
```

Without `searchable: true`, both the stored and the render-time term are dropped on
the way out — the same double enforcement `filterable` has. `CollectionField.tsx`
shows a Search input only when the field declares it. A host's search page is then a
page holding a collection block plus `resolve(doc, { search: url.searchParams.get('q') })`.

**Rejected: a separate `folio.search()` API.** It would be `folio.query` with one
term renamed, a second surface for the MCP tool and the API to mirror, and no way for
a collection block to use it.

### 11. A search on a gated deployment is scoped to the gate's public value, and the predicate keys off the declaring *types*

When `config.gate` is set (spec 31) **and** the normalised query carries `search`
**and** no `where` clause names `gate.field`, `contentSql` appends one more clause:

```sql
(stories.type not in (?, ?, …)                    -- the types whose root declares the field
 or exists (select 1 from content_index cg
             where cg.story_id = stories.id and cg.locale = ?
               and cg.field = ? and cg.text_value = ?))
```

`contentSql` gains an optional `gate` parameter — `{ field, public, types }` off
`ResolvedGate` — and stays pure; `runtime.ts`'s `queryDeps` passes `rt.gate`. The
binds join the existing where binds in clause order. A caller who names the field
itself opts out entirely: `where: [{ field: 'access', op: 'in', value: ['public',
'members'] }]` is how a host builds a members' search over members' content, and it
is the same double enforcement `filterable` and `searchable` already use.

**Why it is search and not every query.** Spec 31 checkpoint 6 leaves lists alone,
and that decision holds: a `collection` of cards is something a host laid out and can
see, and `item.data` is the metadata a card is built from. A search result is
different in kind. `snippet()` returns a marked extract of the body — the exact prose
`redactDoc` nulls — so an unfiltered search page does not merely expose a gated
document, it renders the withheld half of it, ranked, with the matched words
highlighted. "The host filters with `where`" is a fair remedy for a listing the host
wrote deliberately; it is a thin one for the surface whose whole purpose is to query
everything at once.

**The predicate keys off `stories.type`, not off the absence of a row, and that is
load-bearing.** `projectValue` returns null for an absent value, so *a document with
no value for an indexed field gets no `content_index` row*
(`core/index-projection.ts:120-124`). Two very different documents therefore look
identical to a row-absence test: a `record` type whose root never declares the gate
field, which must stay searchable, and a `page` whose root *does* declare it and
holds no value, which spec 31 checkpoint 2 fails **closed**. An
`exists … or not exists …` predicate would open the second case and quietly reverse
that checkpoint. `ResolvedGate` already precomputes the declaring root block names
for `page()`; `validateGate` additionally answers `types: ReadonlySet<string>`, the
document type names those roots belong to, which is what `stories.type` holds.
Absence then means "this type has no gate", and a declaring type with no value falls
to the `exists` and is excluded — which is what fail-closed means here.

This is also the second reason spec 31 checkpoint 4 requires `indexed: true` on the
gate field. The first was that a host could filter its own lists; this is that Folio
can compile the predicate at all.

**Rejected: scope every query, not just search.** It is the safer default and it
contradicts a decision the owner has taken twice. It would also change what a
`collection` returns on a deployment that added a gate afterwards, silently.
**Rejected: `redactDoc` on gated items inside `runQuery`.** Spec 31 checkpoint 6's
S-sized follow-up, still available and still not built here: it removes the body but
leaves the row in the result set, so a search page would list a paywalled document
with an empty snippet, which is worse than not listing it. The two are complementary
rather than alternatives — if it is ever built, this clause is what keeps the row out
of a *search* and that one is what keeps the body out of a *list*.
**Rejected: refusing `search` outright when a gate is configured and no filter is
given.** An error the host has to learn about by hitting it, for a case the compiler
can simply answer correctly.

## Wire & schema changes

### D1 migration `0007_content_fts.sql`

The number is a claim in build order (spec 28 takes `0005`, 29 `0006`); whichever
lands first takes the next free number and the others restamp.

```sql
-- Full-text index over published prose (docs/specs/content-model/full-text-search.md).
--
-- Two tables that are one thing. `content_text` holds one row per (story, locale)
-- with the flattened title and body; `content_fts` is an FTS5 index *over* it
-- (`content=`), so the text is stored once and the index is the only thing FTS5
-- keeps. Written inside publish()'s batch beside content_index, so it cannot
-- describe an unpublished document, and rebuildable from `published_doc` with
-- `POST {base}/api/reindex`.
--
-- No triggers, deliberately. The canonical external-content pattern keeps the two
-- in step with three triggers; here four bound statements in the publish batch do
-- it, so the whole write path is visible in one file (server/content-index.ts) and
-- nothing about it lives in DDL a statement splitter has to understand.
create table content_text (
  -- `autoincrement` so a rowid is never reused: FTS5 keys its index by rowid, and
  -- a stale token entry attaching to a new document's rowid is the failure a
  -- reused id would allow.
  id       integer primary key autoincrement,
  story_id text not null,
  -- '' is the source locale, as content_index. A declared non-source locale gets
  -- its own row holding what that locale *renders* — the translation, or the
  -- fallback — so a French search finds what a French visitor reads.
  locale   text not null default '',
  -- The document's title as titleOf() computes it, weighted above the body at
  -- query time. Body is every searchable text/textarea/richtext value in the
  -- whole blok graph, in document order, flattened to plain text.
  title    text not null default '',
  body     text not null default ''
);

-- The delete lookup and the invariant, in one index. Deliberately the only one:
-- nothing starts a query from a locale, so there is no content_text_locale.
create unique index content_text_story on content_text (story_id, locale);

-- unicode61 rather than porter (an English stemmer over a multi-locale table)
-- or trigram (substring semantics, three times the index). remove_diacritics 2
-- is what lets "cafe" find "café". prefix='2 3' makes the type-ahead `*` a seek.
create virtual table content_fts using fts5(
  title, body,
  content='content_text', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
```

### Core types

All additive. `PROTOCOL_VERSION` is unchanged: nothing here rides a socket frame.

- `fields.ts`: `interface Searchable { searchable?: boolean }` mixed into `text`,
  `textarea` and `richtext` only. Not on `Common`, for the same reason `Indexable`
  is not: the type says which kinds can carry it.
- `query.ts`: `ContentQuery.search?`; `'relevance'` in `ContentOrder` and
  `BUILT_IN_ORDERS`; `SnippetPart`; `ContentItem`; `ContentPage.items: ContentItem[]`;
  `CollectionValue.search?`; `collectionQuery`/`collectionQueries` gain a trailing
  `search?` parameter.
- `fields.ts` `collection` kind: `searchable?: boolean`.
- `resolve.ts`: `Resolution.search?: string`.
- `search-projection.ts` (new): `SearchRow`, `isSearchable`, `searchRowsFor`,
  `ftsQuery`, `SnippetPart`, `splitSnippet`, the three constants. Exported from
  `core/index.ts` beside `indexRowsFor`.

### Server types

- `content-index.ts`: `ContentProjection.search: SearchRow[]`; `EMPTY_PROJECTION`
  gains `search: []`; `indexStatements` emits the four statements of decision 1;
  `clearIndexStatements` emits the first two with `in (…)`.
- `reindex.ts`: `ReindexReport.searchRows: number`.
- `migrate.ts`: `MigrateDeps.projection?`.
- `runtime.ts`: `resolve` threads `opts.search` into `collectionQueries` beside
  `opts.page`; `FolioResolveOptions.search?` on `types.ts`.
- `query.ts`: `contentSql` gains a fourth optional parameter,
  `gate?: { field: string; public: string | number | boolean; types: ReadonlySet<string> }`,
  applied only when `n.search` is set and no `where` clause names `gate.field`
  (decision 11). Pure; `queryDeps` in `runtime.ts` passes `rt.gate` through.
- `gate.ts` (spec 31): `ResolvedGate` gains `types: ReadonlySet<string>` beside its
  `roots` set — the document type names whose root declares the field, which is what
  `stories.type` holds. Computed in `validateGate`, which already walks `types`.

### New or changed routes

| Method | Path | Auth | Change |
| --- | --- | --- | --- |
| GET | `{base}/api/content?search=&order=relevance` | `READ` | `queryFromParams` reads `search` (trimmed, ≤ 200, like `SEARCH_Q`) and accepts `relevance` as an order |
| GET | `/api/v1/documents?search=` | `READ` (`content:read`) | same parser; the response's `items[]` may carry `snippet` and `score` |
| MCP | `query_documents` | `content:read` | `query` gains `search`; `inputSchema.properties.search` with the description "Full-text `search` ranks by relevance and returns a `snippet` per item." |

Errors: `bad_request` for `order=relevance` without `search`; `bad_request` for a
`search` over 200 characters (the same screen as `?q=`). A malformed `search` is
**never** an error: `ftsQuery` cannot produce invalid syntax, and an empty token set
answers an empty page.

Response shape for an item when `search` was set:

```json
{
  "id": "sty_…", "title": "…", "path": "…", "url": "…", "data": { }, "doc": { },
  "score": 4.21,
  "snippet": [
    { "text": "…the harbour at ", "match": false },
    { "text": "sunset", "match": true },
    { "text": " was…", "match": false }
  ]
}
```

## Acceptance criteria

### Publish writes the index, atomically

```
GIVEN a published document with the prose "the harbour at sunset" in a nested `prose` block
WHEN it is published
THEN content_text has one row per configured locale for it
AND folio.query({ search: 'sunset' }) returns it with a snippet whose match part is "sunset"

GIVEN a publish whose batch fails on the stories update
WHEN the batch is rolled back
THEN content_text and content_fts hold no row for the document
```

### Ranking

```
GIVEN document A titled "Sunset" with an unrelated body, and document B with "sunset" only in its body
WHEN folio.query({ search: 'sunset' })
THEN A ranks first, both carry a positive score, A's is higher

GIVEN the same two documents
WHEN folio.query({ search: 'sunset', order: 'publishedAt' })
THEN both are returned sorted by publication date and each still carries a score
```

### Locale

```
GIVEN a document whose `body` is translated to French ("coucher de soleil")
WHEN folio.query({ search: 'coucher', locale: 'fr' })
THEN the document is returned
AND folio.query({ search: 'coucher' }) (source locale) does not return it

GIVEN a French-locale query for a document with no French translation of a searchable field
WHEN folio.query({ search: <a word from the source text>, locale: 'fr' })
THEN the document is returned, through the fallback text indexed under 'fr'
```

### Unpublish, delete, reindex, migrate

```
GIVEN a published, indexed document
WHEN it is unpublished
THEN content_text has no row for it and the same search returns nothing

WHEN it is deleted through deleteDocument
THEN content_text has no row for it

GIVEN a field marked searchable: false after documents were published with it indexed
WHEN POST {base}/api/reindex runs to completion
THEN the field's text is no longer found

GIVEN a content migration that rewrites a richtext body
WHEN runMigrations republishes the document
THEN the new prose is found and the old is not, with no reindex
```

### Malformed input is never an error

```
GIVEN search values `"`, `-x`, `foo:bar`, `NOT`, `(x`, `*`, `^`, a 10 kB string, an emoji-only string
WHEN GET {base}/api/content?search=<value>
THEN every response is 200 with a well-formed ContentPage
AND the emoji-only and `???` cases answer zero items

WHEN GET {base}/api/content?order=relevance with no search
THEN 400 bad_request naming 'relevance'
```

### One compiler, four surfaces

```
GIVEN a search term
WHEN it is sent through folio.query, GET {base}/api/content, GET /api/v1/documents and MCP query_documents
THEN the four answer the same items in the same order with the same snippets

GIVEN a page holding collection({ type: 'insight', searchable: true })
WHEN folio.resolve(doc, { search: 'harbour' })
THEN the collection's items are the search results
AND the same call against a collection without `searchable` ignores `search`
```

### Migration shape

```
GIVEN the migrations directory applied to an empty database
THEN content_text has columns id, story_id, locale, title, body in that order
AND its only index is content_text_story, unique on (story_id, locale)
AND content_fts exists with shadow tables content_fts_data, content_fts_idx, content_fts_docsize, content_fts_config
AND there is NO content_fts_content table (external content proven)
```

## Implementation plan

### Phase 1 — the migration, and the one thing to prove

1. `migrations/0007_content_fts.sql` as above.
2. `test/workers/migrations.test.ts`: the shape block from the last acceptance
   group, including the index absence and the `content_fts_content` absence.
3. **The gate**, in the same file or `test/workers/fts-smoke.test.ts`: insert two
   `content_text` rows, index them, `match`, read `bm25` and `snippet`, then run the
   `'delete'`-via-`insert … select` statement for one story and prove the index no
   longer finds it while the other row still matches. Nothing after this phase is
   built until this passes in workerd.

Tree green: nothing reads the table yet.

### Phase 2 — the core projection

1. `src/core/search-projection.ts`: `searchRowsFor`, `isSearchable`, `ftsQuery`,
   `splitSnippet`, the constants.
2. `src/core/fields.ts`: `Searchable` on the three kinds.
3. `src/core/index.ts`: exports.
4. `test/unit/core/search-projection.test.ts`: whole-graph walk in document order;
   `''` plus each locale with fallback; richtext flattening; `searchable: false`;
   title from `titleOf`; the body and title caps on a word boundary; control-character
   stripping; the `ftsQuery` table; `splitSnippet`.

### Phase 3 — the write path

1. `src/server/content-index.ts`: `ContentProjection.search`; four statements in
   `indexStatements`; two in `clearIndexStatements`. The header comment gains one
   sentence naming the third table.
2. `src/server/reindex.ts`: `searchRows` in the report.
3. **3b** `src/server/migrate.ts`: `MigrateDeps.projection`, the batch at `:310`.
4. `test/workers/search.test.ts`: publish writes, unpublish clears, delete (through
   `deleteDocument`) clears, reindex rebuilds, migrate re-projects.
   `test/workers/records.test.ts:430-486` gains a `content_text` assertion beside
   each `content_index` one.

### Phase 4 — the query compiler

1. `src/core/query.ts`: `search`, `relevance`, `ContentItem`, `queryKey`'s eighth
   element, `normaliseQuery`.
2. `src/server/query.ts`: the match join, the score, the correlated snippet, the
   `relevance` refusal, `search` as narrowing, and decision 11's gate clause —
   `contentSql`'s `gate` parameter, `queryDeps` passing `rt.gate`, and the caller
   opt-out when a `where` clause names the field. `validateGate` (spec 31) answers
   the `types` set this reads.
3. `src/server/routes/content.ts`: `search` in `queryFromParams`; `parseOrder`
   accepts `relevance`.
4. `test/unit/server/query.test.ts`: SQL text and bind order pinned; refusals.
   Workers: ranking, locale, paging past the end, malformed input, `where` + `type`
   + `search` together.

### Phase 5 — the surfaces of record

1. `src/server/mcp/tools.ts`: `search` in `query_documents`; `test/unit/mcp/tools.test.ts`
   query-list parity.
2. `docs/api.md` Querying table; `docs/mcp.md`.

### Phase 6 — the collection field

1. `src/core/query.ts`: `collectionQuery`/`collectionQueries` `search`;
   `CollectionValue.search`.
2. `src/core/resolve.ts`: `Resolution.search`; `src/server/runtime.ts`: threading;
   `src/server/types.ts`: the resolve option.
3. `src/admin/ui/screens/fields/CollectionField.tsx`: a Search input when declared.
4. Demo: a `/search?q=` host route beside `/archive` and a `searchable` collection on
   a search page.
5. `scripts/search-test.mjs`, following `scripts/*-test.mjs`: `import
   './lib/ts-resolve.mjs'` first, `signInGlobally()`, `PROTOCOL_VERSION` on every
   socket frame.

### Phase 7 — prose

1. `README.md`: `:1141` and `:2388` stop saying "its own spec"; the hooks example at
   `:1407` stops showing a host writing `indexForSearch`; a `## Search` section after
   `## Collections` shows `folio.query({ search })`, the snippet shape, the
   `searchable` flag and the collection option.
2. `docs/specs/README.md`: row 30, the migration ledger, `## Why this order`, status.
3. Dated notes in `foundation/pagination.md` decision 8 and `:788`,
   `content-model/collections.md` out of scope, `docs/design-system.md:453-461`,
   `foundation/multi-site.md:80-84`.

## Edge cases

- **The root has no title field** → `title` is `''`; the document is found by body.
- **`titleField` is marked `searchable: false`** → still in `title` (via `titleOf`),
  not in `body`. The flag governs the body walk; the title column is the story's.
- **A locale is removed from config** → the next publish or reindex drops its rows,
  by delete-then-insert. Until then a query for that locale finds stale rows, as
  `content_index` does today.
- **`i18n` holds an undeclared locale** → ignored, as `indexRowsFor` ignores it.
- **Body over 64 kB** → truncated on a word boundary; a 20,000-blok document is
  searchable by its first 64 kB of prose. Title over 256 → truncated.
- **More than 24 declared locales** → rows capped at `MAX_SEARCH_ROWS`; 4 binds × 24
  = 96 stays under the D1 bound-parameter cap (verify the cap in phase 3).
- **A reindex racing a publish** → both replace the same rows inside their own
  transactions; whichever commits second describes the document. Idempotent.
- **An unknown `locale` in the query** → `localeKey` gives `''` → source rows, as
  today.
- **CJK text** → `unicode61` emits one token per unbroken run; a sub-phrase search
  fails. Known; `trigram` is the future answer and would be a second DDL.
- **`search` with `parent`, `type` and `where`** → all conjoined; `contains` is
  allowed alongside `search` because `search` narrows first.
- **`perPage` over the cap, `page` past the end** → the existing clamps; an empty
  page with the correct `total`.
- **A hand-edited `content_text`** → the FTS index may disagree; `POST /reindex` is
  the repair. FTS5's `insert into content_fts(content_fts) values ('rebuild')` is
  available to an operator and deliberately not wired: it re-tokenises the whole
  table in one statement.
- **A search-only page under draft mode** → published results, flagged stale like
  any collection (decision 7).
- **`order: 'relevance'` on a `collection` without `searchable`** → dropped with the
  search term; the field's `defaultOrder` applies.
- **A search on a deployment with no `gate`** → decision 11's clause is not emitted
  at all; the SQL is byte-identical to the ungated form, which is what the unit test
  pins.
- **A search over a `record` type on a gated deployment** → records' roots do not
  declare the gate field, so their type is not in the `not in (…)` list's complement
  and every row survives. This is the case a row-absence predicate would have broken.
- **A gated page whose gate field holds no value at all** → no `content_index` row,
  its type *is* a declaring one, so the `exists` fails and it is excluded from search.
  The same fail-closed answer `reader.page()` gives it (spec 31 checkpoint 2).
- **A caller filtering the gate field itself** → the auto-clause is not emitted; the
  caller's `where` is the whole of the scoping. A members' search page is
  `where: [{ field: 'access', op: 'in', value: ['public', 'members'] }]` plus the
  host's own check that the visitor is a member before it runs the query.
- **A `collection` with `searchable: true` on a gated deployment** → it carries a
  `search` term, so it is scoped like any other search. A collection with no search
  term is untouched, per spec 31 checkpoint 6.

## Testing requirements

**Unit (`test/unit/`):**
- `core/search-projection.test.ts`: `searchRowsFor` walks the whole graph in document
  order; emits `''` then each declared locale with fallback text; flattens richtext
  through `richtextToText`; honours `searchable: false`; takes the title from
  `titleOf`; caps body and title on a word boundary; strips `\u0001`/`\u0002` and
  C0 controls; emits no row for an empty document. `ftsQuery` fuzz table: `"`, `-x`,
  `foo:bar`, `NOT`, `a AND`, `(unbalanced`, `*`, `^`, `"" ""`, emoji, a 10 kB
  string, `café`/`cafe` equivalence, the 12-token and 64-character caps, the trailing
  `*` rule. `splitSnippet` with zero, one and several matches.
- `server/query.test.ts`: the search page statement's text and bind order; `count`
  shares the join; `relevance` without `search` refused; `search` counts as narrowing;
  `queryKey` gains the eighth element and two queries differing only in `search`
  differ. Decision 11: with no `gate`, the SQL is byte-identical to today's; with a
  `gate`, the clause and its three binds appear in both `count` and `page` in clause
  order; a `where` on the gate field suppresses it; a query with no `search` never
  emits it.
- `mcp/tools.test.ts`: `query_documents` query list and `inputSchema` stay in parity.

**Workers (`test/workers/`, real workerd):**
- `migrations.test.ts`: `content_text` columns in order; `content_text_story` unique
  and alone; FTS5 shadow tables present; `content_fts_content` absent.
- `fts-smoke.test.ts` (the phase 1 gate): match, `bm25`, `snippet`, and the
  `'delete'`-via-`insert … select` round trip.
- `search.test.ts`: publish writes one row per locale; unpublish clears; delete via
  `deleteDocument` clears; reindex rebuilds after a `searchable: false` edit; migrate
  re-projects; title-over-body ranking; `order: 'publishedAt'` keeps scores;
  multi-locale including fallback; every malformed input answers 200; a 64 kB body
  round-trips through one bind; decision 11 end to end — a gated page is absent from
  an unfiltered `search`, present when the caller filters the gate field, and a
  `record` type with no gate field is never excluded; `GET {base}/api/content?search=` and
  `GET /api/v1/documents?search=` answer identically; MCP `query_documents` with
  `search`; a `searchable` collection resolves with `search` and a plain one ignores
  it.
- `records.test.ts`: `content_text` asserted beside each existing `content_index`
  assertion.

**End to end (`scripts/search-test.mjs` against a live dev server on port 5199):**
- Sign in; edit an insight's prose over the socket with a distinctive word
  (`PROTOCOL_VERSION` on every frame); publish; query the three HTTP surfaces and the
  demo's `/search?q=`; unpublish and confirm absence; a French translation found under
  `locale=fr`; three malformed queries answer 200.

## Dependencies

- **Spec 13 (collections):** `content_index`, `contentProjection`, `indexStatements`,
  `contentSql`, `runQuery`, the `collection` field and `Resolution.page` are all
  extended here, none replaced.
- **Spec 18 (pagination):** decision 8 is the rejection this spec reverses, on the
  trigger `docs/design-system.md` named; `queryFromParams` and the `/api/v1` partition
  rule are what the new parameter rides on.
- **Spec 31 (visitor access): an ordering constraint, added 2026-09-05. 31 lands
  first.** Decision 11 compiles a predicate out of `ResolvedGate`, so the gate has to
  exist before the query compiler is written. Building this spec first would mean
  writing `contentSql`'s search path twice, and shipping a window in which a search
  page leaks gated bodies. If 31 is ever dropped, decision 11 goes with it and
  nothing else here moves.
- **Spec 23 (multi-site, draft):** no ordering constraint. `content_text` joins the
  list of tables that hang off a story id; the search join inherits the implicit
  `site_id` scope through `stories`. Note that decision 11's clause is a second
  predicate on `stories` and picks up 23's implicit `site_id` scope the same way
  every other clause does.
- No new Cloudflare resources, bindings or host config.

## Out of scope

- **Draft search.** A second index per keystroke from every Durable Object, or
  opening every candidate object per query (decision 7).
- **Redacting gated documents' bodies out of `item.doc` in a search result.** Decision
  11 keeps a gated *row* out of an unfiltered search; the body still rides on
  `item.doc` for anything the caller does surface with an explicit filter, exactly as
  spec 31 checkpoint 6 leaves it for every other list. The `redactDoc`-in-`runQuery`
  follow-up that spec offers is still the fix for that half and is still not built.
- **The palette and pickers on FTS.** They need drafts and unpublished documents;
  `searchStories` stays (decision 7).
- **Faceted counts** ("12 in Insights, 3 in People"). A second query per facet; wait
  for a want.
- **Highlighting the whole body** (`highlight()`). The snippet is the honest amount
  of prose to hand back; a host that wants more has the doc.
- **Stemming, synonyms, stopwords, per-host tokenizer choice.** The DDL is shared
  across hosts; a stemmer is wrong for the locale it was not built for (decision 2).
- **Indexing `select` labels, numbers, asset alt text, referenced titles**
  (checkpoint 1). Each is additive later; referenced titles carry a staleness the
  write path cannot see.
- **An FTS `'rebuild'` route.** One statement over the whole table; `reindex` is the
  bounded repair.
- **Fixing `indexStatements`' bind count** — *conditionally*. Pre-existing and out of
  scope **unless phase 1's measurement shows the cap is below 2,000**, in which case it
  is a live bug in the neighbour this spec is extending and comes into phase 3. Noted
  in Ground truth.

## Open questions

None. **All eight checkpoints answered by the owner on 2026-09-05**, each to its
recommendation, with checkpoint 8 and decision 11 added in that sitting.

Two things are deliberately measurements rather than questions, both gated in phase 1:
the `'delete'` command via `insert … select` in workerd, and D1's per-query
bound-parameter cap (Ground truth). Neither blocks the design; the second decides
whether phase 3 also chunks `content_index`'s existing insert.
