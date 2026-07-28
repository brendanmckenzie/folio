-- D1 holds story *structure* and published snapshots.
-- Live draft state lives in the per-story Durable Object, named by `id`.
--
-- Every statement here is `if not exists`, which is not decoration: this
-- migration has to be able to *adopt* a database created by the schema.sql this
-- directory replaced. That file created these three tables and never created
-- d1_migrations, and `wrangler d1 migrations apply` treats every migration as
-- unapplied whenever its bookkeeping table is missing — so the first apply
-- against such a database runs this file over tables that already exist. The
-- structure below is byte-for-byte the structure schema.sql produced (it only
-- dropped the tables first and seeded three rows afterwards), so guarding each
-- statement makes that first apply a no-op that records the history instead of
-- failing on `create table stories`. A fresh database is unaffected.
--
-- 0002 adds a constraint rather than a table and cannot be made idempotent the
-- same way; see its own note for the one precondition an existing database has
-- to meet.
--
-- Page metadata (title, description, social image, noindex) lives in the
-- document's root block, not here, so it inherits sync, undo and versioning.
-- `title` is denormalised into this table purely so the tree can render
-- without loading every Durable Object; the document is the source of truth.

create table if not exists stories (
  -- Stable. The Durable Object name, so renaming or moving a page never
  -- orphans its draft or its mutation log.
  id            text primary key,
  parent_id     text,
  -- Last path segment. Empty string for the root story, which serves '/'.
  slug          text not null,
  -- Derived from the ancestor chain; recomputed on rename and move.
  path          text not null unique,
  -- Fractional index among siblings, the same primitive as block ordering.
  ord           text not null,
  title         text not null,
  published_doc text,
  published_at  integer,
  created_at    integer not null default (unixepoch()),
  updated_at    integer not null default (unixepoch())
);

create index if not exists stories_parent_ord on stories (parent_id, ord);

-- Coarse, meaningful history: one row per publish, plus any checkpoints an
-- editor names. Deliberately *not* the Durable Object's mutation log, which is
-- per-keystroke and far too fine-grained to show anyone.
create table if not exists versions (
  id         text primary key,
  story_id   text not null,
  kind       text not null check (kind in ('publish', 'checkpoint')),
  label      text,
  title      text not null,
  actor      text,
  doc        text not null,
  created_at integer not null
);

create index if not exists versions_story on versions (story_id, created_at desc);

-- The media library: one row per uploaded file, so an asset can be reused
-- across pages instead of being re-uploaded.
--
-- `alt` here is only a *default*. The copy that gets rendered lives in the field
-- value, because the same photograph needs different alt text depending on what
-- it is illustrating. Same reasoning for the focal point.
create table if not exists assets (
  id           text primary key,
  -- R2 object key. Carries the original filename so the URL stays readable.
  key          text not null unique,
  filename     text not null,
  content_type text not null,
  size         integer not null,
  width        integer,
  height       integer,
  alt          text not null default '',
  created_at   integer not null
);

create index if not exists assets_created on assets (created_at desc);
