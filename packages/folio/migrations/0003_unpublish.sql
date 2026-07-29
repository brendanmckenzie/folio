-- Unpublishing clears published_doc (the liveness switch) and published_at. These
-- two new columns are what distinguishes "taken down" from "never published",
-- which the tree needs to show and which nothing else records: an unpublish is
-- not a document snapshot, so it gets no versions row — and versions.kind
-- carries a CHECK constraint SQLite cannot widen without rebuilding the table.
--
-- Both null on every existing row, which reads as "never unpublished" —
-- correct for every row written before this migration.
--
-- Plain, ordinary columns on purpose: 0006_document_types.sql rebuilds
-- `stories` to make `path` nullable and has to carry every column added
-- before it forward untouched, this pair included.
alter table stories add column unpublished_at integer;
alter table stories add column unpublished_by text;
