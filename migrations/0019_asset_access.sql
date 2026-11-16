-- Visitor access for media library assets (docs/specs/platform/asset-access.md).
--
-- Four nullable columns and one table, all additive. Access values are JSON text so
-- the gate field's primitive survives the round trip (decision 2). No index on
-- assets: the asset route reads by key, on the unique index 0001 already has; the
-- "gated only" filter is a scan, like every asset filter but folder and tag.

-- own value; null = inherit from the folder
alter table assets add column access text;
-- what the route reads; null = public. Maintained by server/asset-access.ts.
alter table assets add column effective_access text;
-- own value; null = inherit from the ancestors
alter table asset_folders add column access text;
-- the nearest own value on this folder or an ancestor, by path
alter table asset_folders add column effective_access text;

-- Edge purges owed for files that went from public to gated (decision 10). A row is
-- written in the same batch as the transition and retired only by a purge that
-- succeeded after settle_at. No foreign key, following 0010: deleteAsset deletes
-- the row in its own batch.
create table asset_purges (
  asset_id   text primary key,
  site_id    text not null,
  queued_at  integer not null,
  settle_at  integer not null,
  purged_at  integer,
  attempts   integer not null default 0,
  last_error text
);
-- The admin's pending count, per scope.
create index asset_purges_pending on asset_purges (site_id) where purged_at is null;
