-- Folders, tags, and six columns on `assets`.
--
-- Every path in `asset_folders` is a query key and NEVER a URL and NEVER an R2
-- key prefix. `docs/specs/content-model/media-library.md` decision 1: an asset's
-- key is minted once and baked into published HTML through `Resolution.assetBase`,
-- so filing a file must not move an object.

create table asset_folders (
  -- 'fld_<12 hex>', minted like an asset id.
  id         text primary key,
  parent_id  text,
  -- As typed. Displayed; not the identity.
  name       text not null,
  -- Slash-joined chain of slugified ancestor names, this folder last. Unique, so
  -- two siblings cannot slugify onto one another. Recomputed on rename and move,
  -- the way stories.path is (core/story.ts derivePaths).
  --
  -- Sorted, this is depth-first AND alphabetical among siblings, which is what
  -- lets the folder list be keyset-paged like every other list with no
  -- client-side sort. Do not replace it with a chain of ids: they sort randomly
  -- among siblings and that property is lost (decision 3).
  path       text not null unique,
  created_at integer not null
);

-- The tree render, and the only query not going through `path`.
create index asset_folders_parent on asset_folders (parent_id, name);

create table asset_tags (
  -- 'tag_<12 hex>'.
  id         text primary key,
  -- As first typed. Displayed.
  name       text not null,
  -- The identity: lowercased, trimmed, inner whitespace collapsed. 'Headshot',
  -- 'headshot' and 'head  shot ' are one tag. Creating a colliding tag returns
  -- the existing one rather than erroring, which is what makes free-form entry
  -- with autocomplete tolerable.
  slug       text not null unique,
  created_at integer not null
);

create table asset_taggings (
  asset_id text not null,
  tag_id   text not null,
  primary key (asset_id, tag_id)
);

-- The tag filter's reader, and the sidebar's per-tag counts. The primary key
-- above serves "this asset's tags"; this serves "this tag's assets", which is
-- the direction the screen actually filters in.
create index asset_taggings_tag on asset_taggings (tag_id, asset_id);

-- Null is 'unfiled', a real state and the one every existing row starts in. Not
-- a foreign key: `asset_folders` deletes null this out (decision 14), and D1 has
-- foreign keys off by default anyway.
alter table assets add column folder_id        text;
-- Human, longer than `alt`, searchable. What the file IS, as against what a
-- screen reader should say.
alter table assets add column description      text not null default '';
-- Machine-written. Separate columns so a human edit is never clobbered and a
-- re-run is idempotent (decision 9). Readers want `alt || alt_auto`.
alter table assets add column alt_auto         text not null default '';
alter table assets add column description_auto text not null default '';
-- Null means never attempted. Set with `describe_error` non-null means tried and
-- failed, which is what stops a permanently failing asset being retried forever.
alter table assets add column described_at     integer;
alter table assets add column describe_error   text;

-- `0002_asset_refs.sql` refused these two by name, on the premise that an asset
-- table is 'bounded by what somebody uploaded by hand'. That premise is what
-- changed: this migration exists because the library is expected to hold
-- thousands. The refusal was correct when it was written and it named the
-- measurement that would reverse it.
create index assets_filename on assets (filename, id);
create index assets_size     on assets (size desc, id);

-- The default ordering inside a folder filter, which is the screen's most common
-- state after 'everything'.
create index assets_folder   on assets (folder_id, created_at desc);

-- The enrichment backlog walk. Partial, the shape 0003_schedules.sql
-- established: the index holds only the rows the query wants.
create index assets_undescribed on assets (described_at) where described_at is null;

-- Deliberately absent, each asserted in test/workers/migrations.test.ts so
-- adding one is a deliberate act with a measurement behind it:
--
--   * an `ord` on asset_folders — manual sibling ordering breaks `path`'s
--     depth-first-and-alphabetical property and nobody orders folders by hand
--     (decision 3);
--   * any tag index on `assets` — the tag filter is served by
--     asset_taggings_tag, on the join table where it belongs;
--   * an index on asset_tags.name — the vocabulary is hundreds of rows and the
--     unique index on `slug` already serves lookup;
--   * an index on assets.description — search is a scan by decision 12, and an
--     index cannot serve a leading-wildcard LIKE anyway.
--
-- No CHECK constraint anywhere here, following 0002/0003/0004: SQLite cannot
-- widen one without rebuilding the table, and `versions.kind` is the standing
-- reminder of what that costs.
