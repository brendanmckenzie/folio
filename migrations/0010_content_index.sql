-- Collections (docs/specs/content-model/collections.md).
--
-- Two new tables and nothing else. `stories` is NOT rebuilt here:
-- 0006_document_types.sql already did that to make `path` nullable, and every
-- migration since has been additive on top of it — a second rebuild is a second
-- chance to silently drop a column.
--
-- Queryable projection of published documents. Written inside publish()'s batch,
-- so it cannot describe an unpublished document, and rebuildable from
-- published_doc with POST /folio/reindex.
--
-- An index table rather than an expression index over
-- json_extract(published_doc, …) (architecture decision 1): a root field's JSON
-- path contains the root blok's random uid, so the expression is a nested
-- extract, it would need one index per queryable field PER LOCALE, it could
-- never reach a field on a nested block, and it gives no home for reference
-- edges. Four columns and two indexes do all of it.
--
-- Scalars only: this table filters and sorts. Rendering a result loads the
-- published document for the page of results being returned, which is at most
-- `perPage` rows through one `publishedDocsByIds` call.
create table if not exists content_index (
  story_id   text not null,
  -- '' is the source locale, so a single-locale site has exactly one row per
  -- field and no null handling anywhere. A declared non-source locale gets its
  -- own row holding the value as that locale *renders* it — the translation when
  -- there is one, the fallback when there is not — so filtering a French index
  -- page matches what a French visitor actually reads.
  locale     text not null default '',
  field      text not null,
  text_value text,
  -- Numbers, booleans (0/1) and parsed ISO dates, so ordering and ranges are
  -- numeric rather than lexicographic. A date is stored in both columns: an ISO
  -- 8601 string sorts correctly as text *and* parses to a number, and storing
  -- both costs 8 bytes and removes a class of bug.
  num_value  real,
  primary key (story_id, locale, field)
);

create index if not exists content_index_lookup on content_index (field, locale, text_value);
create index if not exists content_index_num    on content_index (field, locale, num_value);

-- Outbound edges of a published document: story links (a `multilink` field, and
-- a link mark inside richtext) and `reference` fields. Written in the same
-- batch. Powers "used by N documents" (data-documents.md) and, later, the cache
-- purge set (ROADMAP.md).
create table if not exists content_refs (
  from_story text not null,
  to_story   text not null,
  -- 'link' | 'reference'
  kind       text not null,
  primary key (from_story, to_story, kind)
);

create index if not exists content_refs_to on content_refs (to_story);
