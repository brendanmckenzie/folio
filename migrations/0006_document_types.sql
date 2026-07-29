-- Document types (docs/specs/foundation/document-types.md).
--
-- A record and a page are the same row with a different `type` (checkpoint 1):
-- there is no second table, because a separate one would fork the story tree,
-- versions, publish, the Durable Object naming rule, the history routes and the
-- admin, all for the sake of two columns being null.
--
-- This is a REBUILD, not an `alter table`, and it is the only one in the
-- migration series: `path` has to become nullable so an unrouted document
-- leaves the URL namespace entirely (checkpoint 2), and SQLite cannot drop a
-- NOT NULL in place. `stories` has no foreign keys pointing at it (`versions`
-- and `redirects` both reference `story_id` by convention only, deliberately,
-- so a redirect outlives the story that created it), so a rebuild is safe as
-- long as nothing writes while it runs.
--
-- A rebuild has to carry every column added before it forward untouched, which
-- is the only reason this migration's *number* matters: anything added after
-- 0006 is an ordinary `alter table`, but anything before it has to appear here
-- or the rebuild silently drops the data. As of 0006 that means 0003's pair
-- (unpublish) and 0005's trio (draft watermark), both marked as such in their
-- own files. The same goes for indexes: dropping the table drops every index
-- on it, including the implicit one behind 0001's `path ... unique`, so every
-- index that should still exist is recreated at the bottom of this file.
--
-- Ordering matters: the new table is created and filled before the old one is
-- dropped, so a failure mid-file leaves the original table intact.

create table stories_new (
  -- Stable. The Durable Object name, so renaming or moving a page never
  -- orphans its draft or its mutation log. A singleton's id is derived from
  -- its type name instead of minted ('sng_<type>', checkpoint 4), which is
  -- what makes a second one unrepresentable without a uniqueness constraint.
  id            text primary key,
  -- Document type name, resolved against the `types` passed to createFolio.
  -- 'page' by default: every row written before this migration belonged to the
  -- single root type, which `root: 'page'` now expands to a type of exactly
  -- that name (server/runtime.ts), so an existing database keeps working with
  -- an unchanged host config.
  type          text not null default 'page',
  parent_id     text,
  -- Last path segment. Empty string for the root story, which serves '/'. Kept
  -- for an unrouted document too: it needs a stable machine-readable handle for
  -- the content API and for sitemap-style host code, unique per type rather
  -- than per parent (see stories_type_slug below).
  slug          text not null,
  -- Null for an unrouted document (a record or a singleton), which leaves the
  -- page tree entirely rather than squatting a URL: naming a record "Contact"
  -- must not take /contact away from the page that needs it. Derived from the
  -- ancestor chain for everything else, and recomputed on rename and move.
  path          text,
  -- Fractional index among siblings: within the parent for a routed document,
  -- within the type for an unrouted one.
  ord           text not null,
  title         text not null,
  published_doc text,
  published_at  integer,
  created_at    integer not null default (unixepoch()),
  updated_at    integer not null default (unixepoch()),
  -- From 0003 (unpublish).
  unpublished_at    integer,
  unpublished_by    text,
  -- From 0005 (draft watermark).
  draft_sync_id     integer not null default 0,
  draft_updated_at  integer,
  published_sync_id integer not null default 0
);

-- Every column named explicitly on both sides rather than `select *`: a
-- positional copy is exactly how a rebuild loses a column silently.
insert into stories_new
  (id, type, parent_id, slug, path, ord, title, published_doc, published_at,
   created_at, updated_at, unpublished_at, unpublished_by,
   draft_sync_id, draft_updated_at, published_sync_id)
select
  id, 'page', parent_id, slug, path, ord, title, published_doc, published_at,
  created_at, updated_at, unpublished_at, unpublished_by,
  draft_sync_id, draft_updated_at, published_sync_id
from stories;

drop table stories;
alter table stories_new rename to stories;

-- 0001's index, unchanged.
create index stories_parent_ord on stories (parent_id, ord);

-- 0005's index, recreated: the rebuild dropped it with the old table.
create index stories_draft_updated on stories (draft_updated_at desc);

-- New: the flat per-type listing GET /folio/documents runs.
create index stories_type on stories (type, ord);

-- 0001's `path text not null unique`, now a named partial index. Only routed
-- documents live in the URL namespace; unrouted rows all carry path = null and
-- would otherwise all collide with each other. (SQLite would in fact treat
-- each of those NULLs as distinct even in a plain unique index, so the `where`
-- clause is about intent and index size rather than about correctness here —
-- unlike stories_parent_slug below, where it is load-bearing.)
create unique index stories_path on stories (path) where path is not null;

-- 0002's index, narrowed to routed rows. The coalesce is still needed for
-- exactly the reason 0002 documents: SQLite treats every NULL in a unique
-- index as distinct, so two top-level siblings (both storing parent_id = null)
-- sharing a slug would never collide without it. The `where` clause is what
-- keeps a record out of the page namespace entirely: every unrouted row stores
-- parent_id = null, so coalesce would otherwise fold them all onto the same key
-- as the top-level pages and a record slugged 'contact' would collide with the
-- page at /contact. Records are governed by stories_type_slug instead.
create unique index stories_parent_slug
  on stories (coalesce(parent_id, ''), slug) where path is not null;

-- New, and the unrouted counterpart of the above: an unrouted document's slug
-- is unique within its type, which is the handle the content API and
-- collections.md address it by.
create unique index stories_type_slug on stories (type, slug) where path is null;
