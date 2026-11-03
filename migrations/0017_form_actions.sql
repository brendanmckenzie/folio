-- Form actions (docs/specs/content-model/form-actions.md).
--
-- One column and two tables, all additive, numbered after spec 37's
-- 0016_option_sources.sql and independent of it. No foreign keys and no CHECK
-- constraint, following 0010: the delete paths are explicit batches (decision 20),
-- and enum-shaped columns are screened on read rather than constrained, because
-- SQLite cannot widen a CHECK without rebuilding the table.

-- JSON array of FormActionAttachment, in run order, at most MAX_FORM_ACTIONS (8).
-- Validated against the brand's registered actions on every write that changes it;
-- screened on read by readFormActions, where an unreadable column answers [] with
-- one logged line.
alter table forms add column actions text not null default '[]';

create table form_deliveries (
  -- The response this delivers. One row per (response, action): an action is
  -- attached to a form at most once (decision 7).
  response_id text not null,
  action      text not null,
  -- Denormalised from the response so deleteForm clears a form's deliveries in one
  -- statement. Counts by form join form_responses for the site fence (decision 21).
  form_id     text not null,
  -- pending | delivered | skipped | failed | cancelled. Screened on read.
  status      text not null default 'pending',
  -- Moved at claim time, so an attempt that was killed mid-flight still counts.
  attempts    integer not null default 0,
  -- When the next attempt may claim this row. Null unless pending. A claim moves it
  -- forward by the lease, which is what recovers a row whose runner died.
  next_at     integer,
  -- The current claim's random token. Every result write is fenced by it, so a
  -- runner whose lease lapsed writes nothing (decision 10).
  claim       text,
  -- The hostname that received the submission (decision 14). One of the site's own
  -- hosts; not personal data.
  host        text not null default '',
  -- JSON object, input name -> question name, as the mapping stood at submit
  -- (decision 11). Question names only, never answers. Null for a row created failed.
  inputs_map  text,
  -- What the third party called it, when deliver returned one. Shown in Responses.
  reference   text,
  -- A category: threw | timeout | malformed | refused | not_registered | incomplete |
  -- predates_mapping | no_brand | gave_up. Never a thrown message (decision 15).
  failure     text,
  -- Only text the action returned for display ({ skipped } or { failed }). At most
  -- 500 characters.
  detail      text,
  created_at  integer not null,
  updated_at  integer not null,
  primary key (response_id, action)
);

-- The sweep: due pending rows, oldest first. Partial, so a site whose deliveries all
-- succeed reads an empty index on every tick (0003's schedules index, again).
create index form_deliveries_due on form_deliveries (next_at) where status = 'pending';
-- The failed-count banner and deleteForm.
create index form_deliveries_form on form_deliveries (form_id, status);

-- Refused attempts, for the rate limit only (decision 23). No answers, no id: the
-- hour-bucketed ip_hash the rate check computed, the form, and when.
create table form_refusals (
  ip_hash    text not null,
  form_id    text not null,
  created_at integer not null
);
create index form_refusals_throttle on form_refusals (ip_hash, created_at desc);
