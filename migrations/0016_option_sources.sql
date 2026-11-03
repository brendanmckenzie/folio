-- Form option sources (docs/specs/content-model/form-option-sources.md).
--
-- Additive. Read by the release that carries it (render reads option_lists, response
-- reads select option_labels), so it is applied BEFORE that Worker is deployed.
-- v1.3.0 also carries 0017_form_actions.sql (spec 36), and the two are independent.

-- The last good list a host option source returned, per brand, source and
-- canonical [settings, locale] key (locale '' for a source that is not localised).
-- Content sources have no rows, because they are D1 already. options is null until
-- the first good load, and attempted_at is the lease.
create table option_lists (
  brand text not null,           -- '' on a deployment with no brands
  source text not null,
  key text not null,
  options text,                  -- JSON FormFieldOption[], screened, at most 500
  digest text,                   -- SHA-256 of options, for change detection
  loaded_at integer,             -- last good load, epoch ms
  attempted_at integer not null, -- last attempt, epoch ms, the 30-second lease
  failures integer not null default 0,
  failure text,                  -- 'timeout' | 'threw' | 'malformed' | 'empty'
  primary key (brand, source, key)
) without rowid;

-- { [question]: { [value]: label } } for each answered sourced question, in the
-- locale the response was submitted in. '{}' for every row before this migration.
alter table form_responses add column option_labels text not null default '{}';
