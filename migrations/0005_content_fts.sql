-- Full-text search over published prose
-- (`docs/specs/content-model/full-text-search.md`).
--
-- Two tables that are one thing. `content_text` holds one row per (story, locale)
-- with the document's title and its whole body flattened to plain text;
-- `content_fts` is an FTS5 index *over* that table (`content='content_text'`), so
-- the prose is stored once and the only thing FTS5 keeps for itself is the index.
--
-- These rows are written inside `publish()`'s batch beside `content_index` and
-- `content_refs` — `server/content-index.ts`'s header states the rule, and it is
-- the whole reason this is safe: the search index can never describe a document
-- that is not published, and it is rebuildable from `published_doc` at any time
-- with `POST {base}/api/reindex`.
--
-- **No triggers, deliberately.** The canonical external-content pattern keeps the
-- content table and the index in step with three triggers. Here four bound
-- statements in the publish batch do it instead, so the entire write path is
-- visible in one TypeScript file rather than half of it living in DDL — and
-- nothing about it depends on a statement splitter understanding `BEGIN … END`,
-- which is the one SQL construct with a reported `wrangler d1 migrations apply`
-- failure in the wild.
--
-- **Why external content rather than a plain FTS5 table with `story_id
-- UNINDEXED`.** FTS5 can only seek by rowid or `MATCH`, so `delete … where
-- story_id = ?` over a plain FTS5 table is a full scan of its `%_content` shadow
-- table, reading every stored body. That makes a publish O(site) where every other
-- statement in its batch is O(document). Rejected alternatives in full: spec 30
-- decision 1.

create table content_text (
  -- `autoincrement` so a rowid is never reused. FTS5 keys its index by rowid and
  -- has no other handle on a row, so a stale token entry landing on a *different*
  -- document's recycled rowid would silently make one page findable by another
  -- page's words. SQLite's default rowid allocation reuses the largest deleted id;
  -- `autoincrement` is the one-word purchase of the guarantee that it never does.
  id       integer primary key autoincrement,
  story_id text not null,
  -- '' is the source locale, exactly as `content_index`. A declared non-source
  -- locale gets its own row holding what that locale *renders* — the translation
  -- when there is one, the fallback when there is not — so a French search finds
  -- what a French visitor reads.
  locale   text not null default '',
  -- The title as `titleOf()` computes it, which is the same function that fills
  -- `stories.title` and `title_i18n`, so the ranked title and the listed title can
  -- never disagree. Weighted above the body at query time
  -- (`-bm25(content_fts, 10.0, 1.0)`), in the SQL rather than persisted as FTS5
  -- rank state, so the weights are readable in `server/query.ts`.
  title    text not null default '',
  -- Every searchable `text`, `textarea` and `richtext` value in the whole blok
  -- graph, in document order, flattened to plain text. Document order is what makes
  -- a snippet read the way the page reads, and what makes two projections of the
  -- same document byte-identical.
  body     text not null default ''
);

-- The delete lookup and the invariant in one index: the per-publish replace seeks
-- `where story_id = ?` twice, and one row per (story, locale) is the shape the rest
-- of the design assumes.
--
-- **Deliberately the only index on this table.** No `content_text_locale` —
-- nothing starts a query from a locale, and this repo's standing rule is that an
-- index nothing reads is asserted *absent* rather than created on spec
-- (`stories_draft_updated` is the example that cost ten migrations of write
-- amplification for a query nobody ever wrote). `test/workers/migrations.test.ts`
-- pins the absence, so adding one later is a deliberate act with a measurement
-- behind it.
--
-- Declared rather than left to a column constraint, which SQLite would name
-- `sqlite_autoindex_content_text_1` — invisible to `migrations.test.ts`, whose
-- index assertions filter `sqlite_%` out.
create unique index content_text_story on content_text (story_id, locale);

-- `unicode61` rather than `porter`: an English stemmer over a table that is
-- multi-locale by construction produces wrong stems for French and German, and the
-- tokenizer is fixed in shared DDL so there is no per-host knob to make it right
-- for one site and wrong for the next. `remove_diacritics 2` is what lets "cafe"
-- find "café" and "Zurich" find "Zürich", which is what the multi-locale claim
-- rests on. `prefix='2 3'` buys index space for two- and three-character prefixes
-- so that the trailing `*` the query compiler appends to a visitor's last token is
-- a seek rather than a scan of the vocabulary.
--
-- Not `trigram`: substring semantics ("sun" finds "Sunderland"), roughly three
-- times the index, and bm25 over trigrams is not relevance. It is named in the
-- spec as the future answer for CJK, which `unicode61` tokenises as one run per
-- script segment.
create virtual table content_fts using fts5(
  title, body,
  content='content_text', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
