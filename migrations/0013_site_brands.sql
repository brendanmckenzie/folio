-- The brand a site or group belongs to (docs/specs/foundation/multi-brand.md
-- decision 4). Null on every row of a deployment with no `brands`; on one with
-- `brands`, one of the configured brand ids, and a row without one serves nothing.
-- Additive: code that predates it never reads the column.
alter table sites add column brand text;
