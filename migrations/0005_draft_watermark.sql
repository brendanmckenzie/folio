-- The Durable Object's log position, mirrored into D1 by a debounced alarm so
-- the content tree can show which pages have unpublished changes without
-- opening every object. Coarser than a diff on purpose: see unpublished-changes.md.
alter table stories add column draft_sync_id integer not null default 0;
alter table stories add column draft_updated_at integer;
-- The log position that was published. Set by publish() in the same batch as
-- published_doc, so the two can never disagree about what is live.
alter table stories add column published_sync_id integer not null default 0;

-- `default 0` on both watermarks makes an existing database read "nothing
-- changed since publish" rather than "everything changed" -- the safer wrong
-- answer for rows written before this column existed. The first edit to any
-- story corrects it.
--
-- Plain, ordinary columns on purpose: 0006_document_types.sql rebuilds
-- `stories` to make `path` nullable and has to carry every column added
-- before it forward untouched, this trio included (alongside 0003's pair).

create index if not exists stories_draft_updated on stories (draft_updated_at desc);
