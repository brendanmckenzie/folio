-- D1 holds story *structure* and published snapshots.
-- Live draft state lives in the per-story Durable Object, named by `id`.
--
-- Page metadata (title, description, social image, noindex) lives in the
-- document's root block, not here, so it inherits sync, undo and versioning.
-- `title` is denormalised into this table purely so the tree can render
-- without loading every Durable Object; the document is the source of truth.

drop table if exists stories;

create table stories (
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

create index stories_parent_ord on stories (parent_id, ord);

-- Coarse, meaningful history: one row per publish, plus any checkpoints an
-- editor names. Deliberately *not* the Durable Object's mutation log, which is
-- per-keystroke and far too fine-grained to show anyone.
drop table if exists versions;

create table versions (
  id         text primary key,
  story_id   text not null,
  kind       text not null check (kind in ('publish', 'checkpoint')),
  label      text,
  title      text not null,
  actor      text,
  doc        text not null,
  created_at integer not null
);

create index versions_story on versions (story_id, created_at desc);

-- The media library: one row per uploaded file, so an asset can be reused
-- across pages instead of being re-uploaded.
--
-- `alt` here is only a *default*. The copy that gets rendered lives in the field
-- value, because the same photograph needs different alt text depending on what
-- it is illustrating. Same reasoning for the focal point.
drop table if exists assets;

create table assets (
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

create index assets_created on assets (created_at desc);

insert into stories (id, parent_id, slug, path, ord, title) values
  ('sty_home',  null,        '',     '',           'a0', 'Home'),
  ('sty_about', null,        'about', 'about',     'a1', 'About'),
  ('sty_team',  'sty_about', 'team',  'about/team', 'a0', 'Our team');
