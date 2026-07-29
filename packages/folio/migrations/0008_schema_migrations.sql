-- Content migrations (docs/specs/foundation/schema-migrations.md).
--
-- Purely additive: two `alter table`s and one new table. `stories` is NOT
-- rebuilt here — 0006_document_types.sql already did that to make `path`
-- nullable, and a second rebuild is a second chance to silently drop a column.

-- One row per content migration that has been applied to every document. The
-- audit trail, and what the admin's migrations screen calls "already run".
--
-- Correctness does not depend on it (checkpoint 2): migrations are idempotent,
-- so a missing row costs a re-run that does nothing. "Is this document behind"
-- is answered by `stories.schema_id` below, which is per-document and therefore
-- the accurate answer; this table is per-migration and is the record of a run.
create table if not exists schema_migrations (
  -- The migration's own id, e.g. '0001-hero-heading-to-title'.
  id              text primary key,
  applied_at      integer not null,
  -- Who ran it: a `users.id`, `token:<name>`, or null under `auth: 'open'`.
  actor           text,
  stories_seen    integer not null default 0,
  stories_changed integer not null default 0,
  mutations       integer not null default 0,
  -- JSON array of { storyId, reason }, null when the sweep was clean. A story
  -- that failed is still behind, so it is still picked up by the next run --
  -- this column exists so an operator can see *why* without re-running.
  failed          text
);

-- How far this story's draft and published snapshot have been migrated: the id
-- of the last migration applied to it. Null means "before the first migration",
-- which is the correct reading for every row written before this column existed.
--
-- This is what makes a partial run resumable and what tells the admin whether
-- the document an editor is about to open is behind the configured model.
-- Plain and nullable, with no default: `pendingFor(null, migrations)` is every
-- migration, which is exactly right for an unmigrated row.
alter table stories add column schema_id text;

-- The same, for a version document. Version rows are never rewritten
-- (checkpoint 3): `getVersion` applies the migrations a version is missing on
-- the way out, so history stays byte-true and a restore across a migration
-- diffs two documents in the same shape.
alter table versions add column schema_id text;

-- Deliberately no index on either column. The runner's sweep is
-- `where schema_id is null or schema_id < ?` over the whole table, ordered by
-- the primary key, which is a scan either way at the sizes a CMS has; and a
-- version's `schema_id` is only ever read by primary key on `versions.id`.
